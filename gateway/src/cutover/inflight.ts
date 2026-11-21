// Registry of forwarded writes in `gateway.inflight`; a row leaves only by its own instance's `remove` or evidence-backed `clearOrphans`.
// Dispatcher order: `register` (committed) before `state.readEpochForWrite()`; when the entry is frozen, `remove`, wait unfrozen,
// `register` again and re-read; `remove` when the response completes, `abandon` when the exchange ended uncertainly. A write that
// read a pre-freeze epoch therefore has its row committed before any instance can acknowledge the freeze, so a transition waiting
// for no in-flight rows cannot miss it. A row is an orphan once abandoned or once its instance is not live.
import { withMetadata, type MetadataTx, type TenantDb } from '@opt2/platform/tenancy';

/** Side a forwarded write went to. */
export type InflightSide = 'legacy' | 'target';

/** Evidence that an orphaned write can no longer commit: a controlled legacy restart, or the owners' gates closing on its units. */
export type OrphanEvidence = 'legacy-restart' | 'gates-closed';

/** Heartbeat age, in seconds, after which an instance is dead and its rows orphans; it never clears a row on its own. */
export const INSTANCE_LIVENESS_SECONDS = 3;

/** Most items one keyset page of a cut-over status list reads. */
export const STATUS_PAGE_SIZE = 500;

/** One `gateway.inflight` row; `startedAt` is ISO-8601 with the server's UTC offset. */
export interface InflightRow {
  instanceId: string;
  requestId: string;
  route: string;
  side: InflightSide;
  windowId: string | null;
  startedAt: string;
}

/** Narrows `list`; an absent field matches every row. */
export interface InflightFilter {
  side?: InflightSide;
  routes?: readonly string[];
  instanceIds?: readonly string[];
}

/** A forwarded write; `route` is the canonical route key of its cut-over entry. */
export interface InflightRegistration {
  requestId: string;
  route: string;
  side: InflightSide;
  windowId?: string | null;
}

/** The evidence of `InflightClearRequest`: its kind, the lease holder that produced it, its time and, for gates, the closed units. */
export interface OrphanEvidenceRecord {
  kind: OrphanEvidence;
  holderId: string;
  at: string;
  units?: readonly string[];
}

/** `InflightClearRequest` of the gateway contract, plus an optional in-process narrowing to `routes`. */
export interface InflightClearInput {
  side: InflightSide;
  evidence: OrphanEvidenceRecord;
  instanceIds?: readonly string[];
  routes?: readonly string[];
}

/** `InflightClearResponse` (`cleared`) with the deleted rows. */
export interface InflightClearResult {
  cleared: number;
  rows: InflightRow[];
}

/** One `CutoverStatus.inflight` item: in-flight writes of one instance, route and side. */
export interface InflightSummaryRow {
  instanceId: string;
  route: string;
  side: InflightSide;
  count: number;
  oldestStartedAt: string;
}

/** One `CutoverStatusV2.inflight` item: in-flight writes of one instance, route, side and orphan state. */
export interface InflightOrphanSummaryRow extends InflightSummaryRow {
  /** The instance is not live, or abandoned these writes; only evidence clears them. */
  orphaned: boolean;
}

/** Settings of {@link createInflightStore}. */
export interface InflightStoreOptions {
  /** Gateway schema pool. */
  db: TenantDb;
  /** This gateway instance, as it heartbeats into `gateway.instance`. */
  instanceId: string;
  /** Units of a route key's entry in the active version, undefined when unknown; `gates-closed` needs all of them closed. */
  unitsOf: (route: string) => readonly string[] | undefined;
}

/** In-flight write registry of one gateway instance. */
export interface InflightStore {
  /** Inserts this instance's row for `requestId`; resolves after COMMIT. */
  register(input: InflightRegistration): Promise<void>;
  /** Deletes this instance's row for `requestId`; false when it held none. */
  remove(requestId: string): Promise<boolean>;
  /** Marks this instance's row for `requestId` abandoned, an orphan only evidence clears; false when it held no unmarked row. */
  abandon(requestId: string): Promise<boolean>;
  /** Rows of every instance matching `filter`, oldest first. */
  list(filter?: InflightFilter): Promise<InflightRow[]>;
  /** Rows grouped by instance, route and side, as `CutoverStatus.inflight`. */
  summary(): Promise<InflightSummaryRow[]>;
  /** `summary()` in keyset pages of at most `STATUS_PAGE_SIZE` groups, each read as it is iterated. */
  summaryPages(): AsyncIterable<InflightSummaryRow[]>;
  /** Rows grouped by instance, route, side and orphan state, as `CutoverStatusV2.inflight`, paged as `summaryPages()`. */
  orphanSummaryPages(): AsyncIterable<InflightOrphanSummaryRow[]>;
  /** Deletes the evidence-covered orphans (abandoned rows, or rows of instances not live) that started before `evidence.at`. */
  clearOrphans(input: InflightClearInput): Promise<InflightClearResult>;
}

