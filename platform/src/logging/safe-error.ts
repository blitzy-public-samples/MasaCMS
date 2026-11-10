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

/** Every text `safeErrorMessage` produces besides REDACTED, plus the sanitized message of @opentelemetry/instrumentation-pg. */
const SAFE_TEXT =
  /^(?:PostgreSQL error [0-9A-Z]{5}|[a-z][A-Za-z0-9_]* E[A-Z0-9_]+|(?:ERR|FST)_[A-Z0-9_]+|PostgreSQL error of type '\w+' occurred \(code: [0-9A-Z]{5}\))$/;

/** String property `key` of an object value, or undefined. */
function stringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const property: unknown = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}

/** `header` followed by the redacted frame lines of `lines`. */
function withFrames(header: string, lines: readonly string[]): string {
  return [header, ...lines.filter((line) => FRAME.test(line)).map(redactText)].join('\n');
}

/** Message of `err` built only from its diagnostic identifiers (SQLSTATE, system call and code, Node or Fastify code); otherwise REDACTED. */
export function safeErrorMessage(err: unknown): string {
  const code = stringProperty(err, 'code');
  if (code === undefined) return REDACTED;
  if (SQLSTATE.test(code) && stringProperty(err, 'severity') !== undefined) return `PostgreSQL error ${code}`;
  const syscall = stringProperty(err, 'syscall');
  if (SYSTEM_CODE.test(code) && syscall !== undefined && SYSCALL.test(syscall)) return `${syscall} ${code}`;
  return NAMED_CODE.test(code) ? code : REDACTED;
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
