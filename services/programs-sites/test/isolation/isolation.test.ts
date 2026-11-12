/** Tenant isolation of the programs-sites schema, its site routes and its site registry consumer against PostgreSQL. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLATFORM_TABLE_GROUPS,
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  crossTenantPairs,
  defineIsolationSuite,
  expectPlatformTables,
  pgAvailable,
  pushTo,
  seedRegistry,
  testEnvelope,
  withoutTenant,
  type IsolationSuiteOptions,
  type PlatformTableGroup,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { OWNED_TABLES, SITE, SITE_MONITOR_STATE, UNITS } from '../../src/repo/tables.js';
import { buildTestApp, headersFor } from '../helpers/app.js';

type Tx = Parameters<IsolationSuiteOptions['writeAs']>[0];
type Row = Record<string, unknown>;
type ColumnType = (typeof SITE.columns)[number]['type'];
/** NOT NULL columns without a default, per table, mapped to their `char(n)` length or null. */
type RequiredColumns = Map<string, Map<string, number | null>>;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const SITE_CHANGED_TOPIC = 'programs-sites.site.changed.v1';
const RLS_VIOLATION = '42501';
const TIMESTAMP = '2026-06-30 12:00:00.000';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const ALL_PLATFORM_GROUPS = Object.keys(PLATFORM_TABLE_GROUPS) as PlatformTableGroup[];
const DEFINITIONS = new Map([...OWNED_TABLES, SITE_MONITOR_STATE].map((definition) => [definition.table, definition]));
const MONITOR = SITE_MONITOR_STATE.table;

const REQUIRED_COLUMNS_SQL = `
SELECT c.relname::text AS table, a.attname::text AS column,
       CASE WHEN a.atttypid = 'bpchar'::regtype THEN a.atttypmod - 4 END AS length
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull AND NOT a.atthasdef`;

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

let schema: ThrowawaySchema | undefined;
let required: RequiredColumns = new Map();

/** The schema the outer beforeAll created; throws when its creation failed. */
function created(): ThrowawaySchema {
  if (schema === undefined) {
    throw new Error('The throwaway programs-sites schema was not created; see the beforeAll failure');
  }
  return schema;
}

/** Reads the NOT NULL columns without a default of every table of `db`. */
async function requiredColumns(db: ThrowawaySchema): Promise<RequiredColumns> {
  const { rows } = await db.app.withMetadata((tx) =>
    tx.query<{ table: string; column: string; length: number | null }>(REQUIRED_COLUMNS_SQL, [db.schema]),
  );
  const tables: RequiredColumns = new Map();
  for (const { table, column, length } of rows) {
    tables.set(table, (tables.get(table) ?? new Map<string, number | null>()).set(column, length));
  }
  return tables;
}

/** SHA-256 hex digest of `seed`. */
function digest(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

/** A 35-character CF-format id derived from `seed`. */
function cfId(seed: string): string {
  const hex = digest(seed).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 32)}`;
}

/** A value of canonical type `type` derived from `seed`; text exactly fills a `char(length)` column. */
function valueFor(type: ColumnType, seed: string, length: number | null): unknown {
  switch (type) {
    case 's':
      return length === null || length === 35 ? cfId(seed) : digest(seed).repeat(Math.ceil(length / 64)).slice(0, length);
    case 'i':
      return Number.parseInt(digest(seed).slice(0, 7), 16) + 1;
    case 'f':
      return 1.5;
    case 'd':
      return '1.0000';
    case 't':
      return TIMESTAMP;
    case 'b':
      return Buffer.from(digest(seed), 'hex');
  }
}

/** A `table` row of `tenant` with only its NOT NULL columns without a default set; `variant` keeps rows of one tenant distinct. */
function rowOf(table: string, tenant: TenantFixture, variant: string): Row {
  const definition = DEFINITIONS.get(table);
  const columns = required.get(table);
  if (definition === undefined || columns === undefined) {
    throw new TypeError(`programs-sites has no table ${table} in schema ${created().schema}`);
  }
  const row: Row = {};
  for (const { name, type } of definition.columns) {
    if (name !== 'tenant_id' && columns.has(name)) {
      row[name] = valueFor(type, `${tenant.key}:${table}:${name}:${variant}`, columns.get(name) ?? null);
    }
  }
  return row;
}

/** The parameterised INSERT of `row` into `<schemaName>.<table>`. */
function insertOf(schemaName: string, table: string, row: Row): { text: string; values: unknown[] } {
  const names = Object.keys(row);
  const columns = names.map((name) => `"${name}"`).join(', ');
  const placeholders = names.map((_, index) => `$${String(index + 1)}`).join(', ');
  return { text: `INSERT INTO "${schemaName}"."${table}" (${columns}) VALUES (${placeholders})`, values: Object.values(row) };
}

/** Inserts `row` into `table` under the tenant of `tx`. */
async function insertRow(tx: Tx, table: string, row: Row): Promise<void> {
  const { text, values } = insertOf(tx.schema, table, { tenant_id: tx.tenantId, ...row });
  await tx.query(text, values);
}

/** Writes the seeded row of `table` for `tenant`. */
async function writeAs(tx: Tx, table: string, tenant: TenantFixture): Promise<void> {
  await insertRow(tx, table, rowOf(table, tenant, 'seed'));
}

/** Every row of `table` visible in `tx`. */
async function readAs(tx: Tx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT * FROM "${tx.schema}"."${table}"`)).rows;
}

