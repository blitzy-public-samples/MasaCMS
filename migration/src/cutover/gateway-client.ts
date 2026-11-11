// Client of the gateway's internal cut-over operations, plus the epoch and in-flight waits of a transition.
import { setTimeout as delay } from 'node:timers/promises';

import { systemClock, type Clock, type ServiceClient } from '@opt2/platform/service-kit';

import type { components, operations, paths } from '../generated/clients/gateway.js';

type Schemas = components['schemas'];

/** Body of `cutoverActivate`. */
export type CutoverActivateRequest = Schemas['CutoverActivateRequest'];
/** `cutoverActivate`'s answer: the now-active version and the epoch its activation committed. */
export type CutoverActivateResponse = operations['cutoverActivate']['responses'][200]['content']['application/json'];
/** Body of `cutoverFreeze` and `cutoverUnfreeze`. */
export type CutoverRoutesRequest = Schemas['CutoverRoutesRequest'];
/** Active version (null before `v0001`), epoch, freezes, instance acknowledgements and in-flight writes. */
export type CutoverStatus = Schemas['CutoverStatus'];
/** One gateway instance, the epoch it has seen and whether it is live. */
export type GatewayInstance = CutoverStatus['instances'][number];
/** In-flight writes of one gateway instance on one route and side. */
export type InflightRow = CutoverStatus['inflight'][number];
/** Body of `inflightClearOrphans`. */
export type InflightClearRequest = Schemas['InflightClearRequest'];
/** Number of orphan rows `inflightClearOrphans` deleted. */
export type InflightClearResponse = Schemas['InflightClearResponse'];

/** Evidence that an orphaned write can no longer commit: `legacy-restart` for legacy rows, `gates-closed` for target rows. */
export type OrphanEvidence = InflightClearRequest['evidence']['kind'];
/** Side an in-flight write was forwarded to. */
export type InflightSide = InflightClearRequest['side'];

/** Callee name of the gateway in `OPT2_SERVICE_URLS`. */
export const GATEWAY_SERVICE = 'gateway';

/** Poll budget of a wait, taken by callers from the migration config. */
export interface WaitBudget {
  /** Time after which the last failed poll ends the wait. */
  timeoutMs: number;
  /** Pause between polls. */
  intervalMs: number;
}

/** Outcome of {@link GatewayClient.awaitInflightDrained}. */
export interface InflightDrainResult {
  /** Rows on the awaited routes whose instance is not live; they block nothing here and leave only with evidence. */
  orphans: InflightRow[];
}

/** The migration service's calls into the gateway's cut-over state. */
export interface GatewayClient {
  /** `cutoverStatus`. */
  status(): Promise<CutoverStatus>;
  /** `cutoverActivate`: activates the version, whose `previous` must be the active one, and commits a new epoch. */
  activate(tableVersion: string): Promise<CutoverActivateResponse>;
  /** `cutoverFreeze`: freezes entries of the active version and returns the status with the new epoch. */
  freeze(routes: readonly string[]): Promise<CutoverStatus>;
  /** `cutoverUnfreeze`: unfreezes entries of the active version and returns the status with the new epoch. */
  unfreeze(routes: readonly string[]): Promise<CutoverStatus>;
  /** Resolves with the first status in which every live instance has seen `epoch`; throws {@link GatewayWaitTimeoutError}. */
  awaitEpoch(epoch: number, budget: WaitBudget): Promise<CutoverStatus>;
  /** Resolves once no live instance holds an in-flight write on `routes`; throws {@link GatewayWaitTimeoutError}. */
  awaitInflightDrained(routes: readonly string[], budget: WaitBudget): Promise<InflightDrainResult>;
  /** `inflightClearOrphans`: deletes dead instances' rows that the evidence covers. */
  clearOrphans(request: InflightClearRequest): Promise<InflightClearResponse>;
}

