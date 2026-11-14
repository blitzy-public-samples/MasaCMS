// The `gateway` schema without PostgreSQL: a fake pg pool whose interpreter answers the statements of the cut-over state,
// in-flight registry, legacy jar and session barrier, driven by the platform's own transaction runner.
import {
  tenantDbFromPool,
  type Pool,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
  type TenantDb,
} from '@opt2/platform/tenancy';

/** `gateway.cutover_state` row, valued as node-postgres returns it (bigint as decimal text, timestamps as Date). */
export type CutoverStateRow = {
  id: number;
  table_version: string | null;
  previous_version: string | null;
  epoch: string;
  activated_at: Date | null;
  activated_by: string | null;
};

/** `gateway.cutover_freeze` row. */
export type CutoverFreezeRow = {
  route: string;
  epoch: string;
  frozen_at: Date;
  frozen_by: string;
};

/** `gateway.instance` row. */
export type InstanceRow = {
  instance_id: string;
  seen_epoch: string;
  started_at: Date;
  heartbeat_at: Date;
};

/** `gateway.inflight` row. */
export type InflightRowRecord = {
  instance_id: string;
  request_id: string;
  route: string;
  side: 'legacy' | 'target';
  window_id: string | null;
  started_at: Date;
};

/** `gateway.legacy_jar` row; `cookies` is the parsed jsonb. */
export type LegacyJarRow = {
  session_id: string;
  legacy_session_id: string | null;
  cookies: Record<string, unknown>;
  mode: 'legacy-primary' | 'target-primary';
  hydrated_epoch: string | null;
  updated_at: Date;
  identity_end_pending_at: Date | null;
};

/** `gateway.session_barrier` row; `xid` is numeric(20,0) as decimal text. */
export type SessionBarrierRow = {
  session_id: string;
  owner: string;
  xid: string | null;
  pending: number;
  recorded_at: Date;
};

/** Rows of every `gateway` table, in storage order; suites may read and seed them between transactions. */
export interface GatewayTables {
  cutover_state: CutoverStateRow[];
  cutover_freeze: CutoverFreezeRow[];
  instance: InstanceRow[];
  inflight: InflightRowRecord[];
  legacy_jar: LegacyJarRow[];
  session_barrier: SessionBarrierRow[];
}

/** Committed state a store starts with; omitted non-key columns take their defaults, a missing key column fails as NOT NULL. */
export interface MemoryGatewaySeed {
  activeVersion?: { tableVersion: string; previous?: string | null; epoch?: number };
  freezes?: Partial<CutoverFreezeRow>[];
  instances?: Partial<InstanceRow>[];
  inflight?: Partial<InflightRowRecord>[];
  jars?: Partial<LegacyJarRow>[];
  barriers?: Partial<SessionBarrierRow>[];
}

/** A statement the fake pool received; `text` is the SQL as issued with whitespace collapsed. */
export interface RecordedQuery {
  text: string;
  values: unknown[];
}

/** Raised for a statement no handler models, so a store change the gateway makes fails loudly. */
export class UnsupportedStatementError extends Error {
  override readonly name = 'UnsupportedStatementError';

  constructor(readonly statement: string) {
    super(`memory gateway db: unsupported statement: ${statement}`);
  }
}

/** Selects the statements an override answers: a string or RegExp tested on the normalised SQL, or a predicate. */
export type QueryMatcher = string | RegExp | ((query: RecordedQuery) => boolean);

/** Rows an override answers, or a function computing them that may throw (a database failure) or never settle (a hang). */
export type QueryResponse = unknown[] | ((query: RecordedQuery) => unknown[] | Promise<unknown[]>);

/** `TenantDb` of schema `gateway` over the in-memory tables, with its statements recorded and overridable. */
export interface MemoryGatewayDb extends TenantDb {
  /** The tables, changed in place; a rollback restores them in place. */
  readonly tables: GatewayTables;
  /** Every statement received, transaction control included, in arrival order. */
  readonly queries: RecordedQuery[];
  /** Empties `queries`, drops every override and resets the tables to the seeded state. */
  clear(): void;
  /** Answers matching statements ahead of the interpreter, first-installed first; BEGIN, COMMIT and ROLLBACK are never overridden. */
  respond(matcher: QueryMatcher, result: QueryResponse): void;
  /** Commits another instance's heartbeat: upserts its `instance` row, keeping `started_at`. */
  heartbeat(instanceId: string, seenEpoch: number, at?: Date): void;
  /** Commits an activation of `tableVersion`; `previous` defaults to the active version and `epoch` to the current one plus 1. */
  setActive(tableVersion: string, opts?: { previous?: string | null; epoch?: number }): void;
}

type TableName = keyof GatewayTables;
type Row = Record<string, unknown>;

const TABLE_NAMES: readonly TableName[] = ['cutover_state', 'cutover_freeze', 'instance', 'inflight', 'legacy_jar', 'session_barrier'];

/** The schema the store models; only its qualifier is stripped from statements. */
const SCHEMA = 'gateway';

interface UniqueIndex {
  name: string;
  columns: readonly string[];
  /** Predicate of a partial index. */
  where?: (row: Row) => boolean;
}

interface CheckConstraint {
  name: string;
  test: (row: Row) => boolean;
}

interface TableDef {
  notNull: readonly string[];
  unique: readonly UniqueIndex[];
  checks: readonly CheckConstraint[];
}

const primaryKey = (table: TableName, columns: readonly string[]): UniqueIndex => ({ name: `${table}_pkey`, columns });

/** Constraints of migrations 0001–0004, under PostgreSQL's default constraint names. */
const TABLE_DEFS: Readonly<Record<TableName, TableDef>> = {
  cutover_state: {
    notNull: ['id', 'epoch'],
    unique: [primaryKey('cutover_state', ['id'])],
    checks: [{ name: 'cutover_state_id_check', test: (row) => row.id === 1 }],
  },
  cutover_freeze: {
    notNull: ['route', 'epoch', 'frozen_at', 'frozen_by'],
    unique: [primaryKey('cutover_freeze', ['route'])],
    checks: [],
  },
  instance: {
    notNull: ['instance_id', 'seen_epoch', 'started_at', 'heartbeat_at'],
    unique: [primaryKey('instance', ['instance_id'])],
    checks: [],
  },
  inflight: {
    notNull: ['instance_id', 'request_id', 'route', 'side', 'started_at'],
    unique: [primaryKey('inflight', ['instance_id', 'request_id'])],
    checks: [{ name: 'inflight_side_check', test: (row) => row.side === 'legacy' || row.side === 'target' }],
  },
  legacy_jar: {
    notNull: ['session_id', 'cookies', 'mode', 'updated_at'],
    unique: [
      primaryKey('legacy_jar', ['session_id']),
      { name: 'legacy_jar_legacy_session_uidx', columns: ['legacy_session_id'], where: (row) => row.legacy_session_id != null },
    ],
    checks: [{ name: 'legacy_jar_mode_check', test: (row) => row.mode === 'legacy-primary' || row.mode === 'target-primary' }],
  },
  session_barrier: {
    notNull: ['session_id', 'owner', 'pending', 'recorded_at'],
    unique: [primaryKey('session_barrier', ['session_id', 'owner'])],
    checks: [{ name: 'session_barrier_pending_check', test: (row) => typeof row.pending === 'number' && row.pending >= 0 }],
  },
};

