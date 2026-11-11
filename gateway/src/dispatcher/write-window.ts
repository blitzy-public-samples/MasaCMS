// Client of migration's write-window operations for legacy-write entries, plus the window scope taken from the request.
import { LegacyServiceUnavailableError, normaliseRouteKey } from '@opt2/platform/legacy-compat';
import {
  SERVICE_CALL_TIMEOUT_MS,
  ServiceUnavailableError,
  type ServiceClient,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import type { InventoryFacts } from '../cutover/types.js';
import type { components, paths } from '../generated/clients/migration.js';
import { paramValue } from './body.js';

type Schemas = components['schemas'];

/** Migration's open budget: leases, gate closing and projection await. */
export const WINDOW_OPEN_BUDGET_MS = 30_000;

/** Bound of the open call: migration's budget plus the platform call bound for transport. */
export const WINDOW_OPEN_TIMEOUT_MS = WINDOW_OPEN_BUDGET_MS + SERVICE_CALL_TIMEOUT_MS;

/** Callee name of the migration service in the service client's URL map. */
export const MIGRATION_SERVICE = 'migration';

/** The writers' keyScope values, or the whole table. */
export type WindowScope = Schemas['WindowScope'];
/** Body of `windowOpen`. */
export type WindowOpenInput = Schemas['WindowOpenRequest'];
/** The opened window; legacy may execute. */
export type WindowOpened = Pick<Schemas['WindowOpenResponse'], 'windowId'>;
/** Body of `windowComplete`. */
export type WindowCompleteInput = Schemas['WindowCompleteRequest'];
/** Window state after completion; `unknown` when migration's answer was not received. */
export type WindowCompleteResult = Schemas['WindowCompleteResponse'];
/** Values of the session the request acts in, used where the request carries no scope value. */
export interface WindowSessionValues {
  siteid?: string | undefined;
  userid?: string | undefined;
}

/** Contract path of each window operation; `satisfies` checks them against the migration contract. */
export const WINDOW_OPERATIONS = Object.freeze({
  open: '/internal/v1/windows',
  complete: '/internal/v1/windows/{windowId}:complete',
} as const satisfies Record<string, keyof paths>);

const COMPLETE_STATES: ReadonlySet<string> = new Set<WindowCompleteResult['state']>(['closed', 'import-pending', 'unknown']);

/** keyScope name meaning the writer touches rows no request value bounds. */
const TABLE_SCOPE = 'table';

/** A trailing variant suffix; fixture keys carry `{id}` segments mid-key, which are not variants. */
const VARIANT_SUFFIX = /\{[^{}]*\}$/;

/** Migration refused or could not be asked to open the window; renders as the legacy 503 before legacy executes. */
export class WindowOpenError extends LegacyServiceUnavailableError {
  override readonly name: string = 'WindowOpenError';

  constructor(
    readonly routeKey: string,
    override readonly cause: unknown,
  ) {
    super(`Write window for ${routeKey} could not open`, 'auto', 'window-unavailable');
  }
}

/** The gateway's write-window calls into migration. */
export interface WriteWindowClient {
  /** Opens a window or throws WindowOpenError; a caller failing before forwarding then calls `complete(windowId, {forwarded: false})`. */
  open(input: WindowOpenInput): Promise<WindowOpened>;
  /** Reports legacy's outcome so migration imports and closes; never throws, `unknown` when the answer is lost. */
  complete(windowId: string, input: WindowCompleteInput): Promise<WindowCompleteResult>;
  /** {@link scopeFor} over the client's inventory facts. */
  scope(routeKey: string, params: Record<string, unknown>, sessionValues: WindowSessionValues): WindowScope;
}

function sessionValue(values: WindowSessionValues, name: string): string | undefined {
  const value: unknown = Object.entries(values).find(([key]) => key === name)?.[1];
  return typeof value === 'string' ? value : undefined;
}

/** The route's keyScope, from its own facts or, when it has none, from its base key's. */
function keyScopeOf(facts: InventoryFacts, routeKey: string): readonly string[] | undefined {
  const key = normaliseRouteKey(routeKey);
  const own = facts.get(key);
  if (own !== undefined) return own.keyScope;
  const base = key.replace(VARIANT_SUFFIX, '');
  return base !== key && base !== '' ? facts.get(base)?.keyScope : undefined;
}

/** Window scope: each keyScope value from the request, else the session; the whole table when any is missing or empty. */
export function scopeFor(
  facts: InventoryFacts,
  routeKey: string,
  params: Record<string, unknown>,
  sessionValues: WindowSessionValues,
): WindowScope {
  const names = (keyScopeOf(facts, routeKey) ?? []).map((name) => name.toLowerCase());
  if (names.length === 0 || names.includes(TABLE_SCOPE)) return { table: true };
  const keys: Record<string, string> = {};
  for (const name of names) {
    const value = paramValue(params, name) || sessionValue(sessionValues, name);
    if (!value) return { table: true };
    keys[name] = value;
  }
  return { keys };
}

/** The open answer's window id; undefined for a body that carries none. */
function windowIdOf(body: unknown): string | undefined {
  const windowId = (body as Partial<WindowOpened> | null | undefined)?.windowId;
  return typeof windowId === 'string' && windowId !== '' ? windowId : undefined;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

function httpFailure(status: number): Error {
  return Object.assign(new Error(`${MIGRATION_SERVICE} answered HTTP ${String(status)}`), { code: `HTTP_${String(status)}` });
}

/** Creates the write-window client over the gateway's migration service client. */
export function createWriteWindowClient({ client, facts }: { client: ServiceClient; facts: InventoryFacts }): WriteWindowClient {
  return {
    async open(input) {
      let response: ServiceResponse;
      try {
        // Migration sees only the gateway's invocation credential, never the browser's user token.
        response = await client.request({
          service: MIGRATION_SERVICE,
          method: 'POST',
          path: WINDOW_OPERATIONS.open,
          json: input,
          userToken: null,
          timeoutMs: WINDOW_OPEN_TIMEOUT_MS,
        });
      } catch (err) {
        if (err instanceof ServiceUnavailableError) throw new WindowOpenError(input.routeKey, err);
        throw err;
      }
      if (!isSuccess(response.status)) throw new WindowOpenError(input.routeKey, httpFailure(response.status));
      const windowId = windowIdOf(response.body);
      // Without an id the window cannot be completed, so legacy must not run.
      if (windowId === undefined) throw new WindowOpenError(input.routeKey, new Error('windowOpen answered no windowId'));
      return { windowId };
    },

    async complete(windowId, input) {
      let response: ServiceResponse<Partial<WindowCompleteResult> | null | undefined>;
      try {
        response = await client.request({
          service: MIGRATION_SERVICE,
          method: 'POST',
          path: WINDOW_OPERATIONS.complete.replace('{windowId}', encodeURIComponent(windowId)),
          json: input,
          userToken: null,
        });
      } catch {
        // Legacy has committed or never ran either way; migration's lease handling settles a window whose answer is lost.
        return { state: 'unknown' };
      }
      const state = response.body?.state;
      if (isSuccess(response.status) && state !== undefined && COMPLETE_STATES.has(state)) return { state };
      return { state: 'unknown' };
    },

    scope: (routeKey, params, sessionValues) => scopeFor(facts, routeKey, params, sessionValues),
  };
}
