/** Tenant-isolation suite factory and RLS/role catalog checks of `@opt2/platform/testing`. */
import { randomUUID } from 'node:crypto';
import {
  CONSUMER_AGGREGATE_VERSION_TABLE,
  INBOX_TABLE,
  consumeEnvelope,
  destinationTenants,
  subscriptionName,
  type ConsumeOptions,
  type ConsumerDefinition,
  type DeadLetterReason,
  type EventEnvelope,
} from '../events/index.js';
import {
  CHANGELOG_TABLE,
  MIGRATION_BATCH_TABLE,
  MIGRATION_WATERMARK_TABLE,
  OPEN_OPERATION_TABLE,
  UNIT_GATE_TABLE,
} from '../migration-kit/index.js';
import { OUTBOX_TABLE } from '../outbox/index.js';
import { SCHEDULED_TASK_QUEUE_STATE_TABLE, SCHEDULED_TASK_QUEUE_TABLE } from '../tasks/index.js';
import {
  NON_TENANT_TABLES,
  OutsideTenantTransactionError,
  RLS_POLICY_NAME,
  TENANT_SETTING,
  hasGrant,
  requireTenantTx,
  tenantDbFromPool,
  withTenant,
  type TenantDb,
  type TenantTx,
} from '../tenancy/index.js';
import { isAck, pushTo, withoutTenant, type CapturingPublisher, type PushTarget } from './events.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  crossTenantPairs,
  seedRegistry,
  userPoolFanoutExpectation,
  type TenantFixture,
} from './fixtures.js';
import type { ThrowawaySchema } from './schema.js';

/** One catalog violation; `object` is `<schema>.<table>` for table findings and the role name for role findings. */
export interface CatalogFinding {
  kind:
    | 'rls-disabled'
    | 'rls-not-forced'
    | 'policy-missing-using'
    | 'policy-missing-check'
    | 'role-superuser'
    | 'role-bypassrls'
    | 'role-member-of-privileged';
  object: string;
  detail?: string;
}

/** What the catalog checks read: a throwaway schema handle or the same three members of another schema. */
export type CatalogHandle = Pick<ThrowawaySchema, 'adminPool' | 'schema' | 'roles'>;

/** Options of {@link checkCatalog}. */
export interface CatalogCheckOptions {
  /** Roles to check; defaults to the handle's owner, app and migrator roles. */
  roles?: readonly string[];
}

/** Name of a group of platform-provided service-schema tables. */
export type PlatformTableGroup = 'outbox' | 'events' | 'migrationKit' | 'tasks' | 'tenancy';

/** The tables a platform component creates in a service schema, split by whether RLS must guard them. */
export interface PlatformTables {
  readonly tenantOwned: readonly string[];
  readonly nonTenant: readonly string[];
}

const MIGRATION_KIT_NON_TENANT: readonly string[] = Object.freeze([
  UNIT_GATE_TABLE,
  OPEN_OPERATION_TABLE,
  MIGRATION_WATERMARK_TABLE,
]);

/** Platform tables per component; every service has `tenancy` and `migrationKit`, producers `outbox`, consumers `events`, task creators `tasks`. */
export const PLATFORM_TABLE_GROUPS: Readonly<Record<PlatformTableGroup, PlatformTables>> = Object.freeze({
  outbox: Object.freeze({ tenantOwned: Object.freeze([OUTBOX_TABLE]), nonTenant: Object.freeze([]) }),
  events: Object.freeze({
    tenantOwned: Object.freeze([INBOX_TABLE, CONSUMER_AGGREGATE_VERSION_TABLE]),
    nonTenant: Object.freeze([]),
  }),
  migrationKit: Object.freeze({
    tenantOwned: Object.freeze([CHANGELOG_TABLE, MIGRATION_BATCH_TABLE]),
    nonTenant: MIGRATION_KIT_NON_TENANT,
  }),
  tasks: Object.freeze({
    tenantOwned: Object.freeze([SCHEDULED_TASK_QUEUE_TABLE, SCHEDULED_TASK_QUEUE_STATE_TABLE]),
    nonTenant: Object.freeze([]),
  }),
  // The non-tenant tables no other component creates: tenant_registry and tenant_grant.
  tenancy: Object.freeze({
    tenantOwned: Object.freeze([]),
    nonTenant: Object.freeze(NON_TENANT_TABLES.filter((table) => !MIGRATION_KIT_NON_TENANT.includes(table))),
  }),
});

