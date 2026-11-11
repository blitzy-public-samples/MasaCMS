import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCatalogue, scenarioById, type SeedRef, type SessionSpec } from '../../src/golden/catalogue.js';
import { GoldenConfigError, MissingSecretError } from '../../src/golden/errors.js';
import {
  DEFAULT_SESSION,
  GATEWAY_PORT,
  GENERATED_SECRETS_FILE,
  SEED_CONFIG_PATH,
  SEED_CREDENTIALS_FILE,
  appReloadKey,
  createScenarioContext,
  loadSecretStore,
  loadSeedStore,
  originBaseUrl,
  placeholderNames,
  resolvePlaceholders,
  secretValues,
  session,
  type Origin,
  type ScenarioContext,
  type ScenarioInput,
  type SecretStore,
  type SeedStore,
} from '../../src/golden/session.js';
import { inventoryRouteKeyForRequest } from '../../src/inventory/route-keys.js';
import type { FetchLike } from '../../src/lib/http.js';
import type { EnvLike } from '../../src/lib/paths.js';

const SCENARIO = 'GS-ID-05';
const LEGACY_PORT = '20080';
const LEGACY_URL = `http://127.0.0.1:${LEGACY_PORT}`;
const ADMIN_PASSWORD = 'FIXTURE-ADMIN-PW';
const EDITOR_PASSWORD = 'FIXTURE-EDITOR-PW';
const SITE_ADMIN = 'ada.lovelace';
const SYSTEM_USER = 'grace.hopper';
const MEMBER = 'alan.turing';
const SPLIT_USER = 'edsger.dijkstra';
const SITE_ADMIN_PW = 'FIXTURE-PW-ADA';
const SHARED_PW = 'FIXTURE-PW-GRACE';
const MEMBER_PW = 'FIXTURE-PW-ALAN';
const OAUTH_CLIENT = 'FIXTURE-CLIENT-0001';
const OAUTH_SECRET = 'FIXTURE-OAUTH-SECRET';
const RELOAD_KEY = 'fixture-reload-key';
// Synthetic secrets holding URL-reserved and non-ASCII characters, with their Java URLEncoder forms.
const RESERVED_PW = 'FIXTURE pw&=#%+ü';
const RESERVED_PW_ENCODED = 'FIXTURE+pw%26%3D%23%25%2B%C3%BC';
const RESERVED_KEY = 'fixture key&=#%+/?ü';
const RESERVED_KEY_ENCODED = 'fixture+key%26%3D%23%25%2B%2F%3F%C3%BC';
const MASK = '<secret>';
const BUSINESS_DATE = '2026-03-02';
const NO_LOGIN: SessionSpec = { login: 'none', via: 'admin' };
const GENERATED_VALUE = /^[A-Za-z0-9_-]{24}a1A$/;

// Shape of `SeedCredentials` from legacy-fixtures/seed/src/credentials.ts.
const CREDENTIALS = {
  sourceSha: 'FIXTURE-SHA',
  digest: 'FIXTURE-DIGEST',
  users: {
    'tenant-a': { [SITE_ADMIN]: SITE_ADMIN_PW, [SYSTEM_USER]: SHARED_PW, [SPLIT_USER]: 'FIXTURE-PW-EDSGER-A' },
    'tenant-b': { [MEMBER]: MEMBER_PW, [SYSTEM_USER]: SHARED_PW, [SPLIT_USER]: 'FIXTURE-PW-EDSGER-B' },
  },
  roles: {
    'tenant-a': { 'site-admin': SITE_ADMIN, 'system-user': SYSTEM_USER },
    'tenant-b': { member: MEMBER },
  },
  oauthClients: { [OAUTH_CLIENT]: OAUTH_SECRET },
};

const SITES = [
  { siteID: 'tenant-a', site: 'Tenant A', orderNo: 1 },
  { siteID: 'tenant-b', site: 'Tenant B', orderNo: 2 },
];
const USERS = [
  { userID: 'FIXTURE-USER-0001', siteID: 'tenant-a', type: 2, isPublic: 0, username: SITE_ADMIN, fname: 'Ada' },
  { userID: 'FIXTURE-USER-0002', siteID: 'tenant-a', type: 2, isPublic: 1, username: SYSTEM_USER, fname: 'Grace' },
  { userID: 'FIXTURE-USER-0003', siteID: 'tenant-b', type: 2, isPublic: 1, username: MEMBER, fname: 'Alan' },
];
const PERSONS = [
  { person_id: 'FIXTURE-PERSON-0001', site_id: 'tenant-a', archived: false },
  { person_id: 'FIXTURE-PERSON-0002', site_id: 'tenant-b', archived: true },
];

// Shape of `Dataset` as legacy-fixtures/seed/src/writer.ts writes `dataset.json`.
const DATASET = {
  sourceSha: 'FIXTURE-SHA',
  seed: 1,
  businessDate: BUSINESS_DATE,
  digest: 'FIXTURE-DIGEST',
  masa: {
    sites: SITES,
    groups: [],
    users: USERS,
    memberships: [],
    categories: [],
    content: [],
    files: [],
    oauthClients: [{ clientID: OAUTH_CLIENT, siteID: 'tenant-a' }],
  },
  fixtures: { 'synthetic.person': PERSONS },
};

const SEED_CONFIG = {
  reserved: {
    rehearsal: { site: 'tenant-a', persons: ['FIXTURE-PERSON-0001'], usernames: ['rh-create-01', 'rh-create-02'] },
  },
};

let stateDir: string;
let env: EnvLike;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2-golden-session-'));
  env = {
    PORT: LEGACY_PORT,
    OPT2_STATE_DIR: stateDir,
    MURA_ADMIN_PASSWORD: ADMIN_PASSWORD,
    MASA_TEST_EDITOR_PASSWORD: EDITOR_PASSWORD,
  };
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function secretsPath(file: string): string {
  return path.join(stateDir, 'secrets', file);
}

