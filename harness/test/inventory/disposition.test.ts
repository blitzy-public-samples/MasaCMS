import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AREA_OWNERS,
  NAMED_SPANNING_OWNERS,
  SPANNING_OWNER,
  areaKeyForRouteKey,
  decide,
  loadDecisionList,
  loadExceptions,
  ownersOfWriteSet,
} from '../../src/inventory/disposition.js';
import type {
  DecisionList,
  DispositionContext,
  DispositionFacts,
  DispositionFinding,
  DispositionResult,
  ExceptionsList,
} from '../../src/inventory/disposition.js';
import { loadTableOwnership } from '../../src/inventory/tables.js';
import type { TableOwnership } from '../../src/inventory/tables.js';
import { pinnedSha } from '../../src/lib/pin.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/inventory/${name}`, import.meta.url));

const DECISION_LIST_FILE = fixture('mini-decision-list.json');
const EXCEPTIONS_FILE = fixture('mini-exceptions-list.json');
const OWNERSHIP_FILE = fixture('mini-table-ownership.json');

const ctx: DispositionContext = {
  decisionList: await loadDecisionList(DECISION_LIST_FILE),
  exceptions: await loadExceptions(EXCEPTIONS_FILE),
  ownership: await loadTableOwnership(OWNERSHIP_FILE),
};

type OwnershipEntry = TableOwnership['tables'][number];

function tableOf(doc: TableOwnership, name: string): OwnershipEntry {
  const entry = doc.tables.find((t) => t.table === name);
  if (entry === undefined) throw new Error(`ownership fixture has no table ${name}`);
  return entry;
}

function owned(table: string, owner: string, unit: string): OwnershipEntry {
  return { table, owner, ruleSteps: [1], targets: [{ unit, owner, rowPredicate: null }] };
}

/** The mini ownership widened with the tusers group split, file, content, pattern, retired and stored-data splits. */
function wideOwnership(): TableOwnership {
  const doc = structuredClone(ctx.ownership);
  tableOf(doc, 'tusers').targets.unshift({ unit: 'identity.group_account', owner: 'identity', rowPredicate: 'Type = 1' });
  doc.tables.push(
    owned('tfiles', 'strategies-content', 'content.file'),
    owned('tcontent', 'strategies-content', 'content.content'),
    { table: 'tclustercommands', owner: 'decision-list', ruleSteps: [5], targets: [] },
    { table: 'fb_*', owner: 'decision-list', ruleSteps: [5], targets: [] },
    { table: 'tglobals', owner: 'retired', ruleSteps: [1], targets: [] },
    {
      table: 'tclassextenddata',
      owner: 'split',
      ruleSteps: [1],
      targets: [
        { unit: 'content.extend_data', owner: 'strategies-content', rowPredicate: "baseTable in ('tcontent', 'tfiles')" },
        { unit: 'people.extend_data', owner: 'people', rowPredicate: "baseTable in ('tusers')" },
      ],
    },
    {
      table: 'ttrash',
      owner: 'split',
      ruleSteps: [1],
      targets: [
        { unit: 'identity.trash', owner: 'identity', rowPredicate: 'classMap owner = identity' },
        { unit: 'people.trash', owner: 'people', rowPredicate: 'classMap owner = people' },
      ],
    },
  );
  return doc;
}

function wideDecisionList(): DecisionList {
  const doc = structuredClone(ctx.decisionList);
  doc.tables.push({ table: 'fb_*', proposedOwner: 'strategies-content', buildWithheld: true });
  doc.actionVariants.push({
    routeKey: 'admin:cextend.*',
    owners: ['people', 'programs-sites', 'strategies-content'],
    proposal: 'Programs-sites hosts the screens; writes go to the owner of each stored baseTable.',
    proposedOwner: 'programs-sites',
  });
  return doc;
}

const wide: DispositionContext = { ...ctx, ownership: wideOwnership(), decisionList: wideDecisionList() };

