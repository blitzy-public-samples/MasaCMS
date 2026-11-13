// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/timesheets` routes of the OPT-2 timesheets screens and of reporting's sheet-status export read, answered as plain JSON. */
import { AuthDenial, Roles, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import { LEGACY_ERROR_MAP, buildEnvelope, cfDateTimeFormat, errorSpec, type LegacyErrorSpec } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import type { Clock, FastifyPluginAsync, FastifyReply, FastifyRequest } from '@opt2/platform/service-kit';
import { TransitionRejectedError, decide } from '@opt2/platform/state-machine';
import { withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { performDayAction, type DayActionResult as DayActionOutcome } from '../domain/day-action.js';
import { TIMESHEET_ACTIONS, timesheetsLifecycle, type TimesheetAction, type TimesheetState } from '../domain/lifecycle.transitions.js';
import { deriveSheetStatus, type SheetStatusResult } from '../domain/sheet-status.js';
import type { components } from '../generated/openapi.js';
import { MAX_SHEETS_PER_PAGE, type DayWithBlackout, type TimesheetsRepository } from '../repo/repository.js';
import type { TimesheetDayRow, TimesheetRow } from '../repo/tables.js';
import { parseFixtureAsOf } from './fixture.js';

// Declared here rather than imported from the route registry, which imports this module; the registry's deps stay assignable.
/** Options of the `/v1` plugin: the timesheets tenant database, repository and injected clock. */
type V1RouteDeps = { db: TenantDb; repository: TimesheetsRepository; clock: Clock };

type Schemas = components['schemas'];
type Timesheet = Schemas['Timesheet'];
type TimesheetDay = Schemas['TimesheetDay'];
type TimesheetDetail = Schemas['TimesheetDetail'];
type TimesheetList = Schemas['TimesheetList'];
type SheetStatusRow = Schemas['SheetStatusRow'];
type SheetStatusList = Schemas['SheetStatusList'];
type DayActionResult = Schemas['DayActionResult'];

/** A sheet with each of its days and the day's blackout flag, in work date order. */
type SheetWithDays = { sheet: TimesheetRow; days: Array<Pick<DayWithBlackout, 'day' | 'blackout'>> };

type LegalDayAction = Extract<DayActionOutcome, { outcome: 'legal' }>;

/** `asOf` arrives as the raw query value; `parseFixtureAsOf` is its only parser. */
type AsOfQuery = { asOf?: unknown };
type SheetListQuery = AsOfQuery & { pageIndex: number; itemsPerPage: number };
type IdParams = { id: string };
type DayActionParams = IdParams & { action: string };

const SHEETS_PATH = '/v1/timesheets/sheets';
const SHEET_PATH = `${SHEETS_PATH}/:id`;
const DAY_ACTION_PATH = '/v1/timesheets/days/:id/:action';
const SHEET_STATUS_PATH = '/v1/timesheets/sheet-status';

// Envelope `method` of v1 errors, named as the fixture names the same operations.
const SHEETS_METHOD = 'timesheets.sheets';
const SHEET_STATUS_METHOD = 'timesheets.sheet-status';

const DAY_ROLES: readonly string[] = Object.freeze([
  Roles.timesheetsEmployee,
  Roles.timesheetsPrimaryApprover,
  Roles.timesheetsSecondaryApprover,
]);

const SHEET_ACCESS: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: DAY_ROLES });

/** Reporting's export reads the status rows as the exporter, beside the approvers. */
const SHEET_STATUS_ACCESS: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.reportingExporter, Roles.timesheetsPrimaryApprover, Roles.timesheetsSecondaryApprover]),
});

const DEFAULT_PAGE_INDEX = 1;
const DEFAULT_ITEMS_PER_PAGE = 50;

// pageIndex is bounded where the repository's offset arithmetic stays exact, so a larger value is a 400 rather than a RangeError.
const SHEET_LIST_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    pageIndex: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: DEFAULT_PAGE_INDEX },
    itemsPerPage: { type: 'integer', minimum: 1, maximum: MAX_SHEETS_PER_PAGE, default: DEFAULT_ITEMS_PER_PAGE },
  },
} as const;