/** Options of {@link expectPlatformTables}. */
export interface PlatformTablesOptions {
  /** Defaults to `['tenancy', 'migrationKit']`, the tables every service schema has. */
  groups?: readonly PlatformTableGroup[];
}

interface TableRow {
  table: string;
  enabled: boolean;
  forced: boolean;
  using_cmds: string[];
  check_cmds: string[];
}

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

interface AncestorRow {
  member: string;
  ancestor: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

const TABLES_SQL = `
SELECT c.relname::text AS table,
       c.relrowsecurity AS enabled,
       c.relforcerowsecurity AS forced,
       coalesce(array_agg(p.polcmd::text) FILTER (WHERE p.polqual IS NOT NULL), '{}') AS using_cmds,
       coalesce(array_agg(p.polcmd::text) FILTER (WHERE p.polwithcheck IS NOT NULL), '{}') AS check_cmds
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policy p ON p.polrelid = c.oid
 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
 GROUP BY c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
 ORDER BY c.relname`;

const ROLES_SQL = 'SELECT rolname::text, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname';

// UNION, not UNION ALL, so a membership graph revisiting a role terminates.
const ANCESTORS_SQL = `
WITH RECURSIVE ancestry(member, ancestor) AS (
  SELECT r.rolname::text, m.roleid
    FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid
   WHERE r.rolname = ANY($1::text[])
  UNION
  SELECT a.member, m.roleid FROM ancestry a JOIN pg_auth_members m ON m.member = a.ancestor
)
SELECT DISTINCT a.member, g.rolname::text AS ancestor, g.rolsuper, g.rolbypassrls
  FROM ancestry a JOIN pg_roles g ON g.oid = a.ancestor
 WHERE g.rolsuper OR g.rolbypassrls
 ORDER BY 1, 2`;

// Commands needing USING and WITH CHECK when no `*` policy covers them; INSERT takes no USING, SELECT and DELETE no WITH CHECK.
const USING_COMMANDS = ['r', 'w', 'd'] as const;
const CHECK_COMMANDS = ['a', 'w'] as const;

function covers(commands: readonly string[], required: readonly string[]): boolean {
  return commands.includes('*') || required.every((command) => commands.includes(command));
}

/** The schema's ordinary and partitioned tables with their RLS flags and policy commands. */
async function readTables(handle: CatalogHandle): Promise<TableRow[]> {
  return (await handle.adminPool.query<TableRow>(TABLES_SQL, [handle.schema])).rows;
}

/** RLS violations on `tables`. */
function tableFindings(schema: string, tables: readonly TableRow[]): CatalogFinding[] {
  const findings: CatalogFinding[] = [];
  for (const row of tables) {
    const object = `${schema}.${row.table}`;
    if (!row.enabled) findings.push({ kind: 'rls-disabled', object });
    if (!row.forced) findings.push({ kind: 'rls-not-forced', object });
    if (!covers(row.using_cmds, USING_COMMANDS)) {
      findings.push({ kind: 'policy-missing-using', object, detail: `no ${RLS_POLICY_NAME} policy USING for SELECT, UPDATE and DELETE` });
    }
    if (!covers(row.check_cmds, CHECK_COMMANDS)) {
      findings.push({ kind: 'policy-missing-check', object, detail: `no ${RLS_POLICY_NAME} policy WITH CHECK for INSERT and UPDATE` });
    }
  }
  return findings;
}

function privileges(row: { rolsuper: boolean; rolbypassrls: boolean }): string {
  return [row.rolsuper ? 'SUPERUSER' : undefined, row.rolbypassrls ? 'BYPASSRLS' : undefined].filter(Boolean).join(', ');
}

/** Finds roles that are, or are members of, a SUPERUSER or BYPASSRLS role. */
async function roleFindings(handle: CatalogHandle, roles: readonly string[]): Promise<CatalogFinding[]> {
  const names = [...roles];
  const own = await handle.adminPool.query<RoleRow>(ROLES_SQL, [names]);
  const inherited = await handle.adminPool.query<AncestorRow>(ANCESTORS_SQL, [names]);
  const findings: CatalogFinding[] = [];
  for (const row of own.rows) {
    if (row.rolsuper) findings.push({ kind: 'role-superuser', object: row.rolname });
    if (row.rolbypassrls) findings.push({ kind: 'role-bypassrls', object: row.rolname });
  }
  for (const row of inherited.rows) {
    findings.push({ kind: 'role-member-of-privileged', object: row.member, detail: `member of ${row.ancestor} (${privileges(row)})` });
  }
  return findings;
}

/** Returns, without throwing, every RLS violation on the schema's tenant tables and every privileged role or membership. */
export async function checkCatalog(handle: CatalogHandle, opts: CatalogCheckOptions = {}): Promise<CatalogFinding[]> {
  const nonTenant: readonly string[] = NON_TENANT_TABLES;
  const tenantTables = (await readTables(handle)).filter((row) => !nonTenant.includes(row.table));
  const roles = opts.roles ?? Object.values(handle.roles);
  return [...tableFindings(handle.schema, tenantTables), ...(await roleFindings(handle, roles))];
}

/** One finding as a report line. */
function formatFinding(finding: CatalogFinding): string {
  return `${finding.kind} ${finding.object}${finding.detail === undefined ? '' : `: ${finding.detail}`}`;
}

/** Throws an Error listing each catalog finding on its own line when {@link checkCatalog} reports any. */
export async function expectNoCatalogFindings(handle: CatalogHandle, opts: CatalogCheckOptions = {}): Promise<void> {
  const findings = await checkCatalog(handle, opts);
  if (findings.length > 0) {
    throw new Error([`Catalog findings in schema ${handle.schema}:`, ...findings.map(formatFinding)].join('\n'));
  }
}

/** Throws an Error naming each platform table of `groups` missing from the schema and each RLS finding on the tenant-owned ones. */
export async function expectPlatformTables(handle: CatalogHandle, opts: PlatformTablesOptions = {}): Promise<void> {
  const groups = opts.groups ?? (['tenancy', 'migrationKit'] as const);
  const tenantOwned = new Set(groups.flatMap((group) => PLATFORM_TABLE_GROUPS[group].tenantOwned));
  const wanted = [...tenantOwned, ...groups.flatMap((group) => PLATFORM_TABLE_GROUPS[group].nonTenant)];
  const rows = await readTables(handle);
  const present = new Set(rows.map((row) => row.table));
  const missing = wanted.filter((table) => !present.has(table));
  const findings = tableFindings(
    handle.schema,
    rows.filter((row) => tenantOwned.has(row.table)),
  );
  if (missing.length > 0 || findings.length > 0) {
    throw new Error(
      [
        `Platform tables of ${groups.join(', ')} in schema ${handle.schema}:`,
        ...missing.map((table) => `missing ${handle.schema}.${table}`),
        ...findings.map(formatFinding),
      ].join('\n'),
    );
  }
}

/** The matchers the suite asserts with; vitest's `expect` satisfies it structurally. */
export interface SuiteExpectation {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeGreaterThanOrEqual(expected: number): void;
}

/** The test-runner functions the suite registers its cases with, such as vitest's `{describe, it, expect, beforeAll}`. */
export interface SuiteApi {
  describe(name: string, fn: () => void): unknown;
  it(name: string, fn: () => Promise<void>): unknown;
  expect(actual: unknown, message?: string): SuiteExpectation;
  /** When given, seeding runs in a before hook instead of a first setup case. */
  beforeAll?(fn: () => Promise<void>): unknown;
}

/** A migrated schema handle, or a getter of one the caller creates later, e.g. in its own `beforeAll`. */
export type IsolationDb = ThrowawaySchema | (() => ThrowawaySchema | undefined);

/** The service's push route and dead-letter publisher, for the tenantless-event case. */
export interface IsolationEventOptions {
  /** The app, or a getter of one the caller builds later, e.g. in its own `beforeAll`. */
  app: PushTarget | (() => PushTarget | undefined);
  subscription: string;
  /** A contract-valid envelope of the subscription's topic for `tenantId`. */
  envelopeFor(tenantId: string): EventEnvelope;
  publisher: CapturingPublisher;
}

/** A `userPool` fan-out consumer and the effect it leaves, for the fan-out case. */
export interface IsolationFanoutOptions {
  definition: ConsumerDefinition;
  /** A contract-valid envelope whose tenant is `tenant`. */
  envelopeFrom(tenant: TenantFixture): EventEnvelope;
  /** Number of effects of the fan-out envelope visible in `tx`. */
  effectsIn(tx: TenantTx): Promise<number>;
}

/** A data-created cross-tenant grant and the write it guards, for the grant case. */
export interface IsolationGrantOptions {
  kind: string;
  resourceId: string;
  /** Creates the grant to `grantee` through service code, inside the grantor's transaction `tx`. */
  grant(tx: TenantTx, grantee: TenantFixture): Promise<void>;
  /** Attempts the guarded write on `grantor`'s resource acting as `actingTenant`. */
  guardedWrite(grantor: TenantFixture, actingTenant: TenantFixture): Promise<'allowed' | 'denied'>;
}

/** Options of {@link defineIsolationSuite}. */
export interface IsolationSuiteOptions {
  db: IsolationDb;
  /** Label of the describe block; defaults to the schema of a direct handle. */
  name?: string;
  /** Tenant-owned business tables of the schema, each with a `tenant_id` column. */
  tables: readonly string[];
  /** Writes one row of `table` for `tenant` through the service's own repository code. */
  writeAs(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void>;
  /** Reads every row of `table` visible in `tx`, through service code or a plain SELECT. */
  readAs(tx: TenantTx, table: string): Promise<unknown[]>;
  event?: IsolationEventOptions;
  fanout?: IsolationFanoutOptions;
  grant?: IsolationGrantOptions;
}

/** SQLSTATE of a row-level security WITH CHECK violation. */
const RLS_VIOLATION = '42501';
const MISSING_TENANT: DeadLetterReason = 'missing-tenant';
/** Consumer segment of the subscription the fan-out case records its inbox receipts under. */
const FANOUT_CONSUMER = 'isolation';
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const noop = (): void => undefined;
const SILENT_LOGGER: ConsumeOptions['logger'] = {
  level: 'silent',
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  child: () => SILENT_LOGGER,
  isLevelEnabled: () => false,
  flush: (cb) => cb?.(),
};

/** `value`, or what its getter returns; throws naming `label` when a getter has nothing yet. */
function resolved<T extends object>(value: T | (() => T | undefined), label: string): T {
  const current = typeof value === 'function' ? (value as () => T | undefined)() : value;
  if (current === undefined) {
    throw new Error(`defineIsolationSuite: the ${label} getter returned undefined; create it in a beforeAll that runs first`);
  }
  return current;
}

function quoted(schema: string, table: string): string {
  return `"${schema}"."${table}"`;
}

function tenantLabel(tenant: TenantFixture): string {
  return `tenant ${tenant.key}`;
}

function tenantLabels(tenants: readonly TenantFixture[]): string {
  return tenants.length === 0 ? 'no tenant' : tenants.map(tenantLabel).join(' and ');
}

/** The SQLSTATE `work` failed with, or a description of its other outcome. */
async function sqlStateOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'no error';
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? code : `non-SQL error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** The lower-cased `tenant_id` or `tenantId` of a row a service read returned, when it carries one. */
function rowTenant(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const record = row as Record<string, unknown>;
  const value = record.tenant_id ?? record.tenantId;
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

/** Row counts of `table` per `tenant_id` among the rows visible in `tx`. */
async function countsByTenant(tx: TenantTx, schema: string, table: string): Promise<Map<string, number>> {
  const { rows } = await tx.query<{ tenant_id: string; n: number }>(
    `SELECT tenant_id::text AS tenant_id, count(*)::int AS n FROM ${quoted(schema, table)} GROUP BY tenant_id`,
  );
  return new Map(rows.map((row) => [row.tenant_id.toLowerCase(), row.n]));
}

/** Rows of each table visible to each fixture tenant, keyed `<key> <table>`. */
async function visibleCounts(db: ThrowawaySchema, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const tenant of TENANT_LIST) {
    await withTenant(db.app, tenant.tenantId, async (tx) => {
      for (const table of tables) {
        const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${quoted(db.schema, table)}`);
        counts[`${tenant.key} ${table}`] = rows[0]?.n ?? 0;
      }
    });
  }
  return counts;
}

