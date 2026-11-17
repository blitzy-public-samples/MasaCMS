/** `opt2-people resolve-operation`: argument parsing, environment checks, and resolutions over a recording database with identity doubles. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { REDACTED, createLogger, validateLogRecord } from '@opt2/platform/logging';
import { createOutbox } from '@opt2/platform/outbox';
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, createCapturingPublisher } from '@opt2/platform/testing';
import { OperationNotFoundError, UsageError, main, parseArgs, runResolveOperation, type ResolveReport } from '../../src/cli.js';
import { HALT_AFTER_MS, type RecoveryDeps, type ResolveTarget } from '../../src/domain/roster-recovery.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { peoplePayloadValidators } from '../../src/events/topics.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import { FINISH_PENDING_ERROR, type RosterOperationRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, createMutableClock, createRecordingDb, type MutableClock, type RecordingDb } from '../helpers/app.js';
import { STALE, captureWrites, cliEnv } from '../helpers/cli-doubles.js';
import { rosterOperationRow } from '../helpers/fixtures.js';
import { createIdentityDouble, type IdentityDouble } from '../helpers/identity-double.js';

const mocks = vi.hoisted(() => ({
  createPool: vi.fn(),
  assertTenantId: vi.fn(),
  createPublisher: vi.fn(),
  createIdentityClient: vi.fn(),
}));

// Pass-through spies; the main tests replace them to run the CLI over a test database, and one parseArgs test fails the tenant check.
vi.mock('@opt2/platform/tenancy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tenancy')>();
  mocks.createPool.mockImplementation(actual.createPool);
  mocks.assertTenantId.mockImplementation(actual.assertTenantId);
  return { ...actual, createPool: mocks.createPool, assertTenantId: mocks.assertTenantId };
});
vi.mock('@opt2/platform/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/events')>();
  mocks.createPublisher.mockImplementation(actual.createPublisher);
  return { ...actual, createPublisher: mocks.createPublisher };
});
vi.mock('../../src/legacy/identity-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/legacy/identity-client.js')>();
  mocks.createIdentityClient.mockImplementation(actual.createIdentityClient);
  return { ...actual, createIdentityClient: mocks.createIdentityClient };
});

const A = TENANT_A.tenantId;
const SITE = TENANT_A.siteId;
const USAGE = 'usage: opt2-people resolve-operation <operationId> [--to rolled-back|done] [--tenant <uuid>]';
const OPTION_VALUE = 'an option is missing its value or was given one it does not take';
// Assembled at run time, so no literal credential appears in source.
const SECRET = ['s3cr3t', 'people', 'cli', 'value'].join('-');

type LogLine = Record<string, unknown>;

/** The stderr chunks as log-record.v1 lines of the people CLI, each checked against the schema. */
function stderrRecords(chunks: readonly string[]): LogLine[] {
  return chunks.map((chunk) => {
    expect(chunk.endsWith('\n')).toBe(true);
    const record = JSON.parse(chunk) as LogLine;
    expect(validateLogRecord(record)).toStrictEqual({ valid: true, errors: [] });
    expect(record).toMatchObject({ service: 'people' });
    return record;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseArgs', () => {
  const OP = 'OP-0000-0000-0000000000000000000001';

  it.each<[string[], ReturnType<typeof parseArgs>]>([
    [['resolve-operation', OP], { command: 'resolve-operation', operationId: OP }],
    [['resolve-operation', OP, '--to', 'done'], { command: 'resolve-operation', operationId: OP, to: 'done' }],
    [['resolve-operation', '--to=rolled-back', OP], { command: 'resolve-operation', operationId: OP, to: 'rolled-back' }],
    [['resolve-operation', OP, '--tenant', A.toUpperCase()], { command: 'resolve-operation', operationId: OP, tenant: A }],
    [['--help'], 'help'],
    [['resolve-operation', '-h'], 'help'],
  ])('parses %j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });

  it.each<[string[], string]>([
    [[], 'missing subcommand'],
    [['resolve'], 'unknown subcommand'],
    [['resolve-operation'], 'missing operation id'],
    [['resolve-operation', ''], 'missing operation id'],
    [['resolve-operation', OP, 'extra'], 'unexpected argument'],
    [['resolve-operation', OP, SECRET], 'unexpected argument'],
    [['resolve-operation', OP, '--to', 'halted'], '--to must be one of rolled-back, done'],
    [['resolve-operation', OP, '--tenant', 'tenant-a'], '--tenant must be a tenant UUID'],
    [['resolve-operation', OP, '--force'], 'unknown option'],
    [['resolve-operation', OP, `--${SECRET}=x`], 'unknown option'],
    [['resolve-operation', OP, '--tenant'], OPTION_VALUE],
  ])('rejects %j with a fixed message that quotes no argument', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(new UsageError(message));
  });

  it('rethrows a tenant check failure other than an invalid tenant id', () => {
    const failure = new TypeError('tenant check failed');
    mocks.assertTenantId.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => parseArgs(['resolve-operation', OP, '--tenant', A])).toThrow(failure);
  });
});

