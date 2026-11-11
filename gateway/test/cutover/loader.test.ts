import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { matchRouteKey, routeKeyForRequest } from '@opt2/platform/legacy-compat';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CutoverSchemaError,
  buildRoutingIndex,
  listVersions,
  loadDecisionList,
  loadExceptionsList,
  loadGroups,
  loadInventory,
  loadInventoryFacts,
  loadSourcePin,
  loadTableOwnership,
  loadVariants,
  loadVersion,
} from '../../src/cutover/loader.js';
import { resolveGatewayPaths, type GatewayPaths } from '../../src/cutover/paths.js';
import type {
  Authority,
  CutoverEntry,
  CutoverGroup,
  CutoverTable,
  DecisionListInput,
  ExceptionsDoc,
  GroupsFile,
  InventoryDoc,
  InventoryFacts,
  OwnershipDoc,
  SourcePin,
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

// ---- Fixture opt2 inputs ----

const SRC = { path: 'admin/core/controllers/cusers.cfc', lines: [1, 2] as const };

const PIN: SourcePin = {
  sha: SHA,
  subject: 'Increase version to 7.6.1 in package files and configuration',
  repository: 'fixture',
  confirmedAt: '2026-06-01T00:00:00Z',
  confirmCommand: 'cd harness && npx tsx src/reporting/check-pin.ts --confirm',
};

const OWNERSHIP: OwnershipDoc = {
  sourceSha: SHA,
  units: GROUPS.groups
    .flatMap((group) => group.units)
    .map((unit) => ({ unit, owner: unit.split('.')[0] as string, legacyTables: ['tusers'] })),
  tables: [{ table: 'tusers', owner: 'split', targets: [{ unit: 'people.person', rowPredicate: 'Type = 2', ownedColumns: ['Fname'] }] }],
};

const WRITE = {
  unit: 'people.person',
  legacyTable: 'tusers',
  op: 'update',
  via: ['cusers.update', 'userDAO.update'],
  source: SRC,
  condition: null,
  override: null,
};

const ENTRY_POINT = {
  id: 'fe:setreminder',
  source: SRC,
  owningService: 'people',
  disposition: 'carry',
  writeSet: [WRITE],
  conditionalWrites: [],
  routeKey: ROSTER_ADD,
  predicate: null,
  sessionEffects: 'none',
} as const;

// generatedBy, requiredRole and windowed stand for inventory metadata the gateway does not read.
const INVENTORY = {
  sourceSha: SHA,
  generatedBy: 'fixture',
  controllers: [
    {
      id: 'ctl:cusers',
      circuit: 'cusers',
      isBase: false,
      owningService: 'people',
      requiredRole: { gate: 'S2' },
      actions: [
        {
          id: 'act:cusers.update',
          action: 'update',
          variants: [
            {
              ...ENTRY_POINT,
              id: 'ctl:cusers.update{type=2,action=add}',
              predicate: { variant: 'type=2,action=add', when: [{ param: 'type', equals: '2' }, { param: 'action', present: true }] },
              csrfValidation: 'validates',
              csrfContext: 'cusers',
              responseMode: 'redirect',
              contentType: null,
            },
          ],
        },
      ],
    },
  ],
  routes: [{ ...ENTRY_POINT, id: 'rte:/_api/json/v1', routeKey: null, writeSet: [], kind: 'api-family', family: 'api' }],
  frontEnd: [
    {
      ...ENTRY_POINT,
      routeKey: 'page:setreminder',
      disposition: 'decision',
      windowed: false,
      writeSet: [{ ...WRITE, unit: 'legacy:tcontenteventreminders', legacyTable: 'tcontenteventreminders' }],
      conditionalWrites: [{ kind: 'guarded', unit: null, legacyTable: null, op: null, via: [], source: SRC, guard: 'never holds' }],
    },
  ],
  scheduledJobs: [
    {
      id: 'job:sitemonitor',
      source: SRC,
      owningService: 'programs-sites',
      disposition: 'carry',
      routeKey: 'sitemonitor:run',
      steps: [
        { id: 'job:sitemonitor:purge', source: SRC, owningService: null, disposition: 'legacy-served', writeSet: [], conditionalWrites: [], order: 1, step: 'purge' },
      ],
    },
  ],
  tables: [
    {
      id: 'tbl:tusers',
      source: SRC,
      owningService: 'people',
      disposition: 'carry',
      table: 'tusers',
      schema: 'dbo',
      hasPrimaryKey: null,
      writers: [
        {
          component: 'core/mura/user/userDAO.cfc',
          method: 'update',
          source: SRC,
          op: 'update',
          routeKeys: [ROSTER_ADD],
          keyScope: ['userid'],
          trigger: 'request',
          sessionEffects: 'none',
          condition: 'Type = 2',
          override: null,
        },
      ],
    },
  ],
};

const DECISION_LIST: DecisionListInput = {
  sourceSha: SHA,
  tables: [{ table: 'tcontenteventreminders', withheldEntryPoints: [{ routeKey: null }] }],
  actionVariants: [{ routeKey: 'admin:cusers.update{type=2,action=delete}', writeSet: ['tusers'], entryPoints: [{ routeKey: 'api:user.delete' }] }],
};

const EXCEPTIONS: ExceptionsDoc = {
  sourceSha: SHA,
  entries: [{ id: 'EX-FILE-RENDITION', routeKey: 'admin:carch.update{upload=image}', appliesTo: [], decision: 'preserve', status: 'halted' }],
};

const VARIANTS: VariantsFile = {
  sourceSha: SHA,
  variants: [{ route: 'admin:cusers.update', variant: 'type=2,action=add', when: [{ param: 'type', equals: '2' }] }],
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

let dir: string;
let paths: GatewayPaths;
let variants: VariantsFile;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opt2-loader-'));
  const opt2 = join(dir, 'opt2');
  paths = {
    ...resolveGatewayPaths({ OPT2_CUTOVER_DIR: join(dir, 'cutover') }),
    inventoryFile: join(opt2, 'legacy-inventory.json'),
    tableOwnershipFile: join(opt2, 'table-ownership.json'),
    decisionListFile: join(opt2, 'decision-list.json'),
    exceptionsListFile: join(opt2, 'exceptions-list.json'),
    sourcePinFile: join(opt2, 'source-pin.json'),
  };
  await mkdir(paths.versionsDir, { recursive: true });
  await mkdir(opt2);
  await writeFile(paths.inventoryFile, json(INVENTORY));
  await writeFile(paths.tableOwnershipFile, json(OWNERSHIP));
  await writeFile(paths.decisionListFile, json(DECISION_LIST));
  await writeFile(paths.exceptionsListFile, json(EXCEPTIONS));
  await writeFile(paths.sourcePinFile, json(PIN));
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

/** A deep copy of `doc` with the value at `path` replaced; `undefined` drops the property from the written JSON. */
function withValue(doc: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const copy = structuredClone(doc) as Record<string | number, unknown>;
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1] as string | number] = value;
  return copy;
}

