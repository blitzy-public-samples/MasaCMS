import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { memorySourceTree, openSourceTree, parseCfmlComponent } from '../../src/inventory/closure.js';
import type { CfmlComponent, ClosureContext, ComponentIndex, SourceTree } from '../../src/inventory/closure.js';
import {
  LIVE_SOURCE,
  NOT_ENTITY_REASON,
  attachDaoWrites,
  classCounts,
  extractEntities,
  fetchLiveEntities,
  mergeLive,
  ormEntityIndex,
} from '../../src/inventory/entities.js';
import type {
  EntityClass,
  EntityEntry,
  EntityExtraction,
  FetchLiveEntitiesDeps,
  LiveEntities,
} from '../../src/inventory/entities.js';

type FetchLike = NonNullable<FetchLiveEntitiesDeps['fetch']>;

const ORM_VERSIONED = 'core/mura/bean/beanORMVersioned.cfc';
const FIXTURE_BASE = 'core/mura/fixture/fixtureBase.cfc';
const FIXTURE_BEAN = 'core/mura/fixture/fixtureBean.cfc';
const VERSIONED_BEAN = 'core/mura/fixture/fixtureVersionedBean.cfc';
const FIXTURE_MANAGER = 'core/mura/fixture/fixtureManager.cfc';
const LABEL_BEAN = 'core/mura/fixture/labelBean.cfc';
const ROSTER_DAO = 'core/mura/fixture/rosterDAO.cfc';
const NOTE_BEAN = 'core/mura/fixture/noteBean.cfc';
const ROSTER_BEAN = 'core/mura/fixture/rosterBean.cfc';
const TALLY_BEAN = 'core/mura/fixture/tallyBean.cfc';
const JSON_API_UTILITY = 'core/mura/client/api/json/v1/jsonApiUtility.cfc';
const PLUGIN_CONFIG = 'core/mura/plugin/pluginConfig.cfc';
const PLUGIN_BEAN = 'plugins/demo/model/beans/plugindemo.cfc';

/** Committed CFML fixtures by their place in the temp tree. */
const FIXTURES: Readonly<Record<string, string>> = {
  [ORM_VERSIONED]: 'orm-base.cfc',
  [FIXTURE_BASE]: 'orm-base.cfc',
  [FIXTURE_BEAN]: 'entity-with-bom.cfc',
  [VERSIONED_BEAN]: 'versioned-entity.cfc',
  [FIXTURE_MANAGER]: 'not-entity-manager.cfc',
  [LABEL_BEAN]: 'tag-component.cfc',
  [ROSTER_DAO]: 'dao-writes.cfc',
};

/** Inline components: both dynamic-family declaration sites, three domain-bean persistence styles, a plugin entity. */
const INLINE: Readonly<Record<string, string>> = {
  [JSON_API_UTILITY]: `component extends="mura.cfobject" output="false" {

	public any function declareEntity(required string entityConfig) {
		return this;
	}
}
`,
  [PLUGIN_CONFIG]: `<cfcomponent extends="mura.cfobject" output="false">

<cffunction name="registerBeanDir" output="false">
	<cfargument name="dir" type="string" required="true">
	<cfreturn this>
</cffunction>

</cfcomponent>
`,
  [NOTE_BEAN]: `component extends="mura.cfobject" output="false" {

	public any function save() {
		getBean('rosterDAO').create(variables.instance);
		return this;
	}
}
`,
  [ROSTER_BEAN]: `component extends="mura.cfobject" output="false" {

	public any function getRosterID() {
		return variables.instance.rosterid;
	}
}
`,
  [TALLY_BEAN]: `component extends="mura.cfobject" output="false" {

	public any function save() {
		queryExecute("INSERT INTO ttally (tallyid) VALUES (:tallyid)", {tallyid=createUUID()});
		return this;
	}
}
`,
  [PLUGIN_BEAN]: `component extends="mura.bean.beanORM" table="plugindemo" entityname="plugindemo" {
	property name="plugindemoid" fieldtype="id";
}
`,
};

const ORIGIN = 'http://legacy.invalid:8080';

let root: string;
let tree: SourceTree;
let extraction: EntityExtraction;

