import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveGatewayPaths, type GatewayPaths } from '../../src/cutover/paths.js';
import type {
  CutoverEntry,
  CutoverTable,
  Disposition,
  ExceptionsDoc,
  GroupsFile,
  InventoryActionVariant,
  InventoryDoc,
  InventoryEntryPoint,
  InventoryRoute,
  InventoryTable,
  InventoryWrite,
  InventoryWriter,
  OwnershipDoc,
  VariantsFile,
} from '../../src/cutover/types.js';
import {
  inventoryKeyFacts,
  loadValidationContext,
  main,
  unpreventedWriters,
  validateVersion,
  type DecisionListInput,
  type ValidationContext,
} from '../../src/cutover/validate.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const SRC = { path: 'core/mura/user/userDAO.cfc', lines: [1, 1] as const };
const committed = resolveGatewayPaths({});
const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opt2-validate-'));
  scratch.push(dir);
  return dir;
}

// ---- Fixture inventory ----

const V_ADD = 'admin:cusers.update{type=2,action=add}';
const V_DELETE = 'admin:cusers.update{type=2,action=delete}';
const LIST = 'admin:cusers.list';
const SEARCH = 'admin:cusers.search';
const SITECOPY = 'admin:csettings.sitecopyselect';
const CEMAIL = 'admin:cemail.list';
const IMAGE = 'admin:carch.update{upload=image}';
const CARCH = 'admin:carch.update';
const REMINDER = 'page:setreminder';
const CONTACT = 'page:contactsend';
const JOB = 'sitemonitor:run';
const WIDGETS = 'widgets:redirect';
const FIXTURE = 'fixture:reporting/exports@post';

const G_PERSON = 'grp:people.person';
const G_GROUP = 'grp:identity.group_account';
const G_CONTENT = 'grp:content.content';
const G_EXPORT = 'grp:reporting.export_job';

function write(unit: string, legacyTable: string | null): InventoryWrite {
  return { unit, legacyTable, op: 'update', via: [], source: SRC, condition: null, override: null };
}

function entryPoint(
  routeKey: string,
  disposition: Disposition,
  owningService: string | null,
  writeSet: InventoryWrite[] = [],
): InventoryEntryPoint {
  return {
    id: `item:${routeKey}`,
    source: SRC,
    owningService,
    disposition,
    writeSet,
    conditionalWrites: [],
    routeKey,
    predicate: null,
    sessionEffects: 'none',
  };
}

function variant(
  routeKey: string,
  disposition: Disposition,
  owningService: string | null,
  writeSet: InventoryWrite[] = [],
): InventoryActionVariant {
  return {
    ...entryPoint(routeKey, disposition, owningService, writeSet),
    csrfValidation: 'none',
    csrfContext: null,
    responseMode: 'page',
    contentType: null,
  };
}

function route(
  routeKey: string | null,
  kind: InventoryRoute['kind'],
  family: InventoryRoute['family'],
  disposition: Disposition,
  owningService: string | null,
  writeSet: InventoryWrite[] = [],
): InventoryRoute {
  return { ...entryPoint(routeKey ?? '-', disposition, owningService, writeSet), routeKey, kind, family };
}

function writer(fields: Partial<InventoryWriter> & Pick<InventoryWriter, 'component' | 'trigger'>): InventoryWriter {
  return {
    method: '(template)',
    source: { path: fields.component, lines: [1, 1] },
    op: 'update',
    routeKeys: [],
    keyScope: [],
    sessionEffects: 'none',
    condition: null,
    override: null,
    ...fields,
  };
}

function table(name: string, writers: InventoryWriter[]): InventoryTable {
  return {
    id: `tbl:${name}`,
    source: SRC,
    owningService: null,
    disposition: 'carry',
    table: name,
    schema: 'dbo',
    hasPrimaryKey: true,
    writers,
  };
}

const PUBLISHER_WRITER = writer({
  component: 'core/mura/publisher.cfc',
  method: 'getToWorkSite',
  trigger: 'appstart',
  source: { path: 'core/mura/publisher.cfc', lines: [682, 682] },
  condition: 'config/setup/deploy/bundle.zip exists',
});

