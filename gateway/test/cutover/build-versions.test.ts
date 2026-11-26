import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { matchRouteKey, routeKeyForRequest } from '@opt2/platform/legacy-compat';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildGroups } from '../../src/cutover/build-groups.js';
import {
  CutoverBuildError,
  ROLLBACK_EVIDENCE,
  ROLLBACK_REPORT,
  VERSION_CREATED_AT,
  VERSION_IDS,
  buildVersions,
  globRoute,
  main,
  rosterGroupSet,
  serialiseVersion,
} from '../../src/cutover/build-versions.js';
import { loadVersion } from '../../src/cutover/loader.js';
import { resolveGatewayPaths, type GatewayPaths } from '../../src/cutover/paths.js';
import type {
  CutoverEntry,
  CutoverTable,
  Disposition,
  ExceptionEntry,
  GroupsFile,
  InventoryActionVariant,
  InventoryDoc,
  InventoryRoute,
  InventoryTable,
  InventoryWrite,
  InventoryWriter,
  OwnershipDoc,
} from '../../src/cutover/types.js';
import {
  inventoryKeyFacts,
  loadValidationContext,
  validateVersion,
  type ValidationContext,
} from '../../src/cutover/validate.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const SRC = { path: 'admin/core/controllers/cusers.cfc', lines: [1, 1] as const };
const committed = resolveGatewayPaths({});
const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opt2-build-versions-'));
  scratch.push(dir);
  return dir;
}

const entryOf = (table: CutoverTable, route: string): CutoverEntry | undefined => table.entries.find((entry) => entry.route === route);
const targetRoutes = (table: CutoverTable): string[] => table.entries.filter((e) => e.state === 'target').map((e) => e.route);
const withoutState = (table: CutoverTable) => table.entries.map(({ tableVersion: _v, state: _s, ...rest }) => rest);
/** Globs of the OPT-2 web-root folders the gateway answers 404 for. */
const CLOSED_FOLDER_GLOBS = [
  ...['/harness', '/infra', '/migration', '/platform', '/services', '/web'].flatMap((folder) =>
    ['cfc', 'cfm', 'static'].map((family) => `${family}:${folder}/**`),
  ),
  'opt2:/opt2/**',
  'static:/.github/workflows/**',
  'static:/gateway/**',
  'static:/legacy-fixtures/**',
];
const NATIVE_TARGETS = ['bridge:/gateway/legacy-bridge/**', ...CLOSED_FOLDER_GLOBS, 'opt2:/opt2/stub/**', 'static:/_next/**'].sort();
// ---- Committed inputs ----