/** Facts of a plain carry item; `id` and `areaKey` derive from `routeKey` unless overridden. */
function facts(overrides: Partial<DispositionFacts> = {}): DispositionFacts {
  const routeKey = 'routeKey' in overrides ? overrides.routeKey : 'admin:clogin.login';
  return {
    itemKind: 'action',
    id: `item:${routeKey ?? 'unkeyed'}`,
    ...(routeKey === undefined ? {} : { routeKey }),
    reachable: true,
    writeSet: [],
    fileStoreWrite: false,
    rendersCfml: false,
    webRootFilesystem: false,
    areaKey: routeKey === undefined ? 'unkeyed' : areaKeyForRouteKey(routeKey),
    ...overrides,
  };
}

function findingsOf(f: DispositionFacts, context: DispositionContext = ctx): DispositionFinding[] {
  const findings: DispositionFinding[] = [];
  decide(f, { ...context, findings });
  return findings;
}

const ROSTER = ['tusers', 'tusersmemb'] as const;

describe('disposition inputs', () => {
  it('loads the mini decision list, exceptions list and table ownership as committed', () => {
    expect(ctx.decisionList.sourceSha).toBe(pinnedSha());
    expect(ctx.decisionList.tables.map((t) => [t.table, t.proposedOwner, t.buildWithheld])).toEqual([['tplugins', 'retire', true]]);
    expect(ctx.decisionList.actionVariants.map((v) => v.routeKey)).toEqual([
      'admin:cusers.update{type=2,action=delete}',
      'api:user.delete',
    ]);
    expect(ctx.decisionList.actionVariants[1]?.entryPoints?.map((e) => e.routeKey)).toEqual(['api:user.delete', 'rest:user.delete']);
    expect(ctx.exceptions.entries.map((e) => [e.id, e.routeKey, e.decision, e.status])).toEqual([
      ['EX-FILE-RENDITION', 'admin:carch.update{upload=image}', 'preserve', 'halted'],
      ['EX-SEC-APPRELOAD', 'reload:application', 'fix', 'open'],
    ]);
    expect(ctx.ownership.tables.map((t) => [t.table, t.owner])).toEqual([
      ['tplugins', 'decision-list'],
      ['tusers', 'split'],
      ['tusersmemb', 'identity'],
    ]);
  });

  describe('authored files', () => {
    let dir = '';

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'disposition-'));
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function authored(name: string, doc: unknown): Promise<string> {
      const file = path.join(dir, name);
      await writeFile(file, JSON.stringify(doc));
      return file;
    }

    it('normalises authored route keys of variants and exceptions without optional lists', async () => {
      const list = await loadDecisionList(
        await authored('decision.json', {
          sourceSha: pinnedSha(),
          tables: [],
          actionVariants: [{ routeKey: ' Admin:cUsers.Update{Type=2,Action=Delete} ', owners: ['identity', 'people'], proposal: 'p' }],
          spanningControllers: [],
        }),
      );
      const exceptions = await loadExceptions(
        await authored('exceptions.json', {
          sourceSha: pinnedSha(),
          entries: [{ id: 'EX-X', routeKey: 'Admin:cArch.Update{Upload=Image}', decision: 'preserve', status: 'halted' }],
        }),
      );
      expect(list.actionVariants[0]).toEqual({
        routeKey: 'admin:cusers.update{type=2,action=delete}',
        owners: ['identity', 'people'],
        proposal: 'p',
      });
      expect(exceptions.entries[0]).toEqual({ id: 'EX-X', routeKey: 'admin:carch.update{upload=image}', decision: 'preserve', status: 'halted' });
    });

    it.each([
      ['decision list', loadDecisionList, { tables: [], actionVariants: [], spanningControllers: [] }],
      ['exceptions list', loadExceptions, { entries: [] }],
    ] as const)('rejects a %s stamped with another SHA', async (label, load, body) => {
      const stale = '0'.repeat(40);
      const file = await authored(`stale-${label.replace(' ', '-')}.json`, { sourceSha: stale, ...body });
      await expect(load(file)).rejects.toThrow(`sourceSha "${stale}" differs from the pinned SHA ${pinnedSha()}`);
    });
  });
});

