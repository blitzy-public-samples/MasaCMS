// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig, roleGroupName, siteForProgram, SITE_ORDER, type SiteCounts, type SiteKey } from '../src/config.js';
import { generateCredentials, type SeedCredentials } from '../src/credentials.js';
import { datasetDigest, type Dataset } from '../src/dataset.js';
import type { DirectClient } from '../src/direct.js';
import { fixtureKeys, specForKey, type FixtureModule, type FixtureRow, type FixtureValue } from '../src/fixture-tables.js';
import { run, type GenerateDeps } from '../src/generate.js';
import { MASA_DEFAULT_MODULE_ID, MASA_FORMS_MODULE_ID, MASA_HOME_CONTENT_ID } from '../src/ids.js';
import type { MasaData, MembershipRow } from '../src/masa.js';
import { readDataset, type DatasetPart, type Manifest } from '../src/writer.js';

const PKG = fileURLToPath(new URL('../', import.meta.url));
const REPO_ROOT = resolve(PKG, '../..');
const CONFIG_PATH = join(PKG, 'seed.config.json');
const GENERATE_PATH = join(PKG, 'src', 'generate.ts');
const PINNED_SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const DDL_FILES: Readonly<Record<FixtureModule, string>> = {
  people: 'people/100_person_archive.sql',
  timesheets: 'timesheets/110_tables.program.sql',
  finance: 'finance/110_tables.program.sql',
  surveys: 'surveys/100_tables.sql',
  reporting: 'reporting/100_tables.sql',
  communications: 'communications/100_tables.sql',
  esignature: 'esignature/100_tables.sql',
};
// Columns the fixture procedures fill on load, so seeded rows omit them.
const LOADED_COLUMNS: Readonly<Record<string, readonly string[]>> = { audit_entry: ['seq', 'prev_hash', 'entry_hash'] };
const MASA_ARRAYS = ['sites', 'groups', 'users', 'memberships', 'categories', 'content', 'files', 'oauthClients'] as const;
const ROLES: readonly string[] = [
  'timesheets.employee',
  'timesheets.primary-approver',
  'timesheets.secondary-approver',
  'finance.preparer',
  'finance.approver',
  'esignature.signer',
  'esignature.auditor',
  'reporting.exporter',
  'surveys.manager',
  'communications.sender',
];
const SITE_ADMIN = 'site-admin';
const SYSTEM_USER = 'system-user';
const MEMBER = 'member';
const ROLE_SUBJECTS: readonly string[] = [...ROLES, SITE_ADMIN, SYSTEM_USER];
const INSTALLED_USERNAMES: readonly string[] = ['admin', 'qa_editor'];
const UNSEEDED_KEYS: readonly string[] = [
  'Program_1.finance_rollup',
  'Program_2.finance_rollup',
  'synthetic.program_site',
  'synthetic.finance_transition',
  'synthetic.timesheet_transition',
  'synthetic.transition_rule',
];
const TIMESHEET_STEPS: readonly { from: string; action: string; role: string; to: string }[] = [
  { from: 'DRAFT', action: 'submit', role: 'timesheets.employee', to: 'SUBMITTED' },
  ...['SUBMITTED', 'RESUBMITTED'].flatMap((from) => [
    { from, action: 'primary-approve', role: 'timesheets.primary-approver', to: 'PRIMARY_APPROVED' },
    { from, action: 'return', role: 'timesheets.primary-approver', to: 'RETURNED' },
  ]),
  { from: 'PRIMARY_APPROVED', action: 'secondary-approve', role: 'timesheets.secondary-approver', to: 'APPROVED' },
  { from: 'PRIMARY_APPROVED', action: 'return', role: 'timesheets.secondary-approver', to: 'RETURNED' },
  { from: 'RETURNED', action: 'resubmit', role: 'timesheets.employee', to: 'RESUBMITTED' },
];
const FINANCE_STEPS: ReadonlySet<string> = new Set([
  'IN-PROGRESS>SUBMITTED',
  'SUBMITTED>APPROVED',
  'SUBMITTED>REJECTED',
  'REJECTED>RE-SUBMITTED',
  'RE-SUBMITTED>APPROVED',
  'RE-SUBMITTED>REJECTED',
  'IN-PROGRESS>IN-PROGRESS',
  'REJECTED>REJECTED',
]);
const USER_COLUMNS = ['person_id', 'actor_user_id', 'createdByID', 'lastUpdateByID', 'respondent_user_id', 'requested_by_id', 'signer_user_id', 'archived_by_id'];
const SITE_COLUMNS = ['siteID', 'respondentSiteID'];
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{2}0$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const PASSWORD = /^[A-Za-z0-9_-]{24}a1A$/;
const CLIENT_SECRET = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_RUN = /[A-Za-z0-9_-]{27,}/g;
const SECRET_KEY = /"(password|clientsecret|secret)"\s*:/i;
const URLS_ERROR = 'seed: --direct needs OPT2_SERVICE_URLS, a JSON object of service name to URL\n';
const URLS_INVALID = 'seed: OPT2_SERVICE_URLS is not a JSON object of service name to http(s) URL';
const SERVICE_URL_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  ['people', 'timesheets', 'finance', 'surveys', 'reporting', 'communications', 'e-signature'].map((service) => [service, 'http://127.0.0.1:9']),
);
const SERVICE_URLS = JSON.stringify(SERVICE_URL_MAP);
const EARLIEST_DAY = '1753-01-01';

interface DdlColumn {
  name: string;
  type: string;
  size: string | undefined;
  nullable: boolean;
}

/** The parts of `seed.config.json` the CLI failure cases edit. */
interface RawConfig {
  businessDate: string;
  sites: Record<'tenant-b', { counts: Record<string, number> }>;
}

interface Run {
  code: number;
  out: string;
  state: string;
  log: string[];
}

/** `CREATE TABLE` columns of a fixture DDL file by table name, in catalog order. */
function parseDdl(sql: string): Map<string, DdlColumn[]> {
  const tables = new Map<string, DdlColumn[]>();
  for (const [, table = '', body = ''] of sql.matchAll(/CREATE TABLE \[[^\]]+\]\.\[([^\]]+)\] \(([\s\S]*?)\n\s*\) ON /g)) {
    const columns: DdlColumn[] = [];
    for (const line of body.split('\n')) {
      const match = /^\s*\[([^\]]+)\] \[([a-z]+)\](?: \(([^)]+)\))?(.*)$/.exec(line);
      if (match !== null) columns.push({ name: match[1] ?? '', type: match[2] ?? '', size: match[3], nullable: !(match[4] ?? '').includes('NOT NULL') });
    }
    tables.set(table, columns);
  }
  return tables;
}

