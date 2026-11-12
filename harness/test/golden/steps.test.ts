import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, inflateSync } from 'node:zlib';
import { routeKeyForRequest, type RouteKeyRequest } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scenarioSchema, type Extraction, type Scenario, type Step } from '../../src/golden/catalogue.js';
import { GoldenConfigError } from '../../src/golden/errors.js';
import { createScenarioContext, session, type ScenarioContext } from '../../src/golden/session.js';
import {
  GAP_REASON,
  SETTLE_TIMEOUT_MS,
  bodyRepresentation,
  fixtureBytes,
  redact,
  runScenarioSteps,
  runStep,
  type CandidateChoice,
  type RecordedBody,
  type StepRecord,
  type StepRunOptions,
} from '../../src/golden/steps.js';
import type { FetchLike } from '../../src/lib/http.js';
import type { EnvLike } from '../../src/lib/paths.js';

// No listener on this port; every request goes to the scripted fetch of its test.
const BASE = 'http://127.0.0.1:8500';
const SCENARIO = 'GS-CO-15';
const ADMIN_PASSWORD = 'FIXTURE-ADMIN-PASSWORD';
const RELOAD_KEY = 'FIXTURE-reload-key';
const MASK = '<secret>';
const LOGIN_PAGE = '/admin/?muraAction=clogin.main';
const LOGIN_TOKEN = 'FIXTURECSRFTOKEN0000000000000001';
const LOGIN_EXPIRES = '260630120000000';
const API_TOKEN = 'FIXTURE-API-TOKEN';
const API_EXPIRES = '260630130000000';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const NO_LOGIN = { default: { login: 'none', via: 'admin' } };
const TWO_SESSIONS = { admin: { login: 'none', via: 'admin' }, editor: { login: 'none', via: 'admin' } };

const ADMIN_LOGIN_HTML = readFileSync(new URL('../fixtures/html/admin-login.html', import.meta.url), 'utf8');
const TINY_PDF = readFileSync(new URL('../fixtures/exports/tiny.pdf', import.meta.url));
const SERVER_ERROR_ENVELOPE = readFileSync(
  new URL('../fixtures/http/envelope-error-500-server-error.json', import.meta.url),
  'utf8',
);
const BAD_REQUEST_ENVELOPE = readFileSync(
  new URL('../fixtures/http/envelope-error-400-bad-request.json', import.meta.url),
  'utf8',
);

/** Hidden fields and CSRF pair of the fixture page's first CSRF form, in document order. */
const LOGIN_FORM_FIELDS = {
  returnUrl: '',
  muraAction: 'cLogin.login',
  isAdminLogin: 'true',
  compactDisplay: 'true',
  csrf_token: LOGIN_TOKEN,
  csrf_token_expires: LOGIN_EXPIRES,
};

type Reply = () => Response;

/** One request the scripted fetch received; `target` is the path and query, headers as the session sent them. */
interface Call {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
}

interface FakeOrigin {
  fetch: FetchLike;
  calls: Call[];
  unmatched: string[];
}

const fakes: FakeOrigin[] = [];
let stateDir = '';

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'opt2-steps-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  for (const fake of fakes.splice(0)) expect(fake.unmatched).toStrictEqual([]);
});

/**
 * Fetch answering `routes`, keyed `<METHOD> <path?query>`: each call takes the route's next reply and the last one
 * repeats. Any other request is recorded as unmatched and rejected.
 */
function fakeOrigin(routes: Record<string, Reply | Reply[]>): FakeOrigin {
  const queues = new Map(Object.entries(routes).map(([key, replies]) => [key, [replies].flat()]));
  const fake: FakeOrigin = {
    calls: [],
    unmatched: [],
    fetch: async (url, init) => {
      const parsed = new URL(url);
      const method = init.method ?? 'GET';
      const target = `${parsed.pathname}${parsed.search}`;
      const raw = init.body;
      const body = typeof raw === 'string' || raw instanceof Uint8Array ? Buffer.from(raw) : undefined;
      fake.calls.push({ method, target, headers: { ...(init.headers as Record<string, string>) }, body });
      const queue = parsed.origin === BASE ? queues.get(`${method} ${target}`) : undefined;
      const reply = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0];
      if (reply === undefined) {
        fake.unmatched.push(`${method} ${url}`);
        throw new Error(`unscripted request ${method} ${url}`);
      }
      return reply();
    },
  };
  fakes.push(fake);
  return fake;
}

function html(markup: string, headers: [string, string][] = [], status = 200): Reply {
  return () =>
    new Response(markup, { status, headers: [['content-type', 'text/html; charset=utf-8'], ...headers] });
}

