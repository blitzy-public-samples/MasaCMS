// Tenant isolation of the content schema: RLS, pools, content pools, dead letters and repository guards.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONSUMER_AGGREGATE_VERSION_TABLE,
  DEAD_LETTER_REASON_ATTRIBUTE,
  INBOX_TABLE,
  dlqTopicName,
  type EventEnvelope,
} from '@opt2/platform/events';
import { CHANGELOG_TABLE, legacyRowHash, type TableDefinition } from '@opt2/platform/migration-kit';
import {
  NON_TENANT_TABLES,
  OutsideTenantTransactionError,
  TransactionEndedError,
  registeredTenants,
  registryEntries,
  tenantIdForSite,
  withMetadata,
  withTenant,
  type SiteChangedPayload,
  type TenantDb,
  type TenantTx,
} from '@opt2/platform/tenancy';
import {
  PLATFORM_TABLE_GROUPS,
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  businessClock,
  createCapturingPublisher,
  defineIsolationSuite,
  expectPlatformTables,
  fixtureForTenant,
  pgAvailable,
  pushTo,
  registryPayloads,
  testEnvelope,
  withoutTenant,
  type InjectResponse,
  type IsolationEventOptions,
  type PlatformTableGroup,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { listPrivateInterestGroups } from '../../src/domain/categories.js';
import { actorFromClaims } from '../../src/domain/context.js';
import { contentPoolSites, feedPoolSites, readAcrossContentPool, withPoolTenant, type PoolScope } from '../../src/domain/pools.js';
import {
  GROUP_CHANGED_SUBSCRIPTION,
  GROUP_CHANGED_TOPIC,
  MEMBERSHIP_CHANGED_SUBSCRIPTION,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_SUBSCRIPTION,
  PERMISSION_CHANGED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
  type GroupChangedPayload,
  type MembershipChangedPayload,
  type PermissionChangedPayload,
} from '../../src/events/consumers.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import {
  APPROVAL_ASSIGNMENT,
  APPROVAL_CHAIN,
  APPROVAL_MEMBERSHIP,
  APPROVAL_REQUEST,
  CATEGORY,
  CATEGORY_ASSIGN,
  CHANGESET,
  COMMENT,
  CONTENT,
  DISPLAY_TITLE_APPROVAL,
  FEED,
  FILE,
  FILE_OBJECT,
  FORM_RESPONSE_PACKET,
  GROUP_PROJECTION,
  IDENTITY_COLUMNS,
  MEMBERSHIP_PROJECTION,
  OWNED_TABLES,
  PERMISSION_PROJECTION,
  PUBLIC_SUBMISSION_APPROVAL,
  STAGED_OBJECT,
} from '../../src/repo/tables.js';
import { buildTestApp, openContentGates, withPgSchema, type TestApp } from '../helpers/app.js';
import {
  IDS,
  approvalAssignmentRow,
  approvalChainRow,
  approvalMembershipRow,
  approvalRequestRow,
  at,
  categoryAssignRow,
  categoryRow,
  changesetRow,
  commentRow,
  contentRow,
  displayTitleApprovalRow,
  feedRow,
  fileObjectRow,
  fileRow,
  formResponsePacketRow,
  groupProjectionRow,
  membershipProjectionRow,
  newId,
  permissionProjectionRow,
  publicSubmissionApprovalRow,
  seedAll,
  seedRows,
  type TenantSeed,
} from '../helpers/seed.js';

type Row = Record<string, unknown>;

/** Catalog facts of one column the generic row builder needs. */
interface ColumnFacts {
  /** NOT NULL without a default or identity, so every insert must set it. */
  required: boolean;
  /** Declared length of a `char(n)` or `varchar(n)` column, else null. */
  length: number | null;
}

const NON_TENANT: readonly string[] = NON_TENANT_TABLES;
const ALL_PLATFORM_GROUPS = Object.keys(PLATFORM_TABLE_GROUPS) as PlatformTableGroup[];
const PLATFORM_TENANT_TABLES = ALL_PLATFORM_GROUPS.flatMap((group) => PLATFORM_TABLE_GROUPS[group].tenantOwned);
const DEFINITIONS: ReadonlyMap<string, TableDefinition> = new Map(
  [...OWNED_TABLES, GROUP_PROJECTION, PERMISSION_PROJECTION, MEMBERSHIP_PROJECTION].map((definition) => [definition.table, definition]),
);
const ISOLATION_TABLES: readonly string[] = [...DEFINITIONS.keys()].filter((table) => !NON_TENANT.includes(table));
/** Fresh rows of the platform tables a delivery writes in its destination tenant: receipt, ordering progress and projection audit. */
const CONSUMER_ROWS: ReadonlyMap<string, () => Row> = new Map<string, () => Row>([
  [INBOX_TABLE, () => ({ event_id: randomUUID(), subscription: SITE_CHANGED_SUBSCRIPTION, status: 'applied' })],
  [CONSUMER_AGGREGATE_VERSION_TABLE, () => ({ subscription: SITE_CHANGED_SUBSCRIPTION, aggregate_type: 'site', aggregate_id: newId(), last_version: 1 })],
  [CHANGELOG_TABLE, () => ({ table: GROUP_PROJECTION.table, op: 'insert', key: newId(), after: '{}', origin: 'target' })],
]);
/** Tables of the shared suite, so a delivery's effect in another tenant shows in its counts. */
const SUITE_TABLES: readonly string[] = [...ISOLATION_TABLES, ...CONSUMER_ROWS.keys()];
const IDENTITY_OF: ReadonlyMap<string, string> = new Map(Object.entries(IDENTITY_COLUMNS));
const KEYLESS_MANAGED: ReadonlySet<string> = new Set(['tenant_id', 'legacy_row_hash', 'occurrence']);
const SITE_COLUMNS: ReadonlySet<string> = new Set(['siteid', 'site_id']);
const CLOCK = businessClock();
const BUSINESS_TIME = at('12:00:00');
const RLS_VIOLATION = '42501';
const CF_ID_LENGTH = 35;

