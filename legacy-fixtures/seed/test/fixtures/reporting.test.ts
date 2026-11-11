// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/bytes.js';
import { SITE_ORDER, loadConfig, parseConfig, type SeedConfig, type SiteCounts, type SiteKey } from '../../src/config.js';
import { fixtureKeys, specForKey, type FixtureContext, type FixtureRow, type FixtureTables } from '../../src/fixture-tables.js';
import { buildReportingFixtures } from '../../src/fixtures/reporting.js';
import { buildMasa, indexMasa } from '../../src/masa.js';
import { createRandom } from '../../src/random.js';
import { createCalendar } from '../../src/time.js';

const CONFIG_PATH = fileURLToPath(new URL('../../seed.config.json', import.meta.url));
const DDL_PATH = fileURLToPath(new URL('../../../sql/reporting/100_tables.sql', import.meta.url));
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;
const DEFINITIONS = 'synthetic.export_definition';
const JOBS = 'synthetic.export_job';
const FORMAT_CYCLE = ['xlsx', 'csv', 'pdf'] as const;
// Content types the fixture export runner (cfml/modules/reporting.cfc) records per format.
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  pdf: 'application/pdf',
};
const VALID_SOURCES = ['timesheets.sheets', 'finance.records'];
const CATALOGUE = [
  ['Timesheet status', 'timesheets.sheets'],
  ['Finance records', 'finance.records'],
  ['Timesheet day counts', 'timesheets.sheets'],
  ['Finance record history', 'finance.records'],
] as const;
const BROKEN = ['Archived ledger extract', 'broken'] as const;
const SHEET_STATUSES = ['DRAFT', 'SUBMITTED', 'PARTIALLY_APPROVED', 'APPROVED', 'RETURNED'];
const FINANCE_STATES = ['IN-PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RE-SUBMITTED'];
const MINUTE_MS = 60_000;

type SourceRow = Readonly<Record<string, string>>;
type CountChange = readonly [SiteKey, Partial<SiteCounts>];

let rawConfig: unknown;
let config: SeedConfig;
let ctx: FixtureContext;
let tables: FixtureTables;
let ddl: Map<string, string[]>;

/** Fixture context of `c`, built as the generator builds it. */
function contextFor(c: SeedConfig): FixtureContext {
  const random = createRandom(c.seed);
  const calendar = createCalendar(c.businessDate);
  const masa = buildMasa(c, random.fork('masa'), calendar);
  return { config: c, random: random.fork('fixtures/reporting'), calendar, masa, index: indexMasa(masa, c) };
}

/** Seed config parsed from a copy of the seed file with each change merged into its site's counts. */
function configWith(...changes: readonly CountChange[]): SeedConfig {
  const copy = structuredClone(rawConfig) as { sites: Record<SiteKey, { counts: Partial<SiteCounts> }> };
  for (const [site, counts] of changes) copy.sites[site].counts = { ...copy.sites[site].counts, ...counts };
  return parseConfig(copy);
}

/** Reporting tables of the seed config with `changes` applied. */
const buildWith = (...changes: readonly CountChange[]): FixtureTables => buildReportingFixtures(contextFor(configWith(...changes)));

/** Column names of each `CREATE TABLE [synthetic].[<table>]` block by dataset key, in catalog order. */
function parseDdlColumns(sql: string): Map<string, string[]> {
  return new Map(
    [...sql.matchAll(/CREATE TABLE \[synthetic\]\.\[([^\]]+)\] \(([\s\S]*?)\n\s*\) ON /g)].map(([, table = '', body = '']) => [
      `synthetic.${table}`,
      [...body.matchAll(/^\s*\[([^\]]+)\] \[/gm)].map(([, column = '']) => column),
    ]),
  );
}

/** Rows of dataset key `key` in `t`, optionally only those of `site`. */
const rowsOf = (t: FixtureTables, key: string, site?: SiteKey): FixtureRow[] =>
  (t[key] ?? []).filter((row) => site === undefined || row.siteID === site);

/** Minutes from timestamp `a` to timestamp `b`. */
const minutesBetween = (a: string, b: string): number => (Date.parse(`${b}Z`) - Date.parse(`${a}Z`)) / MINUTE_MS;

/** Definition rows of `t` by `definition_id`. */
const definitionsById = (t: FixtureTables): Map<string, FixtureRow> =>
  new Map(rowsOf(t, DEFINITIONS).map((row) => [String(row.definition_id), row]));

