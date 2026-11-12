import { readFileSync } from 'node:fs';
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
import { TEST_ENV_DEFAULTS, useTestEnv } from '../helpers/env';

/** `TEST_ENV_DEFAULTS` as a `loadEnv` source; Next's `ProcessEnv` typing requires `NODE_ENV`. */
const SOURCE = { ...TEST_ENV_DEFAULTS, NODE_ENV: 'test' } as const satisfies NodeJS.ProcessEnv;

type Overrides = Record<string, string | undefined>;

/** settings.template.cfm `key=value` lines by lower-cased key, with their 1-based line numbers. */
const TEMPLATE: ReadonlyMap<string, { readonly line: number; readonly value: string }> = new Map(
  readFileSync(new URL('../../../core/templates/settings.template.cfm', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .flatMap((text, index) => {
      const [, key, value] = /^(\w+)=(.*)$/.exec(text) ?? [];
      return key === undefined || value === undefined ? [] : [[key.toLowerCase(), { line: index + 1, value }] as const];
    }),
);

/** Points every web variable of `process.env` at `SOURCE` and unsets every `MURA_` variable. */
function stubProcessEnv(): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const key of Object.keys(webEnvSchema.shape)) vi.stubEnv(key, (SOURCE as NodeJS.ProcessEnv)[key]);
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
  stubProcessEnv();
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
});

describe('constants', () => {
  it('names the core version and gateway prefix', () => {
    expect(CORE_VERSION).toBe('7.6.1');
    expect(GATEWAY_SERVICE_PREFIX).toBe('/opt2/svc');
  });
});

