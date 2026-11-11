// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Read-only queries of schema `reporting` in the fixture `reporting.cfc` order; each runs in the caller's tenant transaction, whose RLS scopes the rows. */
import { awaitReadable, qualified, type TableDefinition } from '@opt2/platform/migration-kit';
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

/** An `export_job` row naming a stored object; the repository stores one only after its SHA-256 matched `output_sha256`. */
type StoredOutputRow = Pick<ExportJobRow, 'job_id' | 'content_type'> & { object_key: string; output_sha256: string };

interface Statements {
  readonly job: string;
  readonly jobForUpdate: string;
  readonly definition: string;
  readonly countJobs: string;
  readonly jobPage: string;
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
    jobObjects:
      `SELECT "job_id", "object_key", "output_sha256", "content_type" FROM ${jobTable}` +
      ' WHERE "object_key" IS NOT NULL ORDER BY "job_id" COLLATE "C"',
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

/** The tenant's export output object manifest, by job id. */
export async function listJobObjects(tx: TenantTx): Promise<JobObject[]> {
  // No read gate: the migration export reads this while a write window imports the unit, and waiting would stall that window.
  const { rows } = await tx.query<StoredOutputRow>(statementsFor(tx.schema).jobObjects);
  return rows.map((row) => ({
    jobId: row.job_id,
    objectKey: row.object_key,
    sha256: row.output_sha256,
    ...(row.content_type === null ? {} : { contentType: row.content_type }),
  }));
}