/** Writes `body` as the seed writes `seed-credentials.json`: pretty JSON, file 0600 in a 0700 `secrets/`. */
function writeSeedCredentials(body: unknown = CREDENTIALS): string {
  fs.mkdirSync(path.join(stateDir, 'secrets'), { recursive: true, mode: 0o700 });
  const file = secretsPath(SEED_CREDENTIALS_FILE);
  fs.writeFileSync(file, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Writes `body` as the seed writes `dataset.json`: compact JSON under `<state>/seed/`. */
function writeSeedDataset(body: unknown = DATASET): string {
  fs.mkdirSync(path.join(stateDir, 'seed'), { recursive: true });
  const file = path.join(stateDir, 'seed', 'dataset.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : `${JSON.stringify(body)}\n`);
  return file;
}

function writeSeedConfig(): string {
  const file = path.join(stateDir, 'seed.config.json');
  fs.writeFileSync(file, `${JSON.stringify(SEED_CONFIG, null, 2)}\n`);
  return file;
}

function readGenerated(): Record<string, string> {
  return JSON.parse(fs.readFileSync(secretsPath(GENERATED_SECRETS_FILE), 'utf8')) as Record<string, string>;
}

function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

/** Error `fn` throws; fails the test when it returns. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

/** Message, stack and MissingSecretError placeholder of `err` and of every cause below it. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    parts.push(e.message, e.stack ?? '', e instanceof MissingSecretError ? e.placeholder : '');
  }
  return parts.join('\n');
}

interface Call {
  url: string;
  cookie: string | undefined;
}

/** Fetch stub answering every request 200 with `setCookie`, recording each URL and the Cookie header it sent. */
function fakeFetch(setCookie: readonly string[] = []): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, cookie: (init.headers as Record<string, string> | undefined)?.cookie });
    const headers = setCookie.map((line): [string, string] => ['set-cookie', line]);
    return new Response('ok', { status: 200, headers });
  };
  return { fetch, calls };
}

function contextFor(scenario: ScenarioInput = { id: SCENARIO }, origin: Origin = 'legacy'): ScenarioContext {
  return createScenarioContext(scenario, { origin, env, fetch: fakeFetch().fetch });
}

function sessionsNamed(names: readonly string[]): Record<string, SessionSpec> {
  return Object.fromEntries(names.map((name) => [name, NO_LOGIN]));
}

describe('originBaseUrl', () => {
  it.each<[Origin, EnvLike, string]>([
    ['legacy', { PORT: LEGACY_PORT }, LEGACY_URL],
    ['legacy', { PORT: LEGACY_PORT, LEGACY_ORIGIN: 'http://localhost:20080//' }, 'http://localhost:20080'],
    ['legacy', { PORT: LEGACY_PORT, LEGACY_ORIGIN: '' }, LEGACY_URL],
    ['legacy', { LEGACY_ORIGIN: 'http://localhost:20080' }, 'http://localhost:20080'],
    ['gateway', {}, `http://127.0.0.1:${GATEWAY_PORT}`],
    ['gateway', { PORT: LEGACY_PORT }, 'http://127.0.0.1:8100'],
    ['gateway', { OPT2_GATEWAY_URL: 'http://localhost:20000/' }, 'http://localhost:20000'],
    ['gateway', { OPT2_GATEWAY_URL: '' }, 'http://127.0.0.1:8100'],
  ])('resolves %s with %j to %s', (origin, vars, expected) => {
    expect(originBaseUrl(origin, vars)).toBe(expected);
  });

  it.each<EnvLike>([{}, { PORT: '' }, { LEGACY_ORIGIN: '', OPT2_GATEWAY_URL: 'http://localhost:20000' }])(
    'throws GoldenConfigError for legacy when PORT is unset in %j',
    (vars) => {
      const err = thrown(() => originBaseUrl('legacy', vars));
      expect(err).toBeInstanceOf(GoldenConfigError);
      expect(err).toMatchObject({ message: 'PORT, the legacy ColdFusion port, is not set' });
    },
  );
});

describe('createScenarioContext', () => {
  it('opens one logged-out session per declared name on the origin, with empty bindings and seed rows', async () => {
    const ctx = contextFor({ id: SCENARIO, sessions: sessionsNamed(['admin', 'editor']) });
    expect(ctx.origin).toBe('legacy');
    expect(ctx.baseUrl).toBe(LEGACY_URL);
    expect(ctx.scenarioId).toBe(SCENARIO);
    expect(ctx.env).toBe(env);
    expect([...ctx.sessions.keys()]).toEqual(['admin', 'editor']);
    for (const s of ctx.sessions.values()) {
      expect(s.baseUrl).toBe(LEGACY_URL);
      expect(await s.cookieHeader()).toBe('');
    }
    expect(ctx.bindings.size).toBe(0);
    expect(ctx.seedRows.size).toBe(0);
  });

  it('keeps the cookies legacy sets on one named session out of every other session', async () => {
    const { fetch, calls } = fakeFetch(['CFID=FIXTURE-CFID-1; Path=/', 'CFTOKEN=FIXTURE-CFTOKEN-1; Path=/']);
    const ctx = createScenarioContext(
      { id: SCENARIO, sessions: sessionsNamed(['admin', 'editor']) },
      { origin: 'legacy', env, fetch },
    );
    const admin = session(ctx, 'admin');
    const editor = session(ctx, 'editor');
    expect(admin.jar).not.toBe(editor.jar);

    await admin.get('/admin/');
    expect(await admin.cookieHeader()).toBe('CFID=FIXTURE-CFID-1; CFTOKEN=FIXTURE-CFTOKEN-1');
    expect(await editor.cookieHeader()).toBe('');

    await editor.get('/admin/');
    expect(calls).toEqual([
      { url: `${LEGACY_URL}/admin/`, cookie: undefined },
      { url: `${LEGACY_URL}/admin/`, cookie: undefined },
    ]);
  });

  it('gives two contexts of one scenario separate cookie jars and bindings', async () => {
    const { fetch } = fakeFetch(['JSESSIONID=FIXTURE-JSESSION-1; Path=/']);
    const first = createScenarioContext({ id: SCENARIO }, { origin: 'gateway', env, fetch });
    const second = createScenarioContext({ id: SCENARIO }, { origin: 'gateway', env, fetch });
    await session(first).get('/');
    first.bindings.set('create.data', { id: 'FIXTURE-ID-1' });

    expect(first.baseUrl).toBe('http://127.0.0.1:8100');
    expect(session(second).jar).not.toBe(session(first).jar);
    expect(await session(first).cookieHeader()).toBe('JSESSIONID=FIXTURE-JSESSION-1');
    expect(await session(second).cookieHeader()).toBe('');
    expect(second.bindings.size).toBe(0);
  });

  it.each<[string, ScenarioInput]>([
    ['undeclared', { id: SCENARIO }],
    ['empty', { id: SCENARIO, sessions: {} }],
  ])('opens only the default session when sessions are %s', (_label, scenario) => {
    expect([...contextFor(scenario).sessions.keys()]).toEqual([DEFAULT_SESSION]);
  });

  it('builds fresh secret and seed stores over its env when none are given', () => {
    writeSeedCredentials();
    writeSeedDataset();
    const ctx = contextFor();
    expect(ctx.secrets.secret('admin')).toBe(ADMIN_PASSWORD);
    expect(ctx.secrets.username('tenant-b', 'member')).toBe(MEMBER);
    expect(ctx.seed.businessDate()).toBe(BUSINESS_DATE);
  });

  it('uses the stores it is given and process.env when no env is given', () => {
    const secrets: SecretStore = loadSecretStore(env);
    const seed: SeedStore = loadSeedStore(env);
    const ctx = createScenarioContext({ id: SCENARIO }, { origin: 'gateway', secrets, seed, fetch: fakeFetch().fetch });
    expect(ctx.secrets).toBe(secrets);
    expect(ctx.seed).toBe(seed);
    expect(ctx.env).toBe(process.env);
    expect(ctx.baseUrl).toBe(originBaseUrl('gateway', process.env));
  });

  it('resolves seedRefs in declaration order, so a later where reads an earlier row', () => {
    writeSeedDataset();
    const ctx = contextFor({
      id: SCENARIO,
      seedRefs: [
        { as: 'site', source: 'dataset', path: 'masa.sites', where: { siteID: 'tenant-b' } },
        { as: 'member', source: 'dataset', path: 'masa.users', where: { siteID: '${seed.site.siteID}' } },
        { as: 'person', source: 'dataset', path: 'fixtures.synthetic.person', index: -1 },
      ],
    });
    expect([...ctx.seedRows.entries()]).toEqual([
      ['site', SITES[1]],
      ['member', USERS[2]],
      ['person', PERSONS[1]],
    ]);
    expect(ctx.bindings.size).toBe(0);
  });

  it('prefixes a seedRef failure with the scenario id, keeping its path and cause', () => {
    const file = writeSeedDataset();
    const seedRefs: SeedRef[] = [{ as: 'nobody', source: 'dataset', path: 'masa.people' }];
    const err = thrown(() => contextFor({ id: SCENARIO, seedRefs }));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ message: `${SCENARIO}: seedRef nobody: masa.people is not in ${file}`, path: file });
    expect((err as GoldenConfigError).cause).toBeInstanceOf(GoldenConfigError);
  });
});