/** Raised when clear-orphans evidence does not fit its side; the route answers the contract's 400. */
export class InflightEvidenceError extends Error {
  override readonly name = 'InflightEvidenceError';
}

const EVIDENCE_SIDE: Readonly<Record<OrphanEvidence, InflightSide>> = { 'legacy-restart': 'legacy', 'gates-closed': 'target' };

const ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MSTZH:TZM'`;

interface DbRow {
  instance_id: string;
  request_id: string;
  route: string;
  side: InflightSide;
  window_id: string | null;
  started_at: string;
}

interface DbSummaryRow {
  instance_id: string;
  route: string;
  side: InflightSide;
  count: number;
  oldest_started_at: string;
}

interface DbOrphanSummaryRow extends DbSummaryRow {
  orphaned: boolean;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function toSummaryRow(row: DbSummaryRow): InflightSummaryRow {
  return {
    instanceId: row.instance_id,
    route: row.route,
    side: row.side,
    count: row.count,
    oldestStartedAt: row.oldest_started_at,
  };
}

function toOrphanSummaryRow(row: DbOrphanSummaryRow): InflightOrphanSummaryRow {
  return { ...toSummaryRow(row), orphaned: row.orphaned };
}

/** Pages of `read`, each after the last item of the one before, until a page is shorter than `STATUS_PAGE_SIZE`. */
async function* keysetPages<T>(read: (after: T | undefined) => Promise<T[]>): AsyncGenerator<T[]> {
  let after: T | undefined;
  for (;;) {
    const page = await read(after);
    if (page.length > 0) yield page;
    if (page.length < STATUS_PAGE_SIZE) return;
    after = page.at(-1);
  }
}

function toRow(row: DbRow): InflightRow {
  return {
    instanceId: row.instance_id,
    requestId: row.request_id,
    route: row.route,
    side: row.side,
    windowId: row.window_id,
    startedAt: row.started_at,
  };
}

function arrayParam(values: readonly string[] | undefined): string[] | null {
  return values === undefined ? null : [...values];
}

/** True when the route's units are known, non-empty and all among the closed gates. */
function coveredByGates(units: readonly string[] | undefined, closed: ReadonlySet<string>): boolean {
  return units !== undefined && units.length > 0 && units.every((unit) => closed.has(unit));
}

/** Creates the registry over the gateway schema of `db`. */
export function createInflightStore({ db, instanceId, unitsOf }: InflightStoreOptions): InflightStore {
  const schema = quoteIdent(db.schema);
  const inflight = `${schema}.inflight`;
  const instance = `${schema}.instance`;
  const rowColumns = (alias: string): string =>
    `${alias}.instance_id, ${alias}.request_id, ${alias}.route, ${alias}.side, ${alias}.window_id, ` +
    `to_char(${alias}.started_at::timestamptz, ${ISO_FORMAT}) AS started_at`;
  // Liveness is read from the database clock.
  const orphaned =
    `(i.abandoned_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM ${instance} AS g WHERE g.instance_id = i.instance_id ` +
    `AND g.heartbeat_at >= now() - interval '${String(INSTANCE_LIVENESS_SECONDS)} seconds'))`;
  // $1 side, $2 evidence time, $3 routes or null, $4 instance ids or null.
  const orphanWhere =
    `i.side = $1 AND i.started_at < $2::timestamptz ` +
    `AND ($3::text[] IS NULL OR i.route = ANY($3::text[])) ` +
    `AND ($4::text[] IS NULL OR i.instance_id = ANY($4::text[])) ` +
    `AND ${orphaned}`;

  const coveredRoutes = async (tx: MetadataTx, params: unknown[], units: readonly string[]): Promise<string[]> => {
    const closed = new Set(units);
    const { rows } = await tx.query<{ route: string }>(`SELECT DISTINCT i.route FROM ${inflight} AS i WHERE ${orphanWhere}`, params);
    return rows.map((row) => row.route).filter((route) => coveredByGates(unitsOf(route), closed));
  };

  /** The `CutoverStatus` groups after `after` in group-key order, at most `STATUS_PAGE_SIZE` of them. */
  const summaryPage = async (after: InflightSummaryRow | undefined): Promise<InflightSummaryRow[]> => {
    const { rows } = await withMetadata(db, (tx) =>
      tx.query<DbSummaryRow>(
        `SELECT i.instance_id, i.route, i.side, count(*)::int AS count, ` +
          `to_char(min(i.started_at)::timestamptz, ${ISO_FORMAT}) AS oldest_started_at FROM ${inflight} AS i ` +
          `WHERE $1::text IS NULL OR (i.instance_id, i.route, i.side) > ($1::text, $2::text, $3::text) ` +
          `GROUP BY i.instance_id, i.route, i.side ORDER BY i.instance_id, i.route, i.side LIMIT $4`,
        after === undefined ? [null, null, null, STATUS_PAGE_SIZE] : [after.instanceId, after.route, after.side, STATUS_PAGE_SIZE],
      ),
    );
    return rows.map(toSummaryRow);
  };

  /** The `CutoverStatusV2` groups after `after` in group-key order, at most `STATUS_PAGE_SIZE` of them. */
  const orphanSummaryPage = async (after: InflightOrphanSummaryRow | undefined): Promise<InflightOrphanSummaryRow[]> => {
    const { rows } = await withMetadata(db, (tx) =>
      tx.query<DbOrphanSummaryRow>(
        `SELECT o.instance_id, o.route, o.side, o.orphaned, count(*)::int AS count, ` +
          `to_char(min(o.started_at)::timestamptz, ${ISO_FORMAT}) AS oldest_started_at ` +
          `FROM (SELECT i.instance_id, i.route, i.side, i.started_at, ${orphaned} AS orphaned FROM ${inflight} AS i) AS o ` +
          `WHERE $1::text IS NULL OR (o.instance_id, o.route, o.side, o.orphaned) > ($1::text, $2::text, $3::text, $4::boolean) ` +
          `GROUP BY o.instance_id, o.route, o.side, o.orphaned ORDER BY o.instance_id, o.route, o.side, o.orphaned LIMIT $5`,
        after === undefined
          ? [null, null, null, null, STATUS_PAGE_SIZE]
          : [after.instanceId, after.route, after.side, after.orphaned, STATUS_PAGE_SIZE],
      ),
    );
    return rows.map(toOrphanSummaryRow);
  };

  const summaryPages = (): AsyncGenerator<InflightSummaryRow[]> => keysetPages(summaryPage);

  return {
    async register({ requestId, route, side, windowId = null }) {
      await withMetadata(db, (tx) =>
        tx.query(
          `INSERT INTO ${inflight} (instance_id, request_id, route, side, window_id, started_at) VALUES ($1, $2, $3, $4, $5, now())`,
          [instanceId, requestId, route, side, windowId],
        ),
      );
    },

    async remove(requestId) {
      const result = await withMetadata(db, (tx) =>
        tx.query(`DELETE FROM ${inflight} WHERE instance_id = $1 AND request_id = $2`, [instanceId, requestId]),
      );
      return (result.rowCount ?? 0) > 0;
    },

    async abandon(requestId) {
      const result = await withMetadata(db, (tx) =>
        tx.query(`UPDATE ${inflight} SET abandoned_at = now() WHERE instance_id = $1 AND request_id = $2 AND abandoned_at IS NULL`, [
          instanceId,
          requestId,
        ]),
      );
      return (result.rowCount ?? 0) > 0;
    },

    async list(filter = {}) {
      const { rows } = await withMetadata(db, (tx) =>
        tx.query<DbRow>(
          `SELECT ${rowColumns('i')} FROM ${inflight} AS i ` +
            `WHERE ($1::text IS NULL OR i.side = $1) ` +
            `AND ($2::text[] IS NULL OR i.route = ANY($2::text[])) ` +
            `AND ($3::text[] IS NULL OR i.instance_id = ANY($3::text[])) ` +
            `ORDER BY i.started_at, i.instance_id, i.request_id`,
          [filter.side ?? null, arrayParam(filter.routes), arrayParam(filter.instanceIds)],
        ),
      );
      return rows.map(toRow);
    },

    async summary() {
      const groups: InflightSummaryRow[] = [];
      for await (const page of summaryPages()) groups.push(...page);
      return groups;
    },

    summaryPages,

    orphanSummaryPages: () => keysetPages(orphanSummaryPage),

    async clearOrphans({ side, evidence, instanceIds, routes }) {
      if (EVIDENCE_SIDE[evidence.kind] !== side) {
        throw new InflightEvidenceError(`${evidence.kind} evidence clears only ${EVIDENCE_SIDE[evidence.kind]}-side in-flight writes`);
      }
      const gateUnits = evidence.units ?? [];
      if (evidence.kind === 'gates-closed' && gateUnits.length === 0) {
        throw new InflightEvidenceError('gates-closed evidence must name the units whose gates closed');
      }
      const rows = await withMetadata(db, async (tx) => {
        const ids = arrayParam(instanceIds);
        let routeParam = arrayParam(routes);
        if (evidence.kind === 'gates-closed') {
          routeParam = await coveredRoutes(tx, [side, evidence.at, routeParam, ids], gateUnits);
          if (routeParam.length === 0) {
            return [];
          }
        }
        const result = await tx.query<DbRow>(`DELETE FROM ${inflight} AS i WHERE ${orphanWhere} RETURNING ${rowColumns('i')}`, [
          side,
          evidence.at,
          routeParam,
          ids,
        ]);
        return result.rows.map(toRow);
      });
      return { cleared: rows.length, rows };
    },
  };
}
