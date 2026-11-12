// The one golden normaliser: normalises capture and replay records alike and compares the results.
import type { CompareKind, Scenario, Step } from '../catalogue.js';
import { GoldenConfigError } from '../errors.js';
import type { FileVariant, SideEffects } from '../side-effects.js';
import type { RecordedResponse, StepRecord } from '../steps.js';
import {
  createSessionCookieTracker,
  normaliseAuth,
  type NormalisedAuth,
  type SessionCookieTracker,
} from './cookies.js';
import { domModel, type DomModel } from './dom-model.js';
import { exportModel, fileModel, type ExportModel } from './exports.js';
import { normaliseHeaders, type NormalisedHeaders } from './headers.js';
import { createIdOrdinals, normaliseIdsInString, type IdOrdinals } from './ids.js';
import { normaliseMail, type NormalisedMail } from './mail.js';
import { applyMasks, masksFor, pathMasks, type Difference, type DifferenceKind, type KnownIssueMask } from './masks.js';
import { compareRows, normaliseRows, type NormalisedRows } from './rows.js';
import { applyOverrides, ruleEnabled, type KnownIssueId, type NormaliseRules } from './rules.js';
import { normaliseTasks, type NormalisedTask } from './tasks.js';
import { isTokenKey, normaliseText, normaliseValue } from './values.js';

export * from './cookies.js';
export * from './dom-model.js';
export * from './exports.js';
export * from './headers.js';
export * from './ids.js';
export * from './mail.js';
export * from './masks.js';
export * from './rows.js';
export * from './rules.js';
export * from './tasks.js';
export * from './values.js';
export type { Classification, Difference, DifferenceKind } from './masks.js';

/** One scenario side's state, shared by all its steps and side effects: id ordinals and session-cookie values. */
export interface NormaliseState {
  ids: IdOrdinals;
  sessionCookies: SessionCookieTracker;
}

/** Fresh state for one side (capture or replay) of one scenario. */
export function createNormaliseState(): NormaliseState {
  return { ids: createIdOrdinals(), sessionCookies: createSessionCookieTracker() };
}

/**
 * Inputs of normalisation. `rules` is either the loaded rules or rules already carrying this scenario's
 * `normalisationOverrides`; the overrides are applied exactly once in both cases.
 */
export interface NormaliseContext {
  state: NormaliseState;
  rules: NormaliseRules;
  scenario: Scenario;
}

/** A step record as compared; `maskedPaths` lists the paths its known-issue masks cover. */
export interface NormalisedStep {
  name: string;
  index: number;
  matrixKey?: string;
  routeKey: string;
  status: number;
  headers?: NormalisedHeaders;
  auth?: NormalisedAuth;
  /** A Masa JSON envelope (an object with `apiversion`). */
  envelope?: unknown;
  /** Any other JSON value, or normalised text. */
  body?: unknown;
  domModel?: DomModel;
  export?: ExportModel;
  /** JSON of a step comparing transitions but no body; read by `stateTransitions` only, never compared. */
  transitionBody?: unknown;
  maskedPaths: Record<string, KnownIssueId>;
}

/** The body representation of a response, with the masked paths inside it. */
export type NormalisedBody = Pick<NormalisedStep, 'envelope' | 'body' | 'domModel' | 'export' | 'maskedPaths'>;

/** One stored file variant, holding the fields `files.compare` names. */
export type NormalisedFile = Record<string, string | number>;

/** Ordered states of one aggregate across a scenario's steps, consecutive repeats collapsed. */
export interface StateTransitions {
  aggregate: string;
  states: string[];
}

/** Normalised side effects; only the kinds the scenario compares are present. */
export interface NormalisedSideEffects {
  mail?: NormalisedMail[];
  rows?: NormalisedRows;
  tasks?: NormalisedTask[];
  files?: NormalisedFile[];
  transitions?: StateTransitions[];
}

/** One side of a scenario as compared: its normalised steps and side effects. */
export interface NormalisedRun {
  steps: readonly NormalisedStep[];
  sideEffects: NormalisedSideEffects;
}

/** Rules and scenario a comparison runs under. */
export interface CompareOptions {
  rules: NormaliseRules;
  scenario: Scenario;
}

/** `Difference.step` of side-effect differences, whose paths start with `sideEffects.`. */
export const SIDE_EFFECTS_STEP = 'sideEffects';

