// Internal route through which identity writes consumed CSRF tokens into the mapped legacy session's used-token ledger.
import { serviceRole } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import type { components, operations } from '../generated/openapi.js';
import type { BridgeClient } from './bridge-client.js';
import { legacyCookieHeader, type LegacyJar } from './jar.js';

type MarkUsedRequest = components['schemas']['MarkUsedRequest'];
type MarkUsedParams = operations['legacySessionMarkUsed']['parameters']['path'];

/** Stores the route reads: the gateway's own jar and the signed bridge client. */
export interface MarkUsedRouteDeps {
  jar: LegacyJar;
  bridge: BridgeClient;
}

// The router ends a parameter name only at `(`, `-`, `.` or `/`, so `:sid::mark-used` would declare `sid::mark`;
// the `(.+)` pattern ends the name at `sid` and `::` is the literal colon of the contract's `{sid}:mark-used`.
const MARK_USED_URL = '/internal/v1/legacy-sessions/:sid(.+)::mark-used';

const PARAMS_SCHEMA = {
  type: 'object',
  required: ['sid'],
  properties: { sid: { type: 'string', minLength: 1, maxLength: 255 } },
} as const;

const BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tokens'],
  properties: {
    tokens: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['token', 'usedAt'],
        properties: {
          token: { type: 'string', pattern: '^[0-9A-Fa-f]{64}$' },
          usedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?$' },
        },
      },
    },
  },
} as const;

/** Registers `POST /internal/v1/legacy-sessions/{sid}:mark-used` (`legacySessionMarkUsed`), callable by identity only. */
export async function registerMarkUsedRoute(app: FastifyInstance, deps: MarkUsedRouteDeps): Promise<void> {
  app.post<{ Params: MarkUsedParams; Body: MarkUsedRequest }>(
    MARK_USED_URL,
    {
      schema: { params: PARAMS_SCHEMA, body: BODY_SCHEMA },
      config: { opt2: { transport: 'service', requires: [serviceRole('identity')] } },
    },
    async (request, reply) => {
      const row = await deps.jar.get(request.params.sid);
      // The bridge addresses a session by its ColdFusion id and live cookies; a jar lacking either maps no session.
      // service-kit's not-found handler answers the legacy JSON API 404.
      if (row === undefined || row.legacySessionId === null || legacyCookieHeader(row.cookies) === '') {
        return reply.callNotFound();
      }
      // Every bridge failure, a session mismatch included, propagates as the legacy 503 (fail closed): reporting it
      // as unmapped could leave the token unmarked in a live legacy session.
      await deps.bridge.markUsed(row.cookies, request.body.tokens, { legacySessionId: row.legacySessionId });
      return reply.code(204).send();
    },
  );
}
