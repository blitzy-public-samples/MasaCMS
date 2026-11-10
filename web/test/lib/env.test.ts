import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvValidationError, loadEnv } from '@opt2/platform/service-kit';
import {
  CORE_VERSION,
  GATEWAY_SERVICE_PREFIX,
  legacySettings,
  resetLegacySettingsForTests,
  setWebEnvForTests,
  webEnv,
  webEnvSchema,
  type LegacySettings,
  type WebEnv,
} from '@/lib/env';

/** Valid synthetic web variables. */
const TEST_ENV_DEFAULTS = {
  NODE_ENV: 'test',
  PORT: '8101',
  OPT2_SERVICE_NAME: 'web',
  OPT2_ENV: 'local',
  OPT2_TOKEN_ISSUER: 'https://identity.opt2.test',
  OPT2_TOKEN_AUDIENCE: 'opt2-web',
  OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
  OPT2_GATEWAY_URL: 'http://127.0.0.1:8100/',
  TZ: 'UTC',
} as const satisfies NodeJS.ProcessEnv;

type Overrides = Record<string, string | undefined>;

/** Replaces every web and `MURA_` variable in `process.env` with `vars`; returns a restore for the cached env. */
function useTestEnv(vars: NodeJS.ProcessEnv = TEST_ENV_DEFAULTS): () => void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const key of Object.keys(webEnvSchema.shape)) vi.stubEnv(key, vars[key]);
  return setWebEnvForTests(undefined);
}

