// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Read-only queries of schema `esignature` in the fixture `esignature.cfc` order, and the audit append lock; each runs in the caller's tenant transaction, whose RLS scopes the rows. */
import { awaitReadable, qualified, type TableDefinition } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import {
  AUDIT_ENTRY,
  SIGNATURE,
  SIGNATURE_REQUEST,
  type AuditEntryRow,
  type SignatureRequestMetadataRow,
  type SignatureRow,
} from './tables.js';

/** A request list page as envelope.cfc `page()` validates it: `pageIndex` from 1, `itemsPerPage` from 1 to 1000. */
export interface RequestPaging {
  pageIndex: number;
  itemsPerPage: number;
}

/** One page of the tenant's requests and the count of all of them. */
export interface RequestPage {
  rows: SignatureRequestMetadataRow[];
  total: number;
}

/** A request row-locked for an audit append, with its highest-`seq` entry, or null before the first. */
export interface LockedRequest {
  request: SignatureRequestMetadataRow;
  last: AuditEntryRow | null;
}

/** An audit list page, validated as a request page is. */
export type AuditPaging = RequestPaging;

/** One page of a request's audit entries and the count of all of them. */
export interface AuditPage {
  rows: AuditEntryRow[];
  total: number;
}

/** Entries per `auditChainBatches` read, the fixture's largest page. */
export const AUDIT_BATCH_SIZE = 1000;

interface Statements {
  readonly request: string;
  readonly requestForUpdate: string;
  readonly countRequests: string;
  readonly requestPage: string;
  readonly signature: string;
  readonly countAuditEntries: string;
  readonly auditPage: string;
  readonly auditBatch: string;
  readonly lastAuditEntry: string;
}

// SQL Server compares the fixture's char(35) ids case- and trailing-space-insensitively, and stored ids are uppercase CF UUIDs;
// the bpchar cast keeps the comparison bpchar to bpchar, so trailing spaces are ignored and the key indexes still apply.
const REQUEST_ID_MATCH = '"request_id" = upper($1)::bpchar';

/** The quoted catalogue columns of `def`, in catalogue order; `tenant_id` and `row_version` included, as the `tables.ts` row types declare them. */
function columnList(def: TableDefinition): string {
  return def.columns.map((column) => `"${column.name}"`).join(', ');
}

/** The request catalogue without `document`, the bytes no request read returns. */
const REQUEST_METADATA: TableDefinition = { ...SIGNATURE_REQUEST, columns: SIGNATURE_REQUEST.columns.filter((column) => column.name !== 'document') };

/** The statements over `schema`, which is `esignature` except in throwaway test schemas. */
function statementsFor(schema: string): Statements {
  const request = `SELECT ${columnList(REQUEST_METADATA)} FROM ${qualified(schema, SIGNATURE_REQUEST.table)}`;
  const audit = `SELECT ${columnList(AUDIT_ENTRY)} FROM ${qualified(schema, AUDIT_ENTRY.table)} WHERE ${REQUEST_ID_MATCH}`;
  // The fixture's siteID filter is the tenant's own site, so RLS alone scopes rows.
  // CF UUIDs are fixed-format uppercase hex, so byte order on ids matches SQL Server's case-insensitive order.
  return Object.freeze({
    request: `${request} WHERE ${REQUEST_ID_MATCH}`,
    requestForUpdate: `${request} WHERE ${REQUEST_ID_MATCH} FOR UPDATE`,
    countRequests: `SELECT count(*)::integer AS "total" FROM ${qualified(schema, SIGNATURE_REQUEST.table)}`,
    requestPage: `${request} ORDER BY "created", "request_id" COLLATE "C" LIMIT $1 OFFSET $2`,
    signature: `SELECT ${columnList(SIGNATURE)} FROM ${qualified(schema, SIGNATURE.table)} WHERE ${REQUEST_ID_MATCH}`,
    countAuditEntries: `SELECT count(*)::integer AS "total" FROM ${qualified(schema, AUDIT_ENTRY.table)} WHERE ${REQUEST_ID_MATCH}`,
    auditPage: `${audit} ORDER BY "seq" LIMIT $2 OFFSET $3`,
    auditBatch: `${audit} AND "seq" > $2 ORDER BY "seq" LIMIT $3`,
    lastAuditEntry: `${audit} ORDER BY "seq" DESC LIMIT 1`,
  });
}

