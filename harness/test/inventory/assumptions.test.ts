import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ASSUMPTIONS,
  CATALOG_TABLES_SQL,
  GENERATED_BY,
  INFO_PATH,
  NATIVE_TASKS_FILE,
  PENDING_RUN,
  PROGRAM_SITES_SQL,
  REPORT_FILE,
  REPORT_TITLE,
  SITE_ID_TABLES_SQL,
  SITE_POOLS_SQL,
  embedsSiteId,
  evaluateAssumptions,
  loadAssumptionsInventory,
  main,
  renderAssumptionsMarkdown,
  summarise,
  tableCell,
} from '../../src/inventory/assumptions.js';
import type {
  AssumptionRow,
  AssumptionsDeps,
  AssumptionsInventory,
  LegacyMonitorInfo,
  LiveEvidence,
  NativeTasksCapture,
  SitePools,
} from '../../src/inventory/assumptions.js';
import type { LegacyInventory } from '../../src/inventory/generate.js';
import { LIVE_CHECK_SQL } from '../../src/inventory/stored-procedures.js';
import type { LiveCheck, StaticMatch } from '../../src/inventory/stored-procedures.js';
import { isInsideRepo, opt2Path } from '../../src/lib/paths.js';
import type { EnvLike } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

type Db = Awaited<ReturnType<NonNullable<AssumptionsDeps['openDb']>>>;
type Fetch = NonNullable<AssumptionsDeps['fetch']>;
type Variant = AssumptionsInventory['controllers'][number]['actions'][number]['variants'][number];
type Table = AssumptionsInventory['tables'][number];
type CatalogRow = { schemaName: string; tableName: string };

const MINI = fileURLToPath(new URL('../fixtures/inventory/mini-inventory.json', import.meta.url));
const COMMITTED_REPORT = opt2Path('reports', REPORT_FILE);
const CHECKED_AT = '2026-06-30T12:00:00.000Z';
const CAPTURED_AT = '2026-06-01T00:00:00.000Z';
const clock = (): Date => new Date(CHECKED_AT);
const IDS = ['A1', 'A2', 'A3', 'A4', 'A5'] as const;
const PRISTINE_NOTE = '`${OPT2_PRISTINE_DIR}/native-tasks.json`';
const DDL_REF = { path: 'core/setup/db/mssql.sql', lines: [1, 2] };
const MONITOR_URL = 'http://localhost:8080/index.cfm/_api/sitemonitor/';
const LEGACY = 'http://legacy.test';

const ZERO_OBJECTS: LiveCheck = {
  procedures: 0,
  triggers: 0,
  databaseTriggers: 0,
  functions: 0,
  total: 0,
  excludedSchemas: ['synthetic', 'Program_*'],
  takenBeforeFixtures: true,
  checkedAt: CHECKED_AT,
  objects: [],
};

/** A `tsettings` row whose pools default to the site itself. */
function sitePools(siteId: string, pools: Partial<Omit<SitePools, 'siteId'>> = {}): SitePools {
  return {
    siteId,
    publicUserPoolID: siteId,
    privateUserPoolID: siteId,
    displayPoolID: siteId,
    contentPoolID: siteId,
    categoryPoolID: siteId,
    filePoolID: siteId,
    ...pools,
  };
}

const SITES: readonly SitePools[] = [
  sitePools('default'),
  sitePools('umbrella', { publicUserPoolID: null, privateUserPoolID: '', displayPoolID: '  ' }),
  sitePools('tenant-a', {
    publicUserPoolID: 'umbrella',
    displayPoolID: 'umbrella',
    contentPoolID: 'tenant-a, umbrella',
    categoryPoolID: 'umbrella',
    filePoolID: 'umbrella',
  }),
  sitePools('tenant-b'),
];

const LIVE_TABLES: readonly CatalogRow[] = [
  { schemaName: 'dbo', tableName: 'tsettings' },
  { schemaName: 'dbo', tableName: 'tusers' },
  { schemaName: 'opt2_sync', tableName: 'projector_checkpoint' },
  { schemaName: 'Program_1', tableName: 'timesheet' },
  { schemaName: 'Program_2', tableName: 'timesheet' },
  { schemaName: 'synthetic', tableName: 'program_site' },
];

let miniJson: unknown;
let mini: LegacyInventory;
let tempDir: string;
let committedReport: string | null;