/** The issues `loadEnv(webEnvSchema, source)` throws. */
function issuesOf(source: NodeJS.ProcessEnv): string[] {
  try {
    loadEnv(webEnvSchema, source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return (error as EnvValidationError).issues;
  }
  throw new Error('loadEnv accepted the source');
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('constants', () => {
  it('names the core version and gateway prefix', () => {
    expect(CORE_VERSION).toBe('7.6.1');
    expect(GATEWAY_SERVICE_PREFIX).toBe('/opt2/svc');
  });
});

describe('webEnvSchema', () => {
  it('parses the defaults', () => {
    const env: WebEnv = loadEnv(webEnvSchema, TEST_ENV_DEFAULTS);
    const gatewayUrl: string = env.OPT2_GATEWAY_URL;
    expect(gatewayUrl).toBe('http://127.0.0.1:8100');
    expect(env).toMatchObject({
      PORT: 8101,
      OPT2_SERVICE_NAME: 'web',
      OPT2_ENV: 'local',
      OPT2_SERVICE_URLS: {},
      OPT2_TASKS_ADAPTER: 'local',
      OPT2_STORAGE_ADAPTER: 'local',
    });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it.each([[''], ['  '], [undefined]])('defaults OPT2_SERVICE_NAME %j to web', (name) => {
    expect(loadEnv(webEnvSchema, { ...TEST_ENV_DEFAULTS, OPT2_SERVICE_NAME: name }).OPT2_SERVICE_NAME).toBe('web');
  });

  it('parses OPT2_SERVICE_URLS into a record', () => {
    const env = loadEnv(webEnvSchema, {
      ...TEST_ENV_DEFAULTS,
      OPT2_SERVICE_URLS: '{"people":"http://127.0.0.1:8112/","identity":"http://127.0.0.1:8111"}',
    });
    expect(env.OPT2_SERVICE_URLS).toEqual({ people: 'http://127.0.0.1:8112', identity: 'http://127.0.0.1:8111' });
  });

  it.each<{ overrides: Overrides; issues: string[] }>([
    ...['PORT', 'OPT2_ENV', 'OPT2_TOKEN_ISSUER', 'OPT2_TOKEN_AUDIENCE', 'TZ', 'OPT2_GATEWAY_URL'].map((key) => ({
      overrides: { [key]: undefined },
      issues: [`${key}: is required`],
    })),
    { overrides: { PORT: '', OPT2_GATEWAY_URL: '' }, issues: ['PORT: is required', 'OPT2_GATEWAY_URL: is required'] },
    { overrides: { OPT2_SERVICE_NAME: 'people' }, issues: ['OPT2_SERVICE_NAME: must be web'] },
    { overrides: { OPT2_SERVICE_URLS: 'people' }, issues: ['OPT2_SERVICE_URLS: OPT2_SERVICE_URLS must be a JSON object'] },
  ])('rejects $overrides', ({ overrides, issues }) => {
    expect(issuesOf({ ...TEST_ENV_DEFAULTS, ...overrides })).toEqual(issues);
  });
});

describe('webEnv', () => {
  it('parses process.env once', () => {
    const first = webEnv();
    vi.stubEnv('PORT', '8199');
    expect(webEnv()).toBe(first);
    expect(first.PORT).toBe(8101);
  });

  it('throws EnvValidationError when process.env is invalid', () => {
    vi.stubEnv('OPT2_GATEWAY_URL', undefined);
    expect(() => webEnv()).toThrow(EnvValidationError);
  });

  it('installs a test env and restores the previous one', () => {
    const parsed = webEnv();
    const installed: WebEnv = loadEnv(webEnvSchema, { ...TEST_ENV_DEFAULTS, PORT: '8199' });
    const restore = setWebEnvForTests(installed);
    expect(webEnv()).toBe(installed);
    restore();
    expect(webEnv()).toBe(parsed);
  });

  it('re-reads process.env when cleared', () => {
    const parsed = webEnv();
    vi.stubEnv('PORT', '8199');
    const restore = setWebEnvForTests(undefined);
    expect(webEnv().PORT).toBe(8199);
    restore();
    expect(webEnv()).toBe(parsed);
  });

  it('drops cached legacy settings on install and restore', () => {
    expect(legacySettings().title).toBe('Masa CMS');
    vi.stubEnv('MURA_TITLE', 'Acme');
    const restore = setWebEnvForTests(webEnv());
    expect(legacySettings().title).toBe('Acme');
    vi.stubEnv('MURA_TITLE', 'Beta');
    restore();
    expect(legacySettings().title).toBe('Beta');
  });
});

describe('legacySettings', () => {
  it('resolves the settings template values', () => {
    expect(legacySettings()).toMatchObject({
      title: 'Masa CMS',
      context: '',
      adminDir: '/admin',
      adminDomain: '',
      adminSSL: false,
      sessionTimeout: 180,
      renderMuraAlerts: true,
      secureCookies: false,
      sessionHistory: 0,
      windowDocumentDomain: '',
      defaultLocale: 'Server',
      allowAutoUpdates: true,
      fileManagerEnabled: true,
      fmShowSiteFiles: true,
      fmShowApplicationRoot: true,
      mode: 'production',
      dbType: '',
      indexFileInAPI: true,
      version: '7.6.1',
    } satisfies Partial<LegacySettings>);
  });

  it('falls back to configBean for settings the template lacks', () => {
    expect(legacySettings()).toMatchObject({
      htmlEditorType: '',
      expirePasswords: 0,
      fileDelim: process.platform === 'win32' ? '\\' : '/',
    } satisfies Partial<LegacySettings>);
  });

  it('caches a frozen object until reset', () => {
    const settings = legacySettings();
    expect(Object.isFrozen(settings)).toBe(true);
    vi.stubEnv('MURA_TITLE', 'Acme');
    expect(legacySettings()).toBe(settings);
    resetLegacySettingsForTests();
    expect(legacySettings().title).toBe('Acme');
  });

  it.each<[Record<string, string>, keyof LegacySettings, LegacySettings[keyof LegacySettings]]>([
    [{ MURA_TITLE: 'Acme' }, 'title', 'Acme'],
    [{ MURA_ADMINDIR: '/manage' }, 'adminDir', '/manage'],
    [{ MURA_ADMINDIR: 'manage' }, 'adminDir', '/manage'],
    [{ MURA_ADMINDIR: '/' }, 'adminDir', '/admin'],
    [{ MURA_ADMINDIR: '' }, 'adminDir', '/admin'],
    [{ MURA_CONTEXT: '/masa/' }, 'context', '/masa'],
    [{ MURA_CONTEXT: '/' }, 'context', ''],
    [{ MURA_ADMINDOMAIN: 'admin.example.test' }, 'adminDomain', 'admin.example.test'],
    [{ MURA_ADMINSSL: 'true' }, 'adminSSL', true],
    [{ MURA_ADMINSSL: 'false' }, 'adminSSL', false],
    [{ MURA_ADMINSSL: 'yes' }, 'adminSSL', true],
    [{ MURA_ADMINSSL: 'no' }, 'adminSSL', false],
    [{ MURA_ADMINSSL: '1' }, 'adminSSL', true],
    [{ MURA_ADMINSSL: '0' }, 'adminSSL', false],
    [{ MURA_ADMINSSL: 'YES' }, 'adminSSL', true],
    [{ MURA_ADMINSSL: 'False' }, 'adminSSL', false],
    [{ MURA_ADMINSSL: '2' }, 'adminSSL', true],
    [{ MURA_SESSIONTIMEOUT: '30' }, 'sessionTimeout', 30],
    [{ MURA_SESSIONHISTORY: '7' }, 'sessionHistory', 7],
    [{ MURA_SESSIONHISTORY: 'week' }, 'sessionHistory', 1],
    [{ MURA_LOCALE: 'en_US' }, 'defaultLocale', 'en_US'],
    [{ MURA_LOCALE: '' }, 'defaultLocale', 'Server'],
    [{ MURA_ALLOWAUTOUPDATES: 'false' }, 'allowAutoUpdates', false],
    [{ MURA_ALLOWAUTOUPDATES: 'maybe' }, 'allowAutoUpdates', false],
    [{ MURA_DBTYPE: 'mysql5' }, 'dbType', 'mysql'],
    [{ MURA_DBTYPE: 'h2' }, 'dbType', 'mysql'],
    [{ MURA_DBTYPE: 'mssql' }, 'dbType', 'mssql'],
    [{ MURA_PORT: '8080' }, 'serverPort', ':8080'],
    [{ MURA_PORT: '80' }, 'serverPort', ''],
    [{ MURA_PORT: '443' }, 'serverPort', ''],
    [{ MURA_HTMLEDITORTYPE: 'ckeditor' }, 'htmlEditorType', 'ckeditor'],
    [{ MURA_EXPIREPASSWORDS: '90' }, 'expirePasswords', 90],
    [{ MURA_FILEDELIM: '\\' }, 'fileDelim', '\\'],
    [{ MURA_INDEXFILEINURLS: 'false' }, 'indexFileInAPI', false],
    [{ MURA_INDEXFILEINURLS: 'true' }, 'indexFileInAPI', true],
    [{ MURA_INDEXFILEINAPI: 'false' }, 'indexFileInAPI', false],
    [{ MURA_INDEXFILEINAPI: 'true', MURA_INDEXFILEINURLS: 'false' }, 'indexFileInAPI', true],
  ])('reads %j as %s %j', (vars, field, expected) => {
    for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
    expect(legacySettings()[field]).toBe(expected);
  });
});
