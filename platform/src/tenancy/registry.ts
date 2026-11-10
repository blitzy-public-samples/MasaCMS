import { assertTenantId, tenantIdForSite } from './tenant-id.js';
import type { Queryable, TenantDb, TenantTx } from './transaction.js';
import type { MetadataTx } from './metadata.js';

/** A site pool whose tenant the registry resolves. */
export type PoolKind = 'publicUser' | 'privateUser' | 'category' | 'file' | 'display';

/** One site of `<schema>.tenant_registry`, the event-fed site projection. */
export interface TenantRegistryEntry {
  siteId: string;
  tenantId: string;
  publicUserPoolId: string | null;
  privateUserPoolId: string | null;
  categoryPoolId: string | null;
  filePoolId: string | null;
  displayPoolId: string | null;
  contentPoolIds: string[];
  publicUserPoolTenant: string | null;
  privateUserPoolTenant: string | null;
  categoryPoolTenant: string | null;
  filePoolTenant: string | null;
  displayPoolTenant: string | null;
  contentPoolTenants: string[];
  domains: string[];
  aggregateVersion: number;
  updatedAt: Date;
}

/** A database handle, or an already open transaction, that registry reads run on. */
export type RegistrySource = TenantDb | TenantTx | MetadataTx;

/** Topic whose consumer is the only writer of `tenant_registry`. */
export const SITE_CHANGED_TOPIC = 'programs-sites.site.changed.v1';

/** Full site state carried by `programs-sites.site.changed.v1`; keys are also accepted in legacy casing. */
export interface SiteChangedPayload {
  siteId: string;
  publicUserPoolId?: string | null;
  privateUserPoolId?: string | null;
  categoryPoolId?: string | null;
  filePoolId?: string | null;
  displayPoolId?: string | null;
  /** An array, or Masa's comma-separated `contentPoolID` text. */
  contentPoolIds?: string[] | string | null;
  domains?: string[] | null;
}

/** The envelope fields the registry consumer reads. */
export interface SiteChangedEvent {
  eventId?: string;
  tenantId: string;
  aggregateId?: string;
  aggregateVersion: number;
  payload: SiteChangedPayload;
}

/** Raised when an event's tenant is not the tenant of the site it describes. */
export class TenantMismatchError extends Error {
  override readonly name = 'TenantMismatchError';
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`Tenant mismatch: expected ${expected}, got ${JSON.stringify(actual)}`);
    this.expected = expected;
    this.actual = actual;
  }
}

type RegistryReader = Queryable & { readonly schema: string };

type RegistryRow = {
  site_id: string;
  tenant_id: string;
  public_user_pool_id: string | null;
  private_user_pool_id: string | null;
  category_pool_id: string | null;
  file_pool_id: string | null;
  display_pool_id: string | null;
  content_pool_ids: string[] | null;
  public_user_pool_tenant: string | null;
  private_user_pool_tenant: string | null;
  category_pool_tenant: string | null;
  file_pool_tenant: string | null;
  display_pool_tenant: string | null;
  content_pool_tenants: string[] | null;
  domains: string[] | null;
  aggregate_version: string;
  updated_at: Date;
};

// Fixed column names, so no caller string ever reaches the SQL text.
const POOL_TENANT_COLUMNS: Readonly<Record<PoolKind, string>> = Object.freeze({
  publicUser: 'public_user_pool_tenant',
  privateUser: 'private_user_pool_tenant',
  category: 'category_pool_tenant',
  file: 'file_pool_tenant',
  display: 'display_pool_tenant',
});

const ENTRY_COLUMNS = [
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
].join(', ');

function registryTable(reader: RegistryReader): string {
  return `${reader.schema}.tenant_registry`;
}

// A TenantDb gets a short metadata transaction; an open transaction is reused, so no second connection is taken.
function read<T>(source: RegistrySource, fn: (reader: RegistryReader) => Promise<T>): Promise<T> {
  return 'withMetadata' in source ? source.withMetadata((tx) => fn(tx)) : fn(source);
}

