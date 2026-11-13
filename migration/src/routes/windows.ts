/** `windowOpen`, `windowGet`, `windowComplete` and `windowResolve`: the write-window lifecycle of the migration service over HTTP. */
import { Roles, serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import {
  LegacyApiError,
  LegacyServiceUnavailableError,
  apiUnavailableResponse,
  buildEnvelope,
  reportedMethod,
  serializeResponse,
} from '@opt2/platform/legacy-compat';
import { sendLegacyResponse, z, type FastifyInstance, type FastifyReply } from '@opt2/platform/service-kit';

import type { components, operations, paths } from '../generated/openapi.js';
import { UnknownUnitError } from '../owners/index.js';
import { WindowNotFoundError, WindowStateError, type WindowService } from '../windows/index.js';

type Schemas = components['schemas'];
type WindowParams = operations['windowGet']['parameters']['path'];

/** The window service the routes call. */
export interface WindowRouteDeps {
  windows: Pick<WindowService, 'open' | 'complete' | 'get' | 'resolve'>;
}

const OPEN_PATH = '/internal/v1/windows' satisfies keyof paths;
const WINDOW_PATH = '/internal/v1/windows/{windowId}' satisfies keyof paths;
const COMPLETE_PATH = '/internal/v1/windows/{windowId}:complete' satisfies keyof paths;
const RESOLVE_PATH = '/internal/v1/windows/{windowId}:resolve' satisfies keyof paths;
const WINDOW_URL = '/internal/v1/windows/:windowId';
// A parameter followed by `:verb` needs a pattern that stops at the colon; without one, find-my-way reads the verb into
// the parameter's name and the two verbs collide. The literal colon is then written `::`.
const COMPLETE_URL = '/internal/v1/windows/:windowId(^[^:/]+)::complete';
const RESOLVE_URL = '/internal/v1/windows/:windowId(^[^:/]+)::resolve';

/** Operations this module registers: contract `path` and Fastify `url`. */
export const WINDOW_ROUTES = Object.freeze([
  Object.freeze({ operationId: 'windowOpen', method: 'POST', path: OPEN_PATH, url: OPEN_PATH } as const),
  Object.freeze({ operationId: 'windowGet', method: 'GET', path: WINDOW_PATH, url: WINDOW_URL } as const),
  Object.freeze({ operationId: 'windowComplete', method: 'POST', path: COMPLETE_PATH, url: COMPLETE_URL } as const),
  Object.freeze({ operationId: 'windowResolve', method: 'POST', path: RESOLVE_PATH, url: RESOLVE_URL } as const),
]);

type WindowOperationId = (typeof WINDOW_ROUTES)[number]['operationId'];

const GATEWAY_OR_OPERATOR = Object.freeze([serviceRole('gateway'), Roles.platformOperator]);

// The contract turns the site check off for windowOpen only: its body names the writers' scope, not a site the caller acts for.
const OPEN_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: GATEWAY_OR_OPERATOR, siteCheck: false });
const WINDOW_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: GATEWAY_OR_OPERATOR });
const RESOLVE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([Roles.platformOperator]) });

// CfId and UnitId as the contract declares them.
const CF_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const UNIT_ID = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

// WindowScope: exactly one of the two strict forms.
const scopeSchema = z.union([
  z.strictObject({ table: z.literal(true) }),
  z.strictObject({ keys: z.record(z.string(), z.string()).refine((keys) => Object.keys(keys).length > 0) }),
]) satisfies z.ZodType<Schemas['WindowScope']>;

const openBodySchema = z.strictObject({
  routeKey: z.string().min(1),
  units: z
    .array(z.string().regex(UNIT_ID))
    .min(1)
    .refine((units) => new Set(units).size === units.length),
  scope: scopeSchema,
  requestId: z.string().min(1),
}) satisfies z.ZodType<Schemas['WindowOpenRequest']>;

const completeBodySchema = z.strictObject({
  forwarded: z.boolean(),
  legacyStatus: z.int().min(100).max(599).optional(),
}) satisfies z.ZodType<Schemas['WindowCompleteRequest']>;

/** The body as `schema` parses it; anything else is the legacy 400. */
function bodyOf<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new LegacyApiError('invalidParameters');
  return parsed.data;
}

/** The path's window id. @throws WindowNotFoundError for an id that is not a CF UUID, which names no window */
function windowIdOf(params: WindowParams): string {
  if (!CF_ID.test(params.windowId)) throw new WindowNotFoundError(params.windowId);
  return params.windowId;
}

/** Answers an unknown window (404) or a state that refuses the action (409) with the legacy error envelope. */
function sendWindowError(reply: FastifyReply, operationId: WindowOperationId, error: WindowNotFoundError | WindowStateError): FastifyReply {
  const envelope = buildEnvelope({ method: reportedMethod(operationId), error: { message: error.message, code: 'invalid_request' } });
  return sendLegacyResponse(reply, serializeResponse(envelope, { statusCode: error.statusCode }));
}

/** Registers the four window operations; all window logic, budgets and leases stay in the window service. */
export function registerWindowRoutes(app: FastifyInstance, deps: WindowRouteDeps): void {
  const { windows } = deps;

  app.post<{ Body: unknown }>(OPEN_PATH, { config: { opt2: OPEN_AUTH } }, async (request, reply) => {
    const body = bodyOf(openBodySchema, request.body);
    try {
      const opened: Schemas['WindowOpenResponse'] = await windows.open(body);
      reply.code(201);
      return opened;
    } catch (error) {
      if (error instanceof UnknownUnitError) throw new LegacyApiError('invalidParameters');
      // A refused open gave back everything it took; the gateway relays this 503 before legacy executes anything.
      if (error instanceof LegacyServiceUnavailableError) return sendLegacyResponse(reply, apiUnavailableResponse({ method: 'windowOpen' }));
      throw error;
    }
  });

  app.get<{ Params: WindowParams }>(WINDOW_URL, { config: { opt2: WINDOW_AUTH } }, async (request, reply) => {
    try {
      return await windows.get(windowIdOf(request.params));
    } catch (error) {
      if (error instanceof WindowNotFoundError) return sendWindowError(reply, 'windowGet', error);
      throw error;
    }
  });

  app.post<{ Params: WindowParams; Body: unknown }>(COMPLETE_URL, { config: { opt2: WINDOW_AUTH } }, async (request) => {
    const body = bodyOf(completeBodySchema, request.body);
    try {
      return await windows.complete(windowIdOf(request.params), body);
    } catch (error) {
      // The contract answers an id that names no window with `unknown`, not 404.
      if (error instanceof WindowNotFoundError) return { state: 'unknown' } satisfies Schemas['WindowCompleteResponse'];
      throw error;
    }
  });

  app.post<{ Params: WindowParams }>(RESOLVE_URL, { config: { opt2: RESOLVE_AUTH } }, async (request, reply) => {
    try {
      // The actor is the verified operator workload, recorded with the operator's evidence.
      return await windows.resolve(windowIdOf(request.params), { actor: request.opt2Auth.service?.name });
    } catch (error) {
      if (error instanceof WindowNotFoundError || error instanceof WindowStateError) return sendWindowError(reply, 'windowResolve', error);
      throw error;
    }
  });
}
