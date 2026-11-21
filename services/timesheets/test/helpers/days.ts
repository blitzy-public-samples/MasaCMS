// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture-shaped timesheets rows for seeding the recording db and stating expected rows, and the per-tenant seed sets of the fan-out suites. */
import { cfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, asOf, type TenantFixture } from '@opt2/platform/testing';
import { TEST_CLOCK, type SeedRows } from './app.js';
import type { TimesheetAction, TimesheetRole, TimesheetState } from '../../src/domain/lifecycle.transitions.js';
import { PROGRAM_SITES } from '../../src/migration/mappings/index.js';
import {
  APPROVAL_ACTION,
  BLACKOUT,
  TIMESHEET,
  TIMESHEET_DAY,
  type ApprovalActionRow,
  type BlackoutRow,
  type TimesheetDayRow,
  type TimesheetRow,
} from '../../src/repo/tables.js';

/** Test-only `legacy_program_id` of umbrella rows: umbrella has no `Program_<id>` schema, and the column admits any integer. */
export const TEST_UMBRELLA_PROGRAM_ID = 99;

/** Person every tenant seed set's sheet belongs to, so one archive event can reach all three tenants. */
export const SHARED_PERSON_ID = cfUuid();

/** Archive effective date of the tenant seed sets, as the `yyyy-mm-dd` an archive event carries. */
export const EFFECTIVE_FROM = '2026-06-15';

const DEFAULT_PERIOD_START = '2026-06-08';
const DEFAULT_PERIOD_END = '2026-06-21';
const DEFAULT_DUE_DATE = '2026-06-26';
const DEFAULT_HOURS = '8.0000';
const HOURS_SCALE = 4;
const PERSON_ARCHIVED_REASON = 'person-archived';

const PROGRAM_FOR_SITE: ReadonlyMap<string, number> = new Map(Object.entries(PROGRAM_SITES).map(([programId, siteId]) => [siteId, Number(programId)]));

/** Options of {@link timesheetRow}; dates are `yyyy-mm-dd`, `actorId` (the person by default) is the sheet's `lastupdatebyid`. */
export interface TimesheetRowOptions {
  tenant?: TenantFixture;
  personId?: string;
  timesheetId?: string;
  periodStart?: string;
  periodEnd?: string;
  dueDate?: string;
  actorId?: string;
}

/** Options of {@link dayRow}; `workDate` is `yyyy-mm-dd`, a number of `hours` is stored with four decimals. */
export interface DayRowOptions {
  workDate: string;
  state?: TimesheetState;
  hours?: string | number;
}

/** Options of {@link approvalActionRow}: the applied transition and its actor. */
export interface ApprovalActionRowOptions {
  action: TimesheetAction;
  role: TimesheetRole;
  from: TimesheetState;
  to: TimesheetState;
  actor: string;
  comment?: string | null;
}

/** Options of {@link blackoutRow}. */
export interface BlackoutRowOptions {
  archiveId: BlackoutRow['archive_id'];
  personId: string;
}

/** One sheet with its days and the blackouts closing some of them. */
export interface SeededSheet {
  sheet: TimesheetRow;
  days: TimesheetDayRow[];
  blackouts: BlackoutRow[];
}

/** Options of {@link seedSheet}; `blackoutDays` are indexes into `states`, `workDates` (one per state) replace the consecutive dates. */
export interface SeedSheetOptions {
  personId?: string;
  states: readonly TimesheetState[];
  dueDate?: string;
  blackoutDays?: readonly number[];
  workDates?: readonly string[];
}

/** A tenant's fan-out seed set: one open day before {@link EFFECTIVE_FROM}, three open days from it, and the seed holding them. */
export interface TenantSeed {
  readonly tenant: TenantFixture;
  readonly sheet: SeededSheet;
  readonly before: TimesheetDayRow;
  readonly open: readonly TimesheetDayRow[];
  readonly seed: SeedRows;
}

/** `row` with its keys in the column order of `def`. */
function inColumnOrder<T extends Record<string, unknown>>(def: { readonly columns: readonly { readonly name: string }[] }, row: T): T {
  return Object.fromEntries(def.columns.map(({ name }) => [name, row[name]])) as T;
}

/** Local midnight of the `yyyy-mm-dd` `date`, as a `timestamp(3)` date column holds it. */
function localMidnight(date: string): Date {
  return new Date(`${asOf(date)}T00:00:00`);
}

/** The `yyyy-mm-dd` `offset` days after the local date of `start`. */
function dateAfter(start: Date, offset: number): string {
  return asOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset));
}

/** The `Program_<id>` schema `tenant`'s rows fold from, per `synthetic.program_site`; umbrella gets {@link TEST_UMBRELLA_PROGRAM_ID}. */
export function programIdForTenant(tenant: TenantFixture): number {
  if (tenant.siteId === TENANT_UMBRELLA.siteId) return TEST_UMBRELLA_PROGRAM_ID;
  const programId = PROGRAM_FOR_SITE.get(tenant.siteId);
  if (programId === undefined) throw new RangeError(`site ${JSON.stringify(tenant.siteId)} has no Program_<id> schema in synthetic.program_site`);
  return programId;
}

