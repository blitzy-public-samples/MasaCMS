import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SAFE_ERROR_TEXT, envIssueReason, systemErrorText } from '../logging/safe-error.js';

const SERVICE_NAME = /^[a-z][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const HOST_PORT = /^(?:\[[0-9a-fA-F:.]+\]|[^\s:/[\]]+):(\d{1,5})$/;
const PORT_NUMBER = z.coerce.number<string>().int().min(1).max(65535);
const CLOUD_SQL_INSTANCE = /^[^:]+:[^:]+:[^:]+$/;
const MODES = ['local', 'cloud'] as const;
const ADAPTER_KEYS = ['OPT2_TASKS_ADAPTER', 'OPT2_STORAGE_ADAPTER'] as const;
// Repository checkout root: the same depth above src/service-kit/env.ts and dist/service-kit/env.js. Resolved from the
// module path, not `new URL(…, import.meta.url)`, which Next's Turbopack rewrites to a protocol-less asset URL when
// web bundles the linked platform.
const REPO_ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));

type Mode = (typeof MODES)[number];
type AdapterKey = (typeof ADAPTER_KEYS)[number];

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

// Plain z.url() also accepts scheme-like 'host:port' strings; every configured endpoint is HTTP.
const httpUrl = () => z.url({ protocol: /^https?$/ }).transform((url) => url.replace(/\/+$/, ''));

const OFFSET_INSTANTS = [Date.UTC(2026, 0, 15, 12), Date.UTC(2026, 6, 15, 12)];
const WALL_CLOCK = {
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
} as const;

/** Minutes by which `format`'s time zone is ahead of UTC at `at`. */
const zoneOffsetMinutes = (format: Intl.DateTimeFormat, at: number): number => {
  const parts = format.formatToParts(at);
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return (Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute')) - at) / 60_000;
};

/** Whether `name` is a correctly cased IANA zone id that `Date` also applies when it is this process's TZ. */
function isAppliedTimeZone(name: string): boolean {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone: name, ...WALL_CLOCK });
  } catch {
    return false;
  }
  const resolved = format.resolvedOptions().timeZone;
  if (/^[+-]/.test(resolved) || (resolved !== name && resolved.toLowerCase() === name.toLowerCase())) return false;
  if (name !== process.env.TZ) return true;
  return OFFSET_INSTANTS.every((at) => zoneOffsetMinutes(format, at) === -new Date(at).getTimezoneOffset());
}

/** Optional variable; blank values count as absent. */
export function optionalEnvString(): z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
export function optionalEnvString<T extends z.ZodType>(schema: T): z.ZodPreprocess<z.ZodOptional<T>>;
export function optionalEnvString(schema: z.ZodType = z.string()): z.ZodPreprocess<z.ZodOptional<z.ZodType>> {
  // The blank check must wrap `.optional()`: an outer `.optional()` would hand '' to the inner schema.
  return z.preprocess(blankToUndefined, schema.optional());
}

/** Required variable; blank values count as absent. */
export function requiredEnvString(): z.ZodPreprocess<z.ZodString>;
export function requiredEnvString<T extends z.ZodType>(schema: T): z.ZodPreprocess<T>;
export function requiredEnvString(schema: z.ZodType = z.string()): z.ZodPreprocess<z.ZodType> {
  return z.preprocess(blankToUndefined, schema);
}

/** Required absolute http(s) URL, trailing `/` trimmed. */
export function envUrl() {
  return requiredEnvString(httpUrl());
}

/** Required TCP port. */
export function envPort() {
  return requiredEnvString().pipe(PORT_NUMBER);
}

const serviceUrlMap = z
  .string()
  .default('{}')
  .transform((raw, ctx): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'OPT2_SERVICE_URLS must be a JSON object' });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string().regex(SERVICE_NAME), httpUrl()));

