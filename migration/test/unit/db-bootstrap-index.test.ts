import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Connector } from '@google-cloud/cloud-sql-connector';
import { createLogger, type Logger } from '@opt2/platform/logging';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type MigrationConfig, type OwnerName } from '../../src/config.js';
import {
  bootstrap,
  bootstrapOwners,
  BootstrapEnvError,
  BootstrapStatementError,
  MissingIamUserError,
  secretPathsFor,
  SecretFileError,
  type BootstrapDeps,
  type ConnectedClient,
  type ConnectSpec,
} from '../../src/db-bootstrap/index.js';
import { loadBootstrapEnv, type BootstrapEnv, type BootstrapTarget } from '../../src/db-bootstrap/env.js';
import { MigrationDirectoryError, SchemaNotEmptyError } from '../../src/db-bootstrap/migrations.js';

interface Call {
  session: string;
  text: string;
  values?: unknown[];
}

interface FakeOptions {
  /** Roles present before the run, with their LOGIN attribute. */
  roles?: Record<string, boolean>;
  /** Schemas the emptiness check reports as holding tables. */
  populated?: string[];
  /** Schema the catalog reports with a foreign owner. */
  wrongOwner?: string;
  failOn?: RegExp;
}

const config = loadConfig();
const PROJECT = 'example-project';
const schemasInOrder = Object.values(config.owners).map((owner) => owner.schema);
// Sample credentials are assembled at run time so no password literal sits in source.
const secretFor = (schema: string, kind: string): string => ['sample', schema, kind, 'value'].join('-');
const iamUser = (account: string): string => `opt2-${account}@${PROJECT}.iam`;
const cloudIamUsers = (): string[] => [
  ...bootstrapOwners(config, 'cloud').map((owner) => iamUser(owner.name)),
  iamUser('db-bootstrap'),
];

let tmp: string;
let stateDir: string;
let packagesDir: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'opt2-db-bootstrap-index-'));
  stateDir = path.join(tmp, 'state');
  packagesDir = path.join(tmp, 'packages');
  for (const owner of Object.values(config.owners)) {
    const dir = path.join(packagesDir, owner.package, 'db', 'migrations');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '0001_init.sql'), `CREATE TABLE ${owner.schema}.t (id int);`);
  }
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function capturingLogger(): { logger: Logger; lines: Record<string, unknown>[]; raw: string[] } {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = createLogger({
    service: 'db-bootstrap',
    version: '1.0.0',
    env: 'local',
    destination: {
      write: (chunk: string) => {
        raw.push(chunk);
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      },
    },
  });
  return { logger, lines, raw };
}

/** A recording stand-in for PostgreSQL that tracks created roles and schemas and answers the catalog queries. */
function fakeDatabase(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const connections: { spec: ConnectSpec; ended: boolean }[] = [];
  const secretsRead: string[] = [];
  const roles = new Map(Object.entries(options.roles ?? {}));
  const schemas = new Map<string, string>();
  let closed = 0;
  const names = (values?: unknown[]): string[] => (values?.[0] as string[] | undefined) ?? [];

  const answer = async (session: string, text: string, values?: unknown[]): Promise<{ rows: unknown[] }> => {
    calls.push({ session, text, values });
    if (options.failOn?.test(text)) throw Object.assign(new Error('statement rejected'), { severity: 'ERROR', code: '42000' });
    if (text.startsWith('SELECT current_setting')) return { rows: [{ version: 160015 }] };
    if (text.startsWith('SELECT rolname FROM pg_roles')) {
      return { rows: names(values).filter((name) => roles.has(name)).map((rolname) => ({ rolname })) };
    }
    if (text.startsWith('SELECT rolname, rolsuper')) {
      return {
        rows: names(values)
          .filter((name) => roles.has(name))
          .map((rolname) => ({ rolname, rolsuper: false, rolbypassrls: false, rolcanlogin: roles.get(rolname) })),
      };
    }
    if (text.startsWith('SELECT n.nspname')) {
      return { rows: names(values).filter((name) => options.populated?.includes(name)).map((nspname) => ({ nspname })) };
    }
    if (text.startsWith('SELECT nspname, pg_get_userbyid')) {
      return {
        rows: names(values)
          .filter((name) => schemas.has(name))
          .map((nspname) => ({ nspname, owner: nspname === options.wrongOwner ? 'other_role' : schemas.get(nspname), acl: null })),
      };
    }
    if (text.startsWith('SELECT has_schema_privilege')) return { rows: [{ can_create: false }] };
    const role = /^CREATE ROLE "([^"]+)" (NOLOGIN|LOGIN)/.exec(text);
    if (role) roles.set(role[1]!, role[2] === 'LOGIN');
    const schema = /^CREATE SCHEMA (?:IF NOT EXISTS )?"([^"]+)" AUTHORIZATION "([^"]+)"/.exec(text);
    if (schema) schemas.set(schema[1]!, schema[2]!);
    const dropped = /^DROP ROLE IF EXISTS "([^"]+)"/.exec(text);
    if (dropped) roles.delete(dropped[1]!);
    return { rows: [] };
  };

  const deps: BootstrapDeps = {
    connect: async (spec) => {
      const connection = { spec, ended: false };
      connections.push(connection);
      const session = spec.kind === 'admin' ? 'admin' : `${spec.kind}:${spec.user}`;
      return {
        query: async (text: string, values?: unknown[]) => answer(session, text, values),
        end: async () => {
          connection.ended = true;
        },
      };
    },
    readSecret: async (file) => {
      secretsRead.push(file);
      const match = /^db-(.+)-(app|migrator)$/.exec(path.basename(file));
      if (!match) throw new Error(`unexpected secret file ${file}`);
      return secretFor(match[1]!, match[2]!);
    },
    migrationsDir: (packageRel) => path.join(packagesDir, packageRel, 'db', 'migrations'),
    close: async () => {
      closed += 1;
    },
  };
  const texts = (session: string): string[] => calls.filter((call) => call.session === session).map((call) => call.text);
  return { calls, connections, secretsRead, deps, texts, closed: () => closed };
}

