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

/** SMTP command nodemailer names as in flight when it fails; `AUTH` carries an RFC 4422 mechanism name. */
const SMTP_COMMAND = String.raw`(?:CONN|API|EHLO|HELO|LHLO|STARTTLS|AUTH [A-Z0-9_-]{1,20}|MAIL FROM|RCPT TO|DATA|RSET)`;

/** Text that is exactly one SMTP_COMMAND. */
const SMTP_COMMAND_TEXT = new RegExp(`^${SMTP_COMMAND}$`);

/** Gate unit `<schema>.<table>`. */
const UNIT = String.raw`[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*`;

/** Supplied text of a migration-kit gate error: its fixed phrase, then one or more units separated by `, `. */
const GATE_TEXT = `(?:Unit gate (?:closed|race|compare-and-set refused) for|Target is not write-authoritative for|Legacy write window in progress for|Open operation or closed gate blocks) ${UNIT}(?:, ${UNIT})*`;

/** Task queue name: lower-case words joined by `-`. */
const QUEUE = '[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*';

/** Recurring chain task name `<queue>-<slot start epoch s>`. */
const SLOT = '(?:[a-z][a-z0-9]*-)+[0-9]+';

/** Supplied text of a RecurringSlotsTombstonedError, naming only its queue and probed chain task names. */
const RECURRING_TEXT = `No live chain task on queue ${QUEUE}: tombstoned slots ${SLOT}(?:, ${SLOT})*`;

/** SQL Server error number text. */
const SQL_SERVER_ERROR = 'SQL Server error [0-9]+';

/** mssql driver error classes, by name, and what each reports failed. */
const MSSQL_ERRORS: ReadonlyMap<string, string> = new Map([
  ['RequestError', 'request'],
  ['ConnectionError', 'connection'],
  ['TransactionError', 'transaction'],
]);

/** Text of an mssql driver error: its SQL Server error number, else what failed and the driver code. */
const MSSQL_TEXT = `(?:${SQL_SERVER_ERROR}|SQL Server (?:${[...MSSQL_ERRORS.values()].join('|')}) E[A-Z0-9_]+)`;

/** Supplied text of migration's Opt2SyncUnavailableError: its fixed phrase, then an SQL Server error number or the missing checkpoint table. */
const OPT2_SYNC_TEXT = String.raw`Schema opt2_sync could not be created in the legacy database, so no unit may become target-authoritative: (?:${SQL_SERVER_ERROR}|opt2_sync\.projector_checkpoint does not exist in the live legacy database)`;

/** Write position entry `<owner>=<xid>`. */
const POSITION = '[a-z][a-z0-9-]*=[0-9]+';

/** Supplied text of migration's ProjectionTimeoutError: the awaited positions, joined by `,`, and the budget in ms. */
const PROJECTION_TIMEOUT_TEXT = `Projection of (?:${POSITION}(?:,${POSITION})*)? was not applied in legacy within [0-9]+ ms`;

/** Environment variable name. */
const ENV_KEY = '[A-Z][A-Z0-9_]*';

/** Condition of a cross-variable rule, ` when <KEY>=<word>`. */
const ENV_CONDITION = ` when ${ENV_KEY}=[a-z0-9_-]+`;

/** Reason wording: letters, digits, spaces and `,()/|._-`, never `:`, `;`, `@`, quotes or `=`. */
const REASON_TEXT = '[A-Za-z0-9 ,()/|._-]{1,160}';

/** Reason a schema's own message states: a requirement or constraint in schema words. */
const RULE_REASON = String.raw`is required(?:${ENV_CONDITION}| \(or OPT2_SERVICE_URLS\.[a-z][a-z0-9-]*\))?|must be unset${ENV_CONDITION}|must equal ${ENV_KEY}|must be ${REASON_TEXT}(?:${ENV_CONDITION})?`;

/** Value-free reason of one invalid variable. */
const ENV_REASON = `(?:${RULE_REASON}|expected ${REASON_TEXT}|is invalid)`;

