import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ROUTE_FAMILIES,
  esapiUrlEncode,
  matchRouteKey,
  normaliseRouteKey,
  routeKeyForRequest,
  type RouteFamily,
  type RouteKeyOptions,
  type RouteKeyRequest,
  type RouteKeyResult,
} from '@opt2/platform/legacy-compat';
import { z } from '@opt2/platform/service-kit';
import { CATALOGUE_PATH, isRehearsalScenario, loadCatalogue, type Scenario, type Step } from './catalogue.js';
import { GoldenConfigError, MissingSecretError } from './errors.js';
import { defaultRouteKeyOptions } from './route-key-options.js';
import {
  SEED_CONFIG_PATH,
  basicAuth,
  loadSecretStore,
  loadSeedStore,
  placeholderNames,
  type SeedStore,
} from './session.js';
import { catalogueSeedKeys, type SeedKeyStores } from './workload.js';
import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { repoPath, stateDir, type EnvLike } from '../lib/paths.js';
import { readJson, stableStringify } from '../lib/report.js';

export { VARIANTS_PATH, defaultRouteKeyOptions } from './route-key-options.js';

/** Neutral CF UUID standing in for path segments and id-like placeholder values. */
export const NEUTRAL_ID = '00000000-0000-0000-0000000000000000';

/** Cut-over version whose entries the gate checks by default. */
export const DEFAULT_VERSION_PATH: string = repoPath('gateway/cutover/versions/v0002.json');

/** Committed legacy inventory holding the admin controllers. */
export const INVENTORY_PATH: string = repoPath('opt2/inventory/legacy-inventory.json');

/** Finding kinds, in the order {@link checkCoverage} reports them. */
export const FINDING_KINDS = [
  'unknown-cover',
  'uncovered-target',
  'uncovered-legacy-write',
  'uncovered-admin-action',
  'cover-not-exercised',
  'reserved-identity',
  'unresolved-seed-ref',
] as const;
export type CoverageFindingKind = (typeof FINDING_KINDS)[number];

/** One coverage gap; any finding fails the gate. */
export type CoverageFinding =
  | { kind: 'unknown-cover'; scenario: string; cover: string }
  | { kind: 'uncovered-target'; route: string; owningService: string }
  | { kind: 'uncovered-legacy-write'; route: string }
  | { kind: 'uncovered-admin-action'; routeKey: string }
  | { kind: 'cover-not-exercised'; scenario: string; cover: string }
  | { kind: 'reserved-identity'; scenario: string; value: string }
  | { kind: 'unresolved-seed-ref'; scenario: string; message: string };

const cutoverEntrySchema = z.object({
  route: z.string().min(1),
  owningService: z.string(),
  state: z.enum(['legacy', 'target']),
  kind: z.enum(['read', 'write', 'legacy-write', 'job', 'static']),
});
/** The cut-over entry fields the gate reads. */
export type CutoverEntry = z.infer<typeof cutoverEntrySchema>;

const versionSchema = z.object({ tableVersion: z.string(), entries: z.array(cutoverEntrySchema) });

const inventoryItemSchema = z.object({
  routeKey: z.string().nullable().optional(),
  disposition: z.string().nullable().optional(),
});
const inventorySchema = z.object({
  controllers: z.array(
    z.object({ actions: z.array(inventoryItemSchema.extend({ variants: z.array(inventoryItemSchema).optional() })) }),
  ),
});

/** An inventoried admin action or action variant. */
export interface InventoryItem {
  routeKey?: string | null;
  disposition?: string | null;
}

/** An inventory controller: its actions, each with its variants. */
export interface InventoryController {
  actions: ReadonlyArray<InventoryItem & { variants?: readonly InventoryItem[] }>;
}

const seedConfigSchema = z.object({
  reserved: z.object({
    rehearsal: z.object({ persons: z.array(z.string().min(1)), usernames: z.array(z.string().min(1)) }),
  }),
});

/** Identities only the rollback-rehearsal scenarios may reference (`seed.config.json` `reserved.rehearsal`). */
export interface ReservedRehearsal {
  persons: readonly string[];
  usernames: readonly string[];
}

