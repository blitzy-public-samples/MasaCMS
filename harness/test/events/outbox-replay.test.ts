// Outbox replay check against scripted owner endpoints, a recorded replay bin and an injected clock: nothing is spawned or dialled.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MIGRATION_PATH_PREFIX,
  encodeKey,
  encodeRow,
  sha256Hex,
  tableChecksum,
  type CanonicalColumn,
  type ExportResponse,
  type ExportRow,
  type PositionResponse,
} from '@opt2/platform/migration-kit';
import { LOCAL_ONLY_PRODUCERS, OUTBOX_PRODUCERS } from '@opt2/platform/tasks';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, writeTestSecrets } from '@opt2/platform/testing';

import {
  CONSUMER_EFFECT_UNITS,
  DEFAULT_DRAIN,
  QuiescenceTimeoutError,
  REPLAY_BIN_TIMEOUT_MS,
  runOutboxReplay,
  snapshotConsumers,
  waitForQuiescence,
  type DrainBounds,
  type ExecFn,
  type ExecResult,
  type ReplayScopeDeps,
  type SnapshotDifference,
} from '../../src/events/outbox-replay.js';
import { createHarnessInvoker, harnessCallerRoles, type HarnessInvoker } from '../../src/lib/invocation.js';
import { repoPath } from '../../src/lib/paths.js';
import { deriveTopology } from '../../src/repro/pubsub-topology.js';
import { UpStateMissingError, writeUpState, type UpProcessEntry } from '../../src/repro/up-state.js';

const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: childProcess.execFile,
}));

type FakeFetch = NonNullable<ReplayScopeDeps['fetch']>;
type ExecEnv = Parameters<ExecFn>[2]['env'];
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const SINCE = '2026-06-30T00:00:00.000Z';
const PRODUCERS: readonly string[] = [...OUTBOX_PRODUCERS, ...LOCAL_ONLY_PRODUCERS];
const TOPOLOGY = deriveTopology('local');
const SUBSCRIPTIONS = Object.entries(TOPOLOGY.subscriptions).map(([name, entry]) => ({ name, consumer: entry.consumer }));
const CONSUMERS = [...new Set(SUBSCRIPTIONS.map((subscription) => subscription.consumer))];
const SITES = [TENANT_UMBRELLA, TENANT_A, TENANT_B];
const SERVICES = [...new Set<string>([...TOPOLOGY.packages, ...PRODUCERS, ...CONSUMERS])];
// No listener on these ports; every request goes to the fake fetch of its test.
const SERVICE_URLS: Record<string, string> = Object.fromEntries(
  SERVICES.map((service, index) => [service, `http://127.0.0.1:${24_950 + index}`]),
);
const SERVICE_BY_ORIGIN = new Map(Object.entries(SERVICE_URLS).map(([service, url]) => [url, service]));

const INVOCATION_HEADER = 'x-serverless-authorization';
const INVOCATION_CREDENTIAL = 'Bearer FIXTURE-invocation-credential';
const ARCHIVE_SUBSCRIPTION = 'timesheets.people.person.archived.v1';
const SITE_UNIT = 'programs_sites.site';
const DRAIN: Required<DrainBounds> = { timeoutMs: 10_000, intervalMs: 1_000, stablePolls: 2 };

const SITE_COLUMNS: CanonicalColumn[] = [
  { name: 'SiteID', type: 's' },
  { name: 'publicUserPoolID', type: 's' },
  { name: 'privateUserPoolID', type: 's' },
];
const EFFECT_COLUMNS: CanonicalColumn[] = [
  { name: 'id', type: 's' },
  { name: 'detail', type: 's' },
  { name: 'row_version', type: 'i' },
];

/** Owner state the fake endpoints serve; tests mutate it between polls or during a replay. */
interface FakeState {
  inbox: Record<string, Record<string, number>>;
  outbox: Record<string, { unpublished: number; held: number }>;
  effects: Record<string, ExportRow[]>;
  /** Status answered instead, keyed `<service>:<position|export>`. */
  failing: Record<string, number>;
}

interface RecordedRequest {
  service: string;
  url: URL;
  headers: Headers;
}

interface ExecCall {
  file: string;
  args: readonly string[];
  cwd: string;
  env: ExecEnv;
}

