// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance fixture envelope, error map and error mapping against legacy-fixtures/cfml/lib/envelope.cfc, api.cfm and modules/finance.cfc. */
import { describe, expect, it } from 'vitest';
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
import type { FastifyRequest } from '@opt2/platform/service-kit';
import { TransitionRejectedError, decide } from '@opt2/platform/state-machine';
import { financeLifecycle } from '../../src/domain/lifecycle.transitions.js';
import { FinanceDomainError } from '../../src/domain/records.js';
import {
  FIXTURE_ERROR_MAP,
  FIXTURE_HINTS,
  FIXTURE_MODULE,
  FixtureApiError,
  fixtureContext,
  fixtureError,
  fixtureFile,
  fixtureList,
  fixtureMethod,
  fixtureParams,
  fixtureSuccess,
  toFixtureError,
  type FixtureContext,
  type FixtureErrorType,
  type FixturePaging,
} from '../../src/legacy/envelope.js';

const RECORD_ID = '0A1B2C3D-4E5F-6A7B-8C9D0E1F2A3B4C5D';
const ATTACHMENT_ID = '99999999-8888-7777-6666555544443333';
// Params a request may carry; envelope.cfc never echoes them, because suppressAPIParams defaults to true.
const ECHO_PARAMS = { siteid: 'tenant-a', method: 'finance.records', filePath: 'a/b', csrf_token: 'T' };
const CTX: FixtureContext = { method: 'finance.records.approve', params: ECHO_PARAMS };

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

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** The rejection finance's lifecycle throws for `action` on `state` by `roles`. */
function rejection(state: string, action: string, roles: readonly string[]): TransitionRejectedError {
  const decision = decide(financeLifecycle, { state, action, roles });
  if (decision.outcome === 'ok') throw new Error(`${action} on ${state} is legal`);
  return new TransitionRejectedError(decision);
}

describe('fixtureMethod', () => {
  it.each<[string, string | undefined, string | undefined, string]>([
    ['records', undefined, undefined, 'finance.records'],
    ['Records', 'Submit', undefined, 'finance.records.submit'],
    ['rollups', '', '', 'finance.rollups'],
    ['records', 'attachments', ATTACHMENT_ID, 'finance.records.attachments'],
    ['records', 'attachments', 'Download', 'finance.records.attachments.download'],
    ['records', 'attachments', '6F9619FF-8B86-D011-B42D-00C04FC964FF', 'finance.records.attachments.6f9619ff-8b86-d011-b42d-00c04fc964ff'],
  ])('names resource %s, action %j, tail %j as %s', (resource, action, tail, method) => {
    expect(fixtureMethod(resource, action, tail)).toBe(method);
  });

  it('prefixes the finance module', () => {
    expect(FIXTURE_MODULE).toBe('finance');
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
    const data = { Version: '3', size_bytes: '10', overdue: 'yes', valid: 0, isblackout: 'false', pageindex: '2', amount: 12.5, title: 7 };

    expectFixtureResponse(
      fixtureSuccess({ method: 'finance.records', params: {} }, data),
      200,
      successBody(
        'finance.records',
        '{"version":3,"size_bytes":10,"overdue":true,"valid":false,"isblackout":false,"pageindex":2,"amount":"12.5","title":"7"}',
      ),
    );
  });
});

describe('FixtureApiError', () => {
  it.each<[FixtureErrorType, string | undefined, string]>([
    ['notFound', undefined, 'notFound: Not Found'],
    ['forbidden', undefined, 'forbidden: Insufficient Account Permissions'],
    ['invalidParameters', '', 'invalidParameters: Invalid parameters'],
    ['conflict', 'illegalTransition', 'conflict: illegalTransition'],
  ])('raises %s with detail %j as "%s"', (type, detail, message) => {
    const error = new FixtureApiError(type, detail);

    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error.name).toBe('FixtureApiError');
    expect(error.type).toBe(type);
    expect(error.detail).toBe(detail);
    expect(error.message).toBe(message);
  });
});