describe('webEnvSchema', () => {
  it('parses TEST_ENV_DEFAULTS', () => {
    const env: WebEnv = loadEnv(webEnvSchema, SOURCE);
    const gatewayUrl: string = env.OPT2_GATEWAY_URL;
    expect(gatewayUrl).toBe(TEST_ENV_DEFAULTS.OPT2_GATEWAY_URL);
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
    expect(loadEnv(webEnvSchema, { ...SOURCE, OPT2_SERVICE_NAME: name }).OPT2_SERVICE_NAME).toBe('web');
  });

  it('parses OPT2_SERVICE_URLS into a record', () => {
    const env = loadEnv(webEnvSchema, {
      ...SOURCE,
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
    expect(issuesOf({ ...SOURCE, ...overrides })).toEqual(issues);
  });
});

describe('webEnv', () => {
  it('returns the installed env on every call', () => {
    const first = webEnv();
    expect(webEnv()).toBe(first);
    expect(first.PORT).toBe(8101);
  });

  it('parses process.env once', () => {
    const restore = setWebEnvForTests(undefined);
    const first = webEnv();
    vi.stubEnv('PORT', '8199');
    expect(webEnv()).toBe(first);
    expect(first.PORT).toBe(8101);
    restore();
  });

  it('throws EnvValidationError when process.env is invalid', () => {
    const restore = setWebEnvForTests(undefined);
    vi.stubEnv('OPT2_GATEWAY_URL', undefined);
    expect(() => webEnv()).toThrow(EnvValidationError);
    restore();
  });

  it('installs a test env and restores the previous one', () => {
    const parsed = webEnv();
    const installed: WebEnv = loadEnv(webEnvSchema, { ...SOURCE, PORT: '8199' });
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
  it.each(
    (
      [
        ['title', 'title', 'Masa CMS', 'Masa CMS'],
        ['context', 'context', '', ''],
        ['adminDir', 'admindir', '/admin', '/admin'],
        ['adminDomain', 'admindomain', '', ''],
        ['adminEmail', 'adminemail', '', ''],
        ['adminSSL', 'adminssl', 'false', false],
        ['sessionTimeout', 'sessiontimeout', '180', 180],
        ['renderMuraAlerts', 'rendermuraalerts', 'true', true],
        ['secureCookies', 'securecookies', 'false', false],
        ['sessionHistory', 'sessionhistory', '0', 0],
        ['windowDocumentDomain', 'windowdocumentdomain', '', ''],
        ['defaultLocale', 'locale', 'Server', 'Server'],
        ['allowAutoUpdates', 'allowautoupdates', 'true', true],
        ['fileManagerEnabled', 'filemanagerenabled', 'true', true],
        ['fmShowSiteFiles', 'fmshowsitefiles', 'true', true],
        ['fmShowApplicationRoot', 'fmshowapplicationroot', 'true', true],
        ['mode', 'mode', 'production', 'production'],
        ['dbType', 'dbtype', '', ''],
        ['indexFileInAPI', 'indexfileinurls', 'true', true],
        ['siteIDInURLS', 'siteidinurls', 'false', false],
        ['indexFileInURLS', 'indexfileinurls', 'true', true],
        ['serverPort', 'port', '${cgi.SERVER_PORT}', ''],
        ['appReloadKey', 'appreloadkey', 'appreload', 'appreload'],
        ['javaEnabled', 'javaenabled', 'true', true],
        ['fileDir', 'filedir', '', ''],
      ] as const
    ).map(([field, key, raw, expected]) => ({
      field,
      key,
      raw,
      expected,
      shown: JSON.stringify(expected),
      line: TEMPLATE.get(key)?.line,
    })),
  )('settings.template.cfm:$line $key=$raw gives $field $shown', ({ field, key, raw, expected }) => {
    expect(TEMPLATE.get(key)?.value).toBe(raw);
    expect(legacySettings()[field]).toBe(expected);
  });

  it.each(
    (
      [
        ['htmlEditorType', 'htmleditortype', '', 1734],
        ['expirePasswords', 'expirepasswords', 0, 271],
        ['fileDelim', 'filedelim', process.platform === 'win32' ? '\\' : '/', 653],
        ['webroot', 'webroot', '', 85],
        ['assetPath', 'assetpath', '/sites', 2172],
        ['version', 'version', '7.6.1', 81],
        ['corePath', 'corepath', '', 122],
        ['pluginsPath', 'pluginspath', '', 123],
        ['fileAssetPath', 'fileassetpath', '', 1744],
      ] as const
    ).map(([field, key, expected, line]) => ({ field, key, expected, shown: JSON.stringify(expected), line })),
  )('configBean.cfc:$line gives $field $shown when the template lacks or blanks $key', ({ field, key, expected }) => {
    expect(TEMPLATE.get(key)?.value ?? '').toBe('');
    expect(legacySettings()[field]).toBe(expected);
  });

  it.each<[keyof LegacySettings, string | undefined, LegacySettings[keyof LegacySettings]]>([
    ['legacyIndexFileLocation', undefined, false],
    ['legacyIndexFileLocation', 'true', true],
    ['legacyIndexFileLocation', 'yes', true],
    ['legacyIndexFileLocation', '0', false],
    ['legacyIndexFileLocation', 'maybe', false],
    ['fileAssetPath', '//files.example.test/assets', '//files.example.test/assets'],
    ['corePath', 'https://cdn.example.test/core/', 'https://cdn.example.test/core/'],
    ['pluginsPath', 'https://cdn.example.test/plugins', 'https://cdn.example.test/plugins'],
  ])('reads the template-less MURA_<KEY> of %s=%j as %j', (field, value, expected) => {
    expect(TEMPLATE.has(field.toLowerCase())).toBe(false);
    vi.stubEnv(`MURA_${field.toUpperCase()}`, value);
    expect(legacySettings()[field]).toBe(expected);
  });

  it.each(['${application.title}', '{{application.title}}'])('blanks the CFML expression MURA_TITLE=%s', (title) => {
    vi.stubEnv('MURA_TITLE', title);
    expect(legacySettings().title).toBe('');
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
    [{ MURA_ADMINEMAIL: 'ops@example.test' }, 'adminEmail', 'ops@example.test'],
    [{ MURA_ADMINEMAIL: '' }, 'adminEmail', ''],
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
    [{ MURA_APPRELOADKEY: 'cfg-key' }, 'appReloadKey', 'cfg-key'],
    [{ MURA_APPRELOADKEY: '' }, 'appReloadKey', ''],
    [{ MURA_JAVAENABLED: 'false' }, 'javaEnabled', false],
    [{ MURA_JAVAENABLED: 'no' }, 'javaEnabled', false],
    [{ MURA_JAVAENABLED: 'maybe' }, 'javaEnabled', true],
    [{ MURA_FILEDIR: '/srv/masa/sites/' }, 'fileDir', '/srv/masa/sites'],
    [{ MURA_FILEDIR: 's3://bucket/assets' }, 'fileDir', 's3://bucket/assets'],
    [{ MURA_S3ASSETS: 's3://bucket', MURA_FILEDIR: '/srv/masa/sites' }, 'fileDir', 's3://bucket/masa/sites'],
    [{ MURA_S3ASSETS: 's3://bucket/', MURA_FILEDIR: 'sites/' }, 'fileDir', 's3://bucket'],
    [{ MURA_S3ASSETS: 's3://bucket' }, 'fileDir', 's3://bucket'],
    [{ MURA_S3ASSETS: '', MURA_FILEDIR: '/srv/masa/sites' }, 'fileDir', '/srv/masa/sites'],
    [{ MURA_INDEXFILEINURLS: 'false' }, 'indexFileInAPI', false],
    [{ MURA_INDEXFILEINURLS: 'true' }, 'indexFileInAPI', true],
    [{ MURA_INDEXFILEINAPI: 'false' }, 'indexFileInAPI', false],
    [{ MURA_INDEXFILEINAPI: 'true', MURA_INDEXFILEINURLS: 'false' }, 'indexFileInAPI', true],
    [{ MURA_SITEIDINURLS: 'true' }, 'siteIDInURLS', true],
    [{ MURA_SITEIDINURLS: 'maybe' }, 'siteIDInURLS', true],
    [{ MURA_INDEXFILEINURLS: 'false' }, 'indexFileInURLS', false],
    [{ MURA_INDEXFILEINURLS: 'no' }, 'indexFileInURLS', false],
    [{ MURA_ASSETPATH: '/assets/' }, 'assetPath', '/assets'],
    [{ MURA_SITEDIR: 'tenants' }, 'assetPath', '/tenants'],
    [{ MURA_SITEDIR: '' }, 'assetPath', ''],
  ])('reads %j as %s %j', (vars, field, expected) => {
    for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
    expect(legacySettings()[field]).toBe(expected);
  });

  it.each<[string | undefined, number]>([
    [undefined, 0],
    ['0', 0],
    ['5', 5],
    ['1.5', 1.5],
    ['5abc', 0],
    ['', 0],
    ['abc', 0],
  ])('reads MURA_EXPIREPASSWORDS=%j as expirePasswords %j, non-numeric values as never expiring', (value, expected) => {
    vi.stubEnv('MURA_EXPIREPASSWORDS', value);
    expect(legacySettings().expirePasswords).toBe(expected);
  });
});
