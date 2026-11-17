// Unit tests for runFault over every scripted fault (always resumed, always reported) and the registry's in-process hooks.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from '@opt2/platform/service-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

import { loadConfig } from '../../src/config.js';
import {
  FAULT_NAMES,
  FAULT_SCRIPTS,
  FaultInjectedError,
  FaultParamsError,
  FaultUsageError,
  REGISTRY_FAULT_NAMES,
  UnknownFaultError,
  assertFaultNamesMatchConfig,
  createFaultRegistry,
  runFault,
  type FaultAssertion,
  type FaultEnv,
  type FaultName,
  type FaultRegistry,
  type FaultReportBlock,
  type FaultRunOutput,
  type FaultScript,
  type ProcessControl,
  type RunFaultDeps,
  type RunFaultResult,
} from '../../src/faults/index.js';
import { fail, pass } from '../../src/faults/scripts/types.js';
import {
  RECONCILIATION_DIR,
  buildReport,
  fileUnitIds,
  resolvePoint,
  type ReconcileReport,
  type ReconcileResult,
  type ReconcileUnitsOptions,
} from '../../src/reconcile/index.js';
import { buildTestContext, type TestContext } from '../helpers/context.js';
import { TEST_SOURCE_SHA } from '../helpers/env.js';
import { fixtureId } from '../helpers/fixtures.js';

type Context = Parameters<typeof runFault>[0];
type Reconcile = NonNullable<RunFaultDeps['reconcile']>;
type Snapshot = NonNullable<Awaited<ReturnType<NonNullable<RunFaultDeps['latestSnapshot']>>>>;
type WindowArg = Parameters<NonNullable<ReturnType<FaultRegistry['windowHooks']>['beforeImport']>>[0];
type WrittenReport = ReconcileReport & { sourceSha: string; fault: FaultReportBlock };

const CONFIG = loadConfig();

const EXPECTED_NAMES = [
  'applier-killed-mid-batch',
  'duplicate-batch',
  'mssql-dropped-mid-extract',
  'service-restarted-mid-apply',
  'pubsub-redelivery',
  'window-import-interrupted',
  'projector-delay',
  'forced-reinit',
];

const TOGGLE_FAULT = 'projector-delay' satisfies FaultName;
const RECONCILING_FAULTS: FaultName[] = FAULT_NAMES.filter((name) => FAULT_SCRIPTS[name].reconciles);
const PARAMS_FAULT = 'duplicate-batch' satisfies FaultName;

/** Delay the committed config gives `projector-delay` when armed without `delayMs`. */
const DEFAULT_DELAY_MS = 3000;
/** Exit status of the projector crash, as for a process killed by SIGKILL. */
const CRASH_EXIT_CODE = 137;

const SNAPSHOT: Snapshot = {
  seq: 3,
  kind: 'feed',
  state: 'ready',
  databaseName: 'masa_test_opt2_snap_3',
  backupPath: 'snapshots/snap-3.bak',
  checkpointLsn: null,
  lastLsn: null,
  takenAt: new Date('2026-06-30T08:00:00.000Z'),
  transitionId: null,
  sourceSha: TEST_SOURCE_SHA,
  manifestComplete: true,
  fileStore: { status: 'ok', objects: 0 },
};

const refuse = (): never => {
  throw new Error('This suite starts, stops and restarts no process');
};
const PROCESS_CONTROL: ProcessControl = { entry: refuse, envOf: refuse, restart: refuse, waitHealthy: refuse };

/** The injected ports of one runFault call and the order its script and reconciliation ran in. */
interface Doubles {
  deps: RunFaultDeps;
  events: string[];
  reconcile: Mock<Reconcile>;
  remote: { set: Mock<FaultEnv['remote']['set']>; clear: Mock<FaultEnv['remote']['clear']> };
  sleep: Mock<(ms: number) => Promise<void>>;
}