async function loadDdl(): Promise<Map<string, DdlColumn[]>> {
  const tables = new Map<string, DdlColumn[]>();
  for (const file of Object.values(DDL_FILES)) {
    for (const [table, columns] of parseDdl(await readFile(join(REPO_ROOT, 'legacy-fixtures', 'sql', file), 'utf8'))) tables.set(table, columns);
  }
  return tables;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** File names in `dir`, sorted. */
async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/** Deterministic `randomBytes`: every call returns a distinct counter value. */
function counterBytes(): (n: number) => Buffer {
  let calls = 0;
  return (n) => {
    calls += 1;
    const out = Buffer.alloc(n);
    out.writeUInt32BE(calls, 0);
    return out;
  };
}

/** Captures stdout and stderr writes until the test ends. */
function captureOutput(): { stdout: () => string; stderr: () => string } {
  const sink = (chunks: string[]) => (chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(sink(out));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(sink(err));
  onTestFinished(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });
  return { stdout: () => out.join(''), stderr: () => err.join('') };
}

/** Runs the CLI with its log collected. */
async function generated(argv: string[], env: NodeJS.ProcessEnv, paths: { out: string; state: string }, deps: GenerateDeps = {}): Promise<Run> {
  const log: string[] = [];
  const code = await run(argv, env, { ...deps, log: (line) => log.push(line) });
  return { code, log, ...paths };
}

function groupBy(rows: readonly FixtureRow[], column: string): Map<FixtureValue, FixtureRow[]> {
  const out = new Map<FixtureValue, FixtureRow[]>();
  for (const row of rows) {
    const list = out.get(row[column] ?? null);
    if (list === undefined) out.set(row[column] ?? null, [row]);
    else list.push(row);
  }
  return out;
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every string value nested in `value`. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

const config = await loadConfig(CONFIG_PATH);
const KEYS = fixtureKeys(config);
const DDL = await loadDdl();
const LATEST_DAY = addDays(config.businessDate, 366);

/** DDL columns a seeded row of dataset key `key` carries, in order. */
function columnsOf(key: string): DdlColumn[] {
  const { table } = specForKey(key).spec;
  const columns = DDL.get(table);
  if (columns === undefined) throw new Error(`${table} is not in the fixture DDL`);
  return columns.filter((column) => !(LOADED_COLUMNS[table] ?? []).includes(column.name));
}

/** Whether `value` loads unchanged into `column`. */
function fits(column: DdlColumn, value: FixtureValue | undefined): boolean {
  if (value === null) return column.nullable;
  if (typeof value === 'number') return column.type === 'int' && Number.isInteger(value) && Math.abs(value) <= 2_147_483_647;
  if (typeof value !== 'string') return false;
  switch (column.type) {
    case 'datetime':
      return TIMESTAMP.test(value) && value.slice(0, 10) >= EARLIEST_DAY && value.slice(0, 10) <= LATEST_DAY;
    case 'char':
      return column.size === '35' ? CF_UUID.test(value) : value.length === Number(column.size) && /^[0-9a-f]+$/.test(value);
    case 'nvarchar':
      return column.size === 'max' || value.length <= Number(column.size);
    case 'numeric':
      return /^-?\d{1,15}\.\d{4}$/.test(value);
    case 'varbinary':
      return /^(?:[0-9a-f]{2})*$/.test(value);
    case 'binary':
      return value.length === 2 * Number(column.size) && /^[0-9a-f]+$/.test(value);
    default:
      return false;
  }
}

function masaIds(masa: MasaData): string[] {
  return [
    ...masa.groups.map((row) => row.groupID),
    ...masa.users.map((row) => row.userID),
    ...masa.categories.map((row) => row.categoryID),
    ...masa.content.flatMap((row) => [row.contentID, ...row.versions.map((version) => version.contentHistID)]),
    ...masa.files.map((row) => row.fileID),
    ...masa.oauthClients.map((row) => row.clientID),
  ];
}

let root: string;
let first: Run;
let second: Run;
let dataset: Dataset;
let manifest: Manifest;
let creds: SeedCredentials;

function rowsOf(key: string): FixtureRow[] {
  const rows = dataset.fixtures[key];
  if (rows === undefined) throw new Error(`dataset has no ${key}`);
  return rows;
}

function membershipsOf(userID: string): MembershipRow[] {
  return dataset.masa.memberships.filter((row) => row.userID === userID);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'seed-generate-'));
  const home = join(root, 'home');
  const homeState = join(home, '.opt2', 'state');
  first = await generated([], { HOME: home }, { out: join(homeState, 'seed'), state: homeState });
  const state = join(root, 'second', 'state');
  const out = join(root, 'second', 'out');
  second = await generated(['--out', out], { OPT2_STATE_DIR: state }, { out, state }, { randomBytes: counterBytes() });
  dataset = await readJson<Dataset>(join(first.out, 'dataset.json'));
  manifest = await readJson<Manifest>(join(first.out, 'manifest.json'));
  creds = await readJson<SeedCredentials>(join(first.out, 'credentials.json'));
}, 600_000);

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('determinism', () => {
  it('regenerates byte-identical dataset files', async () => {
    expect([first.code, second.code]).toEqual([0, 0]);
    const names = (await listing(first.out)).filter((name) => name !== 'credentials.json');
    expect((await listing(second.out)).filter((name) => name !== 'credentials.json')).toEqual(names);
    for (const name of names) {
      expect((await readFile(join(second.out, name))).equals(await readFile(join(first.out, name))), name).toBe(true);
    }
  });

  it('records the pin, seed and business date with a digest of the content', async () => {
    const pin = await readJson<{ sha: string }>(join(REPO_ROOT, 'opt2', 'source-pin.json'));
    expect([dataset.sourceSha, pin.sha, dataset.seed, dataset.businessDate]).toEqual([PINNED_SHA, PINNED_SHA, 20260601, '2026-06-30']);
    expect(datasetDigest(dataset)).toBe(dataset.digest);
    const repinned: Dataset = { ...dataset, sourceSha: 'other' };
    expect(datasetDigest(repinned)).toBe(dataset.digest);
  });

  it('reads back through readDataset with the recorded digest', async () => {
    expect((await readDataset(second.out)).digest).toBe(dataset.digest);
  });
});

describe('credentials', () => {
  it('writes the same owner-only file to the output and to secrets/', async () => {
    const copies = [join(first.out, 'credentials.json'), join(first.state, 'secrets', 'seed-credentials.json')];
    const [text, secret] = await Promise.all(copies.map((path) => readFile(path, 'utf8')));
    expect(secret).toBe(text);
    for (const path of copies) expect(await modeOf(path)).toBe(0o600);
    expect(await modeOf(join(first.state, 'secrets'))).toBe(0o700);
    expect([creds.sourceSha, creds.digest]).toEqual([dataset.sourceSha, dataset.digest]);
  });

  it('gives every seeded user a password, every OAuth client a secret and every scenario password name a password', () => {
    for (const user of dataset.masa.users) expect(creds.users[user.siteID]?.[user.username], user.username).toMatch(PASSWORD);
    expect(Object.values(creds.users).reduce((n, site) => n + Object.keys(site).length, 0)).toBe(dataset.masa.users.length);
    expect(Object.keys(creds.oauthClients)).toEqual(dataset.masa.oauthClients.map((row) => row.clientID));
    for (const secret of Object.values(creds.oauthClients)) expect(secret).toMatch(CLIENT_SECRET);
    expect(Object.keys(creds.generated)).toEqual(config.scenarioPasswords);
    for (const value of Object.values(creds.generated)) expect(value).toMatch(PASSWORD);
  });

  it('draws secrets from deps.randomBytes', async () => {
    const injected = await readJson<SeedCredentials>(join(second.out, 'credentials.json'));
    expect(injected).toEqual(generateCredentials(dataset, config, { randomBytes: counterBytes() }));
    expect(injected.roles).toEqual(creds.roles);
    expect(await readFile(join(second.state, 'secrets', 'seed-credentials.json'), 'utf8')).toBe(`${JSON.stringify(injected, null, 2)}\n`);
  });

  it('draws fresh secrets on every run', async () => {
    const other = await readJson<SeedCredentials>(join(second.out, 'credentials.json'));
    const reused = Object.entries(creds.users).flatMap(([siteID, users]) =>
      Object.entries(users).filter(([username, password]) => other.users[siteID]?.[username] === password),
    );
    expect(reused).toEqual([]);
    expect(Object.entries(creds.oauthClients).filter(([clientID, secret]) => other.oauthClients[clientID] === secret)).toEqual([]);
    expect(Object.entries(creds.generated).filter(([name, value]) => other.generated[name] === value)).toEqual([]);
  });

  it('keeps every secret out of the dataset files', async () => {
    const secrets = new Set([
      ...Object.values(creds.users).flatMap((site) => Object.values(site)),
      ...Object.values(creds.oauthClients),
      ...Object.values(creds.generated),
    ]);
    for (const name of (await listing(first.out)).filter((file) => file !== 'credentials.json')) {
      const text = await readFile(join(first.out, name), 'utf8');
      expect(SECRET_KEY.test(text), name).toBe(false);
      expect([...text.matchAll(TOKEN_RUN)].filter(([token]) => secrets.has(token)), name).toEqual([]);
    }
  });
});

