import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GENERATED_BY,
  buildGroups,
  carryWriteEntries,
  createWriteClosure,
  legacyWriteExceptionKeys,
  lineDiff,
  loadBuildGroupsInput,
  main,
  serialiseGroups,
  type BuildGroupsInput,
} from '../../src/cutover/build-groups.js';
import { loadGroups } from '../../src/cutover/loader.js';
import { resolveGatewayPaths, type GatewayPaths } from '../../src/cutover/paths.js';
import type {
  Disposition,
  ExceptionEntry,
  GroupsFile,
  InventoryActionVariant,
  InventoryDoc,
  InventoryJobStep,
  InventoryWrite,
  InventoryWriter,
  OwnershipDoc,
  OwnershipTable,
} from '../../src/cutover/types.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const LOGIN = 'admin:clogin.login';
const UPGRADE_SOURCE = { path: 'core/mura/user/userUtility.cfc', lines: [167, 173] as const };
const committed = resolveGatewayPaths({});

// ---- Fixture builders ----

function write(unit: string, fields: Partial<InventoryWrite> = {}): InventoryWrite {
  return {
    unit,
    legacyTable: null,
    op: 'update',
    via: [],
    source: { path: 'core/mura/user/userDAO.cfc', lines: [1, 1] },
    condition: null,
    override: null,
    ...fields,
  };
}

type WriteSpec = string | InventoryWrite;
const writes = (specs: readonly WriteSpec[]): InventoryWrite[] => specs.map((s) => (typeof s === 'string' ? write(s) : s));

function variant(routeKey: string, specs: readonly WriteSpec[], disposition: Disposition = 'carry'): InventoryActionVariant {
  return {
    id: `ctl:${routeKey}`,
    source: { path: 'admin/core/controllers/cusers.cfc', lines: [1, 2] },
    owningService: 'people',
    disposition,
    writeSet: writes(specs),
    conditionalWrites: [],
    routeKey,
    predicate: null,
    sessionEffects: 'none',
    csrfValidation: 'none',
    csrfContext: null,
    responseMode: 'redirect',
    contentType: null,
  };
}

function step(name: string, specs: readonly WriteSpec[], disposition: Disposition = 'carry'): InventoryJobStep {
  return {
    id: `job:sitemonitor:${name}`,
    source: { path: 'core/mura/content/contentServer.cfc', lines: [669, 747] },
    owningService: 'strategies-content',
    disposition,
    writeSet: writes(specs),
    conditionalWrites: [],
    order: 1,
    step: name,
  };
}

function writer(table: string, fields: Partial<InventoryWriter> = {}): { table: string; writer: InventoryWriter } {
  return {
    table,
    writer: {
      component: 'core/mura/user/userDAO.cfc',
      method: 'update',
      source: { path: 'core/mura/user/userDAO.cfc', lines: [1, 1] },
      op: 'update',
      routeKeys: [],
      keyScope: ['userid'],
      trigger: 'request',
      sessionEffects: 'none',
      condition: null,
      override: null,
      ...fields,
    },
  };
}

interface FixtureSpec {
  variants?: InventoryActionVariant[];
  routes?: InventoryDoc['routes'];
  frontEnd?: InventoryDoc['frontEnd'];
  steps?: InventoryJobStep[];
  writers?: Array<{ table: string; writer: InventoryWriter }>;
  exceptions?: ExceptionEntry[];
}

const USERS_TABLE: OwnershipTable = {
  table: 'tusers',
  owner: 'split',
  targets: [
    { unit: 'identity.group_account', rowPredicate: 'Type = 1', ownedColumns: [] },
    { unit: 'identity.user_account', rowPredicate: 'Type = 2', ownedColumns: [] },
    { unit: 'identity.credential', rowPredicate: 'Type = 2', ownedColumns: [] },
    { unit: 'people.person', rowPredicate: 'Type = 2', ownedColumns: [] },
  ],
};

const OWNERSHIP: OwnershipDoc = {
  sourceSha: SHA,
  units: [
    'content.content',
    'content.file',
    'content.feed',
    'content.changeset',
    'identity.credential',
    'identity.group_account',
    'identity.login_state',
    'identity.membership',
    'identity.user_account',
    'people.person',
    'people.person_archive',
    'timesheets.blackout',
  ].map((unit) => ({ unit, owner: unit.split('.')[0] as string, legacyTables: [] })),
  tables: [
    USERS_TABLE,
    { table: 'tfiles', owner: 'strategies-content', targets: [{ unit: 'content.file', rowPredicate: null, ownedColumns: [] }] },
    { table: 'tusersmemb', owner: 'identity', targets: [{ unit: 'identity.membership', rowPredicate: null, ownedColumns: [] }] },
  ],
};

