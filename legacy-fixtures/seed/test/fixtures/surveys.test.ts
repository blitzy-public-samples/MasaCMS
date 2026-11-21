// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SITE_ORDER, loadConfig, parseConfig, type SeedConfig, type SiteCounts, type SiteKey } from '../../src/config.js';
import {
  FIXTURE_TABLE_SPECS,
  fixtureKeys,
  specForKey,
  type FixtureContext,
  type FixtureRow,
  type FixtureTables,
} from '../../src/fixture-tables.js';
import { buildSurveyFixtures } from '../../src/fixtures/surveys.js';
import { buildMasa, indexMasa, type MasaData } from '../../src/masa.js';
import { createRandom } from '../../src/random.js';
import { createCalendar } from '../../src/time.js';

const CONFIG_PATH = fileURLToPath(new URL('../../seed.config.json', import.meta.url));
const DDL_PATH = fileURLToPath(new URL('../../../sql/surveys/100_tables.sql', import.meta.url));
const EVENT_PATH = fileURLToPath(
  new URL('../../../../services/surveys/contracts/events/surveys.survey.scheduled.v1.json', import.meta.url),
);
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{2}0$/;
const WORKING_HOUR = /T(0[89]|1[0-7]):00:00\.000$/;
const SURVEY = 'synthetic.survey';
const SCHEDULE = 'synthetic.survey_schedule';
const REMINDER = 'synthetic.survey_reminder';
const TARGET = 'synthetic.survey_target';
const RESPONSE = 'synthetic.survey_response';
const KEYS: readonly string[] = [SURVEY, SCHEDULE, REMINDER, TARGET, RESPONSE];
const MANAGER_ROLE = 'surveys.manager';
const STATUSES: readonly string[] = ['DRAFT', 'SCHEDULED', 'LAUNCHED', 'CLOSED'];
// Statuses the first surveys of a site take once each, in this order.
const BASE_STATUSES: readonly string[] = ['LAUNCHED', 'CLOSED', 'SCHEDULED', 'DRAFT'];
const RESPONDING: readonly string[] = ['LAUNCHED', 'CLOSED'];
const CHOICES: readonly string[] = ['Strongly agree', 'Agree', 'Neutral', 'Disagree', 'Strongly disagree'];
// First other site in SITE_ORDER with groups and respondents; umbrella has neither.
const PARTNER: Readonly<Record<string, SiteKey>> = { 'tenant-a': 'tenant-b', 'tenant-b': 'tenant-a' };
const NO_MANAGER = 'Site umbrella has no surveys.manager to create its surveys';
const NO_PARTNER = 'Site tenant-a has multi-site responses but no other site to answer from';
const OVER_MULTI_SITE = 'Site tenant-b: multiSiteResponses 21 exceeds surveyResponses 20';
const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;
const MAX_TASK_DELAY_MS = 2 * MINUTE_MS + 990;

interface DdlColumn {
  name: string;
  type: string;
  length: number | null;
  nullable: boolean;
}

interface DdlTable {
  columns: DdlColumn[];
  /** Column sets of the primary key and each unique constraint. */
  unique: string[][];
}

interface ScheduledEventSchema {
  properties: { launchAt: { pattern: string }; launchTaskName: { pattern: string } };
  $defs: {
    SurveyScheduledReminder: { properties: { offsetMinutes: { minimum: number }; taskName: { pattern: string; maxLength: number } } };
  };
}

type RawConfig = { historyDays: number; sites: Record<SiteKey, { counts: Partial<SiteCounts> }> };

