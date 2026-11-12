// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting fixture envelope, error map and error mapping against legacy-fixtures/cfml/lib/envelope.cfc, api.cfm and modules/reporting.cfc. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AuthDenial } from '@opt2/platform/auth';
import {
  cfHash,
  LEGACY_ERROR_MAP,
  LEGACY_JSON_CONTENT_TYPE,
  LegacyApiError,
  LegacyServiceUnavailableError,
  WWW_AUTHENTICATE,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import { UnitNotAuthoritativeError } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type FastifyRequest } from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { ReportingDomainError } from '../../src/domain/jobs.js';
import {
  FIXTURE_ERROR_MAP,
  FIXTURE_HINTS,
  FIXTURE_MODULE,
  FixtureApiError,
  NOT_READY,
  fixtureContext,
  fixtureError,
  fixtureFile,
  fixtureList,
  fixtureMethod,
  fixtureParams,
  fixtureSuccess,
  notReadyError,
  toFixtureError,
  type FixtureContext,
  type FixtureErrorType,
  type FixturePaging,
} from '../../src/legacy/envelope.js';

const JOB_ID = '0A1B2C3D-4E5F-6A7B-8C9D0E1F2A3B4C5D';
const DEFINITION_ID = '99999999-8888-7777-6666555544443333';
const USER_ID = '11111111-2222-3333-4444555566667777';
const FIXTURE_PATH = '/legacy-fixtures/cfml/api.cfm/reporting';
// Params a request may carry; envelope.cfc never echoes them, because suppressAPIParams defaults to true.
const ECHO_PARAMS = { siteid: 'tenant-a', method: 'reporting.exports', filePath: 'a/b', csrf_token: 'T' };
const CTX: FixtureContext = { method: 'reporting.exports.download', params: ECHO_PARAMS };
const contract = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

// `variables.errorMap` of envelope.cfc.
const ENVELOPE_CFC_ERROR_MAP = {
  authorization: { status: 401, code: 'invalid_request', message: 'Insufficient Account Permissions' },
  invalidParameters: { status: 400, code: 'invalid_request', message: 'Invalid parameters' },
  invalidMethodCall: { status: 400, code: 'invalid_request', message: 'Invalid method call' },
  badRequest: { status: 400, code: 'invalid_request', message: 'Bad Request' },
  invalidTokens: { status: 400, code: 'invalid_request', message: 'Invalid CSRF tokens' },
  forbidden: { status: 403, code: 'invalid_request', message: 'Insufficient Account Permissions' },
  notFound: { status: 404, code: 'invalid_request', message: 'Not Found' },
  conflict: { status: 409, code: 'invalid_request', message: 'Conflict' },
  server_error: { status: 500, code: 'server_error', message: 'Unhandled Exception' },
} as const satisfies Record<string, { status: number; code: string; message: string }>;
type EnvelopeErrorType = keyof typeof ENVELOPE_CFC_ERROR_MAP;
const ENVELOPE_ERROR_ROWS = Object.entries(ENVELOPE_CFC_ERROR_MAP) as [EnvelopeErrorType, (typeof ENVELOPE_CFC_ERROR_MAP)[EnvelopeErrorType]][];

// A `synthetic.export_job` row as envelope.cfc `rows()` reads a queued job.
const QUEUED_JOB = {
  job_id: JOB_ID,
  siteID: 'tenant-a',
  definition_id: DEFINITION_ID,
  format: 'csv',
  state: 'queued',
  requested_by_id: USER_ID,
  created: '2026-06-30T09:15:00',
  started_at: '',
  finished_at: '',
  error: '',
  file_name: '',
  content_type: '',
  output_sha256: '',
};
const QUEUED_JOB_JSON =
  `{"job_id":"${JOB_ID}","siteid":"tenant-a","definition_id":"${DEFINITION_ID}","format":"csv","state":"queued",` +
  `"requested_by_id":"${USER_ID}","created":"2026-06-30T09:15:00","started_at":"","finished_at":"","error":"","file_name":"",` +
  '"content_type":"","output_sha256":""}';