/** A zero-difference report for `options`, built as reconciliation builds one, with no unit entries. */
function zeroDifference(ctx: Context, options: ReconcileUnitsOptions): ReconcileReport {
  return buildReport({
    point: resolvePoint(ctx.config, options.point),
    startedAt: ctx.clock.now().toISOString(),
    legacySource: options.legacySource,
    tableVersion: 'v0001',
    snapshotSeq: options.snapshotSeq ?? null,
    legacyDatabase: options.database,
    units: [],
    fileStore: { store: null, status: 'not-applicable', haltedUnits: [] },
  });
}

/** Ports with a zero-difference reconcile stub, a recording remote and a refusing process control; `scripts` absent keeps the real ones. */
function doubles(scripts?: RunFaultDeps['scripts'], events: string[] = []): Doubles {
  const reconcile = vi.fn<Reconcile>((ctx, options) => {
    events.push('reconcile');
    return Promise.resolve(zeroDifference(ctx, options));
  });
  const remote = { set: vi.fn<FaultEnv['remote']['set']>(() => Promise.resolve()), clear: vi.fn<FaultEnv['remote']['clear']>(() => Promise.resolve()) };
  const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
  const deps: RunFaultDeps = {
    ...(scripts === undefined ? {} : { scripts }),
    processControl: PROCESS_CONTROL,
    remote,
    reconcile,
    latestSnapshot: () => Promise.resolve(SNAPSHOT),
    sleep,
  };
  return { deps, events, reconcile, remote, sleep };
}

/** A reconciling script double whose `run` settles with `output` (rejects when it is an Error), recording into `events`. */
function doubleScript(name: string, output: FaultRunOutput | Error, events: string[], paramsSchema: z.ZodType = z.object({}).strict()) {
  const run = vi.fn<FaultScript['run']>(() => {
    events.push('run');
    return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
  });
  const resume = vi.fn<FaultScript['resume']>(() => {
    events.push('resume');
    return Promise.resolve({ steps: ['resumed'], assertions: [] });
  });
  const script: FaultScript = { name, reconciles: true, paramsSchema, run, resume };
  return { script, run, resume };
}

/** The error `promise` rejects with. */
async function rejectionOf(promise: Promise<unknown> | undefined): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

/** The error `run` throws. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a throw');
}

function reconciliationDir(t: TestContext): string {
  return path.join(t.dirs.reportsDir, RECONCILIATION_DIR);
}

async function readReport(file: string): Promise<WrittenReport> {
  return JSON.parse(await readFile(file, 'utf8')) as WrittenReport;
}

const opened: TestContext[] = [];

/** A context over in-process doubles, gateway at v0001, reports in its own temp directory. */
async function context(): Promise<TestContext> {
  const t = await buildTestContext({ bridge: false, gateway: { active: 'v0001' } });
  opened.push(t);
  return t;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((t) => t.close()));
});

describe('fault names', () => {
  it('lists the eight scripted faults in the order of the config and of the script table', () => {
    expect(FAULT_NAMES).toStrictEqual(EXPECTED_NAMES);
    expect(FAULT_NAMES).toStrictEqual(CONFIG.faults.map((fault) => fault.name));
    expect(Object.keys(FAULT_SCRIPTS)).toStrictEqual(EXPECTED_NAMES);
  });

  it('names each script after its key and reconciles every fault but the projector-delay toggle', () => {
    for (const name of FAULT_NAMES) expect(FAULT_SCRIPTS[name].name).toBe(name);
    expect(RECONCILING_FAULTS).toStrictEqual(EXPECTED_NAMES.filter((name) => name !== TOGGLE_FAULT));
    expect(REGISTRY_FAULT_NAMES).toEqual(expect.arrayContaining([TOGGLE_FAULT, 'window-import-interrupted']));
  });

  it('accepts the committed config and rejects a reordered or shortened fault list', () => {
    expect(() => assertFaultNamesMatchConfig(CONFIG)).not.toThrow();
    expect(() => assertFaultNamesMatchConfig({ faults: [...CONFIG.faults].reverse() })).toThrow(/but the fault scripts are/);
    expect(() => assertFaultNamesMatchConfig({ faults: CONFIG.faults.slice(1) })).toThrow(/but the fault scripts are/);
  });
});