/** The fan-out consumer's effect count per fixture key. */
async function effectCounts(db: TenantDb, fanout: IsolationFanoutOptions): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const tenant of TENANT_LIST) {
    counts[tenant.key] = await withTenant(db, tenant.tenantId, (tx) => fanout.effectsIn(tx));
  }
  return counts;
}

/** Upserts the fixture registry, then writes one row of every table for each fixture tenant in its own transaction. */
async function seed(db: ThrowawaySchema, options: IsolationSuiteOptions, tables: readonly string[]): Promise<void> {
  await seedRegistry(db.app);
  for (const tenant of TENANT_LIST) {
    for (const table of tables) {
      await withTenant(db.app, tenant.tenantId, (tx) => options.writeAs(tx, table, tenant));
    }
  }
}


/** What every case registration needs: the runner, the resolved schema and the validated table list. */
interface SuiteContext {
  api: SuiteApi;
  options: IsolationSuiteOptions;
  tables: readonly string[];
  /** The schema handle, without seeding. */
  resolve(): ThrowawaySchema;
  /** The schema handle once the fixture registry and rows are seeded. */
  ready(): Promise<ThrowawaySchema>;
}

function registerReadCases({ api, options, tables, ready }: SuiteContext): void {
  const { expect } = api;
  for (const table of tables) {
    for (const tenant of TENANT_LIST) {
      const who = tenantLabel(tenant);
      api.it(`${who} sees only its own rows in ${table}`, async () => {
        const db = await ready();
        await withTenant(db.app, tenant.tenantId, async (tx) => {
          const visible = await options.readAs(tx, table);
          const counts = await countsByTenant(tx, db.schema, table);
          const foreign = [...counts].filter(([tenantId]) => tenantId !== tenant.tenantId);
          expect(foreign, `rows of other tenants visible to ${who} in ${table}`).toEqual([]);
          expect(counts.get(tenant.tenantId) ?? 0, `seeded rows of ${who} in ${table}`).toBeGreaterThanOrEqual(1);
          expect(visible.length, `rows readAs returned for ${who} in ${table}`).toBeGreaterThanOrEqual(1);
          const mislabelled = visible.map(rowTenant).filter((tenantId) => tenantId !== undefined && tenantId !== tenant.tenantId);
          expect(mislabelled, `tenant ids of rows readAs returned for ${who} in ${table}`).toEqual([]);
        });
      });
    }
  }
}