const BODY_KINDS: readonly CompareKind[] = ['envelope', 'dom', 'export'];
const STEP_PARTS = ['headers', 'auth', 'envelope', 'body', 'domModel', 'export'] as const;
const HTML_TYPES: ReadonlySet<string> = new Set(['text/html', 'application/xhtml+xml']);
// Admin `json` response modes carry rendered markup in these keys: loadsitemanager.cfm:158, loadsitesection.cfm:111,
// refreshsitesection.cfm:105 (`html`), draftpromptdata.cfm:89 (`message`).
const EMBEDDED_HTML_FIELDS: ReadonlySet<string> = new Set(['html', 'message']);
const HTML_MARKUP = /^\s*<(?:!doctype\b|[a-z][a-z0-9-]*(?=[\s/>]))/i;
const STATE_KEYS = ['state', 'status'] as const;
const PLACEHOLDER_REF = /\$\{([^${}]+)\}/g;
const PATH_SEGMENT = /([^.[\]]+)|\[(\*|\d+)\]/g;
// A pattern that never matches: id rules compiled from it replace nothing.
const NEVER = '(?!)';
const SIDE_EFFECTS_INDEX = Number.MAX_SAFE_INTEGER;
const byPlaceholder = new Intl.Collator('en', { numeric: true }).compare;

const codeUnitOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const overriddenRules = new WeakMap<NormaliseRules, WeakMap<object, NormaliseRules>>();

/** `rules` with the scenario's `normalisationOverrides` applied once; rules already carrying them are returned. */
export function rulesForScenario(
  rules: NormaliseRules,
  scenario: Pick<Scenario, 'id' | 'normalisationOverrides'>,
): NormaliseRules {
  if (rules.overrides.applied.scenario === scenario.id) return rules;
  const overrides = scenario.normalisationOverrides;
  let byOverrides = overriddenRules.get(rules);
  if (byOverrides === undefined) {
    byOverrides = new WeakMap();
    overriddenRules.set(rules, byOverrides);
  }
  const cached = byOverrides.get(overrides);
  if (cached !== undefined && cached.overrides.applied.scenario === scenario.id) return cached;
  const applied = applyOverrides(rules, overrides, scenario.id);
  byOverrides.set(overrides, applied);
  return applied;
}

const literalRulesOf = new WeakMap<NormaliseRules, NormaliseRules>();

// `literalPaths` exempts values from the id and timestamp rules only; tokens, origins and URLs still apply.
function literalRules(rules: NormaliseRules): NormaliseRules {
  let literal = literalRulesOf.get(rules);
  if (literal === undefined) {
    literal = {
      ...rules,
      ids: { ...rules.ids, pattern: NEVER, rfc4122: { ...rules.ids.rfc4122, pattern: NEVER } },
      timestamps: { ...rules.timestamps, classes: [] },
    };
    literalRulesOf.set(rules, literal);
  }
  return literal;
}

function catalogueStep(scenario: Scenario, name: string): Step | undefined {
  return scenario.steps.find((step) => step.name === name);
}

// A step's own `compare` replaces the scenario's (e.g. `[]` for target-only screens).
function stepKinds(scenario: Scenario, name: string): ReadonlySet<CompareKind> {
  return new Set(catalogueStep(scenario, name)?.compare ?? scenario.compare);
}

function mediaType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

function isJsonType(media: string, rules: NormaliseRules): boolean {
  return rules.envelope.contentTypes.some((type) => type.toLowerCase() === media) || media.endsWith('+json');
}