/** Columns and key column sets of each `CREATE TABLE [synthetic]` block by dataset key, in catalog order. */
function parseDdl(sql: string): Map<string, DdlTable> {
  const tables = new Map<string, DdlTable>();
  for (const [, table = '', body = ''] of sql.matchAll(/CREATE TABLE \[synthetic\]\.\[([^\]]+)\] \(([\s\S]*?)\n\s*\) ON /g)) {
    const columns = [...body.matchAll(/^\s*\[([^\]]+)\] \[([a-z]+)\](?: \((\d+|max)\))? (NOT NULL|NULL)/gm)].map(
      ([, name = '', type = '', length, nullability]): DdlColumn => ({
        name,
        type,
        length: length === undefined || length === 'max' ? null : Number(length),
        nullable: nullability === 'NULL',
      }),
    );
    const inline = [...body.matchAll(/^\s*\[([^\]]+)\] [^\n]*\b(?:PRIMARY KEY|UNIQUE)\b/gm)].map(([, name = '']) => [name]);
    const composite = [...body.matchAll(/CONSTRAINT \[[^\]]+\] UNIQUE \(([^)]+)\)/g)].map(([, list = '']) =>
      [...list.matchAll(/\[([^\]]+)\]/g)].map(([, name = '']) => name),
    );
    tables.set(`synthetic.${table}`, { columns, unique: [...inline, ...composite] });
  }
  return tables;
}

let raw: RawConfig;
let config: SeedConfig;
let masa: MasaData;
let ctx: FixtureContext;
let tables: FixtureTables;
let ddl: Map<string, DdlTable>;
let event: ScheduledEventSchema;
let midnight: string;

/** Fixture context of `c` over `data` (built from `c` when omitted), with the surveys builder's own random stream. */
function contextFor(c: SeedConfig, data?: MasaData): FixtureContext {
  const random = createRandom(c.seed);
  const calendar = createCalendar(c.businessDate);
  const built = data ?? buildMasa(c, random.fork('masa'), calendar);
  return { config: c, random: random.fork('fixtures/surveys'), calendar, masa: built, index: indexMasa(built, c) };
}

/** Seed configuration parsed from a copy of `seed.config.json` changed by `edit`. */
function variant(edit: (copy: RawConfig) => void): SeedConfig {
  const copy = structuredClone(raw);
  edit(copy);
  return parseConfig(copy);
}

/** Rows of dataset key `key`; throws when the key is absent. */
function rows(t: FixtureTables, key: string): FixtureRow[] {
  const found = t[key];
  if (found === undefined) throw new Error(`${key} is not in the fixture tables`);
  return found;
}

/** String value of `column`; throws when it is not a string. */
function text(row: FixtureRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new TypeError(`${column} is ${JSON.stringify(value)}, not a string`);
  return value;
}

/** Rows of each surveys table that belong to surveys of `site`. */
function siteRows(t: FixtureTables, site: SiteKey): FixtureTables {
  const ids = new Set(rows(t, SURVEY).filter((row) => row.siteID === site).map((row) => row.survey_id));
  return Object.fromEntries(KEYS.map((key): [string, FixtureRow[]] => [key, rows(t, key).filter((row) => ids.has(row.survey_id))]));
}

/** Rows of `key` grouped by `survey_id`, each group in row order. */
function bySurvey(t: FixtureTables, key: string): Map<string, FixtureRow[]> {
  const out = new Map<string, FixtureRow[]>();
  for (const row of rows(t, key)) {
    const id = text(row, 'survey_id');
    out.set(id, [...(out.get(id) ?? []), row]);
  }
  return out;
}

/** `survey_id` of each run of consecutive rows of `key` that share one survey. */
function surveyRuns(t: FixtureTables, key: string): string[] {
  return rows(t, key)
    .map((row) => text(row, 'survey_id'))
    .filter((id, i, ids) => id !== ids[i - 1]);
}

/** Milliseconds from timestamp `a` to timestamp `b`. */
function msBetween(a: string, b: string): number {
  return Date.parse(`${b}Z`) - Date.parse(`${a}Z`);
}

/** Day offset from the business date of timestamp `ts`. */
function dayOf(ts: string): number {
  return ctx.calendar.dayOffsetOf(ts.slice(0, 10));
}

/** Kind of one answer value: a 1 to 5 rating, a fixed choice, free text, or invalid. */
function answerKind(value: unknown): string {
  if (Number.isInteger(value)) return Number(value) >= 1 && Number(value) <= 5 ? 'rating' : 'invalid';
  if (typeof value !== 'string') return 'invalid';
  if (CHOICES.includes(value)) return 'choice';
  return /^[A-Z].*\.$/.test(value) ? 'text' : 'invalid';
}

