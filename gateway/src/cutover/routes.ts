// Internal cut-over endpoints of the gateway contract: activate, freeze, unfreeze, status and evidence-backed orphan clearing.
import { AuthDenial, Roles, type Opt2AuthContext } from '@opt2/platform/auth';
import type { FastifyInstance, FastifyReply } from '@opt2/platform/service-kit';
import type { components } from '../generated/openapi.js';
import type { InflightStore } from './inflight.js';
import { ActivationRejected, CutoverConflict, type CutoverState, type CutoverStatus } from './state.js';

type CutoverActivateRequest = components['schemas']['CutoverActivateRequest'];
type CutoverRoutesRequest = components['schemas']['CutoverRoutesRequest'];
type InflightClearRequest = components['schemas']['InflightClearRequest'];
type InflightClearResponse = components['schemas']['InflightClearResponse'];

/** Stores the cut-over routes act on: the instance's cut-over state and the in-flight write registry. */
export interface CutoverRouteDeps {
  state: CutoverState;
  inflight: InflightStore;
}

const OPERATOR = [Roles.platformOperator];
const OPERATOR_OR_MIGRATION = [Roles.platformOperator, Roles.platformMigration];

const TABLE_VERSION_PATTERN = '^v[0-9]{4}$';
const ROUTE_KEY_PATTERN = '^[a-z0-9-]+:\\S+$';
const TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$';
const UNIT_PATTERN = '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$';

// Request bodies as the contract components declare them; Fastify validates them once, before the handler.
const ACTIVATE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['tableVersion'],
  properties: { tableVersion: { type: 'string', pattern: TABLE_VERSION_PATTERN } },
} as const;

const ROUTES_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['routes'],
  properties: {
    routes: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: ROUTE_KEY_PATTERN } },
  },
} as const;

// The allOf pairs each side with the only evidence kind that can clear it, so a mismatch fails validation with the
// contract's 400 before the store's own evidence check could raise.
const CLEAR_ORPHANS_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['side', 'evidence'],
  properties: {
    side: { type: 'string', enum: ['legacy', 'target'] },
    evidence: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'holderId', 'at'],
      properties: {
        kind: { type: 'string', enum: ['legacy-restart', 'gates-closed'] },
        holderId: { type: 'string', minLength: 1 },
        at: { type: 'string', pattern: TIMESTAMP_PATTERN },
        units: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: UNIT_PATTERN } },
      },
    },
    instanceIds: { type: 'array', uniqueItems: true, items: { type: 'string' } },
  },
  allOf: [
    {
      if: { required: ['side'], properties: { side: { const: 'target' } } },
      then: {
        properties: {
          evidence: { type: 'object', required: ['units'], properties: { kind: { const: 'gates-closed' }, units: { type: 'array' } } },
        },
      },
    },
    {
      if: { required: ['side'], properties: { side: { const: 'legacy' } } },
      then: { properties: { evidence: { type: 'object', properties: { kind: { const: 'legacy-restart' } } } } },
    },
  ],
} as const;

/** The verified caller recorded as `activated_by` / `frozen_by`: the calling service, else the user. */
function actorOf(auth: Opt2AuthContext): string {
  const actor = auth.service?.name ?? auth.user?.sub;
  if (actor === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return actor;
}

/** Answers a refused cut-over operation with its `ValidationFindings`: 400 for findings, 409 for a conflict; rethrows anything else. */
function sendFindings(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ActivationRejected) return reply.code(400).send({ findings: error.findings });
  if (error instanceof CutoverConflict) return reply.code(409).send({ findings: error.findings });
  throw error;
}

/** Registers `cutoverActivate`, `cutoverFreeze`, `cutoverUnfreeze`, `cutoverStatus` and `inflightClearOrphans` of the gateway contract. */
export async function registerCutoverRoutes(app: FastifyInstance, { state, inflight }: CutoverRouteDeps): Promise<void> {
  app.post<{ Body: CutoverActivateRequest }>(
    '/internal/v1/cutover/activate',
    { schema: { body: ACTIVATE_BODY }, config: { opt2: { transport: 'service', requires: OPERATOR } } },
    async (request, reply) => {
      const actor = actorOf(request.opt2Auth);
      try {
        return await state.activate({ tableVersion: request.body.tableVersion, actor });
      } catch (error) {
        return sendFindings(reply, error);
      }
    },
  );

  const freezeRoute = (url: string, change: CutoverState['freeze']): void => {
    app.post<{ Body: CutoverRoutesRequest }>(
      url,
      { schema: { body: ROUTES_BODY }, config: { opt2: { transport: 'service', requires: OPERATOR } } },
      async (request, reply) => {
        const actor = actorOf(request.opt2Auth);
        try {
          return await change(request.body.routes, actor);
        } catch (error) {
          return sendFindings(reply, error);
        }
      },
    );
  };
  freezeRoute('/internal/v1/cutover/freeze', (routes, actor) => state.freeze(routes, actor));
  freezeRoute('/internal/v1/cutover/unfreeze', (routes, actor) => state.unfreeze(routes, actor));

  // The contract declares no HEAD operation, so Fastify's automatic HEAD sibling is not registered.
  app.get(
    '/internal/v1/cutover/status',
    { exposeHeadRoute: false, config: { opt2: { transport: 'service', requires: OPERATOR_OR_MIGRATION } } },
    async (): Promise<CutoverStatus> => state.status(),
  );

  // `::` is the router's literal colon, so the contract's `inflight:clear-orphans` is not read as a path parameter.
  app.post<{ Body: InflightClearRequest }>(
    '/internal/v1/inflight::clear-orphans',
    { schema: { body: CLEAR_ORPHANS_BODY }, config: { opt2: { transport: 'service', requires: OPERATOR_OR_MIGRATION } } },
    async (request): Promise<InflightClearResponse> => {
      const actor = actorOf(request.opt2Auth);
      // The store's `routes` narrowing is in-process only; the contract body carries no routes.
      const { side, evidence, instanceIds } = request.body;
      const { cleared } = await inflight.clearOrphans({ side, evidence, instanceIds });
      // The platform logger keeps only log-record.v1 fields, so the cleanup context is in the message.
      const units = evidence.units === undefined ? '' : ` units=${JSON.stringify(evidence.units)}`;
      const instances = instanceIds === undefined ? '' : ` instances=${JSON.stringify(instanceIds)}`;
      request.log.info(
        `in-flight orphans cleared: count=${cleared} side=${side} evidence=${evidence.kind} holder=${evidence.holderId}` +
          `${units}${instances} actor=${actor}`,
      );
      return { cleared };
    },
  );
}