/** `dir` with its deepest existing ancestor resolved through symlinks. */
function canonicalPath(dir: string): string {
  const missing: string[] = [];
  for (let current = dir; ; current = path.dirname(current)) {
    try {
      return path.join(realpathSync(current), ...missing);
    } catch {
      if (path.dirname(current) === current) return dir;
      missing.unshift(path.basename(current));
    }
  }
}

/** Absolute runtime state directory outside the checkout, returned normalised. */
const stateDirPath = z.string().transform((dir, ctx) => {
  if (!path.isAbsolute(dir)) {
    ctx.addIssue({ code: 'custom', message: 'must be an absolute path' });
    return z.NEVER;
  }
  const resolved = path.resolve(dir);
  const canonical = canonicalPath(resolved);
  if (canonical === REPO_ROOT || canonical.startsWith(REPO_ROOT + path.sep)) {
    ctx.addIssue({ code: 'custom', message: 'must be outside the repository checkout' });
    return z.NEVER;
  }
  return resolved;
});

/** Variables every OPT-2 process reads; gateway, migration and communications `.extend()` it with the builders above. */
export const baseEnvSchema = z.object({
  PORT: envPort(),
  OPT2_SERVICE_NAME: requiredEnvString(z.string().regex(SERVICE_NAME)),
  OPT2_ENV: requiredEnvString(z.enum(MODES)),
  PG_HOST: optionalEnvString(),
  PG_PORT: optionalEnvString(envPort()),
  PG_DATABASE: optionalEnvString(),
  PG_USER: optionalEnvString(),
  PG_PASSWORD: optionalEnvString(),
  OPT2_DB_AUTH: optionalEnvString(z.enum(['password', 'iam'])),
  CLOUD_SQL_INSTANCE: optionalEnvString(z.string().regex(CLOUD_SQL_INSTANCE)),
  PUBSUB_EMULATOR_HOST: optionalEnvString(
    z
      .string()
      .regex(HOST_PORT, { abort: true })
      .refine((value) => PORT_NUMBER.safeParse(HOST_PORT.exec(value)?.[1]).success, 'port must be from 1 to 65535'),
  ),
  GOOGLE_CLOUD_PROJECT: optionalEnvString(),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalEnvString(envUrl()),
  OPT2_JWKS_URL: optionalEnvString(envUrl()),
  OPT2_TOKEN_ISSUER: requiredEnvString(),
  OPT2_TOKEN_AUDIENCE: requiredEnvString(),
  OPT2_GATEWAY_URL: optionalEnvString(envUrl()),
  OPT2_MIGRATION_URL: optionalEnvString(envUrl()),
  OPT2_SERVICE_URLS: z.preprocess(blankToUndefined, serviceUrlMap),
  // `.prefault` checks the home-directory default too; `.default` would return it unchecked.
  OPT2_STATE_DIR: z.preprocess(
    blankToUndefined,
    stateDirPath.prefault(() => path.join(homedir(), '.opt2', 'state')),
  ),
  OPT2_TASKS_ADAPTER: optionalEnvString(z.enum(MODES)),
  OPT2_STORAGE_ADAPTER: optionalEnvString(z.enum(MODES)),
  LOG_LEVEL: optionalEnvString(z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])),
  TZ: requiredEnvString(
    z
      .string()
      .refine(isAppliedTimeZone, 'must be an IANA time zone name that this process applies, such as UTC or America/New_York'),
  ),
});

/** Any object schema that carries every base variable. */
export type EnvSchema = z.ZodObject<typeof baseEnvSchema.shape>;

/** Parsed variables of `S`, with the adapter choices always set. */
export type LoadedEnv<S extends EnvSchema = typeof baseEnvSchema> = Omit<z.output<S>, AdapterKey> &
  Record<AdapterKey, Mode>;

/** Parsed base variables as `loadEnv` returns them. */
export type BaseEnv = LoadedEnv<typeof baseEnvSchema>;