/** The scenario fields the gate reads. */
export type CoverageScenario = Pick<Scenario, 'id' | 'covers' | 'steps'> &
  Partial<Pick<Scenario, 'seedRefs' | 'browser' | 'sessions'>>;

/**
 * Everything {@link checkCoverage} checks; `options` default to {@link defaultRouteKeyOptions}. `seedStores` resolve
 * seedRefs and seeded role accounts; without them a scenario that has any reports `unresolved-seed-ref`.
 */
export interface CoverageInputs {
  scenarios: readonly CoverageScenario[];
  entries: readonly CutoverEntry[];
  controllers: readonly InventoryController[];
  reserved: ReservedRehearsal;
  options?: RouteKeyOptions;
  seedStores?: SeedKeyStores;
}

/** The request fields of a step or candidate. */
export type StepRequest = Pick<Step, 'method' | 'route'> &
  Partial<Pick<Step, 'auth' | 'headers' | 'form' | 'body' | 'multipart' | 'matrix'>>;

/** A step as the gate expands it: its own request plus any capture candidates. */
export type CoverageStep = StepRequest & Partial<Pick<Step, 'candidates'>>;

// ---- Step → route-key request ----

const DEFAULT_RELOAD_KEY = 'appreload';
const RELOAD_SECRET = 'secret:appreload';
const NEUTRAL_VALUE = 'x';
const ID_NAME = /id$/i;
const MATRIX_REF = /\$\{matrix\.([a-zA-Z][\w-]*)\}/g;
const CONTENT_TYPES = {
  multipart: 'multipart/form-data',
  form: 'application/x-www-form-urlencoded',
  body: 'application/json',
} as const;

/** Stand-in of placeholder `name`, its inner placeholders already filled. */
function neutral(name: string, idLike: boolean, reloadKey: string): string {
  if (name === RELOAD_SECRET) return reloadKey;
  if (name.startsWith('nodash:')) return name.slice('nodash:'.length).replaceAll('-', '');
  if (name.startsWith('urlencode:')) return esapiUrlEncode(name.slice('urlencode:'.length));
  return idLike || ID_NAME.test(name.split(/[.:]/).pop() ?? '') ? NEUTRAL_ID : NEUTRAL_VALUE;
}

/** `text` with every placeholder replaced by its stand-in, outer placeholders resolving their inner ones first. */
function fill(text: string, idLike: boolean, reloadKey: string): string {
  let out = text;
  for (const name of placeholderNames(text)) {
    const token = `\${${name}}`;
    if (out.includes(token)) out = out.replaceAll(token, neutral(fill(name, idLike, reloadKey), idLike, reloadKey));
  }
  return out;
}

// A field whose name ends in `id` carries an id, whatever its placeholder is named.
function fillFields<V extends string | string[]>(
  fields: Readonly<Record<string, V>>,
  reloadKey: string,
): Record<string, V> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      const name = fill(key, false, reloadKey);
      const idLike = ID_NAME.test(name);
      const filled = Array.isArray(value)
        ? value.map((v) => fill(v, idLike, reloadKey))
        : fill(value, idLike, reloadKey);
      return [name, filled as V];
    }),
  );
}

function fillJson(value: unknown, idLike: boolean, reloadKey: string): unknown {
  if (typeof value === 'string') return fill(value, idLike, reloadKey);
  if (Array.isArray(value)) return value.map((item) => fillJson(item, idLike, reloadKey));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const name = fill(key, false, reloadKey);
        return [name, fillJson(item, ID_NAME.test(name), reloadKey)];
      }),
    );
  }
  return value;
}

/** URL scope as the dispatcher builds it: a repeated name maps to its values in order. */
function queryOf(search: string): Record<string, string | string[]> {
  const query = new Map<string, string | string[]>();
  for (const [name, value] of new URLSearchParams(search)) {
    const previous = query.get(name);
    query.set(name, previous === undefined ? value : [previous, value].flat());
  }
  return Object.fromEntries(query);
}

