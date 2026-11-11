// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { csvBytes, pdfBytes, sha256Hex, toHex, xlsxBytes, type TableRows } from '../bytes.js';
import { SITE_ORDER, type SiteKey } from '../config.js';
import { printable } from '../errors.js';
import {
  FIXTURE_TABLE_SPECS,
  fixtureKey,
  fixtureKeys,
  specForKey,
  type FixtureContext,
  type FixtureRow,
  type FixtureTables,
} from '../fixture-tables.js';
import { cfUuidFrom } from '../ids.js';
import type { SeedRandom } from '../random.js';

const MODULE = 'reporting';
const EXPORTER = 'reporting.exporter';
const EMPLOYEE = 'timesheets.employee';
// The only site seeded with a definition the export runner cannot read, and so the only site with failed jobs.
const FAILING_SITE: SiteKey = 'tenant-a';
const FAILED_EVERY = 10;
// Error the fixture export runner (cfml/modules/reporting.cfc) records for a job on a `broken` source.
const SOURCE_UNAVAILABLE = 'source-unavailable';
const WORK_START = 7 * 60;
const WORK_END = 18 * 60;
const MINUTES_PER_DAY = 1440;

type Format = 'xlsx' | 'csv' | 'pdf';

interface FormatSpec {
  contentType: string;
  render(table: TableRows, title: string, modifiedAt: string): Buffer;
}

const FORMAT_CYCLE: readonly Format[] = ['xlsx', 'csv', 'pdf'];

const FORMATS: Readonly<Record<Format, FormatSpec>> = {
  xlsx: {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    render: (table, _title, modifiedAt) => xlsxBytes(table, { modifiedAt }),
  },
  csv: { contentType: 'text/csv', render: (table) => csvBytes(table) },
  pdf: { contentType: 'application/pdf', render: (table, title) => pdfBytes(title, table.map((row) => row.join(' | '))) },
};

const SHEET_STATUSES = ['DRAFT', 'SUBMITTED', 'PARTIALLY_APPROVED', 'APPROVED', 'RETURNED'] as const;
const FINANCE_STATES = ['IN-PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RE-SUBMITTED'] as const;
const FINANCE_TITLES = ['Travel', 'Equipment', 'Consulting', 'Training', 'Supplies', 'Licences'] as const;

/** Draw inputs for one source row of an export preview table. */
interface RowDraw {
  rng: SeedRandom;
  ctx: FixtureContext;
  /** Day offset of the job; every source value predates it. */
  dayOffset: number;
  /** Non-reserved timesheet employees of the site. */
  people: readonly string[];
}

const millis = (rng: SeedRandom): number => rng.int(0, 99) * 10;

/** One consistent `tvf_timesheet_status` row, every value as the runner's string form. */
function sheetRow(d: RowDraw) {
  const { rng, ctx } = d;
  const status = rng.pick(SHEET_STATUSES);
  const dayCount = rng.int(5, 20);
  const blackoutCount = rng.int(0, 2);
  const open = dayCount - blackoutCount;
  const approved = status === 'APPROVED' ? open : status === 'PARTIALLY_APPROVED' ? rng.int(1, open - 1) : 0;
  return {
    timesheet_id: cfUuidFrom(rng),
    person_id: rng.pick(d.people),
    period_start: ctx.calendar.localDate(ctx.calendar.mondayOnOrBefore(d.dayOffset - rng.int(0, 56))),
    status,
    overdue: status === 'DRAFT' && rng.bool() ? '1' : '0',
    day_count: String(dayCount),
    blackout_count: String(blackoutCount),
    approved_count: String(approved),
  };
}