/** A node-postgres-shaped error with SQLSTATE `code`. */
function pgError(code: string, message: string, fields: Readonly<Record<string, string>> = {}): Error {
  return Object.assign(new Error(message), { severity: 'ERROR', code, schema: SCHEMA, ...fields });
}

function checkRow(table: TableName, row: Row): void {
  const def = TABLE_DEFS[table];
  for (const column of def.notNull) {
    if (row[column] == null) {
      throw pgError('23502', `null value in column "${column}" of relation "${table}" violates not-null constraint`, { table, column });
    }
  }
  for (const check of def.checks) {
    if (!check.test(row)) {
      throw pgError('23514', `new row for relation "${table}" violates check constraint "${check.name}"`, { table, constraint: check.name });
    }
  }
}

/** Every row's NOT NULL and CHECK constraints, then every unique index, as a statement's end-of-statement checks. */
function validateTable(table: TableName, rows: readonly Row[]): void {
  for (const row of rows) checkRow(table, row);
  for (const index of TABLE_DEFS[table].unique) {
    const seen = new Set<string>();
    for (const row of rows) {
      if (index.where !== undefined && !index.where(row)) continue;
      const key = JSON.stringify(index.columns.map((column) => row[column]));
      if (seen.has(key)) {
        const values = index.columns.map((column) => String(row[column])).join(', ');
        throw pgError('23505', `duplicate key value violates unique constraint "${index.name}"`, {
          table,
          constraint: index.name,
          detail: `Key (${index.columns.join(', ')})=(${values}) already exists.`,
        });
      }
      seen.add(key);
    }
  }
}

/** A parameter as node-postgres serialises it: NULL, text, a Date's ISO form or JSON for objects. */
function pgText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

/** A bigint parameter as the decimal text pg returns for it. */
function bigintText(value: unknown): string | null {
  const text = pgText(value);
  if (text === null) return null;
  if (!/^\s*[+-]?\d+\s*$/.test(text)) throw pgError('22P02', `invalid input syntax for type bigint: "${text}"`);
  const parsed = BigInt(text.trim());
  if (parsed < INT8_MIN || parsed > INT8_MAX) throw pgError('22003', `value "${text}" is out of range for type bigint`);
  return parsed.toString();
}

/** A numeric(20,0) parameter, rounded half away from zero, as decimal text. */
function numericText(value: unknown): string | null {
  const text = pgText(value);
  if (text === null) return null;
  const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/.exec(text);
  if (match === null || (match[2] === '' && !match[3])) throw pgError('22P02', `invalid input syntax for type numeric: "${text}"`);
  let magnitude = BigInt(match[2] || '0');
  if ((match[3] ?? '') >= '5') magnitude += 1n;
  if (magnitude.toString().length > 20) {
    throw pgError('22003', 'numeric field overflow', {
      detail: 'A field with precision 20, scale 0 must round to an absolute value less than 10^20.',
    });
  }
  return (match[1] === '-' ? -magnitude : magnitude).toString();
}

/** A double precision parameter. */
function doubleValue(value: unknown): number | null {
  const text = pgText(value);
  if (text === null) return null;
  const parsed = Number(text);
  if (text.trim() === '' || Number.isNaN(parsed)) throw pgError('22P02', `invalid input syntax for type double precision: "${text}"`);
  return parsed;
}

/** A timestamptz parameter as the instant it names. */
function timestamptzValue(value: unknown): Date | null {
  const text = pgText(value);
  if (text === null) return null;
  const at = value instanceof Date ? new Date(value.getTime()) : new Date(text);
  if (Number.isNaN(at.getTime())) throw pgError('22007', `invalid input syntax for type timestamp with time zone: "${text}"`);
  return at;
}

/** An array parameter of `element`; NULL stays NULL. */
function arrayParam<T>(value: unknown, element: (item: unknown) => T): T[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw pgError('22P02', `malformed array literal: "${pgText(value) ?? ''}"`);
  return value.map(element);
}

const textArray = (value: unknown): Array<string | null> | null => arrayParam(value, pgText);
const numericArray = (value: unknown): Array<string | null> | null => arrayParam(value, numericText);

/** Rows of `unnest(a, b)`: the longer array's length, the shorter padded with NULL; a NULL array yields nothing. */
function unnest2<A, B>(a: A[] | null, b: B[] | null): Array<[A | null, B | null]> {
  const left = a ?? [];
  const right = b ?? [];
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i): [A | null, B | null] => [left[i] ?? null, right[i] ?? null]);
}

/** A jsonb value with object keys in jsonb's storage order: shorter keys first, then by bytes. */
function jsonbCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbCanonical);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value as Row).sort(
    ([a], [b]) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  return Object.fromEntries(entries.map(([key, item]) => [key, jsonbCanonical(item)]));
}

/** A jsonb parameter, parsed from the JSON text pg sends. */
function jsonbValue(value: unknown): unknown {
  const text = pgText(value);
  if (text === null) return null;
  try {
    return jsonbCanonical(JSON.parse(text));
  } catch {
    throw pgError('22P02', 'invalid input syntax for type json');
  }
}