function localEnv(overrides: NodeJS.ProcessEnv = {}): BootstrapEnv {
  return loadBootstrapEnv({
    OPT2_ENV: 'local',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'opt2_test',
    PG_USER: 'admin_role',
    PG_PASSWORD: ['admin', 'sample', 'value'].join('-'),
    OPT2_STATE_DIR: stateDir,
    ...overrides,
  });
}

function cloudEnv(overrides: NodeJS.ProcessEnv = {}): BootstrapEnv {
  return loadBootstrapEnv({
    OPT2_ENV: 'cloud',
    PG_DATABASE: 'opt2',
    CLOUD_SQL_INSTANCE: `${PROJECT}:us-central1:opt2`,
    GOOGLE_CLOUD_PROJECT: PROJECT,
    OPT2_CLOUDSQL_ADMIN_PASSWORD: ['cloud', 'sample', 'value'].join('-'),
    OPT2_STATE_DIR: stateDir,
    ...overrides,
  });
}

const failure = async (run: Promise<unknown>): Promise<unknown> => run.then(() => undefined, (error: unknown) => error);

describe('bootstrapOwners and secretPathsFor', () => {
  it('lists every owner locally and the deployed owners without the stub in the cloud, in config order', () => {
    const local = bootstrapOwners(config, 'local');
    expect(local.map((owner) => owner.name)).toEqual(Object.keys(config.owners));
    expect(local.find((owner) => owner.name === 'strategies-content')).toEqual({
      name: 'strategies-content',
      schema: 'content',
      package: 'services/strategies-content',
      roles: { schema: 'content', owner: 'content_owner', app: 'content_app', migrator: 'content_migrator' },
    });
    const cloud = bootstrapOwners(config, 'cloud').map((owner) => owner.name);
    expect(cloud).toEqual(Object.keys(config.owners).filter((name) => name !== 'stub'));
  });

  it('names the app and migrator password files under <state>/secrets', () => {
    expect(secretPathsFor('/state', 'people')).toEqual({
      app: '/state/secrets/db-people-app',
      migrator: '/state/secrets/db-people-migrator',
    });
    expect(() => secretPathsFor('relative', 'people')).toThrow(/absolute/);
  });
});