describe('counts', () => {
  const site = (row: { siteID: string }, siteID: SiteKey): boolean => row.siteID === siteID;
  const siteTree = (siteID: SiteKey): MasaData['content'] =>
    dataset.masa.content.filter((c) => site(c, siteID) && c.moduleID === MASA_DEFAULT_MODULE_ID);
  it.each([
    ['umbrella members', () => dataset.masa.users.filter((u) => site(u, 'umbrella') && u.isPublic === 1), 1000],
    ['umbrella categories', () => dataset.masa.categories.filter((c) => site(c, 'umbrella')), 100],
    ['umbrella files', () => dataset.masa.files.filter((f) => site(f, 'umbrella')), 20],
    ['tenant-a system users', () => dataset.masa.users.filter((u) => site(u, 'tenant-a') && u.isPublic === 0), 2000],
    ['tenant-a groups', () => dataset.masa.groups.filter((g) => site(g, 'tenant-a')), 50],
    ['tenant-a content nodes', () => siteTree('tenant-a').filter((c) => c.versions.length > 0), 5000],
    ['tenant-a forms', () => dataset.masa.content.filter((c) => site(c, 'tenant-a') && c.type === 'Form'), 1],
    ['tenant-a timesheet days', () => rowsOf('Program_1.timesheet_day'), 20000],
    ['tenant-a finance records', () => rowsOf('Program_1.finance_record'), 3000],
    ['tenant-a survey responses', () => rowsOf('synthetic.survey_response').filter((r) => r.siteID === 'tenant-a'), 500],
    ['tenant-a export jobs', () => rowsOf('synthetic.export_job').filter((r) => r.siteID === 'tenant-a'), 200],
    ['tenant-b system users', () => dataset.masa.users.filter((u) => site(u, 'tenant-b') && u.isPublic === 0), 180],
    ['tenant-b members', () => dataset.masa.users.filter((u) => site(u, 'tenant-b') && u.isPublic === 1), 20],
    ['tenant-b groups', () => dataset.masa.groups.filter((g) => site(g, 'tenant-b')), 10],
    ['tenant-b content nodes', () => siteTree('tenant-b').filter((c) => c.versions.length > 0), 300],
    ['tenant-b forms', () => dataset.masa.content.filter((c) => site(c, 'tenant-b') && c.type === 'Form'), 1],
    ['tenant-b timesheet days', () => rowsOf('Program_2.timesheet_day'), 2000],
    ['tenant-b finance records', () => rowsOf('Program_2.finance_record'), 300],
  ] as const)('%s', (_label, select, expected) => {
    expect(select()).toHaveLength(expected);
  });

  const program = (siteID: SiteKey, table: string): FixtureRow[] => {
    const { programId } = config.sites[siteID];
    return programId === null ? [] : rowsOf(`Program_${programId}.${table}`);
  };
  const synthetic = (siteID: SiteKey, table: string): FixtureRow[] => rowsOf(`synthetic.${table}`).filter((row) => row.siteID === siteID);
  /** Day count shared by every timesheet of the site: 0 without timesheets, -1 when they differ. */
  const daysPerSheet = (siteID: SiteKey): number => {
    const sizes = new Set([...groupBy(program(siteID, 'timesheet_day'), 'timesheet_id').values()].map((days) => days.length));
    return sizes.size === 0 ? 0 : sizes.size === 1 ? ([...sizes][0] ?? -1) : -1;
  };
  const COUNTED: Readonly<Record<keyof SiteCounts, (siteID: SiteKey) => number>> = {
    members: (s) => dataset.masa.users.filter((u) => site(u, s) && u.isPublic === 1).length,
    systemUsers: (s) => dataset.masa.users.filter((u) => site(u, s) && u.isPublic === 0).length,
    groups: (s) => dataset.masa.groups.filter((g) => site(g, s)).length,
    categories: (s) => dataset.masa.categories.filter((c) => site(c, s)).length,
    files: (s) => dataset.masa.files.filter((f) => site(f, s)).length,
    contentNodes: (s) => siteTree(s).length,
    maxVersionsPerNode: (s) => Math.max(0, ...siteTree(s).map((c) => c.versions.length)),
    timesheetDays: (s) => program(s, 'timesheet_day').length,
    daysPerTimesheet: daysPerSheet,
    timesheetEmployees: (s) => new Set(program(s, 'timesheet').map((row) => row.person_id)).size,
    financeRecords: (s) => program(s, 'finance_record').length,
    financeAttachments: (s) => program(s, 'finance_attachment').length,
    surveys: (s) => synthetic(s, 'survey').length,
    surveyResponses: (s) => synthetic(s, 'survey_response').length,
    multiSiteResponses: (s) => synthetic(s, 'survey_response').filter((row) => row.respondentSiteID !== s).length,
    exportDefinitions: (s) => synthetic(s, 'export_definition').length,
    exportJobs: (s) => synthetic(s, 'export_job').length,
    messageTemplates: (s) => synthetic(s, 'message_template').length,
    messages: (s) => synthetic(s, 'message').length,
    signatureRequests: (s) => synthetic(s, 'signature_request').length,
    oauthClients: (s) => dataset.masa.oauthClients.filter((c) => site(c, s)).length,
  };

  it.each([...SITE_ORDER])('%s matches every configured count', (siteID) => {
    const { counts } = config.sites[siteID];
    expect(Object.keys(counts).filter((key) => !Object.hasOwn(COUNTED, key))).toEqual([]);
    expect(Object.fromEntries(Object.keys(counts).map((key) => [key, COUNTED[key as keyof SiteCounts](siteID)]))).toEqual(counts);
  });

  it('seeds umbrella, tenant-a and tenant-b, never the installed site or accounts', () => {
    const { sites, users, groups, content } = dataset.masa;
    expect(sites.map((row) => row.siteID)).toEqual(SITE_ORDER);
    expect([...users, ...groups, ...content].filter((row) => !SITE_ORDER.includes(row.siteID))).toEqual([]);
    expect(users.filter((u) => INSTALLED_USERNAMES.includes(u.username.toLowerCase()))).toEqual([]);
  });

  it('leaves the archive and blackout tables to the archive flow', () => {
    for (const key of ['synthetic.person_archive', 'Program_1.blackout', 'Program_2.blackout']) expect(rowsOf(key), key).toEqual([]);
  });
});