/** Raw query `search` with each pair's placeholders filled, values by their parameter name, then parsed. */
function fillQuery(search: string, reloadKey: string): Record<string, string | string[]> {
  const pairs = search.split('&').map((pair) => {
    const at = pair.indexOf('=');
    const name = fill(at === -1 ? pair : pair.slice(0, at), false, reloadKey);
    return at === -1 ? name : `${name}=${fill(pair.slice(at + 1), ID_NAME.test(name), reloadKey)}`;
  });
  return queryOf(pairs.join('&'));
}

/** `Authorization` header a step's `basic:` or `bearer:` auth mode sends. */
function authorization(auth: string | undefined): Record<string, string> {
  if (auth?.startsWith('basic:')) {
    const [user = '', ...secret] = auth.slice('basic:'.length).split(':');
    return { Authorization: basicAuth(user, secret.join(':')) };
  }
  return auth?.startsWith('bearer:') ? { Authorization: `Bearer ${auth.slice('bearer:'.length)}` } : {};
}

function hasHeader(headers: Readonly<Record<string, string>> | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name);
}

/** Route-key input of one request shape whose matrix placeholders are already substituted. */
function keyRequest(shape: StepRequest, reloadKey: string): RouteKeyRequest {
  const at = shape.route.indexOf('?');
  const req: RouteKeyRequest = {
    method: shape.method,
    path: fill(at === -1 ? shape.route : shape.route.slice(0, at), true, reloadKey),
    query: fillQuery(at === -1 ? '' : shape.route.slice(at + 1), reloadKey),
    headers: authorization(shape.auth === undefined ? undefined : fill(shape.auth, false, reloadKey)),
  };
  if (shape.form !== undefined || shape.multipart !== undefined) {
    req.form = fillFields({ ...shape.form, ...shape.multipart?.fields }, reloadKey);
  }
  if (shape.multipart !== undefined) {
    req.multipartFileNames = shape.multipart.files.map(({ field, filename }) => ({
      field: fill(field, false, reloadKey),
      filename: fill(filename, false, reloadKey),
    }));
  }
  if (shape.body !== undefined) req.jsonBody = fillJson(shape.body, false, reloadKey);
  const kind = (['multipart', 'form', 'body'] as const).find((name) => shape[name] !== undefined);
  if (kind !== undefined && !hasHeader(shape.headers, 'content-type')) {
    req.headers['Content-Type'] = CONTENT_TYPES[kind];
  }
  Object.assign(req.headers, fillFields(shape.headers ?? {}, reloadKey));
  return req;
}

/** Copy of `value` with `fn` applied to every string, object keys included. */
function mapStrings<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => mapStrings(item, fn)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [fn(key), mapStrings(item, fn)])) as T;
  }
  return value;
}

/** Cartesian product of a step matrix, in declared key order; one empty combination without a matrix. */
function matrixCombinations(matrix: Step['matrix']): Record<string, string>[] {
  return Object.entries(matrix ?? {}).reduce<Record<string, string>[]>(
    (acc, [name, values]) => acc.flatMap((combo) => values.map((value) => ({ ...combo, [name]: value }))),
    [{}],
  );
}

function withMatrix<T extends StepRequest>(shape: T, combo: Readonly<Record<string, string>>): T {
  return mapStrings(shape, (text) => text.replace(MATRIX_REF, (whole, name: string) => combo[name] ?? whole));
}

/**
 * Route-key input of `step`'s request: its first matrix combination, then every other placeholder replaced by a
 * neutral value — the reload key for `${secret:appreload}`, {@link NEUTRAL_ID} in path segments and id-like values
 * (field or placeholder name ending in `id`), `x` elsewhere. Literal values are kept as written.
 */
export function toRouteKeyRequest(
  step: StepRequest,
  opts: Pick<RouteKeyOptions, 'appReloadKey'> = {},
): RouteKeyRequest {
  const [first = {}] = matrixCombinations(step.matrix);
  return keyRequest(withMatrix(step, first), opts.appReloadKey ?? DEFAULT_RELOAD_KEY);
}

