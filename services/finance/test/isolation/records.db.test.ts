// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance record transitions over a throwaway `finance` schema as the app role: atomic audit, unit gates and the reported write position. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GATE_WAIT_MS,
  WRITE_POSITION_HEADER,
  closeGates,
  decodeRow,
  openGates,
  parseWritePosition,
  setGatePhase,
} from '@opt2/platform/migration-kit';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import { tenantDbFromPool, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  FINANCE_RECORD,
  FINANCE_RECORD_VERSION,
  FINANCE_ROLLUP,
  PROGRAM_BINDING,
  UNITS,
  type FinanceRecordRow,
  type FinanceRecordVersionRow,
} from '../../src/repo/tables.js';
import { buildTestApp, headersFor } from '../helpers/app.js';
import { programBindingRow, recordRow } from '../helpers/records.js';

/** One `<schema>.changelog` row, its xid as decimal text. */
interface ChangeRow {
  xid: string;
  table: string;
  op: string;
  key: string;
  before: string | null;
  after: string | null;
  columns: string[];
  origin: string;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const PREPARER_ID = 'AAAAAAAA-1111-2222-3333444455556666';
const SETUP_HOLDER = 'records-db-test-setup';
const SEEDED_VERSION = 3;
const TRANSITION_UNITS = [FINANCE_RECORD.unit, FINANCE_RECORD_VERSION.unit, FINANCE_ROLLUP.unit];
const STEP_REAL_MS = 25;
const STEP_FAKE_MS = 1_000;
const LEGACY_UNAVAILABLE = { apiversion: 'v1', method: expect.any(String), error: { message: 'Unhandled Exception', code: 'server_error' } };

const sentinel = recordRow({ version: SEEDED_VERSION, title: 'Rollback sentinel' });

const FAULT_SQL = `
-- Fails the changelog insert of the sentinel record's version row, after its record update, in the same transaction.
CREATE FUNCTION finance.fail_sentinel_version_changelog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."table" = '${FINANCE_RECORD_VERSION.table}' AND strpos(NEW.after, '${sentinel.record_id}') > 0 THEN
    RAISE EXCEPTION 'injected changelog failure for record ${sentinel.record_id}';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fail_sentinel_version_changelog BEFORE INSERT ON finance.changelog
  FOR EACH ROW EXECUTE FUNCTION finance.fail_sentinel_version_changelog();
`;

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!available)('finance record writes', () => {
  let handle: ThrowawaySchema | undefined;
  let app: FastifyInstance | undefined;

  /** The built schema and app; throws when beforeAll failed to build them. */
  function built(): { handle: ThrowawaySchema; app: FastifyInstance } {
    if (handle === undefined || app === undefined) throw new Error('The throwaway finance schema or app was not built; see the beforeAll failure');
    return { handle, app };
  }

  /** Inserts `row` into `table` of the throwaway schema, outside the repository, so no changelog row is written. */
  async function insertRow(tx: TenantTx, table: string, row: Readonly<Record<string, unknown>>): Promise<void> {
    const columns = Object.keys(row);
    await tx.query(
      `INSERT INTO ${built().handle.schema}.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  /** Stores `row` as a tenant-a record with an empty changelog and returns it. */
  async function seedRecord(row: FinanceRecordRow = recordRow({ version: SEEDED_VERSION })): Promise<FinanceRecordRow> {
    await withTenant(built().handle.app, TENANT_A.tenantId, (tx) => insertRow(tx, FINANCE_RECORD.table, row));
    return row;
  }

  /** Posts the `submit` transition of record `id` as a tenant-a preparer. */
  async function submit(id: string) {
    const headers = await headersFor('finance.preparer', { site: TENANT_A.siteId, sub: PREPARER_ID });
    return built().app.inject({ method: 'POST', url: `/v1/finance/records/${id}/transitions/submit`, headers });
  }

  /** Gets record `id` as a tenant-a approver. */
  async function read(id: string) {
    const headers = await headersFor('finance.approver', { site: TENANT_A.siteId });
    return built().app.inject({ method: 'GET', url: `/v1/finance/records/${id}`, headers });
  }

  /** The record row, its version rows and the changelog rows naming record `id`, read in tenant-a as the app role. */
  async function rowsFor(id: string): Promise<{ record: FinanceRecordRow | undefined; versions: FinanceRecordVersionRow[]; changes: ChangeRow[] }> {
    const { schema } = built().handle;
    return withTenant(built().handle.app, TENANT_A.tenantId, async (tx) => {
      const records = await tx.query<FinanceRecordRow>(`SELECT * FROM ${schema}.${FINANCE_RECORD.table} WHERE record_id = $1`, [id]);
      const versions = await tx.query<FinanceRecordVersionRow>(
        `SELECT * FROM ${schema}.${FINANCE_RECORD_VERSION.table} WHERE record_id = $1 ORDER BY version`,
        [id],
      );
      const changes = await tx.query<ChangeRow>(
        `SELECT xid::text AS xid, "table", op, key, before, after, columns, origin FROM ${schema}.changelog
          WHERE strpos(key || coalesce(before, '') || coalesce(after, ''), $1) > 0 ORDER BY seq`,
        [id],
      );
      return { record: records.rows[0], versions: versions.rows, changes: changes.rows };
    });
  }

  /** Settles `work` with only Date faked, stepped a second per real 25 ms so gate budgets elapse quickly; returns the faked time it took. */
  async function onSteppedClock<T>(work: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const started = Date.now();
      let settled = false;
      const pending = work().finally(() => {
        settled = true;
      });
      while (!settled) {
        await new Promise((resolve) => setTimeout(resolve, STEP_REAL_MS));
        vi.setSystemTime(Date.now() + STEP_FAKE_MS);
      }
      const result = await pending;
      return { result, elapsedMs: Date.now() - started };
    } finally {
      vi.useRealTimers();
    }
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'finance', migrationsDir: MIGRATIONS_DIR, extraSql: [FAULT_SQL] });
    await seedRegistry(handle.app, handle.schema);
    const stagingDb = tenantDbFromPool(handle.connect('app', { max: 1 }), { schema: handle.schema });
    ({ app } = await buildTestApp({ db: handle.app, stagingDb }));
    await withTenant(handle.app, TENANT_A.tenantId, (tx) => insertRow(tx, PROGRAM_BINDING.table, programBindingRow(TENANT_A.siteId)));
    await closeGates(handle.app, { units: UNITS, holderId: SETUP_HOLDER, allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: SETUP_HOLDER });
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
  });

  it('commits the record update, its version row and their changelog rows in one transaction', async () => {
    const seeded = await seedRecord();

    const res = await submit(seeded.record_id);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ data: { record_id: seeded.record_id, state: 'SUBMITTED', version: SEEDED_VERSION + 1 } });
    const { record, versions, changes } = await rowsFor(seeded.record_id);
    expect(record).toMatchObject({ state: 'SUBMITTED', version: SEEDED_VERSION + 1 });
    expect(versions).toEqual([
      expect.objectContaining({ record_id: seeded.record_id, state: 'SUBMITTED', version: SEEDED_VERSION + 1, action: 'submit' }),
    ]);
    const recordChanges = changes.filter((change) => change.table === FINANCE_RECORD.table);
    expect(recordChanges).toHaveLength(1);
    const [update] = recordChanges as [ChangeRow];
    expect(update).toMatchObject({ op: 'update', origin: 'target', columns: expect.arrayContaining(['state', 'version']) });
    expect(decodeRow(FINANCE_RECORD.columns, update.before as string)).toMatchObject({ state: 'IN-PROGRESS', version: String(SEEDED_VERSION) });
    expect(decodeRow(FINANCE_RECORD.columns, update.after as string)).toMatchObject({ state: 'SUBMITTED', version: String(SEEDED_VERSION + 1) });
    const versionChanges = changes.filter((change) => change.table === FINANCE_RECORD_VERSION.table);
    expect(versionChanges).toEqual([expect.objectContaining({ op: 'insert', origin: 'target', before: null })]);
    expect(decodeRow(FINANCE_RECORD_VERSION.columns, (versionChanges[0] as ChangeRow).after as string)).toMatchObject({
      version_id: (versions[0] as FinanceRecordVersionRow).version_id,
      state: 'SUBMITTED',
      version: String(SEEDED_VERSION + 1),
    });
    expect(new Set(changes.map((change) => change.xid)).size).toBe(1);
  });

  it('rolls back record, version and changelog together when the version audit fails', async () => {
    await seedRecord(sentinel);

    const res = await submit(sentinel.record_id);

    expect(res.statusCode, res.body).toBe(500);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error' } });
    expect(res.headers[WRITE_POSITION_HEADER.toLowerCase()]).toBeUndefined();
    const { record, versions, changes } = await rowsFor(sentinel.record_id);
    expect(record).toMatchObject({ state: 'IN-PROGRESS', version: SEEDED_VERSION });
    expect(versions).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('holds a write on a closed gate for the whole gate budget, then answers the legacy 503 and writes nothing', async () => {
    const seeded = await seedRecord();
    const holderId = `test-holder-${randomUUID()}`;
    const { handle: db } = built();
    await closeGates(db.app, { units: TRANSITION_UNITS, holderId });
    try {
      const { result: res, elapsedMs } = await onSteppedClock(() => submit(seeded.record_id));

      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toEqual(LEGACY_UNAVAILABLE);
      expect(res.headers[WRITE_POSITION_HEADER.toLowerCase()]).toBeUndefined();
      expect(elapsedMs).toBeGreaterThanOrEqual(GATE_WAIT_MS);
      const { record, versions, changes } = await rowsFor(seeded.record_id);
      expect(record).toMatchObject({ state: 'IN-PROGRESS', version: SEEDED_VERSION });
      expect(versions).toEqual([]);
      expect(changes).toEqual([]);
    } finally {
      const reopened = await openGates(db.app, { units: TRANSITION_UNITS, holderId });
      expect(reopened.map((gate) => [gate.state, gate.holderId])).toEqual(TRANSITION_UNITS.map(() => ['open', null]));
    }
  });

  it('holds a read while the record gate imports, then answers the legacy 503, and reads again once the gate reopens', async () => {
    const seeded = await seedRecord();
    const holderId = `test-holder-${randomUUID()}`;
    const { handle: db } = built();
    await closeGates(db.app, { units: [FINANCE_RECORD.unit], holderId });
    try {
      await setGatePhase(db.app, { units: [FINANCE_RECORD.unit], holderId, phase: 'importing' });

      const { result: res, elapsedMs } = await onSteppedClock(() => read(seeded.record_id));

      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toEqual(LEGACY_UNAVAILABLE);
      expect(elapsedMs).toBeGreaterThanOrEqual(GATE_WAIT_MS);
    } finally {
      const reopened = await openGates(db.app, { units: [FINANCE_RECORD.unit], holderId });
      expect(reopened).toEqual([{ unit: FINANCE_RECORD.unit, state: 'open', holderId: null, phase: 'quiet' }]);
    }

    const res = await read(seeded.record_id);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ data: { record_id: seeded.record_id, state: 'IN-PROGRESS', version: SEEDED_VERSION } });
  });

  it('reports the committed transaction as the finance write position', async () => {
    const seeded = await seedRecord();

    const res = await submit(seeded.record_id);

    expect(res.statusCode, res.body).toBe(200);
    const header = res.headers[WRITE_POSITION_HEADER.toLowerCase()];
    expect(header).toBeDefined();
    const positions = parseWritePosition(header as string | string[]);
    expect([...positions.keys()]).toEqual(['finance']);
    const xid = positions.get('finance') as string;
    expect(xid).toMatch(/^\d+$/);
    const { changes } = await rowsFor(seeded.record_id);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.map((change) => change.xid)).toEqual(changes.map(() => xid));
  });
});
