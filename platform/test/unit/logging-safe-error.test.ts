import { once } from 'node:events';
import { SpanKind, SpanStatusCode, TraceFlags, type Attributes, type SpanStatus } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { fastify } from 'fastify';
import type { DestinationStream } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fastifyLoggerOptions } from '../../src/logging/fastify.js';
import type { LogFields } from '../../src/logging/fields.js';
import { createLogger, serializeError, type Logger } from '../../src/logging/logger.js';
import { REDACTED } from '../../src/logging/redact.js';
import { envIssueReason, isSafeErrorText, SAFE_ERROR_TEXT, safeErrorMessage, safeErrorStack, safeStackText } from '../../src/logging/safe-error.js';
import { validateLogRecord } from '../../src/logging/validate.js';
import {
  GateClosedError,
  GateConflictError,
  GateRaceError,
  OperationBlockedError,
  UnitNotAuthoritativeError,
  UnitReadBlockedError,
} from '../../src/migration-kit/gates.js';
import { ServiceUnavailableError, UnknownServiceError } from '../../src/service-kit/client.js';
import { UnpublishedEventsError } from '../../src/service-kit/context.js';
import { RecurringSlotsTombstonedError, SuccessorCreationError } from '../../src/tasks/recurring.js';
import { startSpan } from '../../src/tracing/propagation.js';
import { RedactingSpanExporter } from '../../src/tracing/redact.js';
import { flushTracing, MemorySpanExporter, shutdownTracing, startTracing, type ReadableSpan } from '../../src/tracing/sdk.js';
import { tenancyWarning } from '../../src/tenancy/warning.js';

// The secret is assembled at run time, so no literal credential appears in source; the person and phone are fictional.
const SECRET = ['opt2', 'synthetic', 'csrf'].join('-');
const TEXT = `Invalid CSRF token '${SECRET}' for patient Synthetic Ada Lovelace (phone +1-202-555-0147)`;
const LEAKS = [SECRET, 'Ada', 'Lovelace', '202-555'];
const FRAME = '    at handler (/srv/people/dist/main.js:10:5)';
const FRAME_LINE = /^\s+at \S/;
const RECORD = { type: 'ValidationError', message: TEXT, stack: `ValidationError: ${TEXT}\n${FRAME}` };
const UNAVAILABLE = 'Service identity unavailable (ECONNREFUSED)';
const UNITS = ['identity.credential', 'people.person_archive'];
const UNIT_LIST = 'identity.credential, people.person_archive';
const SWEEP = 'people-outbox-sweep';
const SLOT = `${SWEEP}-1700000040`;
const NEXT_SLOT = `${SWEEP}-1700000100`;
const OPT2_SYNC = 'Schema opt2_sync could not be created in the legacy database, so no unit may become target-authoritative';
const CHECKPOINT_MISSING = 'opt2_sync.projector_checkpoint does not exist in the live legacy database';

type LogLine = Record<string, unknown>;

/** PostgreSQL error as pg reports it: SQLSTATE `code` and `severity` beside a message echoing the input. */
function pgError(): Error {
  return Object.assign(new Error(`syntax error at or near "${TEXT}"`), { name: 'error', code: '42601', severity: 'ERROR' });
}

/** Node system error whose message carries the peer address and the text. */
function systemError(): Error {
  return Object.assign(new Error(`connect ECONNREFUSED 10.0.0.7:5432 ${TEXT}`), { code: 'ECONNREFUSED', syscall: 'connect', errno: -111 });
}

/** Fastify error whose message quotes the rejected input. */
function fastifyError(): Error {
  return Object.assign(new Error(`body/name must match pattern: ${TEXT}`), { code: 'FST_ERR_VALIDATION' });
}

/** google-gax error class: named only by its constructor. */
class GoogleError extends Error {}

/** @google-cloud/pubsub error of a paused ordering key, named only by its constructor. */
class PublishError extends Error {}

/** google-gax error with gRPC status `code` whose message, like a total-timeout error's, carries TEXT. */
function googleError(code: unknown): Error {
  return Object.assign(new GoogleError(`Total timeout of API google.pubsub.v1.Publisher exceeded 60000 milliseconds retrying error ${TEXT}`), { code });
}

/** grpc-js ServiceError as callErrorFromStatus builds it: a plain Error with `code`, free-form `details`, `metadata` and a caller stack. */
function serviceError(code: number): Error {
  const err = new Error(`${String(code)} STATUS: ${TEXT}`);
  return Object.assign(err, { code, details: TEXT, metadata: { internalRepr: new Map() }, stack: `${err.stack ?? ''}\nfor call at\n${FRAME}` });
}

/** nodemailer SMTP error: its type as `code` and the command in flight, beside a message and `response` echoing the server reply. */
function smtpError(code: string, command: string): Error {
  const response = `502 5.5.1 ${TEXT}`;
  return Object.assign(new Error(`Error upgrading connection with STARTTLS: ${response}`), { code, command, response });
}

/** mssql driver error: class `name`, driver `code` and, for a server error, SQL Server's error `number`, beside a message echoing a query value. */
function mssqlError(name: string, code: string, number?: unknown): Error {
  const message = `Conversion failed when converting the varchar value '${TEXT}' to data type int.`;
  return Object.assign(new Error(message), { name, code, number, state: 1, class: 16, lineNumber: 1, serverName: 'legacy-db', procName: '' });
}

/** `cause` wrapped in `depth` Errors whose messages carry TEXT. */
function wrapped(depth: number, cause: unknown): unknown {
  return Array.from({ length: depth }).reduce<unknown>((inner) => new Error(TEXT, { cause: inner }), cause);
}

/** Two Errors carrying TEXT, each the other's cause. */
function cyclic(): Error {
  const outer = new Error(TEXT);
  outer.cause = new Error(TEXT, { cause: outer });
  return outer;
}

/** Asserts that no part of TEXT appears in `text`. */
function expectNoLeak(text: string | undefined): void {
  for (const part of LEAKS) {
    expect(text ?? '').not.toContain(part);
  }
}

/** Asserts that `stack` is `header` followed by one or more frame lines and nothing else. */
function expectFramesUnder(stack: unknown, header: string): void {
  expect(stack).toEqual(expect.any(String));
  const [first, ...frames] = String(stack).split('\n');
  expect(first).toBe(header);
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame).toMatch(FRAME_LINE);
  }
}