/** Step-shaped request (`name: 'case'`) that {@link toRouteKeyRequest} maps back to `req`. */
export function fromRouteKeyRequest(req: RouteKeyRequest): Step {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(req.query)) {
    for (const item of [value].flat()) search.append(name, item);
  }
  const query = search.toString();
  const step: Step = {
    name: 'case',
    method: req.method.toUpperCase() as Step['method'],
    route: query === '' ? req.path : `${req.path}?${query}`,
    csrf: 'none',
  };
  const headers = Object.entries(req.headers).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, [value].flat().join(', ')] as const],
  );
  if (headers.length > 0) step.headers = Object.fromEntries(headers);
  if (req.form !== undefined) step.form = { ...req.form };
  if (req.jsonBody !== undefined) step.body = req.jsonBody as Step['body'];
  if (req.multipartFileNames !== undefined) {
    step.multipart = {
      fields: {},
      files: req.multipartFileNames.map(({ field, filename }) => ({
        field,
        fixture: 'case',
        filename,
        contentType: 'application/octet-stream',
      })),
    };
  }
  return step;
}

/** Route key of `step`'s request (its first matrix combination). */
export function coverageRouteKey(step: StepRequest, opts: RouteKeyOptions = defaultRouteKeyOptions()): string {
  return routeKeyForRequest(toRouteKeyRequest(step, opts), opts).key;
}

// Capture sends each candidate until legacy answers as expected, so candidates exercise their routes as the step does.
/** Route-key results of every request `step` sends: per matrix combination, the step and then each candidate. */
export function coverageRouteResults(
  step: CoverageStep,
  opts: RouteKeyOptions = defaultRouteKeyOptions(),
): RouteKeyResult[] {
  const reloadKey = opts.appReloadKey ?? DEFAULT_RELOAD_KEY;
  const shapes: StepRequest[] = [step, ...(step.candidates ?? []).map((c) => ({ ...c, auth: step.auth }))];
  return matrixCombinations(step.matrix).flatMap((combo) =>
    shapes.map((shape) => routeKeyForRequest(keyRequest(withMatrix(shape, combo), reloadKey), opts)),
  );
}

/** Keys of {@link coverageRouteResults}: one per matrix combination and candidate. */
export function coverageRouteKeys(step: CoverageStep, opts: RouteKeyOptions = defaultRouteKeyOptions()): string[] {
  return coverageRouteResults(step, opts).map((result) => result.key);
}

// ---- Checks ----

const FAMILIES: ReadonlySet<string> = new Set(ROUTE_FAMILIES);
const VARIANT_SUFFIX = /\{([^{}]*)\}$/;
/** Static entries the gateway or web serves itself, which no golden scenario can exercise. */
const SELF_SERVED_OWNERS: ReadonlySet<string> = new Set(['gateway', 'web']);
// The stub is the platform-proof service: it has no legacy oracle to capture, the catalogue admits only the ten
// services, and the platform-proof e2e suite proves its routes. Its target entries need no golden cover.
const PLATFORM_PROOF_OWNER = 'stub';

/** An authored route key read as `matchRouteKey` reads a computed one; `undefined` for an unknown family. */
function keyOf(text: string): RouteKeyResult | undefined {
  const key = normaliseRouteKey(text);
  const at = key.indexOf(':');
  const family = key.slice(0, at);
  if (at < 1 || !FAMILIES.has(family)) return undefined;
  const variant = VARIANT_SUFFIX.exec(key)?.[1];
  const result: RouteKeyResult = {
    key,
    baseKey: variant === undefined ? key : key.slice(0, key.length - variant.length - 2),
    family: family as RouteFamily,
    httpMethod: '',
    params: {},
  };
  if (variant !== undefined) result.variant = variant;
  return result;
}

/** Whether `result` is an error key (`<family>:!<type>`): a request legacy rejects before routing, never an entry. */
function isErrorKey(result: RouteKeyResult): boolean {
  return result.key.startsWith(`${result.family}:!`);
}