describe('local bootstrap', () => {
  it('resets, then creates roles, schema and chain per owner, then migrates each schema as its owner, then asserts', async () => {
    const db = fakeDatabase();
    const { logger, lines, raw } = capturingLogger();
    const summary = await bootstrap({ target: 'local', env: localEnv(), config, logger, deps: db.deps });

    expect(summary).toMatchObject({ command: 'bootstrap', target: 'local', ok: true, roles: 39, iamGrants: 0, findings: [] });
    expect(summary.schemas.map((entry) => entry.schema)).toEqual(schemasInOrder);
    expect(summary.schemas).toContainEqual({ schema: 'content', owner: 'strategies-content', migrations: 1 });
    expect(db.secretsRead).toHaveLength(26);
    expect(db.secretsRead[0]).toBe(secretPathsFor(stateDir, 'identity').app);
    expect(db.connections[0]!.spec).toEqual({ kind: 'admin' });
    expect(db.connections.slice(1).map((connection) => connection.spec)).toEqual(
      schemasInOrder.map((schema) => ({ kind: 'role', user: `${schema}_migrator`, password: secretFor(schema, 'migrator') })),
    );
    expect(db.connections.every((connection) => connection.ended)).toBe(true);
    expect(db.closed()).toBe(1);

    const admin = db.texts('admin');
    const selfGrant = admin.indexOf("SET createrole_self_grant = 'set, inherit'");
    const lastDrop = admin.map((text) => text.startsWith('DROP ')).lastIndexOf(true);
    const ddl = admin.filter((text) => /^(CREATE|GRANT|REVOKE)/.test(text));
    expect(selfGrant).toBeGreaterThan(-1);
    expect(selfGrant).toBeLessThan(admin.findIndex((text) => text.startsWith('DROP SCHEMA')));
    expect(lastDrop).toBeLessThan(admin.findIndex((text) => text.startsWith('CREATE ROLE')));
    expect(ddl).toHaveLength(schemasInOrder.length * 6);
    expect(ddl.slice(0, 6).map((text) => text.split(' PASSWORD ')[0])).toEqual([
      'CREATE ROLE "identity_owner" NOLOGIN NOSUPERUSER NOBYPASSRLS',
      'CREATE ROLE "identity_app" LOGIN NOSUPERUSER NOBYPASSRLS',
      'CREATE ROLE "identity_migrator" LOGIN NOSUPERUSER NOBYPASSRLS',
      'CREATE SCHEMA "identity" AUTHORIZATION "identity_owner"',
      'GRANT "identity_owner" TO "identity_migrator"',
      'REVOKE ALL ON SCHEMA "identity" FROM PUBLIC',
    ]);
    const lastMigratorCall = db.calls.map((call) => call.session !== 'admin').lastIndexOf(true);
    expect(db.calls.findIndex((call) => call.text.startsWith('SELECT rolname, rolsuper'))).toBeGreaterThan(lastMigratorCall);

    expect(db.texts('role:people_migrator')).toEqual([
      'SET ROLE "people_owner"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "people_owner" IN SCHEMA "people" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "people_app"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "people_owner" IN SCHEMA "people" GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "people_app"',
      'GRANT USAGE ON SCHEMA "people" TO "people_app"',
      'RESET ROLE',
      'SET ROLE "people_owner"',
      'BEGIN',
      'CREATE TABLE people.t (id int);',
      'COMMIT',
      'RESET ROLE',
      'SET ROLE "people_owner"',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "people" TO "people_app"',
      'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "people" TO "people_app"',
      'RESET ROLE',
    ]);

    const messages = lines.map((line) => line.message);
    expect(messages).toContain('created roles for identity');
    expect(messages).toContain('migrated content: 1 files');
    expect(messages.at(-1)).toBe('bootstrap finished: 13 schemas');
    const log = raw.join('');
    expect(log).not.toContain('PASSWORD');
    for (const schema of schemasInOrder) {
      expect(log).not.toContain(secretFor(schema, 'app'));
      expect(log).not.toContain(secretFor(schema, 'migrator'));
    }
  });

  it('returns ok false with the findings when the role assertions find a defect', async () => {
    const db = fakeDatabase({ wrongOwner: 'finance' });
    const { logger, lines } = capturingLogger();
    const summary = await bootstrap({ target: 'local', env: localEnv(), config, logger, deps: db.deps });
    expect(summary.ok).toBe(false);
    expect(summary.findings).toEqual([
      { kind: 'schema-owner', subject: 'finance', detail: 'owned by other_role, expected finance_owner' },
    ]);
    expect(lines.some((line) => line.severity === 'WARNING')).toBe(true);
  });

  it.each([
    {
      what: 'a password file',
      error: SecretFileError,
      deps: (deps: BootstrapDeps): BootstrapDeps => ({
        ...deps,
        readSecret: async (file) => Promise.reject(new SecretFileError(file, 'does not exist')),
      }),
    },
    {
      what: 'a migration directory',
      error: MigrationDirectoryError,
      deps: (deps: BootstrapDeps): BootstrapDeps => ({
        ...deps,
        migrationsDir: (packageRel) => (packageRel === 'gateway' ? path.join(tmp, 'absent') : deps.migrationsDir(packageRel)),
      }),
    },
  ])('fails before connecting when $what is missing', async ({ error, deps }) => {
    const db = fakeDatabase();
    const { logger } = capturingLogger();
    const thrown = await failure(bootstrap({ target: 'local', env: localEnv(), config, logger, deps: deps(db.deps) }));
    expect(thrown).toBeInstanceOf(error);
    expect(db.connections).toHaveLength(0);
    expect(db.closed()).toBe(1);
  });

  it('masks passwords in the error of a failed role statement and ends the admin session', async () => {
    const db = fakeDatabase({ failOn: /^CREATE ROLE "people_app"/ });
    const { logger } = capturingLogger();
    const thrown = await failure(bootstrap({ target: 'local', env: localEnv(), config, logger, deps: db.deps }));
    expect(thrown).toBeInstanceOf(BootstrapStatementError);
    const { message, statement } = thrown as BootstrapStatementError;
    expect(message).toContain("PASSWORD '***'");
    expect(message).toContain('statement rejected');
    expect(`${message}${statement}`).not.toContain(secretFor('people', 'app'));
    expect(db.connections.every((connection) => connection.ended)).toBe(true);
  });

  it('reads password files through the default dependencies and names a missing or empty file', async () => {
    const dir = path.join(tmp, 'default-state');
    await mkdir(path.join(dir, 'secrets'), { recursive: true });
    const { logger } = capturingLogger();
    const env = localEnv({ OPT2_STATE_DIR: dir });
    const appFile = secretPathsFor(dir, 'identity').app;
    expect((await failure(bootstrap({ target: 'local', env, config, logger }))) as Error).toMatchObject({
      name: 'SecretFileError',
      message: `secret file ${appFile} does not exist`,
    });
    await writeFile(appFile, '\r\n');
    expect(((await failure(bootstrap({ target: 'local', env, config, logger }))) as Error).message).toBe(
      `secret file ${appFile} is empty`,
    );
  });
});

