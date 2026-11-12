// Captures golden outputs from legacy directly and writes one committed set per catalogue scenario.
import path from 'node:path';
import { z } from '@opt2/platform/service-kit';
import {
  CATALOGUE_PATH,
  FIXTURES_UNAVAILABLE,
  SCENARIO_ID_PATTERN,
  STEP_EXPECTATIONS,
  loadCatalogue,
  readFixtureStatus,
  scenarioById,
  skipReason,
  type Catalogue,
  type CompareKind,
  type FixtureStatus,
  type Scenario,
  type StepExpectation,
} from './catalogue.js';
import { GoldenConfigError, haltEvidence, type ExceptionEntry } from './errors.js';
import {
  KNOWN_ISSUE_IDS,
  createNormaliseState,
  normaliseSideEffects,
  normaliseStep,
  normaliseTokens,
  type DomModel,
  type ExportModel,
  type NormaliseRules,
  type NormaliseState,
  type NormalisedAuth,
  type NormalisedHeaders,
  type NormalisedMail,
  type NormalisedRun,
  type NormalisedSideEffects,
  type NormalisedStep,
  type NormalisedTable,
  type NormalisedTask,
  type StateTransitions,
} from './normalise/index.js';
import { RULES_PATH, loadRules } from './normalise/rules.js';
import {
  createScenarioContext,
  loadSecretStore,
  loadSeedStore,
  secretValues,
  type ScenarioContextOptions,
  type SecretStore,
  type SeedStore,
} from './session.js';
import {
  collectSideEffects,
  resetMailpit,
  resolveSideEffectConfig,
  settleHook,
  type SideEffectDeps,
  type SideEffects,
} from './side-effects.js';
import {
  GAP_REASON,
  redact,
  runScenarioSteps,
  type CandidateChoice,
  type RecordedBody,
  type RecordedRequest,
  type StepGap,
  type StepRecord,
  type StepRunOptions,
} from './steps.js';
import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { opt2Path, repoPath, stateDir, type EnvLike } from '../lib/paths.js';
import { readPin } from '../lib/pin.js';
import { readJson, stableStringify, writeJsonReport, type ReportOptions } from '../lib/report.js';

/** Fetch implementation the scenario sessions, Mailpit and side-effect reads use. */
export type FetchLike = NonNullable<ScenarioContextOptions['fetch']>;

/** Repository-relative folder of the committed golden sets. */
export const GOLDEN_SETS_DIR = 'harness/golden/sets';

/** `generatedBy` stamped on every set. */
export const GENERATED_BY = 'harness/src/golden/capture.ts';

/** The exceptions list gap entries are recorded in. */
export const EXCEPTIONS_LIST_PATH: string = opt2Path('exceptions-list.json');

/** One step response as captured, normalised for review: exactly one of `body`, `domModel` or `export`. */
export interface GoldenResponse {
  status: number;
  headers: NormalisedHeaders;
  /** JSON (a Masa envelope as served) or normalised text. */
  body?: unknown;
  domModel?: DomModel;
  export?: ExportModel;
  /** SHA-256 of the raw response bytes. */
  rawSha256: string;
}

/** One captured exchange: the redacted request, the reviewed response and the normalised step compare.ts reads. */
export interface GoldenStep {
  name: string;
  index: number;
  matrixKey?: string;
  routeKey: string;
  /** As sent; token values are `<token>` and secret values `<secret>`. */
  request: RecordedRequest;
  response: GoldenResponse;
  normalised: NormalisedStep;
  expected?: StepExpectation;
  decisionListRef?: string;
  exceptionId?: string;
  gap?: StepGap;
  /** Index into the step's `candidates` that was kept, so replay sends the same request shape. */
  candidateIndex?: number;
}

/** Normalised side effects; the four kinds are always present, empty when the scenario does not compare them. */
export type GoldenSideEffects = Required<Pick<NormalisedSideEffects, 'mail' | 'rows' | 'tasks' | 'files'>> &
  Pick<NormalisedSideEffects, 'transitions'>;