/** Cross-variable rules of a parsed, possibly partial, environment, as messages naming variables only; mode rules need OPT2_ENV. */
export function envModeIssues(env: Partial<BaseEnv>): string[] {
  const issues: string[] = [];
  const need = (when: string, keys: readonly (keyof BaseEnv)[]) => {
    for (const key of keys) if (env[key] === undefined) issues.push(`${key}: is required when ${when}`);
  };
  const forbid = (when: string, key: keyof BaseEnv) => {
    if (env[key] !== undefined) issues.push(`${key}: must be unset when ${when}`);
  };
  const runIn = (when: string, mode: Mode) => {
    if (env.OPT2_ENV !== undefined && env.OPT2_ENV !== mode) issues.push(`OPT2_ENV: must be ${mode} when ${when}`);
  };

  if (env.OPT2_DB_AUTH === 'password') {
    need('OPT2_DB_AUTH=password', ['PG_HOST', 'PG_PORT', 'PG_DATABASE', 'PG_USER', 'PG_PASSWORD']);
    runIn('OPT2_DB_AUTH=password', 'local');
  } else if (env.OPT2_DB_AUTH === 'iam') {
    need('OPT2_DB_AUTH=iam', ['CLOUD_SQL_INSTANCE', 'PG_DATABASE', 'PG_USER']);
    forbid('OPT2_DB_AUTH=iam', 'PG_PASSWORD');
    runIn('OPT2_DB_AUTH=iam', 'cloud');
  }
  if (env.OPT2_ENV === 'cloud') {
    need('OPT2_ENV=cloud', ['GOOGLE_CLOUD_PROJECT']);
    forbid('OPT2_ENV=cloud', 'PUBSUB_EMULATOR_HOST');
  } else if (env.OPT2_ENV === 'local') {
    need('OPT2_ENV=local', ['OPT2_JWKS_URL']);
  }
  for (const key of ADAPTER_KEYS) {
    if (env.OPT2_ENV !== undefined && env[key] !== env.OPT2_ENV) issues.push(`${key}: must equal OPT2_ENV`);
  }
  return issues;
}

/** Safe name of `issue`: `VAR.name` for a missing required map entry, else the variable name; '' when it names none. */
function issueName(issue: string): string {
  const at = issue.indexOf(':');
  const issuePath = (at < 0 ? issue : issue.slice(0, at)).trim();
  const dot = issuePath.indexOf('.');
  const variable = dot < 0 ? issuePath : issuePath.slice(0, dot);
  if (!ENV_NAME.test(variable)) return '';
  // A required entry's name comes from the schema, never from the value.
  const requiredEntry = dot >= 0 && issue.slice(at) === ': is required' && SERVICE_NAME.test(issuePath.slice(dot + 1));
  return requiredEntry ? issuePath : variable;
}

/** Start-up failure listing every invalid or missing variable. */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
  readonly issues: string[];
  readonly #safeText: string;

  constructor(issues: string[], service?: string) {
    super([`${service === undefined ? '' : `${service}: `}invalid environment`, ...issues.map((i) => `  ${i}`)].join('\n'));
    this.issues = issues;
    // One entry per name, with the reason of its first issue.
    const reasons = new Map<string, string>();
    for (const issue of issues) {
      const name = issueName(issue);
      const at = issue.indexOf(':');
      if (name !== '' && !reasons.has(name)) reasons.set(name, envIssueReason(at < 0 ? '' : issue.slice(at + 1).trim()));
    }
    const entries = [...reasons].map(([name, reason]) => `${name}: ${reason}`);
    this.#safeText = `${service === undefined ? '' : `${service}: `}invalid environment${entries.length > 0 ? ` (${entries.join('; ')})` : ''}`;
  }

  /** The service and, per invalid variable or missing required entry, its name and value-free reason, never its value or issue text. */
  get [SAFE_ERROR_TEXT](): string {
    return this.#safeText;
  }
}

/** Start-up failure reading a file inside the directory a variable names; keeps the cause's message, string `code` and `syscall`. */
export class EnvFileError extends Error {
  override readonly name = 'EnvFileError';
  /** The directory variable, such as OPT2_STATE_DIR. */
  readonly variable: string;
  /** The file's `/`-separated path inside that directory. */
  readonly file: string;
  readonly code?: string;
  readonly syscall?: string;
  readonly #safeText: string;

