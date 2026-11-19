// A route's answer when legacy's SQL Server would fail its write: the JSON API's 500 naming the failed query.
import type { FastifyReply } from 'fastify';
import { LegacyQueryFault, queryFaultResponse } from '../legacy-compat/index.js';
import { sendLegacyResponse } from './create-service.js';

/** `run`'s answer, or the 500 naming the failed query when legacy's SQL Server fails the write. */
export async function answeringQueryFault<T, R extends FastifyReply>(reply: R, run: () => Promise<T>): Promise<T | R> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof LegacyQueryFault)) throw err;
    sendLegacyResponse(reply, queryFaultResponse(err));
    return reply;
  }
}