function inventory(extraContentWriters: InventoryWriter[] = []): InventoryDoc {
  return {
    sourceSha: SHA,
    controllers: [
      {
        id: 'ctl:cusers',
        circuit: 'cusers',
        isBase: false,
        owningService: 'people',
        actions: [
          {
            id: 'ctl:cusers.update',
            action: 'update',
            variants: [
              variant(V_ADD, 'carry', 'people', [write('people.person', 'tusers')]),
              variant(V_DELETE, 'decision', null, [write('people.person', 'tusers')]),
              variant(LIST, 'carry', 'people'),
              variant(SEARCH, 'carry', 'people'),
              variant(SITECOPY, 'decision', 'programs-sites'),
              variant(CEMAIL, 'legacy-served', 'communications'),
              variant(IMAGE, 'carry', 'strategies-content', [write('content.content', 'tcontent')]),
              variant(CARCH, 'carry', 'strategies-content', [write('content.content', 'tcontent')]),
            ],
          },
        ],
      },
    ],
    routes: [
      route(JOB, 'job', 'sitemonitor', 'carry', 'programs-sites'),
      route(WIDGETS, 'static', 'widgets', 'legacy-served', null),
      route(null, 'api-family', 'api', 'carry', null),
      route(FIXTURE, 'fixture', 'fixture', 'carry', 'reporting', [write('reporting.export_job', 'synthetic.export_job')]),
    ],
    frontEnd: [
      entryPoint(REMINDER, 'decision', 'communications', [write('legacy:tcontenteventreminders', 'tcontenteventreminders')]),
      entryPoint(CONTACT, 'retired', null),
    ],
    scheduledJobs: [
      {
        id: 'job:sitemonitor',
        source: SRC,
        owningService: 'programs-sites',
        disposition: 'carry',
        routeKey: JOB,
        steps: [],
      },
    ],
    tables: [
      table('tusers', [
        writer({ component: 'core/mura/user/userDAO.cfc', method: 'update', trigger: 'request', routeKeys: [V_ADD] }),
        writer({ component: 'core/mura/publisher.cfc', method: 'getToWorkUsers', trigger: 'appstart', condition: 'Type = 1' }),
      ]),
      table('tcontent', [
        writer({
          component: 'core/appcfc/onApplicationStart_include.cfm',
          trigger: 'appstart',
          source: { path: 'core/appcfc/onApplicationStart_include.cfm', lines: [892, 929] },
        }),
        writer({
          component: 'core/mura/content/contentServer.cfc',
          method: 'handleAPIRequest',
          trigger: 'scheduler',
          source: { path: 'core/mura/content/contentServer.cfc', lines: [669, 747] },
          routeKeys: [JOB],
        }),
        ...extraContentWriters,
      ]),
      table('synthetic.export_job', [
        writer({ component: 'legacy-fixtures/cfml/modules/reporting.cfc', method: 'createExport', trigger: 'thread' }),
      ]),
    ],
  };
}

const ownership: OwnershipDoc = {
  sourceSha: SHA,
  units: [
    { unit: 'people.person', owner: 'people', legacyTables: ['tusers'] },
    { unit: 'identity.group_account', owner: 'identity', legacyTables: ['tusers'] },
    { unit: 'content.content', owner: 'strategies-content', legacyTables: ['tcontent'] },
    { unit: 'reporting.export_job', owner: 'reporting', legacyTables: ['synthetic.export_job'] },
  ],
  tables: [
    {
      table: 'tusers',
      owner: 'people',
      targets: [
        { unit: 'identity.group_account', rowPredicate: 'Type = 1', ownedColumns: [] },
        { unit: 'people.person', rowPredicate: 'Type = 2', ownedColumns: [] },
      ],
    },
    { table: 'tcontent', owner: 'strategies-content', targets: [{ unit: 'content.content', rowPredicate: null, ownedColumns: [] }] },
    {
      table: 'synthetic.export_job',
      owner: 'reporting',
      targets: [{ unit: 'reporting.export_job', rowPredicate: null, ownedColumns: [] }],
    },
  ],
};