describe('rule steps in order', () => {
  it('retires a SOAP v1 component that HTTP and the scheduler cannot reach', () => {
    const result = decide(facts({ itemKind: 'route', id: 'rte:soap:user', routeKey: undefined, areaKey: 'soap:v1', reachable: false }), ctx);
    expect(result).toMatchObject({ disposition: 'retired', dispositionStep: 1, owningService: null, withheld: false, legacyWrite: false });
    expect(result.basis).toBe('unreachable over HTTP or the scheduler at the pinned SHA');
  });

  it('retires the tglobals table item because the live catalog no longer holds it', () => {
    const result = decide(facts({ itemKind: 'table', id: 'tbl:tglobals', routeKey: undefined, areaKey: 'table:tglobals', tableAbsent: true }), ctx);
    expect(result).toMatchObject({ disposition: 'retired', dispositionStep: 1, basis: 'its table is absent from the live catalog' });
  });

  it('withholds an action that writes the decision-list table tplugins under its proposal', () => {
    const result = decide(facts({ routeKey: 'admin:csettings.deployplugin', writeSet: ['tplugins'] }), ctx);
    expect(result).toMatchObject({
      disposition: 'decision',
      dispositionStep: 2,
      basis: 'writes decision-list table tplugins',
      owningService: 'retire',
      ownerBasis: 'decision-list-proposal',
      withheld: true,
      legacyWrite: true,
      decisionListRef: 'opt2/decision-list.json#tplugins',
      owners: [],
    });
  });

  it('matches a decision-list table pattern for a dynamic form-builder table', () => {
    expect(decide(facts({ routeKey: 'api:submitform', writeSet: ['fb_contactform'] }), wide)).toMatchObject({
      disposition: 'decision',
      dispositionStep: 2,
      owningService: 'strategies-content',
      decisionListRef: 'opt2/decision-list.json#fb_*',
    });
  });

  it('still withholds a write to a decision-list table the decision list does not name, with no owner', () => {
    const result = decide(facts({ routeKey: 'admin:csettings.updatesite{action=update}', writeSet: ['tclustercommands'] }), wide);
    expect(result).toMatchObject({ disposition: 'decision', dispositionStep: 2, owningService: null, ownerBasis: 'none', withheld: true });
    expect(result.decisionListRef).toBeUndefined();
  });

  it('withholds cusers.update{type=2,action=delete} because identity and people both own its writes', () => {
    const result = decide(
      facts({ routeKey: 'admin:cusers.update{type=2,action=delete}', variantPredicates: { type: '2', action: 'Delete' }, writeSet: ROSTER }),
      ctx,
    );
    expect(result).toMatchObject({
      disposition: 'decision',
      dispositionStep: 3,
      basis: 'write set spans identity, people; no input names the owner',
      owningService: SPANNING_OWNER,
      ownerBasis: 'spanning',
      owners: ['identity', 'people'],
      withheld: true,
      legacyWrite: true,
      decisionListRef: 'opt2/decision-list.json#admin:cusers.update{type=2,action=delete}',
    });
    expect(result.correction).toBeUndefined();
  });

  it.each(['api:user.delete', 'rest:user.delete'])('withholds %s through the JSON API user delete variant', (routeKey) => {
    expect(decide(facts({ itemKind: 'api', routeKey, writeSet: ROSTER }), ctx)).toMatchObject({
      disposition: 'decision',
      dispositionStep: 3,
      owningService: SPANNING_OWNER,
      withheld: true,
      decisionListRef: 'opt2/decision-list.json#api:user.delete',
    });
  });

  it.each([
    ['admin:cextend.updatesubtype', 'baseTable'],
    ['admin:ctrash.restore', 'objectClass'],
  ] as const)('withholds %s because its owner depends on the stored %s', (routeKey, storedDataOwner) => {
    const result = decide(facts({ routeKey, storedDataOwner }), ctx);
    expect(result).toMatchObject({
      disposition: 'decision',
      dispositionStep: 3,
      basis: `owner depends on the stored ${storedDataOwner}`,
      owningService: SPANNING_OWNER,
      withheld: true,
      legacyWrite: false,
    });
  });

  it('takes the proposed owner of a matching decision-list variant pattern for a stored-data owner', () => {
    expect(decide(facts({ routeKey: 'admin:cextend.updatesubtype', storedDataOwner: 'baseTable' }), wide)).toMatchObject({
      dispositionStep: 3,
      owningService: 'programs-sites',
      ownerBasis: 'decision-list-proposal',
      decisionListRef: 'opt2/decision-list.json#admin:cextend.*',
    });
  });

  it.each([
    ['page:render', { itemKind: 'front-end', rendersCfml: true }, 'renders CFML through the theme and display-object runtime', 'reporting'],
    ['admin:cfilemanager.default', { webRootFilesystem: true }, 'depends on the legacy web-root filesystem', 'strategies-content'],
    ['admin:cplugins.list', { runtimeCategory: 'plugin' }, 'depends on the CFML runtime (plugin)', null],
    ['admin:cemail.list', {}, 'owner communications is not a migrated domain', 'communications'],
    ['admin:scaffold.default', {}, 'no service owns its area', null],
  ] as const)('serves %s from legacy: %s', (routeKey, extra, basis, owningService) => {
    expect(decide(facts({ routeKey, ...extra }), ctx)).toMatchObject({
      disposition: 'legacy-served',
      dispositionStep: 4,
      basis,
      owningService,
      withheld: false,
      legacyWrite: false,
    });
  });

  it.each([
    ['admin:clogin.login', ['tusersmemb'], 'identity', 'table-ownership', 'single owner identity among the migrated services'],
    ['admin:clogin.main', [], 'identity', 'aap-0.3.2', 'area owner identity is a migrated service'],
    ['cfc:/core/modules/v1/comments/ajax/commentsproxy.cfc?method=getcomments', [], null, 'none', 'writes nothing and depends on no legacy runtime'],
  ] as const)('carries %s', (routeKey, writeSet, owningService, ownerBasis, basis) => {
    const result = decide(facts({ routeKey, writeSet }), ctx);
    expect(result).toMatchObject({ disposition: 'carry', dispositionStep: 5, owningService, ownerBasis, basis, withheld: false, legacyWrite: false });
    expect(result.haltedBy).toBeUndefined();
    expect(result.protocol).toBeUndefined();
  });

  it('settles an item that writes tplugins and renders CFML at step 2, before legacy-served', () => {
    expect(decide(facts({ routeKey: 'admin:csettings.deployplugin', writeSet: ['tplugins'], rendersCfml: true }), ctx).dispositionStep).toBe(2);
  });

  it('retires an unreachable item that writes tplugins at step 1, before the decision list', () => {
    expect(decide(facts({ routeKey: 'admin:csettings.deployplugin', writeSet: ['tplugins'], reachable: false }), ctx)).toMatchObject({
      disposition: 'retired',
      dispositionStep: 1,
    });
  });

  it('settles a stored-data owner that also renders CFML at step 3, before legacy-served', () => {
    expect(decide(facts({ routeKey: 'admin:ctrash.list', storedDataOwner: 'objectClass', rendersCfml: true }), ctx).dispositionStep).toBe(3);
  });

  it.each([
    ['a written table the ownership file does not assign', facts({ id: 'ctl:carch.update', routeKey: 'admin:carch.update', writeSet: ['tcontent'] }), 'ctl:carch.update: table ownership assigns no owner to written table tcontent'],
    ['a fixture module no service owns', facts({ id: 'fix:unknown/x@get', routeKey: 'fixture:unknown/x@get', fixtureModule: 'unknown' }), 'fix:unknown/x@get: fixture module unknown maps to no service'],
  ])('throws naming the item for %s', (_label, f, message) => {
    expect(() => decide(f, ctx)).toThrow(message);
  });
});

