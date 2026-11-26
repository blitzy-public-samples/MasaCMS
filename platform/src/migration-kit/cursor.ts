/** Commit-safe changelog cursor, applied horizon and write position of the reverse projection feed. */
import { lastClosedEnd, predecessorEnds } from './commit-order.js';
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

/**
 * Changelog rows below `horizon` in `(xid, seq)` order; `cursor` is the last row's, and `horizon` counts as applied only
 * when `complete`. `horizon` is the read horizon, or the xid of the first row withheld for a same-row predecessor at or
 * above it; a page may run past its limit to take a predecessor positioned after one of its rows.
 */
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

/**
 * Reads the tenant's changelog rows after `after` whose transactions finished before the read's horizon. Within one row
 * seq is commit order and xid is not, so a row whose later-positioned same-row predecessors are below the horizon takes
 * them into the page, and one whose predecessors are not yet below it ends the page before its transaction.
 */
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
    const table = qualified(tx.schema, CHANGELOG_TABLE);
    const read = await selectRows(tx, table, horizon, from, limit);
    const { rows, withheld } = await closeOverPredecessors(tx, table, horizon, from, read, limit);
    const last = rows.at(-1);
    return {
      rows,
      cursor: last === undefined ? after : formatCursor(positionOf(last)),
      horizon: withheld?.xid ?? horizon,
      complete: withheld !== undefined || read.length < limit,
    };
  });
}

/** A later-positioned predecessor of the page row at `index`. */
interface PredecessorLink {
  index: number;
  predecessor: ChangelogCursor;
}

function positionOf(row: Pick<ChangeRow, 'xid' | 'seq'>): ChangelogCursor {
  return { xid: BigInt(row.xid), seq: BigInt(row.seq) };
}

function comparePosition(a: ChangelogCursor, b: ChangelogCursor): number {
  if (a.xid !== b.xid) return a.xid < b.xid ? -1 : 1;
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
}

/** Up to `limit` rows after `from` below `below`, in `(xid, seq)` order. */
async function selectRows(tx: Queryable, table: string, below: string, from: ChangelogCursor, limit: number): Promise<ChangeRow[]> {
  // ORDER BY qualifies its columns: a bare name would sort by the text output aliases, so '10' before '9'.
  const { rows } = await tx.query<ChangelogRecord>(
    `SELECT c.xid::text AS xid, c.seq::text AS seq, c."table", c.op, c.key, c.before, c.after, c.columns, c.origin,
            c.actor_user_id, c.actor_service, to_char(c.at, 'YYYY-MM-DD HH24:MI:SS.MS') AS at, c.request_id, c.operation_id
       FROM ${table} AS c
      WHERE c.xid < $1::xid8 AND (c.xid, c.seq) > ($2::xid8, $3::bigint)
      ORDER BY c.xid, c.seq
      LIMIT $4`,
    [below, from.xid.toString(), from.seq.toString(), limit],
  );
  return rows.map(toChangeRow);
}

/**
 * Target rows positioned after `end` that must reach legacy before a target row in `(from, end]` below `horizon`:
 * same table and lower seq, sharing its key or being the update whose after-image it removes or changes.
 */