const INPUTS = {
  inventory: { doc: INVENTORY, file: 'inventoryFile', load: loadInventory },
  ownership: { doc: OWNERSHIP, file: 'tableOwnershipFile', load: loadTableOwnership },
  decisionList: { doc: DECISION_LIST, file: 'decisionListFile', load: loadDecisionList },
  exceptions: { doc: EXCEPTIONS, file: 'exceptionsListFile', load: loadExceptionsList },
  pin: { doc: PIN, file: 'sourcePinFile', load: loadSourcePin },
  variants: { doc: VARIANTS, file: 'variantsFile', load: loadVariants },
  groups: { doc: GROUPS, file: 'groupsFile', load: loadGroups },
} satisfies Record<string, { doc: unknown; file: keyof GatewayPaths; load: (paths: GatewayPaths) => Promise<unknown> }>;

type InputCase = [label: string, input: keyof typeof INPUTS, path: Array<string | number>, value: unknown, expected: string];

const VARIANT_0 = ['controllers', 0, 'actions', 0, 'variants', 0];
const ONE_OF = 'must be equal to one of the allowed values';
const PINNED = `must equal the pinned sha ${SHA}`;

/** Writes one input with its change beside the fixture inputs and returns what its loader rejects with. */
async function rejection(input: keyof typeof INPUTS, path: Array<string | number>, value: unknown): Promise<{ file: string; error: unknown }> {
  const { doc, file: key, load } = INPUTS[input];
  const file = join(await mkdtemp(join(dir, 'input-')), basename(paths[key]));
  await writeFile(file, json(withValue(doc, path, value)));
  const error = await load({ ...paths, [key]: file }).then(
    () => undefined,
    (e: unknown) => e,
  );
  return { file, error };
}

