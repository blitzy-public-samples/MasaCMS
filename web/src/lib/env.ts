// Web process environment and the Masa global settings (application.configBean) the admin shell renders (server-only).
import { baseEnvSchema, loadEnv, z, type LoadedEnv } from '@opt2/platform/service-kit';

/** Masa core version: configBean `version`, printed as `application.coreversion`. */
export const CORE_VERSION = '7.6.1';

/** Gateway path prefix web relays service calls through: `${OPT2_GATEWAY_URL}/opt2/svc/<service>/<path>`. */
export const GATEWAY_SERVICE_PREFIX = '/opt2/svc';

// Overrides keep the base field types (loadEnv only accepts schemas of the base shape), narrowing them by refinement.
const webVariables = baseEnvSchema.extend({
  OPT2_SERVICE_NAME: z.preprocess(
    (value) => (value === undefined || (typeof value === 'string' && value.trim() === '') ? 'web' : value),
    z.string().refine((name): name is 'web' => name === 'web', 'must be web'),
  ),
});

/** Base variables with the service name fixed to `web` (its default) and the gateway URL required. */
export const webEnvSchema = webVariables.refine(
  (env): env is z.output<typeof webVariables> & { readonly OPT2_GATEWAY_URL: string } =>
    env.OPT2_GATEWAY_URL !== undefined,
  // Runs even when other variables failed, so loadEnv lists every missing variable at once.
  { path: ['OPT2_GATEWAY_URL'], message: 'is required', when: () => true },
);

/** Parsed web variables as `loadEnv` returns them. */
export type WebEnv = Readonly<LoadedEnv<typeof webEnvSchema>>;

/** Masa global settings the admin shell and lib read. */
export interface LegacySettings {
  readonly title: string;
  readonly context: string;
  readonly adminDir: string;
  readonly adminDomain: string;
  /** configBean `getAdminEmail()`: the no-access page's contact address. */
  readonly adminEmail: string;
  readonly adminSSL: boolean;
  /** Minutes. */
  readonly sessionTimeout: number;
  readonly renderMuraAlerts: boolean;
  readonly secureCookies: boolean;
  readonly sessionHistory: number;
  readonly windowDocumentDomain: string;
  readonly defaultLocale: string;
  readonly allowAutoUpdates: boolean;
  readonly fileManagerEnabled: boolean;
  readonly fmShowSiteFiles: boolean;
  readonly fmShowApplicationRoot: boolean;
  readonly mode: string;
  readonly dbType: string;
  /** `:<port>`, or `''` for no port, 80 and 443. */
  readonly serverPort: string;
  readonly htmlEditorType: string;
  readonly fileDelim: string;
  /** configBean `siteIDInURLS`: site URL stems carry `/<siteid>`. */
  readonly siteIDInURLS: boolean;
  /** configBean `indexFileInURLS`: site URL stems carry `/index.cfm`. */
  readonly indexFileInURLS: boolean;
  /** `legacyIndexFileLocation`: index-file URL stems sit under `<siteAssetPath>/<siteid>`. */
  readonly legacyIndexFileLocation: boolean;
  /** configBean `fileAssetPath`: when set, site file asset URLs are `<fileAssetPath>/<filePoolID>`. */
  readonly fileAssetPath: string;
  /** configBean `corepath`: when set, the core URL on an admin domain. */
  readonly corePath: string;
  /** configBean `pluginspath`: when set, the plugins URL on an admin domain. */
  readonly pluginsPath: string;
  readonly indexFileInAPI: boolean;
  /** Days; 0 means passwords never expire. */
  readonly expirePasswords: number;
  /** `strongpasswords`, true only for a CFML boolean true, as `isBoolean(v) and v` tests it. */
  readonly strongPasswords: boolean;
  readonly webroot: string;
  /** `application.appReloadKey`: the URL parameter that reloads the application. */
  readonly appReloadKey: string;
  /** configBean `javaEnabled`. */
  readonly javaEnabled: boolean;
  /** configBean `fileDir` with `s3assets` applied; `''` when unset, where configBean derives a path under the web root. */
  readonly fileDir: string;
  /** configBean `assetPath`, e.g. `/sites`; the admin session's `userFilesPath` is built from it. */
  readonly assetPath: string;
  /** configBean `getSiteAssetPath()`: `/<siteDir>`, or `''` with no site directory; site asset URLs are built from it. */
  readonly siteAssetPath: string;
  readonly version: string;
}

let loadedEnv: WebEnv | undefined;
let resolvedSettings: Readonly<LegacySettings> | undefined;

/** The web environment, parsed from `process.env` on first use; throws `EnvValidationError` when invalid. */
export function webEnv(): WebEnv {
  loadedEnv ??= loadEnv(webEnvSchema, process.env);
  return loadedEnv;
}

