import { describe, expect, it } from 'vitest';
import {
  INVENTORY_TITLE,
  renderInventoryMarkdown,
  type ControllerVariantView,
  type DisposedItem,
  type InventoryFinding,
  type RenderableInventory,
  type SourceRef,
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
                owningService: 'spanning',
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
            ...carry('communications'),
            disposition: 'legacy-served',
            dispositionStep: 4,
            order: 4,
            call: 'emailManager.trackBounces per site',
            targetMechanism: 'proposed communications step',
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
        hasSiteId: true,
        hasSiteIdLive: false,
        hasPrimaryKey: true,
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
        hasPrimaryKey: true,
        hasPrimaryKeyLive: true,
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
  '| 4 | `job:sitemonitor.bounces` | emailManager.trackBounces per site | communications | legacy-served (4) | proposed communications step | — |',
  '',
  '## Tables',
  '',
  '| Id | Origin | siteID | PK | Owner(s) | Rule step(s) | Disposition (step) | Writers |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| `tbl:fb_*` | dynamic | pending-run | pending-run | — | 5 | decision (2, withheld) | 0 |',
  '| `tbl:tsettings` | bootstrap | yes (live: no) | yes (bootstrap: no) | programs-sites | 1 | carry (5) | 2 |',
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
      '| unclassified-gate | `ctl:nosuch` | — | — |',
    ]);
  });
});
