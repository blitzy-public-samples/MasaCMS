// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, parseConfig, type SeedConfig, type SiteKey } from '../../src/config.js';
import { fixtureKeys, specForKey, type FixtureContext, type FixtureRow, type FixtureTables } from '../../src/fixture-tables.js';
import { buildTimesheetFixtures } from '../../src/fixtures/timesheets.js';
import { buildMasa, indexMasa } from '../../src/masa.js';
import { MONEY_PATTERN } from '../../src/money.js';
import { createRandom } from '../../src/random.js';
import { createCalendar } from '../../src/time.js';

const CONFIG_PATH = fileURLToPath(new URL('../../seed.config.json', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DDL_PATH = `${REPO_ROOT}legacy-fixtures/sql/timesheets/110_tables.program.sql`;
const TRANSITIONS_PATH = `${REPO_ROOT}opt2/reports/state-machines/timesheets.json`;
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{2}0$/;
const MIDNIGHT = 'T00:00:00.000';
const EMPLOYEE = 'timesheets.employee';
const PRIMARY = 'timesheets.primary-approver';
const SECONDARY = 'timesheets.secondary-approver';
const ROLES = [EMPLOYEE, PRIMARY, SECONDARY] as const;
const TABLES = ['timesheet', 'timesheet_day', 'approval_action', 'blackout'] as const;
const ROW_TABLES = ['timesheet', 'timesheet_day', 'approval_action'] as const;
const PROGRAMS = [
  [1, 'tenant-a'],
  [2, 'tenant-b'],
] as const;
const PERIOD_DAYS = 28;
const DAYS_PER_SHEET = 20;
const DUE_AFTER_START = 30;
const MAX_STEP_GAP_MS = (4 * 1440 + 1) * 60_000;
const WORKED_HOURS = ['8.0000', '7.5000'];
const NO_HOURS = '0.0000';
const PAST_SHAPES = ['APPROVED', 'PARTIALLY_APPROVED', 'RETURNED', 'SUBMITTED', 'DRAFT overdue'];
const RESERVED_SHAPES = ['SUBMITTED', 'RETURNED', 'DRAFT overdue'];
const CURRENT_SHAPES = ['DRAFT', 'PARTIALLY_APPROVED'];

type Table = (typeof TABLES)[number];
type ProgramRows = Record<Table, FixtureRow[]>;
type Registry = typeof import('../../src/fixture-tables.js');

/** One column of a `CREATE TABLE` block; `width` is null for unsized and `max` types. */
interface DdlColumn {
  name: string;
  type: string;
  width: number | null;
  nullable: boolean;
}

/** One row of the exported timesheet-day transition table. */
interface TransitionRow {
  from: string;
  action: string;
  role: string;
  outcome: string;
  to: string | null;
}

/** The parts of the exported state machine the replay reads. */
interface Machine {
  states: string[];
  terminal: string[];
  roles: string[];
  rows: TransitionRow[];
}

/** The parts of `seed.config.json` the variants edit. */
interface RawConfig {
  sites: Record<SiteKey, { counts: Record<string, number> }>;
}

let raw: RawConfig;
let config: SeedConfig;
let ctx: FixtureContext;
let tables: FixtureTables;
let ddl: Map<string, DdlColumn[]>;
let machine: Machine;
let legal: Map<string, string>;

/** Columns of each `CREATE TABLE` block in `sql` by table name, in catalog order. */
function parseDdl(sql: string): Map<string, DdlColumn[]> {
  const parsed = new Map<string, DdlColumn[]>();
  for (const [, table = '', body = ''] of sql.matchAll(/CREATE TABLE \[[^\]]+\]\.\[([^\]]+)\] \(([\s\S]*?)\n\s*\) ON /g)) {
    const columns = [...body.matchAll(/^\s*\[(\w+)\] \[(\w+)\](?: \((\d+|max)(?:, \d+)?\))? (NOT NULL|NULL)/gm)].map(
      ([, name = '', type = '', width, nullability]): DdlColumn => ({
        name,
        type,
        width: width === undefined || width === 'max' ? null : Number(width),
        nullable: nullability === 'NULL',
      }),
    );
    parsed.set(table, columns);
  }
  return parsed;
}

