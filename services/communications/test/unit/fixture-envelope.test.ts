// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture envelope, error map, paging and handler of the communications fixture routes (legacy-fixtures/cfml/lib/envelope.cfc). */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const MESSAGE_ID = '6F9619FF-8B86-D011-B42D00C04FC964FF';
const TEMPLATE_ID = '7A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const PREFIX = '/legacy-fixtures/cfml/api.cfm/communications';
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

/** A `synthetic.message_template` row as envelope.cfc rows() emits it: column order, dates as text. */
const template = {
  template_id: TEMPLATE_ID,
  siteID: 'tenant-a',
  name: 'Welcome',
  subject: '2026',
  body_text: 'Hello {{name}}',
  body_html: '',
  created: '2026-06-30T09:15:00',
  lastUpdate: '2026-06-30T09:15:00',
};
const templateJson =
  `{"template_id":"${TEMPLATE_ID}","siteid":"tenant-a","name":"Welcome","subject":"2026","body_text":"Hello {{name}}",` +
  `"body_html":"","created":"2026-06-30T09:15:00","lastupdate":"2026-06-30T09:15:00"}`;

/** A message detail as envelope.cfc emits it: the message row plus history[] of delivery_status rows. */
const message = {
  message_id: MESSAGE_ID,
  siteID: 'tenant-a',
  template_id: '',
  to_address: 'person@example.com',
  from_address: 'noreply@opt2.local',
  subject: 'Hi',
  body_text: 'Body',
  body_html: '',
  state: 'delivered',
  created: '2026-06-30T09:15:00',
  sent_at: '2026-06-30T09:15:01',
  history: [
    { status_id: 'S1', message_id: MESSAGE_ID, status: 'queued', detail: '', mailpit_id: '', recorded_at: '2026-06-30T09:15:00' },
    { status_id: 'S2', message_id: MESSAGE_ID, status: 'delivered', detail: '', mailpit_id: 'abc123', recorded_at: '2026-06-30T09:15:02' },
  ],
};
const messageMembers =
  `"message_id":"${MESSAGE_ID}","siteid":"tenant-a","template_id":"","to_address":"person@example.com",` +
  `"from_address":"noreply@opt2.local","subject":"Hi","body_text":"Body","body_html":"","state":"delivered",` +
  `"created":"2026-06-30T09:15:00","sent_at":"2026-06-30T09:15:01","history":[` +
  `{"status_id":"S1","message_id":"${MESSAGE_ID}","status":"queued","detail":"","mailpit_id":"","recorded_at":"2026-06-30T09:15:00"},` +
  `{"status_id":"S2","message_id":"${MESSAGE_ID}","status":"delivered","detail":"","mailpit_id":"abc123","recorded_at":"2026-06-30T09:15:02"}]`;

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

/** Asserts envelope.cfc respond(): status, exact body, JSON content type, and ETag = ACF hash(body). */
function expectFixtureResponse(wire: Wire, status: number, body: string): void {
  expect(wire.status).toBe(status);
  expect(wire.body).toBe(body);
  expect(wire.contentType).toBe(LEGACY_JSON_CONTENT_TYPE);
  expect(wire.etag).toBe(cfHash(body));
}

describe('fixtureMethod', () => {
  it.each<[string, string | undefined, string]>([
    ['templates', undefined, 'communications.templates'],
    ['Messages', undefined, 'communications.messages'],
    ['messages', '', 'communications.messages'],
    ['messages', 'Retry', 'communications.messages.retry'],
  ])('names resource %s with action %j as %s', (resource, action, method) => {
    expect(fixtureMethod(resource, action)).toBe(method);
  });
});

describe('fixture error map', () => {
  it('holds the fixture-only rows of envelope.cfc, frozen', () => {
    const { forbidden, notFound, conflict } = ENVELOPE_CFC_ERROR_MAP;
    expect(FIXTURE_ERROR_MAP).toStrictEqual({ forbidden, notFound, conflict });
    expect(Object.isFrozen(FIXTURE_ERROR_MAP)).toBe(true);
    for (const row of Object.values(FIXTURE_ERROR_MAP)) expect(Object.isFrozen(row)).toBe(true);
  });

  it('reuses the LEGACY_ERROR_MAP rows of the other envelope.cfc types, covering every type exactly once', () => {
    for (const type of FIXTURE_LEGACY_ERROR_TYPES) {
      expect(LEGACY_ERROR_MAP[type]).toStrictEqual(ENVELOPE_CFC_ERROR_MAP[type as EnvelopeErrorType]);
    }
    expect([...Object.keys(FIXTURE_ERROR_MAP), ...FIXTURE_LEGACY_ERROR_TYPES].toSorted()).toEqual(ENVELOPE_ERROR_TYPES.toSorted());
  });
});

