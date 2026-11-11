import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load, type CheerioAPI } from 'cheerio';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
  isLegacySessionCookie,
  parseCookieHeader,
} from '@opt2/platform/legacy-compat';
import type { Scenario, SeedRef, SessionLogin, SessionSpec } from './catalogue.js';
import { GoldenConfigError, MissingSecretError } from './errors.js';
import { createHttpSession, type FetchLike, type HttpResult, type HttpSession } from '../lib/http.js';
import { repoPath, secretsDir, stateDir, type EnvLike } from '../lib/paths.js';

/** Where a scenario's requests go: legacy directly (capture) or the gateway (replay). */
export type Origin = 'legacy' | 'gateway';

/** Gateway port fixed in `harness/repro/ports.env`. */
export const GATEWAY_PORT = 8100;

/** Session a scenario that declares none runs in. */
export const DEFAULT_SESSION = 'default';

/** Site of the installed `admin` and `qa_editor` accounts. */
export const DEFAULT_SITE = 'default';

/** Credential file written by `legacy-fixtures/seed` under `${OPT2_STATE_DIR}/secrets/`. */
export const SEED_CREDENTIALS_FILE = 'seed-credentials.json';

/** Generated golden passwords under `${OPT2_STATE_DIR}/secrets/`, shared by capture and replay of one run. */
export const GENERATED_SECRETS_FILE = 'golden-generated.json';

/** Committed seed configuration holding `reserved.rehearsal`. */
export const SEED_CONFIG_PATH: string = repoPath('legacy-fixtures', 'seed', 'seed.config.json');

/** Admin login page. */
export const ADMIN_LOGIN_PATH = '/admin/?muraAction=clogin.main';

/** CSRF context every legacy login form and the JSON API `login` method validate. */
export const LOGIN_CSRF_CONTEXT = 'login';

/** Placeholder read from the dataset's `businessDate` unless a binding of the same name exists. */
const AS_OF = 'asOf';

const ENV_SECRETS: Readonly<Record<string, string>> = {
  admin: 'MURA_ADMIN_PASSWORD',
  qa_editor: 'MASA_TEST_EDITOR_PASSWORD',
};
const SECRET_FORMS = 'admin, qa_editor, seed:<username>, oauth:<clientId> or generated:<name>';
const GENERATED_BYTES = 18;
// Guarantees a digit, a lower-case and an upper-case letter, as seeded passwords do.
const GENERATED_SUFFIX = 'a1A';
const PUBLIC_LOGIN_FORM = 'form:has(input[name="password"])';
const FAILED_STATUS = /[?&]status=failed(?:&|$)/i;

/** One scenario run: origin, named sessions (one cookie jar each), step bindings, secrets and seed rows. */
export interface ScenarioContext {
  readonly origin: Origin;
  readonly baseUrl: string;
  readonly scenarioId: string;
  readonly sessions: Map<string, HttpSession>;
  /** Step bindings keyed `<step>.<binding>`; keys `matrix.<var>` and `asOf` serve those placeholders. */
  readonly bindings: Map<string, unknown>;
  /** Row (or reserved scalar) each seedRef selected, keyed by its `as`; kept apart so `bindings` starts empty. */
  readonly seedRows: Map<string, unknown>;
  readonly secrets: SecretStore;
  readonly seed: SeedStore;
  readonly env: EnvLike;
}

/** Scenario fields a context is built from. */
export type ScenarioInput = Pick<Scenario, 'id'> & Partial<Pick<Scenario, 'sessions' | 'seedRefs'>>;

/** Options for {@link createScenarioContext}. */
export interface ScenarioContextOptions {
  origin: Origin;
  env?: EnvLike;
  fetch?: FetchLike;
  /** Stores to use instead of fresh ones, e.g. one seed store for a whole run. */
  secrets?: SecretStore;
  seed?: SeedStore;
}

/** Secret and seeded-username lookups; values come from the environment and `${OPT2_STATE_DIR}/secrets`. */
export interface SecretStore {
  /** Value of `${secret:<name>}`; throws MissingSecretError when its source holds no unique value. */
  secret(name: string): string;
  /** Username of `${user:<site>:<role>}`; throws GoldenConfigError when the credential file has none. */
  username(site: string, role: string): string;
  /** Every secret value returned so far. */
  values(): string[];
}

