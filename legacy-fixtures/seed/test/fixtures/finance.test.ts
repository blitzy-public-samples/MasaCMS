// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/bytes.js';
import { loadConfig, parseConfig, type SeedConfig, type SiteKey } from '../../src/config.js';
import { fixtureKeys, specForKey, type FixtureContext, type FixtureRow, type FixtureTables } from '../../src/fixture-tables.js';
import { buildFinanceFixtures } from '../../src/fixtures/finance.js';
import { buildMasa, indexMasa } from '../../src/masa.js';
import { MONEY_PATTERN, formatUnits, fromCents } from '../../src/money.js';
import { createRandom } from '../../src/random.js';
import { createCalendar } from '../../src/time.js';

const CONFIG_PATH = fileURLToPath(new URL('../../seed.config.json', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DDL_PATH = `${REPO_ROOT}legacy-fixtures/sql/finance/110_tables.program.sql`;
const TRANSITIONS_PATH = `${REPO_ROOT}opt2/reports/state-machines/finance.json`;
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{2}0$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const PREPARER = 'finance.preparer';
const APPROVER = 'finance.approver';
const FINAL_STATES = ['IN-PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RE-SUBMITTED'] as const;
const TABLES = ['finance_record', 'finance_record_version', 'finance_attachment'] as const;
const PROGRAMS = [
  [1, 'tenant-a'],
  [2, 'tenant-b'],
] as const;
const SNAPSHOT_FIELDS = ['title', 'amount', 'period'] as const;
const ATTACHMENT_KINDS = [
  ['invoice', 'pdf', 'application/pdf', '%PDF-1.4\n'],
  ['receipt', 'png', 'image/png', '\x89PNG\r\n\x1a\n'],
  ['ledger', 'csv', 'text/csv', 'line,description,amount\r\n'],
] as const;

type Table = (typeof TABLES)[number];
type ProgramRows = Record<Table, FixtureRow[]>;

/** One column of a `CREATE TABLE` block; `width` is null for unsized and `max` types. */
interface DdlColumn {
  name: string;
  type: string;
  width: number | null;
  nullable: boolean;
}

/** One row of the exported finance transition table. */
interface TransitionRow {
  from: string;
  action: string;
  role: string;
  outcome: string;
  to: string | null;
}

/** The parts of `seed.config.json` the variants edit. */
interface RawConfig {
  historyDays: number;
  sites: Record<SiteKey, { counts: Record<string, number> }>;
}

let raw: RawConfig;
let config: SeedConfig;
let ctx: FixtureContext;
let tables: FixtureTables;
let ddl: Map<string, DdlColumn[]>;
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

/** Whether `value` loads into `column` through the conversions of `usp_seed_finance`. */
function fits(value: FixtureRow[string] | undefined, column: DdlColumn): boolean {
  if (value === null) return column.nullable;
  if (typeof value === 'number') return column.type === 'int' && Number.isSafeInteger(value);
  if (typeof value !== 'string') return false;
  if (column.type === 'char') return value.length === column.width;
  if (column.type === 'nvarchar') return value.length > 0 && value.length <= (column.width ?? 0);
  if (column.type === 'numeric') return MONEY_PATTERN.test(value);
  if (column.type === 'datetime') return TS.test(value);
  return column.type === 'varbinary' && HEX.test(value);
}

function transitionKey(from: string, action: string, role: string): string {
  return `${from}|${action}|${role}`;
}

/** Fixture context as the generator wires it: Masa from the `masa` fork, finance from `fixtures/finance`. */
function context(c: SeedConfig): FixtureContext {
  const random = createRandom(c.seed);
  const calendar = createCalendar(c.businessDate);
  const masa = buildMasa(c, random.fork('masa'), calendar);
  return { config: c, random: random.fork('fixtures/finance'), calendar, masa, index: indexMasa(masa, c) };
}

/** `seed.config.json` with `edit` applied to a copy, validated by `parseConfig`. */
function variant(edit: (copy: RawConfig) => void): SeedConfig {
  const copy = structuredClone(raw);
  edit(copy);
  return parseConfig(copy);
}

/** The finance tables of `Program_<programId>`; throws when one is missing. */
function programRows(t: FixtureTables, programId: number): ProgramRows {
  const rows = (table: Table): FixtureRow[] => {
    const found = t[`Program_${programId}.${table}`];
    if (found === undefined) throw new Error(`No Program_${programId}.${table}`);
    return found;
  };
  return {
    finance_record: rows('finance_record'),
    finance_record_version: rows('finance_record_version'),
    finance_attachment: rows('finance_attachment'),
  };
}

/** UserIDs holding the Masa group of `role` in the private user pool of `site`. */
function holders(c: FixtureContext, site: SiteKey, role: string): Set<string> {
  const pool = c.index.site(site).privateUserPoolID;
  const group = c.config.roleGroups[role];
  return new Set(c.masa.memberships.filter((m) => m.groupSiteID === pool && m.groupname === group).map((m) => m.userID));
}

/** Version rows grouped by record id, in dataset order. */
function versionsByRecord(versions: readonly FixtureRow[]): Map<string, FixtureRow[]> {
  const grouped = new Map<string, FixtureRow[]>();
  for (const row of versions) {
    const id = String(row.record_id);
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  return grouped;
}

/** Departures of the records and versions of `site` from a legal lifecycle replay by the site's finance role holders. */
function lifecycleProblems(c: FixtureContext, site: SiteKey, p: ProgramRows): string[] {
  const preparers = holders(c, site, PREPARER);
  const approvers = holders(c, site, APPROVER);
  const roleOf = (userID: string): string => (preparers.has(userID) ? PREPARER : approvers.has(userID) ? APPROVER : 'none');
  const byRecord = versionsByRecord(p.finance_record_version);
  const problems: string[] = [];
  if ([...byRecord.keys()].join() !== p.finance_record.map((r) => r.record_id).join()) problems.push('versions are not grouped in record order');
  for (const record of p.finance_record) {
    const fail = (what: string): void => {
      problems.push(`${String(record.record_id)}: ${what}`);
    };
    const versions = byRecord.get(String(record.record_id)) ?? [];
    const first = versions[0];
    const last = versions.at(-1);
    if (first === undefined || last === undefined) {
      fail('has no versions');
      continue;
    }
    if (record.siteID !== site) fail(`siteID ${String(record.siteID)}`);
    if (roleOf(String(record.createdByID)) !== PREPARER) fail('owner is not a preparer');
    if ([first.action, first.state, first.actor_user_id, first.created].join() !== ['create', 'IN-PROGRESS', record.createdByID, record.created].join()) {
      fail('version 1 is not the owner create');
    }
    versions.forEach((v, i) => {
      if (v.version !== i + 1) fail(`version ${i + 1} numbered ${String(v.version)}`);
    });
    for (let i = 1; i < versions.length; i += 1) {
      const prev = versions[i - 1] as FixtureRow;
      const cur = versions[i] as FixtureRow;
      const actor = String(cur.actor_user_id);
      const to = legal.get(transitionKey(String(prev.state), String(cur.action), roleOf(actor)));
      if (to !== cur.state) fail(`v${i + 1} ${String(cur.action)} by ${roleOf(actor)} from ${String(prev.state)} to ${String(cur.state)} is illegal`);
      if (roleOf(actor) === PREPARER && actor !== record.createdByID) fail(`v${i + 1} preparer step by someone other than the owner`);
      if (String(cur.created) <= String(prev.created)) fail(`v${i + 1} is not after v${i}`);
      const changed = SNAPSHOT_FIELDS.filter((field) => cur[field] !== prev[field]);
      if (changed.length !== (cur.action === 'edit' ? 1 : 0)) fail(`v${i + 1} ${String(cur.action)} changed [${changed.join()}]`);
    }
    for (const field of ['state', ...SNAPSHOT_FIELDS] as const) if (record[field] !== last[field]) fail(`${field} is not its last version's`);
    if (record.version !== versions.length) fail(`version ${String(record.version)} of ${versions.length} versions`);
    const expected = versions.length === 1 ? [null, null] : [last.created, last.actor_user_id];
    if (record.lastUpdate !== expected[0] || record.lastUpdateByID !== expected[1]) fail('lastUpdate does not name its last version');
  }
  return problems;
}

/** `yyyy-MM` months of the history window, which ends the day before the business date. */
function windowMonths(c: FixtureContext): Set<string> {
  const months = new Set<string>();
  for (let day = -c.config.historyDays; day <= -1; day += 1) months.add(c.calendar.localDate(day).slice(0, 7));
  return months;
}

/** Timestamps outside 08:00 of the window's first day to 18:00 of its last, and periods outside the window or after their row's date. */
function timeProblems(c: FixtureContext, p: ProgramRows): string[] {
  const open = c.calendar.localTimestamp(-c.config.historyDays, 8 * 60);
  const close = c.calendar.localTimestamp(-1, 18 * 60, 990);
  const months = windowMonths(c);
  const stamps = [
    ...p.finance_record.flatMap((r) => [r.created, r.lastUpdate]),
    ...p.finance_record_version.map((v) => v.created),
    ...p.finance_attachment.map((a) => a.created),
  ].filter((ts): ts is string => typeof ts === 'string');
  const problems = stamps.filter((ts) => ts < open || ts > close || ts >= `${c.config.businessDate}T00:00:00.000`);
  for (const row of [...p.finance_record, ...p.finance_record_version]) {
    const period = String(row.period);
    const month = String(row.lastUpdate ?? row.created).slice(0, 7);
    if (!months.has(period) || period > month) problems.push(`period ${period} at ${month}`);
  }
  return problems;
}

/** Record and version amounts that are not whole-cent four-decimal strings in the drawn range. */
function amountProblems(p: ProgramRows): string[] {
  return [...p.finance_record, ...p.finance_record_version]
    .map((row) => String(row.amount))
    .filter((amount) => {
      const cents = Number(amount.replace('.', '')) / 100;
      // Drawn in 25.00..25000.00; an edit that redraws the unchanged amount adds 1.00.
      return !MONEY_PATTERN.test(amount) || !Number.isSafeInteger(cents) || formatUnits(fromCents(cents)) !== amount || cents < 2_500 || cents > 2_500_100;
    });
}

/** Departures of each attachment from its record, its kind in the PDF, PNG, CSV cycle, or its own bytes. */
function attachmentProblems(p: ProgramRows): string[] {
  const records = new Map(p.finance_record.map((row, index) => [String(row.record_id), { row, index }]));
  const problems: string[] = [];
  let previous = -1;
  p.finance_attachment.forEach((a, i) => {
    const fail = (what: string): void => {
      problems.push(`${String(a.file_name)}: ${what}`);
    };
    const target = records.get(String(a.record_id));
    if (target === undefined) {
      fail('references no record of its program');
      return;
    }
    if (target.index <= previous) fail('is not in record order on a distinct record');
    previous = target.index;
    const [stem, extension, contentType, magic] = ATTACHMENT_KINDS[i % ATTACHMENT_KINDS.length] as (typeof ATTACHMENT_KINDS)[number];
    if (a.file_name !== `${stem}-${String(i + 1).padStart(4, '0')}.${extension}` || a.content_type !== contentType) fail('breaks the kind cycle');
    const bytes = Buffer.from(String(a.content), 'hex');
    if (a.size_bytes !== bytes.length || a.sha256 !== sha256Hex(bytes)) fail('size or digest differs from its bytes');
    if (!bytes.toString('latin1').startsWith(magic)) fail(`does not start like a ${extension}`);
    if (a.createdByID !== target.row.createdByID) fail('uploader is not the record owner');
    if (String(a.created) <= String(target.row.created)) fail('is not after its record was created');
    if (extension === 'pdf') {
      const text = bytes.toString('latin1');
      const lines = [`Record ${String(a.record_id)}`, `Period ${String(target.row.period)}`, `Amount ${String(target.row.amount)}`];
      if (!lines.every((line) => text.includes(`(${line}) Tj`))) fail('does not show its record, period and amount');
    }
    if (extension === 'csv') {
      const items = bytes.toString('utf8').split('\r\n').slice(1, -1);
      const valid = items.every((line, n) => line.startsWith(`${n + 1},`) && MONEY_PATTERN.test(line.slice(line.lastIndexOf(',') + 1)));
      if (items.length === 0 || !valid) fail('ledger lines are not numbered amounts');
    }
  });
  return problems;
}

beforeAll(async () => {
  raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as RawConfig;
  config = await loadConfig(CONFIG_PATH);
  ctx = context(config);
  tables = buildFinanceFixtures(ctx);
  ddl = parseDdl(await readFile(DDL_PATH, 'utf8'));
  const machine = JSON.parse(await readFile(TRANSITIONS_PATH, 'utf8')) as { rows: TransitionRow[] };
  legal = new Map(machine.rows.filter((row) => row.outcome === 'legal').map((row) => [transitionKey(row.from, row.action, row.role), row.to ?? row.from]));
});

describe('finance tables', () => {
  it('returns exactly the finance dataset keys, in registry order, without the rollup', () => {
    const keys = fixtureKeys(config).filter((key) => specForKey(key).spec.module === 'finance');
    expect(Object.keys(tables)).toEqual(keys);
    expect(keys).toEqual(TABLES.flatMap((table) => PROGRAMS.map(([id]) => `Program_${id}.${table}`)));
  });

  it.each(PROGRAMS.flatMap(([id]) => TABLES.map((table) => [`Program_${id}.${table}`, id, table] as const)))(
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
    [1, 'tenant-a', 3000, 300],
    [2, 'tenant-b', 300, 30],
  ] as const)('Program_%i (%s) holds %i records and %i attachments, as seed.config.json sets', (id, site, records, attachments) => {
    const p = programRows(tables, id);
    expect([config.sites[site].counts.financeRecords, config.sites[site].counts.financeAttachments]).toEqual([records, attachments]);
    expect([p.finance_record.length, p.finance_attachment.length]).toEqual([records, attachments]);
    expect(p.finance_record_version).toHaveLength(p.finance_record.reduce((sum, r) => sum + Number(r.version), 0));
  });

  it('keys are unique CF UUIDs, distinct from Masa ids, and versions are unique per record', () => {
    const all = PROGRAMS.map(([id]) => programRows(tables, id));
    const ids = all.flatMap((p) => [
      ...p.finance_record.map((r) => String(r.record_id)),
      ...p.finance_record_version.map((v) => String(v.version_id)),
      ...p.finance_attachment.map((a) => String(a.attachment_id)),
    ]);
    expect(ids.filter((id) => !CF_UUID.test(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    const masaIds = new Set([...ctx.masa.users.map((u) => u.userID), ...ctx.masa.groups.map((g) => g.groupID), ...ctx.masa.content.map((c) => c.contentID)]);
    expect(ids.filter((id) => masaIds.has(id))).toEqual([]);
    const pairs = all.flatMap((p) => p.finance_record_version.map((v) => `${String(v.record_id)}|${String(v.version)}`));
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});

describe('finance lifecycle', () => {
  it.each(PROGRAMS)('Program_%i versions replay a legal path by %s role holders to each record state', (id, site) => {
    expect(lifecycleProblems(ctx, site, programRows(tables, id))).toEqual([]);
  });

  it.each(PROGRAMS)('Program_%i opens with one record per final state, each edited before its first submit', (id) => {
    const p = programRows(tables, id);
    const byRecord = versionsByRecord(p.finance_record_version);
    const actions = (record: FixtureRow): string[] => (byRecord.get(String(record.record_id)) ?? []).map((v) => String(v.action));
    const leading = p.finance_record.slice(0, FINAL_STATES.length);
    expect(leading.map((r) => r.state)).toEqual([...FINAL_STATES]);
    for (const record of leading) {
      const steps = actions(record);
      const submit = steps.indexOf('submit');
      expect(steps.indexOf('edit')).toBeGreaterThan(0);
      expect(submit === -1 || steps.indexOf('edit') < submit).toBe(true);
    }
    const resubmitted = actions(leading[4] as FixtureRow);
    expect(resubmitted.lastIndexOf('reject')).toBeLessThan(resubmitted.lastIndexOf('resubmit'));
    expect(resubmitted.at(-1)).toBe('resubmit');
    expect(new Set(p.finance_record.slice(FINAL_STATES.length).map((r) => r.state))).toEqual(new Set(FINAL_STATES));
  });
});

describe('finance values', () => {
  it.each(PROGRAMS)('Program_%i record and version amounts are whole-cent four-decimal strings', (id) => {
    expect(amountProblems(programRows(tables, id))).toEqual([]);
  });

  it.each(PROGRAMS)('Program_%i actors are %s private-pool finance role holders, never reserved rehearsal persons', (id, site) => {
    const p = programRows(tables, id);
    const actors = [
      ...p.finance_record.flatMap((r) => [r.createdByID, r.lastUpdateByID]),
      ...p.finance_record_version.map((v) => v.actor_user_id),
      ...p.finance_attachment.map((a) => a.createdByID),
    ].filter((userID): userID is string => typeof userID === 'string');
    const members = new Set([...holders(ctx, site, PREPARER), ...holders(ctx, site, APPROVER)]);
    const selectable = new Set([...ctx.index.actors(site, PREPARER), ...ctx.index.actors(site, APPROVER)]);
    expect(actors.length).toBeGreaterThan(0);
    expect(actors.filter((userID) => !members.has(userID) || !selectable.has(userID))).toEqual([]);
    expect(actors.filter((userID) => ctx.index.user(userID).siteID !== site || ctx.index.user(userID).isPublic !== 0)).toEqual([]);
    const text = JSON.stringify(p);
    expect(config.reserved.rehearsal.persons.filter((person) => text.includes(person))).toEqual([]);
  });

  it.each(PROGRAMS)('Program_%i attachments belong to their records and match their bytes', (id) => {
    expect(attachmentProblems(programRows(tables, id))).toEqual([]);
  });

  it.each(PROGRAMS)('Program_%i timestamps sit in the history window and periods never follow their row date', (id) => {
    expect(timeProblems(ctx, programRows(tables, id))).toEqual([]);
  });
});

describe('finance determinism and configuration', () => {
  it('equal contexts yield identical rows and the context stream is not consumed', () => {
    const text = JSON.stringify(tables);
    expect(JSON.stringify(buildFinanceFixtures(ctx))).toBe(text);
    expect(JSON.stringify(buildFinanceFixtures(context(config)))).toBe(text);
  });

  it('a different seed changes every program', () => {
    const other = buildFinanceFixtures(context({ ...config, seed: config.seed + 1 }));
    for (const [id] of PROGRAMS) {
      expect(programRows(other, id).finance_record[0]?.record_id).not.toBe(programRows(tables, id).finance_record[0]?.record_id);
    }
  });

  it('a program depends only on its own counts; three records take the first three final states and all attachments', () => {
    const small = context(variant((copy) => Object.assign(copy.sites['tenant-b'].counts, { financeRecords: 3, financeAttachments: 3 })));
    const rows = buildFinanceFixtures(small);
    expect(JSON.stringify(programRows(rows, 1))).toBe(JSON.stringify(programRows(tables, 1)));
    const p = programRows(rows, 2);
    expect(p.finance_record.map((r) => r.state)).toEqual(FINAL_STATES.slice(0, 3));
    expect(p.finance_attachment.map((a) => a.record_id)).toEqual(p.finance_record.map((r) => r.record_id));
    expect(p.finance_attachment.map((a) => a.file_name)).toEqual(['invoice-0001.pdf', 'receipt-0002.png', 'ledger-0003.csv']);
    expect([...lifecycleProblems(small, 'tenant-b', p), ...attachmentProblems(p), ...timeProblems(small, p)]).toEqual([]);
  });

  it('a program without records keeps its keys with empty lists', () => {
    const rows = buildFinanceFixtures(context(variant((copy) => Object.assign(copy.sites['tenant-a'].counts, { financeRecords: 0, financeAttachments: 0 }))));
    expect(Object.keys(rows)).toEqual(Object.keys(tables));
    expect(programRows(rows, 1)).toEqual({ finance_record: [], finance_record_version: [], finance_attachment: [] });
    expect(JSON.stringify(programRows(rows, 2))).toBe(JSON.stringify(programRows(tables, 2)));
  });

  it('a one-day history keeps every row in that day and period edits fall back to other fields', () => {
    const short = context(variant((copy) => Object.assign(copy, { historyDays: 1 })));
    const month = short.calendar.localDate(-1).slice(0, 7);
    for (const [id, site] of PROGRAMS) {
      const p = programRows(buildFinanceFixtures(short), id);
      expect([...lifecycleProblems(short, site, p), ...attachmentProblems(p), ...timeProblems(short, p), ...amountProblems(p)]).toEqual([]);
      expect(new Set(p.finance_record_version.map((v) => v.period))).toEqual(new Set([month]));
      expect(p.finance_record_version.filter((v) => v.action === 'edit').length).toBeGreaterThan(0);
    }
  });
});
