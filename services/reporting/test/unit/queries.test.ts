// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting read queries against a throwaway `reporting` schema: fixture order and paging, unfinished jobs, manifest pages, index plans, value forms, isolation, read gates. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import {
  DEFAULT_EXPORT_LIMIT,
  MAX_EXPORT_LIMIT,
  UnitReadBlockedError,
  closeGates,
  ensureUnitGates,
  openGates,
  withGatedTenant,
  type GatePhase,
} from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { findDefinition, findJob, iterateJobObjects, listJobObjects, listJobs, listUnfinishedJobs } from '../../src/repo/queries.js';
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

/** Tenant whose manifest spans several pages; the lowercase id sorts after the uppercase ones in byte (C) order. */
const PAGED_TENANT = randomUUID();
const PAGED_SITE = 'paged-site';
const PAGED_DEFINITION = cfId('D', 3);
const PAGED_JOBS: SeedJob[] = [
  ...['C', 'a', 'B', 'D', 'A'].map((prefix, n) => ({
    id: cfId(prefix, n + 1),
    created: '2026-03-01 12:00:00.000',
    objectKey: `k-p${n + 1}`,
    sha: String(n + 1).repeat(64),
    contentType: 'text/csv',
  })),
  { id: cfId('B', 9), created: '2026-03-01 12:00:00.000' },
];
/** Manifest of `PAGED_TENANT` in byte order of job id. */
const PAGED_MANIFEST = PAGED_JOBS.filter((job) => job.objectKey !== undefined)
  .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  .map((job) => ({ jobId: job.id, objectKey: job.objectKey, sha256: job.sha, contentType: 'text/csv' }));
const PAGED_IDS = PAGED_MANIFEST.map((object) => object.jobId);

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

/** One statement a recorded transaction ran. */
interface Statement {
  text: string;
  values?: unknown[];
}

/** Wraps `tx` so every statement it runs is appended to `seen`. */
function recording(tx: TenantTx, seen: Statement[]): TenantTx {
  const query = ((text: string, values?: unknown[]) => {
    seen.push({ text, values });
    return tx.query(text, values);
  }) as TenantTx['query'];
  return { ...tx, query };
}

