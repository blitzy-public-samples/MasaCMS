// Sends a forward's request target as the client sent it, in place of the path reply-from resolves from its source URL.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Dispatcher } from '@opt2/platform/service-kit';

/** The target of the forward running under it, until that forward's dispatch takes it. */
interface PendingTarget {
  target: string | undefined;
}

const pendingTarget = new AsyncLocalStorage<PendingTarget>();

/** Gives the first request dispatched under {@link withRequestTarget} its target as the path; requests outside one pass untouched. */
export const sendRequestTarget: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (options, handler) => {
  const pending = pendingTarget.getStore();
  const target = pending?.target;
  if (pending === undefined || target === undefined) return dispatch(options, handler);
  pending.target = undefined;
  return dispatch({ ...options, path: target }, handler);
};

/**
 * Runs `forward` so the request it dispatches synchronously through an agent composed with {@link sendRequestTarget}
 * carries `target`, path and query byte for byte, never resolved or normalised.
 */
export function withRequestTarget<T>(target: string, forward: () => T): T {
  return pendingTarget.run({ target }, forward);
}
