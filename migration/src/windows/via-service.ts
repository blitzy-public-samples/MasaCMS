// `opt2-migrate` client of the running migration service's write-window operations, called as `platform.operator`.
import { randomUUID } from 'node:crypto';

import { currentRequestContext, REQUEST_ID_HEADER, SERVICE_CALL_TIMEOUT_MS, ServiceUnavailableError } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import type { components, operations, paths } from '../generated/openapi.js';

type Schemas = components['schemas'];

/** The writers' keyScope values, or the whole table. */
export type WindowScope = Schemas['WindowScope'];
/** Body of `windowOpen`. */
export type WindowOpenRequest = Schemas['WindowOpenRequest'];
/** `windowOpen`'s answer: the window id, open and executing. */
export type WindowOpenResponse = Schemas['WindowOpenResponse'];
/** Body of `windowComplete`. */
export type WindowCompleteRequest = Schemas['WindowCompleteRequest'];
/** `windowComplete`'s answer: the window state after completion. */
export type WindowCompleteResponse = Schemas['WindowCompleteResponse'];
/** A write window as the service reports it. */
export type WriteWindow = Schemas['WriteWindow'];

/** Set to a window id when ColdFusion restarts under a holder that already leases the content units; `legacy-start.sh` then opens no start-up window. */
export const STARTUP_WINDOW_HOLDER_ENV = 'OPT2_STARTUP_WINDOW_HOLDER';

/** Default route label of start-up windows. */
export const STARTUP_ROUTE_KEY = 'startup:legacy-start';

/** Callee name of the migration service in the service client's URL map. */
const MIGRATION_SERVICE = 'migration';

const HTTP_UNAVAILABLE = 503;

/** Input of {@link openWindowViaService}. */
export interface OpenWindowInput {
  /** Route label; {@link STARTUP_ROUTE_KEY} when omitted. */
  routeKey?: string;
  /** `<schema>.<table>` unit ids the legacy writer may write. */
  units: string[];
  /** `{table: true}` when omitted. */
  scope?: WindowScope;
}

/** Input of {@link completeWindowViaService}. */
export interface CompleteWindowInput {
  /** Whether the legacy writer ran; false closes the window without an import. */
  forwarded: boolean;
}

/** The context part these calls need: the per-caller service client and the window budgets. */
type WindowCallContext = Pick<MigrationContext, 'clientAs' | 'config'>;

interface WindowOperation {
  readonly operationId: keyof operations;
  readonly path: keyof paths;
}

const OPERATIONS = Object.freeze({
  open: { operationId: 'windowOpen', path: '/internal/v1/windows' },
  complete: { operationId: 'windowComplete', path: '/internal/v1/windows/{windowId}:complete' },
  resolve: { operationId: 'windowResolve', path: '/internal/v1/windows/{windowId}:resolve' },
} as const satisfies Record<string, WindowOperation>);

/** The migration service answered a window operation outside 2xx and other than 503; `body` is its answer unchanged. */
export class WindowCallError extends Error {
  override readonly name: string = 'WindowCallError';

  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Migration ${operation} answered HTTP ${String(status)}${legacyMessageSuffix(body)}`);
  }
}

/** `: <message>` of a legacy error envelope, or empty. */
function legacyMessageSuffix(body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | null | undefined)?.error?.message;
  return typeof message === 'string' ? `: ${message}` : '';
}

/** The operation's path with its `{windowId}` segment filled. */
function windowPath(operation: WindowOperation, windowId: string): string {
  return operation.path.replace('{windowId}', encodeURIComponent(windowId));
}

/** Sends one POST as `operator` without a user token, with `options.headers` and bounded by `options.timeoutMs` when given; a 503 throws the legacy 503 error, any other non-2xx {@link WindowCallError}. */
async function post<T>(
  ctx: WindowCallContext,
  operation: WindowOperation,
  path: string,
  json?: unknown,
  options: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const { headers, timeoutMs } = options;
  const response = await ctx
    .clientAs('operator')
    .request<T>({ service: MIGRATION_SERVICE, method: 'POST', path, json, headers, userToken: null, timeoutMs });
  if (response.status === HTTP_UNAVAILABLE) {
    const cause = Object.assign(new Error(`${MIGRATION_SERVICE} answered HTTP ${String(HTTP_UNAVAILABLE)}`), {
      code: `HTTP_${String(HTTP_UNAVAILABLE)}`,
    });
    throw new ServiceUnavailableError(MIGRATION_SERVICE, cause);
  }
  if (response.status < 200 || response.status > 299) {
    throw new WindowCallError(operation.operationId, response.status, response.body);
  }
  return response.body;
}

/**
 * Opens a write window in the running migration service, waiting its open budget plus the call bound; legacy may execute once this resolves.
 * @throws ServiceUnavailableError when the service refuses the window (503) or cannot be reached.
 */
export async function openWindowViaService(ctx: WindowCallContext, input: OpenWindowInput): Promise<WindowOpenResponse> {
  // The contract requires a request id and has no `kind`; the active request's id, else a fresh one, is also the X-Request-Id.
  const requestId = currentRequestContext()?.requestId ?? randomUUID();
  const body = {
    routeKey: input.routeKey ?? STARTUP_ROUTE_KEY,
    units: input.units,
    scope: input.scope ?? { table: true },
    requestId,
  } satisfies WindowOpenRequest;
  return post<WindowOpenResponse>(ctx, OPERATIONS.open, OPERATIONS.open.path, body, {
    headers: { [REQUEST_ID_HEADER]: requestId },
    timeoutMs: ctx.config.windows.openBudgetMs + SERVICE_CALL_TIMEOUT_MS,
  });
}

/** Reports the legacy outcome of an open window; the service imports legacy changes and closes it, or leaves it import-pending. */
export async function completeWindowViaService(
  ctx: WindowCallContext,
  windowId: string,
  input: CompleteWindowInput,
): Promise<WindowCompleteResponse> {
  const body = { forwarded: input.forwarded } satisfies WindowCompleteRequest;
  return post<WindowCompleteResponse>(ctx, OPERATIONS.complete, windowPath(OPERATIONS.complete, windowId), body);
}

/** Imports and closes an import-pending window on the operator's evidence that its legacy request can no longer commit. */
export async function resolveWindowViaService(ctx: WindowCallContext, windowId: string): Promise<WriteWindow> {
  return post<WriteWindow>(ctx, OPERATIONS.resolve, windowPath(OPERATIONS.resolve, windowId));
}