/** Survey rows of `t` by `survey_id`. */
const surveysById = (t: FixtureTables): Map<string, FixtureRow> => new Map(rows(t, SURVEY).map((row) => [text(row, 'survey_id'), row]));

/** Surveys tables of a fresh context over `c`, reusing the base Masa data unless `rebuild` is set. */
const buildWith = (c: SeedConfig, rebuild = false): FixtureTables => buildSurveyFixtures(contextFor(c, rebuild ? undefined : masa));

beforeAll(async () => {
  raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as RawConfig;
  config = await loadConfig(CONFIG_PATH);
  ctx = contextFor(config);
  masa = ctx.masa;
  tables = buildSurveyFixtures(ctx);
  ddl = parseDdl(await readFile(DDL_PATH, 'utf8'));
  event = JSON.parse(await readFile(EVENT_PATH, 'utf8')) as ScheduledEventSchema;
  midnight = ctx.calendar.localTimestamp(0, 0);
});

describe('surveys tables', () => {
  it('returns exactly the surveys dataset keys of fixtureKeys, in registry order', () => {
    expect(Object.keys(tables)).toEqual(fixtureKeys(config).filter((key) => specForKey(key).spec.module === 'surveys'));
    expect(Object.keys(tables)).toEqual(KEYS);
  });

  it.each(KEYS)('%s rows follow the DDL column order, nullability, types and sizes', (key) => {
    const columns = ddl.get(key)?.columns ?? [];
    expect(columns.length).toBeGreaterThan(0);
    expect(rows(tables, key).length).toBeGreaterThan(0);
    for (const row of rows(tables, key)) {
      expect(Object.keys(row)).toEqual(columns.map((column) => column.name));
      for (const column of columns) {
        const value = row[column.name];
        if (!column.nullable) expect(value).not.toBeNull();
        if (value === null || value === undefined) continue;
        if (column.type === 'int') {
          expect(Number.isInteger(value)).toBe(true);
          continue;
        }
        expect(typeof value).toBe('string');
        const size = String(value).length;
        if (column.type === 'char') expect(size).toBe(column.length);
        else if (column.length !== null) expect(size).toBeLessThanOrEqual(column.length);
        if (column.type === 'datetime') expect(value).toMatch(TS);
      }
    }
  });

  it('keys every row by a unique CF UUID and points every child row at a seeded survey', () => {
    const specs = FIXTURE_TABLE_SPECS.filter((entry) => entry.module === 'surveys');
    expect(specs.map((entry) => `synthetic.${entry.table}`)).toEqual(KEYS);
    const ids = specs.flatMap((entry) => rows(tables, `synthetic.${entry.table}`).map((row) => text(row, entry.key)));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(CF_UUID);
    const surveys = surveysById(tables);
    for (const key of KEYS.slice(1)) for (const row of rows(tables, key)) expect(surveys.has(text(row, 'survey_id'))).toBe(true);
  });

  it.each(KEYS)('%s holds no two rows equal on a primary-key or unique column set of the DDL', (key) => {
    const unique = ddl.get(key)?.unique ?? [];
    if (key === SCHEDULE) expect(unique).toContainEqual(['survey_id']);
    if (key === TARGET) expect(unique).toContainEqual(['survey_id', 'siteID', 'group_name']);
    expect(unique.length).toBeGreaterThan(0);
    for (const columns of unique) {
      const tuples = rows(tables, key).map((row) => JSON.stringify(columns.map((column) => row[column])));
      expect(new Set(tuples).size).toBe(tuples.length);
    }
  });

  it.each([
    ['umbrella', 0, 0, 0],
    ['tenant-a', 20, 500, 50],
    ['tenant-b', 2, 20, 0],
  ] as const)('%s holds %i surveys and %i responses, %i of them from another site', (site, surveys, responses, multiSite) => {
    const { counts } = config.sites[site];
    expect([counts.surveys, counts.surveyResponses, counts.multiSiteResponses]).toEqual([surveys, responses, multiSite]);
    const own = siteRows(tables, site);
    expect(rows(own, SURVEY)).toHaveLength(surveys);
    expect(rows(own, RESPONSE)).toHaveLength(responses);
    expect(rows(own, RESPONSE).filter((row) => row.respondentSiteID !== site)).toHaveLength(multiSite);
  });

  it('orders surveys by site, then oldest first, and keeps each child table grouped in survey order', () => {
    const surveys = rows(tables, SURVEY);
    const sites = surveys.map((row) => row.siteID as SiteKey);
    expect(sites).toEqual([...sites].sort((a, b) => SITE_ORDER.indexOf(a) - SITE_ORDER.indexOf(b)));
    for (const site of SITE_ORDER) {
      const created = rows(siteRows(tables, site), SURVEY).map((row) => text(row, 'created'));
      expect(created).toEqual([...created].sort());
    }
    const order = surveys.map((row) => text(row, 'survey_id'));
    for (const key of KEYS.slice(1)) {
      const children = bySurvey(tables, key);
      expect(surveyRuns(tables, key)).toEqual(order.filter((id) => children.has(id)));
    }
  });
});