function registerWriteCases({ api, tables, ready }: SuiteContext): void {
  const { expect } = api;
  for (const table of tables) {
    for (const { writer, reader } of crossTenantPairs()) {
      const [as, other] = [tenantLabel(writer), tenantLabel(reader)];
      api.it(`${as} cannot insert, move into, update or delete rows of ${other} in ${table}`, async () => {
        const db = await ready();
        const target = quoted(db.schema, table);
        const asWriter = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(db.app, writer.tenantId, fn);
        const inserted = await sqlStateOf(
          asWriter((tx) => tx.query(`INSERT INTO ${target} (tenant_id) VALUES ($1)`, [reader.tenantId])),
        );
        expect(inserted, `INSERT of a ${other} row as ${as} in ${table}`).toBe(RLS_VIOLATION);
        const moved = await sqlStateOf(
          asWriter((tx) =>
            tx.query(`UPDATE ${target} SET tenant_id = $1 WHERE tenant_id = $2`, [reader.tenantId, writer.tenantId]),
          ),
        );
        expect(moved, `UPDATE moving rows of ${as} to ${other} in ${table}`).toBe(RLS_VIOLATION);
        // Asserted inside the transaction, so an UPDATE or DELETE that did reach rows is rolled back.
        await asWriter(async (tx) => {
          const updated = await tx.query(`UPDATE ${target} SET tenant_id = tenant_id WHERE tenant_id = $1`, [reader.tenantId]);
          const deleted = await tx.query(`DELETE FROM ${target} WHERE tenant_id = $1`, [reader.tenantId]);
          expect(updated.rowCount, `rows of ${other} updated as ${as} in ${table}`).toBe(0);
          expect(deleted.rowCount, `rows of ${other} deleted as ${as} in ${table}`).toBe(0);
        });
      });
    }
  }
}

