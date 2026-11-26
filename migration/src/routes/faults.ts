/** `faultSet` and `faultClear`: arm and disarm the migration service's in-process replay faults. */
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, buildEnvelope, reportedMethod, serializeResponse } from '@opt2/platform/legacy-compat';
import { sendLegacyResponse, z, type FastifyInstance, type FastifyReply } from '@opt2/platform/service-kit';

import { FaultParamsError, UnknownFaultError, type FaultRegistry } from '../faults/index.js';
import type { components, operations, paths } from '../generated/openapi.js';

type FaultPathParams = operations['faultSet']['parameters']['path'];

/** The fault registry the routes arm and disarm; both operations answer 204, so they never read the armed list. */
export interface FaultRouteDeps {
  faults: Pick<FaultRegistry, 'set' | 'clear'>;
}

const FAULT_PATH = '/internal/v1/faults/{name}' satisfies keyof paths;
const FAULT_URL = '/internal/v1/faults/:name';

/** Operations this module registers: contract `path` and Fastify `url`. */
export const FAULT_ROUTES = Object.freeze([
  Object.freeze({ operationId: 'faultSet', method: 'PUT', path: FAULT_PATH, url: FAULT_URL } as const),
  Object.freeze({ operationId: 'faultClear', method: 'DELETE', path: FAULT_PATH, url: FAULT_URL } as const),
]);

type FaultOperationId = (typeof FAULT_ROUTES)[number]['operationId'];

// Only the operator workload's invocation credential opens these routes; no client of the gateway can reach them.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.platformOperator]),
});

// FaultRequest: `params` is required and open, since each fault's own schema in the registry judges its keys.
const setBodySchema = z.strictObject({ params: z.looseObject({}) }) satisfies z.ZodType<components['schemas']['FaultRequest']>;

/** Answers a name the registry does not know with the legacy error envelope at 404. */
function sendUnknownFault(reply: FastifyReply, operationId: FaultOperationId, error: UnknownFaultError): FastifyReply {
  const envelope = buildEnvelope({ method: reportedMethod(operationId), error: { message: error.message, code: 'invalid_request' } });
  return sendLegacyResponse(reply, serializeResponse(envelope, { statusCode: error.statusCode }));
}

/** Registers both fault operations; fault names, parameters and where a fault may be armed stay with the registry. */
export function registerFaultRoutes(app: FastifyInstance, deps: FaultRouteDeps): void {
  app.put<{ Params: FaultPathParams; Body: unknown }>(FAULT_URL, { config: { opt2: ROUTE_AUTH } }, (request, reply) => {
    const body = setBodySchema.safeParse(request.body);
    if (!body.success) throw new LegacyApiError('invalidParameters');
    try {
      deps.faults.set(request.params.name, body.data.params);
    } catch (error) {
      if (error instanceof UnknownFaultError) return sendUnknownFault(reply, 'faultSet', error);
      // Also a fault the registry refuses to arm in this environment, which the contract answers as malformed.
      if (error instanceof FaultParamsError) throw new LegacyApiError('invalidParameters');
      throw error;
    }
    return reply.code(204).send();
  });

  app.delete<{ Params: FaultPathParams }>(FAULT_URL, { config: { opt2: ROUTE_AUTH } }, (request, reply) => {
    try {
      // Disarming a fault that is not armed is still 204: the caller only needs it disarmed afterwards.
      deps.faults.clear(request.params.name);
    } catch (error) {
      if (error instanceof UnknownFaultError) return sendUnknownFault(reply, 'faultClear', error);
      throw error;
    }
    return reply.code(204).send();
  });
}
