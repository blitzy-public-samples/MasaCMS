// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture routes `timesheets/…` of legacy-fixtures/cfml/api.cfm, answered as lib/auth.cfc and modules/timesheets.cfc answer them. */
import {
  AuthDenial,
  Roles,
  assertSiteMatches,
  type DenialRenderer,
  type Opt2AuthContext,
  type Opt2RouteConfig,
  type UserClaims,
} from '@opt2/platform/auth';
import { LegacyApiError, cfDateFormat } from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import {
  csrfPreHandler,
  recordOutcomeReason,
  sendLegacyResponse,
  type Clock,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { tenantForRegisteredSite, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { performDayAction } from '../domain/day-action.js';
import { TIMESHEET_ACTIONS, type TimesheetAction, type TimesheetState } from '../domain/lifecycle.transitions.js';
import { deriveSheetStatus, type SheetStatusOptions, type SheetStatusResult } from '../domain/sheet-status.js';
import {
  FIXTURE_ERROR_MAP,
  FixtureApiError,
  fixtureContext,
  fixtureDayAction,
  fixtureList,
  fixtureOutcomeReason,
  fixtureSuccess,
  toFixtureError,
  type FixtureContext,
} from '../legacy/envelope.js';
import { dayActionResult, sheetRow, statusRow, type FixtureDaySource } from '../legacy/serialize.js';
import { PROGRAM_SITES } from '../migration/mappings/index.js';
import type { TimesheetsRepository } from '../repo/repository.js';
import type { TimesheetDayRow, TimesheetRow } from '../repo/tables.js';

/** Options of the fixture plugin; `routes/index.ts` passes its `TimesheetsDeps`, which has the same shape. */
export type FixtureRouteDeps = { db: TenantDb; repository: TimesheetsRepository; clock: Clock };

/** Fastify path of the timesheets fixture module; every fixture route below is built from it. */
export const FIXTURE_PREFIX = '/legacy-fixtures/cfml/api.cfm/timesheets';

/** The contract's fixture routes; the envelope resource and action are read back from the matched url by `contextOf`. */
const ROUTES = Object.freeze({
  sheets: `${FIXTURE_PREFIX}/sheets`,
  sheet: `${FIXTURE_PREFIX}/sheets/:id`,
  sheetStatus: `${FIXTURE_PREFIX}/sheets/:id/status`,
  dayAction: `${FIXTURE_PREFIX}/days/:id/:action`,
});

/** Request methods every fixture route accepts; `effectiveMethod` picks the one it answers as. */
const TRANSPORT_METHODS = Object.freeze(['GET', 'POST'] as const);

/** timesheets.cfc `variables.roles`, which its gate() requires for every route. */
const FIXTURE_ROLES: readonly string[] = Object.freeze([
  Roles.timesheetsEmployee,
  Roles.timesheetsPrimaryApprover,
  Roles.timesheetsSecondaryApprover,
]);

const DEFAULT_SITE_ID = 'default';
const AS_OF_TEXT = /^\d{4}-\d{2}-\d{2}$/;
// SQL Server datetime's floor, below which timesheets.cfc asOfParam rejects a date.
const MIN_AS_OF_YEAR = 1753;
const INT_MAX = 2_147_483_647;
const ASCII_INTEGER = /^[+-]?[0-9]+$/;
const ANY_SCRIPT_INTEGER = /^[+-]?\p{Nd}+$/u;
const DECIMAL_DIGIT = /\p{Nd}/u;

/** Path params of the fixture routes. */
type IdParams = { id: string };
type DayActionParams = IdParams & { action: string };

/** A fixture request's site, canonical as `synthetic.program_site` holds it, and its `Program_<id>`. */
export type FixtureProgram = { siteId: string; programId: number };

/** `parseFixtureAsOf`'s verdict: the `yyyy-mm-dd` business date, or the fixture's invalidParameters message. */
export type FixtureAsOf = { ok: true; asOf: SheetStatusOptions['asOf'] } | { ok: false; message: string };

/** A validated fixture page request: `pageIndex` from 1, `itemsPerPage` from 1 to 1000. */
type FixturePageRequest = { pageIndex: number; itemsPerPage: number };

/** One read fixture request after the site and program checks. */
type FixtureCall = FixtureProgram & { ctx: FixtureContext; claims: UserClaims };

/** The merged param under `name` ignoring case, as a CFML struct key resolves; undefined when absent. */
function param(params: Readonly<Record<string, unknown>>, name: string): unknown {
  const lower = name.toLowerCase();
  const key = Object.keys(params).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : params[key];
}

/** Envelope context of the matched route: `timesheets.<resource>[.<action>]`, the action being a fixed segment or `:action`. */
function contextOf(request: FastifyRequest): FixtureContext {
  const [resource = '', , segment] = (request.routeOptions.url ?? '').slice(FIXTURE_PREFIX.length + 1).split('/');
  const { action } = request.params as Partial<DayActionParams>;
  return fixtureContext(request, resource, segment === ':action' ? action : segment);
}

/** The verified user; every fixture route requires a user role, so the auth hook admits no request without one. */
function userClaims(request: FastifyRequest): UserClaims {
  const { user } = request.opt2Auth;
  if (user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return user;
}

/** The method api.cfm dispatches on: a non-empty X-HTTP-Method-Override, else the request method, upper-cased. */
function effectiveMethod(request: FastifyRequest): string {
  const override = request.headers['x-http-method-override'];
  const value = Array.isArray(override) ? override[0] : override;
  return (value === undefined || value === '' ? request.method : value).toUpperCase();
}

/**
 * The request's site as auth.cfc resolveSite picks it (`siteid`, else the token's site, else `default`), then its
 * program as auth.cfc programSchema finds it; throws invalidParameters for a site without a program.
 */
export function resolveFixtureProgram(params: Readonly<Record<string, unknown>>, claims: Pick<UserClaims, 'site'>): FixtureProgram {
  const supplied = param(params, 'siteid');
  const requested = typeof supplied === 'string' && supplied !== '' ? supplied : claims.site || DEFAULT_SITE_ID;
  // The token's site stands for the session site, and only it may select data, so the tenant is always the token's.
  assertSiteMatches(requested, claims);
  const program = Object.entries(PROGRAM_SITES).find(([, site]) => site.toLowerCase() === requested.toLowerCase());
  if (program === undefined) throw new FixtureApiError('invalidParameters');
  return { siteId: program[1], programId: Number(program[0]) };
}

/** timesheets.cfc asOfParam: today (injected clock, legacy server zone) when absent, else a real `yyyy-mm-dd` date from 1753 on. */
export function parseFixtureAsOf(raw: unknown, clock: Clock): FixtureAsOf {
  if (raw === undefined || raw === null) return { ok: true, asOf: cfDateFormat(clock.now(), 'yyyy-mm-dd') };
  const invalid: FixtureAsOf = { ok: false, message: FIXTURE_ERROR_MAP.invalidParameters.message };
  if (typeof raw !== 'string' || !AS_OF_TEXT.test(raw)) return invalid;
  const [year = 0, month = 0, day = 0] = raw.split('-').map(Number);
  if (year < MIN_AS_OF_YEAR || month < 1 || month > 12) return invalid;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate() ? { ok: true, asOf: raw } : invalid;
}

/** The request's `asOf` business date; throws invalidParameters as timesheets.cfc asOfParam raises it. */
function requireAsOf(params: Readonly<Record<string, unknown>>, clock: Clock): string {
  const parsed = parseFixtureAsOf(param(params, 'asOf'), clock);
  if (!parsed.ok) throw new FixtureApiError('invalidParameters', parsed.message);
  return parsed.asOf;
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

/** envelope.cfc pageParam: `fallback` when absent or empty, else an integer in [1, max]; throws invalidParameters. */
function pageParam(params: Readonly<Record<string, unknown>>, name: string, fallback: number, max = INT_MAX): number {
  const value = param(params, name);
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
function fixturePaging(params: Readonly<Record<string, unknown>>): FixturePageRequest {
  const pageIndex = pageParam(params, 'pageIndex', 1);
  return { pageIndex, itemsPerPage: pageParam(params, 'itemsPerPage', 50, 1000) };
}

/** A path id as SQL Server matches it against the stored upper-case CF UUIDs, ignoring case; bpchar ignores trailing spaces. */
function storedId(segment: string): string {
  return segment.toUpperCase();
}

/** Whether `segment` names a timesheet day action. */
function isDayAction(segment: string): segment is TimesheetAction {
  return (TIMESHEET_ACTIONS as readonly string[]).includes(segment);
}

/** The audit comment as timesheets.cfc reads it: '' when absent, invalidParameters for a value that is not simple. */
function commentOf(params: Readonly<Record<string, unknown>>): string {
  const comment = param(params, 'comment') ?? '';
  if (typeof comment !== 'string') throw new FixtureApiError('invalidParameters');
  return comment;
}

/** Context, user, site and program of a read request, checked in api.cfm's and timesheets.cfc's order. */
function fixtureCall(request: FastifyRequest): FixtureCall {
  const ctx = contextOf(request);
  const claims = userClaims(request);
  return { ctx, claims, ...resolveFixtureProgram(ctx.params, claims) };
}

/** auth.cfc requireCsrf of a logged-in write: identity validates and consumes the token for `context`, else invalidTokens. */
async function requireCsrf(request: FastifyRequest, reply: FastifyReply, context: string): Promise<void> {
  await csrfPreHandler({ contextOf: () => context }).call(request.server, request, reply);
}

/** The sheet `id` of the site, as timesheets.cfc requireSheet selects it; throws notFound when the site holds none. */
async function requireSheet(tx: TenantTx, repository: TimesheetsRepository, id: string, siteId: string): Promise<TimesheetRow> {
  const sheet = await repository.getSheet(tx, storedId(id));
  if (sheet === null || sheet.siteid !== siteId) throw new FixtureApiError('notFound');
  return sheet;
}

/** Ids of the blacked-out days among `days`, read in one query. */
async function blackedOutIds(tx: TenantTx, repository: TimesheetsRepository, days: readonly TimesheetDayRow[]): Promise<ReadonlySet<string>> {
  return new Set((await repository.blackoutsOfDays(tx, days.map((day) => day.day_id))).map((row) => row.day_id));
}

/** Each of `sheets` with its days in work date, then day id order, the days of all of them read in one query. */
export async function sheetsWithDays(
  tx: TenantTx,
  repository: TimesheetsRepository,
  sheets: readonly TimesheetRow[],
): Promise<Array<{ sheet: TimesheetRow; rows: TimesheetDayRow[] }>> {
  const bySheet = new Map<string, TimesheetDayRow[]>();
  for (const day of await repository.daysOfSheets(tx, sheets.map((sheet) => sheet.timesheet_id))) {
    const rows = bySheet.get(day.timesheet_id);
    if (rows === undefined) bySheet.set(day.timesheet_id, [day]);
    else rows.push(day);
  }
  return sheets.map((sheet) => ({ sheet, rows: bySheet.get(sheet.timesheet_id) ?? [] }));
}

/** Days with their blackout flags, as timesheets.cfc findDays left-joins the blackouts. */
function withBlackouts(days: readonly TimesheetDayRow[], blackedOut: ReadonlySet<string>): FixtureDaySource[] {
  return days.map((day) => ({ day, blackout: blackedOut.has(day.day_id) }));
}

/** The sheet's `usp_timesheet_status` row as of `asOf`. */
function statusOf(sheet: TimesheetRow, days: readonly FixtureDaySource[], asOf: string): SheetStatusResult {
  return deriveSheetStatus(
    days.map(({ day, blackout }) => ({ state: day.state as TimesheetState, blackout })),
    { dueDate: sheet.due_date, asOf },
  );
}

/** Reads one sheet of the site with its days and status as of `asOf`, in timesheets.cfc's order: existence, then `asOf`. */
async function sheetDetail(
  tx: TenantTx,
  deps: FixtureRouteDeps,
  call: FixtureCall,
  id: string,
): Promise<{ sheet: TimesheetRow; status: SheetStatusResult; days: FixtureDaySource[] }> {
  const sheet = await requireSheet(tx, deps.repository, id, call.siteId);
  const asOf = requireAsOf(call.ctx.params, deps.clock);
  const rows = await deps.repository.daysOfSheet(tx, sheet.timesheet_id);
  const days = withBlackouts(rows, await blackedOutIds(tx, deps.repository, rows));
  return { sheet, status: statusOf(sheet, days, asOf), days };
}

/** Renders a platform auth denial as the fixture answers it; an unregistered token site is resolveSite's invalidParameters. */
function fixtureDenialRenderer(db: TenantDb): DenialRenderer {
  return async (denial, request) => {
    const claims = (request.opt2Auth as Opt2AuthContext | null)?.user;
    // Identity mints a token without roles for an unknown site, whereas auth.cfc resolveSite rejects that site before requireAny.
    const unknownSite = denial.reason === 'forbidden' && claims !== undefined && (await tenantForRegisteredSite(db, claims.site)) === null;
    const answered = unknownSite ? new FixtureApiError('invalidParameters') : denial;
    recordOutcomeReason(request, fixtureOutcomeReason(answered));
    return toFixtureError(answered, contextOf(request));
  };
}

/** Registers the four timesheets fixture routes of the contract for GET and POST, answering their errors and auth denials in the fixture envelope. */
export const timesheetsFixturePlugin: FastifyPluginAsync<FixtureRouteDeps> = async (app, deps) => {
  const { db, repository, clock } = deps;
  const opt2: Opt2RouteConfig = { requires: FIXTURE_ROLES, transport: 'service', renderDenial: fixtureDenialRenderer(db) };
  const config = { config: { opt2 } };

  app.setErrorHandler((error, request, reply) => {
    // A LegacyServiceUnavailableError is rethrown here and answered by service-kit's handler as the legacy 503.
    const response = toFixtureError(error, contextOf(request));
    if (response.status === 500 && !(error instanceof LegacyApiError)) request.log.error({ error: serializeError(error) }, 'unhandled fixture exception');
    else recordOutcomeReason(request, fixtureOutcomeReason(error));
    return sendLegacyResponse(reply, response);
  });

  /** Registers `url` for every transport method; `handler` runs only when `method` is the effective method. */
  function register<Params>(
    url: string,
    method: (typeof TRANSPORT_METHODS)[number],
    handler: (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => Promise<FastifyReply>,
  ): void {
    app.route<{ Params: Params }>({
      method: [...TRANSPORT_METHODS],
      url,
      ...config,
      handler: async (request, reply) => {
        // timesheets.cfc handle() answers any other effective method notFound before its gate.
        if (effectiveMethod(request) !== method) throw new FixtureApiError('notFound');
        return handler(request, reply);
      },
    });
  }

  register(ROUTES.sheets, 'GET', async (request, reply) => {
    const { ctx, claims, siteId } = fixtureCall(request);
    const asOf = requireAsOf(ctx.params, clock);
    const paging = fixturePaging(ctx.params);
    const { total, items } = await withTenant(db, claims.tid, async (tx) => {
      const page = await repository.listSheets(tx, { siteid: siteId, ...paging });
      const sheets = await sheetsWithDays(tx, repository, page.rows);
      const blackedOut = await blackedOutIds(tx, repository, sheets.flatMap(({ rows }) => rows));
      return {
        total: page.total,
        items: sheets.map(({ sheet, rows }) => statusRow({ sheet, status: statusOf(sheet, withBlackouts(rows, blackedOut), asOf) })),
      };
    });
    return sendLegacyResponse(reply, fixtureList(ctx, items, { total, ...paging }));
  });

  register<IdParams>(ROUTES.sheet, 'GET', async (request, reply) => {
    const call = fixtureCall(request);
    const detail = await withTenant(db, call.claims.tid, (tx) => sheetDetail(tx, deps, call, request.params.id));
    return sendLegacyResponse(reply, fixtureSuccess(call.ctx, sheetRow(detail)));
  });

  register<IdParams>(ROUTES.sheetStatus, 'GET', async (request, reply) => {
    const call = fixtureCall(request);
    const { sheet, status } = await withTenant(db, call.claims.tid, (tx) => sheetDetail(tx, deps, call, request.params.id));
    return sendLegacyResponse(reply, fixtureSuccess(call.ctx, statusRow({ sheet, status })));
  });

  register<DayActionParams>(ROUTES.dayAction, 'POST', async (request, reply) => {
    const ctx = contextOf(request);
    // api.cfm lower-cases the action segment; timesheets.cfc answers any other action notFound before its gate.
    const action = request.params.action.toLowerCase();
    if (!isDayAction(action)) throw new FixtureApiError('notFound');
    const claims = userClaims(request);
    // auth.cfc requireAny validates the token, with the raw route id as context, before programSchema runs.
    await requireCsrf(request, reply, request.params.id);
    const { siteId } = resolveFixtureProgram(ctx.params, claims);
    const dayId = storedId(request.params.id);
    const now = clock.now();
    const result = await withGatedTenant(db, claims.tid, async (tx) => {
      const found = await repository.dayWithBlackout(tx, dayId);
      if (found === null || found.sheet.siteid !== siteId) throw new FixtureApiError('notFound');
      const comment = commentOf(ctx.params);
      return performDayAction(tx, repository, { dayId, action, roles: claims.roles, actorUserId: claims.sub, comment, now });
    });
    return sendLegacyResponse(reply, fixtureDayAction(ctx, result, dayActionResult));
  });
};