interface RunCase {
  label: string;
  output: FaultRunOutput | Error;
  outcome: RunFaultResult['outcome'];
  exitCode: 0 | 1;
  result: ReconcileResult;
  assertions: FaultAssertion[];
  error?: { phase: 'run'; message: string };
}

const INJECTED = pass('injected', { batch: 1 });
const NOT_RECOVERED = fail('recovered', { pending: 1 }, 'the batch was not applied again');

const RUN_CASES: RunCase[] = [
  {
    label: 'passing assertions',
    output: { assertions: [INJECTED], state: { batch: 1 } },
    outcome: 'passed',
    exitCode: 0,
    result: 'zero-difference',
    assertions: [INJECTED],
  },
  {
    label: 'a failing assertion',
    output: { assertions: [INJECTED, NOT_RECOVERED] },
    outcome: 'failed',
    exitCode: 1,
    result: 'zero-difference',
    assertions: [INJECTED, NOT_RECOVERED],
  },
  {
    label: 'a run that throws',
    output: new Error('injection refused'),
    outcome: 'failed',
    exitCode: 1,
    result: 'zero-difference',
    assertions: [],
    error: { phase: 'run', message: 'Error: injection refused' },
  },
];

describe.each(RECONCILING_FAULTS)('runFault %s', (name) => {
  const point = `after-fault-${name}`;

  it.each(RUN_CASES)('after $label resumes, reconciles once and writes a $result report', async (entry) => {
    const t = await context();
    const events: string[] = [];
    const { script, run, resume } = doubleScript(name, entry.output, events);
    const d = doubles({ [name]: script }, events);

    const result = await runFault(t.ctx, name, {}, d.deps);

    const reportPath = path.join(reconciliationDir(t), `${point}.json`);
    expect(result).toStrictEqual({
      name,
      outcome: entry.outcome,
      assertions: entry.assertions,
      ...(entry.error === undefined ? {} : { error: entry.error }),
      reconciliation: { point, result: entry.result, reportPath },
      exitCode: entry.exitCode,
    });
    expect(events).toStrictEqual(['run', 'resume', 'reconcile']);

    const env = run.mock.calls[0]?.[0];
    expect(env?.ctx).toBe(t.ctx);
    expect(env?.processControl).toBe(PROCESS_CONTROL);
    expect(env?.remote).toBe(d.remote);
    expect(env?.sleep).toBe(d.sleep);
    expect(resume).toHaveBeenCalledExactlyOnceWith(env, {}, entry.output instanceof Error ? undefined : entry.output);

    const { legacySource } = resolvePoint(t.ctx.config, point);
    expect(d.reconcile).toHaveBeenCalledExactlyOnceWith(t.ctx, {
      point,
      units: [...t.ctx.catalog.units().map((unit) => unit.id), ...fileUnitIds(t.ctx.config)],
      database: legacySource === 'live' ? t.ctx.env.MURA_DATABASE : SNAPSHOT.databaseName,
      snapshotSeq: SNAPSHOT.seq,
      legacySource,
    });

    const report = await readReport(reportPath);
    expect(report).toMatchObject({
      sourceSha: TEST_SOURCE_SHA,
      point,
      expectedTableVersion: 'v0001',
      tableVersion: 'v0001',
      tableVersionMatches: true,
      result: entry.result,
      summary: { differences: 0, unitsWithDifferences: 0 },
      fault: { name, params: {}, outcome: entry.outcome, tableVersion: 'v0001', assertions: entry.assertions, steps: ['resumed'] },
    });
    expect(report.fault.error).toStrictEqual(entry.error);
    expect(report.fault.resumeError).toBeUndefined();
    expect(await readFile(path.join(reconciliationDir(t), 'summary.md'), 'utf8')).toContain('Zero difference at every point: yes');
  });
});

