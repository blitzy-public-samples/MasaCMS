// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/` routes of the OPT-2 communications screens: templates, sends and delivery status. */
import { AuthDenial, Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import {
  csrfPreHandler,
  legacyParamsOf,
  recordOutcomeReason,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { DomainDeps, MailDeps } from '../domain/delivery.js';
import { getMessage, listMessages, submitMessage, type MessageFilters, type MessageInput } from '../domain/messages.js';
import { createTemplate, listTemplates, type TemplateFilters, type TemplateInput } from '../domain/templates.js';
import type { components, paths } from '../generated/openapi.js';
import { FixtureApiError, fixtureErrorResponse, fixtureMethod, listResultData } from '../legacy/fixture-envelope.js';
import type { MessageTemplateRow } from '../repo/tables.js';

/** The `application/json` body of an operation's 200 response. */
type OkBody<O> = O extends { responses: { 200: { content: { 'application/json': infer B } } } } ? B : never;

type MessageTemplate = components['schemas']['MessageTemplate'];
type TemplateListBody = OkBody<paths['/v1/templates']['get']>;
type TemplateBody = OkBody<paths['/v1/templates']['post']>;
type MessageListBody = OkBody<paths['/v1/messages']['get']>;
type SendMessageBody = OkBody<paths['/v1/messages']['post']>;
type MessageDetailBody = OkBody<paths['/v1/messages/{messageId}']['get']>;
type MessagePathParams = paths['/v1/messages/{messageId}']['get']['parameters']['path'];

// Declared here rather than imported from the route registry, which imports this module; the registry's RouteContext stays assignable.
/** Dependencies of the `/v1/` routes: the tenant database, the domain deps and the mail deps. */
export type V1RouteDeps = { db: TenantDb; domain: DomainDeps; mailDeps: MailDeps };

/** Tenant, site and user of a request, from the verified user token only. */
interface VerifiedIdentity {
  tenantId: string;
  siteId: string;
  userId: string;
}

/** Merged request params, as the domain and the fixture error envelope read them. */
type RequestParams = Record<string, unknown>;

type MessageRequest = FastifyRequest<{ Params: MessagePathParams }>;

const TEMPLATES_PATH = '/v1/templates';
const MESSAGES_PATH = '/v1/messages';
const MESSAGE_PATH = `${MESSAGES_PATH}/:messageId`;

const TEMPLATES_METHOD = fixtureMethod('templates');
const MESSAGES_METHOD = fixtureMethod('messages');

const SENDER_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.communicationsSender]),
});

const ROUTE_OPTIONS = { config: { opt2: SENDER_AUTH } };

/** CSRF context of the template and message collections: the empty route id the fixture validates their writes under. */
const COLLECTION_CSRF_CONTEXT = '';

// Identity consumes the write's token once the sender and site checks pass, before the handler reads the body.
const WRITE_OPTIONS = { ...ROUTE_OPTIONS, preHandler: csrfPreHandler({ contextOf: () => COLLECTION_CSRF_CONTEXT }) };

const FIXTURE_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss";

/** A stored template as the fixture emits it: datetimes to the second, a NULL `lastupdate` as ''. */
function toTemplate(row: MessageTemplateRow): MessageTemplate {
  return {
    template_id: row.template_id,
    siteid: row.siteid,
    name: row.name,
    subject: row.subject,
    body_text: row.body_text,
    body_html: row.body_html,
    created: cfDateTimeFormat(row.created, FIXTURE_TIMESTAMP_MASK),
    lastupdate: row.lastupdate === null ? '' : cfDateTimeFormat(row.lastupdate, FIXTURE_TIMESTAMP_MASK),
  };
}

/** The verified tenant, site and user; every route requires a user role, so a request without them is unauthenticated. */
function identityOf(request: FastifyRequest): VerifiedIdentity {
  const { user } = request.opt2Auth;
  const { tenantId, site } = request.opt2;
  if (user === undefined || tenantId === undefined || site === undefined) {
    throw AuthDenial.unauthenticated('missing-credential');
  }
  return { tenantId, siteId: site, userId: user.sub };
}

/**
 * Handler sending `fn`'s body with status 200; a `FixtureApiError` answers in the fixture error envelope of `method`, its type
 * recorded as the outcome reason; other errors propagate to service-kit's legacy error handler.
 */
function v1Handler<R extends FastifyRequest, B>(
  method: string,
  fn: (request: R, identity: VerifiedIdentity, params: RequestParams) => Promise<B>,
): (request: R, reply: FastifyReply) => Promise<FastifyReply> {
  return async (request, reply) => {
    // The query plus the form or JSON-object body as CFML scope values, JSON simple values as toString text: the same input
    // the fixture routes give the domain. A raw body may be absent or not an object.
    const params = legacyParamsOf(request, { jsonScalars: 'cfml' });
    try {
      const body = await fn(request, identityOf(request), params);
      return reply.code(200).send(body);
    } catch (error) {
      if (!(error instanceof FixtureApiError)) {
        throw error;
      }
      recordOutcomeReason(request, error.type);
      return sendLegacyResponse(reply, fixtureErrorResponse(error, { method, params }));
    }
  };
}

/** Registers `listTemplates`, `createTemplate`, `listMessages`, `sendMessage` and `getMessage`. */
export async function registerV1Routes(app: FastifyInstance, ctx: V1RouteDeps): Promise<void> {
  app.get(
    TEMPLATES_PATH,
    ROUTE_OPTIONS,
    v1Handler(TEMPLATES_METHOD, async (_request, { tenantId, siteId }, params): Promise<TemplateListBody> => {
      const filters: TemplateFilters = { ...params, siteId };
      const page = await withTenant(ctx.db, tenantId, (tx) => listTemplates(tx, filters));
      return { data: listResultData({ ...page, list: page.list.map(toTemplate) }) };
    }),
  );

  app.post(
    TEMPLATES_PATH,
    WRITE_OPTIONS,
    v1Handler(TEMPLATES_METHOD, async (_request, { tenantId, siteId, userId }, params): Promise<TemplateBody> => {
      const input: TemplateInput = params;
      const row = await withGatedTenant(ctx.db, tenantId, (tx) => createTemplate(tx, ctx.domain, { siteId, userId, input }));
      return { data: toTemplate(row) };
    }),
  );

  app.get(
    MESSAGES_PATH,
    ROUTE_OPTIONS,
    v1Handler(MESSAGES_METHOD, async (_request, { tenantId, siteId }, params): Promise<MessageListBody> => {
      const filters: MessageFilters = { ...params, siteId };
      const page = await withTenant(ctx.db, tenantId, (tx) => listMessages(tx, filters));
      return { data: listResultData(page) };
    }),
  );

  app.post(
    MESSAGES_PATH,
    WRITE_OPTIONS,
    v1Handler(MESSAGES_METHOD, async (_request, { tenantId, siteId, userId }, params): Promise<SendMessageBody> => {
      const input: MessageInput = params;
      return { data: await submitMessage(ctx.mailDeps, { tenantId, siteId, userId, input }) };
    }),
  );

  app.get(
    MESSAGE_PATH,
    ROUTE_OPTIONS,
    v1Handler(MESSAGES_METHOD, async (request: MessageRequest, { tenantId }): Promise<MessageDetailBody> => {
      const detail = await withTenant(ctx.db, tenantId, (tx) => getMessage(tx, request.params.messageId));
      return { data: detail };
    }),
  );
}