const COLUMN_FACTS_SQL = `
SELECT c.relname::text AS table, a.attname::text AS column,
       a.attnotnull AND NOT a.atthasdef AND a.attidentity = '' AS required,
       CASE WHEN a.atttypid IN ('bpchar'::regtype, 'varchar'::regtype) AND a.atttypmod > 0 THEN a.atttypmod - 4 END AS length
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`;

/** Seed row builders by table; each returns a fresh tenant-a row that {@link rowFor} moves to the wanted site. */
const BUILDERS: ReadonlyMap<string, () => Row> = new Map<string, () => Row>([
  [CONTENT.table, () => contentRow()],
  [FILE.table, () => fileRow()],
  [CHANGESET.table, () => changesetRow()],
  [APPROVAL_CHAIN.table, () => approvalChainRow()],
  [APPROVAL_MEMBERSHIP.table, () => approvalMembershipRow()],
  [APPROVAL_ASSIGNMENT.table, () => approvalAssignmentRow()],
  [APPROVAL_REQUEST.table, () => approvalRequestRow()],
  [CATEGORY.table, () => categoryRow()],
  [CATEGORY_ASSIGN.table, () => categoryAssignRow()],
  [COMMENT.table, () => commentRow()],
  [FEED.table, () => feedRow()],
  [FORM_RESPONSE_PACKET.table, () => formResponsePacketRow()],
  [DISPLAY_TITLE_APPROVAL.table, () => displayTitleApprovalRow({ contentid: newId() })],
  [PUBLIC_SUBMISSION_APPROVAL.table, () => publicSubmissionApprovalRow({ contentid: newId() })],
  [GROUP_PROJECTION.table, () => groupProjectionRow()],
  [PERMISSION_PROJECTION.table, () => permissionProjectionRow()],
  [MEMBERSHIP_PROJECTION.table, () => membershipProjectionRow()],
]);

const available = await pgAvailable();

let handle: ThrowawaySchema | undefined;
let testApp: TestApp<TenantDb> | undefined;
let repository: ContentRepository | undefined;
let seeds: TenantSeed[] = [];
let columnFacts = new Map<string, Map<string, ColumnFacts>>();
/** Last `programs-sites.site.changed.v1` version built for a push; seedRegistry stores version 1. */
let siteVersion = 1;
/** The app's publisher, created up front because the shared suite's event cases take it at registration. */
const publisher = createCapturingPublisher();

/** The throwaway schema the outer beforeAll created; throws when its creation failed. */
function created(): ThrowawaySchema {
  if (handle === undefined) {
    throw new Error('The throwaway content schema was not created; see the beforeAll failure');
  }
  return handle;
}

/** The app and repository the outer beforeAll built; throws when building them failed. */
function built(): { db: TenantDb; app: TestApp<TenantDb>; repository: ContentRepository } {
  if (testApp === undefined || repository === undefined) {
    throw new Error('The strategies-content app or repository was not built; see the beforeAll failure');
  }
  return { db: created().app, app: testApp, repository };
}

/** Reads the column facts of every table of `db`'s schema from the catalog. */
async function readColumnFacts(db: ThrowawaySchema): Promise<Map<string, Map<string, ColumnFacts>>> {
  const { rows } = await db.adminPool.query<{ table: string; column: string; required: boolean; length: number | null }>(COLUMN_FACTS_SQL, [
    db.schema,
  ]);
  const facts = new Map<string, Map<string, ColumnFacts>>();
  for (const { table, column, required, length } of rows) {
    facts.set(table, (facts.get(table) ?? new Map<string, ColumnFacts>()).set(column, { required, length }));
  }
  return facts;
}

/** A fresh text value that fits `length` characters: a CF-format id, or hex when the column is shorter. */
function freshText(length: number | null): string {
  return length === null || length >= CF_ID_LENGTH ? newId() : randomBytes(length).toString('hex').slice(0, length);
}

