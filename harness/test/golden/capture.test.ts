// Golden capture against a fake legacy origin and Mailpit; every set and exceptions-list write lands in a temp tree.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { LEGACY_ERROR_MAP, cfHash, esapiUrlEncode } from '@opt2/platform/legacy-compat';
import { createLogger, type Logger } from '@opt2/platform/logging';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXCEPTIONS_LIST_PATH,
  GENERATED_BY,
  appendExceptionEntry,
  assertNoReloadKey,
  assertNoSecrets,
  captureScenario,
  gapExceptionId,
  goldenSetPath,
  goldenSetSchema,
  main,
  rawCapturePath,
  readGoldenSet,
  writeCapture,
  type CaptureDeps,
  type CapturedScenario,
  type FetchLike,
  type GoldenSet,
  type GoldenStep,
  type RawCapture,
} from '../../src/golden/capture.js';
import {
  FIXTURES_UNAVAILABLE,
  loadCatalogue,
  readFixtureStatus,
  scenarioById,
  scenarioSchema,
  type FixtureStatus,
  type Scenario,
} from '../../src/golden/catalogue.js';
import { haltEvidence, type ExceptionEntry } from '../../src/golden/errors.js';
import { ETAG_OK } from '../../src/golden/normalise/index.js';
import { RULES_PATH, loadRules, type NormaliseRules } from '../../src/golden/normalise/rules.js';
import { loadSecretStore, secretValues } from '../../src/golden/session.js';
import { GAP_REASON } from '../../src/golden/steps.js';
import { REPO_ROOT, isInsideRepo, type EnvLike } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

// A temp tree mirroring the checkout layout, so redirected paths keep their repository-relative tails.
const redirect = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2-capture-test-'));
  return {
    root,
    setsDir: path.join(root, 'harness', 'golden', 'sets'),
    exceptionsFile: path.join(root, 'opt2', 'exceptions-list.json'),
    enabled: true,
  };
});

// goldenSetPath and EXCEPTIONS_LIST_PATH have no injection point, so the committed locations are mapped here.
vi.mock('../../src/lib/paths.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/paths.js')>();
  const { join, relative, sep } = process.getBuiltinModule('node:path');
  const sets = real.repoPath('harness', 'golden', 'sets');
  const exceptions = real.opt2Path('exceptions-list.json');
  const redirected = (file: string): string => {
    if (!redirect.enabled) return file;
    if (file === exceptions) return redirect.exceptionsFile;
    if (file === sets || file.startsWith(`${sets}${sep}`)) return join(redirect.setsDir, relative(sets, file));
    return file;
  };
  return {
    ...real,
    repoPath: (...segments: string[]) => redirected(real.repoPath(...segments)),
    opt2Path: (...segments: string[]) => redirected(real.opt2Path(...segments)),
  };
});

const fixture = (relativePath: string): string =>
  fileURLToPath(new URL(`../fixtures/${relativePath}`, import.meta.url));

const CATALOGUE_FIXTURE = fixture('golden/catalogue.valid.yaml');
const SAMPLE = JSON.parse(readFileSync(fixture('golden/golden-set.sample.json'), 'utf8')) as GoldenSet;
const ETAG_FIXTURE = JSON.parse(readFileSync(fixture('http/headers-etag.json'), 'utf8')) as {
  headers: Record<string, string>;
};
const SUCCESS_ENVELOPE = readFileSync(fixture('http/envelope-success.json'), 'utf8');
const FIXTURES_UNAVAILABLE_FILE = fixture('reporting/fixtures-unavailable.json');
const MINI_EXCEPTIONS_FILE = fixture('inventory/mini-exceptions-list.json');

const COMMITTED_SETS = path.join(REPO_ROOT, 'harness', 'golden', 'sets');
const COMMITTED_EXCEPTIONS = path.join(REPO_ROOT, 'opt2', 'exceptions-list.json');

const SHA = pinnedSha();
const LEGACY_PORT = '8580';
const LEGACY = `http://127.0.0.1:${LEGACY_PORT}`;
const MAILPIT = 'http://127.0.0.1:8525';
const RESET = 'DELETE /api/v1/messages';
const ADMIN_PASSWORD = ['FIXTURE', 'ADMIN', 'PASSWORD'].join('-');
const CAPTURED_AT = new Date(SAMPLE.capturedAt);