/** One committed golden set, `harness/golden/sets/<scenarioId>.json`. */
export interface GoldenSet {
  sourceSha: string;
  scenarioId: string;
  capturedAt: string;
  origin: 'legacy';
  /** Capture bypasses the gateway, so no cut-over version applies. */
  tableVersion: null;
  fixtures: Pick<FixtureStatus, 'available' | 'reason'>;
  skipped?: typeof FIXTURES_UNAVAILABLE;
  steps: GoldenStep[];
  sideEffects: GoldenSideEffects;
  generatedBy?: string;
  generatedAt?: string;
}

/** The un-normalised, redacted exchanges of one capture, kept under `${OPT2_STATE_DIR}` for review. */
export interface RawCapture {
  sourceSha: string;
  scenarioId: string;
  capturedAt: string;
  origin: 'legacy';
  records: StepRecord[];
  sideEffects: SideEffects;
}

/** A captured scenario: its set, its raw exchanges (absent when skipped) and the exception ids of its gaps. */
export interface CapturedScenario {
  set: GoldenSet;
  raw?: RawCapture;
  gaps: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 hex digest');
const fieldValues = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const headerValues = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const domModelSchema = z.custom<DomModel>(isPlainObject, 'must be a DOM model object');
const exportModelSchema = z.custom<ExportModel>(
  (value) => isPlainObject(value) && typeof value.kind === 'string',
  'must be an export model with a kind',
);

const recordedBodySchema: z.ZodType<RecordedBody> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('form'), value: fieldValues }),
  z.strictObject({ kind: z.literal('json'), value: z.unknown() }),
  z.strictObject({
    kind: z.literal('multipart'),
    value: z.strictObject({
      fields: fieldValues,
      files: z.array(
        z.strictObject({
          field: z.string(),
          filename: z.string(),
          contentType: z.string(),
          sha256,
          size: z.number().int().nonnegative(),
        }),
      ),
    }),
  }),
]);

const requestSchema: z.ZodType<RecordedRequest> = z.strictObject({
  method: z.string().min(1),
  url: z.string().startsWith('/', 'must be origin-relative'),
  headers: z.record(z.string(), z.string()),
  body: recordedBodySchema,
});

const RESPONSE_BODY_PARTS = ['body', 'domModel', 'export'] as const;

const responseSchema: z.ZodType<GoldenResponse> = z
  .strictObject({
    status: z.number().int().min(100).max(599),
    headers: headerValues,
    body: z.unknown().optional(),
    domModel: domModelSchema.optional(),
    export: exportModelSchema.optional(),
    rawSha256: sha256,
  })
  .refine((response) => RESPONSE_BODY_PARTS.filter((part) => response[part] !== undefined).length === 1, {
    message: 'must hold exactly one of body, domModel or export',
  });

// The normaliser owns these shapes; unknown keys are kept so a newer normaliser field never invalidates a set.
const normalisedStepSchema = z.looseObject({
  name: z.string().min(1),
  index: z.number().int().nonnegative(),
  matrixKey: z.string().optional(),
  routeKey: z.string().min(1),
  status: z.number().int(),
  headers: headerValues.optional(),
  auth: z.custom<NormalisedAuth>(isPlainObject, 'must be a normalised auth object').optional(),
  envelope: z.unknown().optional(),
  body: z.unknown().optional(),
  domModel: domModelSchema.optional(),
  export: exportModelSchema.optional(),
  // A set may hold an empty `maskedPaths` as `[]`.
  maskedPaths: z
    .union([z.record(z.string(), z.enum(KNOWN_ISSUE_IDS)), z.tuple([])])
    .transform((paths) => (Array.isArray(paths) ? {} : paths)),
});

