// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { roleGroupName, siteForProgram, type SiteKey } from '../config.js';
import { fixtureKeys, specForKey, type FixtureContext, type FixtureRow, type FixtureTables } from '../fixture-tables.js';
import { cfUuidFrom } from '../ids.js';
import { formatUnits, units } from '../money.js';
import type { SeedRandom } from '../random.js';
import type { Calendar } from '../time.js';

type DayState = 'DRAFT' | 'SUBMITTED' | 'RESUBMITTED' | 'PRIMARY_APPROVED' | 'APPROVED' | 'RETURNED';
type DayAction = 'submit' | 'primary-approve' | 'secondary-approve' | 'return' | 'resubmit';
type ApproverRole = 'timesheets.primary-approver' | 'timesheets.secondary-approver';
type DayRole = 'timesheets.employee' | ApproverRole;

interface Transition {
  readonly from: readonly DayState[];
  readonly action: DayAction;
  readonly role: DayRole;
  readonly to: DayState;
}

const MODULE = 'timesheets';
const EMPLOYEE = 'timesheets.employee' satisfies DayRole;
const PRIMARY_APPROVER = 'timesheets.primary-approver' satisfies ApproverRole;
const SECONDARY_APPROVER = 'timesheets.secondary-approver' satisfies ApproverRole;

const TRANSITIONS: readonly Transition[] = Object.freeze([
  { from: ['DRAFT'], action: 'submit', role: 'timesheets.employee', to: 'SUBMITTED' },
  { from: ['SUBMITTED', 'RESUBMITTED'], action: 'primary-approve', role: 'timesheets.primary-approver', to: 'PRIMARY_APPROVED' },
  { from: ['PRIMARY_APPROVED'], action: 'secondary-approve', role: 'timesheets.secondary-approver', to: 'APPROVED' },
  { from: ['SUBMITTED', 'RESUBMITTED'], action: 'return', role: 'timesheets.primary-approver', to: 'RETURNED' },
  { from: ['PRIMARY_APPROVED'], action: 'return', role: 'timesheets.secondary-approver', to: 'RETURNED' },
  { from: ['RETURNED'], action: 'resubmit', role: 'timesheets.employee', to: 'RESUBMITTED' },
]);

/** The transition `action` takes from `state`; throws when the lifecycle has none. */
function transition(state: DayState, action: DayAction): Transition {
  const found = TRANSITIONS.find((row) => row.action === action && row.from.includes(state));
  if (found === undefined) throw new Error(`Illegal timesheet day step: ${action} from ${state}`);
  return found;
}

/** Action sequences a seeded day takes from DRAFT. */
const CHAINS = Object.freeze({
  draft: [],
  submitted: ['submit'],
  primaryApproved: ['submit', 'primary-approve'],
  approved: ['submit', 'primary-approve', 'secondary-approve'],
  returnedPrimary: ['submit', 'return'],
  returnedSecondary: ['submit', 'primary-approve', 'return'],
  resubmitted: ['submit', 'return', 'resubmit'],
  reapproved: ['submit', 'return', 'resubmit', 'primary-approve', 'secondary-approve'],
  reprimary: ['submit', 'primary-approve', 'return', 'resubmit', 'primary-approve'],
} as const satisfies Record<string, readonly DayAction[]>);

type ChainName = keyof typeof CHAINS;
type ChainWeights = readonly (readonly [ChainName, number])[];

const FINAL_STATE: Readonly<Record<ChainName, DayState>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CHAINS).map(([name, chain]) => [
      name,
      chain.reduce<DayState>((state, action) => transition(state, action).to, 'DRAFT'),
    ]),
  ) as Record<ChainName, DayState>,
);

const SETTLED_DAY: ChainWeights = [['approved', 0.92], ['reapproved', 0.08]];
const PENDING_DAY: ChainWeights = [['submitted', 0.4], ['primaryApproved', 0.4], ['resubmitted', 0.15], ['reprimary', 0.05]];
const RETURNED_DAY: ChainWeights = [['returnedPrimary', 0.7], ['returnedSecondary', 0.3]];
const MIXED_DAY: ChainWeights = [
  ['approved', 0.45],
  ['reapproved', 0.05],
  ['submitted', 0.2],
  ['primaryApproved', 0.2],
  ['resubmitted', 0.1],
];
const OPEN_DAY: ChainWeights = [['submitted', 0.6], ['primaryApproved', 0.4]];
const CURRENT_DAY: ChainWeights = [['draft', 0.1], ['submitted', 0.5], ['primaryApproved', 0.25], ['approved', 0.15]];

