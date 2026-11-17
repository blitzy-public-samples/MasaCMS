import { describe, expect, it } from 'vitest';
import { computeClosure, memorySourceTree, parseCfmlComponent } from '../../src/inventory/closure.js';
import type { CfmlComponent, ComponentIndex, SourceTree, WriteClosure } from '../../src/inventory/closure.js';
import type { SettledResolution, WriterOverrides } from '../../src/inventory/overrides.js';

const CONTROLLER = 'admin/core/controllers/cthing.cfc';
const THING = 'core/mura/fixture/thingBean.cfc';
const MANAGER = 'core/mura/fixture/thingManager.cfc';
const SERVICE = 'core/mura/fixture/thingService.cfc';
const BEAN_ORM = 'core/mura/bean/beanORM.cfc';
const BEAN_FEED = 'core/mura/bean/beanFeed.cfc';
const BEAN_ITERATOR = 'core/mura/bean/beanIterator.cfc';
const APP_START = 'core/appcfc/onApplicationStart_include.cfm';

/** Receivers the closure resolves only through what a call returns, a request key, a feed's entity, start-up or the variables scope. */
const FILES: Readonly<Record<string, string>> = {
  [CONTROLLER]: `component output="false" {

  public any function chained(rc) {
    rc.bean = getBean('thing').loadBy(thingid=arguments.rc.thingid).set(arguments.rc).validate();
    rc.bean.save();
  }

  public any function managed(rc) {
    variables.thingManager.read(arguments.rc.thingid).set(arguments.rc).save();
  }

  public any function parented(rc) {
    variables.thingManager.touchParent(arguments.rc.thingid);
  }

  public any function keyed(rc) {
    arguments.rc.thingBean = getBean('thing').loadBy(thingid=arguments.rc.thingid);
    arguments.rc.thingBean.delete();
  }

  public any function continued(rc) {
    var found = variables.thingManager
      .read(arguments.rc.thingid);
    found.save();
  }

  public any function iterated(rc) {
    var it = getFeed('thing')
      .where()
      .prop('siteid').isEQ(arguments.rc.siteid)
      .getIterator();
    while (it.hasNext()) {
      it.next().delete();
    }
  }

  public any function entityIterator(rc) {
    var it = getBean('thing').getIterator();
    it.previous().save();
  }

  public any function aliased(rc) {
    application.thingService.purge(arguments.rc.siteid);
  }

  public any function unscopedHelper(rc) {
    prepare();
    helper.save();
  }

  private any function prepare() {
    helper = getBean('thing');
  }

  public any function scriptQuery(rc) {
    var q = new Query();
    local.sql = 'DELETE FROM tthingarchive WHERE 0=0';
    local.sql &= ' AND siteid = :siteid';
    q.addParam(name='siteid', value=arguments.rc.siteid);
    q.setSQL(local.sql);
    q.execute();
  }
}
`,
  [MANAGER]: `<cfcomponent output="false">

<cffunction name="read" output="false">
  <cfargument name="thingID" default="">
  <cfargument name="thingBean" default="">
  <cfset var bean=arguments.thingBean>
  <cfif not isObject(bean)>
    <cfset bean=getBean("thing")>
  </cfif>
  <cfreturn bean>
</cffunction>

<cffunction name="touchParent" output="false">
  <cfargument name="thingID">
  <cfset var parent=read(arguments.thingID)>
  <cfset parent.save()>
</cffunction>

</cfcomponent>
`,
  [SERVICE]: `component output="false" {
  public any function purge(siteid) {
    queryExecute("DELETE FROM tpurge WHERE siteid = :siteid", {siteid=arguments.siteid});
  }
}
`,
  [THING]: `component extends="mura.bean.beanORM" table="tthing" entityname="thing" output="false" {
  property name="thingid" fieldtype="id";
}
`,
  [BEAN_ORM]: `component output="false" {
  function loadBy() {
    return this;
  }
  function set(property, propertyValue) {
    return this;
  }
  function validate() {
    return this;
  }
  function save() {
    return this;
  }
  function delete() {
    return this;
  }
  function getFeed() {
    var feed = getBean('beanFeed').setEntityName(variables.entityName);
    return feed;
  }
  function getIterator() {
    return getBean('beanIterator').setEntityName(variables.entityName);
  }
}
`,
  [BEAN_FEED]: `component output="false" {
  function where() {
    return this;
  }
  function prop(property) {
    return this;
  }
  function isEQ(criteria) {
    return this;
  }
  function getIterator() {
    var it = getBean("#variables.entityName#Iterator");
    it = getBean("beanIterator");
    return it;
  }
}
`,
  [BEAN_ITERATOR]: `component output="false" {
  function hasNext() {
    return false;
  }
  function next() {
    return packageRecord();
  }
  function previous() {
    return packageRecord();
  }
  function packageRecord() {
    return getBean(variables.entityName);
  }
}
`,
  [APP_START]: `<cfscript>
  application.thingService = new mura.fixture.thingService();
</cfscript>
`,
};