describe('runFault failed reconciliation', () => {
  const name = 'forced-reinit' satisfies FaultName;
  const point = `after-fault-${name}`;

  it.each([
    { label: 'the version active when the fault started', active: 'v0002', expected: 'v0002', matches: true, cell: '| v0002 |' },
    { label: "the point's default when no version was active", active: null, expected: 'v0001', matches: false, cell: '| none |' },
  ])('writes a difference report expecting $label', async ({ active, expected, matches, cell }) => {
    const t = await buildTestContext({ bridge: false, gateway: { active } });
    opened.push(t);
    const events: string[] = [];
    const { script } = doubleScript(name, { assertions: [INJECTED] }, events);
    const d = doubles({ [name]: script }, events);
    d.reconcile.mockRejectedValueOnce(new Error('snapshot database unreachable'));

    const result = await runFault(t.ctx, name, {}, d.deps);

    const reportPath = path.join(reconciliationDir(t), `${point}.json`);
    const failure = { phase: 'reconcile', message: 'Error: snapshot database unreachable' };
    expect(result).toStrictEqual({
      name,
      outcome: 'passed',
      assertions: [INJECTED],
      error: failure,
      reconciliation: { point, result: 'difference', reportPath },
      exitCode: 1,
    });
    const report = await readReport(reportPath);
    expect(report).toMatchObject({
      point,
      expectedTableVersion: expected,
      tableVersion: active,
      tableVersionMatches: matches,
      units: [],
      result: 'difference',
      error: failure,
      fault: { name, outcome: 'passed', tableVersion: active },
    });
    const row = (await readFile(path.join(reconciliationDir(t), 'summary.md'), 'utf8')).split('\n').find((line) => line.startsWith(`| ${point} |`));
    expect(row).toContain(cell);
    expect(row).not.toContain('expected');
  });
});

describe('runFault parameters', () => {
  const schema = z.object({ rows: z.number().int().min(1).default(10), units: z.array(z.string()).min(1).optional() }).strict();

  it("hands the script its schema's parsed params and reconciles the units they name", async () => {
    const t = await context();
    const events: string[] = [];
    const { script, run } = doubleScript(PARAMS_FAULT, { assertions: [INJECTED] }, events, schema);
    const d = doubles({ [PARAMS_FAULT]: script }, events);
    const parsed = { rows: 10, units: ['people.person'] };

    const result = await runFault(t.ctx, PARAMS_FAULT, { units: ['people.person'] }, d.deps);

    expect(result).toMatchObject({ outcome: 'passed', exitCode: 0 });
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.anything(), parsed);
    expect(d.reconcile).toHaveBeenCalledExactlyOnceWith(t.ctx, expect.objectContaining({ units: parsed.units }));
    const report = await readReport(path.join(reconciliationDir(t), `after-fault-${PARAMS_FAULT}.json`));
    expect(report.fault.params).toStrictEqual(parsed);
  });

  it('rejects params its schema refuses with FaultUsageError before the script runs', async () => {
    const t = await context();
    const events: string[] = [];
    const { script } = doubleScript(PARAMS_FAULT, { assertions: [INJECTED] }, events, schema);
    const d = doubles({ [PARAMS_FAULT]: script }, events);

    const error = await rejectionOf(runFault(t.ctx, PARAMS_FAULT, { rows: 0 }, d.deps));

    expect(error).toBeInstanceOf(FaultUsageError);
    expect(error).toMatchObject({ fault: PARAMS_FAULT, exitCode: 2, reason: expect.stringMatching(/^invalid parameters: rows: /) });
    expect(events).toStrictEqual([]);
    expect(existsSync(reconciliationDir(t))).toBe(false);
  });

  it.each(FAULT_NAMES)('rejects an unknown parameter of the real %s script before it runs', async (name) => {
    const t = await context();
    const d = doubles();

    const error = await rejectionOf(runFault(t.ctx, name, { notAParameter: true }, d.deps));

    expect(error).toBeInstanceOf(FaultUsageError);
    expect(error).toMatchObject({ fault: name, exitCode: 2 });
    expect(d.remote.set).not.toHaveBeenCalled();
    expect(d.remote.clear).not.toHaveBeenCalled();
    expect(d.reconcile).not.toHaveBeenCalled();
    expect(existsSync(reconciliationDir(t))).toBe(false);
  });
});