/** Canonical route keys of the inventoried admin actions and variants with disposition `carry`, in inventory order. */
export function carriedAdminActions(controllers: readonly InventoryController[]): string[] {
  const keys = new Set<string>();
  for (const controller of controllers) {
    for (const action of controller.actions) {
      for (const item of [action, ...(action.variants ?? [])]) {
        if (item.disposition === 'carry' && item.routeKey) keys.add(normaliseRouteKey(item.routeKey));
      }
    }
  }
  return [...keys];
}

/** Every string in `value`, object keys included. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsOf(item, out));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      stringsOf(item, out);
    }
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function notLoaded(what: string): never {
  throw new GoldenConfigError(`${what}: no seed dataset or credentials are loaded`);
}

/** Stores that resolve nothing, so a scenario with seedRefs or seeded role accounts reports them unresolved. */
const UNLOADED_STORES: SeedKeyStores = {
  seed: { select: (ref) => notLoaded(`seedRef ${ref.as}`), businessDate: () => notLoaded('${asOf}') },
  secrets: {
    secret: (name) => notLoaded(`\${secret:${name}}`),
    username: (site, role) => notLoaded(`\${user:${site}:${role}}`),
    values: () => [],
  },
  env: {},
};

/** How text refers to the reserved identities; each pattern carries the identity it reports. */
interface ReservedMatcher {
  /** Person ids, lower-cased with and without dashes. */
  persons: ReadonlyArray<{ value: string; forms: readonly string[] }>;
  /** Usernames as whole case-insensitive tokens, as legacy compares them. */
  tokens: ReadonlyArray<{ value: string; token: RegExp }>;
}

/** Username the dataset holds for reserved person `person`; none when the dataset lacks the person or is unreadable. */
function datasetUsername(person: string, seed: SeedStore): string[] {
  try {
    const row = seed.select({ as: 'reservedPerson', source: 'dataset', path: 'masa.users', where: { userID: person } });
    const username = typeof row === 'object' && row !== null ? (row as Record<string, unknown>).username : undefined;
    return typeof username === 'string' && username !== '' ? [username] : [];
  } catch (err) {
    if (err instanceof GoldenConfigError) return [];
    throw err;
  }
}

/** Matcher of `reserved`; a reserved person's dataset username reports as that person. */
function reservedMatcher(reserved: ReservedRehearsal, stores: SeedKeyStores): ReservedMatcher {
  const token = (value: string, username: string): { value: string; token: RegExp } => ({
    value,
    token: new RegExp(`(?<![\\w-])${escapeRegExp(username)}(?![\\w-])`, 'i'),
  });
  return {
    persons: reserved.persons.map((value) => ({
      value,
      forms: [value.toLowerCase(), value.replaceAll('-', '').toLowerCase()],
    })),
    tokens: [
      ...reserved.usernames.map((username) => token(username, username)),
      ...reserved.persons.flatMap((person) => datasetUsername(person, stores.seed).map((name) => token(person, name))),
    ],
  };
}

/** Reserved identities among `strings`, plus the `reserved.rehearsal` seedRefs of `scenario`. */
function reservedReferences(
  scenario: CoverageScenario,
  strings: readonly string[],
  matcher: ReservedMatcher,
): string[] {
  const lower = strings.map((s) => s.toLowerCase());
  const found = new Set<string>();
  // A reserved seedRef binds a rehearsal identity without spelling it out.
  for (const ref of scenario.seedRefs ?? []) {
    if (ref.source === 'reserved' && ref.path.startsWith('reserved.rehearsal')) found.add(ref.path);
  }
  for (const { value, forms } of matcher.persons) {
    if (lower.some((s) => forms.some((form) => s.includes(form)))) found.add(value);
  }
  for (const { value, token } of matcher.tokens) {
    if (strings.some((s) => token.test(s))) found.add(value);
  }
  return [...found];
}

/** Covers of `scenario` that no request of its steps keys to. */
function unexercisedCovers(scenario: CoverageScenario, opts: RouteKeyOptions): string[] {
  const results = scenario.steps.flatMap((step) => coverageRouteResults(step, opts));
  return scenario.covers.filter((cover) => !results.some((result) => matchRouteKey(result, [cover]) !== undefined));
}