/** A value of `column`'s canonical type; text is fresh so keys never repeat within a tenant. */
function valueOf(column: TableDefinition['columns'][number], facts: ColumnFacts | undefined): unknown {
  switch (column.type) {
    case 's':
      return freshText(facts?.length ?? null);
    case 'i':
      return 1;
    case 'f':
      return 0;
    case 'd':
      return '0';
    case 't':
      return BUSINESS_TIME;
    case 'b':
      return Buffer.from('opt2 isolation probe', 'utf8');
  }
}

/** A row of `definition` with its key and required columns set, built from the column types and the catalog. */
function genericRow(definition: TableDefinition): Row {
  const facts = columnFacts.get(definition.table);
  if (facts === undefined) {
    throw new TypeError(`Schema ${created().schema} has no table ${definition.table}`);
  }
  const key = new Set(definition.key ?? []);
  const identity = IDENTITY_OF.get(definition.table);
  const row: Row = {};
  for (const column of definition.columns) {
    const fact = facts.get(column.name);
    if (KEYLESS_MANAGED.has(column.name) || column.name === identity) continue;
    if (key.has(column.name) || fact?.required === true) {
      row[column.name] = valueOf(column, fact);
    }
  }
  return row;
}

/** A pending upload intent of `staged_object`, the shape `files.insertStagedObject` writes. */
function stagedObjectRow(tenant: TenantFixture): Row {
  const fileId = newId();
  return {
    stage_id: newId(),
    object_key: `${tenant.tenantId}/${fileId}.bin`,
    kind: 'upload',
    file_id: fileId,
    variant: '',
    ext: 'bin',
    size: 1,
    sha256: randomBytes(32).toString('hex'),
    content_type: 'application/octet-stream',
    state: 'staged',
  };
}

/** A fresh, constraint-satisfying `table` row of `tenant` without `tenant_id`; keyless rows carry their hash and occurrence 1. */
function rowFor(table: string, tenant: TenantFixture): Row {
  if (table === STAGED_OBJECT.table) return stagedObjectRow(tenant);
  const consumerRow = CONSUMER_ROWS.get(table);
  if (consumerRow !== undefined) return consumerRow();
  const definition = DEFINITIONS.get(table);
  if (definition === undefined) {
    throw new TypeError(`strategies-content declares no table ${table}`);
  }
  const build = BUILDERS.get(table);
  const base: Row =
    table === FILE_OBJECT.table ? fileObjectRow({ tenant_id: tenant.tenantId }) : build === undefined ? genericRow(definition) : build();
  const { tenant_id: _tenant, ...row } = base;
  for (const column of SITE_COLUMNS) {
    if (definition.columns.some(({ name }) => name === column)) row[column] = tenant.siteId;
  }
  if (definition.key === null) {
    const data = definition.columns.filter(({ name }) => !KEYLESS_MANAGED.has(name));
    Object.assign(row, { legacy_row_hash: legacyRowHash(data, row), occurrence: 1 });
  }
  return row;
}

/** The parameterised INSERT of `row` into `<schema>.<table>` under `tx`'s tenant. */
function insertOf(tx: TenantTx, table: string, row: Row): { text: string; values: unknown[] } {
  const names = ['tenant_id', ...Object.keys(row)];
  const placeholders = names.map((_, index) => `$${String(index + 1)}`);
  return {
    text: `INSERT INTO "${tx.schema}"."${table}" (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
    values: [tx.tenantId, ...Object.values(row)],
  };
}

/** Writes one fresh `table` row of `tenant` through the gated, audited content repository; the platform consumer tables with plain SQL. */
async function writeAs(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  const row = rowFor(table, tenant);
  if (CONSUMER_ROWS.has(table)) {
    const { text, values } = insertOf(tx, table, row);
    await tx.query(text, values);
    return;
  }
  await built().repository.platform.insert(tx, table, row, { actorService: 'strategies-content', requestId: 'isolation' });
}

/** Every row of `table` visible in `tx`; RLS is the only filter. */
async function readAs(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT * FROM "${tx.schema}"."${table}"`)).rows;
}

/** The fixture registry payload of `fixture`'s site. */
function payloadOf(fixture: TenantFixture): SiteChangedPayload {
  const payload = registryPayloads().find(({ siteId }) => siteId === fixture.siteId);
  if (payload === undefined) {
    throw new TypeError(`The fixture registry has no site ${fixture.siteId}`);
  }
  return payload;
}

const POOL_FIELDS = {
  category: 'categoryPoolId',
  file: 'filePoolId',
  publicUser: 'publicUserPoolId',
  privateUser: 'privateUserPoolId',
} as const satisfies Record<PoolScope, keyof SiteChangedPayload & `${string}PoolId`>;

/** The site holding `fixture`'s `kind` pool in the fixture registry. */
function poolSiteOf(fixture: TenantFixture, kind: PoolScope): string {
  const site = payloadOf(fixture)[POOL_FIELDS[kind]];
  if (typeof site !== 'string') {
    throw new TypeError(`The fixture registry gives site ${fixture.siteId} no ${kind} pool`);
  }
  return site;
}

/** The content pool sites `fixture` registers, in stored order. */
function contentPoolOf(fixture: TenantFixture): string[] {
  const { contentPoolIds } = payloadOf(fixture);
  if (!Array.isArray(contentPoolIds)) {
    throw new TypeError(`The fixture registry gives site ${fixture.siteId} no content pool list`);
  }
  return contentPoolIds;
}