function json(body: unknown, status = 200): Reply {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return () => new Response(text, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function redirect(location: string, setCookie: readonly string[] = []): Reply {
  return () =>
    new Response(null, {
      status: 302,
      headers: [['location', location], ...setCookie.map((line): [string, string] => ['set-cookie', line])],
    });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function scenario(steps: readonly Record<string, unknown>[], sessions: Record<string, unknown> = NO_LOGIN): Scenario {
  return scenarioSchema.parse({
    id: SCENARIO,
    title: 'Step runner fixture',
    service: 'strategies-content',
    role: 'admin',
    sessions,
    steps,
    compare: ['status'],
    covers: [],
  });
}

function stepAt(s: Scenario, index: number): Step {
  const step = s.steps[index];
  if (step === undefined) throw new Error(`scenario has no step ${index}`);
  return step;
}

function only<T>(items: readonly T[]): T {
  const [first, ...rest] = items;
  if (first === undefined || rest.length > 0) throw new Error(`expected exactly one item, got ${items.length}`);
  return first;
}

function contextFor(s: Scenario, fake: FakeOrigin, extraEnv: EnvLike = {}): ScenarioContext {
  const env: EnvLike = { PORT: '8500', MURA_ADMIN_PASSWORD: ADMIN_PASSWORD, OPT2_STATE_DIR: stateDir, ...extraEnv };
  return createScenarioContext(s, { origin: 'legacy', env, fetch: fake.fetch });
}

/** Runs the only step of a one-step scenario on capture. */
async function runSingle(
  step: Record<string, unknown>,
  fake: FakeOrigin,
  opts: Partial<StepRunOptions> = {},
  extraEnv: EnvLike = {},
): Promise<{ record: StepRecord; ctx: ScenarioContext }> {
  const s = scenario([step]);
  const ctx = contextFor(s, fake, extraEnv);
  const records = await runStep(ctx, s, stepAt(s, 0), { mode: 'capture', fetch: fake.fetch, ...opts });
  return { record: only(records), ctx };
}

/** Runs every step of `s` on capture without logging its sessions in. */
function captureAll(ctx: ScenarioContext, s: Scenario, fake: FakeOrigin): Promise<StepRecord[]> {
  return runScenarioSteps(ctx, s, { mode: 'capture', login: false, fetch: fake.fetch });
}

/** The error `promise` rejects with, asserted to be a GoldenConfigError. */
async function configError(promise: Promise<unknown>): Promise<GoldenConfigError> {
  const err: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(err).toBeInstanceOf(GoldenConfigError);
  return err as GoldenConfigError;
}

function callAt(fake: FakeOrigin, index: number): Call {
  const call = fake.calls[index];
  if (call === undefined) throw new Error(`no call ${index}; got ${fake.calls.length}`);
  return call;
}

function formEntries(call: Call): [string, string][] {
  return [...new URLSearchParams(call.body?.toString('utf8') ?? '')];
}

describe('redact', () => {
  const secret = `FIXTURE pw/&"'{ü`;

  it.each([
    { form: 'plain', text: secret },
    { form: 'URI component', text: 'FIXTURE%20pw%2F%26%22\'%7B%C3%BC' },
    { form: 'form-encoded', text: 'FIXTURE+pw%2F%26%22%27%7B%C3%BC' },
    { form: 'URL query', text: 'FIXTURE%20pw/&%22%27{%C3%BC' },
    { form: 'URL path', text: 'FIXTURE%20pw/&%22\'%7B%C3%BC' },
    { form: 'JSON-escaped', text: 'FIXTURE pw/&\\"\'{ü' },
    { form: 'JSON-escaped with escaped slashes', text: 'FIXTURE pw\\/&\\"\'{ü' },
  ])('masks the $form form of a secret', ({ text }) => {
    expect(redact(`before ${text} after`, [secret])).toBe(`before ${MASK} after`);
  });

  it('masks object keys and nested strings while keeping other values and non-plain objects', () => {
    const date = new Date(0);
    const bytes = new Uint8Array([1, 2]);
    const value: Record<string, unknown[]> = { [`key-${secret}`]: [`value ${secret}`, 7, null, true, { date, bytes }] };
    const out = redact(value, [secret]);
    expect(out).toStrictEqual({ [`key-${MASK}`]: [`value ${MASK}`, 7, null, true, { date, bytes }] });
    const nested = out[`key-${MASK}`]?.[4] as { date: Date; bytes: Uint8Array };
    expect(nested.date).toBe(date);
    expect(nested.bytes).toBe(bytes);
  });

  it('masks a Basic credential whose decoded form holds a secret and keeps one that does not', () => {
    const holding = Buffer.from(`FIXTURE-user:${ADMIN_PASSWORD}`).toString('base64');
    const other = Buffer.from('FIXTURE-user:FIXTURE-other').toString('base64');
    expect(redact(`Authorization: Basic ${holding}`, [ADMIN_PASSWORD])).toBe(`Authorization: Basic ${MASK}`);
    expect(redact(`Authorization: Basic ${other}`, [ADMIN_PASSWORD])).toBe(`Authorization: Basic ${other}`);
  });

  it.each([{ secrets: [] }, { secrets: [''] }])('returns the value itself for secrets $secrets', ({ secrets }) => {
    const value = { text: 'FIXTURE' };
    expect(redact(value, secrets)).toBe(value);
  });
});

describe('bodyRepresentation', () => {
  const utf8 = new TextEncoder().encode('FIXTURE body ü');
  const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0x00]);

  it.each([
    { contentType: 'text/html; charset=utf-8', bytes: utf8, kind: 'text' },
    { contentType: 'text/csv', bytes: utf8, kind: 'text' },
    { contentType: 'application/json;charset=utf-8', bytes: utf8, kind: 'text' },
    { contentType: 'application/xml', bytes: utf8, kind: 'text' },
    { contentType: 'application/problem+json', bytes: utf8, kind: 'text' },
    { contentType: 'image/svg+xml', bytes: utf8, kind: 'text' },
    { contentType: 'application/javascript', bytes: utf8, kind: 'text' },
    { contentType: 'application/ecmascript', bytes: utf8, kind: 'text' },
    { contentType: 'Application/X-WWW-Form-Urlencoded', bytes: utf8, kind: 'text' },
    { contentType: ['text/plain', 'application/pdf'], bytes: utf8, kind: 'text' },
    { contentType: undefined, bytes: utf8, kind: 'text' },
    { contentType: undefined, bytes: invalidUtf8, kind: 'bytesBase64' },
    { contentType: 'application/pdf', bytes: utf8, kind: 'bytesBase64' },
    { contentType: 'image/png', bytes: invalidUtf8, kind: 'bytesBase64' },
    { contentType: 'application/octet-stream', bytes: utf8, kind: 'bytesBase64' },
  ])('represents a $contentType body as $kind', ({ contentType, bytes, kind }) => {
    const headers: Record<string, string | string[]> = contentType === undefined ? {} : { 'content-type': contentType };
    const text = new TextDecoder().decode(bytes);
    const expected = kind === 'text' ? { text } : { bytesBase64: Buffer.from(bytes).toString('base64') };
    expect(bodyRepresentation({ headers, bytes, text })).toStrictEqual(expected);
  });
});

describe('fixtureBytes', () => {
  it('generates a deterministic 8x8 RGB PNG with valid chunk CRCs and inflatable rows', () => {
    const png = Buffer.from(fixtureBytes('image-png-8x8'));
    expect(Buffer.from(fixtureBytes('image-png-8x8'))).toStrictEqual(png);
    expect([...png.subarray(0, 8)]).toStrictEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks: { type: string; data: Buffer }[] = [];
    for (let at = 8; at < png.length; ) {
      const length = png.readUInt32BE(at);
      const typed = png.subarray(at + 4, at + 8 + length);
      expect(png.readUInt32BE(at + 8 + length)).toBe(crc32(typed));
      chunks.push({ type: typed.subarray(0, 4).toString('latin1'), data: typed.subarray(4) });
      at += 12 + length;
    }
    expect(chunks.map((chunk) => chunk.type)).toStrictEqual(['IHDR', 'IDAT', 'IEND']);
    const header = chunks[0]?.data ?? Buffer.alloc(0);
    expect([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9]]).toStrictEqual([8, 8, 8, 2]);
    const raw = inflateSync(chunks[1]?.data ?? Buffer.alloc(0));
    expect(raw).toHaveLength(8 * (1 + 8 * 3));
    // Row 2 (filter byte, then RGB triples), pixel 1.
    expect([...raw.subarray(2 * 25 + 1 + 3, 2 * 25 + 1 + 6)]).toStrictEqual([32, 64, 128]);
  });

  it('generates a one-page PDF whose cross-reference offsets point at its objects', () => {
    const text = Buffer.from(fixtureBytes('pdf-one-page')).toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
    expect(text).toContain('/Count 1');
    const xref = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
    expect(text.slice(xref).startsWith('xref\n0 6\n')).toBe(true);
    const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, i) => expect(text.slice(offset).startsWith(`${i + 1} 0 obj\n`)).toBe(true));
  });

  it('rejects an unknown fixture id, naming the known ones', () => {
    expect(() => fixtureBytes('no-such-fixture')).toThrow(GoldenConfigError);
    expect(() => fixtureBytes('no-such-fixture')).toThrow(
      'unknown file fixture no-such-fixture; known: image-png-8x8, pdf-one-page',
    );
  });
});