describe('ids', () => {
  it('keys every row with a CF UUID unique across the dataset', () => {
    const ids = [...masaIds(dataset.masa), ...KEYS.flatMap((key) => rowsOf(key).map((row) => row[specForKey(key).spec.key]))];
    expect(ids.filter((id) => typeof id !== 'string' || !CF_UUID.test(id) || !isCfUuid(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('parents site-tree content at the home node or seeded content, forms at the Forms module and files at the default module', () => {
    const { content } = dataset.masa;
    const nodes = new Map(content.map((row) => [row.contentID, row.siteID]));
    const modules = [MASA_HOME_CONTENT_ID, MASA_DEFAULT_MODULE_ID, MASA_FORMS_MODULE_ID];
    expect([...nodes.keys()].filter((id) => modules.includes(id))).toEqual([]);
    const tree = content.filter((row) => row.moduleID === MASA_DEFAULT_MODULE_ID);
    expect(tree.filter((row) => row.parentID !== MASA_HOME_CONTENT_ID && nodes.get(row.parentID) !== row.siteID)).toEqual([]);
    const forms = content.filter((row) => row.moduleID !== MASA_DEFAULT_MODULE_ID);
    expect(forms.map((row) => [row.siteID, row.moduleID, row.parentID, row.type])).toEqual(
      ['tenant-a', 'tenant-b'].map((siteID) => [siteID, MASA_FORMS_MODULE_ID, MASA_FORMS_MODULE_ID, 'Form']),
    );
    expect(dataset.masa.files.filter((row) => row.moduleID !== MASA_DEFAULT_MODULE_ID)).toEqual([]);
  });

  it.each([
    ...[1, 2].flatMap((p) => [
      [`Program_${p}.timesheet_day`, 'timesheet_id', `Program_${p}.timesheet`],
      [`Program_${p}.approval_action`, 'day_id', `Program_${p}.timesheet_day`],
      [`Program_${p}.finance_record_version`, 'record_id', `Program_${p}.finance_record`],
      [`Program_${p}.finance_attachment`, 'record_id', `Program_${p}.finance_record`],
    ]),
    ['synthetic.survey_schedule', 'survey_id', 'synthetic.survey'],
    ['synthetic.survey_reminder', 'survey_id', 'synthetic.survey'],
    ['synthetic.survey_target', 'survey_id', 'synthetic.survey'],
    ['synthetic.survey_response', 'survey_id', 'synthetic.survey'],
    ['synthetic.export_job', 'definition_id', 'synthetic.export_definition'],
    ['synthetic.message', 'template_id', 'synthetic.message_template'],
    ['synthetic.delivery_status', 'message_id', 'synthetic.message'],
    ['synthetic.signature', 'request_id', 'synthetic.signature_request'],
    ['synthetic.audit_entry', 'request_id', 'synthetic.signature_request'],
  ])('%s.%s names a row of %s', (child, column, parent) => {
    const parents = new Set(rowsOf(parent).map((row) => row[specForKey(parent).spec.key]));
    expect(rowsOf(child).length).toBeGreaterThan(0);
    expect(rowsOf(child).filter((row) => row[column] !== null && !parents.has(row[column] ?? null))).toEqual([]);
  });

  it('names seeded users in every user column', () => {
    const users = new Set(dataset.masa.users.map((row) => row.userID));
    const checked = new Set<string>();
    const stray: string[] = [];
    for (const key of KEYS) {
      for (const column of columnsOf(key).filter((c) => USER_COLUMNS.includes(c.name))) {
        checked.add(column.name);
        for (const row of rowsOf(key)) if (row[column.name] !== null && !users.has(String(row[column.name]))) stray.push(`${key}.${column.name}`);
      }
    }
    expect([...checked].sort()).toEqual([...USER_COLUMNS].sort());
    expect(stray).toEqual([]);
  });

  it('joins memberships and OAuth clients to seeded users and groups', () => {
    const users = new Set(dataset.masa.users.map((row) => row.userID));
    const groups = new Map(dataset.masa.groups.map((row) => [row.groupID, row]));
    for (const m of dataset.masa.memberships) {
      expect(users.has(m.userID)).toBe(true);
      const group = m.groupID === null ? { groupname: 'Admin', siteID: m.groupSiteID } : groups.get(m.groupID);
      expect(group, m.groupname).toMatchObject({ groupname: m.groupname, siteID: m.groupSiteID });
    }
    expect(dataset.masa.oauthClients.filter((row) => !users.has(row.userID))).toEqual([]);
  });

  it("names seeded sites, and a Program_<id> row its program's site", () => {
    const stray: string[] = [];
    for (const key of KEYS) {
      const { programId } = specForKey(key);
      for (const column of columnsOf(key).filter((c) => SITE_COLUMNS.includes(c.name))) {
        for (const row of rowsOf(key)) {
          const value = row[column.name];
          const expected = programId === null ? SITE_ORDER.includes(value as SiteKey) : value === siteForProgram(config, programId);
          if (!expected) stray.push(`${key}.${column.name}=${String(value)}`);
        }
      }
    }
    expect(stray).toEqual([]);
  });
});

describe('value forms', () => {
  it.each(KEYS)('%s values fit their DDL column types', (key) => {
    const columns = columnsOf(key);
    const bad: string[] = [];
    for (const row of rowsOf(key)) {
      for (const column of columns) if (!fits(column, row[column.name])) bad.push(`${column.name}=${JSON.stringify(row[column.name])}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('stamps Masa rows with local timestamps before the business date', () => {
    const { groups, users, categories, content, files } = dataset.masa;
    const stamps = [
      ...groups.flatMap((row) => [row.created, row.lastUpdate]),
      ...users.flatMap((row) => [row.created, row.lastUpdate]),
      ...categories.flatMap((row) => [row.dateCreated, row.lastUpdate]),
      ...content.flatMap((row) => row.versions.map((version) => version.lastUpdate)),
      ...files.map((row) => row.created),
    ];
    expect(stamps.filter((stamp) => !TIMESTAMP.test(stamp) || stamp >= `${config.businessDate}T00:00:00.000`)).toEqual([]);
  });

  it('writes every date-like Masa string as a timestamp or a date within the bound', () => {
    const dated = strings(dataset.masa).filter((value) => DATE_PREFIX.test(value));
    expect(dated.length).toBeGreaterThan(0);
    expect(dated.filter((value) => !(TIMESTAMP.test(value) || DATE.test(value)) || value.slice(0, 10) > LATEST_DAY)).toEqual([]);
  });

  it('stores each digest of the bytes it describes', () => {
    const bad: string[] = [];
    for (const file of dataset.masa.files) {
      const bytes = Buffer.from(file.bytes, 'base64');
      if (file.sha256 !== sha256(bytes) || file.fileSize !== bytes.length) bad.push(`file ${file.fileID}`);
    }
    for (const key of ['Program_1.finance_attachment', 'Program_2.finance_attachment']) {
      for (const row of rowsOf(key)) {
        const bytes = Buffer.from(String(row.content), 'hex');
        if (row.sha256 !== sha256(bytes) || row.size_bytes !== bytes.length) bad.push(`${key} ${String(row.attachment_id)}`);
      }
    }
    for (const job of rowsOf('synthetic.export_job')) {
      const expected = job.output === null ? null : sha256(Buffer.from(String(job.output), 'hex'));
      if (job.output_sha256 !== expected) bad.push(`export_job ${String(job.job_id)}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('reserved rehearsal identities', () => {
  const { persons, usernames } = config.reserved.rehearsal;
  const reserved = new Set(persons);

  it('seeds each reserved person as a tenant-a timesheets.employee only', () => {
    expect(persons).toHaveLength(10);
    for (const userID of persons) {
      expect(dataset.masa.users.find((row) => row.userID === userID), userID).toMatchObject({ siteID: 'tenant-a', isPublic: 0 });
      expect(membershipsOf(userID).map((m) => [m.groupSiteID, m.groupname])).toEqual([['tenant-a', roleGroupName(config, 'timesheets.employee')]]);
    }
  });

  it('gives each reserved person open timesheet days and no approved one', () => {
    const days = groupBy(rowsOf('Program_1.timesheet_day'), 'timesheet_id');
    for (const userID of persons) {
      const sheets = rowsOf('Program_1.timesheet').filter((sheet) => sheet.person_id === userID);
      const own = sheets.flatMap((sheet) => days.get(sheet.timesheet_id ?? null) ?? []);
      expect(sheets.length, userID).toBeGreaterThan(0);
      expect(own.filter((day) => day.state === 'DRAFT' && String(day.work_date) >= config.businessDate).length, userID).toBeGreaterThanOrEqual(5);
      expect(own.filter((day) => day.state === 'APPROVED')).toEqual([]);
    }
  });

  it('references reserved persons only from their own timesheet rows', () => {
    const sheetOwner = new Map(rowsOf('Program_1.timesheet').map((row) => [row.timesheet_id, row.person_id]));
    const dayOwner = new Map(rowsOf('Program_1.timesheet_day').map((row) => [row.day_id, sheetOwner.get(row.timesheet_id)]));
    const owners: Readonly<Record<string, (row: FixtureRow) => FixtureValue | undefined>> = {
      'Program_1.timesheet': (row) => row.person_id,
      'Program_1.timesheet_day': (row) => sheetOwner.get(row.timesheet_id ?? null),
      'Program_1.approval_action': (row) => dayOwner.get(row.day_id ?? null),
    };
    const stray: string[] = [];
    for (const key of KEYS) {
      for (const row of rowsOf(key)) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value === 'string' && reserved.has(value) && owners[key]?.(row) !== value) stray.push(`${key}.${column}`);
        }
      }
    }
    expect(stray).toEqual([]);
    expect(dataset.masa.oauthClients.filter((row) => reserved.has(row.userID))).toEqual([]);
    const names = new Set(dataset.masa.users.filter((row) => reserved.has(row.userID)).map((row) => row.username));
    expect(Object.values(creds.roles).flatMap((subjects) => Object.values(subjects)).filter((name) => names.has(name))).toEqual([]);
  });

  it('leaves the reserved usernames to the rehearsal', () => {
    const taken = new Set(dataset.masa.users.map((row) => row.username.toLowerCase()));
    expect(usernames).toHaveLength(10);
    expect(usernames.filter((name) => taken.has(name))).toEqual([]);
  });
});

describe('roles', () => {
  it.each(['tenant-a', 'tenant-b'] as const)('%s holds one group per synthetic role and its Admin membership', (siteID) => {
    const names = dataset.masa.groups.filter((row) => row.siteID === siteID).map((row) => row.groupname);
    for (const role of ROLES) expect(names.filter((name) => name === roleGroupName(config, role)), role).toHaveLength(1);
    expect(dataset.masa.memberships.filter((m) => m.groupID === null && m.groupname === 'Admin' && m.groupSiteID === siteID).length).toBeGreaterThan(0);
  });

  it.each([
    ['umbrella', [MEMBER]],
    ['tenant-a', ROLE_SUBJECTS],
    ['tenant-b', [...ROLE_SUBJECTS, MEMBER]],
  ] as const)('%s names each role subject by a user holding exactly that role', (siteID, subjects) => {
    const named = creds.roles[siteID] ?? {};
    const oauthUsers = new Set(dataset.masa.oauthClients.map((row) => row.userID));
    expect(Object.keys(named)).toEqual(subjects);
    for (const [role, username] of Object.entries(named)) {
      const user = dataset.masa.users.find((row) => row.siteID === siteID && row.username === username);
      if (user === undefined) throw new Error(`${siteID} ${role} names unknown user ${username}`);
      const held = membershipsOf(user.userID).map((m) => [m.groupSiteID, m.groupname, m.groupID === null]);
      expect(user.isPublic, role).toBe(role === MEMBER ? 1 : 0);
      if (role === SITE_ADMIN) expect(held).toEqual([[siteID, 'Admin', true]]);
      else if (role === MEMBER || role === SYSTEM_USER) expect(held, role).toEqual([]);
      else expect(held, role).toEqual([[siteID, roleGroupName(config, role), false]]);
      if (role === SYSTEM_USER) expect(oauthUsers.has(user.userID)).toBe(false);
    }
  });
});

describe('fixture columns', () => {
  it('fills exactly the configured fixture tables', () => {
    expect(Object.keys(dataset.fixtures)).toEqual(KEYS);
    expect(KEYS.filter((key) => UNSEEDED_KEYS.includes(key))).toEqual([]);
  });

  it.each(KEYS)('%s rows carry the DDL columns in catalog order', (key) => {
    const names = columnsOf(key).map((column) => column.name).join();
    expect(rowsOf(key).filter((row) => Object.keys(row).join() !== names)).toEqual([]);
  });
});

describe('state consistency', () => {
  it.each([1, 2])('Program_%i day states replay their approval actions through legal steps', (p) => {
    const legal = (row: FixtureRow): boolean =>
      TIMESHEET_STEPS.some((step) => step.from === row.from_state && step.action === row.action && step.role === row.role && step.to === row.to_state);
    const actions = groupBy(rowsOf(`Program_${p}.approval_action`), 'day_id');
    const bad = rowsOf(`Program_${p}.timesheet_day`).filter((day) => {
      let state: FixtureValue = 'DRAFT';
      let at = '';
      for (const action of actions.get(day.day_id ?? null) ?? []) {
        if (action.from_state !== state || String(action.created) < at || !legal(action)) return true;
        state = action.to_state ?? null;
        at = String(action.created);
      }
      return state !== day.state;
    });
    expect(bad).toEqual([]);
  });

  it.each([1, 2])('Program_%i versions step through the finance lifecycle', (p) => {
    const versions = groupBy(rowsOf(`Program_${p}.finance_record_version`), 'record_id');
    const steps = [...versions.values()].flatMap((list) => list.slice(1).map((version, i) => `${String(list[i]?.state)}>${String(version.state)}`));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((step) => !FINANCE_STEPS.has(step))).toEqual([]);
  });

  it.each([1, 2])('Program_%i records match their last version', (p) => {
    const versions = groupBy(rowsOf(`Program_${p}.finance_record_version`), 'record_id');
    const bad = rowsOf(`Program_${p}.finance_record`).filter((record) => {
      const list = versions.get(record.record_id ?? null) ?? [];
      const last = list.at(-1);
      return (
        last === undefined ||
        list.length !== record.version ||
        list.some((version, i) => version.version !== i + 1) ||
        list[0]?.action !== 'create' ||
        list[0]?.state !== 'IN-PROGRESS' ||
        ['state', 'title', 'amount', 'period'].some((column) => last[column] !== record[column])
      );
    });
    expect(bad).toEqual([]);
  });

  it('gives each message the state of its last delivery status', () => {
    const history = groupBy(rowsOf('synthetic.delivery_status'), 'message_id');
    const bad = rowsOf('synthetic.message').filter((message) => {
      const rows = history.get(message.message_id ?? null) ?? [];
      const sent = rows.find((row) => row.status === 'sent');
      return message.state === 'queued' || rows.at(-1)?.status !== message.state || message.sent_at !== (sent?.recorded_at ?? null);
    });
    expect(bad).toEqual([]);
  });

  it('marks a request SIGNED exactly when it has a signature and a signed audit entry', () => {
    const signatures = groupBy(rowsOf('synthetic.signature'), 'request_id');
    const entries = groupBy(rowsOf('synthetic.audit_entry'), 'request_id');
    const bad = rowsOf('synthetic.signature_request').filter((request) => {
      const signed = request.state === 'SIGNED';
      const actions = (entries.get(request.request_id ?? null) ?? []).map((row) => row.action);
      return (
        (signatures.get(request.request_id ?? null) ?? []).length !== (signed ? 1 : 0) ||
        actions.join() !== (signed ? 'created,signed' : 'created') ||
        !['SIGNED', 'PENDING'].includes(String(request.state))
      );
    });
    expect(bad).toEqual([]);
  });

  it('gives done export jobs an output and failed ones an error', () => {
    const bad = rowsOf('synthetic.export_job').filter((job) =>
      job.state === 'done' ? job.output === null || job.error !== null : job.state !== 'failed' || job.output !== null || job.error === null,
    );
    expect(bad).toEqual([]);
  });
});

describe('chunks and manifest', () => {
  it('writes the dataset, its parts, the manifest and the credentials', async () => {
    expect(await listing(first.out)).toEqual(['credentials.json', 'dataset.json', ...manifest.parts.map((part) => part.file), 'manifest.json'].sort());
    expect(existsSync(join(second.state, 'seed'))).toBe(false);
  });

  it('records the dataset identity and the length of every array', () => {
    expect([manifest.sourceSha, manifest.seed, manifest.businessDate, manifest.digest]).toEqual([
      dataset.sourceSha,
      dataset.seed,
      dataset.businessDate,
      dataset.digest,
    ]);
    expect(Object.entries(manifest.counts)).toEqual([
      ...MASA_ARRAYS.map((name) => [`masa.${name}`, dataset.masa[name].length]),
      ...KEYS.map((key) => [`fixtures.${key}`, rowsOf(key).length]),
    ]);
  });

  it('splits every array into parts of at most chunkRows rows that rebuild it', async () => {
    expect(config.chunkRows).toBe(1000);
    const rebuilt = new Map<string, unknown[]>();
    for (const part of manifest.parts) {
      const body = await readJson<DatasetPart>(join(first.out, part.file));
      expect([body.sourceSha, body.digest, body.array, body.offset, body.rows.length]).toEqual([dataset.sourceSha, dataset.digest, part.array, part.offset, part.count]);
      expect(part.file).toMatch(/^dataset-\d{4}\.json$/);
      expect(part.count).toBeLessThanOrEqual(config.chunkRows);
      const rows = rebuilt.get(part.array) ?? [];
      expect(rows).toHaveLength(part.offset);
      rebuilt.set(part.array, [...rows, ...body.rows]);
    }
    const arrays = new Map<string, readonly unknown[]>([
      ...MASA_ARRAYS.map((name): [string, readonly unknown[]] => [`masa.${name}`, dataset.masa[name]]),
      ...KEYS.map((key): [string, readonly unknown[]] => [`fixtures.${key}`, rowsOf(key)]),
    ]);
    expect([...rebuilt.keys()]).toEqual([...arrays.keys()].filter((name) => (arrays.get(name)?.length ?? 0) > 0));
    for (const [name, rows] of rebuilt) expect(JSON.stringify(rows) === JSON.stringify(arrays.get(name)), name).toBe(true);
  });

  it('logs the digest, output, part count and every count', () => {
    const counts = Object.entries(manifest.counts).map(([array, count]) => `${array}=${count}`);
    expect(first.log).toEqual([`seed digest=${manifest.digest} out=${first.out} parts=${manifest.parts.length}`, `seed counts ${counts.join(' ')}`]);
    expect(second.log[0]).toBe(`seed digest=${manifest.digest} out=${second.out} parts=${manifest.parts.length}`);
  });
});

describe('CLI', () => {
  it('prints usage for --help and writes nothing', async () => {
    const io = captureOutput();
    const state = join(root, 'help-state');
    expect(await run(['--help'], { OPT2_STATE_DIR: state })).toBe(0);
    expect(io.stdout()).toMatch(/^Usage: node dist\/generate\.js \[--direct\]/);
    expect(io.stderr()).toBe('');
    expect(existsSync(state)).toBe(false);
  });

  it.each([[['--bogus']], [['extra']], [['--out']], [['--help=yes']]])('rejects %j with usage', async (argv) => {
    const io = captureOutput();
    const state = join(root, 'usage-state');
    expect(await run(argv, { OPT2_STATE_DIR: state })).toBe(2);
    expect(io.stderr()).toMatch(/^seed: [^\n]+\nUsage: node dist\/generate\.js /);
    expect(io.stdout()).toBe('');
    expect(existsSync(state)).toBe(false);
  });

  const insideCheckout = [REPO_ROOT, join(REPO_ROOT, 'legacy-fixtures', 'seed', 'out'), relative(process.cwd(), join(REPO_ROOT, 'opt2-seed-test-out'))];
  it.each(insideCheckout)('refuses --out %s inside the checkout', async (out) => {
    const io = captureOutput();
    const state = join(root, 'refused-state');
    expect(await run(['--out', out], { OPT2_STATE_DIR: state })).toBe(2);
    expect(io.stderr()).toBe(`seed: ${resolve(out)} is inside the checkout ${REPO_ROOT}; choose a location outside it\n`);
    expect(existsSync(join(resolve(out), 'manifest.json'))).toBe(false);
    expect(existsSync(state)).toBe(false);
  });

  it('refuses OPT2_STATE_DIR inside the checkout', async () => {
    const io = captureOutput();
    const state = join(REPO_ROOT, '.opt2-state');
    const out = join(root, 'refused-out');
    expect(await run(['--out', out], { OPT2_STATE_DIR: state })).toBe(2);
    expect(io.stderr()).toBe(`seed: ${state} is inside the checkout ${REPO_ROOT}; choose a location outside it\n`);
    expect([existsSync(state), existsSync(out)]).toEqual([false, false]);
  });

  it.each([
    ['--out beneath a symlink to the checkout', { target: REPO_ROOT, out: 'opt2-seed-link-out/seed', created: 'opt2-seed-link-out' }],
    ['--out that is a symlink into the checkout', { target: join(REPO_ROOT, 'legacy-fixtures'), out: '', created: 'legacy-fixtures/manifest.json' }],
    ['OPT2_STATE_DIR beneath a symlink to the checkout', { target: REPO_ROOT, state: '.opt2-seed-link-state', created: '.opt2-seed-link-state' }],
    ['--out that is a dangling symlink into the checkout', { target: join(REPO_ROOT, 'opt2-seed-dangling'), out: '', created: 'opt2-seed-dangling' }],
    ['--out beneath a relative dangling symlink into the checkout', { target: join(REPO_ROOT, 'opt2-seed-dangling'), relative: true, out: 'seed', created: 'opt2-seed-dangling' }],
  ] as const)('refuses %s', async (_label, link) => {
    const io = captureOutput();
    const dir = await mkdtemp(join(root, 'linked-'));
    const path = join(dir, 'link');
    await symlink('relative' in link ? relative(dir, link.target) : link.target, path);
    onTestFinished(() => rm(path));
    const out = 'out' in link ? join(path, link.out) : join(dir, 'out');
    const state = 'state' in link ? join(path, link.state) : join(dir, 'state');
    expect(await run(['--out', out], { OPT2_STATE_DIR: state })).toBe(2);
    expect(io.stderr()).toBe(`seed: ${'out' in link ? out : state} is inside the checkout ${REPO_ROOT}; choose a location outside it\n`);
    expect(existsSync(join(REPO_ROOT, link.created))).toBe(false);
    expect(await readdir(dir)).toEqual(['link']);
  });

  it.each([
    ['a symlink to the dataset', () => first.out, '', /^seed: ENOENT: no such file or directory, open '[^']+token-signing-public\.pem'\n$/],
    ['a symlink to the dataset parent', () => dirname(first.out), 'seed', /^seed: ENOENT: no such file or directory, open '[^']+token-signing-public\.pem'\n$/],
    ['a dangling symlink', (path: string) => join(dirname(path), 'absent'), 'seed', /^seed: (?![^\n]*inside the checkout)[^\n]+\n$/],
    ['a symlink loop', (path: string) => path, 'seed', /^seed: (?![^\n]*inside the checkout)[^\n]+\n$/],
  ])('lets --direct --out through %s outside the checkout', async (_label, target, suffix, message) => {
    const io = captureOutput();
    const dir = await mkdtemp(join(root, 'linked-'));
    const path = join(dir, 'link');
    await symlink(target(path), path);
    onTestFinished(() => rm(path));
    const state = await mkdtemp(join(root, 'keyless-'));
    expect(await run(['--direct', '--out', join(path, suffix)], { OPT2_STATE_DIR: state, OPT2_SERVICE_URLS: SERVICE_URLS })).toBe(1);
    expect(io.stderr()).toMatch(message);
  });

  it('defaults to <HOME>/.opt2/state, writing the dataset to seed/ and credentials to secrets/', () => {
    expect(first.code).toBe(0);
    expect(existsSync(join(root, 'home', '.opt2', 'state', 'seed', 'manifest.json'))).toBe(true);
    expect(existsSync(join(root, 'home', '.opt2', 'state', 'secrets', 'seed-credentials.json'))).toBe(true);
  });

  it('treats an empty OPT2_STATE_DIR as unset, defaulting to <HOME>/.opt2/state', async () => {
    const io = captureOutput();
    const home = await mkdtemp(join(root, 'empty-state-home-'));
    const keyPath = join(home, '.opt2', 'state', 'secrets', 'token-signing-public.pem');
    expect(await run(['--direct', '--out', first.out], { OPT2_STATE_DIR: '', HOME: home, OPT2_SERVICE_URLS: SERVICE_URLS })).toBe(1);
    expect(io.stderr()).toBe(`seed: ENOENT: no such file or directory, open '${keyPath}'\n`);
    expect(await readdir(home)).toEqual([]);
    expect([existsSync(join(process.cwd(), 'seed')), existsSync(join(process.cwd(), 'secrets'))]).toEqual([false, false]);
  });

  it('reads --config and --pin and logs to stdout by default', async () => {
    const io = captureOutput();
    const dir = await mkdtemp(join(root, 'inputs-'));
    const raw = await readJson<{ seed: number }>(CONFIG_PATH);
    const configPath = join(dir, 'seed.config.json');
    const pinPath = join(dir, 'pin.json');
    await writeFile(configPath, JSON.stringify({ ...raw, seed: raw.seed + 1 }));
    await writeFile(pinPath, JSON.stringify({ sha: 'a'.repeat(40) }));
    const out = join(dir, 'out');
    expect(await run(['--config', configPath, '--pin', pinPath, '--out', out], { OPT2_STATE_DIR: join(dir, 'state') })).toBe(0);
    const other = await readJson<Manifest>(join(out, 'manifest.json'));
    expect([other.sourceSha, other.seed, other.businessDate]).toEqual(['a'.repeat(40), raw.seed + 1, manifest.businessDate]);
    expect(other.digest).not.toBe(manifest.digest);
    const counts = Object.entries(other.counts).map(([array, count]) => `${array}=${count}`);
    expect(io.stdout()).toBe(`seed digest=${other.digest} out=${out} parts=${other.parts.length}\nseed counts ${counts.join(' ')}\n`);
    expect(existsSync(join(dir, 'state', 'secrets', 'seed-credentials.json'))).toBe(true);
  });

  it.each([
    ['a missing config', { config: 'absent.json' }, /^seed: ENOENT: no such file or directory, open '[^']+absent\.json'\n$/],
    ['a config that is not JSON', { config: 'bad.json', text: '{ seed' }, /^seed: [^\n]+bad\.json is not valid JSON at line 1 column 3 \(see --help\)\n$/],
    [
      'a config the schema rejects',
      { config: 'bad.json', patch: { chunkRows: 0 } },
      /^seed: [^\n]+bad\.json is not a valid seed configuration: chunkRows: Too small: expected number to be >0 \(see --help\)\n$/,
    ],
    [
      'a config whose seed is text',
      { config: 'bad.json', patch: { seed: 'abc' } },
      /^seed: [^\n]+bad\.json is not a valid seed configuration: seed: Invalid input: expected number, received string \(see --help\)\n$/,
    ],
    ['a missing pin', { pin: 'absent.json' }, /^seed: ENOENT: no such file or directory, open '[^']+absent\.json'\n$/],
    ['a pin without a lower-case SHA', { pin: 'pin.json', text: JSON.stringify({ sha: 'A'.repeat(40) }) }, /^seed: [^\n]+pin\.json has no sha of 40 lower-case hex characters\n$/],
  ] as const)('exits 1 on %s before writing', async (_label, input, message) => {
    const io = captureOutput();
    const dir = await mkdtemp(join(root, 'failed-'));
    const flag = 'config' in input ? '--config' : '--pin';
    const path = join(dir, 'config' in input ? input.config : input.pin);
    if ('patch' in input) await writeFile(path, JSON.stringify({ ...(await readJson<object>(CONFIG_PATH)), ...input.patch }));
    else if ('text' in input) await writeFile(path, input.text);
    expect(await run([flag, path, '--out', join(dir, 'out')], { OPT2_STATE_DIR: join(dir, 'state') })).toBe(1);
    expect(io.stderr()).toMatch(message);
    expect([existsSync(join(dir, 'out')), existsSync(join(dir, 'state'))]).toEqual([false, false]);
  });

  it.each<[string, (raw: RawConfig) => void, RegExp]>([
    ['too few groups for the role groups', (raw) => void (raw.sites['tenant-b'].counts.groups = 3), /^seed: Site tenant-b needs at least 10 groups for the role groups, got 3\n$/],
    [
      'more multi-site survey responses than responses',
      (raw) => void (raw.sites['tenant-b'].counts.multiSiteResponses = 500),
      /^seed: Site tenant-b: multiSiteResponses 500 exceeds surveyResponses 20\n$/,
    ],
    ['a history reaching before 1753', (raw) => void (raw.businessDate = '1753-01-02'), /^seed: generate failed \(RangeError\)\n$/],
  ])('exits 1 naming the site and counts, or only the error class, on a config with %s', async (_label, edit, message) => {
    const io = captureOutput();
    const dir = await mkdtemp(join(root, 'unfillable-'));
    const raw = await readJson<RawConfig>(CONFIG_PATH);
    edit(raw);
    const path = join(dir, 'seed.config.json');
    await writeFile(path, JSON.stringify(raw));
    expect(await run(['--config', path, '--out', join(dir, 'out')], { OPT2_STATE_DIR: join(dir, 'state') })).toBe(1);
    expect(io.stderr()).toMatch(message);
    expect([existsSync(join(dir, 'out')), existsSync(join(dir, 'state'))]).toEqual([false, false]);
  });

  it.each([
    ['JSON the parser quotes', '{"masa":{"users":[{"fname":Zelda,"email":"zelda.sentinel@example.com"}]}}', true, /^seed: [^\n]+dataset\.json is not valid JSON\n$/],
    [
      'JSON broken beside a row',
      '{"masa":{"users":[{"fname":"Zelda Sentinel","email":"zelda.sentinel@example.com"} x',
      false,
      /^seed: [^\n]+dataset\.json is not valid JSON at line 1 column 83\n$/,
    ],
    ['valid JSON that is not a dataset', '{"masa":{"users":[{"fname":"Zelda Sentinel","email":"zelda.sentinel@example.com"}]}}', false, /^seed: [^\n]+dataset\.json does not hold a dataset\n$/],
  ])('keeps the rows of an unreadable dataset.json out of stdout and stderr: %s', async (_label, text, quoted, message) => {
    const io = captureOutput();
    const dir = await mkdtemp(join(root, 'unreadable-'));
    await writeFile(join(dir, 'dataset.json'), text);
    // V8's own message quotes the row here, so the case shows the CLI withholds it.
    if (quoted) expect(() => JSON.parse(text) as unknown).toThrow(/Zelda/);
    const requests: unknown[] = [];
    const client: DirectClient = {
      request: (req) => {
        requests.push(req);
        return Promise.reject(new Error('unexpected request'));
      },
    };
    expect(await run(['--direct', '--out', dir], { OPT2_STATE_DIR: join(dir, 'state') }, { client })).toBe(1);
    expect(io.stderr()).toMatch(message);
    for (const sentinel of ['Zelda', 'zelda.sentinel', 'example.com']) expect(`${io.stdout()}${io.stderr()}`).not.toContain(sentinel);
    expect(requests).toEqual([]);
  });

  it('runs as the entry module', async () => {
    const io = captureOutput();
    const { argv, exitCode } = process;
    onTestFinished(() => {
      process.argv = argv;
      process.exitCode = exitCode;
      vi.resetModules();
    });
    process.argv = [argv[0] ?? 'node', GENERATE_PATH, '--help'];
    process.exitCode = undefined;
    vi.resetModules();
    await import('../src/generate.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(0));
    expect(io.stdout()).toMatch(/^Usage: node dist\/generate\.js /);
  });
});

// Only run()'s own direct-mode environment checks live here; test/direct.test.ts covers the apply through an injected client.
describe('CLI --direct without a client', () => {
  it.each([
    ['unset', undefined, URLS_ERROR],
    ['empty', '', URLS_ERROR],
    ['blank', '  ', URLS_ERROR],
    ['not JSON', '{', `${URLS_INVALID} (OPT2_SERVICE_URLS must be a JSON object)\n`],
    ['not an object', JSON.stringify('http://127.0.0.1:9'), `${URLS_INVALID} (Invalid input: expected record, received string)\n`],
    ['not a URL', JSON.stringify({ ...SERVICE_URL_MAP, people: 'not a url' }), `${URLS_INVALID} (people: Invalid URL)\n`],
    ['an ftp:// URL', JSON.stringify({ ...SERVICE_URL_MAP, finance: 'ftp://127.0.0.1:9' }), `${URLS_INVALID} (finance: Invalid URL)\n`],
    ['a key that is not a service name', JSON.stringify({ ...SERVICE_URL_MAP, Finance: 'http://127.0.0.1:9' }), `${URLS_INVALID} (Finance: Invalid key in record)\n`],
    [
      'several invalid entries, one keyed by its URL',
      JSON.stringify({ surveys: 'mailto:ops@example.com', 'http://127.0.0.1:9': 'people' }),
      `${URLS_INVALID} (surveys: Invalid URL; <name>: Invalid key in record)\n`,
    ],
  ])('needs OPT2_SERVICE_URLS: %s', async (_label, urls, message) => {
    const io = captureOutput();
    const state = await mkdtemp(join(root, 'urls-'));
    const env: NodeJS.ProcessEnv = { OPT2_STATE_DIR: state, ...(urls === undefined ? {} : { OPT2_SERVICE_URLS: urls }) };
    expect(await run(['--direct', '--out', first.out], env)).toBe(2);
    expect(io.stderr()).toBe(message);
    expect([io.stdout(), await listing(state)]).toEqual(['', []]);
  });

  it.each([
    ['an empty map', {}, 'timesheets, finance, surveys, reporting, communications, e-signature'],
    ['a map missing one owner', Object.fromEntries(Object.entries(SERVICE_URL_MAP).filter(([service]) => service !== 'reporting')), 'reporting'],
  ])('names each owner of a non-empty table that OPT2_SERVICE_URLS lacks, before reading the signing keys: %s', async (_label, urls, missing) => {
    const io = captureOutput();
    const state = await mkdtemp(join(root, 'unmapped-'));
    expect(await run(['--direct', '--out', first.out], { OPT2_STATE_DIR: state, OPT2_SERVICE_URLS: JSON.stringify(urls) })).toBe(2);
    expect(io.stderr()).toBe(`seed: OPT2_SERVICE_URLS has no URL for ${missing}\n`);
    expect([io.stdout(), await listing(state)]).toEqual(['', []]);
  });

  it.each([
    ['an empty state directory', () => mkdtemp(join(root, 'keyless-'))],
    ['a state directory inside the checkout', () => Promise.resolve(join(REPO_ROOT, '.opt2-state'))],
  ])('reads the local signing keys from %s before sending anything', async (_label, stateDir) => {
    const io = captureOutput();
    const state = await stateDir();
    const existed = existsSync(state);
    expect(await run(['--direct', '--out', first.out], { OPT2_STATE_DIR: state, OPT2_SERVICE_URLS: SERVICE_URLS })).toBe(1);
    expect(io.stderr()).toMatch(/^seed: ENOENT: no such file or directory, open '[^']+token-signing-public\.pem'\n$/);
    expect(io.stderr()).toContain(state);
    expect(existsSync(state)).toBe(existed);
  });
});
