// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture envelope, error map, paging and handler of the surveys fixture routes (legacy-fixtures/cfml/lib/envelope.cfc). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cfHash,
  LEGACY_ERROR_MAP,
  LEGACY_JSON_CONTENT_TYPE,
  LegacyApiError,
  LegacyJsonSerializer,
  LegacyServiceUnavailableError,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { testVerifier } from '@opt2/platform/testing';
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

const SURVEY_ID = '6F9619FF-8B86-D011-B42D00C04FC964FF';
const ROUTE = '/legacy-fixtures/cfml/api.cfm/surveys/surveys';
const PUBLIC = { config: { opt2: { public: true as const } } };

/** `variables.errorMap` of envelope.cfc, the oracle every fixture error row is held to. */
const ENVELOPE_CFC_ERROR_MAP = {
  authorization: { status: 401, code: 'invalid_request', message: 'Insufficient Account Permissions' },
  invalidParameters: { status: 400, code: 'invalid_request', message: 'Invalid parameters' },
  invalidMethodCall: { status: 400, code: 'invalid_request', message: 'Invalid method call' },
  badRequest: { status: 400, code: 'invalid_request', message: 'Bad Request' },
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
    expect(FIXTURE_LEGACY_ERROR_TYPES).toEqual(['authorization', 'invalidParameters', 'invalidMethodCall', 'badRequest', 'server_error']);
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
    error: () => new Error('database down'),
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

  /** Injects one request and returns its wire view plus whether it logged an unhandled fixture exception. */
  async function call(
    url: string,
    opts: { method?: 'GET' | 'POST'; payload?: string; contentType?: string } = {},
  ): Promise<Wire & { logged: boolean }> {
    const before = logLines.length;
    const res = await app.inject({
      method: opts.method ?? 'GET',
      url,
      ...(opts.payload === undefined ? {} : { payload: opts.payload }),
      ...(opts.contentType === undefined ? {} : { headers: { 'content-type': opts.contentType } }),
    });
    return {
      status: res.statusCode,
      contentType: res.headers['content-type'],
      etag: res.headers['etag'],
      body: res.body,
      logged: logLines.slice(before).some((line) => line.includes('Unhandled fixture exception')),
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
    ])('answers a thrown %s with the fixture envelope at %i', async (kind, status, code, message, logged) => {
      const res = await call(`${ROUTE}/${SURVEY_ID}/launch?kind=${kind}`);

      expectFixtureResponse(res, status, errorBody('surveys.surveys.launch', code, message));
      expect(res.logged).toBe(logged);
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