/** Whether `value` loads into `column` through the conversions of `usp_seed_timesheets`. */
function fits(value: FixtureRow[string] | undefined, column: DdlColumn): boolean {
  if (value === null) return column.nullable;
  if (typeof value !== 'string') return false;
  if (column.type === 'char') return value.length === column.width;
  if (column.type === 'nvarchar') return value.length > 0 && value.length <= (column.width ?? Number.MAX_SAFE_INTEGER);
  if (column.type === 'numeric') return MONEY_PATTERN.test(value);
  return column.type === 'datetime' && TS.test(value);
}

function transitionKey(from: string, action: string, role: string): string {
  return `${from}|${action}|${role}`;
}

/** Fixture context as the generator wires it: Masa from the `masa` fork, timesheets from `fixtures/timesheets`. */
function context(c: SeedConfig): FixtureContext {
  const random = createRandom(c.seed);
  const calendar = createCalendar(c.businessDate);
  const masa = buildMasa(c, random.fork('masa'), calendar);
  return { config: c, random: random.fork('fixtures/timesheets'), calendar, masa, index: indexMasa(masa, c) };
}

/** `seed.config.json` with `counts` merged into the tenant-b counts of a copy, validated by `parseConfig`. */
function tenantB(counts: Readonly<Record<string, number>>): SeedConfig {
  const copy = structuredClone(raw);
  Object.assign(copy.sites['tenant-b'].counts, counts);
  return parseConfig(copy);
}

/** The timesheet tables of `Program_<programId>`; throws when one is missing. */
function programRows(t: FixtureTables, programId: number): ProgramRows {
  const rows = (table: Table): FixtureRow[] => {
    const found = t[`Program_${programId}.${table}`];
    if (found === undefined) throw new Error(`No Program_${programId}.${table}`);
    return found;
  };
  return { timesheet: rows('timesheet'), timesheet_day: rows('timesheet_day'), approval_action: rows('approval_action'), blackout: rows('blackout') };
}

/** Rows grouped by the value of `column`, groups in first-seen order. */
function groupBy(rows: readonly FixtureRow[], column: string): Map<string, FixtureRow[]> {
  const grouped = new Map<string, FixtureRow[]>();
  for (const row of rows) {
    const key = String(row[column]);
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [row]);
    else list.push(row);
  }
  return grouped;
}

/** Values of `column` with consecutive repeats collapsed. */
function runs(rows: readonly FixtureRow[], column: string): string[] {
  return rows.map((row) => String(row[column])).filter((value, i, all) => i === 0 || all[i - 1] !== value);
}

/** UserIDs holding the Masa group of `role` in the private user pool of `site`. */
function holders(c: FixtureContext, site: SiteKey, role: string): Set<string> {
  const pool = c.index.site(site).privateUserPoolID;
  const group = c.config.roleGroups[role];
  return new Set(c.masa.memberships.filter((m) => m.groupSiteID === pool && m.groupname === group).map((m) => m.userID));
}

function asOf(c: FixtureContext): string {
  return `${c.config.businessDate}${MIDNIGHT}`;
}

function offsetOf(c: FixtureContext, ts: FixtureRow[string] | undefined): number {
  return c.calendar.dayOffsetOf(String(ts).slice(0, 10));
}

/** `tvf_timesheet_status` of `sheet` as of the business date, with ` overdue` appended when flagged. */
function sheetStatus(c: FixtureContext, p: ProgramRows, sheet: FixtureRow, days: readonly FixtureRow[]): string {
  const blackedOut = new Set(p.blackout.map((b) => b.day_id));
  const states = days.filter((d) => !blackedOut.has(d.day_id)).map((d) => String(d.state));
  const count = (wanted: readonly string[]): number => states.filter((state) => wanted.includes(state)).length;
  const n = states.length;
  const approved = count(['APPROVED']);
  const status =
    n === 0
      ? 'DRAFT'
      : count(['RETURNED']) > 0
        ? 'RETURNED'
        : approved === n
          ? 'APPROVED'
          : approved > 0
            ? 'PARTIALLY_APPROVED'
            : count(['SUBMITTED', 'RESUBMITTED', 'PRIMARY_APPROVED', 'APPROVED']) === n
              ? 'SUBMITTED'
              : 'DRAFT';
  return String(sheet.due_date) < asOf(c) && count(['DRAFT']) > 0 ? `${status} overdue` : status;
}