describe('named spanning owners', () => {
  const NAMED = [
    ['admin:cusers.update{type=2,action=add}', { type: '2', action: 'Add' }],
    ['admin:cusers.update{type=2,action=update}', { type: '2', action: 'Update' }],
    ['api:user.save', {}],
    ['admin:ceditprofile.update', {}],
  ] as const;

  it('names people as the owner of exactly the roster create, edit, JSON API user save and profile update', () => {
    expect(Object.keys(NAMED_SPANNING_OWNERS).sort()).toEqual(NAMED.map(([key]) => key).sort());
    for (const named of Object.values(NAMED_SPANNING_OWNERS)) {
      expect(named).toEqual({ owner: 'people', protocol: 'roster-write', participants: ['identity', 'people'] });
    }
  });

  it.each(NAMED)('carries %s to people under the roster write protocol instead of withholding it', (routeKey, variantPredicates) => {
    const result = decide(facts({ routeKey, variantPredicates, writeSet: ROSTER }), ctx);
    expect(result).toMatchObject({
      disposition: 'carry',
      dispositionStep: 5,
      owningService: 'people',
      ownerBasis: 'named-input',
      owners: ['identity', 'people'],
      protocol: 'roster-write',
      withheld: false,
      legacyWrite: false,
      basis: 'an input names people as owner of writes spanning identity, people',
    });
    expect(result.correction).toBeUndefined();
  });

  it('resolves the REST user save through its JSON API key', () => {
    expect(decide(facts({ itemKind: 'api', routeKey: 'rest:user.save', writeSet: ROSTER }), ctx)).toMatchObject({
      disposition: 'carry',
      owningService: 'people',
      protocol: 'roster-write',
    });
  });

  it('withholds a named roster key whose file-store write reaches strategies-content, which the protocol does not coordinate', () => {
    const result = decide(
      facts({ routeKey: 'admin:cusers.update{type=2,action=update}', variantPredicates: { type: '2', action: 'Update' }, writeSet: ROSTER, fileStoreWrite: true }),
      wide,
    );
    expect(result).toMatchObject({ disposition: 'decision', dispositionStep: 3, owners: ['identity', 'people', 'strategies-content'] });
    expect(result.protocol).toBeUndefined();
  });
});