/** One `<VAR>: <reason>` entry; a required map entry is named `<VAR>.<service>`. */
const ENV_ENTRY = String.raw`${ENV_KEY}(?:\.[a-z][a-z0-9-]*)?: ${ENV_REASON}`;

/** Segment of a `/`-separated path inside a configured directory, never `.` or `..`. */
const FILE_SEGMENT = String.raw`(?!\.\.?(?:/| |$))[A-Za-z0-9._-]+`;

/** Supplied text of an EnvFileError: the directory variable, the file inside it and the cause's system call and code. */
const ENV_FILE_TEXT = String.raw`(?:[a-z][a-z0-9-]*: )?cannot read ${ENV_KEY} file ${FILE_SEGMENT}(?:/${FILE_SEGMENT})*(?: \([a-z][A-Za-z0-9_]* E[A-Z0-9_]+\))?`;

/** Supplied text of an UnpublishedEventsError, naming only its event count. */
const UNPUBLISHED_TEXT = String.raw`Outbox publish of [1-9][0-9]* committed event\(s\) incomplete before the answer; left to the sweep`;

/** Every text `safeErrorMessage` produces besides REDACTED, platform and migration errors' supplied texts included, plus the sanitized message of @opentelemetry/instrumentation-pg. */
const SAFE_TEXT = new RegExp(
  String.raw`^(?:PostgreSQL error [0-9A-Z]{5}|[a-z][A-Za-z0-9_]* E[A-Z0-9_]+|(?:ERR|FST)_[A-Z0-9_]+|PostgreSQL error of type '\w+' occurred \(code: [0-9A-Z]{5}\)|Service [a-z][a-z0-9-]* unavailable \(${FAILURE_CODE}\)|Database unavailable \((?:E[A-Z0-9_]+|[0-9A-Z]{5})\)|(?:[a-z][a-z0-9-]*: )?invalid environment(?: \(${ENV_ENTRY}(?:; ${ENV_ENTRY})*\))?|${ENV_FILE_TEXT}|(?:[a-z][a-z0-9-]*: )?invalid configuration file [a-z][a-z0-9-]*\.json|${GRPC_STATUS_TEXT}|${ABORT_TEXT}|SMTP ${SMTP_COMMAND} E[A-Z0-9_]+|${GATE_TEXT}|${RECURRING_TEXT}|${MSSQL_TEXT}|${OPT2_SYNC_TEXT}|${PROJECTION_TIMEOUT_TEXT}|${UNPUBLISHED_TEXT})$`,
);

/** Text that is exactly one RULE_REASON. */
const RULE_REASON_TEXT = new RegExp(`^(?:${RULE_REASON})$`);

/** Text that is exactly one ENV_REASON. */
const ENV_REASON_TEXT = new RegExp(`^${ENV_REASON}$`);

/** Reasons of the platform's fixed environment messages that do not read as one. */
const FIXED_ENV_REASONS: ReadonlyMap<string, string> = new Map([
  ['OPT2_SERVICE_URLS must be a JSON object', 'must be a JSON object'],
  ['port must be from 1 to 65535', 'must be a port from 1 to 65535'],
  // Every URL variable the platform builds is http(s).
  ['Invalid URL', 'expected an http(s) URL'],
  ['Invalid key in record', 'expected valid record keys'],
]);

/** Enum option or literal a zod message quotes from the schema. */
const SCHEMA_WORD = /^(?:"([a-z0-9_-]+)"|([a-z0-9_-]+))$/;

/** Words of zod's size comparison operators. */
const BOUND_WORDS: ReadonlyMap<string, string> = new Map([
  ['<=', 'at most'],
  ['>=', 'at least'],
  ['<', 'below'],
  ['>', 'above'],
  ['exactly ', 'exactly'],
]);