/**
 * Every coverage gap, none short-circuiting: covers that match no cut-over entry (error keys aside); `target`
 * entries (bar the stub's and static entries the gateway or web serves itself), `legacy-write` entries and carried
 * admin actions no cover matches; covers no step of a non-browser scenario exercises; reserved rehearsal identities a
 * scenario outside `REHEARSAL_SCENARIO_IDS` names or selects through its seedRefs and seeded role accounts; and
 * such selections that do not resolve.
 */
export function checkCoverage(inputs: CoverageInputs): CoverageFinding[] {
  const opts = inputs.options ?? defaultRouteKeyOptions();
  const routes = inputs.entries.map((entry) => entry.route);
  const findings: CoverageFinding[] = [];
  const covers: string[] = [];
  const coveredRoutes = new Set<string>();
  for (const scenario of inputs.scenarios) {
    for (const cover of scenario.covers) {
      covers.push(cover);
      const result = keyOf(cover);
      const route = result === undefined ? undefined : matchRouteKey(result, routes);
      if (route !== undefined) coveredRoutes.add(route);
      // An error key routes to legacy by having no entry, so naming one is a known cover, not a stray key.
      else if (result === undefined || !isErrorKey(result)) {
        findings.push({ kind: 'unknown-cover', scenario: scenario.id, cover });
      }
    }
  }
  for (const entry of inputs.entries) {
    const selfServed = entry.kind === 'static' && SELF_SERVED_OWNERS.has(entry.owningService);
    const exempt = selfServed || entry.owningService === PLATFORM_PROOF_OWNER;
    if (entry.state === 'target' && !exempt && !coveredRoutes.has(entry.route)) {
      findings.push({ kind: 'uncovered-target', route: entry.route, owningService: entry.owningService });
    }
  }
  for (const entry of inputs.entries) {
    if (entry.kind === 'legacy-write' && !coveredRoutes.has(entry.route)) {
      findings.push({ kind: 'uncovered-legacy-write', route: entry.route });
    }
  }
  for (const routeKey of carriedAdminActions(inputs.controllers)) {
    const result = keyOf(routeKey);
    if (result === undefined || matchRouteKey(result, covers) === undefined) {
      findings.push({ kind: 'uncovered-admin-action', routeKey });
    }
  }
  for (const scenario of inputs.scenarios) {
    if (scenario.browser !== undefined) continue;
    for (const cover of unexercisedCovers(scenario, opts)) {
      findings.push({ kind: 'cover-not-exercised', scenario: scenario.id, cover });
    }
  }
  const stores = inputs.seedStores ?? UNLOADED_STORES;
  const matcher = reservedMatcher(inputs.reserved, stores);
  const unresolved: CoverageFinding[] = [];
  for (const scenario of inputs.scenarios) {
    if (isRehearsalScenario(scenario.id)) continue;
    const strings = stringsOf(scenario);
    const selecting = { ...scenario, sessions: scenario.sessions ?? {} };
    try {
      for (const key of catalogueSeedKeys([selecting], stores)) strings.push(key);
    } catch (err) {
      if (!(err instanceof GoldenConfigError || err instanceof MissingSecretError)) throw err;
      unresolved.push({ kind: 'unresolved-seed-ref', scenario: scenario.id, message: err.message });
    }
    for (const value of reservedReferences(scenario, strings, matcher)) {
      findings.push({ kind: 'reserved-identity', scenario: scenario.id, value });
    }
  }
  findings.push(...unresolved);
  return findings;
}

/** Finding count per kind, every kind present. */
export function countByKind(findings: readonly CoverageFinding[]): Record<CoverageFindingKind, number> {
  const counts = Object.fromEntries(FINDING_KINDS.map((kind) => [kind, 0])) as Record<CoverageFindingKind, number>;
  for (const finding of findings) counts[finding.kind] += 1;
  return counts;
}

// ---- Inputs and CLI ----

/** Input file locations; each defaults to the committed file. */
export interface CoveragePaths {
  version?: string;
  catalogue?: string;
  inventory?: string;
  seedConfig?: string;
}