/** Shape of a past sheet, each yielding one `tvf_timesheet_status` status; `overdue` sheets stay DRAFT. */
type SheetKind = 'approved' | 'partial' | 'returned' | 'submitted' | 'overdue';
type KindWeights = readonly (readonly [SheetKind, number])[];

const SHEET_KINDS: readonly SheetKind[] = ['approved', 'partial', 'returned', 'submitted', 'overdue'];
const RESERVED_KINDS: readonly SheetKind[] = ['submitted', 'returned', 'overdue'];
const RECENT_AGE = 2;
const RECENT_SHEET: KindWeights = [['approved', 0.45], ['partial', 0.15], ['returned', 0.12], ['submitted', 0.18], ['overdue', 0.1]];
const OLDER_SHEET: KindWeights = [['approved', 0.85], ['partial', 0.04], ['returned', 0.04], ['submitted', 0.02], ['overdue', 0.05]];

const MINUTES_PER_DAY = 1440;
const WORKDAYS_PER_WEEK = 5;
const WEEKS_PER_PERIOD = 4;
const PERIOD_DAYS = 7 * WEEKS_PER_PERIOD;
const PERIOD_WORKDAYS = WORKDAYS_PER_WEEK * WEEKS_PER_PERIOD;
const DUE_DAYS_AFTER_END = 3;
const LATEST_PERIOD_CHOICES = 3;
const MAX_RETURNED_DAYS = 3;
const CREATED_MINUTES: readonly [number, number] = [0, 119];
const SUBMIT_MINUTES: readonly [number, number] = [16 * 60, 20 * 60 - 1];
const MAX_STEP_GAP_MINUTES = 4 * MINUTES_PER_DAY;
// Minutes from business-date midnight of the last instant an action may take.
const LAST_ACTION_MINUTE = -1;
const HOURS_FULL = formatUnits(units(8));
const HOURS_SHORT = formatUnits(units(7, 5000));
const HOURS_NONE = formatUnits(units(0));
const RETURN_COMMENTS: readonly string[] = [
  'Hours do not match the project log.',
  'Add the missing project code and resubmit.',
  'Overtime needs prior approval.',
  'Split the hours by cost centre.',
];

interface ProgramRows {
  timesheet: FixtureRow[];
  timesheet_day: FixtureRow[];
  approval_action: FixtureRow[];
  blackout: FixtureRow[];
}

/** A past sheet of one employee, `age` periods before the latest one, starting at day offset `start`. */
interface Slot {
  readonly age: number;
  readonly start: number;
  readonly reserved: boolean;
}

/** One employee with their stream, latest period start and approvers. */
interface Employee {
  readonly personId: string;
  readonly rng: SeedRandom;
  readonly reserved: boolean;
  readonly latestStart: number;
  readonly approvers: Readonly<Record<ApproverRole, string>>;
  readonly slots: readonly Slot[];
}

/** Last change of a row: timestamp and user. */
interface Touch {
  at: string;
  by: string;
}

/** Sheets per employee and the employees of `site`; throws when the counts do not split into whole four-week sheets. */
function layout(ctx: FixtureContext, site: SiteKey): { perEmployee: number; personIds: readonly string[] } {
  const { timesheetDays, daysPerTimesheet, timesheetEmployees } = ctx.config.sites[site].counts;
  if (timesheetDays === 0) return { perEmployee: 0, personIds: [] };
  const perEmployee = timesheetDays / daysPerTimesheet / timesheetEmployees;
  if (daysPerTimesheet !== PERIOD_WORKDAYS || !Number.isInteger(perEmployee)) {
    throw new RangeError(
      `Site ${site}: ${timesheetDays} days do not fill whole ${PERIOD_WORKDAYS}-day sheets for ${timesheetEmployees} employees`,
    );
  }
  const group = roleGroupName(ctx.config, EMPLOYEE);
  const personIds = ctx.index.membersOf(ctx.index.site(site).privateUserPoolID, group).slice(0, timesheetEmployees);
  if (personIds.length < timesheetEmployees) throw new RangeError(`Site ${site} has fewer than ${timesheetEmployees} members of ${group}`);
  return { perEmployee, personIds };
}