/** Seed dataset and reserved-identity lookups. */
export interface SeedStore {
  /** Row (or reserved scalar) `ref` selects, its `where` values already resolved; throws GoldenConfigError. */
  select(ref: SeedRef): unknown;
  /** The dataset's `businessDate`, the `asOf` of every scenario. */
  businessDate(): string;
}

/** Options for {@link loadSeedStore}. */
export interface SeedStoreOptions {
  /** Default `${OPT2_STATE_DIR}/seed/dataset.json`. */
  datasetPath?: string;
  /** Default {@link SEED_CONFIG_PATH}. */
  configPath?: string;
}

/** A login exchange: the final response and whether legacy accepted the credentials. */
export interface LoginResult {
  result: HttpResult;
  ok: boolean;
}

/** Credentials of one legacy login. */
export interface LoginCredentials {
  username: string;
  password: string;
}

/** CSRF pair, remaining hidden fields and submission target of one HTML form. */
export interface FormTokens {
  token: string;
  expires: string;
  /** Named hidden fields other than the CSRF pair, first occurrence of each name. */
  fields: Record<string, string>;
  /** Submission URL, origin-relative when it is on the session's origin. */
  action: string;
  /** Upper-cased form method. */
  method: string;
}

interface Found {
  present: boolean;
  value?: unknown;
}

const ABSENT: Found = { present: false };

function envValue(env: EnvLike, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Base URL of `origin`. Legacy is `LEGACY_ORIGIN` when set, else `http://127.0.0.1:${PORT}` (ColdFusion's port);
 * the gateway is `OPT2_GATEWAY_URL` when set, else loopback port {@link GATEWAY_PORT}.
 */
export function originBaseUrl(origin: Origin, env: EnvLike = process.env): string {
  if (origin === 'gateway') return trimSlash(envValue(env, 'OPT2_GATEWAY_URL') ?? `http://127.0.0.1:${GATEWAY_PORT}`);
  // Masa redirects 127.0.0.1 to its configured host on some instances, and a cross-origin hop cannot resend a
  // POST body, so the legacy origin is overridable through the same LEGACY_ORIGIN the gateway reads.
  const override = envValue(env, 'LEGACY_ORIGIN');
  if (override !== undefined) return trimSlash(override);
  const port = envValue(env, 'PORT');
  if (port === undefined) throw new GoldenConfigError('PORT, the legacy ColdFusion port, is not set');
  return `http://127.0.0.1:${port}`;
}

/** Rethrows a GoldenConfigError from `fn` with the scenario id in front of its message. */
function inScenario<T>(ctx: Pick<ScenarioContext, 'scenarioId'>, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof GoldenConfigError) {
      throw new GoldenConfigError(`${ctx.scenarioId}: ${err.message}`, { path: err.path, cause: err });
    }
    throw err;
  }
}

/**
 * Context with one fresh, logged-out session per declared name (`default` when none is declared) and every
 * seedRef resolved in declaration order, so a later ref's `where` may read an earlier one. Logins are separate:
 * {@link loginSessions}.
 */
export function createScenarioContext(scenario: ScenarioInput, opts: ScenarioContextOptions): ScenarioContext {
  const env = opts.env ?? process.env;
  const baseUrl = originBaseUrl(opts.origin, env);
  const declared = Object.keys(scenario.sessions ?? {});
  const names = declared.length > 0 ? declared : [DEFAULT_SESSION];
  const ctx: ScenarioContext = {
    origin: opts.origin,
    baseUrl,
    scenarioId: scenario.id,
    sessions: new Map(names.map((name) => [name, createHttpSession({ baseUrl, fetch: opts.fetch })])),
    bindings: new Map(),
    seedRows: new Map(),
    secrets: opts.secrets ?? loadSecretStore(env),
    seed: opts.seed ?? loadSeedStore(env),
    env,
  };
  for (const ref of scenario.seedRefs ?? []) {
    const where = ref.where === undefined ? undefined : resolvePlaceholders(ref.where, ctx);
    ctx.seedRows.set(ref.as, inScenario(ctx, () => ctx.seed.select({ ...ref, where })));
  }
  return ctx;
}

