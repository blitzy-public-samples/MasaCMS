// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting read queries against a throwaway `reporting` schema: fixture order and paging, value forms, tenant isolation and window read gates. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { UnitReadBlockedError, closeGates, ensureUnitGates, openGates, withGatedTenant, type GatePhase } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { findDefinition, findJob, listJobObjects, listJobs } from '../../src/repo/queries.js';
import { EXPORT_DEFINITION, EXPORT_JOB, UNITS } from '../../src/repo/tables.js';

let handle: ThrowawaySchema;

/** A CF-format id whose first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;

const REQUESTER = cfId('E', 1);
const A_DEFINITION = cfId('D', 1);
const B_DEFINITION = cfId('D', 2);

interface SeedJob {
  id: string;
  created: string;
  objectKey?: string;
  sha?: string;
  contentType?: string | null;
}

const A_JOBS: SeedJob[] = [
  { id: cfId('A', 5), created: '2026-06-01 10:00:00.000', objectKey: 'k-a5', sha: 'a'.repeat(64), contentType: 'text/csv' },
  { id: cfId('A', 3), created: '2026-06-01 10:00:00.000' },
  { id: cfId('A', 9), created: '2026-05-01 09:00:00.000', objectKey: 'k-a9', sha: 'b'.repeat(64), contentType: null },
  { id: cfId('F', 1), created: '2026-06-01 10:00:00.000' },
  { id: cfId('A', 1), created: '2026-07-01 08:00:00.000' },
];
const B_JOB: SeedJob = { id: cfId('B', 2), created: '2026-01-01 00:00:00.000', objectKey: 'k-b2', sha: 'c'.repeat(64), contentType: 'application/pdf' };

/** Inserts one export definition of the transaction tenant. */
async function insertDefinition(tx: TenantTx, definitionId: string, siteId: string): Promise<void> {
  await tx.query(
    `INSERT INTO ${handle.schema}.export_definition (tenant_id, definition_id, siteid, name, source, columns)
     VALUES ($1, $2, $3, 'Sheets', 'timesheets.sheets', '["timesheet_id","status"]')`,
    [tx.tenantId, definitionId, siteId],
  );
}

/** Inserts one csv job of `definitionId` in the transaction tenant; a job with an object is `done`, any other `queued`. */
async function insertJob(tx: TenantTx, job: SeedJob, definitionId: string, siteId: string): Promise<void> {
  const done = job.objectKey !== undefined;
  await tx.query(
    `INSERT INTO ${handle.schema}.export_job
       (tenant_id, job_id, siteid, definition_id, format, state, requested_by_id, created, file_name, content_type, object_key, output_sha256)
     VALUES ($1, $2, $3, $4, 'csv', $5, $6, $7, $8, $9, $10, $11)`,
    [
      tx.tenantId,
      job.id,
      siteId,
      definitionId,
      done ? 'done' : 'queued',
      REQUESTER,
      job.created,
      done ? `export-${job.id}.csv` : null,
      job.contentType ?? null,
      job.objectKey ?? null,
      job.sha ?? null,
    ],
  );
}

/** Wraps `tx` so every statement text it runs is appended to `seen`. */
function recording(tx: TenantTx, seen: string[]): TenantTx {
  const query = ((text: string, values?: unknown[]) => {
    seen.push(text);
    return tx.query(text, values);
  }) as TenantTx['query'];
  return { ...tx, query };
}

/** Fixture order of jobs: `created`, then id. */
function fixtureOrder(rows: readonly SeedJob[]): string[] {
  const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return [...rows].sort((x, y) => compare(x.created, y.created) || compare(x.id, y.id)).map((row) => row.id);
}

