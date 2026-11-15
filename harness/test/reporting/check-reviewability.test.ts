import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/lib/cli.js';
import { isInsideRepo, opt2Path } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';
import {
  GENERATED_BY,
  INVENTORY_PATH,
  OWNERSHIP_PATH,
  PASS_CONDITION,
  SYNTHETIC_SERVICES,
  TEN_SERVICES,
  buildReport,
  carriedOrOwnedItems,
  checkService,
  coverageKeys,
  fileOk,
  inventorySchema,
  main,
  markdownLines,
  ownershipSchema,
  parseTraceabilityRows,
  traceabilityRowCount,
} from '../../src/reporting/check-reviewability.js';
import type {
  CheckDeps,
  FileRecord,
  Inventory,
  MissingItem,
  Ownership,
  ReviewabilityReport,
  ReviewItem,
  ServiceName,
  ServiceReport,
} from '../../src/reporting/check-reviewability.js';

const SHA = pinnedSha();
const ZERO_SHA = '0'.repeat(40);
/** A non-pin SHA YAML reads as a string; an all-digit SHA would parse as a number. */
const OTHER_SHA = 'ab'.repeat(20);
const COMMAND = 'harness/src/reporting/check-reviewability.ts';
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

const fixture = (relPath: string): Promise<string> => readFile(path.join(FIXTURES, relPath), 'utf8');
const TRACEABILITY = await fixture('reporting/traceability-identity.md.txt');
const README = await fixture('reporting/readme-service.md.txt');
const OPENAPI = await fixture('reporting/openapi-sample.yaml');
const EVENT = await fixture('reporting/event-sample.json');
const INVENTORY_JSON = await fixture('inventory/mini-inventory.json');
const OWNERSHIP_JSON = await fixture('inventory/mini-table-ownership.json');
const PIN_JSON = await readFile(opt2Path('source-pin.json'), 'utf8');

const INVENTORY: Inventory = inventorySchema.parse(JSON.parse(INVENTORY_JSON));
const OWNERSHIP: Ownership = ownershipSchema.parse(JSON.parse(OWNERSHIP_JSON));

/**
 * The mini inventory records `ctl:clogin.login` as a spanning decision; this copy carries it for identity, as the plan
 * disposes the admin login, so a carried admin action and its traceability-fixture row can be checked.
 */
const LOGIN_CARRIED: Inventory = (() => {
  const inventory = structuredClone(INVENTORY);
  const carried = { owningService: 'identity', disposition: 'carry' };
  for (const controller of inventory.controllers) {
    for (const action of controller.actions ?? []) {
      for (const variant of action.variants ?? []) {
        if (variant.id === 'ctl:clogin.login') Object.assign(variant, carried);
      }
    }
  }
  return inventory;
})();

/** Items each service carries or owns in the mini inventory and ownership fixtures, derived by hand. */
const EXPECTED_ITEMS: Record<ServiceName, readonly string[]> = {
  identity: ['tbl:tusersmemb', 'tbl:tusers'],
  people: ['ctl:cusers.listusers', 'ctl:cusers.update{type=2,action=add}', 'tbl:tusers'],
  'programs-sites': ['job:sitemonitor'],
  'strategies-content': ['api:content.findone'],
  communications: [],
  reporting: [],
  surveys: [],
  timesheets: [],
  finance: [],
  'e-signature': [],
};
const IDENTITY_LOGIN_ITEMS = ['ctl:clogin.login', 'tbl:tusersmemb', 'tbl:tusers'];
/** Identity items of {@link LOGIN_CARRIED} that no row of the traceability fixture names. */
const UNCOVERED_BY_FIXTURE = ['tbl:tusersmemb', 'tbl:tusers'];

/** Code and test files the traceability fixture's rows cite. */
const FIXTURE_REFS = [
  'services/identity/src/routes/admin-sessions.ts',
  'services/identity/src/domain/login.ts',
  'services/identity/src/routes/admin-permissions.ts',
  'services/identity/src/domain/permissions.ts',
  'services/identity/test/unit/admin-sessions.test.ts',
];

const EVENT_FILE = 'contracts/events/identity.group.changed.v1.json';
const TABLE_HEADER = [
  '| Inventory id / route key | Legacy source (path:lines) | Disposition | Target code |',
  ' Proof (test file — test name, or GS id) |',
].join('');
const TABLE_SEPARATOR = '|---|---|---|---|---|';
const LOGIN_MISSING: MissingItem = { id: 'ctl:clogin.login', routeKey: 'admin:clogin.login', reason: 'no-row' };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-reviewability-'));
  expect(isInsideRepo(root)).toBe(false);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, text] of Object.entries(files)) {
    const file = path.join(dir, relPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
  }
}

async function touch(dir: string, relPaths: readonly string[]): Promise<void> {
  await writeTree(dir, Object.fromEntries(relPaths.map((relPath) => [relPath, ''])));
}

/** Service artefacts: `undefined` keeps the fixture, `null` omits the file, a string replaces it. */
interface ServiceOverrides {
  readme?: string | null;
  traceability?: string | null;
  openapi?: string | null;
  event?: string | null;
}