/** Number of rows of `table` visible in `tx` that match `where`. */
async function countIn(tx: Pick<Tx, 'query' | 'schema'>, table: string, where = 'true', values: unknown[] = []): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tx.schema}"."${table}" WHERE ${where}`, values);
  return rows[0]?.n ?? 0;
}

/** The SQLSTATE `work` fails with, or 'no error'. */
async function sqlStateOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'no error';
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? code : `non-SQL error: ${String(err)}`;
  }
}

/** The SQLSTATE of a statement run in `tx` inside a savepoint that undoes it and keeps `tx` usable. */
async function sqlStateIn(tx: Tx, text: string, values: unknown[]): Promise<string> {
  await tx.query('SAVEPOINT isolation_case');
  const state = await sqlStateOf(tx.query(text, values));
  await tx.query('ROLLBACK TO SAVEPOINT isolation_case');
  return state;
}

/** A fixture's own site row with every integer setting 0, since settingsDAO.update binds them unquoted. */
function fixtureSiteRow(fixture: TenantFixture): Row {
  const integers = SITE.columns.filter(({ type }) => type === 'i').map(({ name }) => [name, 0] as const);
  return {
    ...rowOf(SITE.table, fixture, 'app'),
    ...Object.fromEntries(integers),
    siteid: fixture.siteId,
    site: `Isolation site ${fixture.key}`,
  };
}

/** Builds the programs-sites app over the throwaway schema. */
function startApp(db: ThrowawaySchema['app']) {
  return buildTestApp({ db });
}

type AppContext = Awaited<ReturnType<typeof startApp>>;