let stateRoot: string;

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(os.tmpdir(), 'opt2-outbox-replay-'));
});

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true });
  childProcess.execFile.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
});

function effectKey(consumer: string, unit: string, tenantId: string): string {
  return `${consumer}/${unit}/${tenantId}`;
}

function exportRow(columns: readonly CanonicalColumn[], key: string, row: Record<string, unknown>): ExportRow {
  const encoded = encodeRow(columns, row);
  return { key: encodeKey(columns, [key], row), row: encoded, hash: sha256Hex(encoded) };
}

function effectRow(id: string, detail: string, version = 1): ExportRow {
  return exportRow(EFFECT_COLUMNS, 'id', { id, detail, row_version: version });
}

/** Deterministic seed: a distinct count per subscription, and 0, 1 and 2 effect rows in the umbrella, A and B tenants. */
function seedState(): FakeState {
  const inbox: FakeState['inbox'] = {};
  SUBSCRIPTIONS.forEach(({ name, consumer }, index) => {
    (inbox[consumer] ??= {})[name] = 10 + index;
  });
  const effects: FakeState['effects'] = {};
  for (const [consumer, units] of Object.entries(CONSUMER_EFFECT_UNITS)) {
    for (const unit of units) {
      SITES.forEach(({ tenantId }, rows) => {
        effects[effectKey(consumer, unit, tenantId)] = Array.from({ length: rows }, (_, i) =>
          effectRow(`FIXTURE-${unit}-${rows}-${i}`, `effect ${i}`),
        );
      });
    }
  }
  return { inbox, outbox: {}, effects, failing: {} };
}

function inboxCount(state: FakeState, consumer: string, subscription: string): number {
  const count = state.inbox[consumer]?.[subscription];
  if (count === undefined) throw new Error(`seed holds no inbox count for ${consumer}/${subscription}`);
  return count;
}

function bumpInbox(state: FakeState, consumer: string, subscription: string): void {
  const counts = (state.inbox[consumer] ??= {});
  counts[subscription] = (counts[subscription] ?? 0) + 1;
}

function unitChecksum(rows: readonly ExportRow[] | undefined): { rows: number; checksum: string } {
  const { count, sha256 } = tableChecksum(rows ?? []);
  return { rows: count, checksum: sha256 };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function positionOf(service: string, state: FakeState): PositionResponse {
  const counts = state.inbox[service];
  const outbox = state.outbox[service] ?? { unpublished: 0, held: 0 };
  return {
    owner: service,
    position: '1000',
    outbox: { tenants: [], ...outbox },
    inbox:
      counts === undefined
        ? null
        : { total: Object.values(counts).reduce((sum, count) => sum + count, 0), bySubscription: { ...counts } },
  };
}

function exportOf(service: string, url: URL, state: FakeState): ExportResponse {
  const unit = url.searchParams.get('unit') ?? '';
  const tenantId = url.searchParams.get('tenantId') ?? '';
  const siteExport = service === 'programs-sites' && unit === SITE_UNIT;
  const rows = siteExport
    ? SITES.filter((site) => site.tenantId === tenantId).map(({ siteId }) =>
        exportRow(SITE_COLUMNS, 'SiteID', { SiteID: siteId, publicUserPoolID: siteId, privateUserPoolID: siteId }),
      )
    : (state.effects[effectKey(service, unit, tenantId)] ?? []);
  const table = unit.split('.')[1] ?? unit;
  return {
    unit,
    tenantId,
    tables: [
      { unit, legacyTable: table, targetTable: unit, keyless: false, columns: siteExport ? SITE_COLUMNS : EFFECT_COLUMNS, rows },
    ],
    next: null,
  };
}

/** Owner migration endpoints over `state`, recording every request. */
function fakeFetch(state: FakeState): { fetch: FakeFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FakeFetch = async (input, init) => {
    const url = new URL(input);
    const service = SERVICE_BY_ORIGIN.get(url.origin);
    if (service === undefined) throw new Error(`no fake owner listens at ${url.origin}`);
    requests.push({ service, url, headers: new Headers(init.headers) });
    const endpoint = url.pathname.slice(MIGRATION_PATH_PREFIX.length + 1);
    const failing = state.failing[`${service}:${endpoint}`];
    if (failing !== undefined) return new Response('unit gate closed', { status: failing });
    if (endpoint === 'position') return json(positionOf(service, state));
    if (endpoint === 'export') return json(exportOf(service, url, state));
    return new Response('not found', { status: 404 });
  };
  return { fetch, requests };
}

async function stubInvoker(callees: string[] = []): Promise<HarnessInvoker> {
  return createHarnessInvoker({
    caller: 'migration',
    env: { OPT2_STATE_DIR: stateRoot },
    minterFactory: () => ({
      async headersFor({ name }) {
        callees.push(name);
        return { [INVOCATION_HEADER]: INVOCATION_CREDENTIAL };
      },
    }),
  });
}

function baseEnv(): Record<string, string> {
  return { OPT2_STATE_DIR: stateRoot, PG_USER: 'harness_reader', OPT2_TEST_BASE: 'base' };
}

/** Seeded state, its fake endpoints and a clock that advances only when the code under test sleeps. */
async function setup(onSleep?: (state: FakeState) => void): Promise<{
  state: FakeState;
  deps: ReplayScopeDeps;
  requests: RecordedRequest[];
  sleeps: number[];
}> {
  const state = seedState();
  const { fetch, requests } = fakeFetch(state);
  const sleeps: number[] = [];
  let now = 0;
  const deps: ReplayScopeDeps = {
    env: baseEnv(),
    fetch,
    invoker: await stubInvoker(),
    serviceUrls: SERVICE_URLS,
    // The module derives the topology on every call when unset; the default is exercised once in snapshotConsumers.
    consumers: CONSUMERS,
    siteIds: SITES.map((site) => site.siteId),
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      onSleep?.(state);
    },
    drain: DRAIN,
  };
  return { state, deps, requests, sleeps };
}

