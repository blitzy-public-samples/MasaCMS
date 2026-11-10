import type { Pool, QueryConfig, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { MetadataTx } from '../../src/tenancy/metadata.js';
import { tenantDbFromPool } from '../../src/tenancy/pool.js';
import {
  SITE_CHANGED_TOPIC,
  TenantMismatchError,
  contentPoolTenants,
  poolTenantFor,
  registeredTenants,
  registryEntryForTenant,
  siteForTenant,
  tenantForRegisteredSite,
  tenantRegistryConsumer,
  userPoolFanoutTenants,
  type PoolKind,
  type RegistrySource,
  type SiteChangedEvent,
  type SiteChangedPayload,
  type TenantRegistryEntry,
} from '../../src/tenancy/registry.js';
import { InvalidTenantIdError, tenantIdForSite } from '../../src/tenancy/tenant-id.js';
import type { TenantTx } from '../../src/tenancy/transaction.js';

const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const UMBRELLA = tenantIdForSite('umbrella');
const SET_TENANT = "SELECT set_config('app.tenant_id', $1, true)";
const TABLE = 'people.tenant_registry';
const UPDATED_AT = new Date('2026-01-02T03:04:05.678Z');
const POOL_NAMES = ['publicUserPoolId', 'privateUserPoolId', 'categoryPoolId', 'filePoolId', 'displayPoolId'] as const;
const COLUMNS = [
  'site_id',
  'tenant_id',
  'public_user_pool_id',
  'private_user_pool_id',
  'category_pool_id',
  'file_pool_id',
  'display_pool_id',
  'content_pool_ids',
  'public_user_pool_tenant',
  'private_user_pool_tenant',
  'category_pool_tenant',
  'file_pool_tenant',
  'display_pool_tenant',
  'content_pool_tenants',
  'domains',
  'aggregate_version',
  'updated_at',
];

const SQL = {
  registered: `SELECT tenant_id, site_id FROM ${TABLE} ORDER BY site_id`,
  entry: `SELECT ${COLUMNS.join(', ')} FROM ${TABLE} WHERE tenant_id = $1`,
  tenantForSite: `SELECT tenant_id FROM ${TABLE} WHERE lower(site_id) = lower($1)`,
  siteForTenant: `SELECT site_id FROM ${TABLE} WHERE tenant_id = $1`,
  contentPool: `SELECT content_pool_tenants FROM ${TABLE} WHERE tenant_id = $1`,
  fanout: `SELECT tenant_id FROM ${TABLE} WHERE public_user_pool_tenant = $1 OR private_user_pool_tenant = $1 ORDER BY site_id`,
  pool: (column: string): string => `SELECT ${column} AS pool_tenant FROM ${TABLE} WHERE tenant_id = $1`,
  upsert: [
    `INSERT INTO ${TABLE} (${COLUMNS.join(', ')})`,
    `VALUES (${COLUMNS.slice(0, -1)
      .map((_, index) => `$${String(index + 1)}`)
      .join(', ')}, LOCALTIMESTAMP(3))`,
    'ON CONFLICT (tenant_id) DO UPDATE SET',
    COLUMNS.filter((column) => column !== 'tenant_id')
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', '),
    `WHERE ${TABLE}.aggregate_version < EXCLUDED.aggregate_version`,
  ].join(' '),
};

const ROW_A = {
  site_id: 'tenant-a',
  tenant_id: TENANT_A,
  public_user_pool_id: 'umbrella',
  private_user_pool_id: 'tenant-a',
  category_pool_id: 'umbrella',
  file_pool_id: 'tenant-a',
  display_pool_id: 'tenant-a',
  content_pool_ids: ['tenant-a', 'umbrella'],
  public_user_pool_tenant: UMBRELLA,
  private_user_pool_tenant: TENANT_A,
  category_pool_tenant: UMBRELLA,
  file_pool_tenant: TENANT_A,
  display_pool_tenant: TENANT_A,
  content_pool_tenants: [TENANT_A, UMBRELLA],
  domains: ['tenant-a.example.test'],
  aggregate_version: '12',
  updated_at: UPDATED_AT,
};

type Row = Record<string, unknown>;
type Recorded = [text: string, values: unknown[] | undefined];

/** Structural stand-in for a pg PoolClient that records statements and answers each with the rows keyed on its SQL text. */
class FakeClient {
  readonly calls: Recorded[] = [];
  readonly releases: (Error | boolean | undefined)[] = [];
  readonly results: Map<string, Row[]>;

