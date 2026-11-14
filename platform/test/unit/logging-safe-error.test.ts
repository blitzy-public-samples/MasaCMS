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
import { isSafeErrorText, SAFE_ERROR_TEXT, safeErrorMessage, safeErrorStack, safeStackText } from '../../src/logging/safe-error.js';
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
    ['SMTP STARTTLS ETLS', true],
    ['SMTP AUTH CRAM-MD5 EAUTH', true],
    ['SMTP MAIL FROM EENVELOPE', true],
    ['SMTP CONN ETIMEDOUT', true],
    ['SMTP QUIT ETLS', false],
    ['SMTP STARTTLS etls', false],
    ['SMTP RCPT TO:<ada@example.com> EENVELOPE', false],
    ['SMTP AUTH EAUTH', false],
    ['SMTP STARTTLS ETLS: 502 5.5.1', false],
    ['people: invalid environment (PG_PORT, LOG_LEVEL)', true],
    ['invalid environment (OPT2_SERVICE_URLS)', true],
    ['people: invalid environment', true],
    ['identity: invalid environment (OPT2_SERVICE_URLS.strategies-content, OPT2_GATEWAY_URL)', true],
    ['people: invalid environment (OPT2_SERVICE_URLS.People)', false],
    ['people: invalid environment (OPT2_SERVICE_URLS.)', false],
    ['people: invalid environment (PG_PORT) for Ada', false],
    ['people: invalid environment\n  PG_HOST: Ada', false],
    ['People: invalid environment (PG_PORT)', false],
    ['people: invalid environment (pg_port)', false],
    ['people: invalid environment (PG_PORT,LOG_LEVEL)', false],
    ['people: invalid environment ()', false],
    ['identity: invalid configuration file role-map.json', true],
    ['invalid configuration file role-map.json', true],
    ['identity: invalid configuration file config/role-map.json', false],
    ['identity: invalid configuration file role-map.json: Unexpected token', false],
    ['Identity: invalid configuration file role-map.json', false],
    ['identity: invalid configuration file role-map', false],
    ['identity: invalid configuration file Role-Map.json', false],
  ])('judges %j as %s', (text, safe) => {
    expect(isSafeErrorText(text)).toBe(safe);
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