const groups: GroupsFile = {
  sourceSha: SHA,
  generatedBy: 'gateway/src/cutover/build-groups.ts',
  inputs: { inventorySha256: 'a'.repeat(64), tableOwnershipSha256: 'b'.repeat(64) },
  groups: [
    { id: G_CONTENT, units: ['content.content'], writeEntries: [CARCH], hasCarryWrite: true },
    { id: G_GROUP, units: ['identity.group_account'], writeEntries: [], hasCarryWrite: false },
    { id: G_PERSON, units: ['people.person'], writeEntries: [V_ADD], hasCarryWrite: true },
    { id: G_EXPORT, units: ['reporting.export_job'], writeEntries: [FIXTURE], hasCarryWrite: true },
  ],
};

const variants: VariantsFile = {
  sourceSha: SHA,
  variants: [
    { route: 'admin:carch.update', variant: 'upload=image', when: [{ multipartExtensionIn: ['png'] }] },
    { route: 'admin:cusers.update', variant: 'type=2,action=add', when: [{ param: 'type', equals: '2' }] },
    { route: 'admin:cusers.update', variant: 'type=2,action=delete', when: [{ param: 'type', equals: '2' }] },
  ],
};

const decisionList: DecisionListInput = {
  sourceSha: SHA,
  tables: [{ table: 'tcontenteventreminders' }, { table: 'fb_*', withheldEntryPoints: [{ routeKey: null }] }],
  actionVariants: [
    { routeKey: V_DELETE, writeSet: ['tusers'] },
    { routeKey: 'admin:csettings.*', writeSet: [], entryPoints: [{ routeKey: SITECOPY }] },
  ],
};

const exceptions: ExceptionsDoc = {
  sourceSha: SHA,
  entries: [
    { id: 'EX-FILE-RENDITION', routeKey: IMAGE, appliesTo: [], decision: 'preserve', status: 'halted' },
    { id: 'EX-FIX', routeKey: SEARCH, decision: 'fix', status: 'open' },
    { id: 'EX-ACCEPTED', routeKey: LIST, decision: 'preserve', status: 'accepted' },
  ],
};

function context(fields: Partial<ValidationContext> = {}): ValidationContext {
  const inv = fields.inventory ?? inventory();
  return {
    mode: 'ci',
    inventory: inv,
    inventoryKeys: inventoryKeyFacts(inv),
    groups,
    variants,
    decisionList,
    exceptions,
    ownership,
    sourceSha: SHA,
    reconciliationDir: committed.reconciliationDir,
    ...fields,
  };
}

// ---- Fixture versions ----

type BaseEntry = Omit<CutoverEntry, 'tableVersion' | 'state'>;

const entry = (
  route: string,
  owningService: CutoverEntry['owningService'],
  kind: CutoverEntry['kind'],
  units: string[],
  disposition: Disposition,
  group: string | null = null,
): BaseEntry => ({ route, owningService, kind, group, units, disposition });

const BASE: BaseEntry[] = [
  entry(V_ADD, 'people', 'write', ['people.person'], 'carry', G_PERSON),
  entry(V_DELETE, 'none', 'legacy-write', ['people.person'], 'decision'),
  entry(LIST, 'people', 'read', ['people.person'], 'carry'),
  entry(SEARCH, 'people', 'read', [], 'carry'),
  entry(SITECOPY, 'programs-sites', 'read', [], 'decision'),
  entry(CEMAIL, 'communications', 'read', [], 'legacy-served'),
  entry(IMAGE, 'strategies-content', 'legacy-write', ['content.content'], 'carry'),
  entry(CARCH, 'strategies-content', 'write', ['content.content'], 'carry', G_CONTENT),
  entry(REMINDER, 'communications', 'legacy-write', [], 'decision'),
  entry(CONTACT, 'none', 'read', [], 'retired'),
  entry(JOB, 'programs-sites', 'job', [], 'carry'),
  entry(WIDGETS, 'none', 'static', [], 'legacy-served'),
  entry(FIXTURE, 'reporting', 'write', ['reporting.export_job'], 'carry', G_EXPORT),
  entry('opt2:/opt2/stub/**', 'stub', 'write', [], 'carry'),
  entry('static:/admin/assets/**', 'none', 'static', [], 'legacy-served'),
  entry('bridge:/gateway/legacy-bridge/**', 'gateway', 'static', [], 'carry'),
  entry('opt2:/opt2/admin/reporting/**', 'web', 'read', ['reporting.export_job'], 'carry'),
];

