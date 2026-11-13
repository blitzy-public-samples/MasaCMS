// In-memory gateway schema for app-level suites: the statements of the cut-over state, in-flight registry, jar and barrier.
import type {
  CommitCallback,
  CommitErrorHandler,
  MetadataTx,
  QueryConfig,
  QueryResult,
  QueryResultRow,
  TenantDb,
  TransactionCallOptions,
} from '@opt2/platform/tenancy';
import { INSTANCE_LIVENESS_SECONDS, type InflightSide } from '../../src/cutover/inflight.js';

const SCHEMA = 'gateway';
const ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MSTZH:TZM'`;
const LIVE = `heartbeat_at >= now() - interval '${INSTANCE_LIVENESS_SECONDS} seconds'`;
const JAR_COLUMNS = 'session_id, legacy_session_id, cookies, mode, hydrated_epoch, updated_at, identity_end_pending_at';
const JAR_UPSERT_COLUMNS = 'session_id, legacy_session_id, cookies, mode, hydrated_epoch, updated_at';
const INFLIGHT_COLUMNS =
  `i.instance_id, i.request_id, i.route, i.side, i.window_id, to_char(i.started_at::timestamptz, ${ISO_FORMAT}) AS started_at`;
const ORPHAN_WHERE =
  `i.side = $1 AND i.started_at < $2::timestamptz AND ($3::text[] IS NULL OR i.route = ANY($3::text[])) ` +
  `AND ($4::text[] IS NULL OR i.instance_id = ANY($4::text[])) AND NOT EXISTS (SELECT 1 FROM instance AS g ` +
  `WHERE g.instance_id = i.instance_id AND g.heartbeat_at >= now() - interval '${INSTANCE_LIVENESS_SECONDS} seconds')`;
const END_DECLARATION =
  `WITH gone AS (DELETE FROM session_barrier WHERE session_id = $1 AND owner = $2 AND pending = 1 AND xid IS NULL RETURNING owner) ` +
  `UPDATE session_barrier SET pending = pending - 1 WHERE session_id = $1 AND owner = $2 AND pending > 0 AND NOT EXISTS (SELECT 1 FROM gone)`;

/** `gateway.cutover_state`'s single row. */
export interface StateRecord {
  tableVersion: string | null;
  previousVersion: string | null;
  epoch: bigint;
  activatedAt: Date | null;
  activatedBy: string | null;
}

/** One `gateway.cutover_freeze` row. */
export interface FreezeRecord {
  route: string;
  epoch: bigint;
  frozenAt: Date;
  frozenBy: string;
}

/** One `gateway.instance` row. */
export interface InstanceRecord {
  instanceId: string;
  seenEpoch: bigint;
  startedAt: Date;
  heartbeatAt: Date;
}

/** One `gateway.inflight` row. */
export interface InflightRecord {
  instanceId: string;
  requestId: string;
  route: string;
  side: InflightSide;
  windowId: string | null;
  startedAt: Date;
}

/** One `gateway.legacy_jar` row; `cookies` is the stored jsonb. */
export interface JarRecord {
  sessionId: string;
  legacySessionId: string | null;
  cookies: Record<string, unknown>;
  mode: string;
  hydratedEpoch: bigint | null;
  updatedAt: Date;
  identityEndPendingAt: Date | null;
}

/** One `gateway.session_barrier` row. */
export interface BarrierRecord {
  sessionId: string;
  owner: string;
  xid: bigint | null;
  pending: number;
  recordedAt: Date;
}

/** Committed contents of the gateway schema; suites may seed rows directly. */
export interface GatewayTables {
  state: StateRecord;
  freezes: Map<string, FreezeRecord>;
  instances: Map<string, InstanceRecord>;
  inflight: Map<string, InflightRecord>;
  jars: Map<string, JarRecord>;
  barriers: Map<string, BarrierRecord>;
}

/** Durable rows a request may change, without instance heartbeats, which the refresh loop writes every second. */
export interface DurableSnapshot {
  state: StateRecord;
  freezes: FreezeRecord[];
  inflight: InflightRecord[];
  jars: JarRecord[];
  barriers: BarrierRecord[];
}

