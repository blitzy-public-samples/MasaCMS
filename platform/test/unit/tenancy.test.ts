import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as tenancy from '../../src/tenancy/index.js';
import {
  InvalidTenantIdError,
  NON_TENANT_TABLES,
  createPool,
  hasGrant,
  iamDbUser,
  isNonTenantTable,
  tenantDbFromPool,
  tenantIdForSite,
  withMetadata,
  withTenant,
  writeGrant,
  type DbEnv,
  type Pool,
  type QueryConfig,
  type TenantDb,
  type TenantTx,
  type TxBase,
} from '../../src/tenancy/index.js';

type Recorded = [text: string, values: unknown[] | undefined];

const doubles = vi.hoisted(() => {
  /** Structural pg PoolClient that records every statement and release. */
  class FakeClient {
    readonly calls: Recorded[] = [];
    readonly releases: unknown[] = [];
    /** Rejection values keyed by statement text. */
    readonly failures = new Map<string, unknown>();
    rows: Record<string, unknown>[] = [];

    query(text: string | QueryConfig, values?: unknown[]) {
      const sql = typeof text === 'string' ? text : text.text;
      this.calls.push([sql, values]);
      if (this.failures.has(sql)) {
        return Promise.reject(this.failures.get(sql));
      }
      return Promise.resolve({ command: sql, rowCount: this.rows.length, oid: 0, fields: [], rows: this.rows });
    }

    release(err?: unknown): void {
      this.releases.push(err);
    }
  }

  /** Structural pg Pool, also installed as pg's Pool constructor; records its options, listeners and end. */
  class FakePool {
    static readonly created: FakePool[] = [];
    readonly options: Record<string, unknown> | undefined;
    readonly client = new FakeClient();
    readonly listeners = new Map<string, unknown>();
    readonly events: string[] = [];
    connects = 0;
    endError: unknown = undefined;

    constructor(options?: Record<string, unknown>) {
      this.options = options;
      FakePool.created.push(this);
    }

    connect(): Promise<FakeClient> {
      this.connects += 1;
      return Promise.resolve(this.client);
    }

    on(event: string, listener: unknown): this {
      this.listeners.set(event, listener);
      return this;
    }

    end(): Promise<void> {
      this.events.push('pool.end');
      return this.endError === undefined ? Promise.resolve() : Promise.reject(this.endError);
    }
  }

  const cloud = {
    connectors: 0,
    getOptions: vi.fn<(opts: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
    close: vi.fn<() => void>(),
    getCredentials: vi.fn<() => Promise<{ client_email?: string }>>(),
  };

  class FakeConnector {
    readonly getOptions = cloud.getOptions;
    readonly close = cloud.close;

    constructor() {
      cloud.connectors += 1;
    }
  }

  class FakeGoogleAuth {
    readonly getCredentials = cloud.getCredentials;
  }

  return { FakePool, FakeConnector, FakeGoogleAuth, cloud };
});

vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { ...actual, default: { ...actual.default, Pool: doubles.FakePool } };
});

vi.mock('@google-cloud/cloud-sql-connector', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, Connector: doubles.FakeConnector };
});

vi.mock('google-auth-library', () => ({ GoogleAuth: doubles.FakeGoogleAuth }));

const { FakePool, cloud } = doubles;
type FakePoolInstance = InstanceType<typeof FakePool>;

const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const SET_TENANT = "SELECT set_config('app.tenant_id', $1, true)";
const INSERT_GRANT =
  'INSERT INTO people.tenant_grant (grantor_tenant, grantee_tenant, kind, resource_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING';
const SELECT_GRANT =
  'SELECT 1 FROM people.tenant_grant WHERE grantor_tenant = $1 AND grantee_tenant = $2 AND kind = $3 AND resource_id = $4';
const GRANT = { grantee: TENANT_B, kind: 'survey-response', resourceId: 'S1' };
const GRANT_KEY = { grantor: TENANT_A, ...GRANT };

const PASSWORD_ENV: DbEnv = {
  OPT2_DB_AUTH: 'password',
  PG_HOST: '127.0.0.1',
  PG_DATABASE: 'masa_services',
  PG_USER: 'people_app',
  PG_PASSWORD: 'local-test-only',
};
const IAM_ENV: DbEnv = { OPT2_DB_AUTH: 'iam', PG_DATABASE: 'masa_services', CLOUD_SQL_INSTANCE: 'proj:region:opt2' };
const SERVICE_ACCOUNT = 'opt2-people@proj.iam.gserviceaccount.com';
const IAM_USER = 'opt2-people@proj.iam';
const stream = (): void => undefined;