describe('surveys', () => {
  it('take one of the four statuses, each base status once on every site before any repeats', () => {
    for (const site of SITE_ORDER) {
      const statuses = rows(siteRows(tables, site), SURVEY).map((row) => text(row, 'status'));
      for (const status of statuses) expect(STATUSES).toContain(status);
      for (const status of BASE_STATUSES.slice(0, statuses.length)) expect(statuses).toContain(status);
    }
    expect(new Set(rows(siteRows(tables, 'tenant-a'), SURVEY).map((row) => row.status))).toEqual(new Set(STATUSES));
    expect(rows(siteRows(tables, 'tenant-b'), SURVEY).map((row) => row.status).sort()).toEqual(['CLOSED', 'LAUNCHED']);
  });

  it("are created by the site's non-reserved surveys.manager actors, titled '<catch phrase> survey', with no update audit", () => {
    for (const row of rows(tables, SURVEY)) {
      const site = row.siteID as SiteKey;
      expect(ctx.index.actors(site, MANAGER_ROLE)).toContain(row.createdByID);
      expect(ctx.index.isReserved(text(row, 'createdByID'))).toBe(false);
      expect(text(row, 'title')).toMatch(/^\S.* survey$/);
      expect([row.lastUpdate, row.lastUpdateByID]).toEqual([null, null]);
    }
  });

  it('are created in a working hour of the history window, scheduled ones at least 30 days before the business date', () => {
    const scheduleFloor = -Math.max(30, config.historyDays);
    for (const row of rows(tables, SURVEY)) {
      const created = text(row, 'created');
      const hour = Number(created.slice(11, 13));
      expect(hour >= 8 && hour <= 17).toBe(true);
      const day = dayOf(created);
      if (row.status === 'DRAFT') expect(day >= -config.historyDays && day <= -1).toBe(true);
      else expect(day >= scheduleFloor && day <= -30).toBe(true);
    }
  });

  it('carry launched_at only when LAUNCHED or CLOSED, within two minutes after the scheduled launch', () => {
    const schedules = bySurvey(tables, SCHEDULE);
    for (const row of rows(tables, SURVEY)) {
      const responding = RESPONDING.includes(text(row, 'status'));
      expect(row.launched_at !== null).toBe(responding);
      if (!responding) continue;
      const launchAt = text(schedules.get(text(row, 'survey_id'))?.[0] ?? {}, 'launch_at');
      expect(msBetween(launchAt, text(row, 'launched_at'))).toSatisfy((ms: number) => ms >= 0 && ms <= MAX_TASK_DELAY_MS);
    }
  });
});