/** Session `name`; unnamed, the scenario's only session, else `default`. Throws GoldenConfigError when absent. */
export function session(ctx: ScenarioContext, name?: string): HttpSession {
  const key = name ?? (ctx.sessions.size === 1 ? [...ctx.sessions.keys()][0] : DEFAULT_SESSION);
  const found = key === undefined ? undefined : ctx.sessions.get(key);
  if (found === undefined) {
    throw new GoldenConfigError(
      `${ctx.scenarioId}: no session ${key ?? DEFAULT_SESSION}; declared: ${[...ctx.sessions.keys()].join(', ')}`,
    );
  }
  return found;
}

/**
 * Parsed JSON of `file`, or undefined when it does not exist. For a secret file the parse error is withheld,
 * because its message quotes the file's text.
 */
function readJsonFile(file: string, what: string, secret: boolean): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    const message = `${what} ${file} cannot be read: ${(err as Error).message}`;
    throw new GoldenConfigError(message, { path: file, cause: err });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    if (secret) throw new GoldenConfigError(`${what} ${file} is not valid JSON`, { path: file });
    const message = `${what} ${file} is not valid JSON: ${(err as Error).message}`;
    throw new GoldenConfigError(message, { path: file, cause: err });
  }
}

/** JSON object of `file`, undefined when it does not exist; throws GoldenConfigError for any other JSON value. */
function readJsonObject(file: string, what: string, secret: boolean): Record<string, unknown> | undefined {
  const json = readJsonFile(file, what, secret);
  if (json === undefined) return undefined;
  const record = asRecord(json);
  if (record === undefined) throw new GoldenConfigError(`${what} ${file} is not a JSON object`, { path: file });
  return record;
}

/** Writes `body` to `file` owner-only (file 0600, directory 0700). */
function writeSecretFile(file: string, body: Record<string, unknown>): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // `mode` applies only when the file is created, so an existing file is tightened explicitly.
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Secret store over `env` and `seed-credentials.json`, read once on first use. `seed:<username>` needs one
 * distinct password across sites; `generated:<name>` falls back to {@link GENERATED_SECRETS_FILE}, created on
 * first use so capture and replay of one run post the same value.
 */
export function loadSecretStore(env: EnvLike = process.env): SecretStore {
  let credentials: Record<string, unknown> | null | undefined;
  const returned = new Set<string>();
  const credentialsFile = (): string => join(secretsDir(env), SEED_CREDENTIALS_FILE);
  const section = (name: string): Record<string, unknown> | undefined => {
    if (credentials === undefined) credentials = readJsonObject(credentialsFile(), 'seed credentials', true) ?? null;
    return credentials === null ? undefined : asRecord(credentials[name]);
  };

  const fromEnv = (variable: string, placeholder: string): string => {
    const value = envValue(env, variable);
    if (value === undefined) throw new MissingSecretError(placeholder, variable);
    return value;
  };

  const seedPassword = (username: string, placeholder: string): string => {
    const distinct = new Set<string>();
    for (const site of Object.values(section('users') ?? {})) {
      const password = ownString(asRecord(site), username);
      if (password !== undefined) distinct.add(password);
    }
    const [only] = distinct;
    if (distinct.size !== 1 || only === undefined) throw new MissingSecretError(placeholder, credentialsFile());
    return only;
  };

  const oauthSecret = (clientId: string, placeholder: string): string => {
    const value = ownString(section('oauthClients'), clientId);
    if (value === undefined) throw new MissingSecretError(placeholder, credentialsFile());
    return value;
  };

  const generated = (name: string): string => {
    const preset = ownString(section('generated'), name);
    if (preset !== undefined) return preset;
    const file = join(secretsDir(env), GENERATED_SECRETS_FILE);
    const existing = readJsonObject(file, 'generated golden secrets', true) ?? {};
    const known = ownString(existing, name);
    if (known !== undefined) return known;
    const value = `${randomBytes(GENERATED_BYTES).toString('base64url')}${GENERATED_SUFFIX}`;
    writeSecretFile(file, { ...existing, [name]: value });
    return value;
  };

  const lookup = (name: string): string => {
    const placeholder = `\${secret:${name}}`;
    if (Object.hasOwn(ENV_SECRETS, name)) return fromEnv(ENV_SECRETS[name] as string, placeholder);
    const colon = name.indexOf(':');
    const key = colon < 0 ? '' : name.slice(colon + 1);
    if (key !== '') {
      switch (name.slice(0, colon)) {
        case 'seed':
          return seedPassword(key, placeholder);
        case 'oauth':
          return oauthSecret(key, placeholder);
        case 'generated':
          return generated(key);
        default:
          break;
      }
    }
    throw new GoldenConfigError(`unknown secret placeholder ${placeholder}; expected secret:${SECRET_FORMS}`);
  };

  return {
    secret(name) {
      const value = lookup(name);
      returned.add(value);
      return value;
    },
    username(site, role) {
      const roles = section('roles');
      const siteRoles = roles !== undefined && Object.hasOwn(roles, site) ? asRecord(roles[site]) : undefined;
      const value = ownString(siteRoles, role);
      if (value === undefined) {
        const file = credentialsFile();
        throw new GoldenConfigError(`\${user:${site}:${role}} has no username in ${file}`, { path: file });
      }
      return value;
    },
    values: () => [...returned],
  };
}