function tryParse(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

// mura.json's encode escapes ' as \' (JSStringFormat), which JSON rejects; legacy's own client evals the body.
function parseJson(text: string): { value: unknown } | undefined {
  const parsed = tryParse(text);
  if (parsed !== undefined || !text.includes("\\'")) return parsed;
  return tryParse(text.replace(/\\(.)/gs, (escape: string, char: string) => (char === "'" ? "'" : escape)));
}

const ANY_INDEX = Symbol('[*]');
type PathSegment = string | number | typeof ANY_INDEX;
type RawPath = readonly (string | number)[];

/** Override JSON path (`a.b[*].c`, `items[0]`) as segments. */
function parsePath(path: string): PathSegment[] {
  return [...path.matchAll(PATH_SEGMENT)].map((m) => m[1] ?? (m[2] === '*' ? ANY_INDEX : Number(m[2])));
}

function pathMatches(path: readonly PathSegment[], at: RawPath): boolean {
  return (
    path.length === at.length &&
    path.every((segment, i) => (segment === ANY_INDEX ? typeof at[i] === 'number' : segment === at[i]))
  );
}

function prefixed(paths: Readonly<Record<string, KnownIssueId>>, prefix: string): Record<string, KnownIssueId> {
  return Object.fromEntries(Object.entries(paths).map(([path, id]) => [`${prefix}${path}`, id]));
}

/** What body normalisation of one response needs. */
interface BodyEnv {
  ids: IdOrdinals;
  rules: NormaliseRules;
  kinds: ReadonlySet<CompareKind>;
  masks: readonly KnownIssueMask[];
}

interface JsonEnv extends BodyEnv {
  literal: readonly (readonly PathSegment[])[];
  maskedPaths: Record<string, KnownIssueId>;
}

interface PruneOps {
  drop: readonly (readonly PathSegment[])[];
  sort: readonly (readonly PathSegment[])[];
}

function lastKey(at: RawPath): string | undefined {
  const key = at.findLast((segment) => typeof segment === 'string');
  return typeof key === 'string' ? key : undefined;
}

// Element order comes from each element's provisional normalised form, so it never depends on raw ids.
function sortProvisionally(items: unknown[], key: string | undefined, env: BodyEnv): unknown[] {
  return items
    .map((item) => ({ item, order: JSON.stringify(normaliseValue(item, structuredClone(env.ids), env.rules, key)) }))
    .sort((a, b) => codeUnitOrder(a.order, b.order))
    .map(({ item }) => item);
}

/** Raw JSON with the `dropPaths` removed and the `sortArrays` arrays sorted; the input is not mutated. */
function prune(value: unknown, at: RawPath, ops: PruneOps, env: BodyEnv): unknown {
  const dropped = (path: RawPath): boolean => ops.drop.some((drop) => pathMatches(drop, path));
  if (Array.isArray(value)) {
    const items = value.flatMap((item: unknown, i) => (dropped([...at, i]) ? [] : [prune(item, [...at, i], ops, env)]));
    return ops.sort.some((sort) => pathMatches(sort, at)) ? sortProvisionally(items, lastKey(at), env) : items;
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !dropped([...at, name]))
      .map(([name, child]) => [name, prune(child, [...at, name], ops, env)]),
  );
}

/**
 * JSON normalised as `normaliseValue` does, visiting keys in sorted order, except that `literalPaths` skip the id and
 * timestamp rules and, when the DOM is compared, embedded admin markup becomes its DOM model.
 * @param out Output path of `value`, which prefixes the DOM model's masked paths.
 */
function walkJson(value: unknown, key: string | undefined, at: RawPath, out: string, env: JsonEnv): unknown {
  if (env.literal.some((path) => pathMatches(path, at))) {
    return normaliseValue(value, env.ids, literalRules(env.rules), key);
  }
  if (key !== undefined && isTokenKey(key, env.rules)) return normaliseValue(value, env.ids, env.rules, key);
  if (
    typeof value === 'string' &&
    key !== undefined &&
    env.kinds.has('dom') &&
    EMBEDDED_HTML_FIELDS.has(key.toLowerCase()) &&
    HTML_MARKUP.test(value)
  ) {
    const { model, maskedPaths } = domModel(value, { state: env.ids, rules: env.rules, masks: env.masks });
    for (const [path, id] of Object.entries(prefixed(maskedPaths, `${out}.`))) env.maskedPaths[path] ??= id;
    return model;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown, i) => walkJson(item, key, [...at, i], `${out}[${i}]`, env));
  }
  if (!isPlainObject(value)) return normaliseValue(value, env.ids, env.rules, key);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((name): [string, unknown] => {
        const outName = normaliseIdsInString(name, env.ids, env.rules.ids);
        return [outName, walkJson(value[name], name, [...at, name], `${out}.${outName}`, env)];
      }),
  );
}