describe('schedules and reminders', () => {
  it('give every non-DRAFT survey one version-1 schedule and one to three reminders, and a DRAFT survey none', () => {
    const schedules = bySurvey(tables, SCHEDULE);
    const reminders = bySurvey(tables, REMINDER);
    for (const row of rows(tables, SURVEY)) {
      const id = text(row, 'survey_id');
      if (row.status === 'DRAFT') {
        expect([schedules.has(id), reminders.has(id)]).toEqual([false, false]);
        continue;
      }
      expect(schedules.get(id)?.map((schedule) => schedule.schedule_version)).toEqual([1]);
      expect(reminders.get(id)?.length).toSatisfy((n: number) => n >= 1 && n <= 3);
    }
  });

  it('name tasks opt2-survey-<surveyId>-launch and -reminder-<n>, inside the survey.scheduled.v1 patterns', () => {
    const launchName = new RegExp(event.properties.launchTaskName.pattern);
    const launchAt = new RegExp(event.properties.launchAt.pattern);
    const reminder = event.$defs.SurveyScheduledReminder.properties.taskName;
    const reminderName = new RegExp(reminder.pattern);
    for (const row of rows(tables, SCHEDULE)) {
      expect(row.task_name).toBe(`opt2-survey-${text(row, 'survey_id')}-launch`);
      expect(text(row, 'task_name')).toMatch(launchName);
      expect(text(row, 'launch_at')).toMatch(launchAt);
    }
    for (const [id, list] of bySurvey(tables, REMINDER)) {
      expect(list.map((row) => row.task_name)).toEqual(list.map((_, i) => `opt2-survey-${id}-reminder-${i + 1}`));
      for (const row of list) {
        expect(text(row, 'task_name')).toMatch(reminderName);
        expect(text(row, 'task_name').length).toBeLessThanOrEqual(reminder.maxLength);
      }
    }
  });

  it('share one 64-hex task token hash between a survey launch and its reminders, distinct across surveys', () => {
    const schedules = rows(tables, SCHEDULE);
    const hashes = schedules.map((row) => text(row, 'task_token_hash'));
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(hashes).size).toBe(hashes.length);
    const reminders = bySurvey(tables, REMINDER);
    for (const row of schedules) {
      for (const item of reminders.get(text(row, 'survey_id')) ?? []) expect(item.task_token_hash).toBe(row.task_token_hash);
    }
  });

  it('launch on a whole working hour 1 to 14 days after the schedule is created, 10 minutes to 3 days after the survey', () => {
    const surveys = surveysById(tables);
    for (const row of rows(tables, SCHEDULE)) {
      const launchAt = text(row, 'launch_at');
      const created = text(row, 'created');
      expect(launchAt).toMatch(WORKING_HOUR);
      expect(dayOf(launchAt) - dayOf(created)).toSatisfy((days: number) => days >= 1 && days <= 14);
      const surveyCreated = text(surveys.get(text(row, 'survey_id')) ?? {}, 'created');
      expect(msBetween(surveyCreated, created)).toSatisfy(
        (ms: number) => ms >= 10 * MINUTE_MS - 990 && ms <= 3 * DAY_MINUTES * MINUTE_MS + 990,
      );
    }
  });

  it('offset reminders by 1 to 7 whole days each, offset_minutes being the minutes from launch_at to remind_at', () => {
    const schedules = bySurvey(tables, SCHEDULE);
    const minimum = event.$defs.SurveyScheduledReminder.properties.offsetMinutes.minimum;
    for (const [id, list] of bySurvey(tables, REMINDER)) {
      const launchAt = text(schedules.get(id)?.[0] ?? {}, 'launch_at');
      let previous = 0;
      for (const row of list) {
        const offset = Number(row.offset_minutes);
        expect(offset).toBeGreaterThanOrEqual(minimum);
        expect(offset - previous).toSatisfy((gap: number) => gap % DAY_MINUTES === 0 && gap >= DAY_MINUTES && gap <= 7 * DAY_MINUTES);
        expect(row.remind_at).toBe(ctx.calendar.addMinutes(launchAt, offset));
        previous = offset;
      }
    }
  });

  it('stamp sent_at within two minutes of remind_at exactly when the survey launched and the reminder is past due', () => {
    const surveys = surveysById(tables);
    const reminders = rows(tables, REMINDER);
    for (const row of reminders) {
      const launched = surveys.get(text(row, 'survey_id'))?.launched_at !== null;
      const remindAt = text(row, 'remind_at');
      expect(row.sent_at !== null).toBe(launched && remindAt < midnight);
      if (row.sent_at === null) continue;
      expect(msBetween(remindAt, text(row, 'sent_at'))).toSatisfy((ms: number) => ms >= 0 && ms <= MAX_TASK_DELAY_MS);
      expect(text(row, 'sent_at') < midnight).toBe(true);
    }
    expect(reminders.some((row) => row.sent_at === null)).toBe(true);
    expect(reminders.some((row) => row.sent_at !== null)).toBe(true);
  });
});