const goldenStepSchema: z.ZodType<GoldenStep> = z.strictObject({
  name: z.string().min(1),
  index: z.number().int().nonnegative(),
  matrixKey: z.string().optional(),
  routeKey: z.string().min(1),
  request: requestSchema,
  response: responseSchema,
  normalised: normalisedStepSchema,
  expected: z.enum(STEP_EXPECTATIONS).optional(),
  decisionListRef: z.string().min(1).optional(),
  exceptionId: z.string().min(1).optional(),
  gap: z.strictObject({ reason: z.string().min(1), candidatesTried: z.number().int().positive() }).optional(),
  candidateIndex: z.number().int().nonnegative().optional(),
});

const sideEffectsSchema: z.ZodType<GoldenSideEffects> = z.strictObject({
  mail: z.array(
    z.looseObject({
      to: z.array(z.string()),
      from: z.string(),
      subject: z.string(),
      text: z.string(),
      htmlText: z.string(),
      headers: z.record(z.string(), z.array(z.string())).optional(),
    }) satisfies z.ZodType<NormalisedMail>,
  ),
  rows: z.record(
    z.string(),
    z.looseObject({
      unit: z.string(),
      legacyTable: z.string(),
      columns: z.array(z.custom<NormalisedTable['columns'][number]>(isPlainObject, 'must be a canonical column')),
      entries: z.array(z.strictObject({ encoding: z.string(), count: z.number().int().positive() })),
      checksum: z.string(),
    }) satisfies z.ZodType<NormalisedTable>,
  ),
  tasks: z.array(
    z.looseObject({
      kind: z.string(),
      target: z.string(),
      offsetSeconds: z.number(),
    }) satisfies z.ZodType<NormalisedTask>,
  ),
  files: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
  transitions: z
    .array(z.strictObject({ aggregate: z.string(), states: z.array(z.string()) }) satisfies z.ZodType<StateTransitions>)
    .optional(),
});

/** Schema of a committed golden set; `generatedBy`/`generatedAt` are the report writer's stamps. */
export const goldenSetSchema: z.ZodType<GoldenSet> = z
  .strictObject({
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character lowercase hex commit id'),
    scenarioId: z.string().regex(SCENARIO_ID_PATTERN, 'must match GS-<AREA>-NN or GS-<AREA>-RH-NN'),
    capturedAt: z.iso.datetime(),
    origin: z.literal('legacy'),
    tableVersion: z.null(),
    fixtures: z.strictObject({ available: z.boolean(), reason: z.string().nullable() }),
    skipped: z.literal(FIXTURES_UNAVAILABLE).optional(),
    steps: z.array(goldenStepSchema),
    sideEffects: sideEffectsSchema,
    generatedBy: z.string().min(1).optional(),
    generatedAt: z.string().min(1).optional(),
  })
  .superRefine((set, ctx) => {
    if (set.skipped !== undefined && set.steps.length > 0) {
      ctx.addIssue({ code: 'custom', message: 'a skipped set holds no steps', path: ['steps'] });
    }
  });

/** Absolute path of scenario `id`'s committed golden set. */
export function goldenSetPath(id: string): string {
  return repoPath(GOLDEN_SETS_DIR, `${id}.json`);
}

/** Path of scenario `id`'s raw capture, `<stateDir>/golden/raw/<id>.json`, outside the checkout. */
export function rawCapturePath(id: string, env: EnvLike = process.env): string {
  return path.join(stateDir(env), 'golden', 'raw', `${id}.json`);
}

/** Parses scenario `id`'s golden set; throws `GoldenConfigError` when it is missing, not JSON or off-schema. */
export async function readGoldenSet(id: string, file: string = goldenSetPath(id)): Promise<GoldenSet> {
  let set: GoldenSet;
  try {
    set = await readJson(file, goldenSetSchema);
  } catch (err) {
    throw new GoldenConfigError(`golden set of ${id}: ${(err as Error).message}`, { path: file, cause: err });
  }
  if (set.scenarioId !== id) {
    throw new GoldenConfigError(`golden set ${file} holds scenario ${set.scenarioId}, not ${id}`, { path: file });
  }
  return set;
}

