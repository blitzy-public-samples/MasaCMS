import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GeneratedFinding, InventoryVariant, LegacyInventory } from '../../src/inventory/generate.js';
import {
  INVENTORY_TITLE,
  renderInventoryMarkdown,
  type ControllerVariantView,
  type DisposedItem,
  type InventoryFinding,
  type RenderableInventory,
  type SourceRef,
  type WriteRecordView,
} from '../../src/inventory/render-md.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const SERVER = 'core/mura/content/contentServer.cfc';

const src = (path: string, start: number, end = start): SourceRef => ({ path, lines: [start, end] });

const carry = (owner: string): Omit<DisposedItem, 'id'> => ({
  owningService: owner,
  owners: [owner],
  disposition: 'carry',
  dispositionStep: 5,
  expected: null,
  correction: null,
  exceptionRef: null,
});

function variant(id: string, over: Partial<ControllerVariantView> = {}): ControllerVariantView {
  return {
    id,
    source: src('admin/core/controllers/cusers.cfc', 290, 353),
    ...carry('people'),
    routeKey: id.replace(/^ctl:/, 'admin:'),
    csrfValidation: 'validates',
    csrfContext: 'rc.userid',
    responseMode: 'redirect',
    contentType: null,
    ...over,
  };
}

function miniInventory(): RenderableInventory {
  return {
    generatedBy: 'harness/src/inventory/generate.ts',
    extractedFrom: { method: 'git archive', sha: SHA },
    counts: {
      extra: 2,
      notes: { dispositions: 'Tallied | summed' },
      tables: { live: null, staticTotal: 73, liveStatus: 'pending-run' },
      coreMuraActionFiles: 21,
      entities: { zeta: 1, dynamic: null, 'orm-base': 4, liveStatus: 'pending-run' },
    },
    entities: [{ id: 'ent:userBean', source: src('core/mura/user/userBean.cfc', 1, 900) }],
    services: [],
    controllers: [
      {
        id: 'ctl:carch',
        ...carry('strategies-content'),
        circuit: 'carch',
        isBase: false,
        actions: [
          {
            variants: [
              variant('ctl:carch.update{upload=image}', {
                ...carry('strategies-content'),
                legacyWrite: true,
                haltedBy: 'EX-FILE-RENDITION',
                csrfContext: 'rc.contentid & "delete" | rc.parentid',
                responseMode: 'fragment',
                contentType: 'text/html',
              }),
            ],
          },
        ],
      },
      { id: 'ctl:controller', ...carry('none'), owningService: null, owners: [], circuit: 'controller', isBase: true, actions: [] },
      {
        id: 'ctl:cusers',
        ...carry('people'),
        disposition: null,
        dispositionStep: null,
        circuit: 'cusers',
        isBase: false,
        actions: [
          {
            variants: [
              variant('ctl:cusers.update{type=2,action=add}'),
              variant('ctl:cusers.update{type=2,action=delete}', {
                owningService: 'people',
                ownerBasis: 'spanning',
                owners: ['identity', 'people'],
                disposition: 'decision',
                dispositionStep: 3,
                withheld: true,
              }),
            ],
          },
        ],
      },
    ],
    coreMuraActionSearch: {
      query: 'muraAction',
      scope: 'core/** excluding core/vendor',
      handlers: 0,
      filesMentioning: 3,
      files: [{ use: 'reads-admin-action' }, { use: 'builds-admin-url' }, { use: 'builds-admin-url' }],
      dispatcher: src('admin/Application.cfc', 151, 166),
    },
    frontEnd: [
      {
        id: 'fe:appreload',
        ...carry('strategies-content'),
        disposition: 'legacy-served',
        dispositionStep: 4,
        exceptionRef: 'EX-SEC-APPRELOAD',
        entry: 'application reload by ?<appreloadkey>',
        csrfValidation: 'none',
        csrfContext: null,
        windowed: true,
        sessionEffects: 'none',
      },
    ],
    scheduledJobs: [
      {
        id: 'job:sitemonitor',
        ...carry('programs-sites'),
        routeKey: 'sitemonitor:run',
        registration: {
          type: 'ACF HTTPRequest task',
          url: '/index.cfm/_api/sitemonitor/',
          startTime: '00:15',
          intervalSeconds: 900,
          requestTimeoutSeconds: 600,
          condition: 'ping is true',
          pingDefault: { value: false },
          liveTask: null,
          livePing: null,
          liveStatus: 'pending-run',
        },
        semantics: {
          cursor: { rule: 'lastMonitored defaults to now - 1 minute', source: src(SERVER, 676), endSource: src(SERVER, 745) },
          purgeWindow: { rule: 'display-window purge covers [lastMonitored, now]', source: src(SERVER, 702, 711) },
          bounceDedupeIneffective: true,
        },
        steps: [
          {
            id: 'job:sitemonitor.bounces',
            source: src(SERVER, 689, 699),
            ...carry('sample-module'),
            disposition: 'legacy-served',
            dispositionStep: 4,
            order: 4,
            call: 'emailManager.trackBounces per site',
            targetMechanism: 'legacy only; no target service owns the mail tables',
            stateThisRun: null,
          },
        ],
      },
    ],
    routes: [
      {
        id: 'api:content.findone',
        ...carry('strategies-content'),
        kind: 'api-entity-method',
        routeKey: 'api:content.findone',
        csrfValidation: 'none',
        csrfContext: null,
        decisionListRef: null,
      },
      {
        id: 'api:file.save{upload=image}',
        ...carry('strategies-content'),
        exceptionRef: 'EX-FILE-RENDITION',
        kind: 'api-entity-method',
        routeKey: 'api:file.save{upload=image}',
        csrfValidation: 'validates',
        csrfContext: 'arguments.id',
        decisionListRef: null,
      },
      {
        id: 'api:user.delete',
        ...carry('people'),
        disposition: 'decision',
        dispositionStep: 3,
        withheld: true,
        kind: 'api-entity-method',
        routeKey: 'api:user.delete',
        csrfValidation: 'validates',
        csrfContext: 'arguments.id',
        decisionListRef: 'opt2/decision-list.json#api:user.delete',
      },
      {
        id: 'fix:people/persons/{id}/archive@post',
        ...carry('people'),
        dispositionStep: 'fixture-definition',
        kind: 'fixture',
        routeKey: 'fixture:people/persons/{id}/archive@post',
        csrfValidation: 'validates',
        csrfContext: '',
        decisionListRef: null,
      },
      {
        id: 'rte:/_api/json/v1',
        ...carry('none'),
        owningService: null,
        owners: [],
        kind: 'api-family',
        routeKey: null,
        csrfValidation: null,
        csrfContext: null,
        decisionListRef: null,
      },
      {
        id: 'rte:soap:user',
        ...carry('none'),
        owningService: null,
        owners: [],
        disposition: 'retired',
        dispositionStep: 1,
        kind: 'soap',
        routeKey: null,
        csrfValidation: null,
        csrfContext: null,
        decisionListRef: null,
      },
    ],
    tables: [
      {
        id: 'tbl:fb_*',
        ...carry('none'),
        owningService: null,
        owners: [],
        disposition: 'decision',
        dispositionStep: 2,
        withheld: true,
        origin: 'dynamic',
        hasSiteId: null,
        hasPrimaryKey: null,
        bootstrapHasPrimaryKey: null,
        ruleSteps: [5],
        writers: [],
      },
      {
        id: 'tbl:tsettings',
        ...carry('programs-sites'),
        origin: 'bootstrap',
        hasSiteId: false,
        staticHasSiteId: true,
        hasPrimaryKey: true,
        staticHasPrimaryKey: false,
        bootstrapHasPrimaryKey: false,
        ruleSteps: [1],
        writers: [{}, {}],
      },
      {
        id: 'tbl:tusers',
        ...carry('identity'),
        owningService: null,
        owners: ['identity', 'people'],
        origin: 'bootstrap',
        hasSiteId: true,
        staticHasSiteId: true,
        hasPrimaryKey: true,
        staticHasPrimaryKey: true,
        bootstrapHasPrimaryKey: true,
        ruleSteps: [1, 3],
        writers: [{}],
      },
    ],
    relations: [
      { id: 'rel:a', kind: 'program-fold' },
      { id: 'rel:b', kind: 'orm-fk' },
      { id: 'rel:c', kind: 'orm-fk' },
    ],
    storedProcedureCheck: { static: { count: 0 }, live: { total: null }, foreignKeys: { static: 0 } },
  };
}

