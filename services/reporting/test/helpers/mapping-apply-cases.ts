// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Registers the migration apply cases of export job output against the reporting app over one test database mode. */
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANGELOG_TABLE,
  MIGRATION_BATCH_TABLE,
  MIGRATION_PATH_PREFIX,
  encodeRow,
  qualified,
  sha256Hex,
  type ApplyRequest,
  type ApplyResponse,
  type CanonicalColumn,
  type CanonicalValue,
} from '@opt2/platform/migration-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A } from '@opt2/platform/testing';
import { exportJobMapping } from '../../src/migration/mappings/index.js';
import { EXPORT_BUCKET, EXPORT_JOB, EXPORT_OUTPUT_FIELD, OUTPUT_SLOTS, exportObjectKey, type ExportFormat, type ExportJobRow } from '../../src/repo/tables.js';
import { buildTestApp, headersFor, type TestApp, type TestDbMode } from './app.js';
import { LEGACY_EXPORT_JOB_ROWS } from './fixtures.js';

type LegacyRow = Readonly<Record<string, CanonicalValue>>;

const OWNERSHIP = JSON.parse(await readFile(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as {
  tables: { table: string; columns: string[] }[];
};

/** The catalog columns table ownership lists for `legacyTable`. */
function ownershipColumns(legacyTable: string): string[] {
  const table = OWNERSHIP.tables.find((candidate) => candidate.table === legacyTable);
  if (table === undefined) throw new Error(`table ownership lists no ${legacyTable}`);
  return table.columns;
}

/** Registers `migration apply of export job output` over a fresh test app in database `mode` per case. */
export function defineMappingApplyCases(mode: TestDbMode): void {
  describe('migration apply of export job output', () => {
    const APPLY_URL = `${MIGRATION_PATH_PREFIX}/apply`;
    const BAD_REQUEST = { error: { code: 'invalid_request', message: 'Bad Request' } };
    const done = LEGACY_EXPORT_JOB_ROWS[0];
    if (done === undefined) throw new Error('fixture has no row 0');
    const jobId = String(done.job_id);
    const format = done.format as ExportFormat;
    const outputKeys = OUTPUT_SLOTS.map((slot) => exportObjectKey(TENANT_A.tenantId, jobId, format, slot));
    let t: TestApp<TenantDb>;

    /** A `synthetic.export_job` column in fixture catalog order: an owned column, or `output` as binary. */
    function batchColumn(name: string): CanonicalColumn {
      if (name === EXPORT_OUTPUT_FIELD) return { name, type: 'b' };
      const column = exportJobMapping.legacyColumns.find((owned) => owned.name === name);
      if (column === undefined) throw new Error(`${exportJobMapping.legacyTable} maps no column ${name}`);
      return column;
    }

    const columns = ownershipColumns(exportJobMapping.legacyTable).map(batchColumn);

    beforeEach(async () => {
      t = await buildTestApp({ db: mode });
    });

    afterEach(async () => {
      await t?.close();
    });

    /** A tenant-a backfill batch upserting `row` with its output bytes. */
    function jobBatch(batchId: string, row: LegacyRow): ApplyRequest {
      return {
        batchId,
        origin: 'backfill',
        legacyTable: exportJobMapping.legacyTable,
        tenantId: TENANT_A.tenantId,
        columns,
        rows: [{ op: 'upsert', row: encodeRow(columns, row) }],
      };
    }

    async function apply(body: ApplyRequest): Promise<{ status: number; body: ApplyResponse }> {
      const res = await t.app.inject({ method: 'POST', url: APPLY_URL, headers: await headersFor('service:migration'), payload: body });
      return { status: res.statusCode, body: res.json<ApplyResponse>() };
    }

    /** The stored tenant-a job of the sample, every tenant-a changelog row and every recorded batch id. */
    function stored(): Promise<{ job: ExportJobRow | null; changes: { op: string; origin: string; table: string }[]; batches: string[] }> {
      return withTenant(t.db, TENANT_A.tenantId, async (tx) => {
        const job = await tx.query<ExportJobRow>(`SELECT * FROM ${qualified(tx.schema, EXPORT_JOB.table)} WHERE job_id = $1`, [jobId]);
        const changes = await tx.query<{ op: string; origin: string; table: string }>(
          `SELECT op, origin, "table" FROM ${qualified(tx.schema, CHANGELOG_TABLE)} ORDER BY seq`,
        );
        const batches = await tx.query<{ batch_id: string }>(`SELECT batch_id FROM ${qualified(tx.schema, MIGRATION_BATCH_TABLE)} ORDER BY batch_id`);
        return { job: job.rows[0] ?? null, changes: changes.rows, batches: batches.rows.map((row) => row.batch_id) };
      });
    }

    it('stores the verified output under its slot key with a backfill changelog row, and applies a repeated batch as a no-op', async () => {
      const body = jobBatch('mapping-apply-output', done);

      expect(await apply(body)).toStrictEqual({ status: 200, body: { batchId: body.batchId, duplicate: false, applied: 1, skipped: 0 } });
      const first = await stored();
      const head = await t.storage.head(EXPORT_BUCKET, outputKeys[0] ?? '');

      expect(first.job).toMatchObject({ job_id: jobId, siteid: TENANT_A.siteId, object_key: outputKeys[0], output_sha256: sha256Hex(done.output as Buffer) });
      expect(exportJobMapping.encodeLegacy(first.job ?? {})).toBe(encodeRow(exportJobMapping.legacyColumns, done));
      expect({ sha256: head?.sha256, contentType: head?.contentType }).toStrictEqual({ sha256: first.job?.output_sha256, contentType: done.content_type });
      expect(first.changes).toStrictEqual([{ op: 'insert', origin: 'backfill', table: EXPORT_JOB.table }]);
      expect(first.batches).toStrictEqual([body.batchId]);

      expect(await apply(body)).toStrictEqual({ status: 200, body: { batchId: body.batchId, duplicate: true, applied: 0, skipped: 0 } });
      expect(await stored()).toStrictEqual(first);
    });

    it('rejects output whose SHA-256 is not its output_sha256 as badRequest and stores nothing', async () => {
      const res = await apply(jobBatch('mapping-apply-tampered', { ...done, output_sha256: sha256Hex('other output') }));

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject(BAD_REQUEST);
      expect(await stored()).toStrictEqual({ job: null, changes: [], batches: [] });
      for (const key of outputKeys) expect(await t.storage.head(EXPORT_BUCKET, key)).toBeNull();
    });
  });
}