describe('targets', () => {
  it("target one to three groups of the survey's own site and at most two of its partner site's groups", () => {
    const groupsOf = (site: SiteKey): string[] => ctx.index.groups(ctx.index.site(site).privateUserPoolID).map((group) => group.groupname);
    const targets = bySurvey(tables, TARGET);
    for (const survey of rows(tables, SURVEY)) {
      const site = survey.siteID as SiteKey;
      const partner = PARTNER[site];
      const list = targets.get(text(survey, 'survey_id')) ?? [];
      const own = list.filter((row) => row.siteID === site);
      const cross = list.filter((row) => row.siteID !== site);
      expect(own.length).toSatisfy((n: number) => n >= 1 && n <= 3);
      expect(cross.length).toSatisfy((n: number) => n >= 0 && n <= 2);
      for (const row of own) expect(groupsOf(site)).toContain(row.group_name);
      for (const row of cross) {
        expect(row.siteID).toBe(partner);
        if (partner !== undefined) expect(groupsOf(partner)).toContain(row.group_name);
      }
    }
    const surveys = surveysById(tables);
    const pairs = rows(tables, TARGET)
      .map((row) => [String(surveys.get(text(row, 'survey_id'))?.siteID), text(row, 'siteID')])
      .filter(([from, to]) => from !== to)
      .map(([from, to]) => `${from}->${to}`);
    expect(new Set(pairs)).toEqual(new Set(['tenant-a->tenant-b', 'tenant-b->tenant-a']));
  });

  it('are created after the survey and before its launch, or before the business date for a DRAFT survey', () => {
    const surveys = surveysById(tables);
    const schedules = bySurvey(tables, SCHEDULE);
    for (const row of rows(tables, TARGET)) {
      const id = text(row, 'survey_id');
      const created = text(row, 'created');
      const bound = schedules.has(id) ? text(schedules.get(id)?.[0] ?? {}, 'launch_at') : midnight;
      expect(created > text(surveys.get(id) ?? {}, 'created')).toBe(true);
      expect(created < bound).toBe(true);
    }
  });

  it('make a responding tenant-a survey target tenant-b, the site its multi-site responses come from', () => {
    const surveys = surveysById(tables);
    const responding = rows(tables, TARGET).filter((row) => {
      const survey = surveys.get(text(row, 'survey_id'));
      return survey?.siteID === 'tenant-a' && row.siteID === 'tenant-b' && RESPONDING.includes(text(survey, 'status'));
    });
    expect(responding.length).toBeGreaterThan(0);
  });
});