const BEANS: Readonly<Record<string, string>> = {
  thing: THING,
  thingmanager: MANAGER,
  beanfeed: BEAN_FEED,
  beaniterator: BEAN_ITERATOR,
};

const tree: SourceTree = memorySourceTree(FILES);

const parsed = new Map<string, CfmlComponent | null>();
const index: ComponentIndex = {
  resolveBean: (name) => BEANS[name.toLowerCase()] ?? null,
  ormTable: (p) => (p === THING ? 'tthing' : null),
  parsed(p) {
    if (!parsed.has(p)) parsed.set(p, p.endsWith('.cfc') && tree.exists(p) ? parseCfmlComponent(p, tree.readText(p)) : null);
    return parsed.get(p) ?? null;
  },
};

function closureOf(method: string): WriteClosure {
  return computeClosure({ component: CONTROLLER, method }, { tree, index });
}

describe('receiver resolution', () => {
  it.each<[string, string, string[]]>([
    ['a bean chain ending in a method that returns this', 'chained', ['tthing:save']],
    ['a manager method returning the bean it loads after a caller-supplied one', 'managed', ['tthing:save']],
    ['a local assigned from an unqualified call of the same component', 'parented', ['tthing:save']],
    ['a request key holding a bean', 'keyed', ['tthing:delete']],
    ['a fluent chain continued on the next line', 'continued', ['tthing:save']],
    ['the next() of an entity feed iterator', 'iterated', ['tthing:delete']],
    ["the previous() of an entity's own iterator", 'entityIterator', ['tthing:save']],
    ['an application-scope name the start-up template assigns', 'aliased', ['tpurge:delete']],
    ['an unscoped name another function sets in the variables scope', 'unscopedHelper', ['tthing:save']],
    ['SQL a script Query object receives from a local', 'scriptQuery', ['tthingarchive:delete']],
  ])('resolves %s', (_label, method, writes) => {
    const closure = closureOf(method);
    expect(closure.writes.map((w) => `${w.table ?? '?'}:${w.op}`)).toEqual(writes);
    expect(closure.unresolved).toEqual([]);
  });

  it('records the SQL a script Query object receives at the line of its statement', () => {
    const line = (FILES[CONTROLLER] ?? '').split('\n').findIndex((l) => l.includes('DELETE FROM tthingarchive')) + 1;
    const [write] = closureOf('scriptQuery').writes;
    expect(line).toBeGreaterThan(0);
    expect(write).toMatchObject({ table: 'tthingarchive', op: 'delete', source: { path: CONTROLLER, lines: [line, line] } });
  });
});

const MAPPED_CONTROLLER = 'admin/core/controllers/cmapped.cfc';
const MAPPED_ORM = 'core/mura/bean/beanORM.cfc';
const MAPPED_HISTORICAL_BASE = 'core/mura/bean/beanORMHistorical.cfc';
const TRASH_MANAGER = 'core/mura/trash/trashManager.cfc';

/** Entities whose mapping flags decide the trash and history branches of an inherited delete. */
const MAPPED_ENTITIES: Readonly<Record<string, [path: string, table: string, source: string]>> = {
  plain: [
    'core/mura/fixture/plainBean.cfc',
    'tplain',
    'component extends="mura.bean.beanORM" table="tplain" entityname="plain" {\n  property name="plainid" fieldtype="id";\n}\n',
  ],
  trashed: [
    'core/mura/fixture/trashedBean.cfc',
    'ttrashed',
    'component extends="mura.bean.beanORM" table="ttrashed" entityname="trashed" usetrash=true {\n  property name="trashedid" fieldtype="id";\n}\n',
  ],
  historical: [
    'core/mura/fixture/historicalBean.cfc',
    'thist',
    'component extends="mura.bean.beanORMHistorical" table="thist" entityname="historical" {\n  property name="historicalid" fieldtype="index";\n}\n',
  ],
  overriding: [
    'core/mura/fixture/overridingBean.cfc',
    'toverriding',
    'component extends="mura.bean.beanORM" table="toverriding" entityname="overriding" {\n  function getUseTrash() {\n    return variables.trash;\n  }\n}\n',
  ],
};

