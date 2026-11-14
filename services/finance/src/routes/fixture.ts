// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture routes `finance/…` of legacy-fixtures/cfml/api.cfm, answered as legacy-fixtures/cfml/modules/finance.cfc answers them. */
import { AuthDenial, Roles, type DenialRenderer, type Opt2AuthContext, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import {
  csrfPreHandler,
  multipartFilesOf,
  recordOutcomeReason,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { getAttachment, listAttachments, streamLegacy, uploadAttachment } from '../domain/attachments.js';
import {
  createRecord,
  getRecord,
  listRecords,
  listVersions,
  transitionRecord,
  type FinanceActor,
  type FinanceDomainDeps,
  type RecordWrite,
} from '../domain/records.js';
import { getRollups, rebuildRollups } from '../domain/rollup.js';
import {
  fixtureDenialOverride,
  requireFinanceAction,
  requireProgram,
  requireRecordInput,
  resolveFixtureSite,
  type FixtureSite,
} from '../legacy/checks.js';
import {
  FixtureApiError,
  fixtureContext,
  fixtureList,
  fixtureOutcomeReason,
  fixtureSuccess,
  logUnavailable,
  toFixtureError,
  type FixtureContext,
} from '../legacy/envelope.js';
import { attachmentRow, recordRow, rollupRow, versionRow } from '../legacy/serialize.js';
import type { FinanceRecordRow } from '../repo/tables.js';

/** The finance domain's repository, storage and clock, plus the finance tenant database. */
export type FixtureRouteDeps = FinanceDomainDeps & { db: TenantDb };

/** Fastify path of the finance fixture module; every fixture route below is built from it. */
export const FIXTURE_PREFIX = '/legacy-fixtures/cfml/api.cfm/finance';

// finance.cfc gates reads and lifecycle actions with readRoles, record and attachment creation with writeRoles.
const READ_ROLES: readonly string[] = Object.freeze([Roles.financePreparer, Roles.financeApprover]);
const WRITE_ROLES: readonly string[] = Object.freeze([Roles.financePreparer]);

/** Multipart field finance.cfc stores as the attachment. */
const UPLOAD_FIELD = 'file';
/** The collection's CSRF context: api.cfm passes the empty route id. */
const COLLECTION_CONTEXT = '';

const INT_MAX = 2_147_483_647;
const ASCII_INTEGER = /^[+-]?[0-9]+$/;
const ANY_SCRIPT_INTEGER = /^[+-]?\p{Nd}+$/u;
const DECIMAL_DIGIT = /\p{Nd}/u;
const JSON_MEDIA_TYPE = /^application\/json/i;

/** Path params of the fixture routes. */
type RouteParams = { id?: string; action?: string; aid?: string };
type IdParams = { id: string };

/** One page of rows with the count of all of them, as the domain list reads return it. */
type RowPage<R> = { rows: R[]; total: number };

/** A fixture page request: `pageIndex` from 1, `itemsPerPage` from 1 to 1000. */
type FixturePageRequest = { pageIndex: number; itemsPerPage: number };

/** One fixture request after api.cfm's site check: its envelope context, verified user, site and acting user. */
interface FixtureCall {
  ctx: FixtureContext;
  user: UserClaims;
  site: FixtureSite;
  actor: FinanceActor;
}

/** The envelope context of the matched route: resource, then the action segment or a fixed one, then the attachment id. */
function contextOf(request: FastifyRequest): FixtureContext {
  const { action, aid } = request.params as RouteParams;
  const [resource = '', , fixed] = (request.routeOptions.url ?? '').slice(FIXTURE_PREFIX.length + 1).split('/');
  return fixtureContext(request, resource, action ?? fixed, aid);
}

/** The verified user; every fixture route requires a user role, so the auth hook admits no request without one. */
function userOf(request: FastifyRequest): UserClaims {
  const { user } = request.opt2Auth;
  if (user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return user;
}

/** Context, user and site of a request, the site resolved as auth.cfc resolveSite does before finance.cfc runs. */
async function fixtureCall(request: FastifyRequest, db: TenantDb): Promise<FixtureCall> {
  const ctx = contextOf(request);
  const user = userOf(request);
  const site = await resolveFixtureSite(ctx.params, { claims: user, registry: db });
  return { ctx, user, site, actor: { userId: user.sub, siteId: site.siteId } };
}

/** auth.cfc requireCsrf of a logged-in write: identity validates and consumes the token for `context`, else invalidTokens. */
async function requireCsrf(request: FastifyRequest, reply: FastifyReply, context: string): Promise<void> {
  await csrfPreHandler({ contextOf: () => context }).call(request.server, request, reply);
}

/** A path id as SQL Server matches it against the stored upper-case CF UUIDs: ignoring case and trailing spaces. */
function storedId(segment: string): string {
  return segment.replace(/ +$/u, '').toUpperCase();
}

/** Value of a Unicode decimal digit; such digits come in contiguous runs of ten starting at zero. */
function digitValue(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  let start = codePoint;
  while (DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (codePoint - start) % 10;
}

/** ACF isValid('integer', text), which parses as Java Integer.parseInt: an optional sign, digits of any script, 32-bit range. */
function cfInteger(text: string): number | undefined {
  if (!ANY_SCRIPT_INTEGER.test(text)) return undefined;
  let magnitude = 0;
  for (const char of text.replace(/^[+-]/u, '')) magnitude = magnitude * 10 + digitValue(char);
  const value = text.startsWith('-') ? -magnitude : magnitude;
  return value >= -INT_MAX - 1 && value <= INT_MAX ? value : undefined;
}

/** The merged param under `name` ignoring case, as a CFML struct key resolves; undefined when absent. */
function paramNoCase(params: Record<string, unknown>, name: string): unknown {
  const lower = name.toLowerCase();
  const key = Object.keys(params).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : params[key];
}

/** envelope.cfc pageParam: `fallback` when absent or empty, else an integer in [1, max]; throws invalidParameters. */
function pageParam(params: Record<string, unknown>, name: string, fallback: number, max = INT_MAX): number {
  const value = paramNoCase(params, name);
  if (value === undefined || value === '') return fallback;
  const parsed = typeof value === 'string' ? cfInteger(value) : undefined;
  if (typeof value !== 'string' || parsed === undefined) throw new FixtureApiError('invalidParameters');
  if (ASCII_INTEGER.test(value)) {
    if (parsed < 1 || parsed > max) throw new FixtureApiError('invalidParameters');
    return parsed;
  }
  // ACF compares non-ASCII digit text with the bounds as strings, then its int() fails with an expression error.
  if (value < '1' || value > String(max)) throw new FixtureApiError('invalidParameters');
  throw new Error(`The ${name} paging parameter holds non-ASCII digits`);
}

/** envelope.cfc page(): `pageIndex` defaults to 1, `itemsPerPage` to 50 and at most 1000. */
function fixturePaging(params: Record<string, unknown>): FixturePageRequest {
  const pageIndex = pageParam(params, 'pageIndex', 1);
  return { pageIndex, itemsPerPage: pageParam(params, 'itemsPerPage', 50, 1000) };
}

/** Merged params with a JSON object body's values in their JSON types, as finance.cfc recordFields reads deserialized JSON. */
function recordFieldParams(request: FastifyRequest, params: Record<string, unknown>): Record<string, unknown> {
  const { body } = request;
  const json = JSON_MEDIA_TYPE.test(request.headers['content-type'] ?? '');
  return json && typeof body === 'object' && body !== null && !Array.isArray(body) ? { ...params, ...body } : params;
}

/** The multipart file part finance.cfc stores: field `file` (ignoring case) with a client file name; else invalidParameters. */
function uploadedFile(request: FastifyRequest): ReturnType<typeof multipartFilesOf>[number] {
  const part = multipartFilesOf(request).find((candidate) => candidate.field.toLowerCase() === UPLOAD_FIELD && candidate.filename !== '');
  if (part === undefined) throw new FixtureApiError('invalidParameters');
  return part;
}

/** Rebuilds the program rollup at the write's instant inside its transaction, as finance.cfc refreshRollup does; returns the record. */
async function withRollup(tx: TenantTx, deps: FinanceDomainDeps, write: RecordWrite, actor: FinanceActor): Promise<FinanceRecordRow> {
  await rebuildRollups(tx, deps, { now: write.version.created, ctx: { actorUserId: actor.userId } });
  return write.record;
}

/** Sends one fixture list page of `page`, each row projected by `project`. */
function sendPage<R>(
  reply: FastifyReply,
  ctx: FixtureContext,
  page: RowPage<R>,
  paging: FixturePageRequest,
  project: (row: R) => unknown,
): FastifyReply {
  return sendLegacyResponse(reply, fixtureList(ctx, page.rows.map(project), { total: page.total, ...paging }));
}

/** Renders a platform auth denial as the fixture answers it, after the site check auth.cfc resolveSite runs first. */
function fixtureDenialRenderer(db: TenantDb): DenialRenderer {
  return async (denial, request) => {
    const claims = (request.opt2Auth as Opt2AuthContext | null)?.user;
    const answered = await fixtureDenialOverride(denial, { claims, registry: db });
    recordOutcomeReason(request, fixtureOutcomeReason(answered));
    return toFixtureError(answered, contextOf(request));
  };
}

/** Registers the nine finance fixture routes of the contract, answering their errors and auth denials in the fixture envelope. */
export const financeFixturePlugin: FastifyPluginAsync<FixtureRouteDeps> = async (app, deps) => {
  const { db } = deps;
  const renderDenial = fixtureDenialRenderer(db);
  const auth = (requires: readonly string[]): { opt2: Opt2RouteConfig } => ({ opt2: { requires, transport: 'service', renderDenial } });
  const read = { config: auth(READ_ROLES) };
  const write = { config: auth(WRITE_ROLES) };

  app.setErrorHandler((error, request, reply) => {
    const response = toFixtureError(error, contextOf(request));
    if (error instanceof LegacyServiceUnavailableError) logUnavailable(request, error);
    else if (response.status === 500 && !(error instanceof LegacyApiError)) request.log.error({ error: serializeError(error) }, 'unhandled fixture exception');
    else recordOutcomeReason(request, fixtureOutcomeReason(error));
    return sendLegacyResponse(reply, response);
  });

  app.get(`${FIXTURE_PREFIX}/records`, read, async (request, reply) => {
    const { ctx, site } = await fixtureCall(request, db);
    const { page, paging } = await withTenant(db, site.tenantId, async (tx) => {
      await requireProgram(tx, site.tenantId);
      const paging = fixturePaging(ctx.params);
      return { page: await listRecords(tx, paging), paging };
    });
    return sendPage(reply, ctx, page, paging, recordRow);
  });

  app.post(`${FIXTURE_PREFIX}/records`, write, async (request, reply) => {
    const { ctx, site, actor } = await fixtureCall(request, db);
    await requireCsrf(request, reply, COLLECTION_CONTEXT);
    const record = await withGatedTenant(db, site.tenantId, async (tx) => {
      await requireProgram(tx, site.tenantId);
      const input = requireRecordInput(recordFieldParams(request, ctx.params), 'create');
      return withRollup(tx, deps, await createRecord(tx, deps, input, actor), actor);
    });
    return sendLegacyResponse(reply, fixtureSuccess(ctx, recordRow(record)));
  });

  app.get<{ Params: IdParams }>(`${FIXTURE_PREFIX}/records/:id`, read, async (request, reply) => {
    const { ctx, site } = await fixtureCall(request, db);
    const record = await withTenant(db, site.tenantId, async (tx) => {
      await requireProgram(tx, site.tenantId);
      return getRecord(tx, storedId(request.params.id));
    });
    return sendLegacyResponse(reply, fixtureSuccess(ctx, recordRow(record)));
  });

  app.post<{ Params: IdParams & { action: string } }>(`${FIXTURE_PREFIX}/records/:id/:action`, read, async (request, reply) => {
    const { ctx, user, site, actor } = await fixtureCall(request, db);
    const action = requireFinanceAction(request.params.action);
    await requireCsrf(request, reply, request.params.id);
    const record = await withGatedTenant(db, site.tenantId, async (tx) => {
      await requireProgram(tx, site.tenantId);
      const id = storedId(request.params.id);
      await getRecord(tx, id);
      const input = action === 'edit' ? requireRecordInput(recordFieldParams(request, ctx.params), 'edit') : undefined;
      return withRollup(tx, deps, await transitionRecord(tx, deps, { id, action, roles: user.roles, input }, actor), actor);
    });
    return sendLegacyResponse(reply, fixtureSuccess(ctx, recordRow(record)));
  });

  app.get<{ Params: IdParams }>(`${FIXTURE_PREFIX}/records/:id/versions`, read, async (request, reply) => {
    const { ctx, site } = await fixtureCall(request, db);
    const { page, paging } = await withTenant(db, site.tenantId, async (tx) => {
      await requireProgram(tx, site.tenantId);
      const id = storedId(request.params.id);
      await getRecord(tx, id);
      const paging = fixturePaging(ctx.params);
      return { page: await listVersions(tx, id, paging), paging };
    });
    return sendPage(reply, ctx, page, paging, versionRow);
  });

  app.get<{ Params: IdParams }>(`${FIXTURE_PREFIX}/records/:id/attachments`, read, async (request, reply) => {
    const { ctx, site } = await fixtureCall(request, db);
    const { page, paging } = await withTenant(db, site.tenantId, async (tx) => {
      await requireProgram(tx, site.tenantId);
      const id = storedId(request.params.id);
      await getRecord(tx, id);
      const paging = fixturePaging(ctx.params);
      return { page: await listAttachments(tx, id, paging), paging };
    });
    return sendPage(reply, ctx, page, paging, attachmentRow);
  });

  app.post<{ Params: IdParams }>(`${FIXTURE_PREFIX}/records/:id/attachments`, write, async (request, reply) => {
    const { ctx, site, actor } = await fixtureCall(request, db);
    await requireCsrf(request, reply, request.params.id);
    const attachment = await withGatedTenant(db, site.tenantId, async (tx) => {
      await requireProgram(tx, site.tenantId);
      const recordId = storedId(request.params.id);
      await getRecord(tx, recordId);
      const { filename, contentType, size, sha256, stream } = uploadedFile(request);
      return uploadAttachment(tx, deps, { recordId, fileName: filename, contentType, size, sha256, body: stream }, actor);
    });
    return sendLegacyResponse(reply, fixtureSuccess(ctx, attachmentRow(attachment)));
  });

  app.get<{ Params: IdParams & { aid: string } }>(`${FIXTURE_PREFIX}/records/:id/attachments/:aid`, read, async (request, reply) => {
    const { site } = await fixtureCall(request, db);
    const attachment = await withTenant(db, site.tenantId, async (tx) => {
      await requireProgram(tx, site.tenantId);
      return getAttachment(tx, storedId(request.params.id), storedId(request.params.aid));
    });
    return streamLegacy(reply, deps, attachment);
  });

  app.get(`${FIXTURE_PREFIX}/rollups`, read, async (request, reply) => {
    const { ctx, site } = await fixtureCall(request, db);
    const { page, paging } = await withTenant(db, site.tenantId, async (tx) => {
      await requireProgram(tx, site.tenantId);
      const paging = fixturePaging(ctx.params);
      return { page: await getRollups(tx, { paging }), paging };
    });
    return sendPage(reply, ctx, page, paging, (row) => rollupRow(row));
  });
};

/** Registers the finance fixture routes in their own encapsulated context, so their error handler serves only them. */
export async function registerFixtureRoutes(app: FastifyInstance, deps: FixtureRouteDeps): Promise<void> {
  await app.register(financeFixturePlugin, deps);
}