describe('responses', () => {
  it("answer only LAUNCHED or CLOSED surveys, under the survey's site, from that site or a site it targets", () => {
    const surveys = surveysById(tables);
    const targets = bySurvey(tables, TARGET);
    for (const row of rows(tables, RESPONSE)) {
      const id = text(row, 'survey_id');
      const survey = surveys.get(id) ?? {};
      expect(RESPONDING).toContain(survey.status);
      expect(row.siteID).toBe(survey.siteID);
      const allowed = new Set([survey.siteID, ...(targets.get(id) ?? []).map((target) => target.siteID)]);
      expect(allowed.has(row.respondentSiteID ?? null)).toBe(true);
    }
  });

  it("come from non-reserved system users of the respondent site's private pool, once per user and survey", () => {
    const reserved = config.reserved.rehearsal;
    const pool = ctx.index.systemUsers(ctx.index.site(reserved.site).privateUserPoolID).map((user) => user.userID);
    for (const id of reserved.persons) expect(pool).toContain(id);
    for (const row of rows(tables, RESPONSE)) {
      const site = row.respondentSiteID as SiteKey;
      const users = ctx.index.systemUsers(ctx.index.site(site).privateUserPoolID).map((user) => user.userID);
      expect(users).toContain(row.respondent_user_id);
      expect(ctx.index.isReserved(text(row, 'respondent_user_id'))).toBe(false);
    }
    for (const list of bySurvey(tables, RESPONSE).values()) {
      const respondents = list.map((row) => row.respondent_user_id);
      expect(new Set(respondents).size).toBe(respondents.length);
    }
  });

  it('are created after the launch, oldest first per survey, and before the business date', () => {
    const surveys = surveysById(tables);
    for (const [id, list] of bySurvey(tables, RESPONSE)) {
      const launched = text(surveys.get(id) ?? {}, 'launched_at');
      const created = list.map((row) => text(row, 'created'));
      expect(created).toEqual([...created].sort());
      for (const ts of created) expect(ts > launched && ts < midnight).toBe(true);
    }
  });

  it("answer each of the survey's 3 to 6 questions as JSON: a 1 to 5 rating, a fixed choice or free text", () => {
    const seen = new Set<string>();
    for (const list of bySurvey(tables, RESPONSE).values()) {
      const answers = list.map((row) => JSON.parse(text(row, 'answers')) as Record<string, unknown>);
      const keys = Object.keys(answers[0] ?? {});
      expect(keys.length).toSatisfy((n: number) => n >= 3 && n <= 6);
      expect(keys).toEqual(keys.map((_, i) => `q${i + 1}`));
      const kinds = keys.map((key) => answerKind(answers[0]?.[key]));
      for (const answer of answers) {
        expect(Object.keys(answer)).toEqual(keys);
        expect(keys.map((key) => answerKind(answer[key]))).toEqual(kinds);
      }
      for (const kind of kinds) seen.add(kind);
    }
    expect(seen).toEqual(new Set(['rating', 'choice', 'text']));
  });
});

describe('determinism', () => {
  it('same seed gives identical output; a different seed changes it', () => {
    expect(JSON.stringify(buildSurveyFixtures(contextFor(config, masa)))).toBe(JSON.stringify(tables));
    expect(JSON.stringify(buildSurveyFixtures(contextFor(config)))).toBe(JSON.stringify(tables));
    const other = buildSurveyFixtures(contextFor({ ...config, seed: config.seed + 1 }));
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(tables));
    expect(rows(other, SURVEY)[0]?.survey_id).not.toBe(rows(tables, SURVEY)[0]?.survey_id);
  });

  it('draws each site from its own stream', () => {
    const changed = buildWith(variant((copy) => Object.assign(copy.sites['tenant-b'].counts, { surveys: 6, surveyResponses: 30 })));
    expect(rows(siteRows(changed, 'tenant-b'), SURVEY)).toHaveLength(6);
    expect(rows(siteRows(changed, 'tenant-b'), RESPONSE)).toHaveLength(30);
    expect(siteRows(changed, 'tenant-a')).toEqual(siteRows(tables, 'tenant-a'));
  });
});