const MAPPED_FILES: Readonly<Record<string, string>> = {
  [MAPPED_CONTROLLER]: `component output="false" {
${Object.keys(MAPPED_ENTITIES)
  .map((name) => `  public any function ${name}(rc) {\n    getBean('${name}').loadBy(id=arguments.rc.id).delete();\n  }\n`)
  .join('')}
  public any function pruned(rc) {
    var plain = getBean('plain');
    plain.save();
  }
}
`,
  [MAPPED_ORM]: `component output="false" {
  function loadBy() {
    return this;
  }
  function save() {
    return this;
  }
  function delete() {
    if (getIsHistorical()) {
      queryExecute("UPDATE thistory SET deleted = 1 WHERE siteid = :siteid", {siteid=1});
    }
    if (getUseTrash()) {
      getBean('trashManager').throwIn(this);
    }
    return this;
  }
  function getUseTrash() {
    return application.objectMappings[variables.entityName].usetrash;
  }
  function getIsHistorical() {
    param name="application.objectMappings.#variables.entityName#.historical" default=false;
    return application.objectMappings[variables.entityName].historical;
  }
}
`,
  [MAPPED_HISTORICAL_BASE]: `component extends="mura.bean.beanORM" historical=true {
  property name="histid" fieldtype="id" historical=true;
}
`,
  [TRASH_MANAGER]: `component output="false" {
  function throwIn(bean) {
    queryExecute("INSERT INTO ttrash (objectid) VALUES (:objectid)", {objectid=1});
  }
}
`,
  ...Object.fromEntries(Object.values(MAPPED_ENTITIES).map(([p, , source]) => [p, source])),
};

const mappedTree: SourceTree = memorySourceTree(MAPPED_FILES);
const mappedParsed = new Map<string, CfmlComponent | null>();
const mappedIndex: ComponentIndex = {
  resolveBean: (name) => (name.toLowerCase() === 'trashmanager' ? TRASH_MANAGER : (MAPPED_ENTITIES[name.toLowerCase()]?.[0] ?? null)),
  ormTable: (p) => Object.values(MAPPED_ENTITIES).find(([path]) => path === p)?.[1] ?? null,
  parsed(p) {
    if (!mappedParsed.has(p)) mappedParsed.set(p, p.endsWith('.cfc') && mappedTree.exists(p) ? parseCfmlComponent(p, mappedTree.readText(p)) : null);
    return mappedParsed.get(p) ?? null;
  },
};

function mappedClosure(method: string, overrides?: WriterOverrides): WriteClosure {
  return computeClosure({ component: MAPPED_CONTROLLER, method }, { tree: mappedTree, index: mappedIndex, overrides });
}

describe('mapping flags of the receiving entity', () => {
  it.each<[string, string, string[], string[]]>([
    ['neither flag', 'plain', ['tplain:delete'], []],
    ['its own usetrash attribute', 'trashed', ['ttrash:insert', 'ttrashed:delete'], []],
    ['a historical property up its chain', 'historical', ['thist:delete', 'thistory:update'], []],
    ['a mapping getter of its own, left undecided', 'overriding', ['toverriding:delete', 'ttrash:insert'], ['ttrash:insert']],
  ])('decides an inherited guard for an entity with %s', (_label, method, writes, conditional) => {
    const closure = mappedClosure(method);
    expect(closure.writes.map((w) => `${w.table ?? '?'}:${w.op}`).sort()).toEqual(writes);
    expect(closure.writes.filter((w) => w.conditional).map((w) => `${w.table ?? '?'}:${w.op}`)).toEqual(conditional);
    expect(closure.unresolved).toEqual([]);
  });
});

describe('settled calls on a resolved call', () => {
  const line = (MAPPED_FILES[MAPPED_CONTROLLER] ?? '').split('\n').findIndex((l) => l.includes('plain.save();')) + 1;

  /** One settled call naming the resolved `plain.save` with `resolution`. */
  function settledAs(resolution: SettledResolution): WriterOverrides {
    return {
      sourceSha: '0'.repeat(40),
      writers: [],
      settledCalls: [
        {
          id: 'wov:fixture-plain-save',
          source: { path: MAPPED_CONTROLLER, lines: [line, line] },
          calls: ['plain.save'],
          resolution,
          ...(resolution === 'counted' ? { countedBy: ['tplain'] } : {}),
          reason: 'Fixture.',
        },
      ],
    };
  }

  it.each<[SettledResolution, string[]]>([
    ['unreachable', []],
    ['non-write', []],
    ['not-cfml', []],
    ['counted', ['tplain:save']],
  ])('walks a call settled as %s only when its writes are counted', (resolution, writes) => {
    expect(line).toBeGreaterThan(0);
    expect(mappedClosure('pruned').writes.map((w) => `${w.table ?? '?'}:${w.op}`)).toEqual(['tplain:save']);
    const closure = mappedClosure('pruned', settledAs(resolution));
    expect(closure.writes.map((w) => `${w.table ?? '?'}:${w.op}`)).toEqual(writes);
    expect(closure.overrides).toEqual(resolution === 'counted' ? [] : ['wov:fixture-plain-save']);
  });
});