/** Statuses of the past sheets (all but each person's latest) and of the latest sheets of the persons `include` selects. */
function shapes(c: FixtureContext, p: ProgramRows, include: (personId: string) => boolean): { past: string[]; current: string[] } {
  const daysBySheet = groupBy(p.timesheet_day, 'timesheet_id');
  const past: string[] = [];
  const current: string[] = [];
  for (const [personId, sheets] of groupBy(p.timesheet, 'person_id')) {
    if (!include(personId)) continue;
    sheets.forEach((sheet, i) => {
      const status = sheetStatus(c, p, sheet, daysBySheet.get(String(sheet.timesheet_id)) ?? []);
      (i === sheets.length - 1 ? current : past).push(status);
    });
  }
  return { past, current };
}

/** Departures of the sheets and days of `site` from consecutive four-week periods of its employees, oldest first. */
function periodProblems(c: FixtureContext, site: SiteKey, p: ProgramRows): string[] {
  const problems: string[] = [];
  const latest = c.calendar.mondayOnOrBefore(0);
  const latestStarts = [latest, latest - 7, latest - 14];
  const sheetsByPerson = groupBy(p.timesheet, 'person_id');
  const daysBySheet = groupBy(p.timesheet_day, 'timesheet_id');
  if (runs(p.timesheet, 'person_id').join() !== [...sheetsByPerson.keys()].join()) problems.push('sheets of a person are not contiguous');
  if (runs(p.timesheet_day, 'timesheet_id').join() !== p.timesheet.map((s) => s.timesheet_id).join()) problems.push('days do not follow their sheets');
  for (const sheets of sheetsByPerson.values()) {
    sheets.forEach((sheet, i) => {
      const fail = (what: string): void => {
        problems.push(`${String(sheet.timesheet_id)}: ${what}`);
      };
      const start = offsetOf(c, sheet.period_start);
      const previous = sheets[i - 1];
      if (sheet.siteID !== site) fail(`siteID ${String(sheet.siteID)}`);
      if (![sheet.period_start, sheet.period_end, sheet.due_date].every((ts) => String(ts).endsWith(MIDNIGHT))) fail('period dates are not midnights');
      if (c.calendar.weekday(start) !== 1) fail('period does not start on a Monday');
      if (offsetOf(c, sheet.period_end) !== start + PERIOD_DAYS - 1) fail('period does not end on its fourth Sunday');
      if (offsetOf(c, sheet.due_date) !== start + DUE_AFTER_START) fail('due date is not three days after the period end');
      if (previous !== undefined && start !== offsetOf(c, previous.period_start) + PERIOD_DAYS) fail('does not follow the previous period');
      if (i === sheets.length - 1 && !latestStarts.includes(start)) fail('latest period is not one of the last three');
      const days = daysBySheet.get(String(sheet.timesheet_id)) ?? [];
      const offsets = days.map((d) => offsetOf(c, d.work_date));
      const weekdays = Array.from({ length: PERIOD_DAYS }, (_, d) => start + d).filter((d) => c.calendar.isWeekday(d));
      if (offsets.join() !== weekdays.join() || days.some((d) => !String(d.work_date).endsWith(MIDNIGHT))) fail('days are not the period weekdays in order');
      days.forEach((day, k) => {
        const offset = offsets[k] ?? 0;
        if (offset > 0 ? day.hours !== NO_HOURS : !WORKED_HOURS.includes(String(day.hours))) fail(`hours ${String(day.hours)} at day offset ${offset}`);
        if (offset >= 0 && day.state !== 'DRAFT') fail(`day at offset ${offset} is ${String(day.state)}`);
      });
    });
  }
  return problems;
}