describe('fixtureParams and fixtureContext', () => {
  const query = { siteid: 'tenant-a', Title: 'from url' };

  it.each<[string, string, unknown, Record<string, unknown>]>([
    [
      'a JSON object body, simple values as strings',
      'application/json; charset=utf-8',
      { title: 'Travel', amount: 12.5, draft: true, note: null },
      { siteid: 'tenant-a', title: 'Travel', amount: '12.5', draft: 'true', note: '' },
    ],
    ['a form body, repeated keys joined', 'application/x-www-form-urlencoded', { TITLE: 'Travel', tag: ['a', 'b'] }, { siteid: 'tenant-a', TITLE: 'Travel', tag: 'a,b' }],
    ['a JSON array body, ignored', 'application/json', ['x'], query],
  ])('merges url then %s, later keys winning ignoring case', (_label, contentType, body, params) => {
    const request = { query, body, headers: { 'content-type': contentType } } as unknown as FastifyRequest;

    expect(fixtureParams(request)).toStrictEqual(params);
  });

  it('pairs the api.cfm method with the merged params of a request', () => {
    const request = { query: { siteid: 'tenant-a' }, body: undefined, headers: {} } as unknown as FastifyRequest;

    expect(fixtureContext(request, 'records', 'attachments', ATTACHMENT_ID)).toStrictEqual({
      method: 'finance.records.attachments',
      params: { siteid: 'tenant-a' },
    });
  });
});

describe('fixtureSuccess', () => {
  const record = { record_id: RECORD_ID, state: 'SUBMITTED', version: 2 };
  const recordJson = `"record_id":"${RECORD_ID}","state":"SUBMITTED","version":2`;

  it.each<[Record<string, unknown>, unknown, string]>([
    [ECHO_PARAMS, record, successBody('finance.records', `{${recordJson}}`)],
    [{ useDataNamespace: 'true' }, record, successBody('finance.records', `{${recordJson}}`)],
    [{ useDataNamespace: 'maybe' }, record, successBody('finance.records', `{${recordJson}}`)],
    [{ useDataNamespace: '' }, record, successBody('finance.records', `{${recordJson}}`)],
    [{ useDataNamespace: 'false' }, record, `{"apiversion":"v1","method":"finance.records",${recordJson}}`],
    [{ USEDATANAMESPACE: 'no' }, record, `{"apiversion":"v1","method":"finance.records",${recordJson}}`],
    [{ useDataNamespace: 'false' }, [record], successBody('finance.records', `[{${recordJson}}]`)],
    [{ useDataNamespace: 'false' }, { method: 'other', state: 'APPROVED' }, '{"apiversion":"v1","method":"other","state":"APPROVED"}'],
  ])('answers 200 without params for params %j and data %j', (params, data, body) => {
    expectFixtureResponse(fixtureSuccess({ method: 'finance.records', params }, data), 200, body);
  });

  it('answers {} as data when the route gives none', () => {
    expectFixtureResponse(fixtureSuccess({ method: 'finance.records.edit', params: {} }), 200, successBody('finance.records.edit', '{}'));
  });
});

describe('fixtureList', () => {
  const rowA = { record_id: 'R1', version: 1 };
  const rowB = { record_id: 'R2', version: 3 };
  const rowsJson = '{"record_id":"R1","version":1},{"record_id":"R2","version":3}';

  it.each<[string, unknown[], FixturePaging, string]>([
    ['a first page', [rowA, rowB], { total: 3, pageIndex: 1, itemsPerPage: 2 }, `[${rowsJson}],"startindex":1,"endindex":2,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":1`],
    ['a last partial page', [rowB], { total: 3, pageIndex: 2, itemsPerPage: 2 }, '[{"record_id":"R2","version":3}],"startindex":3,"endindex":3,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":2'],
    ['a page past the total', [rowA], { total: 3, pageIndex: 5, itemsPerPage: 2 }, '[],"startindex":9,"endindex":3,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":5'],
    ['an empty list', [], { total: 0, pageIndex: 1, itemsPerPage: 50 }, '[],"startindex":1,"endindex":0,"itemsperpage":50,"totalitems":0,"totalpages":0,"pageindex":1'],
    [
      'the largest page index',
      [],
      { total: 1, pageIndex: 2147483647, itemsPerPage: 1000 },
      '[],"startindex":2147483646001,"endindex":1,"itemsperpage":1000,"totalitems":1,"totalpages":1,"pageindex":2147483647',
    ],
  ])('answers %s as envelope.cfc listResponse() of a queryPage() result', (_label, items, paging, listJson) => {
    expectFixtureResponse(fixtureList({ method: 'finance.records', params: ECHO_PARAMS }, items, paging), 200, successBody('finance.records', `{"items":${listJson}}`));
  });
});