/** 404 of a sheet or day outside the tenant, and of an action the lifecycle does not name. */
const NOT_FOUND: LegacyErrorSpec = Object.freeze({ status: 404, code: LEGACY_ERROR_MAP.invalidParameters.code, message: 'Not Found' });

const LOCAL_DATE_TIME_MASK = "yyyy-mm-dd'T'HH:nn:ss";

/** A stored `timestamp` as the contract's LocalDateTime, in the legacy server's zone. */
function localDateTime(value: Date): string {
  return cfDateTimeFormat(value, LOCAL_DATE_TIME_MASK);
}

/** As `localDateTime`, keeping NULL as null. */
function nullableDateTime(value: Date | null): string | null {
  return value === null ? null : localDateTime(value);
}

/** A path id as the stored upper-case CF UUID it names, so ids match ignoring case as the fixture's SQL Server matches them. */
function storedId(id: string): string {
  return id.toUpperCase();
}

/** Whether `segment` names a timesheet day action. */
function isDayAction(segment: string): segment is TimesheetAction {
  return (TIMESHEET_ACTIONS as readonly string[]).includes(segment);
}

/** Envelope `method` of the matched route's v1 errors: `timesheets.<resource>[.<action>]`. */
function methodOf(request: FastifyRequest): string {
  switch (request.routeOptions.url) {
    case DAY_ACTION_PATH:
      return `timesheets.days.${(request.params as DayActionParams).action.toLowerCase()}`;
    case SHEET_STATUS_PATH:
      return SHEET_STATUS_METHOD;
    default:
      return SHEETS_METHOD;
  }
}

/** Sends the v1 error body of `spec` at its status: the legacy error envelope of `method`, `code` before `message`. */
function sendError(reply: FastifyReply, method: string, { status, code, message }: LegacyErrorSpec): FastifyReply {
  return reply.code(status).send(buildEnvelope({ method, error: { code, message } }));
}

/** Whether `error` is Fastify's schema validation failure of the request. */
function isValidationError(error: unknown): boolean {
  return error instanceof Error && 'validation' in error && error.validation !== undefined;
}

/** The 400 `invalidParameters` spec carrying `message`. */
function invalidParameters(message: string): LegacyErrorSpec {
  return { ...LEGACY_ERROR_MAP.invalidParameters, message };
}

/** The verified user claims, the only source of the tenant; a request without them is refused with 403. */
function claimsOf(request: FastifyRequest): UserClaims {
  const { user } = request.opt2Auth;
  if (user === undefined) throw AuthDenial.forbidden('missing-credential');
  return user;
}

/** The day actions `roles` may take on a day in `state`, as the lifecycle decides them; none on a blackout or terminal day. */
export function allowedActions(state: TimesheetState, roles: readonly string[], blackout: boolean): TimesheetAction[] {
  return TIMESHEET_ACTIONS.filter((action) => decide(timesheetsLifecycle, { state, action, roles, guards: { blackout } }).outcome === 'ok');
}

/** Each of `sheets` with its days, their blackout flags read in one query. */
async function withDays(tx: TenantTx, repository: TimesheetsRepository, sheets: readonly TimesheetRow[]): Promise<SheetWithDays[]> {
  const read: Array<{ sheet: TimesheetRow; days: TimesheetDayRow[] }> = [];
  for (const sheet of sheets) read.push({ sheet, days: await repository.daysOfSheet(tx, sheet.timesheet_id) });
  const dayIds = read.flatMap(({ days }) => days.map((day) => day.day_id));
  const blackedOut = new Set((await repository.blackoutsOfDays(tx, dayIds)).map((blackout) => blackout.day_id));
  return read.map(({ sheet, days }) => ({ sheet, days: days.map((day) => ({ day, blackout: blackedOut.has(day.day_id) })) }));
}