const ROUTE_HEADER = ['| Id | Route key | Owner | Disposition (step) | CSRF | Notes |', '| --- | --- | --- | --- | --- | --- |'];

const EXPECTED: readonly string[] = [
  `Extracted from: git archive ${SHA} · generator: harness/src/inventory/generate.ts · live fields: pending-run`,
  '',
  '## Counts',
  '',
  '| Section | Item | Count |',
  '| --- | --- | --- |',
  '| entities | orm-base | 4 |',
  '| entities | dynamic | pending-run |',
  '| entities | zeta | 1 |',
  '| coreMuraActionFiles | — | 21 |',
  '| tables | staticTotal | 73 |',
  '| tables | live | pending-run |',
  '| notes | dispositions | Tallied \\| summed |',
  '| extra | — | 2 |',
  '',
  '## Admin controllers',
  '',
  '| Id | Route key | Owner | Disposition (step) | CSRF | Response mode |',
  '| --- | --- | --- | --- | --- | --- |',
  '| `ctl:carch.update{upload=image}` | `admin:carch.update{upload=image}` | strategies-content | carry (5, legacy-write) `EX-FILE-RENDITION` | validates `rc.contentid & "delete" \\| rc.parentid` | fragment (text/html) |',
  '| `ctl:controller` | — | — | carry (5) | — | — |',
  '| `ctl:cusers.update{type=2,action=add}` | `admin:cusers.update{type=2,action=add}` | people | carry (5) | validates `rc.userid` | redirect |',
  '| `ctl:cusers.update{type=2,action=delete}` | `admin:cusers.update{type=2,action=delete}` | spans identity, people | decision (3, withheld) | validates `rc.userid` | redirect |',
  '',
  'Search for `muraAction` in `core/** excluding core/vendor`: 0 handlers; 3 files mention it (builds-admin-url 2, reads-admin-action 1); admin dispatch at `admin/Application.cfc:151-166`.',
  '',
  '## Route families',
  '',
  ...ROUTE_HEADER,
  '| `rte:/_api/json/v1` | — | — | carry (5) | — | — |',
  '',
  '## JSON API entities and methods',
  '',
  ...ROUTE_HEADER,
  '| `api:content.findone` | `api:content.findone` | strategies-content | carry (5) | none | — |',
  '| `api:file.save{upload=image}` | `api:file.save{upload=image}` | strategies-content | carry (5) | validates `arguments.id` | `EX-FILE-RENDITION` |',
  '| `api:user.delete` | `api:user.delete` | people | decision (3, withheld) | validates `arguments.id` | `opt2/decision-list.json#api:user.delete` |',
  '',
  '## OAuth, SOAP and fixture routes',
  '',
  ...ROUTE_HEADER,
  '| `fix:people/persons/{id}/archive@post` | `fixture:people/persons/{id}/archive@post` | people | carry (fixture-definition) | validates | — |',
  '| `rte:soap:user` | — | — | retired (1) | — | — |',
  '',
  '## Public front end',
  '',
  '| Id | Entry | Owner | Disposition (step) | CSRF | Windowed | Session effects |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| `fe:appreload` | application reload by ?\\<appreloadkey> | strategies-content | legacy-served (4) `EX-SEC-APPRELOAD` | none | yes | none |',
  '',
  '## Site monitor',
  '',
  '`job:sitemonitor` (`sitemonitor:run`, programs-sites, carry (5)): ACF HTTPRequest task to `/index.cfm/_api/sitemonitor/`, start 00:15, interval 900 s, request timeout 600 s, registered only when ping is true; `ping` default `false`; live task: pending-run; live `ping`: pending-run.',
  '',
  `- Cursor: lastMonitored defaults to now - 1 minute (\`${SERVER}:676\`, \`${SERVER}:745\`)`,
  `- Purge window: display-window purge covers [lastMonitored, now] (\`${SERVER}:702-711\`)`,
  '- Bounce dedupe ineffective: yes',
  '',
  '| Order | Step | Call | Owner | Disposition (step) | Target mechanism | State this run |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| 4 | `job:sitemonitor.bounces` | emailManager.trackBounces per site | sample-module | legacy-served (4) | legacy only; no target service owns the mail tables | — |',
  '',
  '## Write sets',
  '',
  'None.',
  '',
  '## Tables',
  '',
  '| Id | Origin | siteID | PK | Owner(s) | Rule step(s) | Disposition (step) | Writers |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| `tbl:fb_*` | dynamic | pending-run | pending-run | — | 5 | decision (2, withheld) | 0 |',
  '| `tbl:tsettings` | bootstrap | no (static: yes) | yes (bootstrap: no) (static: no) | programs-sites | 1 | carry (5) | 2 |',
  '| `tbl:tusers` | bootstrap | yes | yes | identity, people | 1, 3 | carry (5) | 1 |',
  '',
  '## Relations and stored procedures',
  '',
  '- Relations: 3 (program-fold 1, orm-fk 2)',
  '- Stored procedures: static 0, live pending-run; foreign keys: static 0',
];