/** Array element or own property `key` of `value`; properties match exactly, then case-insensitively. */
function fieldOf(value: unknown, key: string): Found {
  if (Array.isArray(value)) {
    if (!/^\d+$/.test(key)) return ABSENT;
    const index = Number(key);
    return index < value.length ? { present: true, value: value[index] } : ABSENT;
  }
  const record = asRecord(value);
  if (record === undefined) return ABSENT;
  if (Object.hasOwn(record, key)) return { present: true, value: record[key] };
  // Masa column names vary in case between the dataset, the catalogue and SQL Server.
  const lower = key.toLowerCase();
  const match = Object.keys(record).find((candidate) => candidate.toLowerCase() === lower);
  return match === undefined ? ABSENT : { present: true, value: record[match] };
}

/** Value at `segments` below `value`. */
function walk(value: unknown, segments: readonly string[]): Found {
  let found: Found = { present: true, value };
  for (const segment of segments) {
    found = fieldOf(found.value, segment);
    if (!found.present) return ABSENT;
  }
  return found;
}

/** Dotted placeholder path as segments; `a.b[0].c` reads like `a.b.0.c`. */
function pathSegments(path: string): string[] {
  return path.replace(/\[(\d+)\]/g, '.$1').split('.');
}

/** Value at dotted `segments`, where a key may itself hold dots (fixture tables are keyed `<schema>.<table>`). */
function atDottedPath(value: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return value;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (let n = segments.length; n > 0; n -= 1) {
    const key = segments.slice(0, n).join('.');
    if (Object.hasOwn(record, key)) {
      const found = atDottedPath(record[key], segments.slice(n));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Whether `a` and `b` are equal, scalars compared by their string form (`0` matches `'0'`). */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || (isScalar(a) && isScalar(b) && String(a) === String(b));
}

function rowMatches(row: unknown, where: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(where).every(([field, wanted]) => {
    const found = fieldOf(row, field);
    return found.present && sameValue(found.value, wanted);
  });
}

/**
 * Seed store reading `dataset.json` (`source: dataset`) and the seed configuration (`source: reserved`) once each,
 * on first use. A list selects the `index`th row (default 0, negative from the end) of those matching `where`.
 */
export function loadSeedStore(env: EnvLike = process.env, opts: SeedStoreOptions = {}): SeedStore {
  const documents = new Map<string, Record<string, unknown>>();
  const document = (source: SeedRef['source']): { file: string; root: Record<string, unknown> } => {
    const reserved = source === 'reserved';
    const file = reserved
      ? (opts.configPath ?? SEED_CONFIG_PATH)
      : (opts.datasetPath ?? join(stateDir(env), 'seed', 'dataset.json'));
    let root = documents.get(file);
    if (root === undefined) {
      const what = reserved ? 'seed config' : 'seed dataset';
      root = readJsonObject(file, what, false);
      if (root === undefined) throw new GoldenConfigError(`${what} ${file} does not exist`, { path: file });
      documents.set(file, root);
    }
    return { file, root };
  };

  return {
    select(ref) {
      const { file, root } = document(ref.source);
      const value = atDottedPath(root, ref.path.split('.'));
      if (value === undefined) {
        throw new GoldenConfigError(`seedRef ${ref.as}: ${ref.path} is not in ${file}`, { path: file });
      }
      if (!Array.isArray(value)) {
        if (ref.where === undefined && ref.index === undefined) return value;
        throw new GoldenConfigError(`seedRef ${ref.as}: ${ref.path} is not a list, so where and index do not apply`, {
          path: file,
        });
      }
      const { where } = ref;
      const rows = where === undefined ? value : value.filter((row) => rowMatches(row, where));
      const index = ref.index ?? 0;
      const row: unknown = rows.at(index);
      if (row === undefined) {
        throw new GoldenConfigError(
          `seedRef ${ref.as}: no row at index ${index} among the ${rows.length} rows of ${ref.path} matching ` +
            JSON.stringify(where ?? {}),
          { path: file },
        );
      }
      return row;
    },
    businessDate() {
      const { file, root } = document('dataset');
      const date = ownString(root, 'businessDate');
      if (date === undefined) throw new GoldenConfigError(`seed dataset ${file} has no businessDate`, { path: file });
      return date;
    },
  };
}


/** Literal text, or a placeholder whose name may itself hold placeholders. */
type TemplatePart = string | { readonly parts: readonly TemplatePart[] };

interface Parsed {
  parts: TemplatePart[];
  end: number;
}

type ParseMemo = Map<number, Parsed | undefined>;

/**
 * Parts of `text` from `start`; inside a placeholder, up to its closing `}`. An unclosed `${` is literal text:
 * inside a placeholder it makes the enclosing one unclosed as well, since both would need the same `}`.
 * `memo` holds each placeholder body's parse by start, so every position is parsed once.
 */
function parseFrom(text: string, start: number, inside: boolean, memo: ParseMemo): Parsed | undefined {
  if (inside && memo.has(start)) return memo.get(start);
  const parsed = parseUncached(text, start, inside, memo);
  if (inside) memo.set(start, parsed);
  return parsed;
}

function parseUncached(text: string, start: number, inside: boolean, memo: ParseMemo): Parsed | undefined {
  const parts: TemplatePart[] = [];
  let literal = '';
  let i = start;
  const flush = (): void => {
    if (literal !== '') parts.push(literal);
    literal = '';
  };
  while (i < text.length) {
    if (text.startsWith('${', i)) {
      const inner = parseFrom(text, i + 2, true, memo);
      if (inner !== undefined) {
        flush();
        parts.push({ parts: inner.parts });
        i = inner.end;
        continue;
      }
      if (inside) return undefined;
      literal += '${';
      i += 2;
      continue;
    }
    if (inside && text[i] === '}') {
      flush();
      return { parts, end: i + 1 };
    }
    literal += text[i];
    i += 1;
  }
  if (inside) return undefined;
  flush();
  return { parts, end: i };
}

function parseTemplate(text: string): readonly TemplatePart[] {
  return text.includes('${') ? (parseFrom(text, 0, false, new Map())?.parts ?? [text]) : [text];
}

/** Placeholder text as written, nested placeholders unresolved. */
function sourceOf(parts: readonly TemplatePart[]): string {
  return parts.map((part) => (typeof part === 'string' ? part : `\${${sourceOf(part.parts)}}`)).join('');
}

/** Embedded form of a resolved value: strings as they are, null as empty, objects as JSON. */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Value at dotted `segments` of the longest bound key they start with. */
function boundValue(bindings: ReadonlyMap<string, unknown>, segments: readonly string[]): Found {
  for (let n = segments.length; n > 0; n -= 1) {
    const key = segments.slice(0, n).join('.');
    if (bindings.has(key)) return walk(bindings.get(key), segments.slice(n));
  }
  return ABSENT;
}

/** Value of placeholder `name`, its nested placeholders already resolved. */
function lookup(name: string, ctx: ScenarioContext): unknown {
  if (name.startsWith('secret:')) return inScenario(ctx, () => ctx.secrets.secret(name.slice('secret:'.length)));
  const user = /^user:([^:]+):(.+)$/s.exec(name);
  if (user !== null) return inScenario(ctx, () => ctx.secrets.username(user[1] as string, user[2] as string));
  if (!name.startsWith('user:')) {
    const segments = pathSegments(name);
    const [head, as, ...field] = segments;
    if (head === 'seed' && as !== undefined) {
      const found = ctx.seedRows.has(as) ? walk(ctx.seedRows.get(as), field) : ABSENT;
      if (found.present) return found.value;
    } else {
      const found = boundValue(ctx.bindings, segments);
      if (found.present) return found.value;
      if (name === AS_OF) return inScenario(ctx, () => ctx.seed.businessDate());
    }
  }
  throw new GoldenConfigError(`${ctx.scenarioId}: unresolved placeholder \${${name}}`);
}

function render(parts: readonly TemplatePart[], ctx: ScenarioContext): string {
  return parts
    .map((part) => (typeof part === 'string' ? part : stringify(lookup(render(part.parts, ctx), ctx))))
    .join('');
}

function resolveString(text: string, ctx: ScenarioContext): unknown {
  const parts = parseTemplate(text);
  const [only] = parts;
  if (parts.length === 1 && only !== undefined && typeof only !== 'string') return lookup(render(only.parts, ctx), ctx);
  return render(parts, ctx);
}

function resolveValue(value: unknown, ctx: ScenarioContext): unknown {
  if (typeof value === 'string') return resolveString(value, ctx);
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, ctx));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, ctx)]));
  }
  return value;
}