beforeAll(async () => {
  miniJson = JSON.parse(await readFile(MINI, 'utf8'));
  mini = miniJson as LegacyInventory;
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-assumptions-'));
  vi.stubEnv('OPT2_REPORTS_DIR', tempDir);
  committedReport = await readFile(COMMITTED_REPORT, 'utf8').catch(() => null);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

/** Fresh mini-inventory copy; cast via unknown as `LegacyInventory` disposition steps are wider than the unit's. */
function copy(): AssumptionsInventory {
  return structuredClone(miniJson) as AssumptionsInventory;
}

/** Writes an inventory document into the temp dir and reads it back through the unit's validating loader. */
async function loaded(inv: LegacyInventory, name: string): Promise<{ file: string; inventory: AssumptionsInventory }> {
  const file = path.join(tempDir, name);
  await writeFile(file, JSON.stringify(inv), 'utf8');
  return { file, inventory: await loadAssumptionsInventory(file) };
}

/** Live evidence of a clean environment: no routines, `tenant-a` pooled into `umbrella`, `ping` false, no capture. */
function cleanLive(): LiveEvidence {
  return {
    checkedAt: CHECKED_AT,
    tables: LIVE_TABLES.map((t) => ({ schema: t.schemaName, name: t.tableName })),
    siteIdTableCount: 54,
    programSites: [
      { programId: 1, siteId: 'tenant-a' },
      { programId: 2, siteId: 'tenant-b' },
    ],
    sites: structuredClone([...SITES]),
    storedProcedures: structuredClone(ZERO_OBJECTS),
    legacy: { ping: false, siteMonitorTask: 'siteMonitor', siteMonitorTaskRegistered: false },
    nativeTasks: null,
  };
}

function rowById(rows: readonly AssumptionRow[], id: AssumptionRow['id']): AssumptionRow {
  const found = rows.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
}

function variantOf(inv: AssumptionsInventory, id: string): Variant {
  const found = inv.controllers.flatMap((c) => c.actions.flatMap((a) => a.variants)).find((v) => v.id === id);
  if (found === undefined) throw new Error(`no variant ${id}`);
  return found;
}

function tableEntry(entry: Pick<Table, 'table' | 'origin'> & Partial<Table>): Table {
  const siteIdSource = entry.siteIdSource ?? null;
  return { schema: 'dbo', hasSiteId: siteIdSource !== null, siteIdSource, source: DDL_REF, ...entry };
}

/** Read-only client fake answering each statement from `answers`; any other statement throws. */
function fakeDb(answers: ReadonlyMap<string, readonly unknown[]>): { db: Db; sent: string[]; closed: () => boolean } {
  const sent: string[] = [];
  let closed = false;
  const db: Db = {
    async readOnlyQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      sent.push(sql);
      const rows = answers.get(sql);
      if (rows === undefined) throw new Error(`unexpected query: ${sql}`);
      return [...rows] as T[];
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
  return { db, sent, closed: () => closed };
}

function catalogAnswers(
  tables: readonly CatalogRow[],
  fixtureSchemas: readonly unknown[] = [],
): Map<string, readonly unknown[]> {
  const probe = LIVE_CHECK_SQL.length - 1;
  return new Map<string, readonly unknown[]>([
    [CATALOG_TABLES_SQL, tables],
    [SITE_ID_TABLES_SQL, [{ tableCount: 54 }]],
    [
      PROGRAM_SITES_SQL,
      [
        { programId: 1, siteId: 'tenant-a' },
        { programId: 2, siteId: 'tenant-b' },
      ],
    ],
    [SITE_POOLS_SQL, SITES],
    ...LIVE_CHECK_SQL.map((sql, i): [string, readonly unknown[]] => [sql, i === probe ? fixtureSchemas : []]),
  ]);
}

/** Fetch fake answering every request with `body` as JSON and recording the requested URLs. */
function probeFetch(status: number, body: unknown): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: Fetch = async (input) => {
    urls.push(input);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, urls };
}

async function reportLines(file: string): Promise<{ text: string; lines: string[] }> {
  const text = await readFile(file, 'utf8');
  return { text, lines: text.split('\n') };
}

describe('ASSUMPTIONS', () => {
  it('defines the five planning assumptions in report order with a live check and an if-refuted action', () => {
    expect(ASSUMPTIONS.map((a) => a.id)).toEqual([...IDS]);
    const [programSite, frontEnd, storedProcedures, tenancy, siteMonitor] = ASSUMPTIONS.map((a) => a.assumption);
    expect(programSite).toMatch(/^"Program" maps to a Masa site/);
    expect(frontEnd).toMatch(/^Front-end scope is the admin screens of identity, people, programs-sites/);
    expect(storedProcedures).toBe('Masa has no stored procedures');
    expect(tenancy).toBe('Masa tenancy is `siteID`; shared pools map to the umbrella tenant');
    expect(siteMonitor).toBe('The `siteMonitor` task runs in the existing environment');
    for (const a of ASSUMPTIONS) {
      expect(a.liveCheck.trim()).not.toBe('');
      expect(a.actionIfRefuted.trim()).not.toBe('');
      expect(Object.isFrozen(a)).toBe(true);
    }
    expect(Object.isFrozen(ASSUMPTIONS)).toBe(true);
  });
});

describe('evaluateAssumptions without live evidence', () => {
  it('returns one pending-run row per assumption in ASSUMPTIONS order', () => {
    const rows = evaluateAssumptions(copy());
    expect(rows.map((r) => r.id)).toEqual([...IDS]);
    rows.forEach((r, i) => {
      expect(r.status).toBe(PENDING_RUN);
      expect(r.liveEvidence).toBe(PENDING_RUN);
      expect(r.assumption).toBe(ASSUMPTIONS[i]?.assumption);
      expect(r.actionIfRefuted).toBe(ASSUMPTIONS[i]?.actionIfRefuted);
    });
    expect(summarise(rows)).toEqual({ confirmed: 0, refuted: 0, pendingRun: 5 });
  });

  it('cites the static evidence of the mini inventory and leaves it unchanged', () => {
    const inv = copy();
    const before = structuredClone(inv);
    const rows = evaluateAssumptions(inv);
    expect(inv).toEqual(before);
    const evidence = (id: AssumptionRow['id']): string => rowById(rows, id).staticEvidence;
    expect(evidence('A1')).toContain(
      '`siteID` on 1 table statically (`opt2/inventory/legacy-inventory.json` `counts.tables.withSiteIdStatic`): ' +
        '1 bootstrap (`core/setup/db/mssql.sql`), 0 migration-created, 0 ORM-only',
    );
    expect(evidence('A1')).toContain('differs from the planning figure 54 by -53');
    expect(evidence('A1')).toContain('no per-site table sets in Masa: every Masa table is in `dbo`');
    expect(evidence('A1')).toContain('the inventory lists no fixture `synthetic.program_site`');
    expect(evidence('A2')).toBe(
      '`opt2/inventory/legacy-inventory.json` `controllers[]`: 3 circuits, 4 actions (0 view-only), 5 variants; ' +
        'every variant has a disposition and a rule step; ' +
        'migrated domains (identity, people, programs-sites, strategies-content): 2 carry, 2 decision variants',
    );
    expect(evidence('A3')).toBe(
      '0 `CREATE PROCEDURE`/`PROC`/`FUNCTION`/`TRIGGER` statements in `core/setup/db/mssql.sql` and in all 37 ' +
        '`core/mura/dbUpdates/*.cfm` (`storedProcedureCheck.static.count` = 0)',
    );
    expect(evidence('A4')).toContain('(`core/mura/settings/settingsBean.cfc:119-124`)');
    expect(evidence('A4')).toContain(
      "each default to the site's own id (`core/mura/settings/settingsBean.cfc:328-344`)",
    );
    expect(evidence('A5')).toBe(
      '`ping` defaults to `false` (`core/templates/settings.template.cfm:91`); the task (every 900 s, 600 s timeout) ' +
        'is registered only when `ping` is true (`core/appcfc/onApplicationStart_include.cfm:561`)',
    );
  });

  it('accepts the mini inventory through the validating loader with identical rows', async () => {
    expect(evaluateAssumptions(await loadAssumptionsInventory(MINI))).toEqual(evaluateAssumptions(copy()));
  });

  it.each([
    {
      label: 'named matches',
      matches: [
        {
          path: 'core/mura/dbUpdates/9.10.cfm',
          line: 3,
          kind: 'procedure',
          schema: 'dbo',
          name: 'usp_fixture_refuted',
          text: 'CREATE PROCEDURE dbo.usp_fixture_refuted AS SELECT 1',
        },
        { path: 'core/setup/db/mssql.sql', line: 620, kind: 'function', schema: null, name: 'fn_lower', text: '' },
        { path: 'core/mura/dbUpdates/9.11.cfm', line: 7, kind: 'function', schema: null, name: null, text: '' },
      ] satisfies StaticMatch[],
      counts: '3 `CREATE PROCEDURE`/`PROC`/`FUNCTION`/`TRIGGER` statements in',
      found:
        'found: `core/mura/dbUpdates/9.10.cfm:3` (`dbo.usp_fixture_refuted`), `core/setup/db/mssql.sql:620` ' +
        '(`fn_lower`), `core/mura/dbUpdates/9.11.cfm:7`',
    },
    {
      label: 'a count without matches',
      matches: [] satisfies StaticMatch[],
      counts: '1 `CREATE PROCEDURE`/`PROC`/`FUNCTION`/`TRIGGER` statement in',
      found: 'found: 1 statement',
    },
  ])('refutes the no-stored-procedures assumption from $label even without live data', async (c) => {
    const inv = structuredClone(mini);
    inv.storedProcedureCheck.static.count = Math.max(c.matches.length, 1);
    inv.storedProcedureCheck.static.matches = c.matches;
    inv.storedProcedureCheck.result = 'refuted';
    const { inventory } = await loaded(inv, `refuted-static-${c.matches.length}.json`);
    const rows = evaluateAssumptions(inventory);
    const a3 = rowById(rows, 'A3');
    expect(a3.status).toBe('refuted');
    expect(a3.liveEvidence).toBe(PENDING_RUN);
    expect(a3.staticEvidence).toContain(c.counts);
    expect(a3.staticEvidence.endsWith(c.found)).toBe(true);
    expect(rows.filter((r) => r.id !== 'A3').map((r) => r.status)).toEqual(Array(4).fill(PENDING_RUN));
  });

  it('refutes the program-equals-site assumption when a Masa table sits outside dbo or embeds a site id', () => {
    const inv = copy();
    inv.tables.push(
      tableEntry({ table: 'tcontent_tenant_a', origin: 'bootstrap' }),
      tableEntry({ table: 'tsitedata', schema: 'sites', origin: 'migration' }),
    );
    const a1 = rowById(evaluateAssumptions(inv), 'A1');
    expect(a1.status).toBe('refuted');
    expect(a1.staticEvidence).not.toContain('no per-site table sets in Masa');
    expect(a1.staticEvidence).toContain('Masa tables outside `dbo`: `sites.tsitedata`');
    expect(a1.staticEvidence).toContain('Masa table names embedding a site id: `tcontent_tenant_a`');
  });

  it('breaks the siteID figure down by origin and attributes a gap to ORM base classes', () => {
    const base = { path: 'core/mura/bean/beanORMVersioned.cfc', lines: [80, 80] };
    const inv = copy();
    inv.counts.tables.withSiteIdStatic = 55;
    inv.entities.push({ class: 'orm-base', source: { path: base.path, lines: [77, 77] } });
    inv.tables.push(
      tableEntry({
        table: 'tredirects',
        origin: 'bootstrap',
        siteIdSource: { path: 'core/mura/dbUpdates/7.0.cfm', lines: [32, 35] },
      }),
      tableEntry({
        table: 'ttrash',
        origin: 'migration',
        siteIdSource: { path: 'core/mura/dbUpdates/5.7.cfm', lines: [94] },
      }),
      tableEntry({ table: 'tcontentfilemetadata', origin: 'orm', siteIdSource: base }),
      tableEntry({ table: 'fb_*', origin: 'dynamic' }),
      tableEntry({
        table: 'synthetic.program_site',
        schema: 'synthetic',
        origin: 'fixture',
        source: { path: 'legacy-fixtures/sql/010_program_site.sql', lines: [1, 8] },
      }),
      tableEntry({ table: 'timesheet', schema: 'Program_1', origin: 'fixture' }),
      tableEntry({ table: 'timesheet', schema: 'Program_2', origin: 'fixture' }),
    );
    const a1 = rowById(evaluateAssumptions(inv), 'A1');
    expect(a1.status).toBe(PENDING_RUN);
    expect(a1.staticEvidence).toContain(
      '`siteID` on 55 tables statically (`opt2/inventory/legacy-inventory.json` `counts.tables.withSiteIdStatic`): ' +
        '1 bootstrap (`core/setup/db/mssql.sql`), `tredirects` with its column added at ' +
        '`core/mura/dbUpdates/7.0.cfm:32-35`, 1 migration-created (`ttrash`), 1 ORM-only',
    );
    expect(a1.staticEvidence).toContain('`tables[]` marks 4 Masa tables with `siteID`');
    expect(a1.staticEvidence).toContain(
      'the planning figure 54 omitted `tcontentfilemetadata`, whose `siteID` comes from its base ' +
        '`core/mura/bean/beanORMVersioned.cfc:80`',
    );
    expect(a1.staticEvidence).toContain(
      'fixtures add 2 per-program tables, created in `Program_1` and `Program_2` and mapped to `tenant-a` and ' +
        '`tenant-b` through `synthetic.program_site` (`legacy-fixtures/sql/010_program_site.sql:1-8`)',
    );
  });

  it.each([
    { figure: 54, text: 'matches the planning figure 54' },
    { figure: 60, text: 'differs from the planning figure 54 by 6' },
  ])('compares a static siteID figure of $figure with the planning figure', ({ figure, text }) => {
    const inv = copy();
    inv.counts.tables.withSiteIdStatic = figure;
    const a1 = rowById(evaluateAssumptions(inv), 'A1');
    expect(a1.staticEvidence).toContain(text);
    expect(a1.staticEvidence).toContain('`tables[]` marks 1 Masa table with `siteID`');
  });

  it.each([
    { label: 'no dynamic table', patterns: [], text: 'the inventory lists no dynamic table' },
    {
      label: 'two dynamic table patterns',
      patterns: ['fb_*', 'tentity-declared:*'],
      text: 'the only dynamic table patterns are `fb_*` and `tentity-declared:*`',
    },
  ])('names the dynamic table patterns of an inventory with $label', ({ patterns, text }) => {
    const inv = copy();
    inv.tables.push(...patterns.map((table) => tableEntry({ table, origin: 'dynamic' })));
    const a1 = rowById(evaluateAssumptions(inv), 'A1');
    expect(a1.staticEvidence).toContain(`(\`default\`, \`umbrella\`, \`tenant-a\`, \`tenant-b\`), and ${text};`);
  });

  it('refutes the front-end scope assumption when an action has no variant or a variant has no disposition', () => {
    const inv = copy();
    variantOf(inv, 'ctl:cemail.list').disposition = null;
    variantOf(inv, 'ctl:clogin.login').owningService = null;
    const cemail = inv.controllers.find((c) => c.source.path.endsWith('/cemail.cfc'));
    if (cemail === undefined) throw new Error('no cemail controller');
    cemail.actions.push({ id: 'ctl:cemail.edit', kind: 'view-only', variants: [] });
    inv.controllers.push({
      isBase: true,
      source: { path: 'admin/core/controllers/controller.cfc', lines: [1, 40] },
      actions: [],
    });
    const a2 = rowById(evaluateAssumptions(inv), 'A2');
    expect(a2.status).toBe('refuted');
    expect(a2.liveEvidence).toBe(PENDING_RUN);
    expect(a2.staticEvidence).toContain(
      '3 circuits plus the base `controller.cfc`, 5 actions (1 view-only), 5 variants',
    );
    expect(a2.staticEvidence).toContain('2 without a disposition and rule step: `ctl:cemail.edit`, `ctl:cemail.list`');
    expect(a2.staticEvidence).toContain('1 variant has no single owning service (1 decision)');
  });

  it.each<{ label: string; mutate: (inv: AssumptionsInventory) => void; text: string }>([
    { label: 'the mini inventory', mutate: () => undefined, text: '2 carry, 2 decision variants' },
    {
      label: 'no migrated owner',
      mutate: (inv) => {
        const ids = ['ctl:cusers.listusers', 'ctl:cusers.update{type=2,action=add}', 'ctl:clogin.login', 'ctl:cusers.update{type=2,action=delete}'];
        for (const id of ids) {
          variantOf(inv, id).owningService = 'communications';
        }
      },
      text: 'no variants',
    },
    {
      label: 'an unranked disposition',
      mutate: (inv) => {
        variantOf(inv, 'ctl:cusers.listusers').disposition = 'proposed';
      },
      text: '1 carry, 2 decision, 1 proposed variants',
    },
  ])('tallies the migrated-domain variants of $label', ({ mutate, text }) => {
    const inv = copy();
    mutate(inv);
    const a2 = rowById(evaluateAssumptions(inv), 'A2');
    expect(a2.staticEvidence).toContain(
      `migrated domains (identity, people, programs-sites, strategies-content): ${text}`,
    );
    expect(a2.status).toBe(PENDING_RUN);
  });

  it.each<{ label: string; mutate: (inv: AssumptionsInventory) => void; text: string }>([
    {
      label: 'no siteMonitor job',
      mutate: (inv) => {
        inv.scheduledJobs = [];
      },
      text: 'no `siteMonitor` job in `scheduledJobs[]`',
    },
    {
      label: 'no ping default in the settings template',
      mutate: (inv) => {
        for (const job of inv.scheduledJobs) job.registration.pingDefault = null;
      },
      text:
        'the settings template sets no `ping` default; the task (every 900 s, 600 s timeout) is registered only ' +
        'when `ping` is true (`core/appcfc/onApplicationStart_include.cfm:561`)',
    },
  ])('keeps the siteMonitor row pending with $label', ({ mutate, text }) => {
    const inv = copy();
    mutate(inv);
    const a5 = rowById(evaluateAssumptions(inv), 'A5');
    expect(a5.staticEvidence).toBe(text);
    expect(a5.status).toBe(PENDING_RUN);
  });
});


describe('evaluateAssumptions with live evidence', () => {
  it('confirms every assumption in a clean environment with no native task and ping false', () => {
    const rows = evaluateAssumptions(copy(), cleanLive());
    expect(rows.map((r) => r.status)).toEqual(Array(5).fill('confirmed'));
    expect(summarise(rows)).toEqual({ confirmed: 5, refuted: 0, pendingRun: 0 });
    const live = (id: AssumptionRow['id']): string => rowById(rows, id).liveEvidence;
    expect(live('A1')).toBe(
      'no per-site table sets: no table outside `dbo`, `synthetic`, `Program_*` and `opt2_sync`, and no `dbo` table ' +
        'name embeds a site id (`default`, `umbrella`, `tenant-a`, `tenant-b`); `siteID` on 54 `dbo` tables live ' +
        '(static 1); `synthetic.program_site`: `Program_1` → `tenant-a`, `Program_2` → `tenant-b`',
    );
    expect(live('A2')).toMatch(/^n\/a: decided from the inventory/);
    expect(live('A3')).toBe(
      '0 procedures, 0 table triggers, 0 database triggers and 0 functions (`FN`/`IF`/`TF`) outside `synthetic` and ' +
        '`Program_*`; taken before fixtures load: yes',
    );
    expect(live('A4')).toBe(
      '4 sites in `tsettings`: `default`, `umbrella`, `tenant-a`, `tenant-b`; `tenant-a` pools into `umbrella` ' +
        '(publicUserPoolID, displayPoolID, contentPoolID, categoryPoolID, filePoolID); ' +
        'own pools only: `default`, `umbrella`, `tenant-b`',
    );
    expect(live('A5')).toBe(
      `live \`ping\` = \`false\`; monitor task \`siteMonitor\` registered: no; no native capture at ${PRISTINE_NOTE}`,
    );
  });

  it.each<{ label: string; check: LiveCheck; texts: string[] }>([
    {
      label: 'a procedure',
      check: {
        ...ZERO_OBJECTS,
        procedures: 1,
        total: 1,
        objects: [{ schema: 'dbo', name: 'usp_found', kind: 'procedure', objectType: 'P' }],
      },
      texts: [
        '1 procedure, 0 table triggers, 0 database triggers and 0 functions',
        'taken before fixtures load: yes',
        'found: `dbo.usp_found` (procedure, `P`)',
      ],
    },
    {
      label: 'a database trigger after fixtures loaded',
      check: {
        ...ZERO_OBJECTS,
        databaseTriggers: 1,
        total: 1,
        takenBeforeFixtures: false,
        objects: [{ schema: null, name: 'tr_ddl_audit', kind: 'database-trigger', objectType: 'TR' }],
      },
      texts: [
        '0 procedures, 0 table triggers, 1 database trigger and 0 functions',
        'taken before fixtures load: no (fixture schemas present and excluded)',
        'found: `tr_ddl_audit` (database-trigger, `TR`)',
      ],
    },
  ])('refutes the no-stored-procedures assumption when the live check finds $label', ({ check, texts }) => {
    const live = cleanLive();
    live.storedProcedures = check;
    const rows = evaluateAssumptions(copy(), live);
    const a3 = rowById(rows, 'A3');
    expect(a3.status).toBe('refuted');
    for (const text of texts) expect(a3.liveEvidence).toContain(text);
    expect(rows.filter((r) => r.id !== 'A3').map((r) => r.status)).toEqual(Array(4).fill('confirmed'));
  });

  it.each<{ label: string; mutate: (live: LiveEvidence) => void; text: string }>([
    {
      label: 'a table outside the known schemas',
      mutate: (live) => live.tables.push({ schema: 'site_tenant_a', name: 'tcontent' }),
      text: 'per-site table set candidates: `site_tenant_a.tcontent`',
    },
    {
      label: 'a dbo table naming a site',
      mutate: (live) => live.tables.push({ schema: 'dbo', name: 'tcontent_tenant-b' }),
      text: '`dbo` tables naming a site: `tcontent_tenant-b` (`tenant-b`)',
    },
    {
      label: 'a program mapped to an unknown site',
      mutate: (live) => live.programSites?.push({ programId: 3, siteId: 'ghost' }),
      text: '`Program_3` maps to `ghost`, which is not a site',
    },
    {
      label: 'a program schema without a mapping row',
      mutate: (live) => live.tables.push({ schema: 'Program_4', name: 'timesheet' }),
      text: 'schema `Program_4` has no `synthetic.program_site` row',
    },
  ])('refutes the program-equals-site assumption on $label', ({ mutate, text }) => {
    const live = cleanLive();
    mutate(live);
    const a1 = rowById(evaluateAssumptions(copy(), live), 'A1');
    expect(a1.status).toBe('refuted');
    expect(a1.liveEvidence.endsWith(text)).toBe(true);
  });

  it.each([
    { programSites: null, text: '`synthetic.program_site` absent' },
    { programSites: [], text: '`synthetic.program_site`: no rows' },
  ])('confirms the program-equals-site assumption without fixtures: $text', ({ programSites, text }) => {
    const live = cleanLive();
    live.programSites = programSites;
    live.tables = live.tables.filter((t) => t.schema === 'dbo');
    const a1 = rowById(evaluateAssumptions(copy(), live), 'A1');
    expect(a1.status).toBe('confirmed');
    expect(a1.liveEvidence).toContain(text);
  });

  it('ignores dbo tables that match a dynamic table pattern of the inventory', () => {
    const inv = copy();
    inv.tables.push(tableEntry({ table: 'fb_*', origin: 'dynamic' }));
    const live = cleanLive();
    live.tables.push({ schema: 'dbo', name: 'fb_tenant-a_survey' });
    expect(rowById(evaluateAssumptions(inv, live), 'A1').status).toBe('confirmed');
    expect(rowById(evaluateAssumptions(copy(), live), 'A1').status).toBe('refuted');
  });

  it.each<{ label: string; mutate: (live: LiveEvidence) => void; text: string }>([
    {
      label: 'a pool naming no site',
      mutate: (live) => {
        live.sites = live.sites.map((s) => (s.siteId === 'tenant-b' ? { ...s, filePoolID: 'ghost' } : s));
      },
      text: '`tenant-b` `filePoolID` names `ghost`, which is not a site',
    },
    {
      label: 'an empty tsettings',
      mutate: (live) => {
        live.sites = [];
      },
      text: 'no rows in `tsettings`',
    },
  ])('refutes the siteID tenancy assumption on $label', ({ mutate, text }) => {
    const live = cleanLive();
    mutate(live);
    const a4 = rowById(evaluateAssumptions(copy(), live), 'A4');
    expect(a4.status).toBe('refuted');
    expect(a4.liveEvidence.endsWith(text)).toBe(true);
  });

  it('records a captured native siteMonitor task with ping true as confirming the assumption', () => {
    const live = cleanLive();
    live.legacy = { ping: true, siteMonitorTask: 'siteMonitor', siteMonitorTaskRegistered: true };
    live.nativeTasks = {
      capturedAt: CAPTURED_AT,
      originalPing: true,
      siteMonitorTask: 'siteMonitor',
      tasks: [{ task: 'siteMonitor', url: MONITOR_URL }],
    };
    const a5 = rowById(evaluateAssumptions(copy(), live), 'A5');
    expect(a5.status).toBe('confirmed');
    expect(a5.liveEvidence).toBe(
      'live `ping` = `true`; monitor task `siteMonitor` registered: yes; native capture ' +
        `${PRISTINE_NOTE} (${CAPTURED_AT}): original \`ping\` = \`true\`, 1 task (\`siteMonitor\`), ` +
        'monitor task captured: yes',
    );
  });

  it.each<{ label: string; legacy: LegacyMonitorInfo; capture: NativeTasksCapture; text: string }>([
    {
      label: 'a live monitor task the capture lacks',
      legacy: { ping: false, siteMonitorTask: 'siteMonitor', siteMonitorTaskRegistered: true },
      capture: { capturedAt: CAPTURED_AT, originalPing: false, tasks: [{ task: 'nightly-backup' }] },
      text: 'the live server has a monitor task the native capture lacks',
    },
    {
      label: 'live ping true where the capture recorded false',
      legacy: { ping: true, siteMonitorTask: 'siteMonitor', siteMonitorTaskRegistered: true },
      capture: { capturedAt: CAPTURED_AT, originalPing: 'false', tasks: [{ task: 'Masa monitor', url: MONITOR_URL }] },
      text: 'live `ping` is true but the native capture records it false',
    },
  ])('refutes the siteMonitor assumption on $label', ({ legacy, capture, text }) => {
    const live = cleanLive();
    live.legacy = legacy;
    live.nativeTasks = capture;
    const a5 = rowById(evaluateAssumptions(copy(), live), 'A5');
    expect(a5.status).toBe('refuted');
    expect(a5.liveEvidence.endsWith(text)).toBe(true);
    expect(a5.liveEvidence).toContain(`1 task (\`${capture.tasks[0]?.task}\`)`);
  });

  it.each<{ originalPing: NativeTasksCapture['originalPing']; shown: string }>([
    { originalPing: true, shown: 'true' },
    { originalPing: false, shown: 'false' },
    { originalPing: 'yes', shown: 'true' },
    { originalPing: ' NO ', shown: 'false' },
    { originalPing: '', shown: 'false' },
    { originalPing: '1', shown: 'true' },
    { originalPing: '0', shown: 'false' },
    { originalPing: 'maybe', shown: 'maybe' },
    { originalPing: null, shown: 'unknown' },
    { originalPing: undefined, shown: 'unknown' },
  ])('reads a captured ping of $originalPing as $shown', ({ originalPing, shown }) => {
    const live = cleanLive();
    live.nativeTasks = { originalPing, tasks: [] };
    const a5 = rowById(evaluateAssumptions(copy(), live), 'A5');
    expect(a5.status).toBe('confirmed');
    expect(a5.liveEvidence).toContain(
      `(capture time unknown): original \`ping\` = \`${shown}\`, 0 tasks, monitor task captured: no`,
    );
  });

  it('populates every column of every row with and without live evidence', () => {
    for (const rows of [evaluateAssumptions(copy()), evaluateAssumptions(copy(), cleanLive())]) {
      for (const r of rows) {
        for (const cell of [r.assumption, r.staticEvidence, r.liveEvidence, r.actionIfRefuted, r.status]) {
          expect(cell.trim()).not.toBe('');
        }
        expect(['confirmed', 'refuted', PENDING_RUN]).toContain(r.status);
      }
    }
  });
});

describe('table helpers', () => {
  it.each([
    { name: 'tcontent_tenant_a', siteId: 'tenant-a', embeds: true },
    { name: 'Tenant-A_files', siteId: 'tenant-a', embeds: true },
    { name: 'ttenantaccess', siteId: 'tenant-a', embeds: false },
    { name: 'tdefaults', siteId: 'default', embeds: false },
    { name: 'default', siteId: 'default', embeds: true },
  ])('decides whether $name embeds the site id $siteId', ({ name, siteId, embeds }) => {
    expect(embedsSiteId(name, siteId)).toBe(embeds);
  });

  it.each([
    { text: 'a | b', cell: 'a \\| b' },
    { text: 'a\r\nb\nc\rd', cell: 'a b c d' },
  ])('turns $text into a single-line table cell', ({ text, cell }) => {
    expect(tableCell(text)).toBe(cell);
  });
});


describe('renderAssumptionsMarkdown', () => {
  const HEADER = [
    '| # | Assumption | Static evidence (planning) | Live evidence | If refuted | Status |',
    '|---|---|---|---|---|---|',
  ];

  it('renders a pending report with each assumption and its live check in the live column', () => {
    const lines = renderAssumptionsMarkdown(evaluateAssumptions(copy()), null);
    expect(lines.slice(0, 6)).toEqual([
      'Status: pending-run',
      `Generated by: ${GENERATED_BY}`,
      'Generated at: pending-run',
      '',
      ...HEADER,
    ]);
    const body = lines.slice(6);
    expect(body).toHaveLength(ASSUMPTIONS.length);
    ASSUMPTIONS.forEach((def, i) => {
      const line = body[i] ?? '';
      expect(line.startsWith(`| ${def.id} | ${tableCell(def.assumption)} | `)).toBe(true);
      expect(line).toContain(` | ${tableCell(`${PENDING_RUN}: ${def.liveCheck}`)} | `);
      expect(line.endsWith(` | ${tableCell(def.actionIfRefuted)} | ${PENDING_RUN} |`)).toBe(true);
    });
  });

  it('marks a fully evaluated report complete with its generation time and live evidence', () => {
    const live = cleanLive();
    live.sites = [];
    const rows = evaluateAssumptions(copy(), live);
    const lines = renderAssumptionsMarkdown(rows, CHECKED_AT);
    expect(lines.slice(0, 3)).toEqual([
      'Status: complete',
      `Generated by: ${GENERATED_BY}`,
      `Generated at: ${CHECKED_AT}`,
    ]);
    rows.forEach((r, i) => {
      const cells = [r.id, r.assumption, r.staticEvidence, r.liveEvidence, r.actionIfRefuted, r.status];
      expect(lines[6 + i]).toBe(`| ${cells.map(tableCell).join(' | ')} |`);
    });
    expect(lines[9]?.endsWith(' | refuted |')).toBe(true);
  });

  it('keeps evidence holding pipes and line breaks inside one table cell', () => {
    const [first] = evaluateAssumptions(copy());
    if (first === undefined) throw new Error('no rows');
    const lines = renderAssumptionsMarkdown([{ ...first, staticEvidence: 'a | b\nc' }], null);
    expect(lines).toHaveLength(7);
    expect(lines[6]).toContain(' | a \\| b c | ');
  });
});

describe('main', () => {
  const probeBody = { PING: false, SITEMONITORTASK: 'siteMonitor', SITEMONITORTASKREGISTERED: false };

  async function reportsCase(): Promise<string> {
    return mkdtemp(path.join(tempDir, 'reports-'));
  }

  function liveEnv(reports: string, pristine = path.join(tempDir, 'no-capture')): EnvLike {
    return { OPT2_REPORTS_DIR: reports, OPT2_PRISTINE_DIR: pristine, LEGACY_ORIGIN: LEGACY };
  }

  it('writes the static report into the stubbed reports directory and nowhere in the repository', async () => {
    const outcome = await main([], undefined, { inventoryPath: MINI });
    const file = path.join(tempDir, REPORT_FILE);
    expect(outcome).toEqual({
      code: 0,
      summary: { confirmed: 0, refuted: 0, pendingRun: 5, live: false, report: file },
    });
    expect(isInsideRepo(file)).toBe(false);
    const { text, lines } = await reportLines(file);
    expect(lines.slice(0, 4)).toEqual([`# ${REPORT_TITLE}`, `Source SHA: ${pinnedSha()}`, '', 'Status: pending-run']);
    expect(lines.slice(3, -1)).toEqual(renderAssumptionsMarkdown(evaluateAssumptions(copy()), null));
    expect(lines.filter((l) => /^\| A[1-5] \|/.test(l))).toHaveLength(5);
    expect(text.endsWith(' | pending-run |\n')).toBe(true);
    await main([], undefined, { inventoryPath: MINI });
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('reports a static stored-procedure refutation without live evidence', async () => {
    const inv = structuredClone(mini);
    inv.storedProcedureCheck.static.count = 1;
    inv.storedProcedureCheck.result = 'refuted';
    const { file: inventoryPath } = await loaded(inv, 'refuted-static-main.json');
    const reports = await reportsCase();
    const outcome = await main([], { OPT2_REPORTS_DIR: reports }, { inventoryPath });
    expect(outcome.summary).toMatchObject({ confirmed: 0, refuted: 1, pendingRun: 4, live: false });
    const { lines } = await reportLines(path.join(reports, REPORT_FILE));
    expect(lines[3]).toBe('Status: pending-run');
    const a3 = lines.find((l) => l.startsWith('| A3 |')) ?? '';
    expect(a3).toContain('(`storedProcedureCheck.static.count` = 1); found: 1 statement | ');
    expect(a3.endsWith(' | refuted |')).toBe(true);
  });

  it('adds live evidence gathered through injected database, probe and capture fakes', async () => {
    const reports = await reportsCase();
    const pristine = path.join(tempDir, 'pristine');
    await mkdir(pristine, { recursive: true });
    const capture: NativeTasksCapture = {
      capturedAt: CAPTURED_AT,
      originalPing: 'false',
      siteMonitorTask: 'siteMonitor',
      tasks: [],
    };
    await writeFile(path.join(pristine, NATIVE_TASKS_FILE), JSON.stringify(capture), 'utf8');
    const { db, sent, closed } = fakeDb(catalogAnswers(LIVE_TABLES, [{ name: 'synthetic' }]));
    const probe = probeFetch(200, probeBody);
    const openDb = vi.fn(async (_env: EnvLike) => db);
    const env = liveEnv(reports, pristine);
    const outcome = await main(['--live'], env, { inventoryPath: MINI, openDb, fetch: probe.fetch, clock });
    const file = path.join(reports, REPORT_FILE);
    expect(outcome).toEqual({
      code: 0,
      summary: { confirmed: 5, refuted: 0, pendingRun: 0, live: true, report: file },
    });
    expect(openDb).toHaveBeenCalledExactlyOnceWith(env);
    expect(closed()).toBe(true);
    expect(sent).toEqual([
      CATALOG_TABLES_SQL,
      SITE_ID_TABLES_SQL,
      PROGRAM_SITES_SQL,
      SITE_POOLS_SQL,
      ...LIVE_CHECK_SQL,
    ]);
    expect(probe.urls).toEqual([`${LEGACY}${INFO_PATH}?info=1`]);
    const { lines } = await reportLines(file);
    expect(lines.slice(3, 6)).toEqual([
      'Status: complete',
      `Generated by: ${GENERATED_BY}`,
      `Generated at: ${CHECKED_AT}`,
    ]);
    expect(lines.find((l) => l.startsWith('| A3 |'))).toContain(
      'taken before fixtures load: no (fixture schemas present and excluded)',
    );
    expect(lines.find((l) => l.startsWith('| A5 |'))).toContain(
      `native capture ${PRISTINE_NOTE} (${CAPTURED_AT}): original \`ping\` = \`false\`, 0 tasks, ` +
        'monitor task captured: no',
    );
  });

  it('falls back to PORT, skips program_site without its table and records a missing capture', async () => {
    const reports = await reportsCase();
    const answers = catalogAnswers(LIVE_TABLES.filter((t) => t.schemaName === 'dbo'));
    answers.set(SITE_ID_TABLES_SQL, []);
    const { db, sent, closed } = fakeDb(answers);
    const probe = probeFetch(200, { ping: true, siteMonitorTask: 'siteMonitor', siteMonitorTaskRegistered: true });
    const env = { OPT2_REPORTS_DIR: reports, OPT2_PRISTINE_DIR: path.join(tempDir, 'no-capture'), PORT: '25980' };
    const outcome = await main(['--live'], env, { inventoryPath: MINI, openDb: async () => db, fetch: probe.fetch });
    expect(outcome.summary).toMatchObject({ confirmed: 5, refuted: 0, pendingRun: 0, live: true });
    expect(probe.urls).toEqual([`http://127.0.0.1:25980${INFO_PATH}?info=1`]);
    expect(sent).not.toContain(PROGRAM_SITES_SQL);
    expect(closed()).toBe(true);
    const { lines } = await reportLines(path.join(reports, REPORT_FILE));
    expect(lines[5]).toMatch(/^Generated at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(lines.find((l) => l.startsWith('| A1 |'))).toContain(
      '`siteID` on 0 `dbo` tables live (static 1); `synthetic.program_site` absent',
    );
    expect(lines.find((l) => l.startsWith('| A5 |'))).toContain(
      `live \`ping\` = \`true\`; monitor task \`siteMonitor\` registered: yes; no native capture at ${PRISTINE_NOTE}`,
    );
  });

  it('rejects --live without LEGACY_ORIGIN or PORT before opening the database', async () => {
    const reports = await reportsCase();
    const openDb = vi.fn(async (_env: EnvLike) => fakeDb(new Map()).db);
    const run = main(['--live'], { OPT2_REPORTS_DIR: reports }, { inventoryPath: MINI, openDb });
    await expect(run).rejects.toMatchObject({ name: 'UsageError', message: '--live needs LEGACY_ORIGIN or PORT' });
    expect(openDb).not.toHaveBeenCalled();
    expect(await readdir(reports)).toEqual([]);
  });

  it.each([
    { label: 'HTTP 500', status: 500, body: probeBody, message: `${LEGACY}${INFO_PATH}?info=1 answered HTTP 500` },
    { label: 'no monitor fields', status: 200, body: { ping: 'no' }, message: 'lacks ping, siteMonitorTask' },
    { label: 'a non-object body', status: 200, body: ['ping'], message: 'lacks ping, siteMonitorTask' },
  ])('closes the database and writes nothing when the monitor probe answers $label', async (c) => {
    const reports = await reportsCase();
    const { db, closed } = fakeDb(catalogAnswers(LIVE_TABLES));
    const deps = { inventoryPath: MINI, openDb: async () => db, fetch: probeFetch(c.status, c.body).fetch, clock };
    await expect(main(['--live'], liveEnv(reports), deps)).rejects.toThrow(c.message);
    expect(closed()).toBe(true);
    expect(await readdir(reports)).toEqual([]);
  });

  it.each([
    { label: 'not JSON', content: '{not json', message: 'is not valid JSON' },
    { label: 'off its schema', content: '{"tasks":"none"}', message: 'does not match its schema' },
  ])('fails on a native capture that is $label instead of treating it as missing', async (c) => {
    const reports = await reportsCase();
    const pristine = await mkdtemp(path.join(tempDir, 'pristine-bad-'));
    await writeFile(path.join(pristine, NATIVE_TASKS_FILE), c.content, 'utf8');
    const { db, closed } = fakeDb(catalogAnswers(LIVE_TABLES));
    const deps = { inventoryPath: MINI, openDb: async () => db, fetch: probeFetch(200, probeBody).fetch, clock };
    await expect(main(['--live'], liveEnv(reports, pristine), deps)).rejects.toThrow(c.message);
    expect(closed()).toBe(true);
    expect(await readdir(reports)).toEqual([]);
  });

  it.each([
    { label: 'missing', content: null, message: 'does not exist: run npm run inventory first' },
    { label: 'off its schema', content: '{}', message: 'does not match its schema' },
  ])('fails without writing a report when the inventory is $label', async (c) => {
    const reports = await reportsCase();
    const inventoryPath = path.join(reports, 'inventory.json');
    if (c.content !== null) await writeFile(inventoryPath, c.content, 'utf8');
    await expect(loadAssumptionsInventory(inventoryPath)).rejects.toThrow(c.message);
    await expect(main([], { OPT2_REPORTS_DIR: reports }, { inventoryPath })).rejects.toThrow(c.message);
    expect((await readdir(reports)).filter((f) => f !== 'inventory.json')).toEqual([]);
  });

  it('leaves the committed opt2/reports/assumptions.md untouched', async () => {
    expect(await readFile(COMMITTED_REPORT, 'utf8').catch(() => null)).toBe(committedReport);
  });
});