/** A parsed JSON body: the Masa envelope (`error.stacktrace` dropped when that rule is applied) or any other value. */
function jsonBody(parsed: unknown, env: BodyEnv): NormalisedBody {
  const { rules } = env;
  const { applied } = rules.overrides;
  const isEnvelope = isPlainObject(parsed) && Object.hasOwn(parsed, 'apiversion');
  const stacktrace = rules.envelope.stacktrace;
  const drop = [...applied.dropPaths, ...(isEnvelope && ruleEnabled(rules, stacktrace.id) ? stacktrace.dropPaths : [])];
  const ops: PruneOps = { drop: drop.map(parsePath), sort: applied.sortArrays.map(parsePath) };
  const raw = ops.drop.length === 0 && ops.sort.length === 0 ? parsed : prune(parsed, [], ops, env);
  const jsonEnv: JsonEnv = { ...env, literal: applied.literalPaths.map(parsePath), maskedPaths: {} };
  const value = walkJson(raw, undefined, [], isEnvelope ? 'envelope' : 'body', jsonEnv);
  const { maskedPaths } = jsonEnv;
  return isEnvelope ? { envelope: value, maskedPaths } : { body: value, maskedPaths };
}

/** JSON bodies, and HTML when the DOM is compared; undefined for anything else. */
function structuredBody(contentType: string, text: string, env: BodyEnv): NormalisedBody | undefined {
  const media = mediaType(contentType);
  if (isJsonType(media, env.rules)) {
    const parsed = parseJson(text);
    if (parsed !== undefined) return jsonBody(parsed.value, env);
  }
  if (HTML_TYPES.has(media) && env.kinds.has('dom')) {
    const { model, maskedPaths } = domModel(text, { state: env.ids, rules: env.rules, masks: env.masks });
    return { domModel: model, maskedPaths: prefixed(maskedPaths, 'domModel.') };
  }
  return undefined;
}

// Downloads (CSV, XLSX, PDF, other files) are modelled when exports are compared; other text is normalised text.
async function responseBody(
  response: RecordedResponse,
  text: string | undefined,
  env: BodyEnv,
): Promise<NormalisedBody> {
  const structured = text === undefined ? undefined : structuredBody(response.contentType, text, env);
  if (structured !== undefined) return structured;
  const media = mediaType(response.contentType);
  if (env.kinds.has('export') && !isJsonType(media, env.rules) && !HTML_TYPES.has(media)) {
    return { export: await exportModel(response, env.ids, env.rules), maskedPaths: {} };
  }
  if (text !== undefined) return { body: normaliseText(text, env.ids, env.rules), maskedPaths: {} };
  return { export: fileModel({ sha256: response.sha256, contentType: response.contentType }), maskedPaths: {} };
}

/**
 * One step record normalised for comparison, continuing the side's id ordinals. Parts are produced in a fixed order
 * (status, headers, auth, body) and only for the kinds the step compares (its own `compare`, else the scenario's); a
 * step comparing transitions but no body keeps its JSON body as `transitionBody` instead.
 */
export async function normaliseStep(record: StepRecord, ctx: NormaliseContext): Promise<NormalisedStep> {
  const rules = rulesForScenario(ctx.rules, ctx.scenario);
  const { ids } = ctx.state;
  const definition = catalogueStep(ctx.scenario, record.name);
  const kinds = stepKinds(ctx.scenario, record.name);
  const masks = masksFor(ctx.scenario.id, record.routeKey, rules, definition);
  const { response } = record;
  const text = 'text' in response ? response.text : undefined;
  const step: Omit<NormalisedStep, 'maskedPaths'> = {
    name: record.name,
    index: record.index,
    ...(record.matrixKey === undefined ? {} : { matrixKey: record.matrixKey }),
    routeKey: record.routeKey,
    status: response.status,
  };
  if (kinds.has('headers')) step.headers = normaliseHeaders(response.headers, text, ids, rules);
  if (kinds.has('auth')) step.auth = normaliseAuth(response, ctx.state, rules);
  let bodyMasks: Record<string, KnownIssueId> = {};
  if (BODY_KINDS.some((kind) => kinds.has(kind))) {
    const { maskedPaths, ...body } = await responseBody(response, text, { ids, rules, kinds, masks });
    Object.assign(step, body);
    bodyMasks = maskedPaths;
  } else if (kinds.has('transitions') && text !== undefined) {
    // Without `dom` in `kinds`, only JSON is structured, as envelope or body.
    const json = structuredBody(response.contentType, text, { ids, rules, kinds, masks });
    if (json !== undefined) step.transitionBody = json.envelope ?? json.body;
  }
  // Header, cookie, status and body masks first; DOM paths never displace them.
  return { ...step, maskedPaths: { ...bodyMasks, ...pathMasks(step, masks) } };
}

