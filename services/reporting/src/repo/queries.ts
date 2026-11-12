// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Read-only queries of schema `reporting` in the fixture `reporting.cfc` order; each runs in the caller's tenant transaction, whose RLS scopes the rows. */
import { DEFAULT_EXPORT_LIMIT, MAX_EXPORT_LIMIT, awaitReadable, qualified, type TableDefinition } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { EXPORT_DEFINITION, EXPORT_JOB, type ExportDefinitionRow, type ExportJobRow } from './tables.js';

/** A job list page as envelope.cfc `page()` validates it: `pageIndex` from 1, `itemsPerPage` from 1 to 1000. */
export interface JobPaging {
  pageIndex: number;
  itemsPerPage: number;
}

/** One page of the tenant's jobs, the count of all of them and the paging it was read with, as envelope.cfc `queryPage()` returns them. */
export interface JobPage extends JobPaging {
  rows: ExportJobRow[];
  total: number;
}

/**
 * One stored export output of the migration export manifest. `size` is absent because `export_job` stores none;
 * `contentType` is absent when the row stores none.
 */
export interface JobObject {
  jobId: string;
  objectKey: string;
  size?: number;
  sha256: string;
  contentType?: string;
}

/** A manifest page request: the job id the previous page ended at, and the page size from 1, capped at `MAX_EXPORT_LIMIT`. */
export interface JobObjectPaging {
  after?: string | null;
  limit?: number;
}

/** One manifest page by job id; `next` is the cursor of the following page, or null after the last one. */
export interface JobObjectPage {
  objects: JobObject[];
  next: string | null;
}

/** An `export_job` row naming a stored object; the repository stores one only after its SHA-256 matched `output_sha256`. */
type StoredOutputRow = Pick<ExportJobRow, 'job_id' | 'content_type'> & { object_key: string; output_sha256: string };

interface Statements {
  readonly job: string;
  readonly jobForUpdate: string;
  readonly definition: string;
  readonly countJobs: string;
  readonly jobPage: string;
  readonly unfinishedJobs: string;
  readonly jobObjects: string;
}

/** The quoted catalogue columns of `def`, in catalogue order. */
function columnList(def: TableDefinition): string {
  return def.columns.map((column) => `"${column.name}"`).join(', ');
}

/** The statements over `schema`, which is `reporting` except in throwaway test schemas. */
function statementsFor(schema: string): Statements {
  const jobTable = qualified(schema, EXPORT_JOB.table);
  const job = `SELECT ${columnList(EXPORT_JOB)} FROM ${jobTable}`;
  // The fixture's siteID filter is the tenant's own site, so RLS alone scopes rows; ids match exactly, as stored CF UUIDs.
  // CF UUIDs are fixed-format uppercase hex, so byte order matches SQL Server's case-insensitive order on job_id.
  return Object.freeze({
    job: `${job} WHERE "job_id" = $1`,
    jobForUpdate: `${job} WHERE "job_id" = $1 FOR UPDATE`,
    definition: `SELECT ${columnList(EXPORT_DEFINITION)} FROM ${qualified(schema, EXPORT_DEFINITION.table)} WHERE "definition_id" = $1`,
    countJobs: `SELECT count(*)::integer AS "total" FROM ${jobTable}`,
    jobPage: `${job} ORDER BY "created", "job_id" COLLATE "C" LIMIT $1 OFFSET $2`,
    // SQL Server compares the fixture's siteID case-insensitively.
    unfinishedJobs: `${job} WHERE "state" IN ('queued', 'running') AND lower("siteid") = lower($1) ORDER BY "created", "job_id" COLLATE "C"`,
    // job_id is char(35), so the cursor is compared as bpchar to keep the (tenant_id, job_id COLLATE "C") index usable.
    jobObjects:
      `SELECT "job_id", "object_key", "output_sha256", "content_type" FROM ${jobTable}` +
      ' WHERE "object_key" IS NOT NULL AND ($1::bpchar IS NULL OR "job_id" COLLATE "C" > $1::bpchar)' +
      ' ORDER BY "job_id" COLLATE "C" LIMIT $2',
  });
}

/** The job `jobId`, or null; `forUpdate` row-locks it so state moves on one job serialise. */
export async function findJob(
  tx: TenantTx,
  jobId: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<ExportJobRow | null> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [EXPORT_JOB.unit]);
  const { rows } = await tx.query<ExportJobRow>(forUpdate ? statements.jobForUpdate : statements.job, [jobId]);
  return rows[0] ?? null;
}

/** The export definition `definitionId`, or null. */
export async function findDefinition(tx: TenantTx, definitionId: string): Promise<ExportDefinitionRow | null> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [EXPORT_DEFINITION.unit]);
  const { rows } = await tx.query<ExportDefinitionRow>(statements.definition, [definitionId]);
  return rows[0] ?? null;
}

/** One page of the tenant's jobs by `created`, then id, and their total, read as envelope.cfc `queryPage()` reads it. */
export async function listJobs(tx: TenantTx, paging: JobPaging): Promise<JobPage> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [EXPORT_JOB.unit]);
  const [{ total }] = (await tx.query<{ total: number }>(statements.countJobs)).rows as [{ total: number }];
  const offset = (paging.pageIndex - 1) * paging.itemsPerPage;
  const page = { pageIndex: paging.pageIndex, itemsPerPage: paging.itemsPerPage, total };
  if (offset >= total) {
    return { ...page, rows: [] };
  }
  const { rows } = await tx.query<ExportJobRow>(statements.jobPage, [paging.itemsPerPage, offset]);
  return { ...page, rows };
}

/** The queued and running jobs of site `siteId` by `created`, then id, as the fixture's `recoverJobs` reads them. */
export async function listUnfinishedJobs(tx: TenantTx, siteId: string): Promise<ExportJobRow[]> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [EXPORT_JOB.unit]);
  const { rows } = await tx.query<ExportJobRow>(statements.unfinishedJobs, [siteId]);
  return rows;
}

/** One page of the tenant's export output object manifest, by job id after `paging.after`. */
export async function listJobObjects(tx: TenantTx, paging: JobObjectPaging = {}): Promise<JobObjectPage> {
  const limit = Math.min(paging.limit ?? DEFAULT_EXPORT_LIMIT, MAX_EXPORT_LIMIT);
  // No read gate: the migration export reads this while a write window imports the unit, and waiting would stall that window.
  // One row past the page tells whether another page follows.
  const { rows } = await tx.query<StoredOutputRow>(statementsFor(tx.schema).jobObjects, [paging.after ?? null, limit + 1]);
  const objects = rows.slice(0, limit).map((row) => ({
    jobId: row.job_id,
    objectKey: row.object_key,
    sha256: row.output_sha256,
    ...(row.content_type === null ? {} : { contentType: row.content_type }),
  }));
  return { objects, next: rows.length > limit ? (objects.at(-1)?.jobId ?? null) : null };
}

/** Every stored output of the tenant's manifest in job-id order, read `pageSize` at a time so one page is held at once. */
export async function* iterateJobObjects(tx: TenantTx, pageSize?: number): AsyncGenerator<JobObject, void, undefined> {
  let after: string | null = null;
  do {
    const page: JobObjectPage = await listJobObjects(tx, { after, limit: pageSize });
    yield* page.objects;
    after = page.next;
  } while (after !== null);
}
