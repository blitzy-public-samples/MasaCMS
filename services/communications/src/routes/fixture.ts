// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture routes `communications/…` of legacy-fixtures/cfml/api.cfm, answered as legacy-fixtures/cfml/modules/communications.cfc answers them. */
import type { Opt2RouteConfig, UserClaims } from '@opt2/platform/auth';
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';
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

// api.cfm resolves the site before communications.cfc checks login and role, so these routes are public on the
// platform and resolveSite and requireAny decide in the handler. A platform `requires` list would refuse an anonymous
// or role-less caller before the site check, in the JSON API envelope rather than the fixture's.
const FIXTURE_ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', public: true, siteCheck: false });

const SENDER_ROLES: readonly string[] = Object.freeze([FIXTURE_ROLES.sender]);
const DATE_MASK = "yyyy-mm-dd'T'HH:nn:ss";

/** The methods the contract declares on a fixture path; communications.cfc dispatches no other. */
type HttpMethod = 'GET' | 'POST';

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
  return call.id.replace(/ +$/u, '').toUpperCase();
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

/**
 * Registers one fixture path for exactly its declared methods. As api.cfm and communications.cfc do, the site is
 * checked first, then the effective method (X-HTTP-Method-Override included) picks the handler, and a method the
 * path lacks answers notFound.
 */
function registerPath(
  app: FastifyInstance,
  lookup: FixtureSiteLookup,
  url: string,
  method: string,
  handlers: ReadonlyArray<readonly [HttpMethod, MethodHandler]>,
): void {
  app.route<{ Params: { id?: string } }>({
    method: handlers.map(([httpMethod]) => httpMethod),
    url,
    config: { opt2: FIXTURE_ROUTE_AUTH },
    handler: fixtureHandler(method, async (request, reply, ctx) => {
      const site = await resolveSite(request, ctx.params, lookup);
      const effective = fixtureHttpMethod(request);
      const handler = handlers.find(([httpMethod]) => httpMethod === effective)?.[1];
      if (handler === undefined) {
        throw new FixtureApiError('notFound');
      }
      return handler({ request, reply, ctx, site, id: request.params.id ?? '' });
    }),
  });
}

/** Registers the five communications fixture routes the contract declares: templates and messages lists and writes, and the message detail. */
export async function registerFixtureRoutes(app: FastifyInstance, deps: FixtureRouteDeps): Promise<void> {
  const register = (url: string, method: string, handlers: ReadonlyArray<readonly [HttpMethod, MethodHandler]>): void =>
    registerPath(app, deps.siteLookup, url, method, handlers);

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

  register(`${FIXTURE_PREFIX}/templates`, fixtureMethod('templates'), [
    ['GET', templates],
    ['POST', storeTemplate],
  ]);
  register(`${FIXTURE_PREFIX}/messages`, fixtureMethod('messages'), [
    ['GET', messages],
    ['POST', send],
  ]);
  // api.cfm leaves an `{id}` segment out of the envelope method, so the detail answers as `communications.messages`.
  register(`${FIXTURE_PREFIX}/messages/:id`, fixtureMethod('messages'), [['GET', message]]);
}