/** Departures of the day states and approval actions of `p` from a legal replay of the exported lifecycle. */
function lifecycleProblems(p: ProgramRows): string[] {
  const problems: string[] = [];
  const sheets = new Map(p.timesheet.map((s) => [String(s.timesheet_id), s]));
  const dayIds = p.timesheet_day.map((d) => String(d.day_id));
  const actionsByDay = groupBy(p.approval_action, 'day_id');
  if (runs(p.approval_action, 'day_id').join() !== dayIds.filter((id) => actionsByDay.has(id)).join()) problems.push('actions are not grouped in day order');
  for (const day of p.timesheet_day) {
    const fail = (what: string): void => {
      problems.push(`${String(day.day_id)}: ${what}`);
    };
    const sheet = sheets.get(String(day.timesheet_id));
    if (sheet === undefined) {
      fail('belongs to no timesheet of its program');
      continue;
    }
    const actions = actionsByDay.get(String(day.day_id)) ?? [];
    let state = 'DRAFT';
    actions.forEach((a, i) => {
      const to = legal.get(transitionKey(state, String(a.action), String(a.role)));
      if (a.from_state !== state || to === undefined || a.to_state !== to) {
        fail(`step ${i + 1} ${String(a.action)} by ${String(a.role)} from ${state} is illegal`);
      }
      state = String(a.to_state);
      if ((a.action === 'return') !== (typeof a.comment === 'string')) fail(`step ${i + 1} comment ${String(a.comment)}`);
      const previous = actions[i - 1];
      if (previous !== undefined && String(a.created) <= String(previous.created)) fail(`step ${i + 1} is not after step ${i}`);
    });
    if (day.state !== state) fail(`state ${String(day.state)} after a replay to ${state}`);
    const last = actions.at(-1);
    const touch = last === undefined ? [sheet.created, sheet.person_id] : [last.created, last.actor_user_id];
    if (day.lastUpdate !== touch[0] || day.lastUpdateByID !== touch[1]) fail('lastUpdate does not name its last step');
  }
  const daysBySheet = groupBy(p.timesheet_day, 'timesheet_id');
  for (const sheet of p.timesheet) {
    const latest = (daysBySheet.get(String(sheet.timesheet_id)) ?? []).reduce<FixtureRow | undefined>(
      (best, d) => (String(d.lastUpdate) > String(best?.lastUpdate ?? sheet.created) ? d : best),
      undefined,
    );
    const touch = latest === undefined ? [sheet.created, sheet.person_id] : [latest.lastUpdate, latest.lastUpdateByID];
    if (sheet.lastUpdate !== touch[0] || sheet.lastUpdateByID !== touch[1]) {
      problems.push(`${String(sheet.timesheet_id)}: lastUpdate does not name its latest day`);
    }
  }
  return problems;
}

/** Departures of the actors of `p` from the site's timesheets role holders, each employee keeping one approver per role. */
function actorProblems(c: FixtureContext, site: SiteKey, p: ProgramRows): string[] {
  const problems: string[] = [];
  const held = new Map(ROLES.map((role) => [role as string, holders(c, site, role)]));
  const selectable = new Map(ROLES.map((role) => [role as string, new Set(c.index.actors(site, role))]));
  const personOf = new Map(p.timesheet.map((s) => [String(s.timesheet_id), String(s.person_id)]));
  const dayPerson = new Map(p.timesheet_day.map((d) => [String(d.day_id), personOf.get(String(d.timesheet_id)) ?? '']));
  const approvers = new Map<string, Set<string>>();
  for (const personId of new Set(personOf.values())) {
    if (!held.get(EMPLOYEE)?.has(personId) || !selectable.get(EMPLOYEE)?.has(personId)) problems.push(`${personId} does not hold ${EMPLOYEE}`);
  }
  for (const a of p.approval_action) {
    const role = String(a.role);
    const actor = String(a.actor_user_id);
    const person = dayPerson.get(String(a.day_id)) ?? '';
    const user = c.index.user(actor);
    if (user.siteID !== c.index.site(site).privateUserPoolID || user.isPublic !== 0) problems.push(`${actor} is not a ${site} system user`);
    if (role === EMPLOYEE) {
      if (actor !== person) problems.push(`${String(a.action_id)}: employee step by someone other than the sheet's person`);
      continue;
    }
    if (actor === person || !held.get(role)?.has(actor) || !selectable.get(role)?.has(actor)) {
      problems.push(`${String(a.action_id)}: ${actor} does not hold ${role}`);
    }
    const key = `${person}|${role}`;
    approvers.set(key, (approvers.get(key) ?? new Set()).add(actor));
  }
  for (const [key, actors] of approvers) if (actors.size !== 1) problems.push(`${key} has ${actors.size} approvers`);
  return problems;
}

