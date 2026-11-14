// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature fixture envelope, error map and error mapping against legacy-fixtures/cfml/lib/envelope.cfc, api.cfm and modules/esignature.cfc. */
import { describe, expect, it } from 'vitest';
import { AuthDenial } from '@opt2/platform/auth';
import {
  cfHash,
  LEGACY_ERROR_MAP,
  LEGACY_JSON_CONTENT_TYPE,
  LegacyApiError,
  LegacyServiceUnavailableError,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import { GateClosedError, UnitNotAuthoritativeError } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type FastifyRequest } from '@opt2/platform/service-kit';
import { ALREADY_SIGNED_MESSAGE, EsignatureDomainError } from '../../src/domain/signing.js';
import {
  FIXTURE_ERROR_MAP,
  FIXTURE_HINTS,
  FIXTURE_MODULE,
  FixtureApiError,
  fixtureContext,
  fixtureError,
  fixtureList,
  fixtureMethod,
  fixtureOutcomeReason,
  fixtureParams,
  fixtureSuccess,
  toFixtureError,
  type FixtureContext,
  type FixtureErrorType,
  type FixturePaging,
} from '../../src/legacy/envelope.js';
import { PeopleReadDeniedError } from '../../src/legacy/people-client.js';
import type { FixtureAuditEntry, FixtureRequest, FixtureVerifyResult } from '../../src/legacy/serialize.js';

const REQUEST_ID = 'A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D';
const SIGNER_ID = 'E1000000-AAAA-BBBB-0000000000000001';
const UNIT = 'esignature.signature_request';
// Params a request may carry; envelope.cfc never echoes them, because suppressAPIParams defaults to true.
const ECHO_PARAMS = { siteid: 'tenant-a', method: 'esignature.requests', filePath: 'a/b', csrf_token: 'T' };
const CTX: FixtureContext = { method: 'esignature.requests.sign', params: ECHO_PARAMS };
// PostgreSQL's refusal of a NUL in a text column, as pg reports it.
const UNSTORABLE_TEXT = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021', severity: 'ERROR' });

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

const REQUEST: FixtureRequest = {
  request_id: REQUEST_ID,
  siteid: 'tenant-a',
  document_name: 'contract.pdf',
  document_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  signer_user_id: SIGNER_ID,
  state: 'PENDING',
  created: '2026-06-30T09:15:00',
  createdbyid: SIGNER_ID,
};
const REQUEST_JSON =
  `{"request_id":"${REQUEST_ID}","siteid":"tenant-a","document_name":"contract.pdf",` +
  `"document_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","signer_user_id":"${SIGNER_ID}",` +
  `"state":"PENDING","created":"2026-06-30T09:15:00","createdbyid":"${SIGNER_ID}"}`;

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