/** The normalised run of `set`, as `compareNormalised` takes it. */
export function goldenRun(set: Pick<GoldenSet, 'steps' | 'sideEffects'>): NormalisedRun {
  return { steps: set.steps.map((step) => step.normalised), sideEffects: set.sideEffects };
}

function candidateKey(step: string, matrixKey: string | undefined): string {
  return JSON.stringify([step, matrixKey ?? null]);
}

/** Replay's candidate choice: the candidate each golden step kept, by step name and matrix key. */
export function candidateChoice(
  set: Pick<GoldenSet, 'steps'>,
): Extract<CandidateChoice, (...args: never[]) => unknown> {
  const kept = new Map<string, number>();
  for (const step of set.steps) {
    if (step.candidateIndex !== undefined) kept.set(candidateKey(step.name, step.matrixKey), step.candidateIndex);
  }
  return (step, matrixKey) => kept.get(candidateKey(step, matrixKey));
}

const SECRET_MASK = '<secret>';
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization']);
const COOKIE_HEADER = 'cookie';

function decodeParamName(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {
    return raw;
  }
}

/** `url` with the value of every non-empty token query parameter of the rules replaced by the token placeholder. */
function maskQueryTokens(url: string, rules: NormaliseRules): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const { tokens } = rules;
  const fold = tokens.queryParamMatch === 'exact' ? (name: string) => name : (name: string) => name.toLowerCase();
  const names = new Set(tokens.queryParams.map(fold));
  const query = url
    .slice(q + 1)
    .split('&')
    .map((param) => {
      const eq = param.indexOf('=');
      if (eq < 0 || eq === param.length - 1 || !names.has(fold(decodeParamName(param.slice(0, eq))))) return param;
      return `${param.slice(0, eq)}=${tokens.placeholder}`;
    });
  return `${url.slice(0, q + 1)}${query.join('&')}`;
}

/** Credential header value with its credentials as the token placeholder, unless already a secret mask. */
function maskCredentials(value: string, placeholder: string): string {
  const space = value.indexOf(' ');
  const credentials = space < 0 ? value : value.slice(space + 1);
  if (credentials === '' || credentials === SECRET_MASK) return value;
  return space < 0 ? placeholder : `${value.slice(0, space)} ${placeholder}`;
}

function maskHeaders(headers: Record<string, string>, rules: NormaliseRules): Record<string, string> {
  const placeholder = rules.tokens.placeholder;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (CREDENTIAL_HEADERS.has(lower)) out[name] = maskCredentials(value, placeholder);
    else if (lower === COOKIE_HEADER && value !== '') out[name] = placeholder;
    else out[name] = value;
  }
  return normaliseTokens(out, rules) as Record<string, string>;
}

type FieldValues = Extract<RecordedBody, { kind: 'form' }>['value'];

function maskBody(body: RecordedBody, rules: NormaliseRules): RecordedBody {
  switch (body.kind) {
    case 'none':
      return body;
    case 'form':
      return { kind: 'form', value: normaliseTokens(body.value, rules) as FieldValues };
    case 'json':
      return { kind: 'json', value: normaliseTokens(body.value, rules) };
    case 'multipart':
      return {
        kind: 'multipart',
        value: { fields: normaliseTokens(body.value.fields, rules) as FieldValues, files: body.value.files },
      };
  }
}

/**
 * A recorded request as committed: credentials, cookies, token headers, token fields and token query parameters
 * become the token placeholder; values already masked as `<secret>` stay masked.
 */
export function redactRequest(request: RecordedRequest, rules: NormaliseRules): RecordedRequest {
  return {
    method: request.method,
    url: maskQueryTokens(request.url, rules),
    headers: maskHeaders(request.headers, rules),
    body: maskBody(request.body, rules),
  };
}