/** Draws each employee's latest period start and approvers, and lists their past sheets. */
function planEmployees(
  ctx: FixtureContext,
  site: SiteKey,
  siteRng: SeedRandom,
  personIds: readonly string[],
  perEmployee: number,
): Employee[] {
  const latestMonday = ctx.calendar.mondayOnOrBefore(0);
  const primaries = ctx.index.actors(site, PRIMARY_APPROVER);
  const secondaries = ctx.index.actors(site, SECONDARY_APPROVER);
  return personIds.map((personId) => {
    const rng = siteRng.fork(`person/${personId}`);
    const reserved = ctx.index.isReserved(personId);
    const latestStart = latestMonday - 7 * rng.int(0, LATEST_PERIOD_CHOICES - 1);
    const approvers = { [PRIMARY_APPROVER]: rng.pick(primaries), [SECONDARY_APPROVER]: rng.pick(secondaries) };
    const slots = Array.from({ length: perEmployee - 1 }, (_, i): Slot => ({
      age: i + 1,
      start: latestStart - PERIOD_DAYS * (i + 1),
      reserved,
    }));
    return { personId, rng, reserved, latestStart, approvers, slots };
  });
}

/** Day offset of the due date of the sheet starting at day offset `start`. */
function dueOffset(start: number): number {
  return start + PERIOD_DAYS - 1 + DUE_DAYS_AFTER_END;
}

function kindAllowed(slot: Slot, kind: SheetKind): boolean {
  return (kind !== 'overdue' || dueOffset(slot.start) < 0) && (!slot.reserved || RESERVED_KINDS.includes(kind));
}

/** Kind of every past sheet; each kind lands at least once on a non-reserved sheet, the rest are drawn by age. */
function assignKinds(rng: SeedRandom, slots: readonly Slot[]): Map<Slot, SheetKind> {
  const kinds = new Map<Slot, SheetKind>();
  const order = rng.shuffle(slots);
  for (const kind of SHEET_KINDS) {
    const slot = order.find((candidate) => !kinds.has(candidate) && !candidate.reserved && kindAllowed(candidate, kind));
    if (slot === undefined) throw new RangeError(`No past timesheet can take the ${kind} shape`);
    kinds.set(slot, kind);
  }
  for (const slot of slots) {
    if (kinds.has(slot)) continue;
    const weights = slot.age <= RECENT_AGE ? RECENT_SHEET : OLDER_SHEET;
    kinds.set(slot, rng.weighted(weights.filter(([kind]) => kindAllowed(slot, kind))));
  }
  return kinds;
}

/** Day offsets of the Monday-to-Friday work days of the period starting at `start`. */
function workDays(start: number): number[] {
  return Array.from({ length: PERIOD_WORKDAYS }, (_, i) =>
    start + 7 * Math.floor(i / WORKDAYS_PER_WEEK) + (i % WORKDAYS_PER_WEEK),
  );
}

/** Work days of a sheet starting at `start`, each with its chain; days on or after the business date stay DRAFT. */
function dayPlan(rng: SeedRandom, kind: SheetKind | 'current', start: number, reserved: boolean): (readonly [number, ChainName])[] {
  const offsets = workDays(start);
  const draw = (weights: ChainWeights): ChainName =>
    rng.weighted(reserved ? weights.filter(([name]) => FINAL_STATE[name] !== 'APPROVED') : weights);
  const plan = (choose: (offset: number, i: number) => ChainName) =>
    offsets.map((offset, i) => [offset, choose(offset, i)] as const);
  switch (kind) {
    case 'current':
      return plan((offset) => (offset < 0 ? draw(CURRENT_DAY) : 'draft'));
    case 'approved':
      return plan(() => draw(SETTLED_DAY));
    case 'partial': {
      const cut = rng.int(1, offsets.length - 1);
      return plan((_, i) => draw(i < cut ? SETTLED_DAY : PENDING_DAY));
    }
    case 'returned': {
      const returned = new Set(rng.pickMany([...offsets.keys()], rng.int(1, MAX_RETURNED_DAYS)));
      return plan((_, i) => draw(returned.has(i) ? RETURNED_DAY : MIXED_DAY));
    }
    case 'submitted':
      return plan(() => draw(PENDING_DAY));
    case 'overdue': {
      const done = WORKDAYS_PER_WEEK * rng.int(0, WEEKS_PER_PERIOD - 1);
      return plan((_, i) => (i < done ? draw(OPEN_DAY) : 'draft'));
    }
  }
}