function registerPoolReuseCases({ api, tables, ready }: SuiteContext): void {
  const { expect } = api;
  for (const table of tables) {
    api.it(`a pooled connection reused after a tenant A transaction sees no rows of ${table} and cannot write it`, async () => {
      const db = await ready();
      const target = quoted(db.schema, table);
      const pool = db.connect('app', { max: 1 });
      const reused = tenantDbFromPool(pool, { schema: db.schema });
      try {
        const inside = await withTenant(reused, TENANT_A.tenantId, async (tx) => {
          const { rows } = await tx.query<{ pid: number; n: number }>(
            `SELECT pg_backend_pid() AS pid, (SELECT count(*)::int FROM ${target}) AS n`,
          );
          return rows[0];
        });
        const after = await pool.query<{ pid: number; tenant: string; n: number }>(
          `SELECT pg_backend_pid() AS pid, coalesce(current_setting($1, true), '') AS tenant, (SELECT count(*)::int FROM ${target}) AS n`,
          [TENANT_SETTING],
        );
        const inserted = await sqlStateOf(pool.query(`INSERT INTO ${target} (tenant_id) VALUES ($1)`, [TENANT_A.tenantId]));
        expect(inside?.n ?? 0, `rows of tenant A in ${table} inside its transaction`).toBeGreaterThanOrEqual(1);
        expect(after.rows[0], `the same connection after the transaction, in ${table}`).toEqual({ pid: inside?.pid, tenant: '', n: 0 });
        expect(inserted, `INSERT into ${table} on the reused connection`).toBe(RLS_VIOLATION);
      } finally {
        await reused.end();
      }
    });
  }
}

