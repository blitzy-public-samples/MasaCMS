// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The only data-access path of schema `timesheets`: gated, audited writes through the platform repository and gated reads in the fixture's order. */
import { awaitReadable, createRepository, qualified, type Repository, type WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import { APPROVAL_ACTION, BLACKOUT, TIMESHEET, TIMESHEET_DAY, TIMESHEETS_SCHEMA, tables } from './tables.js';
import type { ApprovalActionRow, BlackoutRow, TimesheetDayRow, TimesheetRow } from './tables.js';

/** A row to insert; `tenant_id` defaults to the transaction tenant. */
type NewRow<R extends { tenant_id: string }> = Omit<R, 'tenant_id'> & Partial<Pick<R, 'tenant_id'>>;

/** The columns a day lifecycle action sets on day `dayId`. */
export interface DayStateUpdate {
  dayId: TimesheetDayRow['day_id'];
  state: TimesheetDayRow['state'];
  lastupdate: TimesheetDayRow['lastupdate'];
  lastupdatebyid: TimesheetDayRow['lastupdatebyid'];
}

/** The largest `itemsPerPage` of a sheet page, as envelope.cfc `page()` bounds it. */
export const MAX_SHEETS_PER_PAGE = 1000;

/** Filters and page of `listSheets`; an absent filter matches every sheet; `pageIndex` is from 1, `itemsPerPage` 1 to `MAX_SHEETS_PER_PAGE`. */
export interface SheetFilter {
  siteid?: string;
  personId?: string;
  pageIndex: number;
  itemsPerPage: number;
}

/** One page of the tenant's matching sheets and the count of all of them. */
export interface SheetPage {
  rows: TimesheetRow[];
  total: number;
}

/** A day, the sheet columns its checks read, and whether a blackout closes it. */
export interface DayWithBlackout {
  day: TimesheetDayRow;
  sheet: Pick<TimesheetRow, 'timesheet_id' | 'person_id' | 'siteid'>;
  blackout: boolean;
}

/** The person whose open days on or after `effectiveFrom` a person archive blacks out. */
export interface OpenDaysQuery {
  personId: TimesheetRow['person_id'];
  effectiveFrom: TimesheetDayRow['work_date'];
}

/** The platform repository of schema `timesheets` plus its domain writes and reads; each takes the caller's open tenant transaction. */
export type TimesheetsRepository = Repository & {
  /** Sets the day's `state`, `lastupdate` and `lastupdatebyid`; null when the day does not exist. */
  updateDayState(tx: TenantTx, update: DayStateUpdate, ctx?: WriteContext): Promise<TimesheetDayRow | null>;
  /** Inserts one `approval_action` audit row. */
  insertApprovalAction(tx: TenantTx, row: NewRow<ApprovalActionRow>, ctx?: WriteContext): Promise<ApprovalActionRow>;
  /**
   * Inserts, in one audited batch, each blackout whose day has none yet.
   * @returns the number of blackouts inserted.
   */
  insertBlackoutsIfAbsent(tx: TenantTx, rows: readonly NewRow<BlackoutRow>[], ctx?: WriteContext): Promise<number>;
  /** One page of the tenant's sheets matching `filter`, as `usp_timesheet_status_list` pages them, and their count; RangeError for paging out of bounds. */
  listSheets(tx: TenantTx, filter: SheetFilter): Promise<SheetPage>;
  /** The sheet `timesheetId`, or null. */
  getSheet(tx: TenantTx, timesheetId: string): Promise<TimesheetRow | null>;
  /** The days of sheet `timesheetId`, by work date, then day id. */
  daysOfSheet(tx: TenantTx, timesheetId: string): Promise<TimesheetDayRow[]>;
  /** The day `dayId` joined to its sheet with its blackout flag, or null; `forUpdate` row-locks the day so actions on it serialise. */
  dayWithBlackout(tx: TenantTx, dayId: string, opts?: { forUpdate?: boolean }): Promise<DayWithBlackout | null>;
  /** The blackouts of `dayIds`, by day id. */
  blackoutsOfDays(tx: TenantTx, dayIds: readonly string[]): Promise<BlackoutRow[]>;
  /** The person's days that `usp_apply_blackout` would black out, row-locked, by day id. */
  openDaysOfPerson(tx: TenantTx, query: OpenDaysQuery): Promise<TimesheetDayRow[]>;
};

/** A `dayWithBlackout` result row before it is split into day and sheet. */
type DayBlackoutRow = TimesheetDayRow & { sheet_person_id: string; sheet_siteid: string; blackout: boolean };

/** The quoted `columns`, each prefixed by `alias`. */
function columnList(columns: readonly { name: string }[], alias: string): string {
  return columns.map((column) => `${alias}."${column.name}"`).join(', ');
}

/** The read statements over `schema`. */
function statementsFor(schema: string) {
  const sheets = qualified(schema, TIMESHEET.table);
  const days = qualified(schema, TIMESHEET_DAY.table);
  const blackouts = qualified(schema, BLACKOUT.table);
  const sheetColumns = columnList(TIMESHEET.columns, 't');
  const dayColumns = columnList(TIMESHEET_DAY.columns, 'd');
  const daySheet = `${days} d JOIN ${sheets} t ON t."tenant_id" = d."tenant_id" AND t."timesheet_id" = d."timesheet_id"`;
  const dayBlackout = `SELECT 1 FROM ${blackouts} b WHERE b."tenant_id" = d."tenant_id" AND b."day_id" = d."day_id"`;
  const sheetFilter = ` WHERE ($1::text IS NULL OR t."siteid" = $1::text) AND ($2::bpchar IS NULL OR t."person_id" = $2::bpchar)`;
  // Ids are fixed-format uppercase CF UUIDs, so byte order ("C") equals the fixture's Latin1_General_BIN2 and its default collation;
  // bpchar casts compare ids as the char(35) columns store them, without truncating a longer argument.
  return Object.freeze({
    countSheets: `SELECT count(*)::integer AS "total" FROM ${sheets} t${sheetFilter}`,
    // timesheet_list_idx carries the tenant and this order, so a page is read in index order.
    sheets:
      `SELECT ${sheetColumns} FROM ${sheets} t${sheetFilter}` +
      ' ORDER BY t."period_start", t."person_id" COLLATE "C", t."timesheet_id" COLLATE "C" LIMIT $3 OFFSET $4',
    sheet: `SELECT ${sheetColumns} FROM ${sheets} t WHERE t."timesheet_id" = $1::bpchar`,
    daysOfSheet: `SELECT ${dayColumns} FROM ${days} d WHERE d."timesheet_id" = $1::bpchar ORDER BY d."work_date", d."day_id" COLLATE "C"`,
    lockDay: `SELECT 1 FROM ${days} WHERE "day_id" = $1::bpchar FOR UPDATE`,
    dayWithBlackout:
      `SELECT ${dayColumns}, t."person_id" AS sheet_person_id, t."siteid" AS sheet_siteid, EXISTS (${dayBlackout}) AS blackout` +
      ` FROM ${daySheet} WHERE d."day_id" = $1::bpchar`,
    blackoutsOfDays:
      `SELECT ${columnList(BLACKOUT.columns, 'b')} FROM ${blackouts} b WHERE b."day_id" = ANY($1::bpchar[]) ORDER BY b."day_id" COLLATE "C"`,
    // usp_apply_blackout's predicate, its UPDLOCK on every candidate day before any blackout key, and its @days (day_id key) order.
    openDaysOfPerson:
      `SELECT ${dayColumns} FROM ${daySheet} WHERE t."person_id" = $1::bpchar AND d."state" <> 'APPROVED' AND d."work_date" >= $2` +
      ` AND NOT EXISTS (${dayBlackout}) ORDER BY d."day_id" COLLATE "C" FOR UPDATE OF d`,
  });
}

/**
 * Builds the timesheets repository over the platform repository of `tables`; `src/app.ts` hands it to the migration handlers and routes.
 * @param options `schema` differs from `timesheets` only in throwaway test schemas, because the platform repository requires it to equal `tx.schema`.
 */
export function createTimesheetsRepository(options: { clock?: Clock; schema?: string } = {}): TimesheetsRepository {
  const schema = options.schema ?? TIMESHEETS_SCHEMA;
  const base = createRepository({ owner: 'timesheets', schema, tables, clock: options.clock });
  const sql = statementsFor(schema);

  function updateDayState(
    tx: TenantTx,
    { dayId, state, lastupdate, lastupdatebyid }: DayStateUpdate,
    ctx?: WriteContext,
  ): Promise<TimesheetDayRow | null> {
    return base.update<TimesheetDayRow>(tx, TIMESHEET_DAY.table, { day_id: dayId }, { state, lastupdate, lastupdatebyid }, ctx);
  }

  function insertApprovalAction(tx: TenantTx, row: NewRow<ApprovalActionRow>, ctx?: WriteContext): Promise<ApprovalActionRow> {
    return base.insert<ApprovalActionRow>(tx, APPROVAL_ACTION.table, row, ctx);
  }

  async function insertBlackoutsIfAbsent(tx: TenantTx, rows: readonly NewRow<BlackoutRow>[], ctx?: WriteContext): Promise<number> {
    // UNIQUE (tenant_id, day_id): a day already blacked out is skipped and gets no changelog row.
    return (await base.insertAbsent(tx, BLACKOUT.table, rows, ['day_id'], ctx)).length;
  }

  async function listSheets(tx: TenantTx, { siteid, personId, pageIndex, itemsPerPage }: SheetFilter): Promise<SheetPage> {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 1 || !Number.isInteger(itemsPerPage) || itemsPerPage < 1 || itemsPerPage > MAX_SHEETS_PER_PAGE) {
      throw new RangeError(`Sheet page out of range: pageIndex ${pageIndex}, itemsPerPage ${itemsPerPage}`);
    }
    await awaitReadable(tx, [TIMESHEET.unit]);
    const filter = [siteid ?? null, personId ?? null];
    const [{ total }] = (await tx.query<{ total: number }>(sql.countSheets, filter)).rows as [{ total: number }];
    const offset = (pageIndex - 1) * itemsPerPage;
    if (offset >= total) return { rows: [], total };
    return { rows: (await tx.query<TimesheetRow>(sql.sheets, [...filter, itemsPerPage, offset])).rows, total };
  }

  async function getSheet(tx: TenantTx, timesheetId: string): Promise<TimesheetRow | null> {
    await awaitReadable(tx, [TIMESHEET.unit]);
    return (await tx.query<TimesheetRow>(sql.sheet, [timesheetId])).rows[0] ?? null;
  }

  async function daysOfSheet(tx: TenantTx, timesheetId: string): Promise<TimesheetDayRow[]> {
    await awaitReadable(tx, [TIMESHEET_DAY.unit]);
    return (await tx.query<TimesheetDayRow>(sql.daysOfSheet, [timesheetId])).rows;
  }

  async function dayWithBlackout(tx: TenantTx, dayId: string, opts: { forUpdate?: boolean } = {}): Promise<DayWithBlackout | null> {
    await awaitReadable(tx, [TIMESHEET_DAY.unit, TIMESHEET.unit, BLACKOUT.unit]);
    if (opts.forUpdate === true) {
      // The lock is its own statement so the read below takes its snapshot after the lock is granted and sees a blackout the
      // lock holder committed, as usp_timesheet_day_action checks the blackout only after locking the day.
      await tx.query(sql.lockDay, [dayId]);
    }
    const found = (await tx.query<DayBlackoutRow>(sql.dayWithBlackout, [dayId])).rows[0];
    if (found === undefined) return null;
    const { sheet_person_id, sheet_siteid, blackout, ...day } = found;
    return { day, sheet: { timesheet_id: day.timesheet_id, person_id: sheet_person_id, siteid: sheet_siteid }, blackout };
  }

  async function blackoutsOfDays(tx: TenantTx, dayIds: readonly string[]): Promise<BlackoutRow[]> {
    if (dayIds.length === 0) return [];
    await awaitReadable(tx, [BLACKOUT.unit]);
    return (await tx.query<BlackoutRow>(sql.blackoutsOfDays, [dayIds])).rows;
  }

  async function openDaysOfPerson(tx: TenantTx, { personId, effectiveFrom }: OpenDaysQuery): Promise<TimesheetDayRow[]> {
    await awaitReadable(tx, [TIMESHEET_DAY.unit, TIMESHEET.unit, BLACKOUT.unit]);
    return (await tx.query<TimesheetDayRow>(sql.openDaysOfPerson, [personId, effectiveFrom])).rows;
  }

  // The platform repository is frozen and its methods are closures, so spreading keeps every base method working.
  return Object.freeze({
    ...base,
    updateDayState,
    insertApprovalAction,
    insertBlackoutsIfAbsent,
    listSheets,
    getSheet,
    daysOfSheet,
    dayWithBlackout,
    blackoutsOfDays,
    openDaysOfPerson,
  });
}