/**
 * A response body normalised by the step rules, for XHR bodies of the browser suite: JSON as envelope or body, HTML
 * as a DOM model when the scenario compares the DOM, anything else as normalised text.
 * @param routeKey Route key of the request; without it no known-issue mask applies.
 */
export function normaliseBody(
  contentType: string,
  text: string,
  ctx: NormaliseContext,
  routeKey?: string,
): NormalisedBody {
  const rules = rulesForScenario(ctx.rules, ctx.scenario);
  const masks = routeKey === undefined ? [] : masksFor(ctx.scenario.id, routeKey, rules);
  const env: BodyEnv = { ids: ctx.state.ids, rules, kinds: new Set(ctx.scenario.compare), masks };
  return structuredBody(contentType, text, env) ?? { body: normaliseText(text, env.ids, rules), maskedPaths: {} };
}

type FileField = (variant: FileVariant, name: string) => string | number;

// `files.compare` names: the variant (fileDAO.cfc:153-199: original, _source, _small, _medium), the stored name
// (its file id), and the digest fields.
const FILE_FIELDS: ReadonlyMap<string, FileField> = new Map<string, FileField>([
  ['variant', (variant) => variant.name],
  ['name', (_variant, name) => name],
  ['contentType', (variant) => variant.contentType],
  ['sha256', (variant) => variant.sha256],
  ['size', (variant) => variant.size],
]);

/**
 * Stored file variants by the fields `files.compare` names, sorted by name, then variant in `files.variants` order.
 * Throws `RangeError` for a field name it cannot produce.
 */
function normaliseFiles(files: readonly FileVariant[], ids: IdOrdinals, rules: NormaliseRules): NormalisedFile[] {
  const fields = rules.files.compare.map((field): [string, FileField] => {
    const read = FILE_FIELDS.get(field);
    if (read === undefined) {
      const known = [...FILE_FIELDS.keys()].join(', ');
      throw new RangeError(`files.compare names unknown field ${field}; expected one of ${known}`);
    }
    return [field, read];
  });
  const apply = new Set<string>(rules.files.apply);
  const maskIds = apply.has(rules.ids.id) || apply.has(rules.ids.rfc4122.id);
  const variants = rules.files.variants;
  const rank = (name: string): number => (variants.includes(name) ? variants.indexOf(name) : variants.length);
  // Unseen file ids take ordinals in content order, never in the order an origin listed its files.
  const named = [...files]
    .sort(
      (a, b) =>
        codeUnitOrder(a.contentType, b.contentType) ||
        codeUnitOrder(a.sha256, b.sha256) ||
        a.size - b.size ||
        rank(a.name) - rank(b.name),
    )
    .map((variant) => ({
      variant,
      name: maskIds ? normaliseIdsInString(variant.fileId, ids, rules.ids) : variant.fileId,
    }));
  return named
    .sort((a, b) => codeUnitOrder(a.name, b.name) || rank(a.variant.name) - rank(b.variant.name))
    .map(({ variant, name }) => Object.fromEntries(fields.map(([field, read]) => [field, read(variant, name)])));
}

/**
 * Side effects normalised after every step of the scenario side, so their ordinals continue the steps'. Only the
 * kinds `scenario.compare` lists are produced; `transitions` needs the side's normalised `steps`.
 */
export async function normaliseSideEffects(
  effects: SideEffects,
  ctx: NormaliseContext,
  steps?: readonly NormalisedStep[],
): Promise<NormalisedSideEffects> {
  const rules = rulesForScenario(ctx.rules, ctx.scenario);
  const kinds = new Set<CompareKind>(ctx.scenario.compare);
  const { ids } = ctx.state;
  const out: NormalisedSideEffects = {};
  // `effects.legacyRows` (gateway only) has no golden counterpart, so it is left out of the comparison.
  if (kinds.has('mail')) out.mail = normaliseMail(effects.mail, ids, rules);
  if (kinds.has('rows')) out.rows = normaliseRows(effects.rows, ids, rules);
  if (kinds.has('tasks')) out.tasks = normaliseTasks(effects.tasks, { state: ids, rules });
  if (kinds.has('files')) out.files = normaliseFiles(effects.files, ids, rules);
  if (kinds.has('transitions') && steps !== undefined) {
    out.transitions = stateTransitions(steps, { rules, scenario: ctx.scenario });
  }
  return out;
}

