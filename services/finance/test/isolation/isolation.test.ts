// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Tenant isolation of the finance schema, its record routes and its site registry consumer against PostgreSQL. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SITE_CHANGED_TOPIC, tenantDbFromPool, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createCapturingPublisher,
  createThrowawaySchema,
  defineIsolationSuite,
  expectPlatformTables,
  pgAvailable,
  registryPayloads,
  seedRegistry,
  testEnvelope,
  type InjectResponse,
  type PlatformTableGroup,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { createFinanceRepository, type FinanceRepository } from '../../src/repo/repository.js';
import {
  FINANCE_ATTACHMENT,
  FINANCE_RECORD,
  FINANCE_RECORD_VERSION,
  FINANCE_ROLLUP,
  OWNED_TABLES,
  PROGRAM_BINDING,
  UNITS,
  type FinanceRecordRow,
  type FinanceRollupRow,
  type ProgramBindingRow,
} from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { TEST_CLOCK, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { PROGRAM_FOR_SITE, attachmentRow, programBindingRow, recordRow, versionRow } from '../helpers/records.js';

type Row = Record<string, unknown>;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
// Finance publishes no events and schedules no tasks, so its migration creates no outbox or task queue tables.
const PLATFORM_GROUPS: readonly PlatformTableGroup[] = ['tenancy', 'migrationKit', 'events'];
const V1_RECORDS = '/v1/finance/records';
const FIXTURE_RECORDS = `${FIXTURE_PREFIX}/records`;
const READER = 'finance.approver';
const RLS_VIOLATION = '42501';
const MISSING_ID = '00000000-0000-0000-0000000000000000';
// umbrella has no Program_<id> schema in synthetic.program_site; its rows take a program id no fixture site uses.
const UMBRELLA_PROGRAM_ID = 3;
const ATTACHMENT = { fileName: 'isolation.pdf', contentType: 'application/pdf', bytes: '%PDF-1.4 isolation' } as const;

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());
const publisher = createCapturingPublisher();

let schema: ThrowawaySchema | undefined;
let service: TestApp<TenantDb> | undefined;
let repository: FinanceRepository | undefined;
let rollupPeriods = 0;

/** What the outer beforeAll built; throws when building it failed. */
function built(): { schema: ThrowawaySchema; service: TestApp<TenantDb>; repository: FinanceRepository } {
  if (schema === undefined || service === undefined || repository === undefined) {
    throw new Error('The throwaway finance schema or app was not built; see the beforeAll failure');
  }
  return { schema, service, repository };
}

/** Title prefix of every record written for `tenant`, so a response body can be searched for its data. */
function titleOf(tenant: TenantFixture): string {
  return `Isolation ${tenant.key}`;
}

function programOf(tenant: TenantFixture): number {
  return PROGRAM_FOR_SITE[tenant.siteId] ?? UMBRELLA_PROGRAM_ID;
}

/** A fresh record of `tenant`. */
function recordOf(tenant: TenantFixture, title = titleOf(tenant)): FinanceRecordRow {
  return recordRow({ siteid: tenant.siteId, legacyProgramId: programOf(tenant), title });
}

/** A rollup row of `tenant` under a period no earlier call used, so every row meets the primary key. */
function rollupOf(tenant: TenantFixture): FinanceRollupRow {
  rollupPeriods += 1;
  return {
    tenant_id: tenant.tenantId,
    period: `${String(2000 + rollupPeriods)}-06`,
    state: 'APPROVED',
    record_count: 1,
    total_amount: '100.0000',
    computed_at: TEST_CLOCK.now(),
    legacy_program_id: programOf(tenant),
    row_version: '1',
  };
}

/** A fresh complete row of the unit table `table` for `tenant`. */
function rowFor(table: string, tenant: TenantFixture): Row {
  switch (table) {
    case FINANCE_RECORD.table:
      return recordOf(tenant);
    case FINANCE_RECORD_VERSION.table:
      return versionRow(recordOf(tenant), { action: 'create', version: 1 });
    case FINANCE_ATTACHMENT.table:
      return attachmentRow(recordOf(tenant), ATTACHMENT).row;
    case FINANCE_ROLLUP.table:
      return rollupOf(tenant);
    default:
      throw new TypeError(`finance has no unit table ${table}`);
  }
}

/** Writes a fresh row of `table` for `tenant` through the finance repository, so its unit gate and changelog hooks run. */
async function writeAs(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  await built().repository.insert(tx, table, rowFor(table, tenant));
}

