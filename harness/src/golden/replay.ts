// Replays captured scenarios through the gateway with the step script capture used, and writes the outputs compare.ts reads.
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CookieJar, type SerializedCookieJar } from 'tough-cookie';
import {
  ROUTE_FAMILIES,
  matchRouteKey,
  normaliseRouteKey,
  type RouteFamily,
  type RouteKeyResult,
} from '@opt2/platform/legacy-compat';
import type { Logger } from '@opt2/platform/logging';
import { z } from '@opt2/platform/service-kit';
import {
  EXCEPTIONS_LIST_PATH,
  appendExceptionEntry,
  candidateChoice,
  createGoldenStepBuilder,
  goldenSetPath,
  goldenSetSchema,
  readGoldenSet,
  type AppendExceptionOptions,
  type GoldenSet,
  type GoldenSideEffects,
  type GoldenStep,
} from './capture.js';
import {
  CATALOGUE_PATH,
  FIXTURES_UNAVAILABLE,
  SCENARIO_ID_PATTERN,
  isRehearsalScenario,
  loadCatalogue,
  readFixtureStatus,
  scenarioById,
  skipReason,
  type Catalogue,
  type FaultSpec,
  type FixtureStatus,
  type Scenario,
  type TableVersion,
} from './catalogue.js';
import {
  EquivalenceImpossible,
  GoldenConfigError,
  haltEvidence,
  haltedExceptionEntry,
  isEquivalenceImpossible,
} from './errors.js';
import { RULES_PATH, loadRules, type NormaliseRules } from './normalise/rules.js';
import {
  createScenarioContext,
  loadSecretStore,
  loadSeedStore,
  originBaseUrl,
  secretValues,
  type ScenarioContext,
  type SecretStore,
  type SeedStore,
} from './session.js';
import {
  collectSideEffects,
  resetMailpit,
  resolveSideEffectConfig,
  settleHook,
  type SettleHook,
  type SideEffectDeps,
  type SideEffects,
} from './side-effects.js';
import { redact, runScenarioSteps, type StepRecord, type StepRunOptions } from './steps.js';
import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { safeDiagnostic } from '../lib/diagnostics.js';
import { createHttpSession, type FetchLike, type HttpResult } from '../lib/http.js';
import { createHarnessInvoker, type HarnessInvoker } from '../lib/invocation.js';
import { createHarnessLogger } from '../lib/logger.js';
import { repoPath, stateDir, type EnvLike } from '../lib/paths.js';
import { readPin } from '../lib/pin.js';
import { readJson, stableStringify, writeJsonReport } from '../lib/report.js';

/** `generatedBy` stamped on every replay output. */
export const GENERATED_BY = 'harness/src/golden/replay.ts';

/** Migration service base URL when `OPT2_MIGRATION_URL` is unset. */
export const DEFAULT_MIGRATION_URL = 'http://127.0.0.1:8102';

/** Gateway `cutoverStatus` route. */
export const CUTOVER_STATUS_PATH = '/internal/v1/cutover/status';

/** Migration `gatesList` route. */
export const GATES_PATH = '/internal/v1/gates';

/** Phases of a scenario replayed across a cut-over transition (`acrossTransition`). */
export const REPLAY_PHASES = ['pre-transition', 'resume'] as const;
export type ReplayPhase = (typeof REPLAY_PHASES)[number];

/** A run's phase: `full` replays every step, resuming a scenario paused at a transition. */
export type RunPhase = ReplayPhase | 'full';

const FAULTS_PATH = '/internal/v1/faults/';
const UNAVAILABLE = 503;
const IMPORT_PENDING = 'import-pending';
const HALT_ID_PREFIX = 'EX-HALT-';

/** One halted case: the step, its route key, why equivalence is impossible and its exceptions-list entry. */
export interface ReplayHalt {
  step: string;
  routeKey: string;
  reason: string;
  exceptionId: string;
}

/** Why a scenario's replay did not finish; `step` names the step that failed. */
export interface ReplayError {
  message: string;
  step?: string;
}

/** One scenario replayed through the gateway, `<stateDir>/golden/replay/<id>.json`. */
export interface ReplayOutput {
  sourceSha: string;
  scenarioId: string;
  replayedAt: string;
  origin: 'gateway';
  /** Cut-over version the gateway had active. */
  tableVersion: string;
  skipped?: typeof FIXTURES_UNAVAILABLE;
  /** Shaped and normalised exactly as the golden set's steps. */
  steps: GoldenStep[];
  sideEffects: GoldenSideEffects;
  halted: ReplayHalt[];
  error?: ReplayError;
  generatedBy?: string;
  generatedAt?: string;
}

const versionId = z.string().regex(/^v\d{4}$/, 'must be a cut-over version vNNNN');

const replayFieldsSchema = z.strictObject({
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character lowercase hex commit id'),
  scenarioId: z.string().regex(SCENARIO_ID_PATTERN, 'must match GS-<AREA>-NN or GS-<AREA>-RH-NN'),
  replayedAt: z.iso.datetime(),
  origin: z.literal('gateway'),
  tableVersion: versionId,
  skipped: z.literal(FIXTURES_UNAVAILABLE).optional(),
  steps: z.array(z.unknown()),
  sideEffects: z.unknown(),
  halted: z.array(
    z.strictObject({
      step: z.string().min(1),
      routeKey: z.string().min(1),
      reason: z.string().min(1),
      exceptionId: z.string().min(1),
    }),
  ),
  error: z.strictObject({ message: z.string().min(1), step: z.string().min(1).optional() }).optional(),
  generatedBy: z.string().min(1).optional(),
  generatedAt: z.string().min(1).optional(),
});

