import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchRouteKey, routeKeyForRequest } from '@opt2/platform/legacy-compat';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CutoverSchemaError,
  buildRoutingIndex,
  listVersions,
  loadGroups,
  loadInventoryFacts,
  loadVariants,
  loadVersion,
} from '../../src/cutover/loader.js';
import { resolveGatewayPaths, type GatewayPaths } from '../../src/cutover/paths.js';
import type {
  Authority,
  CutoverEntry,
  CutoverTable,
  GroupsFile,
  InventoryDoc,
  InventoryFacts,
  VariantsFile,
} from '../../src/cutover/types.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const LOGIN_GROUP = 'grp:identity.credential';
const ROSTER_GROUP = 'grp:identity.user_account';
const IDLE_GROUP = 'grp:content.trash';
const ROSTER_ADD = 'admin:cusers.update{type=2,action=add}';

const committed = resolveGatewayPaths({});

const GROUPS: GroupsFile = {
  sourceSha: SHA,
  generatedBy: 'gateway/src/cutover/build-groups.ts',
  inputs: { inventorySha256: 'a'.repeat(64), tableOwnershipSha256: 'b'.repeat(64) },
  groups: [
    { id: IDLE_GROUP, units: ['content.trash'], writeEntries: [], hasCarryWrite: false },
    {
      id: LOGIN_GROUP,
      units: ['identity.credential', 'identity.login_state'],
      writeEntries: ['admin:clogin.login'],
      hasCarryWrite: true,
    },
    {
      id: ROSTER_GROUP,
      units: ['identity.user_account', 'people.person'],
      writeEntries: [ROSTER_ADD, 'admin:cusers.update{type=2,action=update}'],
      hasCarryWrite: true,
    },
  ],
};

function entry(fields: Pick<CutoverEntry, 'route' | 'tableVersion' | 'state' | 'kind' | 'units'> & Partial<CutoverEntry>): CutoverEntry {
  return { owningService: 'identity', group: null, disposition: 'carry', ...fields };
}

/** A fixture version whose login and roster groups have the given authority. */
function version(tableVersion: string, previous: string | null, login: Authority, roster: Authority): CutoverTable {
  return {
    tableVersion,
    previous,
    sourceSha: SHA,
    createdAt: '2026-06-30T00:00:00.000Z',
    groupAuthority: { [IDLE_GROUP]: 'legacy', [LOGIN_GROUP]: login, [ROSTER_GROUP]: roster },
    rollbackRefs:
      tableVersion === 'v0003'
        ? [
            {
              groups: [ROSTER_GROUP],
              rollbackSet: [ROSTER_GROUP],
              report: 'opt2/reports/reconciliation/rollback-before.json',
              evidence: ['opt2/reports/rollback-rehearsal.md'],
            },
          ]
        : [],
    entries: [
      entry({ route: 'admin:clogin.login', tableVersion, state: login, kind: 'write', units: ['identity.login_state'], group: LOGIN_GROUP }),
      entry({ route: ROSTER_ADD, tableVersion, state: roster, kind: 'write', units: ['people.person'], group: ROSTER_GROUP, owningService: 'people' }),
      entry({ route: 'admin:cusers.listusers', tableVersion, state: 'legacy', kind: 'read', units: ['people.person'], owningService: 'people' }),
    ],
  };
}