const successBody = (method: string, data: string): string => `{"apiversion":"v1","method":"${method}","data":${data}}`;
const errorBody = (method: string, code: string, message: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"code":"${code}","message":"${message}"}}`;

/** Asserts envelope.cfc respond(): status, exact body, and only the JSON content type and ETag = hash(body) headers. */
function expectFixtureResponse(res: SerializedLegacyResponse, status: number, body: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toBe(body);
  expect(res.headers).toStrictEqual({ 'Content-Type': LEGACY_JSON_CONTENT_TYPE, ETag: cfHash(body) });
  expect(res.headers['ETag']).toMatch(/^[0-9A-F]{64}$/);
}

/** Validates a fixture response against the reporting contract's operation for `method` on `path`. */
function expectContractValid(method: string, path: string, res: SerializedLegacyResponse): void {
  expect(() =>
    assertResponseMatchesOpenApi(contract, { method, path, status: res.status, contentType: res.headers['Content-Type'], body: res.body }),
  ).not.toThrow();
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('fixtureMethod', () => {
  it.each<[string, string | undefined, string | undefined, string]>([
    ['exports', undefined, undefined, 'reporting.exports'],
    ['Exports', 'Download', undefined, 'reporting.exports.download'],
    ['exports', '', '', 'reporting.exports'],
    ['exports', 'download', JOB_ID, 'reporting.exports.download'],
    ['exports', 'download', 'Extra', 'reporting.exports.download.extra'],
  ])('names resource %s, action %j, tail %j as %s', (resource, action, tail, method) => {
    expect(fixtureMethod(resource, action, tail)).toBe(method);
  });

  it('prefixes the reporting module', () => {
    expect(FIXTURE_MODULE).toBe('reporting');
  });
});

describe('fixture error map', () => {
  it.each(ENVELOPE_ERROR_ROWS)('holds the envelope.cfc %s row, frozen', (type, row) => {
    expect(FIXTURE_ERROR_MAP[type]).toStrictEqual(row);
    expect(Object.isFrozen(FIXTURE_ERROR_MAP[type])).toBe(true);
  });

  it('keeps every JSON API row, which token denials answer with, and is frozen', () => {
    for (const [type, row] of Object.entries(LEGACY_ERROR_MAP)) expect(FIXTURE_ERROR_MAP[type as FixtureErrorType]).toBe(row);
    expect(Object.isFrozen(FIXTURE_ERROR_MAP)).toBe(true);
  });
});

describe('FIXTURE_HINTS', () => {
  it('registers the envelope.cfc fixture hints after the JSON API chain, in its call order', () => {
    expect(FIXTURE_HINTS).toEqual([
      ...[
        'version', 'seq', 'record_count', 'day_count', 'blackout_count', 'approved_count', 'size_bytes', 'offset_minutes',
        'offsetminutes', 'schedule_version', 'inserted', 'total', 'blackouts', 'program_id', 'entries', 'brokenat',
      ].map((key) => ({ key, hint: 'integer' })),
      ...['overdue', 'valid', 'isblackout'].map((key) => ({ key, hint: 'boolean' })),
    ]);
    expect(Object.isFrozen(FIXTURE_HINTS)).toBe(true);
  });

  it('serializes hinted keys as envelope.cfc does, other simple values as strings and keys lower-cased', () => {
    const data = { Total: '3', size_bytes: '10', valid: 'yes', pageindex: '2', amount: 12.5, title: 7 };

    expectFixtureResponse(
      fixtureSuccess({ method: 'reporting.exports', params: {} }, data),
      200,
      successBody('reporting.exports', '{"total":3,"size_bytes":10,"valid":true,"pageindex":2,"amount":"12.5","title":"7"}'),
    );
  });
});

describe('FixtureApiError and NOT_READY', () => {
  it.each<[FixtureErrorType, string | undefined, string]>([
    ['notFound', undefined, 'notFound: Not Found'],
    ['forbidden', undefined, 'forbidden: Insufficient Account Permissions'],
    ['invalidParameters', '', 'invalidParameters: Invalid parameters'],
    ['conflict', 'not-ready', 'conflict: not-ready'],
  ])('raises %s with detail %j as "%s"', (type, detail, message) => {
    const error = new FixtureApiError(type, detail);

    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error.name).toBe('FixtureApiError');
    expect(error.type).toBe(type);
    expect(error.detail).toBe(detail);
    expect(error.message).toBe(message);
  });

  it('is reporting.cfc raise("conflict", "not-ready"), a new error per call', () => {
    expect(NOT_READY).toStrictEqual({ type: 'conflict', message: 'not-ready' });
    expect(Object.isFrozen(NOT_READY)).toBe(true);
    const error = notReadyError();
    expect(error).toBeInstanceOf(FixtureApiError);
    expect([error.type, error.detail]).toStrictEqual(['conflict', 'not-ready']);
    expect(notReadyError()).not.toBe(error);
  });
});

describe('fixtureParams and fixtureContext', () => {
  const query = { siteid: 'tenant-a', Format: 'pdf' };

  it.each<[string, string, unknown, Record<string, unknown>]>([
    [
      'a JSON object body, simple values as strings',
      'application/json; charset=utf-8',
      { format: 'csv', definitionId: DEFINITION_ID, draft: true, asOf: null },
      { siteid: 'tenant-a', format: 'csv', definitionId: DEFINITION_ID, draft: 'true', asOf: '' },
    ],
    ['a form body, repeated keys joined', 'application/x-www-form-urlencoded', { FORMAT: 'xlsx', tag: ['a', 'b'] }, { siteid: 'tenant-a', FORMAT: 'xlsx', tag: 'a,b' }],
    ['a JSON array body, ignored', 'application/json', ['x'], query],
  ])('merges url then %s, later keys winning ignoring case', (_label, contentType, body, params) => {
    const request = { query, body, headers: { 'content-type': contentType } } as unknown as FastifyRequest;

    expect(fixtureParams(request)).toStrictEqual(params);
  });

  it('pairs the api.cfm method, without the id segment, with the merged params of a request', () => {
    const request = { query: { siteid: 'tenant-a' }, body: undefined, headers: {} } as unknown as FastifyRequest;

    expect(fixtureContext(request, 'exports', 'download')).toStrictEqual({ method: 'reporting.exports.download', params: { siteid: 'tenant-a' } });
    expect(fixtureContext(request, 'exports')).toStrictEqual({ method: 'reporting.exports', params: { siteid: 'tenant-a' } });
  });
});

describe('fixtureSuccess', () => {
  it.each<[Record<string, unknown>, unknown, string]>([
    [ECHO_PARAMS, QUEUED_JOB, successBody('reporting.exports', QUEUED_JOB_JSON)],
    [{ useDataNamespace: 'true' }, QUEUED_JOB, successBody('reporting.exports', QUEUED_JOB_JSON)],
    [{ useDataNamespace: 'maybe' }, QUEUED_JOB, successBody('reporting.exports', QUEUED_JOB_JSON)],
    [{ useDataNamespace: 'false' }, QUEUED_JOB, `{"apiversion":"v1","method":"reporting.exports",${QUEUED_JOB_JSON.slice(1, -1)}}`],
    [{ USEDATANAMESPACE: 'no' }, QUEUED_JOB, `{"apiversion":"v1","method":"reporting.exports",${QUEUED_JOB_JSON.slice(1, -1)}}`],
    [{ useDataNamespace: 'false' }, [QUEUED_JOB], successBody('reporting.exports', `[${QUEUED_JOB_JSON}]`)],
  ])('answers 200 without params for params %j', (params, data, body) => {
    expectFixtureResponse(fixtureSuccess({ method: 'reporting.exports', params }, data), 200, body);
  });

  it('answers {} as data when the route gives none, and the given status', () => {
    expectFixtureResponse(fixtureSuccess({ method: 'reporting.exports', params: {} }, undefined, 201), 201, successBody('reporting.exports', '{}'));
  });

  it('answers a created job and one job as the contract declares them', () => {
    const res = fixtureSuccess({ method: 'reporting.exports', params: ECHO_PARAMS }, QUEUED_JOB);

    expectContractValid('POST', `${FIXTURE_PATH}/exports`, res);
    expectContractValid('GET', `${FIXTURE_PATH}/exports/${JOB_ID}`, res);
  });
});

describe('fixtureList', () => {
  const rowA = { job_id: 'J1', state: 'done' };
  const rowB = { job_id: 'J2', state: 'failed' };
  const rowsJson = '{"job_id":"J1","state":"done"},{"job_id":"J2","state":"failed"}';

  it.each<[string, unknown[], FixturePaging, string]>([
    ['a first page', [rowA, rowB], { total: 3, pageIndex: 1, itemsPerPage: 2 }, `[${rowsJson}],"startindex":1,"endindex":2,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":1`],
    ['a last partial page', [rowB], { total: 3, pageIndex: 2, itemsPerPage: 2 }, '[{"job_id":"J2","state":"failed"}],"startindex":3,"endindex":3,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":2'],
    ['a page past the total', [rowA], { total: 3, pageIndex: 5, itemsPerPage: 2 }, '[],"startindex":9,"endindex":3,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":5'],
    ['an empty list', [], { total: 0, pageIndex: 1, itemsPerPage: 50 }, '[],"startindex":1,"endindex":0,"itemsperpage":50,"totalitems":0,"totalpages":0,"pageindex":1'],
  ])('answers %s as envelope.cfc listResponse() of a queryPage() result', (_label, items, paging, listJson) => {
    expectFixtureResponse(fixtureList({ method: 'reporting.exports', params: ECHO_PARAMS }, items, paging), 200, successBody('reporting.exports', `{"items":${listJson}}`));
  });

  it('answers a JobPage as the contract declares a page of export jobs', () => {
    const page = { rows: [QUEUED_JOB], total: 1, pageIndex: 1, itemsPerPage: 50 };
    const res = fixtureList({ method: 'reporting.exports', params: {} }, page.rows, page);

    expect(res.body).toBe(successBody('reporting.exports', `{"items":[${QUEUED_JOB_JSON}],"startindex":1,"endindex":1,"itemsperpage":50,"totalitems":1,"totalpages":1,"pageindex":1}`));
    expectContractValid('GET', `${FIXTURE_PATH}/exports`, res);
  });
});