const SAMPLE_STEP = SAMPLE.steps[0] as GoldenStep;
const CONTENT_ID = SAMPLE_STEP.request.url.split('/').at(-1) as string;
const HISTORY_ID = 'A2A2A2A2-2222-2222-2222222222222222';
const FINDONE_PATH = `/index.cfm/_api/json/v1/tenant-a/content/${CONTENT_ID}`;
const FINDONE_BODY = JSON.stringify({
  apiversion: 'v1',
  method: 'findOne',
  data: {
    contenthistid: HISTORY_ID,
    contentid: CONTENT_ID,
    entityname: 'content',
    filename: 'about-us',
    id: CONTENT_ID,
    parentid: '00000000000000000000000000000000001',
    siteid: 'tenant-a',
    title: 'About Us',
    type: 'Page',
  },
});

const DATASET = {
  businessDate: '2026-06-30',
  masa: { content: [{ siteID: 'tenant-a', type: 'Page', contentid: CONTENT_ID }] },
};
const FIXTURES_AVAILABLE: FixtureStatus = { available: true, reason: null, checkedAt: '2026-06-30T00:00:00Z' };

const LOGIN_PAGE =
  '<html><head><title>Login</title></head><body><form name="frmLogin" method="post" action="./index.cfm">' +
  '<input type="hidden" name="csrf_token" value="fixture-csrf">' +
  '<input type="hidden" name="csrf_token_expires" value="260630131500000">' +
  '<input type="text" name="username"><input type="password" name="password"></form></body></html>';
const DASHBOARD = '<html><head><title>Masa CMS</title></head><body><h1>Dashboard</h1></body></html>';

/** One request the fake legacy origin received. */
interface FakeRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

/** Scenario-specific answer of the fake legacy origin; `undefined` falls through to the default routes. */
type Route = (req: FakeRequest) => Response | undefined;

interface FakeLegacy {
  fetch: FetchLike;
  /** {@link RESET} per Mailpit reset and `<METHOD> <path?query>` per legacy request, in arrival order. */
  events: string[];
  /** Headers of each legacy request, in arrival order. */
  headers: Record<string, string>[];
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json;charset=utf-8' } });
}

/**
 * The findOne answer with the legacy wire headers; `echo` comes back as `X-Fixture-Echo`. The ETag is `cfHash`, the
 * uppercase SHA-256 the normalise rules check on ACF 2023, not MD5.
 */
function findOne(echo: string | undefined): Response {
  const headers: Record<string, string> = { ...ETAG_FIXTURE.headers, ETag: cfHash(FINDONE_BODY) };
  if (echo !== undefined) headers['X-Fixture-Echo'] = echo;
  return new Response(FINDONE_BODY, { headers });
}

/** Default legacy routes: GS-CO-05's findOne and GS-ID-01's admin pages; the login answer echoes the password. */
function legacyAnswer(req: FakeRequest): Response {
  const { pathname, searchParams } = req.url;
  if (pathname === FINDONE_PATH) return findOne(req.headers['x-fixture-credential']);
  if (pathname.startsWith('/admin/')) {
    if (searchParams.get('muraAction') === 'cLogin.main') return html(LOGIN_PAGE);
    if (req.method === 'POST') {
      const password = new URLSearchParams(req.body).get('password') ?? '';
      return html(`<html><body><div class="alert">Signed in with ${password}</div></body></html>`);
    }
    return html(DASHBOARD);
  }
  throw new Error(`unscripted legacy request ${req.method} ${pathname}`);
}

/** Fake legacy origin on `LEGACY` plus an empty Mailpit on `MAILPIT`; any other request throws. */
function fakeLegacy(route?: Route): FakeLegacy {
  const events: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    if (url.origin === MAILPIT && url.pathname === '/api/v1/messages') {
      if (method !== 'DELETE') return Response.json({ total: 0, messages: [] });
      events.push(RESET);
      return new Response('ok');
    }
    if (url.origin !== LEGACY) throw new Error(`unscripted request ${method} ${url.href}`);
    const req: FakeRequest = {
      method,
      url,
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? init.body : '',
    };
    events.push(`${method} ${url.pathname}${url.search}`);
    headers.push(req.headers);
    return route?.(req) ?? legacyAnswer(req);
  };
  return { fetch, events, headers };
}

let rules: NormaliseRules;
let catalogueCo05: Scenario;
let committed: ReturnType<typeof committedState>;
let stateDir = '';