const ALWAYS_TARGET = new Set(['opt2:/opt2/stub/**', 'bridge:/gateway/legacy-bridge/**']);
const ROLLBACK_REF = {
  groups: [G_PERSON],
  rollbackSet: [G_PERSON],
  report: 'opt2/reports/reconciliation/rollback-before.json',
  evidence: [],
};

function version(
  tableVersion: string,
  previous: string | null,
  authority: Record<string, 'legacy' | 'target'>,
  targets: ReadonlySet<string>,
): CutoverTable {
  return {
    tableVersion,
    previous,
    sourceSha: SHA,
    createdAt: '2026-06-01T00:00:00.000Z',
    groupAuthority: authority,
    rollbackRefs: tableVersion === 'v0003' ? [ROLLBACK_REF] : [],
    entries: BASE.map((e) => ({
      ...e,
      tableVersion,
      state: ALWAYS_TARGET.has(e.route) || targets.has(e.route) ? 'target' : 'legacy',
    })),
  };
}

const V1 = version('v0001', null, { [G_CONTENT]: 'legacy', [G_GROUP]: 'legacy', [G_PERSON]: 'legacy', [G_EXPORT]: 'legacy' }, new Set());
const V2 = version(
  'v0002',
  'v0001',
  { [G_CONTENT]: 'target', [G_GROUP]: 'legacy', [G_PERSON]: 'target', [G_EXPORT]: 'target' },
  new Set([V_ADD, CARCH, FIXTURE, LIST, JOB, 'opt2:/opt2/admin/reporting/**']),
);
const V3 = version(
  'v0003',
  'v0002',
  { [G_CONTENT]: 'target', [G_GROUP]: 'legacy', [G_PERSON]: 'legacy', [G_EXPORT]: 'target' },
  new Set([CARCH, FIXTURE, JOB, 'opt2:/opt2/admin/reporting/**']),
);
const PRIOR: Record<string, CutoverTable | undefined> = { v0001: undefined, v0002: V1, v0003: V2 };

function patch(t: CutoverTable, route: string, fields: Partial<CutoverEntry>): CutoverTable {
  return { ...t, entries: t.entries.map((e) => (e.route === route ? { ...e, ...fields } : e)) };
}

function adding(t: CutoverTable, ...entries: CutoverEntry[]): CutoverTable {
  return { ...t, entries: [...t.entries, ...entries] };
}

const rulesOf = (t: CutoverTable, ctx: ValidationContext = context({ prior: PRIOR[t.tableVersion] })): string[] =>
  validateVersion(t, ctx).map((finding) => finding.rule);

// ---- Rules ----

