// Registry of forwarded writes in `gateway.inflight`; a row leaves only by its own instance's `remove` or evidence-backed `clearOrphans`.
// Dispatcher order: `register` (committed) before `state.readEpochForWrite()`; when the entry is frozen, `remove`, wait unfrozen,
// `register` again and re-read; `remove` when the response completes. A write that read a pre-freeze epoch therefore has its row
// committed before any instance can acknowledge the freeze, so a transition waiting for no in-flight rows cannot miss it.
import { withMetadata, type MetadataTx, type TenantDb } from '@opt2/platform/tenancy';

/** Side a forwarded write went to. */
export type InflightSide = 'legacy' | 'target';

/** Evidence that an orphaned write can no longer commit: a controlled legacy restart, or the owners' gates closing on its units. */
export type OrphanEvidence = 'legacy-restart' | 'gates-closed';

/** Heartbeat age, in seconds, after which an instance is dead; it only narrows `clearOrphans`, never clears a row on its own. */
export const INSTANCE_LIVENESS_SECONDS = 3;

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
  /** Rows of every instance matching `filter`, oldest first. */
  list(filter?: InflightFilter): Promise<InflightRow[]>;
  /** Rows grouped by instance, route and side, as `CutoverStatus.inflight`. */
  summary(): Promise<InflightSummaryRow[]>;
  /** Deletes the evidence-covered rows of dead instances that started before `evidence.at`. */
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

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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
  // $1 side, $2 evidence time, $3 routes or null, $4 instance ids or null; liveness is read from the database clock.
  const orphanWhere =
    `i.side = $1 AND i.started_at < $2::timestamptz ` +
    `AND ($3::text[] IS NULL OR i.route = ANY($3::text[])) ` +
    `AND ($4::text[] IS NULL OR i.instance_id = ANY($4::text[])) ` +
    `AND NOT EXISTS (SELECT 1 FROM ${instance} AS g WHERE g.instance_id = i.instance_id ` +
    `AND g.heartbeat_at >= now() - interval '${INSTANCE_LIVENESS_SECONDS} seconds')`;

  const coveredRoutes = async (tx: MetadataTx, params: unknown[], units: readonly string[]): Promise<string[]> => {
    const closed = new Set(units);
    const { rows } = await tx.query<{ route: string }>(`SELECT DISTINCT i.route FROM ${inflight} AS i WHERE ${orphanWhere}`, params);
    return rows.map((row) => row.route).filter((route) => coveredByGates(unitsOf(route), closed));
  };

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
      const { rows } = await withMetadata(db, (tx) =>
        tx.query<DbSummaryRow>(
          `SELECT i.instance_id, i.route, i.side, count(*)::int AS count, ` +
            `to_char(min(i.started_at)::timestamptz, ${ISO_FORMAT}) AS oldest_started_at ` +
            `FROM ${inflight} AS i GROUP BY i.instance_id, i.route, i.side ORDER BY i.instance_id, i.route, i.side`,
        ),
      );
      return rows.map((row) => ({
        instanceId: row.instance_id,
        route: row.route,
        side: row.side,
        count: row.count,
        oldestStartedAt: row.oldest_started_at,
      }));
    },

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