/** SHA-256 of the committed exceptions list and the sorted files of the committed sets folder with their digests. */
function committedState(): { exceptions: string | null; sets: string[] } {
  const digest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
  const sets = existsSync(COMMITTED_SETS)
    ? readdirSync(COMMITTED_SETS, { recursive: true, encoding: 'utf8' })
        .filter((name) => statSync(path.join(COMMITTED_SETS, name)).isFile())
        .sort()
        .map((name) => `${name} ${digest(path.join(COMMITTED_SETS, name))}`)
    : [];
  return { exceptions: existsSync(COMMITTED_EXCEPTIONS) ? digest(COMMITTED_EXCEPTIONS) : null, sets };
}

function envFor(dir: string): EnvLike {
  return { PORT: LEGACY_PORT, MAILPIT_API_URL: MAILPIT, OPT2_STATE_DIR: dir, MURA_ADMIN_PASSWORD: ADMIN_PASSWORD };
}

/** A log-record.v1 logger that pushes each line's message to `messages`. */
function messageLogger(messages: string[]): Logger {
  const destination = new Writable({
    write(chunk, _encoding, done) {
      messages.push((JSON.parse(String(chunk)) as { message: string }).message);
      done();
    },
  });
  return createLogger({ service: 'test', version: '1', env: 'local', destination });
}

function captureDeps(fake: FakeLegacy, env: EnvLike, logs: string[] = []): CaptureDeps {
  return {
    rules,
    fixtures: readFixtureStatus(env),
    sourceSha: SHA,
    env,
    fetch: fake.fetch,
    clock: () => CAPTURED_AT,
    logger: messageLogger(logs),
  };
}

async function capture(scenario: Scenario, deps: CaptureDeps): Promise<CapturedScenario> {
  const captured = await captureScenario(scenario, deps);
  if (captured === null) throw new Error(`${scenario.id} yielded no capture`);
  return captured;
}

async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

beforeAll(async () => {
  committed = committedState();
  expect(EXCEPTIONS_LIST_PATH).toBe(redirect.exceptionsFile);
  expect(goldenSetPath('GS-CO-05')).toBe(path.join(redirect.setsDir, 'GS-CO-05.json'));
  rules = loadRules(RULES_PATH, { PORT: LEGACY_PORT });
  catalogueCo05 = scenarioById(await loadCatalogue(CATALOGUE_FIXTURE), 'GS-CO-05');
});

afterAll(async () => {
  await rm(redirect.root, { recursive: true, force: true });
  expect(committedState()).toStrictEqual(committed);
});

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'opt2-capture-state-'));
  await mkdir(path.join(stateDir, 'seed'), { recursive: true });
  await writeFile(path.join(stateDir, 'seed', 'dataset.json'), JSON.stringify(DATASET));
  await writeFile(path.join(stateDir, 'fixtures.json'), JSON.stringify(FIXTURES_AVAILABLE));
  await rm(path.join(redirect.root, 'harness'), { recursive: true, force: true });
  await rm(path.join(redirect.root, 'opt2'), { recursive: true, force: true });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function without(set: GoldenSet, key: keyof GoldenSet): Record<string, unknown> {
  return Object.fromEntries(Object.entries(set).filter(([name]) => name !== key));
}

describe('golden set schema and locations', () => {
  it('accepts the committed-set sample', () => {
    expect(goldenSetSchema.parse(SAMPLE)).toMatchObject({
      scenarioId: 'GS-CO-05',
      origin: 'legacy',
      tableVersion: null,
    });
  });

  it.each<[string, (set: GoldenSet) => unknown]>([
    ['a gateway origin', (set) => ({ ...set, origin: 'gateway' })],
    ['a missing sourceSha', (set) => without(set, 'sourceSha')],
    ['a cut-over table version', (set) => ({ ...set, tableVersion: 'v0002' })],
  ])('rejects a set with %s', (_label, mutate) => {
    expect(goldenSetSchema.safeParse(mutate(SAMPLE)).success).toBe(false);
  });

  it('places a scenario set under harness/golden/sets of the checkout', () => {
    redirect.enabled = false;
    try {
      const file = goldenSetPath('GS-CO-05');
      expect(file).toBe(path.join(REPO_ROOT, 'harness', 'golden', 'sets', 'GS-CO-05.json'));
      expect(file.split(path.sep).join('/').endsWith('harness/golden/sets/GS-CO-05.json')).toBe(true);
    } finally {
      redirect.enabled = true;
    }
  });

  it('keeps raw captures under the state directory, outside the checkout', () => {
    const file = rawCapturePath('GS-CO-05', { OPT2_STATE_DIR: stateDir });
    expect(file).toBe(path.join(stateDir, 'golden', 'raw', 'GS-CO-05.json'));
    expect(isInsideRepo(file)).toBe(false);
    expect(() => rawCapturePath('GS-CO-05', { OPT2_STATE_DIR: path.join(REPO_ROOT, 'state') })).toThrow(
      /outside the repository checkout/,
    );
  });
});

