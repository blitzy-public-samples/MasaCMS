import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  resolveFixtures,
  rosterGroupSet,
  serialiseVersion,
  servesSyntheticRoutes,
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
const NATIVE_TARGETS = ['bridge:/gateway/legacy-bridge/**', 'opt2:/opt2/stub/**', 'static:/_next/**'];

// ---- Committed inputs ----

describe('committed inputs', () => {
  let ctx: ValidationContext;
  let available: CutoverTable[];
  let unavailable: CutoverTable[];

  beforeAll(async () => {
    ctx = await loadValidationContext(committed, 'ci');
    available = buildVersions(ctx, { available: true });
    unavailable = buildVersions(ctx, { available: false });
  });

  it('builds byte-identical versions on every run', () => {
    const again = buildVersions(ctx, { available: true });
    expect(again.map(serialiseVersion)).toEqual(available.map(serialiseVersion));
  });

  it('chains v0001-v0003 with the pinned sha and fixed createdAt values', () => {
    expect(available.map((t) => [t.tableVersion, t.previous, t.createdAt, t.sourceSha])).toEqual([
      ['v0001', null, VERSION_CREATED_AT.v0001, SHA],
      ['v0002', 'v0001', VERSION_CREATED_AT.v0002, SHA],
      ['v0003', 'v0002', VERSION_CREATED_AT.v0003, SHA],
    ]);
    expect(VERSION_IDS).toEqual(['v0001', 'v0002', 'v0003']);
  });

  it('lists every inventoried key once, sorted, with sorted group authority and units', () => {
    for (const table of available) {
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
    for (const chain of [available, unavailable]) {
      for (const [i, table] of chain.entries()) {
        const prior = chain[i - 1];
        expect(validateVersion(table, prior === undefined ? ctx : { ...ctx, prior })).toEqual([]);
        await writeFile(join(paths.versionsDir, `${table.tableVersion}.json`), serialiseVersion(table));
        expect(await loadVersion(paths, table.tableVersion)).toEqual(table);
      }
    }
  });

  it('keeps every inventoried entry legacy in v0001 and targets only the OPT-2 platform entries', () => {
    const [v0001] = available as [CutoverTable];
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
    const v0002 = available[1] as CutoverTable;
    expect(entryOf(v0002, 'sitemonitor:run')).toMatchObject({ kind: 'job', state: 'target', tableVersion: 'v0002' });
    const withheld = ctx.decisionList.actionVariants.flatMap((v) => [v.routeKey, ...(v.entryPoints ?? []).flatMap((e) => e.routeKey ?? [])]);
    const listed = withheld.filter((key) => ctx.inventoryKeys.has(key));
    expect(listed.length).toBeGreaterThan(0);
    for (const key of listed) expect(entryOf(v0002, key)?.state).toBe('legacy');
    for (const key of ['admin:carch.update{upload=image}', 'api:file.save{upload=image}', 'rest:file.save{upload=image}']) {
      expect(entryOf(v0002, key)).toMatchObject({ kind: 'legacy-write', state: 'legacy' });
    }
  });

  it('makes a write entry follow its group and a read target only over target units', () => {
    const v0002 = available[1] as CutoverTable;
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
    const [, v0002, v0003] = available as [CutoverTable, CutoverTable, CutoverTable];
    const roster = rosterGroupSet(ctx.groups);
    expect(roster).toContain(ctx.groups.groups.find((g) => g.writeEntries.includes('admin:cusers.update{type=2,action=add}'))?.id);
    for (const [group, authority] of Object.entries(v0003.groupAuthority)) {
      expect(authority).toBe(roster.includes(group) ? 'legacy' : v0002.groupAuthority[group]);
    }
    expect(v0003.rollbackRefs).toEqual([{ groups: roster, rollbackSet: roster, report: ROLLBACK_REPORT, evidence: [...ROLLBACK_EVIDENCE] }]);
    expect(entryOf(v0003, 'sitemonitor:run')?.state).toBe('target');
  });

  it('shares one entry set across versions, differing only in tableVersion and state', () => {
    const [v0001, v0002, v0003] = available as [CutoverTable, CutoverTable, CutoverTable];
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

  it('adds the synthetic /v1/ entries from v0002 only when fixtures are unavailable', () => {
    expect(serialiseVersion(unavailable[0] as CutoverTable)).toBe(serialiseVersion(available[0] as CutoverTable));
    const added = (unavailable[1] as CutoverTable).entries.filter((entry) => !entryOf(available[1] as CutoverTable, entry.route));
    expect(added.map((entry) => [entry.route, entry.owningService, entry.state, entry.kind])).toEqual([
      ['static:/v1/communications/**', 'communications', 'target', 'write'],
      ['static:/v1/esignature/**', 'e-signature', 'target', 'write'],
      ['static:/v1/finance/**', 'finance', 'target', 'write'],
      ['static:/v1/reporting/**', 'reporting', 'target', 'write'],
      ['static:/v1/surveys/**', 'surveys', 'target', 'write'],
      ['static:/v1/timesheets/**', 'timesheets', 'target', 'write'],
    ]);
    expect(servesSyntheticRoutes(unavailable[1] as CutoverTable)).toBe(true);
    expect(available.some(servesSyntheticRoutes)).toBe(false);
  });

  it('keys each OPT-2 glob so live requests under it resolve to it', async () => {
    const v0002 = available[1] as CutoverTable;
    const routes = v0002.entries.map((entry) => entry.route);
    const resolve = (path: string) => matchRouteKey(routeKeyForRequest({ method: 'GET', path, query: {}, headers: {} }), routes);
    const stub = parse(await readFile(join(committed.repoRoot, 'services/stub/contracts/openapi.yaml'), 'utf8')) as {
      paths: Record<string, unknown>;
    };
    const stubPaths = Object.keys(stub.paths).filter((path) => !path.startsWith('/internal/') && path !== '/healthz');
    expect(stubPaths.length).toBeGreaterThan(0);
    for (const path of stubPaths) expect(resolve(path.replaceAll(/\{[^}]+\}/g, 'x'))).toBe('opt2:/opt2/stub/**');
    expect(resolve('/gateway/legacy-bridge/cfml/session.cfm')).toBe('bridge:/gateway/legacy-bridge/**');
    expect(resolve('/_next/static/chunks/main.js')).toBe('static:/_next/**');
    expect(resolve('/admin/assets/css/admin.min.css')).toBe('static:/admin/assets/**');
    expect(resolve('/opt2/files/content-files/tenant/file.png')).toBe('opt2:/opt2/files/content-files/**');
    expect(resolve('/opt2/admin/timesheets/sheets')).toBe('opt2:/opt2/admin/timesheets/**');
    expect(entryOf(v0002, 'opt2:/opt2/files/finance-attachments/**')).toMatchObject({ owningService: 'finance', units: ['finance.attachment'] });
    expect(entryOf(v0002, 'opt2:/opt2/files/content-files/**')?.units).toEqual(['content.file']);
  });

  it.each([
    ['/opt2/stub', 'opt2:/opt2/stub/**'],
    ['/core/vendor', 'static:/core/vendor/**'],
    ['/v1/finance', 'static:/v1/finance/**'],
  ])('derives the glob of %s from the route-key family', (prefix, key) => {
    expect(globRoute(prefix)).toBe(key);
  });

  it('rejects a prefix no path family keys', () => {
    expect(() => globRoute('/_api/json/v1')).toThrow(CutoverBuildError);
  });
});

describe.runIf(VERSION_IDS.every((id) => existsSync(join(committed.versionsDir, `${id}.json`))))('committed versions', () => {
  it('equal the build, so the default CLI mode reports no difference', async () => {
    const stderr: string[] = [];
    const code = await main(['--fixtures', 'available'], { paths: committed, stdout: () => undefined, stderr: (text) => stderr.push(text) });
    expect({ code, stderr }).toEqual({ code: 0, stderr: [] });
  });
});

// ---- Rules on fixture inventories ----

const ADD = 'admin:cusers.update{type=2,action=add}';
const ARCHIVE = 'fixture:people/persons/{id}/archive@post';
const EXPORT = 'fixture:reporting/exports@post';
const EXPORTS = 'fixture:reporting/exports@get';
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
    component: 'legacy-fixtures/cfml/modules/reporting.cfc',
    method: 'createExport',
    source: { path: 'legacy-fixtures/cfml/modules/reporting.cfc', lines: [10, 20] },
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

const UNITS: Record<string, readonly string[]> = {
  'people.person': ['tusers'],
  'identity.user_account': ['tusers'],
  'people.person_archive': ['synthetic.person_archive'],
  'timesheets.blackout': ['Program_N.blackout'],
  'timesheets.timesheet': ['Program_N.timesheet'],
  'reporting.export_job': ['synthetic.export_job'],
  'reporting.export_definition': ['synthetic.export_definition'],
  'reporting.session_tracking': ['tsessiontracking'],
  'content.content': ['tcontent'],
};

function ownershipOf(units: Record<string, readonly string[]>): OwnershipDoc {
  return {
    sourceSha: SHA,
    units: Object.entries(units).map(([unit, legacyTables]) => ({
      unit,
      owner: unit.startsWith('content.') ? 'strategies-content' : (unit.split('.')[0] as string),
      legacyTables,
    })),
    tables: Object.entries(units).map(([unit, [table]]) => ({
      table: table as string,
      owner: unit.split('.')[0] as string,
      targets: [{ unit, rowPredicate: null, ownedColumns: [] }],
    })),
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
      fixtureRoute(ARCHIVE, 'people', [write('people.person_archive'), write('timesheets.blackout')]),
      fixtureRoute(EXPORT, 'reporting', [write('reporting.export_job')]),
      fixtureRoute(EXPORTS, 'reporting'),
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
    tables: spec.tables ?? [],
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
        { id: 'grp:timesheets.blackout', units: ['timesheets.blackout'], writeEntries: [], hasCarryWrite: false },
        { id: 'grp:content.content', units: ['content.content'], writeEntries: [' Admin:CUsers.Update{type=2,action=update} '], hasCarryWrite: true },
        { id: 'grp:content.file', units: ['content.file'], writeEntries: [EDIT], hasCarryWrite: true },
      ],
    };
    expect(rosterGroupSet(seamOnly)).toEqual(['grp:content.content', 'grp:timesheets.blackout']);
  });

  it('derives kinds, units and states from the inventory', () => {
    const ctx = fixtureContext();
    const [v0001, v0002, v0003] = buildVersions(ctx, { available: true }) as [CutoverTable, CutoverTable, CutoverTable];
    expect(entryOf(v0002, ADD)).toMatchObject({
      kind: 'write',
      group: 'grp:identity.user_account',
      units: ['identity.user_account', 'people.person'],
      state: 'target',
      tableVersion: 'v0002',
    });
    expect(entryOf(v0002, IMAGE)).toMatchObject({ kind: 'legacy-write', group: null, units: ['content.content'], state: 'legacy' });
    expect(entryOf(v0002, EXPORTS)).toMatchObject({
      kind: 'read',
      units: ['reporting.export_definition', 'reporting.export_job', 'reporting.session_tracking'],
      state: 'legacy',
    });
    expect(entryOf(v0002, EDIT)).toMatchObject({ kind: 'read', units: ['content.content'], state: 'legacy' });
    expect(entryOf(v0001, JOB)).toMatchObject({ kind: 'job', units: ['content.content'], state: 'legacy' });
    expect(entryOf(v0002, JOB)?.state).toBe('target');
    expect(entryOf(v0003, ADD)).toMatchObject({ state: 'legacy', tableVersion: 'v0003' });
    expect(entryOf(v0003, EXPORT)).toMatchObject({ state: 'target', tableVersion: 'v0002' });
    expect(v0003.rollbackRefs[0]?.groups).toEqual(rosterGroupSet(ctx.groups));
    expect(entryOf(v0002, 'opt2:/opt2/admin/reporting/**')).toMatchObject({ kind: 'read', state: 'legacy' });
    expect(entryOf(v0002, 'opt2:/opt2/admin-actions/reporting/**')).toMatchObject({ kind: 'write', units: [], state: 'legacy' });
  });

  it.each([
    ['prevented', 'createExport', 'target'],
    ['unprevented', 'resumeExport', 'legacy'],
  ] as const)('keeps a group legacy only while its thread writer is %s', (_label, method, expected) => {
    const ctx = fixtureContext({ tables: [writer('synthetic.export_job', { method, trigger: 'thread' })] });
    const v0002 = buildVersions(ctx, { available: true })[1] as CutoverTable;
    expect(v0002.groupAuthority[groupOfUnit(ctx, 'reporting.export_job')]).toBe(expected);
    expect(entryOf(v0002, EXPORT)?.state).toBe(expected);
  });

  it('keeps a halted carry read on legacy', () => {
    const exceptions: ExceptionEntry[] = [{ id: 'EX-1', routeKey: 'fixture:reporting/exports@get', decision: 'preserve', status: 'halted' }];
    const ctx = fixtureContext({ units: { ...UNITS, 'reporting.session_tracking': ['synthetic.session_tracking'] }, exceptions });
    const v0002 = buildVersions(ctx, { available: true })[1] as CutoverTable;
    expect(entryOf(v0002, EXPORTS)).toMatchObject({ kind: 'read', state: 'legacy' });
  });

  it('names the uncarried fixture-backed group of a synthetic service when fixtures are unavailable', () => {
    const ctx = fixtureContext({ units: { ...UNITS, 'reporting.session_tracking': ['synthetic.session_tracking'] } });
    expect(() => buildVersions(ctx, { available: false })).toThrow(/static:\/v1\/reporting\/\*\*: fixture-backed units span groups/);
    const single = fixtureContext();
    const v0002 = buildVersions(single, { available: false })[1] as CutoverTable;
    expect(entryOf(v0002, 'static:/v1/reporting/**')).toMatchObject({
      kind: 'write',
      group: 'grp:reporting.export_definition',
      units: ['reporting.export_definition'],
      state: 'target',
    });
    expect(entryOf(v0002, 'static:/v1/timesheets/**')).toMatchObject({ group: 'grp:timesheets.timesheet', state: 'target' });
    expect(entryOf(v0002, 'static:/v1/finance/**')).toMatchObject({ group: null, units: [], state: 'target' });
    expect(v0002.groupAuthority['grp:reporting.export_definition']).toBe('target');
  });

  it('fails when a carry write entry is in no generated group', () => {
    const ctx = fixtureContext();
    const groups = { ...ctx.groups, groups: ctx.groups.groups.map((g) => ({ ...g, writeEntries: g.writeEntries.filter((k) => k !== ADD) })) };
    expect(() => buildVersions({ ...ctx, groups }, { available: true })).toThrow(`carry write entry ${ADD} is in 0 groups`);
  });

  it('fails on an owner the cut-over table cannot name', () => {
    expect(() => buildVersions(fixtureContext({ owner: 'split' }), { available: true })).toThrow(/owner split is not a cut-over owning service/);
  });

  it('never returns a version the validator rejects', () => {
    let error: unknown;
    try {
      buildVersions(fixtureContext({ withheld: [EXPORT] }), { available: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CutoverBuildError);
    expect((error as CutoverBuildError).message).toMatch(/^v0002 fails validation:\nwithheld-never-target fixture:reporting\/exports@post/);
    expect((error as CutoverBuildError).findings.map((finding) => finding.rule)).toContain('withheld-never-target');
  });

  it('returns no rollback reference when no group holds the roster', () => {
    const ctx = fixtureContext();
    const groups = { ...ctx.groups, groups: ctx.groups.groups.filter((g) => !rosterGroupSet(ctx.groups).includes(g.id)) };
    const units = ctx.ownership.units.filter((u) => groups.groups.some((g) => g.units.includes(u.unit)));
    const inventory = { ...ctx.inventory, controllers: [], routes: ctx.inventory.routes.filter((r) => r.routeKey !== ARCHIVE) };
    const trimmed = { ...ctx, groups, inventory, inventoryKeys: inventoryKeyFacts(inventory), ownership: { ...ctx.ownership, units } };
    expect(buildVersions(trimmed, { available: true })[2]?.rollbackRefs).toEqual([]);
  });
});