describe('committed inputs', () => {
  let ctx: ValidationContext;
  let built: CutoverTable[];

  beforeAll(async () => {
    ctx = await loadValidationContext(committed, 'ci');
    built = buildVersions(ctx);
  });

  it('builds byte-identical versions on every run', () => {
    const again = buildVersions(ctx);
    expect(again.map(serialiseVersion)).toEqual(built.map(serialiseVersion));
  });

  it('chains v0001-v0003 with the pinned sha and fixed createdAt values', () => {
    expect(built.map((t) => [t.tableVersion, t.previous, t.createdAt, t.sourceSha])).toEqual([
      ['v0001', null, VERSION_CREATED_AT.v0001, SHA],
      ['v0002', 'v0001', VERSION_CREATED_AT.v0002, SHA],
      ['v0003', 'v0002', VERSION_CREATED_AT.v0003, SHA],
    ]);
    expect(VERSION_IDS).toEqual(['v0001', 'v0002', 'v0003']);
  });

  it('lists every inventoried key once, sorted, with sorted group authority and units', () => {
    for (const table of built) {
      const routes = table.entries.map((entry) => entry.route);
      expect(routes).toEqual([...routes].sort());
      expect(new Set(routes).size).toBe(routes.length);
      for (const key of ctx.inventoryKeys.keys()) expect(routes).toContain(key);
      expect(Object.keys(table.groupAuthority)).toEqual(ctx.groups.groups.map((group) => group.id).sort());
      for (const entry of table.entries) expect(entry.units).toEqual([...entry.units].sort());
    }
  });

  it('passes the validator against its predecessor and the version schema the loader applies', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'versions'));
    await copyFile(committed.schemaFile, join(dir, 'cutover-table.schema.json'));
    const paths = resolveGatewayPaths({ OPT2_CUTOVER_DIR: dir });
    for (const [i, table] of built.entries()) {
      const prior = built[i - 1];
      expect(validateVersion(table, prior === undefined ? ctx : { ...ctx, prior })).toEqual([]);
      await writeFile(join(paths.versionsDir, `${table.tableVersion}.json`), serialiseVersion(table));
      expect(await loadVersion(paths, table.tableVersion)).toEqual(table);
    }
  });

  it('keeps every inventoried entry legacy in v0001 and targets only the OPT-2 platform entries', () => {
    const [v0001] = built as [CutoverTable];
    expect(targetRoutes(v0001)).toEqual(NATIVE_TARGETS);
    expect(Object.values(v0001.groupAuthority).every((authority) => authority === 'legacy')).toBe(true);
    expect(new Set(v0001.entries.map((entry) => entry.tableVersion))).toEqual(new Set(['v0001']));
    expect(entryOf(v0001, 'opt2:/opt2/stub/**')).toEqual({
      route: 'opt2:/opt2/stub/**',
      owningService: 'stub',
      tableVersion: 'v0001',
      state: 'target',
      kind: 'write',
      group: null,
      units: [],
      disposition: 'carry',
    });
  });

  it('moves sitemonitor:run in v0002 and keeps withheld and halted keys on legacy', () => {
    const v0002 = built[1] as CutoverTable;
    expect(entryOf(v0002, 'sitemonitor:run')).toMatchObject({ kind: 'job', state: 'target', tableVersion: 'v0002' });
    const withheld = ctx.decisionList.actionVariants.flatMap((v) => [v.routeKey, ...(v.entryPoints ?? []).flatMap((e) => e.routeKey ?? [])]);
    const listed = withheld.filter((key) => ctx.inventoryKeys.has(key));
    expect(listed.length).toBeGreaterThan(0);
    for (const key of listed) expect(entryOf(v0002, key)?.state).toBe('legacy');
    for (const key of ['admin:carch.update{upload=image}', 'api:file.save{upload=image}', 'rest:file.save{upload=image}', 'admin:carch.edit', 'admin:carch.list{sharedid}']) {
      expect(entryOf(v0002, key)).toMatchObject({ kind: 'legacy-write', state: 'legacy' });
    }
    // A halted whole write key leaves its group, which still moves.
    expect(entryOf(v0002, 'admin:carch.edit')?.group).toBeNull();
    // A halted write variant leaves its base in the group.
    expect(entryOf(v0002, 'admin:carch.list{sharedid}')).toMatchObject({ group: null, units: ['content.content'] });
    expect(entryOf(v0002, 'admin:carch.list')).toMatchObject({ kind: 'write', state: 'target', group: 'grp:content.approval_action' });
    expect(v0002.groupAuthority['grp:content.approval_action']).toBe('target');
  });

  it('makes a write entry follow its group and a read target only over target units', () => {
    const v0002 = built[1] as CutoverTable;
    const unitGroup = new Map(ctx.groups.groups.flatMap((g) => g.units.map((unit): [string, string] => [unit, g.id])));
    for (const entry of v0002.entries) {
      if (entry.kind === 'write' && entry.group !== null) expect(entry.state).toBe(v0002.groupAuthority[entry.group ?? '']);
      if (entry.kind === 'read' && entry.state === 'target') {
        for (const unit of entry.units) expect(v0002.groupAuthority[unitGroup.get(unit) ?? '']).toBe('target');
      }
      if (entry.state === 'target') expect(entry.disposition).toBe('carry');
    }
  });

  it('returns exactly the roster group set to legacy in v0003 with its rollback reference', () => {
    const [, v0002, v0003] = built as [CutoverTable, CutoverTable, CutoverTable];
    const roster = rosterGroupSet(ctx.groups);
    expect(roster).toContain(ctx.groups.groups.find((g) => g.writeEntries.includes('admin:cusers.update{type=2,action=add}'))?.id);
    for (const [group, authority] of Object.entries(v0003.groupAuthority)) {
      expect(authority).toBe(roster.includes(group) ? 'legacy' : v0002.groupAuthority[group]);
    }
    expect(v0003.rollbackRefs).toEqual([{ groups: roster, rollbackSet: roster, report: ROLLBACK_REPORT, evidence: [...ROLLBACK_EVIDENCE] }]);
    expect(entryOf(v0003, 'sitemonitor:run')?.state).toBe('target');
  });

  it('shares one entry set across versions, differing only in tableVersion and state', () => {
    const [v0001, v0002, v0003] = built as [CutoverTable, CutoverTable, CutoverTable];
    expect(withoutState(v0002)).toEqual(withoutState(v0001));
    expect(withoutState(v0003)).toEqual(withoutState(v0001));
    for (const [prior, table] of [
      [v0001, v0002],
      [v0002, v0003],
    ] as const) {
      for (const entry of table.entries) {
        const before = entryOf(prior, entry.route);
        expect(entry.tableVersion).toBe(before?.state === entry.state ? before.tableVersion : table.tableVersion);
      }
    }
  });

  it('keys each OPT-2 glob so live requests under it resolve to it', async () => {
    const v0002 = built[1] as CutoverTable;
    const routes = v0002.entries.map((entry) => entry.route);
    const resolve = (path: string) => matchRouteKey(routeKeyForRequest({ method: 'GET', path, query: {}, headers: {} }), routes);
    const stub = parse(await readFile(join(committed.repoRoot, 'services/stub/contracts/openapi.yaml'), 'utf8')) as {
      paths: Record<string, unknown>;
    };
    const stubPaths = Object.keys(stub.paths).filter((path) => !path.startsWith('/internal/') && path !== '/healthz');
    expect(stubPaths.length).toBeGreaterThan(0);
    for (const path of stubPaths) expect(resolve(path.replaceAll(/\{[^}]+\}/g, 'x'))).toBe('opt2:/opt2/stub/**');
    expect(resolve('/gateway/legacy-bridge/cfml/session.cfm')).toBe('bridge:/gateway/legacy-bridge/**');
    expect(resolve('/gateway/cutover/versions/v0002.json')).toBe('static:/gateway/**');
    expect(resolve('/harness/legacy-baseline/cfml/run.cfm/x')).toBe('cfm:/harness/**');
    expect(resolve('/harness/legacy-baseline/cfml/Application.cfc')).toBe('cfc:/harness/**');
    expect(resolve('/opt2/source-pin.json')).toBe('opt2:/opt2/**');
    expect(resolve('/legacy-fixtures/cfml/seed.cfm')).toBeUndefined();
    for (const route of CLOSED_FOLDER_GLOBS) {
      expect(entryOf(v0002, route)).toMatchObject({ owningService: 'gateway', state: 'target', kind: 'static', units: [], disposition: 'carry' });
    }
    expect(resolve('/_next/static/chunks/main.js')).toBe('static:/_next/**');
    expect(resolve('/admin/assets/css/admin.min.css')).toBe('static:/admin/assets/**');
    expect(resolve('/opt2/files/content-files/tenant/file.png')).toBe('opt2:/opt2/files/content-files/**');
    expect(resolve('/opt2/admin/module/screen')).toBe('opt2:/opt2/**');
    expect(entryOf(v0002, 'opt2:/opt2/files/content-files/**')?.units).toEqual(['content.file']);
  });

  it.each<[string, string, string?]>([
    ['/opt2/stub', 'opt2:/opt2/stub/**'],
    ['/core/vendor', 'static:/core/vendor/**'],
    ['/harness', 'cfm:/harness/**', 'probe.cfm'],
    ['/harness', 'cfc:/harness/**', 'probe.cfc'],
  ])('derives the glob of %s from the route-key family', (prefix, key, probe) => {
    expect(globRoute(prefix, probe)).toBe(key);
  });

  it('rejects a prefix no path family keys', () => {
    expect(() => globRoute('/_api/json/v1')).toThrow(CutoverBuildError);
  });
});