describe('captureScenario against legacy', () => {
  it('writes the normalised GS-CO-05 set and its raw exchanges', async () => {
    const env = envFor(stateDir);
    const fake = fakeLegacy();
    const file = await writeCapture(await capture(catalogueCo05, captureDeps(fake, env)), env);

    expect(file).toBe(path.join(redirect.setsDir, 'GS-CO-05.json'));
    expect(fake.events).toStrictEqual([RESET, `GET ${FINDONE_PATH}`]);
    const set = await readGoldenSet('GS-CO-05');
    expect(goldenSetSchema.safeParse(await readJsonFile(file)).success).toBe(true);
    expect(set.sourceSha).toBe(pinnedSha());
    expect(set).toStrictEqual({
      ...SAMPLE,
      steps: [
        {
          ...SAMPLE_STEP,
          request: { method: 'GET', url: FINDONE_PATH, headers: {}, body: { kind: 'none' } },
          response: { ...SAMPLE_STEP.response, rawSha256: sha256Hex(FINDONE_BODY) },
        },
      ],
      generatedBy: GENERATED_BY,
      generatedAt: expect.any(String),
    });
    const [step] = set.steps;
    expect(step?.routeKey).toBe('api:content.findone');
    expect(step?.normalised.envelope).toMatchObject({
      data: { contenthistid: '<id:1>', contentid: '<id:2>', id: '<id:2>' },
    });
    expect(step?.normalised.headers).toMatchObject({ etag: ETAG_OK, generator: 'Masa CMS 7.6.1' });
    expect(step?.normalised.headers).not.toHaveProperty('date');
    expect(step?.normalised.headers).not.toHaveProperty('server');

    const rawFile = rawCapturePath('GS-CO-05', env);
    expect(isInsideRepo(rawFile)).toBe(false);
    const raw = await readJsonFile<RawCapture & { generatedBy: string }>(rawFile);
    expect(raw).toMatchObject({ sourceSha: SHA, scenarioId: 'GS-CO-05', origin: 'legacy', generatedBy: GENERATED_BY });
    expect(raw.records).toHaveLength(1);
    expect(raw.records[0]?.extracted).toStrictEqual({ contentid: CONTENT_ID });
    expect(raw.records[0]?.response).toMatchObject({
      status: 200,
      text: FINDONE_BODY,
      sha256: sha256Hex(FINDONE_BODY),
      headers: { date: ETAG_FIXTURE.headers.Date, server: ETAG_FIXTURE.headers.Server, etag: cfHash(FINDONE_BODY) },
    });
  });

  it('stores no resolved secret in the set or the raw capture', async () => {
    const env = envFor(stateDir);
    const fake = fakeLegacy();
    const [findone] = catalogueCo05.steps;
    const scenario = scenarioSchema.parse({
      ...catalogueCo05,
      steps: [{ ...findone, headers: { 'X-Fixture-Credential': '${secret:admin}' } }],
    });
    const file = await writeCapture(await capture(scenario, captureDeps(fake, env)), env);

    expect(fake.headers[0]?.['x-fixture-credential']).toBe(ADMIN_PASSWORD);
    const set = await readGoldenSet('GS-CO-05');
    expect(set.steps[0]?.request.headers['x-fixture-credential']).toBe('<secret>');
    expect(set.steps[0]?.normalised.headers?.['x-fixture-echo']).toBe('<secret>');
    for (const written of [file, rawCapturePath('GS-CO-05', env)]) {
      const text = await readFile(written, 'utf8');
      expect(text).toContain('<secret>');
      expect(text).not.toContain(ADMIN_PASSWORD);
    }
  });

  it('keeps a configured reload key no step resolves out of the set and raw capture, its admin link a token', async () => {
    const key = ['Fixture', 'Reload Key/"', '24'].join('-');
    const encoded = esapiUrlEncode(key);
    const env = { ...envFor(stateDir), MURA_APPRELOADKEY: key };
    const reloadLink = `/admin/?${encoded}&amp;reload=${encoded}`;
    // admin/common/layouts/includes/nav.cfm:338 renders this link on every admin page.
    const page =
      `<html><head><title>Masa CMS</title></head><body><a href="${reloadLink}" ` +
      'onclick="return actionModal(this.href);"><span>Reload Application</span></a></body></html>';
    const fake = fakeLegacy((req) =>
      req.method === 'GET' && req.url.pathname === '/admin/' && req.url.searchParams.get('muraAction') !== 'cLogin.main'
        ? html(page)
        : undefined,
    );
    const scenario = scenarioById(await loadCatalogue(CATALOGUE_FIXTURE), 'GS-ID-01');
    expect(JSON.stringify(scenario)).not.toContain('secret:appreload');
    const file = await writeCapture(await capture(scenario, captureDeps(fake, env)), env);

    const set = await readGoldenSet('GS-ID-01');
    const home = set.steps.find((step) => step.name === 'home');
    const reloadHrefs = [home?.response.domModel, home?.normalised.domModel].map(
      (model) => model?.links.find((link) => link.text === 'Reload Application')?.href,
    );
    expect(reloadHrefs).toStrictEqual(['/admin/?<token>&reload=<token>', '/admin/?<token>&reload=<token>']);
    const forms = [key, encoded, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)];
    for (const written of [file, rawCapturePath('GS-ID-01', env)]) {
      const text = await readFile(written, 'utf8');
      expect(forms.filter((form) => text.includes(form))).toStrictEqual([]);
    }
    const raw = await readJsonFile<RawCapture>(rawCapturePath('GS-ID-01', env));
    expect(raw.records.find((record) => record.name === 'home')?.response).toMatchObject({
      text: expect.stringContaining('/admin/?<secret>&amp;reload=<secret>'),
    });
    const leaked = (await readFile(file, 'utf8')).replace('?<token>&reload=<token>', `?${encoded}&reload=${encoded}`);
    expect(() => assertNoReloadKey(leaked, key, 'GS-ID-01 golden set')).toThrow(
      'GS-ID-01 golden set: a secret value remains after redaction',
    );
  });

  it.each([
    { word: 'a page title', key: ['Ho', 'me'].join('') },
    { word: 'the admin path', key: ['ad', 'min'].join('') },
  ])('keeps text equal to a configured reload key that is $word, masking only the reload link', async ({ key }) => {
    const env = { ...envFor(stateDir), MURA_APPRELOADKEY: key };
    const reloadLink = `/admin/?${key}&amp;reload=${key}`;
    const page =
      '<html><head><title>Home</title></head><body><h1>Home</h1>' +
      '<a href="/admin/?muraAction=cUsers.list&amp;ispublic=0">Users</a>' +
      `<a href="${reloadLink}"><span>Reload Application</span></a></body></html>`;
    const contentBody = FINDONE_BODY.replace('"title":"About Us"', '"title":"Home"');
    const fake = fakeLegacy((req) => {
      if (req.url.pathname === FINDONE_PATH) {
        return new Response(contentBody, { headers: { ...ETAG_FIXTURE.headers, ETag: cfHash(contentBody) } });
      }
      const login = req.url.searchParams.get('muraAction') === 'cLogin.main';
      return req.method === 'GET' && req.url.pathname === '/admin/' && !login ? html(page) : undefined;
    });
    const admin = await capture(scenarioById(await loadCatalogue(CATALOGUE_FIXTURE), 'GS-ID-01'), captureDeps(fake, env));
    const content = await capture(catalogueCo05, captureDeps(fake, env));

    const urls = ['/admin/?muraAction=cLogin.main', '/admin/index.cfm', '/admin/', '/admin/?muraAction=cLogin.logout'];
    expect(admin.set.steps.map((step) => step.request.url)).toStrictEqual(urls);
    expect(admin.raw?.records.map((record) => record.request.url)).toStrictEqual(urls);
    expect(admin.raw?.records.find((record) => record.name === 'home')?.response).toMatchObject({
      text: page.replace(reloadLink, '/admin/?<secret>&amp;reload=<secret>'),
    });
    const home = admin.set.steps.find((step) => step.name === 'home');
    expect(home?.normalised.domModel?.title).toBe('Home');
    expect(home?.normalised.domModel?.links.map((link) => link.href)).toStrictEqual([
      '/admin/?muraAction=cusers.list&ispublic=0',
      '/admin/?<token>&reload=<token>',
    ]);
    expect(content.raw?.records[0]?.response).toMatchObject({ text: contentBody });
    expect(content.set.steps[0]?.request.url).toBe(FINDONE_PATH);
    expect(content.set.steps[0]?.normalised.envelope).toMatchObject({ data: { title: 'Home' } });
    const ordinary = JSON.stringify({ title: 'Home' });
    expect(() => assertNoSecrets(ordinary, secretValues({ secrets: loadSecretStore(env) }), 'title')).not.toThrow();
    expect(() => assertNoReloadKey(ordinary, key, 'title')).not.toThrow();
  });
});