/** `column` values of the `table` rows seeded under `fixture`. */
function seededValues(fixture: TenantFixture | undefined, table: string, column: string): string[] {
  const seed = seeds.find(({ tenant }) => tenant === fixture);
  return (seed?.rows ?? []).filter(({ table: def }) => def.table === table).map(({ row }) => String(row[column]));
}

/** Rows of each `tables` entry visible to each fixture tenant, keyed `<key> <table>`. */
async function countsByFixture(tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const tenant of TENANT_LIST) {
    await withTenant(created().app, tenant.tenantId, async (tx) => {
      for (const table of tables) {
        const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tx.schema}"."${table}"`);
        counts[`${tenant.key} ${table}`] = rows[0]?.n ?? 0;
      }
    });
  }
  return counts;
}

/** Rows of `table` whose `column` is `value`, visible to each fixture tenant, keyed by fixture key. */
async function matchesByFixture(table: string, column: string, value: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const tenant of TENANT_LIST) {
    counts[tenant.key] = await withTenant(created().app, tenant.tenantId, async (tx) => {
      const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tx.schema}"."${table}" WHERE "${column}" = $1`, [value]);
      return rows[0]?.n ?? 0;
    });
  }
  return counts;
}

/** A private-pool group state of `fixture`'s site. */
function groupEnvelope(fixture: TenantFixture) {
  const groupId = newId();
  const payload: GroupChangedPayload = {
    groupId,
    siteId: fixture.siteId,
    groupName: 'Isolation Group',
    type: 1,
    isPublic: 0,
    poolTenantId: fixture.tenantId,
    deleted: false,
  };
  return testEnvelope({ topic: GROUP_CHANGED_TOPIC, tenantId: fixture.tenantId, aggregateType: 'group', aggregateId: groupId, payload });
}

/** One Read grant of a group on `fixture`'s home node. */
function permissionEnvelope(fixture: TenantFixture) {
  const groupId = newId();
  const payload: PermissionChangedPayload = {
    groupId,
    siteId: fixture.siteId,
    rows: [{ contentId: IDS.content.root, siteId: fixture.siteId, type: 'Read' }],
  };
  return testEnvelope({ topic: PERMISSION_CHANGED_TOPIC, tenantId: fixture.tenantId, aggregateType: 'group', aggregateId: groupId, payload });
}

/** One user of `fixture`'s site in one group. */
function membershipEnvelope(fixture: TenantFixture) {
  const userId = newId();
  const payload: MembershipChangedPayload = { userId, siteId: fixture.siteId, groupIds: [newId()] };
  return testEnvelope({ topic: MEMBERSHIP_CHANGED_TOPIC, tenantId: fixture.tenantId, aggregateType: 'user', aggregateId: userId, payload });
}

/** `fixture`'s registry state, as programs-sites publishes it. */
function siteEnvelope(fixture: TenantFixture, payload: SiteChangedPayload = payloadOf(fixture), aggregateVersion = 1) {
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: fixture.tenantId, aggregateType: 'site', aggregateId: fixture.siteId, aggregateVersion, payload });
}

/** `fixture`'s registry state as the next site.changed version, so the consumer applies it rather than ignoring it as stale. */
function nextSiteEnvelope(fixture: TenantFixture) {
  siteVersion += 1;
  return siteEnvelope(fixture, payloadOf(fixture), siteVersion);
}

/** `build` keyed by tenant id instead of fixture; throws for a tenant id no fixture has. */
function byTenantId(build: (fixture: TenantFixture) => EventEnvelope): (tenantId: string) => EventEnvelope {
  return (tenantId) => {
    const fixture = fixtureForTenant(tenantId);
    if (fixture === undefined) {
      throw new TypeError(`No tenant fixture has tenant id ${tenantId}`);
    }
    return build(fixture);
  };
}

/** The shared suite's event cases, one per push subscription of the service. */
const SUITE_EVENTS: readonly IsolationEventOptions[] = [
  { subscription: SITE_CHANGED_SUBSCRIPTION, envelopeFor: byTenantId(nextSiteEnvelope) },
  { subscription: GROUP_CHANGED_SUBSCRIPTION, envelopeFor: byTenantId(groupEnvelope) },
  { subscription: PERMISSION_CHANGED_SUBSCRIPTION, envelopeFor: byTenantId(permissionEnvelope) },
  { subscription: MEMBERSHIP_CHANGED_SUBSCRIPTION, envelopeFor: byTenantId(membershipEnvelope) },
].map((event) => ({ ...event, app: () => testApp?.app, publisher }));

/** Delivers tenant-a's registry state `payload` as the next site.changed version. */
async function pushTenantASite(payload: SiteChangedPayload): Promise<InjectResponse> {
  siteVersion += 1;
  return pushTo(built().app.app, SITE_CHANGED_SUBSCRIPTION, siteEnvelope(TENANT_A, payload, siteVersion));
}

