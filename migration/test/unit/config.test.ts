// Unit tests for the static migration configuration, its owner lookups and the migration environment schema.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EnvValidationError } from '@opt2/platform/service-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MigrationConfigError,
  loadConfig,
  migrationConfigSchema,
  ownerByName,
  ownerBySchema,
  resolveReportsDir,
  type LoadedMigrationConfig,
  type MigrationConfig,
} from '../../src/config.js';
import {
  UnsupportedLegacyDatabaseError,
  assertSqlServerSource,
  loadMigrationEnv,
  migrationEnvSchema,
} from '../../src/env.js';
import { CONFIG_PATH } from '../../src/paths.js';

const CONFIG_URL = new URL('../../config/migration.config.json', import.meta.url);
const REPO_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const MASA_APP_START = new URL('../../../core/appcfc/onApplicationStart_include.cfm', import.meta.url);
const MASA_CONFIG_BEAN = new URL('../../../core/mura/configBean.cfc', import.meta.url);

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const RAW: unknown = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));

const OWNERS = [
  ['identity', 'identity', 'services/identity'],
  ['people', 'people', 'services/people'],
  ['programs-sites', 'programs_sites', 'services/programs-sites'],
  ['strategies-content', 'content', 'services/strategies-content'],
  ['communications', 'communications', 'services/communications'],
  ['reporting', 'reporting', 'services/reporting'],
  ['surveys', 'surveys', 'services/surveys'],
  ['timesheets', 'timesheets', 'services/timesheets'],
  ['finance', 'finance', 'services/finance'],
  ['e-signature', 'esignature', 'services/e-signature'],
  ['stub', 'stub', 'services/stub'],
  ['gateway', 'gateway', 'gateway'],
  ['migration', 'migration', 'migration'],
] as const;

const SERVICES = OWNERS.slice(0, 10).map(([name]) => name);

const FAULTS = [
  'applier-killed-mid-batch',
  'duplicate-batch',
  'mssql-dropped-mid-extract',
  'service-restarted-mid-apply',
  'pubsub-redelivery',
  'window-import-interrupted',
  'projector-delay',
  'forced-reinit',
];

/** Placeholder environment of the migration service; no value is a real credential. */
const ENV: NodeJS.ProcessEnv = {
  PORT: '8102',
  OPT2_SERVICE_NAME: 'migration',
  OPT2_ENV: 'local',
  OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
  OPT2_TOKEN_ISSUER: 'http://127.0.0.1:8111',
  OPT2_TOKEN_AUDIENCE: 'opt2',
  TZ: 'UTC',
  MURA_DBHOST: '127.0.0.1',
  MURA_DATABASE: 'muradb_unit',
  MURA_DBUSERNAME: 'unit-reader',
  MURA_DBPASSWORD: 'not-a-secret',
  LEGACY_ORIGIN: 'http://localhost:8080/',
  OPT2_BRIDGE_HMAC_KEY: 'not-a-key',
};

const rawConfig = (): MigrationConfig => migrationConfigSchema.parse(structuredClone(RAW));

function faultNamed(config: MigrationConfig, name: string): MigrationConfig['faults'][number] {
  const fault = config.faults.find((entry) => entry.name === name);
  if (fault === undefined) throw new Error(`fault ${name} is not configured`);
  return fault;
}

/** Runs `action` and returns what it threw, failing the test when it returns normally. */
function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('migration.config.json', () => {
  it('parses under the strict configuration schema unchanged', () => {
    expect(migrationConfigSchema.parse(RAW)).toEqual(RAW);
  });

  it('loads the same values once and returns the cached object on later calls', () => {
    const first = loadConfig();
    const { paths, ...values } = first;

    expect(values).toEqual(RAW);
    expect(paths).toBeDefined();
    expect(loadConfig()).toBe(first);
    expect(loadConfig({ path: CONFIG_PATH })).toBe(first);
  });

  it('rejects an unknown top-level key', () => {
    const result = migrationConfigSchema.safeParse({ ...rawConfig(), extra: true });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
  });
});