async function laterPredecessors(
  tx: Queryable,
  table: string,
  horizon: string,
  from: ChangelogCursor,
  end: ChangelogCursor,
): Promise<{ q_xid: string; q_seq: string; xid: string; seq: string }[]> {
  // The plain xid bounds repeat the row comparisons for the planner, which estimates only the former.
  const page =
    "q.origin = 'target' AND q.xid < $1::xid8 AND q.xid >= $2::xid8 AND q.xid <= $4::xid8" +
    ' AND (q.xid, q.seq) > ($2::xid8, $3::bigint) AND (q.xid, q.seq) <= ($4::xid8, $5::bigint)';
  const later = "p.origin = 'target' AND p.seq < q.seq AND p.xid >= $4::xid8 AND (p.xid, p.seq) > ($4::xid8, $5::bigint)";
  const params = [horizon, from.xid.toString(), from.seq.toString(), end.xid.toString(), end.seq.toString()];
  // md5 matches the changelogOrderSql expression indexes; keys and images can exceed a btree entry.
  const byKey = await tx.query<{ q_xid: string; q_seq: string; xid: string; seq: string }>(
    `SELECT q.xid::text AS q_xid, q.seq::text AS q_seq, p.xid::text AS xid, p.seq::text AS seq
       FROM ${table} AS q
       JOIN ${table} AS p ON p.tenant_id = q.tenant_id AND p."table" = q."table" AND md5(p.key) = md5(q.key) AND p.key = q.key
      WHERE ${page} AND ${later}`,
    params,
  );
  const byImage = await tx.query<{ q_xid: string; q_seq: string; xid: string; seq: string }>(
    `SELECT q.xid::text AS q_xid, q.seq::text AS q_seq, p.xid::text AS xid, p.seq::text AS seq
       FROM ${table} AS q
       JOIN ${table} AS p ON p.tenant_id = q.tenant_id AND p."table" = q."table" AND md5(p.after) = md5(q.before) AND p.after = q.before
      WHERE ${page} AND q.op <> 'insert' AND p.op = 'update' AND ${later}`,
    params,
  );
  return [...byKey.rows, ...byImage.rows];
}

/**
 * Closes the page over same-row commit order: while a row's later-positioned predecessors are all below the horizon,
 * reads through the last of them; once one is at or above it, cuts the page at the last transaction boundary before
 * every row that still needs a row after the cut, and returns the first row withheld.
 */
async function closeOverPredecessors(
  tx: Queryable,
  table: string,
  horizon: string,
  from: ChangelogCursor,
  read: ChangeRow[],
  limit: number,
): Promise<{ rows: ChangeRow[]; withheld?: ChangeRow }> {
  const rows = [...read];
  let visibleBelow: string | undefined;
  let checked = from;
  for (;;) {
    const last = rows.at(-1);
    if (last === undefined) return { rows };
    const end = positionOf(last);
    // Predecessors of committed rows committed before the horizon was read, so every one is below this snapshot's xmax.
    visibleBelow ??= await scalar(tx, XMAX_SQL);
    if ((await selectRows(tx, table, visibleBelow, end, 1)).length === 0) return { rows };
    const index = new Map(rows.map((row, at) => [`${row.xid}:${row.seq}`, at]));
    const links: PredecessorLink[] = (await laterPredecessors(tx, table, horizon, checked, end)).map((link) => ({
      index: index.get(`${link.q_xid}:${link.q_seq}`) as number,
      predecessor: { xid: BigInt(link.xid), seq: BigInt(link.seq) },
    }));
    if (links.length === 0) return { rows };
    if (links.some((link) => compareXid(link.predecessor.xid, horizon) >= 0)) return cut(rows, links);
    const through = links.reduce((max, link) => (comparePosition(link.predecessor, max) > 0 ? link.predecessor : max), end);
    rows.push(...(await rowsThrough(tx, table, horizon, end, through, limit)));
    checked = end;
  }
}

/** Every row after `from` through `through` below `horizon`; `through` is such a row. */
async function rowsThrough(
  tx: Queryable,
  table: string,
  horizon: string,
  from: ChangelogCursor,
  through: ChangelogCursor,
  limit: number,
): Promise<ChangeRow[]> {
  const taken: ChangeRow[] = [];
  for (let after = from; ; ) {
    const page = await selectRows(tx, table, horizon, after, limit);
    for (const row of page) {
      if (comparePosition(positionOf(row), through) > 0) return taken;
      taken.push(row);
    }
    const last = page.at(-1);
    if (last === undefined) return taken;
    after = positionOf(last);
  }
}

/** The rows before the last closed transaction boundary, given links to predecessors past the page end, and the first row withheld. */
function cut(rows: ChangeRow[], links: readonly PredecessorLink[]): { rows: ChangeRow[]; withheld: ChangeRow } {
  const ends = predecessorEnds(rows);
  for (const { index } of links) ends[index] = rows.length;
  const boundary = (end: number): boolean => (rows[end] as ChangeRow).xid !== (rows[end + 1] as ChangeRow).xid;
  const keep = lastClosedEnd(ends, rows.length - 1, boundary) + 1;
  return { rows: rows.slice(0, keep), withheld: rows[keep] as ChangeRow };
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
