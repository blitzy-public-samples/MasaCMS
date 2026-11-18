/** `migration.projector_quarantine`: changes the reverse projector left out of their batches, their repair, and the barrier's read of them. */
import { compareXid, qualified, type ChangeOp, type WritePositions } from '@opt2/platform/migration-kit';
import type { MetadataTx } from '@opt2/platform/tenancy';

const QUARANTINE_TABLE = 'projector_quarantine';

/** One legacy row of one owner's stream, which a quarantined change shares with every later change of that row. */
export interface QuarantineKey {
  owner: string;
  tenantId: string;
  /** Legacy table name as in `LegacyChange.legacyTable`. */
  legacyTable: string;
  /** Encoded legacy key as the owner projected it. */
  legacyKey: string;
}

/** A change and its changelog position. */
export interface QuarantinedChange extends QuarantineKey {
  xid: string;
  seq: string;
}

/** A change left out of its batch, as it is recorded. */
export interface QuarantineEntry extends QuarantinedChange {
  op: ChangeOp;
  /** Why, without the values a SQL Server message quotes. */
  reason: string;
}

/** A quarantined change marked repaired, with the position of the change that wrote its key again. */
export interface RepairedChange extends QuarantinedChange {
  repairedXid: string;
  repairedSeq: string;
}

/** An unrepaired quarantined change at an awaited write position. */
export interface QuarantinedPosition {
  owner: string;
  xid: string;
  tenantId: string;
}

interface ChangeRecord {
  owner: string;
  tenant_id: string;
  legacy_table: string;
  legacy_key: string;
  xid: string;
  seq: string;
}

// Qualified by the handle's schema, so a throwaway test schema is read rather than a literal `migration.`.
function quarantineTable(tx: MetadataTx): string {
  return qualified(tx.schema, QUARANTINE_TABLE);
}

/** In-memory identity of a key; tenant ids compare case-insensitively. */
export function quarantineKeyOf(key: QuarantineKey): string {
  return JSON.stringify([key.owner, key.tenantId.toLowerCase(), key.legacyTable, key.legacyKey]);
}

function keyColumns(keys: readonly QuarantineKey[]): [string[], string[], string[], string[]] {
  return [keys.map((key) => key.owner), keys.map((key) => key.tenantId), keys.map((key) => key.legacyTable), keys.map((key) => key.legacyKey)];
}

function changeOf(record: ChangeRecord): QuarantinedChange {
  return { owner: record.owner, tenantId: record.tenant_id, legacyTable: record.legacy_table, legacyKey: record.legacy_key, xid: record.xid, seq: record.seq };
}

/** Records `entries` of batch `batchId`; a change already recorded keeps its record. */
export async function recordQuarantine(tx: MetadataTx, entries: readonly QuarantineEntry[], batchId: string, at: Date): Promise<void> {
  if (entries.length === 0) return;
  await tx.query(
    `INSERT INTO ${quarantineTable(tx)} (owner, tenant_id, xid, seq, legacy_table, op, legacy_key, reason, batch_id, quarantined_at)
     SELECT e.owner, e.tenant_id, e.xid, e.seq, e.legacy_table, e.op, e.legacy_key, e.reason, $9, $10::timestamp(3)
       FROM unnest($1::text[], $2::uuid[], $3::numeric[], $4::bigint[], $5::text[], $6::text[], $7::text[], $8::text[])
         AS e(owner, tenant_id, xid, seq, legacy_table, op, legacy_key, reason)
     ON CONFLICT (owner, tenant_id, xid, seq) DO NOTHING`,
    [
      entries.map((entry) => entry.owner),
      entries.map((entry) => entry.tenantId),
      entries.map((entry) => entry.xid),
      entries.map((entry) => entry.seq),
      entries.map((entry) => entry.legacyTable),
      entries.map((entry) => entry.op),
      entries.map((entry) => entry.legacyKey),
      entries.map((entry) => entry.reason),
      batchId,
      at,
    ],
  );
}

/** The unrepaired quarantined changes of `keys`, in one read. */
export async function unrepairedChanges(tx: MetadataTx, keys: readonly QuarantineKey[]): Promise<QuarantinedChange[]> {
  if (keys.length === 0) return [];
  const { rows } = await tx.query<ChangeRecord>(
    `SELECT owner, tenant_id::text AS tenant_id, legacy_table, legacy_key, xid::text AS xid, seq::text AS seq
       FROM ${quarantineTable(tx)}
      WHERE repaired_at IS NULL
        AND (owner, tenant_id, legacy_table, legacy_key) IN (SELECT * FROM unnest($1::text[], $2::uuid[], $3::text[], $4::text[]))`,
    keyColumns(keys),
  );
  return rows.map(changeOf);
}

/**
 * Marks every unrepaired quarantined change of each repair's key, at or before the repair's seq, repaired by that change;
 * one repair per key. Returns the changes it marked, in changelog order.
 */
export async function markRepaired(tx: MetadataTx, repairs: readonly QuarantinedChange[], at: Date): Promise<RepairedChange[]> {
  if (repairs.length === 0) return [];
  const { rows } = await tx.query<ChangeRecord & { repaired_xid: string; repaired_seq: string }>(
    `UPDATE ${quarantineTable(tx)} AS q
        SET repaired_at = $7::timestamp(3), repaired_xid = r.xid, repaired_seq = r.seq
       FROM unnest($1::text[], $2::uuid[], $3::text[], $4::text[], $5::numeric[], $6::bigint[])
         AS r(owner, tenant_id, legacy_table, legacy_key, xid, seq)
      WHERE q.repaired_at IS NULL AND q.owner = r.owner AND q.tenant_id = r.tenant_id AND q.legacy_table = r.legacy_table
        AND q.legacy_key = r.legacy_key AND q.seq <= r.seq
  RETURNING q.owner, q.tenant_id::text AS tenant_id, q.legacy_table, q.legacy_key, q.xid::text AS xid, q.seq::text AS seq,
            q.repaired_xid::text AS repaired_xid, q.repaired_seq::text AS repaired_seq`,
    [...keyColumns(repairs), repairs.map((repair) => repair.xid), repairs.map((repair) => repair.seq), at],
  );
  return rows
    .map((row): RepairedChange => ({ ...changeOf(row), repairedXid: row.repaired_xid, repairedSeq: row.repaired_seq }))
    .sort((a, b) => compareXid(a.xid, b.xid) || compareXid(a.seq, b.seq));
}

/** The unrepaired quarantined changes at exactly the owner positions given, one per owner, xid and tenant. */
export async function quarantinedPositions(tx: MetadataTx, positions: WritePositions): Promise<QuarantinedPosition[]> {
  if (positions.size === 0) return [];
  const { rows } = await tx.query<{ owner: string; xid: string; tenant_id: string }>(
    `SELECT DISTINCT owner, xid::text AS xid, tenant_id::text AS tenant_id
       FROM ${quarantineTable(tx)}
      WHERE repaired_at IS NULL AND (owner, xid) IN (SELECT * FROM unnest($1::text[], $2::numeric[]))
      ORDER BY owner, xid, tenant_id`,
    [[...positions.keys()], [...positions.values()]],
  );
  return rows.map((row) => ({ owner: row.owner, xid: row.xid, tenantId: row.tenant_id }));
}
