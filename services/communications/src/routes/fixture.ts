// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture routes `communications/…` of legacy-fixtures/cfml/api.cfm, answered as legacy-fixtures/cfml/modules/communications.cfc answers them. */
import type { Opt2RouteConfig, UserClaims } from '@opt2/platform/auth';
import { cfDateTimeFormat, isCfUuid } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { DomainDeps, MailDeps } from '../domain/delivery.js';
import { getMessage, listMessages, submitMessage, type MessageFilters, type MessageInput } from '../domain/messages.js';
import { createTemplate, listTemplates, type TemplateFilters, type TemplateInput } from '../domain/templates.js';
import type { components } from '../generated/openapi.js';
import {
  FIXTURE_ROLES,
  fixtureHttpMethod,
  requireAny,
  requireCsrf,
  resolveSite,
  userId,
  type FixtureSiteLookup,
} from '../legacy/fixture-auth.js';
import {
  FixtureApiError,
  fixtureHandler,
  fixtureList,
  fixtureMethod,
  fixtureSuccess,
  type FixtureContext,
} from '../legacy/fixture-envelope.js';
import { storedCfId } from '../repo/queries.js';
import type { MessageTemplateRow } from '../repo/tables.js';

type Schemas = components['schemas'];

// Declared here rather than imported from the route registry, which imports this module; the registry's RouteContext stays assignable.
/** The tenant database, the registry site lookup of `resolveSite` and the prepared domain and mail dependencies. */
export type FixtureRouteDeps = {
  db: TenantDb;
  siteLookup: FixtureSiteLookup;
  domain: DomainDeps;
  mailDeps: MailDeps;
};

/** Fastify path of the communications fixture module; every fixture path below is built from it. */
export const FIXTURE_PREFIX = '/legacy-fixtures/cfml/api.cfm/communications';

/** Fastify path of the api.cfm catch-all; above the module, since the gateway routes fixture paths ignoring case and empty segments. */
export const FIXTURE_CATCH_ALL = '/legacy-fixtures/cfml/api.cfm/*';

/** The module segment of every communications fixture path; api.cfm matches it ignoring case. */
const FIXTURE_MODULE = 'communications';

// api.cfm resolves the site before communications.cfc checks login and role, so these routes are public on the
// platform and resolveSite and requireAny decide in the handler. A platform `requires` list would refuse an anonymous
// or role-less caller before the site check, in the JSON API envelope rather than the fixture's.
const FIXTURE_ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', public: true, siteCheck: false });

const SENDER_ROLES: readonly string[] = Object.freeze([FIXTURE_ROLES.sender]);
const DATE_MASK = "yyyy-mm-dd'T'HH:nn:ss";

/** The methods api.cfm answers; communications.cfc dispatches only GET and POST. */
const FIXTURE_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const);

type HttpMethod = (typeof FIXTURE_METHODS)[number];

/** Path parameters of the fixture routes: the detail's `{id}`, or the rest of the path after api.cfm on the catch-all. */
type RouteParams = { id?: string; '*'?: string };

type FixtureRequest = FastifyRequest<{ Params: RouteParams }>;

/** One fixture path as api.cfm's grammar reads it. */
interface FixturePath {
  /** Envelope method `communications.<resource>[.<action>][.<tail>]`, without the id or a CF UUID tail; `invalid` outside the grammar. */
  method: string;
  /** communications.cfc's dispatch path `<resource>[/{id}][/+]`; undefined outside the grammar. */
  key: string | undefined;
  /** The `{id}` segment as sent; '' when absent. */
  id: string;
}

/** One fixture request after api.cfm's site check. */
interface FixtureCall {
  request: FastifyRequest;
  reply: FastifyReply;
  ctx: FixtureContext;
  /** The registered site id `resolveSite` returned. */
  site: string;
  /** The `{id}` path segment as sent; '' on a collection, which is also its CSRF context. */
  id: string;
}

type MethodHandler = (call: FixtureCall) => Promise<FastifyReply>;

/** communications.cfc authorize(): login, the sender role group, then a write's CSRF token for context `id`. */
async function requireSender(call: FixtureCall): Promise<UserClaims> {
  const user = requireAny(call.request, SENDER_ROLES);
  await requireCsrf(call.request, call.reply, call.id);
  return user;
}

/** The message id to look up: stored ids are upper-case CF UUIDs, so this reproduces SQL Server's case- and trailing-space-insensitive match. */
function storedId(call: FixtureCall): string {
  return storedCfId(call.id);
}

/** A `synthetic.message_template` row as envelope.cfc rows() writes it: dates to the second, NULL as ''. */
function fixtureTemplate(row: MessageTemplateRow): Schemas['MessageTemplate'] {
  return {
    template_id: row.template_id,
    siteid: row.siteid,
    name: row.name,
    subject: row.subject,
    body_text: row.body_text,
    body_html: row.body_html,
    created: cfDateTimeFormat(row.created, DATE_MASK),
    lastupdate: row.lastupdate === null ? '' : cfDateTimeFormat(row.lastupdate, DATE_MASK),
  };
}