function registerCatalogAndGuardCases({ api, resolve }: SuiteContext): void {
  const { expect } = api;
  api.it('every tenant table has forced RLS with USING and WITH CHECK, and no schema role can bypass it', async () => {
    expect(await checkCatalog(resolve()), 'catalog findings').toEqual([]);
  });
  api.it('the repository guard refuses tenant work outside withTenant', async () => {
    const db = resolve();
    await withTenant(db.app, TENANT_A.tenantId, async (tx) => {
      expect(requireTenantTx(), 'the guard inside withTenant').toBe(tx);
    });
    let refusal: unknown;
    try {
      requireTenantTx();
    } catch (err) {
      refusal = err;
    }
    expect(refusal instanceof OutsideTenantTransactionError, 'requireTenantTx outside withTenant throws OutsideTenantTransactionError').toBe(true);
  });
}

function registerEventCase({ api, tables, ready }: SuiteContext, event: IsolationEventOptions): void {
  const { expect } = api;
  api.it(`an event without a tenant on ${event.subscription} is acked, dead-lettered as missing-tenant and changes no rows`, async () => {
    const db = await ready();
    const app = resolved(event.app, 'event.app');
    const before = await visibleCounts(db, tables);
    const earlier = event.publisher.deadLetters(event.subscription).length;
    const response = await pushTo(app, event.subscription, withoutTenant(event.envelopeFor(TENANT_A.tenantId)));
    const letters = event.publisher.deadLetters(event.subscription).slice(earlier);
    expect(isAck(response), `push answered ${String(response.statusCode)}`).toBe(true);
    expect(letters.map((letter) => letter.reason), `dead letters on ${event.subscription}`).toEqual([MISSING_TENANT]);
    expect(await visibleCounts(db, tables), 'business rows after the tenantless delivery').toEqual(before);
  });
}