/** Whole-value pattern of the id placeholders `transitions.aggregateId` names. */
function aggregatePattern(rules: NormaliseRules): RegExp {
  const templates = rules.transitions.aggregateId.map((id) => {
    if (id === rules.ids.id) return rules.ids.placeholder;
    if (id === rules.ids.rfc4122.id) return rules.ids.rfc4122.placeholder;
    throw new GoldenConfigError(`normalise rules transitions.aggregateId names ${id}, which is not an id rule`);
  });
  return new RegExp(`^(?:${templates.map((t) => t.split('{n}').map(escapeRegExp).join('\\d+')).join('|')})$`);
}

/**
 * Lower-cased fields whose ids the scenario's routes address: `${seed.<alias>.<field>}`, and `${<step>.<binding>}`
 * bindings extracted from a body path (its last key). They name the aggregate a state belongs to.
 */
function routeBoundFields(scenario: Scenario): ReadonlySet<string> {
  const extracted = new Map<string, string>();
  for (const step of scenario.steps) {
    for (const [binding, extraction] of Object.entries(step.extract ?? {})) {
      if (extraction.from !== 'body') continue;
      const field = extraction.path.replace(/\[[^\]]*\]/g, '').split('.').at(-1);
      if (field !== undefined && field !== '') extracted.set(`${step.name}.${binding}`, field);
    }
  }
  const fields = new Set<string>();
  for (const step of scenario.steps) {
    for (const [, ref = ''] of step.route.matchAll(PLACEHOLDER_REF)) {
      const parts = ref.split('.');
      const seedField = parts.length > 2 ? parts.at(-1) : undefined;
      const field = parts[0] === 'seed' ? seedField : extracted.get(parts.slice(0, 2).join('.'));
      if (field !== undefined) fields.add(field.toLowerCase());
    }
  }
  return fields;
}

function stateOf(entry: Readonly<Record<string, unknown>>): string | undefined {
  for (const wanted of STATE_KEYS) {
    const key = Object.keys(entry).find((name) => name.toLowerCase() === wanted);
    const value = key === undefined ? undefined : entry[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

// The identity key is a route-bound field, else `id`, else the object's only id-valued key; first in key order.
function aggregateOf(
  entry: Readonly<Record<string, unknown>>,
  bound: ReadonlySet<string>,
  pattern: RegExp,
): string | undefined {
  const keys = Object.keys(entry).filter((name) => {
    const value = entry[name];
    return typeof value === 'string' && pattern.test(value);
  });
  const key =
    keys.find((name) => bound.has(name.toLowerCase())) ??
    keys.find((name) => name.toLowerCase() === 'id') ??
    (keys.length === 1 ? keys[0] : undefined);
  return key === undefined ? undefined : (entry[key] as string);
}

function eachObject(value: unknown, visit: (entry: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) eachObject(item, visit);
  } else if (isPlainObject(value)) {
    visit(value);
    for (const child of Object.values(value)) eachObject(child, visit);
  }
}

/**
 * Ordered state sequence per aggregate (rules `transitions`): every object of a step's envelope, JSON body or
 * transition body holding a `state` (else `status`) string and an aggregate id placeholder, in step order. Sorted by
 * aggregate placeholder.
 */
export function stateTransitions(steps: readonly NormalisedStep[], opts: CompareOptions): StateTransitions[] {
  const rules = rulesForScenario(opts.rules, opts.scenario);
  const pattern = aggregatePattern(rules);
  const bound = routeBoundFields(opts.scenario);
  const sequences = new Map<string, string[]>();
  for (const step of [...steps].sort((a, b) => a.index - b.index)) {
    for (const part of [step.envelope, step.body, step.transitionBody]) {
      eachObject(part, (entry) => {
        const state = stateOf(entry);
        const aggregate = state === undefined ? undefined : aggregateOf(entry, bound, pattern);
        if (state === undefined || aggregate === undefined) return;
        const states = sequences.get(aggregate) ?? [];
        if (states.at(-1) !== state) states.push(state);
        sequences.set(aggregate, states);
      });
    }
  }
  return [...sequences]
    .map(([aggregate, states]) => ({ aggregate, states }))
    .sort((a, b) => byPlaceholder(a.aggregate, b.aggregate));
}

function difference(step: string, path: string, kind: DifferenceKind, expected: unknown, actual: unknown): Difference {
  return { step, path, kind, expected, actual, classification: 'difference' };
}

/** One difference per differing leaf; absent and `undefined` are the same, array elements compare by position. */
function diffValues(expected: unknown, actual: unknown, path: string, step: string, out: Difference[]): void {
  if (expected === undefined && actual === undefined) return;
  if (expected === undefined) {
    out.push(difference(step, path, 'extra', undefined, actual));
  } else if (actual === undefined) {
    out.push(difference(step, path, 'missing', expected, undefined));
  } else if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i += 1) diffValues(expected[i], actual[i], `${path}[${i}]`, step, out);
  } else if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(codeUnitOrder);
    for (const key of keys) diffValues(expected[key], actual[key], `${path}.${key}`, step, out);
  } else if (expected !== actual) {
    out.push(difference(step, path, 'changed', expected, actual));
  }
}