function fixture(spec: FixtureSpec, ownership: OwnershipDoc = OWNERSHIP): BuildGroupsInput {
  const byTable = new Map<string, InventoryWriter[]>();
  for (const { table, writer: w } of spec.writers ?? []) byTable.set(table, [...(byTable.get(table) ?? []), w]);
  const inventory: InventoryDoc = {
    sourceSha: SHA,
    controllers: [
      {
        id: 'ctl:cusers',
        circuit: 'cusers',
        isBase: false,
        owningService: 'people',
        actions: [{ id: 'act:cusers.update', action: 'update', variants: spec.variants ?? [] }],
      },
    ],
    routes: spec.routes ?? [],
    frontEnd: spec.frontEnd ?? [],
    scheduledJobs: [
      {
        id: 'job:sitemonitor',
        source: { path: 'core/mura/content/contentServer.cfc', lines: [669, 747] },
        owningService: 'programs-sites',
        disposition: 'carry',
        routeKey: 'sitemonitor:run',
        steps: spec.steps ?? [],
      },
    ],
    tables: [...byTable].map(([table, writers]) => ({
      id: `tbl:${table}`,
      source: { path: 'core/setup/db/mssql.sql', lines: [1, 1] },
      owningService: null,
      disposition: 'carry',
      table,
      schema: 'dbo',
      hasPrimaryKey: true,
      writers,
    })),
  };
  return {
    sourceSha: SHA,
    inventory,
    ownership,
    exceptions: { sourceSha: SHA, entries: spec.exceptions ?? [] },
    inputs: { inventorySha256: 'a'.repeat(64), tableOwnershipSha256: 'b'.repeat(64) },
  };
}

const groupOf = (file: GroupsFile, unit: string) => file.groups.find((group) => group.units.includes(unit));

// ---- Committed inputs ----

