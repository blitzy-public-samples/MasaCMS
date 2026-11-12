import { existsSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { FIXTURES_UNAVAILABLE } from '../../src/golden/catalogue.js';
import { SEED_CONFIG_PATH } from '../../src/golden/session.js';
import { runCli } from '../../src/lib/cli.js';
import { createHttpSession, type FetchLike, type HttpSession } from '../../src/lib/http.js';
import { REPO_ROOT, type EnvLike } from '../../src/lib/paths.js';
import { readPin } from '../../src/lib/pin.js';
import {
  CLOUD_MEASUREMENT,
  EXPECTED_MIN_INSTANCES,
  GATEWAY_PROBES,
  GENERATED_BY,
  HOME_CONTENT_ID,
  POLL_LIMIT_MS,
  PROBE_INTERVAL_MS,
  READ_SET,
  REQUESTS_PER_SET,
  RESTART_SERVICES,
  STOP_KILL_AFTER_MS,
  STOP_POLL_MS,
  TIMESHEETS_ROLE,
  buildPerformanceReport,
  checkMinInstanceCounts,
  main,
  measureLatencySet,
  parseMinInstanceCounts,
  percentile,
  primeLookups,
  ratioFinding,
  renderPerformanceMarkdown,
  resolveReadPath,
  restartAndMeasure,
  skippedLatency,
  startProcess,
  stopProcess,
  summariseSamples,
  terraformPlanReportSchema,
  windowsOverThreshold,
  windowsReportSchema,
  type Finding,
  type GatewayProbe,
  type KillLike,
  type MainDeps,
  type PerformanceParts,
  type PerformanceReport,
  type ProbePlan,
  type ProcessDeps,
  type ReadSetEntry,
  type RestartService,
  type SpawnLike,
  type SpawnedProcess,
} from '../../src/performance/run.js';
import { portFor } from '../../src/repro/ports.js';
import { readUpState, writeUpState, type UpProcessEntry, type UpStatePatch } from '../../src/repro/up-state.js';

// Above Linux pid_max (at most 4194304), so no signal from a test can reach a real process.
const PID_BASE = 1_000_000_000;
// `.invalid` never resolves; every request goes to the fake fetch of its test.
const LEGACY = 'http://legacy.invalid';
const GATEWAY = 'http://gateway.invalid';
const LOGIN_PAGE = '/admin/?muraAction=clogin.main';
const LOGIN_POST = '/admin/?muraAction=cLogin.login';
const CONTENT_LIST = '/_api/json/v1/tenant-a/content/?type=Page';
const FEED_LIST = '/_api/json/v1/tenant-a/feed/?method=findQuery&entityname=feed';
const CONTENTNAV = `/_api/json/v1/tenant-a/contentnav/${HOME_CONTENT_ID}`;
const CUSERS = '/admin/?muraAction=cUsers.listUsers&siteid=tenant-a&ispublic=0';
const CSETTINGS = '/admin/?muraAction=cSettings.list';
const CSRF_TOKEN = 'FIXTURE-CSRF-0001';
const USAGE = 'usage: tsx src/performance/run.ts';
const SEED_ROLES = [
  TIMESHEETS_ROLE,
  'communications.sender',
  'reporting.exporter',
  'surveys.manager',
  'finance.preparer',
  'esignature.signer',
];
const SYNTHETIC: readonly RestartService[] = ['communications', 'reporting', 'surveys', 'timesheets', 'finance', 'e-signature'];
const FIXTURE_OWNERS: Readonly<Record<string, RestartService>> = {
  communications: 'communications',
  reporting: 'reporting',
  surveys: 'surveys',
  timesheets: 'timesheets',
  finance: 'finance',
  esignature: 'e-signature',
};
const LEGACY_MS = 4;
const TARGET_MS = 5;
const ESRCH = errno('ESRCH');
const EPERM = errno('EPERM');
const EINVAL = errno('EINVAL');

const savedArgv = process.argv;
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-performance-'));
});