/** api.cfm's grammar `<module>/<resource>[/<id>][/<action>][/<tail>]` over the non-empty path segments after api.cfm. */
function fixturePath(segments: readonly string[]): FixturePath {
  if (segments.length < 2 || segments.length > 5) return { method: 'invalid', key: undefined, id: '' };
  const [, resource = '', id = '', action = '', tail = ''] = segments;
  const namedTail = isCfUuid(tail) ? '' : tail;
  return {
    method: fixtureMethod(resource, [action, namedTail].filter((part) => part !== '').join('.')),
    key: `${resource.toLowerCase()}${id === '' ? '' : '/{id}'}${action === '' ? '' : '/+'}`,
    id,
  };
}

/** communications.cfc handle(): the handler of each `<dispatch path> <effective method>` key. */
type Dispatch = ReadonlyMap<string, MethodHandler>;

/** Registers `url` for `methods`, dispatching each request through api.cfm's grammar, site check and communications.cfc key. */
function registerPath(
  app: FastifyInstance,
  lookup: FixtureSiteLookup,
  dispatch: Dispatch,
  url: string,
  methods: readonly HttpMethod[],
  segmentsOf: (request: FixtureRequest) => readonly string[],
): void {
  app.route<{ Params: RouteParams }>({
    method: [...methods],
    url,
    config: { opt2: FIXTURE_ROUTE_AUTH },
    handler: fixtureHandler<FixtureRequest>(
      (request) => fixturePath(segmentsOf(request)).method,
      async (request, reply, ctx) => {
        const segments = segmentsOf(request);
        if (segments[0]?.toLowerCase() !== FIXTURE_MODULE) {
          reply.callNotFound();
          return reply;
        }
        const { key, id } = fixturePath(segments);
        if (key === undefined) {
          throw new FixtureApiError('notFound');
        }
        const site = await resolveSite(request, ctx.params, lookup);
        const handler = dispatch.get(`${key} ${fixtureHttpMethod(request)}`);
        if (handler === undefined) {
          throw new FixtureApiError('notFound');
        }
        return handler({ request, reply, ctx, site, id });
      },
    ),
  });
}

/** Registers the five communications fixture routes the contract declares, and the api.cfm catch-all answering every other path and method. */
export async function registerFixtureRoutes(app: FastifyInstance, deps: FixtureRouteDeps): Promise<void> {
  const templates: MethodHandler = async (call) => {
    const user = await requireSender(call);
    const filters: TemplateFilters = { ...call.ctx.params, siteId: call.site };
    const page = await withTenant(deps.db, user.tid, (tx) => listTemplates(tx, filters));
    return fixtureList(call.reply, { ...call.ctx, listResult: { ...page, list: page.list.map(fixtureTemplate) } });
  };

  const storeTemplate: MethodHandler = async (call) => {
    const user = await requireSender(call);
    const input: TemplateInput = call.ctx.params;
    const row = await withGatedTenant(deps.db, user.tid, (tx) =>
      createTemplate(tx, deps.domain, { siteId: call.site, userId: userId(call.request), input }),
    );
    return fixtureSuccess(call.reply, { ...call.ctx, data: fixtureTemplate(row) });
  };

  const messages: MethodHandler = async (call) => {
    const user = await requireSender(call);
    const filters: MessageFilters = { ...call.ctx.params, siteId: call.site };
    const page = await withTenant(deps.db, user.tid, (tx) => listMessages(tx, filters));
    return fixtureList(call.reply, { ...call.ctx, listResult: page });
  };

  const send: MethodHandler = async (call) => {
    const user = await requireSender(call);
    const input: MessageInput = call.ctx.params;
    const detail = await submitMessage(deps.mailDeps, { tenantId: user.tid, siteId: call.site, userId: userId(call.request), input });
    return fixtureSuccess(call.reply, { ...call.ctx, data: detail });
  };

  const message: MethodHandler = async (call) => {
    const user = await requireSender(call);
    const detail = await withTenant(deps.db, user.tid, (tx) => getMessage(tx, storedId(call)));
    return fixtureSuccess(call.reply, { ...call.ctx, data: detail });
  };

  const dispatch: Dispatch = new Map([
    ['templates GET', templates],
    ['templates POST', storeTemplate],
    ['messages GET', messages],
    ['messages POST', send],
    ['messages/{id} GET', message],
  ]);
  const register = (url: string, methods: readonly HttpMethod[], segmentsOf: (request: FixtureRequest) => readonly string[]): void =>
    registerPath(app, deps.siteLookup, dispatch, url, methods, segmentsOf);

  register(`${FIXTURE_PREFIX}/templates`, ['GET', 'POST'], () => [FIXTURE_MODULE, 'templates']);
  register(`${FIXTURE_PREFIX}/messages`, ['GET', 'POST'], () => [FIXTURE_MODULE, 'messages']);
  register(`${FIXTURE_PREFIX}/messages/:id`, ['GET'], (request) => [FIXTURE_MODULE, 'messages', request.params.id ?? '']);
  // CFML listToArray drops the empty segments of `//` and a trailing `/`.
  register(FIXTURE_CATCH_ALL, FIXTURE_METHODS, (request) => (request.params['*'] ?? '').split('/').filter((segment) => segment !== ''));
}