describe('session', () => {
  it.each<[string[], string | undefined, string]>([
    [['admin'], undefined, 'admin'],
    [['default', 'editor'], undefined, 'default'],
    [['admin', 'editor'], 'editor', 'editor'],
  ])('returns, of sessions %j, the one asked for as %s: %s', (names, name, expected) => {
    const ctx = contextFor({ id: SCENARIO, sessions: sessionsNamed(names) });
    expect(session(ctx, name)).toBe(ctx.sessions.get(expected));
  });

  it.each<[string[], string | undefined, string]>([
    [['admin', 'editor'], undefined, `${SCENARIO}: no session default; declared: admin, editor`],
    [['admin'], 'editor', `${SCENARIO}: no session editor; declared: admin`],
  ])('throws GoldenConfigError when sessions %j hold no session %s', (names, name, message) => {
    const err = thrown(() => session(contextFor({ id: SCENARIO, sessions: sessionsNamed(names) }), name));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ message });
  });
});

describe('loadSecretStore', () => {
  it.each([
    ['admin', ADMIN_PASSWORD],
    ['qa_editor', EDITOR_PASSWORD],
    [`seed:${SITE_ADMIN}`, SITE_ADMIN_PW],
    [`seed:${MEMBER}`, MEMBER_PW],
    [`seed:${SYSTEM_USER}`, SHARED_PW],
    [`oauth:${OAUTH_CLIENT}`, OAUTH_SECRET],
  ])('returns secret %s from the environment or the seed credentials', (name, expected) => {
    writeSeedCredentials();
    expect(loadSecretStore(env).secret(name)).toBe(expected);
  });

  it.each([
    ['admin', 'MURA_ADMIN_PASSWORD'],
    ['qa_editor', 'MASA_TEST_EDITOR_PASSWORD'],
  ])('throws MissingSecretError naming the variable when %s has no value', (name, variable) => {
    for (const vars of [{ ...env, [variable]: undefined }, { ...env, [variable]: '' }]) {
      const err = thrown(() => loadSecretStore(vars).secret(name));
      expect(err).toBeInstanceOf(MissingSecretError);
      expect(err).toMatchObject({ placeholder: `\${secret:${name}}`, source: variable });
    }
  });

  it.each([`seed:${SPLIT_USER}`, 'seed:nobody', 'seed:toString', 'oauth:FIXTURE-CLIENT-0002', 'oauth:constructor'])(
    'throws MissingSecretError naming the credential file when %s has no unique value there',
    (name) => {
      const file = writeSeedCredentials();
      const err = thrown(() => loadSecretStore(env).secret(name));
      expect(err).toBeInstanceOf(MissingSecretError);
      expect(err).toMatchObject({ placeholder: `\${secret:${name}}`, source: file });
      expect((err as Error).message).not.toContain('FIXTURE-PW');
    },
  );

  it.each([`seed:${SITE_ADMIN}`, `oauth:${OAUTH_CLIENT}`])(
    'throws MissingSecretError for %s when the credential file does not exist',
    (name) => {
      const err = thrown(() => loadSecretStore(env).secret(name));
      expect(err).toBeInstanceOf(MissingSecretError);
      expect(err).toMatchObject({ source: secretsPath(SEED_CREDENTIALS_FILE) });
    },
  );

  it.each(['vault:FIXTURE-KEY', 'nobody', 'seed:', 'oauth:', 'generated:', ''])(
    'throws GoldenConfigError listing the accepted forms for secret %j',
    (name) => {
      const err = thrown(() => loadSecretStore(env).secret(name));
      expect(err).toBeInstanceOf(GoldenConfigError);
      expect(err).toMatchObject({
        message:
          `unknown secret placeholder \${secret:${name}}; ` +
          'expected secret:admin, qa_editor, appreload, seed:<username>, oauth:<clientId> or generated:<name>',
      });
    },
  );

  it('reads the credential file once, on first use rather than at creation', () => {
    const store = loadSecretStore(env);
    const file = writeSeedCredentials();
    expect(store.secret(`seed:${MEMBER}`)).toBe(MEMBER_PW);
    fs.rmSync(file);
    expect(store.secret(`oauth:${OAUTH_CLIENT}`)).toBe(OAUTH_SECRET);
    expect(store.username('tenant-a', 'site-admin')).toBe(SITE_ADMIN);
  });

  it('creates a generated secret owner-only and returns the same value to a later store of the run', () => {
    const first = loadSecretStore(env).secret('generated:new-user');
    expect(first).toMatch(GENERATED_VALUE);
    expect(readGenerated()).toEqual({ 'new-user': first });
    expect(modeOf(secretsPath(GENERATED_SECRETS_FILE))).toBe(0o600);
    expect(modeOf(path.join(stateDir, 'secrets'))).toBe(0o700);

    const replay = loadSecretStore(env);
    expect(replay.secret('generated:new-user')).toBe(first);
    const other = replay.secret('generated:other-user');
    expect(other).toMatch(GENERATED_VALUE);
    expect(other).not.toBe(first);
    expect(readGenerated()).toEqual({ 'new-user': first, 'other-user': other });
  });

  it('tightens an existing generated-secrets file and its directory when it adds a value', () => {
    fs.mkdirSync(path.join(stateDir, 'secrets'), { mode: 0o755 });
    fs.chmodSync(path.join(stateDir, 'secrets'), 0o755);
    fs.writeFileSync(secretsPath(GENERATED_SECRETS_FILE), '{"kept":"FIXTURE-KEPT"}\n', { mode: 0o644 });
    fs.chmodSync(secretsPath(GENERATED_SECRETS_FILE), 0o644);

    const value = loadSecretStore(env).secret('generated:added');
    expect(readGenerated()).toEqual({ kept: 'FIXTURE-KEPT', added: value });
    expect(modeOf(secretsPath(GENERATED_SECRETS_FILE))).toBe(0o600);
    expect(modeOf(path.join(stateDir, 'secrets'))).toBe(0o700);
  });

  it('prefers a generated value preset in the credential file over the generated-secrets file', () => {
    writeSeedCredentials({ ...CREDENTIALS, generated: { preset: 'FIXTURE-PRESET' } });
    expect(loadSecretStore(env).secret('generated:preset')).toBe('FIXTURE-PRESET');
    expect(fs.existsSync(secretsPath(GENERATED_SECRETS_FILE))).toBe(false);
  });

  it.each([
    ['tenant-a', 'site-admin', SITE_ADMIN],
    ['tenant-a', 'system-user', SYSTEM_USER],
    ['tenant-b', 'member', MEMBER],
  ])('returns the username of %s role %s from the credential file', (site, role, expected) => {
    writeSeedCredentials();
    expect(loadSecretStore(env).username(site, role)).toBe(expected);
  });

  it.each([
    ['tenant-b', 'site-admin'],
    ['tenant-c', 'member'],
    ['toString', 'member'],
    ['tenant-a', 'constructor'],
  ])('throws GoldenConfigError at the credential file when %s has no %s username', (site, role) => {
    const file = writeSeedCredentials();
    const err = thrown(() => loadSecretStore(env).username(site, role));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ message: `\${user:${site}:${role}} has no username in ${file}`, path: file });
  });

  it('throws GoldenConfigError for a username when the credential file does not exist', () => {
    const err = thrown(() => loadSecretStore(env).username('tenant-a', 'site-admin'));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ path: secretsPath(SEED_CREDENTIALS_FILE) });
  });

  it('reports an unparsable credential file without quoting its text', () => {
    const file = writeSeedCredentials('{"users": FIXTURE-LEAKED-TEXT');
    const err = thrown(() => loadSecretStore(env).secret(`seed:${MEMBER}`));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ message: `seed credentials ${file} is not valid JSON`, path: file });
    expect((err as Error).cause).toBeUndefined();
  });

  it('reports an unparsable generated-secrets file without quoting its text', () => {
    fs.mkdirSync(path.join(stateDir, 'secrets'), { recursive: true });
    const file = secretsPath(GENERATED_SECRETS_FILE);
    fs.writeFileSync(file, 'FIXTURE-LEAKED-TEXT');
    const err = thrown(() => loadSecretStore(env).secret('generated:new-user'));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ message: `generated golden secrets ${file} is not valid JSON`, path: file });
    expect((err as Error).message).not.toContain('FIXTURE-LEAKED-TEXT');
  });

  it.each([['[]'], ['"FIXTURE-TEXT"'], ['null']])('rejects credential file %s as not a JSON object', (text) => {
    const file = writeSeedCredentials(text);
    const err = thrown(() => loadSecretStore(env).secret(`seed:${MEMBER}`));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ message: `seed credentials ${file} is not a JSON object`, path: file });
  });

  it('reports a credential path it cannot read, with the read error as cause', () => {
    const file = secretsPath(SEED_CREDENTIALS_FILE);
    fs.mkdirSync(file, { recursive: true });
    const err = thrown(() => loadSecretStore(env).secret(`seed:${MEMBER}`));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect((err as Error).message.startsWith(`seed credentials ${file} cannot be read: EISDIR`)).toBe(true);
    expect(err).toMatchObject({ path: file, cause: expect.objectContaining({ code: 'EISDIR' }) });
  });

  it('lists every distinct secret value returned so far, and no username', () => {
    writeSeedCredentials();
    const store = loadSecretStore(env);
    expect(store.values()).toEqual([]);
    store.secret('admin');
    store.username('tenant-a', 'site-admin');
    store.secret(`oauth:${OAUTH_CLIENT}`);
    store.secret('admin');
    expect(store.values()).toEqual([ADMIN_PASSWORD, OAUTH_SECRET]);
  });

  it.each<[string, string | undefined, string, string[]]>([
    ['configured', RELOAD_KEY, RELOAD_KEY, [RELOAD_KEY]],
    ['unset', undefined, 'appreload', []],
    ['empty', '', 'appreload', []],
  ])(
    'resolves appreload with MURA_APPRELOADKEY %s to the effective key, listed only when configured',
    (_label, configured, key, listed) => {
      const vars = { ...env, MURA_APPRELOADKEY: configured };
      const store = loadSecretStore(vars);
      expect(appReloadKey(vars)).toBe(key);
      expect(store.secret('appreload')).toBe(key);
      store.secret('admin');
      expect(store.values()).toEqual([...listed, ADMIN_PASSWORD]);
    },
  );

  it.each<[string, EnvLike, new (...args: never[]) => Error]>([
    ['vault:FIXTURE-KEY', {}, GoldenConfigError],
    ['admin', { MURA_ADMIN_PASSWORD: '' }, MissingSecretError],
    [`seed:${MEMBER}`, {}, MissingSecretError],
  ])('keeps a resolved reload key out of the error for secret %s', (name, vars, type) => {
    const store = loadSecretStore({ ...env, ...vars, MURA_APPRELOADKEY: RELOAD_KEY });
    expect(store.secret('appreload')).toBe(RELOAD_KEY);
    const err = thrown(() => store.secret(name));
    expect(err).toBeInstanceOf(type);
    expect(`${(err as Error).message} ${JSON.stringify(err)}`).not.toContain(RELOAD_KEY);
  });
});