// Parts the reviewed response always shows; `export` joins only where the step compares it, so other downloads are
// shown by digest and other text as normalised text.
const VIEW_KINDS: readonly CompareKind[] = ['status', 'headers', 'envelope', 'dom'];

/** `scenario` with every step comparing the reviewed-response parts, for the separate view normalisation. */
function viewScenario(scenario: Scenario): Scenario {
  return {
    ...scenario,
    steps: scenario.steps.map((step) => {
      const kinds = step.compare ?? scenario.compare;
      return { ...step, compare: kinds.includes('export') ? [...VIEW_KINDS, 'export'] : [...VIEW_KINDS] };
    }),
  };
}

function responseView(record: StepRecord, view: NormalisedStep): GoldenResponse {
  const response: GoldenResponse = {
    status: record.response.status,
    headers: view.headers ?? {},
    rawSha256: record.response.sha256,
  };
  if (view.domModel !== undefined) response.domModel = view.domModel;
  else if (view.export !== undefined) response.export = view.export;
  else response.body = view.envelope !== undefined ? view.envelope : view.body;
  return response;
}

/** Normalises one scenario side's records into golden steps and side effects. */
export interface GoldenStepBuilder {
  /** State of the compared normalisation; side effects continue its id ordinals. */
  readonly state: NormaliseState;
  step(record: StepRecord): Promise<GoldenStep>;
  sideEffects(effects: SideEffects, steps: readonly GoldenStep[]): Promise<GoldenSideEffects>;
}

/**
 * Builder for one scenario side. `normalised` uses one state across the scenario's steps and side effects, so id
 * ordinals stay consistent; the reviewed `response` uses a second state of its own, so parts the scenario does not
 * compare never shift the compared ordinals.
 */
export function createGoldenStepBuilder(scenario: Scenario, rules: NormaliseRules): GoldenStepBuilder {
  const state = createNormaliseState();
  const viewState = createNormaliseState();
  const viewed = viewScenario(scenario);
  return {
    state,
    async step(record) {
      const normalised = await normaliseStep(record, { state, rules, scenario });
      const view = await normaliseStep(record, { state: viewState, rules, scenario: viewed });
      const step: GoldenStep = {
        name: record.name,
        index: record.index,
        routeKey: record.routeKey,
        request: redactRequest(record.request, rules),
        response: responseView(record, view),
        normalised,
      };
      if (record.matrixKey !== undefined) step.matrixKey = record.matrixKey;
      if (record.expected !== undefined) step.expected = record.expected;
      if (record.decisionListRef !== undefined) step.decisionListRef = record.decisionListRef;
      if (record.exceptionId !== undefined) step.exceptionId = record.exceptionId;
      if (record.gap !== undefined) {
        step.gap = { reason: record.gap.reason, candidatesTried: record.gap.candidatesTried };
      }
      if (record.candidateIndex !== undefined) step.candidateIndex = record.candidateIndex;
      return step;
    },
    async sideEffects(effects, steps) {
      const normalised = await normaliseSideEffects(
        effects,
        { state, rules, scenario },
        steps.map((step) => step.normalised),
      );
      return { mail: [], rows: {}, tasks: [], files: [], ...normalised };
    },
  };
}

const exceptionEntrySchema = z.looseObject({
  id: z.string().min(1),
  scenario: z.string().min(1),
  routeKey: z.string().min(1),
  appliesTo: z.array(z.string()).optional(),
  difference: z.string(),
  decision: z.enum(['preserve', 'fix']),
  reason: z.string(),
  status: z.enum(['open', 'accepted', 'halted']),
  evidence: z.looseObject({ golden: z.string(), replay: z.string() }),
  sourceSha: z.string(),
});
const exceptionsListSchema = z.looseObject({ entries: z.array(exceptionEntrySchema) });

