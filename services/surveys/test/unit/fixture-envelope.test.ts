// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture envelope, error map, paging and handler of the surveys fixture routes (legacy-fixtures/cfml/lib/envelope.cfc). */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import {
  cfHash,
  LEGACY_ERROR_MAP,
  LEGACY_JSON_CONTENT_TYPE,
  LegacyApiError,
  LegacyJsonSerializer,
  LegacyServiceUnavailableError,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import { createLogger, serializeError } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, testVerifier, type TenantFixture } from '@opt2/platform/testing';
import {
  FIXTURE_ERROR_MAP,
  FIXTURE_LEGACY_ERROR_TYPES,
  FIXTURE_SERIALIZER_HINTS,
  FixtureApiError,
  fixtureErrorResponse,
  fixtureHandler,
  fixtureList,
  fixtureListData,
  fixtureMethod,
  fixturePage,
  fixtureSerializer,
  fixtureSuccess,
  type FixtureContext,
  type FixtureListData,
  type FixtureListResult,
  type FixturePage,
  type FixtureParams,
} from '../../src/legacy/fixture-envelope.js';
import { TEST_CLOCK, buildTestApp, createRecordingDb, headersFor, type TestApp } from '../helpers/app.js';

const SURVEY_ID = '6F9619FF-8B86-D011-B42D00C04FC964FF';
const ROUTE = '/legacy-fixtures/cfml/api.cfm/surveys/surveys';
const PUBLIC = { config: { opt2: { public: true as const } } };

/** `variables.errorMap` of envelope.cfc, the oracle every fixture error row is held to. */
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
} as const;
type EnvelopeErrorType = keyof typeof ENVELOPE_CFC_ERROR_MAP;
const ENVELOPE_ERROR_TYPES = Object.keys(ENVELOPE_CFC_ERROR_MAP) as EnvelopeErrorType[];

const LIST_KEYS = ['items', 'startindex', 'endindex', 'itemsperpage', 'totalitems', 'totalpages', 'pageindex'];

/** Status, content type, ETag and body of one response, from either a serialized response or `app.inject`. */
interface Wire {
  status: number;
  contentType: unknown;
  etag: unknown;
  body: string;
}

const fromSerialized = (r: SerializedLegacyResponse): Wire => ({
  status: r.status,
  contentType: r.headers['Content-Type'],
  etag: r.headers['ETag'],
  body: r.body,
});