describe('ownersOfWriteSet', () => {
  it('gives the tusers user split to identity and people for Type=2', () => {
    expect(ownersOfWriteSet(['tusers'], { type: '2' }, ctx.ownership)).toEqual({ owners: ['identity', 'people'], decisionTables: [] });
  });

  it('gives the tusers group split to identity alone for Type=1', () => {
    expect(ownersOfWriteSet(['tusers'], { Type: '1' }, wide.ownership)).toEqual({ owners: ['identity'], decisionTables: [] });
  });

  it('falls back to every target when the request selects none', () => {
    expect(ownersOfWriteSet(['tusers'], { type: '1' }, ctx.ownership).owners).toEqual(['identity', 'people']);
  });

  it('reports decision-list tables apart from owners and skips retired tables', () => {
    expect(ownersOfWriteSet(['dbo.tplugins', 'tglobals', 'TUSERSMEMB'], {}, wide.ownership)).toEqual({
      owners: ['identity'],
      decisionTables: ['dbo.tplugins'],
    });
  });

  it.each([
    [['tclassextenddata', 'tfiles'], ['strategies-content']],
    [['tclassextenddata'], ['people', 'strategies-content']],
    [['ttrash', 'tusersmemb'], ['identity']],
  ])('narrows stored-data splits of %j by the co-written tables', (writeSet, owners) => {
    expect(ownersOfWriteSet(writeSet, {}, wide.ownership).owners).toEqual(owners);
  });
});