/** The plan of the last statement `read` runs, planned with sequential scans and sorts disabled. */
async function planOf(tx: TenantTx, read: (tx: TenantTx) => Promise<unknown>): Promise<string> {
  const seen: Statement[] = [];
  await read(recording(tx, seen));
  const last = seen.at(-1) as Statement;
  await tx.query('SET LOCAL enable_seqscan = off');
  await tx.query('SET LOCAL enable_sort = off');
  const { rows } = await tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${last.text}`, last.values);
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

/** The manifest page statements among `seen`. */
const manifestReads = (seen: readonly Statement[]): Statement[] => seen.filter((statement) => /"object_key" IS NOT NULL/.test(statement.text));

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
    await handle.app.withTenant(PAGED_TENANT, async (tx) => {
      await insertDefinition(tx, PAGED_DEFINITION, PAGED_SITE);
      for (const job of PAGED_JOBS) await insertJob(tx, job, PAGED_DEFINITION, PAGED_SITE);
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
      expect(await listJobObjects(tx)).toEqual({
        objects: [
          { jobId: cfId('A', 5), objectKey: 'k-a5', sha256: 'a'.repeat(64), contentType: 'text/csv' },
          { jobId: cfId('A', 9), objectKey: 'k-a9', sha256: 'b'.repeat(64) },
        ],
        next: null,
      });
    });
  });

  it.each([
    { limit: 2, pages: [PAGED_IDS.slice(0, 2), PAGED_IDS.slice(2, 4), PAGED_IDS.slice(4)] },
    { limit: 4, pages: [PAGED_IDS.slice(0, 4), PAGED_IDS.slice(4)] },
    { limit: 5, pages: [PAGED_IDS] },
    { limit: 6, pages: [PAGED_IDS] },
  ])('pages the manifest $limit at a time in byte order, each next cursor naming the last id of a page that has a successor', async ({ limit, pages }) => {
    await handle.app.withTenant(PAGED_TENANT, async (tx) => {
      const read: { ids: string[]; next: string | null }[] = [];
      let after: string | null = null;
      do {
        const page = await listJobObjects(tx, { after, limit });
        read.push({ ids: page.objects.map((object) => object.jobId), next: page.next });
        after = page.next;
      } while (after !== null);
      expect(read).toEqual(pages.map((ids, index) => ({ ids, next: index === pages.length - 1 ? null : ids.at(-1) })));
    });
  });

  it.each([
    { after: PAGED_IDS[1] as string, ids: PAGED_IDS.slice(2) },
    { after: cfId('B', 9), ids: PAGED_IDS.slice(2) },
    { after: cfId('A', 0), ids: PAGED_IDS },
    { after: cfId('Z', 9), ids: PAGED_IDS.slice(4) },
    { after: PAGED_IDS.at(-1) as string, ids: [] },
  ])('lists only manifest objects whose job id sorts after $after in byte order', async ({ after, ids }) => {
    await handle.app.withTenant(PAGED_TENANT, async (tx) => {
      const page = await listJobObjects(tx, { after });
      expect(page).toEqual({ objects: PAGED_MANIFEST.filter((object) => ids.includes(object.jobId)), next: null });
      expect(page.objects.map((object) => object.jobId)).toEqual(ids);
    });
  });

  it.each([
    { limit: undefined, fetched: DEFAULT_EXPORT_LIMIT + 1 },
    { limit: 3, fetched: 4 },
    { limit: MAX_EXPORT_LIMIT, fetched: MAX_EXPORT_LIMIT + 1 },
    { limit: MAX_EXPORT_LIMIT * 5, fetched: MAX_EXPORT_LIMIT + 1 },
  ])('reads a manifest page of limit $limit with one row past it, never more than MAX_EXPORT_LIMIT', async ({ limit, fetched }) => {
    const seen: Statement[] = [];
    await handle.app.withTenant(PAGED_TENANT, async (tx) => {
      await listJobObjects(recording(tx, seen), { limit });
    });
    expect(manifestReads(seen).map((statement) => statement.values)).toEqual([[null, fetched]]);
  });

  it.each([
    { pageSize: 1, reads: 5 },
    { pageSize: 2, reads: 3 },
    { pageSize: 5, reads: 1 },
    { pageSize: undefined, reads: 1 },
  ])('iterates every manifest object in byte order, $pageSize per page, one page read at a time', async ({ pageSize, reads }) => {
    const seen: Statement[] = [];
    await handle.app.withTenant(PAGED_TENANT, async (tx) => {
      const objects = iterateJobObjects(recording(tx, seen), pageSize);
      const first = await objects.next();
      expect(manifestReads(seen)).toHaveLength(1);
      const rest = [];
      for await (const object of objects) rest.push(object);
      expect([first.value, ...rest]).toEqual(PAGED_MANIFEST);
    });
    expect(manifestReads(seen)).toHaveLength(reads);
  });

  it.each<{ name: string; index: string; read: (tx: TenantTx) => Promise<unknown>; cond: RegExp }>([
    {
      name: 'a job list page',
      index: 'export_job_created_idx',
      read: (tx) => listJobs(tx, { pageIndex: 2, itemsPerPage: 2 }),
      cond: /Index Cond: \(tenant_id = /,
    },
    {
      name: 'the first manifest page',
      index: 'export_job_object_idx',
      read: (tx) => listJobObjects(tx, { limit: 2 }),
      cond: /Index Cond: \(tenant_id = /,
    },
    {
      name: 'a manifest page after a cursor',
      index: 'export_job_object_idx',
      read: (tx) => listJobObjects(tx, { after: PAGED_IDS[1] as string, limit: 2 }),
      cond: /Index Cond: \(\(tenant_id = .*\) AND \(.*job_id.* > '/,
    },
  ])('reads $name in index order from $index, without a sort', async ({ index, read, cond }) => {
    await handle.app.withTenant(PAGED_TENANT, async (tx) => {
      const plan = await planOf(tx, read);
      expect(plan).toMatch(new RegExp(`Index Scan using ${index} on `));
      expect(plan).toMatch(cond);
      expect(plan).not.toMatch(/Sort/);
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
      const manifest = [{ jobId: B_JOB.id, objectKey: 'k-b2', sha256: 'c'.repeat(64), contentType: 'application/pdf' }];
      expect(await listJobObjects(tx)).toEqual({ objects: manifest, next: null });
      expect(await listJobObjects(tx, { after: cfId('A', 0), limit: 1 })).toEqual({ objects: manifest, next: null });
      const iterated = [];
      for await (const object of iterateJobObjects(tx, 1)) iterated.push(object);
      expect(iterated).toEqual(manifest);
      expect(await findJob(tx, cfId('A', 5))).toBeNull();
    });
  });

  it('answers an empty page and manifest for a tenant without jobs', async () => {
    await handle.app.withTenant(TENANT_UMBRELLA.tenantId, async (tx) => {
      expect(await listJobs(tx, { pageIndex: 1, itemsPerPage: 50 })).toEqual({ rows: [], total: 0, pageIndex: 1, itemsPerPage: 50 });
      expect(await listJobObjects(tx)).toEqual({ objects: [], next: null });
      const iterated = [];
      for await (const object of iterateJobObjects(tx)) iterated.push(object);
      expect(iterated).toEqual([]);
    });
  });

  it("lists a site's queued and running jobs, its id matched ignoring case, by created then id with every catalogue column", async () => {
    const tenantId = randomUUID();
    const site = 'unfinished-site';
    const jobs = [
      { id: cfId('U', 3), state: 'running', siteId: site, created: '2026-04-01 10:00:00.000' },
      { id: cfId('U', 2), state: 'queued', siteId: 'Unfinished-Site', created: '2026-04-01 10:00:00.000' },
      { id: cfId('U', 1), state: 'queued', siteId: site, created: '2026-04-02 10:00:00.000' },
      { id: cfId('U', 0), state: 'queued', siteId: site, created: '2026-03-01 10:00:00.000' },
      { id: cfId('U', 4), state: 'done', siteId: site, created: '2026-01-01 10:00:00.000' },
      { id: cfId('U', 5), state: 'failed', siteId: site, created: '2026-01-01 10:00:00.000' },
      { id: cfId('U', 6), state: 'queued', siteId: 'other-site', created: '2026-01-01 10:00:00.000' },
    ];
    await handle.app.withTenant(tenantId, async (tx) => {
      await insertDefinition(tx, cfId('D', 4), site);
      for (const job of jobs) {
        await tx.query(
          `INSERT INTO ${handle.schema}.export_job (tenant_id, job_id, siteid, definition_id, format, state, requested_by_id, created)
           VALUES ($1, $2, $3, $4, 'csv', $5, $6, $7)`,
          [tx.tenantId, job.id, job.siteId, cfId('D', 4), job.state, REQUESTER, job.created],
        );
      }
    });

    await handle.app.withTenant(tenantId, async (tx) => {
      const rows = await listUnfinishedJobs(tx, 'UNFINISHED-site');
      expect(rows.map((row) => [row.job_id, row.state])).toEqual([
        [cfId('U', 0), 'queued'],
        [cfId('U', 2), 'queued'],
        [cfId('U', 3), 'running'],
        [cfId('U', 1), 'queued'],
      ]);
      expect(Object.keys(rows[0] ?? {})).toEqual(EXPORT_JOB.columns.map((column) => column.name));
      expect(await listUnfinishedJobs(tx, 'nosuch-site')).toEqual([]);
    });
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      expect(await listUnfinishedJobs(tx, site)).toEqual([]);
    });
  });

  it('row-locks the job only when asked for update', async () => {
    const seen: Statement[] = [];
    const jobId = cfId('A', 5);
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      await findJob(recording(tx, seen), jobId);
      expect(seen.at(-1)?.text).not.toMatch(/FOR UPDATE/);
      expect((await findJob(recording(tx, seen), jobId, { forUpdate: true }))?.job_id).toBe(jobId);
      expect(seen.at(-1)?.text).toMatch(/FOR UPDATE$/);
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
          (tx) => listUnfinishedJobs(tx, TENANT_A.siteId),
        ];
        for (const read of reads) {
          const started = Date.now();
          const err = await withGatedTenant(handle.app, TENANT_A.tenantId, read, { budgetMs: 300 }).catch((caught: unknown) => caught);
          expect(err).toBeInstanceOf(UnitReadBlockedError);
          expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
          expect(Date.now() - started).toBeGreaterThanOrEqual(250);
        }
        const started = Date.now();
        const page = await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => listJobObjects(tx, { limit: 1 }), { budgetMs: 300 });
        expect(page.objects).toHaveLength(1);
        const iterated = await withGatedTenant(
          handle.app,
          TENANT_A.tenantId,
          async (tx) => {
            const objects = [];
            for await (const object of iterateJobObjects(tx, 1)) objects.push(object);
            return objects;
          },
          { budgetMs: 300 },
        );
        expect(iterated).toHaveLength(2);
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