  constructor(variable: string, file: string, cause: unknown, service?: string) {
    const prefix = service === undefined ? '' : `${service}: `;
    super(`${prefix}${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.variable = variable;
    this.file = file;
    const { code, syscall } = (typeof cause === 'object' && cause !== null ? cause : {}) as { code?: unknown; syscall?: unknown };
    if (typeof code === 'string') this.code = code;
    if (typeof syscall === 'string') this.syscall = syscall;
    const system = systemErrorText(cause);
    this.#safeText = `${prefix}cannot read ${variable} file ${file}${system === undefined ? '' : ` (${system})`}`;
  }

  /** The service, the variable, the file's path inside its directory and the cause's system call and code, never the directory or the cause's text. */
  get [SAFE_ERROR_TEXT](): string {
    return this.#safeText;
  }
}

/** UTF-8 text of `file`, a path inside `dir`, the directory variable `variable` names; a failed read rejects with `EnvFileError` naming `file` relative to `dir`. */
export async function readEnvFile(variable: string, dir: string, file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    throw new EnvFileError(variable, path.relative(dir, file).split(path.sep).join('/'), err);
  }
}

/** Emulator `host:port` of a process's default publisher, required when local and undefined in the cloud; else throws `EnvValidationError`. */
export function publisherEmulatorHost(
  env: Pick<BaseEnv, 'OPT2_SERVICE_NAME' | 'OPT2_ENV' | 'PUBSUB_EMULATOR_HOST'>,
): string | undefined {
  const parsed = baseEnvSchema.shape.PUBSUB_EMULATOR_HOST.safeParse(env.PUBSUB_EMULATOR_HOST);
  const issues = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  if (parsed.success && env.OPT2_ENV === 'local' && parsed.data === undefined) issues.push('is required when OPT2_ENV=local');
  if (parsed.success && env.OPT2_ENV === 'cloud' && parsed.data !== undefined) issues.push('must be unset when OPT2_ENV=cloud');
  if (issues.length > 0) throw new EnvValidationError(issues.map((issue) => `PUBSUB_EMULATOR_HOST: ${issue}`), env.OPT2_SERVICE_NAME);
  return parsed.data;
}

/** What one process requires of the base variables: its own service name, the callees it calls and, when it opens a pool, its database. */
export interface ProcessEnvRequirements {
  /** The only accepted OPT2_SERVICE_NAME. */
  readonly service: string;
  /** Services called through the service client; `gateway` and `migration` are also named by OPT2_GATEWAY_URL and OPT2_MIGRATION_URL. */
  readonly callees?: readonly string[];
  /** Whether the process opens a pool, which needs OPT2_DB_AUTH and PG_DATABASE. */
  readonly database?: boolean;
}

/** Variable createService maps over a callee's OPT2_SERVICE_URLS entry, so either one names that callee. */
const CALLEE_URL_VARIABLES: ReadonlyMap<string, string> = new Map([
  ['gateway', 'OPT2_GATEWAY_URL'],
  ['migration', 'OPT2_MIGRATION_URL'],
]);

/** Adds an issue for each of `requirements` that `env` misses; a variable or map that failed its own parse gets none. */
export function checkProcessEnv(
  env: Readonly<Record<string, unknown>>,
  ctx: z.RefinementCtx,
  requirements: ProcessEnvRequirements,
): void {
  // Failed fields keep their raw values here and carry their own issue.
  const failed = new Set(ctx.issues.map((issue) => issue.path?.[0]));
  if (!failed.has('OPT2_SERVICE_NAME') && env.OPT2_SERVICE_NAME !== requirements.service) {
    ctx.addIssue({ code: 'custom', path: ['OPT2_SERVICE_NAME'], message: `must be ${requirements.service}` });
  }
  for (const key of requirements.database === true ? ['OPT2_DB_AUTH', 'PG_DATABASE'] : []) {
    if (!failed.has(key) && env[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'is required' });
  }
  const urls = env.OPT2_SERVICE_URLS;
  const mapFailed = ctx.issues.some((issue) => issue.path?.length === 1 && issue.path[0] === 'OPT2_SERVICE_URLS');
  if (mapFailed || typeof urls !== 'object' || urls === null) return;
  for (const callee of (requirements.callees ?? []).filter((name) => !Object.hasOwn(urls, name))) {
    const variable = CALLEE_URL_VARIABLES.get(callee);
    if (variable === undefined) {
      ctx.addIssue({ code: 'custom', path: ['OPT2_SERVICE_URLS', callee], message: 'is required' });
    } else if (!failed.has(variable) && env[variable] === undefined) {
      ctx.addIssue({ code: 'custom', path: [variable], message: `is required (or OPT2_SERVICE_URLS.${callee})` });
    }
  }
}

/** `schema` refined by `checkProcessEnv`, which runs even when other variables failed, so `loadEnv` lists every issue at once. */
export function processEnvSchema<S extends EnvSchema>(schema: S, requirements: ProcessEnvRequirements): S {
  return schema.superRefine((env, ctx) => checkProcessEnv(env, ctx, requirements), { when: () => true });
}

const serviceNameOf = (source: NodeJS.ProcessEnv): string | undefined => {
  const name = source.OPT2_SERVICE_NAME;
  return name !== undefined && SERVICE_NAME.test(name) ? name : undefined;
};

/** Base variables of `source` that parse on their own under `schema`, adapters defaulting to OPT2_ENV. */
function parsedBaseVariables(schema: EnvSchema, source: NodeJS.ProcessEnv): Partial<BaseEnv> {
  const parsed: Partial<Record<keyof BaseEnv, unknown>> = {};
  for (const key of Object.keys(baseEnvSchema.shape) as (keyof EnvSchema['shape'])[]) {
    const result = schema.shape[key].safeParse(source[key]);
    if (result.success) parsed[key] = result.data;
  }
  const base = parsed as Partial<z.output<typeof baseEnvSchema>>;
  return {
    ...base,
    OPT2_TASKS_ADAPTER: base.OPT2_TASKS_ADAPTER ?? base.OPT2_ENV,
    OPT2_STORAGE_ADAPTER: base.OPT2_STORAGE_ADAPTER ?? base.OPT2_ENV,
  };
}

/** Parses and checks `source` against `schema`; throws `EnvValidationError` on any issue. */
export function loadEnv<S extends EnvSchema = typeof baseEnvSchema>(
  schema: S = baseEnvSchema as S,
  source: NodeJS.ProcessEnv = process.env,
): Readonly<LoadedEnv<S>> {
  const result = schema.safeParse(source, {
    error: (issue) => (issue.input === undefined ? 'is required' : undefined),
  });
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    // A variable with an issue of its own keeps only that one.
    const named = new Set(result.error.issues.map((issue) => String(issue.path[0])));
    const crossIssues = envModeIssues(parsedBaseVariables(schema, source)).filter(
      (issue) => !named.has(issue.slice(0, issue.indexOf(':'))),
    );
    throw new EnvValidationError([...issues, ...crossIssues], serviceNameOf(source));
  }

  const base = result.data as z.output<typeof baseEnvSchema>;
  const adapters: Record<AdapterKey, Mode> = {
    OPT2_TASKS_ADAPTER: base.OPT2_TASKS_ADAPTER ?? base.OPT2_ENV,
    OPT2_STORAGE_ADAPTER: base.OPT2_STORAGE_ADAPTER ?? base.OPT2_ENV,
  };
  const issues = envModeIssues({ ...base, ...adapters });
  if (issues.length > 0) throw new EnvValidationError(issues, base.OPT2_SERVICE_NAME);
  return Object.freeze({ ...result.data, ...adapters }) as Readonly<LoadedEnv<S>>;
}