/** The sheet's status, overdue flag and day counts as of `asOf`. */
function statusOf({ sheet, days }: SheetWithDays, asOf: string): SheetStatusResult {
  return deriveSheetStatus(
    days.map(({ day, blackout }) => ({ state: day.state as TimesheetState, blackout })),
    { dueDate: sheet.due_date, asOf },
  );
}

/** The contract `Timesheet` of a sheet and its derived status. */
function timesheetOf(sheet: TimesheetRow, status: SheetStatusResult): Timesheet {
  return {
    timesheetId: sheet.timesheet_id,
    siteId: sheet.siteid,
    personId: sheet.person_id,
    periodStart: localDateTime(sheet.period_start),
    periodEnd: localDateTime(sheet.period_end),
    dueDate: localDateTime(sheet.due_date),
    created: localDateTime(sheet.created),
    lastUpdate: nullableDateTime(sheet.lastupdate),
    lastUpdateById: sheet.lastupdatebyid,
    status: status.status,
    overdue: status.overdue,
  };
}

/** The contract `TimesheetDay` of a day, with the actions `roles` may take on it. */
function timesheetDayOf({ day, blackout }: Pick<DayWithBlackout, 'day' | 'blackout'>, roles: readonly string[]): TimesheetDay {
  const state = day.state as TimesheetState;
  return {
    dayId: day.day_id,
    timesheetId: day.timesheet_id,
    workDate: localDateTime(day.work_date),
    hours: day.hours,
    state,
    blackout,
    lastUpdate: nullableDateTime(day.lastupdate),
    lastUpdateById: day.lastupdatebyid,
    allowedActions: allowedActions(state, roles, blackout),
  };
}

/** The contract `SheetStatusRow` of a sheet as of `asOf`, as `tvf_timesheet_status` returns it. */
function statusRowOf(read: SheetWithDays, asOf: string): SheetStatusRow {
  const { status, overdue, dayCount, blackoutCount, approvedCount } = statusOf(read, asOf);
  return {
    timesheetId: read.sheet.timesheet_id,
    siteId: read.sheet.siteid,
    personId: read.sheet.person_id,
    periodStart: localDateTime(read.sheet.period_start),
    status,
    overdue,
    dayCount,
    blackoutCount,
    approvedCount,
  };
}

/** The contract `DayActionResult` of a legal action; the day carries no blackout, since the blackout guard rejects every action. */
function dayActionResultOf({ day, approvalAction, to }: LegalDayAction): DayActionResult {
  return {
    dayId: day.day_id,
    timesheetId: day.timesheet_id,
    action: approvalAction.action as TimesheetAction,
    fromState: approvalAction.from_state as TimesheetState,
    toState: to,
    actionId: approvalAction.action_id,
    workDate: localDateTime(day.work_date),
    hours: day.hours,
    blackout: false,
  };
}

/** The optional audit comment of the request body: null when absent, undefined when the body holds a non-string comment. */
function commentOf(body: unknown): string | null | undefined {
  const comment = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).comment : undefined;
  if (comment === undefined) return null;
  return typeof comment === 'string' ? comment : undefined;
}