/** The request `id`, or null; `forUpdate` row-locks it. */
export async function findRequest(
  tx: TenantTx,
  id: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<SignatureRequestMetadataRow | null> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [SIGNATURE_REQUEST.unit]);
  const { rows } = await tx.query<SignatureRequestMetadataRow>(forUpdate ? statements.requestForUpdate : statements.request, [id]);
  return rows[0] ?? null;
}

/** One page of the tenant's requests by `created`, then id, and their total, read as envelope.cfc `queryPage()` reads it. */
export async function listRequests(tx: TenantTx, paging: RequestPaging): Promise<RequestPage> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [SIGNATURE_REQUEST.unit]);
  const [{ total }] = (await tx.query<{ total: number }>(statements.countRequests)).rows as [{ total: number }];
  const offset = (paging.pageIndex - 1) * paging.itemsPerPage;
  if (offset >= total) {
    return { rows: [], total };
  }
  const { rows } = await tx.query<SignatureRequestMetadataRow>(statements.requestPage, [paging.itemsPerPage, offset]);
  return { rows, total };
}

/** The signature of request `requestId`, or null while it is unsigned. */
export async function findSignature(tx: TenantTx, requestId: string): Promise<SignatureRow | null> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [SIGNATURE.unit]);
  const { rows } = await tx.query<SignatureRow>(statements.signature, [requestId]);
  return rows[0] ?? null;
}

/** One page of request `requestId`'s audit entries by `seq`, and their total, read as envelope.cfc `queryPage()` reads it. */
export async function listAuditEntries(tx: TenantTx, requestId: string, paging: AuditPaging): Promise<AuditPage> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [AUDIT_ENTRY.unit]);
  const [{ total }] = (await tx.query<{ total: number }>(statements.countAuditEntries, [requestId])).rows as [{ total: number }];
  const offset = (paging.pageIndex - 1) * paging.itemsPerPage;
  if (offset >= total) {
    return { rows: [], total };
  }
  const { rows } = await tx.query<AuditEntryRow>(statements.auditPage, [requestId, paging.itemsPerPage, offset]);
  return { rows, total };
}

/** Request `requestId`'s whole audit chain in `seq` order, `batchSize` entries per read, for incremental verification. */
export async function* auditChainBatches(tx: TenantTx, requestId: string, batchSize = AUDIT_BATCH_SIZE): AsyncGenerator<AuditEntryRow[]> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [AUDIT_ENTRY.unit]);
  // `seq` has no lower bound, so the first read is unkeyed and a corrupted entry below 1 is still read and verified.
  let batch = (await tx.query<AuditEntryRow>(statements.auditPage, [requestId, batchSize, 0])).rows;
  for (let last = batch.at(-1); last !== undefined; last = batch.at(-1)) {
    yield batch;
    if (batch.length < batchSize) {
      return;
    }
    batch = (await tx.query<AuditEntryRow>(statements.auditBatch, [requestId, last.seq, batchSize])).rows;
  }
}

/** The highest-`seq` audit entry of request `requestId`, or null when it has none. */
export async function lastAuditEntry(tx: TenantTx, requestId: string): Promise<AuditEntryRow | null> {
  const statements = statementsFor(tx.schema);
  await awaitReadable(tx, [AUDIT_ENTRY.unit]);
  const { rows } = await tx.query<AuditEntryRow>(statements.lastAuditEntry, [requestId]);
  return rows[0] ?? null;
}

/**
 * Row-locks request `id` until `tx` ends and reads its last audit entry, so appends on one request serialise as in
 * `synthetic.usp_audit_append`; null when the request does not exist.
 */
export async function lockRequest(tx: TenantTx, id: string): Promise<LockedRequest | null> {
  const statements = statementsFor(tx.schema);
  // One wait for both units: once a gate is share-locked, a later awaitReadable cannot wait out a window and fails instead.
  await awaitReadable(tx, [SIGNATURE_REQUEST.unit, AUDIT_ENTRY.unit]);
  const request = (await tx.query<SignatureRequestMetadataRow>(statements.requestForUpdate, [id])).rows[0];
  if (request === undefined) {
    return null;
  }
  // Read after the row lock: a concurrent append on this request has committed by now, and this statement's snapshot sees it.
  const last = (await tx.query<AuditEntryRow>(statements.lastAuditEntry, [request.request_id])).rows[0] ?? null;
  return { request, last };
}