function pairKey(step: NormalisedStep): string {
  return JSON.stringify([step.index, step.name, step.matrixKey ?? null]);
}

function stepIdentity(step: NormalisedStep): Record<string, unknown> {
  const { index, routeKey, matrixKey } = step;
  return { index, routeKey, ...(matrixKey === undefined ? {} : { matrixKey }) };
}

/** Cookies paired by name and occurrence: a pair by field, the rest as one `missing` or `extra` at its own index. */
function diffCookies(
  expected: NormalisedAuth['cookies'],
  actual: NormalisedAuth['cookies'],
  step: string,
  out: Difference[],
): void {
  const unpaired = new Map<string, number[]>();
  actual.forEach((cookie, index) => unpaired.set(cookie.name, [...(unpaired.get(cookie.name) ?? []), index]));
  expected.forEach((cookie, index) => {
    const path = `auth.cookies[${index}]`;
    const match = unpaired.get(cookie.name)?.shift();
    if (match === undefined) out.push(difference(step, path, 'missing', cookie, undefined));
    else diffValues(cookie, actual[match], path, step, out);
  });
  for (const index of [...unpaired.values()].flat()) {
    out.push(difference(step, `auth.cookies[${index}]`, 'extra', undefined, actual[index]));
  }
}

// Cookies pair by name; the other auth fields compare by value.
function diffAuth(expected: NormalisedAuth, actual: NormalisedAuth, step: string, out: Difference[]): void {
  const { cookies: expectedCookies, ...expectedRest } = expected;
  const { cookies: actualCookies, ...actualRest } = actual;
  diffCookies(expectedCookies, actualCookies, step, out);
  diffValues(expectedRest, actualRest, 'auth', step, out);
}

/** Differences of one step pair; `missing` reads the golden masks, `extra` the replay masks, the rest both sides'. */
function compareSteps(golden: NormalisedStep, replay: NormalisedStep, scenario: Scenario): Difference[] {
  const out: Difference[] = [];
  if (stepKinds(scenario, golden.name).has('status') && golden.status !== replay.status) {
    out.push(difference(golden.name, 'status', 'status', golden.status, replay.status));
  }
  for (const part of STEP_PARTS) {
    if (part === 'auth' && golden.auth !== undefined && replay.auth !== undefined) {
      diffAuth(golden.auth, replay.auth, golden.name, out);
    } else {
      diffValues(golden[part], replay[part], part, golden.name, out);
    }
  }
  // A committed set may hold an empty `maskedPaths` as `[]`; spreading reads either form.
  const sides = { golden: { ...golden.maskedPaths }, replay: { ...replay.maskedPaths } };
  return applyMasks(out, {
    maskedPathsByStep: new Map([[golden.name, { ...sides.replay, ...sides.golden }]]),
    maskedSidesByStep: new Map([[golden.name, sides]]),
  });
}

function sameStates(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((state, i) => state === b[i]);
}

