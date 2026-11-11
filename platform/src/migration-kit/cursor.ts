/** Commit-safe changelog cursor, applied horizon and write position of the reverse projection feed. */
import { CHANGELOG_TABLE, qualified, type ChangeOp, type ChangeOrigin } from './ddl.js';
import { compareXid } from './write-position.js';
import { withMetadata, withTenant, type Queryable, type TenantDb } from '../tenancy/index.js';

/** Cursor before the first changelog row. */
export const CURSOR_START = '0:0';

/** Page size of `readChanges` when the caller names none. */
export const DEFAULT_CHANGES_LIMIT = 1000;

/** Largest page `readChanges` returns. */
export const MAX_CHANGES_LIMIT = 10_000;

const CURSOR_PATTERN = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;
const MAX_XID8 = 2n ** 64n - 1n;
const MAX_SEQ = 2n ** 63n - 1n;
const HORIZON_SQL = 'SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS value';
const XMAX_SQL = 'SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS value';

/** Position `(xid, seq)` of a changelog row; the cursor text is `<xid>:<seq>` in decimal. */
export interface ChangelogCursor {
  xid: bigint;
  seq: bigint;
}

/** One changelog row; `xid` and `seq` are decimal strings, `at` is the stored `YYYY-MM-DD HH:MM:SS.mmm`. */
export interface ChangeRow {
  xid: string;
  seq: string;
  table: string;
  op: ChangeOp;
  key: string;
  before: string | null;
  after: string | null;
  columns: string[];
  origin: ChangeOrigin;
  actorUserId: string | null;
  actorService: string | null;
  at: string;
  requestId: string | null;
  operationId: string | null;
}

/** Input of `readChanges`; `after` is cursor text, `limit` 1..MAX_CHANGES_LIMIT. */
export interface ReadChangesOptions {
  tenantId: string;
  after?: string;
  limit?: number;
}

/** Changelog rows below `horizon` in `(xid, seq)` order; `cursor` is the last row's, and `horizon` counts as applied only when `complete`. */
export interface ChangesPage {
  rows: ChangeRow[];
  cursor: string;
  horizon: string;
  complete: boolean;
}

/** Thrown when cursor text is not `<xid>:<seq>` with canonical decimals inside the xid8 and bigint ranges. */
export class InvalidCursorError extends Error {
  override readonly name: string = 'InvalidCursorError';

  constructor(readonly cursor: string) {
    super(`Invalid changelog cursor: ${JSON.stringify(cursor)}`);
  }
}

interface ChangelogRecord {
  xid: string;
  seq: string;
  table: string;
  op: ChangeOp;
  key: string;
  before: string | null;
  after: string | null;
  columns: string[];
  origin: ChangeOrigin;
  actor_user_id: string | null;
  actor_service: string | null;
  at: string;
  request_id: string | null;
  operation_id: string | null;
}

/** Parses cursor text; a missing cursor is the start, malformed text throws InvalidCursorError. */
export function parseCursor(text?: string): ChangelogCursor {
  if (text === undefined) return { xid: 0n, seq: 0n };
  const [, xidText, seqText] = CURSOR_PATTERN.exec(text) ?? [];
  if (xidText === undefined || seqText === undefined || BigInt(xidText) > MAX_XID8 || BigInt(seqText) > MAX_SEQ) {
    throw new InvalidCursorError(text);
  }
  return { xid: BigInt(xidText), seq: BigInt(seqText) };
}

/** Formats a position as cursor text `<xid>:<seq>`. */
export function formatCursor({ xid, seq }: ChangelogCursor): string {
  return `${xid.toString()}:${seq.toString()}`;
}

/** True when the projector's applied `horizon` has passed write position `position`. */
export function isApplied(position: string, horizon: string): boolean {
  return compareXid(horizon, position) > 0;
}

/** Reads the tenant's changelog rows after `after` whose transactions finished before the read's horizon. */
export async function readChanges(
  db: TenantDb,
  { tenantId, after = CURSOR_START, limit = DEFAULT_CHANGES_LIMIT }: ReadChangesOptions,
): Promise<ChangesPage> {
  const from = parseCursor(after);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHANGES_LIMIT) {
    throw new RangeError(`Changelog page limit must be an integer from 1 to ${MAX_CHANGES_LIMIT}, got ${limit}`);
  }
  return withTenant(db, tenantId, async (tx) => {
    // Taken before the row read: the row read's newer snapshot sees every transaction below this horizon as finished.
    const horizon = await scalar(tx, HORIZON_SQL);
    // ORDER BY qualifies its columns: a bare name would sort by the text output aliases, so '10' before '9'.
    const { rows } = await tx.query<ChangelogRecord>(
      `SELECT c.xid::text AS xid, c.seq::text AS seq, c."table", c.op, c.key, c.before, c.after, c.columns, c.origin,
              c.actor_user_id, c.actor_service, to_char(c.at, 'YYYY-MM-DD HH24:MI:SS.MS') AS at, c.request_id, c.operation_id
         FROM ${qualified(tx.schema, CHANGELOG_TABLE)} AS c
        WHERE c.xid < $1::xid8 AND (c.xid, c.seq) > ($2::xid8, $3::bigint)
        ORDER BY c.xid, c.seq
        LIMIT $4`,
      [horizon, from.xid.toString(), from.seq.toString(), limit],
    );
    const changes = rows.map(toChangeRow);
    const last = changes.at(-1);
    return {
      rows: changes,
      cursor: last === undefined ? after : formatCursor({ xid: BigInt(last.xid), seq: BigInt(last.seq) }),
      horizon,
      complete: changes.length < limit,
    };
  });
}

/** Latest assigned xid as a decimal string; once an applied horizon exceeds it, every write committed so far is applied. */
export async function currentPosition(db: TenantDb): Promise<string> {
  const xmax = await withMetadata(db, (tx) => scalar(tx, XMAX_SQL));
  return (BigInt(xmax) - 1n).toString();
}

async function scalar(tx: Queryable, sql: string): Promise<string> {
  const { rows } = await tx.query<{ value: string }>(sql);
  // A SELECT without FROM always returns exactly one row.
  return (rows[0] as { value: string }).value;
}

function toChangeRow(record: ChangelogRecord): ChangeRow {
  return {
    xid: record.xid,
    seq: record.seq,
    table: record.table,
    op: record.op,
    key: record.key,
    before: record.before,
    after: record.after,
    columns: record.columns,
    origin: record.origin,
    actorUserId: record.actor_user_id,
    actorService: record.actor_service,
    at: record.at,
    requestId: record.request_id,
    operationId: record.operation_id,
  };
}