/** The word of zod's quoted `"word"` or bare `word`, or undefined. */
const schemaWord = (text: string): string | undefined => {
  const match = SCHEMA_WORD.exec(text);
  return match?.[1] ?? match?.[2];
};

/** Value-free `expected …` reason of a zod default message, which names only schema types, options and bounds; undefined for any other text. */
function zodReason(text: string): string | undefined {
  let match = /^Invalid input: expected ([a-z][a-z0-9]*), received [A-Za-z]+$/.exec(text);
  if (match !== null) return `expected ${match[1] ?? ''}`;
  match = /^Invalid input: expected (\S+)$/.exec(text);
  if (match !== null) {
    const word = schemaWord(match[1] ?? '');
    return word === undefined ? undefined : `expected ${word}`;
  }
  match = /^Invalid option: expected one of (\S+)$/.exec(text);
  if (match !== null) {
    const words = (match[1] ?? '').split('|').map(schemaWord);
    return words.every((word) => word !== undefined) ? `expected one of ${words.join('|')}` : undefined;
  }
  match = /^Too (?:big|small): expected ([a-z]+) to (be|have) (<=|>=|<|>|exactly )(-?[0-9]+(?:\.[0-9]+)?)( [a-z]+)?$/.exec(text);
  if (match !== null) {
    const [, type = '', verb = '', operator = '', bound = '', unit = ''] = match;
    return `expected ${type} to ${verb} ${BOUND_WORDS.get(operator) ?? ''} ${bound}${unit}`;
  }
  if (text.startsWith('Invalid string: must match pattern ')) return 'expected a string matching the required pattern';
  match = /^Invalid number: must be a multiple of (-?[0-9]+(?:\.[0-9]+)?)$/.exec(text);
  return match === null ? undefined : `expected a multiple of ${match[1] ?? ''}`;
}

/** Value-free reason of an environment issue's text: its rule wording, a zod default message's expected form, else `is invalid`. */
export function envIssueReason(text: string): string {
  const reason = FIXED_ENV_REASONS.get(text) ?? zodReason(text) ?? (RULE_REASON_TEXT.test(text) ? text : undefined);
  return reason !== undefined && ENV_REASON_TEXT.test(reason) ? reason : 'is invalid';
}

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

/** `<syscall> <code>` of a Node system error, or undefined without a system code and call. */
export function systemErrorText(err: unknown): string | undefined {
  const code = stringProperty(err, 'code');
  const syscall = stringProperty(err, 'syscall');
  return code !== undefined && SYSTEM_CODE.test(code) && syscall !== undefined && SYSCALL.test(syscall) ? `${syscall} ${code}` : undefined;
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

/** `SQL Server error <number>` of an mssql RequestError carrying SQL Server's error number, else `SQL Server <failed> <code>`. */
function mssqlText(err: unknown, failed: string, code: string): string {
  const { number } = err as { number?: unknown };
  const known = failed === 'request' && typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  return known ? `SQL Server error ${String(number)}` : `SQL Server ${failed} ${code}`;
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
  const system = systemErrorText(err);
  if (system !== undefined) return system;
  // A nodemailer error's message and response may echo server replies and addresses; its code and command never do.
  const command = stringProperty(err, 'command');
  if (SYSTEM_CODE.test(code) && command !== undefined && SMTP_COMMAND_TEXT.test(command)) return `SMTP ${command} ${code}`;
  // An mssql error's message may echo SQL Server's text and query values; its class, code and error number never do.
  const failed = MSSQL_ERRORS.get(stringProperty(err, 'name') ?? '');
  if (SYSTEM_CODE.test(code) && failed !== undefined) return mssqlText(err, failed, code);
  return NAMED_CODE.test(code) ? code : REDACTED;
}

/** Message of `err` from its supplied safe text or diagnostic identifiers (SQLSTATE, system call and code, SMTP command and code, mssql error number or class and code, Node or Fastify code, gRPC status, Node's abort text), else from its nearest cause's; otherwise REDACTED. */
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