describe('FixtureApiError', () => {
  it.each<[EnvelopeErrorType, string | undefined, string]>([
    ['notFound', undefined, 'notFound: Not Found'],
    ['conflict', 'Template name is taken', 'conflict: Template name is taken'],
    ['invalidParameters', '', 'invalidParameters: Invalid parameters'],
    ['server_error', undefined, 'server_error: Unhandled Exception'],
  ])('raises %s with message %j as "%s", a LegacyApiError', (type, override, text) => {
    const error = new FixtureApiError(type, override);

    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error.name).toBe('FixtureApiError');
    expect(error.type).toBe(type);
    expect(error.message).toBe(text);
    expect(error.messageOverride).toBe(override);
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

  it('lower-cases keys, keeps row values as strings and types the hinted keys', () => {
    const serializer = fixtureSerializer();

    expect(serializer).toBeInstanceOf(LegacyJsonSerializer);
    expect(serializer.serialize(template)).toBe(templateJson);
    expect(serializer.serialize({ Total: '3', valid: 'yes', ID: 12 })).toBe('{"total":3,"valid":true,"id":"12"}');
  });
});

describe('fixturePage', () => {
  it.each<[FixtureParams, FixturePage]>([
    [{}, { pageIndex: 1, itemsPerPage: 50, offset: 0 }],
    [{ pageIndex: null, itemsPerPage: '' }, { pageIndex: 1, itemsPerPage: 50, offset: 0 }],
    [{ PAGEINDEX: '3', itemsperpage: '20' }, { pageIndex: 3, itemsPerPage: 20, offset: 40 }],
    [{ pageIndex: 2, itemsPerPage: 1000 }, { pageIndex: 2, itemsPerPage: 1000, offset: 1000 }],
  ])('pages %j as %j', (params, page) => {
    expect(fixturePage(params)).toStrictEqual(page);
  });

  it.each<[string, unknown]>([
    ['pageIndex', '0'],
    ['pageIndex', '1.5'],
    ['pageIndex', 'abc'],
    ['pageIndex', '2147483648'],
    ['pageIndex', ['2']],
    ['pageIndex', '١'],
    ['itemsPerPage', '1001'],
  ])('raises invalidParameters for %s %j', (name, value) => {
    expect(() => fixturePage({ [name]: value })).toThrow(expect.objectContaining({ type: 'invalidParameters' }));
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
    [{ pageIndex: '2', itemsPerPage: '2' }, { items: ['c', 'd'], startindex: 3, endindex: 4, itemsperpage: 2, totalitems: 5, totalpages: 3, pageindex: 2 }],
    [{ pageIndex: '4', itemsPerPage: '2' }, { items: [], startindex: 7, endindex: 5, itemsperpage: 2, totalitems: 5, totalpages: 3, pageindex: 4 }],
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
});

describe('fixtureErrorResponse', () => {
  const ctx: FixtureContext = {
    method: 'communications.messages',
    params: { method: 'communications.messages', id: MESSAGE_ID, siteid: 'tenant-a' },
  };

  it.each(ENVELOPE_ERROR_TYPES)('answers a FixtureApiError %s with its envelope.cfc row, code before message', (type) => {
    const { status, code, message: text } = ENVELOPE_CFC_ERROR_MAP[type];

    expectFixtureResponse(fromSerialized(fixtureErrorResponse(new FixtureApiError(type), ctx)), status, errorBody(ctx.method, code, text));
  });

  it.each(ENVELOPE_ERROR_TYPES)('answers a FixtureApiError %s raised with a message override with that message', (type) => {
    const { status, code } = ENVELOPE_CFC_ERROR_MAP[type];

    expectFixtureResponse(fromSerialized(fixtureErrorResponse(new FixtureApiError(type, 'Mail server offline'), ctx)), status, errorBody(ctx.method, code, 'Mail server offline'));
  });

  it.each(FIXTURE_LEGACY_ERROR_TYPES)('answers a LegacyApiError %s with the same row and its default message', (type) => {
    const { status, code, message: text } = ENVELOPE_CFC_ERROR_MAP[type as EnvelopeErrorType];

    expectFixtureResponse(fromSerialized(fixtureErrorResponse(new LegacyApiError(type), ctx)), status, errorBody(ctx.method, code, text));
  });

  it.each<[string, unknown]>([
    ['a LegacyApiError type envelope.cfc does not map', new LegacyApiError('invalidAccessToken')],
    ['an Error', new Error('database down')],
    ['a thrown string', 'database down'],
  ])('answers %s as server_error 500', (_label, error) => {
    expectFixtureResponse(fromSerialized(fixtureErrorResponse(error, ctx)), 500, errorBody(ctx.method, 'server_error', 'Unhandled Exception'));
  });

  it('rethrows a LegacyServiceUnavailableError instead of rendering it', () => {
    const unavailable = new LegacyServiceUnavailableError();

    expect(() => fixtureErrorResponse(unavailable, ctx)).toThrow(unavailable);
  });
});

describe('fixture routes', () => {
  const logLines: string[] = [];
  /** Spies on each request logger's `error`, holding the calls as made, before the logger serializes them. */
  const errorSpies: { mock: { calls: unknown[][] } }[] = [];
  const secret = 'secret-value';
  /** An unhandled SMTP-style error whose message, response, detail and cause carry recipient data. */
  const unhandled = Object.assign(new Error(`550 mailbox unavailable: <${secret}>`, { cause: new Error(`RCPT TO:<${secret}>`) }), {
    response: `550 5.1.1 <${secret}> mailbox unavailable`,
    detail: `recipient=${secret}`,
  });
  const listResults: Record<'paged' | 'past', FixtureListResult> = {
    paged: { list: [template], pageIndex: 2, itemsPerPage: 1, totalItems: 3 },
    past: { list: [], pageIndex: 5, itemsPerPage: 1, totalItems: 3 },
  };
  const thrown: Record<'notFound' | 'invalidParameters' | 'authorization' | 'error' | 'unavailable', () => unknown> = {
    notFound: () => new FixtureApiError('notFound'),
    invalidParameters: () => new LegacyApiError('invalidParameters'),
    authorization: () => new LegacyApiError('authorization'),
    error: () => unhandled,
    unavailable: () => new LegacyServiceUnavailableError(),
  };
  let app: FastifyInstance;
  let seen: FixtureContext | undefined;

  beforeAll(async () => {
    app = await createService({
      name: 'communications',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8115',
        OPT2_SERVICE_NAME: 'communications',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('communications'),
      logger: createLogger({
        service: 'communications',
        version: '1.0.0',
        env: 'local',
        destination: { write: (line: string) => void logLines.push(line) },
      }),
    });
    app.addHook('onRequest', async (request) => {
      errorSpies.push(vi.spyOn(request.log, 'error'));
    });
    app.get(
      `${PREFIX}/templates`,
      PUBLIC,
      fixtureHandler(fixtureMethod('templates'), (request, reply, ctx) => {
        const kind = (request.query as { kind?: keyof typeof listResults }).kind;
        return kind === undefined ? fixtureList(reply, { ...ctx, items: [template, template] }) : fixtureList(reply, { ...ctx, listResult: listResults[kind] });
      }),
    );
    app.post(
      `${PREFIX}/messages`,
      PUBLIC,
      fixtureHandler(fixtureMethod('messages'), (_request, reply, ctx) => {
        seen = ctx;
        return fixtureSuccess(reply, { ...ctx, data: message });
      }),
    );
    app.get(
      `${PREFIX}/messages/:id`,
      PUBLIC,
      fixtureHandler(fixtureMethod('messages'), (request, reply, ctx) => {
        const kind = (request.query as { kind?: keyof typeof thrown }).kind;
        if (kind !== undefined) throw thrown[kind]();
        return fixtureSuccess(reply, { ...ctx, data: message });
      }),
    );
    app.get(
      `${PREFIX}/:resource`,
      PUBLIC,
      fixtureHandler(
        (request) => fixtureMethod((request.params as { resource: string }).resource),
        (_request, reply, ctx) => fixtureSuccess(reply, ctx),
      ),
    );
    app.get(`${PREFIX}/escaped/:type`, PUBLIC, async (request) => {
      throw new FixtureApiError((request.params as { type: EnvelopeErrorType }).type);
    });
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

  it.each(['?siteid=tenant-a', '?useDataNamespace=true', '?useDataNamespace=maybe'])(
    'answers a message detail with history[] as 200 {apiversion, method, data} without params for %s',
    async (query) => {
      expectFixtureResponse(await call(`${PREFIX}/messages/${MESSAGE_ID}${query}`), 200, successBody('communications.messages', `{${messageMembers}}`));
    },
  );

  it.each(['?useDataNamespace=false', '?USEDATANAMESPACE=no'])('flattens data into the envelope for %s', async (query) => {
    expectFixtureResponse(await call(`${PREFIX}/messages/${MESSAGE_ID}${query}`), 200, `{"apiversion":"v1","method":"communications.messages",${messageMembers}}`);
  });

  it('answers {} as data when the route gives none', async () => {
    expectFixtureResponse(await call(`${PREFIX}/Unknown`), 200, successBody('communications.unknown', '{}'));
  });

  it.each<[string, string]>([
    ['?pageIndex=2&itemsPerPage=1', `{"items":[${templateJson}],"startindex":2,"endindex":2,"itemsperpage":1,"totalitems":2,"totalpages":2,"pageindex":2}`],
    ['?kind=paged', `{"items":[${templateJson}],"startindex":2,"endindex":2,"itemsperpage":1,"totalitems":3,"totalpages":3,"pageindex":2}`],
    ['?kind=past', '{"items":[],"startindex":5,"endindex":3,"itemsperpage":1,"totalitems":3,"totalpages":3,"pageindex":5}'],
  ])('answers the template list %s in the paged-list shape', async (query, data) => {
    expectFixtureResponse(await call(`${PREFIX}/templates${query}`), 200, successBody('communications.templates', data));
  });

  it('answers invalid paging with invalidParameters 400, unlogged', async () => {
    const res = await call(`${PREFIX}/templates?itemsPerPage=1001`);

    expectFixtureResponse(res, 400, errorBody('communications.templates', 'invalid_request', 'Invalid parameters'));
    expect(res.logged).toBe(false);
  });

  it('merges URL then JSON body params, ignoring case and keeping the body spelling', async () => {
    const res = await call(`${PREFIX}/messages?siteid=tenant-a&to=a@example.com`, {
      method: 'POST',
      payload: '{"To":"b@example.com","templateId":"T1"}',
      contentType: 'application/json',
    });

    expectFixtureResponse(res, 200, successBody('communications.messages', `{${messageMembers}}`));
    expect(seen).toStrictEqual({ method: 'communications.messages', params: { siteid: 'tenant-a', To: 'b@example.com', templateId: 'T1' } });
  });

  it.each<[string, number, string, string, boolean]>([
    ['notFound', 404, 'invalid_request', 'Not Found', false],
    ['invalidParameters', 400, 'invalid_request', 'Invalid parameters', false],
    ['authorization', 401, 'invalid_request', 'Insufficient Account Permissions', false],
    ['error', 500, 'server_error', 'Unhandled Exception', true],
  ])('answers a thrown %s with the fixture envelope at %i, logging only an unhandled error, serialized', async (kind, status, code, text, logged) => {
    const res = await call(`${PREFIX}/messages/${MESSAGE_ID}?kind=${kind}`);
    const record = serializeError(unhandled);

    expectFixtureResponse(res, status, errorBody('communications.messages', code, text));
    expect(res.logged).toBe(logged);
    expect(res.errorCalls).toStrictEqual(logged ? [[{ error: record }, 'Unhandled fixture exception']] : []);
    expect(res.lines.filter((line) => line.includes('Unhandled fixture exception')).map((line) => JSON.parse(line).error)).toStrictEqual(
      logged ? [record] : [],
    );
    expect(Object.keys(record).sort()).toEqual(['message', 'stack', 'type']);
    expect(res.lines.join('\n')).not.toContain(secret);
  });

  it('propagates LegacyServiceUnavailableError, so service-kit answers the legacy 503', async () => {
    const res = await call(`${PREFIX}/messages/${MESSAGE_ID}?kind=unavailable`);

    expect(res.status).toBe(503);
    expect(res.etag).toBe(cfHash(res.body));
    expect(JSON.parse(res.body)).toMatchObject({ apiversion: 'v1', error: { message: 'Unhandled Exception', code: 'server_error' } });
    expect(res.logged).toBe(false);
  });

  it('lets service-kit answer a FixtureApiError that escapes fixtureHandler as a legacy error, unlogged', async () => {
    const before = logLines.length;
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/escaped/invalidParameters` });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ apiversion: 'v1', error: { message: 'Invalid parameters', code: 'invalid_request' } });
    expect(logLines.slice(before).some((line) => line.includes('unhandled error'))).toBe(false);
  });
});