/** Appends one sheet starting at day offset `start`, with its days and their approval actions, to `out`. */
function buildSheet(
  calendar: Calendar,
  site: SiteKey,
  employee: Employee,
  start: number,
  kind: SheetKind | 'current',
  out: ProgramRows,
): void {
  const { rng, personId } = employee;
  const stamp = (minutes: number): string => calendar.localTimestamp(0, minutes, rng.int(0, 99) * 10);
  const timesheetId = cfUuidFrom(rng);
  const created = stamp(start * MINUTES_PER_DAY + rng.int(...CREATED_MINUTES));
  const days: FixtureRow[] = [];
  const actions: FixtureRow[] = [];
  let sheetTouch: Touch = { at: created, by: personId };

  for (const [offset, name] of dayPlan(rng, kind, start, employee.reserved)) {
    const chain: readonly DayAction[] = CHAINS[name];
    const dayId = cfUuidFrom(rng);
    const hours = offset > 0 ? HOURS_NONE : rng.bool(0.8) ? HOURS_FULL : HOURS_SHORT;
    let state: DayState = 'DRAFT';
    let touch: Touch = { at: created, by: personId };
    let minute = offset * MINUTES_PER_DAY + rng.int(...SUBMIT_MINUTES);
    for (const [step, action] of chain.entries()) {
      if (step > 0) {
        // Each later step leaves room for the ones after it, so the chain ends before the business date.
        const room = Math.floor((LAST_ACTION_MINUTE - minute) / (chain.length - step));
        minute += rng.int(1, Math.min(MAX_STEP_GAP_MINUTES, room));
      }
      const next = transition(state, action);
      const actor = next.role === EMPLOYEE ? personId : employee.approvers[next.role];
      const at = stamp(minute);
      actions.push({
        action_id: cfUuidFrom(rng),
        day_id: dayId,
        action,
        role: next.role,
        from_state: state,
        to_state: next.to,
        actor_user_id: actor,
        comment: action === 'return' ? rng.pick(RETURN_COMMENTS) : null,
        created: at,
      });
      state = next.to;
      touch = { at, by: actor };
    }
    if (calendar.compareTimestamps(touch.at, sheetTouch.at) > 0) sheetTouch = touch;
    days.push({
      day_id: dayId,
      timesheet_id: timesheetId,
      work_date: calendar.localTimestamp(offset, 0),
      hours,
      state,
      lastUpdate: touch.at,
      lastUpdateByID: touch.by,
    });
  }

  out.timesheet.push({
    timesheet_id: timesheetId,
    person_id: personId,
    siteID: site,
    period_start: calendar.localTimestamp(start, 0),
    period_end: calendar.localTimestamp(start + PERIOD_DAYS - 1, 0),
    due_date: calendar.localTimestamp(dueOffset(start), 0),
    created,
    lastUpdate: sheetTouch.at,
    lastUpdateByID: sheetTouch.by,
  });
  out.timesheet_day.push(...days);
  out.approval_action.push(...actions);
}

/** Rows of the `Program_<id>` schema of `site`: each employee's consecutive sheets, oldest first; no blackouts. */
function buildProgram(ctx: FixtureContext, site: SiteKey): ProgramRows {
  const out: ProgramRows = { timesheet: [], timesheet_day: [], approval_action: [], blackout: [] };
  const { perEmployee, personIds } = layout(ctx, site);
  if (perEmployee === 0) return out;
  const siteRng = ctx.random.fork(`${MODULE}/${site}`);
  const employees = planEmployees(ctx, site, siteRng, personIds, perEmployee);
  const kinds = assignKinds(siteRng, employees.flatMap((employee) => employee.slots));
  for (const employee of employees) {
    for (const slot of [...employee.slots].reverse()) {
      const kind = kinds.get(slot);
      if (kind === undefined) throw new Error(`Timesheet of ${employee.personId}, ${slot.age} periods back, has no shape`);
      buildSheet(ctx.calendar, site, employee, slot.start, kind, out);
    }
    buildSheet(ctx.calendar, site, employee, employee.latestStart, 'current', out);
  }
  return out;
}

/** Rows of `table` in `rows`; throws for a registry table this builder does not produce. */
function rowsOf(rows: ProgramRows, table: string): FixtureRow[] {
  if (!Object.hasOwn(rows, table)) throw new RangeError(`No timesheet rows are built for table ${table}`);
  return rows[table as keyof ProgramRows];
}

/** Builds the `Program_<id>` timesheet tables of every program site from the seeded Masa employees. */
export function buildTimesheetFixtures(ctx: FixtureContext): FixtureTables {
  const built = new Map<number, ProgramRows>();
  const tables: FixtureTables = {};
  for (const key of fixtureKeys(ctx.config)) {
    const { spec, programId } = specForKey(key);
    if (spec.module !== MODULE) continue;
    if (programId === null) throw new RangeError(`Timesheet table ${key} is not a program table`);
    let rows = built.get(programId);
    if (rows === undefined) {
      rows = buildProgram(ctx, siteForProgram(ctx.config, programId));
      built.set(programId, rows);
    }
    tables[key] = rowsOf(rows, spec.table);
  }
  return tables;
}