/** Checks per exported source column; `jobCreated` is the job's creation timestamp, `employees` the site's non-reserved employees. */
const COLUMN_CHECKS: Readonly<Record<string, (row: SourceRow, jobCreated: string, employees: readonly string[]) => void>> = {
  timesheet_id: (row) => expect(row.timesheet_id).toMatch(CF_UUID),
  person_id: (row, _jobCreated, employees) => expect(employees).toContain(row.person_id),
  period_start: (row, jobCreated) => {
    expect(ctx.calendar.weekday(ctx.calendar.dayOffsetOf(String(row.period_start)))).toBe(1);
    expect(String(row.period_start) <= jobCreated.slice(0, 10)).toBe(true);
  },
  status: (row) => expect(SHEET_STATUSES).toContain(row.status),
  overdue: (row) => expect(row.overdue === '0' || (row.overdue === '1' && row.status === 'DRAFT')).toBe(true),
  day_count: (row) => expect(Number(row.day_count)).toSatisfy((n: number) => Number.isInteger(n) && n >= 5 && n <= 20),
  blackout_count: (row) => expect(Number(row.blackout_count)).toSatisfy((n: number) => Number.isInteger(n) && n >= 0 && n <= 2),
  approved_count: (row) => {
    const open = Number(row.day_count) - Number(row.blackout_count);
    const approved = Number(row.approved_count);
    if (row.status === 'APPROVED') expect(approved).toBe(open);
    else if (row.status === 'PARTIALLY_APPROVED') expect(approved >= 1 && approved <= open - 1).toBe(true);
    else expect(approved).toBe(0);
  },
  record_id: (row) => expect(row.record_id).toMatch(CF_UUID),
  title: (row) => expect(row.title).toMatch(/^(Travel|Equipment|Consulting|Training|Supplies|Licences) \d{4}-\d{2}$/),
  amount: (row) => {
    expect(row.amount).toMatch(/^\d+\.\d{2}00$/);
    expect(Number(row.amount) >= 10 && Number(row.amount) <= 25_000).toBe(true);
  },
  period: (row, jobCreated) => {
    expect(row.period).toMatch(/^\d{4}-\d{2}$/);
    expect(String(row.period) <= jobCreated.slice(0, 7)).toBe(true);
    if (row.title !== undefined) expect(row.title.endsWith(` ${row.period}`)).toBe(true);
  },
  state: (row) => expect(FINANCE_STATES).toContain(row.state),
  version: (row) => {
    if (row.state === 'IN-PROGRESS') expect(row.version).toBe('1');
    else expect(['2', '3', '4', '5']).toContain(row.version);
  },
  created: (row, jobCreated) => {
    expect(row.created).toMatch(TS);
    expect(minutesBetween(String(row.created), jobCreated)).toBeGreaterThan(0);
  },
  lastUpdate: (row) => {
    expect(row.lastUpdate).toMatch(TS);
    expect(minutesBetween(String(row.created), String(row.lastUpdate))).toSatisfy((m: number) => m >= 60 && m <= 7 * 1440);
  },
};

beforeAll(async () => {
  rawConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  config = await loadConfig(CONFIG_PATH);
  ctx = contextFor(config);
  tables = buildReportingFixtures(ctx);
  ddl = parseDdlColumns(await readFile(DDL_PATH, 'utf8'));
});

describe('reporting fixture tables', () => {
  it('holds exactly the reporting dataset keys of fixtureKeys, in registry order', () => {
    const reporting = fixtureKeys(config).filter((key) => specForKey(key).spec.module === 'reporting');
    expect(reporting).toEqual([DEFINITIONS, JOBS]);
    expect(Object.keys(tables)).toEqual(reporting);
  });

  it.each([DEFINITIONS, JOBS])('%s rows carry the DDL columns in catalog order', (key) => {
    const columns = ddl.get(key);
    expect(columns?.length).toBeGreaterThan(0);
    for (const row of rowsOf(tables, key)) expect(Object.keys(row)).toEqual(columns);
  });

  it('keys are unique CF UUIDs and references are CF UUIDs', () => {
    const keys = [...rowsOf(tables, DEFINITIONS).map((row) => row.definition_id), ...rowsOf(tables, JOBS).map((row) => row.job_id)];
    expect(new Set(keys).size).toBe(keys.length);
    for (const id of keys) expect(id).toMatch(CF_UUID);
    for (const job of rowsOf(tables, JOBS)) {
      expect(job.definition_id).toMatch(CF_UUID);
      expect(job.requested_by_id).toMatch(CF_UUID);
    }
  });

  it.each([DEFINITIONS, JOBS])('%s rows are grouped by site in site order', (key) => {
    const sites = rowsOf(tables, key).map((row) => row.siteID as SiteKey);
    expect(sites).toEqual([...sites].sort((a, b) => SITE_ORDER.indexOf(a) - SITE_ORDER.indexOf(b)));
  });
});

