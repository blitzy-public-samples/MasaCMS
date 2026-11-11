// Identity's client for the gateway relay that writes consumed CSRF tokens into the mapped legacy session's ledger.
import { formatSerializerDate } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';

/** Callee key of the gateway in `OPT2_SERVICE_URLS`. */
export const GATEWAY_SERVICE = 'gateway';

/** A consumed token and the time legacy records against it in `session.mura.csrfusedtokens`. */
export interface LegacyUsedToken {
  token: string;
  usedAt: Date;
}

/** Outcome of a mark-used relay; `applied` is false when no legacy session is mapped to the identity session. */
export interface MarkUsedResult {
  applied: boolean;
}

/** Writes consumed CSRF tokens into the legacy session's used-token ledger through the gateway. */
export interface BridgeRelay {
  /** Marks `tokens` used in the legacy session the gateway maps to identity session `sessionId`. */
  markUsed(sessionId: string, tokens: readonly LegacyUsedToken[]): Promise<MarkUsedResult>;
}

/** Body of the gateway's `legacySessionMarkUsed` operation; `usedAt` is legacy server local time without an offset. */
interface MarkUsedRequestBody {
  tokens: { token: string; usedAt: string }[];
}

const APPLIED_STATUSES: ReadonlySet<number> = new Set([200, 204]);
const NOT_MAPPED_STATUS = 404;
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** Creates the relay over the service's own client (`app.opt2.client`). */
export function createBridgeRelay(client: ServiceClient): BridgeRelay {
  return {
    async markUsed(sessionId, tokens) {
      // The contract requires at least one token, and an empty mark changes no ledger.
      if (tokens.length === 0) return { applied: true };
      const json: MarkUsedRequestBody = {
        tokens: tokens.map((t) => ({ token: t.token, usedAt: formatSerializerDate(t.usedAt) })),
      };
      // userToken stays the client default: the gateway authorises the call by identity's invocation credential.
      const { status } = await client.request({
        service: GATEWAY_SERVICE,
        method: 'POST',
        path: `/internal/v1/legacy-sessions/${encodeURIComponent(sessionId)}:mark-used`,
        json,
      });
      if (APPLIED_STATUSES.has(status)) return { applied: true };
      if (status === NOT_MAPPED_STATUS) return { applied: false };
      if (UNAVAILABLE_STATUSES.has(status)) {
        const answered = new Error(`${GATEWAY_SERVICE} answered HTTP ${status}`);
        throw new ServiceUnavailableError(GATEWAY_SERVICE, Object.assign(answered, { code: `HTTP_${status}` }));
      }
      throw new Error(`${GATEWAY_SERVICE} answered mark-used with unexpected HTTP ${status}`);
    },
  };
}
