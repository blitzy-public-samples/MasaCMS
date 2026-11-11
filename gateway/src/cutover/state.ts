// Cut-over activation, freeze and epoch protocol over `gateway.cutover_state`, `gateway.cutover_freeze` and `gateway.instance`.
// Liveness and stored timestamps come from the database clock; the injected clock only bounds in-process waits.
import { LegacyServiceUnavailableError, normaliseRouteKey } from '@opt2/platform/legacy-compat';
import type { Clock } from '@opt2/platform/service-kit';
import { withMetadata, type MetadataTx, type TenantDb } from '@opt2/platform/tenancy';
import type { components, operations } from '../generated/openapi.js';
import { INSTANCE_LIVENESS_SECONDS, createInflightStore } from './inflight.js';
import { CutoverSchemaError, buildRoutingIndex, loadGroups, loadVersion } from './loader.js';
import type { GatewayPaths } from './paths.js';
import type { CutoverTable, GroupsFile, RoutingIndex, VariantsFile } from './types.js';
import { loadValidationContext, validateVersion } from './validate.js';

/** `CutoverStatus` of the gateway contract. */
export type CutoverStatus = components['schemas']['CutoverStatus'];

/** One `ValidationFindings` item: a validator rule, or `unknown-version`, `previous-mismatch` or `unknown-route`. */
export type CutoverFinding = components['schemas']['ValidationFindings']['findings'][number];

/** `cutoverActivate`'s answer: the now-active version and the epoch its activation committed. */
export type ActivationResult = operations['cutoverActivate']['responses'][200]['content']['application/json'];

/** Interval of the background refresh and heartbeat, in milliseconds. */
export const REFRESH_INTERVAL_MS = 1000;

/** Poll interval of `waitUnfrozen` and `awaitVisible`, in milliseconds. */
export const POLL_INTERVAL_MS = 250;

/** Default wait of a frozen entry's request before it answers the legacy 503, in milliseconds. */
export const DEFAULT_FREEZE_WAIT_MS = 30_000;

function describeFindings(findings: readonly CutoverFinding[]): string {
  return findings.map((finding) => `${finding.rule}: ${finding.message}`).join('; ');
}

/** A cut-over operation refused with findings (validation, unknown version file or unknown route); the route answers 400. */
export class ActivationRejected extends Error {
  override readonly name = 'ActivationRejected';

  constructor(readonly findings: CutoverFinding[]) {
    super(describeFindings(findings));
  }
}

/** The version's `previous` is not the active version, or a concurrent operation committed first; the route answers 409. */
export class CutoverConflict extends Error {
  override readonly name = 'CutoverConflict';

  constructor(readonly findings: CutoverFinding[]) {
    super(describeFindings(findings));
  }
}

/** Logger methods the state uses; Fastify's `app.log` satisfies it. */
export interface CutoverStateLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** Settings of {@link createCutoverState}. */
export interface CutoverStateOptions {
  /** Gateway schema pool; only `withMetadata` is used. */
  db: TenantDb;
  /** Bounds in-process waits and the refresh cadence. */
  clock: Clock;
  paths: GatewayPaths;
  /** This gateway instance, as it heartbeats into `gateway.instance`. */
  instanceId: string;
  logger: CutoverStateLogger;
  variants: VariantsFile;
  /** Generated groups; read from `groups.json` when absent. */
  groups?: GroupsFile;
}

/** The active cut-over version of one gateway instance, and the operations that change it. */
export interface CutoverState {
  /** Applies the stored state once, then refreshes and heartbeats every second until `stop`. */
  start(): Promise<void>;
  /** Stops the background refresh. */
  stop(): void;
  /** Cached routing index for reads, at most one refresh old; undefined while no version is active. */
  active(): RoutingIndex | undefined;
  /** Epoch of the cached state. */
  epoch(): number;
  /** Reads the stored epoch before a write is routed; throws `LegacyServiceUnavailableError` while no version is active. */
  readEpochForWrite(): Promise<{ epoch: number; index: RoutingIndex }>;
  /** Whether the route key is frozen in the cached state. */
  isFrozen(route: string): boolean;
  /** Resolves true once the route is unfrozen, false after `ms`. */
  waitUnfrozen(route: string, ms?: number): Promise<boolean>;
  /** Validates `tableVersion` in activation mode and commits it with a new epoch when its `previous` is the active version. */
  activate(input: { tableVersion: string; actor: string }): Promise<ActivationResult>;
  /** Freezes entries of the active version and commits a new epoch; returns the status after it. */
  freeze(routes: readonly string[], actor: string): Promise<CutoverStatus>;
  /** Unfreezes routes and commits a new epoch; returns the status after it. */
  unfreeze(routes: readonly string[], actor: string): Promise<CutoverStatus>;
  /** Resolves true once no live instance reports an epoch below `epoch`, false after `timeoutMs`. */
  awaitVisible(epoch: number, timeoutMs: number): Promise<boolean>;
  /** Stored state, freezes, instance acknowledgements, in-flight writes and session mode, as `CutoverStatus`. */
  status(): Promise<CutoverStatus>;
}