describe('reporting counts', () => {
  it.each([
    ['umbrella', 0, 0, 0, 0],
    ['tenant-a', 5, 1, 200, 20],
    ['tenant-b', 2, 0, 10, 0],
  ] as const)('%s: definitions %i (broken %i), jobs %i (failed %i)', (site, definitions, broken, jobs, failed) => {
    expect([config.sites[site].counts.exportDefinitions, config.sites[site].counts.exportJobs]).toEqual([definitions, jobs]);
    expect(rowsOf(tables, DEFINITIONS, site)).toHaveLength(definitions);
    expect(rowsOf(tables, DEFINITIONS, site).filter((row) => row.source === 'broken')).toHaveLength(broken);
    expect(rowsOf(tables, JOBS, site)).toHaveLength(jobs);
    expect(rowsOf(tables, JOBS, site).filter((row) => row.state === 'failed')).toHaveLength(failed);
  });
});

describe('export definitions', () => {
  it.each([
    ['tenant-a', [...CATALOGUE, BROKEN]],
    ['tenant-b', CATALOGUE.slice(0, 2)],
  ] as const)('%s seeds the catalogue in order, broken definition last', (site, expected) => {
    expect(rowsOf(tables, DEFINITIONS, site).map((row) => [row.name, row.source])).toEqual(expected);
  });

  it('every site with jobs defines both valid sources', () => {
    for (const site of SITE_ORDER.filter((key) => config.sites[key].counts.exportJobs > 0)) {
      const sources = rowsOf(tables, DEFINITIONS, site).map((row) => row.source);
      expect(new Set(sources.filter((source) => source !== 'broken'))).toEqual(new Set(VALID_SOURCES));
    }
  });

  it('only tenant-a has a broken definition', () => {
    const broken = rowsOf(tables, DEFINITIONS).filter((row) => row.source === 'broken');
    expect(broken.map((row) => [row.siteID, row.name, row.columns])).toEqual([['tenant-a', BROKEN[0], '["ledger_id","account","amount"]']]);
  });

  it('columns are JSON arrays of distinct names and values fit their DDL widths', () => {
    for (const row of rowsOf(tables, DEFINITIONS)) {
      const columns: unknown = JSON.parse(String(row.columns));
      expect(Array.isArray(columns) && columns.every((column) => typeof column === 'string' && column.length > 0)).toBe(true);
      expect(new Set(columns as string[]).size).toBe((columns as string[]).length);
      expect(String(row.name).length).toBeLessThanOrEqual(100);
      expect(String(row.source).length).toBeLessThanOrEqual(50);
    }
  });
});