const asPool = (pool: FakePoolInstance): Pool => pool as unknown as Pool;

function fakeDb(): { pool: FakePoolInstance; db: TenantDb } {
  const pool = new FakePool();
  return { pool, db: tenantDbFromPool(asPool(pool), { schema: 'people' }) };
}

/** The pool createPool opened last; fails the test when it opened none. */
function lastPool(): FakePoolInstance {
  const pool = FakePool.created.at(-1);
  if (pool === undefined) {
    throw new Error('expected createPool to open a pg pool');
  }
  return pool;
}

const statements = (pool: FakePoolInstance): string[] => pool.client.calls.map(([text]) => text);

beforeEach(() => {
  FakePool.created.length = 0;
  cloud.connectors = 0;
  cloud.getOptions.mockReset();
  cloud.close.mockReset();
  cloud.getCredentials.mockReset();
});

// Tenant-id values, RLS DDL text, commit callbacks, transaction context and the registry consumer have their cases in
// tenant-id, rls, tenancy-transaction and tenant-registry tests; this suite covers the barrel and the paths they do not reach.
describe('tenancy subpath', () => {
  it('exports exactly the runtime members of @opt2/platform/tenancy', () => {
    expect(Object.keys(tenancy).sort()).toEqual(
      [
        'TENANT_NAMESPACE',
        'SYSTEM_TENANT_ID',
        'tenantIdForSite',
        'isTenantId',
        'assertTenantId',
        'InvalidTenantIdError',
        'TENANT_SETTING',
        'RLS_POLICY_NAME',
        'rlsSql',
        'tenantRegistrySql',
        'tenantGrantSql',
        'withTenant',
        'currentTransaction',
        'currentTenantTx',
        'requireTenantTx',
        'OutsideTenantTransactionError',
        'TransactionEndedError',
        'TransactionRolledBackError',
        'withMetadata',
        'NON_TENANT_TABLES',
        'isNonTenantTable',
        'createPool',
        'tenantDbFromPool',
        'iamDbUser',
        'registeredTenants',
        'registryEntryForTenant',
        'tenantForRegisteredSite',
        'siteForTenant',
        'poolTenantFor',
        'contentPoolTenants',
        'userPoolFanoutTenants',
        'tenantRegistryConsumer',
        'SITE_CHANGED_TOPIC',
        'TenantMismatchError',
        'writeGrant',
        'hasGrant',
      ].sort(),
    );
  });
});