/** A TenantDb over the in-memory gateway schema, with its tables exposed for seeding and assertions. */
export interface GatewayDbDouble extends TenantDb {
  /** The committed tables. */
  readonly tables: GatewayTables;
  /** Every statement executed, normalised, in order. */
  readonly statements: readonly string[];
  /** A deep copy of the durable rows. */
  durable(): DurableSnapshot;
}

type Row = QueryResultRow;

interface Outcome {
  command: string;
  rowCount: number;
  rows: Row[];
}

type Handler = (values: readonly unknown[], tables: GatewayTables, now: Date) => Outcome;

/** One-line SQL without schema qualifiers or spacing around parentheses and commas, so equal statements compare equal. */
export function normaliseSql(sql: string): string {
  return sql
    .replace(/"gateway"\.|\bgateway\./g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();
}

function select(rows: Row[]): Outcome {
  return { command: 'SELECT', rowCount: rows.length, rows };
}

function changed(command: string, rowCount: number, rows: Row[] = []): Outcome {
  return { command, rowCount, rows };
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(`gateway db double: expected a text parameter, got ${typeof value}`);
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function texts(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new TypeError('gateway db double: expected a text[] parameter');
  return value.map(text);
}

function bigintOf(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string') return BigInt(value);
  throw new TypeError(`gateway db double: expected an integer parameter, got ${typeof value}`);
}

function numericOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : bigintOf(value);
}

/** `to_char(<ts>::timestamptz, ISO_FORMAT)` in a UTC session. */
function iso(at: Date): string {
  return at.toISOString().replace('Z', '+00:00');
}

function timestampOf(value: unknown): Date {
  const at = new Date(text(value));
  if (Number.isNaN(at.getTime())) throw new TypeError(`gateway db double: invalid timestamptz ${String(value)}`);
  return at;
}

function isLive(instance: InstanceRecord | undefined, now: Date): boolean {
  return instance !== undefined && instance.heartbeatAt.getTime() >= now.getTime() - INSTANCE_LIVENESS_SECONDS * 1000;
}

/** GREATEST over nullable values, which ignores NULL. */
function greatest<T extends bigint | Date>(a: T | null, b: T | null): T | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

const inflightKey = (instanceId: string, requestId: string): string => `${instanceId}\u0000${requestId}`;
const barrierKey = (sessionId: string, owner: string): string => `${sessionId}\u0000${owner}`;

function stateRow(state: StateRecord): Row {
  return { table_version: state.tableVersion, previous_version: state.previousVersion, epoch: String(state.epoch) };
}

function inflightRow(record: InflightRecord): Row {
  return {
    instance_id: record.instanceId,
    request_id: record.requestId,
    route: record.route,
    side: record.side,
    window_id: record.windowId,
    started_at: iso(record.startedAt),
  };
}

function jarRow(record: JarRecord): Row {
  return {
    session_id: record.sessionId,
    legacy_session_id: record.legacySessionId,
    cookies: structuredClone(record.cookies),
    mode: record.mode,
    hydrated_epoch: record.hydratedEpoch === null ? null : String(record.hydratedEpoch),
    updated_at: new Date(record.updatedAt),
    identity_end_pending_at: record.identityEndPendingAt === null ? null : new Date(record.identityEndPendingAt),
  };
}

/** Orphan rows `clearOrphans` addresses: $1 side, $2 evidence time, $3 routes or null, $4 instance ids or null. */
function orphans(values: readonly unknown[], tables: GatewayTables, now: Date): InflightRecord[] {
  const side = text(values[0]);
  const before = timestampOf(values[1]).getTime();
  const routes = texts(values[2]);
  const instanceIds = texts(values[3]);
  return [...tables.inflight.values()].filter(
    (row) =>
      row.side === side &&
      row.startedAt.getTime() < before &&
      (routes === null || routes.includes(row.route)) &&
      (instanceIds === null || instanceIds.includes(row.instanceId)) &&
      !isLive(tables.instances.get(row.instanceId), now),
  );
}

function freshTables(): GatewayTables {
  return {
    state: { tableVersion: null, previousVersion: null, epoch: 0n, activatedAt: null, activatedBy: null },
    freezes: new Map(),
    instances: new Map(),
    inflight: new Map(),
    jars: new Map(),
    barriers: new Map(),
  };
}

/** The statements the gateway's stores issue, keyed by their normalised text. */
function statementHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const on = (sql: string, handler: Handler): void => {
    handlers.set(normaliseSql(sql), handler);
  };

  // Cut-over state (src/cutover/state.ts).
  on('SELECT table_version, previous_version, epoch FROM cutover_state WHERE id = 1', (_values, t) => select([stateRow(t.state)]));
  on("SELECT set_config('statement_timeout', $1, true)", (values) => select([{ set_config: text(values[0]) }]));
  on('SELECT route FROM cutover_freeze', (_values, t) => select([...t.freezes.keys()].map((route) => ({ route }))));
  on('SELECT route FROM cutover_freeze ORDER BY route', (_values, t) =>
    select([...t.freezes.keys()].sort().map((route) => ({ route }))),
  );
  on('SELECT route FROM cutover_freeze WHERE route = ANY($1::text[])', (values, t) => {
    const routes = new Set(texts(values[0]) ?? []);
    return select([...t.freezes.keys()].filter((route) => routes.has(route)).map((route) => ({ route })));
  });
  on(
    'INSERT INTO instance (instance_id, seen_epoch, started_at, heartbeat_at) VALUES ($1, $2, now(), now()) ' +
      'ON CONFLICT (instance_id) DO UPDATE SET seen_epoch = EXCLUDED.seen_epoch, heartbeat_at = now()',
    (values, t, now) => {
      const instanceId = text(values[0]);
      const previous = t.instances.get(instanceId);
      t.instances.set(instanceId, { instanceId, seenEpoch: bigintOf(values[1]), startedAt: previous?.startedAt ?? now, heartbeatAt: now });
      return changed('INSERT', 1);
    },
  );
  on(
    'DELETE FROM instance AS g WHERE g.heartbeat_at < now() - make_interval(secs => $1) ' +
      'AND NOT EXISTS (SELECT 1 FROM inflight AS i WHERE i.instance_id = g.instance_id)',
    (values, t, now) => {
      const cutoff = now.getTime() - Number(bigintOf(values[0])) * 1000;
      const holders = new Set([...t.inflight.values()].map((row) => row.instanceId));
      let deleted = 0;
      for (const [id, instance] of t.instances) {
        if (instance.heartbeatAt.getTime() < cutoff && !holders.has(id)) {
          t.instances.delete(id);
          deleted += 1;
        }
      }
      return changed('DELETE', deleted);
    },
  );
  on(
    `SELECT instance_id, seen_epoch, to_char(heartbeat_at::timestamptz, ${ISO_FORMAT}) AS heartbeat_at, (${LIVE}) AS live ` +
      'FROM instance ORDER BY instance_id',
    (_values, t, now) =>
      select(
        [...t.instances.values()]
          .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1))
          .map((instance) => ({
            instance_id: instance.instanceId,
            seen_epoch: String(instance.seenEpoch),
            heartbeat_at: iso(instance.heartbeatAt),
            live: isLive(instance, now),
          })),
      ),
  );
  on(`SELECT count(*)::int AS lagging FROM instance WHERE ${LIVE} AND seen_epoch < $1`, (values, t, now) => {
    const epoch = bigintOf(values[0]);
    const lagging = [...t.instances.values()].filter((instance) => isLive(instance, now) && instance.seenEpoch < epoch).length;
    return select([{ lagging }]);
  });
  on('UPDATE cutover_state SET epoch = epoch + 1 WHERE id = 1 RETURNING table_version, previous_version, epoch', (_values, t) => {
    t.state = { ...t.state, epoch: t.state.epoch + 1n };
    return changed('UPDATE', 1, [stateRow(t.state)]);
  });
  on(
    'INSERT INTO cutover_freeze (route, epoch, frozen_at, frozen_by) SELECT f.route, $2::bigint, now(), $3::text ' +
      'FROM unnest($1::text[]) AS f(route) ON CONFLICT (route) DO NOTHING',
    (values, t, now) => {
      let inserted = 0;
      for (const route of texts(values[0]) ?? []) {
        if (t.freezes.has(route)) continue;
        t.freezes.set(route, { route, epoch: bigintOf(values[1]), frozenAt: now, frozenBy: text(values[2]) });
        inserted += 1;
      }
      return changed('INSERT', inserted);
    },
  );
  on('DELETE FROM cutover_freeze WHERE route = ANY($1::text[])', (values, t) => {
    let deleted = 0;
    for (const route of texts(values[0]) ?? []) if (t.freezes.delete(route)) deleted += 1;
    return changed('DELETE', deleted);
  });
  on(
    'UPDATE cutover_state SET table_version = $1, previous_version = $2, epoch = epoch + 1, activated_at = now(), ' +
      'activated_by = $3 WHERE id = 1 AND epoch = $4 RETURNING epoch',
    (values, t, now) => {
      if (t.state.epoch !== bigintOf(values[3])) return changed('UPDATE', 0);
      t.state = {
        tableVersion: text(values[0]),
        previousVersion: nullableText(values[1]),
        epoch: t.state.epoch + 1n,
        activatedAt: now,
        activatedBy: text(values[2]),
      };
      return changed('UPDATE', 1, [{ epoch: String(t.state.epoch) }]);
    },
  );

  // In-flight registry (src/cutover/inflight.ts).
  on(
    'INSERT INTO inflight (instance_id, request_id, route, side, window_id, started_at) VALUES ($1, $2, $3, $4, $5, now())',
    (values, t, now) => {
      const record: InflightRecord = {
        instanceId: text(values[0]),
        requestId: text(values[1]),
        route: text(values[2]),
        side: text(values[3]) as InflightSide,
        windowId: nullableText(values[4]),
        startedAt: now,
      };
      const key = inflightKey(record.instanceId, record.requestId);
      if (t.inflight.has(key)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "inflight_pkey"'), { code: '23505' });
      }
      t.inflight.set(key, record);
      return changed('INSERT', 1);
    },
  );
  on('DELETE FROM inflight WHERE instance_id = $1 AND request_id = $2', (values, t) =>
    changed('DELETE', t.inflight.delete(inflightKey(text(values[0]), text(values[1]))) ? 1 : 0),
  );
  on(
    `SELECT i.instance_id, i.route, i.side, count(*)::int AS count, to_char(min(i.started_at)::timestamptz, ${ISO_FORMAT}) ` +
      'AS oldest_started_at FROM inflight AS i GROUP BY i.instance_id, i.route, i.side ORDER BY i.instance_id, i.route, i.side',
    (_values, t) => {
      const groups = new Map<string, { row: InflightRecord; count: number; oldest: Date }>();
      for (const row of t.inflight.values()) {
        const key = [row.instanceId, row.route, row.side].join('\u0000');
        const group = groups.get(key);
        if (group === undefined) groups.set(key, { row, count: 1, oldest: row.startedAt });
        else groups.set(key, { row, count: group.count + 1, oldest: row.startedAt < group.oldest ? row.startedAt : group.oldest });
      }
      return select(
        [...groups.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([, { row, count, oldest }]) => ({
            instance_id: row.instanceId,
            route: row.route,
            side: row.side,
            count,
            oldest_started_at: iso(oldest),
          })),
      );
    },
  );
  on(`SELECT DISTINCT i.route FROM inflight AS i WHERE ${ORPHAN_WHERE}`, (values, t, now) =>
    select([...new Set(orphans(values, t, now).map((row) => row.route))].map((route) => ({ route }))),
  );
  on(`DELETE FROM inflight AS i WHERE ${ORPHAN_WHERE} RETURNING ${INFLIGHT_COLUMNS}`, (values, t, now) => {
    const rows = orphans(values, t, now);
    for (const row of rows) t.inflight.delete(inflightKey(row.instanceId, row.requestId));
    return changed('DELETE', rows.length, rows.map(inflightRow));
  });

  // Legacy jar (src/session/jar.ts); advisory locks are moot because transactions run one at a time.
  on('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', () => select([{ pg_advisory_xact_lock: '' }]));
  on(`SELECT ${JAR_COLUMNS} FROM legacy_jar WHERE session_id = $1`, (values, t) => {
    const record = t.jars.get(text(values[0]));
    return select(record === undefined ? [] : [jarRow(record)]);
  });
  on(`SELECT ${JAR_COLUMNS} FROM legacy_jar WHERE legacy_session_id = $1`, (values, t) => {
    const legacySessionId = text(values[0]);
    return select([...t.jars.values()].filter((record) => record.legacySessionId === legacySessionId).map(jarRow));
  });
  on(
    `INSERT INTO legacy_jar AS jar (${JAR_UPSERT_COLUMNS}) VALUES ($1, $2, $3::jsonb, $4, $5, now()) ON CONFLICT (session_id) ` +
      'DO UPDATE SET legacy_session_id = EXCLUDED.legacy_session_id, cookies = jar.cookies || EXCLUDED.cookies, ' +
      `mode = EXCLUDED.mode, hydrated_epoch = EXCLUDED.hydrated_epoch, updated_at = EXCLUDED.updated_at RETURNING ${JAR_COLUMNS}`,
    (values, t, now) => {
      const sessionId = text(values[0]);
      const legacySessionId = nullableText(values[1]);
      const cookies = JSON.parse(text(values[2])) as Record<string, unknown>;
      const holder = [...t.jars.values()].find((record) => legacySessionId !== null && record.legacySessionId === legacySessionId);
      if (holder !== undefined && holder.sessionId !== sessionId) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "legacy_jar_legacy_session_uidx"'), {
          code: '23505',
        });
      }
      const previous = t.jars.get(sessionId);
      const record: JarRecord = {
        sessionId,
        legacySessionId,
        cookies: { ...(previous?.cookies ?? {}), ...cookies },
        mode: text(values[3]),
        hydratedEpoch: numericOrNull(values[4]),
        updatedAt: now,
        identityEndPendingAt: previous?.identityEndPendingAt ?? null,
      };
      t.jars.set(sessionId, record);
      return changed('INSERT', 1, [jarRow(record)]);
    },
  );
  on(
    'WITH kept AS (UPDATE legacy_jar SET legacy_session_id = NULL, cookies = \'{}\'::jsonb, hydrated_epoch = NULL, updated_at = now() ' +
      'WHERE session_id <> $1 AND (session_id = $2 OR legacy_session_id = $3) AND identity_end_pending_at IS NOT NULL ' +
      'RETURNING session_id), removed AS (DELETE FROM legacy_jar WHERE session_id <> $1 AND (session_id = $2 OR ' +
      'legacy_session_id = $3) AND identity_end_pending_at IS NULL RETURNING session_id) ' +
      'SELECT session_id FROM kept UNION ALL SELECT session_id FROM removed',
    (values, t, now) => {
      const sessionId = text(values[0]);
      const previous = nullableText(values[1]);
      const legacySessionId = nullableText(values[2]);
      const kept: string[] = [];
      const removed: string[] = [];
      for (const record of [...t.jars.values()]) {
        const holds = record.sessionId === previous || (legacySessionId !== null && record.legacySessionId === legacySessionId);
        if (record.sessionId === sessionId || !holds) continue;
        if (record.identityEndPendingAt === null) {
          t.jars.delete(record.sessionId);
          removed.push(record.sessionId);
        } else {
          t.jars.set(record.sessionId, { ...record, legacySessionId: null, cookies: {}, hydratedEpoch: null, updatedAt: now });
          kept.push(record.sessionId);
        }
      }
      return select([...kept, ...removed].map((id) => ({ session_id: id })));
    },
  );
  on(
    'WITH moved AS (DELETE FROM session_barrier WHERE session_id = ANY($2::text[]) RETURNING owner, xid, pending, recorded_at) ' +
      'INSERT INTO session_barrier AS b (session_id, owner, xid, pending, recorded_at) SELECT $1, owner, max(xid), ' +
      'sum(pending)::integer, max(recorded_at) FROM moved GROUP BY owner ON CONFLICT (session_id, owner) DO UPDATE SET ' +
      'xid = GREATEST(b.xid, EXCLUDED.xid), pending = b.pending + EXCLUDED.pending, recorded_at = GREATEST(b.recorded_at, EXCLUDED.recorded_at)',
    (values, t) => {
      const target = text(values[0]);
      const sources = new Set(texts(values[1]) ?? []);
      const moved = new Map<string, { xid: bigint | null; pending: number; recordedAt: Date }>();
      for (const [key, row] of [...t.barriers]) {
        if (!sources.has(row.sessionId)) continue;
        t.barriers.delete(key);
        const sum = moved.get(row.owner);
        moved.set(row.owner, {
          xid: greatest(sum?.xid ?? null, row.xid),
          pending: (sum?.pending ?? 0) + row.pending,
          recordedAt: greatest(sum?.recordedAt ?? null, row.recordedAt) ?? row.recordedAt,
        });
      }
      for (const [owner, sum] of moved) {
        const key = barrierKey(target, owner);
        const existing = t.barriers.get(key);
        t.barriers.set(key, {
          sessionId: target,
          owner,
          xid: greatest(existing?.xid ?? null, sum.xid),
          pending: (existing?.pending ?? 0) + sum.pending,
          recordedAt: greatest(existing?.recordedAt ?? null, sum.recordedAt) ?? sum.recordedAt,
        });
      }
      return changed('INSERT', moved.size);
    },
  );

  // Session barrier (src/dispatcher/barrier.ts).
  on(
    'INSERT INTO session_barrier AS b (session_id, owner, pending, recorded_at) VALUES ($1, $2, 1, now()) ' +
      'ON CONFLICT (session_id, owner) DO UPDATE SET pending = b.pending + 1',
    (values, t, now) => {
      const sessionId = text(values[0]);
      const owner = text(values[1]);
      const key = barrierKey(sessionId, owner);
      const existing = t.barriers.get(key);
      t.barriers.set(
        key,
        existing === undefined
          ? { sessionId, owner, xid: null, pending: 1, recordedAt: now }
          : { ...existing, pending: existing.pending + 1 },
      );
      return changed('INSERT', 1);
    },
  );
  on(END_DECLARATION, (values, t) => {
    const key = barrierKey(text(values[0]), text(values[1]));
    const row = t.barriers.get(key);
    if (row === undefined || row.pending === 0) return changed('UPDATE', 0);
    if (row.pending === 1 && row.xid === null) {
      t.barriers.delete(key);
      return changed('UPDATE', 0);
    }
    t.barriers.set(key, { ...row, pending: row.pending - 1 });
    return changed('UPDATE', 1);
  });
  on(
    'INSERT INTO session_barrier AS b (session_id, owner, xid, recorded_at) SELECT $1, p.owner, p.xid, now() ' +
      'FROM unnest($2::text[], $3::numeric[]) AS p(owner, xid) ON CONFLICT (session_id, owner) DO UPDATE SET ' +
      'xid = GREATEST(b.xid, EXCLUDED.xid), recorded_at = EXCLUDED.recorded_at',
    (values, t, now) => {
      const sessionId = text(values[0]);
      const owners = texts(values[1]) ?? [];
      const xids = Array.isArray(values[2]) ? values[2] : [];
      owners.forEach((owner, index) => {
        const key = barrierKey(sessionId, owner);
        const existing = t.barriers.get(key);
        const xid = numericOrNull(xids[index]);
        t.barriers.set(key, {
          sessionId,
          owner,
          xid: existing === undefined ? xid : greatest(existing.xid, xid),
          pending: existing?.pending ?? 0,
          recordedAt: now,
        });
      });
      return changed('INSERT', owners.length);
    },
  );
  on('SELECT owner, xid::text AS xid, pending FROM session_barrier WHERE session_id = $1', (values, t) => {
    const sessionId = text(values[0]);
    return select(
      [...t.barriers.values()]
        .filter((row) => row.sessionId === sessionId)
        .map((row) => ({ owner: row.owner, xid: row.xid === null ? null : row.xid.toString(), pending: row.pending })),
    );
  });
  on(
    'DELETE FROM session_barrier AS b USING unnest($2::text[], $3::numeric[]) AS p(owner, xid) ' +
      'WHERE b.session_id = $1 AND b.owner = p.owner AND b.pending = 0 AND (b.xid IS NULL OR b.xid <= p.xid)',
    (values, t) => {
      const sessionId = text(values[0]);
      const owners = texts(values[1]) ?? [];
      const xids = Array.isArray(values[2]) ? values[2] : [];
      let deleted = 0;
      owners.forEach((owner, index) => {
        const key = barrierKey(sessionId, owner);
        const row = t.barriers.get(key);
        const confirmed = numericOrNull(xids[index]);
        if (row === undefined || row.pending !== 0) return;
        if (row.xid !== null && (confirmed === null || row.xid > confirmed)) return;
        t.barriers.delete(key);
        deleted += 1;
      });
      return changed('DELETE', deleted);
    },
  );
  return handlers;
}

