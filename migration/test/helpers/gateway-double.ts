// Double of the gateway's internal cut-over API for migration suites, in process or over loopback HTTP.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { systemClock, type Clock } from '@opt2/platform/service-kit';

import {
  GatewayCallError,
  GatewayWaitTimeoutError,
  type CutoverActivateResponse,
  type CutoverStatus,
  type GatewayClient,
  type GatewayInstance,
  type InflightClearRequest,
  type InflightClearResponse,
  type InflightDrainResult,
  type InflightRow,
  type InflightSide,
  type OrphanEvidence,
  type WaitBudget,
} from '../../src/cutover/index.js';

/** One recorded operation of a double. */
export interface CallLogEntry {
  component: string;
  op: string;
  args?: unknown;
  /** Monotonic sequence number, never reused after `clear()`. */
  at: number;
}

/** Ordered record shared by the gateway, owner and bridge doubles, for cross-component ordering assertions. */
export interface CallLog {
  readonly entries: CallLogEntry[];
  append(component: string, op: string, args?: unknown): void;
  /** Operation names in call order, of one component when given. */
  ops(component?: string): string[];
  /** Position in `entries` of the first matching entry, or -1. */
  indexOf(component: string, op: string): number;
  clear(): void;
}

/** Creates an empty call log. */
export function createCallLog(): CallLog {
  const entries: CallLogEntry[] = [];
  let sequence = 0;
  return {
    entries,
    append(component, op, args) {
      sequence += 1;
      entries.push(args === undefined ? { component, op, at: sequence } : { component, op, args, at: sequence });
    },
    ops: (component) => entries.filter((entry) => component === undefined || entry.component === component).map((entry) => entry.op),
    indexOf: (component, op) => entries.findIndex((entry) => entry.component === component && entry.op === op),
    clear() {
      entries.length = 0;
    },
  };
}

/** Component name of the gateway double's log entries. */
export const GATEWAY_COMPONENT = 'gateway';

/** One `gateway.inflight` row: a write one instance forwarded and has not finished. */
export interface GatewayInflightRow {
  instance: string;
  requestId: string;
  route: string;
  side: InflightSide;
  /** Start time in epoch milliseconds. */
  startedAt: number;
  /** Marks the row's instance dead, which makes all its rows orphans. */
  orphan?: boolean;
  /** Units of a target-side row's route; `gates-closed` evidence clears the row only when they are known, non-empty and all named. */
  units?: string[];
}

/** The double's operations, as `GatewayClient` names them. */
export type GatewayOperationName = keyof GatewayClient;

/** Whether an instance sees each new epoch at once (`auto`) or only through `ackEpoch` (`manual`). */
export type InstanceAck = 'auto' | 'manual';

/** An error to reject with, or a gateway answer outside 2xx to reject with as {@link GatewayCallError}. */
export type GatewayFailure = Error | { status: number; body?: unknown };

/** Initial state and timing of {@link createGatewayDouble}. */
export interface GatewayDoubleOptions {
  /** Active version; `null` (the default) is the state before `v0001`. */
  active?: string | null;
  previous?: string | null;
  epoch?: number;
  inflight?: GatewayInflightRow[];
  log?: CallLog;
  /** Live instances, `['gw-1']` by default; each starts having seen the initial epoch. */
  instances?: string[];
  /** Instances that are held back from the start. */
  manualAck?: string[];
  /** `groupAuthority` the status reports while each version is active; `{}` for unlisted versions. */
  authorityByVersion?: Record<string, CutoverStatus['groupAuthority']>;
  sessionMode?: CutoverStatus['sessionMode'];
  /** Clock of the waits' deadlines and of reported times. */
  clock?: Clock;
  /** Pause between the waits' polls; real timers by default. */
  sleep?: (ms: number) => Promise<void>;
}

/** One call made on the double, in process or through `listen()`. */
export interface GatewayDoubleCall {
  op: GatewayOperationName;
  args: unknown;
}

/** A running loopback HTTP form of the double. */
export interface GatewayListener {
  /** Base URL for `OPT2_SERVICE_URLS.gateway`. */
  url: string;
  close(): Promise<void>;
}

