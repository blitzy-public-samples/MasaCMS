// Route auth declarations, deny-by-default Fastify hooks and legacy-shaped denial responses of @opt2/platform/auth.
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { legacyErrorResponse, type SerializedLegacyResponse } from '../legacy-compat/index.js';
import { AuthDenial, TRANSPORTS, type Opt2AuthContext, type Transport } from './claims.js';
import { hasAnyRole, isServiceRole } from './roles.js';
import { transportForPath, type AuthRequest, type TransportSet } from './transports.js';
import { assertSiteMatches } from './user-token.js';

/** Auth declaration every route carries as `config.opt2`: exactly one of `requires` and `public`. */
export interface Opt2RouteConfig {
  /** Roles of which the verified identities must hold at least one. */
  requires?: readonly string[];
  public?: true;
  /** Authentication scheme the route accepts; defaults to `service`. */
  transport?: Transport;
  /** `false` when the handler calls `assertSiteMatches` itself; defaults to `true`. */
  siteCheck?: boolean;
  /** Gateway client-facing proxy route: public on the `service` transport, its legacy credentials left unparsed. */
  edge?: true;
  /** Renders this route's denials in place of the instance renderer, e.g. in a legacy fixture's own error envelope. */
  renderDenial?: DenialRenderer;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    opt2?: Opt2RouteConfig;
  }
  interface FastifyRequest {
    opt2Auth: Opt2AuthContext;
  }
}

/** Status, headers and exact body a denial is answered with. */
export type DenialResponse = SerializedLegacyResponse;

/** Renders a denial as the response it is answered with; a rejection passes to the route's error handler. */
export type DenialRenderer = (denial: AuthDenial, request: FastifyRequest) => DenialResponse | Promise<DenialResponse>;

/** One route registration, per method, as validated at start-up. */
export interface RecordedRoute {
  method: string;
  url: string;
  config: Opt2RouteConfig;
}

/** Options of `registerAuth`. */
export interface RegisterAuthOptions {
  transports: TransportSet;
  /** Renders a denial of a route that declares no `renderDenial`; defaults to `renderAuthDenial`. */
  renderDenial?: DenialRenderer;
}

/** A route registered without a valid `config.opt2` declaration; fails start-up. */
export class UndeclaredRouteError extends Error {
  override readonly name: string = 'UndeclaredRouteError';

  constructor(
    readonly method: string,
    readonly url: string,
    problem: string,
  ) {
    super(`${method} ${url}: ${problem}`);
  }
}

const ROUTE_STORE = Symbol('opt2.auth.routes');

/** Checks one route's declaration against its path and returns it with the transport defaulted. */
export function validateRouteConfig(
  method: string,
  url: string,
  config: Opt2RouteConfig | undefined,
): Required<Pick<Opt2RouteConfig, 'transport'>> & Opt2RouteConfig {
  const undeclared = (problem: string): UndeclaredRouteError => new UndeclaredRouteError(method, url, problem);
  if (config === undefined || config === null) {
    throw undeclared('no config.opt2 declaration');
  }
  const isPublic = config.public === true;
  const { requires } = config;
  if (requires === undefined && !isPublic) {
    throw undeclared('declares neither config.opt2.requires nor config.opt2.public');
  }
  if (requires !== undefined && isPublic) {
    throw undeclared('declares both config.opt2.requires and config.opt2.public');
  }
  if (requires !== undefined && !(Array.isArray(requires) && requires.length > 0 && requires.every(isString))) {
    throw undeclared('config.opt2.requires must be a non-empty array of role strings');
  }
  const transport = config.transport ?? 'service';
  if (!TRANSPORTS.includes(transport)) {
    throw undeclared(`unknown transport ${JSON.stringify(transport)}`);
  }
  const expected = transportForPath(url);
  if (transport !== expected) {
    throw undeclared(`must declare the ${expected} transport, not ${transport}`);
  }
  if (transport !== 'service' && isPublic) {
    throw undeclared(`a ${transport} route cannot be public`);
  }
  if (config.edge === true && !(isPublic && transport === 'service')) {
    throw undeclared('an edge route must be public on the service transport');
  }
  return { ...config, transport };
}