afterEach(async () => {
  process.argv = savedArgv;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: fixture`), { code });
}

/** Placeholder password for `label`, assembled at run time so no credential-shaped literal sits in the source. */
function credential(label: string): string {
  return ['fixture', label, 'pw'].join('-');
}

function seedUsername(role: string): string {
  return `fixture-${role}`;
}

interface FakeClock {
  t: number;
  now: () => number;
  sleep: Mock<(ms: number) => Promise<void>>;
}

/** Clock that only `sleep` (and the fakes that model latency) advance. */
function fakeClock(): FakeClock {
  const clock: FakeClock = {
    t: 0,
    now: () => clock.t,
    sleep: vi.fn(async (ms: number) => {
      clock.t += ms;
    }),
  };
  return clock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function html(markup: string, setCookie: readonly string[] = []): Response {
  return new Response(`<!DOCTYPE html><html><body>${markup}</body></html>`, {
    headers: [['content-type', 'text/html; charset=utf-8'], ...setCookie.map((line): [string, string] => ['set-cookie', line])],
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function fakeChild(pid: number | undefined, error?: Error): { child: SpawnedProcess; unref: Mock<() => void> } {
  const unref = vi.fn<() => void>();
  const child: SpawnedProcess = {
    pid,
    unref,
    once: (_event, listener) => {
      if (error !== undefined) setImmediate(() => listener(error));
      return child;
    },
  };
  return { child, unref };
}

function readEntry(set: string): ReadSetEntry {
  const entry = READ_SET.find((candidate) => candidate.set === set);
  if (entry === undefined) throw new Error(`no read set ${set}`);
  return entry;
}

function count(items: readonly string[], wanted: string): number {
  return items.filter((item) => item === wanted).length;
}

describe('fixed configuration', () => {
  it('restarts the ten domain services and expects min_instance_count 0 for every deployed service but migration', () => {
    expect(RESTART_SERVICES).toStrictEqual([
      'identity',
      'people',
      'programs-sites',
      'strategies-content',
      'communications',
      'reporting',
      'surveys',
      'timesheets',
      'finance',
      'e-signature',
    ]);
    expect(Object.keys(GATEWAY_PROBES)).toStrictEqual([...RESTART_SERVICES]);
    expect(EXPECTED_MIN_INSTANCES).toStrictEqual({
      gateway: 0,
      web: 0,
      ...Object.fromEntries(RESTART_SERVICES.map((service) => [service, 0])),
      migration: 1,
    });
  });

  it('reads the GS-CO-05 sets, cusers.listusers, csettings.list and the fixture-backed timesheet sheet list', () => {
    expect(READ_SET.map((entry) => entry.set)).toStrictEqual([
      'gs-co-05.content.findOne',
      'gs-co-05.content.findMany',
      'gs-co-05.content.findQuery',
      'gs-co-05.contentnav',
      'gs-co-05.feed',
      'cusers.listusers',
      'csettings.list',
      'timesheets.sheets',
    ]);
    expect(READ_SET.filter((entry) => entry.fixtures === true).map((entry) => entry.set)).toStrictEqual(['timesheets.sheets']);
  });
});

describe('percentile', () => {
  const SAMPLES = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];

  it.each([
    [0, 1],
    [10, 1],
    [11, 2],
    [50, 5],
    [95, 10],
    [100, 10],
    [150, 10],
  ])('takes the nearest-rank sample at q=%i', (q, expected) => {
    expect(percentile(SAMPLES, q)).toBe(expected);
  });

  it('leaves the samples in their original order', () => {
    const samples = [3, 1, 2];
    percentile(samples, 50);
    expect(samples).toStrictEqual([3, 1, 2]);
  });

  it('throws a RangeError for an empty sample set', () => {
    expect(() => percentile([], 50)).toThrow(new RangeError('percentile of an empty sample set'));
  });
});

describe('summariseSamples', () => {
  it('rounds p50 and p95 to 0.1 ms', () => {
    expect(summariseSamples([0.26, 0.14])).toStrictEqual({ p50Ms: 0.1, p95Ms: 0.3 });
  });

  it('throws for an empty sample set', () => {
    expect(() => summariseSamples([])).toThrow(RangeError);
  });
});

describe('ratioFinding', () => {
  it.each([
    { target: 30, legacy: 20, ratioP95: 1.5, finding: null },
    { target: 31, legacy: 20, ratioP95: 1.55, finding: 'target p95 31 ms is 1.55x legacy p95 20 ms (above 1.5x)' },
    { target: 150.1, legacy: 100, ratioP95: 1.5, finding: 'target p95 150.1 ms is 1.5x legacy p95 100 ms (above 1.5x)' },
    { target: 2.1, legacy: 1.4, ratioP95: 1.5, finding: null },
    { target: 4.2, legacy: 2.8, ratioP95: 1.5, finding: null },
    { target: 20, legacy: 3, ratioP95: 6.67, finding: 'target p95 20 ms is 6.67x legacy p95 3 ms (above 1.5x)' },
    { target: 4, legacy: 8, ratioP95: 0.5, finding: null },
    { target: 12, legacy: 0, ratioP95: null, finding: null },
  ])('gives ratio $ratioP95 for target p95 $target ms over legacy p95 $legacy ms', ({ target, legacy, ratioP95, finding }) => {
    expect(ratioFinding({ p50Ms: 1, p95Ms: target }, { p50Ms: 1, p95Ms: legacy })).toStrictEqual({ ratioP95, finding });
  });
});

describe('resolveReadPath', () => {
  const VALUES = { asOf: '2026-06-30', ids: ['c 1', 'c/2'], feedId: 'feed&1' };

  it.each([
    ['gs-co-05.content.findOne', `/_api/json/v1/tenant-a/content/${HOME_CONTENT_ID}`],
    ['gs-co-05.content.findMany', '/_api/json/v1/tenant-a/content/c%201,c%2F2'],
    ['gs-co-05.feed', '/_api/feed/v1/tenant-a/?feedID=feed%261'],
    ['cusers.listusers', CUSERS],
    ['timesheets.sheets', '/legacy-fixtures/cfml/api.cfm/timesheets/sheets?siteid=tenant-a&asOf=2026-06-30'],
  ])('fills the encoded placeholders of %s', (set, expected) => {
    expect(resolveReadPath(readEntry(set), VALUES, true)).toStrictEqual({ path: expected });
  });

  it('resolves a set without placeholders when the priming lookups found nothing', () => {
    expect(resolveReadPath(readEntry('csettings.list'), { asOf: '2026-06-30', ids: [], feedId: undefined }, false)).toStrictEqual({
      path: CSETTINGS,
    });
  });

  it.each([
    ['timesheets.sheets', VALUES, false, FIXTURES_UNAVAILABLE],
    ['gs-co-05.content.findMany', { ...VALUES, ids: [] }, true, `no content ids from GET ${CONTENT_LIST} on legacy`],
    ['gs-co-05.feed', { ...VALUES, feedId: undefined }, true, `no feed id from GET ${FEED_LIST} on legacy`],
  ])('skips %s with the reason it cannot be measured', (set, values, fixturesAvailable, reason) => {
    expect(resolveReadPath(readEntry(set), values, fixturesAvailable)).toStrictEqual({ skipped: reason });
  });
});

describe('primeLookups', () => {
  function primingSession(content: Response, feed: Response): { session: HttpSession; calls: string[] } {
    const calls: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      calls.push(`${init.method ?? 'GET'} ${input}`);
      const url = new URL(input);
      const target = `${url.pathname}${url.search}`;
      if (target === CONTENT_LIST) return content;
      if (target === FEED_LIST) return feed;
      throw new Error(`unscripted request ${input}`);
    };
    return { session: createHttpSession({ baseUrl: LEGACY, fetch }), calls };
  }

  it('takes up to five content ids and the first feed id, matching field names case-insensitively', async () => {
    const { session, calls } = primingSession(
      json({
        data: {
          items: [
            { ContentID: 'c1' },
            { id: 'c2' },
            { contentid: '', id: 'c3' },
            { contentid: 7 },
            { contentid: 'c4' },
            { CONTENTID: 'c5' },
            { contentid: 'c6' },
          ],
        },
      }),
      json({ data: { items: [{ FeedID: 'f1' }, { feedid: 'f2' }] } }),
    );
    await expect(primeLookups(session)).resolves.toStrictEqual({ ids: ['c1', 'c2', 'c3', 'c4', 'c5'], feedId: 'f1' });
    expect(calls).toStrictEqual([`GET ${LEGACY}${CONTENT_LIST}`, `GET ${LEGACY}${FEED_LIST}`]);
  });

  it.each([
    ['answers 500', () => json({ data: { items: [{ contentid: 'c1', feedid: 'f1' }] } }, 500)],
    ['answers a body that is not JSON', () => new Response('<html>maintenance</html>')],
    ['answers JSON without data.items', () => json({ data: { item: [] } })],
    ['answers items that are not objects', () => json({ data: { items: ['c1'] } })],
    ['answers no items', () => json({ data: { items: [] } })],
  ])('reads no ids and no feed id when each lookup %s', async (_label, reply) => {
    const { session } = primingSession(reply(), reply());
    await expect(primeLookups(session)).resolves.toStrictEqual({ ids: [], feedId: undefined });
  });

  it('reads no feed id when the first feed has none', async () => {
    const { session } = primingSession(
      json({ data: { items: [{ contentid: 'c1' }] } }),
      json({ data: { items: [{ name: 'news' }, { feedid: 'f2' }] } }),
    );
    await expect(primeLookups(session)).resolves.toStrictEqual({ ids: ['c1'], feedId: undefined });
  });
});

describe('measureLatencySet', () => {
  /** Session whose every request takes the next scripted duration on `clock` and answers its status. */
  function timedSession(
    side: string,
    clock: FakeClock,
    script: readonly (readonly [ms: number, status: number])[],
    log: string[],
  ): HttpSession {
    const pending = [...script];
    const fetch: FetchLike = async (input) => {
      const next = pending.shift();
      if (next === undefined) throw new Error(`unscripted ${side} request ${input}`);
      log.push(`${side} ${new URL(input).pathname}${new URL(input).search}`);
      clock.t += next[0];
      return new Response('{}', { status: next[1] });
    };
    return createHttpSession({ baseUrl: side === 'legacy' ? LEGACY : GATEWAY, fetch });
  }

  it('requests each side in turn, legacy first, and summarises the time to each read body', async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const ok = (ms: number) => [ms, 200] as const;
    const legacy = timedSession('legacy', clock, [10, 20, 30, 40].map(ok), log);
    const target = timedSession('target', clock, [15, 25, 35, 45].map(ok), log);
    const measured = await measureLatencySet(
      { set: 'csettings.list', path: CSETTINGS },
      { legacy, target },
      { requests: 4, now: clock.now },
    );
    expect(log).toStrictEqual(Array.from({ length: 4 }, () => [`legacy ${CSETTINGS}`, `target ${CSETTINGS}`]).flat());
    expect(measured).toStrictEqual({
      row: {
        set: 'csettings.list',
        requests: 4,
        legacy: { p50Ms: 20, p95Ms: 40 },
        target: { p50Ms: 25, p95Ms: 45 },
        ratioP95: 1.13,
        finding: null,
      },
      findings: [],
    });
  });

  it('raises a latency-ratio finding and, per side, one non-ok-response finding listing its distinct statuses', async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const legacy = timedSession('legacy', clock, [[10, 200], [10, 500], [10, 200]], log);
    const target = timedSession('target', clock, [[40, 500], [40, 404], [40, 404]], log);
    const measured = await measureLatencySet({ set: 'cusers.listusers', path: CUSERS }, { legacy, target }, { requests: 3, now: clock.now });
    const finding = 'target p95 40 ms is 4x legacy p95 10 ms (above 1.5x)';
    expect(measured.row).toStrictEqual({
      set: 'cusers.listusers',
      requests: 3,
      legacy: { p50Ms: 10, p95Ms: 10 },
      target: { p50Ms: 40, p95Ms: 40 },
      ratioP95: 4,
      finding,
    });
    expect(measured.findings).toStrictEqual([
      { kind: 'latency-ratio', subject: 'cusers.listusers', detail: finding },
      { kind: 'non-ok-response', subject: 'cusers.listusers/legacy', detail: '1 of 3: 500' },
      { kind: 'non-ok-response', subject: 'cusers.listusers/target', detail: '3 of 3: 404, 500' },
    ]);
  });
});

describe('skippedLatency', () => {
  it('records zero requests with null sides and its reason as both row finding and set-skipped finding', () => {
    expect(skippedLatency('timesheets.sheets', FIXTURES_UNAVAILABLE)).toStrictEqual({
      row: { set: 'timesheets.sheets', requests: 0, target: null, legacy: null, ratioP95: null, finding: FIXTURES_UNAVAILABLE },
      findings: [{ kind: 'set-skipped', subject: 'timesheets.sheets', detail: FIXTURES_UNAVAILABLE }],
    });
  });
});

describe('stopProcess', () => {
  const PID = PID_BASE + 1;

  /** Kill stub recording every call; `answer` returns to accept a signal or throws to refuse it. */
  function scriptedKill(answer: (pid: number, signal: NodeJS.Signals | 0) => void): {
    kill: KillLike;
    calls: [number, NodeJS.Signals | 0][];
  } {
    const calls: [number, NodeJS.Signals | 0][] = [];
    const kill: KillLike = (pid, signal) => {
      calls.push([pid, signal]);
      answer(pid, signal);
      return true;
    };
    return { kill, calls };
  }

  it('SIGTERMs the process group and polls every STOP_POLL_MS until the group is gone', async () => {
    const clock = fakeClock();
    let probes = 0;
    const { kill, calls } = scriptedKill((_pid, signal) => {
      if (signal === 0 && ++probes > 2) throw ESRCH;
    });
    await stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep });
    expect(calls).toStrictEqual([
      [-PID, 'SIGTERM'],
      [-PID, 0],
      [-PID, 0],
      [-PID, 0],
    ]);
    expect(clock.sleep.mock.calls).toStrictEqual([[STOP_POLL_MS], [STOP_POLL_MS]]);
  });

  it.each(['ESRCH', 'EPERM'])('signals and polls the pid alone when signalling the group fails with %s', async (code) => {
    const clock = fakeClock();
    const { kill, calls } = scriptedKill((pid, signal) => {
      if (pid < 0) throw errno(code);
      if (signal === 0) throw ESRCH;
    });
    await stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep });
    expect(calls).toStrictEqual([
      [-PID, 'SIGTERM'],
      [PID, 'SIGTERM'],
      [PID, 0],
    ]);
  });

  it('returns without polling when neither the group nor the pid exists', async () => {
    const clock = fakeClock();
    const { kill, calls } = scriptedKill(() => {
      throw ESRCH;
    });
    await stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep });
    expect(calls).toStrictEqual([
      [-PID, 'SIGTERM'],
      [PID, 'SIGTERM'],
    ]);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('keeps polling while the liveness probe answers EPERM', async () => {
    const clock = fakeClock();
    let probes = 0;
    const { kill, calls } = scriptedKill((_pid, signal) => {
      if (signal === 0) throw ++probes === 1 ? EPERM : ESRCH;
    });
    await stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep });
    expect(calls).toStrictEqual([
      [-PID, 'SIGTERM'],
      [-PID, 0],
      [-PID, 0],
    ]);
    expect(clock.sleep.mock.calls).toStrictEqual([[STOP_POLL_MS]]);
  });

  it.each([
    ['succeeds', () => undefined],
    ['finds the group already gone', () => {
      throw ESRCH;
    }],
  ])('sends one SIGKILL STOP_KILL_AFTER_MS after SIGTERM and returns once the group exits, when the SIGKILL %s', async (_label, onKill) => {
    const clock = fakeClock();
    let killedAt: number | undefined;
    const { kill, calls } = scriptedKill((_pid, signal) => {
      if (signal === 'SIGKILL') {
        killedAt = clock.t;
        onKill();
      } else if (signal === 0 && killedAt !== undefined) {
        throw ESRCH;
      }
    });
    await stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep });
    expect(killedAt).toBe(STOP_KILL_AFTER_MS);
    expect(calls.filter(([, signal]) => signal === 'SIGKILL')).toStrictEqual([[-PID, 'SIGKILL']]);
    expect(clock.t).toBe(STOP_KILL_AFTER_MS + STOP_POLL_MS);
  });

  it('throws when the group still runs POLL_LIMIT_MS after SIGTERM, having sent SIGKILL once', async () => {
    const clock = fakeClock();
    const { kill, calls } = scriptedKill(() => undefined);
    await expect(stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep })).rejects.toThrow(
      `pid ${PID} still running ${POLL_LIMIT_MS} ms after SIGTERM`,
    );
    expect(calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
    expect(clock.t).toBe(POLL_LIMIT_MS);
  });

  it.each<{ label: string; thrown: unknown; answer: (pid: number, signal: NodeJS.Signals | 0) => void }>([
    {
      label: 'signalling the group fails with EINVAL',
      thrown: EINVAL,
      answer: (pid) => {
        if (pid < 0) throw EINVAL;
      },
    },
    {
      label: 'signalling the group throws a value without an errno code',
      thrown: 'kill refused',
      answer: (pid) => {
        if (pid < 0) throw 'kill refused';
      },
    },
    {
      label: 'signalling the pid fails with EPERM after the group is gone',
      thrown: EPERM,
      answer: (pid) => {
        throw pid < 0 ? ESRCH : EPERM;
      },
    },
    {
      label: 'the liveness probe fails with EINVAL',
      thrown: EINVAL,
      answer: (_pid, signal) => {
        if (signal === 0) throw EINVAL;
      },
    },
    {
      label: 'SIGKILL fails with EPERM',
      thrown: EPERM,
      answer: (_pid, signal) => {
        if (signal === 'SIGKILL') throw EPERM;
      },
    },
  ])('rethrows when $label', async ({ thrown, answer }) => {
    const clock = fakeClock();
    const { kill } = scriptedKill(answer);
    await expect(stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep })).rejects.toBe(thrown);
  });
});

describe('startProcess', () => {
  const OLD = PID_BASE + 10;
  const NEW = PID_BASE + 20;

  function deps(spawn: SpawnLike): { spawn: Mock<SpawnLike>; writeUpState: Mock<(patch: UpStatePatch) => unknown> } {
    return { spawn: vi.fn<SpawnLike>(spawn), writeUpState: vi.fn<(patch: UpStatePatch) => unknown>() };
  }

  it.each<[string, UpProcessEntry['command'], string, string[]]>([
    ['an argv as is', ['node', 'dist/server.js', '--flag'], 'node', ['dist/server.js', '--flag']],
    ['a string through /bin/sh -c', 'npm run start -- --flag', '/bin/sh', ['-c', 'npm run start -- --flag']],
  ])('spawns %s, detached in the entry cwd with its env and output ignored, and records the new pid', async (_label, command, file, args) => {
    const { child, unref } = fakeChild(NEW);
    const d = deps(() => child);
    const entry: UpProcessEntry = { pid: OLD, cwd: tmp, command, env: { OPT2_SERVICE: 'people' } };
    await expect(startProcess('people', entry, d)).resolves.toBe(NEW);
    expect(d.spawn).toHaveBeenCalledTimes(1);
    const [calledFile, calledArgs, options] = d.spawn.mock.calls[0] ?? [];
    expect([calledFile, calledArgs]).toStrictEqual([file, args]);
    expect(options).toStrictEqual({
      cwd: tmp,
      env: { ...process.env, OPT2_SERVICE: 'people' },
      detached: true,
      stdio: 'ignore',
    });
    expect(unref).toHaveBeenCalledTimes(1);
    expect(d.writeUpState.mock.calls).toStrictEqual([[{ processes: { people: { ...entry, pid: NEW } } }]]);
  });

  it('appends stdout and stderr to the log file under the entry cwd, created owner-only', async () => {
    const d = deps(() => fakeChild(NEW).child);
    await startProcess('people', { pid: OLD, cwd: tmp, command: ['node'], log: 'people.log' }, d);
    const stdio = d.spawn.mock.calls[0]?.[2].stdio;
    expect(stdio).toStrictEqual(['ignore', expect.any(Number), expect.any(Number)]);
    expect((stdio as unknown[])[1]).toBe((stdio as unknown[])[2]);
    expect(statSync(path.join(tmp, 'people.log')).mode & 0o777).toBe(0o600);
  });

  it('rejects naming the command, with the spawn error as cause, and records nothing when no pid is assigned', async () => {
    const failure = new Error('spawn node ENOENT');
    const { child, unref } = fakeChild(undefined, failure);
    const d = deps(() => child);
    const err: unknown = await startProcess('people', { pid: OLD, cwd: tmp, command: ['node'] }, d).catch((reason: unknown) => reason);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('people: cannot start node');
    expect((err as Error).cause).toBe(failure);
    expect(unref).not.toHaveBeenCalled();
    expect(d.writeUpState).not.toHaveBeenCalled();
  });

  it('rethrows an error the spawn call throws, after opening the log, and records nothing', async () => {
    const d = deps(() => {
      throw EPERM;
    });
    await expect(startProcess('people', { pid: OLD, cwd: tmp, command: 'npm start', log: 'people.log' }, d)).rejects.toBe(EPERM);
    expect(existsSync(path.join(tmp, 'people.log'))).toBe(true);
    expect(d.writeUpState).not.toHaveBeenCalled();
  });
});

describe('restartAndMeasure', () => {
  const OLD = PID_BASE + 30;
  const NEW = PID_BASE + 31;
  const PEOPLE_PORT = 28_112;
  const HEALTH_URL = `http://127.0.0.1:${PEOPLE_PORT}/healthz`;
  const PROBE_DESCRIBE = `GET ${CUSERS} as admin`;

  function peopleEntry(withPort = true): UpProcessEntry {
    return {
      pid: OLD,
      ...(withPort ? { port: PEOPLE_PORT } : {}),
      cwd: tmp,
      command: ['node', 'dist/server.js'],
      env: { OPT2_SERVICE: 'people' },
    };
  }

  interface RigOptions {
    processes?: Record<string, UpProcessEntry>;
    /** Answer to the n-th /healthz request; throwing refuses the connection. */
    health?: (poll: number) => Response;
    child?: SpawnedProcess;
    kill?: KillLike;
  }

  /** Restart deps over one live old pid; every /healthz request advances the clock 0.25 ms. */
  function restartRig(opts: RigOptions = {}) {
    const clock = fakeClock();
    const alive = new Set([OLD]);
    const signals: [number, NodeJS.Signals | 0][] = [];
    const healthUrls: string[] = [];
    const kill: KillLike =
      opts.kill ??
      ((pid, signal) => {
        signals.push([pid, signal]);
        if (!alive.has(Math.abs(pid))) throw ESRCH;
        if (signal !== 0) alive.delete(Math.abs(pid));
        return true;
      });
    const fetch = vi.fn<FetchLike>(async (input) => {
      healthUrls.push(input);
      clock.t += 0.25;
      return (opts.health ?? (() => new Response('ok')))(healthUrls.length);
    });
    const spawn = vi.fn<SpawnLike>(() => opts.child ?? fakeChild(NEW).child);
    const writeUp = vi.fn<(patch: UpStatePatch) => unknown>();
    const processes = opts.processes ?? { people: peopleEntry() };
    const deps: ProcessDeps = {
      spawn,
      kill,
      fetch,
      now: clock.now,
      sleep: clock.sleep,
      readUpState: () => ({ processes }),
      writeUpState: writeUp,
    };
    return { deps, clock, signals, healthUrls, fetch, spawn, writeUp };
  }

  function probeAnswering(answer: (call: number) => boolean): GatewayProbe & {
    attempt: Mock<(timeoutMs: number) => Promise<boolean>>;
  } {
    let calls = 0;
    return { describe: PROBE_DESCRIBE, attempt: vi.fn(async (_timeoutMs: number) => answer(++calls)) };
  }

  it.each([
    ['the entry port', true, HEALTH_URL],
    ['the ports.env port when the entry has none', false, `http://127.0.0.1:${portFor('people')}/healthz`],
  ])(
    'times the first /healthz 200 and the first gateway success from the restart, polling /healthz on %s',
    async (_label, withPort, healthUrl) => {
      const entry = peopleEntry(withPort);
      const rig = restartRig({
        processes: { people: entry },
        health: (poll) => new Response(null, { status: poll <= 2 ? 503 : 200 }),
      });
      const probe = probeAnswering((call) => call >= 3);
      const outcome = await restartAndMeasure('people', rig.deps, probe);
      expect(outcome).toStrictEqual({
        coldStart: { service: 'people', startToFirst200Ms: 100.8, label: 'measured' },
        scaleToZero: { service: 'people', stopToFirstSuccessMs: 150.8, label: 'derived' },
        findings: [],
        unhealthy: false,
      });
      expect(rig.signals).toStrictEqual([
        [-OLD, 'SIGTERM'],
        [-OLD, 0],
      ]);
      expect(rig.healthUrls).toStrictEqual([healthUrl, healthUrl, healthUrl]);
      expect(rig.fetch.mock.calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true);
      expect(probe.attempt.mock.calls).toStrictEqual([[POLL_LIMIT_MS], [POLL_LIMIT_MS], [POLL_LIMIT_MS - PROBE_INTERVAL_MS]]);
      expect(rig.writeUp.mock.calls).toStrictEqual([[{ processes: { people: { ...entry, pid: NEW } } }]]);
    },
  );

  it.each(['gateway', 'web', 'migration', 'stub', 'legacy'])('rejects %s, which is not a restartable target service', async (name) => {
    await expect(restartAndMeasure(name, restartRig().deps, { skipped: FIXTURES_UNAVAILABLE })).rejects.toThrow(
      `${name} is not a restartable target service`,
    );
  });

  interface OutcomeCase {
    label: string;
    rig: () => ReturnType<typeof restartRig>;
    probe: () => ProbePlan;
    spawns: number;
    cold: number | null;
    scale: number | null;
    unhealthy: boolean;
    findings: Finding[];
  }

  it.each<OutcomeCase>([
    {
      label: 'process-entry-missing, restarting nothing, when up.json has no entry for the service',
      rig: () => restartRig({ processes: {} }),
      probe: () => probeAnswering(() => false),
      spawns: 0,
      cold: null,
      scale: null,
      unhealthy: false,
      findings: [{ kind: 'process-entry-missing', subject: 'people', detail: 'no people entry in up.json' }],
    },
    {
      label: 'stop-failed, starting nothing, when the stop throws',
      rig: () =>
        restartRig({
          kill: () => {
            throw EINVAL;
          },
        }),
      probe: () => probeAnswering(() => false),
      spawns: 0,
      cold: null,
      scale: null,
      unhealthy: false,
      findings: [{ kind: 'stop-failed', subject: 'people', detail: 'EINVAL: fixture' }],
    },
    {
      label: 'start-failed and unhealthy when the spawn assigns no pid',
      rig: () => restartRig({ child: fakeChild(undefined, new Error('spawn node ENOENT')).child }),
      probe: () => probeAnswering(() => false),
      spawns: 1,
      cold: null,
      scale: null,
      unhealthy: true,
      findings: [{ kind: 'start-failed', subject: 'people', detail: 'people: cannot start node' }],
    },
    {
      label: 'cold-start-timeout and unhealthy when /healthz refuses every poll',
      rig: () =>
        restartRig({
          health: () => {
            throw errno('ECONNREFUSED');
          },
        }),
      probe: () => probeAnswering(() => false),
      spawns: 1,
      cold: null,
      scale: null,
      unhealthy: true,
      findings: [{ kind: 'cold-start-timeout', subject: 'people', detail: `${HEALTH_URL} did not answer 200 within ${POLL_LIMIT_MS} ms` }],
    },
    {
      label: 'scale-probe-skipped with the cold start measured when the probe is skipped',
      rig: () => restartRig(),
      probe: () => ({ skipped: FIXTURES_UNAVAILABLE }),
      spawns: 1,
      cold: 0.3,
      scale: null,
      unhealthy: false,
      findings: [{ kind: 'scale-probe-skipped', subject: 'people', detail: FIXTURES_UNAVAILABLE }],
    },
    {
      label: 'probe-not-routed when the gateway answers the probe while the service is stopped',
      rig: () => restartRig(),
      probe: () => probeAnswering(() => true),
      spawns: 1,
      cold: 0.3,
      scale: null,
      unhealthy: false,
      findings: [
        {
          kind: 'probe-not-routed',
          subject: 'people',
          detail: `${PROBE_DESCRIBE} answered 200 through the gateway while people was stopped`,
        },
      ],
    },
    {
      label: 'scale-probe-timeout and unhealthy when every probe after the restart fails',
      rig: () => restartRig(),
      probe: () =>
        probeAnswering(() => {
          throw new Error('socket hang up');
        }),
      spawns: 1,
      cold: 0.3,
      scale: null,
      unhealthy: true,
      findings: [
        {
          kind: 'scale-probe-timeout',
          subject: 'people',
          detail: `${PROBE_DESCRIBE} did not answer 200 through the gateway within ${POLL_LIMIT_MS} ms`,
        },
      ],
    },
  ])('reports $label', async (c) => {
    const rig = c.rig();
    const outcome = await restartAndMeasure('people', rig.deps, c.probe());
    expect(outcome).toStrictEqual({
      coldStart: { service: 'people', startToFirst200Ms: c.cold, label: 'measured' },
      scaleToZero: { service: 'people', stopToFirstSuccessMs: c.scale, label: 'derived' },
      findings: c.findings,
      unhealthy: c.unhealthy,
    });
    expect(rig.spawn).toHaveBeenCalledTimes(c.spawns);
  });
});