// Cells of a table row, split on unescaped pipes.
function cells(line: string): string[] {
  return line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
}

function rowOf(lines: readonly string[], id: string): string[] {
  const line = lines.find((l) => l.startsWith(`| \`${id}\` |`));
  if (line === undefined) throw new Error(`no row for ${id}`);
  return cells(line);
}

function withVariant(over: Partial<ControllerVariantView>): RenderableInventory {
  const inv = miniInventory();
  const v = variant('ctl:cusers.update{type=2,action=update}', over);
  return { ...inv, controllers: [{ ...inv.controllers[2]!, actions: [{ variants: [v] }] }] };
}

describe('renderInventoryMarkdown', () => {
  it('renders the committed section order and row formats', () => {
    const { title, lines } = renderInventoryMarkdown(miniInventory());
    expect(title).toBe(INVENTORY_TITLE);
    expect(lines).toEqual(EXPECTED);
    expect(lines.some((l) => l.startsWith('# ') || l.startsWith('Source SHA:'))).toBe(false);
  });

  it('is deterministic and independent of count key order', () => {
    const inv = miniInventory();
    const reversed = Object.fromEntries(Object.entries(inv.counts).reverse());
    expect(renderInventoryMarkdown(inv)).toEqual(renderInventoryMarkdown(miniInventory()));
    expect(renderInventoryMarkdown({ ...inv, counts: reversed }).lines).toEqual(EXPECTED);
  });

  it.each([
    ['a correction against the item expectation', { correction: {}, expected: { disposition: 'decision' } }, 'carry (5) (corrected; expected decision)'],
    [
      'a correction carrying its own expectation',
      { correction: { expected: { disposition: 'legacy-served' } }, expected: { disposition: 'carry' } },
      'carry (5) (corrected; expected legacy-served)',
    ],
    ['an owner-only correction', { correction: { expected: {} } }, 'carry (5) (corrected; expected carry)'],
    ['a halt without a legacy write', { haltedBy: 'EX-X' }, 'carry (5) `EX-X`'],
    ['a legacy write without a halt', { legacyWrite: true }, 'carry (5)'],
    ['no step', { dispositionStep: null }, 'carry'],
    ['no disposition', { disposition: null }, '—'],
  ] satisfies [string, Partial<ControllerVariantView>, string][])('flags %s in the disposition cell', (_name, over, cell) => {
    const row = rowOf(renderInventoryMarkdown(withVariant(over)).lines, 'ctl:cusers.update{type=2,action=update}');
    expect(row[3]).toBe(cell);
  });

  it('keeps one table row per value with escaped pipes, folded lines and fenced backticks', () => {
    const inv = withVariant({ csrfContext: 'a | b\n    & `c`', responseMode: 'json', contentType: 'text/html', owningService: 'x|y' });
    const row = rowOf(renderInventoryMarkdown(inv).lines, 'ctl:cusers.update{type=2,action=update}');
    expect(row).toHaveLength(6);
    expect(row[2]).toBe('x\\|y');
    expect(row[4]).toBe('validates `` a \\| b & `c` ``');
    expect(row[5]).toBe('json (text/html)');
  });

  it('renders live values, a string extraction origin and jobs without semantics', () => {
    const inv = miniInventory();
    const [job] = inv.scheduledJobs;
    const live = {
      ...job!,
      registration: { ...job!.registration, pingDefault: null, liveTask: { url: '/x', name: 'siteMonitor' }, livePing: true, liveStatus: 'live' },
    };
    const bare = { ...job!, id: 'job:other', semantics: {}, registration: { ...job!.registration, liveStatus: 'live' } };
    const { lines } = renderInventoryMarkdown({
      ...inv,
      extractedFrom: `git archive ${SHA}`,
      counts: { ...inv.counts, liveStatus: 'live' },
      scheduledJobs: [live, bare],
    });
    expect(lines[0]).toBe(`Extracted from: git archive ${SHA} · generator: harness/src/inventory/generate.ts · live fields: live`);
    expect(lines).not.toContain('| liveStatus | — | live |');
    const liveLine = lines.find((l) => l.startsWith('`job:sitemonitor`'));
    expect(liveLine).toContain('`ping` default —; live task: `{"name":"siteMonitor","url":"/x"}`; live `ping`: `true`.');
    const bareAt = lines.findIndex((l) => l.startsWith('`job:other`'));
    expect(lines[bareAt]).toContain('live task: none; live `ping`: none.');
    expect(lines.slice(bareAt + 1, bareAt + 3)).toEqual(['', '| Order | Step | Call | Owner | Disposition (step) | Target mechanism | State this run |']);
    expect(lines[bareAt - 1]).toBe('');
  });

  it('marks the live status empty when no count section carries one', () => {
    const { lines } = renderInventoryMarkdown({ ...miniInventory(), counts: { relations: 3 } });
    expect(lines[0]).toMatch(/ · live fields: —$/);
    expect(lines.slice(4, 7)).toEqual(['| Section | Item | Count |', '| --- | --- | --- |', '| relations | — | 3 |']);
  });

  it('lists unreachable remote methods with source and guard after the public front end, and omits the section when absent', () => {
    const guard = 'core/mura/Application.cfc:76-81';
    const { lines } = renderInventoryMarkdown({
      ...miniInventory(),
      unreachableRemote: [
        {
          id: 'fe:unreachable:core/mura/content/contentcommentbean.cfc#flag',
          source: src('core/mura/content/contentCommentBean.cfc', 512, 530),
          guard,
          ...carry('none'),
          owningService: null,
          owners: [],
          disposition: 'retired',
          dispositionStep: 1,
        },
      ],
    });
    const at = lines.indexOf('## Unreachable remote methods');
    expect(lines.slice(at - 2, at + 6)).toEqual([
      EXPECTED[EXPECTED.indexOf('## Site monitor') - 2],
      '',
      '## Unreachable remote methods',
      '',
      '| Id | Source | Guard | Owner | Disposition (step) |',
      '| --- | --- | --- | --- | --- |',
      `| \`fe:unreachable:core/mura/content/contentcommentbean.cfc#flag\` | \`core/mura/content/contentCommentBean.cfc:512-530\` | \`${guard}\` | — | retired (1) |`,
      '',
    ]);
    expect(lines[at + 6]).toBe('## Site monitor');
    expect(renderInventoryMarkdown(miniInventory()).lines).not.toContain('## Unreachable remote methods');
  });

  it('lists unoriented relations apart from the ordered relations, says so when there are none, and omits the section when absent', () => {
    const heading = '## Unoriented relations (not ordered)';
    const unorientedRelations = [
      { id: 'rel:tmailinglist.mlid->tmailinglistmembers.mlid', kind: 'dao-join', source: src('core/mura/mailinglist/memberDAO.cfc', 42) },
    ];
    const { lines } = renderInventoryMarkdown({ ...miniInventory(), unorientedRelations });
    expect(lines.indexOf(heading)).toBe(lines.indexOf('## Relations and stored procedures') + section(lines, '## Relations and stored procedures').length + 1);
    expect(section(lines, heading)).toEqual([
      '',
      '| Id | Kind | Source |',
      '| --- | --- | --- |',
      '| `rel:tmailinglist.mlid->tmailinglistmembers.mlid` | dao-join | `core/mura/mailinglist/memberDAO.cfc:42` |',
    ]);
    expect(section(renderInventoryMarkdown({ ...miniInventory(), unorientedRelations: [] }).lines, heading)).toEqual(['', 'None.']);
    expect(renderInventoryMarkdown(miniInventory()).lines).not.toContain(heading);
  });

  it('lists the units of each writing entry point, then every write record by unit, table and operation with merged sources', () => {
    const inv = miniInventory();
    const record = (unit: string, legacyTable: string | null, op: string, source: SourceRef): WriteRecordView => ({ unit, legacyTable, op, source });
    const dao = 'core/mura/user/userDAO.cfc';
    const login = record('identity.login_state', 'tusers', 'update', src('core/mura/user/userUtility.cfc', 367, 370));
    const [job] = inv.scheduledJobs;
    const [step] = job!.steps;
    const { lines } = renderInventoryMarkdown({
      ...inv,
      controllers: [
        { ...inv.controllers[2]!, actions: [{ variants: [variant('ctl:cusers.update{type=2,action=add}', { writeSet: [record('people.person', 'tusers', 'update', src(dao, 459, 470)), record('people.person', 'tusers', 'update', src(dao, 120, 130)), login] })] }] },
      ],
      routes: [{ ...inv.routes[0]!, id: 'api:user.save', writeSet: [record('people.person', 'tusers', 'update', src(dao, 120, 130)), record('file-store', null, 'write', src('core/mura/file/fileManager.cfc', 88))] }],
      frontEnd: [{ ...inv.frontEnd[0]!, writeSet: [] }],
      scheduledJobs: [{ ...job!, steps: [{ ...step!, writeSet: [login, record('identity.login_state', 'tusers', 'update', src(dao, 698, 701))] }] }],
    });
    expect(section(lines, '## Write sets')).toEqual([
      '',
      'Units each writing entry point reaches:',
      '',
      '| Id | Units |',
      '| --- | --- |',
      '| `api:user.save` | file-store, people.person |',
      '| `ctl:cusers.update{type=2,action=add}` | identity.login_state, people.person |',
      '| `job:sitemonitor.bounces` | identity.login_state |',
      '',
      'Sources of the write records, by unit, table and operation:',
      '',
      '| Unit | Table | Op | Sources |',
      '| --- | --- | --- | --- |',
      '| `file-store` | — | write | `core/mura/file/fileManager.cfc:88` |',
      '| `identity.login_state` | `tusers` | update | `core/mura/user/userDAO.cfc:698-701; core/mura/user/userUtility.cfc:367-370` |',
      '| `people.person` | `tusers` | update | `core/mura/user/userDAO.cfc:120-130, 459-470` |',
      '',
    ]);
  });

  it('omits the findings section when the inventory carries none, and says so when the list is empty', () => {
    expect(renderInventoryMarkdown(miniInventory()).lines).not.toContain('## Findings');
    expect(renderInventoryMarkdown({ ...miniInventory(), findings: [] }).lines.slice(-3)).toEqual(['## Findings', '', 'None.']);
  });

  it('lists findings with their item id and source', () => {
    const findings: InventoryFinding[] = [
      { kind: 'correction', id: 'ent:userBean', detail: 'AAP expects carry, the rule computes decision at step 3' },
      { kind: 'unresolved-call', id: 'svc:x', source: src('core/mura/x.cfc', 7), detail: 'getBean(name)' },
      { kind: 'decision-list-mismatch', id: 'job:sitemonitor.bounces', detail: 'no matching action variant' },
      { kind: 'unkeyed-entry', id: 'tbl:tusers', source: { path: 'core/x.cfm', lines: [] } },
      { kind: 'count-difference', measure: 'withSiteIdStatic', aapFigure: 54, computed: 55 },
      { kind: 'count-difference', measure: 'tables.withSiteId', aapFigure: 54, computed: 55, detail: 'live catalog 54' },
      { kind: 'unclassified-gate', id: 'ctl:nosuch' },
    ];
    const { lines } = renderInventoryMarkdown({ ...miniInventory(), findings });
    const at = lines.indexOf('## Findings');
    expect(lines.slice(at)).toEqual([
      '## Findings',
      '',
      '| Kind | Id | Source | Detail |',
      '| --- | --- | --- | --- |',
      '| correction | `ent:userBean` | `core/mura/user/userBean.cfc:1-900` | AAP expects carry, the rule computes decision at step 3 |',
      '| unresolved-call | `svc:x` | `core/mura/x.cfc:7` | getBean(name) |',
      `| decision-list-mismatch | \`job:sitemonitor.bounces\` | \`${SERVER}:689-699\` | no matching action variant |`,
      '| unkeyed-entry | `tbl:tusers` | `core/x.cfm` | — |',
      '| count-difference | `withSiteIdStatic` | — | AAP 54, computed 55 |',
      '| count-difference | `tables.withSiteId` | — | AAP 54, computed 55; live catalog 54 |',
      '| unclassified-gate | `ctl:nosuch` | — | — |',
    ]);
  });
});