/** Options of {@link appendExceptionEntry}. */
export interface AppendExceptionOptions {
  /** Default {@link EXCEPTIONS_LIST_PATH}. */
  path?: string;
  report?: ReportOptions;
}

/**
 * Upserts `entry` into the exceptions list: an entry with the same `(scenario, routeKey, status)` is updated and keeps
 * its id, else one with the same id is replaced, else `entry` is appended. A `fix` entry is a proposal for the user and
 * is never changed. The file is rewritten only when it changes; returns the entry as stored.
 */
export async function appendExceptionEntry(
  entry: ExceptionEntry,
  opts: AppendExceptionOptions = {},
): Promise<ExceptionEntry> {
  const file = opts.path ?? EXCEPTIONS_LIST_PATH;
  const list = await readJson(file, exceptionsListSchema);
  const { entries } = list;
  const sameCase = entries.findIndex(
    (e) => e.scenario === entry.scenario && e.routeKey === entry.routeKey && e.status === entry.status,
  );
  const index = sameCase >= 0 ? sameCase : entries.findIndex((e) => e.id === entry.id);
  const existing = index >= 0 ? entries[index] : undefined;
  if (existing?.decision === 'fix') return existing;
  const stored: ExceptionEntry = existing === undefined ? entry : { ...existing, ...entry, id: existing.id };
  if (existing !== undefined && stableStringify(existing) === stableStringify(stored)) return stored;
  const body: Record<string, unknown> = {
    ...list,
    entries: existing === undefined ? [...entries, stored] : entries.map((e, i) => (i === index ? stored : e)),
  };
  // The writer stamps the run that last changed the list.
  delete body.generatedBy;
  delete body.generatedAt;
  await writeJsonReport(file, body, opts.report);
  return stored;
}

/** Exceptions-list id of a gap: `EX-GAP-<scenario>-<step>[-<matrix key>]`, upper-cased like every list id. */
export function gapExceptionId(scenarioId: string, record: Pick<StepRecord, 'name' | 'matrixKey'>): string {
  const parts = [scenarioId, record.name, ...(record.matrixKey === undefined ? [] : [record.matrixKey])];
  const id = parts.join('-').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `EX-GAP-${id}`;
}

function gapEntry(scenario: Scenario, record: StepRecord, gap: StepGap, sourceSha: string): ExceptionEntry {
  return {
    id: gapExceptionId(scenario.id, record),
    scenario: scenario.id,
    routeKey: record.routeKey,
    difference: GAP_REASON,
    decision: 'preserve',
    reason:
      `None of the ${gap.candidatesTried} candidate requests of step ${record.name} makes legacy answer with the ` +
      `JSON API server_error envelope, so the case is halted and its mapping is proven by the ` +
      `@opt2/platform/legacy-compat error-map unit tests.`,
    status: 'halted',
    evidence: haltEvidence(scenario.id),
    sourceSha,
  };
}

/** Collaborators of {@link captureScenario}; absent ones come from the environment. */
export interface CaptureDeps {
  rules: NormaliseRules;
  fixtures: Pick<FixtureStatus, 'available' | 'reason'>;
  sourceSha: string;
  env?: EnvLike;
  fetch?: FetchLike;
  /** Shared across a run so redaction covers every secret resolved so far. */
  secrets?: SecretStore;
  seed?: SeedStore;
  sideEffects?: Omit<SideEffectDeps, 'fetch'>;
  clock?: () => Date;
  /** Progress lines; default stderr. */
  log?: (line: string) => void;
  exceptions?: AppendExceptionOptions;
  /** Route-key registries and variants recorded keys use; default the coverage gate's committed ones. */
  routeKeyOptions?: StepRunOptions['routeKeyOptions'];
}

function stderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

function emptySideEffects(): GoldenSideEffects {
  return { mail: [], rows: {}, tasks: [], files: [] };
}