describe('timing and batch figures', () => {
  const config = loadConfig();

  it.each([
    ['batches 1,000 rows per backfill apply', config.backfill.batchRows, 1_000],
    ['gives a write window 30 s to open', config.windows.openBudgetMs, 30 * SECOND],
    ['uses a 30 s freeze acknowledgement wait', config.transition.freezeAckTimeoutMs, 30 * SECOND],
    ['awaits the reverse projection for 5 s by default', config.projection.defaultAwaitTimeoutMs, 5 * SECOND],
    ['retries a pending window import every 5 s', config.windows.importRetryMs, 5 * SECOND],
    ['leases a gateway write window for 120 s', config.windows.gatewayLeaseMs, 120 * SECOND],
    ['polls the legacy bridge every 60 s', config.background.bridgePollMs, 60 * SECOND],
    ['reconciles task queues every 5 min', config.background.tasksReconcileMs, 5 * MINUTE],
    ['waits up to 10 min for cfthread export jobs', config.transition.cfthreadWaitMs, 10 * MINUTE],
    ['delays the projector by 3 s by default', faultNamed(config, 'projector-delay').defaultDelayMs, 3 * SECOND],
  ])('%s', (_title, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('lists the eight faults in run order, with a delay only on projector-delay', () => {
    expect(config.faults.map((fault) => fault.name)).toEqual(FAULTS);
    expect(config.faults.filter((fault) => fault.defaultDelayMs !== undefined).map((fault) => fault.name)).toEqual([
      'projector-delay',
    ]);
  });
});

describe('owners', () => {
  const config = loadConfig();

  it('registers thirteen owners in bootstrap order', () => {
    expect(Object.keys(config.owners)).toEqual([
      'identity',
      'people',
      'programs-sites',
      'strategies-content',
      'communications',
      'reporting',
      'surveys',
      'timesheets',
      'finance',
      'e-signature',
      'stub',
      'gateway',
      'migration',
    ]);
  });

  it.each(OWNERS)('maps owner %s to schema %s in package %s, by name and by schema', (name, schema, pkg) => {
    expect(config.owners[name]).toEqual({ schema, package: pkg });
    expect(ownerByName(config, name)).toEqual({ name, schema, package: pkg });
    expect(ownerBySchema(config, schema)).toEqual({ name, schema, package: pkg });
  });

  it('names the ten services, and no platform component, as data owners', () => {
    expect(config.dataOwners).toEqual(SERVICES);
  });

  it.each([
    [
      'name',
      () => ownerByName(config, 'programs/sites'),
      `Unknown owner name "programs/sites"; known: ${OWNERS.map(([name]) => name).join(', ')}`,
    ],
    [
      'schema',
      () => ownerBySchema(config, 'programs-sites'),
      `Unknown owner schema "programs-sites"; known: ${OWNERS.map(([, schema]) => schema).join(', ')}`,
    ],
  ])('rejects an unknown owner %s, listing the known values', (_kind, lookup, message) => {
    expect(lookup).toThrow(new Error(message));
  });
});

describe('legacy defaults and reconciliation points', () => {
  const config = loadConfig();

  it("uses Masa's default reload key appreload (onApplicationStart_include.cfm:80)", () => {
    const line = readFileSync(MASA_APP_START, 'utf8').split(/\r?\n/)[79];

    expect(line).toContain('name="application.appReloadKey" default="appreload"');
    expect(config.startupGuard.appreloadKey).toBe('appreload');
  });

  it("expects Masa's default file store fileDir (configBean.cfc:131)", () => {
    const line = readFileSync(MASA_CONFIG_BEAN, 'utf8').split(/\r?\n/)[130];

    expect(line).toContain('variables.instance.fileStore="fileDir"');
    expect(config.fileStore.expected).toBe('fileDir');
  });

  it('treats umbrella as the pool site', () => {
    expect(config.umbrellaSiteId).toBe('umbrella');
  });

  it('names the backfill, cut-over and rollback reconciliation points', () => {
    expect(config.reconciliationPoints).toEqual(
      expect.arrayContaining(['after-backfill', 'post-cutover', 'rollback-before', 'rollback-after']),
    );
  });
});

describe('resolved paths', () => {
  const config = loadConfig();

  it('resolves every configured path to its absolute location in the repository', () => {
    expect(config.paths).toEqual({
      sourcePin: path.join(REPO_DIR, 'opt2', 'source-pin.json'),
      tableOwnership: path.join(REPO_DIR, 'opt2', 'table-ownership.json'),
      inventory: path.join(REPO_DIR, 'opt2', 'inventory', 'legacy-inventory.json'),
      cutoverDir: path.join(REPO_DIR, 'gateway', 'cutover'),
      groupsFile: path.join(REPO_DIR, 'gateway', 'cutover', 'groups.json'),
      reportsDir: path.join(REPO_DIR, 'opt2', 'reports'),
    });
    expect(Object.values(config.paths).every((resolved) => path.isAbsolute(resolved))).toBe(true);
  });
});

describe('resolveReportsDir', () => {
  const config = loadConfig();
  let reportsDir: string;

  beforeEach(async () => {
    reportsDir = await mkdtemp(path.join(os.tmpdir(), 'opt2-migration-reports-'));
  });

  afterEach(async () => {
    await rm(reportsDir, { recursive: true, force: true });
  });

  it('prefers a set OPT2_REPORTS_DIR', () => {
    expect(resolveReportsDir(config, { OPT2_REPORTS_DIR: reportsDir })).toBe(reportsDir);
  });

  it.each([
    ['unset', {}],
    ['empty', { OPT2_REPORTS_DIR: '' }],
  ])('falls back to the configured directory when OPT2_REPORTS_DIR is %s', (_state, env) => {
    expect(resolveReportsDir(config, env)).toBe(config.paths.reportsDir);
  });
});

describe('loadConfig with a fixture file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-migration-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeFixture(content: string): Promise<string> {
    const file = path.join(dir, 'migration.config.json');
    await writeFile(file, content, 'utf8');
    return file;
  }

  const writeVariant = (mutate: (config: MigrationConfig) => void): Promise<string> => {
    const config = rawConfig();
    mutate(config);
    return writeFixture(JSON.stringify(config));
  };

  function configErrorFrom(file: string): MigrationConfigError {
    const error = thrownBy(() => loadConfig({ path: file }));
    expect(error).toBeInstanceOf(MigrationConfigError);
    const configError = error as MigrationConfigError;
    expect(configError.name).toBe('MigrationConfigError');
    expect(configError.configPath).toBe(file);
    expect(configError.message.split('\n')[0]).toBe(`invalid migration config ${file}`);
    return configError;
  }

  it('returns a deep-frozen copy of a valid fixture', async () => {
    const file = await writeVariant(() => undefined);
    const config: LoadedMigrationConfig = loadConfig({ path: file });

    expect(config).not.toBe(loadConfig());
    expect(config).toEqual(loadConfig());
    const parts = [
      config,
      config.owners,
      config.owners.identity,
      config.faults,
      faultNamed(config, 'forced-reinit'),
      config.fileStore.variants,
      config.paths,
    ];
    expect(parts.every((part) => Object.isFrozen(part))).toBe(true);
    expect(() => {
      config.backfill.batchRows = 1;
    }).toThrow(TypeError);
  });

  it.each([
    ['a missing file', async () => path.join(dir, 'absent.json'), /^cannot be read as JSON: ENOENT/],
    ['a directory', async () => dir, /^cannot be read as JSON: EISDIR/],
    ['a file that is not JSON', () => writeFixture('{ "sourceShaFile": '), /^cannot be read as JSON: .*JSON/],
  ])('rejects %s with a MigrationConfigError naming the file', async (_case, fixture, issue) => {
    const file = await fixture();
    const error = configErrorFrom(path.resolve(file));

    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatch(issue);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it.each<[string, (config: MigrationConfig) => void, string]>([
    ['an unknown top-level key', (config) => Object.assign(config, { extra: true }), '(root): Unrecognized key: "extra"'],
    ['an unknown nested key', (config) => Object.assign(config.backfill, { extra: 1 }), 'backfill: Unrecognized key: "extra"'],
    [
      'a schema owned twice',
      (config) => {
        config.owners.migration.schema = 'content';
      },
      'owners.migration.schema: schema "content" is already owned by "strategies-content"',
    ],
    [
      'a duplicate fault',
      (config) => {
        config.faults.push({ name: 'duplicate-batch' });
      },
      'faults.8.name: duplicate fault "duplicate-batch"',
    ],
    [
      'a missing projector-delay fault',
      (config) => {
        config.faults = config.faults.filter((fault) => fault.name !== 'projector-delay');
      },
      'faults: the "projector-delay" fault is missing',
    ],
    [
      'a defaultDelayMs on another fault',
      (config) => {
        faultNamed(config, 'applier-killed-mid-batch').defaultDelayMs = SECOND;
      },
      'faults.0: defaultDelayMs belongs to "projector-delay" only, and is required there',
    ],
    [
      'a projector-delay fault without defaultDelayMs',
      (config) => {
        delete faultNamed(config, 'projector-delay').defaultDelayMs;
      },
      'faults.6: defaultDelayMs belongs to "projector-delay" only, and is required there',
    ],
    [
      'a repeated data owner',
      (config) => {
        config.dataOwners.push('identity');
      },
      'dataOwners: must not repeat an owner',
    ],
    [
      'an absolute path',
      (config) => {
        config.reportsDir = path.join(os.tmpdir(), 'reports');
      },
      'reportsDir: must be relative to migration/',
    ],
  ])('reports %s as a key.path issue', async (_case, mutate, issue) => {
    const file = await writeVariant(mutate);
    const error = configErrorFrom(file);

    expect(error.issues).toEqual([issue]);
    expect(error.message).toContain(`\n  ${issue}`);
  });

  it('rejects a relative path that escapes the repository root', async () => {
    const file = await writeVariant((config) => {
      config.cutoverDir = '../../../x';
    });
    const error = configErrorFrom(file);

    expect(error.issues).toEqual([`Path "../../../x" escapes the repository root ${REPO_DIR}`]);
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('migration environment', () => {
  const without = (key: string, state: 'unset' | 'blank'): NodeJS.ProcessEnv => {
    const env = { ...ENV };
    if (state === 'blank') env[key] = '';
    else delete env[key];
    return env;
  };

  it('parses a complete environment with the SQL Server defaults', () => {
    const env = loadMigrationEnv(ENV);

    expect(env).toMatchObject({
      MURA_DBHOST: '127.0.0.1',
      MURA_DBPORT: 1433,
      MURA_DATABASE: 'muradb_unit',
      OPT2_MSSQL_TRUST_SERVER_CERT: true,
      LEGACY_ORIGIN: 'http://localhost:8080',
    });
    expect(env.MURA_DBTYPE).toBeUndefined();
    expect(env.OPT2_REPORTS_DIR).toBeUndefined();
  });

  it.each<[string, 'unset' | 'blank']>([
    ['MURA_DATABASE', 'unset'],
    ['MURA_DATABASE', 'blank'],
    ['OPT2_BRIDGE_HMAC_KEY', 'unset'],
    ['OPT2_BRIDGE_HMAC_KEY', 'blank'],
  ])('rejects an environment with %s %s as missing', (key, state) => {
    const source = without(key, state);
    const error = thrownBy(() => loadMigrationEnv(source));

    expect(migrationEnvSchema.safeParse(source).success).toBe(false);
    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as EnvValidationError).issues).toEqual([`${key}: is required`]);
    expect((error as EnvValidationError).message).not.toContain('not-a-secret');
  });

  it('accepts an absolute OPT2_REPORTS_DIR and rejects a relative one', () => {
    const absolute = path.join(os.tmpdir(), 'opt2-reports');

    expect(loadMigrationEnv({ ...ENV, OPT2_REPORTS_DIR: absolute }).OPT2_REPORTS_DIR).toBe(absolute);
    expect(() => loadMigrationEnv({ ...ENV, OPT2_REPORTS_DIR: 'reports' })).toThrow(
      new EnvValidationError(['OPT2_REPORTS_DIR: must be an absolute path'], 'migration'),
    );
  });

  it.each([undefined, 'mssql', 'sqlserver', 'Microsoft SQL Server', ' MSSQL '])(
    'accepts the SQL Server source type %j',
    (dbType) => {
      expect(() => assertSqlServerSource({ MURA_DBTYPE: dbType })).not.toThrow();
    },
  );

  it('rejects a MySQL source with UnsupportedLegacyDatabaseError', () => {
    const error = thrownBy(() => assertSqlServerSource({ MURA_DBTYPE: 'mysql' }));

    expect(error).toBeInstanceOf(UnsupportedLegacyDatabaseError);
    expect(error).toMatchObject({ name: 'UnsupportedLegacyDatabaseError', dbType: 'mysql' });
    expect((error as Error).message).toMatch(
      /^MURA_DBTYPE=mysql is not supported: SQL Server is the only supported legacy source\./,
    );
  });
});
