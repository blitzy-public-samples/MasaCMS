// Dispatches a reply-from forward so its undici client span is named after the callee, and only that span.
import { AsyncResource } from 'node:async_hooks';
import type { FastifyReplyFromHooks } from '@fastify/reply-from';
import type { FastifyReply } from '@opt2/platform/service-kit';
import { withCallee } from '@opt2/platform/tracing';

/** Callee name of every legacy-bound forward. */
export const LEGACY_CALLEE = 'legacy';

/**
 * Calls `reply.from(source, options)` under `callee`, so the client span undici starts is named `<METHOD> <callee>`.
 * The hooks reply-from calls after dispatch run in the caller's context, so calls they make are not named after `callee`.
 */
export function replyFromCallee(
  reply: FastifyReply,
  callee: string,
  source: string,
  options: FastifyReplyFromHooks,
): FastifyReply {
  const { retryDelay, onResponse, onError, rewriteHeaders } = options;
  const bound: FastifyReplyFromHooks = {
    ...options,
    ...(retryDelay === undefined ? {} : { retryDelay: AsyncResource.bind(retryDelay) }),
    ...(onResponse === undefined ? {} : { onResponse: AsyncResource.bind(onResponse) }),
    ...(onError === undefined ? {} : { onError: AsyncResource.bind(onError) }),
    ...(rewriteHeaders === undefined ? {} : { rewriteHeaders: AsyncResource.bind(rewriteHeaders) }),
  };
  return withCallee(callee, () => reply.from(source, bound));
}