function toEntry(row: RegistryRow): TenantRegistryEntry {
  return {
    siteId: row.site_id,
    tenantId: row.tenant_id,
    publicUserPoolId: row.public_user_pool_id,
    privateUserPoolId: row.private_user_pool_id,
    categoryPoolId: row.category_pool_id,
    filePoolId: row.file_pool_id,
    displayPoolId: row.display_pool_id,
    contentPoolIds: row.content_pool_ids ?? [],
    publicUserPoolTenant: row.public_user_pool_tenant,
    privateUserPoolTenant: row.private_user_pool_tenant,
    categoryPoolTenant: row.category_pool_tenant,
    filePoolTenant: row.file_pool_tenant,
    displayPoolTenant: row.display_pool_tenant,
    contentPoolTenants: row.content_pool_tenants ?? [],
    domains: row.domains ?? [],
    aggregateVersion: Number(row.aggregate_version),
    updatedAt: row.updated_at,
  };
}

/** Every registered site and its tenant, ordered by site id. */
export async function registeredTenants(db: RegistrySource): Promise<Array<{ tenantId: string; siteId: string }>> {
  return read(db, async (reader) => {
    const { rows } = await reader.query<{ tenant_id: string; site_id: string }>(
      `SELECT tenant_id, site_id FROM ${registryTable(reader)} ORDER BY site_id`,
    );
    return rows.map((row) => ({ tenantId: row.tenant_id, siteId: row.site_id }));
  });
}

/** The registry entry of `tenantId`, or null when the tenant is unregistered. */
export async function registryEntryForTenant(db: RegistrySource, tenantId: string): Promise<TenantRegistryEntry | null> {
  const tid = assertTenantId(tenantId);
  return read(db, async (reader) => {
    const { rows } = await reader.query<RegistryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM ${registryTable(reader)} WHERE tenant_id = $1`,
      [tid],
    );
    const row = rows[0];
    return row === undefined ? null : toEntry(row);
  });
}

/** The tenant of a registered legacy site id, matched case-insensitively; null when the site is unregistered. */
export async function tenantForRegisteredSite(db: RegistrySource, siteId: string): Promise<string | null> {
  return read(db, async (reader) => {
    const { rows } = await reader.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM ${registryTable(reader)} WHERE lower(site_id) = lower($1)`,
      [siteId],
    );
    return rows[0]?.tenant_id ?? null;
  });
}

/** The legacy site id of `tenantId`, or null when the tenant is unregistered. */
export async function siteForTenant(db: RegistrySource, tenantId: string): Promise<string | null> {
  const tid = assertTenantId(tenantId);
  return read(db, async (reader) => {
    const { rows } = await reader.query<{ site_id: string }>(
      `SELECT site_id FROM ${registryTable(reader)} WHERE tenant_id = $1`,
      [tid],
    );
    return rows[0]?.site_id ?? null;
  });
}

/** The tenant holding `tenantId`'s `kind` pool, or null when the tenant is unregistered. */
export async function poolTenantFor(db: RegistrySource, tenantId: string, kind: PoolKind): Promise<string | null> {
  const tid = assertTenantId(tenantId);
  if (!Object.hasOwn(POOL_TENANT_COLUMNS, kind)) {
    throw new TypeError(`Unknown pool kind: ${JSON.stringify(kind)}`);
  }
  const column = POOL_TENANT_COLUMNS[kind];
  return read(db, async (reader) => {
    const { rows } = await reader.query<{ pool_tenant: string | null }>(
      `SELECT ${column} AS pool_tenant FROM ${registryTable(reader)} WHERE tenant_id = $1`,
      [tid],
    );
    return rows[0]?.pool_tenant ?? null;
  });
}

/** The tenants of `tenantId`'s content pool in stored order; empty when the tenant is unregistered. */
export async function contentPoolTenants(db: RegistrySource, tenantId: string): Promise<string[]> {
  const tid = assertTenantId(tenantId);
  return read(db, async (reader) => {
    const { rows } = await reader.query<{ content_pool_tenants: string[] | null }>(
      `SELECT content_pool_tenants FROM ${registryTable(reader)} WHERE tenant_id = $1`,
      [tid],
    );
    return rows[0]?.content_pool_tenants ?? [];
  });
}