function markerOf(service: string): string {
  return `OPT2_TEST_MARKER_${service.toUpperCase().replaceAll('-', '_')}`;
}

function processEntry(service: string): UpProcessEntry {
  const index = SERVICES.indexOf(service);
  return {
    pid: 41_000 + index,
    port: 24_911 + index,
    cwd: path.join(stateRoot, 'packages', service),
    command: ['node', 'dist/main.js'],
    env: { OPT2_SERVICE_NAME: service, PG_USER: `${service.replaceAll('-', '_')}_app`, [markerOf(service)]: `marker-${service}` },
  };
}

function processes(services: readonly string[]): Record<string, UpProcessEntry> {
  return Object.fromEntries(services.map((service) => [service, processEntry(service)]));
}

function writeUp(entries: Record<string, UpProcessEntry>): void {
  writeUpState({ processes: entries }, { env: { OPT2_STATE_DIR: stateRoot } });
}

function binOf(service: string): string {
  return path.join(processEntry(service).cwd, 'node_modules', '.bin', 'opt2-outbox');
}

function succeed(call: ExecCall): ExecResult {
  const service = call.env.OPT2_SERVICE_NAME ?? '';
  return { code: 0, stdout: `replaying ${service}\n${JSON.stringify({ service, republished: 3 })}\n`, stderr: '' };
}

/** Replay bin stand-in recording each call and answering with `reply`. */
function recordingExec(reply: (call: ExecCall) => ExecResult = succeed): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (file, args, { cwd, env }) => {
    const call: ExecCall = { file, args: [...args], cwd, env: { ...env } };
    calls.push(call);
    return reply(call);
  };
  return { exec, calls };
}