interface Snapshot {
  readonly loaded: boolean;
  readonly epoch: number;
  readonly index: RoutingIndex | undefined;
  readonly frozen: ReadonlySet<string>;
}

interface StateRow {
  table_version: string | null;
  previous_version: string | null;
  epoch: string;
}

interface InstanceRow {
  instance_id: string;
  seen_epoch: string;
  heartbeat_at: string;
  live: boolean;
}

const ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MSTZH:TZM'`;
const LIVE = `heartbeat_at >= now() - interval '${INSTANCE_LIVENESS_SECONDS} seconds'`;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Caches one promise per key and forgets it when it rejects, so a failed read is retried. */
function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let value = cache.get(key);
  if (value === undefined) {
    value = load();
    cache.set(key, value);
    value.catch(() => cache.delete(key));
  }
  return value;
}

/** Creates the cut-over state of one gateway instance over the gateway schema of `db`. */
export function createCutoverState(opts: CutoverStateOptions): CutoverState {
  const { db, clock, paths, instanceId, logger, variants } = opts;
  const schema = quoteIdent(db.schema);
  const stateTable = `${schema}.cutover_state`;
  const freezeTable = `${schema}.cutover_freeze`;
  const instanceTable = `${schema}.instance`;
  // Version files are immutable, so each parsed version and its index is kept for the life of the process.
  const tables = new Map<string, Promise<CutoverTable>>();
  const indexes = new Map<string, Promise<RoutingIndex>>();
  const groupsFiles = new Map<string, Promise<GroupsFile>>();
  if (opts.groups !== undefined) groupsFiles.set(paths.groupsFile, Promise.resolve(opts.groups));
  let snapshot: Snapshot = { loaded: false, epoch: 0, index: undefined, frozen: new Set() };
  let running = false;
  let loops = 0;
  let timer: NodeJS.Timeout | undefined;
  const inflight = createInflightStore({ db, instanceId, unitsOf: (route) => snapshot.index?.entryFor(route)?.units });

  const tableFor = (tableVersion: string): Promise<CutoverTable> => cached(tables, tableVersion, () => loadVersion(paths, tableVersion));

  const groupsFor = (): Promise<GroupsFile> => cached(groupsFiles, paths.groupsFile, () => loadGroups(paths));

  const indexFor = (tableVersion: string): Promise<RoutingIndex> =>
    cached(indexes, tableVersion, async () => {
      const [table, groups] = await Promise.all([tableFor(tableVersion), groupsFor()]);
      return buildRoutingIndex(table, variants, groups);
    });

  const readStateRow = async (tx: MetadataTx): Promise<StateRow> => {
    const { rows } = await tx.query<StateRow>(`SELECT table_version, previous_version, epoch FROM ${stateTable} WHERE id = 1`);
    const row = rows[0];
    if (row === undefined) throw new Error(`${stateTable} holds no row; apply gateway/db/migrations first`);
    return row;
  };

  const refresh = (): Promise<Snapshot> =>
    withMetadata(db, async (tx) => {
      const row = await readStateRow(tx);
      const epoch = Number(row.epoch);
      if (!snapshot.loaded || epoch > snapshot.epoch) {
        const { rows } = await tx.query<{ route: string }>(`SELECT route FROM ${freezeTable}`);
        const index = row.table_version === null ? undefined : await indexFor(row.table_version);
        // A slower concurrent refresh never replaces a newer snapshot, so a seen freeze cannot be lost again.
        if (!snapshot.loaded || epoch > snapshot.epoch) {
          snapshot = { loaded: true, epoch, index, frozen: new Set(rows.map((frozen) => frozen.route)) };
        }
      }
      await tx.query(
        `INSERT INTO ${instanceTable} (instance_id, seen_epoch, started_at, heartbeat_at) VALUES ($1, $2, now(), now()) ` +
          `ON CONFLICT (instance_id) DO UPDATE SET seen_epoch = EXCLUDED.seen_epoch, heartbeat_at = now()`,
        [instanceId, snapshot.epoch],
      );
      return snapshot;
    });

  // A tick still running across stop() and start() belongs to the old loop and must not reschedule beside the new one.
  const scheduleRefresh = (delay: number, loop: number): void => {
    timer = setTimeout(() => {
      const startedAt = clock.now().getTime();
      void refresh()
        .catch((error: unknown) => {
          logger.error({ err: error, instanceId }, 'cut-over state refresh failed');
        })
        .finally(() => {
          const elapsed = clock.now().getTime() - startedAt;
          if (running && loop === loops) scheduleRefresh(Math.max(0, REFRESH_INTERVAL_MS - elapsed), loop);
        });
    }, delay);
    timer.unref();
  };

  /** Resolves true once `check` passes after a poll, false once `ms` has elapsed by the clock or by the poll timers. */
  const poll = async (ms: number, check: () => Promise<boolean>): Promise<boolean> => {
    const deadline = clock.now().getTime() + ms;
    let budget = ms;
    for (;;) {
      const remaining = Math.min(budget, deadline - clock.now().getTime());
      if (remaining <= 0) return false;
      const step = Math.min(POLL_INTERVAL_MS, remaining);
      await sleep(step);
      budget -= step;
      if (await check()) return true;
    }
  };

  const allInstancesSeen = (epoch: number): Promise<boolean> =>
    withMetadata(db, async (tx) => {
      const { rows } = await tx.query<{ lagging: number }>(
        `SELECT count(*)::int AS lagging FROM ${instanceTable} WHERE ${LIVE} AND seen_epoch < $1`,
        [epoch],
      );
      return rows[0]?.lagging === 0;
    });

  const requestedTable = async (tableVersion: string): Promise<CutoverTable> => {
    try {
      return await tableFor(tableVersion);
    } catch (error) {
      if (isMissingFile(error)) {
        throw new ActivationRejected([{ rule: 'unknown-version', message: `no version file ${tableVersion}.json in ${paths.versionsDir}` }]);
      }
      if (error instanceof CutoverSchemaError) throw new ActivationRejected([{ rule: 'schema', message: error.message }]);
      throw error;
    }
  };

  const status = async (): Promise<CutoverStatus> => {
    const { row, frozen, instances } = await withMetadata(db, async (tx) => ({
      row: await readStateRow(tx),
      frozen: (await tx.query<{ route: string }>(`SELECT route FROM ${freezeTable} ORDER BY route`)).rows.map((r) => r.route),
      instances: (
        await tx.query<InstanceRow>(
          `SELECT instance_id, seen_epoch, to_char(heartbeat_at::timestamptz, ${ISO_FORMAT}) AS heartbeat_at, (${LIVE}) AS live ` +
            `FROM ${instanceTable} ORDER BY instance_id`,
        )
      ).rows,
    }));
    const [index, inflightRows] = await Promise.all([
      row.table_version === null ? undefined : indexFor(row.table_version),
      inflight.summary(),
    ]);
    const liveEpochs = instances.filter((instance) => instance.live).map((instance) => Number(instance.seen_epoch));
    return {
      tableVersion: row.table_version,
      previous: row.previous_version,
      epoch: Number(row.epoch),
      groupAuthority: { ...(index?.table.groupAuthority ?? {}) },
      frozen,
      instances: instances.map((instance) => ({
        instanceId: instance.instance_id,
        seenEpoch: Number(instance.seen_epoch),
        heartbeatAt: instance.heartbeat_at,
        live: instance.live,
      })),
      acknowledgedEpoch: liveEpochs.length === 0 ? null : Math.min(...liveEpochs),
      inflight: inflightRows,
      sessionMode: index?.loginGroupAuthority() === 'target' ? 'target-primary' : 'legacy-primary',
    };
  };

  const changeFreezes = async (op: 'freeze' | 'unfreeze', routes: readonly string[], actor: string): Promise<CutoverStatus> => {
    const keys = [...new Set(routes.map(normaliseRouteKey))].sort();
    const epoch = await withMetadata(db, async (tx) => {
      // Incrementing under the row lock serialises cut-over operations, so routes are checked against the version this epoch follows.
      const { rows } = await tx.query<StateRow>(
        `UPDATE ${stateTable} SET epoch = epoch + 1 WHERE id = 1 RETURNING table_version, previous_version, epoch`,
      );
      const row = rows[0];
      if (row === undefined) throw new Error(`${stateTable} holds no row; apply gateway/db/migrations first`);
      const index = row.table_version === null ? undefined : await indexFor(row.table_version);
      // A route frozen under an earlier version stays unfreezable after that version is replaced.
      const frozen =
        op === 'unfreeze'
          ? new Set(
              (await tx.query<{ route: string }>(`SELECT route FROM ${freezeTable} WHERE route = ANY($1::text[])`, [keys])).rows.map(
                (r) => r.route,
              ),
            )
          : new Set<string>();
      const unknown = keys.filter((key) => index?.entryFor(key) === undefined && !frozen.has(key));
      if (unknown.length > 0) {
        throw new ActivationRejected(
          unknown.map((route) => ({
            rule: 'unknown-route',
            route,
            message: `${route} is not an entry of the active version ${row.table_version ?? '(none)'}`,
          })),
        );
      }
      if (op === 'freeze') {
        await tx.query(
          `INSERT INTO ${freezeTable} (route, epoch, frozen_at, frozen_by) ` +
            `SELECT f.route, $2::bigint, now(), $3::text FROM unnest($1::text[]) AS f(route) ON CONFLICT (route) DO NOTHING`,
          [keys, row.epoch, actor],
        );
      } else {
        await tx.query(`DELETE FROM ${freezeTable} WHERE route = ANY($1::text[])`, [keys]);
      }
      return Number(row.epoch);
    });
    logger.info({ routes: keys, epoch, actor, instanceId }, op === 'freeze' ? 'cut-over routes frozen' : 'cut-over routes unfrozen');
    await refresh();
    return status();
  };

  return {
    async start() {
      if (running) return;
      running = true;
      loops += 1;
      const loop = loops;
      try {
        await refresh();
      } catch (error) {
        if (loop === loops) running = false;
        throw error;
      }
      if (running && loop === loops) scheduleRefresh(REFRESH_INTERVAL_MS, loop);
    },

    stop() {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },

    active: () => snapshot.index,

    epoch: () => snapshot.epoch,

    async readEpochForWrite() {
      const { epoch, index } = await refresh();
      if (index === undefined) {
        throw new LegacyServiceUnavailableError('No cut-over version is active', 'auto', 'no-active-version');
      }
      return { epoch, index };
    },

    isFrozen: (route) => snapshot.frozen.has(normaliseRouteKey(route)),

    async waitUnfrozen(route, ms = DEFAULT_FREEZE_WAIT_MS) {
      const key = normaliseRouteKey(route);
      if (!snapshot.frozen.has(key)) return true;
      return poll(ms, async () => !(await refresh()).frozen.has(key));
    },

    async activate({ tableVersion, actor }) {
      const table = await requestedTable(tableVersion);
      const current = await withMetadata(db, readStateRow);
      const active = current.table_version;
      if (table.previous !== active) {
        throw new CutoverConflict([
          {
            rule: 'previous-mismatch',
            message: `previous ${table.previous ?? 'null'} of ${tableVersion} is not the active version ${active ?? 'null'}`,
          },
        ]);
      }
      const prior = active === null ? undefined : await tableFor(active);
      const ctx = await loadValidationContext(paths, 'activation', prior === undefined ? {} : { prior });
      const findings = validateVersion(table, ctx);
      if (findings.length > 0) throw new ActivationRejected(findings);
      const { rows } = await withMetadata(db, (tx) =>
        tx.query<{ epoch: string }>(
          `UPDATE ${stateTable} SET table_version = $1, previous_version = $2, epoch = epoch + 1, activated_at = now(), activated_by = $3 ` +
            `WHERE id = 1 AND epoch = $4 RETURNING epoch`,
          [tableVersion, active, actor, current.epoch],
        ),
      );
      const committed = rows[0];
      if (committed === undefined) {
        throw new CutoverConflict([
          {
            rule: 'previous-mismatch',
            message: `another cut-over operation committed after epoch ${current.epoch}, so ${active ?? 'null'} may no longer be active`,
          },
        ]);
      }
      const epoch = Number(committed.epoch);
      logger.info({ tableVersion, previous: active, epoch, actor, instanceId }, 'cut-over version activated');
      await refresh();
      return { tableVersion, epoch };
    },

    freeze: (routes, actor) => changeFreezes('freeze', routes, actor),

    unfreeze: (routes, actor) => changeFreezes('unfreeze', routes, actor),

    async awaitVisible(epoch, timeoutMs) {
      if (await allInstancesSeen(epoch)) return true;
      return poll(timeoutMs, () => allInstancesSeen(epoch));
    },

    status,
  };
}