/**
 * Reads and validates the catalogue, cut-over version, inventory controllers and reserved rehearsal identities; the
 * seed stores read `${OPT2_STATE_DIR}` seed dataset and credentials on first use.
 */
export async function loadCoverageInputs(
  paths: CoveragePaths = {},
  env: EnvLike = process.env,
): Promise<CoverageInputs> {
  const [catalogue, version, inventory, seed] = await Promise.all([
    loadCatalogue(paths.catalogue ?? CATALOGUE_PATH),
    readJson(paths.version ?? DEFAULT_VERSION_PATH, versionSchema),
    readJson(paths.inventory ?? INVENTORY_PATH, inventorySchema),
    readJson(paths.seedConfig ?? SEED_CONFIG_PATH, seedConfigSchema),
  ]);
  return {
    scenarios: catalogue.scenarios,
    entries: version.entries,
    controllers: inventory.controllers,
    reserved: seed.reserved.rehearsal,
    seedStores: { seed: loadSeedStore(env, { configPath: paths.seedConfig }), secrets: loadSecretStore(env), env },
  };
}

function describeFinding(finding: CoverageFinding): string {
  const { kind, ...fields } = finding;
  return `${kind} ${Object.values(fields).join(' ')}`;
}

const USAGE =
  'usage: tsx src/golden/coverage.ts [--version <cut-over version json>] [--catalogue <catalogue yaml>] ' +
  '[--seed-config <seed config json>]';
const HELP = `${USAGE}

Checks that golden-scenario covers reach every target and legacy-write entry of the cut-over version and every
carried admin action, that each cover is exercised by a step, and that no scenario but GS-PE-RH-01, GS-PE-RH-02 and
GS-PE-RH-03 names or selects a reserved rehearsal identity (--seed-config, default
legacy-fixtures/seed/seed.config.json). SeedRefs and seeded role accounts resolve against
\${OPT2_STATE_DIR}/seed/dataset.json and \${OPT2_STATE_DIR}/secrets/seed-credentials.json; one that does not resolve
is a finding. Writes \${OPT2_STATE_DIR}/golden/coverage.json; exits 1 on any finding.`;

/** CLI entry: writes `<state>/golden/coverage.json` and exits 1 when any finding exists. */
export async function main(argv: string[], env: EnvLike = process.env): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: { version: { type: 'string' }, catalogue: { type: 'string' }, 'seed-config': { type: 'string' } },
    usage: USAGE,
    help: HELP,
  });
  if (values.version === '') throw new UsageError('--version needs a path', USAGE);
  if (values.catalogue === '') throw new UsageError('--catalogue needs a path', USAGE);
  if (values['seed-config'] === '') throw new UsageError('--seed-config needs a path', USAGE);
  const report = path.join(stateDir(env), 'golden', 'coverage.json');
  const seedConfig = values['seed-config'];
  const inputs = await loadCoverageInputs(
    {
      version: values.version === undefined ? undefined : path.resolve(values.version),
      catalogue: values.catalogue === undefined ? undefined : path.resolve(values.catalogue),
      seedConfig: seedConfig === undefined ? undefined : path.resolve(seedConfig),
    },
    env,
  );
  const findings = checkCoverage(inputs);
  const byKind = countByKind(findings);
  const counts = {
    scenarios: inputs.scenarios.length,
    covers: inputs.scenarios.reduce((n, s) => n + s.covers.length, 0),
    targetEntries: inputs.entries.filter((e) => e.state === 'target').length,
    legacyWriteEntries: inputs.entries.filter((e) => e.kind === 'legacy-write').length,
    carriedAdminActions: carriedAdminActions(inputs.controllers).length,
    findings: byKind,
  };
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(report, stableStringify({ findings, counts }), 'utf8');
  for (const finding of findings) process.stderr.write(`${describeFinding(finding)}\n`);
  return { code: findings.length > 0 ? 1 : 0, summary: { findings: findings.length, byKind, report } };
}

if (isMainModule(import.meta.url)) void runCli(main);
