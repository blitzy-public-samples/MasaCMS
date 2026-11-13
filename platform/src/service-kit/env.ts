import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const SERVICE_NAME = /^[a-z][a-z0-9-]*$/;
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

/** Cross-variable rules of a parsed environment, as messages naming variables only. */
export function envModeIssues(env: BaseEnv): string[] {
  const issues: string[] = [];
  const need = (when: string, keys: readonly (keyof BaseEnv)[]) => {
    for (const key of keys) if (env[key] === undefined) issues.push(`${key}: is required when ${when}`);
  };
  const forbid = (when: string, key: keyof BaseEnv) => {
    if (env[key] !== undefined) issues.push(`${key}: must be unset when ${when}`);
  };
  const runIn = (when: string, mode: Mode) => {
    if (env.OPT2_ENV !== mode) issues.push(`OPT2_ENV: must be ${mode} when ${when}`);
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
  } else {
    need('OPT2_ENV=local', ['OPT2_JWKS_URL']);
  }
  for (const key of ADAPTER_KEYS) {
    if (env[key] !== env.OPT2_ENV) issues.push(`${key}: must equal OPT2_ENV`);
  }
  return issues;
}

/** Start-up failure listing every invalid or missing variable. */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
  readonly issues: string[];

  constructor(issues: string[], service?: string) {
    super([`${service === undefined ? '' : `${service}: `}invalid environment`, ...issues.map((i) => `  ${i}`)].join('\n'));
    this.issues = issues;
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

const serviceNameOf = (source: NodeJS.ProcessEnv): string | undefined => {
  const name = source.OPT2_SERVICE_NAME;
  return name !== undefined && SERVICE_NAME.test(name) ? name : undefined;
};

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
    throw new EnvValidationError(issues, serviceNameOf(source));
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