function tokenClaims(header: string | null): Record<string, unknown> {
  const payload = (header ?? '').replace(/^Bearer /, '').split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function expectedChecksums(state: FakeState): Record<string, { rows: number; checksum: string }> {
  return Object.fromEntries(
    Object.entries(CONSUMER_EFFECT_UNITS).flatMap(([consumer, units]) =>
      units.flatMap((unit) =>
        SITES.map(({ tenantId }) => {
          const key = effectKey(consumer, unit, tenantId);
          return [key, unitChecksum(state.effects[key])] as const;
        }),
      ),
    ),
  );
}

describe('CONSUMER_EFFECT_UNITS', () => {
  it('names effect units only for topology consumers, each in its consumer schema', () => {
    for (const [consumer, units] of Object.entries(CONSUMER_EFFECT_UNITS)) {
      expect(CONSUMERS).toContain(consumer);
      expect(units.length).toBeGreaterThan(0);
      for (const unit of units) expect(unit.split('.')[0]).toBe(consumer.replaceAll('-', '_'));
    }
    expect(Object.isFrozen(CONSUMER_EFFECT_UNITS)).toBe(true);
  });
});

describe('snapshotConsumers', () => {
  it('keys inbox counts of every topology consumer by subscription and effect checksums by consumer, unit and tenant', async () => {
    const { state, deps, requests } = await setup();

    const snapshot = await snapshotConsumers({ ...deps, consumers: undefined });

    expect(snapshot.inboxCounts).toEqual(
      Object.fromEntries(SUBSCRIPTIONS.map(({ name, consumer }) => [`${consumer}/${name}`, inboxCount(state, consumer, name)])),
    );
    expect(snapshot.aggregateChecksums).toEqual(expectedChecksums(state));
    expect(Object.values(snapshot.aggregateChecksums).map((entry) => entry.rows)).toEqual(
      expect.arrayContaining([0, 1, 2]),
    );
    expect(Object.keys(snapshot.inboxCounts)).toEqual(Object.keys(snapshot.inboxCounts).toSorted());
    expect(Object.keys(snapshot.aggregateChecksums)).toEqual(Object.keys(snapshot.aggregateChecksums).toSorted());

    const positions = requests.filter((request) => request.url.pathname === `${MIGRATION_PATH_PREFIX}/position`);
    expect(positions.map((request) => request.service)).toEqual(CONSUMERS);
    const exports = requests
      .filter((request) => request.url.pathname === `${MIGRATION_PATH_PREFIX}/export`)
      .map(({ service, url }) => effectKey(service, url.searchParams.get('unit') ?? '', url.searchParams.get('tenantId') ?? ''));
    expect(exports.toSorted()).toEqual(
      [
        ...SITES.map(({ tenantId }) => effectKey('programs-sites', SITE_UNIT, tenantId)),
        ...Object.keys(expectedChecksums(state)),
      ].toSorted(),
    );
  });

  it('calls every owner as platform.migration with the invocation credential and no tenant, role or user header', async () => {
    const { deps, requests } = await setup();
    const callees: string[] = [];

    await snapshotConsumers({ ...deps, invoker: await stubInvoker(callees) });

    expect(requests.length).toBeGreaterThan(CONSUMERS.length);
    for (const { headers } of requests) {
      expect(headers.get(INVOCATION_HEADER)).toBe(INVOCATION_CREDENTIAL);
      expect([...headers.keys()].filter((name) => /tenant|role|user|^authorization$/i.test(name))).toEqual([]);
    }
    expect(callees).toEqual(requests.map((request) => request.service));
  });

  it('mints a local service token per owner from the state directory keys when no invoker is given', async () => {
    await writeTestSecrets(stateRoot);
    const { deps, requests } = await setup();

    await snapshotConsumers({ ...deps, invoker: undefined, consumers: ['timesheets'] });

    expect(requests.map((request) => request.service).toSorted()).toEqual(
      ['timesheets', ...SITES.map(() => 'programs-sites'), ...SITES.map(() => 'timesheets')].toSorted(),
    );
    for (const { service, headers } of requests) {
      const claims = tokenClaims(headers.get(INVOCATION_HEADER));
      expect(claims).toMatchObject({ aud: service, roles: [...harnessCallerRoles('migration')] });
    }
  });

  it.each([
    { endpoint: 'position', service: 'timesheets', message: 'timesheets migration position answered 503: unit gate closed' },
    {
      endpoint: 'export',
      service: 'communications',
      message: 'communications export of communications.message answered 503: unit gate closed',
    },
  ])('rejects when a consumer $endpoint answers non-2xx', async ({ endpoint, service, message }) => {
    const { state, deps } = await setup();
    state.failing[`${service}:${endpoint}`] = 503;

    await expect(snapshotConsumers(deps)).rejects.toThrow(message);
  });

  it('reads each listed consumer once and no export when none of them writes an effect unit', async () => {
    const { deps, requests } = await setup();

    const snapshot = await snapshotConsumers({
      ...deps,
      consumers: ['identity', 'timesheets', 'identity'],
      units: { timesheets: [] },
    });

    expect(requests.map(({ service, url }) => `${service} ${url.pathname}`)).toEqual([
      `identity ${MIGRATION_PATH_PREFIX}/position`,
      `timesheets ${MIGRATION_PATH_PREFIX}/position`,
    ]);
    expect(Object.keys(snapshot.inboxCounts).every((key) => /^(identity|timesheets)\//.test(key))).toBe(true);
    expect(snapshot.aggregateChecksums).toEqual({});
  });

  it.each([
    { role: 'consumers', run: (deps: ReplayScopeDeps) => snapshotConsumers({ ...deps, consumers: ['identity', 'ledger'] }) },
    { role: 'producers', run: (deps: ReplayScopeDeps) => waitForQuiescence({ ...deps, producers: ['ledger'] }) },
  ])('refuses $role that name no local package', async ({ role, run }) => {
    const { deps, requests } = await setup();

    await expect(run(deps)).rejects.toThrow(`${role} ledger name no local package`);
    expect(requests).toEqual([]);
  });
});

describe('waitForQuiescence', () => {
  const POLLED = [...new Set([...PRODUCERS, ...CONSUMERS])];

  it('resolves once every outbox is drained and inbox counts hold for the stable polls', async () => {
    const { state, deps, requests, sleeps } = await setup((current) => {
      current.outbox.people = { unpublished: 0, held: 0 };
    });
    state.outbox.people = { unpublished: 2, held: 1 };

    await waitForQuiescence(deps);

    expect(sleeps).toEqual([DRAIN.intervalMs, DRAIN.intervalMs]);
    expect(requests.map((request) => request.service)).toEqual([...POLLED, ...POLLED, ...POLLED]);
  });

  it('polls at the default interval and stable-poll count when no drain bound is given', async () => {
    const { deps, sleeps } = await setup();

    await waitForQuiescence({ ...deps, drain: undefined });

    expect(sleeps).toEqual(Array.from({ length: DEFAULT_DRAIN.stablePolls - 1 }, () => DEFAULT_DRAIN.intervalMs));
  });

  it.each([
    {
      title: 'names producers whose outbox stays unpublished or held',
      drain: { timeoutMs: 3_000, intervalMs: 1_000, stablePolls: 2 },
      prepare: (state: FakeState) => {
        state.outbox.surveys = { unpublished: 4, held: 0 };
        state.outbox.stub = { unpublished: 0, held: 2 };
      },
      onSleep: undefined,
      pending: () => ['surveys outbox unpublished=4 held=0', 'stub outbox unpublished=0 held=2'],
    },
    {
      title: 'names an inbox count that keeps changing',
      drain: { timeoutMs: 3_000, intervalMs: 1_000, stablePolls: 2 },
      prepare: undefined,
      onSleep: (state: FakeState) => bumpInbox(state, 'timesheets', ARCHIVE_SUBSCRIPTION),
      pending: (seed: FakeState) => {
        const count = inboxCount(seed, 'timesheets', ARCHIVE_SUBSCRIPTION);
        return [`timesheets/${ARCHIVE_SUBSCRIPTION} inbox ${count + 2} -> ${count + 3}`];
      },
    },
    {
      title: 'reports the steady streak when the bound ends before enough polls',
      drain: { timeoutMs: 2_000, intervalMs: 1_000, stablePolls: 5 },
      prepare: undefined,
      onSleep: undefined,
      pending: () => ['inbox counts steady for 3 of 5 polls'],
    },
  ])('times out and $title', async ({ drain, prepare, onSleep, pending }) => {
    const { state, deps } = await setup(onSleep);
    prepare?.(state);

    const error = await waitForQuiescence({ ...deps, drain }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(QuiescenceTimeoutError);
    expect(error).toMatchObject({ name: 'QuiescenceTimeoutError', elapsedMs: drain.timeoutMs, pending: pending(seedState()) });
  });

  it.each([0, 1.5, -1])('rejects stablePolls %s before polling', async (stablePolls) => {
    const { deps, requests } = await setup();

    await expect(waitForQuiescence({ ...deps, drain: { ...DRAIN, stablePolls } })).rejects.toThrow(
      new RangeError(`drain.stablePolls must be a positive integer, got ${stablePolls}`),
    );
    expect(requests).toEqual([]);
  });
});

describe('runOutboxReplay', () => {
  it('runs the replay bin once per producer with its own env and directory', async () => {
    const { deps } = await setup();
    writeUp(processes(PRODUCERS));
    const { exec, calls } = recordingExec();

    const result = await runOutboxReplay({ ...deps, since: SINCE, exec });

    expect(calls).toEqual(
      PRODUCERS.map((service) => {
        const entry = processEntry(service);
        return { file: binOf(service), args: ['replay', '--since', SINCE], cwd: entry.cwd, env: { ...baseEnv(), ...entry.env } };
      }),
    );
    expect(calls.map((call) => path.basename(call.file))).toEqual(PRODUCERS.map(() => 'opt2-outbox'));
    expect(calls.map((call) => Object.keys(call.env).filter((name) => name.startsWith('OPT2_TEST_MARKER_')))).toEqual(
      PRODUCERS.map((service) => [markerOf(service)]),
    );
    expect(result.since).toBe(SINCE);
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('reports each producer exit code and last stdout line, null when that line is not JSON', async () => {
    const { deps } = await setup();
    writeUp(processes(PRODUCERS));
    const { exec } = recordingExec((call) =>
      call.env.OPT2_SERVICE_NAME === 'stub' ? { code: 0, stdout: 'replayed 0 rows\n', stderr: '' } : succeed(call),
    );

    const result = await runOutboxReplay({ ...deps, since: SINCE, exec });

    expect(result.replays).toEqual(
      PRODUCERS.map((service) => ({
        service,
        exitCode: 0,
        summary: service === 'stub' ? null : { service, republished: 3 },
      })),
    );
  });

  it('holds the verdict unchanged when every count and checksum is identical after the replay', async () => {
    const { state, deps } = await setup();
    writeUp(processes(PRODUCERS));

    const result = await runOutboxReplay({ ...deps, since: SINCE, exec: recordingExec().exec });

    expect(result.unchanged).toBe(true);
    expect(result.differences).toEqual([]);
    expect(result.after).toEqual(result.before);
    expect(result.before.aggregateChecksums).toEqual(expectedChecksums(state));
  });

  it.each([
    {
      title: 'names the consumer subscription whose inbox count grew',
      producer: 'people',
      mutate: (state: FakeState) => bumpInbox(state, 'timesheets', ARCHIVE_SUBSCRIPTION),
      expected: (seed: FakeState): SnapshotDifference[] => {
        const count = inboxCount(seed, 'timesheets', ARCHIVE_SUBSCRIPTION);
        return [{ key: `timesheets/${ARCHIVE_SUBSCRIPTION}`, before: count, after: count + 1 }];
      },
    },
    {
      title: 'names a subscription counted only after the replay',
      producer: 'surveys',
      mutate: (state: FakeState) => bumpInbox(state, 'identity', 'identity.surveys.survey.scheduled.v1'),
      expected: (): SnapshotDifference[] => [{ key: 'identity/identity.surveys.survey.scheduled.v1', before: null, after: 1 }],
    },
    {
      title: 'names the unit and tenant whose export changed',
      producer: 'communications',
      mutate: (state: FakeState) => {
        state.effects[effectKey('communications', 'communications.message', TENANT_A.tenantId)] = [
          effectRow('FIXTURE-communications.message-1-0', 'effect 0 resent', 2),
        ];
      },
      expected: (seed: FakeState): SnapshotDifference[] => {
        const key = effectKey('communications', 'communications.message', TENANT_A.tenantId);
        return [
          {
            key,
            before: unitChecksum(seed.effects[key]),
            after: unitChecksum([effectRow('FIXTURE-communications.message-1-0', 'effect 0 resent', 2)]),
          },
        ];
      },
    },
  ])('$title during the replay and leaves the verdict changed', async ({ producer, mutate, expected }) => {
    const { state, deps } = await setup();
    writeUp(processes(PRODUCERS));
    const { exec } = recordingExec((call) => {
      if (call.env.OPT2_SERVICE_NAME === producer) mutate(state);
      return succeed(call);
    });

    const result = await runOutboxReplay({ ...deps, since: SINCE, exec });

    expect(result.unchanged).toBe(false);
    expect(result.differences).toEqual(expected(seedState()));
    expect(result.replays.every((run) => run.exitCode === 0)).toBe(true);
  });

  it('reports a non-zero bin exit as a failed replay and leaves the verdict changed', async () => {
    const { deps } = await setup();
    writeUp(processes(PRODUCERS));
    const { exec } = recordingExec((call) =>
      call.env.OPT2_SERVICE_NAME === 'people'
        ? { code: 2, stdout: '{"error":"publish failed"}\n', stderr: 'publish failed' }
        : succeed(call),
    );

    const result = await runOutboxReplay({ ...deps, since: SINCE, exec });

    expect(result.replays.find((run) => run.service === 'people')).toEqual({
      service: 'people',
      exitCode: 2,
      summary: { error: 'publish failed' },
    });
    expect(result.differences).toEqual([]);
    expect(result.unchanged).toBe(false);
  });

  it.each([
    { since: new Date(SINCE), title: 'a Date' },
    { since: '2026-06-30T02:00:00+02:00', title: 'an offset timestamp' },
  ])('passes $title to every bin as UTC ISO-8601', async ({ since }) => {
    const { deps } = await setup();
    writeUp(processes(PRODUCERS));
    const { exec, calls } = recordingExec();

    const result = await runOutboxReplay({ ...deps, since, exec });

    expect(result.since).toBe(SINCE);
    expect(calls.map((call) => call.args)).toEqual(PRODUCERS.map(() => ['replay', '--since', SINCE]));
  });

  it.each([
    { since: '2026-06-30T00:00:00', message: 'since must carry a zone (Z or ±hh:mm), got "2026-06-30T00:00:00"' },
    { since: '2026-13-45T00:00:00Z', message: 'since is not a valid timestamp: 2026-13-45T00:00:00Z' },
    { since: new Date(Number.NaN), message: 'since is not a valid timestamp: Invalid Date' },
  ])('refuses since $since before any call', async ({ since, message }) => {
    const { deps, requests } = await setup();
    writeUp(processes(PRODUCERS));
    const { exec, calls } = recordingExec();

    await expect(runOutboxReplay({ ...deps, since, exec })).rejects.toThrow(new RangeError(message));
    expect(calls).toEqual([]);
    expect(requests).toEqual([]);
  });

  it.each([
    {
      gap: 'process',
      entries: () => processes(PRODUCERS.filter((service) => service !== 'surveys')),
    },
    {
      gap: 'environment',
      entries: () => ({
        ...processes(PRODUCERS),
        surveys: Object.fromEntries(Object.entries(processEntry('surveys')).filter(([name]) => name !== 'env')) as UpProcessEntry,
      }),
    },
  ])('fails before any call when up.json records no $gap for a producer', async ({ gap, entries }) => {
    const { deps, requests } = await setup();
    writeUp(entries());
    const { exec, calls } = recordingExec();

    await expect(runOutboxReplay({ ...deps, since: SINCE, exec })).rejects.toThrow(
      `up.json records no ${gap} for producer surveys; its replay runs only with the producer's own role`,
    );
    expect(calls).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('fails before any call when up.sh has recorded no stack', async () => {
    const { deps, requests } = await setup();
    const { exec, calls } = recordingExec();

    await expect(runOutboxReplay({ ...deps, since: SINCE, exec })).rejects.toBeInstanceOf(UpStateMissingError);
    expect(calls).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('replays only the listed producers', async () => {
    const { deps } = await setup();
    writeUp(processes(['people']));
    const { exec, calls } = recordingExec();

    const result = await runOutboxReplay({ ...deps, producers: ['people'], since: SINCE, exec });

    expect(calls.map((call) => call.file)).toEqual([binOf('people')]);
    expect(result.replays.map((run) => run.service)).toEqual(['people']);
  });
});

describe('runOutboxReplay default runner', () => {
  async function runWithExecFile(error: Error | null): ReturnType<typeof runOutboxReplay> {
    const { deps } = await setup();
    writeUp(processes(['people']));
    childProcess.execFile.mockImplementation((...args: unknown[]) => {
      (args[3] as ExecFileCallback)(error, `${JSON.stringify({ republished: 2 })}\n`, '');
    });
    return runOutboxReplay({ ...deps, producers: ['people'], consumers: ['identity'], since: SINCE });
  }

  it.each([
    { title: 'a clean exit as code 0', error: null, exitCode: 0 },
    { title: 'an exit status as its code', error: Object.assign(new Error('Command failed'), { code: 3 }), exitCode: 3 },
  ])('runs opt2-outbox through execFile without a shell and reports $title', async ({ error, exitCode }) => {
    const result = await runWithExecFile(error);

    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = childProcess.execFile.mock.calls[0] ?? [];
    expect(file).toBe(binOf('people'));
    expect(args).toEqual(['replay', '--since', SINCE]);
    expect(options).toEqual({
      cwd: processEntry('people').cwd,
      env: { ...baseEnv(), ...processEntry('people').env },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });
    expect(result.replays).toEqual([{ service: 'people', exitCode, summary: { republished: 2 } }]);
    expect(result.unchanged).toBe(exitCode === 0);
  });

  it('rejects when the bin cannot be spawned', async () => {
    const spawnFailure = Object.assign(new Error('spawn opt2-outbox ENOENT'), { code: 'ENOENT' });

    await expect(runWithExecFile(spawnFailure)).rejects.toBe(spawnFailure);
  });

  it.each([
    { label: 'dies on SIGTERM', diesOn: 'SIGTERM', kills: [['SIGTERM']], destroyed: 0 },
    { label: 'ignores every signal', diesOn: null, kills: [['SIGTERM'], ['SIGKILL']], destroyed: 1 },
  ])('ends a bin that $label past REPLAY_BIN_TIMEOUT_MS and rejects with a bare ETIMEDOUT', async ({ diesOn, kills, destroyed }) => {
    const { deps } = await setup();
    writeUp(processes(['people']));
    let callback: ExecFileCallback | undefined;
    const stdio = [{ destroy: vi.fn() }, { destroy: vi.fn() }, { destroy: vi.fn() }];
    const kill = vi.fn((signal: string) => {
      // execFile's own error quotes the child's stderr.
      const died = Object.assign(new Error(`Command failed: ${binOf('people')}\nchild-stderr`), { killed: true, code: null, signal });
      if (signal === diesOn) callback?.(died, 'child-stdout', 'child-stderr');
      return true;
    });
    childProcess.execFile.mockImplementation((...args: unknown[]) => {
      callback = args[3] as ExecFileCallback;
      return { exitCode: null, signalCode: null, kill, stdio };
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const pending = runOutboxReplay({ ...deps, producers: ['people'], consumers: ['identity'], since: SINCE }).catch(
        (err: unknown) => err,
      );
      void pending.finally(() => (settled = true));
      while (!settled) await vi.advanceTimersByTimeAsync(60_000);
      const error = await pending;

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: 'ETIMEDOUT', message: `${binOf('people')} timed out after ${REPLAY_BIN_TIMEOUT_MS} ms` });
      expect((error as Error).cause).toBeUndefined();
      expect(childProcess.execFile).toHaveBeenCalledTimes(1);
      expect(kill.mock.calls).toEqual(kills);
      for (const stream of stdio) expect(stream.destroy).toHaveBeenCalledTimes(destroyed);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('opt2/reports/events.json outboxReplay', () => {
  it('records the replay under the before, after and unchanged fields the run returns', async () => {
    const report = JSON.parse(readFileSync(repoPath('opt2', 'reports', 'events.json'), 'utf8')) as {
      outboxReplay: { command: string; before: object; after: object; unchanged: unknown };
    };
    const { command, ...measured } = report.outboxReplay;
    const { deps } = await setup();
    writeUp(processes(PRODUCERS));
    const { exec, calls } = recordingExec();

    const { before, after, unchanged } = await runOutboxReplay({ ...deps, since: SINCE, exec });

    expect(Object.keys(measured).toSorted()).toEqual(Object.keys({ before, after, unchanged }).toSorted());
    for (const side of ['before', 'after'] as const) {
      expect(Object.keys(measured[side]).toSorted()).toEqual(['aggregateChecksums', 'inboxCounts']);
      expect(Object.keys(side === 'before' ? before : after).toSorted()).toEqual(['aggregateChecksums', 'inboxCounts']);
    }
    const [first] = calls;
    expect(command.split(' ')).toEqual([path.basename(first?.file ?? ''), ...(first?.args.slice(0, 2) ?? []), '<ts>']);
  });
});