  constructor(results: Readonly<Record<string, Row[]>> = {}) {
    this.results = new Map(Object.entries(results));
  }

  query(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
    const sql = typeof text === 'string' ? text : text.text;
    this.calls.push([sql, values]);
    const rows = this.results.get(sql) ?? [];
    return Promise.resolve({ command: sql, rowCount: rows.length, oid: 0, fields: [], rows });
  }

  release(err?: Error | boolean): void {
    this.releases.push(err);
  }
}

/** A TenantDb over a fake pool whose every connection is one FakeClient answering `results`. */
function setup(results: Readonly<Record<string, Row[]>> = {}) {
  const client = new FakeClient(results);
  const connect = vi.fn(() => Promise.resolve(client));
  const db = tenantDbFromPool({ connect, on: vi.fn() } as unknown as Pool, { schema: 'people' });
  return { client, connect, db };
}

/** The statements a read issued, after asserting they ran in one committed metadata transaction. */
function metadataReads(client: FakeClient): Recorded[] {
  expect(client.calls.slice(0, 2)).toEqual([
    ['BEGIN', undefined],
    [SET_TENANT, ['']],
  ]);
  expect(client.calls.at(-1)).toEqual(['COMMIT', undefined]);
  expect(client.releases).toEqual([undefined]);
  return client.calls.slice(2, -1);
}

/** Transaction members shared by the open tenant and metadata transactions below. */
function txBase(client: FakeClient) {
  return {
    schema: 'people',
    query: (text: string | QueryConfig, values?: unknown[]) => client.query(text, values),
    onCommit: vi.fn(),
  };
}

/** An open tenant transaction over `client`. */
function tenantTx(client: FakeClient, tenantId = TENANT_A): TenantTx {
  return { ...txBase(client), kind: 'tenant', tenantId };
}

/** An open metadata transaction over `client`. */
function metadataTx(client: FakeClient): MetadataTx {
  return { ...txBase(client), kind: 'metadata' };
}

/** A site.changed envelope at version 3 carrying `payload`, in tenant-a unless overridden. */
function siteChanged(payload: unknown, overrides: Partial<SiteChangedEvent> = {}): SiteChangedEvent {
  return {
    eventId: '0f7c6a52-0c8e-4d8e-9a43-6a3c1d2b5e70',
    tenantId: TENANT_A,
    aggregateId: 'tenant-a',
    aggregateVersion: 3,
    payload: payload as SiteChangedPayload,
    ...overrides,
  };
}

/** Applies `event` in an open tenant transaction and returns the values of the single upsert it issued. */
async function upsertValues(event: SiteChangedEvent, tenantId = TENANT_A): Promise<unknown[] | undefined> {
  const client = new FakeClient();
  await tenantRegistryConsumer.apply(tenantTx(client, tenantId), event);
  expect(client.calls).toHaveLength(1);
  const [call] = client.calls;
  expect(call?.[0].replace(/\s+/g, ' ')).toBe(SQL.upsert);
  return call?.[1];
}

/** Upsert values for `siteId` whose five pool ids, content pool and domains are as given, at version 3. */
function expectedValues(siteId: string, pools: readonly string[], contentPool: readonly string[], domains: readonly string[] = []) {
  return [
    siteId,
    tenantIdForSite(siteId),
    ...pools,
    contentPool,
    ...pools.map((id) => tenantIdForSite(id)),
    contentPool.map((id) => tenantIdForSite(id)),
    domains,
    3,
  ];
}

/** The reason `promise` rejects with; fails when it fulfils. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

/** Applies `payload` in tenant-a and returns the rejection, asserting nothing was written. */
async function applyRejection(payload: unknown): Promise<unknown> {
  const client = new FakeClient();
  const err = await rejection(tenantRegistryConsumer.apply(tenantTx(client), siteChanged(payload)));
  expect(client.calls).toEqual([]);
  return err;
}

describe('TenantMismatchError', () => {
  it('carries both tenants and quotes the actual one in its message', () => {
    const err = new TenantMismatchError(TENANT_A, 'tenant "b"');

    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: 'TenantMismatchError', expected: TENANT_A, actual: 'tenant "b"' });
    expect(err.message).toBe(`Tenant mismatch: expected ${TENANT_A}, got "tenant \\"b\\""`);
  });
});