describe('main before any dependency opens', () => {
  it.each<[string[], string]>([
    [[], 'missing subcommand'],
    [['resolve'], 'unknown subcommand'],
    [[`resolve-${SECRET}`], 'unknown subcommand'],
    [['resolve-operation'], 'missing operation id'],
    [['resolve-operation', 'OP-1', `extra-${SECRET}`], 'unexpected argument'],
    [['resolve-operation', 'OP-1', '--to', 'other'], '--to must be one of rolled-back, done'],
    [['resolve-operation', 'OP-1', '--to', SECRET], '--to must be one of rolled-back, done'],
    [['resolve-operation', 'OP-1', '--tenant', 'not-a-uuid'], '--tenant must be a tenant UUID'],
    [['resolve-operation', 'OP-1', '--tenant', SECRET], '--tenant must be a tenant UUID'],
    [['resolve-operation', 'OP-1', `--${SECRET}`], 'unknown option'],
    [['resolve-operation', 'OP-1', `--help=${SECRET}`], OPTION_VALUE],
  ])('exits 2 for %j with one usage line on stderr that quotes no argument', async (argv, reason) => {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);
    expect(await main(argv, cliEnv())).toBe(2);
    const records = stderrRecords(stderr);
    expect(records).toEqual([expect.objectContaining({ severity: 'ERROR', env: 'local', message: `opt2-people: ${reason}; ${USAGE}` })]);
    expect(records[0]).not.toHaveProperty('error');
    expect(stderr.join('')).not.toMatch(new RegExp(`${SECRET}|OP-1|other|not-a-uuid`));
    expect(stdout).toEqual([]);
  });

  it('prints the help and exits 0', async () => {
    const stdout = captureWrites(process.stdout);
    expect(await main(['--help'], {})).toBe(0);
    expect(stdout.join('')).toContain('Exit codes: 0 the operation stands resolved');
  });

  it.each<[string, NodeJS.ProcessEnv, string]>([
    [
      'an empty environment',
      {},
      'invalid environment (PORT: is required; OPT2_SERVICE_NAME: is required; OPT2_ENV: is required; OPT2_TOKEN_ISSUER: is required; OPT2_TOKEN_AUDIENCE: is required; TZ: is required)',
    ],
    ['no identity URL', cliEnv({ OPT2_SERVICE_URLS: '{}' }), 'opt2-people: invalid environment (OPT2_SERVICE_URLS: is invalid)'],
    ['no database settings', cliEnv({ OPT2_DB_AUTH: undefined, PG_DATABASE: undefined }), 'opt2-people: invalid environment (OPT2_DB_AUTH: is required; PG_DATABASE: is required)'],
    ['no local emulator', cliEnv({ PUBSUB_EMULATOR_HOST: undefined }), 'people: invalid environment (PUBSUB_EMULATOR_HOST: is required when OPT2_ENV=local)'],
    ['a secret-bearing invalid value', cliEnv({ PG_PORT: SECRET, OPT2_SERVICE_URLS: `{"identity":"${SECRET}"}` }), 'people: invalid environment (PG_PORT: expected number; OPT2_SERVICE_URLS: expected an http(s) URL)'],
  ])('exits 2 for %s with one line naming only the invalid variables and their reasons', async (_label, env, safeText) => {
    const stderr = captureWrites(process.stderr);
    expect(await main(['resolve-operation', 'OP-1'], env)).toBe(2);
    expect(stderrRecords(stderr)).toEqual([
      expect.objectContaining({
        severity: 'ERROR',
        message: 'opt2-people: invalid environment',
        error: expect.objectContaining({ type: 'EnvValidationError', message: safeText }),
      }),
    ]);
    expect(stderr.join('')).not.toMatch(new RegExp(`must name|${SECRET}`));
    expect(mocks.createPool).not.toHaveBeenCalled();
  });
});