describe('fixtureError', () => {
  it.each(ENVELOPE_ERROR_ROWS)('answers %s at its envelope.cfc status, code before message', (type, { status, code, message }) => {
    expectFixtureResponse(fixtureError(type, CTX), status, errorBody(CTX.method, code, message));
  });

  it.each<[string | undefined, string]>([
    [undefined, 'Conflict'],
    ['', 'Conflict'],
    [NOT_READY.message, 'not-ready'],
  ])('answers conflict detail %j with message %j', (detail, message) => {
    expectFixtureResponse(fixtureError('conflict', CTX, detail), 409, errorBody(CTX.method, 'invalid_request', message));
  });

  it.each<[FixtureErrorType, string | undefined]>([
    ['invalidParameters', undefined],
    ['authorization', undefined],
    ['forbidden', undefined],
    ['notFound', undefined],
    [NOT_READY.type, NOT_READY.message],
    ['server_error', undefined],
  ])('answers %s on a download as the contract declares it', (type, detail) => {
    expectContractValid('GET', `${FIXTURE_PATH}/exports/${JOB_ID}/download`, fixtureError(type, CTX, detail));
  });
});

describe('fixtureFile', () => {
  it.each<[string, string]>([
    ['export-x.csv', 'attachment; filename="export-x.csv"'],
    ['a"b\\c.pdf', 'attachment; filename="a\\"b\\\\c.pdf"'],
    ['Résumé €.pdf', `attachment; filename="R_sum_ _.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%E2%82%AC.pdf`],
    ['\u{1F600}.csv', `attachment; filename="_.csv"; filename*=UTF-8''%F0%9F%98%80.csv`],
  ])('answers 200 with the sendFile headers of %j', (fileName, disposition) => {
    expect(fixtureFile({ fileName, contentType: 'text/csv', size: 10 })).toStrictEqual({
      status: 200,
      headers: { 'Content-Disposition': disposition, 'Content-Length': '10', 'Content-Type': 'text/csv' },
    });
  });

  it('omits Content-Length when the size is unknown', () => {
    expect(fixtureFile({ fileName: 'export-x.pdf', contentType: 'application/pdf' }).headers).toStrictEqual({
      'Content-Disposition': 'attachment; filename="export-x.pdf"',
      'Content-Type': 'application/pdf',
    });
  });

  it.each(['bad\nname.csv', 'bad\u007Fname.csv'])('raises server_error for the control character in %j', (fileName) => {
    const error = thrownBy(() => fixtureFile({ fileName, contentType: 'text/csv', size: 1 }));

    expect(error).toBeInstanceOf(LegacyApiError);
    expect((error as LegacyApiError).type).toBe('server_error');
  });
});