describe('runStep requests', () => {
  it('sends a session GET and records its request, response and route key', async () => {
    const fake = fakeOrigin({ 'GET /admin/?muraAction=cUsers.list': html('<p>Users</p>', [['x-fixture', 'one']]) });
    const { record } = await runSingle({ name: 'list', route: '/admin/?muraAction=cUsers.list' }, fake);
    expect(record).toMatchObject({ name: 'list', index: 0, routeKey: 'admin:cusers.list', extracted: {} });
    expect(record.request).toStrictEqual({
      method: 'GET',
      url: '/admin/?muraAction=cUsers.list',
      headers: {},
      body: { kind: 'none' },
    });
    expect(record.response).toMatchObject({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      text: '<p>Users</p>',
      sha256: sha256(Buffer.from('<p>Users</p>')),
      headers: { 'x-fixture': 'one', 'set-cookie': [] },
    });
    expect(record.response.hops).toHaveLength(1);
    for (const key of ['matrixKey', 'candidateIndex', 'gap', 'expected', 'decisionListRef', 'exceptionId', 'poll']) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it.each([
    {
      auth: 'basic:FIXTURE-rest-user:${secret:admin}',
      sent: `Basic ${Buffer.from(`FIXTURE-rest-user:${ADMIN_PASSWORD}`).toString('base64')}`,
      recorded: `Basic ${MASK}`,
    },
    {
      auth: 'basic:FIXTURE-rest-user:FIXTURE:colon',
      sent: `Basic ${Buffer.from('FIXTURE-rest-user:FIXTURE:colon').toString('base64')}`,
      recorded: `Basic ${Buffer.from('FIXTURE-rest-user:FIXTURE:colon').toString('base64')}`,
    },
    {
      auth: 'bearer:FIXTURE-bearer-token',
      sent: 'Bearer FIXTURE-bearer-token',
      recorded: 'Bearer FIXTURE-bearer-token',
    },
    { auth: 'session', sent: undefined, recorded: undefined },
  ])('sends and records the Authorization of auth $auth', async ({ auth, sent, recorded }) => {
    const fake = fakeOrigin({ 'GET /_api/rest/v1/default/content': json({ data: {} }) });
    const { record } = await runSingle({ name: 'rest', route: '/_api/rest/v1/default/content', auth }, fake);
    expect(callAt(fake, 0).headers.authorization).toBe(sent);
    expect(record.request.headers.authorization).toBe(recorded);
  });

  it('sends an anonymous step from an empty jar that the scenario session never sees', async () => {
    const fake = fakeOrigin({
      'GET /admin/?muraAction=cDashboard.main': html('<p>mine</p>'),
      'GET /tenant-a/': html('<p>public</p>', [['set-cookie', 'CFID=FIXTURE-anon; Path=/']]),
    });
    const s = scenario([
      { name: 'mine', route: '/admin/?muraAction=cDashboard.main' },
      { name: 'anon', route: '/tenant-a/', auth: 'anonymous' },
    ]);
    const ctx = contextFor(s, fake);
    await session(ctx).jar.setCookie('CFID=FIXTURE-cfid; Path=/', BASE);
    await runStep(ctx, s, stepAt(s, 0), { mode: 'capture', fetch: fake.fetch });
    await runStep(ctx, s, stepAt(s, 1), { mode: 'capture', fetch: fake.fetch });
    expect(callAt(fake, 0).headers.cookie).toBe('CFID=FIXTURE-cfid');
    expect(callAt(fake, 1).headers.cookie).toBeUndefined();
    expect(await session(ctx).cookieHeader()).toBe('CFID=FIXTURE-cfid');
  });

  it('resolves step headers and sends and records them lower-cased', async () => {
    const fake = fakeOrigin({ 'GET /admin/?muraAction=cArch.list': html('<p>tree</p>') });
    const { record } = await runSingle(
      {
        name: 'tree',
        route: '/admin/?muraAction=cArch.list',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-Fixture-Id': '${nodash:A-B-C}' },
      },
      fake,
    );
    expect(callAt(fake, 0).headers).toMatchObject({ 'x-requested-with': 'XMLHttpRequest', 'x-fixture-id': 'ABC' });
    expect(record.request.headers).toStrictEqual({ 'x-requested-with': 'XMLHttpRequest', 'x-fixture-id': 'ABC' });
  });

  it('form-encodes bound values: numbers by String, objects as JSON, null as empty, lists repeated', async () => {
    const fake = fakeOrigin({
      'GET /_api/json/v1/default/content/FIXTURE-1': json({ data: { count: 42, meta: { a: 1 }, none: null } }),
      'POST /admin/?muraAction=cArch.update': html('<p>saved</p>'),
    });
    const s = scenario([
      {
        name: 'source',
        route: '/_api/json/v1/default/content/FIXTURE-1',
        extract: {
          count: { from: 'body', path: 'data.count' },
          meta: { from: 'body', path: 'data.meta' },
          none: { from: 'body', path: 'data.none' },
        },
      },
      {
        name: 'save',
        method: 'POST',
        route: '/admin/?muraAction=cArch.update',
        form: {
          count: '${source.count}',
          meta: '${source.meta}',
          none: '${source.none}',
          tags: ['a', '${source.count}'],
        },
      },
    ]);
    const records = await captureAll(contextFor(s, fake), s, fake);
    const save = callAt(fake, 1);
    expect(save.headers['content-type']).toBe(FORM_TYPE);
    expect(formEntries(save)).toStrictEqual([
      ['count', '42'],
      ['meta', '{"a":1}'],
      ['none', ''],
      ['tags', 'a'],
      ['tags', '42'],
    ]);
    const record = records[1];
    expect(record?.request.body).toStrictEqual({
      kind: 'form',
      value: { count: '42', meta: '{"a":1}', none: '', tags: ['a', '42'] },
    });
    expect(record?.request.headers).toStrictEqual({ 'content-type': FORM_TYPE });
    expect(record?.routeKey).toBe('admin:carch.update');
  });

  it('sends a JSON body and records it as json', async () => {
    const fake = fakeOrigin({ 'POST /_api/json/v1/default/content': json({ data: { id: 'FIXTURE-2' } }) });
    const body = { siteid: 'default', title: 'FIXTURE page', tags: ['x'] };
    const { record } = await runSingle(
      { name: 'save', method: 'POST', route: '/_api/json/v1/default/content', body },
      fake,
    );
    const call = callAt(fake, 0);
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body?.toString('utf8') ?? '')).toStrictEqual(body);
    expect(record.request.body).toStrictEqual({ kind: 'json', value: body });
    expect(record.routeKey).toBe('api:content.save');
  });

  it('sends multipart file fixtures and records each file by digest and size', async () => {
    const fake = fakeOrigin({ 'POST /admin/?muraAction=cArch.multiFileUpload': html('<p>uploaded</p>') });
    const files = [
      { field: 'files', fixture: 'image-png-8x8', filename: 'pixel.png', contentType: 'image/png' },
      { field: 'files', fixture: 'pdf-one-page', filename: 'page.pdf', contentType: 'application/pdf' },
    ];
    const fields = { siteid: 'default', parentid: 'FIXTURE-PARENT' };
    const route = '/admin/?muraAction=cArch.multiFileUpload';
    const { record } = await runSingle({ name: 'upload', method: 'POST', route, multipart: { fields, files } }, fake);
    const png = fixtureBytes('image-png-8x8');
    const pdf = fixtureBytes('pdf-one-page');
    const call = callAt(fake, 0);
    expect(call.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(call.body?.includes(Buffer.from(png))).toBe(true);
    expect(call.body?.includes(Buffer.from(pdf))).toBe(true);
    expect(record.request.headers).toStrictEqual({ 'content-type': call.headers['content-type'] });
    const expected: RecordedBody = {
      kind: 'multipart',
      value: {
        fields,
        files: [
          { field: 'files', filename: 'pixel.png', contentType: 'image/png', sha256: sha256(png), size: png.length },
          {
            field: 'files',
            filename: 'page.pdf',
            contentType: 'application/pdf',
            sha256: sha256(pdf),
            size: pdf.length,
          },
        ],
      },
    };
    expect(record.request.body).toStrictEqual(expected);
    expect(record.routeKey).toBe('admin:carch.multifileupload{upload=image}');
  });

  it('rejects an unknown multipart fixture before sending anything', async () => {
    const fake = fakeOrigin({});
    const file = { field: 'file', fixture: 'no-such-fixture', filename: 'x.bin', contentType: 'text/plain' };
    const multipart = { files: [file] };
    const err = await configError(
      runSingle({ name: 'upload', method: 'POST', route: '/admin/?muraAction=cArch.update', multipart }, fake),
    );
    expect(err.message).toMatch(/^unknown file fixture no-such-fixture/);
    expect(fake.calls).toStrictEqual([]);
  });
});

describe('runStep route keys', () => {
  it.each<{ label: string; step: Record<string, unknown>; key: string; input: RouteKeyRequest }>([
    {
      label: 'a repeated query name',
      step: { name: 'list', route: '/admin/?muraAction=cUsers.list&tag=a&tag=b' },
      key: 'admin:cusers.list',
      input: { method: 'GET', path: '/admin/', query: { muraAction: 'cUsers.list', tag: ['a', 'b'] }, headers: {} },
    },
    {
      label: 'a method override header and JSON body',
      step: {
        name: 'remove',
        method: 'POST',
        route: '/_api/json/v1/default/content',
        headers: { 'X-HTTP-Method-Override': 'DELETE' },
        body: { id: 'FIXTURE-3' },
      },
      key: 'api:content.delete',
      input: {
        method: 'POST',
        path: '/_api/json/v1/default/content',
        query: {},
        headers: { 'x-http-method-override': 'DELETE', 'content-type': 'application/json' },
        jsonBody: { id: 'FIXTURE-3' },
      },
    },
    {
      label: 'form fields',
      step: { name: 'save', method: 'POST', route: '/admin/', form: { muraAction: 'cUsers.update' } },
      key: 'admin:cusers.update',
      input: {
        method: 'POST',
        path: '/admin/',
        query: {},
        headers: { 'content-type': FORM_TYPE },
        form: { muraAction: 'cUsers.update' },
      },
    },
  ])('keys a request with $label as routeKeyForRequest does', async ({ step, key, input }) => {
    const target = String(step.route);
    const fake = fakeOrigin({ [`${String(step.method ?? 'GET')} ${target}`]: json({}) });
    const { record } = await runSingle(step, fake);
    expect(record.routeKey).toBe(key);
    expect(record.routeKey).toBe(routeKeyForRequest(input, { appReloadKey: 'appreload' }).key);
  });

  it.each([
    { label: 'the configured reload key', routeKeyOptions: undefined, key: 'reload:application' },
    { label: 'routeKeyOptions over the env', routeKeyOptions: { appReloadKey: 'FIXTURE-other' }, key: 'page:render' },
  ])('keys a reload request with $label and redacts the configured key', async ({ routeKeyOptions, key }) => {
    const fake = fakeOrigin({ [`GET /?${RELOAD_KEY}`]: html('<p>reloaded</p>') });
    const opts: Partial<StepRunOptions> = routeKeyOptions === undefined ? {} : { routeKeyOptions };
    const { record } = await runSingle({ name: 'reload', route: '/?${secret:appreload}' }, fake, opts, {
      MURA_APPRELOADKEY: RELOAD_KEY,
    });
    expect(record.routeKey).toBe(key);
    expect(record.request.url).toBe(`/?${MASK}`);
  });
});

describe('runStep CSRF', () => {
  it('fills a fetch-form step from its csrfFrom page, explicit fields overriding hidden ones in any case', async () => {
    const fake = fakeOrigin({
      [`GET ${LOGIN_PAGE}`]: html(ADMIN_LOGIN_HTML),
      'POST /admin/?muraAction=cLogin.login': html('<p>signed in</p>'),
    });
    const s = scenario([
      { name: 'loginPage', route: LOGIN_PAGE },
      {
        name: 'login',
        method: 'POST',
        route: '/admin/?muraAction=cLogin.login',
        csrf: 'fetch-form',
        csrfFrom: 'loginPage',
        form: { username: 'admin', password: '${secret:admin}', MURAACTION: 'cLogin.login' },
      },
    ]);
    const records = await captureAll(contextFor(s, fake), s, fake);
    expect(fake.calls.map((call) => `${call.method} ${call.target}`)).toStrictEqual([
      `GET ${LOGIN_PAGE}`,
      'POST /admin/?muraAction=cLogin.login',
    ]);
    expect(formEntries(callAt(fake, 1))).toStrictEqual([
      ['returnUrl', ''],
      ['isAdminLogin', 'true'],
      ['compactDisplay', 'true'],
      ['csrf_token', LOGIN_TOKEN],
      ['csrf_token_expires', LOGIN_EXPIRES],
      ['username', 'admin'],
      ['password', ADMIN_PASSWORD],
      ['MURAACTION', 'cLogin.login'],
    ]);
    const body = records[1]?.request.body;
    expect(body).toMatchObject({ kind: 'form', value: { password: MASK, csrf_token: LOGIN_TOKEN } });
    expect(JSON.stringify(records)).not.toContain(ADMIN_PASSWORD);
  });

  const NEW_USER_FORM = '/admin/?muraAction=cUsers.editUser&siteid=default&userid=';
  const USER_UPDATE = '/admin/?muraAction=cUsers.update';
  const USER_LIST = '/admin/?muraAction=cUsers.list';
  const EXPLICIT_TOKEN = 'FIXTURE-EXPLICIT-TOKEN';
  const tokenFor = (id: string): string => createHash('md5').update(`FIXTURE:${id}`).digest('hex').toUpperCase();

  /** Legacy new-record form: every GET mints an id and a token bound to it; the update creates only on a match. */
  function mintingOrigin(): { fake: FakeOrigin; created: string[] } {
    const created: string[] = [];
    let minted = 0;
    const fake = fakeOrigin({
      [`GET ${NEW_USER_FORM}`]: () => {
        minted += 1;
        const id = `FIXTURE-USER-${minted}`;
        return html(
          `<form name="form1" method="post" action="./?muraAction=cUsers.update&amp;userid=${id}">` +
            `<input type="hidden" name="userid" value="${id}">` +
            `<input type="hidden" name="csrf_token" value="${tokenFor(id)}">` +
            `<input type="hidden" name="csrf_token_expires" value="${LOGIN_EXPIRES}"></form>`,
        )();
      },
      [`POST ${USER_UPDATE}`]: () => {
        const posted = new URLSearchParams(fake.calls.at(-1)?.body?.toString('utf8') ?? '');
        const id = posted.get('userid') ?? '';
        if (posted.get('csrf_token') !== tokenFor(id)) return html('<p>invalid token</p>', [], 500)();
        created.push(id);
        return redirect(USER_LIST)();
      },
      [`GET ${USER_LIST}`]: html('<p>users</p>'),
    });
    return { fake, created };
  }

  it.each<{ label: string; extra: Record<string, string>; token: string; created: string[]; status: number }>([
    {
      label: 'the source form token',
      extra: {},
      token: tokenFor('FIXTURE-USER-1'),
      created: ['FIXTURE-USER-1'],
      status: 302,
    },
    {
      label: 'an explicit csrf_token',
      extra: { csrf_token: EXPLICIT_TOKEN },
      token: EXPLICIT_TOKEN,
      created: [],
      status: 500,
    },
  ])('submits the bound id of a new-record form with $label', async ({ extra, token, created, status }) => {
    const { fake, created: rows } = mintingOrigin();
    const s = scenario([
      {
        name: 'create-form',
        route: NEW_USER_FORM,
        extract: { userid: { from: 'dom', selector: 'form[name=form1]', attr: 'action', param: 'userid' } },
      },
      {
        name: 'create',
        method: 'POST',
        route: USER_UPDATE,
        csrf: 'fetch-form',
        csrfFrom: 'create-form',
        form: { userid: '${create-form.userid}', action: 'Add', ...extra },
      },
    ]);
    const ctx = contextFor(s, fake);
    const records = await captureAll(ctx, s, fake);
    expect(fake.calls.filter((call) => call.target === NEW_USER_FORM)).toHaveLength(1);
    expect(ctx.bindings.get('create-form.userid')).toBe('FIXTURE-USER-1');
    expect(new URLSearchParams(callAt(fake, 1).body?.toString('utf8')).get('csrf_token')).toBe(token);
    expect(records[1]?.response.hops[0]?.status).toBe(status);
    expect(rows).toStrictEqual(created);
  });

  const pixel = { field: 'file', fixture: 'image-png-8x8', filename: 'pixel.png', contentType: 'image/png' };
  const pixelBytes = fixtureBytes('image-png-8x8');

  it.each<{ label: string; body: Record<string, unknown>; recorded: RecordedBody }>([
    { label: 'no body', body: {}, recorded: { kind: 'form', value: LOGIN_FORM_FIELDS } },
    {
      label: 'an object JSON body',
      body: { body: { title: 'FIXTURE' } },
      recorded: { kind: 'json', value: { ...LOGIN_FORM_FIELDS, title: 'FIXTURE' } },
    },
    {
      label: 'a multipart body',
      body: { multipart: { fields: { siteid: 'default' }, files: [pixel] } },
      recorded: {
        kind: 'multipart',
        value: {
          fields: { ...LOGIN_FORM_FIELDS, siteid: 'default' },
          files: [
            {
              field: 'file',
              filename: 'pixel.png',
              contentType: 'image/png',
              sha256: sha256(pixelBytes),
              size: pixelBytes.length,
            },
          ],
        },
      },
    },
  ])('adds the step page form tokens beneath $label', async ({ body, recorded }) => {
    const fake = fakeOrigin({
      [`GET ${LOGIN_PAGE}`]: html(ADMIN_LOGIN_HTML),
      [`POST ${LOGIN_PAGE}`]: html('<p>ok</p>'),
    });
    const step = { name: 'submit', method: 'POST', route: LOGIN_PAGE, csrf: 'fetch-form', ...body };
    const { record } = await runSingle(step, fake);
    expect(record.request.body).toStrictEqual(recorded);
    expect(callAt(fake, 1).body?.toString('latin1')).toContain(LOGIN_TOKEN);
  });

  it('rejects a fetch-form step whose JSON body is not an object, after fetching only the form page', async () => {
    const fake = fakeOrigin({ [`GET ${LOGIN_PAGE}`]: html(ADMIN_LOGIN_HTML) });
    const err = await configError(
      runSingle({ name: 'submit', method: 'POST', route: LOGIN_PAGE, csrf: 'fetch-form', body: ['FIXTURE'] }, fake),
    );
    expect(err.message).toBe(`${SCENARIO} step submit: csrf fetch-form needs a form, multipart or object body`);
    expect(fake.calls.map((call) => call.target)).toStrictEqual([LOGIN_PAGE]);
  });

  it.each([
    { label: 'names no step of the scenario it runs in', withSource: false, why: 'names no step' },
    { label: 'names a step that ran only in another context', withSource: true, why: 'has not run in this scenario' },
  ])('rejects a csrfFrom that $label before sending anything', async ({ withSource, why }) => {
    const fake = fakeOrigin({ [`GET ${LOGIN_PAGE}`]: html(ADMIN_LOGIN_HTML) });
    const s = scenario([
      { name: 'loginPage', route: LOGIN_PAGE },
      { name: 'login', method: 'POST', route: LOGIN_PAGE, csrf: 'fetch-form', csrfFrom: 'loginPage' },
    ]);
    const opts: StepRunOptions = { mode: 'capture', fetch: fake.fetch };
    if (withSource) await runStep(contextFor(s, fake), s, stepAt(s, 0), opts);
    const sent = fake.calls.length;
    const step = stepAt(s, 1);
    const runIn = withSource ? s : { id: s.id, steps: [step] };
    const err = await configError(runStep(contextFor(s, fake), runIn, step, opts));
    expect(err.message).toBe(`${SCENARIO} step login: csrfFrom loginPage ${why}`);
    expect(fake.calls).toHaveLength(sent);
  });

  it.each<{ label: string; step: Record<string, unknown>; site: string }>([
    {
      label: 'its JSON API path segment',
      step: { method: 'POST', route: '/_api/json/v1/tenant-a/content', body: { siteid: 'tenant-b' } },
      site: 'tenant-a',
    },
    { label: 'a siteid query parameter in any case', step: { route: '/tenant-x/?SiteID=tenant-b' }, site: 'tenant-b' },
    {
      label: 'a form siteid field',
      step: { method: 'POST', route: '/admin/?muraAction=cArch.update', form: { SITEID: 'tenant-c' } },
      site: 'tenant-c',
    },
    {
      label: 'a JSON body siteid field',
      step: { method: 'POST', route: '/admin/?muraAction=cArch.update', body: { siteId: 'tenant-d' } },
      site: 'tenant-d',
    },
    { label: 'an empty siteid, falling back to default', step: { route: '/admin/?siteid=' }, site: 'default' },
    {
      label: 'no site at all, falling back to default',
      step: { route: '/admin/?muraAction=cArch.list' },
      site: 'default',
    },
  ])('fetches json-api tokens for the site from $label', async ({ step, site }) => {
    const fake = fakeOrigin({
      [`GET /_api/json/v1/${site}/generateCSRFTokens?context=editContent`]: json({
        data: { csrf_token: API_TOKEN, csrf_token_expires: API_EXPIRES },
      }),
      [`${String(step.method ?? 'GET')} ${String(step.route)}`]: json({}),
    });
    const { record } = await runSingle({ name: 'api', csrf: 'json-api:editContent', ...step }, fake);
    const tokens = { 'x-csrf_token': API_TOKEN, 'x-csrf_token_expires': API_EXPIRES };
    expect(callAt(fake, 1).headers).toMatchObject(tokens);
    expect(record.request.headers).toMatchObject(tokens);
  });
});

describe('runStep matrix', () => {
  it('runs every combination, the first declared name varying slowest, and clears the matrix bindings', async () => {
    const targets = ['a=1&b=x', 'a=1&b=y', 'a=2&b=x', 'a=2&b=y'].map((q) => `/admin/?muraAction=cUsers.list&${q}`);
    const fake = fakeOrigin(Object.fromEntries(targets.map((target) => [`GET ${target}`, json({})])));
    const s = scenario([
      {
        name: 'list',
        route: '/admin/?muraAction=cUsers.list&a=${matrix.a}&b=${matrix.b}',
        matrix: { a: ['1', '2'], b: ['x', 'y'] },
      },
    ]);
    const ctx = contextFor(s, fake);
    const records = await runStep(ctx, s, stepAt(s, 0), { mode: 'capture', index: 3, fetch: fake.fetch });
    expect(records.map((record) => record.matrixKey)).toStrictEqual(['a=1,b=x', 'a=1,b=y', 'a=2,b=x', 'a=2,b=y']);
    expect(records.map((record) => record.index)).toStrictEqual([3, 3, 3, 3]);
    expect(fake.calls.map((call) => call.target)).toStrictEqual(targets);
    expect([...ctx.bindings.keys()].filter((key) => key.startsWith('matrix.'))).toStrictEqual([]);
  });

  it('resolves a matrix value per combination while its key keeps the declared value', async () => {
    const fake = fakeOrigin({
      'GET /_api/json/v1/default/content': json({ data: { items: [{ contentid: 'FIXTURE-C-1' }] } }),
      'GET /admin/?muraAction=cArch.edit&contentid=FIXTURE-C-1': html('<p>one</p>'),
      'GET /admin/?muraAction=cArch.edit&contentid=FIXTURE-LITERAL': html('<p>two</p>'),
    });
    const s = scenario([
      {
        name: 'find',
        route: '/_api/json/v1/default/content',
        extract: { first: { from: 'body', path: 'data.items[0].contentid' } },
      },
      {
        name: 'open',
        route: '/admin/?muraAction=cArch.edit&contentid=${matrix.id}',
        matrix: { id: ['${find.first}', 'FIXTURE-LITERAL'] },
      },
    ]);
    const records = await captureAll(contextFor(s, fake), s, fake);
    expect(records.map((record) => record.matrixKey)).toStrictEqual([
      undefined,
      'id=${find.first}',
      'id=FIXTURE-LITERAL',
    ]);
    expect(records.map((record) => record.request.url)).toStrictEqual(fake.calls.map((call) => call.target));
  });

  it('sends each combination in the session its matrix as names', async () => {
    const fake = fakeOrigin({ 'GET /admin/': html('<p>home</p>') });
    const step = { name: 'home', route: '/admin/', as: '${matrix.who}', matrix: { who: ['admin', 'editor'] } };
    const s = scenario([step], TWO_SESSIONS);
    const ctx = contextFor(s, fake);
    await session(ctx, 'admin').jar.setCookie('CFID=FIXTURE-admin; Path=/', BASE);
    await session(ctx, 'editor').jar.setCookie('CFID=FIXTURE-editor; Path=/', BASE);
    await runStep(ctx, s, stepAt(s, 0), { mode: 'capture', fetch: fake.fetch });
    expect(fake.calls.map((call) => call.headers.cookie)).toStrictEqual(['CFID=FIXTURE-admin', 'CFID=FIXTURE-editor']);
  });

  it('rejects a route that resolves to a non-string and still clears the matrix binding', async () => {
    const fake = fakeOrigin({ 'GET /_api/json/v1/default/count': json({ n: 7 }) });
    const s = scenario([
      { name: 'count', route: '/_api/json/v1/default/count', extract: { n: { from: 'body', path: 'n' } } },
      { name: 'jump', route: '${matrix.target}', matrix: { target: ['${count.n}'] } },
    ]);
    const ctx = contextFor(s, fake);
    const err = await configError(captureAll(ctx, s, fake));
    expect(err.message).toBe(`${SCENARIO} step jump: route does not resolve to a string`);
    expect(ctx.bindings.get('count.n')).toBe(7);
    expect(ctx.bindings.has('matrix.target')).toBe(false);
  });
});

describe('runStep candidates', () => {
  const api = '/_api/json/v1/default/content';
  const candidateStep = {
    name: 'boom',
    route: api,
    candidates: [{ route: `${api}?method=a` }, { route: `${api}?method=b` }, { route: `${api}?method=c` }],
  };

  it('keeps the first candidate legacy answers with the server_error envelope on capture', async () => {
    const fake = fakeOrigin({
      [`GET ${api}?method=a`]: json(BAD_REQUEST_ENVELOPE, 400),
      [`GET ${api}?method=b`]: json(SERVER_ERROR_ENVELOPE, 500),
    });
    const { record } = await runSingle(candidateStep, fake);
    expect(record.candidateIndex).toBe(1);
    expect(record).not.toHaveProperty('gap');
    expect(record.response.status).toBe(500);
    expect(record.request.url).toBe(`${api}?method=b`);
    expect(fake.calls).toHaveLength(2);
  });

  it('records the last candidate as a gap when none answers with server_error', async () => {
    const fake = fakeOrigin({
      [`GET ${api}?method=a`]: json(BAD_REQUEST_ENVELOPE, 400),
      [`GET ${api}?method=b`]: html('<p>500</p>', [], 500),
      [`GET ${api}?method=c`]: json({ error: { code: 'server_error' } }, 200),
    });
    const { record } = await runSingle(candidateStep, fake);
    expect(record.gap).toStrictEqual({ reason: GAP_REASON, candidatesTried: 3 });
    expect(record.candidateIndex).toBe(2);
    expect(record.request.url).toBe(`${api}?method=c`);
  });

  it('rejects an empty candidate list on capture', async () => {
    const fake = fakeOrigin({});
    const s = scenario([candidateStep]);
    const step = { ...stepAt(s, 0), candidates: [] };
    const err = await configError(runStep(contextFor(s, fake), s, step, { mode: 'capture', fetch: fake.fetch }));
    expect(err.message).toBe(`${SCENARIO} step boom: candidates is empty`);
  });

  it.each<{ label: string; choice: number | undefined; target: string; candidateIndex: number | undefined }>([
    { label: 'the chosen candidate', choice: 2, target: `${api}?method=c`, candidateIndex: 2 },
    { label: "the step's own request without a choice", choice: undefined, target: api, candidateIndex: undefined },
  ])('sends only $label on replay', async ({ choice, target, candidateIndex }) => {
    const fake = fakeOrigin({ [`GET ${target}`]: json(SERVER_ERROR_ENVELOPE, 500) });
    const opts: Partial<StepRunOptions> = { mode: 'replay' };
    if (choice !== undefined) opts.candidateIndex = choice;
    const { record } = await runSingle(candidateStep, fake, opts);
    expect(fake.calls.map((call) => call.target)).toStrictEqual([target]);
    expect(record.candidateIndex).toBe(candidateIndex);
    expect(record).not.toHaveProperty('gap');
  });

  it('asks the chooser once per step name and matrix key on replay', async () => {
    const fake = fakeOrigin({ [`GET ${api}?m=p`]: json({}), [`GET ${api}?own=q`]: json({}) });
    const asked: [string, string | undefined][] = [];
    const choice: CandidateChoice = (step, matrixKey) => {
      asked.push([step, matrixKey]);
      return matrixKey === 'm=p' ? 0 : undefined;
    };
    const s = scenario([
      {
        name: 'pick',
        route: `${api}?own=\${matrix.m}`,
        matrix: { m: ['p', 'q'] },
        candidates: [{ route: `${api}?m=\${matrix.m}` }],
      },
    ]);
    const records = await runStep(contextFor(s, fake), s, stepAt(s, 0), {
      mode: 'replay',
      candidateIndex: choice,
      fetch: fake.fetch,
    });
    expect(asked).toStrictEqual([
      ['pick', 'm=p'],
      ['pick', 'm=q'],
    ]);
    expect(records.map((record) => [record.request.url, record.candidateIndex])).toStrictEqual([
      [`${api}?m=p`, 0],
      [`${api}?own=q`, undefined],
    ]);
  });

  it('rejects a replay choice the step has no candidate for', async () => {
    const fake = fakeOrigin({});
    const err = await configError(runSingle(candidateStep, fake, { mode: 'replay', candidateIndex: 5 }));
    expect(err.message).toBe(`${SCENARIO} step boom: has no candidate 5`);
    expect(fake.calls).toStrictEqual([]);
  });
});

describe('runStep poll', () => {
  it('repeats the request until the polled path equals the value, compared as strings', async () => {
    const fake = fakeOrigin({
      'GET /_api/json/v1/default/job': [
        json({ data: { progress: '40' } }),
        html('<p>busy</p>'),
        json({ data: { progress: '100' } }),
      ],
    });
    const { record } = await runSingle(
      {
        name: 'job',
        route: '/_api/json/v1/default/job',
        poll: { until: { path: 'data.progress', equals: 100 }, intervalMs: 1, timeoutMs: 10_000 },
      },
      fake,
    );
    expect(fake.calls).toHaveLength(3);
    expect(record.response).toMatchObject({ text: '{"data":{"progress":"100"}}' });
    expect(record.poll).toStrictEqual({ observed: ['40', '100'] });
  });

  it('rejects a poll whose condition does not hold within its bound, naming the last status', async () => {
    const fake = fakeOrigin({ 'GET /_api/json/v1/default/job': json({ data: { status: 'queued' } }, 202) });
    const err = await configError(
      runSingle(
        {
          name: 'job',
          route: '/_api/json/v1/default/job',
          poll: { until: { path: 'data.status', equals: 'done' }, intervalMs: 2, timeoutMs: 4 },
        },
        fake,
      ),
    );
    expect(err.message).toBe(`${SCENARIO} step job: poll data.status did not equal done within 4 ms (last status 202)`);
    expect(fake.calls.length).toBeGreaterThanOrEqual(1);
  });

  const JOB = '/legacy-fixtures/cfml/api.cfm/reporting/exports/FIXTURE-JOB?siteid=tenant-a';
  const CREATED = '2026-06-30T12:00:00';
  const LIFECYCLE = [
    { state: 'queued', at: 'data.created' },
    { state: 'running', at: 'data.started_at' },
    { state: 'done', at: 'data.finished_at' },
  ];
  const lifecycleStep = (lifecycle: unknown = LIFECYCLE): Record<string, unknown> => ({
    name: 'poll',
    route: JOB,
    poll: { until: { path: 'data.state', equals: 'done' }, intervalMs: 1, timeoutMs: 10_000, lifecycle },
  });
  const job = (state: string, started: string, finished: string): Reply =>
    json({ data: { state, created: CREATED, started_at: started, finished_at: finished } });

  it('records each polled state once, in order, and the lifecycle the satisfying body proves', async () => {
    const fake = fakeOrigin({
      [`GET ${JOB}`]: [
        job('queued', '', ''),
        job('queued', '', ''),
        job('running', '2026-06-30T12:00:01', ''),
        job('running', '2026-06-30T12:00:01', ''),
        job('done', '2026-06-30T12:00:01', '2026-06-30T12:00:01'),
      ],
    });
    const { record } = await runSingle(lifecycleStep(), fake);
    expect(fake.calls).toHaveLength(5);
    expect(record.poll).toStrictEqual({
      observed: ['queued', 'running', 'done'],
      lifecycle: ['queued', 'running', 'done'],
    });
  });

  const NO_RUNNING = 'poll lifecycle state running has no timestamp at data.started_at';

  it.each([
    { label: 'running was skipped', started: '', message: NO_RUNNING },
    { label: 'a timestamp is not a date', started: 'pending', message: NO_RUNNING },
    {
      label: 'states are out of order',
      started: '2026-06-30T12:00:04',
      message: 'poll lifecycle state done at data.finished_at precedes state running',
    },
  ])('rejects a satisfied poll whose body does not prove the lifecycle when $label', async ({ started, message }) => {
    const fake = fakeOrigin({ [`GET ${JOB}`]: job('done', started, '2026-06-30T12:00:03') });
    const err = await configError(runSingle(lifecycleStep(), fake));
    expect(err.message).toBe(`${SCENARIO} step poll: ${message}`);
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    { label: 'is empty', lifecycle: [], message: 'Too small: expected array to have >=1 items' },
    { label: 'repeats a state', lifecycle: [LIFECYCLE[0], LIFECYCLE[0], LIFECYCLE[2]], message: 'must not repeat' },
    { label: 'ends off until.equals', lifecycle: LIFECYCLE.slice(0, 2), message: 'must end with the state' },
    { label: 'has an unknown key', lifecycle: [{ ...LIFECYCLE[2], extra: 'x' }], message: 'Unrecognized key' },
  ])('rejects a poll lifecycle that $label', ({ lifecycle, message }) => {
    expect(() => scenario([lifecycleStep(lifecycle)])).toThrow(message);
  });
});

describe('runScenarioSteps', () => {
  it('calls the settle hook with the step settle and bound before extracting, for settling steps only', async () => {
    const fake = fakeOrigin({
      'POST /_api/json/v1/tenant-a/person/archive': json({ data: { id: 'FIXTURE-P-1' } }),
      'GET /_api/json/v1/tenant-a/person': json({ data: {} }),
    });
    const s = scenario([
      {
        name: 'archive',
        method: 'POST',
        route: '/_api/json/v1/tenant-a/person/archive',
        settle: 'seam:people.person.archived.v1',
        extract: { id: { from: 'body', path: 'data.id' } },
      },
      { name: 'list', route: '/_api/json/v1/tenant-a/person' },
    ]);
    const ctx = contextFor(s, fake);
    const seen: { spec: string; timeoutMs: number; bound: boolean }[] = [];
    await runScenarioSteps(ctx, s, {
      mode: 'capture',
      login: false,
      fetch: fake.fetch,
      settle: async (spec, timeoutMs) => {
        seen.push({ spec, timeoutMs, bound: ctx.bindings.has('archive.id') });
      },
    });
    const settled = { spec: 'seam:people.person.archived.v1', timeoutMs: SETTLE_TIMEOUT_MS, bound: false };
    expect(seen).toStrictEqual([settled]);
    expect(ctx.bindings.get('archive.id')).toBe('FIXTURE-P-1');
  });

  it('runs a settling step without a hook', async () => {
    const fake = fakeOrigin({ 'GET /_api/json/v1/tenant-a/person': json({}) });
    const step = { name: 'list', route: '/_api/json/v1/tenant-a/person', settle: 'projection' };
    const { record } = await runSingle(step, fake);
    expect(record.response.status).toBe(200);
  });

  it('skips the steps onBeforeStep skips, ends at stop, and stamps each record with its scenario index', async () => {
    const target = (n: number): string => `/admin/?muraAction=cUsers.list&n=${n}`;
    const fake = fakeOrigin({ [`GET ${target(0)}`]: json({}), [`GET ${target(2)}`]: json({}) });
    const s = scenario([0, 1, 2, 3, 4].map((n) => ({ name: `s${n}`, route: target(n) })));
    const asked: [number, string][] = [];
    const records = await runScenarioSteps(contextFor(s, fake), s, {
      mode: 'capture',
      login: false,
      fetch: fake.fetch,
      onBeforeStep: async (index, step) => {
        asked.push([index, step.name]);
        return index === 1 ? 'skip' : index === 3 ? 'stop' : undefined;
      },
    });
    expect(asked).toStrictEqual([
      [0, 's0'],
      [1, 's1'],
      [2, 's2'],
      [3, 's3'],
    ]);
    expect(records.map((record) => [record.name, record.index])).toStrictEqual([
      ['s0', 0],
      ['s2', 2],
    ]);
  });

  it('logs declared sessions in first and redacts the secrets the login resolved from every record', async () => {
    const fake = fakeOrigin({
      [`GET ${LOGIN_PAGE}`]: html(ADMIN_LOGIN_HTML),
      'POST /admin/index.cfm': redirect('./', [
        'CFID=FIXTURE-cfid; Path=/; HttpOnly',
        'CFTOKEN=FIXTURE-cftoken; Path=/; HttpOnly',
      ]),
      'GET /admin/': html('<p>dashboard</p>'),
      'GET /admin/?muraAction=cDashboard.main': html(`<p>echo ${ADMIN_PASSWORD}</p>`),
    });
    const s = scenario([{ name: 'home', route: '/admin/?muraAction=cDashboard.main' }], {
      admin: { login: 'admin', via: 'admin' },
    });
    const records = await runScenarioSteps(contextFor(s, fake), s, { mode: 'capture', fetch: fake.fetch });
    expect(fake.calls.map((call) => `${call.method} ${call.target}`)).toStrictEqual([
      `GET ${LOGIN_PAGE}`,
      'POST /admin/index.cfm',
      'GET /admin/',
      'GET /admin/?muraAction=cDashboard.main',
    ]);
    expect(formEntries(callAt(fake, 1))).toContainEqual(['password', ADMIN_PASSWORD]);
    expect(callAt(fake, 3).headers.cookie).toBe('CFID=FIXTURE-cfid; CFTOKEN=FIXTURE-cftoken');
    expect(only(records).response).toMatchObject({ text: `<p>echo ${MASK}</p>` });
  });

  it('sends no login requests with login false', async () => {
    const fake = fakeOrigin({ 'GET /admin/?muraAction=cDashboard.main': html('<p>dashboard</p>') });
    const s = scenario([{ name: 'home', route: '/admin/?muraAction=cDashboard.main' }], {
      admin: { login: 'admin', via: 'admin' },
    });
    await runScenarioSteps(contextFor(s, fake), s, { mode: 'capture', login: false, fetch: fake.fetch });
    expect(fake.calls.map((call) => call.target)).toStrictEqual(['/admin/?muraAction=cDashboard.main']);
  });
});

describe('runStep extraction', () => {
  it('binds body, dom, header and location-query values into later routes', async () => {
    const editPage = '/admin/?muraAction=cUsers.edituser&userID=FIXTURE-USER-9';
    const fake = fakeOrigin({
      'POST /admin/?muraAction=cUsers.update': redirect('./?muraAction=cUsers.edituser&userID=FIXTURE-USER-9'),
      [`GET ${editPage}`]: html(
        '<h1>  Edit User </h1><a id="back" href="./?muraAction=cUsers.list&SiteID=tenant-a">Back</a>' +
          '<input id="uid" name="userid" value="FIXTURE-USER-9">',
        [
          ['etag', 'FIXTURE-ETAG'],
          ['x-record-url', '/admin/?muraAction=cUsers.edituser&userid=FIXTURE-USER-9'],
        ],
      ),
      'GET /_api/json/v1/tenant-a/user': json({ DATA: { Items: [{ id: 'FIXTURE-A' }, { ID: 'FIXTURE-B' }] } }),
      'GET /admin/?muraAction=cUsers.edituser&userid=FIXTURE-B&site=tenant-a&tag=FIXTURE-ETAG': html('<p>ok</p>'),
    });
    const s = scenario([
      {
        name: 'create',
        method: 'POST',
        route: '/admin/?muraAction=cUsers.update',
        extract: {
          userId: { from: 'location-query', param: 'userid' },
          heading: { from: 'dom', selector: 'h1' },
          inputId: { from: 'dom', selector: '#uid', attr: 'value' },
          backSite: { from: 'dom', selector: '#back', attr: 'href', param: 'siteid' },
          etag: { from: 'header:ETag' },
          recordUser: { from: 'header:X-Record-Url', param: 'userid' },
        },
      },
      {
        name: 'lookup',
        route: '/_api/json/v1/tenant-a/user',
        extract: { second: { from: 'body', path: 'data.items[1].id' } },
      },
      {
        name: 'use',
        route: '/admin/?muraAction=cUsers.edituser&userid=${lookup.second}&site=${create.backSite}&tag=${create.etag}',
      },
    ]);
    const ctx = contextFor(s, fake);
    const records = await runScenarioSteps(ctx, s, { mode: 'capture', login: false, fetch: fake.fetch });
    expect(records[0]?.extracted).toStrictEqual({
      userId: 'FIXTURE-USER-9',
      heading: 'Edit User',
      inputId: 'FIXTURE-USER-9',
      backSite: 'tenant-a',
      etag: 'FIXTURE-ETAG',
      recordUser: 'FIXTURE-USER-9',
    });
    expect(records[0]?.response.hops.map((hop) => hop.status)).toStrictEqual([302, 200]);
    expect(records[1]?.extracted).toStrictEqual({ second: 'FIXTURE-B' });
    expect(ctx.bindings.get('create.userId')).toBe('FIXTURE-USER-9');
    expect(ctx.bindings.get('lookup.second')).toBe('FIXTURE-B');
    expect(records[2]?.request.url).toBe(
      '/admin/?muraAction=cUsers.edituser&userid=FIXTURE-B&site=tenant-a&tag=FIXTURE-ETAG',
    );
  });

  const page = html('<a id="link" href="/admin/?muraAction=cUsers.list">Users</a>', [
    ['x-present', 'http://127.0.0.1:8500/admin/?a=1'],
  ]);
  const listing = json({ data: { items: [{ id: 'FIXTURE-A' }] } });
  const absentPath = (bodyPath: string, reply: Reply): { extraction: Extraction; reply: Reply; why: string } => ({
    extraction: { from: 'body', path: bodyPath },
    reply,
    why: `no ${bodyPath} in the response body`,
  });

  it.each<{ extraction: Extraction; reply: Reply; why: string }>([
    absentPath('data.id', page),
    absentPath('data.title', listing),
    absentPath('data.items[3].id', listing),
    absentPath('data.items.first', listing),
    absentPath('data.items[0].id.deeper', listing),
    { extraction: { from: 'dom', selector: '#absent' }, reply: page, why: 'no element matches #absent' },
    { extraction: { from: 'dom', selector: '#link', attr: 'rel' }, reply: page, why: '#link has no rel attribute' },
    {
      extraction: { from: 'dom', selector: '#link', attr: 'href', param: 'userid' },
      reply: page,
      why: 'no userid parameter in the extracted URL',
    },
    { extraction: { from: 'header:X-Absent' }, reply: page, why: 'no x-absent response header' },
    { extraction: { from: 'header:X-Present', param: 'b' }, reply: page, why: 'no b parameter in the extracted URL' },
    { extraction: { from: 'location-query', param: 'uid' }, reply: page, why: 'no redirect Location carries uid' },
  ])('rejects an extraction from $extraction.from that finds nothing: $why', async ({ extraction, reply, why }) => {
    const fake = fakeOrigin({ 'GET /admin/?muraAction=cUsers.list': reply });
    const err = await configError(
      runSingle({ name: 'read', route: '/admin/?muraAction=cUsers.list', extract: { value: extraction } }, fake),
    );
    expect(err.message).toBe(`${SCENARIO} step read: binding value: ${why} (status 200)`);
  });
});

describe('runStep records', () => {
  it.each([
    { expected: 'withheld', decisionListRef: 'admin:cusers.delete' },
    { expected: 'halted', exceptionId: 'EX-ID-01' },
    { expected: 'gap' },
  ])('carries the declared outcome $expected onto the record', async (declared) => {
    const fake = fakeOrigin({ 'GET /admin/?muraAction=cUsers.list': json({}) });
    const { record } = await runSingle({ name: 'list', route: '/admin/?muraAction=cUsers.list', ...declared }, fake);
    const outcomeKeys = ['expected', 'decisionListRef', 'exceptionId'];
    const outcome = Object.fromEntries(Object.entries(record).filter(([key]) => outcomeKeys.includes(key)));
    expect(outcome).toStrictEqual(declared);
  });

  it('records a binary response as base64 with its digest, headers and cookies', async () => {
    const cookie = 'FIXTURE-download=1; Path=/';
    const fake = fakeOrigin({
      'GET /_api/render/file/?fileid=FIXTURE-FILE': () =>
        new Response(TINY_PDF, { headers: [['content-type', 'application/pdf'], ['set-cookie', cookie]] }),
    });
    const { record } = await runSingle({ name: 'file', route: '/_api/render/file/?fileid=FIXTURE-FILE' }, fake);
    expect(record.response).toMatchObject({
      status: 200,
      contentType: 'application/pdf',
      bytesBase64: TINY_PDF.toString('base64'),
      sha256: sha256(TINY_PDF),
      headers: { 'content-type': 'application/pdf', 'set-cookie': [cookie] },
    });
    expect(record.response).not.toHaveProperty('text');
  });
});
