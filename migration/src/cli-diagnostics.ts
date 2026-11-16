// Safe failure output shared by the `opt2-migrate`, `opt2-ops` and `opt2-db` CLIs: scrubbed summary lines and log-record.v1 diagnostics.
// Every function takes the logging barrel as an argument, because the CLIs load it only once tracing has started or failed.
import type { Logger } from '@opt2/platform/logging';

type LoggingModule = typeof import('@opt2/platform/logging');

/** Streams a CLI writes its summary line and diagnostics to. */
interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

// Secret values never written to stdout or stderr.
const SECRET_VARIABLES = ['MURA_DBPASSWORD', 'OPT2_BRIDGE_HMAC_KEY', 'PG_PASSWORD'] as const;
const REDACTED = '[redacted]';
// Task URLs carry opt2TaskToken and local push endpoints the push key in their query, so no URL keeps its query or fragment.
const URL_QUERY = /(\bhttps?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/g;

// Most causes reported after a failure; also ends a cyclic chain.
const MAX_CAUSES = 8;
// Error properties naming what failed (driver code, SQL Server error number, HTTP status, database, unit, callee); never row values, bodies or paths.
const IDENTIFIER_KEYS = ['code', 'number', 'status', 'database', 'table', 'unit', 'owner', 'operation', 'op', 'method', 'step', 'schema'] as const;
// One identifier token: no space, quote, slash, `@`, `=`, `?` or `#`.
const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
// Result keys holding caught error text or an upstream answer: transition and fault errors, fault assertion details, a child's stderr.
const ERROR_PAYLOAD_KEY = /^(?:error|.+Error|failedAfterRestart|stderrTail)$/;

/** `text` with every secret value replaced and every URL query or fragment removed. */
function redact(text: string): string {
  let out = text;
  for (const name of SECRET_VARIABLES) {
    const secret = process.env[name];
    if (secret !== undefined && secret !== '') out = out.split(secret).join(REDACTED);
  }
  return out.replace(URL_QUERY, '$1');
}

/** `text` after `redact` and the platform's masking of credentials, session material and email addresses. */
export function scrub(logging: LoggingModule, text: string): string {
  return logging.redactText(redact(text));
}

/** Writes `value` as one JSON line on stdout, every string scrubbed and every bigint as its decimal string. */
export function writeLine(logging: LoggingModule, io: Pick<CliIo, 'stdout'>, value: object): void {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'string') return scrub(logging, item);
    return typeof item === 'bigint' ? item.toString() : item;
  });
  io.stdout.write(`${json}\n`);
}

/** A log-record.v1 logger on stderr; env `cloud` only when `env` is `cloud` and `googleCloudProject` forms the Cloud Logging trace key, else `local`. */
export function stderrLogger(
  logging: LoggingModule,
  io: Pick<CliIo, 'stderr'>,
  options: { service: string; version: string; env: string | undefined; googleCloudProject: string | undefined },
): Logger {
  const base = { service: options.service, version: options.version, destination: io.stderr };
  if (options.env === 'cloud') {
    try {
      return logging.createLogger({ ...base, env: 'cloud', googleCloudProject: options.googleCloudProject });
    } catch {
      // The line is still written, as local, when the project cannot form the Cloud Logging trace key.
    }
  }
  return logging.createLogger({ ...base, env: 'local' });
}

/** The next link of a cause chain: `cause`, else node-mssql's `originalError`. */
function nextCause(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const { cause, originalError } = value as { cause?: unknown; originalError?: unknown };
  return cause ?? originalError ?? undefined;
}

/** Causes of `error`, nearest first, without repeats and at most MAX_CAUSES. */
function causesOf(error: unknown): unknown[] {
  const causes: unknown[] = [];
  const seen = new Set<unknown>([error]);
  for (let link = nextCause(error); link !== undefined && !seen.has(link) && causes.length < MAX_CAUSES; link = nextCause(link)) {
    causes.push(link);
    seen.add(link);
  }
  return causes;
}