describe('toFixtureError', () => {
  it.each<[string, LegacyServiceUnavailableError]>([
    ['the platform 503', new LegacyServiceUnavailableError()],
    ['a service-call outage', new ServiceUnavailableError('finance', new Error('ECONNREFUSED'))],
    ['a unit gate refusal', new UnitNotAuthoritativeError(['reporting.export_job'])],
  ])('rethrows %s for service-kit', (_label, error) => {
    expect(thrownBy(() => toFixtureError(error, CTX))).toBe(error);
  });

  it.each<[string, unknown, number, string, string]>([
    ['a domain notFound', new ReportingDomainError('notFound'), 404, 'invalid_request', 'Not Found'],
    ['a domain invalidParameters', new ReportingDomainError('invalidParameters'), 400, 'invalid_request', 'Invalid parameters'],
    ['a domain conflict', new ReportingDomainError('conflict', 'not-ready'), 409, 'invalid_request', 'not-ready'],
    ['the not-ready error', notReadyError(), 409, 'invalid_request', 'not-ready'],
    ['a fixture forbidden', new FixtureApiError('forbidden'), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['an unauthenticated denial', AuthDenial.unauthenticated('missing-credential'), 401, 'invalid_request', 'Insufficient Account Permissions'],
    ['a role denial', AuthDenial.forbidden(), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['a site mismatch', AuthDenial.siteMismatch(), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['a legacy invalidTokens', new LegacyApiError('invalidTokens'), 400, 'invalid_request', 'Invalid CSRF tokens'],
    ['a legacy server_error', new LegacyApiError('server_error'), 500, 'server_error', 'Unhandled Exception'],
    ['an unmapped legacy type', new LegacyApiError('invalid_token'), 500, 'server_error', 'Unhandled Exception'],
    ['an unexpected error', new Error('boom'), 500, 'server_error', 'Unhandled Exception'],
    ['a thrown string', 'boom', 500, 'server_error', 'Unhandled Exception'],
  ])('answers %s as the fixture envelope', (_label, error, status, code, message) => {
    expectFixtureResponse(toFixtureError(error, CTX), status, errorBody(CTX.method, code, message));
  });

  it.each<[string, AuthDenial, string, string]>([
    ['an invalid token', AuthDenial.invalidToken(), 'invalid_token', 'Invalid Access Token'],
    ['an expired token', AuthDenial.expiredToken(), 'invalid_token', 'Access Token Expired'],
  ])('keeps the legacy type and bearer challenge of %s', (_label, denial, code, message) => {
    const res = toFixtureError(denial, CTX);
    const body = errorBody(CTX.method, code, message);

    expect(res.status).toBe(401);
    expect(res.body).toBe(body);
    expect(res.headers).toStrictEqual({ 'Content-Type': LEGACY_JSON_CONTENT_TYPE, ETag: cfHash(body), 'WWW-Authenticate': WWW_AUTHENTICATE.bearerInvalidAccessToken });
  });
});