/** Writes `services/<svc>/` from the reporting fixtures, as `overrides` adjusts them. */
async function buildService(dir: string, svc: string, overrides: ServiceOverrides = {}): Promise<void> {
  const files: [string, string | null | undefined, string][] = [
    ['README.md', overrides.readme, README],
    ['TRACEABILITY.md', overrides.traceability, TRACEABILITY],
    ['contracts/openapi.yaml', overrides.openapi, OPENAPI],
    [EVENT_FILE, overrides.event, EVENT],
  ];
  const tree: Record<string, string> = {};
  for (const [relPath, override, text] of files) {
    const content = override === undefined ? text : override;
    if (content !== null) tree[`services/${svc}/${relPath}`] = content;
  }
  await writeTree(dir, tree);
}

function slug(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Code path and test file {@link coverRow} cites for `id`. */
function rowRefs(svc: string, id: string): [string, string] {
  return [`services/${svc}/src/domain/${slug(id)}.ts`, `services/${svc}/test/unit/${slug(id)}.test.ts`];
}

/** A row in the fixture's column layout naming `id`, with a legacy source, a code path and a test file. */
function coverRow(svc: string, id: string): string {
  const [code, test] = rowRefs(svc, id);
  return `| \`${id}\` | \`core/setup/db/mssql.sql:467-505\` | carry | \`${code}\` | \`${test}\` |`;
}

/** A TRACEABILITY.md whose table holds `rows`, the first of them on line 7. */
function traceabilityFor(svc: string, rows: readonly string[]): string {
  const lines = [`# ${svc} — traceability`, '', `Source SHA: ${SHA}`, '', TABLE_HEADER, TABLE_SEPARATOR, ...rows];
  return [...lines, ''].join('\n');
}

/**
 * `services/identity` passing for {@link LOGIN_CARRIED} unless `overrides` breaks it: its TRACEABILITY.md is
 * `overrides.traceability` (default the fixture) plus a row per item the fixture rows do not name.
 */
async function buildPassingIdentity(
  dir: string,
  overrides: Omit<ServiceOverrides, 'traceability'> & { traceability?: string } = {},
): Promise<void> {
  const rows = UNCOVERED_BY_FIXTURE.map((id) => coverRow('identity', id));
  const traceability = `${overrides.traceability ?? TRACEABILITY}${rows.join('\n')}\n`;
  await buildService(dir, 'identity', { ...overrides, traceability });
  await touch(dir, [...FIXTURE_REFS, ...UNCOVERED_BY_FIXTURE.flatMap((id) => rowRefs('identity', id))]);
}

function deps(dir: string, inventory: Inventory = LOGIN_CARRIED, ownership: Ownership = OWNERSHIP): CheckDeps {
  return { root: dir, sha: SHA, inventory, ownership };
}

/** File records of `report` that are absent or do not carry the pinned SHA. */
function failingFiles(report: ServiceReport): FileRecord[] {
  const { readme, traceability, contracts } = report;
  return [readme, traceability, contracts.openapi, ...contracts.events].filter((record) => !fileOk(record, SHA));
}

function ids(items: readonly ReviewItem[]): string[] {
  return items.map((item) => item.id);
}

describe('service constants', () => {
  it('TEN_SERVICES lists the ten services in plan order', () => {
    expect(TEN_SERVICES).toStrictEqual([
      'identity',
      'people',
      'programs-sites',
      'strategies-content',
      'communications',
      'reporting',
      'surveys',
      'timesheets',
      'finance',
      'e-signature',
    ]);
  });

  it('SYNTHETIC_SERVICES lists the last six services in plan order', () => {
    expect(SYNTHETIC_SERVICES).toStrictEqual([
      'communications',
      'reporting',
      'surveys',
      'timesheets',
      'finance',
      'e-signature',
    ]);
  });
});

describe('parseTraceabilityRows', () => {
  it('parses the three data rows of the identity fixture, skipping its header and separator', () => {
    const rows = parseTraceabilityRows(TRACEABILITY);

    expect(
      rows.map(({ line, cells, sourceRefs, codePaths, testRefs }) => ({
        line,
        columns: cells.length,
        sourceRefs,
        codePaths,
        testRefs,
      })),
    ).toEqual([
      {
        line: 7,
        columns: 5,
        sourceRefs: ['admin/core/controllers/clogin.cfc:101-113'],
        codePaths: ['services/identity/src/routes/admin-sessions.ts', 'services/identity/src/domain/login.ts'],
        testRefs: ['services/identity/test/unit/admin-sessions.test.ts', 'GS-ID-01'],
      },
      {
        line: 8,
        columns: 5,
        sourceRefs: ['admin/core/controllers/clogin.cfc:115-118'],
        codePaths: ['services/identity/src/routes/admin-sessions.ts', 'services/identity/src/domain/login.ts'],
        testRefs: ['GS-ID-01'],
      },
      {
        line: 9,
        columns: 5,
        sourceRefs: ['admin/core/controllers/cperm.cfc:119-160'],
        codePaths: ['services/identity/src/routes/admin-permissions.ts', 'services/identity/src/domain/permissions.ts'],
        testRefs: ['GS-ID-07'],
      },
    ]);
  });

  it.each([
    [0, 'ctl:clogin.login', 'admin:clogin.login'],
    [1, 'ctl:clogin.logout', 'admin:clogin.logout'],
    [2, 'ctl:cperm.updatemodule', 'admin:cperm.updatemodule'],
  ])('row %i tokens hold its inventory id %s and route key %s', (index, id, routeKey) => {
    const tokens = parseTraceabilityRows(TRACEABILITY)[index]?.tokens;

    expect(tokens).toContain(id);
    expect(tokens).toContain(routeKey);
  });

  it('counts the three data rows of the identity fixture', () => {
    expect(traceabilityRowCount(TRACEABILITY)).toBe(3);
  });

  it.each([
    ['empty markdown', '', 0],
    ['prose without a table', '# identity\n\nSource SHA: x\n', 0],
    ['a table with only its header', '| a | b |\n|---|---|\n', 0],
    ['a table inside a fenced block', '```\n| a | b |\n|---|---|\n| c | d |\n```\n', 0],
    ['a separator with no header row above it', '|---|---|\n| c | d |\n', 0],
    ['a table ended by a blank line', '| a | b |\n|---|---|\n| c | d |\n\n| e | f |\n', 1],
    ['a delimiter-like row inside a table body', '| a | b |\n|---|---|\n|---|---|\n', 1],
    ['two tables, one with aligned columns', '| a |\n|---|\n| b |\n\n| c |\n|:---:|\n| d |\n| e |\n', 3],
  ])('counts the data rows of %s as %i', (_name, markdown, count) => {
    expect(traceabilityRowCount(markdown)).toBe(count);
  });

  it('counts a row with missing columns and keeps only the cells it has', () => {
    const markdown = `${TABLE_HEADER}\n${TABLE_SEPARATOR}\n| \`tbl:tusers\` | \`core/setup/db/mssql.sql:467-505\` |\n`;

    expect(parseTraceabilityRows(markdown)).toEqual([
      {
        line: 3,
        cells: ['`tbl:tusers`', '`core/setup/db/mssql.sql:467-505`'],
        tokens: new Set(['tbl:tusers', 'core/setup/db/mssql.sql:467-505']),
        sourceRefs: ['core/setup/db/mssql.sql:467-505'],
        codePaths: [],
        testRefs: [],
      },
    ]);
  });

  it('splits cells on unescaped pipes only', () => {
    const rows = parseTraceabilityRows('| a | b |\n|---|---|\n| `x\\|y` | z \\|\n');

    expect(rows.map((row) => row.cells)).toEqual([['`x|y`', 'z |']]);
  });

  it('classifies legacy-fixtures paths as sources and service-relative paths as code and tests', () => {
    const markdown = [
      '| a | b | c |',
      '|---|---|---|',
      '| `legacy-fixtures/cfml/modules/finance.cfc` | `src/domain/lifecycle.ts`, `web/test/shell.ts` |' +
        ' `test/unit/lifecycle.table.test.ts:12` |',
    ].join('\n');

    const [row] = parseTraceabilityRows(markdown);

    expect(row?.sourceRefs).toEqual(['legacy-fixtures/cfml/modules/finance.cfc']);
    expect(row?.codePaths).toEqual(['src/domain/lifecycle.ts']);
    expect(row?.testRefs).toEqual(['test/unit/lifecycle.table.test.ts']);
  });
});

describe('carriedOrOwnedItems', () => {
  it.each(TEN_SERVICES.map((service) => [service, EXPECTED_ITEMS[service]] as const))(
    'selects the mini-fixture items %s carries or owns',
    (service, expected) => {
      expect(ids(carriedOrOwnedItems(service, INVENTORY, OWNERSHIP))).toEqual(expected);
    },
  );

  it('selects identity-owned tables whole and through split units', () => {
    expect(carriedOrOwnedItems('identity', INVENTORY, OWNERSHIP)).toEqual([
      {
        id: 'tbl:tusersmemb',
        category: 'table',
        disposition: 'carry',
        table: 'tusersmemb',
        units: ['identity.membership'],
      },
      { id: 'tbl:tusers', category: 'table', disposition: 'carry', table: 'tusers', units: ['identity.user_account'] },
    ]);
  });

  it('selects the people roster variants with their route keys and its share of the split tusers', () => {
    expect(carriedOrOwnedItems('people', INVENTORY, OWNERSHIP)).toEqual([
      {
        id: 'ctl:cusers.listusers',
        category: 'admin-action',
        disposition: 'carry',
        routeKey: 'admin:cusers.listusers',
      },
      {
        id: 'ctl:cusers.update{type=2,action=add}',
        category: 'admin-action',
        disposition: 'carry',
        routeKey: 'admin:cusers.update{type=2,action=add}',
      },
      { id: 'tbl:tusers', category: 'table', disposition: 'carry', table: 'tusers', units: ['people.person'] },
    ]);
  });

  it.each([
    ['identity', 'api:content.findone'],
    ['identity', 'ctl:clogin.login'],
    ['people', 'ctl:cusers.update{type=2,action=delete}'],
    ['communications', 'ctl:cemail.list'],
    ['programs-sites', 'job:sitemonitor.cache-purge'],
  ])('excludes from %s the item %s, which it does not carry', (service, id) => {
    expect(ids(carriedOrOwnedItems(service, INVENTORY, OWNERSHIP))).not.toContain(id);
  });

  it('selects an admin action once its variant is carried by the service', () => {
    expect(ids(carriedOrOwnedItems('identity', LOGIN_CARRIED, OWNERSHIP))).toEqual(IDENTITY_LOGIN_ITEMS);
  });

  it('selects carried entries from every inventory list in list order', () => {
    const entry = (id: string): Record<string, string> => ({ id, owningService: 'identity', disposition: 'carry' });
    const inventory = inventorySchema.parse({
      entities: [entry('ent:a')],
      services: [entry('svc:a')],
      controllers: [{ actions: [{ ...entry('ctl:a'), variants: [entry('ctl:a{v=1}'), entry('ctl:a')] }] }],
      frontEnd: [entry('fe:a')],
      scheduledJobs: [{ ...entry('job:a'), steps: [entry('job:a.step')] }],
      routes: [entry('api:a')],
      tables: [{ ...entry('tbl:t'), table: 't' }],
    });

    expect(
      carriedOrOwnedItems('identity', inventory, ownershipSchema.parse({})).map(({ id, category }) => [id, category]),
    ).toEqual([
      ['ent:a', 'entity'],
      ['svc:a', 'service'],
      ['ctl:a', 'admin-action'],
      ['ctl:a{v=1}', 'admin-action'],
      ['fe:a', 'front-end'],
      ['job:a', 'job'],
      ['job:a.step', 'job'],
      ['api:a', 'route'],
      ['tbl:t', 'table'],
    ]);
  });

  it('names a split table absent from the inventory tbl:<table>, and lets units[] override a target owner', () => {
    const ownership = ownershipSchema.parse({
      units: [{ id: 'people.person', owner: 'identity' }],
      tables: [
        { table: 'tnew', owner: 'split', targets: [{ unit: 'identity.new', owner: 'identity' }] },
        { table: 'tusers', owner: 'split', targets: [{ unit: 'people.person', owner: 'people' }] },
        { table: 'tother', owner: 'split', targets: [{ unit: 'people.other', owner: 'people' }] },
      ],
    });

    expect(carriedOrOwnedItems('identity', inventorySchema.parse({}), ownership)).toEqual([
      { id: 'tbl:tnew', category: 'table', disposition: null, table: 'tnew', units: ['identity.new'] },
      { id: 'tbl:tusers', category: 'table', disposition: null, table: 'tusers', units: ['people.person'] },
    ]);
  });
});

describe('coverageKeys', () => {
  it('names the roster create variant by its id and its route key', () => {
    const item = carriedOrOwnedItems('people', INVENTORY, OWNERSHIP).find(
      (candidate) => candidate.id === 'ctl:cusers.update{type=2,action=add}',
    );

    expect(item).toBeDefined();
    expect(coverageKeys(item as ReviewItem)).toEqual([
      'ctl:cusers.update{type=2,action=add}',
      'admin:cusers.update{type=2,action=add}',
    ]);
  });

  it.each<[string, ReviewItem, string[]]>([
    [
      'a table by its id, name and owned units',
      { id: 'tbl:tusers', category: 'table', disposition: 'carry', table: 'tusers', units: ['identity.user_account'] },
      ['tbl:tusers', 'tusers', 'identity.user_account'],
    ],
    [
      'a fixture-schema table also by its unqualified name',
      {
        id: 'tbl:Program_1.timesheet',
        category: 'table',
        disposition: 'carry',
        table: 'Program_1.timesheet',
        units: ['timesheets.timesheet'],
      },
      ['tbl:program_1.timesheet', 'program_1.timesheet', 'timesheet', 'timesheets.timesheet'],
    ],
    [
      'a route by its id and both route keys, lower-cased',
      {
        id: 'api:Content.findOne',
        category: 'route',
        disposition: 'carry',
        routeKey: 'API:content.findone',
        baseRouteKey: 'api:content',
      },
      ['api:content.findone', 'api:content'],
    ],
  ])('names %s', (_name, item, keys) => {
    expect(coverageKeys(item)).toEqual(keys);
  });
});

describe('checkService', () => {
  it('passes a service whose artefacts carry the pin and whose table covers every item', async () => {
    await buildPassingIdentity(root);

    await expect(checkService('identity', deps(root))).resolves.toEqual({
      service: 'identity',
      readme: { path: 'services/identity/README.md', present: true, sha: SHA },
      traceability: { path: 'services/identity/TRACEABILITY.md', present: true, sha: SHA, rows: 5 },
      contracts: {
        openapi: { path: 'services/identity/contracts/openapi.yaml', present: true, sha: SHA },
        events: [{ path: `services/identity/${EVENT_FILE}`, present: true, sha: SHA }],
      },
      inventoryItems: { carriedOrOwned: 3, covered: 3, missing: [] },
      result: 'pass',
    });
  });

  it('reports an absent TRACEABILITY.md and every item as having no row', async () => {
    await buildService(root, 'identity', { traceability: null });

    const report = await checkService('identity', deps(root));

    expect(failingFiles(report)).toEqual([
      { path: 'services/identity/TRACEABILITY.md', present: false, sha: null, rows: null },
    ]);
    expect(report.inventoryItems).toEqual({
      carriedOrOwned: 3,
      covered: 0,
      missing: [LOGIN_MISSING, { id: 'tbl:tusersmemb', reason: 'no-row' }, { id: 'tbl:tusers', reason: 'no-row' }],
    });
    expect(report.result).toBe('fail');
  });

  it.each<[string, string, string | null]>([
    [
      'a zero SHA in its $comment',
      JSON.stringify({ ...JSON.parse(EVENT), $comment: `source-sha: ${ZERO_SHA}` }),
      ZERO_SHA,
    ],
    ['no $comment', JSON.stringify({ ...JSON.parse(EVENT), $comment: undefined }), null],
    ['unparseable JSON', '{ "$comment": "source-sha: ', null],
  ])('reports an event schema with %s as its one SHA finding', async (_name, event, sha) => {
    await buildPassingIdentity(root, { event });

    const report = await checkService('identity', deps(root));

    expect(failingFiles(report)).toEqual([{ path: `services/identity/${EVENT_FILE}`, present: true, sha }]);
    expect(report.inventoryItems.missing).toEqual([]);
    expect(report.result).toBe('fail');
  });

  it('lists an inventory item without a traceability row in missing', async () => {
    const withoutLogin = TRACEABILITY.split('\n')
      .filter((line) => !line.includes('`ctl:clogin.login`'))
      .join('\n');
    await buildPassingIdentity(root, { traceability: withoutLogin });

    const report = await checkService('identity', deps(root));

    expect(report.inventoryItems).toEqual({ carriedOrOwned: 3, covered: 2, missing: [LOGIN_MISSING] });
    expect(failingFiles(report)).toEqual([]);
    expect(report.result).toBe('fail');
  });

  it.each<[string, Omit<ServiceOverrides, 'traceability'>, FileRecord]>([
    [
      'README.md without its Source SHA line',
      { readme: README.replace(/^Source SHA:.*\n/m, '') },
      { path: 'services/identity/README.md', present: true, sha: null },
    ],
    [
      'README.md naming a second, different SHA',
      { readme: `${README}\nSource SHA: ${ZERO_SHA}\n` },
      { path: 'services/identity/README.md', present: true, sha: ZERO_SHA },
    ],
    [
      'an absent contracts/openapi.yaml',
      { openapi: null },
      { path: 'services/identity/contracts/openapi.yaml', present: false, sha: null },
    ],
    [
      'contracts/openapi.yaml with another info.x-source-sha',
      { openapi: OPENAPI.replace(SHA, OTHER_SHA) },
      { path: 'services/identity/contracts/openapi.yaml', present: true, sha: OTHER_SHA },
    ],
    [
      'an absent README.md',
      { readme: null },
      { path: 'services/identity/README.md', present: false, sha: null },
    ],
  ])('reports %s as its one file finding', async (_name, overrides, record) => {
    await buildPassingIdentity(root, overrides);

    const report = await checkService('identity', deps(root));

    expect(failingFiles(report)).toEqual([record]);
    expect(report.inventoryItems.missing).toEqual([]);
    expect(report.result).toBe('fail');
  });

  it('passes a service without event contracts', async () => {
    await buildPassingIdentity(root);
    await rm(path.join(root, 'services/identity/contracts/events'), { recursive: true });

    const report = await checkService('identity', deps(root));

    expect(report.contracts.events).toEqual([]);
    expect(report.result).toBe('pass');
  });

  it('checks every contracts/events/*.json in name order and ignores other files', async () => {
    await buildPassingIdentity(root);
    await writeTree(root, {
      'services/identity/contracts/events/identity.account.changed.v1.json': EVENT,
      'services/identity/contracts/events/notes.txt': 'not a contract\n',
    });

    const report = await checkService('identity', deps(root));

    expect(report.contracts.events.map((record) => record.path)).toEqual([
      'services/identity/contracts/events/identity.account.changed.v1.json',
      `services/identity/${EVENT_FILE}`,
    ]);
  });

  describe('row judgement', () => {
    const MEMB = 'tbl:tusersmemb';
    const SOURCE = '`core/setup/db/mssql.sql:528-531`';
    const CODE = 'services/identity/src/domain/memberships.ts';
    const TEST = 'services/identity/test/unit/memberships.test.ts';
    const ABSENT_CODE = 'services/identity/src/domain/absent.ts';
    const ABSENT_TEST = 'services/identity/test/unit/absent.test.ts';
    const incomplete = `| \`${MEMB}\` | ${SOURCE} |`;
    const testAbsent = `| \`${MEMB}\` | ${SOURCE} | carry | \`${CODE}\` | \`${ABSENT_TEST}\` |`;
    const complete = `| \`${MEMB}\` | ${SOURCE} | carry | \`${CODE}\` | \`${TEST}\` |`;

    it.each<[string, string[], MissingItem | null]>([
      ['no row naming it', [coverRow('identity', 'tbl:tother')], { id: MEMB, reason: 'no-row' }],
      [
        'a row with only its id and source',
        [incomplete],
        { id: MEMB, reason: 'incomplete-row', line: 10, lacks: ['code-path', 'test-ref'] },
      ],
      [
        'a row of empty cells',
        [`| \`${MEMB}\` |  |  |  |  |`],
        { id: MEMB, reason: 'incomplete-row', line: 10, lacks: ['source-ref', 'code-path', 'test-ref'] },
      ],
      [
        'a code path not on disk',
        [`| \`${MEMB}\` | ${SOURCE} | carry | \`${ABSENT_CODE}\` | \`${TEST}\` |`],
        { id: MEMB, reason: 'code-path-missing', line: 10, paths: [ABSENT_CODE] },
      ],
      [
        'a code path and a test file not on disk',
        [`| \`${MEMB}\` | ${SOURCE} | carry | \`${ABSENT_CODE}\` | \`${ABSENT_TEST}\` |`],
        { id: MEMB, reason: 'code-path-missing', line: 10, paths: [ABSENT_CODE, ABSENT_TEST] },
      ],
      ['a test file not on disk', [testAbsent], { id: MEMB, reason: 'test-missing', line: 10, paths: [ABSENT_TEST] }],
      [
        'an incomplete row before one with an absent test file',
        [incomplete, testAbsent],
        { id: MEMB, reason: 'test-missing', line: 11, paths: [ABSENT_TEST] },
      ],
      ['an incomplete row before a complete one', [incomplete, complete], null],
      [
        'a row naming its unit with service-relative paths',
        [
          `| \`identity.membership\` | ${SOURCE} | carry | \`src/domain/memberships.ts\` |` +
            ' `test/unit/memberships.test.ts` |',
        ],
        null,
      ],
      [
        'a row naming its table with wildcard and templated paths and a GS id',
        [
          `| \`tusersmemb\` | ${SOURCE} | carry | \`services/identity/src/routes/*.ts\`,` +
            ` \`services/identity/src/routes/{name}.ts\` | GS-ID-06 |`,
        ],
        null,
      ],
    ])('judges tbl:tusersmemb with %s', async (_name, rows, expected) => {
      const tusersRow = coverRow('identity', 'tbl:tusers');
      await buildService(root, 'identity', { traceability: `${TRACEABILITY}${[...rows, tusersRow].join('\n')}\n` });
      await touch(root, [CODE, TEST, ...rowRefs('identity', 'tbl:tusers')]);

      const report = await checkService('identity', deps(root, INVENTORY));

      expect(report.inventoryItems.missing).toEqual(expected === null ? [] : [expected]);
    });

    it.each<[string, MissingItem[]]>([
      ['decision', []],
      ['carry', [{ id: 'tbl:tpermissions', reason: 'incomplete-row', line: 7, lacks: ['code-path'] }]],
    ])('requires a code path for a %s item only when it runs on the target', async (disposition, missing) => {
      const inventory = inventorySchema.parse({
        tables: [{ id: 'tbl:tpermissions', table: 'tpermissions', owningService: 'identity', disposition }],
      });
      const row = `| \`tbl:tpermissions\` | \`core/setup/db/mssql.sql:380-390\` | ${disposition} | — | GS-ID-07 |`;
      await buildService(root, 'identity', { traceability: traceabilityFor('identity', [row]) });

      const report = await checkService('identity', deps(root, inventory, ownershipSchema.parse({})));

      expect(report.inventoryItems.missing).toEqual(missing);
    });
  });

  it.each<[string, (dir: string) => Promise<unknown>, string]>([
    ['README.md is a directory', (dir) => mkdir(path.join(dir, 'services/identity/README.md')), 'EISDIR'],
    ['contracts/events is a file', (dir) => writeTree(dir, { 'services/identity/contracts/events': '' }), 'ENOTDIR'],
  ])('rethrows a read error other than a missing file when %s', async (_name, arrange, code) => {
    await buildService(root, 'identity', { readme: null, event: null });
    await arrange(root);

    await expect(checkService('identity', deps(root))).rejects.toMatchObject({ code });
  });
});

const CLOCK = '2026-06-30T00:00:00.000Z';
const clock = (): Date => new Date(CLOCK);
const MD_HEADER =
  '| Service | README | TRACEABILITY | OpenAPI | Events | Rows | Carried or owned | Covered | Missing | Result |';
const MD_SEPARATOR = '|---|---|---|---|---|---|---|---|---|---|';

describe('buildReport and markdownLines', () => {
  it('reports each service and fails the report when one service fails', async () => {
    await buildPassingIdentity(root);
    await buildService(root, 'people', { traceability: null });

    const report = await buildReport(['identity', 'people'], deps(root), clock);

    expect({ ...report, services: report.services.map(({ service, result }) => [service, result]) }).toEqual({
      sourceSha: SHA,
      generatedBy: GENERATED_BY,
      generatedAt: CLOCK,
      status: 'generated',
      inventory: INVENTORY_PATH,
      passCondition: PASS_CONDITION,
      services: [
        ['identity', 'pass'],
        ['people', 'fail'],
      ],
      result: 'fail',
    });
    expect(markdownLines(report)).toEqual([
      'Status: generated',
      `Generated by: ${GENERATED_BY}`,
      `Generated at: ${CLOCK}`,
      `Inventory: \`${INVENTORY_PATH}\``,
      'Result: **fail**',
      '',
      MD_HEADER,
      MD_SEPARATOR,
      '| identity | ok | ok | ok | 1/1 ok | 5 | 3 | 3 | 0 | pass |',
      '| people | ok | absent | ok | 1/1 ok | — | 3 | 0 | 3 | fail |',
      '',
      `Pass: ${PASS_CONDITION}.`,
      '',
      '## Missing items',
      '',
      '### people',
      '',
      '- `ctl:cusers.listusers` (`admin:cusers.listusers`): no-row',
      '- `ctl:cusers.update{type=2,action=add}` (`admin:cusers.update{type=2,action=add}`): no-row',
      '- `tbl:tusers`: no-row',
      '',
    ]);
  });

  it('renders unpinned, mismatched and absent files, partial events and judged rows', () => {
    const service: ServiceReport = {
      service: 'reporting',
      readme: { path: 'services/reporting/README.md', present: true, sha: null },
      traceability: { path: 'services/reporting/TRACEABILITY.md', present: true, sha: ZERO_SHA, rows: 2 },
      contracts: {
        openapi: { path: 'services/reporting/contracts/openapi.yaml', present: false, sha: null },
        events: [
          { path: 'services/reporting/contracts/events/reporting.changed.v1.json', present: true, sha: OTHER_SHA },
          { path: 'services/reporting/contracts/events/reporting.failed.v1.json', present: true, sha: SHA },
        ],
      },
      inventoryItems: {
        carriedOrOwned: 2,
        covered: 0,
        missing: [
          { id: 'tbl:synthetic.export_job', reason: 'incomplete-row', line: 7, lacks: ['code-path', 'test-ref'] },
          {
            id: 'api:reporting.exports',
            routeKey: 'fixture:reporting/exports',
            reason: 'test-missing',
            line: 8,
            paths: ['test/unit/exports.test.ts'],
          },
        ],
      },
      result: 'fail',
    };
    const report: ReviewabilityReport = {
      sourceSha: SHA,
      generatedBy: GENERATED_BY,
      generatedAt: CLOCK,
      status: 'generated',
      inventory: INVENTORY_PATH,
      passCondition: PASS_CONDITION,
      services: [service],
      result: 'fail',
    };

    const lines = markdownLines(report);

    expect(lines).toContain('| reporting | no SHA | SHA mismatch | absent | 1/2 ok | 2 | 2 | 0 | 2 | fail |');
    expect(lines).toContain('- `tbl:synthetic.export_job`: incomplete-row at line 7 (lacks code-path, test-ref)');
    expect(lines).toContain(
      '- `api:reporting.exports` (`fixture:reporting/exports`): test-missing at line 8: `test/unit/exports.test.ts`',
    );
  });

  it('renders a service without event contracts and states None. when nothing is missing', async () => {
    await buildPassingIdentity(root, { event: null });

    const lines = markdownLines(await buildReport(['identity'], deps(root), clock));

    expect(lines).toContain('| identity | ok | ok | ok | none | 5 | 3 | 3 | 0 | pass |');
    expect(lines.slice(-3)).toEqual(['## Missing items', '', 'None.']);
  });
});

interface CliRun {
  code: number;
  exits: number[];
  output: string;
}

/** Runs `main` through runCli with `argv`, capturing stdout and the exit code. */
async function runCheck(argv: string[]): Promise<CliRun> {
  const chunks: string[] = [];
  const exits: number[] = [];
  const code = await runCli(main, {
    argv,
    command: COMMAND,
    stdout: { write: (chunk: string) => chunks.push(chunk) },
    exit: (exitCode) => exits.push(exitCode),
  });
  return { code, exits, output: chunks.join('') };
}

function summaryLine(run: CliRun): Record<string, unknown> {
  return JSON.parse(run.output) as Record<string, unknown>;
}

/** A checkout at `dir` with the pin, the mini inventory and ownership, and all ten services passing. */
async function buildCheckout(dir: string): Promise<void> {
  await writeTree(dir, {
    'opt2/source-pin.json': PIN_JSON,
    [INVENTORY_PATH]: INVENTORY_JSON,
    [OWNERSHIP_PATH]: OWNERSHIP_JSON,
  });
  for (const service of TEN_SERVICES) {
    const items = EXPECTED_ITEMS[service];
    await buildService(dir, service, {
      traceability: traceabilityFor(service, items.map((id) => coverRow(service, id))),
    });
    await touch(dir, items.flatMap((id) => rowRefs(service, id)));
  }
}

async function readReport(dir: string): Promise<ReviewabilityReport> {
  return JSON.parse(await readFile(path.join(dir, 'reviewability.json'), 'utf8')) as ReviewabilityReport;
}

/** Content and modification time of each checkout report file, `null` when absent. */
async function snapshot(files: readonly string[]): Promise<({ text: string; mtimeMs: number } | null)[]> {
  return Promise.all(
    files.map(async (file) => {
      try {
        return { text: await readFile(file, 'utf8'), mtimeMs: (await stat(file)).mtimeMs };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    }),
  );
}

describe('main', () => {
  let checkout: string;
  let out: string;

  beforeEach(() => {
    checkout = path.join(root, 'checkout');
    out = path.join(root, 'reports');
    vi.stubEnv('OPT2_REPORTS_DIR', out);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('exits 0 and writes reviewability.json and .md when all ten services pass', async () => {
    await buildCheckout(checkout);

    const run = await runCheck(['--root', checkout]);

    expect([run.code, run.exits]).toEqual([0, [0]]);
    expect(summaryLine(run)).toEqual({ command: COMMAND, ok: true, code: 0, result: 'pass', failing: [] });
    const report = await readReport(out);
    expect(report.sourceSha).toBe(SHA);
    expect(report.result).toBe('pass');
    expect(
      report.services.map(({ service, result, inventoryItems }) => [service, result, inventoryItems.carriedOrOwned]),
    ).toEqual(TEN_SERVICES.map((service) => [service, 'pass', EXPECTED_ITEMS[service].length]));
    const markdown = (await readFile(path.join(out, 'reviewability.md'), 'utf8')).split('\n');
    expect(markdown[0]).toBe('# Reviewability');
    expect(markdown[1]).toBe(`Source SHA: ${SHA}`);
  });

  it('exits 1 and names the failing service when one service fails', async () => {
    await buildCheckout(checkout);
    await rm(path.join(checkout, 'services/people/README.md'));

    const run = await runCheck(['--root', checkout]);

    expect([run.code, run.exits]).toEqual([1, [1]]);
    expect(summaryLine(run)).toEqual({ command: COMMAND, ok: false, code: 1, result: 'fail', failing: ['people'] });
    const report = await readReport(out);
    expect(report.sourceSha).toBe(SHA);
    expect(report.services.filter((service) => service.result === 'fail').map((service) => service.service)).toEqual([
      'people',
    ]);
  });

  it('writes nothing under the checkout opt2/reports', async () => {
    const files = [opt2Path('reports', 'reviewability.json'), opt2Path('reports', 'reviewability.md')];
    const before = await snapshot(files);
    await buildCheckout(checkout);

    await runCheck(['--root', checkout]);

    expect(await snapshot(files)).toEqual(before);
  });

  it('takes its root, environment and clock from deps and checks the named services in plan order', async () => {
    await buildCheckout(checkout);
    const elsewhere = path.join(root, 'elsewhere');

    await expect(
      main(['--service', 'people', '--service', 'identity'], {
        root: checkout,
        env: { OPT2_REPORTS_DIR: elsewhere },
        clock,
      }),
    ).resolves.toEqual({ code: 0, summary: { result: 'pass', failing: [] } });

    const report = await readReport(elsewhere);
    expect(report.services.map((service) => service.service)).toEqual(['identity', 'people']);
    expect(report.generatedAt).toBe(CLOCK);
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prints the summary and writes no report with --no-write', async () => {
    await buildCheckout(checkout);

    const run = await runCheck(['--root', checkout, '--no-write']);

    expect(summaryLine(run)).toEqual({ command: COMMAND, ok: true, code: 0, result: 'pass', failing: [] });
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each<[string[], string | undefined]>([
    [['--service', 'stub'], `--service stub: not one of ${TEN_SERVICES.join(', ')}`],
    [['--root', ''], '--root needs a directory'],
    [['--format', 'json'], undefined],
  ])('exits 2 with a UsageError for %j', async (argv, message) => {
    await buildCheckout(checkout);

    const run = await runCheck(['--root', checkout, ...argv]);

    expect([run.code, run.exits]).toEqual([2, [2]]);
    expect(summaryLine(run)).toMatchObject({ command: COMMAND, ok: false, code: 2, error: { type: 'UsageError' } });
    if (message !== undefined) expect(summaryLine(run)).toMatchObject({ error: { message } });
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prints its help and exits 0 for --help', async () => {
    const run = await runCheck(['--help']);

    expect([run.code, run.exits]).toEqual([0, [0]]);
    const usage = 'check-reviewability [--root <dir>] [--service <name>]... [--no-write] [--help]';
    expect(run.output.split('\n')[0]).toBe(usage);
  });

  it('exits 1 naming the inventory when the checkout has none', async () => {
    await buildCheckout(checkout);
    await rm(path.join(checkout, INVENTORY_PATH));

    const run = await runCheck(['--root', checkout]);

    expect([run.code, run.exits]).toEqual([1, [1]]);
    expect(summaryLine(run)).toMatchObject({ ok: false, code: 1, error: { type: 'Error' } });
    expect(JSON.stringify(summaryLine(run))).toContain('legacy-inventory.json');
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