describe('fixtureMethod', () => {
  it.each<[string, string | undefined, string]>([
    ['requests', undefined, 'esignature.requests'],
    ['requests', '', 'esignature.requests'],
    ['Requests', 'Sign', 'esignature.requests.sign'],
    ['requests', 'audit', 'esignature.requests.audit'],
    ['requests', 'verify', 'esignature.requests.verify'],
  ])('names resource %s with action %j as %s', (resource, action, method) => {
    expect(fixtureMethod(resource, action)).toBe(method);
  });

  it('prefixes the esignature module', () => {
    expect(FIXTURE_MODULE).toBe('esignature');
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

  it.each<[string, FixtureVerifyResult | Record<string, unknown>, string]>([
    ['a valid verdict', { valid: true, entries: 3, brokenat: 0 }, '{"valid":true,"entries":3,"brokenat":0}'],
    ['a broken verdict', { valid: false, entries: 3, brokenat: 2 }, '{"valid":false,"entries":3,"brokenat":2}'],
    ['text-typed hinted keys', { Valid: 'no', ENTRIES: '4', brokenat: '1', detail: 7, typed_name: 'true' }, '{"valid":false,"entries":4,"brokenat":1,"detail":"7","typed_name":"true"}'],
  ])('serializes %s with hinted keys typed, other simple values as strings and keys lower-cased', (_label, data, json) => {
    const method = fixtureMethod('requests', 'verify');

    expectFixtureResponse(fixtureSuccess({ method, params: {} }, data), 200, successBody(method, json));
  });
});

describe('FixtureApiError', () => {
  it.each<[FixtureErrorType, string | undefined, string]>([
    ['notFound', undefined, 'Not Found'],
    ['forbidden', undefined, 'Insufficient Account Permissions'],
    ['invalidParameters', '', 'Invalid parameters'],
    ['conflict', ALREADY_SIGNED_MESSAGE, 'already-signed'],
  ])('raises %s with message %j as "%s"', (type, message, effective) => {
    const error = new FixtureApiError(type, message);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FixtureApiError');
    expect(error.type).toBe(type);
    expect(error.message).toBe(effective);
  });
});

describe('fixtureParams and fixtureContext', () => {
  const query = { siteid: 'tenant-a', TypedName: 'from url' };

  it.each<[string, string, unknown, Record<string, unknown>]>([
    [
      'a JSON object body, simple values as strings and arrays as they are',
      'application/json; charset=utf-8',
      { typedName: 'Ada Lovelace', seq: 1, draft: true, note: null, entries: [{ seq: '1' }] },
      { siteid: 'tenant-a', typedName: 'Ada Lovelace', seq: '1', draft: 'true', note: '', entries: [{ seq: '1' }] },
    ],
    [
      'a form body, repeated keys joined',
      'application/x-www-form-urlencoded',
      { TYPEDNAME: 'Ada', tag: ['a', 'b'] },
      { siteid: 'tenant-a', TYPEDNAME: 'Ada', tag: 'a,b' },
    ],
    ['a JSON array body, ignored', 'application/json', ['x'], query],
  ])('merges url then %s, later keys winning ignoring case', (_label, contentType, body, params) => {
    const request = { query, body, headers: { 'content-type': contentType } } as unknown as FastifyRequest;

    expect(fixtureParams(request)).toStrictEqual(params);
  });

  it('pairs the api.cfm method, without the request id, with the merged params of a request', () => {
    const request = { query: { siteid: 'tenant-a' }, body: undefined, headers: {} } as unknown as FastifyRequest;

    expect(fixtureContext(request, 'requests', 'audit')).toStrictEqual({
      method: 'esignature.requests.audit',
      params: { siteid: 'tenant-a' },
    });
    expect(fixtureContext(request, 'requests').method).toBe('esignature.requests');
  });
});

describe('fixtureSuccess', () => {
  const method = fixtureMethod('requests');
  const flatRequest = `{"apiversion":"v1","method":"${method}",${REQUEST_JSON.slice(1)}`;

  it.each<[Record<string, unknown>, unknown, string]>([
    [ECHO_PARAMS, REQUEST, successBody(method, REQUEST_JSON)],
    [{ useDataNamespace: 'true' }, REQUEST, successBody(method, REQUEST_JSON)],
    [{ useDataNamespace: 'maybe' }, REQUEST, successBody(method, REQUEST_JSON)],
    [{ useDataNamespace: '' }, REQUEST, successBody(method, REQUEST_JSON)],
    [{ useDataNamespace: 'false' }, REQUEST, flatRequest],
    [{ USEDATANAMESPACE: 'no' }, REQUEST, flatRequest],
    [{ useDataNamespace: 'false' }, [REQUEST], successBody(method, `[${REQUEST_JSON}]`)],
    [{ useDataNamespace: 'false' }, { method: 'other', state: 'SIGNED' }, '{"apiversion":"v1","method":"other","state":"SIGNED"}'],
  ])('answers 200 without params for params %j', (params, data, body) => {
    expectFixtureResponse(fixtureSuccess({ method, params }, data), 200, body);
  });

  it('answers {} as data when the route gives none', () => {
    expectFixtureResponse(fixtureSuccess({ method, params: {} }), 200, successBody(method, '{}'));
  });
});

describe('fixtureList', () => {
  const entry = (seq: number): FixtureAuditEntry => ({
    entry_id: `D0000000-AAAA-BBBB-000000000000000${String(seq)}`,
    request_id: REQUEST_ID,
    seq,
    action: seq === 1 ? 'created' : 'signed',
    actor_user_id: SIGNER_ID,
    detail: seq === 1 ? 'abc' : 'Ada',
    at: `2026-06-30T14:05:0${String(seq)}.123`,
    prev_hash: '0'.repeat(64),
    entry_hash: 'f'.repeat(64),
  });
  const entryJson = (seq: number): string =>
    `{"entry_id":"D0000000-AAAA-BBBB-000000000000000${String(seq)}","request_id":"${REQUEST_ID}","seq":${String(seq)},` +
    `"action":"${seq === 1 ? 'created' : 'signed'}","actor_user_id":"${SIGNER_ID}","detail":"${seq === 1 ? 'abc' : 'Ada'}",` +
    `"at":"2026-06-30T14:05:0${String(seq)}.123","prev_hash":"${'0'.repeat(64)}","entry_hash":"${'f'.repeat(64)}"}`;

  it.each<[string, unknown[], FixturePaging, string]>([
    [
      'a first page',
      [entry(1), entry(2)],
      { total: 3, pageIndex: 1, itemsPerPage: 2 },
      `[${entryJson(1)},${entryJson(2)}],"startindex":1,"endindex":2,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":1`,
    ],
    [
      'a last partial page',
      [entry(3)],
      { total: 3, pageIndex: 2, itemsPerPage: 2 },
      `[${entryJson(3)}],"startindex":3,"endindex":3,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":2`,
    ],
    ['a page past the total', [entry(1)], { total: 3, pageIndex: 5, itemsPerPage: 2 }, '[],"startindex":9,"endindex":3,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":5'],
    ['an empty list', [], { total: 0, pageIndex: 1, itemsPerPage: 50 }, '[],"startindex":1,"endindex":0,"itemsperpage":50,"totalitems":0,"totalpages":0,"pageindex":1'],
    [
      'the largest page index',
      [],
      { total: 1, pageIndex: 2147483647, itemsPerPage: 1000 },
      '[],"startindex":2147483646001,"endindex":1,"itemsperpage":1000,"totalitems":1,"totalpages":1,"pageindex":2147483647',
    ],
  ])('answers %s as envelope.cfc listResponse() of a queryPage() result', (_label, items, paging, listJson) => {
    const method = fixtureMethod('requests', 'audit');

    expectFixtureResponse(fixtureList({ method, params: ECHO_PARAMS }, items, paging), 200, successBody(method, `{"items":${listJson}}`));
  });
});

describe('fixtureError', () => {
  it.each(ENVELOPE_ERROR_ROWS)('answers %s at its envelope.cfc status, code before message', (type, { status, code, message }) => {
    expectFixtureResponse(fixtureError(type, CTX), status, errorBody(CTX.method, code, message));
  });

  it.each<[string | undefined, string]>([
    [undefined, 'Conflict'],
    ['', 'Conflict'],
    [ALREADY_SIGNED_MESSAGE, 'already-signed'],
  ])('answers message %j as %j', (raised, message) => {
    expectFixtureResponse(fixtureError('conflict', CTX, raised), 409, errorBody(CTX.method, 'invalid_request', message));
  });
});

describe('toFixtureError', () => {
  it.each<[string, unknown, number, string, string]>([
    ['a fixture error with a message', new FixtureApiError('conflict', ALREADY_SIGNED_MESSAGE), 409, 'invalid_request', 'already-signed'],
    ['a fixture error without a message', new FixtureApiError('notFound'), 404, 'invalid_request', 'Not Found'],
    ['a domain conflict', new EsignatureDomainError('conflict', ALREADY_SIGNED_MESSAGE), 409, 'invalid_request', 'already-signed'],
    ['a domain invalidParameters', new EsignatureDomainError('invalidParameters'), 400, 'invalid_request', 'Invalid parameters'],
    ['a domain forbidden', new EsignatureDomainError('forbidden'), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['a domain notFound', new EsignatureDomainError('notFound'), 404, 'invalid_request', 'Not Found'],
    ['an unauthenticated denial', AuthDenial.unauthenticated('missing-credential'), 401, 'invalid_request', 'Insufficient Account Permissions'],
    ['an invalid token denial', AuthDenial.invalidToken(), 401, 'invalid_token', 'Invalid Access Token'],
    ['an expired token denial', AuthDenial.expiredToken(), 401, 'invalid_token', 'Access Token Expired'],
    ['a role denial', AuthDenial.forbidden(), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['a site mismatch', AuthDenial.siteMismatch(), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['a legacy error of a mapped type', new LegacyApiError('invalidTokens'), 400, 'invalid_request', 'Invalid CSRF tokens'],
    ['a legacy error of an unmapped type', new LegacyApiError('invalid_token'), 500, 'server_error', 'Unhandled Exception'],
    ['a legacy error typed as a prototype key', new LegacyApiError('toString'), 500, 'server_error', 'Unhandled Exception'],
    ['an unauthenticated people read', new PeopleReadDeniedError(401, 'authorization'), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['a forbidden people read', new PeopleReadDeniedError(403, 'authorization'), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['a value PostgreSQL cannot store', UNSTORABLE_TEXT, 400, 'invalid_request', 'Invalid parameters'],
    ['an unexpected Error', new Error('connection reset'), 500, 'server_error', 'Unhandled Exception'],
    ['a thrown string', 'boom', 500, 'server_error', 'Unhandled Exception'],
  ])('answers %s with the fixture error envelope and no WWW-Authenticate', (_label, err, status, code, message) => {
    expectFixtureResponse(toFixtureError(err, CTX), status, errorBody(CTX.method, code, message));
  });

  it.each([
    new LegacyServiceUnavailableError(),
    new ServiceUnavailableError('people', new Error('ECONNREFUSED')),
    new GateClosedError([UNIT]),
    new UnitNotAuthoritativeError([UNIT]),
  ])('rethrows %s for the service-kit legacy 503', (err) => {
    expect(thrownBy(() => toFixtureError(err, CTX))).toBe(err);
  });
});

describe('fixtureOutcomeReason', () => {
  it.each<[string, unknown, string]>([
    ['a refused value', UNSTORABLE_TEXT, '22021'],
    ['an unauthenticated denial', AuthDenial.unauthenticated('missing-credential'), 'missing-credential'],
    ['a site mismatch', AuthDenial.siteMismatch(), 'site-mismatch'],
    ['a fixture error', new FixtureApiError('notFound'), 'notFound'],
    ['a domain error', new EsignatureDomainError('conflict', ALREADY_SIGNED_MESSAGE), 'conflict'],
    ['a legacy error', new LegacyApiError('invalidTokens'), 'invalidTokens'],
    ['a refused people read', new PeopleReadDeniedError(401, 'authorization'), 'forbidden'],
    ['anything else', new Error('boom'), 'server_error'],
  ])('names %s as %s', (_label, err, reason) => {
    expect(fixtureOutcomeReason(err)).toBe(reason);
  });
});