/** A `trace`-level logger whose written chunks are kept in `raw`. */
function capture(): { logger: Logger; raw: string[] } {
  const raw: string[] = [];
  const destination: DestinationStream = {
    write: (chunk: string) => {
      raw.push(chunk);
    },
  };
  return { logger: createLogger({ service: 'safe-error', version: '1.0.0', env: 'local', level: 'trace', destination }), raw };
}

/** Everything an exporter could serialise from `span`. */
function serializedSpan(span: ReadableSpan | undefined): string {
  return JSON.stringify(span && { ...span, spanContext: span.spanContext(), resource: span.resource.attributes });
}

/** Finished span as an instrumentation leaves it: `statusMessage` and one exception event of `exception` attributes. */
function failedSpan(statusMessage: string, exception: Attributes): ReadableSpan {
  const spanContext = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', traceFlags: TraceFlags.SAMPLED };
  return {
    name: 'GET',
    kind: SpanKind.CLIENT,
    spanContext: () => spanContext,
    startTime: [1_700_000_000, 0],
    endTime: [1_700_000_001, 0],
    duration: [1, 0],
    ended: true,
    status: { code: SpanStatusCode.ERROR, message: statusMessage },
    attributes: {},
    links: [],
    events: [{ name: 'exception', time: [1_700_000_000, 500], attributes: exception, droppedAttributesCount: 0 }],
    resource: resourceFromAttributes({ 'service.name': 'safe-error' }),
    instrumentationScope: { name: '@opentelemetry/instrumentation-undici', version: '0.34.0' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

/** The single written line after asserting the raw output carries no part of TEXT and validates against log-record.v1. */
function safeLine(raw: string[]): LogLine {
  expect(raw).toHaveLength(1);
  expectNoLeak(raw.join(''));
  const line = JSON.parse(raw[0] ?? '') as LogLine;
  expect(validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
  return line;
}

describe('safeErrorMessage', () => {
  it.each<[string, unknown, string]>([
    ['a PostgreSQL error', pgError(), 'PostgreSQL error 42601'],
    ['a plain-object PostgreSQL error', { code: '23505', severity: 'ERROR', message: TEXT }, 'PostgreSQL error 23505'],
    ['a system error', systemError(), 'connect ECONNREFUSED'],
    ['a Fastify error', fastifyError(), 'FST_ERR_VALIDATION'],
    ['a Node error', Object.assign(new TypeError(TEXT), { code: 'ERR_INVALID_ARG_TYPE' }), 'ERR_INVALID_ARG_TYPE'],
    ['an SQLSTATE without a severity', Object.assign(new Error(TEXT), { code: '22P02' }), REDACTED],
    ['a system code with a spawn path', Object.assign(new Error(TEXT), { code: 'ENOENT', syscall: `spawn /home/ada/${SECRET}` }), REDACTED],
    ['a system code without a system call', Object.assign(new Error(TEXT), { code: 'ENOENT' }), REDACTED],
    ['a free-text code', Object.assign(new Error(TEXT), { code: TEXT }), REDACTED],
    ['a numeric code', Object.assign(new Error(TEXT), { code: 42 }), REDACTED],
    ['a plain Error', new Error(TEXT), REDACTED],
    ['an error record', RECORD, REDACTED],
    ['a thrown string', TEXT, REDACTED],
    ['null', null, REDACTED],
    ['a ServiceUnavailableError', new ServiceUnavailableError('identity', systemError()), UNAVAILABLE],
    ['a ServiceUnavailableError for an unsafe service name', new ServiceUnavailableError('Ada Lovelace', fastifyError()), 'FST_ERR_VALIDATION'],
    ['an UnknownServiceError', new UnknownServiceError('identity'), REDACTED],
    ['an error supplying a safe text', { [SAFE_ERROR_TEXT]: 'Service migration unavailable (HTTP_503)', message: TEXT }, 'Service migration unavailable (HTTP_503)'],
    ['an error supplying free text', Object.assign(new Error(TEXT), { [SAFE_ERROR_TEXT]: TEXT }), REDACTED],
    ['an error whose own identifiers precede its cause', Object.assign(new Error(TEXT, { cause: pgError() }), { code: 'FST_ERR_VALIDATION' }), 'FST_ERR_VALIDATION'],
    ['a wrapped ServiceUnavailableError', wrapped(1, new ServiceUnavailableError('identity', systemError())), UNAVAILABLE],
    ['a PostgreSQL error wrapped twice', wrapped(2, pgError()), 'PostgreSQL error 42601'],
    ['a PostgreSQL error at the cause depth bound', wrapped(4, pgError()), 'PostgreSQL error 42601'],
    ['a PostgreSQL error past the cause depth bound', wrapped(5, pgError()), REDACTED],
    ['a cause chain without identifiers', wrapped(2, TEXT), REDACTED],
    ['a cyclic cause chain', cyclic(), REDACTED],
    ['a GoogleError total timeout', googleError(4), 'gRPC status 4 DEADLINE_EXCEEDED'],
    ['a GoogleError of a missing topic', googleError(5), 'gRPC status 5 NOT_FOUND'],
    ['a GoogleError with status 0', googleError(0), 'gRPC status 0 OK'],
    ['a GoogleError with the last status', googleError(16), 'gRPC status 16 UNAUTHENTICATED'],
    ['a PublishError of a paused key', Object.assign(new PublishError(`Unable to publish for key "${TEXT}"`), { code: 7 }), 'gRPC status 7 PERMISSION_DENIED'],
    ['a grpc-js ServiceError', serviceError(14), 'gRPC status 14 UNAVAILABLE'],
    ['an Error wrapping a GoogleError', wrapped(1, googleError(4)), 'gRPC status 4 DEADLINE_EXCEEDED'],
    ['a GoogleError without a code', googleError(undefined), REDACTED],
    ['a GoogleError with a code past the last status', googleError(17), REDACTED],
    ['a GoogleError with a negative code', googleError(-1), REDACTED],
    ['a GoogleError with a fractional code', googleError(4.5), REDACTED],
    ['a GoogleError with a code as text', googleError('4'), REDACTED],
    ['an Error with a status code and details but no metadata', Object.assign(new Error(TEXT), { code: 4, details: TEXT }), REDACTED],
    ['a plain object shaped as a ServiceError', { code: 4, details: TEXT, metadata: {}, message: TEXT }, REDACTED],
    [
      'a DOMException whose code is also a gRPC status, with details and metadata',
      Object.assign(new DOMException(TEXT, 'NotFoundError'), { details: TEXT, metadata: {} }),
      REDACTED,
    ],
    ['a TimeoutError DOMException with its own message', new DOMException(TEXT, 'TimeoutError'), REDACTED],
    ['an AbortError DOMException with its own message', new DOMException(TEXT, 'AbortError'), REDACTED],
    ["a DOMException of another name with Node's abort text", new DOMException('This operation was aborted', 'NotFoundError'), REDACTED],
    ["a TimeoutError DOMException with Node's text", new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'The operation was aborted due to timeout'],
    ['the reason of an aborted signal', AbortSignal.abort().reason, 'This operation was aborted'],
    ['an Error caused by an aborted signal', new Error(TEXT, { cause: AbortSignal.abort().reason }), 'This operation was aborted'],
    ['a nodemailer STARTTLS error', smtpError('ETLS', 'STARTTLS'), 'SMTP STARTTLS ETLS'],
    ['a nodemailer AUTH error', smtpError('EAUTH', 'AUTH PLAIN'), 'SMTP AUTH PLAIN EAUTH'],
    ['a nodemailer RCPT TO error', smtpError('EENVELOPE', 'RCPT TO'), 'SMTP RCPT TO EENVELOPE'],
    ['a nodemailer socket error, by its system call', Object.assign(systemError(), { code: 'ESOCKET', command: 'CONN' }), 'connect ESOCKET'],
    ['an SMTP error of an unknown command', smtpError('ETLS', 'QUIT'), REDACTED],
    ['an SMTP error with a lower-case code', smtpError('etls', 'STARTTLS'), REDACTED],
    ['an SMTP error whose command carries an address', smtpError('EENVELOPE', 'RCPT TO:<ada@example.com>'), REDACTED],
    ['an SMTP error with an over-long mechanism name', smtpError('EAUTH', `AUTH ${'X'.repeat(21)}`), REDACTED],
    [
      'an OperationBlockedError with a caller message',
      new OperationBlockedError(UNITS, `Operation ${SECRET} keeps ${TEXT} closed`),
      `Open operation or closed gate blocks ${UNIT_LIST}`,
    ],
    ['a gate error without units', new UnitNotAuthoritativeError([]), REDACTED],
    ['a gate error naming a non-unit', new GateClosedError(['Ada Lovelace']), REDACTED],
    ['a gate error naming an email among units', new GateConflictError(['identity.credential', 'ada@example.com']), REDACTED],
    ['an error forging a gate text over a name', { [SAFE_ERROR_TEXT]: 'Target is not write-authoritative for Ada Lovelace', message: TEXT }, REDACTED],
    ['an error forging a gate text over an email', { [SAFE_ERROR_TEXT]: 'Unit gate closed for ada@example.com', message: TEXT }, REDACTED],
    ["a SuccessorCreationError, keeping its cause's PostgreSQL text", new SuccessorCreationError(SWEEP, SLOT, pgError()), 'PostgreSQL error 42601'],
    ['an mssql RequestError of a SQL Server error', mssqlError('RequestError', 'EREQUEST', 245), 'SQL Server error 245'],
    ['an mssql RequestError of SQL Server error 0', mssqlError('RequestError', 'EREQUEST', 0), 'SQL Server error 0'],
    ['an mssql request timeout, whose number is its code', mssqlError('RequestError', 'ETIMEOUT', 'ETIMEOUT'), 'SQL Server request ETIMEOUT'],
    ['an mssql cancelled request', mssqlError('RequestError', 'ECANCEL'), 'SQL Server request ECANCEL'],
    ['an mssql ConnectionError', mssqlError('ConnectionError', 'ESOCKET'), 'SQL Server connection ESOCKET'],
    ['an mssql TransactionError', mssqlError('TransactionError', 'EABORT'), 'SQL Server transaction EABORT'],
    ['an Error wrapping an mssql RequestError', wrapped(1, mssqlError('RequestError', 'EREQUEST', 208)), 'SQL Server error 208'],
    ['an mssql RequestError with a negative number', mssqlError('RequestError', 'EREQUEST', -1), 'SQL Server request EREQUEST'],
    ['an mssql RequestError with a fractional number', mssqlError('RequestError', 'EREQUEST', 208.5), 'SQL Server request EREQUEST'],
    ['an mssql ConnectionError with an error number', mssqlError('ConnectionError', 'ELOGIN', 18456), 'SQL Server connection ELOGIN'],
    ['an mssql RequestError with a free-text code', mssqlError('RequestError', TEXT, 245), REDACTED],
    ['an mssql RequestError with a lower-case code', mssqlError('RequestError', 'erequest', 245), REDACTED],
    ['an mssql RequestError without a code', Object.assign(new Error(TEXT), { name: 'RequestError', number: 245 }), REDACTED],
    ['an error of another class with an SQL Server error number', mssqlError('Error', 'EREQUEST', 245), REDACTED],
    ['an error forging an SQL Server text', { [SAFE_ERROR_TEXT]: `SQL Server error 245 for ${SECRET}`, message: TEXT }, REDACTED],
    [
      'an UnpublishedEventsError, by its event count',
      new UnpublishedEventsError(['0f7c6a52-0c8e-4d8e-9a43-000000000001', '0f7c6a52-0c8e-4d8e-9a43-000000000002']),
      'Outbox publish of 2 committed event(s) incomplete before the answer; left to the sweep',
    ],
  ])('reduces %s to its identifiers', (_, err, expected) => {
    expect(safeErrorMessage(err)).toBe(expected);
    expect(isSafeErrorText(expected)).toBe(true);
  });
});

describe('isSafeErrorText', () => {
  it.each<[string, boolean]>([
    [REDACTED, true],
    ['PostgreSQL error 42601', true],
    ['connect ECONNREFUSED', true],
    ['getaddrinfo ENOTFOUND', true],
    ['FST_ERR_VALIDATION', true],
    ['ERR_INVALID_URL', true],
    ["PostgreSQL error of type 'error' occurred (code: 42601)", true],
    [TEXT, false],
    ['', false],
    ['connect ECONNREFUSED 10.0.0.7:5432', false],
    ['PostgreSQL error 42601 for Ada Lovelace', false],
    ["PostgreSQL error of type 'Ada Lovelace' occurred (code: 42601)", false],
    ["PostgreSQL error of type 'error' occurred (code: UNKNOWN)", false],
    [`${REDACTED} Ada`, false],
    [UNAVAILABLE, true],
    ['Service programs-sites unavailable (UND_ERR_CONNECT_TIMEOUT)', true],
    ['Service migration unavailable (HTTP_503)', true],
    ['Service identity-platform unavailable (TimeoutError)', true],
    ['Service echo unavailable (AbortError)', true],
    ['Service echo unavailable (Error)', true],
    ['Service echo unavailable (unknown)', true],
    ['Service Identity unavailable (ECONNREFUSED)', false],
    ['Service ada lovelace unavailable (ECONNREFUSED)', false],
    ['Service ada@example.com unavailable (ECONNREFUSED)', false],
    ['Service identity unavailable (connect ECONNREFUSED 10.0.0.7:8111)', false],
    ['Service identity unavailable (Ada)', false],
    ['Service identity unavailable (HTTP_5030)', false],
    ['Service identity unavailable ()', false],
    [`${UNAVAILABLE} for Ada`, false],
    ['Database unavailable (ECONNREFUSED)', true],
    ['Database unavailable (57P01)', true],
    ['Database unavailable (08006)', true],
    ['Database unavailable (connect ECONNREFUSED 10.0.0.7:5432)', false],
    ['Database unavailable (Ada)', false],
    ['Database unavailable ()', false],
    ['gRPC status 4 DEADLINE_EXCEEDED', true],
    ['gRPC status 0 OK', true],
    ['gRPC status 16 UNAUTHENTICATED', true],
    ['The operation was aborted due to timeout', true],
    ['This operation was aborted', true],
    ['gRPC status 4 NOT_FOUND', false],
    ['gRPC status 17 UNKNOWN', false],
    ['gRPC status 04 DEADLINE_EXCEEDED', false],
    ['gRPC status 4 DEADLINE_EXCEEDED: Ada', false],
    ['gRPC status 4', false],
    ['The operation was aborted due to timeout for Ada', false],
    ['this operation was aborted', false],
    [`Unit gate closed for ${UNIT_LIST}`, true],
    ['Unit gate race for stub.note', true],
    ['Target is not write-authoritative for toauthtokens.data', true],
    ['Legacy write window in progress for communications.scheduled_task', true],
    ['Open operation or closed gate blocks synthetic.survey_schedule', true],
    ['Unit gate compare-and-set refused for programs_sites.image_size', true],
    ['Target is not write-authoritative for ', false],
    ['Target is not write-authoritative for', false],
    ['Unit gate closed for Ada Lovelace', false],
    ['Unit gate closed for ada@example.com', false],
    ['Unit gate closed for identity.credential,people.person_archive', false],
    ['Unit gate closed for identity.credential, ', false],
    ['Unit gate closed for Identity.credential', false],
    ['Unit gate closed for identity.credential; the write waited out its budget', false],
    ['Unit gate opened for identity.credential', false],
    [`No live chain task on queue ${SWEEP}: tombstoned slots ${SLOT}, ${NEXT_SLOT}`, true],
    ['Could not create successor task programs-sites-sitemonitor-1700000100 on queue programs-sites-sitemonitor', false],
    [`No live chain task on queue ${SWEEP}: tombstoned slots `, false],
    [`No live chain task on queue ${SWEEP}: tombstoned slots ${SWEEP}`, false],
    [`No live chain task on queue ${SWEEP}: tombstoned slots ${SLOT},${NEXT_SLOT}`, false],
    ['Outbox publish of 1 committed event(s) incomplete before the answer; left to the sweep', true],
    ['Outbox publish of 12 committed event(s) incomplete before the answer; left to the sweep', true],
    ['Outbox publish of 0 committed event(s) incomplete before the answer; left to the sweep', false],
    ['Outbox publish of Ada committed event(s) incomplete before the answer; left to the sweep', false],
    ['Outbox publish of 2 committed event(s) incomplete before the answer; left to the sweep for Ada', false],
    ['SMTP STARTTLS ETLS', true],
    ['SMTP AUTH CRAM-MD5 EAUTH', true],
    ['SMTP MAIL FROM EENVELOPE', true],
    ['SMTP CONN ETIMEDOUT', true],
    ['SMTP QUIT ETLS', false],
    ['SMTP STARTTLS etls', false],
    ['SMTP RCPT TO:<ada@example.com> EENVELOPE', false],
    ['SMTP AUTH EAUTH', false],
    ['SMTP STARTTLS ETLS: 502 5.5.1', false],
    ['people: invalid environment (PG_PORT: expected number; LOG_LEVEL: expected one of fatal|error|warn|info|debug|trace)', true],
    ['invalid environment (OPT2_SERVICE_URLS: must be a JSON object)', true],
    ['people: invalid environment', true],
    ['identity: invalid environment (OPT2_SERVICE_URLS.strategies-content: is required; OPT2_GATEWAY_URL: is required (or OPT2_SERVICE_URLS.gateway))', true],
    ['stub: invalid environment (TZ: must be an IANA time zone name that this process applies, such as UTC or America/New_York)', true],
    ['people: invalid environment (PG_PASSWORD: must be unset when OPT2_DB_AUTH=iam; OPT2_TASKS_ADAPTER: must equal OPT2_ENV; PG_HOST: is invalid)', true],
    ['people: invalid environment (OPT2_ENV: must be local when OPT2_DB_AUTH=password; PG_USER: is required when OPT2_DB_AUTH=password)', true],
    ['people: invalid environment (PG_PORT: expected number to be at most 65535; OPT2_JWKS_URL: expected an http(s) URL)', true],
    ['people: invalid environment (PG_PORT, LOG_LEVEL)', false],
    ['invalid environment (OPT2_SERVICE_URLS)', false],
    ['people: invalid environment (OPT2_SERVICE_URLS.People: is required)', false],
    ['people: invalid environment (OPT2_SERVICE_URLS.: is required)', false],
    ['people: invalid environment (PG_PORT: is invalid) for Ada', false],
    ['people: invalid environment\n  PG_HOST: Ada', false],
    ['People: invalid environment (PG_PORT: is invalid)', false],
    ['people: invalid environment (pg_port: is invalid)', false],
    ['people: invalid environment (PG_PORT: is invalid;LOG_LEVEL: is invalid)', false],
    ['people: invalid environment (PG_PORT: is invalid, LOG_LEVEL: is invalid)', false],
    ['people: invalid environment ()', false],
    ['people: invalid environment (PG_HOST: )', false],
    ['people: invalid environment (PG_HOST: Ada Lovelace)', false],
    ['people: invalid environment (PG_HOST: connect postgres://svc:x@db refused)', false],
    ['people: invalid environment (PG_HOST: must be ada@example.com)', false],
    [`people: invalid environment (PG_HOST: must be "${SECRET}")`, false],
    ['people: invalid environment (PG_HOST: must be key=value)', false],
    ['people: invalid environment (PG_HOST: is required when OPT2_ENV=Ada Lovelace)', false],
    ['people: invalid environment (OPT2_GATEWAY_URL: is required (or OPT2_SERVICE_URLS.Gateway))', false],
    [`people: invalid environment (TZ: must be ${'a'.repeat(161)})`, false],
    ['stub: cannot read OPT2_STATE_DIR file secrets/token-signing-public.pem (open ENOENT)', true],
    ['cannot read OPT2_CUTOVER_DIR file versions/v0001.json (open EACCES)', true],
    ['cannot read OPT2_STATE_DIR file secrets/storage-hmac-key', true],
    ['cannot read OPT2_STATE_DIR file .opt2/key (read EISDIR)', true],
    ['cannot read OPT2_STATE_DIR file ../secrets/key (open ENOENT)', false],
    ['cannot read OPT2_STATE_DIR file secrets/../../etc/passwd', false],
    ['cannot read OPT2_STATE_DIR file ./secrets/key', false],
    ['cannot read OPT2_STATE_DIR file /home/ada/secrets/key', false],
    ['cannot read OPT2_STATE_DIR file secrets//key', false],
    ['cannot read OPT2_STATE_DIR file secrets/ada lovelace', false],
    ['cannot read OPT2_STATE_DIR file secrets/key (ENOENT)', false],
    ['cannot read OPT2_STATE_DIR file secrets/key (open ENOENT) for Ada', false],
    ['cannot read opt2_state_dir file secrets/key', false],
    ['Stub: cannot read OPT2_STATE_DIR file secrets/key', false],
    ['identity: invalid configuration file role-map.json', true],
    ['invalid configuration file role-map.json', true],
    ['identity: invalid configuration file config/role-map.json', false],
    ['identity: invalid configuration file role-map.json: Unexpected token', false],
    ['Identity: invalid configuration file role-map.json', false],
    ['identity: invalid configuration file role-map', false],
    ['identity: invalid configuration file Role-Map.json', false],
    ['SQL Server error 208', true],
    ['SQL Server request ETIMEOUT', true],
    ['SQL Server connection ESOCKET', true],
    ['SQL Server transaction ENOTBEGUN', true],
    ['SQL Server error', false],
    ['SQL Server error -1', false],
    ["SQL Server error 208: Invalid object name 'opt2_sync.projector_checkpoint'.", false],
    ['SQL Server statement EREQUEST', false],
    ['SQL Server connection esocket', false],
    ['SQL Server connection ESOCKET 127.0.0.1:1433', false],
    [`${OPT2_SYNC}: SQL Server error 262`, true],
    [`${OPT2_SYNC}: ${CHECKPOINT_MISSING}`, true],
    [`${OPT2_SYNC}: CREATE SCHEMA permission denied in database 'muradb'.`, false],
    [`${OPT2_SYNC}: opt2_sync.projector_checkpoint does not exist in database muradb`, false],
    [`${OPT2_SYNC}: SQL Server error 262 for Ada`, false],
    [`${OPT2_SYNC}: `, false],
    [OPT2_SYNC, false],
    ['Projection of programs-sites=900 was not applied in legacy within 600 ms', true],
    ['Projection of e-signature=7,timesheets=18446744073709551614 was not applied in legacy within 5000 ms', true],
    ['Projection of  was not applied in legacy within 5000 ms', true],
    ['Projection of Ada Lovelace=900 was not applied in legacy within 600 ms', false],
    ['Projection of people=900, timesheets=7 was not applied in legacy within 600 ms', false],
    ['Projection of people=Ada was not applied in legacy within 600 ms', false],
    ['Projection of people=900 was not applied in legacy within 1.5 ms', false],
    ['Projection of people=900 was not applied in legacy within 600 ms for Ada', false],
    ['Projection of programs-sites=802 is quarantined: legacy could not take the write', true],
    ['Projection of e-signature=7,timesheets=18446744073709551614 is quarantined: legacy could not take the write', true],
    ['Projection of  is quarantined: legacy could not take the write', false],
    ['Projection of Ada Lovelace=802 is quarantined: legacy could not take the write', false],
    ['Projection of people=802 is quarantined: legacy could not take the write for Ada', false],
  ])('judges %j as %s', (text, safe) => {
    expect(isSafeErrorText(text)).toBe(safe);
  });
});

describe('envIssueReason', () => {
  it.each<[string, string]>([
    ['is required', 'is required'],
    ['is required when OPT2_ENV=local', 'is required when OPT2_ENV=local'],
    ['is required (or OPT2_SERVICE_URLS.migration)', 'is required (or OPT2_SERVICE_URLS.migration)'],
    ['must be unset when OPT2_ENV=cloud', 'must be unset when OPT2_ENV=cloud'],
    ['must equal OPT2_ENV', 'must equal OPT2_ENV'],
    ['must be web', 'must be web'],
    ['must be cloud when OPT2_DB_AUTH=iam', 'must be cloud when OPT2_DB_AUTH=iam'],
    ['must be an absolute path', 'must be an absolute path'],
    ['must be outside the repository checkout', 'must be outside the repository checkout'],
    ['OPT2_SERVICE_URLS must be a JSON object', 'must be a JSON object'],
    ['port must be from 1 to 65535', 'must be a port from 1 to 65535'],
    ['Invalid input: expected number, received NaN', 'expected number'],
    ['Invalid input: expected int, received number', 'expected int'],
    ['Invalid input: expected record, received array', 'expected record'],
    ['Invalid input: expected "web"', 'expected web'],
    ['Invalid input: expected true', 'expected true'],
    ['Invalid option: expected one of "local"|"cloud"', 'expected one of local|cloud'],
    ['Too big: expected number to be <=65535', 'expected number to be at most 65535'],
    ['Too small: expected number to be >=1', 'expected number to be at least 1'],
    ['Too small: expected number to be >0', 'expected number to be above 0'],
    ['Too big: expected number to be <10', 'expected number to be below 10'],
    ['Too small: expected string to have >=3 characters', 'expected string to have at least 3 characters'],
    ['Too big: expected array to have exactly 2 items', 'expected array to have exactly 2 items'],
    ['Invalid URL', 'expected an http(s) URL'],
    ['Invalid string: must match pattern /^[a-z][a-z0-9-]*$/', 'expected a string matching the required pattern'],
    ['Invalid key in record', 'expected valid record keys'],
    ['Invalid number: must be a multiple of 0.5', 'expected a multiple of 0.5'],
    ['Invalid input', 'is invalid'],
    ['Unrecognized key: "ada@example.com"', 'is invalid'],
    ['Invalid option: expected one of "Ada Lovelace"|"cloud"', 'is invalid'],
    ['Invalid input: expected "Ada"', 'is invalid'],
    [`Invalid option: expected one of ${Array.from({ length: 40 }, (_, i) => `"option${String(i)}"`).join('|')}`, 'is invalid'],
    ['must be blank or a path from / or \\', 'is invalid'],
    [TEXT, 'is invalid'],
    ['', 'is invalid'],
  ])('maps %j to %j', (text, reason) => {
    expect(envIssueReason(text)).toBe(reason);
  });
});

describe('safeErrorStack', () => {
  const HEADER = `Error: ${REDACTED}`;

  it.each<[string, () => Error]>([
    ['a message with forged frame lines', () => new Error(`${TEXT}\n    at Ada (Lovelace)\n    at fake (+1-202-555-0147)`)],
    [
      'a message changed after the stack was captured',
      () => {
        const err = new Error(`first ${TEXT}`);
        err.message = 'second';
        return err;
      },
    ],
    ['a stack with non-frame lines after the message', () => Object.assign(new Error(TEXT), { stack: `Error: ${TEXT}\nCaused by: ${TEXT}\n${FRAME}` })],
    ['a short message that also occurs in the error name', () => Object.assign(new Error('E'), { stack: `Error: E ${TEXT}\n${FRAME}` })],
  ])('keeps only the frames of %s', (_, make) => {
    const stack = safeErrorStack(make(), HEADER);

    expectFramesUnder(stack, HEADER);
    expectNoLeak(stack);
    expect(stack).not.toContain('fake');
  });

  it('masks credentials inside frame lines', () => {
    const err = Object.assign(new Error('x'), { stack: `Error: x\n    at fetch (https://h.example.test/x?token=${SECRET})` });

    const stack = safeErrorStack(err, HEADER);

    expect(stack).toContain(`${HEADER}\n    at fetch (https://h.example.test/x?token=${REDACTED}`);
    expect(stack).not.toContain(SECRET);
  });

  it.each<[string, unknown]>([
    ['an Error without a stack', Object.assign(new Error(TEXT), { stack: undefined })],
    ['a thrown string', TEXT],
    ['null', null],
  ])('returns undefined for %s', (_, err) => {
    expect(safeErrorStack(err, HEADER)).toBeUndefined();
  });

  it('reduces stack text to the header and its frame lines', () => {
    expect(safeStackText(`Error: ${TEXT}\n${FRAME}\n${TEXT}`, HEADER)).toBe(`${HEADER}\n${FRAME}`);
  });
});

describe('serializeError safe-error boundary', () => {
  it.each<[string, unknown]>([
    ['an Error', new Error(TEXT)],
    ['a PostgreSQL error', pgError()],
    ['an error record', RECORD],
    ['an error record with a credential type', { ...RECORD, type: `Bearer ${SECRET}` }],
    ['a thrown string', TEXT],
    ['an Error with forged frame lines', new Error(`${TEXT}\n    at fake (x)`)],
  ])('serializes %s without its text and is idempotent on the record', (_, value) => {
    const record = serializeError(value);

    expectNoLeak(JSON.stringify(record));
    expect(serializeError(record)).toStrictEqual(record);
    expect(serializeError(serializeError(record))).toStrictEqual(record);
  });

  it.each<[string, unknown, string, string]>([
    ['a ServiceUnavailableError', new ServiceUnavailableError('identity', systemError()), 'ServiceUnavailableError', UNAVAILABLE],
    [
      'an unavailability caused by a ServiceUnavailableError',
      Object.assign(new Error(TEXT, { cause: new ServiceUnavailableError('identity', systemError()) }), { name: 'SiteMonitorUnavailableError' }),
      'SiteMonitorUnavailableError',
      UNAVAILABLE,
    ],
    ['an Error caused by a PostgreSQL error', wrapped(1, pgError()), 'Error', 'PostgreSQL error 42601'],
    ['a GoogleError', googleError(4), 'GoogleError', 'gRPC status 4 DEADLINE_EXCEEDED'],
    ['a grpc-js ServiceError', serviceError(5), 'Error', 'gRPC status 5 NOT_FOUND'],
    ['the reason of an aborted signal', AbortSignal.abort().reason, 'AbortError', 'This operation was aborted'],
    ['a GateClosedError', new GateClosedError(UNITS), 'GateClosedError', `Unit gate closed for ${UNIT_LIST}`],
    [
      'a GateRaceError with a caller message',
      new GateRaceError(UNITS, `Legacy write window in progress for ${TEXT}`),
      'GateRaceError',
      `Unit gate race for ${UNIT_LIST}`,
    ],
    [
      'a UnitNotAuthoritativeError',
      new UnitNotAuthoritativeError(['identity.credential']),
      'UnitNotAuthoritativeError',
      'Target is not write-authoritative for identity.credential',
    ],
    ['a UnitReadBlockedError', new UnitReadBlockedError(UNITS), 'UnitReadBlockedError', `Legacy write window in progress for ${UNIT_LIST}`],
    [
      'an OperationBlockedError with a caller message',
      new OperationBlockedError(UNITS, `Operation ${SECRET} cannot start: ${TEXT}`),
      'OperationBlockedError',
      `Open operation or closed gate blocks ${UNIT_LIST}`,
    ],
    ['a GateConflictError', new GateConflictError(UNITS), 'GateConflictError', `Unit gate compare-and-set refused for ${UNIT_LIST}`],
    [
      'a RecurringSlotsTombstonedError',
      new RecurringSlotsTombstonedError(SWEEP, [SLOT, NEXT_SLOT]),
      'RecurringSlotsTombstonedError',
      `No live chain task on queue ${SWEEP}: tombstoned slots ${SLOT}, ${NEXT_SLOT}`,
    ],
    [
      "a SuccessorCreationError, keeping its cause's gRPC status",
      new SuccessorCreationError(SWEEP, SLOT, googleError(14)),
      'SuccessorCreationError',
      'gRPC status 14 UNAVAILABLE',
    ],
    ['a nodemailer SMTP error', smtpError('ETLS', 'STARTTLS'), 'Error', 'SMTP STARTTLS ETLS'],
    ['an mssql RequestError', mssqlError('RequestError', 'EREQUEST', 245), 'RequestError', 'SQL Server error 245'],
    ['an mssql ConnectionError', mssqlError('ConnectionError', 'ESOCKET'), 'ConnectionError', 'SQL Server connection ESOCKET'],
  ])('serializes %s with the safe text of its chain, the outer type and only frames, and keeps it on re-serialization', (_, value, type, message) => {
    const record = serializeError(value);
    const { stack, ...fields } = record;

    expect(fields).toStrictEqual({ type, message });
    expectFramesUnder(stack, `${type}: ${message}`);
    expectNoLeak(JSON.stringify(record));
    expect(serializeError(record)).toStrictEqual(record);
  });
});

describe('createLogger safe-error boundary', () => {
  it.each<[string, (logger: Logger, err: Error) => void | Promise<void>, string, string, string | undefined]>([
    ['an Error', (logger, err) => logger.error(err), REDACTED, 'Error', `Error: ${REDACTED}`],
    ['err', (logger, err) => logger.error({ err } as LogFields), REDACTED, 'Error', `Error: ${REDACTED}`],
    ['an error record', (logger) => logger.error({ error: RECORD }), REDACTED, 'ValidationError', `ValidationError: ${REDACTED}`],
    ['a thrown string', (logger) => logger.error({ error: TEXT as unknown as Error }), REDACTED, 'string', undefined],
    ['err with its message', (logger, err) => logger.error({ err } as LogFields, err.message), REDACTED, 'Error', `Error: ${REDACTED}`],
    [
      'err with an interpolated message',
      (logger, err) => logger.error({ err } as LogFields, 'failed: %s', err.message),
      `failed: ${REDACTED}`,
      'Error',
      `Error: ${REDACTED}`,
    ],
    [
      'err with a template message',
      (logger, err) => logger.error({ err } as LogFields, `failed: ${err.message}`),
      `failed: ${REDACTED}`,
      'Error',
      `Error: ${REDACTED}`,
    ],
    [
      'a thrown string with its text interpolated',
      (logger) => logger.error({ error: TEXT as unknown as Error }, 'failed: %s', TEXT),
      `failed: ${REDACTED}`,
      'string',
      undefined,
    ],
    ['an error in child bindings', (logger, err) => logger.child({ error: err }).error('bound'), 'bound', 'Error', `Error: ${REDACTED}`],
    [
      'err from a Fastify error handler',
      async (logger, err) => {
        const app = fastify(fastifyLoggerOptions(logger));
        app.setErrorHandler<Error>((thrown, request, reply) => {
          request.log.error({ req: request, res: reply, err: thrown }, thrown.message);
          return reply.code(500).send({ error: 'internal' });
        });
        app.get('/boom', () => {
          throw err;
        });
        try {
          await app.inject({ method: 'GET', url: '/boom' });
        } finally {
          await app.close();
        }
      },
      REDACTED,
      'Error',
      `Error: ${REDACTED}`,
    ],
  ])('logs %s without the error text', async (_, log, message, type, header) => {
    const { logger, raw } = capture();

    await log(logger, new Error(TEXT));

    const line = safeLine(raw);
    expect(line.message).toBe(message);
    expect(line.error).toMatchObject({ type, message: REDACTED });
    if (header === undefined) {
      expect(line.error).not.toHaveProperty('stack');
    } else {
      expectFramesUnder((line.error as { stack?: string }).stack, header);
    }
  });

  it.each<[string, (logger: Logger, err: Error) => void, string]>([
    ['a format argument', (logger, err) => logger.error('failed: %s', err), `failed: ${REDACTED}`],
    ['the message beside fields', (logger, err) => logger.error({ route: '/r' }, err as unknown as string), REDACTED],
  ])('writes an Error passed as %s as its safe message', (_, log, message) => {
    const { logger, raw } = capture();

    log(logger, new Error(TEXT));

    expect(safeLine(raw).message).toBe(message);
  });

  it.each<[string, () => Error, string, string]>([
    ['a PostgreSQL error', pgError, 'error', 'PostgreSQL error 42601'],
    ['a system error', systemError, 'Error', 'connect ECONNREFUSED'],
    ['a Fastify error', fastifyError, 'Error', 'FST_ERR_VALIDATION'],
    ['a ServiceUnavailableError', () => new ServiceUnavailableError('identity', systemError()), 'ServiceUnavailableError', UNAVAILABLE],
    ['a GoogleError', () => googleError(7), 'GoogleError', 'gRPC status 7 PERMISSION_DENIED'],
    ['a grpc-js ServiceError', () => serviceError(4), 'Error', 'gRPC status 4 DEADLINE_EXCEEDED'],
  ])('keeps the identifiers of %s', (_, make, type, identifier) => {
    const { logger, raw } = capture();

    logger.error(make());

    const line = safeLine(raw);
    expect(line).toMatchObject({ message: identifier, error: { type, message: identifier } });
    expectFramesUnder((line.error as { stack?: string }).stack, `${type}: ${identifier}`);
  });

  it("keeps Node's text of a timed-out signal's reason in a serialized record the logger writes again", async () => {
    const signal = AbortSignal.timeout(1);
    await once(signal, 'abort');
    const record = serializeError(signal.reason);
    const { logger, raw } = capture();

    logger.error({ error: record }, 'outbox publish failed');

    expect(record).toMatchObject({ type: 'TimeoutError', message: 'The operation was aborted due to timeout' });
    expectFramesUnder(record.stack, 'TimeoutError: The operation was aborted due to timeout');
    expect(serializeError(record)).toStrictEqual(record);
    expect(safeLine(raw)).toMatchObject({ message: 'outbox publish failed', error: record });
  });
});

describe('tracing safe-error boundary', () => {
  const exporter = new MemorySpanExporter();

  beforeAll(async () => {
    await startTracing({ serviceName: 'safe-error', version: '1.0.0', exporter });
  });

  afterAll(async () => {
    await shutdownTracing();
  });

  it.each<[string, () => unknown, string | undefined, string]>([
    ['an Error', () => new Error(TEXT), 'Error', REDACTED],
    ['a PostgreSQL error', pgError, '42601', 'PostgreSQL error 42601'],
    ['a system error', systemError, 'ECONNREFUSED', 'connect ECONNREFUSED'],
    ['a ServiceUnavailableError', () => new ServiceUnavailableError('identity', systemError()), 'ServiceUnavailableError', UNAVAILABLE],
    ['a thrown string', () => TEXT, undefined, REDACTED],
  ])('exports a startSpan that throws %s without the error text', async (_, make, type, message) => {
    exporter.reset();
    const thrown = make();

    await expect(
      startSpan('fail', SpanKind.INTERNAL, () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    await flushTracing();

    const [span] = exporter.getFinishedSpans();
    expectNoLeak(serializedSpan(span));
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    const attributes = span?.events[0]?.attributes ?? {};
    expect(attributes['exception.type']).toBe(type);
    expect(attributes['exception.message']).toBe(message);
    if (type === undefined) {
      expect(attributes).not.toHaveProperty('exception.stacktrace');
    } else {
      expectFramesUnder(attributes['exception.stacktrace'], `${type}: ${message}`);
    }
  });

  it.each<[string, string, Attributes, SpanStatus, Attributes]>([
    [
      'an HTTP client failure',
      `connect ECONNREFUSED 10.0.0.7:8112 ${TEXT}`,
      {
        'exception.type': 'ECONNREFUSED',
        'exception.message': `connect ECONNREFUSED 10.0.0.7:8112 ${TEXT}`,
        'exception.stacktrace': `Error: connect ECONNREFUSED 10.0.0.7:8112 ${TEXT}\n${FRAME}`,
      },
      { code: SpanStatusCode.ERROR, message: REDACTED },
      { 'exception.type': 'ECONNREFUSED', 'exception.message': REDACTED, 'exception.stacktrace': `ECONNREFUSED: ${REDACTED}\n${FRAME}` },
    ],
    [
      'a multi-line exception message',
      TEXT,
      { 'exception.type': 'Error', 'exception.message': `${TEXT}\nAda Lovelace`, 'exception.stacktrace': `Error: ${TEXT}\nAda Lovelace\n${FRAME}` },
      { code: SpanStatusCode.ERROR, message: REDACTED },
      { 'exception.type': 'Error', 'exception.message': REDACTED, 'exception.stacktrace': `Error: ${REDACTED}\n${FRAME}` },
    ],
    [
      'a pg query failure',
      `syntax error at or near "${TEXT}"`,
      { 'exception.message': "PostgreSQL error of type 'error' occurred (code: 42601)" },
      { code: SpanStatusCode.ERROR, message: REDACTED },
      { 'exception.message': "PostgreSQL error of type 'error' occurred (code: 42601)" },
    ],
    [
      'a safe status message',
      'connect ECONNREFUSED',
      { 'exception.type': 'ECONNREFUSED', 'exception.stacktrace': `Error: ${TEXT}\n${FRAME}` },
      { code: SpanStatusCode.ERROR, message: 'connect ECONNREFUSED' },
      { 'exception.type': 'ECONNREFUSED', 'exception.stacktrace': `ECONNREFUSED: ${REDACTED}\n${FRAME}` },
    ],
  ])('exports %s recorded by an instrumentation without the error text', (_, statusMessage, exception, status, expected) => {
    const memory = new MemorySpanExporter();

    new RedactingSpanExporter(memory).export([failedSpan(statusMessage, exception)], () => undefined);

    const [copy] = memory.getFinishedSpans();
    expectNoLeak(serializedSpan(copy));
    expect(copy?.status).toEqual(status);
    expect(copy?.events[0]?.attributes).toEqual(expected);
  });
});

describe('tenancy warning safe-error boundary', () => {
  const PREFIX = 'Commit callback error handler failed: ';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<[string, () => unknown, string, string | undefined]>([
    ['an Error', () => new Error(TEXT), REDACTED, String.raw`Error: [REDACTED]\n    at `],
    ['a PostgreSQL error', pgError, 'PostgreSQL error 42601', 'error: PostgreSQL error 42601'],
    ['a system error', systemError, 'connect ECONNREFUSED', 'Error: connect ECONNREFUSED'],
    ['a thrown string', () => TEXT, REDACTED, undefined],
    ['an error record', () => RECORD, REDACTED, String.raw`object: [REDACTED]\n${FRAME}`],
    [
      'an Error whose frames hold control characters',
      () => Object.assign(new Error(TEXT), { stack: `Error: ${TEXT}\n    at f\u001b[31m (x\u2028y)\t` }),
      REDACTED,
      String.raw`Error: [REDACTED]\n    at f\u001b[31m (x\u2028y)\t`,
    ],
  ])('emits %s as a one-line warning without the error text', (_, make, message, detail) => {
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    tenancyWarning(PREFIX)(make());

    expect(emitWarning).toHaveBeenCalledOnce();
    const [text, options] = emitWarning.mock.calls[0] ?? [];
    expect(text).toBe(`${PREFIX}${message}`);
    expect(options?.code).toBe('OPT2_TENANCY');
    if (detail === undefined) {
      expect(options?.detail).toBeUndefined();
    } else {
      expect(options?.detail?.startsWith(detail)).toBe(true);
    }
    expect(options?.detail ?? '').not.toMatch(/[\p{Cc}\u2028\u2029]/u);
    expectNoLeak(`${String(text)}${options?.detail ?? ''}`);
  });
});