describe('cloud bootstrap', () => {
  it('creates NOLOGIN roles, grants the IAM users and migrates every deployed schema on one IAM session', async () => {
    const db = fakeDatabase({ roles: Object.fromEntries(cloudIamUsers().map((user) => [user, true])) });
    const { logger } = capturingLogger();
    const summary = await bootstrap({ target: 'cloud', env: cloudEnv(), config, logger, deps: db.deps });

    expect(summary).toMatchObject({ target: 'cloud', ok: true, roles: 36, iamGrants: 24, findings: [] });
    expect(summary.schemas.map((entry) => entry.schema)).toEqual(schemasInOrder.filter((schema) => schema !== 'stub'));
    expect(db.connections.map((connection) => connection.spec)).toEqual([
      { kind: 'admin' },
      { kind: 'iam', user: iamUser('db-bootstrap') },
    ]);
    expect(db.secretsRead).toEqual([]);
    const admin = db.texts('admin');
    const roles = admin.filter((text) => text.startsWith('CREATE ROLE'));
    expect(roles.every((text) => text.endsWith(' NOLOGIN NOSUPERUSER NOBYPASSRLS'))).toBe(true);
    expect(admin).toContain('CREATE SCHEMA IF NOT EXISTS "migration" AUTHORIZATION "migration_owner"');
    expect(admin).toContain(`GRANT "identity_app" TO "${iamUser('identity')}"`);
    expect(admin).toContain(`GRANT "content_app" TO "${iamUser('strategies-content')}"`);
    expect(admin).toContain(`GRANT "esignature_migrator" TO "${iamUser('db-bootstrap')}"`);
    expect(admin.some((text) => /stub|cloudsqlsuperuser|^DROP /.test(text))).toBe(false);
    expect(admin.findIndex((text) => text.startsWith('SELECT n.nspname'))).toBeLessThan(
      admin.findIndex((text) => text.startsWith('CREATE')),
    );
    const iam = db.texts(`iam:${iamUser('db-bootstrap')}`);
    expect(iam[0]).toBe('SET ROLE "identity_owner"');
    expect(iam.filter((text) => text === 'BEGIN')).toHaveLength(12);
    expect(db.closed()).toBe(1);
  });

  it('creates only the roles that do not exist yet', async () => {
    const existing = { ...Object.fromEntries(cloudIamUsers().map((user) => [user, true])), identity_owner: false, people_app: false };
    const db = fakeDatabase({ roles: existing });
    const { logger } = capturingLogger();
    const summary = await bootstrap({ target: 'cloud', env: cloudEnv(), config, logger, deps: db.deps });
    expect(summary.roles).toBe(34);
    expect(db.texts('admin').some((text) => /^CREATE ROLE "(identity_owner|people_app)"/.test(text))).toBe(false);
  });

  it('refuses schemas that already hold tables before any DDL', async () => {
    const db = fakeDatabase({ roles: Object.fromEntries(cloudIamUsers().map((user) => [user, true])), populated: ['people', 'gateway'] });
    const { logger } = capturingLogger();
    const thrown = await failure(bootstrap({ target: 'cloud', env: cloudEnv(), config, logger, deps: db.deps }));
    expect(thrown).toBeInstanceOf(SchemaNotEmptyError);
    expect((thrown as SchemaNotEmptyError).schemas).toEqual(['people', 'gateway']);
    expect(db.calls.some((call) => /^(CREATE|GRANT|SET )/.test(call.text))).toBe(false);
    expect(db.connections.every((connection) => connection.ended)).toBe(true);
  });

  it('lists the missing Cloud SQL IAM users before any DDL', async () => {
    const absent = [iamUser('finance'), iamUser('db-bootstrap')];
    const present = cloudIamUsers().filter((user) => !absent.includes(user));
    const db = fakeDatabase({ roles: Object.fromEntries(present.map((user) => [user, true])) });
    const { logger } = capturingLogger();
    const thrown = await failure(bootstrap({ target: 'cloud', env: cloudEnv(), config, logger, deps: db.deps }));
    expect(thrown).toBeInstanceOf(MissingIamUserError);
    expect((thrown as MissingIamUserError).users).toEqual(absent);
    expect(db.calls.some((call) => /^(CREATE|GRANT)/.test(call.text))).toBe(false);
  });

  it('builds the default Cloud SQL dependencies and closes them when planning fails', async () => {
    // A missing migration directory fails before any Cloud SQL connection is attempted.
    const owners = { ...config.owners, gateway: { ...config.owners.gateway, package: 'migration/test/no-such-package' } };
    const { logger } = capturingLogger();
    const thrown = await failure(
      bootstrap({ target: 'cloud', env: cloudEnv(), config: { ...config, owners } as MigrationConfig, logger }),
    );
    expect(thrown).toBeInstanceOf(MigrationDirectoryError);
  });
});