/**
 * Copy of `value` with every `${…}` in its strings resolved, inner first: `secret:*`, `user:<site>:<role>`,
 * `seed.<as>[.<field>]`, bindings (`<step>.<binding>[.<path>]`, `matrix.<var>`), then `asOf`. A string that is
 * exactly one placeholder keeps the value's type. Throws GoldenConfigError or MissingSecretError when unresolved.
 */
export function resolvePlaceholders<T>(value: T, ctx: ScenarioContext): T {
  return resolveValue(value, ctx) as T;
}

/** Distinct placeholder names in `value`'s strings, as written, outer before inner, in order of appearance. */
export function placeholderNames(value: unknown): string[] {
  const names = new Set<string>();
  const visitParts = (parts: readonly TemplatePart[]): void => {
    for (const part of parts) {
      if (typeof part === 'string') continue;
      names.add(sourceOf(part.parts));
      visitParts(part.parts);
    }
  };
  const visit = (item: unknown): void => {
    if (typeof item === 'string') visitParts(parseTemplate(item));
    else if (Array.isArray(item)) item.forEach(visit);
    else if (isPlainObject(item)) Object.values(item).forEach(visit);
  };
  visit(value);
  return [...names];
}

/** Every secret value `ctx` resolved so far, for redaction before anything is written. */
export function secretValues(ctx: ScenarioContext): string[] {
  return ctx.secrets.values();
}