/** One consistent `finance_record` row, every value as the runner's string form. */
function financeRow(d: RowDraw) {
  const { rng, ctx } = d;
  const createdDay = d.dayOffset - rng.int(8, 60);
  const created = ctx.calendar.localTimestamp(createdDay, rng.int(WORK_START, WORK_END), millis(rng));
  const period = ctx.calendar.localDate(createdDay).slice(0, 7);
  const state = rng.pick(FINANCE_STATES);
  const cents = rng.int(1_000, 2_500_000);
  return {
    record_id: cfUuidFrom(rng),
    title: `${rng.pick(FINANCE_TITLES)} ${period}`,
    amount: `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}00`,
    period,
    state,
    version: String(state === 'IN-PROGRESS' ? 1 : rng.int(2, 5)),
    created,
    lastUpdate: ctx.calendar.addMinutes(created, rng.int(60, 7 * MINUTES_PER_DAY)),
  };
}

/** Definition the fixture runner can export; its columns are names of its source's result set. */
type ValidDefinition =
  | { name: string; source: 'timesheets.sheets'; columns: readonly (keyof ReturnType<typeof sheetRow>)[] }
  | { name: string; source: 'finance.records'; columns: readonly (keyof ReturnType<typeof financeRow>)[] };

const VALID_DEFINITIONS: readonly ValidDefinition[] = [
  { name: 'Timesheet status', source: 'timesheets.sheets', columns: ['timesheet_id', 'person_id', 'period_start', 'status', 'overdue'] },
  { name: 'Finance records', source: 'finance.records', columns: ['record_id', 'title', 'amount', 'period', 'state'] },
  {
    name: 'Timesheet day counts',
    source: 'timesheets.sheets',
    columns: ['timesheet_id', 'status', 'day_count', 'blackout_count', 'approved_count'],
  },
  { name: 'Finance record history', source: 'finance.records', columns: ['record_id', 'state', 'version', 'created', 'lastUpdate'] },
];

const BROKEN_DEFINITION = { name: 'Archived ledger extract', source: 'broken', columns: ['ledger_id', 'account', 'amount'] } as const;

/** A seeded valid definition with its id. */
interface SeededDefinition {
  definitionId: string;
  template: ValidDefinition;
}

/** Definitions of one site: rows in load order, the valid ones, and the broken one's id. */
interface SiteDefinitions {
  rows: FixtureRow[];
  valid: SeededDefinition[];
  brokenId: string | null;
}

/** `synthetic.export_definition` row in DDL column order. */
function definitionRow(definitionId: string, siteID: SiteKey, def: { name: string; source: string; columns: readonly string[] }): FixtureRow {
  return { definition_id: definitionId, siteID, name: def.name, source: def.source, columns: JSON.stringify(def.columns) };
}

/** `count` definitions of `siteID`, cycling the valid catalogue; on the failing site the last of them is broken. */
function buildDefinitions(siteID: SiteKey, count: number, rng: SeedRandom): SiteDefinitions {
  // The broken definition counts towards counts.exportDefinitions, so the site's row count always equals its configured count.
  const broken = siteID === FAILING_SITE && count > 0;
  const valid = Array.from({ length: count - (broken ? 1 : 0) }, (_, i): SeededDefinition => {
    const base = VALID_DEFINITIONS[i % VALID_DEFINITIONS.length] as ValidDefinition;
    const round = Math.floor(i / VALID_DEFINITIONS.length);
    return { definitionId: cfUuidFrom(rng), template: round === 0 ? base : { ...base, name: `${base.name} ${round + 1}` } };
  });
  const brokenId = broken ? cfUuidFrom(rng) : null;
  const rows = valid.map((def) => definitionRow(def.definitionId, siteID, def.template));
  if (brokenId !== null) rows.push(definitionRow(brokenId, siteID, BROKEN_DEFINITION));
  return { rows, valid, brokenId };
}

/** Header of the definition's columns, then a few drawn source rows. */
function exportTable(def: ValidDefinition, d: RowDraw): string[][] {
  const rows = Array.from({ length: d.rng.int(3, 6) }, (): string[] => {
    if (def.source === 'timesheets.sheets') {
      const row = sheetRow(d);
      return def.columns.map((column) => row[column]);
    }
    const row = financeRow(d);
    return def.columns.map((column) => row[column]);
  });
  return [[...def.columns], ...rows];
}