describe.runIf(VERSION_IDS.every((id) => existsSync(join(committed.versionsDir, `${id}.json`))))('committed versions', () => {
  it('equal the build, so the default CLI mode reports no difference', async () => {
    const stderr: string[] = [];
    const code = await main([], { paths: committed, stdout: () => undefined, stderr: (text) => stderr.push(text) });
    expect({ code, stderr }).toEqual({ code: 0, stderr: [] });
  });
});

// ---- Rules on fixture inventories ----

const ADD = 'admin:cusers.update{type=2,action=add}';
const ARCHIVE = 'fixture:people/persons/{id}/archive@post';
const RECORD = 'fixture:sample/records@post';
const RECORDS = 'fixture:sample/records@get';
const IMAGE = 'admin:carch.update{upload=image}';
const EDIT = 'admin:carch.edit';
const JOB = 'sitemonitor:run';

function write(unit: string, legacyTable: string | null = null): InventoryWrite {
  return { unit, legacyTable, op: 'update', via: [], source: SRC, condition: null, override: null };
}

function variant(routeKey: string, disposition: Disposition, owner: string | null, writes: InventoryWrite[] = []): InventoryActionVariant {
  return {
    id: `item:${routeKey}`,
    source: SRC,
    owningService: owner,
    disposition,
    writeSet: writes,
    conditionalWrites: [],
    routeKey,
    predicate: null,
    sessionEffects: 'none',
    csrfValidation: 'none',
    csrfContext: null,
    responseMode: 'page',
    contentType: null,
  };
}

