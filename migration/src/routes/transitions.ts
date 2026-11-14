/** `transitionStart` and `transitionGet`: cut-over transitions of the migration service over HTTP. */
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, buildEnvelope, reportedMethod, serializeResponse } from '@opt2/platform/legacy-compat';
import { sendLegacyResponse, z, type FastifyInstance, type FastifyReply } from '@opt2/platform/service-kit';

import type { components, operations, paths } from '../generated/openapi.js';
import {
  TransitionInProgressError,
  TransitionNotFoundError,
  TransitionPreconditionError,
  type TransitionService,
} from '../transition/index.js';

type Schemas = components['schemas'];
type TransitionParams = operations['transitionGet']['parameters']['path'];

/** The transition service the routes call. */
export interface TransitionRouteDeps {
  transitions: Pick<TransitionService, 'start' | 'get'>;
}

const START_PATH = '/internal/v1/transitions' satisfies keyof paths;
const TRANSITION_PATH = '/internal/v1/transitions/{transitionId}' satisfies keyof paths;
const TRANSITION_URL = '/internal/v1/transitions/:transitionId';

/** Operations this module registers: contract `path` and Fastify `url`. */
export const TRANSITION_ROUTES = Object.freeze([
  Object.freeze({ operationId: 'transitionStart', method: 'POST', path: START_PATH, url: START_PATH } as const),
  Object.freeze({ operationId: 'transitionGet', method: 'GET', path: TRANSITION_PATH, url: TRANSITION_URL } as const),
]);

type TransitionOperationId = (typeof TRANSITION_ROUTES)[number]['operationId'];

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.platformOperator]),
});

// CfId and VersionId as the contract declares them.
const CF_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const VERSION_ID = /^v[0-9]{4}$/;

const startBodySchema = z.strictObject({
  toVersion: z.string().regex(VERSION_ID),
}) satisfies z.ZodType<Schemas['TransitionStartRequest']>;

/** The path's transition id. @throws TransitionNotFoundError for an id that is not a CF UUID, which names no transition */
function transitionIdOf(params: TransitionParams): string {
  // The contract declares no 400 for `transitionGet`, so a malformed id is answered as unknown.
  if (!CF_ID.test(params.transitionId)) throw new TransitionNotFoundError(params.transitionId);
  return params.transitionId;
}

/** Answers an unknown transition (404) or a transition that may not start (409) with the legacy error envelope. */
function sendTransitionError(
  reply: FastifyReply,
  operationId: TransitionOperationId,
  error: TransitionInProgressError | TransitionNotFoundError | TransitionPreconditionError,
): FastifyReply {
  const envelope = buildEnvelope({ method: reportedMethod(operationId), error: { message: error.message, code: 'invalid_request' } });
  return sendLegacyResponse(reply, serializeResponse(envelope, { statusCode: error.statusCode }));
}

/** Registers both transition operations; leases, freezes, gates and activation stay in the transition service. */
export function registerTransitionRoutes(app: FastifyInstance, deps: TransitionRouteDeps): void {
  const { transitions } = deps;

  app.post<{ Body: unknown }>(START_PATH, { config: { opt2: ROUTE_AUTH } }, async (request, reply) => {
    const body = startBodySchema.safeParse(request.body);
    if (!body.success) throw new LegacyApiError('invalidParameters');
    try {
      // The service records the transition and drives its steps in the background; the answer never waits for them.
      const started: Schemas['Transition'] = await transitions.start({
        to: body.data.toVersion,
        requestedBy: request.opt2Auth.service?.name,
      });
      reply.code(202);
      return started;
    } catch (error) {
      if (error instanceof TransitionInProgressError || error instanceof TransitionPreconditionError) {
        return sendTransitionError(reply, 'transitionStart', error);
      }
      throw error;
    }
  });

  app.get<{ Params: TransitionParams }>(TRANSITION_URL, { config: { opt2: ROUTE_AUTH } }, async (request, reply) => {
    try {
      return await transitions.get(transitionIdOf(request.params));
    } catch (error) {
      if (error instanceof TransitionNotFoundError) return sendTransitionError(reply, 'transitionGet', error);
      throw error;
    }
  });
}