describe('loadSeedStore', () => {
  it.each<[string, Omit<SeedRef, 'as' | 'source'>, unknown]>([
    ['the first row of a list', { path: 'masa.users' }, USERS[0]],
    ['the row at index', { path: 'masa.users', index: 1 }, USERS[1]],
    ['a row counted from the end', { path: 'masa.users', index: -1 }, USERS[2]],
    ['the first row matching where', { path: 'masa.users', where: { siteID: 'tenant-b' } }, USERS[2]],
    ['a row matching a number by its string form', { path: 'masa.users', where: { isPublic: '1' } }, USERS[1]],
    ['a row matching a column case-insensitively', { path: 'masa.users', where: { SITEID: 'tenant-b' } }, USERS[2]],
    ['a row matching several columns', { path: 'masa.users', where: { siteID: 'tenant-a', isPublic: 1 } }, USERS[1]],
    [
      'a row of a fixture table keyed <schema>.<table>',
      { path: 'fixtures.synthetic.person', where: { archived: true } },
      PERSONS[1],
    ],
  ])('selects %s from dataset.json', (_label, ref, expected) => {
    writeSeedDataset();
    expect(loadSeedStore(env).select({ as: 'row', source: 'dataset', ...ref })).toEqual(expected);
  });

  it('selects a whole non-list value when neither where nor index is given', () => {
    writeSeedDataset({ ...DATASET, fixtures: { synthetic: { person: PERSONS[0] } } });
    const store = loadSeedStore(env);
    expect(store.select({ as: 'person', source: 'dataset', path: 'fixtures.synthetic.person' })).toEqual(PERSONS[0]);
    expect(store.select({ as: 'synthetic', source: 'dataset', path: 'fixtures.synthetic' })).toEqual({
      person: PERSONS[0],
    });
  });

  it('reads reserved refs from the committed seed configuration by default', () => {
    const config = JSON.parse(fs.readFileSync(SEED_CONFIG_PATH, 'utf8')) as {
      reserved: { rehearsal: { site: string; usernames: string[] } };
    };
    const store = loadSeedStore(env);
    expect(store.select({ as: 'site', source: 'reserved', path: 'reserved.rehearsal.site' })).toBe(
      config.reserved.rehearsal.site,
    );
    expect(store.select({ as: 'user', source: 'reserved', path: 'reserved.rehearsal.usernames', index: -1 })).toBe(
      config.reserved.rehearsal.usernames.at(-1),
    );
  });

  it('reads the dataset and seed configuration from the paths it is given', () => {
    const datasetPath = path.join(stateDir, 'elsewhere.json');
    fs.writeFileSync(datasetPath, `${JSON.stringify({ ...DATASET, businessDate: '2030-01-31' })}\n`);
    const store = loadSeedStore(env, { datasetPath, configPath: writeSeedConfig() });
    expect(store.businessDate()).toBe('2030-01-31');
    expect(store.select({ as: 'user', source: 'reserved', path: 'reserved.rehearsal.usernames', index: 1 })).toBe(
      'rh-create-02',
    );
  });

  it('reads each document once, on first use rather than at creation', () => {
    const store = loadSeedStore(env);
    const file = writeSeedDataset();
    expect(store.businessDate()).toBe(BUSINESS_DATE);
    fs.rmSync(file);
    expect(store.select({ as: 'site', source: 'dataset', path: 'masa.sites' })).toEqual(SITES[0]);
  });

  it('prefers the longest dotted key that leads to a value, else a shorter one', () => {
    const datasetPath = path.join(stateDir, 'dotted.json');
    fs.writeFileSync(datasetPath, JSON.stringify({ 'a.b': { other: 1 }, a: { b: { c: 'FIXTURE-DEEP' } } }));
    const store = loadSeedStore(env, { datasetPath });
    expect(store.select({ as: 'v', source: 'dataset', path: 'a.b.other' })).toBe(1);
    expect(store.select({ as: 'v', source: 'dataset', path: 'a.b.c' })).toBe('FIXTURE-DEEP');
  });

  it.each<[string, Omit<SeedRef, 'source'>, (file: string) => string]>([
    ['a path the dataset lacks', { as: 'x', path: 'masa.people' }, (f) => `seedRef x: masa.people is not in ${f}`],
    [
      'a path below a list',
      { as: 'x', path: 'masa.users.username' },
      (file) => `seedRef x: masa.users.username is not in ${file}`,
    ],
    [
      'where on a non-list',
      { as: 'x', path: 'fixtures.synthetic', where: { site_id: 'tenant-a' } },
      () => 'seedRef x: fixtures.synthetic is not a list, so where and index do not apply',
    ],
    [
      'index on a non-list',
      { as: 'x', path: 'fixtures.synthetic.person', index: 0 },
      () => 'seedRef x: fixtures.synthetic.person is not a list, so where and index do not apply',
    ],
    [
      'a where no row matches',
      { as: 'x', path: 'masa.users', where: { siteID: 'tenant-z' } },
      () => 'seedRef x: no row at index 0 among the 0 rows of masa.users matching {"siteID":"tenant-z"}',
    ],
    [
      'an index past the matching rows',
      { as: 'x', path: 'masa.users', index: 3 },
      () => 'seedRef x: no row at index 3 among the 3 rows of masa.users matching {}',
    ],
  ])('throws GoldenConfigError at dataset.json for %s', (_label, ref, message) => {
    const file = writeSeedDataset({ ...DATASET, fixtures: { synthetic: { person: PERSONS[0] } } });
    const err = thrown(() => loadSeedStore(env).select({ source: 'dataset', ...ref }));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ message: message(file), path: file });
  });

  it('throws GoldenConfigError when dataset.json does not exist', () => {
    const file = path.join(stateDir, 'seed', 'dataset.json');
    const store = loadSeedStore(env);
    const calls = [() => store.businessDate(), () => store.select({ as: 'x', source: 'dataset', path: 'masa.users' })];
    for (const call of calls) {
      const err = thrown(call);
      expect(err).toBeInstanceOf(GoldenConfigError);
      expect(err).toMatchObject({ message: `seed dataset ${file} does not exist`, path: file });
    }
  });

  it('reports an unparsable dataset with the parse error as cause', () => {
    const file = writeSeedDataset('{"masa": ');
    const err = thrown(() => loadSeedStore(env).businessDate());
    expect(err).toBeInstanceOf(GoldenConfigError);
    const { message } = err as Error;
    expect(message.startsWith(`seed dataset ${file} is not valid JSON: `)).toBe(true);
    expect(message.length).toBeGreaterThan(`seed dataset ${file} is not valid JSON: `.length);
    expect(err).toMatchObject({ path: file, cause: expect.any(SyntaxError) });
  });

  it.each<[string, unknown]>([
    ['absent', undefined],
    ['empty', ''],
    ['a number', 20260302],
  ])('throws GoldenConfigError when the dataset businessDate is %s', (_label, businessDate) => {
    const file = writeSeedDataset({ ...DATASET, businessDate });
    const err = thrown(() => loadSeedStore(env).businessDate());
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ message: `seed dataset ${file} has no businessDate`, path: file });
  });
});

