// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Read-only queries of schema `finance` in the fixture `finance.cfc` order; each runs in the caller's tenant transaction, whose RLS scopes the rows. */
import { awaitReadable, qualified, type TableDefinition } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { moneyFromNumeric, type Money } from '../domain/money.js';
import {
  FINANCE_ATTACHMENT,
  FINANCE_RECORD,
  FINANCE_RECORD_VERSION,
  FINANCE_ROLLUP,
  PROGRAM_BINDING,
  type FinanceAttachmentRow,
  type FinanceRecordRow,
  type FinanceRecordVersionRow,
  type FinanceRollupRow,
  type ProgramBindingRow,
} from './tables.js';

/** A list page as envelope.cfc `page()` validates it: `pageIndex` from 1, `itemsPerPage` from 1 to 1000. */
export interface RecordPaging {
  pageIndex: number;
  itemsPerPage: number;
}

/** One page of a list and the count of all its rows. */
export interface Page<R> {
  rows: R[];
  total: number;
}

/** One page of the tenant's records and the count of all of them. */
export type RecordPage = Page<FinanceRecordRow>;

/** Record list filters; each one given narrows both the page and its count. */
export type RecordFilter = { state?: string; period?: string };

/** The filtered record columns, in placeholder order. */
const RECORD_FILTER_COLUMNS = ['state', 'period'] as const satisfies readonly (keyof RecordFilter & keyof FinanceRecordRow)[];

/** Attachment rows read per page of the object manifest's keyset iteration. */
export const MANIFEST_PAGE_SIZE = 1000;

/** The `finance.attachment` columns the object manifest reads. */
const MANIFEST_COLUMNS = ['attachment_id', 'object_key', 'legacy_program_id'] as const satisfies readonly (keyof FinanceAttachmentRow)[];

/** One attachment row of the object manifest; the object's size, hash and type come from storage, not from the row. */
export type AttachmentObject = Pick<FinanceAttachmentRow, (typeof MANIFEST_COLUMNS)[number]>;

/** The records of one program period whose amounts are summed, optionally without record `excludeRecordId`. */
export type PeriodScope = { programId: number; period: string; excludeRecordId?: string };

/** Exact sums of a period's positive and of its negative amounts; 0n where there are none. */
export type PeriodTotals = { positive: Money; negative: Money };

interface Statements {
  readonly record: string;
  readonly recordForUpdate: string;
  readonly countRecords: string;
  readonly recordList: string;
  readonly countVersions: string;
  readonly versionPage: string;
  readonly countAttachments: string;
  readonly attachmentPage: string;
  readonly attachment: string;
  readonly attachmentObjectKey: string;
  readonly countRollups: string;
  readonly rollupPage: string;
  readonly binding: string;
  readonly manifestFirst: string;
  readonly manifestAfter: string;
  readonly periodTotals: string;
}

/** The quoted catalogue columns of `def`, in catalogue order. */
function columnList(def: TableDefinition): string {
  return def.columns.map((column) => `"${column.name}"`).join(', ');
}