/** Registers `listSheets`, `getSheet`, `dayAction` and `listSheetStatus`, with an error handler encapsulated to them. */
export const timesheetsV1Plugin: FastifyPluginAsync<V1RouteDeps> = async (app, { db, repository, clock }) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof TransitionRejectedError) {
      return reply.code(error.statusCode).send(error.toEnvelope({ method: methodOf(request) }));
    }
    if (error instanceof AuthDenial) {
      if (error.wwwAuthenticate !== undefined) reply.header('WWW-Authenticate', error.wwwAuthenticate);
      return sendError(reply, methodOf(request), { ...errorSpec(error.type), status: error.statusCode });
    }
    // Query schema failures answer in the same v1 400 body as the handlers' own parameter checks.
    if (isValidationError(error)) return sendError(reply, methodOf(request), LEGACY_ERROR_MAP.invalidParameters);
    // A gate wait's LegacyServiceUnavailableError, like any other error, is answered by service-kit's handler.
    throw error;
  });

  app.get<{ Querystring: SheetListQuery }>(
    SHEETS_PATH,
    { config: { opt2: SHEET_ACCESS }, schema: { querystring: SHEET_LIST_QUERY_SCHEMA } },
    async (request, reply) => {
      const claims = claimsOf(request);
      const asOf = parseFixtureAsOf(request.query.asOf, clock);
      if (!asOf.ok) return sendError(reply, SHEETS_METHOD, invalidParameters(asOf.message));
      const { pageIndex, itemsPerPage } = request.query;
      const body = await withTenant(db, claims.tid, async (tx): Promise<TimesheetList> => {
        const page = await repository.listSheets(tx, { pageIndex, itemsPerPage });
        const sheets = await withDays(tx, repository, page.rows);
        return { items: sheets.map((read) => timesheetOf(read.sheet, statusOf(read, asOf.asOf))), total: page.total };
      });
      return reply.code(200).send(body);
    },
  );

  app.get<{ Params: IdParams; Querystring: AsOfQuery }>(SHEET_PATH, { config: { opt2: SHEET_ACCESS } }, async (request, reply) => {
    const claims = claimsOf(request);
    const asOf = parseFixtureAsOf(request.query.asOf, clock);
    if (!asOf.ok) return sendError(reply, SHEETS_METHOD, invalidParameters(asOf.message));
    const id = storedId(request.params.id);
    const read = await withTenant(db, claims.tid, async (tx): Promise<SheetWithDays | undefined> => {
      const sheet = await repository.getSheet(tx, id);
      return sheet === null ? undefined : (await withDays(tx, repository, [sheet]))[0];
    });
    if (read === undefined) return sendError(reply, SHEETS_METHOD, NOT_FOUND);
    const detail: TimesheetDetail = {
      ...timesheetOf(read.sheet, statusOf(read, asOf.asOf)),
      days: read.days.map((day) => timesheetDayOf(day, claims.roles)),
    };
    return reply.code(200).send(detail);
  });

  app.post<{ Params: DayActionParams }>(DAY_ACTION_PATH, { config: { opt2: SHEET_ACCESS } }, async (request, reply) => {
    const claims = claimsOf(request);
    const { action } = request.params;
    if (!isDayAction(action)) return sendError(reply, methodOf(request), NOT_FOUND);
    const comment = commentOf(request.body);
    if (comment === undefined) return sendError(reply, methodOf(request), LEGACY_ERROR_MAP.invalidParameters);
    const dayId = storedId(request.params.id);
    const now = clock.now();
    const result = await withGatedTenant(db, claims.tid, (tx) =>
      performDayAction(tx, repository, { dayId, action, roles: claims.roles, actorUserId: claims.sub, comment, now }),
    );
    if (result.outcome === 'not-found') return sendError(reply, methodOf(request), NOT_FOUND);
    return reply.code(200).send(dayActionResultOf(result));
  });

  app.get<{ Querystring: AsOfQuery }>(SHEET_STATUS_PATH, { config: { opt2: SHEET_STATUS_ACCESS } }, async (request, reply) => {
    const claims = claimsOf(request);
    // The contract's shared AsOf parameter is optional here too, so an absent asOf reads as today, as on the other reads.
    const asOf = parseFixtureAsOf(request.query.asOf, clock);
    if (!asOf.ok) return sendError(reply, SHEET_STATUS_METHOD, invalidParameters(asOf.message));
    const items = await withTenant(db, claims.tid, async (tx): Promise<SheetStatusRow[]> => {
      const rows: SheetStatusRow[] = [];
      for (let pageIndex = 1; ; pageIndex += 1) {
        const page = await repository.listSheets(tx, { pageIndex, itemsPerPage: MAX_SHEETS_PER_PAGE });
        for (const read of await withDays(tx, repository, page.rows)) rows.push(statusRowOf(read, asOf.asOf));
        if (pageIndex * MAX_SHEETS_PER_PAGE >= page.total) return rows;
      }
    });
    const body: SheetStatusList = { items };
    return reply.code(200).send(body);
  });
};