/** `tenantId`, then every registered tenant whose public or private user pool it is, ordered by site id, without repeats. */
export async function userPoolFanoutTenants(db: RegistrySource, tenantId: string): Promise<string[]> {
  const tid = assertTenantId(tenantId);
  return read(db, async (reader) => {
    const { rows } = await reader.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM ${registryTable(reader)}` +
        ' WHERE public_user_pool_tenant = $1 OR private_user_pool_tenant = $1 ORDER BY site_id',
      [tid],
    );
    return [...new Set([tid, ...rows.map((row) => row.tenant_id)])];
  });
}

// Exact key first, then any casing, so legacy keys such as `siteID` and `contentPoolID` are read too.
function readField(payload: Readonly<Record<string, unknown>>, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(payload, name)) {
      return payload[name];
    }
    const wanted = name.toLowerCase();
    const key = Object.keys(payload).find((candidate) => candidate.toLowerCase() === wanted);
    if (key !== undefined) {
      return payload[key];
    }
  }
  return undefined;
}

// settingsBean.cfc defaults every empty pool id to the site's own id.
function poolId(value: unknown, siteId: string, label: string): string {
  if (value === undefined || value === null || value === '') {
    return siteId;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

// A non-empty stored list is kept as is, without adding the site itself; only an empty list defaults to the site.
function contentPool(value: unknown, siteId: string): string[] {
  const items: unknown[] =
    value === undefined || value === null ? [] : typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') {
      throw new TypeError('contentPoolIds must hold strings');
    }
    const id = item.trim();
    if (id !== '' && !seen.has(id.toLowerCase())) {
      seen.add(id.toLowerCase());
      ids.push(id);
    }
  }
  return ids.length > 0 ? ids : [siteId];
}

function domainList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Applies `programs-sites.site.changed.v1` to `tenant_registry`; older or equal aggregate versions are ignored. */
export const tenantRegistryConsumer = {
  topic: SITE_CHANGED_TOPIC,
  kind: 'state' as const,
  async apply(tx: TenantTx, event: SiteChangedEvent): Promise<void> {
    const payload: Readonly<Record<string, unknown>> =
      typeof event.payload === 'object' && event.payload !== null ? { ...event.payload } : {};
    const siteId = readField(payload, 'siteId');
    if (typeof siteId !== 'string' || siteId === '') {
      throw new TypeError('site.changed payload siteId must be a non-empty string');
    }
    const expected = tenantIdForSite(siteId);
    if (event.tenantId.toLowerCase() !== expected) {
      throw new TenantMismatchError(expected, event.tenantId);
    }
    if (tx.tenantId !== expected) {
      throw new TenantMismatchError(expected, tx.tenantId);
    }

    const pools = (['publicUserPoolId', 'privateUserPoolId', 'categoryPoolId', 'filePoolId', 'displayPoolId'] as const).map(
      (name) => poolId(readField(payload, name), siteId, name),
    );
    const contentPoolIds = contentPool(readField(payload, 'contentPoolIds', 'contentPoolId'), siteId);
    const table = `${tx.schema}.tenant_registry`;
    await tx.query(
      `INSERT INTO ${table} (site_id, tenant_id,
         public_user_pool_id, private_user_pool_id, category_pool_id, file_pool_id, display_pool_id, content_pool_ids,
         public_user_pool_tenant, private_user_pool_tenant, category_pool_tenant, file_pool_tenant, display_pool_tenant,
         content_pool_tenants, domains, aggregate_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, LOCALTIMESTAMP(3))
       ON CONFLICT (tenant_id) DO UPDATE SET
         site_id = EXCLUDED.site_id,
         public_user_pool_id = EXCLUDED.public_user_pool_id,
         private_user_pool_id = EXCLUDED.private_user_pool_id,
         category_pool_id = EXCLUDED.category_pool_id,
         file_pool_id = EXCLUDED.file_pool_id,
         display_pool_id = EXCLUDED.display_pool_id,
         content_pool_ids = EXCLUDED.content_pool_ids,
         public_user_pool_tenant = EXCLUDED.public_user_pool_tenant,
         private_user_pool_tenant = EXCLUDED.private_user_pool_tenant,
         category_pool_tenant = EXCLUDED.category_pool_tenant,
         file_pool_tenant = EXCLUDED.file_pool_tenant,
         display_pool_tenant = EXCLUDED.display_pool_tenant,
         content_pool_tenants = EXCLUDED.content_pool_tenants,
         domains = EXCLUDED.domains,
         aggregate_version = EXCLUDED.aggregate_version,
         updated_at = EXCLUDED.updated_at
       WHERE ${table}.aggregate_version < EXCLUDED.aggregate_version`,
      [
        siteId,
        expected,
        ...pools,
        contentPoolIds,
        ...pools.map((id) => tenantIdForSite(id)),
        contentPoolIds.map((id) => tenantIdForSite(id)),
        domainList(readField(payload, 'domains')),
        event.aggregateVersion,
      ],
    );
  },
};