describe('edge configurations', () => {
  it.each([1, 3, 4])('tenant-b with %i surveys takes the first base statuses once each', (surveys) => {
    const out = buildWith(variant((copy) => Object.assign(copy.sites['tenant-b'].counts, { surveys })));
    const own = siteRows(out, 'tenant-b');
    expect(rows(own, SURVEY).map((row) => row.status).sort()).toEqual(BASE_STATUSES.slice(0, surveys).sort());
    expect(rows(own, SCHEDULE)).toHaveLength(rows(own, SURVEY).filter((row) => row.status !== 'DRAFT').length);
    expect(rows(own, RESPONSE)).toHaveLength(20);
  });

  it('tenant-b without responses keeps its surveys and schedules but answers none', () => {
    const out = buildWith(variant((copy) => Object.assign(copy.sites['tenant-b'].counts, { surveyResponses: 0 })));
    const own = siteRows(out, 'tenant-b');
    expect([rows(own, SURVEY).length, rows(own, SCHEDULE).length, rows(own, RESPONSE).length]).toEqual([2, 2, 0]);
    expect(siteRows(out, 'tenant-a')).toEqual(siteRows(tables, 'tenant-a'));
  });

  it('keeps DRAFTs in a short history window, schedules 30 days back and reminders due after the business date unsent', () => {
    const edited = variant((copy) => {
      copy.historyDays = 10;
      copy.sites['tenant-a'].counts.surveys = 60;
    });
    const context = contextFor(edited);
    const out = buildSurveyFixtures(context);
    const due = context.calendar.localTimestamp(0, 0);
    for (const row of rows(out, SURVEY)) {
      const day = context.calendar.dayOffsetOf(text(row, 'created').slice(0, 10));
      if (row.status === 'DRAFT') expect(day >= -10 && day <= -1).toBe(true);
      else expect(day).toBe(-30);
    }
    const future = rows(out, REMINDER).filter((row) => text(row, 'remind_at') >= due);
    expect(future.length).toBeGreaterThan(0);
    for (const row of future) expect(row.sent_at).toBeNull();
    expect(rows(out, RESPONSE).every((row) => text(row, 'created') < due)).toBe(true);
  });

  it.each([
    ['tenant-b has no groups', { groups: 0, systemUsers: 0, surveys: 0 }],
    ['tenant-b has no system users', { systemUsers: 0, surveys: 0 }],
  ] as const)('without a partner site (%s) tenant-a targets and answers only from itself', (_label, tenantB) => {
    const edited = variant((copy) => {
      Object.assign(copy.sites['tenant-b'].counts, tenantB);
      copy.sites['tenant-a'].counts.multiSiteResponses = 0;
    });
    const out = buildWith(edited, true);
    expect(rows(out, SURVEY)).toHaveLength(20);
    expect(rows(out, TARGET).every((row) => row.siteID === 'tenant-a')).toBe(true);
    expect(rows(out, RESPONSE)).toHaveLength(500);
    expect(rows(out, RESPONSE).every((row) => row.respondentSiteID === 'tenant-a')).toBe(true);
  });

  it.each([
    ['surveys on a site without a surveys.manager', 'umbrella', { surveys: 1 }, NO_MANAGER],
    ['more multi-site responses than responses', 'tenant-b', { multiSiteResponses: 21 }, OVER_MULTI_SITE],
    ['multi-site responses when no other site has groups', 'tenant-b', { groups: 0, systemUsers: 0, surveys: 0 }, NO_PARTNER],
    ['multi-site responses when no other site has respondents', 'tenant-b', { systemUsers: 0, surveys: 0 }, NO_PARTNER],
  ] as const)('rejects %s', (_label, site, counts, message) => {
    const context = contextFor(variant((copy) => Object.assign(copy.sites[site].counts, counts)));
    expect(() => buildSurveyFixtures(context)).toThrow(RangeError);
    expect(() => buildSurveyFixtures(context)).toThrow(message);
  });

  it.each(['survey', 'survey_schedule', 'survey_reminder', 'survey_target', 'survey_response'])(
    'rejects a registry without %s',
    async (table) => {
      onTestFinished(() => {
        vi.doUnmock('../../src/fixture-tables.js');
        vi.resetModules();
      });
      vi.doMock('../../src/fixture-tables.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/fixture-tables.js')>();
        return { ...actual, FIXTURE_TABLE_SPECS: actual.FIXTURE_TABLE_SPECS.filter((entry) => entry.table !== table) };
      });
      vi.resetModules();
      const { buildSurveyFixtures: build } = await import('../../src/fixtures/surveys.js');
      expect(() => build(ctx)).toThrow(new RangeError(`No surveys fixture table ${table}`));
    },
  );
});