describe('fixtureError', () => {
  it.each(ENVELOPE_ERROR_ROWS)('answers %s at its envelope.cfc status, code before message', (type, { status, code, message }) => {
    expectFixtureResponse(fixtureError(type, CTX), status, errorBody(CTX.method, code, message));
  });

  it.each<[string | undefined, string]>([
    [undefined, 'Conflict'],
    ['', 'Conflict'],
    ['illegalTransition', 'illegalTransition'],
  ])('answers detail %j with message %j', (detail, message) => {
    expectFixtureResponse(fixtureError('conflict', CTX, detail), 409, errorBody(CTX.method, 'invalid_request', message));
  });
});

describe('fixtureFile', () => {
  it('answers 200 with the sendFile headers of an attachment', () => {
    expect(fixtureFile({ fileName: 'scan.pdf', contentType: 'application/pdf', size: 10 })).toStrictEqual({
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="scan.pdf"', 'Content-Length': '10', 'Content-Type': 'application/pdf' },
    });
  });

  it('raises server_error, which toFixtureError answers as 500, for a control character in the file name', () => {
    const thrown = thrownBy(() => fixtureFile({ fileName: 'a\nb.pdf', contentType: 'application/pdf', size: 1 }));

    expect(thrown).toBeInstanceOf(LegacyApiError);
    expectFixtureResponse(toFixtureError(thrown, CTX), 500, errorBody(CTX.method, 'server_error', 'Unhandled Exception'));
  });
});

describe('toFixtureError', () => {
  it.each<[string, unknown, number, string, string]>([
    ['a domain notFound', new FinanceDomainError('notFound'), 404, 'invalid_request', 'Not Found'],
    ['a domain invalidParameters', new FinanceDomainError('invalidParameters'), 400, 'invalid_request', 'Invalid parameters'],
    ['an illegal-state transition', rejection('APPROVED', 'approve', ['finance.approver']), 409, 'invalid_request', 'illegalTransition'],
    ['a wrong-role transition', rejection('SUBMITTED', 'approve', ['finance.preparer']), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['a fixture error with detail', new FixtureApiError('conflict', 'Period total exceeded'), 409, 'invalid_request', 'Period total exceeded'],
    ['a fixture error without detail', new FixtureApiError('notFound'), 404, 'invalid_request', 'Not Found'],
    ['a legacy error of a mapped type', new LegacyApiError('invalidTokens'), 400, 'invalid_request', 'Invalid CSRF tokens'],
    ['a legacy error of an unmapped type', new LegacyApiError('invalid_token'), 500, 'server_error', 'Unhandled Exception'],
    ['a legacy error typed as a prototype key', new LegacyApiError('toString'), 500, 'server_error', 'Unhandled Exception'],
    ['an unauthenticated denial', AuthDenial.unauthenticated('missing-credential'), 401, 'invalid_request', 'Insufficient Account Permissions'],
    ['a role denial', AuthDenial.forbidden(), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['an unexpected Error', new Error('connection reset'), 500, 'server_error', 'Unhandled Exception'],
    ['a thrown string', 'boom', 500, 'server_error', 'Unhandled Exception'],
  ])('answers %s with the fixture error envelope', (_label, err, status, code, message) => {
    expectFixtureResponse(toFixtureError(err, CTX), status, errorBody(CTX.method, code, message));
  });

  it.each<[string, AuthDenial, string]>([
    ['an invalid', AuthDenial.invalidToken(), 'Invalid Access Token'],
    ['an expired', AuthDenial.expiredToken(), 'Access Token Expired'],
  ])('keeps the bearer challenge of %s token denial', (_label, denial, message) => {
    const body = errorBody(CTX.method, 'invalid_token', message);
    const res = toFixtureError(denial, CTX);

    expect(res.status).toBe(401);
    expect(res.body).toBe(body);
    expect(res.headers).toStrictEqual({
      'Content-Type': LEGACY_JSON_CONTENT_TYPE,
      ETag: cfHash(body),
      'WWW-Authenticate': WWW_AUTHENTICATE.bearerInvalidAccessToken,
    });
  });

  it.each([new LegacyServiceUnavailableError(), new UnitNotAuthoritativeError(['finance.records'])])(
    'answers %s with the fixture server_error envelope at 503',
    (err) => {
      expectFixtureResponse(toFixtureError(err, CTX), 503, errorBody(CTX.method, 'server_error', 'Unhandled Exception'));
    },
  );
});