/** `GatewayClient` over in-memory cut-over state, plus the controls suites drive it with. */
export interface GatewayDouble extends GatewayClient {
  readonly calls: GatewayDoubleCall[];
  readonly log: CallLog;
  readonly frozen: Set<string>;
  /** Current status, without recording a call. */
  snapshot(): CutoverStatus;
  /** Copies of the in-flight rows, `orphan` set from their instance's liveness. */
  inflightRows(): GatewayInflightRow[];
  /** Sets the active version, and the epoch when given, without recording a call. */
  setActive(tableVersion: string | null, epoch?: number): void;
  setInflight(rows: readonly GatewayInflightRow[]): void;
  addInflight(row: GatewayInflightRow): void;
  /** Removes a row as its own instance does on completion; false when no row has that id. */
  removeInflight(requestId: string): boolean;
  /** Switches an instance's acknowledgement mode; an unknown instance joins as live. */
  setInstanceAck(instance: string, mode: InstanceAck): void;
  /** Lets an instance see `epoch`. */
  ackEpoch(instance: string, epoch: number): void;
  /** Marks an instance dead: it stops acknowledging and its rows become orphans. */
  killInstance(instance: string): void;
  /** Makes the next call of `op` reject; queued failures apply in order. */
  failNext(op: GatewayOperationName, failure: GatewayFailure): void;
  /** Serves the contract's cut-over and orphan-clearing operations over the same state on `127.0.0.1`. */
  listen(): Promise<GatewayListener>;
}

interface InstanceState {
  live: boolean;
  seenEpoch: number;
  ack: InstanceAck;
  /** Last heartbeat of a dead instance; a live one reports the clock's time. */
  lastHeartbeat: string | null;
}

interface HttpAnswer {
  status: number;
  body: unknown;
}

const OPERATION_IDS = {
  status: 'cutoverStatus',
  activate: 'cutoverActivate',
  freeze: 'cutoverFreeze',
  unfreeze: 'cutoverUnfreeze',
  awaitEpoch: 'cutoverStatus',
  awaitInflightDrained: 'cutoverStatus',
  clearOrphans: 'inflightClearOrphans',
} as const satisfies Record<GatewayOperationName, string>;

const VERSION_PATTERN = /^v[0-9]{4}$/;
const ROUTE_PATTERN = /^[a-z0-9-]+:\S+$/;
const EVIDENCE_SIDE: Readonly<Record<OrphanEvidence, InflightSide>> = { 'legacy-restart': 'legacy', 'gates-closed': 'target' };

/** The contract's `LegacyError` body; 5xx answers carry the `LegacyUnavailable` code and message. */
function legacyError(method: string, status: number, message: string): unknown {
  const error = status >= 500 ? { code: 'server_error', message: 'Unhandled Exception' } : { code: 'badRequest', message };
  return { apiversion: 'v1', method, error };
}

function refusal(operation: GatewayOperationName, status: number, message: string): GatewayCallError {
  const operationId = OPERATION_IDS[operation];
  return new GatewayCallError(operationId, status, legacyError(operationId, status, message));
}

function routesRefusal(routes: readonly string[]): string | undefined {
  if (routes.length === 0) return 'routes must name at least one route key';
  if (new Set(routes).size !== routes.length) return 'routes must not repeat a route key';
  const malformed = routes.find((route) => !ROUTE_PATTERN.test(route));
  return malformed === undefined ? undefined : `route key ${malformed} is malformed`;
}

function clearRefusal({ side, evidence }: InflightClearRequest): string | undefined {
  if (EVIDENCE_SIDE[evidence.kind] !== side) return `${evidence.kind} evidence clears only ${EVIDENCE_SIDE[evidence.kind]}-side in-flight writes`;
  if (evidence.kind === 'gates-closed' && (evidence.units ?? []).length === 0) return 'gates-closed evidence must name the units whose gates closed';
  return Number.isNaN(Date.parse(evidence.at)) ? `evidence.at ${evidence.at} is not a timestamp` : undefined;
}

/** True when a target row's units are known, non-empty and all among the closed gates. */
function coveredByGates(units: readonly string[] | undefined, closed: ReadonlySet<string>): boolean {
  return units !== undefined && units.length > 0 && units.every((unit) => closed.has(unit));
}