describe('parseMinInstanceCounts', () => {
  const CLOUD_RUN = 'google_cloud_run_v2_service';
  const PLAN = {
    planned_values: {
      root_module: {
        resources: [
          {
            address: 'google_cloud_run_v2_service.gateway',
            type: CLOUD_RUN,
            values: { name: 'opt2-gateway', template: [{ scaling: [{ min_instance_count: 0 }] }] },
          },
          { address: 'google_storage_bucket.exports', type: 'google_storage_bucket', values: { name: 'opt2-exports' } },
          { type: CLOUD_RUN, values: null },
        ],
        child_modules: [
          {
            resources: [
              {
                address: 'module.services["people"].google_cloud_run_v2_service.this',
                type: CLOUD_RUN,
                values: { name: 'opt2-people-renamed', template: [{ scaling: [{ min_instance_count: 0 }] }] },
              },
              {
                address: 'module.services["migration"].google_cloud_run_v2_service.this',
                type: CLOUD_RUN,
                values: { scaling: [{ min_instance_count: 1 }] },
              },
              {
                address: 'module.services["web"].google_cloud_run_v2_service.this',
                type: CLOUD_RUN,
                values: { template: [{ scaling: null }] },
              },
              {
                address: 'module.services["finance"].google_cloud_run_v2_service.this',
                type: CLOUD_RUN,
                values: { name: 42, template: 'not-a-list', scaling: [{ min_instance_count: 'two' }] },
              },
              { address: 'module.services["timesheets"].google_cloud_run_v2_service.this', type: CLOUD_RUN },
            ],
            child_modules: [
              {},
              {
                resources: [
                  {
                    address: 'module.services["surveys"].module.inner.google_cloud_run_v2_service.this',
                    type: CLOUD_RUN,
                    values: { template: [{ scaling: [{ min_instance_count: 2 }] }] },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
  const FROM_PLAN = { gateway: 0, people: 0, migration: 1, web: 0, finance: 0, timesheets: 0, surveys: 2 };

  it.each([
    ['no report', undefined, { source: 'unavailable', values: {} }],
    ['a null plan', terraformPlanReportSchema.parse({ plan: null }), { source: 'unavailable', values: {} }],
    ['a plan without planned_values', terraformPlanReportSchema.parse({ plan: {} }), { source: 'unavailable', values: {} }],
    [
      'planned_values without a root module',
      terraformPlanReportSchema.parse({ plan: { planned_values: {} } }),
      { source: 'plan.planned_values', values: {} },
    ],
    [
      'a non-empty minInstanceCounts summary beside a plan',
      terraformPlanReportSchema.parse({ minInstanceCounts: { gateway: 0, migration: 1 }, plan: PLAN }),
      { source: 'minInstanceCounts', values: { gateway: 0, migration: 1 } },
    ],
  ])('reads %s', (_label, report, expected) => {
    expect(parseMinInstanceCounts(report)).toStrictEqual(expected);
  });

  it.each([
    ['no summary', {}],
    ['an empty summary', { minInstanceCounts: {} }],
    ['a null summary', { minInstanceCounts: null }],
  ])(
    'walks every Cloud Run service of the plan, keyed by module instance else by name, with %s',
    (_label, summary) => {
      expect(parseMinInstanceCounts(terraformPlanReportSchema.parse({ ...summary, plan: PLAN }))).toStrictEqual({
        source: 'plan.planned_values',
        values: FROM_PLAN,
      });
    },
  );
});

describe('checkMinInstanceCounts', () => {
  it('raises nothing when every expected service is planned at its count and extras plan 0', () => {
    expect(checkMinInstanceCounts({ ...EXPECTED_MIN_INSTANCES, 'extra-service': 0 })).toStrictEqual([]);
  });

  it('flags an absent service, a differing count and an unexpected service planned above 0', () => {
    const values: Record<string, number> = { ...EXPECTED_MIN_INSTANCES, migration: 0, 'legacy-bridge': 2 };
    delete values.web;
    expect(checkMinInstanceCounts(values)).toStrictEqual([
      { kind: 'min-instance-count-missing', subject: 'web', detail: 'expected 0, absent from the plan' },
      { kind: 'min-instance-count', subject: 'migration', detail: 'expected 1, planned 0' },
      { kind: 'min-instance-count-unexpected', subject: 'legacy-bridge', detail: 'not an expected service; planned 2, expected 0' },
    ]);
  });
});

describe('windowsOverThreshold', () => {
  it('flags windows longer than 5000 ms, longest first, spanning first to last phase when durationMs is absent', () => {
    const report = windowsReportSchema.parse({
      windows: [
        { windowId: 'w-at', routeKey: 'cusers.update', durationMs: 5000 },
        { windowId: 'w-over', routeKey: 'csettings.update', durationMs: 5001 },
        {
          windowId: 'w-phases',
          routeKey: 'carch.update',
          phases: [
            { phase: 'opened', at: '2026-06-30T10:00:00.000Z' },
            { phase: 'applied', at: '2026-06-30T10:00:03.000Z' },
            { phase: 'closed', at: '2026-06-30T10:00:07.500Z' },
          ],
        },
        { windowId: 'w-one-phase', routeKey: 'cusers.delete', phases: [{ phase: 'opened', at: '2026-06-30T10:00:00.000Z' }] },
        { windowId: 'w-bare', routeKey: 'cperm.update' },
      ],
    });
    expect(windowsOverThreshold(report)).toStrictEqual([
      { windowId: 'w-phases', routeKey: 'carch.update', durationMs: 7500 },
      { windowId: 'w-over', routeKey: 'csettings.update', durationMs: 5001 },
    ]);
  });

  it.each([
    ['no report', undefined],
    ['a report without windows', windowsReportSchema.parse({})],
  ])('flags nothing for %s', (_label, report) => {
    expect(windowsOverThreshold(report)).toStrictEqual([]);
  });
});

describe('buildPerformanceReport', () => {
  it('adds the min-instance and window findings and sorts all findings by kind, subject and detail', () => {
    const parts: PerformanceParts = {
      latency: [skippedLatency('timesheets.sheets', FIXTURES_UNAVAILABLE).row],
      coldStart: [{ service: 'people', startToFirst200Ms: 12.5, label: 'measured' }],
      scaleToZero: [{ service: 'people', stopToFirstSuccessMs: 30.1, label: 'derived' }],
      minInstanceCount: { source: 'minInstanceCounts', values: { ...EXPECTED_MIN_INSTANCES, migration: 0 } },
      windowsOverThreshold: [{ windowId: 'w-1', routeKey: 'cusers.update', durationMs: 6000 }],
      findings: [
        { kind: 'set-skipped', subject: 'timesheets.sheets', detail: 'b' },
        { kind: 'latency-ratio', subject: 'cusers.listusers', detail: 'x' },
        { kind: 'set-skipped', subject: 'timesheets.sheets', detail: 'a' },
        { kind: 'latency-ratio', subject: 'csettings.list', detail: 'x' },
      ],
    };
    const before = structuredClone(parts.findings);
    expect(buildPerformanceReport(parts)).toStrictEqual({
      latency: parts.latency,
      coldStart: parts.coldStart,
      minInstanceCount: { ...parts.minInstanceCount, label: 'measured' },
      scaleToZero: parts.scaleToZero,
      windowsOverThreshold: parts.windowsOverThreshold,
      findings: [
        { kind: 'latency-ratio', subject: 'csettings.list', detail: 'x' },
        { kind: 'latency-ratio', subject: 'cusers.listusers', detail: 'x' },
        { kind: 'min-instance-count', subject: 'migration', detail: 'expected 1, planned 0' },
        { kind: 'set-skipped', subject: 'timesheets.sheets', detail: 'a' },
        { kind: 'set-skipped', subject: 'timesheets.sheets', detail: 'b' },
        { kind: 'window-over-threshold', subject: 'w-1', detail: 'cusers.update 6000 ms' },
      ],
      cloudMeasurement: CLOUD_MEASUREMENT,
    });
    expect(parts.findings).toStrictEqual(before);
  });
});

describe('renderPerformanceMarkdown', () => {
  const REPORT: PerformanceReport = {
    latency: [
      {
        set: 'csettings.list',
        requests: 200,
        target: { p50Ms: 5, p95Ms: 9.5 },
        legacy: { p50Ms: 4, p95Ms: 4.5 },
        ratioP95: 2.11,
        finding: 'target p95 9.5 ms is 2.11x legacy p95 4.5 ms (above 1.5x)',
      },
      { set: 'cusers.listusers', requests: 200, target: { p50Ms: 5, p95Ms: 5 }, legacy: { p50Ms: 4, p95Ms: 4 }, ratioP95: 1.25, finding: null },
      { set: 'gs-co-05.feed', requests: 0, target: null, legacy: null, ratioP95: null, finding: 'no feed id | none' },
    ],
    coldStart: [
      { service: 'people', startToFirst200Ms: 12.5, label: 'measured' },
      { service: 'finance', startToFirst200Ms: null, label: 'measured' },
    ],
    minInstanceCount: {
      source: 'plan.planned_values',
      values: { gateway: 0, migration: 1, 'zeta-extra': 0, 'alpha-extra': 3 },
      label: 'measured',
    },
    scaleToZero: [
      { service: 'people', stopToFirstSuccessMs: 30.1, label: 'derived' },
      { service: 'finance', stopToFirstSuccessMs: null, label: 'derived' },
    ],
    windowsOverThreshold: [{ windowId: 'w-1', routeKey: 'cusers.update', durationMs: 6000 }],
    findings: [{ kind: 'latency-ratio', subject: 'csettings.list', detail: 'a|b' }],
    cloudMeasurement: CLOUD_MEASUREMENT,
  };

  it('renders the method, one table per measurement with n/a for null cells and escaped pipes, and the findings', () => {
    expect(renderPerformanceMarkdown(REPORT)).toStrictEqual([
      '## Method',
      '',
      '- 200 sequential requests per read set and side, interleaved: one legacy request, then one target request.',
      '- p50 and p95 by nearest rank, in ms rounded to 0.1.',
      '- Target is the gateway with the active cut-over version; legacy is the ColdFusion origin, requested directly.',
      '- The request sets no latency threshold: a target p95 above 1.5x legacy and a write window over 5 s are flags, not failures.',
      "- The legacy-direct admin and timesheet sessions log in on legacy itself, which updates that user's `tusers.LastLogin` on the legacy side.",
      '- Cold start is measured locally (process start to the first `/healthz` 200); scale to zero and back is derived (stopped service, restart, first successful request through the gateway). Each poll is bounded at 60000 ms.',
      '- Cloud measurement: not possible without apply.',
      '',
      '## Latency',
      '',
      '| Set | Requests | Target p50 (ms) | Target p95 (ms) | Legacy p50 (ms) | Legacy p95 (ms) | Ratio p95 | Finding |',
      '|---|---|---|---|---|---|---|---|',
      '| csettings.list | 200 | 5 | 9.5 | 4 | 4.5 | 2.11 | target p95 9.5 ms is 2.11x legacy p95 4.5 ms (above 1.5x) |',
      '| cusers.listusers | 200 | 5 | 5 | 4 | 4 | 1.25 |  |',
      '| gs-co-05.feed | 0 | n/a | n/a | n/a | n/a | n/a | no feed id \\| none |',
      '',
      '## Cold start (measured)',
      '',
      '| Service | Start to first 200 (ms) |',
      '|---|---|',
      '| people | 12.5 |',
      '| finance | n/a |',
      '',
      '## min_instance_count (measured from the Terraform plan)',
      '',
      'Source: `plan.planned_values`.',
      '',
      '| Service | Planned | Expected |',
      '|---|---|---|',
      '| gateway | 0 | 0 |',
      '| web | absent | 0 |',
      '| identity | absent | 0 |',
      '| people | absent | 0 |',
      '| programs-sites | absent | 0 |',
      '| strategies-content | absent | 0 |',
      '| communications | absent | 0 |',
      '| reporting | absent | 0 |',
      '| surveys | absent | 0 |',
      '| timesheets | absent | 0 |',
      '| finance | absent | 0 |',
      '| e-signature | absent | 0 |',
      '| migration | 1 | 1 |',
      '| alpha-extra | 3 | 0 |',
      '| zeta-extra | 0 | 0 |',
      '',
      '## Scale to zero and back (derived)',
      '',
      '| Service | Stop to first success through the gateway (ms) |',
      '|---|---|',
      '| people | 30.1 |',
      '| finance | n/a |',
      '',
      '## Windows over 5 s',
      '',
      '| Window | Route key | Duration (ms) |',
      '|---|---|---|',
      '| w-1 | cusers.update | 6000 |',
      '',
      '## Findings',
      '',
      '| Kind | Subject | Detail |',
      '|---|---|---|',
      '| latency-ratio | csettings.list | a\\|b |',
    ]);
  });

  it('writes None. for no windows over the threshold and no findings', () => {
    const lines = renderPerformanceMarkdown({ ...REPORT, windowsOverThreshold: [], findings: [] });
    expect(lines.slice(lines.indexOf('## Windows over 5 s'))).toStrictEqual([
      '## Windows over 5 s',
      '',
      'None.',
      '',
      '## Findings',
      '',
      'None.',
    ]);
  });
});

describe('main', () => {
  const LOGIN_FORM = `
<form novalidate="novalidate" id="loginForm" name="frmLogin" method="post" action="./?muraAction=cLogin.login">
  <input id="username" name="username" type="text">
  <input id="password" type="password" name="password">
  <input type="hidden" name="isAdminLogin" value="true">
  <input type="hidden" name="csrf_token" value="${CSRF_TOKEN}">
  <input type="hidden" name="csrf_token_expires" value="260630120000000">
</form>`;
  const BUSINESS_DATE = (JSON.parse(readFileSync(SEED_CONFIG_PATH, 'utf8')) as { businessDate: string }).businessDate;
  const TIMESHEET_SHEETS = `/legacy-fixtures/cfml/api.cfm/timesheets/sheets?siteid=tenant-a&asOf=${BUSINESS_DATE}`;
  const MEASURED_PATHS = [
    `/_api/json/v1/tenant-a/content/${HOME_CONTENT_ID}`,
    '/_api/json/v1/tenant-a/content/c1,c2',
    '/_api/json/v1/tenant-a/content/?method=findQuery&entityname=content&type=Page',
    CONTENTNAV,
    '/_api/feed/v1/tenant-a/?feedID=feed-1',
    CUSERS,
    CSETTINGS,
    TIMESHEET_SHEETS,
  ];
  const CONTENTNAV_FINDING = 'target p95 9 ms is 2.25x legacy p95 4 ms (above 1.5x)';

  interface StackOptions {
    adminUser?: string;
    /** Gateway latency per path, else TARGET_MS. */
    slowTarget?: Readonly<Record<string, number>>;
    /** Gateway status per path, else 200. */
    targetStatus?: Readonly<Record<string, number>>;
    neverHealthy?: readonly RestartService[];
    /** /healthz 503 answers after each start before the first 200 (default 2). */
    healthFailures?: number;
    refuse?: 'legacy' | 'gateway';
  }

  interface FakeStack {
    entries: Record<string, UpProcessEntry>;
    requests: string[];
    clock: FakeClock;
    fetch: FetchLike;
    kill: KillLike;
    spawn: SpawnLike;
    spawned: Map<string, number>;
    deps(env: EnvLike): MainDeps;
  }

  function ownerOf(url: URL): RestartService | undefined {
    if (url.pathname === '/admin/') {
      const action = url.searchParams.get('muraAction')?.toLowerCase();
      if (action === 'cusers.listusers') return 'people';
      if (action === 'csettings.list') return 'programs-sites';
      return 'identity';
    }
    if (url.pathname.startsWith('/_api/')) return 'strategies-content';
    const fixtureModule = /^\/legacy-fixtures\/cfml\/api\.cfm\/([^/]+)\//.exec(url.pathname)?.[1];
    return fixtureModule === undefined ? undefined : FIXTURE_OWNERS[fixtureModule];
  }

  /**
   * Legacy origin, gateway and the ten local service processes. The gateway answers 502 for a stopped service's
   * routes; each legacy request takes LEGACY_MS on the fake clock and each gateway request TARGET_MS.
   */
  function fakeStack(opts: StackOptions = {}): FakeStack {
    const clock = fakeClock();
    const requests: string[] = [];
    const running = new Map<string, number>();
    const spawned = new Map<string, number>();
    const healthPolls = new Map<string, number>();
    const byPort = new Map<string, RestartService>();
    const entries: Record<string, UpProcessEntry> = {};
    const accounts = new Map<string, string>([
      [opts.adminUser ?? 'admin', credential('admin')],
      ...SEED_ROLES.map((role): [string, string] => [seedUsername(role), credential(role)]),
    ]);
    let nextPid = PID_BASE + 100;
    let loginPages = 0;
    RESTART_SERVICES.forEach((service, index) => {
      // Every other entry leaves its port to ports.env.
      const port = index % 2 === 0 ? 28_100 + index : undefined;
      const pid = nextPid++;
      entries[service] = {
        pid,
        ...(port === undefined ? {} : { port }),
        cwd: path.join(tmp, service),
        command: ['node', 'dist/server.js'],
        env: { OPT2_SERVICE: service },
      };
      byPort.set(String(port ?? portFor(service)), service);
      running.set(service, pid);
    });

    const kill: KillLike = (pid, signal) => {
      const service = [...running].find(([, live]) => live === Math.abs(pid))?.[0];
      if (service === undefined) throw ESRCH;
      if (signal !== 0) running.delete(service);
      return true;
    };

    const spawn: SpawnLike = (_command, _args, options) => {
      const service = options.env?.OPT2_SERVICE;
      if (service === undefined) throw new Error('spawned without OPT2_SERVICE');
      const pid = nextPid++;
      running.set(service, pid);
      spawned.set(service, pid);
      healthPolls.set(service, 0);
      return fakeChild(pid).child;
    };

    function health(url: URL): Response {
      const service = byPort.get(url.port);
      if (url.hostname !== '127.0.0.1' || service === undefined) throw new Error(`unscripted health check ${url.href}`);
      if (!running.has(service) || opts.neverHealthy?.includes(service) === true) throw errno('ECONNREFUSED');
      const polls = (healthPolls.get(service) ?? 0) + 1;
      healthPolls.set(service, polls);
      return polls > (opts.healthFailures ?? 2) ? new Response('ok') : new Response('starting', { status: 503 });
    }

    function answer(side: 'legacy' | 'gateway', method: string, target: string, body: string): Response {
      if (method === 'GET' && target === LOGIN_PAGE) {
        loginPages += 1;
        return html(LOGIN_FORM, [`CFID=${side}-${loginPages}; Path=/; HttpOnly`]);
      }
      if (method === 'POST' && target === LOGIN_POST) {
        const form = new URLSearchParams(body);
        const accepted =
          opts.refuse !== side &&
          form.get('csrf_token') === CSRF_TOKEN &&
          accounts.get(form.get('username') ?? '') === form.get('password');
        return redirect(accepted ? './' : './?muraAction=clogin.main');
      }
      if (method === 'GET' && target === '/admin/') return html('<h1>Masa CMS - Site Content</h1>');
      if (side === 'legacy' && target === CONTENT_LIST) return json({ data: { items: [{ contentid: 'c1' }, { contentid: 'c2' }] } });
      if (side === 'legacy' && target === FEED_LIST) return json({ data: { items: [{ feedID: 'feed-1' }] } });
      return json({ data: {} }, side === 'gateway' ? (opts.targetStatus?.[target] ?? 200) : 200);
    }

    const fetch: FetchLike = async (input, init) => {
      const url = new URL(input);
      const method = init.method ?? 'GET';
      const target = `${url.pathname}${url.search}`;
      requests.push(`${method} ${url.origin}${target}`);
      if (url.pathname === '/healthz') return health(url);
      const side = url.origin === LEGACY ? 'legacy' : url.origin === GATEWAY ? 'gateway' : undefined;
      if (side === undefined) throw new Error(`unscripted request ${method} ${input}`);
      clock.t += side === 'legacy' ? LEGACY_MS : (opts.slowTarget?.[target] ?? TARGET_MS);
      const owner = side === 'gateway' ? ownerOf(url) : undefined;
      if (owner !== undefined && !running.has(owner)) return new Response('Bad Gateway', { status: 502 });
      return answer(side, method, target, typeof init.body === 'string' ? init.body : '');
    };

    return {
      entries,
      requests,
      clock,
      fetch,
      kill,
      spawn,
      spawned,
      deps: (env) => ({ env, fetch, kill, spawn, now: clock.now, sleep: clock.sleep }),
    };
  }

  function reportsPath(...segments: string[]): string {
    return path.join(tmp, 'reports', ...segments);
  }

  async function writeFixtureFile(file: string, body: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
  }

  /** Writes up.json, fixtures.json, seed credentials and the optional plan and window reports; returns the env. */
  async function stageMain(
    stack: FakeStack,
    stage: { fixtures: boolean; plan?: unknown; windows?: unknown; adminUser?: string },
  ): Promise<EnvLike> {
    const state = path.join(tmp, 'state');
    const env: EnvLike = {
      OPT2_STATE_DIR: state,
      OPT2_REPORTS_DIR: reportsPath(),
      LEGACY_ORIGIN: LEGACY,
      OPT2_GATEWAY_URL: GATEWAY,
      MURA_ADMIN_PASSWORD: credential('admin'),
      ...(stage.adminUser === undefined ? {} : { MURA_ADMIN_USERNAME: stage.adminUser }),
    };
    writeUpState({ processes: stack.entries }, { env });
    await writeFixtureFile(path.join(state, 'fixtures.json'), {
      available: stage.fixtures,
      reason: stage.fixtures ? null : 'fixture load failed',
      checkedAt: '2026-06-30T09:00:00.000Z',
    });
    await writeFixtureFile(path.join(state, 'secrets', 'seed-credentials.json'), {
      roles: { 'tenant-a': Object.fromEntries(SEED_ROLES.map((role) => [role, seedUsername(role)])) },
      users: { 'tenant-a': Object.fromEntries(SEED_ROLES.map((role) => [seedUsername(role), credential(role)])) },
    });
    if (stage.plan !== undefined) await writeFixtureFile(reportsPath('terraform-plan.json'), stage.plan);
    if (stage.windows !== undefined) await writeFixtureFile(reportsPath('windows.json'), stage.windows);
    return env;
  }

  async function readReport(): Promise<PerformanceReport & { generatedBy: string; sourceSha: string }> {
    return JSON.parse(await fs.readFile(reportsPath('performance.json'), 'utf8')) as PerformanceReport & {
      generatedBy: string;
      sourceSha: string;
    };
  }

  function healthUrlOf(stack: FakeStack, service: RestartService): string {
    return `http://127.0.0.1:${stack.entries[service]?.port ?? portFor(service)}/healthz`;
  }

  function cliIo(lines: string[], exits: number[]) {
    return {
      argv: [],
      command: 'performance',
      stdout: { write: (chunk: string) => lines.push(chunk) },
      exit: (code: number) => {
        exits.push(code);
      },
    };
  }

  it('measures every read set, restarts all ten services and writes performance.json and performance.md', async () => {
    const stack = fakeStack({ slowTarget: { [CONTENTNAV]: 9 }, targetStatus: { [CONTENTNAV]: 403 } });
    const env = await stageMain(stack, {
      fixtures: true,
      plan: { minInstanceCounts: { ...EXPECTED_MIN_INSTANCES } },
      windows: { windows: [{ windowId: 'w-1', routeKey: 'cusers.update', durationMs: 6000 }] },
    });

    const outcome = await main([], stack.deps(env));

    expect(outcome).toStrictEqual({
      code: 0,
      summary: { report: reportsPath('performance.json'), latencySets: 8, findings: 3, unhealthy: false },
    });
    const report = await readReport();
    expect(report.generatedBy).toBe(GENERATED_BY);
    expect(report.sourceSha).toBe(readPin().sha);
    expect(report.latency).toStrictEqual(
      READ_SET.map(({ set }) => {
        const slow = set === 'gs-co-05.contentnav';
        return {
          set,
          requests: REQUESTS_PER_SET,
          target: slow ? { p50Ms: 9, p95Ms: 9 } : { p50Ms: 5, p95Ms: 5 },
          legacy: { p50Ms: 4, p95Ms: 4 },
          ratioP95: slow ? 2.25 : 1.25,
          finding: slow ? CONTENTNAV_FINDING : null,
        };
      }),
    );
    expect(report.coldStart).toStrictEqual(RESTART_SERVICES.map((service) => ({ service, startToFirst200Ms: 100, label: 'measured' })));
    // The identity probe is a full login (three gateway requests); every other probe is one GET.
    expect(report.scaleToZero).toStrictEqual(
      RESTART_SERVICES.map((service) => ({ service, stopToFirstSuccessMs: service === 'identity' ? 115 : 105, label: 'derived' })),
    );
    expect(report.minInstanceCount).toStrictEqual({ source: 'minInstanceCounts', values: { ...EXPECTED_MIN_INSTANCES }, label: 'measured' });
    expect(report.windowsOverThreshold).toStrictEqual([{ windowId: 'w-1', routeKey: 'cusers.update', durationMs: 6000 }]);
    expect(report.findings).toStrictEqual([
      { kind: 'latency-ratio', subject: 'gs-co-05.contentnav', detail: CONTENTNAV_FINDING },
      { kind: 'non-ok-response', subject: 'gs-co-05.contentnav/target', detail: '200 of 200: 403' },
      { kind: 'window-over-threshold', subject: 'w-1', detail: 'cusers.update 6000 ms' },
    ]);
    expect(report.cloudMeasurement).toBe(CLOUD_MEASUREMENT);

    for (const target of MEASURED_PATHS) expect(count(stack.requests, `GET ${LEGACY}${target}`)).toBe(REQUESTS_PER_SET);
    expect(count(stack.requests, `POST ${LEGACY}${LOGIN_POST}`)).toBe(2);
    expect(count(stack.requests, `POST ${GATEWAY}${LOGIN_POST}`)).toBe(1 + SEED_ROLES.length + 1);
    expect(readUpState({ env }).processes).toStrictEqual(
      Object.fromEntries(RESTART_SERVICES.map((service) => [service, { ...stack.entries[service], pid: stack.spawned.get(service) }])),
    );

    const markdown = await fs.readFile(reportsPath('performance.md'), 'utf8');
    expect(markdown.startsWith(`# Performance report\nSource SHA: ${readPin().sha}\n\n## Method\n`)).toBe(true);
    expect(markdown).toContain(`| gs-co-05.contentnav | 200 | 9 | 9 | 4 | 4 | 2.25 | ${CONTENTNAV_FINDING} |`);
  });

  it('skips the fixture-backed set and probes without fixtures and flags absent plan and window reports', async () => {
    const stack = fakeStack({ adminUser: 'fixture-admin' });
    const env = await stageMain(stack, { fixtures: false, adminUser: 'fixture-admin' });

    const outcome = await main([], stack.deps(env));

    const report = await readReport();
    expect(outcome).toStrictEqual({
      code: 0,
      summary: { report: reportsPath('performance.json'), latencySets: 7, findings: report.findings.length, unhealthy: false },
    });
    expect(report.latency.at(-1)).toStrictEqual(skippedLatency('timesheets.sheets', FIXTURES_UNAVAILABLE).row);
    expect(report.coldStart.every((row) => row.startToFirst200Ms === 100)).toBe(true);
    expect(report.scaleToZero).toStrictEqual(
      RESTART_SERVICES.map((service) => ({
        service,
        stopToFirstSuccessMs: SYNTHETIC.includes(service) ? null : service === 'identity' ? 115 : 105,
        label: 'derived',
      })),
    );
    expect(report.minInstanceCount).toStrictEqual({ source: 'unavailable', values: {}, label: 'measured' });
    expect(report.findings.filter((finding) => finding.kind === 'min-instance-count-missing').map((finding) => finding.subject)).toStrictEqual(
      Object.keys(EXPECTED_MIN_INSTANCES).sort(),
    );
    expect(report.findings.filter((finding) => finding.kind !== 'min-instance-count-missing')).toStrictEqual([
      ...[...SYNTHETIC].sort().map((subject) => ({ kind: 'scale-probe-skipped', subject, detail: FIXTURES_UNAVAILABLE })),
      { kind: 'set-skipped', subject: 'timesheets.sheets', detail: FIXTURES_UNAVAILABLE },
      { kind: 'terraform-plan-missing', subject: 'terraform-plan.json', detail: 'not in the reports directory' },
      { kind: 'windows-report-missing', subject: 'windows.json', detail: 'not in the reports directory' },
    ]);
    expect(count(stack.requests, `GET ${LEGACY}${TIMESHEET_SHEETS}`)).toBe(0);
    expect(count(stack.requests, `POST ${LEGACY}${LOGIN_POST}`)).toBe(1);
    expect(count(stack.requests, `POST ${GATEWAY}${LOGIN_POST}`)).toBe(2);
  });

  it('exits 1 through runCli when a restarted service never answers /healthz, measuring the others', async () => {
    const stack = fakeStack({ neverHealthy: ['finance'] });
    const env = await stageMain(stack, {
      fixtures: true,
      plan: { minInstanceCounts: { ...EXPECTED_MIN_INSTANCES } },
      windows: { windows: [] },
    });
    const lines: string[] = [];
    const exits: number[] = [];

    await expect(runCli((argv) => main(argv, stack.deps(env)), cliIo(lines, exits))).resolves.toBe(1);

    expect(exits).toStrictEqual([1]);
    expect(JSON.parse(lines.join(''))).toStrictEqual({
      command: 'performance',
      ok: false,
      code: 1,
      report: reportsPath('performance.json'),
      latencySets: 8,
      findings: 1,
      unhealthy: true,
    });
    const report = await readReport();
    expect(report.findings).toStrictEqual([
      {
        kind: 'cold-start-timeout',
        subject: 'finance',
        detail: `${healthUrlOf(stack, 'finance')} did not answer 200 within ${POLL_LIMIT_MS} ms`,
      },
    ]);
    expect(report.coldStart.map((row) => [row.service, row.startToFirst200Ms])).toStrictEqual(
      RESTART_SERVICES.map((service) => [service, service === 'finance' ? null : 100]),
    );
    expect(report.scaleToZero.find((row) => row.service === 'finance')?.stopToFirstSuccessMs).toBeNull();
  });

  it.each(['legacy', 'gateway'] as const)('fails before measuring when the %s admin login is refused', async (side) => {
    const stack = fakeStack({ refuse: side });
    const env = await stageMain(stack, { fixtures: false });
    await expect(main([], stack.deps(env))).rejects.toThrow(`${side} admin: admin login as admin was refused (status 200 at /admin/)`);
    expect(stack.spawned.size).toBe(0);
    expect(existsSync(reportsPath('performance.json'))).toBe(false);
  });

  it.each([
    ['is not JSON', '{"minInstanceCounts":', 'terraform-plan.json: is not valid JSON'],
    ['does not match its schema', JSON.stringify({ minInstanceCounts: { gateway: 'zero' } }), 'terraform-plan.json: does not match its schema'],
  ])('fails without writing a report when terraform-plan.json %s', async (_label, text, message) => {
    const stack = fakeStack();
    const env = await stageMain(stack, { fixtures: false, plan: text });
    await expect(main([], stack.deps(env))).rejects.toThrow(message);
    expect(existsSync(reportsPath('performance.json'))).toBe(false);
  });

  it.each([
    {
      label: 'an unknown flag with exit 2 and the usage text',
      argv: ['--requests', '10'],
      code: 2,
      line: { error: { type: 'UsageError', message: expect.stringContaining("Unknown option '--requests'") }, usage: USAGE },
    },
    {
      label: 'a missing up.json with exit 1',
      argv: [],
      code: 1,
      line: { error: { type: 'UpStateMissingError', message: expect.stringContaining('run harness/repro/up.sh first') } },
    },
  ])('rejects $label before any request', async ({ argv, code, line }) => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetch = vi.fn<FetchLike>();
    const env: EnvLike = { OPT2_STATE_DIR: path.join(tmp, 'state'), OPT2_REPORTS_DIR: reportsPath() };
    const lines: string[] = [];
    const exits: number[] = [];

    await expect(runCli((args) => main(args, { env, fetch }), { ...cliIo(lines, exits), argv })).resolves.toBe(code);

    expect(exits).toStrictEqual([code]);
    expect(JSON.parse(lines.join(''))).toMatchObject({ command: 'performance', ok: false, code, ...line });
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(reportsPath())).toBe(false);
  });

  it('falls back to the global fetch, process.kill, the system clock and timers, and up.json in OPT2_STATE_DIR', async () => {
    const stack = fakeStack({ healthFailures: 1 });
    const env = await stageMain(stack, {
      fixtures: false,
      plan: { minInstanceCounts: { ...EXPECTED_MIN_INSTANCES } },
      windows: { windows: [] },
    });
    vi.stubGlobal('fetch', stack.fetch);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      stack.kill(pid, (signal ?? 'SIGTERM') as NodeJS.Signals | 0);
      return true;
    });

    const outcome = await main([], { env, spawn: stack.spawn });

    expect(outcome.code).toBe(0);
    expect(count(stack.requests, `GET ${LEGACY}${CSETTINGS}`)).toBe(REQUESTS_PER_SET);
    for (const service of RESTART_SERVICES) expect(kill).toHaveBeenCalledWith(-(stack.entries[service]?.pid ?? 0), 'SIGTERM');
    expect(stack.clock.sleep).not.toHaveBeenCalled();
    const report = await readReport();
    for (const row of report.coldStart) expect(row.startToFirst200Ms).toBeGreaterThan(0);
    expect(report.scaleToZero.filter((row) => row.stopToFirstSuccessMs !== null).map((row) => row.service)).toStrictEqual([
      'identity',
      'people',
      'programs-sites',
      'strategies-content',
    ]);
    const { processes } = readUpState({ env });
    expect(RESTART_SERVICES.map((service) => processes[service]?.pid)).toStrictEqual(
      RESTART_SERVICES.map((service) => stack.spawned.get(service)),
    );
  });
});

describe('script entry', () => {
  it('runs main through runCli when node starts this module, exiting 2 with the usage text on an unknown flag', async () => {
    process.argv = [process.execPath, path.join(REPO_ROOT, 'harness', 'src', 'performance', 'run.ts'), '--requests'];
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      rest.find((arg): arg is () => void => typeof arg === 'function')?.();
      return true;
    }) as typeof process.stdout.write);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);

    vi.resetModules();
    await import('../../src/performance/run.js');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    const line = written.find((chunk) => chunk.startsWith('{"command"'));
    expect(JSON.parse(line ?? 'null')).toMatchObject({
      command: 'harness/src/performance/run.ts',
      ok: false,
      code: 2,
      error: { type: 'UsageError', message: expect.stringContaining("Unknown option '--requests'") },
      usage: USAGE,
    });
  });
});