describe('opt2 inputs', () => {
  it.each([
    ['inventory', loadInventory, INVENTORY],
    ['table ownership', loadTableOwnership, OWNERSHIP],
    ['decision list', loadDecisionList, DECISION_LIST],
    ['exceptions list', loadExceptionsList, EXCEPTIONS],
    ['source pin', loadSourcePin, PIN],
  ] as const)('loads the fixture %s as written, extra metadata included', async (_label, load, doc) => {
    expect(await load(paths)).toEqual(doc);
  });

  it.each([
    ['an action variant csrfValidation "sometimes"', 'inventory', [...VARIANT_0, 'csrfValidation'], 'sometimes', ONE_OF],
    ['an action variant responseMode "stream"', 'inventory', [...VARIANT_0, 'responseMode'], 'stream', ONE_OF],
    ['a writer trigger "cron"', 'inventory', ['tables', 0, 'writers', 0, 'trigger'], 'cron', ONE_OF],
    ['a front-end sessionEffects "reset"', 'inventory', ['frontEnd', 0, 'sessionEffects'], 'reset', ONE_OF],
    ['a front-end disposition "moved"', 'inventory', ['frontEnd', 0, 'disposition'], 'moved', ONE_OF],
    ['a route family "nowhere"', 'inventory', ['routes', 0, 'family'], 'nowhere', ONE_OF],
    ['a null front-end routeKey', 'inventory', ['frontEnd', 0, 'routeKey'], null, 'must be string'],
    ['routes as an object', 'inventory', ['routes'], {}, 'must be array'],
    ['writers as a string', 'inventory', ['tables', 0, 'writers'], 'none', 'must be array'],
    ['a write without source', 'inventory', [...VARIANT_0, 'writeSet', 0, 'source'], undefined, "must have required property 'source'"],
    ['a write to an unknown unit', 'inventory', [...VARIANT_0, 'writeSet', 0, 'unit'], 'people.nobody', 'people.nobody maps to no unit of opt2/table-ownership.json'],
    ['a file-store write without a tfiles mapping', 'inventory', ['frontEnd', 0, 'writeSet', 0, 'unit'], 'file-store', 'file-store maps to no unit'],
    ['a decision-table write naming no table', 'inventory', ['frontEnd', 0, 'writeSet', 0, 'unit'], 'legacy:', 'legacy: maps to no unit'],
    ['a target naming no ownership unit', 'ownership', ['tables', 0, 'targets', 0, 'unit'], 'people.ghost', 'unit people.ghost is not in /units'],
    ['a duplicate ownership unit', 'ownership', ['units', 1, 'unit'], IDLE_GROUP.slice('grp:'.length), 'duplicates unit content.trash'],
    ['ownership units as an object', 'ownership', ['units'], {}, 'must be array'],
    ['an action-variant writeSet as a string', 'decisionList', ['actionVariants', 0, 'writeSet'], 'tusers', 'must be array'],
    ['an exception status "closed"', 'exceptions', ['entries', 0, 'status'], 'closed', ONE_OF],
    ['an exception decision "ignore"', 'exceptions', ['entries', 0, 'decision'], 'ignore', ONE_OF],
    ['an inventory of another commit', 'inventory', ['sourceSha'], '0'.repeat(40), PINNED],
    ['a table ownership of another commit', 'ownership', ['sourceSha'], '0'.repeat(40), PINNED],
    ['a decision list of another commit', 'decisionList', ['sourceSha'], '0'.repeat(40), PINNED],
    ['an exceptions list of another commit', 'exceptions', ['sourceSha'], '0'.repeat(40), PINNED],
    ['variants.json of another commit', 'variants', ['sourceSha'], '0'.repeat(40), PINNED],
    ['groups.json of another commit', 'groups', ['sourceSha'], '0'.repeat(40), PINNED],
    ['a pin with a sixth field', 'pin', ['sourceSha'], SHA, 'must NOT have additional properties'],
    ['a pin without subject', 'pin', ['subject'], undefined, "must have required property 'subject'"],
    ['an upper-case pin sha', 'pin', ['sha'], SHA.toUpperCase(), 'must match pattern'],
    ['a pin sha with a trailing newline', 'pin', ['sha'], `${SHA}\n`, 'must match pattern'],
    ['a 39-character pin sha', 'pin', ['sha'], SHA.slice(1), 'must match pattern'],
    ['a duplicate group id', 'groups', ['groups', 1, 'id'], IDLE_GROUP, `/groups/1/id duplicates group ${IDLE_GROUP}`],
    ['a unit in two groups', 'groups', ['groups', 0, 'units', 1], 'people.person', `/groups/2/units/1 unit people.person is also in ${IDLE_GROUP}`],
    ['an ownership unit in no group', 'groups', ['groups', 1, 'units'], ['identity.credential'], '/groups ownership unit identity.login_state is in no group'],
    ['a unit outside the ownership units', 'groups', ['groups', 1, 'units', 2], 'identity.ghost', '/groups/1/units/2 unit identity.ghost is not in opt2/table-ownership.json'],
    ['a carry flag without write entries', 'groups', ['groups', 0, 'hasCarryWrite'], true, '/groups/0/hasCarryWrite must be false for 0 write entries'],
    ['write entries without the carry flag', 'groups', ['groups', 1, 'hasCarryWrite'], false, '/groups/1/hasCarryWrite must be true for 1 write entries'],
    ['a write entry of two groups', 'groups', ['groups', 2, 'writeEntries', 2], 'admin:clogin.login', `/groups/2/writeEntries/2 admin:clogin.login is also a write entry of ${LOGIN_GROUP}`],
  ] satisfies InputCase[])('rejects %s with CutoverSchemaError', async (_label, input, path, value, expected) => {
    const { file, error } = await rejection(input, path, value);
    expect(error).toBeInstanceOf(CutoverSchemaError);
    expect((error as CutoverSchemaError).file).toBe(file);
    expect((error as CutoverSchemaError).message).toContain(`${file} does not match its cut-over schema:`);
    expect((error as CutoverSchemaError).message).toContain(expected);
  });
});