function fixtureRoute(routeKey: string, owner: string, writes: InventoryWrite[] = []): InventoryRoute {
  return {
    id: `item:${routeKey}`,
    source: SRC,
    owningService: owner,
    disposition: 'carry',
    writeSet: writes,
    conditionalWrites: [],
    routeKey,
    predicate: null,
    sessionEffects: 'none',
    csrfValidation: 'none',
    csrfContext: null,
    kind: 'fixture',
    family: 'fixture',
  };
}

function writer(table: string, fields: Partial<InventoryWriter>): InventoryTable {
  const record: InventoryWriter = {
    component: 'core/mura/content/contentServer.cfc',
    method: 'handleAPIRequest',
    source: { path: 'core/mura/content/contentServer.cfc', lines: [669, 747] },
    op: 'update',
    routeKeys: [],
    keyScope: [],
    trigger: 'request',
    sessionEffects: 'none',
    condition: null,
    override: null,
    ...fields,
  };
  return { id: `tbl:${table}`, source: SRC, owningService: null, disposition: 'carry', table, schema: 'dbo', hasPrimaryKey: true, writers: [record] };
}

/** An inventory table with no writer. */
const unwritten = (table: string): InventoryTable => ({ ...writer(table, {}), writers: [] });
// Nothing in the fixture inventory writes the image sizes.
const DEFAULT_TABLES = [unwritten('timagesizes')];

const UNITS: Record<string, readonly string[]> = {
  'people.person': ['tusers'],
  'identity.user_account': ['tusers'],
  'people.person_archive': ['synthetic.person_archive'],
  'programs_sites.site': ['tsettings'],
  'programs_sites.image_size': ['timagesizes'],
  'content.content': ['tcontent'],
};

/** The owning service of a unit: its schema prefix, with `content` for strategies-content and `_` for `-`. */
const ownerOfUnit = (unit: string): string => (unit.startsWith('content.') ? 'strategies-content' : (unit.split('.')[0] as string).replace('_', '-'));

function ownershipOf(units: Record<string, readonly string[]>): OwnershipDoc {
  return {
    sourceSha: SHA,
    units: Object.entries(units).map(([unit, legacyTables]) => ({ unit, owner: ownerOfUnit(unit), legacyTables })),
    tables: Object.entries(units).flatMap(([unit, [table]]) =>
      table === undefined ? [] : [{ table, owner: ownerOfUnit(unit), targets: [{ unit, rowPredicate: null, ownedColumns: [] }] }],
    ),
  };
}

interface FixtureSpec {
  tables?: InventoryTable[];
  exceptions?: ExceptionEntry[];
  withheld?: string[];
  units?: Record<string, readonly string[]>;
  owner?: string;
}

