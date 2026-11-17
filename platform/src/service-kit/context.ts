import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ServiceIdentity, UserClaims } from '../auth/index.js';
import { SAFE_ERROR_TEXT } from '../logging/safe-error.js';
import { systemClock, type Clock } from './clock.js';

/** Per-request state read by the outbox, events, tasks, migration-kit changelog and the service client. */
export interface RequestContextStore {
  readonly requestId: string;
  readonly startedAt: Date; // from the injected clock
  user?: UserClaims; // verified user-token claims
  userToken?: string; // raw verified bearer token, forwarded by the service client
  service?: ServiceIdentity; // verified calling workload
  tenantId?: string; // verified claims.tid only, never a header or body value
  site?: string; // claims.site (legacy site id)
  readonly writePositions: Map<string, string>; // owner -> commit xid8 as a decimal string
  signal?: AbortSignal; // aborts once the client disconnects; set only for a request that opted in to abandonment
  unpublishedEvents?: string[]; // committed outbox event ids whose in-request flush was incomplete
}

/** The process-wide request context store. */
export const requestContext = new AsyncLocalStorage<RequestContextStore>();

/** Inbound header carrying a caller-chosen request id; read, never echoed. */
export const REQUEST_ID_HEADER = 'x-request-id';

const REQUEST_ID_PATTERN = /^[\x21-\x7e]{1,200}$/;

/** Thrown when code that needs a request context runs outside one. */
export class NoRequestContextError extends Error {
  override readonly name: string = 'NoRequestContextError';

  constructor() {
    super('No request context is active');
  }
}

/** The request's client disconnected before its answer. */
export class RequestAbortedError extends Error {
  override readonly name: string = 'RequestAbortedError';

  constructor() {
    super('The client disconnected before the answer');
  }
}

/** The request committed outbox events whose publish was incomplete, so it is abandoned without an answer and the sweep publishes them. */
export class UnpublishedEventsError extends Error {
  override readonly name: string = 'UnpublishedEventsError';

  constructor(readonly eventIds: readonly string[]) {
    super(`Outbox publish of ${String(eventIds.length)} committed event(s) incomplete before the answer; left to the sweep`);
  }

  /** The message, which names only the event count, for logs and spans. */
  get [SAFE_ERROR_TEXT](): string {
    return this.message;
  }
}

/** Records committed outbox events whose in-request publish was incomplete, withholding the active request's answer; a no-op outside a request. */
export function recordUnpublishedEvents(eventIds: readonly string[]): void {
  const store = requestContext.getStore();
  if (store !== undefined && eventIds.length > 0) (store.unpublishedEvents ??= []).push(...eventIds);
}

/** Throws the active request's abort reason once its signal has aborted; a no-op outside a request or without a signal. */
export function throwIfRequestAborted(): void {
  requestContext.getStore()?.signal?.throwIfAborted();
}

/** Returns the first inbound `x-request-id` when it is 1-200 visible ASCII characters, otherwise a new UUID. */
export function requestIdFrom(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers[REQUEST_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

/** Creates a fresh store stamped by `clock` (default: system clock), with a new UUID when `requestId` is omitted. */
export function newRequestContext({
  requestId,
  clock = systemClock,
}: { requestId?: string; clock?: Clock } = {}): RequestContextStore {
  return {
    requestId: requestId ?? randomUUID(),
    startedAt: clock.now(),
    writePositions: new Map(),
  };
}

/** Runs `fn` with `store` as the active request context and returns its result. */
export function runWithRequestContext<T>(store: RequestContextStore, fn: () => T): T {
  return requestContext.run(store, fn);
}

/** Returns the active request context, or undefined outside a request. */
export function currentRequestContext(): RequestContextStore | undefined {
  return requestContext.getStore();
}

/** Returns the active request context; throws NoRequestContextError outside a request. */
export function requireRequestContext(): RequestContextStore {
  const store = requestContext.getStore();
  if (store === undefined) {
    throw new NoRequestContextError();
  }
  return store;
}

/** Records a committed transaction's xid for `owner`, keeping the highest per owner; throws outside a request. */
export function recordWritePosition(owner: string, xid: string | bigint): void {
  const positions = requireRequestContext().writePositions;
  const next = BigInt(xid);
  const previous = positions.get(owner);
  if (previous === undefined || next > BigInt(previous)) {
    positions.set(owner, next.toString());
  }
}