describe('runFault projector-delay', () => {
  it.each([
    { params: {}, call: 'set', args: [TOGGLE_FAULT, {}] },
    { params: { delayMs: 500 }, call: 'set', args: [TOGGLE_FAULT, { delayMs: 500 }] },
    { params: { action: 'clear' }, call: 'clear', args: [TOGGLE_FAULT] },
  ] as const)('toggles the service delay for $params without reconciling or writing a report', async ({ params, call, args }) => {
    const t = await context();
    const d = doubles();

    const result = await runFault(t.ctx, TOGGLE_FAULT, params, d.deps);

    expect(result).toMatchObject({ name: TOGGLE_FAULT, outcome: 'toggled', exitCode: 0 });
    expect(result.assertions.map((assertion) => assertion.status)).toStrictEqual(['pass']);
    expect(result.reconciliation).toBeUndefined();
    expect(d.remote[call].mock.calls).toStrictEqual([args]);
    expect(d.remote[call === 'set' ? 'clear' : 'set']).not.toHaveBeenCalled();
    expect(d.reconcile).not.toHaveBeenCalled();
    expect(existsSync(reconciliationDir(t))).toBe(false);
  });
});

describe('runFault usage', () => {
  it.each([
    { label: 'an unknown fault', name: 'nope', scripts: undefined },
    { label: 'a fault the script table lacks', name: PARAMS_FAULT, scripts: {} },
  ])('rejects $label with FaultUsageError', async ({ name, scripts }) => {
    const t = await context();
    const d = doubles(scripts);

    const error = await rejectionOf(runFault(t.ctx, name, {}, d.deps));

    expect(error).toBeInstanceOf(FaultUsageError);
    expect(error).toMatchObject({ fault: name, exitCode: 2, reason: expect.stringContaining('unknown fault') });
    expect(d.reconcile).not.toHaveBeenCalled();
  });

  it('refuses to run when the context config lists the faults in another order', async () => {
    const t = await context();
    const d = doubles();
    const reordered = { ...t.ctx, config: { ...t.ctx.config, faults: [...t.ctx.config.faults].reverse() } } as Context;

    await expect(runFault(reordered, PARAMS_FAULT, {}, d.deps)).rejects.toThrow(/but the fault scripts are/);
    expect(d.reconcile).not.toHaveBeenCalled();
  });
});