// ---- CLI ----

describe('main', () => {
  let dir: string;
  let paths: GatewayPaths;
  const noState = { OPT2_STATE_DIR: join(tmpdir(), 'opt2-build-versions-no-state') };

  beforeAll(async () => {
    dir = await tempDir();
    for (const file of ['schemaFile', 'variantsFile', 'groupsFile'] as const) {
      await copyFile(committed[file], join(dir, committed[file].slice(committed.cutoverDir.length + 1)));
    }
    paths = resolveGatewayPaths({ OPT2_CUTOVER_DIR: dir });
  });

  const run = async (argv: string[], env: Record<string, string> = noState) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(argv, { paths, env, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
    return { code, stdout, stderr };
  };
  const file = (id: string) => join(paths.versionsDir, `${id}.json`);

  it('reports missing version files as differences', async () => {
    const { code, stdout, stderr } = await run(['--fixtures', 'available']);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(VERSION_IDS.map((id) => `build-versions: ${file(id)} does not exist; run with --write`));
  });

  it('writes with --write (repeatable) and then reports no difference', async () => {
    const written = await run(['--write', '--write', '--fixtures', 'available']);
    expect(written).toEqual({ code: 0, stdout: VERSION_IDS.map((id) => `build-versions: wrote ${file(id)}`), stderr: [] });
    const ctx = await loadValidationContext(paths, 'ci');
    const built = buildVersions(ctx, { available: true });
    for (const table of built) expect(await readFile(file(table.tableVersion), 'utf8')).toBe(serialiseVersion(table));
    expect(await run([])).toEqual({ code: 0, stdout: VERSION_IDS.map((id) => `build-versions: ${file(id)} is up to date`), stderr: [] });
  });

  it('builds as fixtures.json says under --fixtures auto', async () => {
    const state = await tempDir();
    await writeFile(join(state, 'fixtures.json'), JSON.stringify({ available: false, reason: 'no CREATE SCHEMA' }));
    const { code, stdout, stderr } = await run(['--fixtures', 'auto'], { OPT2_STATE_DIR: state });
    expect(code).toBe(1);
    expect(stdout).toContain(`build-versions: ${file('v0001')} is up to date`);
    expect(stdout.some((line) => line.includes('"route": "static:/v1/finance/**"'))).toBe(true);
    expect(stderr).toEqual(['v0002', 'v0003'].map((id) => `build-versions: ${file(id)} differs from the build; run with --write`));
  });

  it('prints a line diff when a version differs', async () => {
    const current = await readFile(file('v0002'), 'utf8');
    await writeFile(file('v0002'), current.replace(`"createdAt": "${VERSION_CREATED_AT.v0002}"`, '"createdAt": "2020-01-01T00:00:00.000Z"'));
    const { code, stdout } = await run([]);
    expect(code).toBe(1);
    expect(stdout).toContain('-  "createdAt": "2020-01-01T00:00:00.000Z",');
    expect(stdout).toContain(`+  "createdAt": "${VERSION_CREATED_AT.v0002}",`);
    await writeFile(file('v0002'), current);
  });

  it.each([[['--check']], [['--fixtures']], [['--fixtures', 'maybe']], [['--fixtures', 'auto', '--fixtures', 'auto']]])(
    'exits 2 on usage error %j',
    async (argv) => {
      const { code, stderr } = await run(argv);
      expect(code).toBe(2);
      expect(stderr[0]).toMatch(/^build-versions: /);
      expect(stderr[0]).toMatch(/usage: build-versions\.ts/);
    },
  );

  it('reports an unreadable fixture status and an input of another commit with exit 1', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.opt2', 'state'), { recursive: true });
    await writeFile(join(home, '.opt2', 'state', 'fixtures.json'), JSON.stringify({ available: 'yes' }));
    expect(await run([], { HOME: home })).toMatchObject({
      code: 1,
      stderr: [`build-versions: ${join(home, '.opt2', 'state', 'fixtures.json')}: available must be true or false`],
    });
    const other = join(dir, 'other-pin.json');
    const pin = JSON.parse(await readFile(committed.exceptionsListFile, 'utf8')) as { sourceSha: string };
    await writeFile(other, JSON.stringify({ ...pin, sourceSha: '0'.repeat(40) }));
    const stderr: string[] = [];
    const code = await main(['--fixtures', 'available'], {
      paths: { ...paths, exceptionsListFile: other },
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
    });
    expect({ code, stderr }).toEqual({
      code: 1,
      stderr: [`build-versions: ${other} does not match its cut-over schema: /sourceSha must equal the pinned sha ${SHA}`],
    });
  });
});