describe('registeredTenants', () => {
  it('lists every registered site and tenant in a metadata transaction', async () => {
    const h = setup({
      [SQL.registered]: [
        { tenant_id: TENANT_A, site_id: 'tenant-a' },
        { tenant_id: UMBRELLA, site_id: 'umbrella' },
      ],
    });

    await expect(registeredTenants(h.db)).resolves.toEqual([
      { tenantId: TENANT_A, siteId: 'tenant-a' },
      { tenantId: UMBRELLA, siteId: 'umbrella' },
    ]);
    expect(h.connect).toHaveBeenCalledOnce();
    expect(metadataReads(h.client)).toEqual([[SQL.registered, undefined]]);
  });

  it('returns an empty list for an empty registry', async () => {
    const h = setup();

    await expect(registeredTenants(h.db)).resolves.toEqual([]);
  });
});

describe('registryEntryForTenant', () => {
  it('maps the row of the lower-cased tenant to an entry with a numeric version', async () => {
    const h = setup({ [SQL.entry]: [ROW_A] });
    const expected: TenantRegistryEntry = {
      siteId: 'tenant-a',
      tenantId: TENANT_A,
      publicUserPoolId: 'umbrella',
      privateUserPoolId: 'tenant-a',
      categoryPoolId: 'umbrella',
      filePoolId: 'tenant-a',
      displayPoolId: 'tenant-a',
      contentPoolIds: ['tenant-a', 'umbrella'],
      publicUserPoolTenant: UMBRELLA,
      privateUserPoolTenant: TENANT_A,
      categoryPoolTenant: UMBRELLA,
      filePoolTenant: TENANT_A,
      displayPoolTenant: TENANT_A,
      contentPoolTenants: [TENANT_A, UMBRELLA],
      domains: ['tenant-a.example.test'],
      aggregateVersion: 12,
      updatedAt: UPDATED_AT,
    };

    await expect(registryEntryForTenant(h.db, TENANT_A.toUpperCase())).resolves.toStrictEqual(expected);
    expect(metadataReads(h.client)).toEqual([[SQL.entry, [TENANT_A]]]);
  });

  it('reads null pool columns as null and null array columns as empty lists', async () => {
    const h = setup({
      [SQL.entry]: [
        {
          ...ROW_A,
          public_user_pool_id: null,
          public_user_pool_tenant: null,
          content_pool_ids: null,
          content_pool_tenants: null,
          domains: null,
        },
      ],
    });

    await expect(registryEntryForTenant(h.db, TENANT_A)).resolves.toMatchObject({
      publicUserPoolId: null,
      publicUserPoolTenant: null,
      contentPoolIds: [],
      contentPoolTenants: [],
      domains: [],
    });
  });

  it('returns null for an unregistered tenant', async () => {
    const h = setup();

    await expect(registryEntryForTenant(h.db, TENANT_B)).resolves.toBeNull();
  });
});

describe('tenantForRegisteredSite', () => {
  it('passes the site id unchanged to a case-insensitive match', async () => {
    const h = setup({ [SQL.tenantForSite]: [{ tenant_id: TENANT_A }] });

    await expect(tenantForRegisteredSite(h.db, 'Tenant-A')).resolves.toBe(TENANT_A);
    expect(metadataReads(h.client)).toEqual([[SQL.tenantForSite, ['Tenant-A']]]);
  });

  it('returns null for an unregistered site', async () => {
    const h = setup();

    await expect(tenantForRegisteredSite(h.db, 'tenant-z')).resolves.toBeNull();
  });
});

describe('siteForTenant', () => {
  it('returns the site id of the lower-cased tenant', async () => {
    const h = setup({ [SQL.siteForTenant]: [{ site_id: 'tenant-a' }] });

    await expect(siteForTenant(h.db, TENANT_A.toUpperCase())).resolves.toBe('tenant-a');
    expect(metadataReads(h.client)).toEqual([[SQL.siteForTenant, [TENANT_A]]]);
  });

  it('returns null for an unregistered tenant', async () => {
    const h = setup();

    await expect(siteForTenant(h.db, TENANT_B)).resolves.toBeNull();
  });
});