describe('validateVersion', () => {
  it.each([V1, V2, V3])('accepts the fixture chain at $tableVersion', (t) => {
    expect(validateVersion(t, context({ prior: PRIOR[t.tableVersion] }))).toEqual([]);
  });

  const extra = (route: string, owningService: CutoverEntry['owningService'], fields: Partial<CutoverEntry> = {}): CutoverEntry => ({
    route,
    owningService,
    tableVersion: 'v0001',
    state: 'target',
    kind: 'read',
    group: null,
    units: [],
    disposition: 'carry',
    ...fields,
  });

  it.each([
    ['a web entry', extra('static:/_next/**', 'web', { kind: 'static' })],
    ['a gateway entry', extra('bridge:/gateway/other/**', 'gateway', { kind: 'static' })],
    ['an opt2 entry of a service', extra('opt2:/opt2/files/reporting-exports/**', 'reporting')],
    ['a synthetic /v1/ entry', extra('static:/v1/timesheets/**', 'timesheets')],
    ['a legacy static entry', extra('static:/core/vendor/**', 'none', { kind: 'static', state: 'legacy', disposition: 'legacy-served' })],
  ])('allows %s without an inventoried key', (_name, added) => {
    expect(rulesOf(adding(V1, added))).toEqual([]);
  });

  const unpreventedCtx = context({ inventory: inventory([PUBLISHER_WRITER]), prior: V1 });

  it.each<[string, CutoverTable, string[], ValidationContext?]>([
    ['an inventoried key without an entry', { ...V1, entries: V1.entries.filter((e) => e.route !== CONTACT) }, ['route-once']],
    ['a key in two entries', adding(V1, { ...V1.entries[9]! }), ['route-once']],
    ['an unlisted non-inventoried entry', adding(V1, extra('admin:cfoo.bar', 'people', { state: 'legacy' })), ['route-not-inventoried']],
    ['a non-/v1/ synthetic entry', adding(V1, extra('static:/x/timesheets/**', 'timesheets')), ['route-not-inventoried']],
    ['a retired entry made target', patch(V1, CONTACT, { state: 'target' }), ['target-only-carry']],
    ['a withheld entry point made target', patch(V1, SITECOPY, { state: 'target' }), ['withheld-never-target']],
    ['a withheld action variant made target', patch(V1, V_DELETE, { state: 'target', kind: 'read', units: [] }), ['withheld-never-target']],
    ['a decision-table writer made target', patch(V1, REMINDER, { state: 'target', kind: 'read' }), ['withheld-never-target']],
    ['a legacy-served entry made target', patch(V1, CEMAIL, { state: 'target' }), ['legacy-served-never-target']],
    ['a target write under a legacy group', { ...V2, groupAuthority: { ...V2.groupAuthority, [G_CONTENT]: 'legacy' } }, ['write-follows-group']],
    ['a write entry without a group', patch(V1, CARCH, { group: null }), ['write-follows-group']],
    ['a write entry with units outside its group', patch(V1, CARCH, { units: ['content.content', 'people.person'] }), ['write-follows-group']],
    ['a target read of a legacy unit', patch(V1, LIST, { state: 'target' }), ['read-follows-units']],
    ['a target legacy-write', patch(V1, IMAGE, { state: 'target' }), ['legacy-write-always-legacy']],
    ['a target job in the first version', patch(V1, JOB, { state: 'target' }), ['job-state']],
    ['a legacy job after the first version', patch(V2, JOB, { state: 'legacy' }), ['job-state']],
    ['a job with another kind', patch(V1, JOB, { kind: 'read' }), ['job-state']],
    ['a job kind on a non-job key', patch(V1, CONTACT, { kind: 'job' }), ['job-state']],
    ['a halted write variant of kind write', patch(V1, IMAGE, { kind: 'write', group: G_CONTENT }), ['halted-is-legacy-write']],
    ['an open fix read made target', patch(V2, SEARCH, { state: 'target' }), ['halted-read-legacy']],
    ['a target unit with an unprevented writer', V2, ['unprevented-writer'], unpreventedCtx],
    ['a group returning to legacy without rollbackRefs', { ...V3, rollbackRefs: [] }, ['rollback-evidence']],
    ['another sourceSha', { ...V1, sourceSha: '0'.repeat(40) }, ['source-sha']],
    ['a previous that is not the prior version', V3, ['previous-chain'], context({ prior: V1 })],
    ['a null previous after a prior version', V1, ['previous-chain'], context({ prior: V1 })],
    ['a previous that is not available', V2, ['previous-chain'], context()],
    ['a previous that does not precede the version', { ...V2, previous: 'v0003' }, ['previous-chain'], context({ prior: V3 })],
    ['an entry from a later version', patch(V1, CONTACT, { tableVersion: 'v0009' }), ['previous-chain']],
    ['an unknown group', patch(V1, CARCH, { group: 'grp:nope.nope' }), ['group-unknown']],
    [
      'a group without authority',
      { ...V1, groupAuthority: Object.fromEntries(Object.entries(V1.groupAuthority).filter(([id]) => id !== G_GROUP)) },
      ['group-authority'],
    ],
    ['an authority for an unknown group', { ...V1, groupAuthority: { ...V1.groupAuthority, 'grp:extra.group': 'legacy' } }, ['group-authority']],
    [
      'an undeclared variant',
      V1,
      ['variant-undeclared'],
      context({ variants: { ...variants, variants: variants.variants.filter((v) => v.variant !== 'type=2,action=add') } }),
    ],
  ])('reports %s', (_name, t, expected, ctx) => {
    expect(rulesOf(t, ctx)).toEqual(expected);
  });

  it('names the route, unit and group a finding concerns', () => {
    const [unprevented] = validateVersion(V2, unpreventedCtx);
    expect(unprevented).toEqual({
      rule: 'unprevented-writer',
      unit: 'content.content',
      group: G_CONTENT,
      message: 'core/mura/publisher.cfc getToWorkSite 682-682 (appstart) writes it and is not prevented',
    });
    expect(validateVersion(patch(V1, CEMAIL, { state: 'target' }), context())).toContainEqual({
      rule: 'legacy-served-never-target',
      route: CEMAIL,
      message: 'legacy-served entry is target',
    });
  });

  it('matches entry routes case-insensitively', () => {
    expect(rulesOf(patch(V1, LIST, { route: ' Admin:cUsers.List ' }), context())).toEqual([]);
  });

  describe('activation mode', () => {
    const activation = (reconciliationDir: string): ValidationContext =>
      context({ mode: 'activation', prior: V2, reconciliationDir });

    it('fails while the rollback report is pending', () => {
      const findings = validateVersion(V3, activation(committed.reconciliationDir));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ rule: 'rollback-evidence', group: G_PERSON });
      expect(findings[0]?.message).toMatch(/rollback-before\.json has result pending-run$/);
    });

    it('passes with a zero-difference report', async () => {
      const dir = await tempDir();
      await writeFile(join(dir, 'rollback-before.json'), JSON.stringify({ result: 'zero-difference' }));
      expect(validateVersion(V3, activation(dir))).toEqual([]);
    });

    it('passes when one of several references has zero difference', async () => {
      const dir = await tempDir();
      await writeFile(join(dir, 'rollback-before.json'), JSON.stringify({ result: 'difference' }));
      await writeFile(join(dir, 'rollback-extra.json'), JSON.stringify({ result: 'zero-difference' }));
      const t = { ...V3, rollbackRefs: [ROLLBACK_REF, { ...ROLLBACK_REF, report: 'opt2/reports/reconciliation/rollback-extra.json' }] };
      expect(validateVersion(t, activation(dir))).toEqual([]);
    });

    it('fails when the report is missing', async () => {
      const findings = validateVersion(V3, activation(await tempDir()));
      expect(findings.map((f) => f.rule)).toEqual(['rollback-evidence']);
      expect(findings[0]?.message).toMatch(/is unreadable: ENOENT/);
    });

    it('needs only the reference in ci mode', async () => {
      expect(validateVersion(V3, context({ prior: V2, reconciliationDir: await tempDir() }))).toEqual([]);
    });
  });
});