const fixture = JSON.parse(
  await fs.readFile(fileURLToPath(new URL('../fixtures/inventory/mini-inventory.json', import.meta.url)), 'utf8'),
) as LegacyInventory;

const SECTION_HEADINGS: readonly string[] = [
  '## Counts',
  '## Admin controllers',
  '## Route families',
  '## JSON API entities and methods',
  '## OAuth, SOAP and fixture routes',
  '## Public front end',
  '## Site monitor',
  '## Write sets',
  '## Tables',
  '## Relations and stored procedures',
  '## Findings',
];

// Lines between `heading` and the next section heading.
function section(lines: readonly string[], heading: string): string[] {
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no section ${heading}`);
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, next < 0 ? undefined : next);
}

// Ids of the item rows, in row order.
function rowIds(lines: readonly string[]): string[] {
  return lines.flatMap((l) => /^\| `([^`]+)` \|/.exec(l)?.[1] ?? []);
}

function byId<T extends { id: string }>(items: readonly T[], id: string): T {
  const item = items.find((i) => i.id === id);
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
}

function variantOf(inv: LegacyInventory, id: string): InventoryVariant {
  return byId(
    inv.controllers.flatMap((c) => c.actions.flatMap((a) => a.variants)),
    id,
  );
}

describe('renderInventoryMarkdown over the mini inventory fixture', () => {
  it('returns body lines only, leaving the title and Source SHA line to writeMarkdown', () => {
    const { title, lines } = renderInventoryMarkdown(fixture);
    expect(title).toBe(INVENTORY_TITLE);
    expect(lines.every((l) => typeof l === 'string')).toBe(true);
    expect(lines.some((l) => l.startsWith('# Legacy inventory') || l.startsWith('Source SHA:'))).toBe(false);
  });

  it('renders every section heading once, in the committed order', () => {
    const { lines } = renderInventoryMarkdown(fixture);
    const at = SECTION_HEADINGS.map((h) => lines.indexOf(h));
    expect(at.every((index, i) => index > (at[i - 1] ?? -1))).toBe(true);
    expect(lines.filter((l) => l.startsWith('## '))).toHaveLength(SECTION_HEADINGS.length);
  });

  it('shows every count of inventory.counts, with the live status in the header line', () => {
    const { lines } = renderInventoryMarkdown(fixture);
    const expected: string[] = [];
    for (const [name, value] of Object.entries(fixture.counts)) {
      if (name === 'liveStatus') continue;
      const items: [string, unknown][] = typeof value === 'object' && value !== null ? Object.entries(value) : [['—', value]];
      for (const [item, n] of items) expected.push(`| ${name} | ${item} | ${n === null ? 'pending-run' : String(n)} |`);
    }
    const rows = section(lines, '## Counts').filter((l) => l.startsWith('| ') && !/^\| (Section|---) \|/.test(l));
    expect(rows.sort()).toEqual(expected.sort());
    expect(lines[0]).toBe(
      `Extracted from: git archive ${fixture.sourceSha} · generator: ${fixture.generatedBy} · live fields: ${fixture.counts.liveStatus}`,
    );
  });

  it('renders the people roster variants with owner, disposition, CSRF and response mode', () => {
    const controllers = section(renderInventoryMarkdown(fixture).lines, '## Admin controllers');
    expect(rowOf(controllers, 'ctl:cusers.update{type=2,action=add}')).toEqual([
      '`ctl:cusers.update{type=2,action=add}`',
      '`admin:cusers.update{type=2,action=add}`',
      'people',
      'carry (5)',
      'validates `rc.userid`',
      'redirect',
    ]);
    expect(rowOf(controllers, 'ctl:cusers.update{type=2,action=delete}').slice(2, 4)).toEqual([
      'spans identity, people',
      'decision (3, withheld)',
    ]);
  });

  it('renders legacy-served email actions and JSON API entity methods in their own sections', () => {
    const { lines } = renderInventoryMarkdown(fixture);
    expect(rowOf(section(lines, '## Admin controllers'), 'ctl:cemail.list').slice(2)).toEqual([
      'sample-module',
      'legacy-served (4)',
      'none',
      'page (text/html)',
    ]);
    const api = section(lines, '## JSON API entities and methods');
    expect(rowOf(api, 'api:content.findone').slice(1, 4)).toEqual(['`api:content.findone`', 'strategies-content', 'carry (5)']);
    expect(rowIds(section(lines, '## Route families'))).toEqual([]);
    expect(rowIds(section(lines, '## OAuth, SOAP and fixture routes'))).toEqual([]);
  });

  it('lists every table with its owners, rule steps and writer count', () => {
    const inv = structuredClone(fixture);
    const memb = byId(inv.tables, 'tbl:tusersmemb');
    inv.tables.push({
      ...structuredClone(memb),
      id: 'tbl:tcontent',
      table: 'tcontent',
      owningService: 'strategies-content',
      owners: ['strategies-content'],
      ownershipOwner: 'strategies-content',
      ruleSteps: [1],
      hasSiteId: true,
      writers: [...memb.writers, ...memb.writers, ...memb.writers],
    });
    const tables = section(renderInventoryMarkdown(inv).lines, '## Tables');
    expect(byId(fixture.tables, 'tbl:tusers').ownershipOwner).toBe('split');
    expect(rowOf(tables, 'tbl:tusers')).toEqual(['`tbl:tusers`', 'bootstrap', 'yes', 'yes', 'identity, people', '1', 'carry (5)', '1']);
    expect(rowOf(tables, 'tbl:tusersmemb').slice(2)).toEqual(['no', 'yes', 'identity', '2', 'carry (5)', '1']);
    expect(rowOf(tables, 'tbl:tcontent').slice(4)).toEqual(['strategies-content', '1', 'carry (5)', '3']);
    expect(rowIds(tables)).toEqual(['tbl:tusers', 'tbl:tusersmemb', 'tbl:tcontent']);
  });

  it('escapes a pipe inside a cell without adding a column', () => {
    const inv = structuredClone(fixture);
    variantOf(inv, 'ctl:cemail.list').csrfContext = 'rc.siteid | rc.emailid';
    const row = rowOf(section(renderInventoryMarkdown(inv).lines, '## Admin controllers'), 'ctl:cemail.list');
    expect(row).toHaveLength(6);
    expect(row[4]).toBe('none `rc.siteid \\| rc.emailid`');
  });

  it('flags a corrected action inline with its expected disposition', () => {
    const inv = structuredClone(fixture);
    variantOf(inv, 'ctl:cusers.listusers').correction = {
      expected: { disposition: 'legacy-served' },
      computed: { disposition: 'carry', owningService: 'people' },
      step: 5,
      basis: 'area owner people is a migrated service',
    };
    const row = rowOf(section(renderInventoryMarkdown(inv).lines, '## Admin controllers'), 'ctl:cusers.listusers');
    expect(row[3]).toBe('carry (5) (corrected; expected legacy-served)');
  });

  it('flags an unclassified gate on its circuit through the generator finding only', () => {
    const inv = structuredClone(fixture);
    const cemail = byId(inv.controllers, 'ctl:cemail');
    const gate = { ...cemail.requiredRole, classification: null, pattern: null, unclassified: true };
    cemail.requiredRole = gate;
    cemail.gates = [{ ...gate, actions: null }];
    expect(renderInventoryMarkdown(inv).lines).toEqual(renderInventoryMarkdown(fixture).lines);

    const finding: GeneratedFinding = {
      kind: 'unclassified-gate',
      id: 'ctl:cemail',
      source: gate.source,
      detail: 'before() gate of cemail for every action matches no extractor pattern',
    };
    inv.findings.push(finding);
    const last = section(renderInventoryMarkdown(inv).lines, '## Findings').at(-1) ?? '';
    expect(cells(last)).toEqual(['unclassified-gate', '`ctl:cemail`', '`admin/core/controllers/cemail.cfc:83-85`', finding.detail]);
  });

  it('flags unkeyed entries with an empty route-key cell and a findings row', () => {
    const inv = structuredClone(fixture);
    variantOf(inv, 'ctl:cemail.list').routeKey = '';
    const route = byId(inv.routes, 'api:content.findone');
    route.routeKey = null;
    inv.findings.push({ kind: 'unkeyed-entry', id: route.id, source: route.source, detail: `${route.kind} route has no platform route key` });
    const { lines } = renderInventoryMarkdown(inv);
    expect(rowOf(section(lines, '## Admin controllers'), 'ctl:cemail.list')[1]).toBe('—');
    expect(rowOf(section(lines, '## JSON API entities and methods'), route.id)[1]).toBe('—');
    expect(section(lines, '## Findings')).toContain(
      '| unkeyed-entry | `api:content.findone` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2292-2384` | api-entity-method route has no platform route key |',
    );
  });

  it('renders the decision-list mismatches of the fixture as findings rows', () => {
    const findings = section(renderInventoryMarkdown(fixture).lines, '## Findings');
    const mismatches = findings.filter((l) => l.startsWith('| decision-list-mismatch |')).map((l) => cells(l).slice(1, 3));
    expect(mismatches).toEqual([
      ['`ctl:clogin.login`', '`admin/core/controllers/clogin.cfc:101-113`'],
      ['`fe:doaction=login`', '`core/mura/Handler/standardEventsHandler.cfc:540-554`'],
    ]);
  });

  it('flags only the fixture items that carry a correction', () => {
    const { lines } = renderInventoryMarkdown(fixture);
    const flagged = lines.filter((l) => l.includes('(corrected; expected')).map((l) => /`([^`]+)`/.exec(l)?.[1]);
    expect(flagged).toEqual(['ctl:clogin.login', 'fe:doaction=login', 'job:sitemonitor.cache-purge']);
    const findingRows = section(lines, '## Findings').filter((l) => /^\| [a-z-]+ \| `/.test(l));
    expect(findingRows.map((l) => cells(l)[0])).toEqual(fixture.findings.map((f) => f.kind));
  });

  it('renders a live procedure check and empty optional facts', () => {
    const inv = structuredClone(fixture);
    inv.storedProcedureCheck.live = {
      procedures: 0,
      triggers: 0,
      databaseTriggers: 0,
      functions: 0,
      total: 0,
      excludedSchemas: ['synthetic'],
      takenBeforeFixtures: true,
      checkedAt: '2026-06-30T00:00:00.000Z',
      objects: [],
    };
    inv.relations = [];
    inv.coreMuraActionSearch = { ...inv.coreMuraActionSearch, filesMentioning: 0, files: [], dispatcher: null };
    byId(inv.frontEnd, 'fe:doaction=login').windowed = false;
    byId(inv.tables, 'tbl:tusersmemb').ruleSteps = [];
    const { lines } = renderInventoryMarkdown(inv);
    expect(section(lines, '## Relations and stored procedures')).toEqual([
      '',
      '- Relations: 0',
      '- Stored procedures: static 0, live 0; foreign keys: static 0',
      '',
    ]);
    expect(lines).toContain('Search for `muraAction` in `core/** excluding core/vendor`: 0 handlers; 0 files mention it.');
    expect(rowOf(section(lines, '## Public front end'), 'fe:doaction=login')[5]).toBe('no');
    expect(rowOf(section(lines, '## Tables'), 'tbl:tusersmemb')[5]).toBe('—');
  });

  it('renders no flags once corrections and findings are cleared', () => {
    const inv = structuredClone(fixture);
    const steps = inv.scheduledJobs.flatMap((j) => j.steps);
    const variants = inv.controllers.flatMap((c) => c.actions.flatMap((a) => a.variants));
    for (const item of [...variants, ...inv.frontEnd, ...inv.routes, ...inv.tables, ...inv.scheduledJobs, ...steps]) {
      item.correction = null;
    }
    inv.findings = [];
    const { lines } = renderInventoryMarkdown(inv);
    expect(lines.filter((l) => l.includes('(corrected;'))).toEqual([]);
    expect(section(lines, '## Findings')).toEqual(['', 'None.']);
  });

  it('is deterministic and leaves its input unchanged', () => {
    const before = structuredClone(fixture);
    const first = renderInventoryMarkdown(fixture);
    expect(renderInventoryMarkdown(fixture)).toEqual(first);
    expect(fixture).toEqual(before);
  });

  it('keeps the inventory row order and orders counts independently of key order', () => {
    const reverseKeys = (o: object): object => Object.fromEntries(Object.entries(o).reverse());
    const inv = structuredClone(fixture);
    inv.controllers.reverse();
    inv.tables.reverse();
    inv.findings.reverse();
    inv.counts = Object.fromEntries(
      Object.entries(reverseKeys(inv.counts)).map(([k, v]) => [k, typeof v === 'object' && v !== null ? reverseKeys(v) : v]),
    ) as LegacyInventory['counts'];
    const original = renderInventoryMarkdown(fixture).lines;
    const reversed = renderInventoryMarkdown(inv).lines;
    expect(section(reversed, '## Counts')).toEqual(section(original, '## Counts'));
    expect(rowIds(section(reversed, '## Admin controllers'))).toEqual([
      'ctl:cusers.listusers',
      'ctl:cusers.update{type=2,action=add}',
      'ctl:cusers.update{type=2,action=delete}',
      'ctl:clogin.login',
      'ctl:cemail.list',
    ]);
    expect(rowIds(section(reversed, '## Tables'))).toEqual(['tbl:tusersmemb', 'tbl:tusers']);
    expect([...reversed].sort()).toEqual([...original].sort());
  });
});