describe('resolvePlaceholders', () => {
  function resolvingContext(): ScenarioContext {
    writeSeedCredentials();
    writeSeedDataset();
    const ctx = contextFor({
      id: SCENARIO,
      seedRefs: [{ as: 'editor', source: 'dataset', path: 'masa.users', where: { username: SYSTEM_USER } }],
    });
    ctx.bindings.set('create.data', {
      id: 'FIXTURE-ID-1',
      count: 7,
      none: null,
      items: [{ name: 'first' }],
      flag: true,
    });
    ctx.bindings.set('create-form.userid', 'FIXTURE-USER-0009');
    ctx.bindings.set('matrix.site', 'tenant-a');
    return ctx;
  }

  it.each<[string, unknown]>([
    ['${secret:admin}', ADMIN_PASSWORD],
    ['pw=${secret:qa_editor};', `pw=${EDITOR_PASSWORD};`],
    [`\${secret:seed:${MEMBER}}`, MEMBER_PW],
    [`Bearer \${secret:oauth:${OAUTH_CLIENT}}`, `Bearer ${OAUTH_SECRET}`],
    ['${user:tenant-a:site-admin}', SITE_ADMIN],
    ['${secret:seed:${user:tenant-a:site-admin}}', SITE_ADMIN_PW],
    ['${user:${matrix.site}:system-user}@example.com', `${SYSTEM_USER}@example.com`],
    ['/admin/?userid=${seed.editor.userID}&x=1', '/admin/?userid=FIXTURE-USER-0002&x=1'],
    ['${seed.editor.USERNAME}', SYSTEM_USER],
    ['${seed.editor.isPublic}', 1],
    ['${seed.editor}', USERS[1]],
    ['row=${seed.editor}', `row=${JSON.stringify(USERS[1])}`],
    ['${create.data.id}', 'FIXTURE-ID-1'],
    ['/x/${create.data.id}/${create-form.userid}', '/x/FIXTURE-ID-1/FIXTURE-USER-0009'],
    ['${create.data.items[0].name}', 'first'],
    ['${create.data.items.0.name}', 'first'],
    ['${create.data.count}', 7],
    ['n=${create.data.count}', 'n=7'],
    ['${create.data.none}', null],
    ['v=${create.data.none}!', 'v=!'],
    ['flag=${create.data.flag}', 'flag=true'],
    ['${matrix.site}', 'tenant-a'],
    ['${asOf}', BUSINESS_DATE],
    ['${nodash:${create-form.userid}}', 'FIXTUREUSER0009'],
    ['p${nodash:${seed.editor.userID}}', 'pFIXTUREUSER0002'],
    ['${nodash:no-dash-left}', 'nodashleft'],
    ['plain text', 'plain text'],
    ['cost $5 {braces} $', 'cost $5 {braces} $'],
    ['${secret:admin', '${secret:admin'],
    ['${outer ${inner', '${outer ${inner'],
    ['${unclosed ${create.data.id}', '${unclosed FIXTURE-ID-1'],
  ])('resolves %j to %j', (template, expected) => {
    expect(resolvePlaceholders(template, resolvingContext())).toEqual(expected);
  });

  it('prefers a binding named asOf over the dataset businessDate', () => {
    const ctx = resolvingContext();
    ctx.bindings.set('asOf', '2030-01-31');
    expect(resolvePlaceholders('${asOf}', ctx)).toBe('2030-01-31');
  });

  it('resolves strings inside nested objects and arrays, leaving other values and the input unchanged', () => {
    const when = new Date(0);
    const input = {
      form: {
        username: '${user:tenant-a:site-admin}',
        password: '${secret:seed:${user:tenant-a:site-admin}}',
        ids: ['${create.data.id}', 3, null, true, ['${seed.editor.siteID}']],
      },
      when,
      count: 5,
    };
    const snapshot = structuredClone(input);
    const output = resolvePlaceholders(input, resolvingContext());
    expect(output).toEqual({
      form: { username: SITE_ADMIN, password: SITE_ADMIN_PW, ids: ['FIXTURE-ID-1', 3, null, true, ['tenant-a']] },
      when,
      count: 5,
    });
    expect(output.when).toBe(when);
    expect(input).toEqual(snapshot);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      'a dashless permission field name',
      { 'p${nodash:${seed.editor.userID}}': 'author', chainID: '', siteid: '${seed.editor.siteID}' },
      { pFIXTUREUSER0002: 'author', chainID: '', siteid: 'tenant-a' },
    ],
    [
      'a whole-placeholder key',
      { '${create-form.userid}': '${create.data.id}', plain: 'x' },
      { 'FIXTURE-USER-0009': 'FIXTURE-ID-1', plain: 'x' },
    ],
    [
      'keys of nested objects',
      { form: { 'id-${matrix.site}': ['${asOf}'] }, list: [{ '${matrix.site}': 1 }] },
      { form: { 'id-tenant-a': [BUSINESS_DATE] }, list: [{ 'tenant-a': 1 }] },
    ],
    ['an unclosed opener in a key as text', { '${open': 'x', '': 'y' }, { '${open': 'x', '': 'y' }],
  ])('resolves %s, keeping key order', (_label, input, expected) => {
    const output = resolvePlaceholders(input, resolvingContext());
    expect(output).toEqual(expected);
    expect(Object.keys(output)).toEqual(Object.keys(expected));
  });

  it.each<[Record<string, unknown>, string]>([
    [
      { 'p${nodash:${create-form.userid}}': 'author', pFIXTUREUSER0009: 'none' },
      'keys p${nodash:${create-form.userid}} and pFIXTUREUSER0009 both resolve to pFIXTUREUSER0009',
    ],
    [
      { '${matrix.site}': 'a', '${seed.editor.siteID}': 'b' },
      'keys ${matrix.site} and ${seed.editor.siteID} both resolve to tenant-a',
    ],
    [{ '${create.data.none}': 'x' }, 'key ${create.data.none} does not resolve to a non-empty string'],
    [{ '${create.data.count}': 'x' }, 'key ${create.data.count} does not resolve to a non-empty string'],
    [{ '${seed.editor}': 'x' }, 'key ${seed.editor} does not resolve to a non-empty string'],
    [{ '${nodash:-}': 'x' }, 'key ${nodash:-} does not resolve to a non-empty string'],
  ])('rejects keys %j with the scenario id', (input, message) => {
    const err = thrown(() => resolvePlaceholders({ form: input }, resolvingContext()));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ message: `${SCENARIO}: ${message}` });
  });

  it.each([
    ['${nodash:}', 'nodash:'],
    ['p${nodash:${create.data.none}}', 'nodash:'],
    ['${urlencode:}', 'urlencode:'],
    ['/?${urlencode:${create.data.none}}', 'urlencode:'],
  ])('rejects %s, as a value and as a key', (template, prefix) => {
    const ctx = resolvingContext();
    for (const value of [template, { [template]: 'x' }]) {
      const err = thrown(() => resolvePlaceholders(value, ctx));
      expect(err).toBeInstanceOf(GoldenConfigError);
      expect(err).toMatchObject({ message: `${SCENARIO}: \${${prefix}} has no value` });
    }
  });

  it.each<[string, string]>([
    ['a&b=c#d%e f+g', 'a%26b%3Dc%23d%25e+f%2Bg'],
    ['/?${x}', '%2F%3F%24%7Bx%7D'],
    ['café ü', 'caf%C3%A9+%C3%BC'],
    ['\u{1F600}', '%F0%9F%98%80'],
    ['Az09.-*_', 'Az09.-*_'],
  ])('encodes %j through ${urlencode:…} as legacy esapiEncode("url") does, to %j', (raw, encoded) => {
    const ctx = resolvingContext();
    ctx.bindings.set('value.raw', raw);
    expect(resolvePlaceholders('/?${urlencode:${value.raw}}', ctx)).toBe(`/?${encoded}`);
    expect(resolvePlaceholders({ 'p${urlencode:${value.raw}}': 1 }, ctx)).toEqual({ [`p${encoded}`]: 1 });
  });

  it('posts the same generated secret in capture and replay contexts of one run', () => {
    const form = { password: '${secret:generated:new-user}' };
    const capture = resolvePlaceholders(form, contextFor({ id: SCENARIO }));
    const replay = resolvePlaceholders(form, contextFor({ id: SCENARIO }, 'gateway'));
    expect(capture.password).toMatch(GENERATED_VALUE);
    expect(replay).toEqual(capture);
  });

  it('throws MissingSecretError unchanged when a secret has no value', () => {
    const ctx = createScenarioContext(
      { id: SCENARIO },
      { origin: 'legacy', env: { ...env, MURA_ADMIN_PASSWORD: '' }, fetch: fakeFetch().fetch },
    );
    const err = thrown(() => resolvePlaceholders({ password: 'x${secret:admin}' }, ctx));
    expect(err).toBeInstanceOf(MissingSecretError);
    expect(err).toMatchObject({ placeholder: '${secret:admin}', source: 'MURA_ADMIN_PASSWORD' });
  });

  it.each([
    '${seed.unknown.userID}',
    '${seed.editor.nofield}',
    '${create.data.missing}',
    '${create.data.items[5].name}',
    '${create.data.items.first}',
    '${create.data.id.more}',
    '${create}',
    '${seed}',
    '${user:tenant-a}',
    '${nobody}',
    '${}',
  ])('throws GoldenConfigError with the scenario id for unresolvable %s', (template) => {
    const err = thrown(() => resolvePlaceholders([`a ${template} b`], resolvingContext()));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ message: `${SCENARIO}: unresolved placeholder ${template}` });
  });

  it.each<[string, (file: string) => string, boolean]>([
    ['${secret:vault:FIXTURE-KEY}', () => 'unknown secret placeholder ${secret:vault:FIXTURE-KEY}', false],
    ['${user:tenant-z:member}', (file) => `\${user:tenant-z:member} has no username in ${file}`, true],
  ])('prefixes the store error for %s with the scenario id', (template, message, hasPath) => {
    const ctx = resolvingContext();
    const file = secretsPath(SEED_CREDENTIALS_FILE);
    const err = thrown(() => resolvePlaceholders(template, ctx));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect((err as Error).message.startsWith(`${SCENARIO}: ${message(file)}`)).toBe(true);
    expect((err as GoldenConfigError).path).toBe(hasPath ? file : undefined);
    expect((err as Error).cause).toBeInstanceOf(GoldenConfigError);
  });

  describe('with a secret holding reserved characters', () => {
    function maskingContext(): ScenarioContext {
      env = { ...env, MURA_ADMIN_PASSWORD: RESERVED_PW };
      const ctx = resolvingContext();
      ctx.bindings.set(`echo.${RESERVED_PW}`, null);
      return ctx;
    }

    function expectMasked(err: unknown): void {
      expect(errorText(err)).not.toContain(RESERVED_PW);
      expect(errorText(err)).not.toContain(RESERVED_PW_ENCODED);
    }

    it.each<[string, unknown, string]>([
      [
        'an unknown secret named by a secret',
        '${secret:${secret:admin}}',
        `unknown secret placeholder \${secret:${MASK}};`,
      ],
      [
        'an unresolved placeholder naming a secret',
        'x ${foo:${secret:admin}}',
        `unresolved placeholder \${foo:${MASK}}`,
      ],
      [
        'an unresolved placeholder naming an encoded secret',
        '${foo:${urlencode:${secret:admin}}}',
        `unresolved placeholder \${foo:${MASK}}`,
      ],
      [
        'a key that does not resolve',
        { password: '${secret:admin}', [`\${echo.${RESERVED_PW}}`]: 'x' },
        `key \${echo.${MASK}} does not resolve to a non-empty string`,
      ],
      [
        'a key collision',
        { '${secret:admin}': 'a', [RESERVED_PW]: 'b' },
        `keys \${secret:admin} and ${MASK} both resolve to ${MASK}`,
      ],
    ])('masks it in %s', (_label, input, message) => {
      const err = thrown(() => resolvePlaceholders(input, maskingContext()));
      expect(err).toBeInstanceOf(GoldenConfigError);
      expect((err as Error).message.startsWith(`${SCENARIO}: ${message}`)).toBe(true);
      expect((err as Error).cause).toBeUndefined();
      expectMasked(err);
    });

    it.each([
      ['${secret:seed:${secret:admin}}', `\${secret:seed:${MASK}}`],
      ['${secret:oauth:${urlencode:${secret:admin}}}', `\${secret:oauth:${MASK}}`],
    ])('masks it in the MissingSecretError placeholder of %s', (template, placeholder) => {
      const err = thrown(() => resolvePlaceholders(template, maskingContext()));
      const file = secretsPath(SEED_CREDENTIALS_FILE);
      expect(err).toBeInstanceOf(MissingSecretError);
      const message = `Secret ${placeholder} has no unique value in ${file}`;
      expect(err).toMatchObject({ placeholder, source: file, message });
      expectMasked(err);
    });

    it('masks it in a seedRef failure and drops the cause that quotes it', () => {
      env = { ...env, MURA_ADMIN_PASSWORD: RESERVED_PW };
      const file = writeSeedDataset();
      const where = { username: '${secret:admin}' };
      const seedRefs: SeedRef[] = [{ as: 'x', source: 'dataset', path: 'masa.users', where }];
      const err = thrown(() => contextFor({ id: SCENARIO, seedRefs }));
      const message = `${SCENARIO}: seedRef x: no row at index 0 among the 0 rows of masa.users matching`;
      expect(err).toBeInstanceOf(GoldenConfigError);
      expect(err).toMatchObject({ message: `${message} {"username":"${MASK}"}`, path: file });
      expect((err as Error).cause).toBeUndefined();
      expectMasked(err);
    });
  });

  it('prefixes a missing businessDate for asOf with the scenario id', () => {
    const file = writeSeedDataset({ ...DATASET, businessDate: undefined });
    const err = thrown(() => resolvePlaceholders('${asOf}', contextFor()));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect(err).toMatchObject({ message: `${SCENARIO}: seed dataset ${file} has no businessDate`, path: file });
  });
});