/** Terminal `synthetic.export_job` rows of one site in creation order; formats cycle and every tenth job on the failing site fails. */
function buildJobs(ctx: FixtureContext, siteID: SiteKey, rng: SeedRandom, defs: SiteDefinitions): FixtureRow[] {
  const count = ctx.config.sites[siteID].counts.exportJobs;
  if (count === 0) return [];
  const exporters = ctx.index.actors(siteID, EXPORTER);
  if (exporters.length === 0 || defs.valid.length === 0) {
    throw printable(new RangeError(`Site ${siteID} needs a ${EXPORTER} actor and a valid export definition for its ${count} export jobs`));
  }
  const people = ctx.index.actors(siteID, EMPLOYEE).filter((id) => !ctx.index.isReserved(id));
  const { calendar } = ctx;
  const starts = Array.from({ length: count }, () => {
    const dayOffset = rng.int(-ctx.config.historyDays, -1);
    return { dayOffset, created: calendar.localTimestamp(dayOffset, rng.int(WORK_START, WORK_END), millis(rng)) };
  }).sort((a, b) => calendar.compareTimestamps(a.created, b.created));

  return starts.map(({ dayOffset, created }, i): FixtureRow => {
    const format = FORMAT_CYCLE[i % FORMAT_CYCLE.length] as Format;
    const jobId = cfUuidFrom(rng);
    const requestedBy = rng.pick(exporters);
    const startedAt = calendar.addMinutes(created, rng.int(1, 5));
    const finishedAt = calendar.addMinutes(startedAt, rng.int(1, 20));
    const head = { job_id: jobId, siteID };
    const times = { requested_by_id: requestedBy, created, started_at: startedAt, finished_at: finishedAt };
    if (defs.brokenId !== null && i % FAILED_EVERY === FAILED_EVERY - 1) {
      return {
        ...head,
        definition_id: defs.brokenId,
        format,
        state: 'failed',
        ...times,
        error: SOURCE_UNAVAILABLE,
        file_name: null,
        content_type: null,
        output: null,
        output_sha256: null,
      };
    }
    const def = rng.pick(defs.valid);
    const spec = FORMATS[format];
    const bytes = spec.render(exportTable(def.template, { rng, ctx, dayOffset, people }), def.template.name, finishedAt);
    return {
      ...head,
      definition_id: def.definitionId,
      format,
      state: 'done',
      ...times,
      error: null,
      file_name: `export-${jobId}.${format}`,
      content_type: spec.contentType,
      output: toHex(bytes),
      output_sha256: sha256Hex(bytes),
    };
  });
}

/** Builds the reporting fixture tables: export definitions and terminal export jobs with their generated output. */
export function buildReportingFixtures(ctx: FixtureContext): FixtureTables {
  const tables: FixtureTables = Object.fromEntries(
    fixtureKeys(ctx.config)
      .filter((key) => specForKey(key).spec.module === MODULE)
      .map((key): [string, FixtureRow[]] => [key, []]),
  );
  const definitions = rowsOf(tables, 'export_definition');
  const jobs = rowsOf(tables, 'export_job');
  for (const siteID of SITE_ORDER) {
    const rng = ctx.random.fork(`${MODULE}/${siteID}`);
    const defs = buildDefinitions(siteID, ctx.config.sites[siteID].counts.exportDefinitions, rng);
    definitions.push(...defs.rows);
    jobs.push(...buildJobs(ctx, siteID, rng, defs));
  }
  return tables;
}

/** Row list of the reporting table `table` in `tables`; throws `RangeError` when the registry has no such table. */
function rowsOf(tables: FixtureTables, table: string): FixtureRow[] {
  const spec = FIXTURE_TABLE_SPECS.find((entry) => entry.module === MODULE && entry.table === table);
  const rows = spec === undefined ? undefined : tables[fixtureKey(spec)];
  if (rows === undefined) throw new RangeError(`No ${MODULE} fixture table ${table}`);
  return rows;
}
