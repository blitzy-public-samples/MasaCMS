// `opt2-migrate transition` client: asks the running migration service for a transition as `platform.operator` and waits for its outcome.
import { setTimeout as delay } from 'node:timers/promises';

import { ServiceUnavailableError } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import type { components, operations, paths } from '../generated/openapi.js';

type Schemas = components['schemas'];

/** Body of `transitionStart`. */
export type TransitionStartRequest = Schemas['TransitionStartRequest'];
/** A transition as the service reports it. */
export type Transition = Schemas['Transition'];
/** State of a transition as the service reports it. */
export type TransitionStatus = Transition['state'];

/** Contract states after which a transition no longer changes; a failed transition is reported as `aborted`, the contract has no `failed`. */
export const TERMINAL_STATUSES = Object.freeze(['completed', 'aborted'] as const satisfies readonly TransitionStatus[]);

/** Callee name of the migration service in the service client's URL map. */
const MIGRATION_SERVICE = 'migration';

const HTTP_UNAVAILABLE = 503;

/** Options of {@link requestTransition}: the target version, the wait between reads, and an optional replacement timer. */
export interface RequestTransitionOptions {
  /** Cut-over version to activate, for example `v0002`. */
  to: string;
  /** Wait between two reads of a running transition. */
  pollMs: number;
  /** Replaces the timer, for example in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The context part these calls need: the per-caller service client. */
type TransitionCallContext = Pick<MigrationContext, 'clientAs'>;

interface TransitionOperation {
  readonly operationId: keyof operations;
  readonly method: 'GET' | 'POST';
  readonly path: keyof paths;
}

const OPERATIONS = Object.freeze({
  start: { operationId: 'transitionStart', method: 'POST', path: '/internal/v1/transitions' },
  get: { operationId: 'transitionGet', method: 'GET', path: '/internal/v1/transitions/{transitionId}' },
} as const satisfies Record<string, TransitionOperation>);

/** The migration service answered a transition operation outside 2xx and other than 503; `body` is its answer unchanged. */
export class TransitionCallError extends Error {
  override readonly name: string = 'TransitionCallError';

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

/** The operation's path with its `{transitionId}` segment filled. */
function transitionPath(operation: TransitionOperation, transitionId: string): string {
  return operation.path.replace('{transitionId}', encodeURIComponent(transitionId));
}

/** Sends one call as `operator` without a user token; a 503 throws the legacy 503 error, any other non-2xx {@link TransitionCallError}. */
async function call<T>(ctx: TransitionCallContext, operation: TransitionOperation, path: string, json?: unknown): Promise<T> {
  const response = await ctx
    .clientAs('operator')
    .request<T>({ service: MIGRATION_SERVICE, method: operation.method, path, json, userToken: null });
  if (response.status === HTTP_UNAVAILABLE) {
    const cause = Object.assign(new Error(`${MIGRATION_SERVICE} answered HTTP ${String(HTTP_UNAVAILABLE)}`), {
      code: `HTTP_${String(HTTP_UNAVAILABLE)}`,
    });
    throw new ServiceUnavailableError(MIGRATION_SERVICE, cause);
  }
  if (response.status < 200 || response.status > 299) {
    throw new TransitionCallError(operation.operationId, response.status, response.body);
  }
  return response.body;
}

function isTerminal(state: TransitionStatus): boolean {
  return (TERMINAL_STATUSES as readonly TransitionStatus[]).includes(state);
}

/**
 * Starts the transition to `to` in the running migration service and reads it every `pollMs` until it completes or aborts.
 * @returns The transition in its terminal state.
 * @throws TransitionCallError on a non-2xx answer other than 503, for example 409 while another transition runs.
 * @throws ServiceUnavailableError when the service answers 503 or cannot be reached.
 */
export async function requestTransition(
  ctx: TransitionCallContext,
  { to, pollMs, sleep = (ms) => delay(ms) }: RequestTransitionOptions,
): Promise<Transition> {
  const body = { toVersion: to } satisfies TransitionStartRequest;
  let transition = await call<Transition>(ctx, OPERATIONS.start, OPERATIONS.start.path, body);
  while (!isTerminal(transition.state)) {
    await sleep(pollMs);
    transition = await call<Transition>(ctx, OPERATIONS.get, transitionPath(OPERATIONS.get, transition.transitionId));
  }
  return transition;
}