/** Event timestamps not before the business date, sheets not created early on their first day, and steps off their day's schedule. */
function timeProblems(c: FixtureContext, p: ProgramRows): string[] {
  const end = asOf(c);
  const stamps = [
    ...p.timesheet.flatMap((s) => [s.created, s.lastUpdate]),
    ...p.timesheet_day.map((d) => d.lastUpdate),
    ...p.approval_action.map((a) => a.created),
  ];
  const problems = stamps.filter((ts) => typeof ts !== 'string' || ts >= end).map((ts) => `${String(ts)} is not before ${end}`);
  for (const sheet of p.timesheet) {
    const created = String(sheet.created);
    if (created.slice(0, 10) !== String(sheet.period_start).slice(0, 10) || created.slice(11) >= '02:00:00.000') {
      problems.push(`${String(sheet.timesheet_id)}: created ${created}`);
    }
  }
  const workDate = new Map(p.timesheet_day.map((d) => [String(d.day_id), String(d.work_date).slice(0, 10)]));
  for (const [dayId, actions] of groupBy(p.approval_action, 'day_id')) {
    const first = actions[0] as FixtureRow;
    const at = String(first.created);
    const time = at.slice(11);
    if (first.action !== 'submit' || at.slice(0, 10) !== workDate.get(dayId) || time < '16:00' || time >= '20:00') {
      problems.push(`${dayId}: first step ${String(first.action)} at ${at}`);
    }
    for (let i = 1; i < actions.length; i += 1) {
      const gap = Date.parse(`${String(actions[i]?.created)}Z`) - Date.parse(`${String(actions[i - 1]?.created)}Z`);
      if (!(gap > 0 && gap < MAX_STEP_GAP_MS)) problems.push(`${dayId}: step ${i + 1} follows after ${gap} ms`);
    }
  }
  return problems;
}

/** Every invariant of the rows of `site` that holds for any configuration. */
function allProblems(c: FixtureContext, site: SiteKey, p: ProgramRows): string[] {
  return [...periodProblems(c, site, p), ...lifecycleProblems(p), ...actorProblems(c, site, p), ...timeProblems(c, p)];
}

/** Day ids `usp_apply_blackout` would close for `personId` from `effectiveFrom`: unapproved days on or after it without a blackout. */
function blackoutCandidates(p: ProgramRows, personId: string, effectiveFrom: string): string[] {
  const own = new Set(p.timesheet.filter((s) => s.person_id === personId).map((s) => s.timesheet_id));
  const closed = new Set(p.blackout.map((b) => b.day_id));
  return p.timesheet_day
    .filter((d) => own.has(d.timesheet_id) && d.state !== 'APPROVED' && String(d.work_date) >= effectiveFrom && !closed.has(d.day_id))
    .map((d) => String(d.day_id));
}

beforeAll(async () => {
  raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as RawConfig;
  config = await loadConfig(CONFIG_PATH);
  ctx = context(config);
  tables = buildTimesheetFixtures(ctx);
  ddl = parseDdl(await readFile(DDL_PATH, 'utf8'));
  machine = JSON.parse(await readFile(TRANSITIONS_PATH, 'utf8')) as Machine;
  legal = new Map(machine.rows.filter((row) => row.outcome === 'legal').map((row) => [transitionKey(row.from, row.action, row.role), row.to ?? row.from]));
});