describe('unpreventedWriters', () => {
  it('leaves out request writers and prevented writers', () => {
    const ctx = context();
    expect(unpreventedWriters('content.content', ctx)).toEqual([]);
    expect(unpreventedWriters('reporting.export_job', ctx)).toEqual([]);
    expect(unpreventedWriters('people.person', ctx)).toEqual([]);
  });

  it('narrows a writer to the targets whose row predicate equals its condition', () => {
    const [groupWriter] = unpreventedWriters('identity.group_account', context());
    expect(groupWriter).toMatchObject({ component: 'core/mura/publisher.cfc', method: 'getToWorkUsers' });
  });

  it('maps a writer without a matching predicate to every target of its table', () => {
    const inv = inventory();
    const users = inv.tables[0]!;
    const any = writer({ component: 'core/mura/settings/settingsDAO.cfc', method: 'create', trigger: 'appstart' });
    const ctx = context({ inventory: { ...inv, tables: [{ ...users, writers: [any] }, ...inv.tables.slice(1)] } });
    expect(unpreventedWriters('people.person', ctx)).toEqual([any]);
    expect(unpreventedWriters('identity.group_account', ctx)).toEqual([any]);
  });

  it('reports an unprevented writer of a content unit', () => {
    expect(unpreventedWriters('content.content', context({ inventory: inventory([PUBLISHER_WRITER]) }))).toEqual([PUBLISHER_WRITER]);
  });
});