/** Per-aggregate sequences: `order` when the same states occur in another order, `changed` otherwise. */
function compareTransitions(
  golden: readonly StateTransitions[],
  replay: readonly StateTransitions[],
  out: Difference[],
): void {
  const want = new Map(golden.map((t) => [t.aggregate, t.states]));
  const got = new Map(replay.map((t) => [t.aggregate, t.states]));
  for (const aggregate of [...new Set([...want.keys(), ...got.keys()])].sort(byPlaceholder)) {
    const path = `${SIDE_EFFECTS_STEP}.transitions.${aggregate}`;
    const expected = want.get(aggregate);
    const actual = got.get(aggregate);
    if (expected === undefined || actual === undefined || sameStates(expected, actual)) {
      diffValues(expected, actual, path, SIDE_EFFECTS_STEP, out);
    } else {
      const reordered = sameStates([...expected].sort(codeUnitOrder), [...actual].sort(codeUnitOrder));
      out.push(difference(SIDE_EFFECTS_STEP, path, reordered ? 'order' : 'changed', expected, actual));
    }
  }
}

/** Side-effect differences for the kinds the scenario compares; a kind absent from a side counts as empty. */
function compareSideEffects(golden: NormalisedRun, replay: NormalisedRun, opts: CompareOptions): Difference[] {
  const kinds = new Set<CompareKind>(opts.scenario.compare);
  const want = golden.sideEffects;
  const got = replay.sideEffects;
  const out: Difference[] = [];
  const root = `${SIDE_EFFECTS_STEP}.`;
  if (kinds.has('mail')) diffValues(want.mail ?? [], got.mail ?? [], `${root}mail`, SIDE_EFFECTS_STEP, out);
  if (kinds.has('rows')) {
    for (const [unit, rows] of Object.entries(compareRows(want.rows ?? {}, got.rows ?? {}))) {
      const path = `${root}rows.${unit}`;
      for (const row of rows.missing) out.push(difference(SIDE_EFFECTS_STEP, path, 'missing', row, undefined));
      for (const row of rows.extra) out.push(difference(SIDE_EFFECTS_STEP, path, 'extra', undefined, row));
    }
  }
  if (kinds.has('tasks')) diffValues(want.tasks ?? [], got.tasks ?? [], `${root}tasks`, SIDE_EFFECTS_STEP, out);
  if (kinds.has('files')) diffValues(want.files ?? [], got.files ?? [], `${root}files`, SIDE_EFFECTS_STEP, out);
  if (kinds.has('transitions')) {
    compareTransitions(
      want.transitions ?? stateTransitions(golden.steps, opts),
      got.transitions ?? stateTransitions(replay.steps, opts),
      out,
    );
  }
  return out;
}

/**
 * Differences between a golden and a replayed run. Steps pair by `(index, name, matrixKey)`; an unpaired step is one
 * `missing` or `extra` difference at path `''`. Status compares exactly where the step compares it; every other part
 * and side effect by deep equality. Known-issue masks classify last. Sorted by step index (side effects last), then
 * path.
 */
export function compareNormalised(golden: NormalisedRun, replay: NormalisedRun, opts: CompareOptions): Difference[] {
  const found: { index: number; difference: Difference }[] = [];
  const add = (index: number, differences: readonly Difference[]): void => {
    for (const diff of differences) found.push({ index, difference: diff });
  };
  const unpaired = new Map<string, NormalisedStep[]>();
  for (const step of replay.steps) unpaired.set(pairKey(step), [...(unpaired.get(pairKey(step)) ?? []), step]);
  for (const step of golden.steps) {
    const match = unpaired.get(pairKey(step))?.shift();
    if (match === undefined) add(step.index, [difference(step.name, '', 'missing', stepIdentity(step), undefined)]);
    else add(step.index, compareSteps(step, match, opts.scenario));
  }
  for (const rest of unpaired.values()) {
    for (const step of rest) add(step.index, [difference(step.name, '', 'extra', undefined, stepIdentity(step))]);
  }
  add(SIDE_EFFECTS_INDEX, compareSideEffects(golden, replay, opts));
  return found
    .sort((a, b) => a.index - b.index || codeUnitOrder(a.difference.path, b.difference.path))
    .map(({ difference: diff }) => diff);
}