function fixtureContext(spec: FixtureSpec = {}): ValidationContext {
  const inventory: InventoryDoc = {
    sourceSha: SHA,
    controllers: [
      {
        id: 'ctl:cusers',
        circuit: 'cusers',
        isBase: false,
        owningService: 'people',
        actions: [
          {
            id: 'act:cusers.update',
            action: 'update',
            variants: [
              variant(ADD, 'carry', spec.owner ?? 'people', [write('people.person', 'tusers'), write('identity.user_account', 'tusers')]),
              variant(IMAGE, 'decision', null, [write('content.content', 'tcontent')]),
              variant(EDIT, 'carry', 'strategies-content'),
            ],
          },
        ],
      },
    ],
    routes: [
      fixtureRoute(ARCHIVE, 'people', [write('people.person_archive')]),
      fixtureRoute(RECORD, 'programs-sites', [write('programs_sites.site')]),
      fixtureRoute(RECORDS, 'programs-sites'),
      { ...fixtureRoute(JOB, 'programs-sites'), kind: 'job', family: 'sitemonitor' },
    ],
    frontEnd: [],
    scheduledJobs: [
      {
        id: 'job:sitemonitor',
        source: SRC,
        owningService: 'programs-sites',
        disposition: 'carry',
        routeKey: JOB,
        steps: [{ ...variant('-', 'carry', 'strategies-content', [write('content.content')]), order: 1, step: 'feed-import' }],
      },
    ],
    tables: spec.tables ?? DEFAULT_TABLES,
  };
  const ownership = ownershipOf(spec.units ?? UNITS);
  const exceptions = { sourceSha: SHA, entries: spec.exceptions ?? [] };
  const groups = buildGroups({
    sourceSha: SHA,
    inventory,
    ownership,
    exceptions,
    inputs: { inventorySha256: 'a'.repeat(64), tableOwnershipSha256: 'b'.repeat(64) },
  });
  return {
    mode: 'ci',
    inventory,
    inventoryKeys: inventoryKeyFacts(inventory),
    groups,
    variants: {
      sourceSha: SHA,
      variants: [
        { route: 'admin:cusers.update', variant: 'type=2,action=add', when: [] },
        { route: 'admin:carch.update', variant: 'upload=image', when: [] },
      ],
    },
    decisionList: { sourceSha: SHA, tables: [], actionVariants: (spec.withheld ?? []).map((routeKey) => ({ routeKey, writeSet: [] })) },
    exceptions,
    ownership,
    sourceSha: SHA,
    reconciliationDir: join(tmpdir(), 'no-reconciliation'),
  };
}

const groupOfUnit = (ctx: ValidationContext, unit: string): string => ctx.groups.groups.find((g) => g.units.includes(unit))?.id ?? '';