/** JSON-string and plain forms of each secret; throws when any occurs in `text`, never naming the value. */
function assertNoSecrets(text: string, secrets: readonly string[], what: string): void {
  for (const secret of secrets) {
    if (secret === '') continue;
    if (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))) {
      throw new Error(`${what}: a secret value remains after redaction`);
    }
  }
}

/**
 * Captures `scenario` against legacy. A fixture-dependent scenario without fixtures yields a `skipped` set; a browser
 * scenario yields `null` (the Playwright interaction suite captures it). Otherwise Mailpit is emptied, the steps run in
 * capture mode, side effects are collected, every step is normalised and redacted, and each step without a
 * deterministic trigger (`gap`) is recorded as a halted exceptions entry.
 */
export async function captureScenario(scenario: Scenario, deps: CaptureDeps): Promise<CapturedScenario | null> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? stderrLine;
  const capturedAt = (deps.clock ?? (() => new Date()))().toISOString();
  const base = {
    sourceSha: deps.sourceSha,
    scenarioId: scenario.id,
    capturedAt,
    origin: 'legacy' as const,
    tableVersion: null,
    fixtures: { available: deps.fixtures.available, reason: deps.fixtures.reason },
  };
  const skipped = skipReason(scenario, deps.fixtures);
  if (skipped !== null) {
    log(`${scenario.id}: ${skipped}`);
    return { set: { ...base, skipped, steps: [], sideEffects: emptySideEffects() }, gaps: [] };
  }
  if (scenario.browser !== undefined) {
    log(`${scenario.id}: browser flow ${scenario.browser.flow}, captured by harness/e2e/ui/interactions.e2e.ts`);
    return null;
  }

  const config = deps.sideEffects?.config ?? resolveSideEffectConfig(env);
  const sideDeps: SideEffectDeps = { ...deps.sideEffects, config, fetch: deps.fetch };
  await resetMailpit(env, { fetch: deps.fetch, config });
  const ctx = createScenarioContext(scenario, {
    origin: 'legacy',
    env,
    fetch: deps.fetch,
    secrets: deps.secrets,
    seed: deps.seed,
  });
  const records = await runScenarioSteps(ctx, scenario, {
    mode: 'capture',
    settle: settleHook(ctx, scenario, sideDeps),
    fetch: deps.fetch,
    routeKeyOptions: deps.routeKeyOptions,
  });
  const effects = await collectSideEffects(ctx, scenario, 'legacy', sideDeps);
  const secrets = secretValues(ctx);

  const builder = createGoldenStepBuilder(scenario, deps.rules);
  const steps: GoldenStep[] = [];
  const gaps: string[] = [];
  for (const record of redact(records, secrets)) {
    let exceptionId = record.exceptionId;
    if (record.gap !== undefined) {
      const entry = gapEntry(scenario, record, record.gap, deps.sourceSha);
      const stored = await appendExceptionEntry(entry, deps.exceptions);
      exceptionId ??= stored.id;
      gaps.push(stored.id);
      log(`${scenario.id} step ${record.name}: ${record.gap.reason}; recorded ${stored.id}`);
    }
    steps.push(await builder.step(exceptionId === undefined ? record : { ...record, exceptionId }));
  }
  const redactedEffects = redact(effects, secrets);
  const sideEffects = await builder.sideEffects(redactedEffects, steps);

  const set = redact<GoldenSet>({ ...base, steps, sideEffects }, secrets);
  const raw = redact<RawCapture>({ ...base, records, sideEffects: effects }, secrets);
  assertNoSecrets(stableStringify(set), secrets, `${scenario.id} golden set`);
  assertNoSecrets(stableStringify(raw), secrets, `${scenario.id} raw capture`);
  log(`${scenario.id}: captured ${steps.length} exchanges`);
  return { set, raw, gaps };
}