/** Installs `env` (`undefined` re-reads `process.env`) and drops cached legacy settings; returns a restore function. */
export function setWebEnvForTests(env: WebEnv | undefined): () => void {
  const previous = loadedEnv;
  loadedEnv = env;
  resolvedSettings = undefined;
  return () => {
    loadedEnv = previous;
    resolvedSettings = undefined;
  };
}

const CF_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** CFML `isNumeric`. */
const isCfNumeric = (value: string): boolean => CF_NUMBER.test(value.trim());

/** CFML boolean conversion: `true/false/yes/no` in any case, or a number (non-zero is true); `undefined` when `isBoolean` fails. */
function cfBoolean(value: string): boolean | undefined {
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === 'yes') return true;
  if (text === 'false' || text === 'no') return false;
  return isCfNumeric(text) ? Number(text) !== 0 : undefined;
}

/** CFML `val`: the leading numeric prefix, else 0. */
function cfVal(value: string): number {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

/** configBean `cleanFilePath`: drops one trailing `/` or `\`. */
const cleanFilePath = (path: string): string => (/[/\\]$/.test(path) ? path.slice(0, -1) : path);

/** CFML `listRest(list, '/')`: the list after its first element. */
const listRest = (list: string): string => list.replace(/^\/*[^/]*\/*/, '');

/** Masa start-up evaluates `${expr}` and `{{expr}}` values as CFML; web cannot, so they resolve to `''`. */
const literalValue = (value: string): string =>
  (value.startsWith('${') && value.endsWith('}')) || (value.startsWith('{{') && value.endsWith('}}')) ? '' : value;

const asIs = (value: string): string => value;

/** One setting: its source values and the configBean setter they pass through. */
interface SettingRule<T> {
  /** settings.ini key; its variable is `MURA_<KEY uppercased>`. */
  readonly key: string;
  /** settings.template.cfm value; absent when the template has no such key. */
  readonly template?: string;
  /** configBean value when no source sets the key or its setter rejects the value. */
  readonly fallback: T;
  /** Setter semantics; `undefined` rejects the value. */
  readonly apply: (value: string) => T | undefined;
}

type RuledSettings = Omit<LegacySettings, 'indexFileInAPI' | 'assetPath' | 'siteAssetPath' | 'version' | 'fileDir'>;

const SETTING_RULES: { readonly [K in keyof RuledSettings]: SettingRule<RuledSettings[K]> } = {
  title: { key: 'title', template: 'Masa CMS', fallback: 'Masa CMS', apply: asIs },
  context: { key: 'context', template: '', fallback: '', apply: cleanFilePath },
  adminDir: {
    key: 'admindir',
    template: '/admin',
    fallback: '/admin',
    apply: (dir) => (dir === '' || dir === '/' ? undefined : dir.startsWith('/') ? dir : `/${dir}`),
  },
  adminDomain: { key: 'admindomain', template: '', fallback: '', apply: asIs },
  adminEmail: { key: 'adminemail', template: '', fallback: '', apply: asIs },
  adminSSL: { key: 'adminssl', template: 'false', fallback: false, apply: cfBoolean },
  sessionTimeout: { key: 'sessiontimeout', template: '180', fallback: 180, apply: cfVal },
  // Not a configBean property; the admin layout reads it with defaultValue=true.
  renderMuraAlerts: { key: 'rendermuraalerts', template: 'true', fallback: true, apply: cfBoolean },
  secureCookies: { key: 'securecookies', template: 'false', fallback: false, apply: cfBoolean },
  sessionHistory: {
    key: 'sessionhistory',
    template: '0',
    fallback: 1,
    apply: (value) => (isCfNumeric(value) ? Number(value) : undefined),
  },
  windowDocumentDomain: { key: 'windowdocumentdomain', template: '', fallback: '', apply: asIs },
  defaultLocale: { key: 'locale', template: 'Server', fallback: 'Server', apply: (locale) => locale || undefined },
  allowAutoUpdates: { key: 'allowautoupdates', template: 'true', fallback: false, apply: cfBoolean },
  fileManagerEnabled: { key: 'filemanagerenabled', template: 'true', fallback: true, apply: cfBoolean },
  fmShowSiteFiles: { key: 'fmshowsitefiles', template: 'true', fallback: true, apply: cfBoolean },
  fmShowApplicationRoot: { key: 'fmshowapplicationroot', template: 'true', fallback: true, apply: cfBoolean },
  mode: { key: 'mode', template: 'production', fallback: '', apply: asIs },
  dbType: {
    key: 'dbtype',
    template: '',
    fallback: 'mssql',
    apply: (type) => (type.slice(0, 5).toLowerCase() === 'mysql' || type.toLowerCase() === 'h2' ? 'mysql' : type),
  },
  serverPort: {
    key: 'port',
    template: '${cgi.SERVER_PORT}',
    fallback: '',
    apply: (port) => (port.trim() === '' || port === '80' || port === '443' ? '' : `:${port}`),
  },
  // configBean has no default, so getValue('htmlEditorType') is ''.
  htmlEditorType: { key: 'htmleditortype', fallback: '', apply: asIs },
  // Start-up always calls setFileDelim (with '' when unset), which picks the server OS delimiter, never the bean's '\'.
  fileDelim: {
    key: 'filedelim',
    fallback: process.platform === 'win32' ? '\\' : '/',
    apply: (delim) => delim || undefined,
  },
  siteIDInURLS: { key: 'siteidinurls', template: 'false', fallback: true, apply: cfBoolean },
  indexFileInURLS: { key: 'indexfileinurls', template: 'true', fallback: true, apply: cfBoolean },
  // Not a configBean property; contentServer reads it with defaultValue=false.
  legacyIndexFileLocation: { key: 'legacyindexfilelocation', fallback: false, apply: cfBoolean },
  fileAssetPath: { key: 'fileassetpath', fallback: '', apply: asIs },
  corePath: { key: 'corepath', fallback: '', apply: asIs },
  pluginsPath: { key: 'pluginspath', fallback: '', apply: asIs },
  // The layout, passwordsExpire() and getPasswordExpired() all treat a non-numeric value as never expiring.
  expirePasswords: {
    key: 'expirepasswords',
    fallback: 0,
    apply: (value) => (isCfNumeric(value) ? Number(value) : undefined),
  },
  strongPasswords: { key: 'strongpasswords', template: 'false', fallback: false, apply: cfBoolean },
  // Masa sets it to expandPath('/muraWRM'), which only the legacy host knows.
  webroot: { key: 'webroot', fallback: '', apply: cleanFilePath },
  appReloadKey: { key: 'appreloadkey', template: 'appreload', fallback: 'appreload', apply: asIs },
  javaEnabled: { key: 'javaenabled', template: 'true', fallback: true, apply: cfBoolean },
};

/** The value of `key` in `source`, else `template`, with unevaluable expressions blanked. */
function sourceValue(source: NodeJS.ProcessEnv, key: string, template?: string): string | undefined {
  const value = source[`MURA_${key.toUpperCase()}`] ?? template;
  return value === undefined ? undefined : literalValue(value);
}

/** Resolves every setting from `source` as Masa start-up and configBean.set do. */
function resolveLegacySettings(source: NodeJS.ProcessEnv): LegacySettings {
  const read = <T>(rule: SettingRule<T>): T => {
    const value = sourceValue(source, rule.key, rule.template);
    return value === undefined ? rule.fallback : (rule.apply(value) ?? rule.fallback);
  };
  const ruled = Object.fromEntries(
    Object.entries(SETTING_RULES).map(([field, rule]: [string, SettingRule<unknown>]) => [field, read(rule)]),
  ) as unknown as RuledSettings;

  // Start-up sets indexFileInAPI=false when only indexFileInURLS=false is configured.
  const indexFileInAPI = sourceValue(source, 'indexfileinapi');
  // An empty assetPath falls back to configBean getSiteAssetPath(): '/<siteDir>', siteDir defaulting to 'sites'.
  const siteDir = sourceValue(source, 'sitedir') ?? 'sites';
  const siteAssetPath = siteDir === '' ? '' : `/${siteDir}`;
  const assetPath = cleanFilePath(sourceValue(source, 'assetpath', '') ?? '');
  // configBean.set puts a non-empty s3assets in place of fileDir's first element before setFileDir cleans it.
  const fileDir = sourceValue(source, 'filedir', '') ?? '';
  const s3Assets = sourceValue(source, 's3assets') ?? '';
  const s3Prefix = s3Assets === '' || s3Assets.endsWith('/') ? s3Assets : `${s3Assets}/`;
  return {
    ...ruled,
    indexFileInAPI:
      indexFileInAPI === undefined
        ? cfBoolean(sourceValue(source, 'indexfileinurls', 'true') ?? '') !== false
        : (cfBoolean(indexFileInAPI) ?? true),
    assetPath: assetPath !== '' ? assetPath : siteAssetPath,
    siteAssetPath,
    fileDir: cleanFilePath(s3Prefix === '' ? fileDir : s3Prefix + listRest(fileDir)),
    version: CORE_VERSION,
  };
}

/** Masa global settings resolved from `process.env` on first use. */
export function legacySettings(): Readonly<LegacySettings> {
  resolvedSettings ??= Object.freeze(resolveLegacySettings(process.env));
  return resolvedSettings;
}

/** Drops cached legacy settings so the next `legacySettings()` re-reads `process.env`. */
export function resetLegacySettingsForTests(): void {
  resolvedSettings = undefined;
}