/** The statements over `schema`, which is `finance` except in throwaway test schemas. */
function statementsFor(schema: string): Statements {
  const record = `SELECT ${columnList(FINANCE_RECORD)} FROM ${qualified(schema, FINANCE_RECORD.table)}`;
  const version = `SELECT ${columnList(FINANCE_RECORD_VERSION)} FROM ${qualified(schema, FINANCE_RECORD_VERSION.table)}`;
  const attachment = `SELECT ${columnList(FINANCE_ATTACHMENT)} FROM ${qualified(schema, FINANCE_ATTACHMENT.table)}`;
  const count = (def: TableDefinition): string => `SELECT count(*)::integer AS "total" FROM ${qualified(schema, def.table)}`;
  const manifest = `SELECT ${MANIFEST_COLUMNS.map((column) => `"${column}"`).join(', ')} FROM ${qualified(schema, FINANCE_ATTACHMENT.table)}`;
  // The fixture's siteID filter is the tenant's own site, so RLS alone scopes rows; ids match exactly, as stored CF UUIDs.
  // CF UUIDs are fixed-format uppercase hex, so byte order matches SQL Server's case-insensitive order on ids;
  // COLLATE "C" on period and state matches the fixture's Latin1_General_BIN2.
  // The manifest keyset keeps the primary key's own collation, so that index serves every page.
  return Object.freeze({
    record: `${record} WHERE "record_id" = $1`,
    recordForUpdate: `${record} WHERE "record_id" = $1 FOR UPDATE`,
    countRecords: count(FINANCE_RECORD),
    recordList: record,
    countVersions: `${count(FINANCE_RECORD_VERSION)} WHERE "record_id" = $1`,
    versionPage: `${version} WHERE "record_id" = $1 ORDER BY "version" LIMIT $2 OFFSET $3`,
    countAttachments: `${count(FINANCE_ATTACHMENT)} WHERE "record_id" = $1`,
    attachmentPage: `${attachment} WHERE "record_id" = $1 ORDER BY "created", "attachment_id" COLLATE "C" LIMIT $2 OFFSET $3`,
    attachment: `${attachment} WHERE "record_id" = $1 AND "attachment_id" = $2`,
    attachmentObjectKey: `SELECT "object_key" FROM ${qualified(schema, FINANCE_ATTACHMENT.table)} WHERE "attachment_id" = $1`,
    countRollups: count(FINANCE_ROLLUP),
    rollupPage:
      `SELECT ${columnList(FINANCE_ROLLUP)} FROM ${qualified(schema, FINANCE_ROLLUP.table)}` +
      ' ORDER BY "period" COLLATE "C", "state" COLLATE "C", "legacy_program_id" LIMIT $1 OFFSET $2',
    binding: `SELECT ${columnList(PROGRAM_BINDING)} FROM ${qualified(schema, PROGRAM_BINDING.table)} ORDER BY "legacy_program_id" LIMIT 1`,
    manifestFirst: `${manifest} ORDER BY "attachment_id" LIMIT $1`,
    manifestAfter: `${manifest} WHERE "attachment_id" > $1 ORDER BY "attachment_id" LIMIT $2`,
    periodTotals:
      `SELECT coalesce(sum("amount") FILTER (WHERE "amount" > 0), 0)::text AS "positive",` +
      ` coalesce(sum("amount") FILTER (WHERE "amount" < 0), 0)::text AS "negative" FROM ${qualified(schema, FINANCE_RECORD.table)}` +
      ' WHERE "legacy_program_id" = $1 AND "period" = $2 AND "record_id" IS DISTINCT FROM $3',
  });
}