/** Path of `url`, for messages: queries can carry tokens. */
function pathOf(url: string): string {
  return new URL(url).pathname;
}

/** Named hidden inputs of `form`, first occurrence of each name, minus `skip`. */
function hiddenFields($: CheerioAPI, form: ReturnType<CheerioAPI>, skip: ReadonlySet<string>): Record<string, string> {
  const entries: [string, string][] = [];
  const seen = new Set<string>(skip);
  form.find('input[type="hidden" i][name]').each((_, el) => {
    const input = $(el);
    const name = input.attr('name') ?? '';
    if (name === '' || seen.has(name)) return;
    seen.add(name);
    entries.push([name, input.attr('value') ?? '']);
  });
  return Object.fromEntries(entries);
}

/** Submission URL of `form` on page `pageUrl`: origin-relative on the session's origin, else absolute. */
function formAction(s: HttpSession, form: ReturnType<CheerioAPI>, pageUrl: string): string {
  const raw = form.attr('action');
  // An absent or empty action submits to the page itself.
  const target = new URL(raw === undefined || raw.trim() === '' ? pageUrl : raw, pageUrl);
  return target.origin === new URL(s.baseUrl).origin ? `${target.pathname}${target.search}` : target.href;
}

/** Whether the jar sends a legacy session cookie (CFID, CFTOKEN, JSESSIONID) to `url`. */
async function holdsSessionCookie(s: HttpSession, url: string): Promise<boolean> {
  return [...parseCookieHeader(await s.cookieHeader(url)).keys()].some(isLegacySessionCookie);
}

/** JSON object body of `result`; throws GoldenConfigError naming `what`, never quoting the body. */
function jsonBody(result: HttpResult, what: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(result.text);
  } catch {
    body = undefined;
  }
  const record = asRecord(body);
  if (record === undefined) {
    throw new GoldenConfigError(`${what} answered ${result.status} at ${pathOf(result.url)} without a JSON object`);
  }
  return record;
}