/** Every row of `table` visible in `tx`; RLS is the only filter. */
async function readAs(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT * FROM "${tx.schema}"."${table}"`)).rows;
}

/** A contract-valid site.changed envelope of the tenant-a site under `tenantId`. */
function siteChanged(tenantId: string) {
  const payload = registryPayloads().find(({ siteId }) => siteId === TENANT_A.siteId);
  if (payload === undefined) throw new Error('registryPayloads() has no tenant-a site');
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId, aggregateId: TENANT_A.siteId, aggregateVersion: 1, payload });
}

/** The SQLSTATE of `text` run in `tx` inside a savepoint that undoes it and keeps `tx` usable, or 'no error'. */
async function sqlStateIn(tx: TenantTx, text: string, values: unknown[]): Promise<string> {
  await tx.query('SAVEPOINT isolation_case');
  try {
    await tx.query(text, values);
    return 'no error';
  } catch (err) {
    return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : String(err);
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT isolation_case');
  }
}

/** The parameterised INSERT of `row` into `<schemaName>.<table>`. */
function insertOf(schemaName: string, table: string, row: Row): { text: string; values: unknown[] } {
  const names = Object.keys(row);
  const columns = names.map((name) => `"${name}"`).join(', ');
  const placeholders = names.map((_, index) => `$${String(index + 1)}`).join(', ');
  return { text: `INSERT INTO "${schemaName}"."${table}" (${columns}) VALUES (${placeholders})`, values: Object.values(row) };
}

describe.skipIf(!available)('finance tenant isolation', () => {
  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'finance', migrationsDir: MIGRATIONS_DIR });
    const stagingDb = tenantDbFromPool(schema.connect('app', { max: 1 }), { schema: schema.schema });
    await seedRegistry(schema.app, schema.schema);
    service = await buildTestApp({ db: schema.app, stagingDb, publisher });
    repository = createFinanceRepository({ db: schema.app, stagingDb, storage: service.storage, clock: TEST_CLOCK });
    // Opened after the build, whose onReady inserts every missing gate as `legacy`.
    await schema.app.withMetadata((tx) =>
      tx.query(
        `INSERT INTO "${tx.schema}".unit_gate (unit, state, holder_id, phase) SELECT unnest($1::text[]), 'open', NULL, 'quiet'
         ON CONFLICT (unit) DO UPDATE SET state = 'open', holder_id = NULL, phase = 'quiet'`,
        [[...UNITS]],
      ),
    );
  });

  afterAll(async () => {
    try {
      await service?.app.close();
    } finally {
      // drop() ends every pool the schema opened, the staging pool included, then removes the schema and its roles.
      await schema?.drop();
    }
  });

  it('creates the tenancy, migration-kit and inbox tables with RLS forced on the tenant-owned ones', async () => {
    await expectPlatformTables(built().schema, { groups: PLATFORM_GROUPS });
  });

  // The shared suite also asserts the catalog: forced RLS with USING and WITH CHECK on every finance table, program_binding and
  // staged_object included, and no schema role that is or inherits SUPERUSER or BYPASSRLS.
  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    {
      db: () => schema,
      name: 'finance unit tables',
      tables: OWNED_TABLES.map(({ table }) => table),
      writeAs,
      readAs,
      rowFor,
      event: { app: () => service?.app, subscription: SITE_CHANGED_SUBSCRIPTION, envelopeFor: siteChanged, publisher },
    },
  );

  describe('record routes, tenant from the token only', () => {
    const FOREIGN_RECORD = recordOf(TENANT_A, `${titleOf(TENANT_A)} route record 1`);
    const ROUTE_RECORDS: readonly FinanceRecordRow[] = [
      FOREIGN_RECORD,
      recordOf(TENANT_A, `${titleOf(TENANT_A)} route record 2`),
      recordOf(TENANT_B, `${titleOf(TENANT_B)} route record 1`),
      recordOf(TENANT_B, `${titleOf(TENANT_B)} route record 2`),
    ];

    /** Record ids stored under `tenant`, read under its RLS, sorted. */
    async function storedIds(tenant: TenantFixture): Promise<string[]> {
      const rows = await withTenant(built().schema.app, tenant.tenantId, (tx) => readAs(tx, FINANCE_RECORD.table));
      return rows.map((row) => (row as FinanceRecordRow).record_id).sort();
    }

    /** GETs `url` with a finance.approver token of `tenant`'s site. */
    async function get(url: string, tenant: TenantFixture): Promise<InjectResponse> {
      const headers = await headersFor(READER, { site: tenant.siteId });
      return built().service.app.inject({ method: 'GET', url, headers });
    }

    /** Ids of `tenant`'s stored records that occur in `body`, plus its title marker when present. */
    async function leakedFrom(tenant: TenantFixture, body: string): Promise<string[]> {
      const markers = [...(await storedIds(tenant)), titleOf(tenant)];
      return markers.filter((marker) => body.includes(marker));
    }

    /** Status and envelope of an answer, without its echoed params. */
    function answerOf(res: InjectResponse): Row {
      const body = res.json<Row>();
      return { status: res.statusCode, apiversion: body.apiversion, method: body.method, error: body.error };
    }

    beforeAll(async () => {
      const { schema: db, repository: repo } = built();
      for (const tenant of [TENANT_A, TENANT_B]) {
        await withTenant(db.app, tenant.tenantId, (tx) => repo.insert(tx, PROGRAM_BINDING.table, programBindingRow(tenant.siteId)));
      }
      for (const row of ROUTE_RECORDS) {
        await withTenant(db.app, row.tenant_id, (tx) => repo.insert(tx, FINANCE_RECORD.table, row));
      }
    });

    it.each([
      { reader: TENANT_B, other: TENANT_A },
      { reader: TENANT_A, other: TENANT_B },
    ])('a tenant $reader.key token lists every tenant $reader.key record and none of tenant $other.key', async ({ reader, other }) => {
      const own = await storedIds(reader);
      const v1 = await get(`${V1_RECORDS}?siteid=${reader.siteId}`, reader);
      const fixture = await get(`${FIXTURE_RECORDS}?siteid=${reader.siteId}&itemsPerPage=1000`, reader);
      const listed = v1.json<{ data: Array<{ record_id: string }>; total: number }>();
      const envelope = fixture.json<{ apiversion: string; method: string; data: { items: Array<{ record_id: string }>; totalitems: number } }>();

      expect(own).toEqual(expect.arrayContaining(ROUTE_RECORDS.filter((row) => row.tenant_id === reader.tenantId).map((row) => row.record_id)));
      expect([v1.statusCode, fixture.statusCode]).toEqual([200, 200]);
      expect(listed.data.map((row) => row.record_id).sort()).toEqual(own);
      expect(listed.total).toBe(own.length);
      expect([envelope.apiversion, envelope.method, envelope.data.totalitems]).toEqual(['v1', 'finance.records', own.length]);
      expect(envelope.data.items.map((row) => row.record_id).sort()).toEqual(own);
      expect(await leakedFrom(other, v1.body), 'tenant data in the /v1 list').toEqual([]);
      expect(await leakedFrom(other, fixture.body), 'tenant data in the fixture list').toEqual([]);
    });

    it.each([
      `${V1_RECORDS}/:id`,
      `${V1_RECORDS}/:id/versions`,
      `${V1_RECORDS}/:id/attachments`,
      '/v2/finance/records/:id',
      `${FIXTURE_RECORDS}/:id`,
      `${FIXTURE_RECORDS}/:id/versions`,
      `${FIXTURE_RECORDS}/:id/attachments`,
    ])('a tenant B token gets the never-stored answer for a tenant A record on %s', async (path) => {
      const foreign = await get(path.replace(':id', FOREIGN_RECORD.record_id), TENANT_B);
      const missing = await get(path.replace(':id', MISSING_ID), TENANT_B);

      expect(answerOf(foreign)).toMatchObject({ status: 404, apiversion: 'v1', error: { code: 'invalid_request', message: 'Not Found' } });
      expect(answerOf(foreign)).toEqual(answerOf(missing));
      expect(foreign.body).not.toContain(FOREIGN_RECORD.title);
    });

    it.each([V1_RECORDS, FIXTURE_RECORDS])('refuses a tenant B token naming siteid tenant-a on %s with 403 and no tenant A data', async (url) => {
      const res = await get(`${url}?siteid=${TENANT_A.siteId}`, TENANT_B);

      expect(res.statusCode).toBe(403);
      expect(res.json()).not.toHaveProperty('data');
      expect(await leakedFrom(TENANT_A, res.body)).toEqual([]);
    });

    it.each([
      { tenant: TENANT_A, bindings: [{ site_id: TENANT_A.siteId, legacy_program_id: PROGRAM_FOR_SITE[TENANT_A.siteId] }] },
      { tenant: TENANT_B, bindings: [{ site_id: TENANT_B.siteId, legacy_program_id: PROGRAM_FOR_SITE[TENANT_B.siteId] }] },
      { tenant: TENANT_UMBRELLA, bindings: [] },
    ])('tenant $tenant.key reads only its own program binding', async ({ tenant, bindings }) => {
      const { rows } = await withTenant(built().schema.app, tenant.tenantId, (tx) =>
        tx.query<Pick<ProgramBindingRow, 'site_id' | 'legacy_program_id'>>(
          `SELECT site_id, legacy_program_id FROM "${tx.schema}"."${PROGRAM_BINDING.table}"`,
        ),
      );
      expect(rows).toEqual(bindings);
    });

    it('refuses the tenant A program binding inside a tenant B transaction', async () => {
      const { text, values } = insertOf(built().schema.schema, PROGRAM_BINDING.table, programBindingRow(TENANT_A.siteId));
      const state = await withTenant(built().schema.app, TENANT_B.tenantId, (tx) => sqlStateIn(tx, text, values));
      expect(state).toBe(RLS_VIOLATION);
    });
  });
});