describe('timesheet tables', () => {
  it('returns exactly the timesheets dataset keys, in registry order', () => {
    const keys = fixtureKeys(config).filter((key) => specForKey(key).spec.module === 'timesheets');
    expect(Object.keys(tables)).toEqual(keys);
    expect(keys).toEqual(TABLES.flatMap((table) => PROGRAMS.map(([id]) => `Program_${id}.${table}`)));
  });

  it.each(PROGRAMS.flatMap(([id]) => ROW_TABLES.map((table) => [`Program_${id}.${table}`, id, table] as const)))(
    '%s rows carry the DDL columns in catalog order with loadable values',
    (_key, id, table) => {
      const columns = ddl.get(table) ?? [];
      const names = columns.map((c) => c.name).join();
      const rows = programRows(tables, id)[table];
      expect(columns.length).toBeGreaterThan(0);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((row) => Object.keys(row).join() !== names)).toEqual([]);
      const misfits = rows.flatMap((row) => columns.filter((c) => !fits(row[c.name], c)).map((c) => `${c.name}=${String(row[c.name])}`));
      expect(misfits).toEqual([]);
    },
  );

  it.each([
    [1, 'tenant-a', 20_000, 100, 10],
    [2, 'tenant-b', 2_000, 20, 5],
  ] as const)('Program_%i (%s) holds %i days for %i employees, %i sheets each', (id, site, days, employees, perEmployee) => {
    const { counts } = config.sites[site];
    const p = programRows(tables, id);
    expect([counts.timesheetDays, counts.daysPerTimesheet, counts.timesheetEmployees]).toEqual([days, DAYS_PER_SHEET, employees]);
    expect(p.timesheet_day).toHaveLength(days);
    expect(p.timesheet).toHaveLength(employees * perEmployee);
    expect([...groupBy(p.timesheet, 'person_id').values()].map((sheets) => sheets.length)).toEqual(Array<number>(employees).fill(perEmployee));
    expect([...groupBy(p.timesheet_day, 'timesheet_id').values()].filter((sheetDays) => sheetDays.length !== DAYS_PER_SHEET)).toEqual([]);
  });

  it('keys are unique CF UUIDs distinct from Masa ids, with one sheet per person and period', () => {
    const all = PROGRAMS.map(([id]) => programRows(tables, id));
    const ids = all.flatMap((p) => [
      ...p.timesheet.map((s) => String(s.timesheet_id)),
      ...p.timesheet_day.map((d) => String(d.day_id)),
      ...p.approval_action.map((a) => String(a.action_id)),
    ]);
    expect(ids.filter((id) => !CF_UUID.test(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    const masaIds = new Set([...ctx.masa.users.map((u) => u.userID), ...ctx.masa.groups.map((g) => g.groupID), ...ctx.masa.content.map((c) => c.contentID)]);
    expect(ids.filter((id) => masaIds.has(id))).toEqual([]);
    const periods = all.flatMap((p) => p.timesheet.map((s) => `${String(s.person_id)}|${String(s.period_start)}`));
    expect(new Set(periods).size).toBe(periods.length);
  });
});

describe('timesheet lifecycle', () => {
  it.each(PROGRAMS)('Program_%i approval actions replay a legal path from DRAFT to each day state', (id) => {
    const p = programRows(tables, id);
    expect(lifecycleProblems(p)).toEqual([]);
    expect(p.approval_action.filter((a) => machine.terminal.includes(String(a.from_state)))).toEqual([]);
    expect(new Set(p.timesheet_day.map((d) => d.state))).toEqual(new Set(machine.states));
  });

  it.each(PROGRAMS)('Program_%i actors hold the %s timesheets role of each step, one approver per role and employee', (id, site) => {
    const p = programRows(tables, id);
    expect(actorProblems(ctx, site, p)).toEqual([]);
    expect(new Set(p.approval_action.map((a) => a.role))).toEqual(new Set(machine.roles));
  });

  it.each(PROGRAMS)('Program_%i past sheets take all five status shapes and latest sheets stay open and on time', (id) => {
    const p = programRows(tables, id);
    const { past, current } = shapes(ctx, p, (personId) => !ctx.index.isReserved(personId));
    expect(new Set(past)).toEqual(new Set(PAST_SHAPES));
    expect(current.filter((status) => !CURRENT_SHAPES.includes(status))).toEqual([]);
  });
});

describe('timesheet periods', () => {
  it.each(PROGRAMS)("Program_%i sheets are the %s employee group's members, in group order", (id, site) => {
    const members = [...holders(ctx, site, EMPLOYEE)].slice(0, config.sites[site].counts.timesheetEmployees);
    expect([...groupBy(programRows(tables, id).timesheet, 'person_id').keys()]).toEqual(members);
  });

  it.each(PROGRAMS)('Program_%i (%s) sheets cover consecutive four-week periods whose weekdays are their days', (id, site) => {
    expect(periodProblems(ctx, site, programRows(tables, id))).toEqual([]);
  });

  it.each(PROGRAMS)('Program_%i events happen before the business date, each day submitted on its own evening', (id) => {
    expect(timeProblems(ctx, programRows(tables, id))).toEqual([]);
  });
});

describe('rehearsal persons and blackouts', () => {
  it('reserved rehearsal persons are tenant-a employees whose days all stay open for the rehearsal archive', () => {
    const { site, persons } = config.reserved.rehearsal;
    const p = programRows(tables, 1);
    const sheetsByPerson = groupBy(p.timesheet, 'person_id');
    const own = (personId: string): FixtureRow[] => {
      const sheetIds = new Set(sheetsByPerson.get(personId)?.map((s) => s.timesheet_id));
      return p.timesheet_day.filter((d) => sheetIds.has(d.timesheet_id));
    };
    const { timesheetDays, daysPerTimesheet, timesheetEmployees } = config.sites['tenant-a'].counts;
    const otherProgram = JSON.stringify(programRows(tables, 2));
    expect(site).toBe('tenant-a');
    expect(persons).toHaveLength(10);
    expect(persons.filter((personId) => sheetsByPerson.get(personId)?.length !== timesheetDays / daysPerTimesheet / timesheetEmployees)).toEqual([]);
    expect(persons.filter((personId) => otherProgram.includes(personId))).toEqual([]);
    for (const personId of persons) {
      const days = own(personId);
      expect(days.filter((d) => d.state === 'APPROVED')).toEqual([]);
      expect(blackoutCandidates(p, personId, String(sheetsByPerson.get(personId)?.[0]?.period_start))).toHaveLength(days.length);
      expect(blackoutCandidates(p, personId, asOf(ctx)).length).toBeGreaterThan(0);
    }
    const reserved = new Set(persons);
    const { past, current } = shapes(ctx, p, (personId) => reserved.has(personId));
    expect(past.filter((status) => !RESERVED_SHAPES.includes(status))).toEqual([]);
    expect(current.filter((status) => status !== 'DRAFT')).toEqual([]);
    expect(p.approval_action.filter((a) => reserved.has(String(a.actor_user_id)) && a.role !== EMPLOYEE)).toEqual([]);
  });

  it.each(PROGRAMS)('Program_%i seeds no blackouts, so every day stays actionable until a person is archived', (id) => {
    const p = programRows(tables, id);
    expect(ddl.get('blackout')?.map((c) => c.name)).toEqual(['blackout_id', 'day_id', 'person_id', 'archive_id', 'reason', 'created']);
    expect(p.blackout).toEqual([]);
    const sheets = groupBy(p.timesheet, 'person_id');
    expect([...sheets.keys()].filter((personId) => blackoutCandidates(p, personId, asOf(ctx)).length === 0)).toEqual([]);
  });
});

describe('timesheet determinism and configuration', () => {
  it('equal contexts yield identical rows and the context stream is not consumed', () => {
    const text = JSON.stringify(tables);
    expect(JSON.stringify(buildTimesheetFixtures(ctx))).toBe(text);
    expect(JSON.stringify(buildTimesheetFixtures(context(config)))).toBe(text);
  });

  it('a different seed changes every program', () => {
    const other = buildTimesheetFixtures(context({ ...config, seed: config.seed + 1 }));
    for (const [id] of PROGRAMS) {
      expect(programRows(other, id).timesheet[0]?.timesheet_id).not.toBe(programRows(tables, id).timesheet[0]?.timesheet_id);
    }
  });

  it('a program without timesheet days keeps its keys with empty lists and leaves the other program unchanged', () => {
    const rows = buildTimesheetFixtures(context(tenantB({ timesheetDays: 0 })));
    expect(Object.keys(rows)).toEqual(Object.keys(tables));
    expect(programRows(rows, 2)).toEqual({ timesheet: [], timesheet_day: [], approval_action: [], blackout: [] });
    expect(JSON.stringify(programRows(rows, 1))).toBe(JSON.stringify(programRows(tables, 1)));
  });

  it('two sheets per employee still give every past status shape and keep every invariant', () => {
    const small = context(tenantB({ timesheetDays: 800 }));
    const rows = buildTimesheetFixtures(small);
    const p = programRows(rows, 2);
    expect(p.timesheet).toHaveLength(40);
    expect(allProblems(small, 'tenant-b', p)).toEqual([]);
    expect(new Set(shapes(small, p, () => true).past)).toEqual(new Set(PAST_SHAPES));
    expect(JSON.stringify(programRows(rows, 1))).toBe(JSON.stringify(programRows(tables, 1)));
  });

  it.each([
    ['10-day sheets', { daysPerTimesheet: 10 }, 'Site tenant-b: 2000 days do not fill whole 20-day sheets for 20 employees'],
    ['a partial sheet', { timesheetDays: 2010 }, 'Site tenant-b: 2010 days do not fill whole 20-day sheets for 20 employees'],
    ['one sheet per employee', { timesheetDays: 400 }, 'No past timesheet can take the approved shape'],
    ['no system users', { systemUsers: 0 }, 'Site tenant-b has fewer than 20 members of timesheets.employee'],
  ] as const)('tenant-b with %s throws RangeError', (_label, counts, message) => {
    const variantCtx = context(tenantB(counts));
    expect(() => buildTimesheetFixtures(variantCtx)).toThrow(RangeError);
    expect(() => buildTimesheetFixtures(variantCtx)).toThrow(message);
  });
});

describe('table registry', () => {
  afterEach(() => {
    vi.doUnmock('../../src/fixture-tables.js');
    vi.resetModules();
  });

  const extra = 'Program_1.timesheet_note';
  it.each([
    [
      'a timesheets key without a program id',
      (actual: Registry): Partial<Registry> => ({
        specForKey: (key: string) => {
          const found = actual.specForKey(key);
          return found.spec.module === 'timesheets' ? { ...found, programId: null } : found;
        },
      }),
      'Timesheet table Program_1.timesheet is not a program table',
    ],
    [
      'a timesheets table the builder does not produce',
      (actual: Registry): Partial<Registry> => ({
        fixtureKeys: (c: SeedConfig) => [...actual.fixtureKeys(c), extra],
        specForKey: (key: string) =>
          key === extra ? { spec: { ...actual.specForKey('Program_1.timesheet').spec, table: 'timesheet_note' }, programId: 1 } : actual.specForKey(key),
      }),
      'No timesheet rows are built for table timesheet_note',
    ],
  ] as const)('throws RangeError for %s', async (_label, override, message) => {
    vi.resetModules();
    vi.doMock('../../src/fixture-tables.js', async (importOriginal) => {
      const actual = await importOriginal<Registry>();
      return { ...actual, ...override(actual) };
    });
    const { buildTimesheetFixtures: build } = await import('../../src/fixtures/timesheets.js');
    expect(() => build(ctx)).toThrow(RangeError);
    expect(() => build(ctx)).toThrow(message);
  });
});