/** A safe integer, or an identifier token scrubbing leaves unchanged. */
function isIdentifierValue(logging: LoggingModule, value: unknown): value is string | number {
  return typeof value === 'number' ? Number.isSafeInteger(value) : typeof value === 'string' && IDENTIFIER.test(value) && scrub(logging, value) === value;
}

/** IDENTIFIER_KEYS properties of `error` that are safe integers, or identifier tokens scrubbing leaves unchanged. */
function identifiersOf(logging: LoggingModule, error: unknown): Record<string, string | number> {
  const identifiers: Record<string, string | number> = {};
  if (typeof error !== 'object' || error === null) return identifiers;
  for (const key of IDENTIFIER_KEYS) {
    const value: unknown = (error as Record<string, unknown>)[key];
    if (isIdentifierValue(logging, value)) identifiers[key] = value;
  }
  return identifiers;
}

/** `{type, message}` as the platform serializes `error`, then its identifiers. */
function safeError(logging: LoggingModule, error: unknown): Record<string, string | number> {
  const { type, message } = logging.serializeError(error);
  return { type, message, ...identifiersOf(logging, error) };
}

/** `{type, message, ...identifiers, causes?}` of `error`, each cause with its own type, safe message and identifiers. */
export function safeFailure(logging: LoggingModule, error: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = safeError(logging, error);
  const causes = causesOf(error).map((cause) => safeError(logging, cause));
  return causes.length === 0 ? summary : { ...summary, causes };
}

/** The platform's safe message of error text `text`: a fixed safe text such as `connect ECONNREFUSED`, otherwise REDACTED. */
function safeText(logging: LoggingModule, text: string): string {
  return logging.serializeError({ type: 'Error', message: text }).message;
}

/** An object literal or a JSON-parsed object, as opposed to a Date or another class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Safe metadata of an error payload: a text as its safe text; an object as its safe `message` and its number, boolean and identifier fields. */
function safePayload(logging: LoggingModule, value: unknown): unknown {
  if (typeof value === 'string') return safeText(logging, value);
  if (Array.isArray(value)) return value.map((item: unknown) => safePayload(logging, item));
  if (typeof value !== 'object' || value === null) return value;
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'message' && typeof item === 'string') safe[key] = safeText(logging, item);
    else if (typeof item === 'number' || typeof item === 'boolean' || isIdentifierValue(logging, item)) safe[key] = item;
  }
  return safe;
}

/** `value` with each ERROR_PAYLOAD_KEY value of its plain objects, at any depth, reduced by `safePayload`; everything else unchanged. */
export function withSafeErrors<T>(logging: LoggingModule, value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => withSafeErrors(logging, item)) as T;
  if (!isPlainObject(value)) return value;
  const entries = Object.entries(value).map(([key, item]) => [key, ERROR_PAYLOAD_KEY.test(key) ? safePayload(logging, item) : withSafeErrors(logging, item)]);
  return Object.fromEntries(entries) as T;
}

/** `text`, then ` (key=value ...)` of `error`'s identifiers when it has any. */
function withIdentifiers(logging: LoggingModule, text: string, error: unknown): string {
  const pairs = Object.entries(identifiersOf(logging, error)).map(([key, value]) => `${key}=${String(value)}`);
  return pairs.length === 0 ? text : `${text} (${pairs.join(' ')})`;
}

/** Logs `error` under `message`, then each cause as a `caused by` line, as safe log-record.v1 lines. */
export function logFailure(logging: LoggingModule, logger: Logger, message: string, error: unknown): void {
  logger.error({ error: logging.serializeError(error) }, withIdentifiers(logging, message, error));
  for (const cause of causesOf(error)) {
    logger.error({ error: logging.serializeError(cause) }, withIdentifiers(logging, 'caused by', cause));
  }
}