/** Schema of a replay output; its steps and side effects are checked by the golden-set schema, so both sides share one shape. */
export const replayOutputSchema: z.ZodType<ReplayOutput> = replayFieldsSchema.transform((output, ctx) => {
  if (output.skipped !== undefined && output.steps.length > 0) {
    ctx.addIssue({ code: 'custom', message: 'a skipped replay holds no steps', path: ['steps'] });
    return z.NEVER;
  }
  const parsed = goldenSetSchema.safeParse({
    sourceSha: output.sourceSha,
    scenarioId: output.scenarioId,
    capturedAt: output.replayedAt,
    origin: 'legacy',
    tableVersion: null,
    fixtures: { available: true, reason: null },
    steps: output.steps,
    sideEffects: output.sideEffects,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    return z.NEVER;
  }
  return { ...output, steps: parsed.data.steps, sideEffects: parsed.data.sideEffects };
});

/** Path of scenario `id`'s replay output, `<stateDir>/golden/replay/<id>.json`, outside the checkout. */
export function replayOutputPath(id: string, env: EnvLike = process.env): string {
  return path.join(stateDir(env), 'golden', 'replay', `${id}.json`);
}

/** Path of scenario `id`'s sessions saved at a transition, `<stateDir>/golden/sessions/<id>.json` (mode 0600). */
export function sessionStatePath(id: string, env: EnvLike = process.env): string {
  return path.join(stateDir(env), 'golden', 'sessions', `${id}.json`);
}

/** Cookie jars, bindings and exchanges of a scenario paused before a cut-over transition. */
export interface SessionState {
  sourceSha: string;
  scenarioId: string;
  savedAt: string;
  /** Version active while the steps before the boundary ran. */
  tableVersion: string;
  /** Index of the first step not yet replayed. */
  nextIndex: number;
  /** Set once the remaining steps have replayed and the output is written. */
  completed: boolean;
  jars: Record<string, SerializedCookieJar>;
  bindings: [string, unknown][];
  records: StepRecord[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const sessionStateSchema: z.ZodType<SessionState> = z.strictObject({
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  scenarioId: z.string().regex(SCENARIO_ID_PATTERN),
  savedAt: z.iso.datetime(),
  tableVersion: versionId,
  nextIndex: z.number().int().nonnegative(),
  completed: z.boolean(),
  jars: z.record(z.string(), z.custom<SerializedCookieJar>(isPlainObject, 'must be a serialized cookie jar')),
  bindings: z.array(z.tuple([z.string(), z.unknown()])),
  records: z.array(z.custom<StepRecord>(isPlainObject, 'must be a step record')),
});

/** Saved sessions of scenario `id`, or `undefined` when none are saved; throws when the file is unreadable or off-schema. */
export async function readSessionState(id: string, env: EnvLike = process.env): Promise<SessionState | undefined> {
  const file = sessionStatePath(id, env);
  try {
    await access(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return readJson(file, sessionStateSchema);
}

/** Writes `value` as stable JSON readable by its owner only, through a temp file and a rename. */
async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, stableStringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Operator access to the gateway's and the migration service's internal routes. */
export interface OperatorDeps {
  env?: EnvLike;
  fetch?: FetchLike;
  /** Operator invocation credentials; else the local `operator` invoker. */
  invoker?: HarnessInvoker;
}

interface InternalTarget {
  callee: 'gateway' | 'migration';
  baseUrl: string;
}

/** Migration service base URL: `OPT2_MIGRATION_URL`, else {@link DEFAULT_MIGRATION_URL}. */
export function migrationUrl(env: EnvLike = process.env): string {
  const configured = env.OPT2_MIGRATION_URL;
  return (configured === undefined || configured === '' ? DEFAULT_MIGRATION_URL : configured).replace(/\/+$/, '');
}

function targetOf(callee: InternalTarget['callee'], env: EnvLike): InternalTarget {
  return { callee, baseUrl: callee === 'gateway' ? originBaseUrl('gateway', env) : migrationUrl(env) };
}

/** One internal request as the operator workload, its invocation credential in the headers. */
async function operatorCall(
  deps: OperatorDeps,
  callee: InternalTarget['callee'],
  req: { method: string; path: string; query?: Record<string, string>; json?: unknown },
): Promise<HttpResult> {
  const env = deps.env ?? process.env;
  const target = targetOf(callee, env);
  const invoker = deps.invoker ?? (await createHarnessInvoker({ caller: 'operator', env }));
  const headers = await invoker.headersFor({ callee, url: `${target.baseUrl}${req.path}` });
  const s = createHttpSession({ baseUrl: target.baseUrl, fetch: deps.fetch });
  return s.request({ method: req.method, path: req.path, query: req.query, headers, json: req.json, followRedirects: false });
}

const cutoverStatusSchema = z.looseObject({ tableVersion: versionId.nullable() });

/** The cut-over version the gateway has active (`CutoverStatus.tableVersion`); `null` before any activation. */
export async function activeTableVersion(deps: OperatorDeps = {}): Promise<string | null> {
  const result = await operatorCall(deps, 'gateway', { method: 'GET', path: CUTOVER_STATUS_PATH });
  if (result.status !== 200) throw new Error(`gateway cutoverStatus answered ${result.status}`);
  const parsed = cutoverStatusSchema.safeParse(result.json());
  if (!parsed.success) throw new Error(`gateway cutoverStatus is not a CutoverStatus: ${z.prettifyError(parsed.error)}`);
  return parsed.data.tableVersion;
}

function faultPath(name: string): string {
  return `${FAULTS_PATH}${encodeURIComponent(name)}`;
}

/** Arms `spec` at the migration service (`faultSet`); the catalogue's `ms` is the fault's `delayMs`. */
async function setFault(deps: OperatorDeps, spec: FaultSpec): Promise<void> {
  const params = spec.ms === undefined ? {} : { delayMs: spec.ms };
  const result = await operatorCall(deps, 'migration', { method: 'PUT', path: faultPath(spec.fault), json: { params } });
  if (result.status !== 204) throw new Error(`migration faultSet ${spec.fault} answered ${result.status}`);
}

/** Disarms fault `name` (`faultClear`). */
async function clearFault(deps: OperatorDeps, name: string): Promise<void> {
  const result = await operatorCall(deps, 'migration', { method: 'DELETE', path: faultPath(name) });
  if (result.status !== 204) throw new Error(`migration faultClear ${name} answered ${result.status}`);
}

/**
 * Runs `fn` with `faults` armed. Every fault whose arming was attempted is disarmed afterwards, whether `fn` returned
 * or threw; `fn`'s error wins over a disarming error.
 */
export async function withFaults<T>(deps: OperatorDeps, faults: readonly FaultSpec[], fn: () => Promise<T>): Promise<T> {
  const armed: string[] = [];
  const outcome = await (async () => {
    for (const spec of faults) {
      armed.push(spec.fault);
      await setFault(deps, spec);
    }
    return fn();
  })().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let clearError: unknown;
  for (const name of armed.reverse()) {
    await clearFault(deps, name).catch((err: unknown) => {
      clearError ??= err;
    });
  }
  if (!outcome.ok) throw outcome.error;
  if (clearError !== undefined) throw clearError;
  return outcome.value;
}

const cutoverVersionSchema = z.looseObject({
  tableVersion: versionId,
  entries: z.array(z.looseObject({ route: z.string().min(1), units: z.array(z.string()) })),
});

/** Units of each entry of one cut-over version, by normalised route. */
type RouteUnits = ReadonlyMap<string, readonly string[]>;

/** Cut-over versions read so far, by file; a version file is immutable once committed. */
const routeUnitsByFile = new Map<string, Promise<RouteUnits>>();

/** `<OPT2_CUTOVER_DIR, else gateway/cutover>/versions/<version>.json`, resolved as the gateway resolves it. */
function cutoverVersionPath(version: string, env: EnvLike): string {
  const dir = env.OPT2_CUTOVER_DIR;
  return path.join(dir ? path.resolve(dir) : repoPath('gateway', 'cutover'), 'versions', `${version}.json`);
}

/** Entry units of cut-over version file `file`; throws when it is off-schema or names another version. */
async function readRouteUnits(file: string, version: string): Promise<RouteUnits> {
  const table = await readJson(file, cutoverVersionSchema);
  if (table.tableVersion !== version) {
    throw new GoldenConfigError(`${file}: tableVersion ${table.tableVersion} is not the active ${version}`, { path: file });
  }
  return new Map(table.entries.map((entry) => [normaliseRouteKey(entry.route), entry.units]));
}

const FAMILIES: ReadonlySet<string> = new Set(ROUTE_FAMILIES);
const VARIANT_SUFFIX = /\{([^{}]*)\}$/;

/** A recorded route key as the computed result `matchRouteKey` reads; `undefined` for an unknown family. */
function keyResultOf(routeKey: string): RouteKeyResult | undefined {
  const key = normaliseRouteKey(routeKey);
  const at = key.indexOf(':');
  const family = key.slice(0, at);
  if (at < 1 || !FAMILIES.has(family)) return undefined;
  const variant = VARIANT_SUFFIX.exec(key)?.[1];
  const baseKey = variant === undefined ? key : key.slice(0, key.length - variant.length - 2);
  const result: RouteKeyResult = { key, baseKey, family: family as RouteFamily, httpMethod: '', params: {} };
  if (variant !== undefined) result.variant = variant;
  return result;
}

/** Units of the `version` entry `routeKey` resolves to, matched as the gateway matches; none when no entry matches. */
export async function routeUnits(routeKey: string, version: string, env: EnvLike = process.env): Promise<readonly string[]> {
  const file = cutoverVersionPath(version, env);
  let loaded = routeUnitsByFile.get(file);
  if (loaded === undefined) {
    loaded = readRouteUnits(file, version);
    routeUnitsByFile.set(file, loaded);
  }
  const units = await loaded;
  const result = keyResultOf(routeKey);
  const route = result === undefined ? undefined : matchRouteKey(result, units.keys());
  return route === undefined ? [] : (units.get(route) ?? []);
}

const gatesSchema = z.looseObject({
  units: z.array(
    z.looseObject({
      unit: z.string(),
      lease: z.looseObject({ holderId: z.string() }).optional(),
      gate: z.looseObject({ holderId: z.string().nullable(), phase: z.string().nullable() }).optional(),
    }),
  ),
});

/**
 * The fail-closed cause `gatesList` reports for `units`: each write window holding any of them `import-pending`, with
 * those units; `undefined` when none is, and without a request when `units` is empty. The migration contract carries
 * no roster-operation state, so a 503 from a halted roster operation is not reported here and stays a difference.
 */
export async function importPendingCause(deps: OperatorDeps, units: readonly string[]): Promise<string | undefined> {
  const wanted = new Set(units);
  if (wanted.size === 0) return undefined;
  const query = { units: [...wanted].sort().join(',') };
  const result = await operatorCall(deps, 'migration', { method: 'GET', path: GATES_PATH, query });
  if (result.status !== 200) throw new Error(`migration gatesList answered ${result.status}`);
  const parsed = gatesSchema.safeParse(result.json());
  if (!parsed.success) throw new Error(`migration gatesList is not a GatesResponse: ${z.prettifyError(parsed.error)}`);
  const byHolder = new Map<string, string[]>();
  for (const { unit, lease, gate } of parsed.data.units) {
    if (!wanted.has(unit) || gate?.phase !== IMPORT_PENDING) continue;
    const holder = gate.holderId ?? lease?.holderId ?? 'unknown';
    byHolder.set(holder, [...(byHolder.get(holder) ?? []), unit]);
  }
  if (byHolder.size === 0) return undefined;
  return [...byHolder]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([holder, held]) => `write window ${holder} is ${IMPORT_PENDING} on ${held.sort().join(', ')}`)
    .join('; ');
}

/** A halted case found while replaying: the raised error, its step and record, and a declared exceptions id. */
interface Halt {
  err: EquivalenceImpossible;
  step: string;
  /** Index of the halted exchange among the scenario's records, when one exists. */
  record?: number;
  /** Exceptions-list id a step declares with `expected: halted`. */
  declaredId?: string;
}

/** Exceptions-list fields replay reads; everything else is left to `appendExceptionEntry`. */
const exceptionEntriesSchema = z.looseObject({
  entries: z.array(z.looseObject({ id: z.string(), scenario: z.string(), routeKey: z.string(), status: z.string() })),
});

function stepKey(name: string, matrixKey: string | undefined): string {
  return JSON.stringify([name, matrixKey ?? null]);
}

function goldenSteps(golden: GoldenSet): Map<string, GoldenStep> {
  return new Map(golden.steps.map((step) => [stepKey(step.name, step.matrixKey), step]));
}

/**
 * Halts declared before any request: a golden step without a deterministic legacy trigger (`gap`), and a step that
 * declares `expected: halted` under an exceptions entry, which the gateway serves from legacy.
 */
function declaredHalts(scenarioId: string, records: readonly StepRecord[], golden: Map<string, GoldenStep>): Halt[] {
  const evidence = haltEvidence(scenarioId);
  const halts: Halt[] = [];
  records.forEach((record, index) => {
    const captured = golden.get(stepKey(record.name, record.matrixKey));
    if (captured?.gap !== undefined) {
      const err = new EquivalenceImpossible({
        scenario: scenarioId,
        routeKey: captured.routeKey,
        reason: captured.gap.reason,
        evidence,
      });
      halts.push({ err, step: record.name, record: index });
    } else if (record.expected === 'halted' && record.exceptionId !== undefined) {
      const err = new EquivalenceImpossible({
        scenario: scenarioId,
        routeKey: record.routeKey,
        reason: `declared halted under ${record.exceptionId}; served by legacy`,
        evidence,
      });
      halts.push({ err, step: record.name, record: index, declaredId: record.exceptionId });
    }
  });
  return halts;
}

/** A step exchange the gateway answered with 503 where legacy did not. */
interface Unavailable {
  step: string;
  routeKey: string;
  legacyStatus: number;
  /** Index of its record among the scenario's records, when the step produced one. */
  record?: number;
}

/** The first of `produced` answered 503 where its golden step was not; `offset` is the index of `produced[0]`. */
function unavailableRecord(
  produced: readonly StepRecord[],
  offset: number,
  golden: Map<string, GoldenStep>,
): Unavailable | undefined {
  for (const [index, record] of produced.entries()) {
    const legacyStatus = golden.get(stepKey(record.name, record.matrixKey))?.normalised.status;
    if (record.response.status === UNAVAILABLE && legacyStatus !== undefined && legacyStatus !== UNAVAILABLE) {
      return { step: record.name, routeKey: record.routeKey, legacyStatus, record: offset + index };
    }
  }
  return undefined;
}

/**
 * Raises `EquivalenceImpossible` for `answer` when an import-pending write window holds a unit of its route's cut-over
 * entry; `undefined` otherwise.
 */
async function unavailableHalt(
  scenarioId: string,
  answer: Unavailable,
  deps: OperatorDeps & Pick<ReplayDeps, 'tableVersion'>,
): Promise<Halt | undefined> {
  const units = await routeUnits(answer.routeKey, deps.tableVersion, deps.env ?? process.env);
  const cause = await importPendingCause(deps, units);
  if (cause === undefined) return undefined;
  const err = new EquivalenceImpossible({
    scenario: scenarioId,
    routeKey: answer.routeKey,
    reason: cause,
    evidence: haltEvidence(scenarioId),
    difference: `the gateway answered the legacy-shaped 503 where legacy answered ${answer.legacyStatus}`,
  });
  return answer.record === undefined ? { err, step: answer.step } : { err, step: answer.step, record: answer.record };
}

/** Fetch remembering the status of the last response it returned, so a step that threw still shows its answer. */
interface ObservedFetch {
  fetch: FetchLike;
  lastStatus: number | undefined;
}

function observingFetch(base: FetchLike | undefined): ObservedFetch {
  const observed: ObservedFetch = {
    lastStatus: undefined,
    fetch: async (input, init) => {
      const response = await (base ?? globalThis.fetch)(input, init);
      observed.lastStatus = response.status;
      return response;
    },
  };
  return observed;
}

/** Next free `EX-HALT-<scenario>-NN` id. */
function nextHaltId(entries: readonly { id: string }[], scenarioId: string): string {
  const prefix = `${HALT_ID_PREFIX}${scenarioId}-`;
  const used = entries
    .filter((entry) => entry.id.startsWith(prefix))
    .map((entry) => Number(entry.id.slice(prefix.length)))
    .filter((n) => Number.isInteger(n));
  return `${prefix}${String(Math.max(0, ...used) + 1).padStart(2, '0')}`;
}

/**
 * Exceptions-list id of `halt`, appending a halted `preserve` entry only when none exists: by the declared id for a
 * declared halt, else by `(scenario, routeKey)` with status `halted`. A `fix` entry is never changed.
 */
async function recordHalt(halt: Halt, sourceSha: string, opts: AppendExceptionOptions): Promise<string> {
  const { entries } = await readJson(opts.path ?? EXCEPTIONS_LIST_PATH, exceptionEntriesSchema);
  const { err, declaredId } = halt;
  if (declaredId !== undefined) {
    if (entries.some((entry) => entry.id === declaredId)) return declaredId;
    return (await appendExceptionEntry(haltedExceptionEntry(err, { id: declaredId, sourceSha }), opts)).id;
  }
  const same = entries.find(
    (entry) => entry.scenario === err.scenario && entry.routeKey === err.routeKey && entry.status === 'halted',
  );
  if (same !== undefined) return same.id;
  const id = nextHaltId(entries, err.scenario);
  return (await appendExceptionEntry(haltedExceptionEntry(err, { id, sourceSha }), opts)).id;
}

/** Collaborators of {@link replayScenario}; absent ones come from the environment. */
export interface ReplayDeps extends OperatorDeps {
  rules: NormaliseRules;
  fixtures: Pick<FixtureStatus, 'available' | 'reason'>;
  sourceSha: string;
  /** Version the gateway reported active for this run. */
  tableVersion: string;
  /** Shared across a run so redaction covers every secret resolved so far. */
  secrets?: SecretStore;
  seed?: SeedStore;
  sideEffects?: Omit<SideEffectDeps, 'fetch'>;
  clock?: () => Date;
  /** Progress and failure log; default {@link createHarnessLogger} on stderr. */
  logger?: Logger;
  exceptions?: AppendExceptionOptions;
  routeKeyOptions?: StepRunOptions['routeKeyOptions'];
  /** Default {@link readGoldenSet}. */
  readGolden?: (id: string) => Promise<GoldenSet>;
}

/** What replaying one scenario produced: an output, a pause at a transition, or nothing to write. */
export type ReplayResult =
  | { status: 'replayed' | 'skipped' | 'error'; output: ReplayOutput; path: string }
  | { status: 'paused'; path: string }
  | { status: 'browser' | 'resumed-earlier' };

type OutputBody = Pick<ReplayOutput, 'skipped' | 'steps' | 'sideEffects' | 'halted' | 'error'>;
type OutputWriter = (status: 'replayed' | 'skipped' | 'error', body: OutputBody) => Promise<ReplayResult>;

interface StepRange {
  start: number;
  /** Exclusive: the next transition boundary, else the step count. */
  end: number;
  /** Sessions restored from before the transition. */
  state?: SessionState;
}

interface StepRun {
  records: StepRecord[];
  /** A halt that ends the scenario's replay. */
  stop?: Halt;
  error?: ReplayError;
}

function emptySideEffects(): GoldenSideEffects {
  return { mail: [], rows: {}, tasks: [], files: [] };
}

function describeError(err: unknown, secrets: readonly string[]): string {
  return redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err), secrets);
}

/** Sorted indexes of the steps an `acrossTransition` boundary precedes. */
function transitionBoundaries(scenario: Scenario): number[] {
  const at = (scenario.acrossTransition ?? []).map((t) => scenario.steps.findIndex((step) => step.name === t.before));
  return [...new Set(at)].sort((a, b) => a - b);
}

/**
 * Steps this invocation replays. `pre-transition` runs up to the first boundary, discarding older saved sessions;
 * otherwise a scenario with boundaries resumes its saved sessions up to the next boundary or the end, which needs a
 * transition since they were saved.
 */
async function stepRange(
  scenario: Scenario,
  phase: RunPhase,
  tableVersion: string,
  env: EnvLike,
): Promise<StepRange | 'resumed-earlier'> {
  const boundaries = transitionBoundaries(scenario);
  const first = boundaries[0];
  const file = sessionStatePath(scenario.id, env);
  if (phase === 'pre-transition') {
    if (first === undefined) throw new GoldenConfigError(`${scenario.id} declares no acrossTransition`);
    await rm(file, { force: true });
    return { start: 0, end: first };
  }
  if (first === undefined) return { start: 0, end: scenario.steps.length };
  const state = await readSessionState(scenario.id, env);
  if (state === undefined) {
    throw new GoldenConfigError(
      `${scenario.id}: no sessions saved before its transition at ${file}; run --phase pre-transition before the transition`,
    );
  }
  if (state.completed) return 'resumed-earlier';
  if (state.tableVersion === tableVersion) {
    throw new GoldenConfigError(
      `${scenario.id}: the gateway still serves ${tableVersion}, the version step ` +
        `${scenario.steps[state.nextIndex]?.name ?? state.nextIndex} was paused under; run the transition first`,
    );
  }
  const end = boundaries.find((at) => at > state.nextIndex) ?? scenario.steps.length;
  return { start: state.nextIndex, end, state };
}

/** Saves `ctx`'s cookie jars and step bindings with `records`, to resume at step `nextIndex` after a transition. */
async function saveSessions(
  ctx: ScenarioContext,
  records: readonly StepRecord[],
  nextIndex: number,
  deps: Pick<ReplayDeps, 'sourceSha' | 'tableVersion'>,
  savedAt: string,
): Promise<string> {
  const jars: Record<string, SerializedCookieJar> = {};
  for (const [name, s] of ctx.sessions) jars[name] = await s.jar.serialize();
  const state: SessionState = {
    sourceSha: deps.sourceSha,
    scenarioId: ctx.scenarioId,
    savedAt,
    tableVersion: deps.tableVersion,
    nextIndex,
    completed: false,
    jars,
    bindings: [...ctx.bindings].filter(([key]) => !key.startsWith('matrix.')),
    records: redact([...records], secretValues(ctx)),
  };
  const file = sessionStatePath(ctx.scenarioId, ctx.env);
  await writePrivateJson(file, state);
  return file;
}

/** Replaces `ctx`'s fresh sessions with the saved jars and restores the saved bindings. */
async function restoreSessions(ctx: ScenarioContext, state: SessionState, fetch: FetchLike | undefined): Promise<void> {
  for (const [name, serialized] of Object.entries(state.jars)) {
    if (!ctx.sessions.has(name)) {
      throw new GoldenConfigError(`${ctx.scenarioId}: saved session ${name} is not a session the scenario declares`);
    }
    const jar = await CookieJar.deserialize(serialized);
    ctx.sessions.set(name, createHttpSession({ baseUrl: ctx.baseUrl, fetch, jar }));
  }
  for (const [key, value] of state.bindings) ctx.bindings.set(key, value);
}

/**
 * Replays the steps of `range` one at a time, each sending the candidate its golden step kept. A step error ends the
 * run with the records so far; so does a halt, raised by the step runner or by {@link unavailableHalt} for a 503,
 * including one that made the step throw (its body holds no binding the step extracts).
 */
async function runSteps(
  ctx: ScenarioContext,
  scenario: Scenario,
  golden: GoldenSet,
  range: StepRange,
  deps: ReplayDeps & { observed: ObservedFetch },
  settle: SettleHook,
): Promise<StepRun> {
  const { observed } = deps;
  const choice = candidateChoice(golden);
  const captured = goldenSteps(golden);
  const offset = range.state?.records.length ?? 0;
  const records: StepRecord[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    const name = scenario.steps[index]?.name ?? String(index);
    observed.lastStatus = undefined;
    try {
      const produced = await runScenarioSteps(ctx, scenario, {
        mode: 'replay',
        candidateIndex: choice,
        settle,
        fetch: observed.fetch,
        routeKeyOptions: deps.routeKeyOptions,
        login: index === 0,
        onBeforeStep: (at) => (at < index ? 'skip' : at > index ? 'stop' : undefined),
      });
      records.push(...produced);
      const answer = unavailableRecord(produced, offset + records.length - produced.length, captured);
      const stop = answer === undefined ? undefined : await unavailableHalt(scenario.id, answer, deps);
      if (stop !== undefined) return { records, stop };
    } catch (err) {
      if (isEquivalenceImpossible(err)) return { records, stop: { err, step: name } };
      const error = { message: describeError(err, secretValues(ctx)), step: name };
      const legacy = golden.steps.find((step) => step.name === name);
      if (observed.lastStatus !== UNAVAILABLE || legacy === undefined || legacy.normalised.status === UNAVAILABLE) {
        return { records, error };
      }
      const answer = { step: name, routeKey: legacy.routeKey, legacyStatus: legacy.normalised.status };
      // An unreadable gate state or cut-over version leaves the step's own error as the outcome.
      const stop = await unavailableHalt(scenario.id, answer, deps).catch(() => undefined);
      return stop === undefined ? { records, error } : { records, stop };
    }
  }
  return { records };
}

/** Records every halt in the exceptions list, once per `(step, routeKey)`; returns them and the ids by record index. */
async function recordHalts(
  halts: readonly Halt[],
  deps: Pick<ReplayDeps, 'sourceSha' | 'exceptions'>,
): Promise<{ halted: ReplayHalt[]; ids: Map<number, string> }> {
  const opts: AppendExceptionOptions = {
    ...deps.exceptions,
    report: { generatedBy: GENERATED_BY, ...deps.exceptions?.report },
  };
  const halted: ReplayHalt[] = [];
  const ids = new Map<number, string>();
  const seen = new Set<string>();
  for (const halt of halts) {
    const exceptionId = await recordHalt(halt, deps.sourceSha, opts);
    if (halt.record !== undefined) ids.set(halt.record, exceptionId);
    const key = stepKey(halt.step, halt.err.routeKey);
    if (seen.has(key)) continue;
    seen.add(key);
    halted.push({ step: halt.step, routeKey: halt.err.routeKey, reason: halt.err.reason, exceptionId });
  }
  return { halted, ids };
}

/** The steps of `range`, the scenario's halts and side effects, then its output or its saved sessions. */
async function replayRun(
  scenario: Scenario,
  phase: RunPhase,
  deps: ReplayDeps,
  io: { env: EnvLike; logger: Logger; secrets: SecretStore; at: string; write: OutputWriter },
): Promise<ReplayResult> {
  const { env, logger } = io;
  const golden = await (deps.readGolden ?? readGoldenSet)(scenario.id);
  if (golden.skipped !== undefined) {
    throw new GoldenConfigError(
      `${scenario.id}: golden set ${goldenSetPath(scenario.id)} was captured ${golden.skipped}; capture it again`,
    );
  }
  const range = await stepRange(scenario, phase, deps.tableVersion, env);
  if (range === 'resumed-earlier') {
    logger.info(
      safeDiagnostic(`${scenario.id}: already resumed after its transition; ${replayOutputPath(scenario.id, env)} stands`, env),
    );
    return { status: 'resumed-earlier' };
  }
  const config = deps.sideEffects?.config ?? resolveSideEffectConfig(env);
  const sideDeps: SideEffectDeps = { ...deps.sideEffects, config, fetch: deps.fetch };
  if (range.start === 0) await resetMailpit(env, { fetch: deps.fetch, config });
  const observed = observingFetch(deps.fetch);
  const ctx = createScenarioContext(scenario, {
    origin: 'gateway',
    env,
    fetch: observed.fetch,
    secrets: io.secrets,
    seed: deps.seed,
  });
  if (range.state !== undefined) await restoreSessions(ctx, range.state, observed.fetch);
  const run = await withFaults(deps, scenario.replayFaults ?? [], () =>
    runSteps(ctx, scenario, golden, range, { ...deps, observed }, settleHook(ctx, scenario, sideDeps)),
  );
  const records = [...(range.state?.records ?? []), ...run.records];

  if (range.end < scenario.steps.length && run.stop === undefined && run.error === undefined) {
    const file = await saveSessions(ctx, records, range.end, deps, io.at);
    const next = scenario.steps[range.end]?.name ?? range.end;
    logger.info(safeDiagnostic(`${scenario.id}: paused before step ${next}; sessions saved to ${file}`, env));
    return { status: 'paused', path: file };
  }

  let { error } = run;
  let effects: SideEffects = { mail: [], rows: {}, tasks: [], files: [] };
  // A halted or failed run leaves its units fail-closed or its steps unfinished, so its side effects are not read.
  if (error === undefined && run.stop === undefined) {
    try {
      effects = await collectSideEffects(ctx, scenario, 'gateway', sideDeps);
    } catch (err) {
      error = { message: describeError(err, secretValues(ctx)) };
    }
  }
  const halts = [...declaredHalts(scenario.id, records, goldenSteps(golden)), ...(run.stop === undefined ? [] : [run.stop])];
  const { halted, ids } = await recordHalts(halts, deps);
  for (const halt of halted) {
    logger.warn(safeDiagnostic(`${scenario.id} step ${halt.step}: halted (${halt.reason}); ${halt.exceptionId}`, env));
  }

  const secrets = secretValues(ctx);
  const builder = createGoldenStepBuilder(scenario, deps.rules);
  const steps: GoldenStep[] = [];
  for (const [index, record] of redact(records, secrets).entries()) {
    const exceptionId = record.exceptionId ?? ids.get(index);
    steps.push(await builder.step(exceptionId === undefined ? record : { ...record, exceptionId }));
  }
  const sideEffects = await builder.sideEffects(redact(effects, secrets), steps);
  const body = redact<OutputBody>({ steps, sideEffects, halted, ...(error === undefined ? {} : { error }) }, secrets);
  const result = await io.write(error === undefined ? 'replayed' : 'error', body);
  if (range.state !== undefined) {
    await writePrivateJson(sessionStatePath(scenario.id, env), { ...range.state, completed: true });
  }
  const outcome = error === undefined ? 'replayed' : `failed${error.step === undefined ? '' : ` at ${error.step}`}`;
  const line = safeDiagnostic(`${scenario.id}: ${outcome}, ${steps.length} exchanges, ${halted.length} halted`, env);
  if (error === undefined) logger.info(line);
  else logger.error(line);
  return result;
}

/**
 * Replays `scenario` through the gateway in `phase`. A fixture-dependent scenario without fixtures yields a `skipped`
 * output and a browser scenario nothing (the Playwright interaction suite replays it). Otherwise its steps run in
 * replay mode with any replay-only faults armed, halted cases are recorded in the exceptions list, side effects are
 * collected on the gateway, and the redacted output is written; a failure yields an `error` output.
 */
export async function replayScenario(scenario: Scenario, deps: ReplayDeps, phase: RunPhase = 'full'): Promise<ReplayResult> {
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? createHarnessLogger('harness-golden-replay', env);
  const secrets = deps.secrets ?? loadSecretStore(env);
  const at = (deps.clock ?? (() => new Date()))().toISOString();
  const write: OutputWriter = async (status, body) => {
    const output: ReplayOutput = {
      sourceSha: deps.sourceSha,
      scenarioId: scenario.id,
      replayedAt: at,
      origin: 'gateway',
      tableVersion: deps.tableVersion,
      ...body,
    };
    const file = replayOutputPath(scenario.id, env);
    await writeJsonReport(file, { ...output }, { generatedBy: GENERATED_BY });
    return { status, output, path: file };
  };
  const skipped = skipReason(scenario, deps.fixtures);
  if (skipped !== null) {
    logger.info(safeDiagnostic(`${scenario.id}: ${skipped}`, env));
    return write('skipped', { skipped, steps: [], sideEffects: emptySideEffects(), halted: [] });
  }
  if (scenario.browser !== undefined) {
    const flow = scenario.browser.flow;
    logger.info(safeDiagnostic(`${scenario.id}: browser flow ${flow}, replayed by harness/e2e/ui/interactions.e2e.ts`, env));
    return { status: 'browser' };
  }
  try {
    return await replayRun(scenario, phase, deps, { env, logger, secrets, at, write });
  } catch (err) {
    const message = describeError(err, secretValues({ secrets }));
    logger.error(safeDiagnostic(`${scenario.id}: replay failed: ${message}`, env));
    return write('error', { steps: [], sideEffects: emptySideEffects(), halted: [], error: { message } });
  }
}

const USAGE =
  'tsx src/golden/replay.ts [--only <scenario-id>[,<scenario-id>…]] [--rehearsal] ' +
  '[--phase pre-transition|resume] [--catalogue <path>]';
const HELP = [
  `Usage: ${USAGE}`,
  '',
  'Replays the captured scenarios through the gateway in catalogue order and writes',
  '${OPT2_STATE_DIR}/golden/replay/<id>.json for golden:compare. The gateway must have v0002 active, or v0003 with',
  '--rehearsal, which replays only the rollback-rehearsal scenarios.',
  '',
  '--phase pre-transition  replays the steps of acrossTransition scenarios before their boundary under any version',
  '                        and saves their sessions to ${OPT2_STATE_DIR}/golden/sessions/<id>.json',
  '--phase resume          restores those sessions after the transition and replays the remaining steps',
  '',
  'Exit: 0 every scenario replayed, 1 the active version is wrong or a scenario failed, 2 usage error.',
].join('\n');

/** Collaborators of {@link main} beyond the environment. */
export type MainDeps = Pick<
  ReplayDeps,
  'fetch' | 'invoker' | 'secrets' | 'seed' | 'sideEffects' | 'clock' | 'logger' | 'exceptions' | 'routeKeyOptions' | 'readGolden'
>;

interface Selection {
  only: string | undefined;
  rehearsal: boolean;
  phase: ReplayPhase | undefined;
  required: TableVersion;
}

/**
 * Scenarios to replay in catalogue order: `--only` ones, else the rehearsal or the other scenarios. Without a phase
 * each must replay under the required version unless it crosses a transition; with one, each must cross a transition.
 */
function selectScenarios(catalogue: Catalogue, sel: Selection): Scenario[] {
  let selected: Scenario[];
  if (sel.only === undefined) {
    selected = catalogue.scenarios.filter((scenario) => isRehearsalScenario(scenario.id) === sel.rehearsal);
  } else {
    const ids = sel.only
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    if (ids.length === 0) throw new UsageError('--only needs at least one scenario id', USAGE);
    const wanted = new Set(ids.map((id) => scenarioById(catalogue, id).id));
    selected = catalogue.scenarios.filter((scenario) => wanted.has(scenario.id));
  }
  const crossing = selected.filter((scenario) => scenario.acrossTransition !== undefined);
  if (sel.phase !== undefined) {
    const other = selected.filter((scenario) => scenario.acrossTransition === undefined);
    if (sel.only !== undefined && other.length > 0) {
      const names = other.map((scenario) => scenario.id).join(', ');
      throw new UsageError(`--phase ${sel.phase} needs scenarios declaring acrossTransition; ${names} declare none`, USAGE);
    }
    if (crossing.length === 0) throw new UsageError(`no selected scenario declares acrossTransition`, USAGE);
    return crossing;
  }
  const mismatched = selected.filter(
    (scenario) => scenario.tableVersion !== sel.required && scenario.acrossTransition === undefined,
  );
  if (mismatched.length > 0) {
    const names = mismatched.map((scenario) => `${scenario.id} (${scenario.tableVersion})`).join(', ');
    throw new UsageError(`${names} do not replay under ${sel.required}; --rehearsal selects v0003`, USAGE);
  }
  return selected;
}

function parsePhase(value: string | undefined): ReplayPhase | undefined {
  if (value === undefined) return undefined;
  if ((REPLAY_PHASES as readonly string[]).includes(value)) return value as ReplayPhase;
  throw new UsageError(`--phase must be ${REPLAY_PHASES.join(' or ')}, got ${value}`, USAGE);
}

/**
 * Replays the selected scenarios in catalogue order once the gateway has the required version active (any version
 * for `--phase pre-transition`), continuing past a failed scenario. Exit 1 when the version is wrong (nothing is
 * replayed) or any scenario produced an `error` output; differences are compare.ts's to report.
 * Summary: `{replayed, skipped, paused, halted, errors, tableVersion}`.
 */
export async function main(argv: string[], env: EnvLike = process.env, deps: MainDeps = {}): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: {
      only: { type: 'string' },
      rehearsal: { type: 'boolean' },
      phase: { type: 'string' },
      catalogue: { type: 'string' },
    },
    usage: USAGE,
    help: HELP,
  });
  if (values.catalogue === '') throw new UsageError('--catalogue needs a path', USAGE);
  const phase = parsePhase(values.phase);
  const rehearsal = values.rehearsal === true;
  const required: TableVersion = rehearsal ? 'v0003' : 'v0002';
  const pin = readPin();
  const catalogue = await loadCatalogue(values.catalogue === undefined ? CATALOGUE_PATH : path.resolve(values.catalogue));
  const scenarios = selectScenarios(catalogue, { only: values.only, rehearsal, phase, required });

  const invoker = deps.invoker ?? (await createHarnessInvoker({ caller: 'operator', env }));
  const tableVersion = await activeTableVersion({ env, fetch: deps.fetch, invoker });
  const empty = { replayed: 0, skipped: 0, paused: 0, halted: [], errors: [], tableVersion };
  if (tableVersion === null) {
    return { code: 1, summary: { ...empty, error: 'the gateway has no cut-over version active' } };
  }
  if (phase !== 'pre-transition' && tableVersion !== required) {
    return { code: 1, summary: { ...empty, error: `the gateway has ${tableVersion} active; replay needs ${required}` } };
  }

  const replayDeps: ReplayDeps = {
    ...deps,
    env,
    invoker,
    rules: loadRules(RULES_PATH, env),
    fixtures: readFixtureStatus(env),
    sourceSha: pin.sha,
    tableVersion,
    secrets: deps.secrets ?? loadSecretStore(env),
    seed: deps.seed ?? loadSeedStore(env),
    sideEffects: { ...deps.sideEffects, config: deps.sideEffects?.config ?? resolveSideEffectConfig(env) },
    logger: deps.logger ?? createHarnessLogger('harness-golden-replay', env),
  };
  const counts = { replayed: 0, skipped: 0, paused: 0 };
  const halted: { id: string; step: string; exceptionId: string }[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const scenario of scenarios) {
    const result = await replayScenario(scenario, replayDeps, phase ?? 'full');
    if (result.status === 'paused') counts.paused += 1;
    else if (result.status === 'skipped') counts.skipped += 1;
    else if (result.status === 'replayed' || result.status === 'resumed-earlier') counts.replayed += 1;
    if (!('output' in result)) continue;
    for (const halt of result.output.halted) halted.push({ id: scenario.id, step: halt.step, exceptionId: halt.exceptionId });
    if (result.output.error !== undefined) errors.push({ id: scenario.id, error: result.output.error.message });
  }
  return { code: errors.length > 0 ? 1 : 0, summary: { ...counts, halted, errors, tableVersion } };
}

if (isMainModule(import.meta.url)) void runCli(main);