/** Replaces pg.Client with a double that records its settings and serves the `db` session its login names. */
function servePgClients(db: ReturnType<typeof fakeDatabase>, adminUser: string): pg.ClientConfig[] {
  const configs: pg.ClientConfig[] = [];
  vi.spyOn(pg, 'Client').mockImplementation(
    class {
      private session: ConnectedClient | undefined;

      constructor(private readonly config: pg.ClientConfig) {
        configs.push(config);
      }

      async connect(): Promise<void> {
        const { user = '', password } = this.config;
        const spec: ConnectSpec =
          user === adminUser ? { kind: 'admin' } : typeof password === 'string' ? { kind: 'role', user, password } : { kind: 'iam', user };
        this.session = await db.deps.connect(spec);
      }

      query(text: string, values?: unknown[]) {
        return this.session!.query(text, values);
      }

      end() {
        return this.session!.end();
      }
    } as unknown as typeof pg.Client,
  );
  return configs;
}

describe('default database sessions', () => {
  const sessionStateDir = (): string => path.join(tmp, 'session-state');
  const stream = vi.fn();
  const SET_TIME_ZONE = "SELECT set_config('TimeZone', $1, false)";
  const sessionOf = ({ spec }: { spec: ConnectSpec }): string => (spec.kind === 'admin' ? 'admin' : `${spec.kind}:${spec.user}`);

  beforeAll(async () => {
    await mkdir(path.join(sessionStateDir(), 'secrets'), { recursive: true });
    for (const [kind, file] of Object.entries(secretPathsFor(sessionStateDir(), 'stub'))) {
      await writeFile(file, `${secretFor('stub', kind)}\n`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each<{ target: BootstrapTarget; owner: OwnerName; env: () => BootstrapEnv; sessions: (env: BootstrapEnv) => pg.ClientConfig[] }>([
    {
      target: 'local',
      owner: 'stub',
      env: () => localEnv({ OPT2_STATE_DIR: sessionStateDir() }),
      sessions: ({ PG_PASSWORD }) => [
        { host: '127.0.0.1', port: 5432, database: 'opt2_test', user: 'admin_role', password: PG_PASSWORD },
        { host: '127.0.0.1', port: 5432, database: 'opt2_test', user: 'stub_migrator', password: secretFor('stub', 'migrator') },
      ],
    },
    {
      target: 'cloud',
      owner: 'people',
      env: cloudEnv,
      sessions: ({ OPT2_CLOUDSQL_ADMIN_PASSWORD }) => [
        { stream, user: config.cloud.adminUser, password: OPT2_CLOUDSQL_ADMIN_PASSWORD, database: 'opt2' },
        { stream, user: iamUser('db-bootstrap'), database: 'opt2' },
      ],
    },
  ])('sets the process zone as the TimeZone of every default $target session first', async ({ target, owner, env, sessions }) => {
    vi.stubEnv('TZ', 'America/New_York');
    vi.spyOn(Connector.prototype, 'getOptions').mockResolvedValue({ stream });
    const db = fakeDatabase({ roles: { [iamUser(owner)]: true, [iamUser('db-bootstrap')]: true } });
    const configs = servePgClients(db, target === 'local' ? 'admin_role' : config.cloud.adminUser);
    const bootstrapEnv = env();

    const summary = await bootstrap({
      target,
      env: bootstrapEnv,
      config: { ...config, owners: { [owner]: config.owners[owner] } } as unknown as MigrationConfig,
      logger: capturingLogger().logger,
    });

    expect(summary).toMatchObject({ target, ok: true, schemas: [{ owner }] });
    expect(configs).toEqual(sessions(bootstrapEnv));
    expect(configs.every((settings) => !('options' in settings))).toBe(true);
    const opened = db.connections.map(sessionOf);
    expect(opened.map((session) => db.calls.find((call) => call.session === session))).toEqual(
      opened.map((session) => ({ session, text: SET_TIME_ZONE, values: ['America/New_York'] })),
    );
    expect(db.calls.filter((call) => call.text === SET_TIME_ZONE)).toHaveLength(opened.length);
    expect(db.connections.every((connection) => connection.ended)).toBe(true);
  });

  it('ends a default session whose TimeZone cannot be set and fails the bootstrap with that error', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    const db = fakeDatabase({ failOn: /^SELECT set_config\('TimeZone'/ });
    servePgClients(db, 'admin_role');

    const thrown = await failure(
      bootstrap({
        target: 'local',
        env: localEnv({ OPT2_STATE_DIR: sessionStateDir() }),
        config: { ...config, owners: { stub: config.owners.stub } } as unknown as MigrationConfig,
        logger: capturingLogger().logger,
      }),
    );

    expect(thrown).toMatchObject({ message: 'statement rejected', code: '42000' });
    expect(db.connections).toEqual([{ spec: { kind: 'admin' }, ended: true }]);
    expect(db.calls.map((call) => call.text)).toEqual([SET_TIME_ZONE]);
  });
});

describe('environment checks', () => {
  it.each<{ target: BootstrapTarget; env: () => BootstrapEnv; missing: string[] }>([
    {
      target: 'local',
      env: () => loadBootstrapEnv({ OPT2_ENV: 'local', OPT2_STATE_DIR: stateDir }),
      missing: ['PG_HOST', 'PG_PORT', 'PG_DATABASE', 'PG_USER', 'PG_PASSWORD'],
    },
    { target: 'cloud', env: () => cloudEnv({ OPT2_CLOUDSQL_ADMIN_PASSWORD: '' }), missing: ['OPT2_CLOUDSQL_ADMIN_PASSWORD'] },
  ])('throws BootstrapEnvError naming the variables $target lacks, without values', async ({ target, env, missing }) => {
    const db = fakeDatabase();
    const { logger } = capturingLogger();
    const thrown = await failure(bootstrap({ target, env: env(), config, logger, deps: db.deps }));
    expect(thrown).toBeInstanceOf(BootstrapEnvError);
    expect((thrown as BootstrapEnvError).missing).toEqual(missing);
    expect((thrown as Error).message).toBe(`db-bootstrap needs ${missing.join(', ')}`);
    expect(db.connections).toHaveLength(0);
    expect(db.closed()).toBe(0);
  });
});