/** The count and page statements of the records matching `filter`, sharing one WHERE, and its parameters in placeholder order. */
function recordListSql(statements: Statements, filter: RecordFilter): { sql: { count: string; page: string }; params: string[] } {
  const params: string[] = [];
  const terms: string[] = [];
  for (const column of RECORD_FILTER_COLUMNS) {
    const value = filter[column];
    if (value === undefined) continue;
    params.push(value);
    terms.push(`"${column}" = $${params.length}`);
  }
  const where = terms.length === 0 ? '' : ` WHERE ${terms.join(' AND ')}`;
  const order = ` ORDER BY "created", "record_id" COLLATE "C" LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  return { sql: { count: `${statements.countRecords}${where}`, page: `${statements.recordList}${where}${order}` }, params };
}

/**
 * One page of `sql.page` and the row count of `sql.count`, read as envelope.cfc `queryPage()` reads them: the count first,
 * then the page only when it starts before that count. Both bind `params`; the page then binds LIMIT and OFFSET.
 */
async function queryPage<R extends Record<string, unknown>>(
  tx: TenantTx,
  sql: { count: string; page: string },
  params: readonly unknown[],
  paging: RecordPaging,
): Promise<Page<R>> {
  const [{ total }] = (await tx.query<{ total: number }>(sql.count, [...params])).rows as [{ total: number }];
  const offset = (paging.pageIndex - 1) * paging.itemsPerPage;
  if (offset >= total) {
    return { rows: [], total };
  }
  const { rows } = await tx.query<R>(sql.page, [...params, paging.itemsPerPage, offset]);
  return { rows, total };
}

/** The record `id`, or null; `forUpdate` row-locks it so transitions on one record serialise. */
export async function findRecord(
  tx: TenantTx,
  id: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<FinanceRecordRow | null> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [FINANCE_RECORD.unit]);
  const { rows } = await tx.query<FinanceRecordRow>(forUpdate ? statements.recordForUpdate : statements.record, [id]);
  return rows[0] ?? null;
}

/** One page of the tenant's records matching `filter` by `created`, then id, and their total, read as envelope.cfc `queryPage()` reads it. */
export async function listRecords(tx: TenantTx, paging: RecordPaging, filter: RecordFilter = {}): Promise<RecordPage> {
  const { sql, params } = recordListSql(statementsFor(tx.schema), filter);
  await awaitReadable(tx, [FINANCE_RECORD.unit]);
  return queryPage<FinanceRecordRow>(tx, sql, params, paging);
}

/** One page of record `recordId`'s version rows by version, and their total. */
export async function listVersions(tx: TenantTx, recordId: string, paging: RecordPaging): Promise<Page<FinanceRecordVersionRow>> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [FINANCE_RECORD_VERSION.unit]);
  return queryPage<FinanceRecordVersionRow>(tx, { count: statements.countVersions, page: statements.versionPage }, [recordId], paging);
}

/** One page of record `recordId`'s attachment rows by `created`, then id, and their total. */
export async function listAttachments(tx: TenantTx, recordId: string, paging: RecordPaging): Promise<Page<FinanceAttachmentRow>> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [FINANCE_ATTACHMENT.unit]);
  return queryPage<FinanceAttachmentRow>(tx, { count: statements.countAttachments, page: statements.attachmentPage }, [recordId], paging);
}

/** The attachment `attachmentId` of record `recordId`, or null when either id does not match. */
export async function findAttachment(tx: TenantTx, recordId: string, attachmentId: string): Promise<FinanceAttachmentRow | null> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [FINANCE_ATTACHMENT.unit]);
  const { rows } = await tx.query<FinanceAttachmentRow>(statements.attachment, [recordId, attachmentId]);
  return rows[0] ?? null;
}

/** The `object_key` of the tenant's attachment `attachmentId`, or null; ungated, as the reverse projection reads it while a window holds the unit. */
export async function findAttachmentObjectKey(tx: TenantTx, attachmentId: string): Promise<string | null> {
  const { rows } = await tx.query<Pick<FinanceAttachmentRow, 'object_key'>>(statementsFor(tx.schema).attachmentObjectKey, [attachmentId]);
  return rows[0]?.object_key ?? null;
}

/** One page of the tenant's rollup rows by period, then state, in binary order, and their total. */
export async function listRollups(tx: TenantTx, paging: RecordPaging): Promise<Page<FinanceRollupRow>> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [FINANCE_ROLLUP.unit]);
  return queryPage<FinanceRollupRow>(tx, { count: statements.countRollups, page: statements.rollupPage }, [], paging);
}

/** The exact positive and negative amount sums of the tenant's records in `scope`. */
export async function periodTotals(tx: TenantTx, scope: PeriodScope): Promise<PeriodTotals> {
  await awaitReadable(tx, [FINANCE_RECORD.unit]);
  const { rows } = await tx.query<{ positive: string; negative: string }>(statementsFor(tx.schema).periodTotals, [
    scope.programId,
    scope.period,
    scope.excludeRecordId ?? null,
  ]);
  const [{ positive, negative }] = rows as [{ positive: string; negative: string }];
  return { positive: moneyFromNumeric(positive), negative: moneyFromNumeric(negative) };
}

/** The tenant's `Program_<id>` binding with the lowest program id, or null; `program_binding` has no unit gate. */
export async function findProgramBinding(tx: TenantTx): Promise<ProgramBindingRow | null> {
  const { rows } = await tx.query<ProgramBindingRow>(statementsFor(tx.schema).binding);
  return rows[0] ?? null;
}

/** The tenant's attachment object rows by attachment id, read in keyset pages of `MANIFEST_PAGE_SIZE` rows. */
export async function* attachmentObjects(tx: TenantTx): AsyncGenerator<AttachmentObject> {
  // No read gate: the migration export reads this while a write window imports the unit, and waiting would stall that window.
  const statements = statementsFor(tx.schema);
  let page = (await tx.query<AttachmentObject>(statements.manifestFirst, [MANIFEST_PAGE_SIZE])).rows;
  for (;;) {
    yield* page;
    const last = page.at(-1);
    if (page.length < MANIFEST_PAGE_SIZE || last === undefined) return;
    page = (await tx.query<AttachmentObject>(statements.manifestAfter, [last.attachment_id, MANIFEST_PAGE_SIZE])).rows;
  }
}