describe('poolTenantFor', () => {
  it.each([
    ['publicUser', 'public_user_pool_tenant'],
    ['privateUser', 'private_user_pool_tenant'],
    ['category', 'category_pool_tenant'],
    ['file', 'file_pool_tenant'],
    ['display', 'display_pool_tenant'],
  ] as const)('reads the %s pool tenant from %s', async (kind, column) => {
    const h = setup({ [SQL.pool(column)]: [{ pool_tenant: UMBRELLA }] });

    await expect(poolTenantFor(h.db, TENANT_A.toUpperCase(), kind)).resolves.toBe(UMBRELLA);
    expect(metadataReads(h.client)).toEqual([[SQL.pool(column), [TENANT_A]]]);
  });

  it.each([
    ['a null pool column', [{ pool_tenant: null }]],
    ['an unregistered tenant', []],
  ])('returns null for %s', async (_label, rows) => {
    const h = setup({ [SQL.pool('public_user_pool_tenant')]: rows });

    await expect(poolTenantFor(h.db, TENANT_A, 'publicUser')).resolves.toBeNull();
  });

  it.each(['content', 'PublicUser', 'toString', '__proto__'])('rejects the unknown pool kind %j before connecting', async (kind) => {
    const h = setup();
    const err = await rejection(poolTenantFor(h.db, TENANT_A, kind as PoolKind));

    expect(err).toBeInstanceOf(TypeError);
    expect(err).toMatchObject({ message: `Unknown pool kind: ${JSON.stringify(kind)}` });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('checks the tenant id before the pool kind', async () => {
    const h = setup();

    await expect(poolTenantFor(h.db, 'tenant-a', 'content' as PoolKind)).rejects.toBeInstanceOf(InvalidTenantIdError);
  });
});

describe('contentPoolTenants', () => {
  it('returns the stored content pool tenants in order', async () => {
    const h = setup({ [SQL.contentPool]: [{ content_pool_tenants: [UMBRELLA, TENANT_B, TENANT_A] }] });

    await expect(contentPoolTenants(h.db, TENANT_A.toUpperCase())).resolves.toEqual([UMBRELLA, TENANT_B, TENANT_A]);
    expect(metadataReads(h.client)).toEqual([[SQL.contentPool, [TENANT_A]]]);
  });

  it.each([
    ['a null column', [{ content_pool_tenants: null }]],
    ['an unregistered tenant', []],
  ])('returns an empty list for %s', async (_label, rows) => {
    const h = setup({ [SQL.contentPool]: rows });

    await expect(contentPoolTenants(h.db, TENANT_A)).resolves.toEqual([]);
  });
});

describe('userPoolFanoutTenants', () => {
  it('puts the tenant first, then its user-pool members in site order, without repeats', async () => {
    const h = setup({ [SQL.fanout]: [{ tenant_id: TENANT_A }, { tenant_id: TENANT_B }, { tenant_id: UMBRELLA }] });

    await expect(userPoolFanoutTenants(h.db, UMBRELLA.toUpperCase())).resolves.toEqual([UMBRELLA, TENANT_A, TENANT_B]);
    expect(metadataReads(h.client)).toEqual([[SQL.fanout, [UMBRELLA]]]);
  });

  it('returns only the tenant when no site pools its users there', async () => {
    const h = setup();

    await expect(userPoolFanoutTenants(h.db, TENANT_B)).resolves.toEqual([TENANT_B]);
  });
});

describe('registry reads', () => {
  const TENANT_READERS: readonly (readonly [string, (db: RegistrySource) => Promise<unknown>])[] = [
    ['registryEntryForTenant', (db) => registryEntryForTenant(db, 'tenant-a')],
    ['siteForTenant', (db) => siteForTenant(db, 'tenant-a')],
    ['poolTenantFor', (db) => poolTenantFor(db, 'tenant-a', 'publicUser')],
    ['contentPoolTenants', (db) => contentPoolTenants(db, 'tenant-a')],
    ['userPoolFanoutTenants', (db) => userPoolFanoutTenants(db, 'tenant-a')],
  ];

  it.each(TENANT_READERS)('%s rejects a non-uuid tenant id before connecting', async (_name, readWith) => {
    const h = setup();

    await expect(readWith(h.db)).rejects.toBeInstanceOf(InvalidTenantIdError);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it.each([
    ['tenant', tenantTx],
    ['metadata', metadataTx],
  ] as const)('run on an open %s transaction without opening another', async (_kind, open) => {
    const h = setup();
    const client = new FakeClient({ [SQL.siteForTenant]: [{ site_id: 'tenant-b' }] });

    await expect(siteForTenant(open(client), TENANT_B)).resolves.toBe('tenant-b');
    expect(client.calls).toEqual([[SQL.siteForTenant, [TENANT_B]]]);
    expect(h.connect).not.toHaveBeenCalled();
  });
});

describe('tenantRegistryConsumer', () => {
  it('consumes the site.changed state topic', () => {
    expect(SITE_CHANGED_TOPIC).toBe('programs-sites.site.changed.v1');
    expect(tenantRegistryConsumer).toMatchObject({ topic: SITE_CHANGED_TOPIC, kind: 'state' });
  });

  it('upserts the site, its pool ids and their tenants at the event version unless stored newer', async () => {
    const values = await upsertValues(
      siteChanged(
        {
          siteId: 'tenant-a',
          publicUserPoolId: 'umbrella',
          privateUserPoolId: 'tenant-a',
          categoryPoolId: 'umbrella',
          filePoolId: 'tenant-b',
          displayPoolId: 'tenant-a',
          contentPoolIds: ['tenant-a', 'umbrella'],
          domains: ['tenant-a.example.test'],
        },
        { aggregateVersion: 7 },
      ),
    );

    expect(values).toEqual([
      'tenant-a',
      TENANT_A,
      'umbrella',
      'tenant-a',
      'umbrella',
      'tenant-b',
      'tenant-a',
      ['tenant-a', 'umbrella'],
      UMBRELLA,
      TENANT_A,
      UMBRELLA,
      TENANT_B,
      TENANT_A,
      [TENANT_A, UMBRELLA],
      ['tenant-a.example.test'],
      7,
    ]);
  });

  it('writes inside the tenant transaction it is given', async () => {
    const h = setup();

    await h.db.withTenant(TENANT_A, (tx) => tenantRegistryConsumer.apply(tx, siteChanged({ siteId: 'tenant-a' })));
    expect(h.client.calls.map(([text, values]) => [text.replace(/\s+/g, ' '), values])).toEqual([
      ['BEGIN', undefined],
      [SET_TENANT, [TENANT_A]],
      [SQL.upsert, expectedValues('tenant-a', Array<string>(5).fill('tenant-a'), ['tenant-a'])],
      ['COMMIT', undefined],
    ]);
    expect(h.client.releases).toEqual([undefined]);
  });

  it('reads legacy-cased keys and keeps the site id casing', async () => {
    const values = await upsertValues(
      siteChanged({
        siteID: 'Tenant-A',
        PublicUserPoolID: 'umbrella',
        PRIVATEUSERPOOLID: 'Tenant-A',
        categorypoolid: 'umbrella',
        FilePoolID: '',
        displayPoolID: null,
        contentPoolID: 'tenant-a,umbrella',
        DOMAINS: ['tenant-a.example.test'],
      }),
    );

    expect(values).toEqual(
      expectedValues(
        'Tenant-A',
        ['umbrella', 'Tenant-A', 'umbrella', 'Tenant-A', 'Tenant-A'],
        ['tenant-a', 'umbrella'],
        ['tenant-a.example.test'],
      ),
    );
    expect(values?.[1]).toBe(TENANT_A);
  });

  it('prefers the exact key over other casings and contentPoolIds over contentPoolId', async () => {
    const values = await upsertValues(
      siteChanged({
        SITEID: 'tenant-b',
        siteId: 'tenant-a',
        PublicUserPoolId: 'tenant-b',
        publicUserPoolId: 'umbrella',
        contentPoolID: 'tenant-b',
        contentPoolIds: ['umbrella'],
      }),
    );

    expect(values).toEqual(expectedValues('tenant-a', ['umbrella', 'tenant-a', 'tenant-a', 'tenant-a', 'tenant-a'], ['umbrella']));
  });

  it.each([
    ['absent', {}],
    ['undefined', Object.fromEntries(POOL_NAMES.map((name) => [name, undefined]))],
    ['null', Object.fromEntries(POOL_NAMES.map((name) => [name, null]))],
    ['empty', Object.fromEntries(POOL_NAMES.map((name) => [name, '']))],
  ])('defaults pool ids that are %s to the site id', async (_label, pools) => {
    const values = await upsertValues(siteChanged({ siteId: 'tenant-a', ...pools }));

    expect(values).toEqual(expectedValues('tenant-a', Array<string>(5).fill('tenant-a'), ['tenant-a']));
  });

  it('keeps a whitespace pool id rather than defaulting it', async () => {
    const values = await upsertValues(siteChanged({ siteId: 'tenant-a', publicUserPoolId: ' ' }));

    expect(values).toEqual(expectedValues('tenant-a', [' ', 'tenant-a', 'tenant-a', 'tenant-a', 'tenant-a'], ['tenant-a']));
  });

  it.each(POOL_NAMES)('rejects a non-string %s without writing', async (name) => {
    const err = await applyRejection({ siteId: 'tenant-a', [name]: 42 });

    expect(err).toBeInstanceOf(TypeError);
    expect(err).toMatchObject({ message: `${name} must be a string` });
  });

  it('trims, drops empty and case-insensitively de-duplicates a content pool list, keeping first casing', async () => {
    const values = await upsertValues(
      siteChanged({ siteId: 'tenant-a', contentPoolIds: [' tenant-a ', 'Umbrella', 'umbrella', '', '  ', 'TENANT-A', 'tenant-b'] }),
    );

    expect(values?.[7]).toEqual(['tenant-a', 'Umbrella', 'tenant-b']);
    expect(values?.[13]).toEqual([TENANT_A, UMBRELLA, TENANT_B]);
  });

  it('splits comma-separated content pool text without adding the site itself', async () => {
    const values = await upsertValues(siteChanged({ siteId: 'tenant-a', contentPoolIds: 'umbrella, Tenant-B ,,UMBRELLA' }));

    expect(values?.[7]).toEqual(['umbrella', 'Tenant-B']);
    expect(values?.[13]).toEqual([UMBRELLA, TENANT_B]);
  });

  it.each([[[]], [''], [' , '], [null], [[' ', '']]])('defaults the empty content pool %j to the site', async (contentPoolIds) => {
    const values = await upsertValues(siteChanged({ siteId: 'tenant-a', contentPoolIds }));

    expect(values?.[7]).toEqual(['tenant-a']);
    expect(values?.[13]).toEqual([TENANT_A]);
  });

  it.each([
    ['a list holding a number', ['tenant-a', 7]],
    ['a number', 7],
    ['an object', { siteId: 'umbrella' }],
  ])('rejects a content pool that is %s without writing', async (_label, contentPoolIds) => {
    const err = await applyRejection({ siteId: 'tenant-a', contentPoolIds });

    expect(err).toBeInstanceOf(TypeError);
    expect(err).toMatchObject({ message: 'contentPoolIds must hold strings' });
  });

  it.each([
    ['a list', ['tenant-a.example.test', 7, null, 'www.tenant-a.example.test'], ['tenant-a.example.test', 'www.tenant-a.example.test']],
    ['a string', 'tenant-a.example.test', []],
  ])('keeps only the string domains of %s', async (_label, domains, expected) => {
    const values = await upsertValues(siteChanged({ siteId: 'tenant-a', domains }));

    expect(values?.[14]).toEqual(expected);
  });

  it.each([
    ['missing', {}],
    ['empty', { siteId: '' }],
    ['a number', { siteId: 7 }],
    ['absent from a null payload', null],
    ['absent from a string payload', 'tenant-a'],
  ])('rejects a payload whose siteId is %s without writing', async (_label, payload) => {
    const err = await applyRejection(payload);

    expect(err).toBeInstanceOf(TypeError);
    expect(err).toMatchObject({ message: 'site.changed payload siteId must be a non-empty string' });
  });

  it('accepts an upper-cased event tenant', async () => {
    const values = await upsertValues(siteChanged({ siteId: 'tenant-a' }, { tenantId: TENANT_A.toUpperCase() }));

    expect(values?.[1]).toBe(TENANT_A);
  });

  it.each([
    { side: 'event', eventTenant: TENANT_B, txTenant: TENANT_A, actual: TENANT_B },
    { side: 'event', eventTenant: 'tenant-a', txTenant: TENANT_A, actual: 'tenant-a' },
    { side: 'transaction', eventTenant: TENANT_A, txTenant: TENANT_B, actual: TENANT_B },
  ])('rejects a mismatched $side tenant $actual without writing', async ({ eventTenant, txTenant, actual }) => {
    const client = new FakeClient();
    const err = await rejection(
      tenantRegistryConsumer.apply(tenantTx(client, txTenant), siteChanged({ siteId: 'tenant-a' }, { tenantId: eventTenant })),
    );

    expect(err).toBeInstanceOf(TenantMismatchError);
    expect(err).toMatchObject({ expected: TENANT_A, actual });
    expect(client.calls).toEqual([]);
  });
});