describe('export jobs', () => {
  it('reference a definition of their own site, the failed ones exactly the broken definition', () => {
    const definitions = definitionsById(tables);
    for (const job of rowsOf(tables, JOBS)) {
      const definition = definitions.get(String(job.definition_id));
      expect(definition?.siteID).toBe(job.siteID);
      expect(definition?.source === 'broken').toBe(job.state === 'failed');
    }
  });

  it("are requested by the site's non-reserved exporters", () => {
    for (const job of rowsOf(tables, JOBS)) {
      expect(ctx.index.actors(job.siteID as SiteKey, 'reporting.exporter')).toContain(job.requested_by_id);
      expect(ctx.index.isReserved(String(job.requested_by_id))).toBe(false);
    }
  });

  it.each(['tenant-a', 'tenant-b'] as const)('%s jobs run in creation order, cycle formats and fail every tenth only on tenant-a', (site) => {
    const jobs = rowsOf(tables, JOBS, site);
    jobs.forEach((job, i) => {
      expect(job.format).toBe(FORMAT_CYCLE[i % FORMAT_CYCLE.length]);
      expect(job.state).toBe(site === 'tenant-a' && i % 10 === 9 ? 'failed' : 'done');
      if (i > 0) expect(String(jobs[i - 1]?.created) <= String(job.created)).toBe(true);
    });
  });

  it('carry the columns the transition procedure leaves in their terminal state', () => {
    for (const job of rowsOf(tables, JOBS)) {
      if (job.state === 'failed') {
        expect(job).toMatchObject({ error: 'source-unavailable', file_name: null, content_type: null, output: null, output_sha256: null });
        continue;
      }
      expect(job.state).toBe('done');
      expect(job.error).toBeNull();
      expect(job.file_name).toBe(`export-${job.job_id}.${job.format}`);
      expect(job.content_type).toBe(CONTENT_TYPES[String(job.format)]);
      expect(job.output).toMatch(/^(?:[0-9a-f]{2})+$/);
      expect(job.output_sha256).toBe(sha256Hex(Buffer.from(String(job.output), 'hex')));
    }
  });

  it('timestamps run created < started_at < finished_at inside the history window before the business date', () => {
    const earliest = ctx.calendar.localTimestamp(-config.historyDays, 0);
    const asOf = ctx.calendar.localTimestamp(0, 0);
    for (const job of rowsOf(tables, JOBS)) {
      const created = String(job.created);
      const started = String(job.started_at);
      const finished = String(job.finished_at);
      for (const ts of [created, started, finished]) expect(ts).toMatch(TS);
      expect(created >= earliest).toBe(true);
      expect(minutesBetween(created, started)).toSatisfy((m: number) => m >= 1 && m <= 5);
      expect(minutesBetween(started, finished)).toSatisfy((m: number) => m >= 1 && m <= 20);
      expect(finished < asOf).toBe(true);
    }
  });
});

