import type { LogErrorRecord } from './fields.js';
import { REDACTED, redactText } from './redact.js';

// Every pattern is anchored and each quantifier stops at a character its class excludes, so each runs in linear time.

/** PostgreSQL SQLSTATE. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Node system error code, e.g. `ECONNREFUSED`. */
const SYSTEM_CODE = /^E[A-Z0-9_]+$/;

/** System call name, e.g. `connect`; excludes the `spawn <path>` form. */
const SYSCALL = /^[a-z][A-Za-z0-9_]*$/;

/** Node or Fastify error code. */
const NAMED_CODE = /^(?:ERR|FST)_[A-Z0-9_]+$/;

/** Stack frame line. */
const FRAME = /^\s+at \S/;

/** Failure code of an unavailable callee: a system, undici or HTTP-status code, an error class name, or `unknown`. */
const FAILURE_CODE = String.raw`(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|HTTP_[0-9]{3}|(?:[A-Z][A-Za-z0-9]*)?Error|unknown)`;

/** Text that is exactly one FAILURE_CODE. */
const FAILURE_CODE_TEXT = new RegExp(`^${FAILURE_CODE}$`);

/** gRPC status names, indexed by status code. */
const GRPC_STATUS = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const;

/** Error classes whose `code` is a gRPC status: google-gax's GoogleError and @google-cloud/pubsub's PublishError. */
const GRPC_ERROR_CLASSES: ReadonlySet<string> = new Set(['GoogleError', 'PublishError']);

/** Node's fixed message of each DOMException an aborted or timed-out signal raises, by name. */
const ABORT_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['TimeoutError', 'The operation was aborted due to timeout'],
  ['AbortError', 'This operation was aborted'],
]);

/** Alternatives matching exactly each `gRPC status <code> <name>` text. */
const GRPC_STATUS_TEXT = String.raw`gRPC status (?:${GRPC_STATUS.map((name, code) => `${String(code)} ${name}`).join('|')})`;

/** Alternatives matching exactly each of ABORT_MESSAGES. */
const ABORT_TEXT = [...ABORT_MESSAGES.values()].join('|');

/** Every text `safeErrorMessage` produces besides REDACTED, plus the sanitized message of @opentelemetry/instrumentation-pg. */
const SAFE_TEXT = new RegExp(
  String.raw`^(?:PostgreSQL error [0-9A-Z]{5}|[a-z][A-Za-z0-9_]* E[A-Z0-9_]+|(?:ERR|FST)_[A-Z0-9_]+|PostgreSQL error of type '\w+' occurred \(code: [0-9A-Z]{5}\)|Service [a-z][a-z0-9-]* unavailable \(${FAILURE_CODE}\)|(?:[a-z][a-z0-9-]*: )?invalid environment(?: \([A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*\))?|${GRPC_STATUS_TEXT}|${ABORT_TEXT})$`,
);

/** Most causes `safeErrorMessage` follows past an error without identifiers; also ends a cyclic chain. */
const MAX_CAUSE_DEPTH = 4;

/** Key under which an error supplies its own diagnostic text; kept only when it is a fixed safe text. */
export const SAFE_ERROR_TEXT: unique symbol = Symbol.for('@opt2/platform/logging.safeErrorText');

/** Whether `token` may stand as the failure code in `Service <name> unavailable (<code>)`. */
export function isSafeFailureCode(token: string): boolean {
  return FAILURE_CODE_TEXT.test(token);
}

/** String property `key` of an object value, or undefined. */
function stringProperty(value: unknown, key: PropertyKey): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const property: unknown = (value as Record<PropertyKey, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}

/** `header` followed by the redacted frame lines of `lines`. */
function withFrames(header: string, lines: readonly string[]): string {
  return [header, ...lines.filter((line) => FRAME.test(line)).map(redactText)].join('\n');
}