/** Installs route validation, per-transport authentication and the `siteid` check on the root instance, before any route. */
export function registerAuth(app: FastifyInstance, opts: RegisterAuthOptions): void {
  const render = opts.renderDenial ?? renderAuthDenial;
  const routes: RecordedRoute[] = [];
  const deny = async (err: unknown, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (err instanceof AuthDenial) {
      const routeRender = request.routeOptions.config.opt2?.renderDenial;
      return sendDenial(reply, await (routeRender ?? render)(err, request));
    }
    throw err;
  };

  app.decorateRequest('opt2Auth', null, []);
  app.decorate(ROUTE_STORE, routes);

  app.addHook('onRoute', (route) => {
    for (const method of methodsOf(route.method)) {
      routes.push({ method, url: route.url, config: validateRouteConfig(method, route.url, route.config?.opt2) });
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.is404) {
      return;
    }
    try {
      const config = request.routeOptions.config.opt2;
      // Routes added before registerAuth bypassed onRoute validation.
      if (config === undefined) {
        throw AuthDenial.forbidden('undeclared-route');
      }
      if (config.edge === true) {
        request.opt2Auth = { roles: [], transport: 'service' };
        return;
      }
      const transport = config.transport ?? 'service';
      const { user, userToken, service } = await opts.transports[transport].authenticate(requestToAuthRequest(request), {
        optional: config.public === true,
      });
      const roles = [...new Set([...(user?.roles ?? []), ...(service?.roles ?? [])])];
      request.opt2Auth = { user, userToken, service, roles, transport };
      if (config.requires !== undefined && !hasAnyRole(roles, config.requires)) {
        throw user === undefined && config.requires.some((role) => !isServiceRole(role))
          ? AuthDenial.unauthenticated('missing-credential')
          : AuthDenial.forbidden();
      }
    } catch (err) {
      return deny(err, request, reply);
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (request.is404) {
      return;
    }
    const config = request.routeOptions.config.opt2;
    const { user, transport } = request.opt2Auth;
    if (config === undefined || config.edge === true || config.siteCheck === false || !user || transport !== 'service') {
      return;
    }
    try {
      for (const siteid of suppliedSiteIds(request)) {
        assertSiteMatches(siteid, user);
      }
    } catch (err) {
      return deny(err, request, reply);
    }
  });
}

/** Routes `registerAuth` validated on this instance, one entry per method; throws when it was not applied. */
export function recordedRoutes(app: FastifyInstance): ReadonlyArray<RecordedRoute> {
  if (!app.hasDecorator(ROUTE_STORE)) {
    throw new Error('registerAuth was not applied to this Fastify instance');
  }
  return app.getDecorator<RecordedRoute[]>(ROUTE_STORE);
}

/** Framework-neutral view of a Fastify request for the transport authenticators. */
export function requestToAuthRequest(request: FastifyRequest): AuthRequest {
  return {
    headers: request.headers,
    query: request.query as Record<string, unknown>,
    path: request.url.split('?')[0] ?? '',
  };
}

/** Legacy JSON API error response for a denial, at the denial's own 401 or 403 status. */
export function renderAuthDenial(denial: AuthDenial, request: FastifyRequest): DenialResponse {
  const query = isRecord(request.query) ? request.query : {};
  // legacyErrorResponse reports the method as legacy does ('invalid' when undefined) and drops it from params.
  const response = legacyErrorResponse(denial.type, {
    method: valuesNoCase(query, 'method').at(-1),
    params: { ...query },
    wwwAuthenticate: denial.wwwAuthenticate,
  });
  return { ...response, status: denial.statusCode };
}

function sendDenial(reply: FastifyReply, response: DenialResponse): FastifyReply {
  return reply.code(response.status).headers(response.headers).send(response.body);
}

function methodsOf(method: RouteOptions['method']): string[] {
  return Array.isArray(method) ? [...method] : [method];
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A plain key-value object, including fast-querystring's null-rooted dictionaries; never arrays, buffers or streams. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || Object.getPrototypeOf(proto) === null;
}

/** Every `siteid` the request supplies, in legacy merge order: route params, query, then a parsed plain-object body. */
function suppliedSiteIds(request: FastifyRequest): string[] {
  const body = isPlainObject(request.body) ? request.body : undefined;
  return [request.params, request.query, body].flatMap((source) => valuesNoCase(source, 'siteid'));
}

/** Values stored under `key` ignoring case, as a CFML scope reads them. */
function valuesNoCase(source: unknown, key: string): string[] {
  if (!isRecord(source)) {
    return [];
  }
  return Object.entries(source).flatMap(([name, value]) =>
    name.toLowerCase() === key && value !== undefined && value !== null ? [scopeValue(value)] : [],
  );
}

/** One parameter as a CFML scope holds it: repeated keys joined with `,`, multipart fields by their value. */
function scopeValue(value: unknown): string {
  const fieldValue = (item: unknown): unknown => (isPlainObject(item) && item.type === 'field' ? item.value : item);
  return Array.isArray(value) ? value.map(fieldValue).join(',') : String(fieldValue(value));
}