describe.skipIf(!available)('programs-sites tenant isolation', () => {
  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'programs-sites', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app);
    required = await requiredColumns(schema);
  });

  afterAll(async () => {
    await schema?.drop();
  });

  it('creates the outbox, event, migration-kit, task and tenancy tables with RLS forced on the tenant-owned ones', async () => {
    await expectPlatformTables(created(), { groups: ALL_PLATFORM_GROUPS });
  });

  // The shared suite also asserts the catalog: forced RLS with USING and WITH CHECK on every tenant table, sitemonitor_state
  // included, and no schema role that is or inherits SUPERUSER or BYPASSRLS.
  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    {
      db: () => schema,
      name: 'programs-sites owned tables',
      tables: OWNED_TABLES.map(({ table }) => table),
      writeAs,
      readAs,
      rowFor: (table, tenant) => rowOf(table, tenant, 'probe'),
    },
  );

  // sitemonitor_state holds one row per tenant (CHECK id = 1), so the shared suite's fresh-row insert beside a seeded
  // row cannot succeed; its cases run here against the seeded row itself.
  describe(`${MONITOR}, one row per tenant`, () => {
    beforeAll(async () => {
      for (const tenant of TENANT_LIST) {
        await created().app.withTenant(tenant.tenantId, (tx) => writeAs(tx, MONITOR, tenant));
      }
    });

    for (const tenant of TENANT_LIST) {
      it(`tenant ${tenant.key} sees only its own ${MONITOR} row`, async () => {
        const rows = await created().app.withTenant(tenant.tenantId, (tx) => readAs(tx, MONITOR));
        expect(rows.map((row) => (row as Row).tenant_id)).toEqual([tenant.tenantId]);
      });
    }

    for (const { writer, reader } of crossTenantPairs()) {
      it(`tenant ${writer.key} cannot insert, move into, update or delete the ${MONITOR} row of tenant ${reader.key}`, async () => {
        await created().app.withTenant(writer.tenantId, async (tx) => {
          const target = `"${tx.schema}"."${MONITOR}"`;
          const foreign = insertOf(tx.schema, MONITOR, { tenant_id: reader.tenantId, ...rowOf(MONITOR, reader, 'probe') });
          const move = `UPDATE ${target} SET tenant_id = $1 WHERE tenant_id = $2`;
          const touch = `UPDATE ${target} SET last_monitored = last_monitored WHERE tenant_id = $1`;
          expect(await sqlStateIn(tx, foreign.text, foreign.values), 'INSERT of a foreign row').toBe(RLS_VIOLATION);
          expect(await sqlStateIn(tx, move, [reader.tenantId, writer.tenantId]), 'UPDATE moving the own row').toBe(RLS_VIOLATION);
          // Asserted inside the transaction, so an UPDATE or DELETE that did reach a foreign row is rolled back.
          const own = await tx.query(touch, [writer.tenantId]);
          const updated = await tx.query(touch, [reader.tenantId]);
          const deleted = await tx.query(`DELETE FROM ${target} WHERE tenant_id = $1`, [reader.tenantId]);
          expect([own.rowCount, updated.rowCount, deleted.rowCount], 'own, foreign updated, foreign deleted').toEqual([1, 0, 0]);
        });
      });
    }

    it(`a pooled connection reused after a tenant A transaction sees no ${MONITOR} row and cannot write it`, async () => {
      const db = created();
      const target = `"${db.schema}"."${MONITOR}"`;
      const insert = insertOf(db.schema, MONITOR, { tenant_id: TENANT_A.tenantId, ...rowOf(MONITOR, TENANT_A, 'probe') });
      const count = `SELECT pg_backend_pid() AS pid, (SELECT count(*)::int FROM ${target}) AS n`;
      const pool = db.connect('app', { max: 1 });
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A.tenantId]);
          const inside = (await client.query<{ pid: number; n: number }>(count)).rows[0];
          await client.query('COMMIT');
          const after = (await client.query<{ pid: number; n: number }>(count)).rows[0];
          const write = await sqlStateOf(client.query(insert.text, insert.values));
          expect({ inside: inside?.n, after, write }).toEqual({ inside: 1, after: { pid: inside?.pid, n: 0 }, write: RLS_VIOLATION });
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    });
  });

  describe('site access through the app', () => {
    let ctx: AppContext | undefined;

    /** The app the beforeAll built; throws when building it failed. */
    function service(): AppContext {
      if (ctx === undefined) {
        throw new Error('The programs-sites app was not built; see the beforeAll failure');
      }
      return ctx;
    }

    /** Injects a request carrying a tenant A token of the ROLE_SET subject `subject`, with `form` as its urlencoded body. */
    async function inject(method: 'GET' | 'POST', url: string, subject: string, form?: Record<string, string>) {
      const headers = await headersFor(subject, { site: TENANT_A.siteId });
      if (form === undefined) {
        return service().app.inject({ method, url, headers });
      }
      return service().app.inject({ method, url, headers: { ...headers, ...FORM }, payload: new URLSearchParams(form).toString() });
    }

    /** Site ids stored under `tenant`. */
    async function storedSiteIds(tenant: TenantFixture): Promise<string[]> {
      const rows = await created().app.withTenant(tenant.tenantId, (tx) => readAs(tx, SITE.table));
      return rows.map((row) => String((row as Row).siteid));
    }

    /** Changelog and outbox rows stored under `tenant`. */
    function auditRows(tenant: TenantFixture): Promise<{ changelog: number; outbox: number }> {
      return created().app.withTenant(tenant.tenantId, async (tx) => ({
        changelog: await countIn(tx, 'changelog'),
        outbox: await countIn(tx, 'outbox'),
      }));
    }

    beforeAll(async () => {
      const db = created().app;
      for (const fixture of TENANT_LIST) {
        await db.withTenant(fixture.tenantId, (tx) => insertRow(tx, SITE.table, fixtureSiteRow(fixture)));
      }
      ctx = await startApp(db);
      // Opened after the build, whose onReady inserts every missing gate as `legacy`.
      await db.withMetadata((tx) =>
        tx.query(
          `INSERT INTO "${tx.schema}".unit_gate (unit, state, holder_id, phase) SELECT unnest($1::text[]), 'open', NULL, 'quiet'
           ON CONFLICT (unit) DO UPDATE SET state = 'open', holder_id = NULL, phase = 'quiet'`,
          [[...UNITS]],
        ),
      );
    });

    afterAll(async () => {
      await ctx?.app.close();
    });

    it('lists the site of every registered tenant for an s2 token', async () => {
      const res = await inject('GET', '/v1/sites', 's2');
      expect(res.statusCode).toBe(200);
      const listed = res
        .json<Array<{ siteid: string }>>()
        .map(({ siteid }) => siteid)
        .sort();
      const stored: string[] = [];
      for (const tenant of TENANT_LIST) {
        stored.push(...(await storedSiteIds(tenant)));
      }
      expect(listed).toEqual(expect.arrayContaining([TENANT_A.siteId, TENANT_B.siteId, TENANT_UMBRELLA.siteId]));
      expect(listed).toEqual(stored.sort());
    });

    it('refuses the site list to a tenant A site-admin', async () => {
      const res = await inject('GET', '/v1/sites', 'site-admin');
      expect(res.statusCode).toBe(403);
    });

    it('lets a tenant A site-admin read its own site and refuses the site of tenant B', async () => {
      const own = await inject('GET', `/v1/sites/${TENANT_A.siteId}`, 'site-admin');
      const other = await inject('GET', `/v1/sites/${TENANT_B.siteId}`, 'site-admin');
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({ isNew: 0, site: { SiteID: TENANT_A.siteId, Site: `Isolation site ${TENANT_A.key}` } });
      expect(other.statusCode).toBe(403);
    });

    it('lets a tenant A site-admin update only its own site and never writes tenant B', async () => {
      const db = created().app;
      const tenantBRows = (): Promise<unknown[]> => db.withTenant(TENANT_B.tenantId, (tx) => readAs(tx, SITE.table));
      const before = await tenantBRows();
      const form = (siteId: string, name: string): Record<string, string> => ({
        siteid: siteId,
        action: 'Update',
        site: name,
        csrf_token: 'isolation-token',
        csrf_token_expires: '260630130000000',
      });

      const own = await inject('POST', `/v1/sites/${TENANT_A.siteId}/update`, 'site-admin', form(TENANT_A.siteId, 'Renamed A'));
      const other = await inject('POST', `/v1/sites/${TENANT_B.siteId}/update`, 'site-admin', form(TENANT_B.siteId, 'Renamed B'));

      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({ written: true, errors: {}, site: { SiteID: TENANT_A.siteId, Site: 'Renamed A' } });
      expect(other.statusCode).toBe(403);
      const updated = await db.withTenant(TENANT_A.tenantId, (tx) =>
        tx.query(`SELECT site, row_version FROM "${tx.schema}"."${SITE.table}" WHERE siteid = $1`, [TENANT_A.siteId]),
      );
      expect(updated.rows).toEqual([{ site: 'Renamed A', row_version: '1' }]);
      const ownAudit = await auditRows(TENANT_A);
      expect(ownAudit.changelog).toBeGreaterThan(0);
      expect(ownAudit.outbox).toBeGreaterThan(0);
      expect(await tenantBRows()).toEqual(before);
      expect(await auditRows(TENANT_B)).toEqual({ changelog: 0, outbox: 0 });
    });

    it('dead-letters and acks a site.changed event without a tenant and records nothing', async () => {
      const { app, publisher } = service();
      const db = created().app;
      const siteId = 'iso-unregistered';
      publisher.clear();
      const envelope = withoutTenant(
        testEnvelope({
          topic: SITE_CHANGED_TOPIC,
          tenantId: TENANT_A.tenantId,
          aggregateId: siteId,
          aggregateVersion: 1,
          payload: {
            siteId,
            publicUserPoolId: siteId,
            privateUserPoolId: siteId,
            categoryPoolId: siteId,
            filePoolId: siteId,
            displayPoolId: siteId,
            contentPoolIds: [siteId],
            domains: [],
          },
        }),
      );

      const res = await pushTo(app, SITE_CHANGED_SUBSCRIPTION, envelope);

      expect(res.statusCode).toBe(204);
      expect(publisher.raw.map(({ topic, message }) => ({ topic, reason: message.attributes.reason }))).toEqual([
        { topic: `${SITE_CHANGED_SUBSCRIPTION}.dlq`, reason: 'missing-tenant' },
      ]);
      expect(publisher.published).toEqual([]);
      for (const tenant of TENANT_LIST) {
        const receipts = await db.withTenant(tenant.tenantId, (tx) => countIn(tx, 'inbox', 'event_id = $1', [envelope.eventId]));
        expect(receipts, `inbox receipts of tenant ${tenant.key}`).toBe(0);
      }
      const registry = await db.withMetadata((tx) =>
        tx.query<{ site_id: string }>(`SELECT site_id FROM "${tx.schema}".tenant_registry ORDER BY site_id`),
      );
      expect(registry.rows.map(({ site_id }) => site_id)).toEqual([TENANT_A.siteId, TENANT_B.siteId, TENANT_UMBRELLA.siteId]);
    });
  });
});