describe('createFaultRegistry hooks', () => {
  const WINDOW_W1 = fixtureId('window:W1');
  const WINDOW_W2 = fixtureId('window:W2');
  const COMMIT = { owner: 'people', tenantId: '6b1d0c2a-3e4f-5a6b-8c7d-9e0f1a2b3c4d', batchId: 'batch-1' };
  const windowArg = (windowId: string) => ({ windowId }) as WindowArg;

  let t: TestContext;
  beforeAll(async () => {
    t = await buildTestContext({ bridge: false });
  });
  afterAll(() => t.close());

  /** A registry with recording sleep and exit, and `process.exit` stubbed to throw so a real exit fails the test. */
  function armedRegistry() {
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const exit = vi.fn<(code: number) => void>();
    const processExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)}) called`);
    });
    return { registry: createFaultRegistry(t.ctx, { sleep, exit }), sleep, exit, processExit };
  }

  it('takes the default delay from the committed config', () => {
    expect(CONFIG.faults.find((fault) => fault.name === TOGGLE_FAULT)?.defaultDelayMs).toBe(DEFAULT_DELAY_MS);
  });

  it.each([
    { params: {}, ms: DEFAULT_DELAY_MS },
    { params: { delayMs: 500 }, ms: 500 },
  ])('sleeps $ms ms before the first batch of each cycle while projector-delay is armed with $params, and not once cleared', async ({ params, ms }) => {
    const { registry, sleep } = armedRegistry();
    const hooks = registry.projectorHooks();
    expect(registry.active()).toStrictEqual([]);
    await hooks.beforeFirstBatch?.();
    expect(sleep).not.toHaveBeenCalled();

    expect(registry.set(TOGGLE_FAULT, params)).toMatchObject({ name: TOGGLE_FAULT, params: { delayMs: ms } });
    await hooks.beforeFirstBatch?.();
    await hooks.beforeFirstBatch?.();
    expect(sleep.mock.calls).toStrictEqual([[ms], [ms]]);

    expect(registry.clear(TOGGLE_FAULT)).toBe(true);
    await hooks.beforeFirstBatch?.();
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(registry.active()).toStrictEqual([]);
  });

  it('exits through the injected exit after the legacy commit while projector-crash is armed', async () => {
    const { registry, exit, processExit } = armedRegistry();
    const hooks = registry.projectorHooks();
    await hooks.afterLegacyCommit?.(COMMIT);
    expect(exit).not.toHaveBeenCalled();

    registry.set('projector-crash', { point: 'after-legacy-commit' });
    await hooks.afterLegacyCommit?.(COMMIT);

    expect(exit).toHaveBeenCalledExactlyOnceWith(CRASH_EXIT_CODE);
    expect(processExit).not.toHaveBeenCalled();
  });

  it('fails the import of the armed window only while window-import-interrupted names it', async () => {
    const { registry } = armedRegistry();
    const hooks = registry.windowHooks();
    await expect(hooks.beforeImport?.(windowArg(WINDOW_W1), 1)).resolves.toBeUndefined();

    registry.set('window-import-interrupted', { windowId: WINDOW_W1 });
    const error = await rejectionOf(hooks.beforeImport?.(windowArg(WINDOW_W1), 1));
    expect(error).toBeInstanceOf(FaultInjectedError);
    expect(error).toMatchObject({ fault: 'window-import-interrupted' });
    await expect(hooks.beforeImport?.(windowArg(WINDOW_W2), 1)).resolves.toBeUndefined();

    registry.clear('window-import-interrupted');
    await expect(hooks.beforeImport?.(windowArg(WINDOW_W1), 2)).resolves.toBeUndefined();
  });

  it('rejects an unknown fault name with UnknownFaultError on set and clear', () => {
    const { registry } = armedRegistry();
    for (const attempt of [() => registry.set('nope', {}), () => registry.clear('nope')]) {
      const error = thrownBy(attempt);
      expect(error).toBeInstanceOf(UnknownFaultError);
      expect(error).toMatchObject({ fault: 'nope', statusCode: 404 });
    }
  });

  // projector-crash requires its point, and a window id must be a 35-character CF id, so these arm nothing.
  it.each([
    { name: TOGGLE_FAULT, params: { delayMs: -1 } },
    { name: 'projector-crash', params: {} },
    { name: 'window-import-interrupted', params: { windowId: 'W1' } },
  ])('rejects $name params $params with FaultParamsError and arms nothing', ({ name, params }) => {
    const { registry } = armedRegistry();

    const error = thrownBy(() => registry.set(name, params));

    expect(error).toBeInstanceOf(FaultParamsError);
    expect(error).toMatchObject({ fault: name, statusCode: 400, issues: [expect.any(String)] });
    expect(registry.active()).toStrictEqual([]);
  });
});