const VERSIONS: Record<string, CutoverTable> = {
  v0001: version('v0001', null, 'legacy', 'legacy'),
  v0002: version('v0002', 'v0001', 'target', 'target'),
  v0003: version('v0003', 'v0002', 'target', 'legacy'),
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

let dir: string;
let paths: GatewayPaths;
let variants: VariantsFile;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opt2-loader-'));
  paths = resolveGatewayPaths({ OPT2_CUTOVER_DIR: join(dir, 'cutover') });
  await mkdir(paths.versionsDir, { recursive: true });
  await copyFile(committed.schemaFile, paths.schemaFile);
  await copyFile(committed.variantsFile, paths.variantsFile);
  await writeFile(paths.groupsFile, json(GROUPS));
  for (const [id, table] of Object.entries(VERSIONS)) await writeFile(join(paths.versionsDir, `${id}.json`), json(table));
  for (const noise of ['README.md', 'v12.json', 'v0004.json.bak']) await writeFile(join(paths.versionsDir, noise), '{}');
  variants = await loadVariants(paths);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('version files', () => {
  it('lists only vNNNN.json files, sorted, without the extension', async () => {
    expect(await listVersions(paths)).toEqual(['v0001', 'v0002', 'v0003']);
  });

  it.each(Object.keys(VERSIONS))('loads %s as written', async (id) => {
    expect(await loadVersion(paths, id)).toEqual(VERSIONS[id]);
  });

  it('lets ENOENT propagate for a missing version', async () => {
    await expect(loadVersion(paths, 'v0099')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recompiles a schema file that failed to load once it exists', async () => {
    const late = { versionsDir: paths.versionsDir, schemaFile: join(dir, 'late.schema.json') };
    await expect(loadVersion(late, 'v0001')).rejects.toMatchObject({ code: 'ENOENT' });
    await copyFile(committed.schemaFile, late.schemaFile);
    expect((await loadVersion(late, 'v0001')).tableVersion).toBe('v0001');
  });
});

describe('schema failures', () => {
  const badVersion = { ...(VERSIONS.v0002 as CutoverTable), tableVersion: 'v0009' };
  const cases: Array<[string, unknown, (file: string) => Promise<unknown>, string]> = [
    [
      'a version entry with state "maybe"',
      { ...badVersion, entries: badVersion.entries.map((e, i) => (i === 0 ? { ...e, state: 'maybe' } : e)) },
      (file) => loadVersion({ ...paths, versionsDir: join(file, '..') }, 'v0009'),
      '/entries/0/state',
    ],
    [
      'a variant condition with a non-string value',
      { sourceSha: SHA, variants: [{ route: ROSTER_ADD, variant: 'type=2', when: [{ param: 'type', equals: 2 }] }] },
      (file) => loadVariants({ ...paths, variantsFile: file }),
      '/variants/0/when/0',
    ],
    [
      'a group id outside the schema pattern',
      { ...GROUPS, groups: [{ ...GROUPS.groups[0], id: 'grp:Bad' }] },
      (file) => loadGroups({ ...paths, groupsFile: file }),
      '/groups/0/id',
    ],
  ];

  it.each(cases)('rejects %s with CutoverSchemaError', async (_label, content, load, instancePath) => {
    const caseDir = await mkdtemp(join(dir, 'bad-'));
    const file = join(caseDir, 'v0009.json');
    await writeFile(file, json(content));
    const error = await load(file).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CutoverSchemaError);
    const schemaError = error as CutoverSchemaError;
    expect(schemaError.name).toBe('CutoverSchemaError');
    expect(schemaError.file).toBe(file);
    expect(schemaError.errors.length).toBeGreaterThan(0);
    expect(schemaError.message).toContain(file);
    expect(schemaError.message).toContain(instancePath);
  });
});

describe('variants and groups', () => {
  it('loads the committed variants.json beside a schema copy compiled from another path', async () => {
    const loaded = await loadVariants(committed);
    expect(loaded).toEqual(variants);
    expect(loaded.variants.length).toBeGreaterThan(0);
  });

  it('loads groups.json as written', async () => {
    expect(await loadGroups(paths)).toEqual(GROUPS);
  });
});

describe('buildRoutingIndex', () => {
  const index = (id: string, groups: GroupsFile = GROUPS) => buildRoutingIndex(VERSIONS[id] as CutoverTable, variants, groups);

  it('resolves an entry through normalisation, with no variant-to-base fallback', () => {
    const routing = index('v0002');
    expect(routing.entryFor('ADMIN:CUSERS.UPDATE{type=2,action=add}')?.route).toBe(ROSTER_ADD);
    expect(routing.entryFor('admin:cusers.update')).toBeUndefined();
    expect(routing.table).toBe(VERSIONS.v0002);
  });

  it('matches a live request through matchKeys', () => {
    const routing = index('v0002');
    const result = routeKeyForRequest(
      { method: 'POST', path: '/admin/index.cfm', query: {}, form: { muraAction: 'cUsers.update', type: '2', action: 'Add' }, headers: {} },
      { variants: variants.variants },
    );
    const match = matchRouteKey(result, routing.matchKeys);
    expect(match).toBe(ROSTER_ADD);
    expect(routing.entryFor(match ?? '')?.state).toBe('target');
    expect(Object.isFrozen(routing.matchKeys)).toBe(true);
  });

  it.each([
    ['v0001', 'identity.login_state', 'legacy'],
    ['v0002', 'identity.login_state', 'target'],
    ['v0003', 'people.person', 'legacy'],
    ['v0003', 'identity.credential', 'target'],
    ['v0002', 'content.trash', 'legacy'],
    ['v0002', 'nowhere.unit', 'legacy'],
  ] as const)('in %s, unit %s is %s-authoritative', (id, unit, authority) => {
    expect(index(id).unitAuthority(unit)).toBe(authority);
  });

  it('reports the group of write entries only', () => {
    const routing = index('v0002');
    expect(routing.groupOf('admin:clogin.login')).toBe(LOGIN_GROUP);
    expect(routing.groupOf('admin:cusers.listusers')).toBeUndefined();
    expect(routing.groupOf('admin:unknown.route')).toBeUndefined();
  });

  it.each([
    [ROSTER_GROUP, 'target'],
    ['grp:unknown.group', 'legacy'],
    ['constructor', 'legacy'],
  ] as const)('gives group %s authority %s in v0002', (group, authority) => {
    expect(index('v0002').groupAuthority(group)).toBe(authority);
  });

  it.each([
    ['v0001', 'legacy'],
    ['v0002', 'target'],
    ['v0003', 'target'],
  ] as const)('takes the login group authority of %s as %s', (id, authority) => {
    expect(index(id).loginGroupAuthority()).toBe(authority);
  });

  it('is legacy-primary when no group writes the login route', () => {
    const groups = { ...GROUPS, groups: GROUPS.groups.filter((group) => group.id !== LOGIN_GROUP) };
    expect(index('v0002', groups).loginGroupAuthority()).toBe('legacy');
  });
});

describe('loadInventoryFacts', () => {
  const inventory = JSON.parse(readFileSync(committed.inventoryFile, 'utf8')) as InventoryDoc;
  const writersOf = (key: string) => inventory.tables.flatMap((table) => table.writers).filter((w) => w.routeKeys.includes(key));
  let facts: InventoryFacts;

  beforeAll(async () => {
    facts = await loadInventoryFacts(committed);
  });

  it('carries the bypassed CSRF check and JSON response of carch.approvalaction', () => {
    expect(facts.get('ADMIN:CARCH.APPROVALACTION')).toMatchObject({
      route: 'admin:carch.approvalaction',
      csrfValidation: 'bypassed',
      csrfContext: 'approvalaction',
      responseMode: 'json',
      contentType: 'application/json',
    });
  });

  it('unions the writer key scopes of the roster edit variant', () => {
    const key = 'admin:cusers.update{type=2,action=update}';
    const expected = [...new Set(writersOf(key).flatMap((w) => w.keyScope))].sort();
    const scope = facts.get(key)?.keyScope ?? [];
    expect(scope.length).toBeGreaterThan(0);
    expect(scope).toEqual(expected);
  });

  it('defaults to no CSRF check and omits admin-only facts for non-admin routes', () => {
    const login = facts.get('api:login');
    expect(login?.csrfValidation).toBe('none');
    expect(login).not.toHaveProperty('csrfContext');
    expect(login).not.toHaveProperty('responseMode');
  });

  it("includes an entry point's own session effect", () => {
    expect(facts.get('admin:clogin.logout')?.sessionEffects).toContain('logout');
  });

  it('merges the write sets of every item carrying a key, deduplicated and sorted', () => {
    const key = 'api:processasyncobject{saveform}';
    const units = [...inventory.routes, ...inventory.frontEnd]
      .filter((item) => item.routeKey === key)
      .flatMap((item) => item.writeSet.map((write) => write.unit));
    expect(units.length).toBeGreaterThan(new Set(units).size);
    expect(facts.get(key)?.writeSet).toEqual([...new Set(units)].sort());
  });

  it('lists every key once, sorted, and answers undefined for an unknown key', () => {
    const routes = facts.routes();
    expect(routes).toEqual([...new Set(routes)].sort());
    expect(routes).toContain('admin:cusers.update{type=2,action=update}');
    expect(routes.every((route) => facts.get(route)?.route === route)).toBe(true);
    expect(facts.get('admin:nope.nope')).toBeUndefined();
  });
});

const committedDataPresent = existsSync(committed.groupsFile) && existsSync(committed.versionsDir);

describe.runIf(committedDataPresent)('committed cut-over data', () => {
  it('lists and loads v0001 to v0003', async () => {
    const ids = await listVersions(committed);
    expect(ids).toEqual(['v0001', 'v0002', 'v0003']);
    for (const id of ids) expect((await loadVersion(committed, id)).tableVersion).toBe(id);
  });

  it('takes the v0002 session mode from the group writing admin:clogin.login', async () => {
    const [table, groups, committedVariants] = await Promise.all([
      loadVersion(committed, 'v0002'),
      loadGroups(committed),
      loadVariants(committed),
    ]);
    const loginGroup = groups.groups.find((group) => group.writeEntries.includes('admin:clogin.login'));
    const expected = loginGroup === undefined ? 'legacy' : (table.groupAuthority[loginGroup.id] ?? 'legacy');
    expect(buildRoutingIndex(table, committedVariants, groups).loginGroupAuthority()).toBe(expected);
  });
});