function registerFanoutCase({ api, ready }: SuiteContext, fanout: IsolationFanoutOptions): void {
  const { expect } = api;
  const expected = userPoolFanoutExpectation(TENANT_UMBRELLA);
  const expectedTenants = [...expected].sort();
  const reached = TENANT_LIST.filter((tenant) => expected.has(tenant.tenantId));
  const spared = TENANT_LIST.filter((tenant) => !expected.has(tenant.tenantId));
  const topic = fanout.definition.topic;
  api.it(`a ${topic} fan-out from umbrella reaches ${tenantLabels(reached)} once each and never ${tenantLabels(spared)}`, async () => {
    const db = await ready();
    const envelope = fanout.envelopeFrom(TENANT_UMBRELLA);
    const consume = {
      subscription: subscriptionName(FANOUT_CONSUMER, topic),
      messageId: randomUUID(),
      logger: SILENT_LOGGER,
    } satisfies ConsumeOptions;
    const destinations = await destinationTenants(db.app, fanout.definition, envelope);
    expect([...destinations].sort(), 'registry-derived destination tenants').toEqual(expectedTenants);

    const before = await effectCounts(db.app, fanout);
    const first = await consumeEnvelope(db.app, fanout.definition, envelope, consume);
    const afterFirst = await effectCounts(db.app, fanout);
    const again = await consumeEnvelope(db.app, fanout.definition, envelope, consume);
    const afterAgain = await effectCounts(db.app, fanout);

    const outcomes = (outcome: typeof first): string[] => outcome.destinations.map((d) => `${d.tenantId} ${d.result}`).sort();
    expect(outcomes(first), 'first delivery outcomes').toEqual(expectedTenants.map((tenantId) => `${tenantId} applied`));
    expect(outcomes(again), 'redelivery outcomes').toEqual(expectedTenants.map((tenantId) => `${tenantId} duplicate`));
    for (const tenant of TENANT_LIST) {
      const added = (afterFirst[tenant.key] ?? 0) - (before[tenant.key] ?? 0);
      const message = `effects added in ${tenantLabel(tenant)}`;
      if (expected.has(tenant.tenantId)) {
        expect(added, message).toBeGreaterThanOrEqual(1);
      } else {
        expect(added, message).toBe(0);
      }
    }
    expect(afterAgain, 'effect counts after redelivery').toEqual(afterFirst);
  });
}

function registerGrantCase({ api, ready }: SuiteContext, grant: IsolationGrantOptions): void {
  const { expect } = api;
  api.it(`a tenant A ${grant.kind} grant to tenant B admits tenant B and not tenant umbrella`, async () => {
    const db = await ready();
    await withTenant(db.app, TENANT_A.tenantId, (tx) => grant.grant(tx, TENANT_B));
    const key = (grantee: TenantFixture) => ({
      grantor: TENANT_A.tenantId,
      grantee: grantee.tenantId,
      kind: grant.kind,
      resourceId: grant.resourceId,
    });
    expect(await hasGrant(db.app, key(TENANT_B)), 'stored grant to tenant B').toBe(true);
    expect(await hasGrant(db.app, key(TENANT_UMBRELLA)), 'stored grant to tenant umbrella').toBe(false);
    expect(await grant.guardedWrite(TENANT_A, TENANT_B), 'guarded write as tenant B').toBe('allowed');
    expect(await grant.guardedWrite(TENANT_A, TENANT_UMBRELLA), 'guarded write as tenant umbrella').toBe('denied');
  });
}

/**
 * Registers the tenant-isolation cases of one service schema under `api.describe`, plus the event, fan-out and grant cases
 * their options enable; the caller migrates the schema beforehand and drops it afterwards.
 */
export function defineIsolationSuite(api: SuiteApi, options: IsolationSuiteOptions): void {
  const tables = [...options.tables];
  const invalid = tables.filter((table) => !IDENTIFIER.test(table));
  if (tables.length === 0 || invalid.length > 0) {
    throw new TypeError(`defineIsolationSuite needs lower-case snake table names; got ${JSON.stringify(options.tables)}`);
  }
  const { db } = options;
  const resolve = (): ThrowawaySchema => resolved(db, 'db');
  const seeds = new WeakMap<ThrowawaySchema, Promise<void>>();
  const ready = async (): Promise<ThrowawaySchema> => {
    const handle = resolve();
    let seeding = seeds.get(handle);
    if (seeding === undefined) {
      seeding = seed(handle, options, tables);
      seeds.set(handle, seeding);
    }
    await seeding;
    return handle;
  };
  const context: SuiteContext = { api, options, tables, resolve, ready };
  const label = options.name ?? (typeof db === 'function' ? 'service schema' : db.schema);

  api.describe(`tenant isolation: ${label}`, () => {
    const seedCase = async (): Promise<void> => {
      await ready();
    };
    if (api.beforeAll === undefined) {
      api.it('seeds the fixture registry and one row per table for tenants A, B and umbrella', seedCase);
    } else {
      api.beforeAll(seedCase);
    }
    registerReadCases(context);
    registerWriteCases(context);
    registerPoolReuseCases(context);
    registerCatalogAndGuardCases(context);
    if (options.event !== undefined) registerEventCase(context, options.event);
    if (options.fanout !== undefined) registerFanoutCase(context, options.fanout);
    if (options.grant !== undefined) registerGrantCase(context, options.grant);
  });
}