/** `gRPC status <code> <name>` of a GoogleError, PublishError or grpc-js ServiceError (`details` and `metadata` beside the code), never its message or details. */
function grpcStatusText(err: Error): string | undefined {
  const { code, details, metadata } = err as { code?: unknown; details?: unknown; metadata?: unknown };
  const name = typeof code === 'number' && Number.isInteger(code) ? GRPC_STATUS[code] : undefined;
  if (name === undefined) return undefined;
  const serviceError = typeof details === 'string' && typeof metadata === 'object' && metadata !== null;
  return serviceError || GRPC_ERROR_CLASSES.has(err.constructor?.name ?? '') ? `gRPC status ${String(code)} ${name}` : undefined;
}

/** Message from `err`'s own supplied safe text or diagnostic identifiers alone; otherwise REDACTED. */
function ownSafeMessage(err: unknown): string {
  const supplied = stringProperty(err, SAFE_ERROR_TEXT);
  if (supplied !== undefined && SAFE_TEXT.test(supplied)) return supplied;
  // Checked before the gRPC rule: DOMException codes 0–16 are not gRPC statuses.
  if (err instanceof DOMException) return ABORT_MESSAGES.get(err.name) === err.message ? err.message : REDACTED;
  const status = err instanceof Error ? grpcStatusText(err) : undefined;
  if (status !== undefined) return status;
  const code = stringProperty(err, 'code');
  if (code === undefined) return REDACTED;
  if (SQLSTATE.test(code) && stringProperty(err, 'severity') !== undefined) return `PostgreSQL error ${code}`;
  const syscall = stringProperty(err, 'syscall');
  if (SYSTEM_CODE.test(code) && syscall !== undefined && SYSCALL.test(syscall)) return `${syscall} ${code}`;
  return NAMED_CODE.test(code) ? code : REDACTED;
}

/** Message of `err` from its supplied safe text or diagnostic identifiers (SQLSTATE, system call and code, Node or Fastify code, gRPC status, Node's abort text), else from its nearest cause's; otherwise REDACTED. */
export function safeErrorMessage(err: unknown): string {
  let message = ownSafeMessage(err);
  let link = err;
  for (let depth = 0; message === REDACTED && depth < MAX_CAUSE_DEPTH && typeof link === 'object' && link !== null; depth += 1) {
    link = (link as { cause?: unknown }).cause;
    message = ownSafeMessage(link);
  }
  return message;
}

/** `header` followed by the redacted frames of `err.stack`, with every line of its message dropped; undefined without a string stack. */
export function safeErrorStack(err: unknown, header: string): string | undefined {
  const stack = stringProperty(err, 'stack');
  if (stack === undefined) return undefined;
  const message = stringProperty(err, 'message');
  const at = message === undefined ? -1 : stack.indexOf(message);
  // The text after the message starts mid-line, so its first segment is the tail of the header line.
  const lines = message === undefined || at < 0 ? stack.split('\n') : stack.slice(at + message.length).split('\n').slice(1);
  return withFrames(header, lines);
}

/** Whether `text` is REDACTED or another fixed safe error text, so a text-only sink may keep it. */
export function isSafeErrorText(text: string): boolean {
  return text === REDACTED || SAFE_TEXT.test(text);
}

/** `header` followed by the redacted frame lines of stack text `text`. */
export function safeStackText(text: string, header: string): string {
  return withFrames(header, text.split('\n'));
}

/** Error record of `value`: `type` redacted, `message` defaulting to its safe message, a string stack reduced to frames. */
function errorRecord(type: string, value: unknown, message = safeErrorMessage(value)): LogErrorRecord {
  const record = { type: redactText(type), message };
  const stack = safeErrorStack(value, `${record.type}: ${message}`);
  return stack === undefined ? record : { ...record, stack };
}

/** Serializes any logged error value to exactly `{ type, message, stack? }`, keeping only its type, safe identifiers and stack frames. */
export function serializeError(value: unknown): LogErrorRecord {
  if (value instanceof Error) {
    const type = value.name !== 'Error' ? value.name : (value.constructor?.name ?? 'Error');
    return errorRecord(type, value);
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  ) {
    // A record this function wrote keeps its safe message, so serializing it again changes nothing.
    return errorRecord(value.type, value, isSafeErrorText(value.message) ? value.message : undefined);
  }
  return errorRecord(typeof value, value);
}