function groupInflight(rows: readonly GatewayInflightRow[]): InflightRow[] {
  const groups = new Map<string, { instanceId: string; route: string; side: InflightSide; count: number; oldest: number }>();
  for (const row of rows) {
    const key = JSON.stringify([row.instance, row.route, row.side]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { instanceId: row.instance, route: row.route, side: row.side, count: 1, oldest: row.startedAt });
    else {
      group.count += 1;
      group.oldest = Math.min(group.oldest, row.startedAt);
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId) || a.route.localeCompare(b.route) || a.side.localeCompare(b.side))
    .map(({ instanceId, route, side, count, oldest }) => ({ instanceId, route, side, count, oldestStartedAt: new Date(oldest).toISOString() }));
}

function laggingInstances(status: CutoverStatus, epoch: number): GatewayInstance[] {
  return status.instances.filter((instance) => instance.live && instance.seenEpoch < epoch);
}

/** The awaited routes' grouped rows, split as the real client splits them: by whether their instance is live. */
function partitionInflight(status: CutoverStatus, routes: ReadonlySet<string>): { pending: InflightRow[]; orphans: InflightRow[] } {
  const live = new Set(status.instances.filter((instance) => instance.live).map((instance) => instance.instanceId));
  const pending: InflightRow[] = [];
  const orphans: InflightRow[] = [];
  for (const row of status.inflight) {
    if (routes.has(row.route)) (live.has(row.instanceId) ? pending : orphans).push(row);
  }
  return { pending, orphans };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isClearRequest(body: unknown): body is InflightClearRequest {
  if (!isRecord(body) || (body.side !== 'legacy' && body.side !== 'target') || !isRecord(body.evidence)) return false;
  const { kind, holderId, at, units } = body.evidence;
  return (
    (kind === 'legacy-restart' || kind === 'gates-closed') &&
    typeof holderId === 'string' &&
    typeof at === 'string' &&
    (units === undefined || isStringArray(units)) &&
    (body.instanceIds === undefined || isStringArray(body.instanceIds))
  );
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

function sendJson(res: ServerResponse, { status, body }: HttpAnswer): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Creates a gateway double whose instances acknowledge every epoch at once unless held back. */
export function createGatewayDouble(opts: GatewayDoubleOptions = {}): GatewayDouble {
  const clock = opts.clock ?? systemClock;
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const log = opts.log ?? createCallLog();
  const authorityByVersion = opts.authorityByVersion ?? {};
  const sessionMode = opts.sessionMode ?? 'legacy-primary';
  const calls: GatewayDoubleCall[] = [];
  const frozen = new Set<string>();
  const failures = new Map<GatewayOperationName, GatewayFailure[]>();
  const instances = new Map<string, InstanceState>();
  let active = opts.active ?? null;
  let previous = opts.previous ?? null;
  let epoch = opts.epoch ?? 0;
  let rows: GatewayInflightRow[] = [];

  const manual = new Set(opts.manualAck ?? []);
  for (const id of opts.instances ?? ['gw-1']) {
    instances.set(id, { live: true, seenEpoch: epoch, ack: manual.has(id) ? 'manual' : 'auto', lastHeartbeat: null });
  }

  function instance(id: string): InstanceState {
    const state = instances.get(id);
    if (state === undefined) throw new Error(`Gateway double has no instance ${id}`);
    return state;
  }

  function killInstance(id: string): void {
    const state = instances.get(id);
    const lastHeartbeat = clock.now().toISOString();
    if (state === undefined) instances.set(id, { live: false, seenEpoch: epoch, ack: 'manual', lastHeartbeat });
    else if (state.live) Object.assign(state, { live: false, lastHeartbeat });
  }

  function register(row: GatewayInflightRow): GatewayInflightRow {
    if (row.orphan === true) killInstance(row.instance);
    else if (!instances.has(row.instance)) instances.set(row.instance, { live: true, seenEpoch: epoch, ack: 'auto', lastHeartbeat: null });
    return row.units === undefined ? { ...row } : { ...row, units: [...row.units] };
  }

  function isOrphan(row: GatewayInflightRow): boolean {
    return instances.get(row.instance)?.live !== true;
  }

  /** Every live `auto` instance sees the current epoch. */
  function publishEpoch(): void {
    for (const state of instances.values()) if (state.live && state.ack === 'auto') state.seenEpoch = epoch;
  }

  /** Commits a new epoch. */
  function bumpEpoch(): void {
    epoch += 1;
    publishEpoch();
  }

  function snapshot(): CutoverStatus {
    const now = clock.now().toISOString();
    const reported = [...instances].map(([instanceId, state]) => ({
      instanceId,
      seenEpoch: state.seenEpoch,
      heartbeatAt: state.live ? now : (state.lastHeartbeat ?? now),
      live: state.live,
    }));
    const seen = reported.filter((item) => item.live).map((item) => item.seenEpoch);
    return {
      tableVersion: active,
      previous,
      epoch,
      groupAuthority: { ...(active === null ? {} : (authorityByVersion[active] ?? {})) },
      frozen: [...frozen].sort(),
      instances: reported,
      acknowledgedEpoch: seen.length === 0 ? null : Math.min(...seen),
      inflight: groupInflight(rows),
      sessionMode,
    };
  }

  /** Records the call in `calls` and the shared log, then rejects with a queued failure of `op` if there is one. */
  function begin(op: GatewayOperationName, args: unknown): void {
    calls.push({ op, args });
    log.append(GATEWAY_COMPONENT, op, args);
    const failure = failures.get(op)?.shift();
    if (failure === undefined) return;
    if (failure instanceof Error) throw failure;
    const operationId = OPERATION_IDS[op];
    throw new GatewayCallError(operationId, failure.status, failure.body ?? legacyError(operationId, failure.status, `Gateway refused ${operationId}`));
  }

  /** The real client's poll loop over in-memory status: settle, else time out once the clock passes the deadline. */
  async function poll<R>(
    budget: WaitBudget,
    settle: (current: CutoverStatus) => R | undefined,
    timeout: (current: CutoverStatus) => GatewayWaitTimeoutError,
  ): Promise<R> {
    const deadline = clock.now().getTime() + budget.timeoutMs;
    for (;;) {
      const current = snapshot();
      const result = settle(current);
      if (result !== undefined) return result;
      if (clock.now().getTime() >= deadline) throw timeout(current);
      await sleep(budget.intervalMs);
    }
  }

  function changeFrozen(op: 'freeze' | 'unfreeze', routes: readonly string[]): CutoverStatus {
    const problem = routesRefusal(routes);
    if (problem !== undefined) throw refusal(op, 400, problem);
    for (const route of routes) {
      if (op === 'freeze') frozen.add(route);
      else frozen.delete(route);
    }
    bumpEpoch();
    return snapshot();
  }

  const client = {
    async status(): Promise<CutoverStatus> {
      begin('status', undefined);
      return snapshot();
    },

    async activate(tableVersion: string): Promise<CutoverActivateResponse> {
      begin('activate', { tableVersion });
      if (!VERSION_PATTERN.test(tableVersion)) {
        throw new GatewayCallError(OPERATION_IDS.activate, 400, {
          findings: [{ rule: 'unknown-version', message: `${tableVersion} is not a cut-over version name` }],
        });
      }
      previous = active;
      active = tableVersion;
      bumpEpoch();
      return { tableVersion, epoch };
    },

    async freeze(routes: readonly string[]): Promise<CutoverStatus> {
      begin('freeze', { routes: [...routes] });
      return changeFrozen('freeze', routes);
    },

    async unfreeze(routes: readonly string[]): Promise<CutoverStatus> {
      begin('unfreeze', { routes: [...routes] });
      return changeFrozen('unfreeze', routes);
    },

    async awaitEpoch(awaited: number, budget: WaitBudget): Promise<CutoverStatus> {
      begin('awaitEpoch', { epoch: awaited, budget });
      return poll(
        budget,
        (current) => (laggingInstances(current, awaited).length === 0 ? current : undefined),
        (current) => new GatewayWaitTimeoutError({ kind: 'epoch', epoch: awaited, lagging: laggingInstances(current, awaited) }),
      );
    },

    async awaitInflightDrained(routes: readonly string[], budget: WaitBudget): Promise<InflightDrainResult> {
      begin('awaitInflightDrained', { routes: [...routes], budget });
      const awaitedRoutes: ReadonlySet<string> = new Set(routes);
      return poll(
        budget,
        (current) => {
          const { pending, orphans } = partitionInflight(current, awaitedRoutes);
          return pending.length === 0 ? { orphans } : undefined;
        },
        (current) => new GatewayWaitTimeoutError({ kind: 'inflight', pending: partitionInflight(current, awaitedRoutes).pending }),
      );
    },

    async clearOrphans(request: InflightClearRequest): Promise<InflightClearResponse> {
      begin('clearOrphans', request);
      const problem = clearRefusal(request);
      if (problem !== undefined) throw refusal('clearOrphans', 400, problem);
      const before = Date.parse(request.evidence.at);
      const covered = new Set(request.evidence.units ?? []);
      const limit = request.instanceIds === undefined ? null : new Set(request.instanceIds);
      const cleared = (row: GatewayInflightRow): boolean =>
        isOrphan(row) &&
        row.side === request.side &&
        row.startedAt < before &&
        (limit === null || limit.has(row.instance)) &&
        (row.side === 'legacy' || coveredByGates(row.units, covered));
      const kept = rows.filter((row) => !cleared(row));
      const count = rows.length - kept.length;
      rows = kept;
      return { cleared: count };
    },
  } satisfies GatewayClient;

  /** Answers one contract operation from the same state; refusals carry the contract's error bodies. */
  async function answer(method: string, path: string, body: unknown): Promise<HttpAnswer> {
    const malformed = (operationId: string): HttpAnswer => ({ status: 400, body: legacyError(operationId, 400, 'Malformed request body') });
    switch (`${method} ${path}`) {
      case 'GET /internal/v1/cutover/status':
        return { status: 200, body: await client.status() };
      case 'POST /internal/v1/cutover/activate':
        if (!isRecord(body) || typeof body.tableVersion !== 'string') return malformed(OPERATION_IDS.activate);
        return { status: 200, body: await client.activate(body.tableVersion) };
      case 'POST /internal/v1/cutover/freeze':
      case 'POST /internal/v1/cutover/unfreeze': {
        const op = path.endsWith('/freeze') ? 'freeze' : 'unfreeze';
        if (!isRecord(body) || !isStringArray(body.routes)) return malformed(OPERATION_IDS[op]);
        return { status: 200, body: await client[op](body.routes) };
      }
      case 'POST /internal/v1/inflight:clear-orphans':
        if (!isClearRequest(body)) return malformed(OPERATION_IDS.clearOrphans);
        return { status: 200, body: await client.clearOrphans(body) };
      default:
        return { status: 404, body: legacyError(`${method} ${path}`, 404, `No gateway double operation at ${method} ${path}`) };
    }
  }

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    let result: HttpAnswer;
    try {
      let body: unknown;
      try {
        body = method === 'POST' ? await readJson(req) : undefined;
      } catch {
        sendJson(res, { status: 400, body: legacyError(`${method} ${path}`, 400, 'Request body is not JSON') });
        return;
      }
      result = await answer(method, path, body);
    } catch (err) {
      result =
        err instanceof GatewayCallError
          ? { status: err.status, body: err.body }
          : { status: 500, body: legacyError(`${method} ${path}`, 500, String(err)) };
    }
    sendJson(res, result);
  }

  async function listen(): Promise<GatewayListener> {
    const server = createServer((req, res) => void serve(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err === undefined ? resolve() : reject(err)));
          // Keep-alive sockets of the real client's agent would otherwise hold `close` open.
          server.closeAllConnections();
        }),
    };
  }

  for (const row of opts.inflight ?? []) rows.push(register(row));

  return {
    ...client,
    calls,
    log,
    frozen,
    snapshot,
    inflightRows: () => rows.map((row) => ({ ...row, orphan: isOrphan(row) })),
    setActive(tableVersion, newEpoch) {
      if (tableVersion !== active) previous = active;
      active = tableVersion;
      if (newEpoch !== undefined) {
        epoch = newEpoch;
        publishEpoch();
      }
    },
    setInflight(next) {
      rows = next.map(register);
    },
    addInflight(row) {
      rows.push(register(row));
    },
    removeInflight(requestId) {
      const before = rows.length;
      rows = rows.filter((row) => row.requestId !== requestId);
      return rows.length !== before;
    },
    setInstanceAck(id, mode) {
      const state = instances.get(id);
      if (state === undefined) {
        instances.set(id, { live: true, seenEpoch: epoch, ack: mode, lastHeartbeat: null });
        return;
      }
      state.ack = mode;
      if (mode === 'auto' && state.live) state.seenEpoch = epoch;
    },
    ackEpoch(id, seen) {
      const state = instance(id);
      state.seenEpoch = Math.max(state.seenEpoch, seen);
    },
    killInstance,
    failNext(op, failure) {
      failures.set(op, [...(failures.get(op) ?? []), failure]);
    },
    listen,
  };
}