describe('inventoryKeyFacts', () => {
  it('merges the items of one key', () => {
    const inv = inventory();
    const dup = { ...entryPoint(` ${LIST.toUpperCase()} `, 'decision', null, [write('file-store', null)]) };
    const facts = inventoryKeyFacts({ ...inv, frontEnd: [...inv.frontEnd, dup] });
    expect(facts.get(LIST)).toEqual({ disposition: 'decision', owningService: 'people', writeSet: ['file-store'], legacyTables: [] });
  });

  it('marks jobs and static routes and skips keyless routes', () => {
    const facts = inventoryKeyFacts(inventory());
    expect(facts.get(JOB)).toEqual({ disposition: 'carry', owningService: 'programs-sites', writeSet: [], legacyTables: [], kindHint: 'job' });
    expect(facts.get(WIDGETS)?.kindHint).toBe('static');
    expect(facts.get(REMINDER)).toMatchObject({ writeSet: ['legacy:tcontenteventreminders'], legacyTables: ['tcontenteventreminders'] });
    expect(facts.has('-')).toBe(false);
    expect(facts.size).toBe(13);
  });
});

describe('loadValidationContext', () => {
  it('loads the committed inputs', async () => {
    const ctx = await loadValidationContext(committed, 'activation', { prior: V1 });
    expect(ctx.mode).toBe('activation');
    expect(ctx.prior).toBe(V1);
    expect(ctx.sourceSha).toBe(SHA);
    expect(ctx.reconciliationDir).toBe(committed.reconciliationDir);
    expect(ctx.inventoryKeys.get(JOB)?.kindHint).toBe('job');
    expect(ctx.inventoryKeys.get(V_ADD)?.disposition).toBe('carry');
    expect(ctx.groups.groups.length).toBeGreaterThan(0);
    expect(ctx.variants.variants.length).toBeGreaterThan(0);
  });

  it('omits prior when none is given', async () => {
    expect('prior' in (await loadValidationContext(committed, 'ci'))).toBe(false);
  });
});

// ---- CLI ----

async function fixturePaths(versions: CutoverTable[] = [V1, V2, V3]): Promise<GatewayPaths> {
  const root = await tempDir();
  const cutoverDir = join(root, 'cutover');
  const opt2 = join(root, 'opt2');
  const reconciliationDir = join(opt2, 'reconciliation');
  await mkdir(join(cutoverDir, 'versions'), { recursive: true });
  await mkdir(reconciliationDir, { recursive: true });
  const paths: GatewayPaths = {
    packageRoot: root,
    repoRoot: root,
    cutoverDir,
    versionsDir: join(cutoverDir, 'versions'),
    schemaFile: join(cutoverDir, 'cutover-table.schema.json'),
    variantsFile: join(cutoverDir, 'variants.json'),
    groupsFile: join(cutoverDir, 'groups.json'),
    inventoryFile: join(opt2, 'legacy-inventory.json'),
    tableOwnershipFile: join(opt2, 'table-ownership.json'),
    decisionListFile: join(opt2, 'decision-list.json'),
    exceptionsListFile: join(opt2, 'exceptions-list.json'),
    sourcePinFile: join(opt2, 'source-pin.json'),
    reconciliationDir,
  };
  const json = (file: string, value: unknown): Promise<void> => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  await Promise.all([
    copyFile(committed.schemaFile, paths.schemaFile),
    json(paths.variantsFile, variants),
    json(paths.groupsFile, groups),
    json(paths.inventoryFile, inventory()),
    json(paths.tableOwnershipFile, ownership),
    json(paths.decisionListFile, decisionList),
    json(paths.exceptionsListFile, exceptions),
    json(paths.sourcePinFile, { sha: SHA, sourceSha: SHA }),
    json(join(reconciliationDir, 'rollback-before.json'), { result: 'pending-run' }),
    ...versions.map((t) => json(join(paths.versionsDir, `${t.tableVersion}.json`), t)),
  ]);
  return paths;
}

async function run(argv: string[], paths?: GatewayPaths): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };
  const code = await main(argv, paths === undefined ? io : { ...io, paths });
  return { code, out, err };
}