describe('placeholderNames', () => {
  it('lists distinct names as written, outer before inner, in order of appearance', () => {
    const value = {
      route: '/admin/?userid=${create-form.userid}&site=${matrix.site}',
      form: { password: '${secret:seed:${user:tenant-a:member}}', again: '${matrix.site}' },
      list: ['${asOf}', 5, null, true, ['${seed.editor.userID}']],
      when: new Date(0),
    };
    expect(placeholderNames(value)).toEqual([
      'create-form.userid',
      'matrix.site',
      'secret:seed:${user:tenant-a:member}',
      'user:tenant-a:member',
      'asOf',
      'seed.editor.userID',
    ]);
  });

  it('lists the placeholders of object keys, each key before its value', () => {
    const value = {
      'p${nodash:${seed.group.groupID}}': 'author',
      chainID: '',
      nested: [{ '${matrix.site}': '${asOf}' }],
    };
    expect(placeholderNames(value)).toEqual([
      'nodash:${seed.group.groupID}',
      'seed.group.groupID',
      'matrix.site',
      'asOf',
    ]);
  });

  it.each<unknown>([
    'plain text',
    { '${unclosed': 'text', plain: '' },
    '${unclosed',
    '${outer ${inner',
    'cost $5 {braces}',
    42,
    null,
    undefined,
    [],
    new Date(0),
  ])('finds no placeholder in %j', (value) => {
    expect(placeholderNames(value)).toEqual([]);
  });

  it('treats an unclosed opener as text and still finds the placeholder after it', () => {
    expect(placeholderNames('${open ${create.data.id}')).toEqual(['create.data.id']);
  });
});