/** One registration as `run.cfm?info=entities` emits it. */
function liveEntity(fields: { name: string } & Record<string, unknown>): Record<string, unknown> {
  return {
    displayName: null,
    table: null,
    componentPath: null,
    componentFile: null,
    isSingleton: false,
    dynamic: null,
    versioned: null,
    bundleable: null,
    historical: null,
    scaffold: null,
    public: null,
    readonly: null,
    manageSchema: null,
    useTrash: null,
    inBundleableBeans: false,
    inVersionedBeans: false,
    properties: [],
    registrationComplete: true,
    origin: 'core',
    ...fields,
  };
}

const LIVE_PAYLOAD = {
  generatedAt: '2026-11-13T00:00:00Z',
  bundleableBeans: ['fb_contact', 'fixture'],
  versionedBeans: ['fixtureVersioned'],
  entities: [
    liveEntity({ name: 'fb_contact', table: 'FB_Contact', dynamic: true, bundleable: true, origin: 'formBuilder' }),
    liveEntity({ name: 'fixture', table: 'tfixture', componentPath: 'mura.fixture.fixtureBean', bundleable: true }),
    liveEntity({
      name: 'fixtureVersioned',
      table: 'tfixtureversioned',
      componentPath: 'muraWRM.core.mura.fixture.fixtureVersionedBean',
      versioned: true,
      origin: 'other',
    }),
    liveEntity({ name: 'label' }),
    liveEntity({
      name: 'plugindemo',
      table: 'plugindemo',
      componentPath: 'plugins.demo.model.beans.plugindemo',
      componentFile: '/var/www/plugins/demo/model/beans/plugindemo.cfc',
      origin: 'plugin',
    }),
    liveEntity({ name: 'stray', componentPath: 'mura.missing.stray', registrationComplete: false }),
    liveEntity({
      name: 'widget',
      table: 'twidget',
      dynamic: true,
      versioned: true,
      bundleable: false,
      origin: 'dynamic',
    }),
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function byEntityId(entities: readonly EntityEntry[], id: string): EntityEntry {
  const found = entities.find((e) => e.id === id);
  if (found === undefined) throw new Error(`no entity ${id}`);
  return found;
}

/** Component index over `source` with the given bean registrations and the extraction's ORM tables. */
function fixtureIndex(
  source: SourceTree,
  beans: Readonly<Record<string, string>>,
  orm: EntityExtraction,
): ComponentIndex {
  const cache = new Map<string, CfmlComponent | null>();
  return {
    resolveBean: (name) => beans[name.toLowerCase()] ?? null,
    ormTable: (p) => orm.ormIndex.byComponent.get(p) ?? null,
    parsed(p) {
      if (!cache.has(p)) cache.set(p, source.exists(p) ? parseCfmlComponent(p, source.readText(p)) : null);
      return cache.get(p) ?? null;
    },
  };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-entities-'));
  for (const [rel, name] of Object.entries(FIXTURES)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await copyFile(fileURLToPath(new URL(`../fixtures/cfml/${name}`, import.meta.url)), path.join(root, rel));
  }
  for (const [rel, text] of Object.entries(INLINE)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, 'utf8');
  }
  tree = openSourceTree(root);
  extraction = extractEntities(tree);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('static classification', () => {
  it('lists one entry per classified component and dynamic-family site, sorted by id', () => {
    const ids = extraction.entities.map((e) => e.id);
    expect(ids).toEqual([
      'ent:beanORMVersioned',
      'ent:dyn:fb_*',
      'ent:dyn:plugin-declared',
      'ent:dyn:tentity-declared',
      'ent:fixtureBase',
      'ent:fixtureBean',
      'ent:fixtureManager',
      'ent:fixtureVersionedBean',
      'ent:labelBean',
      'ent:noteBean',
      'ent:rosterBean',
      'ent:tallyBean',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each<[string, Partial<EntityEntry>]>([
    [
      'ent:beanORMVersioned',
      {
        class: 'orm-base',
        source: { path: ORM_VERSIONED, lines: [2, 2] },
        component: 'mura.bean.beanORMVersioned',
        extends: 'mura.bean.beanORM',
        bom: false,
        table: null,
        registeredName: 'beanORMVersioned',
        writesTables: null,
        writesBasis: null,
      },
    ],
    [
      'ent:fixtureBase',
      {
        class: 'orm-base',
        source: { path: FIXTURE_BASE, lines: [2, 2] },
        component: 'mura.fixture.fixtureBase',
        extends: 'mura.bean.beanORM',
        bom: false,
        table: null,
        entityname: null,
        registeredName: 'fixtureBase',
        writesTables: null,
        writesBasis: null,
      },
    ],
    [
      'ent:fixtureBean',
      {
        class: 'orm-concrete',
        source: { path: FIXTURE_BEAN, lines: [1, 1] },
        component: 'mura.fixture.fixtureBean',
        extends: 'mura.bean.beanORM',
        bom: true,
        table: 'tfixture',
        entityname: 'fixture',
        registeredName: 'fixture',
        writesTables: ['tfixture'],
        writesBasis: 'orm-table',
      },
    ],
    [
      'ent:fixtureVersionedBean',
      {
        class: 'orm-concrete',
        source: { path: VERSIONED_BEAN, lines: [2, 2] },
        component: 'mura.fixture.fixtureVersionedBean',
        extends: 'mura.bean.beanORMVersioned',
        bom: false,
        table: 'tfixtureversioned',
        entityname: 'fixtureVersioned',
        registeredName: 'fixtureVersioned',
        writesTables: ['tfixtureversioned'],
        writesBasis: 'orm-table',
      },
    ],
    [
      'ent:fixtureManager',
      {
        class: 'not-entity',
        source: { path: FIXTURE_MANAGER, lines: [2, 2] },
        component: 'mura.fixture.fixtureManager',
        extends: 'mura.cfobject',
        bom: false,
        table: null,
        registeredName: null,
        reason: NOT_ENTITY_REASON,
        beanORMTextLines: [7],
        writesTables: null,
        writesBasis: null,
      },
    ],
    [
      'ent:labelBean',
      {
        class: 'domain-bean',
        source: { path: LABEL_BEAN, lines: [2, 2] },
        component: 'mura.fixture.labelBean',
        extends: 'mura.cfobject',
        bom: false,
        table: null,
        registeredName: 'label',
        reason: null,
        dao: null,
        writesTables: null,
        writesBasis: null,
      },
    ],
    [
      'ent:dyn:fb_*',
      {
        class: 'dynamic',
        pattern: true,
        source: { path: FIXTURE_MANAGER, lines: [7, 7] },
        component: 'mura.fixture.fixtureManager',
        bom: false,
        table: 'fb_*',
        origin: 'formBuilder',
        registeredName: null,
      },
    ],
    [
      'ent:dyn:tentity-declared',
      {
        class: 'dynamic',
        pattern: true,
        source: { path: JSON_API_UTILITY, lines: [3, 5] },
        component: 'mura.client.api.json.v1.jsonApiUtility',
        bom: false,
        table: null,
        origin: 'dynamic',
      },
    ],
    [
      'ent:dyn:plugin-declared',
      {
        class: 'dynamic',
        pattern: true,
        source: { path: PLUGIN_CONFIG, lines: [3, 6] },
        component: 'mura.plugin.pluginConfig',
        bom: false,
        table: null,
        origin: 'plugin',
      },
    ],
  ])('classifies %s from its declaration', (id, expected) => {
    expect(byEntityId(extraction.entities, id)).toMatchObject(expected);
  });

  it('reads the declaration after a byte-order mark the copy kept on disk', async () => {
    const bytes = await readFile(path.join(root, FIXTURE_BEAN));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(extraction.entities.filter((e) => e.bom === true).map((e) => e.id)).toEqual(['ent:fixtureBean']);
  });

  it('creates no entity or ORM table from ORM source held in a string literal', () => {
    expect(extraction.entities.filter((e) => e.source.path === FIXTURE_MANAGER).map((e) => e.id)).toEqual([
      'ent:dyn:fb_*',
      'ent:fixtureManager',
    ]);
    expect(extraction.ormTables).toEqual(['tfixture', 'tfixtureversioned']);
  });

  it('skips components that are neither ORM, ORM-text holders nor beans', () => {
    const paths = new Set(extraction.entities.filter((e) => !e.pattern).map((e) => e.source.path));
    for (const skipped of [ROSTER_DAO, JSON_API_UTILITY, PLUGIN_CONFIG, PLUGIN_BEAN]) {
      expect(paths.has(skipped)).toBe(false);
    }
  });

  it('counts each class as tallied from the entries, with dynamic instances unknown before a live run', () => {
    const tally = (cls: EntityClass): number => extraction.entities.filter((e) => e.class === cls).length;
    expect(extraction.counts).toEqual({
      ormBase: tally('orm-base'),
      ormConcrete: tally('orm-concrete'),
      notEntity: tally('not-entity'),
      domainBean: tally('domain-bean'),
      dynamic: null,
      dynamicPatterns: extraction.entities.filter((e) => e.pattern).length,
    });
    expect(extraction.counts).toEqual({
      ormBase: 2,
      ormConcrete: 2,
      notEntity: 1,
      domainBean: 4,
      dynamic: null,
      dynamicPatterns: 3,
    });
    expect(classCounts(extraction.entities)).toEqual(extraction.counts);
  });

  it('leaves live fields pending and owners unset without live data', () => {
    for (const e of extraction.entities) {
      expect(e).toMatchObject({
        liveRegistered: null,
        liveNames: null,
        liveInstances: null,
        liveStatus: 'pending-run',
      });
      expect(e).not.toHaveProperty('owningService');
      expect(e).not.toHaveProperty('disposition');
    }
  });
});

describe('ormEntityIndex', () => {
  it.each<[string, string | undefined]>([
    [FIXTURE_BEAN, 'tfixture'],
    [VERSIONED_BEAN, 'tfixtureversioned'],
    [FIXTURE_BASE, undefined],
    [ORM_VERSIONED, undefined],
    [FIXTURE_MANAGER, undefined],
    [LABEL_BEAN, undefined],
  ])('maps %s to table %s', (component, table) => {
    expect(extraction.ormIndex.byComponent.get(component)).toBe(table);
  });

  it('indexes concrete entities by lower-cased registered name and matches a rebuild from the entries', () => {
    expect([...extraction.ormIndex.byEntityName]).toEqual([
      ['fixture', FIXTURE_BEAN],
      ['fixtureversioned', VERSIONED_BEAN],
    ]);
    expect(ormEntityIndex(extraction.entities)).toEqual(extraction.ormIndex);
  });
});

describe('in-memory tree edge cases', () => {
  const memory = memorySourceTree({
    'core/mura/bean/beanORM.cfc': 'component extends="mura.cfobject" {}\n',
    'core/mura/bean/beanORMHistorical.cfc': 'component extends="beanORM" {}\n',
    'core/mura/a/itemBean.cfc': 'component extends="mura.bean.beanormhistorical" table="TItems" {}\n',
    'core/mura/b/itemBean.cfc':
      'component extends="mura.bean.beanORMHistorical" table="titems_b" entityname="mura.custom.item" {}\n',
    'core/mura/c/loopBean.cfc': 'component extends="loopBaseBean" {}\n',
    'core/mura/c/loopBaseBean.cfc': 'component extends="loopBean" {}\n',
    'core/mura/c/notes.cfc': '<cfset notes = "no component here">\n',
    'core/mura/d/generatorManager.cfc': [
      'component extends="mura.cfobject" {',
      `\tvariables.second = 'component extends="mura.bean.beanORM" table="tgen" {';`,
      `\tvariables.first = 'component extends="mura.bean.beanORM" {' & ` +
        `'component extends="mura.bean.beanORMHistorical" {' & 'component extends="mura.cfobject" {';`,
      '}',
      '',
    ].join('\n'),
  });
  const result = extractEntities(memory);

  it('falls back to path ids for shared base names and leaves the ORM root out', () => {
    expect(result.entities.map((e) => [e.id, e.class])).toEqual([
      ['ent:a/itemBean', 'orm-concrete'],
      ['ent:b/itemBean', 'orm-concrete'],
      ['ent:beanORMHistorical', 'orm-base'],
      ['ent:generatorManager', 'not-entity'],
      ['ent:loopBaseBean', 'domain-bean'],
      ['ent:loopBean', 'domain-bean'],
    ]);
  });

  it('records each line of ORM source text once, ignoring non-ORM text and adding no form-builder site', () => {
    expect(byEntityId(result.entities, 'ent:generatorManager')).toMatchObject({
      beanORMTextLines: [2, 3],
      reason: NOT_ENTITY_REASON,
      registeredName: null,
      table: null,
    });
    expect(result.ormTables).not.toContain('tgen');
    expect(result.entities.some((e) => e.pattern)).toBe(false);
  });

  it('resolves extends case-insensitively and through a sibling of the ORM root, lower-casing tables', () => {
    expect(byEntityId(result.entities, 'ent:a/itemBean')).toMatchObject({
      extends: 'mura.bean.beanormhistorical',
      table: 'titems',
      registeredName: 'item',
    });
    expect(byEntityId(result.entities, 'ent:b/itemBean')).toMatchObject({
      table: 'titems_b',
      entityname: 'mura.custom.item',
      registeredName: 'item',
    });
    expect(result.ormTables).toEqual(['titems', 'titems_b']);
  });

  it('keeps the first id for a registered name two entities share', () => {
    expect([...result.ormIndex.byEntityName]).toEqual([['item', 'core/mura/a/itemBean.cfc']]);
  });

  it('reports no byte-order mark knowledge and no dynamic patterns for an in-memory tree', () => {
    expect(result.entities.every((e) => e.bom === null)).toBe(true);
    expect(result.counts).toEqual({
      ormBase: 1,
      ormConcrete: 2,
      notEntity: 1,
      domainBean: 2,
      dynamic: null,
      dynamicPatterns: 0,
    });
  });

  it('gives cyclic domain beans no DAO', () => {
    const ctx: ClosureContext = { tree: memory, index: fixtureIndex(memory, {}, result) };
    const beans = attachDaoWrites(result.entities, ctx).filter((e) => e.class === 'domain-bean');
    expect(beans.map((e) => [e.id, e.dao, e.writesTables, e.writesBasis])).toEqual([
      ['ent:loopBaseBean', null, null, null],
      ['ent:loopBean', null, null, null],
    ]);
  });
});

describe('fetchLiveEntities', () => {
  it('GETs the entities probe from the legacy origin and keeps fields it does not read', async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse(LIVE_PAYLOAD));
    const live = await fetchLiveEntities(ORIGIN, { fetch, timeoutMs: 5_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${ORIGIN}/harness/legacy-baseline/cfml/run.cfm?info=entities`);
    expect(fetch.mock.calls[0]?.[1].method).toBe('GET');
    expect(live).toEqual(LIVE_PAYLOAD);
  });

  it.each<[string, number, unknown, RegExp]>([
    ['a non-200 answer', 500, { error: 'boom' }, /^live entity probe .*run\.cfm\?info=entities answered HTTP 500$/],
    [
      'a registration without an origin',
      200,
      { ...LIVE_PAYLOAD, entities: [{ ...liveEntity({ name: 'fixture' }), origin: undefined }] },
      /returned an invalid payload:[\s\S]*origin/,
    ],
  ])('rejects %s', async (_label, status, body, message) => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse(body, status));
    await expect(fetchLiveEntities(ORIGIN, { fetch })).rejects.toThrow(message);
  });
});

describe('mergeLive', () => {
  let live: LiveEntities;
  let merged: EntityEntry[];

  beforeAll(async () => {
    live = await fetchLiveEntities(ORIGIN, { fetch: vi.fn<FetchLike>(async () => jsonResponse(LIVE_PAYLOAD)) });
    merged = mergeLive(extraction.entities, live, tree);
  });

  it('matches registrations by component path, folding the muraWRM mapping, or by name when it has none', () => {
    expect(byEntityId(merged, 'ent:fixtureBean')).toMatchObject({
      liveRegistered: true,
      liveNames: ['fixture'],
      liveInstances: 1,
      liveStatus: 'live',
    });
    expect(byEntityId(merged, 'ent:fixtureVersionedBean')).toMatchObject({
      liveRegistered: true,
      liveNames: ['fixtureVersioned'],
    });
    expect(byEntityId(merged, 'ent:labelBean')).toMatchObject({ liveRegistered: true, liveNames: ['label'] });
  });

  it.each([
    'ent:beanORMVersioned',
    'ent:fixtureBase',
    'ent:fixtureManager',
    'ent:noteBean',
    'ent:rosterBean',
    'ent:tallyBean',
  ])('marks %s, absent from the live registrations, as not registered', (id) => {
    expect(byEntityId(merged, id)).toMatchObject({
      liveRegistered: false,
      liveNames: [],
      liveInstances: 0,
      liveStatus: 'live',
    });
  });

  it('adds each unmatched registration once as a live dynamic entry and counts it on its pattern', () => {
    const dynamic = merged.filter((e) => e.class === 'dynamic' && !e.pattern);
    expect(dynamic.map((e) => [e.id, e.patternId, e.liveStatus])).toEqual([
      ['ent:dynamic:fb_contact', 'ent:dyn:fb_*', 'live'],
      ['ent:dynamic:plugindemo', 'ent:dyn:plugin-declared', 'live'],
      ['ent:dynamic:stray', null, 'live'],
      ['ent:dynamic:widget', 'ent:dyn:tentity-declared', 'live'],
    ]);
    expect(
      merged.filter((e) => e.pattern).map((e) => [e.id, e.liveRegistered, e.liveNames, e.liveInstances, e.liveStatus]),
    ).toEqual([
      ['ent:dyn:fb_*', null, ['fb_contact'], 1, 'live'],
      ['ent:dyn:plugin-declared', null, ['plugindemo'], 1, 'live'],
      ['ent:dyn:tentity-declared', null, ['widget'], 1, 'live'],
    ]);
    expect(merged.map((e) => e.id)).toEqual(merged.map((e) => e.id).sort());
    expect(classCounts(merged)).toEqual({ ...extraction.counts, dynamic: 4 });
  });

  it('records a registration without a declaration from the live facts alone', () => {
    expect(byEntityId(merged, 'ent:dynamic:fb_contact')).toEqual({
      id: 'ent:dynamic:fb_contact',
      class: 'dynamic',
      source: LIVE_SOURCE,
      component: null,
      extends: null,
      bom: null,
      pattern: false,
      table: 'fb_contact',
      entityname: null,
      registeredName: 'fb_contact',
      bundleable: 'true',
      versioned: null,
      historical: null,
      reason: null,
      beanORMTextLines: null,
      origin: 'formBuilder',
      patternId: 'ent:dyn:fb_*',
      dao: null,
      writesTables: null,
      writesBasis: null,
      liveRegistered: true,
      liveNames: ['fb_contact'],
      liveInstances: 1,
      liveStatus: 'live',
    });
    expect(byEntityId(merged, 'ent:dynamic:widget')).toMatchObject({
      table: 'twidget',
      versioned: 'true',
      bundleable: 'false',
    });
    expect(byEntityId(merged, 'ent:dynamic:stray')).toMatchObject({
      source: LIVE_SOURCE,
      component: 'mura.missing.stray',
      table: null,
    });
  });

  it.each<[string, () => SourceTree | undefined, Partial<EntityEntry>]>([
    [
      'with',
      () => tree,
      {
        source: { path: PLUGIN_BEAN, lines: [1, 1] },
        extends: 'mura.bean.beanORM',
        bom: false,
        entityname: 'plugindemo',
      },
    ],
    ['without', () => undefined, { source: LIVE_SOURCE, extends: null, bom: null, entityname: null }],
  ])('locates a dynamic registration declaration %s the source tree', (_label, source, expected) => {
    const entry = byEntityId(mergeLive(extraction.entities, live, source()), 'ent:dynamic:plugindemo');
    expect(entry).toMatchObject({
      ...expected,
      component: 'plugins.demo.model.beans.plugindemo',
      table: 'plugindemo',
      registeredName: 'plugindemo',
      origin: 'plugin',
    });
  });

  it('replaces earlier live instances on a re-merge and resets to pending without live data', () => {
    expect(mergeLive(merged, live, tree)).toEqual(merged);
    expect(mergeLive(merged, null)).toEqual(extraction.entities);
  });
});

describe('attachDaoWrites', () => {
  let attached: EntityEntry[];

  beforeAll(() => {
    const ctx: ClosureContext = { tree, index: fixtureIndex(tree, { rosterdao: ROSTER_DAO }, extraction) };
    attached = attachDaoWrites(extraction.entities, ctx);
  });

  it.each<[string, Pick<EntityEntry, 'dao' | 'writesTables' | 'writesBasis'>]>([
    ['ent:labelBean', { dao: null, writesTables: null, writesBasis: null }],
    ['ent:noteBean', { dao: ROSTER_DAO, writesTables: ['tfixture'], writesBasis: 'bean-save' }],
    [
      'ent:rosterBean',
      { dao: ROSTER_DAO, writesTables: ['tfixture', 'tfixturemembers', 'tfixturestats'], writesBasis: 'dao-methods' },
    ],
    ['ent:tallyBean', { dao: TALLY_BEAN, writesTables: ['ttally'], writesBasis: 'bean-save' }],
  ])('derives the DAO and write set of %s', (id, expected) => {
    expect(byEntityId(attached, id)).toMatchObject(expected);
  });

  it('leaves every entry that is not a domain bean unchanged', () => {
    const others = (list: readonly EntityEntry[]): EntityEntry[] => list.filter((e) => e.class !== 'domain-bean');
    expect(others(attached)).toEqual(others(extraction.entities));
    expect(attached.map((e) => e.id)).toEqual(extraction.entities.map((e) => e.id));
  });
});