/** A `timesheets.timesheet` row of `tenant`'s program, created and last updated at the test clock. */
export function timesheetRow({
  tenant = TENANT_A,
  personId = cfUuid(),
  timesheetId = cfUuid(),
  periodStart = DEFAULT_PERIOD_START,
  periodEnd = DEFAULT_PERIOD_END,
  dueDate = DEFAULT_DUE_DATE,
  actorId = personId,
}: TimesheetRowOptions = {}): TimesheetRow {
  return inColumnOrder<TimesheetRow>(TIMESHEET, {
    tenant_id: tenant.tenantId,
    timesheet_id: timesheetId,
    person_id: personId,
    siteid: tenant.siteId,
    period_start: localMidnight(periodStart),
    period_end: localMidnight(periodEnd),
    due_date: localMidnight(dueDate),
    created: TEST_CLOCK.now(),
    lastupdate: TEST_CLOCK.now(),
    lastupdatebyid: actorId,
    legacy_program_id: programIdForTenant(tenant),
  });
}

/** A `timesheets.timesheet_day` row of `sheet`, last updated at the test clock by the sheet's last updater. */
export function dayRow(sheet: TimesheetRow, { workDate, state = 'DRAFT', hours = DEFAULT_HOURS }: DayRowOptions): TimesheetDayRow {
  return inColumnOrder<TimesheetDayRow>(TIMESHEET_DAY, {
    tenant_id: sheet.tenant_id,
    day_id: cfUuid(),
    timesheet_id: sheet.timesheet_id,
    work_date: localMidnight(workDate),
    hours: typeof hours === 'number' ? hours.toFixed(HOURS_SCALE) : hours,
    state,
    lastupdate: TEST_CLOCK.now(),
    lastupdatebyid: sheet.lastupdatebyid,
    legacy_program_id: sheet.legacy_program_id,
  });
}

/** The `timesheets.approval_action` audit row of a transition applied to `day` at the test clock. */
export function approvalActionRow(day: TimesheetDayRow, { action, role, from, to, actor, comment = null }: ApprovalActionRowOptions): ApprovalActionRow {
  return inColumnOrder<ApprovalActionRow>(APPROVAL_ACTION, {
    tenant_id: day.tenant_id,
    action_id: cfUuid(),
    day_id: day.day_id,
    action,
    role,
    from_state: from,
    to_state: to,
    actor_user_id: actor,
    comment,
    created: TEST_CLOCK.now(),
    legacy_program_id: day.legacy_program_id,
  });
}

/** The `timesheets.blackout` row a person archive writes for `day` at the test clock. */
export function blackoutRow(day: TimesheetDayRow, { archiveId, personId }: BlackoutRowOptions): BlackoutRow {
  return inColumnOrder<BlackoutRow>(BLACKOUT, {
    tenant_id: day.tenant_id,
    blackout_id: cfUuid(),
    day_id: day.day_id,
    person_id: personId,
    archive_id: archiveId,
    reason: PERSON_ARCHIVED_REASON,
    created: TEST_CLOCK.now(),
    legacy_program_id: day.legacy_program_id,
  });
}

/** One sheet of `tenant` with a day per entry of `states`, on consecutive dates from the period start unless `workDates` are given. */
export function seedSheet(tenant: TenantFixture, { personId, states, dueDate, blackoutDays = [], workDates }: SeedSheetOptions): SeededSheet {
  if (workDates !== undefined && workDates.length !== states.length) {
    throw new RangeError(`seedSheet got ${workDates.length} work dates for ${states.length} day states`);
  }
  const sheet = timesheetRow({ tenant, personId, dueDate });
  const days = states.map((state, index) => dayRow(sheet, { state, workDate: workDates?.[index] ?? dateAfter(sheet.period_start, index) }));
  const blackouts = blackoutDays.map((index) => {
    const day = days[index];
    if (day === undefined) throw new RangeError(`blackout day index ${index} is outside the sheet's ${days.length} days`);
    return blackoutRow(day, { archiveId: cfUuid(), personId: sheet.person_id });
  });
  return { sheet, days, blackouts };
}

/** The recording-db seed holding every row of `sheets`. */
export function toSeed(...sheets: SeededSheet[]): SeedRows {
  return {
    timesheet: sheets.map(({ sheet }) => sheet),
    timesheet_day: sheets.flatMap(({ days }) => days),
    blackout: sheets.flatMap(({ blackouts }) => blackouts),
  };
}

/** Freezes `seeded`'s rows and arrays in place so suites sharing it cannot change it. */
function freezeSheet(seeded: SeededSheet): SeededSheet {
  for (const row of [seeded.sheet, ...seeded.days, ...seeded.blackouts]) Object.freeze(row);
  Object.freeze(seeded.days);
  Object.freeze(seeded.blackouts);
  return Object.freeze(seeded);
}

/** `tenant`'s seed set: a sheet of {@link SHARED_PERSON_ID} with open days on 2026-06-12 (before) and 2026-06-15 to 2026-06-17 (open). */
function tenantSeed(tenant: TenantFixture): TenantSeed {
  const sheet = freezeSheet(
    seedSheet(tenant, {
      personId: SHARED_PERSON_ID,
      states: ['DRAFT', 'DRAFT', 'SUBMITTED', 'RETURNED'],
      workDates: ['2026-06-12', EFFECTIVE_FROM, '2026-06-16', '2026-06-17'],
    }),
  );
  const [before, ...open] = sheet.days as [TimesheetDayRow, ...TimesheetDayRow[]];
  return Object.freeze({ tenant, sheet, before, open: Object.freeze(open), seed: Object.freeze(toSeed(sheet)) });
}

/** Seed sets of tenant-a, tenant-b and umbrella, built once per process; each holds only its own tenant's rows. */
export const TENANT_SEEDS: Readonly<Record<'a' | 'b' | 'umbrella', TenantSeed>> = Object.freeze({
  a: tenantSeed(TENANT_A),
  b: tenantSeed(TENANT_B),
  umbrella: tenantSeed(TENANT_UMBRELLA),
});