const FIXTURE_ROUTE = '/legacy-fixtures/cfml/api.cfm/timesheets/sheets';
const UNAVAILABLE = JSON.parse(readFileSync(FIXTURES_UNAVAILABLE_FILE, 'utf8')) as FixtureStatus;

const fixtureRoute: Route = (req) =>
  req.url.pathname === FIXTURE_ROUTE ? json({ apiversion: 'v1', method: 'list', data: { items: [] } }) : undefined;

// Catalogue inputs, kept unparsed so a temp catalogue can hold them as written.
const FIXTURE_SCENARIO = {
  id: 'GS-TS-01',
  title: 'Timesheet sheet list',
  service: 'timesheets',
  role: 'timesheets.employee',
  sessions: { anon: { login: 'none', via: 'public' } },
  steps: [{ name: 'sheets', route: FIXTURE_ROUTE, as: 'anon', auth: 'anonymous' }],
  compare: ['status'],
  covers: [],
  fixtures: 'required',
};
const BROWSER_SCENARIO = {
  id: 'GS-UI-01',
  title: 'Site Manager tree',
  service: 'strategies-content',
  role: 'admin',
  sessions: { admin: { login: 'admin', via: 'admin' } },
  steps: [],
  compare: ['dom'],
  covers: [],
  browser: { flow: 'site-manager-tree', console: 'no-new-errors' },
};
const UNSCRIPTED_SCENARIO = {
  id: 'GS-CO-14',
  title: 'Route the fake legacy origin does not serve',
  service: 'strategies-content',
  role: 'anonymous',
  sessions: { anon: { login: 'none', via: 'public' } },
  steps: [{ name: 'unscripted', route: '/unscripted/', as: 'anon', auth: 'anonymous' }],
  compare: ['status'],
  covers: [],
};