describe('exceptions, fixtures and corrections', () => {
  const upload = (routeKey: string): DispositionFacts => facts({ routeKey, fileStoreWrite: true });

  it.each(['admin:carch.update{upload=image}', 'admin:carch.multifileupload{upload=image}', 'api:file.save{upload=image}'])(
    'keeps the carried image upload %s a legacy write halted by EX-FILE-RENDITION',
    (routeKey) => {
      expect(decide(upload(routeKey), wide)).toMatchObject({
        disposition: 'carry',
        dispositionStep: 5,
        owningService: 'strategies-content',
        legacyWrite: true,
        haltedBy: 'EX-FILE-RENDITION',
      });
    },
  );

  it('carries a non-image upload as a target write', () => {
    const result = decide(upload('admin:carch.update'), wide);
    expect(result).toMatchObject({ disposition: 'carry', legacyWrite: false });
    expect(result.haltedBy).toBeUndefined();
  });

  it('keeps the application reload a legacy write while EX-SEC-APPRELOAD proposes an open fix', () => {
    expect(decide(facts({ itemKind: 'route', routeKey: 'reload:application', writeSet: ['tcontent'] }), wide)).toMatchObject({
      legacyWrite: true,
      haltedBy: 'EX-SEC-APPRELOAD',
    });
  });

  it.each([
    ['EX-FILE-RENDITION', { status: 'accepted' }, upload('admin:carch.update{upload=image}')],
    ['EX-FILE-RENDITION', { status: 'open' }, upload('admin:carch.update{upload=image}')],
    ['EX-SEC-APPRELOAD', { status: 'accepted' }, facts({ itemKind: 'route', routeKey: 'reload:application', writeSet: ['tcontent'] })],
  ] as const)('releases the route when %s is %j', (id, change, f) => {
    const exceptions: ExceptionsList = structuredClone(wide.exceptions);
    exceptions.entries = exceptions.entries.map((e) => (e.id === id ? { ...e, ...change } : e));
    const result = decide(f, { ...wide, exceptions });
    expect(result.legacyWrite).toBe(false);
    expect(result.haltedBy).toBeUndefined();
  });

  it.each([
    ['fixture:people/persons/{id}/archive@post', 'people', 'people'],
    ['fixture:esignature/requests/{id}/sign@post', 'esignature', 'e-signature'],
  ])('carries the fixture route %s to its module service by definition', (routeKey, fixtureModule, owningService) => {
    const result = decide(facts({ itemKind: 'fixture-route', routeKey, fixtureModule }), ctx);
    expect(result).toMatchObject({
      disposition: 'carry',
      dispositionStep: 'fixture-definition',
      owningService,
      ownerBasis: 'fixture-module',
      withheld: false,
    });
  });

  it('records a correction when the rule disposition differs from the AAP table', () => {
    expect(decide(facts({ routeKey: 'admin:csettings.deployplugin', writeSet: ['tplugins'] }), ctx).correction).toEqual({
      expected: { disposition: 'legacy-served' },
      computed: { disposition: 'decision', owningService: 'retire' },
      step: 2,
      basis: 'writes decision-list table tplugins',
    });
  });

  it('records a correction when a single write-set owner differs from the area owner', () => {
    expect(decide(facts({ routeKey: 'admin:cusers.addtogroup', writeSet: ['tusersmemb'] }), ctx).correction).toEqual({
      expected: { owningService: AREA_OWNERS['admin:cusers'] },
      computed: { disposition: 'carry', owningService: 'identity' },
      step: 5,
      basis: 'single owner identity among the migrated services',
    });
  });

  it('records no correction when the rule agrees with the AAP table and the area owner', () => {
    expect(decide(facts({ routeKey: 'admin:clogin.login', writeSet: ['tusersmemb'] }), ctx).correction).toBeUndefined();
  });
});