describe.runIf(existsSync(committed.inventoryFile))('committed opt2 inputs', () => {
  it('load through the loader, each bound to the pin', async () => {
    const pin = await loadSourcePin(committed);
    const docs = await Promise.all([
      loadInventory(committed),
      loadTableOwnership(committed),
      loadDecisionList(committed),
      loadExceptionsList(committed),
      loadVariants(committed),
      loadGroups(committed),
    ]);
    expect(docs.map((doc) => doc.sourceSha)).toEqual(Array(docs.length).fill(pin.sha));
    expect(Object.keys(pin).sort()).toEqual(['confirmCommand', 'confirmedAt', 'repository', 'sha', 'subject']);
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

  const [idle, login, roster] = GROUPS.groups as [CutoverGroup, CutoverGroup, CutoverGroup];
  const v2 = VERSIONS.v0002 as CutoverTable;
  it.each([
    [
      'two entries normalising to one route',
      { ...v2, entries: [...v2.entries, { ...(v2.entries[0] as CutoverEntry), route: ' ADMIN:clogin.login' }] },
      GROUPS,
      'v0002: entries admin:clogin.login and  ADMIN:clogin.login both route admin:clogin.login',
    ],
    [
      'a unit in two groups',
      v2,
      { ...GROUPS, groups: [{ ...idle, units: [...idle.units, 'people.person'] }, login, roster] },
      `groups.json: unit people.person is in both ${IDLE_GROUP} and ${ROSTER_GROUP}`,
    ],
    [
      'the login route in two groups',
      v2,
      { ...GROUPS, groups: [idle, login, { ...roster, writeEntries: [...roster.writeEntries, 'ADMIN:clogin.login'] }] },
      `groups.json: admin:clogin.login is a write entry of ${LOGIN_GROUP} and ${ROSTER_GROUP}`,
    ],
  ] satisfies Array<[string, CutoverTable, GroupsFile, string]>)('throws on %s instead of choosing one', (_label, table, groups, message) => {
    expect(() => buildRoutingIndex(table, variants, groups)).toThrow(message);
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