const successBody = (method: string, data: string): string => `{"apiversion":"v1","method":"${method}","data":${data}}`;
const errorBody = (method: string, code: string, message: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"code":"${code}","message":"${message}"}}`;

/** Asserts envelope.cfc respond(): status, exact body, JSON content type, and ETag = ACF 2023 hash(body), uppercase SHA-256. */
function expectFixtureResponse(wire: Wire, status: number, body: string): void {
  expect(wire.status).toBe(status);
  expect(wire.body).toBe(body);
  expect(wire.contentType).toBe(LEGACY_JSON_CONTENT_TYPE);
  expect(wire.etag).toBe(cfHash(body));
  expect(wire.etag).toMatch(/^[0-9A-F]{64}$/);
}

describe('fixtureMethod', () => {
  it.each<[string, string | undefined, string | undefined, string]>([
    ['surveys', undefined, undefined, 'surveys.surveys'],
    ['Surveys', 'Schedule', undefined, 'surveys.surveys.schedule'],
    ['surveys', 'targets', 'Bulk', 'surveys.surveys.targets.bulk'],
    ['surveys', '', '', 'surveys.surveys'],
  ])('names resource %s, action %s, tail %s as %s', (resource, action, tail, method) => {
    expect(fixtureMethod(resource, action, tail)).toBe(method);
  });
});

describe('fixture error map', () => {
  it('holds the fixture-only rows of envelope.cfc, frozen', () => {
    const { forbidden, notFound, conflict } = ENVELOPE_CFC_ERROR_MAP;
    expect(FIXTURE_ERROR_MAP).toStrictEqual({ forbidden, notFound, conflict });
    expect(Object.isFrozen(FIXTURE_ERROR_MAP)).toBe(true);
    for (const row of Object.values(FIXTURE_ERROR_MAP)) expect(Object.isFrozen(row)).toBe(true);
  });

  it('reuses the LEGACY_ERROR_MAP rows of the JSON API types envelope.cfc also maps', () => {
    expect(FIXTURE_LEGACY_ERROR_TYPES).toEqual(['authorization', 'invalidParameters', 'invalidMethodCall', 'badRequest', 'invalidTokens', 'server_error']);
    expect(Object.isFrozen(FIXTURE_LEGACY_ERROR_TYPES)).toBe(true);
    for (const type of FIXTURE_LEGACY_ERROR_TYPES) {
      expect(LEGACY_ERROR_MAP[type]).toStrictEqual(ENVELOPE_CFC_ERROR_MAP[type as EnvelopeErrorType]);
    }
  });

  it('covers every envelope.cfc type with exactly one of the two maps', () => {
    const mapped = [...Object.keys(FIXTURE_ERROR_MAP), ...FIXTURE_LEGACY_ERROR_TYPES];
    expect(mapped.toSorted()).toEqual(ENVELOPE_ERROR_TYPES.toSorted());
  });
});

describe('FixtureApiError', () => {
  it.each<[EnvelopeErrorType, string | undefined, string]>([
    ['notFound', undefined, 'notFound: Not Found'],
    ['conflict', 'Survey is already scheduled', 'conflict: Survey is already scheduled'],
    ['badRequest', '', 'badRequest: Bad Request'],
    ['server_error', undefined, 'server_error: Unhandled Exception'],
  ])('raises %s with message %j as "%s"', (type, message, text) => {
    const error = new FixtureApiError(type, message);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FixtureApiError');
    expect(error.type).toBe(type);
    expect(error.message).toBe(text);
    expect(error.messageOverride).toBe(message);
  });
});

describe('fixture serializer', () => {
  it('adds the envelope.cfc fixture hints after the JSON API chain, in its call order', () => {
    expect(FIXTURE_SERIALIZER_HINTS).toEqual([
      ...[
        'version', 'seq', 'record_count', 'day_count', 'blackout_count', 'approved_count', 'size_bytes', 'offset_minutes',
        'offsetminutes', 'schedule_version', 'inserted', 'total', 'blackouts', 'program_id', 'entries', 'brokenat',
      ].map((key) => ({ key, hint: 'integer' })),
      ...['overdue', 'valid', 'isblackout'].map((key) => ({ key, hint: 'boolean' })),
    ]);
  });

  it('serializes fixture and JSON API hinted keys as envelope.cfc does, other simple values as strings', () => {
    const serializer = fixtureSerializer();

    expect(serializer).toBeInstanceOf(LegacyJsonSerializer);
    expect(serializer).not.toBe(fixtureSerializer());
    expect(
      serializer.serialize({
        version: '3',
        offsetMinutes: '30',
        overdue: 'yes',
        valid: 0,
        isblackout: 'false',
        pageindex: '2',
        id: 12,
        label: 7,
      }),
    ).toBe('{"version":3,"offsetminutes":30,"overdue":true,"valid":false,"isblackout":false,"pageindex":2,"id":"12","label":"7"}');
  });
});

describe('fixturePage', () => {
  it.each<[FixtureParams, FixturePage]>([
    [{}, { pageIndex: 1, itemsPerPage: 50, offset: 0 }],
    [{ pageIndex: null, itemsPerPage: '' }, { pageIndex: 1, itemsPerPage: 50, offset: 0 }],
    [{ pageIndex: '3', itemsPerPage: '20' }, { pageIndex: 3, itemsPerPage: 20, offset: 40 }],
    [{ PAGEINDEX: '2', itemsperpage: '10' }, { pageIndex: 2, itemsPerPage: 10, offset: 10 }],
    [{ pageIndex: 4, itemsPerPage: 1000 }, { pageIndex: 4, itemsPerPage: 1000, offset: 3000 }],
    [{ pageIndex: '+2', itemsPerPage: '1' }, { pageIndex: 2, itemsPerPage: 1, offset: 1 }],
    [{ pageIndex: '2147483647', itemsPerPage: '1' }, { pageIndex: 2147483647, itemsPerPage: 1, offset: 2147483646 }],
  ])('pages %j as %j', (params, page) => {
    expect(fixturePage(params)).toStrictEqual(page);
  });

  it.each<[string, unknown]>([
    ['pageIndex', '0'],
    ['pageIndex', '-1'],
    ['pageIndex', '1.5'],
    ['pageIndex', 'abc'],
    ['pageIndex', ' 2'],
    ['pageIndex', '2147483648'],
    ['pageIndex', 1.5],
    ['pageIndex', ['2']],
    ['pageIndex', '١'],
    ['pageIndex', '-١'],
    ['pageIndex', '1١٢٣٤٥٦٧٨٩٠'],
    ['itemsPerPage', '1001'],
    ['itemsPerPage', 0],
    ['itemsPerPage', '1٣'],
  ])('raises invalidParameters for %s %j', (name, value) => {
    const page = (): FixturePage => fixturePage({ [name]: value });

    expect(page).toThrow(LegacyApiError);
    expect(page).toThrow(expect.objectContaining({ type: 'invalidParameters' }));
  });

  it('throws a plain error for in-range non-ASCII digits, which ACF int() rejects', () => {
    const page = (): FixturePage => fixturePage({ pageIndex: '1٣' });

    expect(page).toThrow('The pageIndex paging parameter holds non-ASCII digits');
    expect(page).not.toThrow(LegacyApiError);
  });
});

describe('fixtureListData', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  it.each<[FixtureParams, FixtureListData]>([
    [{}, { items, startindex: 1, endindex: 5, itemsperpage: 50, totalitems: 5, totalpages: 1, pageindex: 1 }],
    [
      { pageIndex: '2', itemsPerPage: '2' },
      { items: ['c', 'd'], startindex: 3, endindex: 4, itemsperpage: 2, totalitems: 5, totalpages: 3, pageindex: 2 },
    ],
    [
      { pageIndex: '3', itemsPerPage: '2' },
      { items: ['e'], startindex: 5, endindex: 5, itemsperpage: 2, totalitems: 5, totalpages: 3, pageindex: 3 },
    ],
    [
      { pageIndex: '4', itemsPerPage: '2' },
      { items: [], startindex: 7, endindex: 5, itemsperpage: 2, totalitems: 5, totalpages: 3, pageindex: 4 },
    ],
  ])('pages five items by %j in envelope.cfc key order', (params, data) => {
    const result = fixtureListData(items, params);

    expect(result).toStrictEqual(data);
    expect(Object.keys(result)).toEqual(LIST_KEYS);
  });

  it('answers an empty list with endindex 0 and no pages', () => {
    expect(fixtureListData([], {})).toStrictEqual({
      items: [],
      startindex: 1,
      endindex: 0,
      itemsperpage: 50,
      totalitems: 0,
      totalpages: 0,
      pageindex: 1,
    });
  });

  it('raises invalidParameters for invalid paging', () => {
    expect(() => fixtureListData(items, { itemsPerPage: '0' })).toThrow(LegacyApiError);
  });
});

describe('fixtureErrorResponse', () => {
  const ctx: FixtureContext = {
    method: 'surveys.surveys.schedule',
    params: { method: 'surveys.surveys', surveyid: SURVEY_ID, siteid: 'tenant-a' },
  };

  it.each(ENVELOPE_ERROR_TYPES)('answers a FixtureApiError %s with its envelope.cfc row, code before message', (type) => {
    const { status, code, message } = ENVELOPE_CFC_ERROR_MAP[type];

    expectFixtureResponse(fromSerialized(fixtureErrorResponse(new FixtureApiError(type), ctx)), status, errorBody(ctx.method, code, message));
  });

  it.each(FIXTURE_LEGACY_ERROR_TYPES)('answers a LegacyApiError %s with the same row and its default message', (type) => {
    const { status, code, message } = ENVELOPE_CFC_ERROR_MAP[type as EnvelopeErrorType];

    expectFixtureResponse(fromSerialized(fixtureErrorResponse(new LegacyApiError(type), ctx)), status, errorBody(ctx.method, code, message));
  });

  it.each<[EnvelopeErrorType, string, string]>([
    ['conflict', 'Survey is already scheduled', 'Survey is already scheduled'],
    ['notFound', '', 'Not Found'],
  ])('answers a %s raised with message %j with message %j', (type, raised, message) => {
    const { status, code } = ENVELOPE_CFC_ERROR_MAP[type];

    expectFixtureResponse(fromSerialized(fixtureErrorResponse(new FixtureApiError(type, raised), ctx)), status, errorBody(ctx.method, code, message));
  });

  it.each<[string, unknown]>([
    ['a LegacyApiError type envelope.cfc does not map', new LegacyApiError('invalidAccessToken')],
    ['an Error', new Error('database down')],
    ['a thrown string', 'database down'],
    ['undefined', undefined],
    ['a LegacyServiceUnavailableError', new LegacyServiceUnavailableError()],
  ])('answers %s as server_error 500', (_label, error) => {
    expectFixtureResponse(fromSerialized(fixtureErrorResponse(error, ctx)), 500, errorBody(ctx.method, 'server_error', 'Unhandled Exception'));
  });
});

describe('fixture routes', () => {
  const logLines: string[] = [];
  /** Spies on each request logger's `error`, holding the calls as made, before the logger serializes them. */
  const errorSpies: { mock: { calls: unknown[][] } }[] = [];
  const secret = 'secret-value';
  /** An unhandled database-style error whose message, detail, where and cause carry row data. */
  const unhandled = Object.assign(new Error(`duplicate key value: Key (answers)=(${secret})`, { cause: new Error(secret) }), {
    detail: `Key (answers)=(${secret})`,
    where: `SQL statement "INSERT INTO surveys.response VALUES ('${secret}')"`,
  });
  const surveys = ['1', '2', '3'].map((n) => ({ surveyid: `S${n}`, title: `Survey ${n}` }));
  const responses = ['R1', 'R2', 'R3'].map((responseid) => ({ responseid, respondentsiteid: 'tenant-b' }));
  const listResults: Record<'paged' | 'past' | 'memory', FixtureListResult> = {
    paged: { list: responses.slice(1, 2), pageIndex: 2, itemsPerPage: 1, totalItems: 3 },
    past: { list: [], pageIndex: 5, itemsPerPage: 1, totalItems: 3 },
    memory: { list: responses, pageIndex: 2, itemsPerPage: 2 },
  };
  const thrown: Record<'notFound' | 'conflict' | 'authorization' | 'error' | 'unavailable', () => unknown> = {
    notFound: () => new FixtureApiError('notFound'),
    conflict: () => new FixtureApiError('conflict', 'Survey is already scheduled'),
    authorization: () => new LegacyApiError('authorization'),
    error: () => unhandled,
    unavailable: () => new LegacyServiceUnavailableError(),
  };
  const survey = { surveyid: SURVEY_ID, title: 'Pulse', version: '2', overdue: 'no', reminders: [{ offset_minutes: '30' }] };
  const surveyJson = `"surveyid":"${SURVEY_ID}","title":"Pulse","version":2,"overdue":false,"reminders":[{"offset_minutes":30}]`;
  let app: FastifyInstance;
  let seen: FixtureContext | undefined;
  /** The context the schedule route last ran with, cleared once read. */
  const takeSeen = (): FixtureContext | undefined => {
    const ctx = seen;
    seen = undefined;
    return ctx;
  };

  beforeAll(async () => {
    app = await createService({
      name: 'surveys',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8117',
        OPT2_SERVICE_NAME: 'surveys',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('surveys'),
      logger: createLogger({
        service: 'surveys',
        version: '1.0.0',
        env: 'local',
        destination: { write: (line: string) => void logLines.push(line) },
      }),
    });
    app.addHook('onRequest', async (request) => {
      errorSpies.push(vi.spyOn(request.log, 'error'));
    });
    app.get(
      ROUTE,
      PUBLIC,
      fixtureHandler(fixtureMethod('surveys'), (_request, reply, ctx) => fixtureList(reply, { ...ctx, items: surveys })),
    );
    app.get(
      `${ROUTE}/:id`,
      PUBLIC,
      fixtureHandler(fixtureMethod('surveys'), (_request, reply, ctx) => fixtureSuccess(reply, { ...ctx, data: survey })),
    );
    app.route({
      method: ['GET', 'POST'],
      url: `${ROUTE}/:id/schedule`,
      ...PUBLIC,
      handler: fixtureHandler(fixtureMethod('surveys', 'schedule'), (_request, reply, ctx) => {
        seen = ctx;
        return fixtureSuccess(reply, { ...ctx, data: { schedule_version: '1' } });
      }),
    });
    app.get(
      `${ROUTE}/:id/responses`,
      PUBLIC,
      fixtureHandler(fixtureMethod('surveys', 'responses'), (request, reply, ctx) =>
        fixtureList(reply, { ...ctx, listResult: listResults[(request.params as { id: keyof typeof listResults }).id] }),
      ),
    );
    app.get(
      `${ROUTE}/:id/launch`,
      PUBLIC,
      fixtureHandler(fixtureMethod('surveys', 'launch'), (request) => {
        throw thrown[(request.query as { kind: keyof typeof thrown }).kind]();
      }),
    );
    app.get(
      `${ROUTE}/:id/do/:action`,
      PUBLIC,
      fixtureHandler(
        (request) => fixtureMethod('surveys', (request.params as { action: string }).action),
        (_request, reply, ctx) => fixtureSuccess(reply, ctx),
      ),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.opt2.shutdown();
  });

  /** Injects one request and returns its wire view, its log lines and logger `error` calls, and whether it logged an unhandled fixture exception. */
  async function call(
    url: string,
    opts: { method?: 'GET' | 'POST'; payload?: string; contentType?: string } = {},
  ): Promise<Wire & { logged: boolean; lines: string[]; errorCalls: unknown[][] }> {
    const before = logLines.length;
    const spiesBefore = errorSpies.length;
    const res = await app.inject({
      method: opts.method ?? 'GET',
      url,
      ...(opts.payload === undefined ? {} : { payload: opts.payload }),
      ...(opts.contentType === undefined ? {} : { headers: { 'content-type': opts.contentType } }),
    });
    const lines = logLines.slice(before);
    return {
      status: res.statusCode,
      contentType: res.headers['content-type'],
      etag: res.headers['etag'],
      body: res.body,
      logged: lines.some((line) => line.includes('Unhandled fixture exception')),
      lines,
      errorCalls: errorSpies.slice(spiesBefore).flatMap((spy) => spy.mock.calls),
    };
  }

  describe('fixtureSuccess', () => {
    it.each<[string, string]>([
      ['?siteid=tenant-a', successBody('surveys.surveys', `{${surveyJson}}`)],
      ['?siteid=tenant-a&useDataNamespace=true', successBody('surveys.surveys', `{${surveyJson}}`)],
      ['?siteid=tenant-a&useDataNamespace=maybe', successBody('surveys.surveys', `{${surveyJson}}`)],
    ])('answers 200 {apiversion, method, data} without params for query %s', async (query, body) => {
      expectFixtureResponse(await call(`${ROUTE}/${SURVEY_ID}${query}`), 200, body);
    });

    it.each(['?useDataNamespace=false', '?USEDATANAMESPACE=no'])('flattens data into the envelope for query %s', async (query) => {
      const body = `{"apiversion":"v1","method":"surveys.surveys",${surveyJson}}`;

      expectFixtureResponse(await call(`${ROUTE}/${SURVEY_ID}${query}`), 200, body);
    });

    it('answers {} as data when the route gives none, with the method the request names', async () => {
      expectFixtureResponse(await call(`${ROUTE}/${SURVEY_ID}/do/Responses`), 200, successBody('surveys.surveys.responses', '{}'));
    });
  });

  describe('fixtureList', () => {
    it('answers one page of in-memory items in the paged-list shape', async () => {
      const data =
        '{"items":[{"surveyid":"S3","title":"Survey 3"}],"startindex":3,"endindex":3,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":2}';

      expectFixtureResponse(await call(`${ROUTE}?pageIndex=2&itemsPerPage=2`), 200, successBody('surveys.surveys', data));
    });

    it.each<[string, string]>([
      ['paged', '{"items":[{"responseid":"R2","respondentsiteid":"tenant-b"}],"startindex":2,"endindex":2,"itemsperpage":1,"totalitems":3,"totalpages":3,"pageindex":2}'],
      ['past', '{"items":[],"startindex":5,"endindex":3,"itemsperpage":1,"totalitems":3,"totalpages":3,"pageindex":5}'],
      ['memory', '{"items":[{"responseid":"R3","respondentsiteid":"tenant-b"}],"startindex":3,"endindex":3,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":2}'],
    ])('answers the %s list result as envelope.cfc listResponse() does', async (id, data) => {
      expectFixtureResponse(await call(`${ROUTE}/${id}/responses`), 200, successBody('surveys.surveys.responses', data));
    });

    it('answers invalid paging with invalidParameters 400, unlogged', async () => {
      const res = await call(`${ROUTE}?itemsPerPage=1001`);

      expectFixtureResponse(res, 400, errorBody('surveys.surveys', 'invalid_request', 'Invalid parameters'));
      expect(res.logged).toBe(false);
    });

    it('answers in-range non-ASCII paging digits with a logged server_error 500', async () => {
      const res = await call(`${ROUTE}?pageIndex=${encodeURIComponent('1٣')}`);

      expectFixtureResponse(res, 500, errorBody('surveys.surveys', 'server_error', 'Unhandled Exception'));
      expect(res.logged).toBe(true);
    });
  });

  describe('fixtureHandler', () => {
    it('passes the URL params to the route, repeated keys joined with commas', async () => {
      const res = await call(`${ROUTE}/${SURVEY_ID}/schedule?pageIndex=2&surveyId=A&tag=x&tag=y`);

      expectFixtureResponse(res, 200, successBody('surveys.surveys.schedule', '{"schedule_version":1}'));
      expect(takeSeen()).toStrictEqual({ method: 'surveys.surveys.schedule', params: { pageIndex: '2', surveyId: 'A', tag: 'x,y' } });
    });

    it.each<[string, string, string, Record<string, unknown>]>([
      [
        'a form body over URL params, ignoring case and keeping the form spelling',
        'application/x-www-form-urlencoded',
        'SurveyID=B&title=Pulse',
        { siteid: 'tenant-a', SurveyID: 'B', title: 'Pulse' },
      ],
      [
        'a JSON object body over URL params, simple values as strings and null as empty',
        'application/json',
        '{"surveyid":"C","count":3,"active":true,"note":null,"targets":["tenant-a"]}',
        { siteid: 'tenant-a', surveyid: 'C', count: '3', active: 'true', note: '', targets: ['tenant-a'] },
      ],
      ['URL params alone for a JSON array body', 'application/json', '["tenant-a"]', { surveyid: 'A', siteid: 'tenant-a' }],
      ['URL params alone for a body that is not JSON', 'application/json', 'not json', { surveyid: 'A', siteid: 'tenant-a' }],
    ])('merges %s', async (_label, contentType, payload, params) => {
      const res = await call(`${ROUTE}/${SURVEY_ID}/schedule?surveyid=A&siteid=tenant-a`, { method: 'POST', payload, contentType });
      const ctx = takeSeen();

      expectFixtureResponse(res, 200, successBody('surveys.surveys.schedule', '{"schedule_version":1}'));
      expect(ctx).toStrictEqual({ method: 'surveys.surveys.schedule', params });
      expect(Object.keys(ctx?.params ?? {})).toEqual(Object.keys(params));
    });

    it.each<[string, number, string, string, boolean]>([
      ['notFound', 404, 'invalid_request', 'Not Found', false],
      ['conflict', 409, 'invalid_request', 'Survey is already scheduled', false],
      ['authorization', 401, 'invalid_request', 'Insufficient Account Permissions', false],
      ['error', 500, 'server_error', 'Unhandled Exception', true],
    ])('answers a thrown %s with the fixture envelope at %i, logging only an unhandled error, serialized', async (kind, status, code, message, logged) => {
      const res = await call(`${ROUTE}/${SURVEY_ID}/launch?kind=${kind}`);
      const record = serializeError(unhandled);

      expectFixtureResponse(res, status, errorBody('surveys.surveys.launch', code, message));
      expect(res.logged).toBe(logged);
      expect(res.errorCalls).toStrictEqual(logged ? [[{ error: record }, 'Unhandled fixture exception']] : []);
      expect(res.lines.filter((line) => line.includes('Unhandled fixture exception')).map((line) => JSON.parse(line).error)).toStrictEqual(
        logged ? [record] : [],
      );
      expect(Object.keys(record).sort()).toEqual(['message', 'stack', 'type']);
      expect(res.lines.join('\n')).not.toContain(secret);
    });

    it('propagates LegacyServiceUnavailableError, so service-kit answers the legacy 503', async () => {
      const res = await call(`${ROUTE}/${SURVEY_ID}/launch?kind=unavailable`);

      expect(res.status).toBe(503);
      expect(res.etag).toBe(cfHash(res.body));
      expect(JSON.parse(res.body)).toMatchObject({ apiversion: 'v1', error: { message: 'Unhandled Exception', code: 'server_error' } });
      expect(res.logged).toBe(false);
    });
  });
});

describe('surveys fixture routes over the recording database', () => {
  const MANAGER_ID = '11111111-2222-3333-4444555566667777';
  const LAUNCHED_ID = 'A0000000-0000-0000-0000000000000001';
  const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
  const SITE_A = `?siteid=${TENANT_A.siteId}`;
  const PAGE_TWO_B = `${ROUTE}?siteid=${TENANT_B.siteId}&pageIndex=2&itemsPerPage=1`;
  const CSRF = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630140509000' };
  const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
  const WRITE_STATEMENT = /^(INSERT|UPDATE|DELETE)\b/i;
  /** Headers onRequestStart_include.cfm adds to every legacy response. */
  const LEGACY_HEADERS = { generator: 'Masa CMS 7.6.1', 'strict-transport-security': 'max-age=1200' };
  /** Page 2 of tenant-b's two seeded surveys at one per page, as envelope.cfc listResponse() writes it. */
  const PAGE_TWO_B_DATA =
    `{"items":[{"survey_id":"B0000000-0000-0000-0000000000000002","siteid":"tenant-b","title":"Pulse B2","status":"DRAFT",` +
    `"created":"2026-06-29T10:00:00","createdbyid":"${MANAGER_ID}","lastupdate":"","lastupdatebyid":"","launched_at":""}],` +
    '"startindex":2,"endindex":2,"itemsperpage":1,"totalitems":2,"totalpages":2,"pageindex":2}';

  type Caller = 'manager' | 'managerB' | 'member' | 'systemUser';
  /** One injected request; no `as` sends it anonymously, a `body` is sent as JSON. */
  interface Req {
    method?: 'GET' | 'POST';
    url: string;
    as?: Caller;
    body?: unknown;
    headers?: Record<string, string>;
  }

  const surveyRow = (surveyId: string, site: TenantFixture, title: string, status: string, created: Date, launchedAt: Date | null = null) => ({
    tenant_id: site.tenantId,
    survey_id: surveyId,
    siteid: site.siteId,
    title,
    status,
    created,
    createdbyid: MANAGER_ID,
    launched_at: launchedAt,
  });

  let t: TestApp;
  let tokens: Record<Caller, Record<string, string>>;

  beforeAll(async () => {
    const db = createRecordingDb({
      clock: TEST_CLOCK,
      rows: {
        survey: [
          surveyRow(LAUNCHED_ID, TENANT_A, 'Launched', 'LAUNCHED', new Date(2026, 5, 28, 9, 0, 0), new Date(2026, 5, 29, 9, 0, 0)),
          surveyRow('B0000000-0000-0000-0000000000000001', TENANT_B, 'Pulse B1', 'DRAFT', new Date(2026, 5, 29, 9, 0, 0)),
          surveyRow('B0000000-0000-0000-0000000000000002', TENANT_B, 'Pulse B2', 'DRAFT', new Date(2026, 5, 29, 10, 0, 0)),
        ],
      },
    });
    t = await buildTestApp({ db });
    tokens = {
      manager: await headersFor(Roles.surveysManager),
      managerB: await headersFor(Roles.surveysManager, { site: TENANT_B.siteId }),
      member: await headersFor(Roles.member),
      systemUser: await headersFor(Roles.systemUser),
    };
  });

  afterAll(async () => {
    await t.app.close();
  });

  /** Injects `req` and returns its wire view, its response headers, the row-changing statements it ran and the service calls it made. */
  async function send({ method = 'GET', url, as, body, headers = {} }: Req) {
    const mark = t.db.transactions.length;
    const callMark = t.client.requests.length;
    const res = await t.app.inject({
      method,
      url,
      headers: { ...(as === undefined ? {} : tokens[as]), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    const wire: Wire = { status: res.statusCode, contentType: res.headers['content-type'], etag: res.headers['etag'], body: res.body };
    return {
      ...wire,
      headers: res.headers,
      writes: t.db.transactions
        .slice(mark)
        .flatMap((tx) => tx.statements.map((statement) => statement.text))
        .filter((text) => WRITE_STATEMENT.test(text)),
      serviceCalls: t.client.requests.slice(callMark),
    };
  }

  it('creates a DRAFT survey and reads it back in the success envelope, params suppressed, with its ETag and the legacy headers', async () => {
    const created = await send({ method: 'POST', url: `${ROUTE}${SITE_A}`, as: 'manager', body: { title: 'Pulse' }, headers: CSRF });
    const id = (JSON.parse(created.body) as { data: { survey_id: string } }).data.survey_id;
    const detail =
      `{"survey_id":"${id}","siteid":"tenant-a","title":"Pulse","status":"DRAFT","created":"2026-06-30T12:00:00",` +
      '"createdbyid":"test-surveys.manager","lastupdate":"","lastupdatebyid":"","launched_at":"","schedule":{},"reminders":[],"targets":[]}';

    expect(id).toMatch(CF_UUID);
    expectFixtureResponse(created, 200, successBody('surveys.surveys', detail));
    expect(created.headers).toMatchObject(LEGACY_HEADERS);
    expect(t.db.rows('survey')).toContainEqual(expect.objectContaining({ tenant_id: TENANT_A.tenantId, survey_id: id, title: 'Pulse' }));

    const read = await send({ url: `${ROUTE}/${id}${SITE_A}`, as: 'manager' });

    expectFixtureResponse(read, 200, successBody('surveys.surveys', detail));
    expect(read.headers).toMatchObject(LEGACY_HEADERS);
    expect(read.writes).toEqual([]);
  });

  it('lists one page of the site\'s surveys in the paged-list shape, writing nothing', async () => {
    const listed = await send({ url: PAGE_TWO_B, as: 'managerB' });

    expectFixtureResponse(listed, 200, successBody('surveys.surveys', PAGE_TWO_B_DATA));
    expect(listed.headers).toMatchObject(LEGACY_HEADERS);
    expect(listed.writes).toEqual([]);
  });

  it.each(['GET', 'get'])('dispatches a POST carrying X-HTTP-Method-Override %s as the list, writing nothing and consuming no CSRF token', async (override) => {
    const res = await send({
      method: 'POST',
      url: PAGE_TWO_B,
      as: 'managerB',
      body: { title: 'Ignored' },
      headers: { ...CSRF, 'x-http-method-override': override },
    });

    expectFixtureResponse(res, 200, successBody('surveys.surveys', PAGE_TWO_B_DATA));
    expect(res.writes).toEqual([]);
    expect(res.serviceCalls).toEqual([]);
  });

  it.each<[string, Req, EnvelopeErrorType, string]>([
    ['an anonymous caller', { url: `${ROUTE}${SITE_A}` }, 'authorization', 'surveys.surveys'],
    ['a member without surveys.manager', { url: `${ROUTE}${SITE_A}`, as: 'member' }, 'forbidden', 'surveys.surveys'],
    ['an unknown survey id', { url: `${ROUTE}/${UNKNOWN_ID}${SITE_A}`, as: 'manager' }, 'notFound', 'surveys.surveys'],
    ['a create without a title', { method: 'POST', url: `${ROUTE}${SITE_A}`, as: 'manager', body: {}, headers: CSRF }, 'invalidParameters', 'surveys.surveys'],
    ['a create without CSRF tokens', { method: 'POST', url: `${ROUTE}${SITE_A}`, as: 'manager', body: { title: 'Pulse' } }, 'invalidTokens', 'surveys.surveys'],
    [
      'a schedule of a launched survey',
      { method: 'POST', url: `${ROUTE}/${LAUNCHED_ID}/schedule${SITE_A}`, as: 'manager', body: { launchAt: '2026-07-01T09:00:00' }, headers: CSRF },
      'conflict',
      'surveys.surveys.schedule',
    ],
    ['in-range non-ASCII paging digits', { url: `${ROUTE}${SITE_A}&pageIndex=${encodeURIComponent('1٣')}`, as: 'manager' }, 'server_error', 'surveys.surveys'],
  ])('answers %s with the envelope.cfc %s row, writing nothing', async (_case, req, type, method) => {
    const { status, code, message } = ENVELOPE_CFC_ERROR_MAP[type];
    const res = await send(req);

    expectFixtureResponse(res, status, errorBody(method, code, message));
    expect(res.writes).toEqual([]);
  });

  describe('api.cfm check order, with two checks failing at once', () => {
    it('answers a path outside the api.cfm grammar with 404 before checking an unknown site', async () => {
      const res = await send({ url: `${ROUTE}/${UNKNOWN_ID}/a/b/c?siteid=nowhere`, as: 'manager' });

      expect(res.status).toBe(404);
      // Only status and method: such paths never reach surveys through the gateway, and service-kit's not-found answers them in
      // the JSON API error shape, not envelope.cfc's.
      expect(JSON.parse(res.body)).toMatchObject({ apiversion: 'v1', method: 'invalid' });
      expect(res.writes).toEqual([]);
    });

    it.each<[string, Req, EnvelopeErrorType, string]>([
      ['the site check precedes the login check', { method: 'POST', url: `${ROUTE}?siteid=nowhere`, body: {} }, 'invalidParameters', 'surveys.surveys'],
      ['the site check precedes the role check', { url: `${ROUTE}?siteid=nowhere`, as: 'systemUser' }, 'invalidParameters', 'surveys.surveys'],
      ['the token-site check refuses another site a role would admit', { url: `${ROUTE}?siteid=${TENANT_B.siteId}`, as: 'manager' }, 'forbidden', 'surveys.surveys'],
      ['the login check precedes the role check', { method: 'POST', url: `${ROUTE}${SITE_A}`, body: { title: 'Pulse' }, headers: CSRF }, 'authorization', 'surveys.surveys'],
      ['the role check precedes the existence check', { url: `${ROUTE}/${UNKNOWN_ID}${SITE_A}`, as: 'systemUser' }, 'forbidden', 'surveys.surveys'],
      [
        'the CSRF check precedes the existence check',
        { method: 'POST', url: `${ROUTE}/${UNKNOWN_ID}/schedule${SITE_A}`, as: 'manager', body: { launchAt: '2026-07-01T09:00:00' } },
        'invalidTokens',
        'surveys.surveys.schedule',
      ],
      [
        'the existence check precedes validation',
        { method: 'POST', url: `${ROUTE}/${UNKNOWN_ID}/schedule${SITE_A}`, as: 'manager', body: { launchAt: 'soon' }, headers: CSRF },
        'notFound',
        'surveys.surveys.schedule',
      ],
      [
        'validation precedes the state check',
        { method: 'POST', url: `${ROUTE}/${LAUNCHED_ID}/schedule${SITE_A}`, as: 'manager', body: { launchAt: 'soon' }, headers: CSRF },
        'invalidParameters',
        'surveys.surveys.schedule',
      ],
    ])('%s', async (_case, req, type, method) => {
      const { status, code, message } = ENVELOPE_CFC_ERROR_MAP[type];
      const res = await send(req);

      expectFixtureResponse(res, status, errorBody(method, code, message));
      expect(res.writes).toEqual([]);
    });
  });
});