describe('buildVersions on fixture inventories', () => {
  it('names the roster group set from roster write entries and seam units', () => {
    const ctx = fixtureContext();
    expect(rosterGroupSet(ctx.groups)).toEqual(['grp:identity.user_account', 'grp:people.person_archive']);
    const seamOnly: Pick<GroupsFile, 'groups'> = {
      groups: [
        { id: 'grp:people.person_archive', units: ['people.person_archive'], writeEntries: [], hasCarryWrite: false },
        { id: 'grp:content.content', units: ['content.content'], writeEntries: [' Admin:CUsers.Update{type=2,action=update} '], hasCarryWrite: true },
        { id: 'grp:content.file', units: ['content.file'], writeEntries: [EDIT], hasCarryWrite: true },
      ],
    };
    expect(rosterGroupSet(seamOnly)).toEqual(['grp:content.content', 'grp:people.person_archive']);
  });

  it('derives kinds, units and states from the inventory', () => {
    const ctx = fixtureContext();
    const [v0001, v0002, v0003] = buildVersions(ctx) as [CutoverTable, CutoverTable, CutoverTable];
    expect(entryOf(v0002, ADD)).toMatchObject({
      kind: 'write',
      group: 'grp:identity.user_account',
      units: ['identity.user_account', 'people.person'],
      state: 'target',
      tableVersion: 'v0002',
    });
    expect(entryOf(v0002, IMAGE)).toMatchObject({ kind: 'legacy-write', group: null, units: ['content.content'], state: 'legacy' });
    // Nothing writes the image sizes, so the read over every programs-sites unit stays legacy.
    expect(entryOf(v0002, RECORDS)).toMatchObject({ kind: 'read', units: ['programs_sites.image_size', 'programs_sites.site'], state: 'legacy' });
    expect(entryOf(v0002, EDIT)).toMatchObject({ kind: 'read', units: ['content.content'], state: 'legacy' });
    expect(entryOf(v0001, JOB)).toMatchObject({ kind: 'job', units: ['content.content'], state: 'legacy' });
    expect(entryOf(v0002, JOB)?.state).toBe('target');
    expect(entryOf(v0003, ADD)).toMatchObject({ state: 'legacy', tableVersion: 'v0003' });
    expect(entryOf(v0003, RECORD)).toMatchObject({ state: 'target', tableVersion: 'v0002' });
    expect(v0003.rollbackRefs[0]?.groups).toEqual(rosterGroupSet(ctx.groups));
  });

  it.each([
    ['prevented', 'handleAPIRequest', 'target'],
    ['unprevented', 'handleRootRequest', 'legacy'],
  ] as const)('keeps a group legacy only while its scheduler writer is %s', (_label, method, expected) => {
    const ctx = fixtureContext({ tables: [...DEFAULT_TABLES, writer('tsettings', { method, trigger: 'scheduler' })] });
    const v0002 = buildVersions(ctx)[1] as CutoverTable;
    expect(v0002.groupAuthority[groupOfUnit(ctx, 'programs_sites.site')]).toBe(expected);
    expect(entryOf(v0002, RECORD)?.state).toBe(expected);
  });

  it('keeps a halted carry read on legacy', () => {
    // Without the image sizes, every unit the read covers moves, so only the halt keeps it on legacy.
    const { 'programs_sites.image_size': _imageSize, ...units } = UNITS;
    expect(entryOf(buildVersions(fixtureContext({ units, tables: [] }))[1] as CutoverTable, RECORDS)?.state).toBe('target');
    const exceptions: ExceptionEntry[] = [{ id: 'EX-1', routeKey: RECORDS, decision: 'preserve', status: 'halted' }];
    const v0002 = buildVersions(fixtureContext({ units, tables: [], exceptions }))[1] as CutoverTable;
    expect(entryOf(v0002, RECORDS)).toMatchObject({ kind: 'read', state: 'legacy' });
  });

  it('fails when a carry write entry is in no generated group', () => {
    const ctx = fixtureContext();
    const groups = { ...ctx.groups, groups: ctx.groups.groups.map((g) => ({ ...g, writeEntries: g.writeEntries.filter((k) => k !== ADD) })) };
    expect(() => buildVersions({ ...ctx, groups })).toThrow(`carry write entry ${ADD} is in 0 groups`);
  });

  it('fails on an owner the cut-over table cannot name', () => {
    expect(() => buildVersions(fixtureContext({ owner: 'split' }))).toThrow(/owner split is not a cut-over owning service/);
  });

  it('never returns a version the validator rejects', () => {
    let error: unknown;
    try {
      buildVersions(fixtureContext({ withheld: [RECORD] }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CutoverBuildError);
    expect((error as CutoverBuildError).message).toMatch(/^v0002 fails validation:\nwithheld-never-target fixture:sample\/records@post/);
    expect((error as CutoverBuildError).findings.map((finding) => finding.rule)).toContain('withheld-never-target');
  });

  it('returns no rollback reference when no group holds the roster', () => {
    const ctx = fixtureContext();
    const groups = { ...ctx.groups, groups: ctx.groups.groups.filter((g) => !rosterGroupSet(ctx.groups).includes(g.id)) };
    const units = ctx.ownership.units.filter((u) => groups.groups.some((g) => g.units.includes(u.unit)));
    const inventory = { ...ctx.inventory, controllers: [], routes: ctx.inventory.routes.filter((r) => r.routeKey !== ARCHIVE) };
    const trimmed = { ...ctx, groups, inventory, inventoryKeys: inventoryKeyFacts(inventory), ownership: { ...ctx.ownership, units } };
    expect(buildVersions(trimmed)[2]?.rollbackRefs).toEqual([]);
  });
});

// ---- CLI ----

/** The message `JSON.parse` rejects `text` with. */
function parseError(text: string): string {
  try {
    JSON.parse(text);
  } catch (error) {
    return (error as SyntaxError).message;
  }
  throw new Error('the text is valid JSON');
}

describe('main', () => {
  /** Paths of a new cut-over directory holding the committed schema, variants, groups and `versions`. */
  const casePaths = async (versions: readonly string[] = []): Promise<GatewayPaths> => {
    const dir = await tempDir();
    for (const key of ['schemaFile', 'variantsFile', 'groupsFile'] as const) await copyFile(committed[key], join(dir, basename(committed[key])));
    const paths = resolveGatewayPaths({ OPT2_CUTOVER_DIR: dir });
    if (versions.length > 0) await mkdir(paths.versionsDir);
    for (const id of versions) await copyFile(join(committed.versionsDir, `${id}.json`), join(paths.versionsDir, `${id}.json`));
    return paths;
  };

  const run = async (paths: GatewayPaths, argv: string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(argv, { paths, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
    return { code, stdout, stderr };
  };
  const fileOf = (paths: GatewayPaths, id: string) => join(paths.versionsDir, `${id}.json`);
  /** The committed bytes of a version, which the build must reproduce exactly. */
  const committedBytes = (id: string): Promise<string> => readFile(join(committed.versionsDir, `${id}.json`), 'utf8');

  it('reports missing version files as differences', async () => {
    const paths = await casePaths();
    expect(await run(paths, [])).toEqual({
      code: 1,
      stdout: [],
      stderr: VERSION_IDS.map((id) => `build-versions: ${fileOf(paths, id)} does not exist; run with --write`),
    });
  });

  it('writes with --write (repeatable) and then reports no difference', async () => {
    const paths = await casePaths();
    const written = await run(paths, ['--write', '--write']);
    expect(written).toEqual({ code: 0, stdout: VERSION_IDS.map((id) => `build-versions: wrote ${fileOf(paths, id)}`), stderr: [] });
    const built = buildVersions(await loadValidationContext(paths, 'ci'));
    for (const table of built) expect(await readFile(fileOf(paths, table.tableVersion), 'utf8')).toBe(`${JSON.stringify(table)}\n`);
    for (const id of VERSION_IDS) expect(await readFile(fileOf(paths, id), 'utf8'), id).toBe(await committedBytes(id));
    expect(await run(paths, [])).toEqual({ code: 0, stdout: VERSION_IDS.map((id) => `build-versions: ${fileOf(paths, id)} is up to date`), stderr: [] });
  });

  it('prints a line diff when a version differs', async () => {
    const paths = await casePaths(VERSION_IDS);
    const current = await committedBytes('v0002');
    const edited = current.replace(`"createdAt":"${VERSION_CREATED_AT.v0002}"`, '"createdAt":"2020-01-01T00:00:00.000Z"');
    expect(edited).not.toBe(current);
    await writeFile(fileOf(paths, 'v0002'), edited);
    expect(await run(paths, [])).toEqual({
      code: 1,
      stdout: [
        `build-versions: ${fileOf(paths, 'v0001')} is up to date`,
        `--- ${fileOf(paths, 'v0002')} (pretty-printed)`,
        '+++ build (pretty-printed)',
        '@@ -5 +5 @@',
        '-  "createdAt": "2020-01-01T00:00:00.000Z",',
        `+  "createdAt": "${VERSION_CREATED_AT.v0002}",`,
        `build-versions: ${fileOf(paths, 'v0003')} is up to date`,
      ],
      stderr: [`build-versions: ${fileOf(paths, 'v0002')} differs from the build; run with --write`],
    });
  });

  it('reports a v0002 that is not valid JSON with exit 1', async () => {
    const paths = await casePaths(VERSION_IDS);
    const current = await committedBytes('v0002');
    const cut = current.slice(0, Math.floor(current.length / 2));
    await writeFile(fileOf(paths, 'v0002'), cut);
    expect(await run(paths, [])).toEqual({
      code: 1,
      stdout: [
        `build-versions: ${fileOf(paths, 'v0001')} is up to date`,
        `${fileOf(paths, 'v0002')} is not valid JSON: ${parseError(cut)}`,
        `build-versions: ${fileOf(paths, 'v0003')} is up to date`,
      ],
      stderr: [`build-versions: ${fileOf(paths, 'v0002')} differs from the build; run with --write`],
    });
  });

  it.each([[['--check']], [['--fixtures', 'available']]])(
    'exits 2 on usage error %j',
    async (argv) => {
      const { code, stderr } = await run(await casePaths(), argv);
      expect(code).toBe(2);
      expect(stderr[0]).toMatch(/^build-versions: unknown argument /);
      expect(stderr[0]).toMatch(/usage: build-versions\.ts/);
    },
  );

  it('reports an input of another commit with exit 1', async () => {
    const paths = await casePaths();
    const other = join(paths.cutoverDir, 'other-pin.json');
    const pin = JSON.parse(await readFile(committed.exceptionsListFile, 'utf8')) as { sourceSha: string };
    await writeFile(other, JSON.stringify({ ...pin, sourceSha: '0'.repeat(40) }));
    const { code, stderr } = await run({ ...paths, exceptionsListFile: other }, []);
    expect({ code, stderr }).toEqual({
      code: 1,
      stderr: [`build-versions: ${other} does not match its cut-over schema: /sourceSha must equal the pinned sha ${SHA}`],
    });
  });
});