/**
 * Creates an empty gateway schema whose `cutover_state` row is seeded as migration 0001 seeds it. Transactions run one at a
 * time and roll back on rejection; an unknown statement rejects, so a store change the double does not model fails loudly.
 */
export function createGatewayDb(opts: { onCommitError?: CommitErrorHandler } = {}): GatewayDbDouble {
  const handlers = statementHandlers();
  const statements: string[] = [];
  let tables = freshTables();
  let queue: Promise<unknown> = Promise.resolve();
  let ended = false;

  async function transaction<T>(fn: (tx: MetadataTx) => Promise<T>, options?: TransactionCallOptions): Promise<T> {
    if (ended) throw new Error('gateway db double: the pool has ended');
    options?.signal?.throwIfAborted();
    const before = structuredClone(tables);
    const commits: Array<{ cb: CommitCallback; onError: CommitErrorHandler | undefined }> = [];
    const now = new Date();
    const query = async <R extends QueryResultRow = QueryResultRow>(
      textOrConfig: string | QueryConfig,
      values?: unknown[],
    ): Promise<QueryResult<R>> => {
      const sql = normaliseSql(typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text);
      const params = values ?? (typeof textOrConfig === 'string' ? [] : (textOrConfig.values ?? []));
      const handler = handlers.get(sql);
      if (handler === undefined) throw new Error(`gateway db double: unsupported statement: ${sql}`);
      statements.push(sql);
      const outcome = handler(params, tables, now);
      return { command: outcome.command, rowCount: outcome.rowCount, oid: 0, fields: [], rows: outcome.rows as R[] };
    };
    const tx: MetadataTx = {
      kind: 'metadata',
      schema: SCHEMA,
      query,
      onCommit(cb, onError) {
        commits.push({ cb, onError });
      },
    };
    let result: T;
    try {
      result = await fn(tx);
      options?.signal?.throwIfAborted();
    } catch (error) {
      tables = before;
      throw error;
    }
    for (const { cb, onError } of commits) {
      try {
        await cb();
      } catch (error) {
        const handle = onError ?? opts.onCommitError;
        if (handle === undefined) throw error;
        handle(error);
      }
    }
    return result;
  }

  return {
    schema: SCHEMA,
    get tables() {
      return tables;
    },
    statements,
    withMetadata<T>(fn: (tx: MetadataTx) => Promise<T>, options?: TransactionCallOptions): Promise<T> {
      const run = queue.then(() => transaction(fn, options));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    withTenant() {
      return Promise.reject(new Error('gateway db double: the gateway schema has no tenant tables'));
    },
    async end() {
      ended = true;
      await queue;
    },
    durable() {
      return structuredClone({
        state: tables.state,
        freezes: [...tables.freezes.values()],
        inflight: [...tables.inflight.values()],
        jars: [...tables.jars.values()],
        barriers: [...tables.barriers.values()],
      });
    },
  };
}