describe('resolveFixtures', () => {
  it('takes explicit modes as given and infers auto from the committed v0002, else available', async () => {
    const empty = resolveGatewayPaths({ OPT2_CUTOVER_DIR: await tempDir() });
    const env = { OPT2_STATE_DIR: join(tmpdir(), 'opt2-build-versions-no-state') };
    expect(await resolveFixtures('unavailable', committed, env)).toBe(false);
    expect(await resolveFixtures('available', committed, env)).toBe(true);
    expect(await resolveFixtures('auto', empty, env)).toBe(true);

    const dir = await tempDir();
    await copyFile(committed.schemaFile, join(dir, 'cutover-table.schema.json'));
    await mkdir(join(dir, 'versions'));
    const paths = resolveGatewayPaths({ OPT2_CUTOVER_DIR: dir });
    const v0002 = buildVersions(await loadValidationContext(committed, 'ci'), { available: false })[1] as CutoverTable;
    await writeFile(join(paths.versionsDir, 'v0002.json'), serialiseVersion(v0002));
    expect(await resolveFixtures('auto', paths, env)).toBe(false);
    await writeFile(join(paths.versionsDir, 'v0002.json'), '{}');
    await expect(resolveFixtures('auto', paths, env)).rejects.toThrow(/does not match its cut-over schema/);
  });
});