describe('export output', () => {
  it('renders a header of the definition columns and 3 to 6 source rows in the job format', () => {
    const definitions = definitionsById(tables);
    for (const job of rowsOf(tables, JOBS).filter((row) => row.state === 'done')) {
      const definition = definitions.get(String(job.definition_id));
      const columns = JSON.parse(String(definition?.columns)) as string[];
      const text = Buffer.from(String(job.output), 'hex').toString('latin1');
      if (job.format === 'csv') {
        const lines = text.split('\r\n');
        expect(lines.pop()).toBe('');
        expect(lines[0]).toBe(columns.join(','));
        expect(lines.length - 1).toSatisfy((n: number) => n >= 3 && n <= 6);
        for (const line of lines) expect(line.split(',')).toHaveLength(columns.length);
      } else if (job.format === 'xlsx') {
        expect(text.startsWith('PK\x03\x04')).toBe(true);
        const sheet = text.slice(text.indexOf('<sheetData>'), text.indexOf('</sheetData>'));
        const header = /<row r="1">(.*?)<\/row>/.exec(sheet)?.[1] ?? '';
        expect([...header.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map(([, cell]) => cell)).toEqual(columns);
        expect((sheet.match(/<row r="/g) ?? []).length - 1).toSatisfy((n: number) => n >= 3 && n <= 6);
      } else {
        expect(job.format).toBe('pdf');
        expect(text.startsWith('%PDF-1.4\n')).toBe(true);
        expect(text).toContain(`(${String(definition?.name)}) Tj`);
        expect(text).toContain(`(${columns.join(' | ')}) Tj`);
        expect((text.match(/\) Tj\n/g) ?? []).length - 2).toSatisfy((n: number) => n >= 3 && n <= 6);
      }
    }
  });

  it("csv rows hold consistent source values drawn before the job, persons from the site's non-reserved employees", () => {
    const definitions = definitionsById(tables);
    const csvJobs = rowsOf(tables, JOBS).filter((row) => row.state === 'done' && row.format === 'csv');
    expect(new Set(csvJobs.map((job) => definitions.get(String(job.definition_id))?.name))).toEqual(new Set(CATALOGUE.map(([name]) => name)));
    for (const job of csvJobs) {
      const site = job.siteID as SiteKey;
      const employees = ctx.index.actors(site, 'timesheets.employee').filter((id) => !ctx.index.isReserved(id));
      const text = Buffer.from(String(job.output), 'hex').toString('utf8');
      expect(text).not.toContain('"');
      const [header = [], ...rows] = text.trimEnd().split('\r\n').map((line) => line.split(','));
      for (const values of rows) {
        const row: SourceRow = Object.fromEntries(header.map((column, i) => [column, values[i] ?? '']));
        for (const column of header) {
          expect(COLUMN_CHECKS).toHaveProperty(column);
          COLUMN_CHECKS[column]?.(row, String(job.created), employees);
        }
      }
    }
  });
});

describe('determinism', () => {
  it('equal inputs yield identical tables', () => {
    expect(buildReportingFixtures(contextFor(config))).toEqual(tables);
  });

  it("each site draws from its own stream, so another site's counts leave its rows unchanged", () => {
    const changed = buildWith(['tenant-a', { exportDefinitions: 3, exportJobs: 40 }]);
    expect(rowsOf(changed, JOBS, 'tenant-a')).toHaveLength(40);
    for (const key of [DEFINITIONS, JOBS]) expect(rowsOf(changed, key, 'tenant-b')).toEqual(rowsOf(tables, key, 'tenant-b'));
  });
});

describe('edge counts', () => {
  it('builds empty tables when no site has definitions or jobs', () => {
    const none = { exportDefinitions: 0, exportJobs: 0 };
    expect(buildWith(['tenant-a', none], ['tenant-b', none])).toEqual({ [DEFINITIONS]: [], [JOBS]: [] });
  });

  it('seeds a lone broken definition on tenant-a with one definition and no jobs', () => {
    const built = buildWith(['tenant-a', { exportDefinitions: 1, exportJobs: 0 }]);
    expect(rowsOf(built, DEFINITIONS, 'tenant-a').map((row) => [row.name, row.source])).toEqual([BROKEN]);
    expect(rowsOf(built, JOBS, 'tenant-a')).toEqual([]);
  });

  it('fails the tenth tenant-a job and sends the other nine to its only valid definition', () => {
    const built = buildWith(['tenant-a', { exportDefinitions: 2, exportJobs: 10 }]);
    const [valid, broken] = rowsOf(built, DEFINITIONS, 'tenant-a');
    expect([valid?.source, broken?.source]).toEqual(['timesheets.sheets', 'broken']);
    const jobs = rowsOf(built, JOBS, 'tenant-a');
    expect(jobs.map((job) => job.definition_id)).toEqual([...Array<unknown>(9).fill(valid?.definition_id), broken?.definition_id]);
    expect(jobs.map((job) => job.state)).toEqual([...Array<string>(9).fill('done'), 'failed']);
  });

  it('suffixes catalogue names with their round past the first round', () => {
    const built = buildWith(['tenant-b', { exportDefinitions: 6 }]);
    expect(rowsOf(built, DEFINITIONS, 'tenant-b').map((row) => [row.name, row.source])).toEqual([
      ...CATALOGUE,
      ['Timesheet status 2', 'timesheets.sheets'],
      ['Finance records 2', 'finance.records'],
    ]);
  });

  it.each([
    ['tenant-b', { exportDefinitions: 0, exportJobs: 10 }, 10],
    ['tenant-a', { exportDefinitions: 1, exportJobs: 5 }, 5],
    ['umbrella', { exportDefinitions: 2, exportJobs: 1 }, 1],
  ] as const)('%s with %o throws RangeError for lack of an exporter or a valid definition', (site, counts, jobs) => {
    const context = contextFor(configWith([site, counts]));
    expect(() => buildReportingFixtures(context)).toThrow(RangeError);
    expect(() => buildReportingFixtures(context)).toThrow(
      `Site ${site} needs a reporting.exporter actor and a valid export definition for its ${jobs} export jobs`,
    );
  });
});

describe('table registry', () => {
  afterEach(() => {
    vi.doUnmock('../../src/fixture-tables.js');
    vi.resetModules();
  });

  it.each([
    ['export_definition', 'registry'],
    ['export_job', 'registry'],
    ['export_definition', 'dataset keys'],
    ['export_job', 'dataset keys'],
  ] as const)('throws RangeError when %s is missing from the %s', async (table, missing) => {
    vi.resetModules();
    vi.doMock('../../src/fixture-tables.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/fixture-tables.js')>();
      return missing === 'registry'
        ? { ...actual, FIXTURE_TABLE_SPECS: actual.FIXTURE_TABLE_SPECS.filter((entry) => entry.table !== table) }
        : { ...actual, fixtureKeys: (c: SeedConfig) => actual.fixtureKeys(c).filter((key) => key !== `synthetic.${table}`) };
    });
    const { buildReportingFixtures: build } = await import('../../src/fixtures/reporting.js');
    expect(() => build(ctx)).toThrow(RangeError);
    expect(() => build(ctx)).toThrow(`No reporting fixture table ${table}`);
  });
});