/** Envelope field `key`: under `data`, else top level (sites without `useDataNamespace`, OAuth 2 tokens). */
function envelopeString(body: Record<string, unknown>, key: string): string | undefined {
  return ownString(asRecord(body.data), key) ?? ownString(body, key);
}

/**
 * Admin login as a browser does it: GET {@link ADMIN_LOGIN_PATH}, then POST `form#loginForm` with the credentials
 * and its hidden fields (CSRF pair included), following redirects; cookies stay as legacy sets them. `ok` when the
 * final URL has left `clogin` and the jar holds a legacy session cookie.
 */
export async function adminLogin(s: HttpSession, credentials: LoginCredentials): Promise<LoginResult> {
  const page = await s.get(ADMIN_LOGIN_PATH);
  const $ = load(page.text);
  const form = $('form#loginForm')
    .filter((_, el) => $(el).find('input[name="username"]').length > 0)
    .first();
  if (form.length === 0) {
    throw new GoldenConfigError(`no admin login form at ${pathOf(page.url)} (status ${page.status})`);
  }
  const fields = { username: credentials.username, password: credentials.password };
  const hidden = hiddenFields($, form, new Set(Object.keys(fields)));
  const result = await s.post(formAction(s, form, page.url), { form: { ...fields, ...hidden } });
  const final = new URL(result.url);
  const ok = !/clogin/i.test(`${final.pathname}${final.search}`) && (await holdsSessionCookie(s, result.url));
  return { result, ok };
}

/**
 * CSRF pair, other hidden fields, action and method of the first `selector` match on page `url` that holds a
 * `csrf_token` field. Throws GoldenConfigError when the page has none.
 */
export async function fetchFormTokens(s: HttpSession, url: string, selector = 'form'): Promise<FormTokens> {
  const page = await s.get(url);
  const $ = load(page.text);
  const tokenInput = `input[name="${CSRF_FIELD_TOKEN}"]`;
  const form = $(selector)
    .filter((_, el) => $(el).find(tokenInput).length > 0)
    .first();
  if (form.length === 0) {
    throw new GoldenConfigError(
      `no ${selector} with a ${CSRF_FIELD_TOKEN} field at ${pathOf(page.url)} (status ${page.status})`,
    );
  }
  return {
    token: form.find(tokenInput).first().attr('value') ?? '',
    expires: form.find(`input[name="${CSRF_FIELD_EXPIRES}"]`).first().attr('value') ?? '',
    fields: hiddenFields($, form, new Set([CSRF_FIELD_TOKEN, CSRF_FIELD_EXPIRES])),
    action: formAction(s, form, page.url),
    method: (form.attr('method') ?? 'get').toUpperCase(),
  };
}

/**
 * JSON API CSRF headers for `context` from `generateCSRFTokens` in this session, the form legacy copies into its
 * `csrf_token` / `csrf_token_expires` params. Throws GoldenConfigError when the response holds no tokens.
 */
export async function jsonApiTokens(s: HttpSession, site: string, context: string): Promise<Record<string, string>> {
  const result = await s.get(`/_api/json/v1/${encodeURIComponent(site)}/generateCSRFTokens`, { query: { context } });
  const body = jsonBody(result, `generateCSRFTokens for ${site}`);
  const token = envelopeString(body, CSRF_FIELD_TOKEN);
  const expires = envelopeString(body, CSRF_FIELD_EXPIRES);
  if (token === undefined || expires === undefined) {
    throw new GoldenConfigError(`generateCSRFTokens for ${site} answered ${result.status} without CSRF tokens`);
  }
  return { [CSRF_HEADER_TOKEN]: token, [CSRF_HEADER_EXPIRES]: expires };
}

/** `Authorization` value for HTTP Basic credentials. */
export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

/**
 * OAuth 2 `client_credentials` token from `/_api/rest/v1/<site>/oauth2`; the secret travels in the form body.
 * Throws GoldenConfigError when legacy issues no `access_token`.
 */
export async function oauthClientCredentials(
  s: HttpSession,
  a: { site: string; clientId: string; secret: string },
): Promise<{ accessToken: string; result: HttpResult }> {
  const result = await s.post(`/_api/rest/v1/${encodeURIComponent(a.site)}/oauth2`, {
    form: { grant_type: 'client_credentials', client_id: a.clientId, client_secret: a.secret },
  });
  const accessToken = envelopeString(jsonBody(result, `OAuth token request for ${a.clientId}`), 'access_token');
  if (accessToken === undefined) {
    throw new GoldenConfigError(`OAuth token request for ${a.clientId} answered ${result.status} without access_token`);
  }
  return { accessToken, result };
}