describe('main', () => {
  it.each([[['--ci']], [[]]])('validates the whole chain with %j', async (argv) => {
    expect(await run(argv, await fixturePaths())).toEqual({ code: 0, out: ['ok v0001', 'ok v0002', 'ok v0003'], err: [] });
  });

  it('validates one version against its previous', async () => {
    expect(await run(['--version', 'v0002'], await fixturePaths())).toEqual({ code: 0, out: ['ok v0002'], err: [] });
  });

  it.each([[['--activation']], [['--ci', '--activation']]])('reads the reconciliation report with %j', async (argv) => {
    const result = await run(argv, await fixturePaths());
    expect(result.code).toBe(1);
    expect(result.out.slice(0, 2)).toEqual(['ok v0001', 'ok v0002']);
    expect(result.out[2]).toMatch(/^v0003 rollback-evidence grp:people\.person .*has result pending-run$/);
  });

  it('lets the last mode flag win', async () => {
    expect((await run(['--activation', '--ci'], await fixturePaths())).code).toBe(0);
  });

  it('prints one line per finding', async () => {
    const bad = { ...patch(V1, CEMAIL, { state: 'target' }), sourceSha: '0'.repeat(40) };
    expect(await run([], await fixturePaths([bad]))).toEqual({
      code: 1,
      out: [
        `v0001 legacy-served-never-target ${CEMAIL} legacy-served entry is target`,
        `v0001 source-sha - sourceSha ${'0'.repeat(40)} is not the pinned ${SHA}`,
      ],
      err: [],
    });
  });

  it('rejects a null previous after the first file', async () => {
    const result = await run([], await fixturePaths([V1, { ...V2, previous: null, entries: patch(V2, JOB, { state: 'legacy' }).entries }]));
    expect(result.code).toBe(1);
    expect(result.out).toEqual(['ok v0001', 'v0002 previous-chain - previous is null although v0001 precedes v0002']);
  });

  it('reports a version that fails its schema', async () => {
    const paths = await fixturePaths([V1]);
    await writeFile(join(paths.versionsDir, 'v0002.json'), '{"tableVersion":"v0002"}');
    const result = await run([], paths);
    expect(result.code).toBe(1);
    expect(result.out[0]).toBe('ok v0001');
    expect(result.out[1]).toMatch(/^v0002 schema - .*v0002\.json does not match its cut-over schema/);
  });

  it('reports a previous whose file fails its schema', async () => {
    const paths = await fixturePaths([V2]);
    await writeFile(join(paths.versionsDir, 'v0001.json'), '{}');
    const result = await run(['--version', 'v0002'], paths);
    expect(result).toEqual({ code: 1, out: ['v0002 previous-chain - previous v0001 is not available'], err: [] });
  });

  it('fails on an input that fails its schema', async () => {
    const paths = await fixturePaths();
    await writeFile(paths.groupsFile, '{}');
    const result = await run([], paths);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err[0]).toMatch(/^validate: .*groups\.json does not match its cut-over schema/);
  });

  it('fails without version files', async () => {
    const paths = await fixturePaths([]);
    for (const dir of [paths.versionsDir, join(paths.cutoverDir, 'absent')]) {
      const result = await run([], { ...paths, versionsDir: dir });
      expect(result.code).toBe(1);
      expect(result.err).toEqual([`validate: no version files in ${dir}`]);
    }
  });

  it.each([
    [['--bogus'], 'unknown argument --bogus'],
    [['--version'], '--version needs a vNNNN id'],
    [['--version', 'v1'], '--version needs a vNNNN id'],
    [['--version', 'v0001', '--version', 'v0002'], '--version given twice'],
  ])('rejects %j as a usage error', async (argv, message) => {
    expect(await run(argv)).toEqual({ code: 2, out: [], err: [`validate: ${message}\nusage: validate.ts [--ci | --activation] [--version vNNNN]`] });
  });

  it('rejects an unknown version as a usage error', async () => {
    const paths = await fixturePaths();
    const result = await run(['--version', 'v0009'], paths);
    expect(result.code).toBe(2);
    expect(result.err[0]).toBe(`validate: no version file v0009 in ${paths.versionsDir}\nusage: validate.ts [--ci | --activation] [--version vNNNN]`);
  });

  describe.runIf(existsSync(join(committed.versionsDir, 'v0001.json')))('committed versions', () => {
    it('validate without findings', async () => {
      const result = await run(['--ci']);
      expect(result.out.filter((line) => !line.startsWith('ok '))).toEqual([]);
      expect(result.code).toBe(0);
    });
  });
});