describe('findings', () => {
  it('reports each correction as a finding with its expected and computed sides', () => {
    expect(findingsOf(facts({ id: 'ctl:csettings.deployplugin', routeKey: 'admin:csettings.deployplugin', writeSet: ['tplugins'] }))).toEqual([
      expect.objectContaining({
        kind: 'correction',
        id: 'ctl:csettings.deployplugin',
        itemKind: 'action',
        routeKey: 'admin:csettings.deployplugin',
        detail: 'AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tplugins)',
      }),
    ]);
    expect(findingsOf(facts({ routeKey: 'admin:cusers.addtogroup', writeSet: ['tusersmemb'] })).map((f) => f.detail)).toEqual([
      'area owner people, computed owner identity (single owner identity among the migrated services)',
    ]);
  });

  it.each([
    [
      'a step-3 withholding the decision list does not list',
      facts({ routeKey: 'admin:ctrash.restore', storedDataOwner: 'objectClass' }),
      ctx,
      'computed decision at step 3 (owner depends on the stored objectClass) but opt2/decision-list.json lists no matching action variant',
    ],
    [
      'a decision-list table write the decision list does not name',
      facts({ routeKey: 'admin:csettings.updatesite{action=update}', writeSet: ['tclustercommands'] }),
      wide,
      'writes tclustercommands, which table ownership assigns to the decision list, but opt2/decision-list.json lists no such table',
    ],
  ])('reports a decision-list mismatch for %s', (_label, f, context, detail) => {
    expect(findingsOf(f, context).filter((x) => x.kind === 'decision-list-mismatch').map((x) => x.detail)).toEqual([detail]);
  });

  it('reports a listed variant the rule carries, beside its correction', () => {
    const found = findingsOf(facts({ routeKey: 'admin:cusers.update{type=2,action=delete}', writeSet: ['tusersmemb'] }));
    expect(found.map((f) => f.kind)).toEqual(['decision-list-mismatch', 'correction']);
    expect(found[0]?.detail).toBe(
      'opt2/decision-list.json lists admin:cusers.update{type=2,action=delete} but the rule computes carry at step 5 (single owner identity among the migrated services)',
    );
  });

  it('reports nothing for an item the rule and the inputs agree on', () => {
    expect(findingsOf(facts({ routeKey: 'admin:clogin.login', writeSet: ['tusersmemb'] }))).toEqual([]);
  });
});

describe('areaKeyForRouteKey', () => {
  it.each([
    ['admin:cUsers.update{type=2,action=delete}', 'admin:cusers'],
    ['rest:user.delete', 'api:user'],
    ['fixture:people/persons/{id}/archive@post', 'fixture:people'],
    ['cfc:/core/modules/v1/comments/ajax/commentsproxy.cfc?method=getcomments', 'cfc:/core/modules/v1/comments/ajax/commentsproxy.cfc'],
    ['page:render', 'page:render'],
    ['feed:v1', 'feed'],
    ['sitemonitor', 'sitemonitor'],
  ])('keys %s under area %s', (routeKey, area) => {
    expect(areaKeyForRouteKey(routeKey)).toBe(area);
  });
});

describe('decide', () => {
  const SAMPLES: ReadonlyArray<readonly [string, DispositionFacts, DispositionContext]> = [
    ['retired', facts({ routeKey: undefined, areaKey: 'soap:v1', reachable: false }), ctx],
    ['decision table', facts({ routeKey: 'admin:csettings.deployplugin', writeSet: ['tplugins'] }), ctx],
    ['spanning', facts({ routeKey: 'admin:cusers.update{type=2,action=delete}', variantPredicates: { type: '2', action: 'Delete' }, writeSet: ROSTER }), ctx],
    ['legacy-served', facts({ itemKind: 'front-end', routeKey: 'page:render', rendersCfml: true }), ctx],
    ['named carry', facts({ routeKey: 'api:user.save', writeSet: ROSTER }), ctx],
    ['halted carry', facts({ routeKey: 'admin:carch.update{upload=image}', fileStoreWrite: true }), wide],
    ['fixture', facts({ itemKind: 'fixture-route', routeKey: 'fixture:people/persons/{id}/archive@post', fixtureModule: 'people' }), ctx],
  ];

  it.each(SAMPLES)('decides the %s sample purely, with a stated basis and untouched inputs', (_label, f, context) => {
    const before = structuredClone(context);
    const first: DispositionResult = decide(f, context);
    const second: DispositionResult = decide(structuredClone(f), context);
    expect(second).toEqual(first);
    expect(first.basis.length).toBeGreaterThan(0);
    expect(context).toEqual(before);
  });
});