/** `contenthistid` and `tenant_id` of every content version visible in `tx`. */
async function contentVersions(tx: TenantTx): Promise<Array<{ tenant_id: string; contenthistid: string }>> {
  const { rows } = await tx.query<{ tenant_id: string; contenthistid: string }>(
    `SELECT tenant_id::text AS tenant_id, contenthistid FROM "${tx.schema}"."${CONTENT.table}" ORDER BY contenthistid`,
  );
  return rows;
}

/** `cases` as `[name, case]` rows, so `it.each(…)('%s')` titles them by their full name. */
function named<T extends { name: string }>(cases: readonly T[]): Array<[string, T]> {
  return cases.map((testCase): [string, T] => [testCase.name, testCase]);
}

/** The SQLSTATE `work` fails with, or 'no error'. */
async function sqlStateOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'no error';
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? code : `non-SQL error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

describe.skipIf(!available)('strategies-content tenant isolation', () => {
  beforeAll(async () => {
    handle = await withPgSchema();
    repository = createContentRepository({ clock: CLOCK, schema: handle.schema });
    columnFacts = await readColumnFacts(handle);
    seeds = await seedAll(handle);
    testApp = await buildTestApp({ db: handle.app, clock: CLOCK, publisher });
    // After the build, whose start-up may add missing gates as `legacy`; the suite's writes go through the gates.
    await openContentGates(handle);
  });

  afterAll(async () => {
    try {
      await testApp?.close();
    } finally {
      await handle?.drop();
    }
  });

  describe('catalog', () => {
    it('has the platform tables with the right tenancy', async () => {
      await expectPlatformTables(created(), { groups: ALL_PLATFORM_GROUPS });
    });

    it('covers every tenant-owned table of the schema, each with tenant_id uuid NOT NULL', async () => {
      const db = created();
      const { rows: tables } = await db.adminPool.query<{ table: string }>(
        `SELECT table_name::text AS table FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [db.schema],
      );
      const { rows: tenantColumns } = await db.adminPool.query<{ table: string; type: string; nullable: string }>(
        `SELECT table_name::text AS table, data_type::text AS type, is_nullable::text AS nullable
           FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'tenant_id'`,
        [db.schema],
      );
      const names = tables.map(({ table }) => table);
      const withTenantColumn = new Map(tenantColumns.map(({ table, type, nullable }) => [table, { type, nullable }]));
      const covered = [...ISOLATION_TABLES, ...PLATFORM_TENANT_TABLES].sort();
      const tenantOwned = names.filter((table) => !NON_TENANT.includes(table)).sort();

      expect(names.filter((table) => !withTenantColumn.has(table) && !NON_TENANT.includes(table)), 'tables without tenant_id').toEqual([]);
      expect(tenantOwned, 'tenant-owned tables of the schema').toEqual(covered);
      expect(tenantOwned.map((table) => [table, withTenantColumn.get(table)])).toEqual(
        tenantOwned.map((table) => [table, { type: 'uuid', nullable: 'NO' }]),
      );
    });
  });

  // Also registers the checkCatalog case (forced RLS with USING and WITH CHECK, no role reaching SUPERUSER or BYPASSRLS)
  // and the requireTenantTx guard case, so neither is repeated here, plus each subscription's tenantless and tenant A delivery cases.
  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    {
      db: () => handle,
      name: 'content owned tables',
      tables: SUITE_TABLES,
      writeAs,
      readAs,
      rowFor,
      events: SUITE_EVENTS,
    },
  );

  describe('pools', () => {
    it('seeds tenant-a with umbrella category, file and public user pools and its own private pool, and tenant-b with its own pools', () => {
      expect(payloadOf(TENANT_A)).toMatchObject({
        categoryPoolId: TENANT_UMBRELLA.siteId,
        filePoolId: TENANT_UMBRELLA.siteId,
        publicUserPoolId: TENANT_UMBRELLA.siteId,
        privateUserPoolId: TENANT_A.siteId,
      });
      expect(payloadOf(TENANT_B)).toMatchObject({
        categoryPoolId: TENANT_B.siteId,
        filePoolId: TENANT_B.siteId,
        publicUserPoolId: TENANT_B.siteId,
        privateUserPoolId: TENANT_B.siteId,
        displayPoolId: TENANT_B.siteId,
        contentPoolIds: [TENANT_B.siteId],
      });
    });

    interface PooledRowCase {
      name: string;
      tenant: TenantFixture;
      kind: PoolScope;
      table: string;
      column: string;
    }

    const pooledRowCases: PooledRowCase[] = [
      { name: 'tenant-a resolves pooled categories to umbrella rows', tenant: TENANT_A, kind: 'category', table: CATEGORY.table, column: 'categoryid' },
      { name: 'tenant-b never resolves umbrella categories', tenant: TENANT_B, kind: 'category', table: CATEGORY.table, column: 'categoryid' },
      { name: 'tenant-a resolves pooled files to umbrella rows', tenant: TENANT_A, kind: 'file', table: FILE.table, column: 'fileid' },
      { name: 'tenant-b never resolves umbrella files', tenant: TENANT_B, kind: 'file', table: FILE.table, column: 'fileid' },
      { name: 'tenant-a resolves pooled file objects to umbrella rows', tenant: TENANT_A, kind: 'file', table: FILE_OBJECT.table, column: 'file_id' },
      { name: 'tenant-b never resolves umbrella file objects', tenant: TENANT_B, kind: 'file', table: FILE_OBJECT.table, column: 'file_id' },
    ];

    it.each(named(pooledRowCases))('%s', async (_name, { tenant, kind, table, column }) => {
      const expected = tenantIdForSite(poolSiteOf(tenant, kind));
      const poolFixture = fixtureForTenant(expected);
      const read = await withPoolTenant(created().app, tenant.tenantId, kind, async (tx, poolTenantId) => ({
        poolTenantId,
        txTenant: tx.tenantId,
        rows: (await readAs(tx, table)) as Row[],
      }));
      const ids = new Set(read.rows.map((row) => String(row[column])));
      const foreign = TENANT_LIST.filter((fixture) => fixture !== poolFixture).flatMap((fixture) => seededValues(fixture, table, column));

      expect([read.poolTenantId, read.txTenant], 'pool tenant and transaction tenant').toEqual([expected, expected]);
      expect(read.rows.map((row) => row.tenant_id).filter((owner) => owner !== expected), `${table} rows of other tenants`).toEqual([]);
      expect(seededValues(poolFixture, table, column).filter((id) => !ids.has(id)), `seeded pool ${table} rows missing`).toEqual([]);
      expect(foreign.filter((id) => ids.has(id)), `seeded ${table} rows of other tenants`).toEqual([]);
    });

    it.each([
      { tenant: TENANT_A, kind: 'publicUser' as const },
      { tenant: TENANT_A, kind: 'privateUser' as const },
      { tenant: TENANT_B, kind: 'publicUser' as const },
      { tenant: TENANT_B, kind: 'privateUser' as const },
    ])('$tenant.siteId resolves its $kind pool to the registered pool site', async ({ tenant, kind }) => {
      const resolved = await withPoolTenant(created().app, tenant.tenantId, kind, async (tx, poolTenantId) => [tx.tenantId, poolTenantId]);
      const expected = tenantIdForSite(poolSiteOf(tenant, kind));
      expect(resolved).toEqual([expected, expected]);
    });

    /** A signed-in system user of `fixture`'s site, as its verified token names it. */
    const actorOf = (fixture: TenantFixture) =>
      actorFromClaims(
        { iss: 'opt2-local-identity', aud: 'opt2-local', sub: newId(), sid: 'isolation', tid: fixture.tenantId, site: fixture.siteId, roles: ['system-user'], s2: false, epoch: 0, iat: 0, exp: 0 },
        '',
      );

    it.each<{ name: string; reader: TenantFixture; included: readonly string[] }>([
      { name: "tenant-a's private interest groups read only tenant-a, never its umbrella category pool or tenant-b", reader: TENANT_A, included: [] },
      { name: "tenant-b's private interest groups read only tenant-b, never umbrella or tenant-a", reader: TENANT_B, included: [IDS.categories.bOwn] },
    ])('$name', async ({ reader, included }) => {
      const { db, repository: repo } = built();
      const rows = await listPrivateInterestGroups({ db, repository: repo }, actorOf(reader), { siteId: reader.siteId, parentId: '' });
      const own = await withTenant(db, reader.tenantId, async (tx) => new Set(((await readAs(tx, CATEGORY.table)) as Row[]).map((row) => String(row.categoryid))));
      const ids = (rows ?? []).map((row) => row.categoryid);
      const foreign = TENANT_LIST.filter((fixture) => fixture !== reader).flatMap((fixture) => seededValues(fixture, CATEGORY.table, 'categoryid'));

      expect(rows, 'an admitted read').toBeDefined();
      expect(ids.filter((id) => !own.has(id)), 'rows outside the reader tenant').toEqual([]);
      expect(foreign.filter((id) => ids.includes(id)), 'seeded rows of other tenants').toEqual([]);
      expect(included.filter((id) => !ids.includes(id)), 'seeded top-level interest groups of the reader').toEqual([]);
    });

    it.each([TENANT_B, TENANT_UMBRELLA])("refuses tenant-a a read of $siteId's interest groups, which share none of its private pool", async (other) => {
      const { db, repository: repo } = built();
      expect(await listPrivateInterestGroups({ db, repository: repo }, actorOf(TENANT_A), { siteId: other.siteId, parentId: '' })).toBeUndefined();
    });

  });

  describe('content pools', () => {
    /** The registered sites of `ids`, as the pool readers return them. */
    const sitesOf = (ids: readonly string[]) => ids.map((siteId) => ({ siteId, tenantId: tenantIdForSite(siteId) }));

    it("tenant-a's content pool is its registered pool, in stored order, of registered tenants only", async () => {
      const db = created().app;
      const sites = await contentPoolSites(db, TENANT_A.tenantId);
      const registered = new Set((await registeredTenants(db)).map(({ tenantId }) => tenantId));
      expect(sites).toEqual(sitesOf(contentPoolOf(TENANT_A)));
      expect(sites.filter(({ tenantId }) => !registered.has(tenantId)), 'unregistered pool tenants').toEqual([]);
    });

    const feedPoolCases = [
      { name: "an empty feed pool reads tenant-a's own site", tenant: TENANT_A, list: '', expected: () => sitesOf([TENANT_A.siteId]) },
      { name: "a '*' feed pool reads tenant-a's registered content pool", tenant: TENANT_A, list: '*', expected: () => sitesOf(contentPoolOf(TENANT_A)) },
      {
        name: 'a feed pool drops a site the registry does not hold',
        tenant: TENANT_A,
        list: `${TENANT_A.siteId},no-such-site`,
        expected: () => sitesOf([TENANT_A.siteId]),
      },
      {
        name: "tenant-b's feed pool never reaches tenant-a, which its content pool does not register",
        tenant: TENANT_B,
        list: `${TENANT_A.siteId},${TENANT_B.siteId}`,
        expected: () => sitesOf([TENANT_B.siteId]),
      },
    ];

    it.each(named(feedPoolCases))('%s', async (_name, { tenant, list, expected }) => {
      expect(await feedPoolSites(created().app, tenant.tenantId, list)).toEqual(expected());
    });

    it("a content-pool read of tenant-a returns only tenant-a's rows and none of tenant-b's", async () => {
      const db = created().app;
      const sites = await contentPoolSites(db, TENANT_A.tenantId);
      const rows = await readAcrossContentPool(db, sites, (tx) => contentVersions(tx));
      const poolTenants = new Set(sites.map(({ tenantId }) => tenantId));
      const versions = new Set(rows.map(({ contenthistid }) => contenthistid));
      expect(rows.filter(({ tenant_id }) => !poolTenants.has(tenant_id)), 'rows outside the pool tenants').toEqual([]);
      expect(seededValues(TENANT_A, CONTENT.table, 'contenthistid').filter((id) => !versions.has(id)), 'tenant-a versions missing').toEqual([]);
      expect(seededValues(TENANT_B, CONTENT.table, 'contenthistid').filter((id) => versions.has(id)), 'tenant-b versions read').toEqual([]);
    });

    describe('with umbrella added to tenant-a content pool', () => {
      const pooledVersion = newId();
      const pooledPage = contentRow({ tenant_id: TENANT_UMBRELLA.tenantId, siteid: TENANT_UMBRELLA.siteId, contenthistid: pooledVersion, title: 'Umbrella Page' });

      beforeAll(async () => {
        await seedRows(created(), TENANT_UMBRELLA, [{ table: CONTENT, row: pooledPage }]);
        const pushed = await pushTenantASite({ ...payloadOf(TENANT_A), contentPoolIds: [TENANT_A.siteId, TENANT_UMBRELLA.siteId] });
        expect(pushed.statusCode, 'site.changed adding umbrella to the content pool').toBe(204);
      });

      afterAll(async () => {
        const restored = await pushTenantASite(payloadOf(TENANT_A));
        expect(restored.statusCode, 'site.changed restoring the fixture content pool').toBe(204);
      });

      it('resolves tenant-a then umbrella from the registry the site.changed event fed', async () => {
        expect(await contentPoolSites(created().app, TENANT_A.tenantId)).toEqual(sitesOf([TENANT_A.siteId, TENANT_UMBRELLA.siteId]));
      });

      it('merges tenant-a and umbrella rows in registered order and still reads no tenant-b row', async () => {
        const db = created().app;
        const sites = await contentPoolSites(db, TENANT_A.tenantId);
        const rows = await readAcrossContentPool(db, sites, (tx) => contentVersions(tx));
        const owners = rows.map(({ tenant_id }) => tenant_id);
        const versions = new Set(rows.map(({ contenthistid }) => contenthistid));
        const firstUmbrella = owners.indexOf(TENANT_UMBRELLA.tenantId);

        expect(owners.filter((owner) => owner !== TENANT_A.tenantId && owner !== TENANT_UMBRELLA.tenantId), 'rows of other tenants').toEqual([]);
        expect(firstUmbrella, 'index of the first umbrella row').toBeGreaterThan(0);
        expect(owners.slice(0, firstUmbrella).every((owner) => owner === TENANT_A.tenantId), 'tenant-a rows first').toBe(true);
        expect(owners.slice(firstUmbrella).every((owner) => owner === TENANT_UMBRELLA.tenantId), 'umbrella rows last').toBe(true);
        expect(versions.has(pooledVersion), 'the pooled umbrella page').toBe(true);
        expect(seededValues(TENANT_B, CONTENT.table, 'contenthistid').filter((id) => versions.has(id)), 'tenant-b versions read').toEqual([]);
      });
    });
  });

  describe('dead letters', () => {
    const deadLetterCases: Array<{ name: string; subscription: string; envelope(): EventEnvelope }> = [
      { name: 'dead-letters a tenant-less group.changed delivery', subscription: GROUP_CHANGED_SUBSCRIPTION, envelope: () => groupEnvelope(TENANT_A) },
      {
        name: 'dead-letters a tenant-less permission.changed delivery',
        subscription: PERMISSION_CHANGED_SUBSCRIPTION,
        envelope: () => permissionEnvelope(TENANT_A),
      },
      {
        name: 'dead-letters a tenant-less membership.changed delivery',
        subscription: MEMBERSHIP_CHANGED_SUBSCRIPTION,
        envelope: () => membershipEnvelope(TENANT_A),
      },
      { name: 'dead-letters a tenant-less site.changed delivery', subscription: SITE_CHANGED_SUBSCRIPTION, envelope: () => siteEnvelope(TENANT_A) },
    ];
    const consumerTables = [GROUP_PROJECTION.table, PERMISSION_PROJECTION.table, MEMBERSHIP_PROJECTION.table, 'inbox'];

    it.each(named(deadLetterCases))('%s and writes nothing in any tenant', async (_name, { subscription, envelope }) => {
      const { db, app } = built();
      const countsBefore = await countsByFixture(consumerTables);
      const registryBefore = await withMetadata(db, (tx) => registryEntries(tx));
      app.publisher.clear();

      const response = await pushTo(app.app, subscription, withoutTenant(envelope()));

      expect(response.statusCode).toBe(204);
      expect(app.publisher.raw.map(({ topic, message }) => ({ topic, reason: message.attributes[DEAD_LETTER_REASON_ATTRIBUTE] }))).toEqual([
        { topic: dlqTopicName(subscription), reason: 'missing-tenant' },
      ]);
      expect(app.publisher.published).toEqual([]);
      expect(await countsByFixture(consumerTables)).toEqual(countsBefore);
      expect(await withMetadata(db, (tx) => registryEntries(tx))).toEqual(registryBefore);
    });

    it('applies a tenant-b group.changed delivery in tenant-b only and dead-letters nothing', async () => {
      const { app } = built();
      const envelope = groupEnvelope(TENANT_B);
      app.publisher.clear();

      const response = await pushTo(app.app, GROUP_CHANGED_SUBSCRIPTION, envelope);

      expect(response.statusCode).toBe(204);
      expect(app.publisher.raw).toEqual([]);
      expect(await matchesByFixture(GROUP_PROJECTION.table, 'group_id', envelope.aggregateId)).toEqual({ A: 0, B: 1, umbrella: 0 });
      expect(await matchesByFixture('inbox', 'event_id', envelope.eventId)).toEqual({ A: 0, B: 1, umbrella: 0 });
    });
  });

  describe('repository writes outside withTenant', () => {
    /** Inserts a fresh tenant-a category through the content repository on `tx`. */
    const insertCategory = (tx: TenantTx, categoryid: string) =>
      built().repository.platform.insert(tx, CATEGORY.table, { ...rowFor(CATEGORY.table, TENANT_A), categoryid });

    it('rejects a write on a finished tenant transaction outside any transaction with OutsideTenantTransactionError', async () => {
      const categoryid = newId();
      const ended = await withTenant(created().app, TENANT_A.tenantId, async (tx) => tx);
      await expect(insertCategory(ended, categoryid)).rejects.toBeInstanceOf(OutsideTenantTransactionError);
      expect(await matchesByFixture(CATEGORY.table, 'categoryid', categoryid)).toEqual({ A: 0, B: 0, umbrella: 0 });
    });

    it('rejects a write on a finished tenant transaction inside a live one with TransactionEndedError', async () => {
      const categoryid = newId();
      const ended = await withTenant(created().app, TENANT_A.tenantId, async (tx) => tx);
      await withTenant(created().app, TENANT_A.tenantId, async () => {
        await expect(insertCategory(ended, categoryid)).rejects.toBeInstanceOf(TransactionEndedError);
      });
      expect(await matchesByFixture(CATEGORY.table, 'categoryid', categoryid)).toEqual({ A: 0, B: 0, umbrella: 0 });
    });

    it('rejects a write inside a metadata transaction, where RLS also refuses the plain insert, and stores no row', async () => {
      const categoryid = newId();
      const ended = await withTenant(created().app, TENANT_A.tenantId, async (tx) => tx);
      const plain = insertOf(ended, CATEGORY.table, { ...rowFor(CATEGORY.table, TENANT_A), categoryid });
      const outcome = await withMetadata(created().app, async (tx) => {
        let refusal: unknown;
        await insertCategory(ended, categoryid).catch((err: unknown) => {
          refusal = err;
        });
        // A savepoint keeps the metadata transaction committable after the refused insert.
        await tx.query('SAVEPOINT plain_insert');
        const state = await sqlStateOf(tx.query(plain.text, plain.values));
        await tx.query('ROLLBACK TO SAVEPOINT plain_insert');
        return { refusal, plain: state };
      });
      expect(outcome.refusal).toBeInstanceOf(OutsideTenantTransactionError);
      expect(outcome.plain).toBe(RLS_VIOLATION);
      expect(await matchesByFixture(CATEGORY.table, 'categoryid', categoryid)).toEqual({ A: 0, B: 0, umbrella: 0 });
    });
  });
});