describe('committed inputs', () => {
  let input: BuildGroupsInput;
  let built: GroupsFile;

  beforeAll(async () => {
    input = await loadBuildGroupsInput(committed);
    built = buildGroups(input);
  });

  it('builds byte-identical output on every run', async () => {
    const again = buildGroups(await loadBuildGroupsInput(committed));
    expect(serialiseGroups(again)).toBe(serialiseGroups(built));
  });

  it('records the pin and the SHA-256 of the committed inventory and ownership bytes', () => {
    const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    expect(built.sourceSha).toBe(SHA);
    expect(built.generatedBy).toBe(GENERATED_BY);
    expect(built.inputs).toEqual({
      inventorySha256: hash(committed.inventoryFile),
      tableOwnershipSha256: hash(committed.tableOwnershipFile),
    });
  });

  it('puts every ownership unit in exactly one group, named by its smallest unit', () => {
    const units = built.groups.flatMap((group) => group.units);
    expect([...units].sort()).toEqual(input.ownership.units.map((unit) => unit.unit).sort());
    expect(new Set(units).size).toBe(units.length);
    for (const group of built.groups) {
      expect(group.id).toBe(`grp:${[...group.units].sort()[0]}`);
      expect(group.units).toEqual([...group.units].sort());
      expect(group.writeEntries).toEqual([...group.writeEntries].sort());
      expect(group.hasCarryWrite).toBe(group.writeEntries.length > 0);
    }
    expect(built.groups.map((group) => group.id)).toEqual(built.groups.map((group) => group.id).sort());
  });

  it('lists each carry write entry once and leaves held-back keys out', () => {
    const keys = built.groups.flatMap((group) => group.writeEntries);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((key) => key === LOGIN)).toHaveLength(1);
    for (const held of legacyWriteExceptionKeys(input.exceptions)) expect(keys).not.toContain(held);
    expect(keys).not.toContain('sitemonitor:run');
    expect(keys).toContain('admin:cusers.update{type=2,action=add}');
    expect(keys).not.toContain('admin:cusers.update{type=2,action=delete}');
  });

  it('passes the groups.json schema the loader applies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'build-groups-schema-'));
    try {
      await copyFile(committed.schemaFile, join(dir, 'cutover-table.schema.json'));
      await writeFile(join(dir, 'groups.json'), serialiseGroups(built));
      const paths = resolveGatewayPaths({ OPT2_CUTOVER_DIR: dir });
      expect(await loadGroups(paths)).toEqual(built);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(existsSync(committed.groupsFile))('committed groups.json', () => {
  it('equals the build, so the default CLI mode reports no difference', async () => {
    const out: string[] = [];
    expect(await main([], { paths: committed, stdout: (text) => out.push(text), stderr: (text) => out.push(text) })).toBe(0);
    expect(out).toEqual([`build-groups: ${committed.groupsFile} is up to date`]);
  });
});

// ---- Rules on fixture inventories ----

describe('buildGroups', () => {
  it('joins every unit one carry entry point writes, keyed in canonical form', () => {
    const built = buildGroups(fixture({ variants: [variant('ADMIN:cusers.update{type=2,action=add} ', ['people.person', 'identity.user_account'])] }));
    expect(groupOf(built, 'people.person')).toEqual({
      id: 'grp:identity.user_account',
      units: ['identity.user_account', 'people.person'],
      writeEntries: ['admin:cusers.update{type=2,action=add}'],
      hasCarryWrite: true,
    });
    expect(groupOf(built, 'content.content')).toEqual({
      id: 'grp:content.content',
      units: ['content.content'],
      writeEntries: [],
      hasCarryWrite: false,
    });
    expect(built.groups).toHaveLength(OWNERSHIP.units.length - 1);
  });

  it('merges groups transitively and lists every entry that writes any of their units', () => {
    const built = buildGroups(
      fixture({
        variants: [
          variant('admin:cusers.update{type=1}', ['identity.group_account', 'identity.membership']),
          variant('admin:cusers.update{type=2,action=update}', ['identity.membership', 'people.person']),
          variant('admin:cusers.addtogroup', ['identity.membership']),
        ],
      }),
    );
    expect(groupOf(built, 'people.person')).toMatchObject({
      id: 'grp:identity.group_account',
      units: ['identity.group_account', 'identity.membership', 'people.person'],
      writeEntries: ['admin:cusers.addtogroup', 'admin:cusers.update{type=1}', 'admin:cusers.update{type=2,action=update}'],
    });
  });

  it.each([
    ['a halted variant', { id: 'EX-1', routeKey: 'admin:carch.update{upload=image}', decision: 'preserve', status: 'halted' }],
    ['an open fix named in appliesTo', { id: 'EX-2', routeKey: 'reload:application', appliesTo: ['ADMIN:carch.update{upload=image}'], decision: 'fix', status: 'open' }],
  ] satisfies Array<[string, ExceptionEntry]>)('never joins the units of %s', (_label, exception) => {
    const built = buildGroups(
      fixture({ variants: [variant('admin:carch.update{upload=image}', ['content.content', 'content.file'])], exceptions: [exception] }),
    );
    expect(groupOf(built, 'content.file')?.units).toEqual(['content.file']);
    expect(built.groups.flatMap((group) => group.writeEntries)).toEqual([]);
  });

  it.each([
    ['an accepted fix', { id: 'EX-3', routeKey: 'admin:carch.update', decision: 'fix', status: 'accepted' }],
    ['an open preserve', { id: 'EX-4', routeKey: 'admin:carch.update', decision: 'preserve', status: 'open' }],
  ] satisfies Array<[string, ExceptionEntry]>)('keeps the entry of %s', (_label, exception) => {
    const built = buildGroups(
      fixture({ variants: [variant('admin:carch.update', ['content.content', 'content.file'])], exceptions: [exception] }),
    );
    expect(groupOf(built, 'content.file')?.writeEntries).toEqual(['admin:carch.update']);
  });

  it.each(['legacy-served', 'decision', 'retired'] satisfies Disposition[])('never joins the units of a %s writer', (disposition) => {
    const built = buildGroups(fixture({ variants: [variant('admin:cusers.update{type=2,action=delete}', ['people.person', 'identity.user_account'], disposition)] }));
    expect(groupOf(built, 'people.person')?.units).toEqual(['people.person']);
  });

  it('holds back a key that a non-carry item also bears', () => {
    const key = 'api:processasyncobject{saveform}';
    const built = buildGroups(
      fixture({
        variants: [variant(key, ['content.content', 'content.feed'])],
        frontEnd: [{ ...variant(key, ['content.content'], 'decision'), id: 'fe:processasyncobject{saveform}' }],
      }),
    );
    expect(groupOf(built, 'content.content')?.units).toEqual(['content.content']);
  });

  it('does not join identity.credential through the legacy-hash upgrade at login', () => {
    const upgradeViaDao = write('identity.credential', {
      legacyTable: 'tusers',
      via: ['clogin.login', 'loginManager.login', 'userUtility.lookupByCredentials', 'userDAO.savePassword'],
      source: { path: 'core/mura/user/userDAO.cfc', lines: [698, 698] },
    });
    const upgradeOverride = write('identity.credential', { legacyTable: 'tusers', via: ['userUtility.lookupByCredentials'], source: UPGRADE_SOURCE });
    const upgradeWriter = writer('tusers', {
      component: UPGRADE_SOURCE.path,
      method: 'lookupByCredentials',
      source: UPGRADE_SOURCE,
      routeKeys: [LOGIN, 'rest:oauth'],
      keyScope: ['table'],
    });
    const spec: FixtureSpec = {
      variants: [variant(LOGIN, [upgradeViaDao, 'identity.login_state'])],
      routes: [{ ...variant('rest:oauth', [upgradeOverride, 'identity.group_account']), kind: 'oauth', family: 'rest' }],
      writers: [upgradeWriter],
    };
    const built = buildGroups(fixture(spec));
    expect(groupOf(built, 'identity.credential')).toMatchObject({ units: ['identity.credential'], hasCarryWrite: false });
    expect(groupOf(built, 'identity.login_state')?.writeEntries).toEqual([LOGIN]);
    expect(groupOf(built, 'identity.group_account')?.writeEntries).toEqual(['rest:oauth']);

    // Only the inventoried upgrade writer is excluded: other credential writes of the same key still join.
    const withRoster = buildGroups(fixture({ ...spec, variants: [variant(LOGIN, [upgradeViaDao, 'identity.login_state', 'identity.credential'])] }));
    expect(groupOf(withRoster, 'identity.credential')?.units).toEqual(['identity.credential', 'identity.login_state']);
    const unrecorded = buildGroups(fixture({ ...spec, writers: [] }));
    expect(groupOf(unrecorded, 'identity.credential')?.writeEntries).toEqual([LOGIN, 'rest:oauth']);
  });

  it('joins site-monitor units per carried step only, and never lists the job key', () => {
    const built = buildGroups(
      fixture({
        steps: [
          step('changeset-publish', ['content.changeset', 'content.content']),
          step('feed-import', ['content.feed', 'content.file']),
          step('cluster-cleanup', ['content.content', 'content.feed'], 'decision'),
        ],
        routes: [{ ...variant('sitemonitor:run', ['content.content', 'content.feed']), kind: 'job', family: 'sitemonitor' }],
      }),
    );
    expect(groupOf(built, 'content.content')).toMatchObject({ units: ['content.changeset', 'content.content'], writeEntries: [] });
    expect(groupOf(built, 'content.feed')).toMatchObject({ units: ['content.feed', 'content.file'], writeEntries: [] });
  });

  it('maps file-store writes to the tfiles units and drops decision-list tables', () => {
    const built = buildGroups(fixture({ variants: [variant('admin:carch.cropimage', ['file-store', 'content.content', 'legacy:tcontenteventreminders'])] }));
    expect(groupOf(built, 'content.file')).toMatchObject({ units: ['content.content', 'content.file'], writeEntries: ['admin:carch.cropimage'] });
  });

  it.each([
    ['an unknown unit', 'content.nope', OWNERSHIP],
    ['the file store without a tfiles mapping', 'file-store', { ...OWNERSHIP, tables: [USERS_TABLE] }],
  ])('rejects %s', (_label, unit, ownership) => {
    expect(() => buildGroups(fixture({ variants: [variant('admin:carch.update', [unit])] }, ownership))).toThrow(/maps to no unit/);
  });

  it('rejects a carry write without a route key and ignores one that writes nothing', () => {
    const family = (specs: WriteSpec[]) => ({ ...variant('x', specs), id: 'rte:/_api/json/v1', routeKey: null, kind: 'api-family' as const, family: 'api' as const });
    expect(() => buildGroups(fixture({ routes: [family(['content.content'])] }))).toThrow(/rte:\/_api\/json\/v1: carry item without a route key/);
    expect(buildGroups(fixture({ routes: [family([])] })).groups.every((group) => !group.hasCarryWrite)).toBe(true);
  });

  it('falls back to tables[].writers[] when an item carries no writeSet, narrowed by row predicate', () => {
    const bare = { ...variant('Admin:cusers.update{type=1}', []), writeSet: undefined } as unknown as InventoryActionVariant;
    const input = fixture({
      variants: [bare],
      writers: [
        writer('TUsers', { routeKeys: ['admin:cusers.update{type=1}'], condition: 'Type = 1' }),
        writer('tusersmemb', { routeKeys: ['admin:cusers.update{type=1}'] }),
        writer('tusers', { routeKeys: ['admin:other'], condition: 'Type = 2' }),
      ],
    });
    const closure = createWriteClosure(input.inventory, input.ownership);
    expect(closure(bare)).toEqual(['identity.group_account', 'identity.membership']);
    expect(closure({ routeKey: 'admin:other' })).toEqual(['identity.credential', 'identity.user_account', 'people.person']);
    expect(closure({ routeKey: null })).toEqual([]);
    expect(carryWriteEntries(input, closure)).toEqual(new Map([['admin:cusers.update{type=1}', ['identity.group_account', 'identity.membership']]]));
  });

  it('applies the upgrade exclusion to the writers fallback too', () => {
    const input = fixture({
      writers: [
        writer('tusers', { component: UPGRADE_SOURCE.path, method: 'lookupByCredentials', source: UPGRADE_SOURCE, routeKeys: [LOGIN] }),
        writer('tusers', { routeKeys: [LOGIN], condition: 'Type = 1' }),
      ],
    });
    const closure = createWriteClosure(input.inventory, input.ownership);
    expect(closure({ routeKey: LOGIN })).toEqual(['identity.group_account', 'identity.user_account', 'people.person']);
  });
});

// ---- CLI ----

describe('main', () => {
  let dir: string;
  let paths: GatewayPaths;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'build-groups-cli-'));
    paths = resolveGatewayPaths({ OPT2_CUTOVER_DIR: dir });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (argv: string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(argv, { paths, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
    return { code, stdout, stderr };
  };

  it('reports a missing groups.json as a difference', async () => {
    const { code, stdout, stderr } = await run([]);
    expect(code).toBe(1);
    expect(stdout[0]).toBe('@@ -1 +1 @@');
    expect(stdout[1]).toBe('+{');
    expect(stderr).toEqual([`build-groups: ${paths.groupsFile} does not exist; run with --write`]);
  });

  it('writes with --write (repeatable) and then reports no difference', async () => {
    expect((await run(['--write', '--write'])).code).toBe(0);
    expect(await readFile(paths.groupsFile, 'utf8')).toBe(serialiseGroups(buildGroups(await loadBuildGroupsInput(paths))));
    expect(await run([])).toEqual({ code: 0, stdout: [`build-groups: ${paths.groupsFile} is up to date`], stderr: [] });
  });

  it('prints a line diff and exits 1 when groups.json differs', async () => {
    const current = await readFile(paths.groupsFile, 'utf8');
    await writeFile(paths.groupsFile, current.replace('"generatedBy": "gateway/src/cutover/build-groups.ts"', '"generatedBy": "hand"'));
    const { code, stdout, stderr } = await run([]);
    expect(code).toBe(1);
    expect(stdout).toEqual(['@@ -3 +3 @@', '-  "generatedBy": "hand",', `+  "generatedBy": "${GENERATED_BY}",`]);
    expect(stderr).toEqual([`build-groups: ${paths.groupsFile} differs from the build; run with --write`]);
  });

  it.each([[['--check']], [['--write', 'extra']]])('exits 2 on usage error %j', async (argv) => {
    const { code, stderr } = await run(argv);
    expect(code).toBe(2);
    expect(stderr[0]).toMatch(/^build-groups: unknown argument/);
  });

  it.each(['inventoryFile', 'tableOwnershipFile', 'exceptionsListFile'] as const)(
    'reports a %s of another commit and exits 1',
    async (key) => {
      const file = join(dir, `other-commit-${basename(committed[key])}`);
      const doc = JSON.parse(await readFile(committed[key], 'utf8')) as { sourceSha: string };
      await writeFile(file, JSON.stringify({ ...doc, sourceSha: '0'.repeat(40) }));
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await main([], { paths: { ...paths, [key]: file }, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
      expect({ code, stdout, stderr }).toEqual({
        code: 1,
        stdout: [],
        stderr: [`build-groups: ${file} does not match its cut-over schema: /sourceSha must equal the pinned sha ${SHA}`],
      });
    },
  );

  it('propagates read errors other than a missing file', async () => {
    await expect(main([], { paths: { ...paths, groupsFile: dir }, stdout: () => undefined, stderr: () => undefined })).rejects.toThrow(/EISDIR/);
  });
});

describe('lineDiff', () => {
  it('emits one hunk header per run of changes', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nx\nc\nd\n')).toEqual(['@@ -2 +2 @@', '-b', '+x', '@@ -4 +4 @@', '+d']);
    expect(lineDiff('same\n', 'same\n')).toEqual([]);
  });
});