const quietLogger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });

/** A before-image of a user who had no stored rows, as the people commit records one. */
const BEFORE_IMAGE = JSON.stringify({ existed: true, addresses: [], interests: [], tags: [], extendData: [] });

/** `tenant_registry` rows of tenants A and B in site order. */
const REGISTRY_ROWS = [TENANT_A, TENANT_B].map(({ tenantId, siteId }) => ({ tenant_id: tenantId, site_id: siteId }));

const REGISTRY_READ = /FROM "?people"?\."?tenant_registry"?/;
const ROSTER_READ = /^SELECT \* FROM "people"\."roster_operation" WHERE/;
const ROSTER_UPDATE = /^UPDATE "people"\."roster_operation" SET (.+) WHERE /;
const ROSTER_CLAIM = /^UPDATE "people"\."roster_operation" SET "claimed_by" = \$1, "updated_at" = \$2 WHERE/;
const CHANGELOG_INSERT = /^INSERT INTO "people"\."changelog"/;
const SET_TENANT = /set_config\('app\.tenant_id'/;

/** A recording `people` database whose registry has known tenants A and B and whose `roster_operation` holds one row that updates change. */
interface RosterDb {
  readonly db: RecordingDb;
  /** The held row of the operation in tenant A. */
  stored(operationId: string): RosterOperationRow | undefined;
  /** Tenant of every tenant transaction, in order; metadata transactions set an empty one. */
  tenantsRead(): string[];
}

/** The recording database holding `row`; reads of registered sites leave out the `deleted` tenants, as the registry does. */
function rosterDb(row: RosterOperationRow, deleted: readonly string[] = []): RosterDb {
  const held = new Map([[`${row.tenant_id}/${row.operation_id}`, { ...row }]]);
  // Both the key read and the update end their parameters with the tenant and the operation id.
  const heldBy = (values: readonly unknown[]): RosterOperationRow | undefined => held.get(`${String(values.at(-2))}/${String(values.at(-1))}`);
  const db = createRecordingDb({
    responses: [
      [REGISTRY_READ, (text) => (/\bNOT deleted\b/.test(text) ? REGISTRY_ROWS.filter((entry) => !deleted.includes(entry.tenant_id)) : REGISTRY_ROWS)],
      [ROSTER_READ, (_text, values) => [heldBy(values)].filter((row) => row !== undefined)],
      [
        ROSTER_UPDATE,
        (text, values) => {
          const updated = heldBy(values);
          if (updated === undefined) return [];
          for (const [, column, index] of (ROSTER_UPDATE.exec(text)?.[1] ?? '').matchAll(/"(\w+)" = \$(\d+)/g)) {
            Object.assign(updated, { [String(column)]: values[Number(index) - 1] });
          }
          return [updated];
        },
      ],
    ],
  });
  return {
    db,
    stored: (operationId) => held.get(`${A}/${operationId}`),
    tenantsRead: () => db.statements().flatMap(({ text, values }) => (SET_TENANT.test(text) && values[0] !== '' ? [String(values[0])] : [])),
  };
}

/** One operation of tenant A, its recording database and the identity double that holds identity's side of it. */
interface Scenario {
  readonly store: RosterDb;
  readonly identity: IdentityDouble;
  readonly operationId: string;
}

/** An operation of tenant A built from `overrides`, prepared at identity, or prepared and committed, as `identityState` names; `deleted` as rosterDb takes it. */
async function scenario(overrides: Partial<RosterOperationRow>, identityState?: 'prepared' | 'committed', deleted: readonly string[] = []): Promise<Scenario> {
  const row = rosterOperationRow(overrides);
  const identity = createIdentityDouble();
  if (identityState !== undefined) {
    const account = { UserName: 'pat', Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', Type: 2 as const };
    const prepared = await identity.identityClient.prepare(row.user_id, row.operation_id, { kind: 'create', siteId: SITE, account, groupIds: [] });
    expect(prepared).toMatchObject({ ok: true, state: 'prepared' });
    if (identityState === 'committed') await identity.identityClient.commit(row.user_id, row.operation_id);
  }
  return { store: rosterDb(row, deleted), identity, operationId: row.operation_id };
}

const preparedStarted = (): Promise<Scenario> => scenario({}, 'prepared');
const haltedCommitted = (): Promise<Scenario> => scenario({ state: 'halted', before_image: BEFORE_IMAGE }, 'committed');

/** The business clock moved past the recovery threshold, so every fixture operation is stale. */
function staleClock(): MutableClock {
  const clock = createMutableClock(TEST_CLOCK.now());
  clock.advance(STALE);
  return clock;
}

/** Recovery collaborators over the scenario's database and identity double, with the `people` outbox registered on it. */
function recordingDeps({ store, identity }: Scenario, clock: MutableClock = staleClock()): RecoveryDeps {
  const repo = createPeopleRepository({ clock, schema: store.db.schema });
  createOutbox({ service: 'people', db: store.db, publisher: createCapturingPublisher(), logger: quietLogger, clock, payloadValidators: peoplePayloadValidators });
  return { db: store.db, repo, identity: identity.identityClient, events: createPeopleEvents(repo), clock, logger: quietLogger };
}

function writeTexts(store: RosterDb): string[] {
  return store.db.writes().map(({ text }) => text);
}

describe('runResolveOperation over a recording database', () => {
  it.each<[string, string[]]>([
    ['registered', []],
    ['deleted from the registry', [A]],
  ])('aborts identity and rolls back an operation identity only prepared, found through the registry in tenant A %s', async (_label, deleted) => {
    const s = await scenario({}, 'prepared', deleted);
    const clock = staleClock();
    const run = await runResolveOperation(recordingDeps(s, clock), { operationId: s.operationId });
    expect(run).toEqual({
      report: { operationId: s.operationId, tenantId: A, from: 'started', to: 'rolled-back', identityState: 'prepared', outcome: 'aborted' },
      settled: true,
    });
    expect(s.identity.operation(s.operationId)?.state).toBe('aborted');
    expect(s.store.stored(s.operationId)).toMatchObject({ state: 'rolled-back', identity_unreachable_since: null, updated_at: clock.now() });
    expect(s.store.db.statements().some(({ text }) => REGISTRY_READ.test(text))).toBe(true);
    expect(new Set(s.store.tenantsRead())).toEqual(new Set([A]));
    expect(writeTexts(s.store)).toContainEqual(expect.stringMatching(/^DELETE FROM \S*open_operation/));
  });

  it.each<[string, string | undefined, string[], RegExp, string[]]>([
    ['only tenant B under --tenant', TENANT_B.tenantId, [TENANT_B.tenantId], /is held by no row of tenant /, []],
    ['every tenant the registry has known', undefined, [A, TENANT_B.tenantId], /is held by no tenant the registry has known/, []],
    ['every tenant the registry has known, a deleted site included', undefined, [A, TENANT_B.tenantId], /is held by no tenant the registry has known/, [TENANT_B.tenantId]],
  ])('throws OperationNotFoundError after searching %s, writing nothing', async (_label, tenant, searched, message, deleted) => {
    const s = await scenario({}, undefined, deleted);
    const operationId = tenant === undefined ? cfUuid() : s.operationId;
    const run = runResolveOperation(recordingDeps(s), { operationId, ...(tenant === undefined ? {} : { tenant }) });
    await expect(run).rejects.toThrow(OperationNotFoundError);
    await expect(run).rejects.toThrow(message);
    expect(s.store.tenantsRead()).toEqual(searched);
    expect(s.store.db.statements().some(({ text }) => REGISTRY_READ.test(text))).toBe(tenant === undefined);
    expect(s.store.db.writes()).toEqual([]);
    expect(s.identity.requests).toEqual([]);
  });

  it('reports a halted operation without --to unchanged and unsettled, without calling identity or writing', async () => {
    const s = await haltedCommitted();
    const calls = s.identity.requests.length;
    const run = await runResolveOperation(recordingDeps(s), { operationId: s.operationId });
    expect(run).toEqual({
      report: { operationId: s.operationId, tenantId: A, from: 'halted', to: 'halted', identityState: null, outcome: 'unchanged' },
      settled: false,
    });
    expect(s.identity.requests).toHaveLength(calls);
    expect(s.store.db.writes()).toEqual([]);
  });

  it('finishes a halted operation with --to done once identity committed, releasing its held events', async () => {
    const s = await haltedCommitted();
    const run = await runResolveOperation(recordingDeps(s), { operationId: s.operationId, to: 'done', tenant: A });
    expect(run).toEqual({
      report: { operationId: s.operationId, tenantId: A, from: 'halted', to: 'done', identityState: 'committed', outcome: 'finished' },
      settled: true,
    });
    expect(s.identity.operation(s.operationId)?.state).toBe('finished');
    expect(s.store.stored(s.operationId)).toMatchObject({ state: 'done', error: null });
    expect(writeTexts(s.store)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^UPDATE \S*outbox"? SET held = false/), expect.stringMatching(/^DELETE FROM \S*open_operation/)]),
    );
  });

  it.each<ResolveTarget>(['rolled-back', 'done'])('fails with identity unreachable under --to %s, leaving the operation in its state', async (to) => {
    const s = await scenario({ state: 'people-committed', before_image: BEFORE_IMAGE }, 'committed');
    s.identity.setUnreachable(true);
    const calls = s.identity.requests.length;
    await expect(runResolveOperation(recordingDeps(s), { operationId: s.operationId, to })).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(s.store.stored(s.operationId)).toMatchObject({ state: 'people-committed', error: null, before_image: BEFORE_IMAGE, identity_unreachable_since: null });
    // The claim, with its changelog row, is the only write.
    expect(writeTexts(s.store).filter((text) => !CHANGELOG_INSERT.test(text))).toEqual([expect.stringMatching(ROSTER_CLAIM)]);
    expect(s.identity.requests.slice(calls).map((request) => request.operationId)).toEqual(['getAccountOperation']);
    expect(s.identity.operation(s.operationId)?.state).toBe('committed');
  });

  it.each<[string, Partial<RosterOperationRow>]>([
    ['a rolled-back operation', { state: 'rolled-back' }],
    ['a done operation', { state: 'done', before_image: BEFORE_IMAGE }],
  ])('reports %s without --to unchanged and settled', async (_label, overrides) => {
    const s = await scenario(overrides);
    const run = await runResolveOperation(recordingDeps(s), { operationId: s.operationId });
    expect(run).toEqual({
      report: { operationId: s.operationId, tenantId: A, from: overrides.state, to: overrides.state, identityState: null, outcome: 'unchanged' },
      settled: true,
    });
    expect(s.store.db.writes()).toEqual([]);
  });

  it('halts an operation whose identity stayed unreachable past the halt period, leaving it unsettled', async () => {
    const since = TEST_CLOCK.now();
    const s = await scenario({ state: 'people-committed', before_image: BEFORE_IMAGE, identity_unreachable_since: since }, 'committed');
    s.identity.setUnreachable(true);
    const clock = createMutableClock(since);
    clock.advance(HALT_AFTER_MS + 1);
    const run = await runResolveOperation(recordingDeps(s, clock), { operationId: s.operationId });
    expect(run).toEqual({
      report: { operationId: s.operationId, tenantId: A, from: 'people-committed', to: 'halted', identityState: null, outcome: 'halted' },
      settled: false,
    });
    expect(s.store.stored(s.operationId)).toMatchObject({ state: 'halted', identity_unreachable_since: since });
  });
});

const unreachable = (s: Scenario): void => s.identity.setUnreachable(true);

/** How one `main` run over a recording database is set up and what it prints. */
interface MainCase {
  setUp: () => Promise<Scenario>;
  flags: string[];
  /** Applied to the scenario before the run. */
  arrange?: (s: Scenario) => void;
  exit: number;
  /** The report line's fields; no stdout line when absent. */
  report?: Omit<ResolveReport, 'operationId' | 'tenantId'>;
  /** The one stderr line's severity, message and error record, if any; nothing on stderr when absent. */
  stderr?: { severity: 'ERROR' | 'CRITICAL'; message: string; error?: { type: string; message: string | RegExp } };
}

/** The `error` record a stderr line of `c` carries, as a matcher. */
function errorMatcher(error: { type: string; message: string | RegExp }): unknown {
  return expect.objectContaining({ type: error.type, message: typeof error.message === 'string' ? error.message : expect.stringMatching(error.message) });
}

describe('main over a recording database', () => {
  it.each<[string, MainCase]>([
    ['a prepared operation found through the registry', { setUp: preparedStarted, flags: [], exit: 0, report: { from: 'started', to: 'rolled-back', identityState: 'prepared', outcome: 'aborted' } }],
    [
      'an operation tenant B does not hold',
      {
        setUp: preparedStarted,
        flags: ['--tenant', TENANT_B.tenantId],
        exit: 1,
        stderr: { severity: 'ERROR', message: 'opt2-people: no searched tenant holds the roster operation', error: { type: 'OperationNotFoundError', message: REDACTED } },
      },
    ],
    [
      'a halted operation without --to',
      {
        setUp: haltedCommitted,
        flags: [],
        exit: 1,
        report: { from: 'halted', to: 'halted', identityState: null, outcome: 'unchanged' },
        stderr: { severity: 'ERROR', message: 'opt2-people: roster operation is halted; rerun with --to rolled-back or --to done' },
      },
    ],
    [
      'a refused resolution',
      {
        setUp: () => scenario({ state: 'rolled-back' }),
        flags: ['--to', 'done'],
        exit: 1,
        stderr: {
          severity: 'ERROR',
          message: 'opt2-people: roster operation refused: its recorded states do not allow the resolution, or another resolution holds it',
          error: { type: 'RosterResolutionError', message: REDACTED },
        },
      },
    ],
    ['a halted operation with --to done', { setUp: haltedCommitted, flags: ['--to', 'done'], exit: 0, report: { from: 'halted', to: 'done', identityState: 'committed', outcome: 'finished' } }],
    [
      'identity unreachable',
      {
        setUp: haltedCommitted,
        flags: ['--to', 'done'],
        arrange: unreachable,
        exit: 1,
        stderr: { severity: 'ERROR', message: 'opt2-people: identity unavailable; rerun later', error: { type: 'ServiceUnavailableError', message: /^Service identity unavailable \(\S+\)$/ } },
      },
    ],
    [
      'an operation its request still holds',
      {
        setUp: () => scenario({ updated_at: new Date() }),
        flags: [],
        exit: 1,
        report: { from: 'started', to: 'started', identityState: null, outcome: 'unchanged' },
        stderr: { severity: 'ERROR', message: 'opt2-people: roster operation is still started: its request or another resolution holds it, or identity is unreachable; rerun later' },
      },
    ],
    [
      'a done operation whose finish identity cannot take',
      {
        setUp: () => scenario({ state: 'done', error: FINISH_PENDING_ERROR, before_image: BEFORE_IMAGE }, 'committed'),
        flags: [],
        arrange: unreachable,
        exit: 1,
        report: { from: 'done', to: 'done', identityState: null, outcome: 'unchanged' },
        stderr: { severity: 'ERROR', message: "opt2-people: roster operation is done but identity's finish is still pending; rerun later" },
      },
    ],
    [
      'a database failure',
      {
        setUp: preparedStarted,
        flags: [],
        arrange: (s) =>
          s.store.db.respond(ROSTER_CLAIM, () => {
            throw new Error(`database down for postgres://svc:${SECRET}@db`);
          }),
        exit: 1,
        stderr: { severity: 'CRITICAL', message: 'opt2-people: resolve-operation failed', error: { type: 'Error', message: REDACTED } },
      },
    ],
  ])('runs %s: its exit code and output lines, and the pool closed', async (_label, c) => {
    const s = await c.setUp();
    c.arrange?.(s);
    const end = vi.spyOn(s.store.db, 'end');
    mocks.createPool.mockResolvedValueOnce(s.store.db);
    mocks.createPublisher.mockReturnValueOnce(createCapturingPublisher());
    mocks.createIdentityClient.mockReturnValueOnce(s.identity.identityClient);
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    expect(await main(['resolve-operation', s.operationId, ...c.flags], cliEnv())).toBe(c.exit);
    expect(stdout.map((line) => JSON.parse(line) as unknown)).toEqual(
      c.report === undefined ? [] : [{ operationId: s.operationId, tenantId: A, ...c.report }],
    );
    if (c.stderr === undefined) {
      expect(stderr).toEqual([]);
    } else {
      const { error, ...line } = c.stderr;
      const records = stderrRecords(stderr);
      expect(records).toEqual([expect.objectContaining({ ...line, ...(error === undefined ? {} : { error: errorMatcher(error) }) })]);
      if (error === undefined) expect(records[0]).not.toHaveProperty('error');
      // The report line names the operation; diagnostics never echo the arguments.
      expect(stderr.join('')).not.toMatch(new RegExp(`${s.operationId}|${TENANT_B.tenantId}|${SECRET}|database down`));
    }
    expect(end).toHaveBeenCalledOnce();
  });
});