describe.skipIf(!(await pgAvailable()))('reporting read queries', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'reporting', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      await insertDefinition(tx, A_DEFINITION, TENANT_A.siteId);
      for (const job of A_JOBS) await insertJob(tx, job, A_DEFINITION, TENANT_A.siteId);
    });
    await handle.app.withTenant(TENANT_B.tenantId, async (tx) => {
      await insertDefinition(tx, B_DEFINITION, TENANT_B.siteId);
      await insertJob(tx, B_JOB, B_DEFINITION, TENANT_B.siteId);
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('pages jobs by created then id with the total and paging, and an empty page past the end', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      const pages = [];
      for (const pageIndex of [1, 2, 3]) pages.push(await listJobs(tx, { pageIndex, itemsPerPage: 2 }));
      expect(pages.map(({ total, pageIndex, itemsPerPage }) => ({ total, pageIndex, itemsPerPage }))).toEqual([
        { total: 5, pageIndex: 1, itemsPerPage: 2 },
        { total: 5, pageIndex: 2, itemsPerPage: 2 },
        { total: 5, pageIndex: 3, itemsPerPage: 2 },
      ]);
      expect(pages.map((page) => page.rows.length)).toEqual([2, 2, 1]);
      expect(pages.flatMap((page) => page.rows.map((row) => row.job_id))).toEqual(fixtureOrder(A_JOBS));
      expect(await listJobs(tx, { pageIndex: 4, itemsPerPage: 2 })).toEqual({ rows: [], total: 5, pageIndex: 4, itemsPerPage: 2 });
    });
  });

  it('selects the catalogue columns in pg value forms', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      const job = await findJob(tx, cfId('A', 3));
      expect(Object.keys(job ?? {})).toEqual(EXPORT_JOB.columns.map((column) => column.name));
      expect(job).toMatchObject({ job_id: cfId('A', 3), siteid: TENANT_A.siteId, state: 'queued', row_version: '0', object_key: null, started_at: null });
      expect(job?.created).toBeInstanceOf(Date);
      const definition = await findDefinition(tx, A_DEFINITION);
      expect(Object.keys(definition ?? {})).toEqual(EXPORT_DEFINITION.columns.map((column) => column.name));
      expect(definition).toMatchObject({ definition_id: A_DEFINITION, source: 'timesheets.sheets', columns: '["timesheet_id","status"]' });
      expect(await findJob(tx, cfId('A', 4))).toBeNull();
      expect(await findDefinition(tx, cfId('D', 9))).toBeNull();
    });
  });

  it('lists the stored output manifest by job id, without jobs that have no object', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      expect(await listJobObjects(tx)).toEqual([
        { jobId: cfId('A', 5), objectKey: 'k-a5', sha256: 'a'.repeat(64), contentType: 'text/csv' },
        { jobId: cfId('A', 9), objectKey: 'k-a9', sha256: 'b'.repeat(64) },
      ]);
    });
  });

  it('hides tenant B rows from a tenant A transaction', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      expect(await findJob(tx, B_JOB.id)).toBeNull();
      expect(await findDefinition(tx, B_DEFINITION)).toBeNull();
      expect((await listJobs(tx, { pageIndex: 1, itemsPerPage: 50 })).rows.map((row) => row.job_id)).not.toContain(B_JOB.id);
    });
    await handle.app.withTenant(TENANT_B.tenantId, async (tx) => {
      const page = await listJobs(tx, { pageIndex: 1, itemsPerPage: 50 });
      expect(page.total).toBe(1);
      expect(page.rows.map((row) => row.job_id)).toEqual([B_JOB.id]);
      expect(await listJobObjects(tx)).toEqual([{ jobId: B_JOB.id, objectKey: 'k-b2', sha256: 'c'.repeat(64), contentType: 'application/pdf' }]);
      expect(await findJob(tx, cfId('A', 5))).toBeNull();
    });
  });

  it('answers an empty page and manifest for a tenant without jobs', async () => {
    await handle.app.withTenant(TENANT_UMBRELLA.tenantId, async (tx) => {
      expect(await listJobs(tx, { pageIndex: 1, itemsPerPage: 50 })).toEqual({ rows: [], total: 0, pageIndex: 1, itemsPerPage: 50 });
      expect(await listJobObjects(tx)).toEqual([]);
    });
  });

  it('row-locks the job only when asked for update', async () => {
    const seen: string[] = [];
    const jobId = cfId('A', 5);
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      await findJob(recording(tx, seen), jobId);
      expect(seen.at(-1)).not.toMatch(/FOR UPDATE/);
      expect((await findJob(recording(tx, seen), jobId, { forUpdate: true }))?.job_id).toBe(jobId);
      expect(seen.at(-1)).toMatch(/FOR UPDATE$/);
      const other = await handle.appPool.connect();
      try {
        await other.query('BEGIN');
        await other.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A.tenantId]);
        await expect(
          other.query(`SELECT 1 FROM ${handle.schema}.export_job WHERE job_id = $1 FOR UPDATE NOWAIT`, [jobId]),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await other.query('ROLLBACK');
        other.release();
      }
    });
  });

  it.each<GatePhase>(['executing', 'importing', 'import-pending'])(
    'makes user reads wait out the %s phase and fail with the legacy 503, but never the export manifest',
    async (phase) => {
      const units = [EXPORT_JOB.unit, EXPORT_DEFINITION.unit];
      const holderId = `window-${randomUUID()}`;
      await closeGates(handle.app, { units, holderId, phase, allowLegacy: true });
      try {
        const reads: ((tx: TenantTx) => Promise<unknown>)[] = [
          (tx) => findJob(tx, cfId('A', 5)),
          (tx) => findDefinition(tx, A_DEFINITION),
          (tx) => listJobs(tx, { pageIndex: 1, itemsPerPage: 2 }),
        ];
        for (const read of reads) {
          const started = Date.now();
          const err = await withGatedTenant(handle.app, TENANT_A.tenantId, read, { budgetMs: 300 }).catch((caught: unknown) => caught);
          expect(err).toBeInstanceOf(UnitReadBlockedError);
          expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
          expect(Date.now() - started).toBeGreaterThanOrEqual(250);
        }
        const started = Date.now();
        const objects = await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => listJobObjects(tx), { budgetMs: 300 });
        expect(objects).toHaveLength(2);
        expect(Date.now() - started).toBeLessThan(250);
      } finally {
        await openGates(handle.app, { units, holderId, state: 'legacy' });
      }
    },
  );

  it('reads through a closed gate in its quiet phase', async () => {
    const units = [EXPORT_JOB.unit];
    const holderId = `window-${randomUUID()}`;
    await closeGates(handle.app, { units, holderId, phase: 'quiet', allowLegacy: true });
    try {
      const job = await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => findJob(tx, cfId('A', 5)), { budgetMs: 300 });
      expect(job?.job_id).toBe(cfId('A', 5));
    } finally {
      await openGates(handle.app, { units, holderId, state: 'legacy' });
    }
  });
});