describe('secretValues', () => {
  it('returns the secrets the context resolved and none of its usernames, bindings or seed values', () => {
    writeSeedCredentials();
    writeSeedDataset();
    const ctx = contextFor({
      id: SCENARIO,
      seedRefs: [{ as: 'editor', source: 'dataset', path: 'masa.users', where: { username: SYSTEM_USER } }],
    });
    expect(secretValues(ctx)).toEqual([]);
    ctx.bindings.set('create.data', { id: 'FIXTURE-ID-1' });
    resolvePlaceholders(
      {
        username: '${user:tenant-a:site-admin}',
        password: '${secret:seed:${user:tenant-a:site-admin}}',
        admin: '${secret:admin}',
        again: '${secret:admin}',
        id: '${create.data.id}',
        token: `\${secret:oauth:${OAUTH_CLIENT}}`,
        site: '${seed.editor.siteID}',
        asOf: '${asOf}',
      },
      ctx,
    );
    expect(secretValues(ctx)).toEqual([SITE_ADMIN_PW, ADMIN_PASSWORD, OAUTH_SECRET]);
    expect(secretValues(ctx)).toEqual(ctx.secrets.values());
  });

  /** Route key of a GET of `route` under legacy reload parameter `key`. */
  async function routeKeyOf(route: string, key: string): Promise<string> {
    const url = new URL(route, LEGACY_URL);
    const query = Object.fromEntries(url.searchParams);
    const req = { method: 'GET', path: url.pathname, query, headers: {} };
    return (await inventoryRouteKeyForRequest(req, { appReloadKey: key })).key;
  }

  /** Decoded query parameter names of `route`. */
  function queryNames(route: string): string[] {
    return [...new URL(route, LEGACY_URL).searchParams.keys()];
  }

  it.each<[string, EnvLike, string, string, string[], boolean]>([
    ['configured', { MURA_APPRELOADKEY: RELOAD_KEY }, RELOAD_KEY, RELOAD_KEY, [RELOAD_KEY], false],
    [
      'configured reserved-character',
      { MURA_APPRELOADKEY: RESERVED_KEY },
      RESERVED_KEY,
      RESERVED_KEY_ENCODED,
      [RESERVED_KEY, RESERVED_KEY_ENCODED],
      false,
    ],
    ['default', {}, 'appreload', 'appreload', [], true],
  ])(
    'resolves the GS-PS-04 routes with the %s reload key to URL-encoded reload:application requests',
    async (_label, vars, key, encoded, listed, literalReloads) => {
      const scenario = scenarioById(await loadCatalogue(), 'GS-PS-04');
      const secrets = loadSecretStore({ ...env, ...vars });
      const seed = loadSeedStore(env);
      const ctx = createScenarioContext(scenario, { origin: 'legacy', env, secrets, seed, fetch: fakeFetch().fetch });
      const requested = scenario.steps.map((step) => step.route);
      const routes = resolvePlaceholders(requested, ctx);

      expect(routes).toEqual([`/?${encoded}`, `/admin/?${encoded}&reload=${encoded}`]);
      expect(secretValues(ctx)).toEqual(listed);
      expect(scenario.covers).toEqual(['reload:application']);
      expect(routes.map(queryNames)).toEqual([[key], [key, 'reload']]);
      expect(new URL(routes[1] ?? '', LEGACY_URL).searchParams.get('reload')).toBe(key);
      expect(queryNames(`/?${key}`).includes(key)).toBe(key === encoded);
      for (const route of routes) expect(await routeKeyOf(route, key)).toBe('reload:application');
      expect((await routeKeyOf('/?appreload', key)) === 'reload:application').toBe(literalReloads);
      const err = thrown(() => resolvePlaceholders('/?${secret:appreload}&${public-reload.missing}', ctx));
      expect(err).toMatchObject({ message: 'GS-PS-04: unresolved placeholder ${public-reload.missing}' });
    },
  );
});