function fixtureScenario(): Scenario {
  return scenarioSchema.parse(FIXTURE_SCENARIO);
}

describe('skipped scenarios and Mailpit resets', () => {
  it('leaves a browser scenario to the interaction suite without sending a request', async () => {
    const fake = fakeLegacy();
    const logs: string[] = [];
    const scenario = scenarioSchema.parse(BROWSER_SCENARIO);

    await expect(captureScenario(scenario, captureDeps(fake, envFor(stateDir), logs))).resolves.toBeNull();
    expect(fake.events).toStrictEqual([]);
    expect(logs).toStrictEqual([
      'GS-UI-01: browser flow site-manager-tree, captured by harness/e2e/ui/interactions.e2e.ts',
    ]);
  });

  it.each([
    {
      label: 'unavailable',
      statusFile: FIXTURES_UNAVAILABLE_FILE,
      fixtures: { available: UNAVAILABLE.available, reason: UNAVAILABLE.reason },
      skipped: FIXTURES_UNAVAILABLE,
      events: [] as string[],
      steps: 0,
    },
    {
      label: 'available',
      statusFile: undefined,
      fixtures: { available: true, reason: null },
      skipped: undefined,
      events: [RESET, `GET ${FIXTURE_ROUTE}`],
      steps: 1,
    },
  ])('runs a fixtures-required scenario only when the fixtures are $label', async (row) => {
    if (row.statusFile !== undefined) await copyFile(row.statusFile, path.join(stateDir, 'fixtures.json'));
    const fake = fakeLegacy(fixtureRoute);
    const captured = await capture(fixtureScenario(), captureDeps(fake, envFor(stateDir)));

    expect(fake.events).toStrictEqual(row.events);
    expect(captured.set.fixtures).toStrictEqual(row.fixtures);
    expect(captured.set.skipped).toBe(row.skipped);
    expect(captured.set.steps).toHaveLength(row.steps);
    expect(captured.raw === undefined).toBe(row.skipped !== undefined);
    expect(goldenSetSchema.safeParse(captured.set).success).toBe(true);
  });

  it('empties Mailpit before each scenario and captures an --only selection in catalogue order', async () => {
    const env = envFor(stateDir);
    const fake = fakeLegacy();
    const logs: string[] = [];
    const outcome = await main(['--only', 'GS-CO-05,GS-ID-01', '--catalogue', CATALOGUE_FIXTURE], env, {
      fetch: fake.fetch,
      clock: () => CAPTURED_AT,
      logger: messageLogger(logs),
    });

    expect(outcome).toStrictEqual({ code: 0, summary: { captured: 2, skipped: 0, browser: 0, gaps: [], failed: [] } });
    expect(fake.events).toStrictEqual([
      RESET,
      RESET,
      'GET /admin/?muraAction=cLogin.main',
      'POST /admin/index.cfm',
      'GET /admin/',
      'GET /admin/?muraAction=cLogin.logout',
      RESET,
      `GET ${FINDONE_PATH}`,
    ]);
    expect(logs).toStrictEqual(['GS-ID-01: captured 4 exchanges', 'GS-CO-05: captured 1 exchanges']);
    expect((await readdir(redirect.setsDir)).sort()).toStrictEqual(['GS-CO-05.json', 'GS-ID-01.json']);

    const id01 = await readGoldenSet('GS-ID-01');
    expect(id01.steps.map((step) => step.name)).toStrictEqual(['main', 'login', 'home', 'logout']);
    expect(id01.steps[1]?.request.body).toMatchObject({
      kind: 'form',
      value: { password: '<secret>', csrf_token: '<token>' },
    });
    await expect(readGoldenSet('GS-CO-05')).resolves.toMatchObject({ scenarioId: 'GS-CO-05', sourceSha: SHA });
    for (const id of ['GS-ID-01', 'GS-CO-05']) {
      for (const written of [goldenSetPath(id), rawCapturePath(id, env)]) {
        expect(await readFile(written, 'utf8')).not.toContain(ADMIN_PASSWORD);
      }
    }
  });

  it('counts browser, skipped and failed scenarios and continues past a failure', async () => {
    const catalogue = path.join(stateDir, 'catalogue.yaml');
    // JSON is YAML, so the catalogue is written without a YAML serialiser.
    await writeFile(
      catalogue,
      JSON.stringify({ sourceSha: SHA, scenarios: [BROWSER_SCENARIO, UNSCRIPTED_SCENARIO, FIXTURE_SCENARIO] }),
    );
    await copyFile(FIXTURES_UNAVAILABLE_FILE, path.join(stateDir, 'fixtures.json'));
    const fake = fakeLegacy();
    const outcome = await main(['--catalogue', catalogue], envFor(stateDir), {
      fetch: fake.fetch,
      logger: messageLogger([]),
    });

    expect(outcome).toStrictEqual({
      code: 1,
      summary: {
        captured: 0,
        skipped: 1,
        browser: 1,
        gaps: [],
        failed: [{ id: 'GS-CO-14', error: expect.stringContaining('HttpRequestError') }],
      },
    });
    expect(fake.events).toStrictEqual([RESET, RESET, 'GET /unscripted/']);
    expect(await readdir(redirect.setsDir)).toStrictEqual(['GS-TS-01.json']);
    await expect(readGoldenSet('GS-TS-01')).resolves.toMatchObject({ skipped: FIXTURES_UNAVAILABLE, steps: [] });
  });
});