describe('tenantDbFromPool', () => {
  const TRANSACTIONS: readonly (readonly [string, (db: TenantDb) => Promise<TxBase>, string, Record<string, unknown>])[] = [
    [
      'withTenant',
      (db) =>
        withTenant(db, TENANT_A, async (tx) => {
          await tx.query('SELECT 1');
          return tx;
        }),
      TENANT_A,
      { kind: 'tenant', tenantId: TENANT_A },
    ],
    [
      'withMetadata',
      (db) =>
        withMetadata(db, async (tx) => {
          await tx.query('SELECT 1');
          return tx;
        }),
      '',
      { kind: 'metadata' },
    ],
  ];

  it.each(TRANSACTIONS)('runs %s on one connection: BEGIN, app.tenant_id, the work, COMMIT, release', async (_name, run, setting, handle) => {
    const { pool, db } = fakeDb();

    const tx = await run(db);

    expect(tx).toMatchObject({ ...handle, schema: 'people' });
    expect(pool.connects).toBe(1);
    expect(pool.client.calls).toEqual([
      ['BEGIN', undefined],
      [SET_TENANT, [setting]],
      ['SELECT 1', undefined],
      ['COMMIT', undefined],
    ]);
    expect(pool.client.releases).toEqual([undefined]);
  });

  it('rethrows the callback error and destroys the connection when ROLLBACK fails with a non-Error value', async () => {
    const { pool, db } = fakeDb();
    const failure = new Error('boom');
    pool.client.failures.set('ROLLBACK', 'connection reset');

    await expect(withTenant(db, TENANT_A, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(statements(pool)).toEqual(['BEGIN', SET_TENANT, 'ROLLBACK']);
    expect(pool.client.releases).toEqual([new Error('connection reset')]);
  });

  it('returns a frozen handle for the schema that listens for idle-client errors', () => {
    const pool = new FakePool();

    const db = tenantDbFromPool(asPool(pool), { schema: 'programs_sites' });

    expect(db.schema).toBe('programs_sites');
    expect(Object.isFrozen(db)).toBe(true);
    expect(pool.listeners.get('error')).toEqual(expect.any(Function));
  });

  it.each(['programs-sites', 'People', 'people.person', ''])('rejects the schema %j before touching the pool', (schema) => {
    const pool = new FakePool();

    expect(() => tenantDbFromPool(asPool(pool), { schema })).toThrow(TypeError);
    expect(pool.listeners.size).toBe(0);
  });

  it.each([
    ['resolves', undefined],
    ['rejects', new Error('pool end failed')],
  ])('end runs onEnd after the pool end %s', async (_label, endError) => {
    const pool = new FakePool();
    pool.endError = endError;
    const db = tenantDbFromPool(asPool(pool), {
      schema: 'people',
      onEnd: () => {
        pool.events.push('onEnd');
      },
    });

    const ending = db.end();

    await (endError === undefined ? expect(ending).resolves.toBeUndefined() : expect(ending).rejects.toBe(endError));
    expect(pool.events).toEqual(['pool.end', 'onEnd']);
  });
});

describe('createPool with password authentication', () => {
  it.each([
    [undefined, 5432],
    ['6543', 6543],
  ])('opens a pg pool on PG_PORT %j as port %i and runs tenant transactions on it', async (port, expectedPort) => {
    const db = await createPool({ env: { ...PASSWORD_ENV, PG_PORT: port }, schema: 'people', max: 4, applicationName: 'people' });
    const pool = lastPool();

    expect(pool.options).toEqual({
      host: '127.0.0.1',
      port: expectedPort,
      database: 'masa_services',
      user: 'people_app',
      password: 'local-test-only',
      max: 4,
      application_name: 'people',
    });
    await withTenant(db, TENANT_A, (tx) => tx.query('SELECT 1'));
    expect(pool.client.calls[1]).toEqual([SET_TENANT, [TENANT_A]]);
    await db.end();
    expect(pool.events).toEqual(['pool.end']);
  });

  it.each([
    [{ PG_HOST: undefined, PG_USER: undefined, PG_PASSWORD: undefined }, 'PG_HOST, PG_USER, PG_PASSWORD'],
    [{ PG_PASSWORD: '' }, 'PG_PASSWORD'],
  ])('refuses the settings %j without opening a pool', async (override, missing) => {
    await expect(createPool({ env: { ...PASSWORD_ENV, ...override }, schema: 'people' })).rejects.toThrow(
      `OPT2_DB_AUTH=password requires ${missing}`,
    );
    expect(FakePool.created).toHaveLength(0);
  });

  it('rejects an invalid schema without opening a pool', async () => {
    await expect(createPool({ env: PASSWORD_ENV, schema: 'programs-sites' })).rejects.toThrow(TypeError);
    expect(FakePool.created).toHaveLength(0);
  });
});

describe('createPool with Cloud SQL IAM authentication', () => {
  it('requires CLOUD_SQL_INSTANCE before creating a connector', async () => {
    await expect(createPool({ env: { ...IAM_ENV, CLOUD_SQL_INSTANCE: undefined }, schema: 'people' })).rejects.toThrow(
      'OPT2_DB_AUTH=iam requires CLOUD_SQL_INSTANCE',
    );
    expect(cloud.connectors).toBe(0);
  });

  it.each([
    ['PG_USER', IAM_USER, 0],
    ['the service-account email of the Google credentials', undefined, 1],
  ])('connects over private IP with IAM tokens as %s and closes the connector on end', async (_label, pgUser, credentialReads) => {
    cloud.getOptions.mockResolvedValue({ stream });
    cloud.getCredentials.mockResolvedValue({ client_email: SERVICE_ACCOUNT });

    const db = await createPool({ env: { ...IAM_ENV, PG_USER: pgUser }, schema: 'people', max: 3, applicationName: 'people' });
    const pool = lastPool();

    expect(cloud.getOptions).toHaveBeenCalledExactlyOnceWith({
      instanceConnectionName: 'proj:region:opt2',
      authType: 'IAM',
      ipType: 'PRIVATE',
    });
    expect(cloud.getCredentials).toHaveBeenCalledTimes(credentialReads);
    expect(pool.options).toEqual({ stream, user: IAM_USER, database: 'masa_services', max: 3, application_name: 'people' });
    expect(pool.options).not.toHaveProperty('password');
    expect(cloud.close).not.toHaveBeenCalled();
    await db.end();
    expect(pool.events).toEqual(['pool.end']);
    expect(cloud.close).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'the connector cannot provide connection options',
      (): void => {
        cloud.getOptions.mockRejectedValue(new Error('instance not found'));
      },
      'instance not found',
    ],
    [
      'the Google credentials carry no service-account email',
      (): void => {
        cloud.getOptions.mockResolvedValue({ stream });
        cloud.getCredentials.mockResolvedValue({});
      },
      'OPT2_DB_AUTH=iam without PG_USER needs a service-account email from Google credentials',
    ],
  ])('closes the connector and opens no pool when %s', async (_label, arrange, message) => {
    arrange();

    await expect(createPool({ env: IAM_ENV, schema: 'people' })).rejects.toThrow(message);
    expect(cloud.close).toHaveBeenCalledOnce();
    expect(FakePool.created).toHaveLength(0);
  });
});

describe('iamDbUser', () => {
  it.each([
    [SERVICE_ACCOUNT, IAM_USER],
    [IAM_USER, IAM_USER],
    ['people_app', 'people_app'],
  ])('maps %s to the database user %s', (email, user) => {
    expect(iamDbUser(email)).toBe(user);
  });
});

describe('non-tenant tables', () => {
  it('lists exactly the tenant-metadata tables', () => {
    expect(NON_TENANT_TABLES).toEqual(['tenant_registry', 'tenant_grant', 'unit_gate', 'open_operation', 'migration_watermark']);
  });

  it.each(NON_TENANT_TABLES)('treats %s as a non-tenant table', (table) => {
    expect(isNonTenantTable(table)).toBe(true);
  });

  it.each(['person', 'outbox', 'inbox', 'changelog', 'Tenant_Registry', 'people.tenant_registry', ''])(
    'treats %j as tenant-owned',
    (table) => {
      expect(isNonTenantTable(table)).toBe(false);
    },
  );
});

describe('writeGrant', () => {
  it("inserts the grant inside the grantor's transaction with the grantor taken from the transaction", async () => {
    const { pool, db } = fakeDb();

    await withTenant(db, TENANT_A, (tx) => writeGrant(tx, { ...GRANT, grantee: TENANT_B.toUpperCase() }));

    expect(pool.client.calls).toEqual([
      ['BEGIN', undefined],
      [SET_TENANT, [TENANT_A]],
      [INSERT_GRANT, [TENANT_A, TENANT_B, 'survey-response', 'S1']],
      ['COMMIT', undefined],
    ]);
  });

  const REFUSALS: readonly (readonly [string, (db: TenantDb) => Promise<void>, new (...args: never[]) => Error, string])[] = [
    ['in a metadata transaction', (db) => withMetadata(db, (tx) => writeGrant(tx as unknown as TenantTx, GRANT)), TypeError, ''],
    [
      'to a non-uuid grantee',
      (db) => withTenant(db, TENANT_A, (tx) => writeGrant(tx, { ...GRANT, grantee: 'tenant-b' })),
      InvalidTenantIdError,
      TENANT_A,
    ],
  ];

  it.each(REFUSALS)('refuses a grant %s without writing', async (_label, run, errorType, setting) => {
    const { pool, db } = fakeDb();

    await expect(run(db)).rejects.toBeInstanceOf(errorType);
    expect(pool.client.calls).toEqual([
      ['BEGIN', undefined],
      [SET_TENANT, [setting]],
      ['ROLLBACK', undefined],
    ]);
  });
});

describe('hasGrant', () => {
  it.each([
    [[{ '?column?': 1 }], true],
    [[], false],
  ])('reads the rows %j as %s in a metadata transaction of the TenantDb', async (rows, expected) => {
    const { pool, db } = fakeDb();
    pool.client.rows = rows;

    await expect(hasGrant(db, { ...GRANT_KEY, grantor: TENANT_A.toUpperCase() })).resolves.toBe(expected);
    expect(pool.client.calls).toEqual([
      ['BEGIN', undefined],
      [SET_TENANT, ['']],
      [SELECT_GRANT, [TENANT_A, TENANT_B, 'survey-response', 'S1']],
      ['COMMIT', undefined],
    ]);
  });

  it('reads inside an open transaction on its own connection', async () => {
    const { pool, db } = fakeDb();
    pool.client.rows = [{ '?column?': 1 }];

    await expect(withTenant(db, TENANT_B, (tx) => hasGrant(tx, GRANT_KEY))).resolves.toBe(true);
    expect(pool.connects).toBe(1);
    expect(statements(pool)).toEqual(['BEGIN', SET_TENANT, SELECT_GRANT, 'COMMIT']);
  });

  it.each(['grantor', 'grantee'] as const)('rejects a non-uuid %s before connecting', async (field) => {
    const { pool, db } = fakeDb();

    await expect(hasGrant(db, { ...GRANT_KEY, [field]: 'tenant-a' })).rejects.toBeInstanceOf(InvalidTenantIdError);
    expect(pool.connects).toBe(0);
  });
});