/** JSON API `login` method on `site` with `login`-context CSRF headers; `ok` when it answers status `success`. */
export async function jsonApiLogin(
  s: HttpSession,
  a: LoginCredentials & { site: string },
): Promise<LoginResult> {
  const headers = await jsonApiTokens(s, a.site, LOGIN_CSRF_CONTEXT);
  const result = await s.post(`/_api/json/v1/${encodeURIComponent(a.site)}/login`, {
    headers,
    form: { username: a.username, password: a.password },
  });
  return { result, ok: envelopeString(jsonBody(result, `JSON API login on ${a.site}`), 'status') === 'success' };
}

/**
 * Front-end `doaction=login` through the login form of `/<site>/?display=login`. `ok` when legacy redirected
 * without `status=failed`: it redirects on success and on rejected credentials, and renders in place otherwise.
 */
export async function publicLogin(s: HttpSession, a: LoginCredentials & { site: string }): Promise<LoginResult> {
  const form = await fetchFormTokens(s, `/${encodeURIComponent(a.site)}/?display=login`, PUBLIC_LOGIN_FORM);
  const result = await s.post(form.action, {
    form: {
      ...form.fields,
      username: a.username,
      password: a.password,
      [CSRF_FIELD_TOKEN]: form.token,
      [CSRF_FIELD_EXPIRES]: form.expires,
    },
  });
  return { result, ok: result.hops.length > 1 && !FAILED_STATUS.test(new URL(result.url).search) };
}

/** Site, username and password a session `login` names; seeded accounts log in on the site that stores them. */
function loginAccount(
  ctx: ScenarioContext,
  login: Exclude<SessionLogin, 'none'>,
): LoginCredentials & { site: string } {
  return inScenario(ctx, () => {
    if (login === 'admin') {
      const username = envValue(ctx.env, 'MURA_ADMIN_USERNAME') ?? 'admin';
      return { site: DEFAULT_SITE, username, password: ctx.secrets.secret('admin') };
    }
    if (login === 'qa_editor') {
      return { site: DEFAULT_SITE, username: 'qa_editor', password: ctx.secrets.secret('qa_editor') };
    }
    const seeded = /^seed:([^:]+):(.+)$/.exec(login);
    if (seeded === null) throw new GoldenConfigError(`unknown session login ${login}`);
    const site = seeded[1] as string;
    const username = ctx.secrets.username(site, seeded[2] as string);
    return { site, username, password: ctx.secrets.secret(`seed:${username}`) };
  });
}

/**
 * Logs session `name` in as `spec` declares: `admin` through {@link adminLogin}, `jsonapi` through
 * {@link jsonApiLogin}, `public` through {@link publicLogin}. `login: none`, `rest-basic` and `client-credentials`
 * sessions send nothing: their steps carry their own credentials. Throws GoldenConfigError when legacy refuses.
 */
export async function loginSession(ctx: ScenarioContext, name: string, spec: SessionSpec): Promise<void> {
  const { login, via } = spec;
  if (login === 'none' || via === 'rest-basic' || via === 'client-credentials') return;
  const s = session(ctx, name);
  const account = loginAccount(ctx, login);
  const attempt =
    via === 'admin' ? adminLogin(s, account) : via === 'jsonapi' ? jsonApiLogin(s, account) : publicLogin(s, account);
  const { result, ok } = await attempt;
  if (!ok) {
    throw new GoldenConfigError(
      `${ctx.scenarioId}: session ${name} could not log in as ${account.username} via ${via} ` +
        `(status ${result.status} at ${pathOf(result.url)})`,
    );
  }
}

/**
 * Logs every declared session of `scenario` in, in declaration order; call once, before the first step. Kept out
 * of {@link createScenarioContext} so a context whose jars are restored from a saved run is not logged in twice.
 */
export async function loginSessions(
  ctx: ScenarioContext,
  scenario: Partial<Pick<Scenario, 'sessions'>>,
): Promise<void> {
  for (const [name, spec] of Object.entries(scenario.sessions ?? {})) await loginSession(ctx, name, spec);
}