const CONTENT_LIST = '/_api/json/v1/tenant-a/content/';
const CANDIDATES = [`${CONTENT_LIST}?pageIndex=gs`, `${CONTENT_LIST}?itemsPerPage=gs`, `${CONTENT_LIST}?sort=%27`];

/** Content-list answers: the success envelope, or legacy's server_error envelope for the `trigger` request. */
function contentList(trigger?: string): Route {
  return (req) => {
    if (req.url.pathname !== CONTENT_LIST) return undefined;
    if (`${req.url.pathname}${req.url.search}` !== trigger) {
      return new Response(SUCCESS_ENVELOPE, { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    const { status, code, message } = LEGACY_ERROR_MAP.server_error;
    return json({ apiversion: 'v1', method: 'findMany', error: { code, message } }, status);
  };
}

function serverErrorScenario(): Scenario {
  return scenarioSchema.parse({
    id: 'GS-CO-15',
    title: 'REST and error envelope',
    service: 'strategies-content',
    role: 'anonymous',
    sessions: { anon: { login: 'none', via: 'public' } },
    steps: [
      {
        name: 'server-error',
        route: CANDIDATES[0],
        as: 'anon',
        auth: 'anonymous',
        expected: 'gap',
        candidates: CANDIDATES.map((route) => ({ method: 'GET', route })),
      },
    ],
    compare: ['status', 'envelope'],
    covers: [],
  });
}

async function emptyExceptionsList(file: string): Promise<string> {
  const text = `${JSON.stringify({ sourceSha: SHA, entries: [] }, null, 2)}\n`;
  await writeFile(file, text);
  return text;
}

describe('gaps and the exceptions list', () => {
  it('records a halted entry for a step none of whose candidates triggers server_error', async () => {
    const exceptions = path.join(stateDir, 'exceptions-list.json');
    await emptyExceptionsList(exceptions);
    const fake = fakeLegacy(contentList());
    const captured = await capture(serverErrorScenario(), {
      ...captureDeps(fake, envFor(stateDir)),
      exceptions: { path: exceptions },
    });

    expect(fake.events).toStrictEqual([RESET, ...CANDIDATES.map((route) => `GET ${route}`)]);
    const id = gapExceptionId('GS-CO-15', { name: 'server-error' });
    expect(id).toBe('EX-GAP-GS-CO-15-SERVER-ERROR');
    expect(captured.gaps).toStrictEqual([id]);
    const [step] = captured.set.steps;
    expect(step).toMatchObject({
      expected: 'gap',
      gap: { reason: GAP_REASON, candidatesTried: CANDIDATES.length },
      candidateIndex: CANDIDATES.length - 1,
      exceptionId: id,
    });
    const { entries } = await readJsonFile<{ entries: ExceptionEntry[] }>(exceptions);
    expect(entries).toStrictEqual([
      {
        id,
        scenario: 'GS-CO-15',
        routeKey: 'api:content.findquery',
        difference: GAP_REASON,
        decision: 'preserve',
        reason: expect.stringContaining(`None of the ${CANDIDATES.length} candidate requests of step server-error`),
        status: 'halted',
        evidence: {
          golden: 'harness/golden/sets/GS-CO-15.json',
          replay: '${OPT2_STATE_DIR}/golden/replay/GS-CO-15.json',
        },
        sourceSha: SHA,
      },
    ]);
  });

  it('keeps the first candidate legacy answers with server_error and records no entry', async () => {
    const exceptions = path.join(stateDir, 'exceptions-list.json');
    const before = await emptyExceptionsList(exceptions);
    const fake = fakeLegacy(contentList(CANDIDATES[1]));
    const captured = await capture(serverErrorScenario(), {
      ...captureDeps(fake, envFor(stateDir)),
      exceptions: { path: exceptions },
    });

    expect(fake.events).toStrictEqual([RESET, `GET ${CANDIDATES[0]}`, `GET ${CANDIDATES[1]}`]);
    expect(captured.gaps).toStrictEqual([]);
    const [step] = captured.set.steps;
    expect(step).toMatchObject({ candidateIndex: 1, response: { status: LEGACY_ERROR_MAP.server_error.status } });
    expect(step?.gap).toBeUndefined();
    expect(await readFile(exceptions, 'utf8')).toBe(before);
  });

  it('upserts entries by scenario, route key and status, keeping existing entries in place', async () => {
    await mkdir(path.dirname(EXCEPTIONS_LIST_PATH), { recursive: true });
    await copyFile(MINI_EXCEPTIONS_FILE, EXCEPTIONS_LIST_PATH);
    const seeded = (await readJsonFile<{ entries: ExceptionEntry[] }>(MINI_EXCEPTIONS_FILE)).entries;
    const proposal = seeded.find((entry) => entry.decision === 'fix');
    if (proposal === undefined) throw new Error('the seeded list holds no fix entry');
    const halted: ExceptionEntry = {
      id: 'EX-GAP-GS-CO-15-SERVER-ERROR',
      scenario: 'GS-CO-15',
      routeKey: 'api:content.findquery',
      difference: GAP_REASON,
      decision: 'preserve',
      reason: 'No candidate request triggers server_error.',
      status: 'halted',
      evidence: haltEvidence('GS-CO-15'),
      sourceSha: SHA,
    };

    await expect(appendExceptionEntry(halted)).resolves.toStrictEqual(halted);
    const once = await readFile(EXCEPTIONS_LIST_PATH, 'utf8');
    await expect(appendExceptionEntry({ ...halted })).resolves.toStrictEqual(halted);
    expect(await readFile(EXCEPTIONS_LIST_PATH, 'utf8')).toBe(once);

    const updated = { ...halted, reason: 'Updated reason.' };
    await expect(appendExceptionEntry({ ...updated, id: 'EX-GAP-RENAMED' })).resolves.toStrictEqual(updated);
    const open: ExceptionEntry = { ...halted, id: 'EX-OPEN-GS-CO-15-SERVER-ERROR', status: 'open' };
    await appendExceptionEntry(open);
    await expect(appendExceptionEntry({ ...proposal, reason: 'Rewritten.' })).resolves.toStrictEqual(proposal);

    const { entries } = await readJsonFile<{ entries: ExceptionEntry[] }>(EXCEPTIONS_LIST_PATH);
    expect(entries).toStrictEqual([...seeded, updated, open]);
  });
});