/** Writes a capture: the raw exchanges under `${OPT2_STATE_DIR}` first, then the committed set. */
export async function writeCapture(
  captured: CapturedScenario,
  env: EnvLike = process.env,
  report: ReportOptions = {},
): Promise<string> {
  const opts: ReportOptions = { generatedBy: GENERATED_BY, ...report };
  if (captured.raw !== undefined) {
    await writeJsonReport(rawCapturePath(captured.raw.scenarioId, env), { ...captured.raw }, opts);
  }
  const { path: file } = await writeJsonReport(goldenSetPath(captured.set.scenarioId), { ...captured.set }, opts);
  return file;
}

const USAGE = 'tsx src/golden/capture.ts [--only <scenario-id>[,<scenario-id>…]] [--catalogue <path>]';
const HELP = [
  `Usage: ${USAGE}`,
  '',
  'Captures every catalogue scenario (or --only those) against legacy directly and writes',
  `${GOLDEN_SETS_DIR}/<id>.json, plus the raw exchanges under \${OPT2_STATE_DIR}/golden/raw/.`,
].join('\n');

/** Collaborators of {@link main} beyond the environment. */
export type MainDeps = Pick<CaptureDeps, 'fetch' | 'secrets' | 'seed' | 'sideEffects' | 'clock' | 'log'>;

/** Scenarios `--only` names, in catalogue order; every id must exist. */
function selectedScenarios(catalogue: Catalogue, only: string | undefined): Scenario[] {
  if (only === undefined) return [...catalogue.scenarios];
  const ids = only
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (ids.length === 0) throw new UsageError('--only needs at least one scenario id', USAGE);
  const wanted = new Set(ids.map((id) => scenarioById(catalogue, id).id));
  return catalogue.scenarios.filter((scenario) => wanted.has(scenario.id));
}

/**
 * Captures the selected scenarios in catalogue order, continuing past a failed one; exit 1 when any failed.
 * Summary: `{captured, skipped, browser, gaps, failed}` (counts, gap exception ids, failed ids with their errors).
 */
export async function main(argv: string[], env: EnvLike = process.env, deps: MainDeps = {}): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: { only: { type: 'string' }, catalogue: { type: 'string' } },
    usage: USAGE,
    help: HELP,
  });
  if (values.catalogue === '') throw new UsageError('--catalogue needs a path', USAGE);
  const log = deps.log ?? stderrLine;
  const pin = readPin();
  const cataloguePath = values.catalogue === undefined ? CATALOGUE_PATH : path.resolve(values.catalogue);
  const catalogue = await loadCatalogue(cataloguePath);
  const scenarios = selectedScenarios(catalogue, values.only);
  const rules = loadRules(RULES_PATH, env);
  const fixtures = readFixtureStatus(env);
  const secrets = deps.secrets ?? loadSecretStore(env);
  const seed = deps.seed ?? loadSeedStore(env);
  const sideEffects = { ...deps.sideEffects, config: deps.sideEffects?.config ?? resolveSideEffectConfig(env) };
  await resetMailpit(env, { fetch: deps.fetch, config: sideEffects.config });

  const counts = { captured: 0, skipped: 0, browser: 0 };
  const gaps: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const scenario of scenarios) {
    try {
      const captured = await captureScenario(scenario, {
        ...deps,
        rules,
        fixtures,
        sourceSha: pin.sha,
        env,
        secrets,
        seed,
        sideEffects,
      });
      if (captured === null) {
        counts.browser += 1;
        continue;
      }
      await writeCapture(captured, env);
      if (captured.set.skipped === undefined) counts.captured += 1;
      else counts.skipped += 1;
      gaps.push(...captured.gaps);
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const error = redact(message, secretValues({ secrets }));
      failed.push({ id: scenario.id, error });
      log(`${scenario.id}: capture failed: ${error}`);
    }
  }
  return { code: failed.length > 0 ? 1 : 0, summary: { ...counts, gaps, failed } };
}

if (isMainModule(import.meta.url)) void runCli(main);