/** Construction options of {@link createGatewayClient}. */
export interface GatewayClientDeps {
  /** Service client of caller `migration` (`platform.migration`): status and orphan clearing. */
  migrationClient: ServiceClient;
  /** Service client of caller `operator` (`platform.operator`): activate, freeze and unfreeze. */
  operatorClient: ServiceClient;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

/** The gateway answered a cut-over operation outside 2xx; `body` is its answer unchanged, such as `ValidationFindings`. */
export class GatewayCallError extends Error {
  override readonly name: string = 'GatewayCallError';

  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Gateway ${operation} answered HTTP ${status}`);
  }
}

/** What a wait was still waiting for when its budget ran out. */
export interface GatewayWaitTimeoutDetails {
  kind: 'epoch' | 'inflight';
  epoch?: number;
  /** Live instances that had not seen `epoch`. */
  lagging?: GatewayInstance[];
  /** In-flight rows of live instances still on the awaited routes. */
  pending?: InflightRow[];
}

function timeoutMessage({ kind, epoch, lagging = [], pending = [] }: GatewayWaitTimeoutDetails): string {
  if (kind === 'epoch') {
    return `Gateway instances have not acknowledged epoch ${String(epoch)}: ${lagging.map((i) => `${i.instanceId} (seen ${i.seenEpoch})`).join(', ')}`;
  }
  const rows = pending.map((row) => `${row.instanceId} ${row.side} ${row.route} (${row.count} since ${row.oldestStartedAt})`);
  return `In-flight writes are still running on live gateway instances: ${rows.join(', ')}`;
}

/** A wait's budget ran out, naming the lagging instances (`epoch`) or the live in-flight rows left (`inflight`). */
export class GatewayWaitTimeoutError extends Error {
  override readonly name: string = 'GatewayWaitTimeoutError';
  readonly kind: 'epoch' | 'inflight';
  readonly epoch?: number;
  readonly lagging?: GatewayInstance[];
  readonly pending?: InflightRow[];

  constructor(details: GatewayWaitTimeoutDetails) {
    super(timeoutMessage(details));
    this.kind = details.kind;
    this.epoch = details.epoch;
    this.lagging = details.lagging;
    this.pending = details.pending;
  }
}

interface GatewayOperation {
  readonly operationId: keyof operations;
  readonly method: 'GET' | 'POST';
  readonly path: keyof paths;
}

const OPERATIONS = Object.freeze({
  status: { operationId: 'cutoverStatus', method: 'GET', path: '/internal/v1/cutover/status' },
  activate: { operationId: 'cutoverActivate', method: 'POST', path: '/internal/v1/cutover/activate' },
  freeze: { operationId: 'cutoverFreeze', method: 'POST', path: '/internal/v1/cutover/freeze' },
  unfreeze: { operationId: 'cutoverUnfreeze', method: 'POST', path: '/internal/v1/cutover/unfreeze' },
  clearOrphans: { operationId: 'inflightClearOrphans', method: 'POST', path: '/internal/v1/inflight:clear-orphans' },
} as const satisfies Record<string, GatewayOperation>);

function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

function laggingInstances(status: CutoverStatus, epoch: number): GatewayInstance[] {
  return status.instances.filter((instance) => instance.live && instance.seenEpoch < epoch);
}

/** The awaited routes' in-flight rows, split by whether their instance is live in the same status. */
function partitionInflight(status: CutoverStatus, routes: ReadonlySet<string>): { pending: InflightRow[]; orphans: InflightRow[] } {
  const live = new Set(status.instances.filter((instance) => instance.live).map((instance) => instance.instanceId));
  const pending: InflightRow[] = [];
  const orphans: InflightRow[] = [];
  for (const row of status.inflight) {
    if (routes.has(row.route)) (live.has(row.instanceId) ? pending : orphans).push(row);
  }
  return { pending, orphans };
}

/** Creates the gateway client over the migration and operator service clients. */
export function createGatewayClient(deps: GatewayClientDeps): GatewayClient {
  const { migrationClient, operatorClient } = deps;
  const clock = deps.clock ?? systemClock;
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));

  async function call<T>(client: ServiceClient, operation: GatewayOperation, json?: unknown): Promise<T> {
    // The gateway sees only the calling workload's credential, never a user token from the request context.
    const response = await client.request<T>({
      service: GATEWAY_SERVICE,
      method: operation.method,
      path: operation.path,
      json,
      userToken: null,
    });
    if (!isSuccess(response.status)) throw new GatewayCallError(operation.operationId, response.status, response.body);
    return response.body;
  }

  const status = (): Promise<CutoverStatus> => call<CutoverStatus>(migrationClient, OPERATIONS.status);

  /** Polls the status until `settle` yields a result; after the deadline the last unsettled status builds the error. */
  async function poll<R>(
    budget: WaitBudget,
    settle: (current: CutoverStatus) => R | undefined,
    timeout: (current: CutoverStatus) => GatewayWaitTimeoutError,
  ): Promise<R> {
    const deadline = clock.now().getTime() + budget.timeoutMs;
    for (;;) {
      const current = await status();
      const result = settle(current);
      if (result !== undefined) return result;
      if (clock.now().getTime() >= deadline) throw timeout(current);
      await sleep(budget.intervalMs);
    }
  }

  return {
    status,

    // Cloud transitions need an operator invocation credential; only the local signer mints one in this run.
    activate: (tableVersion) =>
      call<CutoverActivateResponse>(operatorClient, OPERATIONS.activate, { tableVersion } satisfies CutoverActivateRequest),

    freeze: (routes) =>
      call<CutoverStatus>(operatorClient, OPERATIONS.freeze, { routes: [...routes] } satisfies CutoverRoutesRequest),

    unfreeze: (routes) =>
      call<CutoverStatus>(operatorClient, OPERATIONS.unfreeze, { routes: [...routes] } satisfies CutoverRoutesRequest),

    awaitEpoch: (epoch, budget) =>
      poll(
        budget,
        (current) => (laggingInstances(current, epoch).length === 0 ? current : undefined),
        (current) => new GatewayWaitTimeoutError({ kind: 'epoch', epoch, lagging: laggingInstances(current, epoch) }),
      ),

    awaitInflightDrained(routes, budget) {
      const awaited: ReadonlySet<string> = new Set(routes);
      return poll(
        budget,
        (current) => {
          const { pending, orphans } = partitionInflight(current, awaited);
          return pending.length === 0 ? { orphans } : undefined;
        },
        (current) => new GatewayWaitTimeoutError({ kind: 'inflight', pending: partitionInflight(current, awaited).pending }),
      );
    },

    clearOrphans: (request) => call<InflightClearResponse>(migrationClient, OPERATIONS.clearOrphans, request),
  };
}