/** jsonb `||`: objects merge with the right side winning; anything else concatenates as arrays. */
function jsonbConcat(left: unknown, right: unknown): unknown {
  if (left == null || right == null) return null;
  const isObject = (item: unknown): item is Row => typeof item === 'object' && item !== null && !Array.isArray(item);
  if (isObject(left) && isObject(right)) return jsonbCanonical({ ...left, ...right });
  return [...(Array.isArray(left) ? left : [left]), ...(Array.isArray(right) ? right : [right])];
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `to_char(ts::timestamptz, 'YYYY-MM-DD"T"HH24:MI:SS.MSTZH:TZM')` in a session whose TimeZone is the process zone. */
function isoLocal(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return (
    `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}${zone}`
  );
}

/** Code-unit text order, as a C collation sorts. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** GREATEST of two nullable numeric texts, which ignores NULL. */
function greatestNumeric(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

function latest(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/** SQL whitespace-collapsed, lower-cased, without the `gateway` qualifier or spaces around parentheses and commas. */
function normaliseSql(sql: string): string {
  return sql
    .replace(/"gateway"\.|\bgateway\./g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
    .toLowerCase();
}

/** A statement shape matching normalised SQL exactly; `{n}` captures digits, `{name}` a setting name, `{bool}` true or false. */
function shape(template: string): RegExp {
  const escaped = normaliseSql(template).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = escaped
    .replace(/\\\{n\\\}/g, '(\\d+)')
    .replace(/\\\{name\\\}/g, '([a-z_.]+)')
    .replace(/\\\{bool\\\}/g, '(true|false)');
  return new RegExp(`^${source}$`);
}

interface Exec {
  readonly params: readonly unknown[];
  /** Values of the shape's `{n}`, `{name}` and `{bool}` placeholders, in order. */
  readonly captures: readonly string[];
  readonly tables: GatewayTables;
  /** `now()`: the transaction's start, or the statement's time outside a transaction. */
  readonly now: Date;
}

interface Outcome {
  rows: Row[];
  rowCount: number;
}

interface Handler {
  pattern: RegExp;
  command: string;
  /** Tables whose constraints are checked after the statement. */
  writes: readonly TableName[];
  run(exec: Exec): Outcome;
}

const HANDLERS: Handler[] = [];

function on(template: string, command: string, writes: readonly TableName[], run: (exec: Exec) => Outcome): void {
  HANDLERS.push({ pattern: shape(template), command, writes, run });
}

const selected = (rows: Row[]): Outcome => ({ rows, rowCount: rows.length });
const changed = (rowCount: number, rows: Row[] = []): Outcome => ({ rows, rowCount });
const copyRow = (row: object): Row => structuredClone(row) as Row;
const stamp = (at: Date): Date => new Date(at.getTime());

function stateRow(tables: GatewayTables): CutoverStateRow | undefined {
  return tables.cutover_state.find((row) => row.id === 1);
}

function incremented(epoch: string): string {
  const next = BigInt(epoch) + 1n;
  if (next > INT8_MAX) throw pgError('22003', 'bigint out of range');
  return next.toString();
}

function isLive(row: InstanceRow, now: Date, seconds: number): boolean {
  return row.heartbeat_at.getTime() >= now.getTime() - seconds * 1000;
}

/** Deletes the rows `test` selects, all judged before any goes, and returns them in storage order. */
function removeWhere<T>(rows: T[], test: (row: T) => boolean): T[] {
  const kept: T[] = [];
  const removed: T[] = [];
  for (const row of rows) (test(row) ? removed : kept).push(row);
  rows.splice(0, rows.length, ...kept);
  return removed;
}

function inflightOut(row: InflightRowRecord): Row {
  return {
    instance_id: row.instance_id,
    request_id: row.request_id,
    route: row.route,
    side: row.side,
    window_id: row.window_id,
    started_at: isoLocal(row.started_at),
  };
}

function byStartThenKey(a: InflightRowRecord, b: InflightRowRecord): number {
  return (
    a.started_at.getTime() - b.started_at.getTime() || compareText(a.instance_id, b.instance_id) || compareText(a.request_id, b.request_id)
  );
}

/** Rows of `inflight.ts`'s orphan predicate: $1 side, $2 evidence time, $3 routes or NULL, $4 instance ids or NULL. */
function orphans({ params, captures, tables, now }: Exec): InflightRowRecord[] {
  const side = pgText(params[0]);
  const before = timestamptzValue(params[1]);
  const routes = textArray(params[2]);
  const instanceIds = textArray(params[3]);
  const seconds = Number(captures[0]);
  return tables.inflight.filter(
    (row) =>
      row.side === side &&
      before !== null &&
      row.started_at.getTime() < before.getTime() &&
      (routes === null || routes.includes(row.route)) &&
      (instanceIds === null || instanceIds.includes(row.instance_id)) &&
      !tables.instance.some((g) => g.instance_id === row.instance_id && isLive(g, now, seconds)),
  );
}

function findJar(tables: GatewayTables, sessionId: string | null): LegacyJarRow | undefined {
  return tables.legacy_jar.find((row) => row.session_id === sessionId);
}

/** Inserts `proposed`, or applies `update` to the row holding its key, as `ON CONFLICT (session_id, owner) DO UPDATE`. */
function upsertBarrier(
  tables: GatewayTables,
  proposed: SessionBarrierRow,
  update: (existing: SessionBarrierRow) => Partial<SessionBarrierRow>,
): void {
  const existing = tables.session_barrier.find((row) => row.session_id === proposed.session_id && row.owner === proposed.owner);
  if (existing === undefined) tables.session_barrier.push(proposed);
  else Object.assign(existing, update(existing));
}

function affectedTwice(): Error {
  return pgError('21000', 'ON CONFLICT DO UPDATE command cannot affect row a second time', {
    hint: 'Ensure that no rows proposed for insertion within the same command have duplicate constrained values.',
  });
}

const ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MSTZH:TZM'`;
const LIVE = `heartbeat_at >= now() - interval '{n} seconds'`;
const INFLIGHT_COLUMNS =
  `i.instance_id, i.request_id, i.route, i.side, i.window_id, to_char(i.started_at::timestamptz, ${ISO_FORMAT}) AS started_at`;
const ORPHAN_WHERE =
  `i.side = $1 AND i.started_at < $2::timestamptz AND ($3::text[] IS NULL OR i.route = ANY($3::text[])) ` +
  `AND ($4::text[] IS NULL OR i.instance_id = ANY($4::text[])) AND NOT EXISTS (SELECT 1 FROM instance AS g ` +
  `WHERE g.instance_id = i.instance_id AND g.${LIVE})`;
const JAR_UPSERT_COLUMNS = 'session_id, legacy_session_id, cookies, mode, hydrated_epoch, updated_at';
const JAR_COLUMNS = `${JAR_UPSERT_COLUMNS}, identity_end_pending_at`;

// Settings: the platform's app.tenant_id and the state's statement_timeout; the timeout bounds nothing here.
on(`SELECT set_config('{name}', $1, {bool})`, 'SELECT', [], ({ params }) => selected([{ set_config: pgText(params[0]) }]));

// Cut-over state, freezes and instances (src/cutover/state.ts).
on('SELECT table_version, previous_version, epoch FROM cutover_state WHERE id = 1', 'SELECT', [], ({ tables }) => {
  const row = stateRow(tables);
  return selected(row === undefined ? [] : [{ table_version: row.table_version, previous_version: row.previous_version, epoch: row.epoch }]);
});

on('SELECT route FROM cutover_freeze', 'SELECT', [], ({ tables }) => selected(tables.cutover_freeze.map((row) => ({ route: row.route }))));

on('SELECT route FROM cutover_freeze ORDER BY route', 'SELECT', [], ({ tables }) =>
  selected(tables.cutover_freeze.map((row) => row.route).sort(compareText).map((route) => ({ route }))),
);

on('SELECT route FROM cutover_freeze WHERE route = ANY($1::text[])', 'SELECT', [], ({ params, tables }) => {
  const routes = textArray(params[0]) ?? [];
  return selected(tables.cutover_freeze.filter((row) => routes.includes(row.route)).map((row) => ({ route: row.route })));
});

on(
  'INSERT INTO instance (instance_id, seen_epoch, started_at, heartbeat_at) VALUES ($1, $2, now(), now()) ' +
    'ON CONFLICT (instance_id) DO UPDATE SET seen_epoch = EXCLUDED.seen_epoch, heartbeat_at = now()',
  'INSERT',
  ['instance'],
  ({ params, tables, now }) => {
    const proposed = { instance_id: pgText(params[0]), seen_epoch: bigintText(params[1]), started_at: stamp(now), heartbeat_at: stamp(now) } as InstanceRow;
    checkRow('instance', proposed);
    const existing = tables.instance.find((row) => row.instance_id === proposed.instance_id);
    if (existing === undefined) tables.instance.push(proposed);
    else Object.assign(existing, { seen_epoch: proposed.seen_epoch, heartbeat_at: stamp(now) });
    return changed(1);
  },
);

on(`SELECT count(*)::int AS lagging FROM instance WHERE ${LIVE} AND seen_epoch < $1`, 'SELECT', [], ({ params, captures, tables, now }) => {
  const epoch = bigintText(params[0]);
  const seconds = Number(captures[0]);
  const lagging =
    epoch === null ? 0 : tables.instance.filter((row) => isLive(row, now, seconds) && BigInt(row.seen_epoch) < BigInt(epoch)).length;
  return selected([{ lagging }]);
});

on(
  'DELETE FROM instance AS g WHERE g.heartbeat_at < now() - make_interval(secs => $1) ' +
    'AND NOT EXISTS (SELECT 1 FROM inflight AS i WHERE i.instance_id = g.instance_id)',
  'DELETE',
  ['instance'],
  ({ params, tables, now }) => {
    const seconds = doubleValue(params[0]);
    if (seconds === null) return changed(0);
    const cutoff = now.getTime() - seconds * 1000;
    const holders = new Set(tables.inflight.map((row) => row.instance_id));
    return changed(removeWhere(tables.instance, (row) => row.heartbeat_at.getTime() < cutoff && !holders.has(row.instance_id)).length);
  },
);

on(
  `SELECT instance_id, seen_epoch, to_char(heartbeat_at::timestamptz, ${ISO_FORMAT}) AS heartbeat_at, (${LIVE}) AS live ` +
    'FROM instance ORDER BY instance_id',
  'SELECT',
  [],
  ({ captures, tables, now }) => {
    const seconds = Number(captures[0]);
    return selected(
      [...tables.instance]
        .sort((a, b) => compareText(a.instance_id, b.instance_id))
        .map((row) => ({
          instance_id: row.instance_id,
          seen_epoch: row.seen_epoch,
          heartbeat_at: isoLocal(row.heartbeat_at),
          live: isLive(row, now, seconds),
        })),
    );
  },
);

on(
  'UPDATE cutover_state SET epoch = epoch + 1 WHERE id = 1 RETURNING table_version, previous_version, epoch',
  'UPDATE',
  ['cutover_state'],
  ({ tables }) => {
    const row = stateRow(tables);
    if (row === undefined) return changed(0);
    row.epoch = incremented(row.epoch);
    return changed(1, [{ table_version: row.table_version, previous_version: row.previous_version, epoch: row.epoch }]);
  },
);

on(
  'INSERT INTO cutover_freeze (route, epoch, frozen_at, frozen_by) SELECT f.route, $2::bigint, now(), $3::text ' +
    'FROM unnest($1::text[]) AS f(route) ON CONFLICT (route) DO NOTHING',
  'INSERT',
  ['cutover_freeze'],
  ({ params, tables, now }) => {
    const epoch = bigintText(params[1]);
    const frozenBy = pgText(params[2]);
    let inserted = 0;
    for (const route of textArray(params[0]) ?? []) {
      const proposed = { route, epoch, frozen_at: stamp(now), frozen_by: frozenBy } as CutoverFreezeRow;
      checkRow('cutover_freeze', proposed);
      if (tables.cutover_freeze.some((row) => row.route === route)) continue;
      tables.cutover_freeze.push(proposed);
      inserted += 1;
    }
    return changed(inserted);
  },
);

on('DELETE FROM cutover_freeze WHERE route = ANY($1::text[])', 'DELETE', ['cutover_freeze'], ({ params, tables }) => {
  const routes = textArray(params[0]) ?? [];
  return changed(removeWhere(tables.cutover_freeze, (row) => routes.includes(row.route)).length);
});

on(
  'UPDATE cutover_state SET table_version = $1, previous_version = $2, epoch = epoch + 1, activated_at = now(), ' +
    'activated_by = $3 WHERE id = 1 AND epoch = $4 RETURNING epoch',
  'UPDATE',
  ['cutover_state'],
  ({ params, tables, now }) => {
    const row = stateRow(tables);
    const expected = bigintText(params[3]);
    // The compare-and-set: a concurrent operation that moved the epoch leaves no row to update.
    if (row === undefined || expected === null || BigInt(row.epoch) !== BigInt(expected)) return changed(0);
    Object.assign(row, {
      table_version: pgText(params[0]),
      previous_version: pgText(params[1]),
      epoch: incremented(row.epoch),
      activated_at: stamp(now),
      activated_by: pgText(params[2]),
    });
    return changed(1, [{ epoch: row.epoch }]);
  },
);

// In-flight registry (src/cutover/inflight.ts).
on(
  'INSERT INTO inflight (instance_id, request_id, route, side, window_id, started_at) VALUES ($1, $2, $3, $4, $5, now())',
  'INSERT',
  ['inflight'],
  ({ params, tables, now }) => {
    const proposed = {
      instance_id: pgText(params[0]),
      request_id: pgText(params[1]),
      route: pgText(params[2]),
      side: pgText(params[3]),
      window_id: pgText(params[4]),
      started_at: stamp(now),
    } as InflightRowRecord;
    checkRow('inflight', proposed);
    tables.inflight.push(proposed);
    return changed(1);
  },
);

on('DELETE FROM inflight WHERE instance_id = $1 AND request_id = $2', 'DELETE', ['inflight'], ({ params, tables }) => {
  const instanceId = pgText(params[0]);
  const requestId = pgText(params[1]);
  return changed(removeWhere(tables.inflight, (row) => row.instance_id === instanceId && row.request_id === requestId).length);
});

on(
  `SELECT ${INFLIGHT_COLUMNS} FROM inflight AS i WHERE ($1::text IS NULL OR i.side = $1) ` +
    'AND ($2::text[] IS NULL OR i.route = ANY($2::text[])) AND ($3::text[] IS NULL OR i.instance_id = ANY($3::text[])) ' +
    'ORDER BY i.started_at, i.instance_id, i.request_id',
  'SELECT',
  [],
  ({ params, tables }) => {
    const side = pgText(params[0]);
    const routes = textArray(params[1]);
    const instanceIds = textArray(params[2]);
    return selected(
      tables.inflight
        .filter(
          (row) =>
            (side === null || row.side === side) &&
            (routes === null || routes.includes(row.route)) &&
            (instanceIds === null || instanceIds.includes(row.instance_id)),
        )
        .sort(byStartThenKey)
        .map(inflightOut),
    );
  },
);

on(
  `SELECT i.instance_id, i.route, i.side, count(*)::int AS count, to_char(min(i.started_at)::timestamptz, ${ISO_FORMAT}) ` +
    'AS oldest_started_at FROM inflight AS i GROUP BY i.instance_id, i.route, i.side ORDER BY i.instance_id, i.route, i.side',
  'SELECT',
  [],
  ({ tables }) => {
    const groups = new Map<string, { row: InflightRowRecord; count: number; oldest: Date }>();
    for (const row of tables.inflight) {
      const key = JSON.stringify([row.instance_id, row.route, row.side]);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { row, count: 1, oldest: row.started_at });
      else groups.set(key, { row: group.row, count: group.count + 1, oldest: row.started_at < group.oldest ? row.started_at : group.oldest });
    }
    return selected(
      [...groups.values()]
        .sort(
          (a, b) =>
            compareText(a.row.instance_id, b.row.instance_id) || compareText(a.row.route, b.row.route) || compareText(a.row.side, b.row.side),
        )
        .map(({ row, count, oldest }) => ({
          instance_id: row.instance_id,
          route: row.route,
          side: row.side,
          count,
          oldest_started_at: isoLocal(oldest),
        })),
    );
  },
);

on(`SELECT DISTINCT i.route FROM inflight AS i WHERE ${ORPHAN_WHERE}`, 'SELECT', [], (exec) =>
  selected([...new Set(orphans(exec).map((row) => row.route))].map((route) => ({ route }))),
);

on(`DELETE FROM inflight AS i WHERE ${ORPHAN_WHERE} RETURNING ${INFLIGHT_COLUMNS}`, 'DELETE', ['inflight'], (exec) => {
  const doomed = new Set(orphans(exec));
  const removed = removeWhere(exec.tables.inflight, (row) => doomed.has(row));
  return changed(removed.length, removed.map(inflightOut));
});

// Legacy jar (src/session/jar.ts); transactions run one at a time, so every advisory lock is granted at once.
on('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', 'SELECT', [], () => selected([{ pg_advisory_xact_lock: '' }]));

on(`SELECT ${JAR_COLUMNS} FROM legacy_jar WHERE session_id = $1`, 'SELECT', [], ({ params, tables }) => {
  const sessionId = pgText(params[0]);
  return selected(tables.legacy_jar.filter((row) => row.session_id === sessionId).map(copyRow));
});

on(`SELECT ${JAR_COLUMNS} FROM legacy_jar WHERE legacy_session_id = $1`, 'SELECT', [], ({ params, tables }) => {
  const legacySessionId = pgText(params[0]);
  return selected(tables.legacy_jar.filter((row) => legacySessionId !== null && row.legacy_session_id === legacySessionId).map(copyRow));
});

on(
  `INSERT INTO legacy_jar AS jar (${JAR_UPSERT_COLUMNS}) VALUES ($1, $2, $3::jsonb, $4, $5, now()) ON CONFLICT (session_id) ` +
    'DO UPDATE SET legacy_session_id = EXCLUDED.legacy_session_id, cookies = jar.cookies || EXCLUDED.cookies, ' +
    `mode = EXCLUDED.mode, hydrated_epoch = EXCLUDED.hydrated_epoch, updated_at = EXCLUDED.updated_at RETURNING ${JAR_COLUMNS}`,
  'INSERT',
  ['legacy_jar'],
  ({ params, tables, now }) => {
    const proposed = {
      session_id: pgText(params[0]),
      legacy_session_id: pgText(params[1]),
      cookies: jsonbValue(params[2]),
      mode: pgText(params[3]),
      hydrated_epoch: bigintText(params[4]),
      updated_at: stamp(now),
      identity_end_pending_at: null,
    } as LegacyJarRow;
    checkRow('legacy_jar', proposed);
    const existing = findJar(tables, proposed.session_id);
    if (existing === undefined) {
      tables.legacy_jar.push(proposed);
      return changed(1, [copyRow(proposed)]);
    }
    Object.assign(existing, {
      legacy_session_id: proposed.legacy_session_id,
      cookies: jsonbConcat(existing.cookies, proposed.cookies),
      mode: proposed.mode,
      hydrated_epoch: proposed.hydrated_epoch,
      updated_at: proposed.updated_at,
    });
    return changed(1, [copyRow(existing)]);
  },
);

on('UPDATE legacy_jar SET hydrated_epoch = $2, updated_at = now() WHERE session_id = $1', 'UPDATE', ['legacy_jar'], ({ params, tables, now }) => {
  const sessionId = pgText(params[0]);
  const epoch = bigintText(params[1]);
  const rows = tables.legacy_jar.filter((row) => row.session_id === sessionId);
  for (const row of rows) Object.assign(row, { hydrated_epoch: epoch, updated_at: stamp(now) });
  return changed(rows.length);
});

on('DELETE FROM legacy_jar WHERE session_id = $1', 'DELETE', ['legacy_jar'], ({ params, tables }) => {
  const sessionId = pgText(params[0]);
  return changed(removeWhere(tables.legacy_jar, (row) => row.session_id === sessionId).length);
});

on(
  `INSERT INTO legacy_jar AS jar (${JAR_COLUMNS}) VALUES ($1, NULL, '{}'::jsonb, $2, NULL, now(), now()) ON CONFLICT (session_id) ` +
    'DO UPDATE SET identity_end_pending_at = COALESCE(jar.identity_end_pending_at, EXCLUDED.identity_end_pending_at), ' +
    'updated_at = EXCLUDED.updated_at',
  'INSERT',
  ['legacy_jar'],
  ({ params, tables, now }) => {
    const proposed = {
      session_id: pgText(params[0]),
      legacy_session_id: null,
      cookies: {},
      mode: pgText(params[1]),
      hydrated_epoch: null,
      updated_at: stamp(now),
      identity_end_pending_at: stamp(now),
    } as LegacyJarRow;
    checkRow('legacy_jar', proposed);
    const existing = findJar(tables, proposed.session_id);
    if (existing === undefined) tables.legacy_jar.push(proposed);
    else {
      Object.assign(existing, {
        identity_end_pending_at: existing.identity_end_pending_at ?? proposed.identity_end_pending_at,
        updated_at: proposed.updated_at,
      });
    }
    return changed(1);
  },
);

on(
  "WITH kept AS (UPDATE legacy_jar SET legacy_session_id = NULL, cookies = '{}'::jsonb, hydrated_epoch = NULL, updated_at = now() " +
    'WHERE session_id <> $1 AND (session_id = $2 OR legacy_session_id = $3) AND identity_end_pending_at IS NOT NULL ' +
    'RETURNING session_id), removed AS (DELETE FROM legacy_jar WHERE session_id <> $1 AND (session_id = $2 OR ' +
    'legacy_session_id = $3) AND identity_end_pending_at IS NULL RETURNING session_id) ' +
    'SELECT session_id FROM kept UNION ALL SELECT session_id FROM removed',
  'SELECT',
  ['legacy_jar'],
  ({ params, tables, now }) => {
    const sessionId = pgText(params[0]);
    const previous = pgText(params[1]);
    const legacySessionId = pgText(params[2]);
    // `<>` and `=` against NULL are never true, so a NULL parameter matches nothing.
    const holds = (row: LegacyJarRow): boolean =>
      sessionId !== null &&
      row.session_id !== sessionId &&
      ((previous !== null && row.session_id === previous) || (legacySessionId !== null && row.legacy_session_id === legacySessionId));
    const kept = tables.legacy_jar.filter((row) => holds(row) && row.identity_end_pending_at !== null);
    const removed = removeWhere(tables.legacy_jar, (row) => holds(row) && row.identity_end_pending_at === null);
    for (const row of kept) Object.assign(row, { legacy_session_id: null, cookies: {}, hydrated_epoch: null, updated_at: stamp(now) });
    return selected([...kept, ...removed].map((row) => ({ session_id: row.session_id })));
  },
);

on(
  'WITH moved AS (DELETE FROM session_barrier WHERE session_id = ANY($2::text[]) RETURNING owner, xid, pending, recorded_at) ' +
    'INSERT INTO session_barrier AS b (session_id, owner, xid, pending, recorded_at) SELECT $1, owner, max(xid), ' +
    'sum(pending)::integer, max(recorded_at) FROM moved GROUP BY owner ON CONFLICT (session_id, owner) DO UPDATE SET ' +
    'xid = GREATEST(b.xid, EXCLUDED.xid), pending = b.pending + EXCLUDED.pending, recorded_at = GREATEST(b.recorded_at, EXCLUDED.recorded_at)',
  'INSERT',
  ['session_barrier'],
  ({ params, tables }) => {
    const target = pgText(params[0]);
    const sources = textArray(params[1]) ?? [];
    const moved = removeWhere(tables.session_barrier, (row) => sources.includes(row.session_id));
    const groups = new Map<string, SessionBarrierRow>();
    for (const row of moved) {
      const group = groups.get(row.owner);
      groups.set(
        row.owner,
        group === undefined
          ? ({ session_id: target, owner: row.owner, xid: row.xid, pending: row.pending, recorded_at: row.recorded_at } as SessionBarrierRow)
          : {
              ...group,
              xid: greatestNumeric(group.xid, row.xid),
              pending: group.pending + row.pending,
              recorded_at: latest(group.recorded_at, row.recorded_at),
            },
      );
    }
    for (const proposed of groups.values()) {
      checkRow('session_barrier', proposed);
      upsertBarrier(tables, proposed, (existing) => ({
        xid: greatestNumeric(existing.xid, proposed.xid),
        pending: existing.pending + proposed.pending,
        recorded_at: latest(existing.recorded_at, proposed.recorded_at),
      }));
    }
    return changed(groups.size);
  },
);

// Session barrier (src/dispatcher/barrier.ts).
on(
  'INSERT INTO session_barrier AS b (session_id, owner, pending, recorded_at) VALUES ($1, $2, 1, now()) ' +
    'ON CONFLICT (session_id, owner) DO UPDATE SET pending = b.pending + 1',
  'INSERT',
  ['session_barrier'],
  ({ params, tables, now }) => {
    const proposed = { session_id: pgText(params[0]), owner: pgText(params[1]), xid: null, pending: 1, recorded_at: stamp(now) } as SessionBarrierRow;
    checkRow('session_barrier', proposed);
    upsertBarrier(tables, proposed, (existing) => ({ pending: existing.pending + 1 }));
    return changed(1);
  },
);

on(
  'WITH gone AS (DELETE FROM session_barrier WHERE session_id = $1 AND owner = $2 AND pending = 1 AND xid IS NULL RETURNING owner) ' +
    'UPDATE session_barrier SET pending = pending - 1 WHERE session_id = $1 AND owner = $2 AND pending > 0 AND NOT EXISTS (SELECT 1 FROM gone)',
  'UPDATE',
  ['session_barrier'],
  ({ params, tables }) => {
    const sessionId = pgText(params[0]);
    const owner = pgText(params[1]);
    const mine = (row: SessionBarrierRow): boolean => row.session_id === sessionId && row.owner === owner;
    const gone = removeWhere(tables.session_barrier, (row) => mine(row) && row.pending === 1 && row.xid === null);
    if (gone.length > 0) return changed(0);
    const rows = tables.session_barrier.filter((row) => mine(row) && row.pending > 0);
    for (const row of rows) row.pending -= 1;
    return changed(rows.length);
  },
);

on(
  'INSERT INTO session_barrier AS b (session_id, owner, xid, recorded_at) SELECT $1, p.owner, p.xid, now() ' +
    'FROM unnest($2::text[], $3::numeric[]) AS p(owner, xid) ON CONFLICT (session_id, owner) DO UPDATE SET ' +
    'xid = GREATEST(b.xid, EXCLUDED.xid), recorded_at = EXCLUDED.recorded_at',
  'INSERT',
  ['session_barrier'],
  ({ params, tables, now }) => {
    const sessionId = pgText(params[0]);
    const proposals = unnest2(textArray(params[1]), numericArray(params[2])).map(
      ([owner, xid]) => ({ session_id: sessionId, owner, xid, pending: 0, recorded_at: stamp(now) }) as SessionBarrierRow,
    );
    const touched = new Set<string>();
    for (const proposed of proposals) {
      checkRow('session_barrier', proposed);
      const key = JSON.stringify([proposed.session_id, proposed.owner]);
      if (touched.has(key)) throw affectedTwice();
      touched.add(key);
      upsertBarrier(tables, proposed, (existing) => ({ xid: greatestNumeric(existing.xid, proposed.xid), recorded_at: proposed.recorded_at }));
    }
    return changed(proposals.length);
  },
);

on('SELECT owner, xid::text AS xid, pending FROM session_barrier WHERE session_id = $1', 'SELECT', [], ({ params, tables }) => {
  const sessionId = pgText(params[0]);
  return selected(
    tables.session_barrier.filter((row) => row.session_id === sessionId).map((row) => ({ owner: row.owner, xid: row.xid, pending: row.pending })),
  );
});

on(
  'DELETE FROM session_barrier AS b USING unnest($2::text[], $3::numeric[]) AS p(owner, xid) ' +
    'WHERE b.session_id = $1 AND b.owner = p.owner AND b.pending = 0 AND (b.xid IS NULL OR b.xid <= p.xid)',
  'DELETE',
  ['session_barrier'],
  ({ params, tables }) => {
    const sessionId = pgText(params[0]);
    const confirmed = unnest2(textArray(params[1]), numericArray(params[2]));
    const covered = (row: SessionBarrierRow): boolean =>
      confirmed.some(([owner, xid]) => owner === row.owner && (row.xid === null || (xid !== null && BigInt(row.xid) <= BigInt(xid))));
    return changed(removeWhere(tables.session_barrier, (row) => row.session_id === sessionId && row.pending === 0 && covered(row)).length);
  },
);

/** A transaction holding the store's lock, with the image its rollback restores. */
interface OpenTransaction {
  readonly snapshot: GatewayTables;
  readonly now: Date;
  aborted: boolean;
  readonly unlock: () => void;
}

/** One checked-out client of the fake pool. */
interface Connection {
  tx: OpenTransaction | undefined;
  released: boolean;
}

interface Override {
  matcher: QueryMatcher;
  result: QueryResponse;
}

const ENDED_POOL = 'Cannot use a pool after calling end on the pool';
const RELEASED_CLIENT = 'memory gateway db: query on a released client';

function queryResult(command: string, rows: QueryResultRow[], rowCount: number | null): QueryResult {
  return { command, rowCount, oid: 0, fields: [], rows };
}

/** A FIFO lock; each grant resolves to its idempotent release. */
function createLock(): () => Promise<() => void> {
  let tail: Promise<void> = Promise.resolve();
  return () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const granted = tail.then(() => release);
    tail = tail.then(() => held);
    return granted;
  };
}

function restoreInto(target: GatewayTables, source: GatewayTables): void {
  const copy = structuredClone(source);
  for (const name of TABLE_NAMES) (target[name] as Row[]).splice(0, target[name].length, ...(copy[name] as Row[]));
}

function matches(matcher: QueryMatcher, sql: string, query: RecordedQuery): boolean {
  if (typeof matcher === 'string') return sql.includes(normaliseSql(matcher));
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(sql);
  }
  return matcher(query);
}

/** The command pg reports for a statement: its handler's, else its first keyword. */
function commandOf(sql: string): string {
  return HANDLERS.find((handler) => handler.pattern.test(sql))?.command ?? (sql.split(/[\s(]/, 1)[0] ?? '').toUpperCase();
}

/** Bind-time parameter check: node-postgres sends parameterless statements unprepared, the rest with every value bound. */
function checkParameters(sql: string, values: readonly unknown[]): void {
  let required = 0;
  for (const match of sql.matchAll(/\$(\d+)/g)) required = Math.max(required, Number(match[1]));
  if (values.length === 0 && required > 0) throw pgError('42P02', 'there is no parameter $1');
  if (values.length !== required) {
    throw pgError('08P01', `bind message supplies ${values.length} parameters, but prepared statement "" requires ${required}`);
  }
}

function emptyTables(): GatewayTables {
  return {
    cutover_state: [{ id: 1, table_version: null, previous_version: null, epoch: '0', activated_at: null, activated_by: null }],
    cutover_freeze: [],
    instance: [],
    inflight: [],
    legacy_jar: [],
    session_barrier: [],
  };
}

/** Row 1 of `cutover_state` after a committed activation of `tableVersion` over the current row. */
function activation(tables: GatewayTables, tableVersion: string, opts: { previous?: string | null; epoch?: number } = {}): CutoverStateRow {
  const current = stateRow(tables);
  if (current === undefined) throw new Error('memory gateway db: gateway.cutover_state holds no row 1');
  return {
    id: 1,
    table_version: tableVersion,
    previous_version: opts.previous === undefined ? current.table_version : opts.previous,
    epoch: opts.epoch === undefined ? incremented(current.epoch) : String(bigintText(opts.epoch)),
    activated_at: new Date(),
    activated_by: 'test',
  };
}

/** Seeded rows over their column defaults, checked against every constraint. */
function seedTables(seed: MemoryGatewaySeed): GatewayTables {
  const tables = emptyTables();
  const now = new Date();
  if (seed.activeVersion !== undefined) {
    const { tableVersion, ...opts } = seed.activeVersion;
    tables.cutover_state[0] = activation(tables, tableVersion, opts);
  }
  const epoch = stateRow(tables)?.epoch ?? '0';
  const rows = <T extends Row>(partials: readonly Partial<T>[] | undefined, defaults: () => Partial<T>): T[] =>
    (partials ?? []).map((partial) => ({ ...defaults(), ...structuredClone(partial) }) as T);
  tables.cutover_freeze.push(...rows<CutoverFreezeRow>(seed.freezes, () => ({ epoch, frozen_at: stamp(now), frozen_by: 'test' })));
  tables.instance.push(...rows<InstanceRow>(seed.instances, () => ({ seen_epoch: epoch, started_at: stamp(now), heartbeat_at: stamp(now) })));
  tables.inflight.push(...rows<InflightRowRecord>(seed.inflight, () => ({ window_id: null, started_at: stamp(now) })));
  tables.legacy_jar.push(
    ...rows<LegacyJarRow>(seed.jars, () => ({
      legacy_session_id: null,
      cookies: {},
      hydrated_epoch: null,
      updated_at: stamp(now),
      identity_end_pending_at: null,
    })).map((row) => ({ ...row, cookies: jsonbCanonical(row.cookies) as Record<string, unknown> })),
  );
  tables.session_barrier.push(...rows<SessionBarrierRow>(seed.barriers, () => ({ xid: null, pending: 0, recorded_at: stamp(now) })));
  for (const name of TABLE_NAMES) validateTable(name, tables[name]);
  return tables;
}

/** Creates the store, its `cutover_state` row seeded as migration 0001 seeds it, then `seed` applied over it. */
export function createMemoryGatewayDb(seed: MemoryGatewaySeed = {}): MemoryGatewayDb {
  const seeded = seedTables(seed);
  const tables = structuredClone(seeded);
  const queries: RecordedQuery[] = [];
  const overrides: Override[] = [];
  const acquire = createLock();
  let open: OpenTransaction | undefined;
  let ended = false;

  async function begin(): Promise<OpenTransaction> {
    const unlock = await acquire();
    open = { snapshot: structuredClone(tables), now: new Date(), aborted: false, unlock };
    return open;
  }

  function finish(tx: OpenTransaction, commit: boolean): void {
    if (!commit) restoreInto(tables, tx.snapshot);
    if (open === tx) open = undefined;
    tx.unlock();
  }

  /** Applies a change another session committed, to the tables and to the open transaction's rollback image. */
  function commitOutside(change: (target: GatewayTables) => void): void {
    change(tables);
    if (open !== undefined) change(open.snapshot);
  }

  async function answer(sql: string, query: RecordedQuery, now: Date): Promise<QueryResult> {
    for (const { matcher, result } of overrides) {
      if (!matches(matcher, sql, query)) continue;
      const rows = typeof result === 'function' ? await result(query) : result;
      return queryResult(commandOf(sql), [...rows] as QueryResultRow[], rows.length);
    }
    for (const handler of HANDLERS) {
      const match = handler.pattern.exec(sql);
      if (match === null) continue;
      checkParameters(sql, query.values);
      const outcome = handler.run({ params: query.values, captures: match.slice(1), tables, now });
      for (const name of handler.writes) validateTable(name, tables[name]);
      return queryResult(handler.command, outcome.rows, outcome.rowCount);
    }
    throw new UnsupportedStatementError(query.text);
  }

  async function execute(connection: Connection, input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
    const text = typeof input === 'string' ? input : input.text;
    const bound: unknown[] = values ?? (typeof input === 'string' ? undefined : input.values) ?? [];
    const query: RecordedQuery = { text: text.replace(/\s+/g, ' ').trim(), values: [...bound] };
    queries.push(query);
    if (connection.released) throw new Error(RELEASED_CLIENT);
    const sql = normaliseSql(text);
    if (sql === 'begin') {
      // PostgreSQL only warns on BEGIN inside a transaction.
      if (connection.tx === undefined) {
        const tx = await begin();
        if (connection.released) {
          finish(tx, false);
          throw new Error(RELEASED_CLIENT);
        }
        connection.tx = tx;
      }
      return queryResult('BEGIN', [], null);
    }
    if (sql === 'commit' || sql === 'rollback') {
      const tx = connection.tx;
      // Outside a transaction PostgreSQL only warns; COMMIT of an aborted transaction rolls back and answers ROLLBACK.
      if (tx === undefined) return queryResult(sql.toUpperCase(), [], null);
      connection.tx = undefined;
      const committed = sql === 'commit' && !tx.aborted;
      finish(tx, committed);
      return queryResult(committed ? 'COMMIT' : 'ROLLBACK', [], null);
    }
    const current = connection.tx;
    if (current === undefined) {
      // Autocommit: the statement is its own transaction.
      const tx = await begin();
      try {
        const result = await answer(sql, query, tx.now);
        finish(tx, true);
        return result;
      } catch (error) {
        finish(tx, false);
        throw error;
      }
    }
    if (current.aborted) throw pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
    try {
      return await answer(sql, query, current.now);
    } catch (error) {
      current.aborted = true;
      throw error;
    }
  }

  function release(connection: Connection): void {
    if (connection.released) throw new Error('Release called on client which has already been released to the pool.');
    connection.released = true;
    const tx = connection.tx;
    // A client released inside a transaction is destroyed, which ends the transaction uncommitted.
    if (tx !== undefined) {
      connection.tx = undefined;
      finish(tx, false);
    }
  }

  // Structurally the pg.Pool members tenantDbFromPool and the platform transaction runner call.
  const fakePool = {
    async connect() {
      if (ended) throw new Error(ENDED_POOL);
      const connection: Connection = { tx: undefined, released: false };
      return {
        query: (input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> => execute(connection, input, values),
        release: (): void => release(connection),
      };
    },
    async query(input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
      if (ended) throw new Error(ENDED_POOL);
      return execute({ tx: undefined, released: false }, input, values);
    },
    async end(): Promise<void> {
      ended = true;
    },
    on: (): void => undefined,
  };
  const base = tenantDbFromPool(fakePool as unknown as Pool, { schema: SCHEMA });

  // tenantDbFromPool freezes its TenantDb, so the store's members sit on an object that delegates to it; LISTEN is not modelled.
  return {
    schema: base.schema,
    withTenant: base.withTenant,
    withMetadata: base.withMetadata,
    end: base.end,
    tables,
    queries,
    clear() {
      queries.length = 0;
      overrides.length = 0;
      restoreInto(tables, seeded);
    },
    respond(matcher, result) {
      overrides.push({ matcher, result });
    },
    heartbeat(instanceId, seenEpoch, at = new Date()) {
      const seen = String(bigintText(seenEpoch));
      commitOutside((target) => {
        const existing = target.instance.find((row) => row.instance_id === instanceId);
        if (existing === undefined) target.instance.push({ instance_id: instanceId, seen_epoch: seen, started_at: stamp(at), heartbeat_at: stamp(at) });
        else Object.assign(existing, { seen_epoch: seen, heartbeat_at: stamp(at) });
      });
    },
    setActive(tableVersion, opts) {
      const row = activation(tables, tableVersion, opts);
      commitOutside((target) => {
        const index = target.cutover_state.findIndex((candidate) => candidate.id === 1);
        if (index < 0) target.cutover_state.push(structuredClone(row));
        else target.cutover_state[index] = structuredClone(row);
      });
    },
  };
}
