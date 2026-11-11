import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  computeClosure,
  extractCalls,
  extractSqlWrites,
  lineOf,
  openSourceTree,
  parseCfmlComponent,
  stripComments,
} from '../../src/inventory/closure.js';
import type {
  CfmlComponent,
  CfmlFunction,
  ClosureEntry,
  ComponentIndex,
  Predicates,
  SourceTree,
  WriteClosure,
} from '../../src/inventory/closure.js';
import { loadWriterOverrides, parseWriterOverrides } from '../../src/inventory/overrides.js';
import type { WriterOverrides } from '../../src/inventory/overrides.js';

const TAG_COMPONENT = 'core/mura/fixture/tagComponent.cfc';
const FIXTURE_BEAN = 'core/mura/fixture/fixtureBean.cfc';
const FIXTURE_MANAGER = 'core/mura/fixture/fixtureManager.cfc';
const FIXTURE_DAO = 'core/mura/fixture/fixtureDAO.cfc';
const ROSTER_MANAGER = 'core/mura/fixture/rosterManager.cfc';
const LOOP_MANAGER = 'core/mura/fixture/loopManager.cfc';
const FILE_MANAGER = 'core/mura/content/file/fileManager.cfc';
const CFIXTURE = 'admin/core/controllers/cfixture.cfc';
const CBRANCH = 'admin/core/controllers/cbranch.cfc';

/** Committed CFML fixtures by their place in the temp tree. */
const FIXTURES: Readonly<Record<string, string>> = {
  [TAG_COMPONENT]: 'tag-component.cfc',
  [FIXTURE_BEAN]: 'entity-with-bom.cfc',
  [FIXTURE_MANAGER]: 'manager-writes.cfc',
  [FIXTURE_DAO]: 'dao-writes.cfc',
  [CFIXTURE]: 'controller-gate.cfc',
};

/** Inline excerpts modelled on userManager.cfc, cusers.cfc and fileManager.cfc; cbranch also routes ORM save, re-login and thread calls through a controller. */
const INLINE: Readonly<Record<string, string>> = {
  [ROSTER_MANAGER]: `component extends="mura.cfobject" output="false" {

	public any function update(required struct data) {
		return getBean('fixtureDAO').update(arguments.data);
	}

	public any function delete(required string userid) {
		getBean('fixtureDAO').deleteMembership(arguments.userid);
	}

	public any function create(required struct data) {
		return getBean('fixtureDAO').create(arguments.data);
	}
}
`,
  [CBRANCH]: `component extends="controller" output="false" {

	public any function save(rc) {
		if (arguments.rc.type == 1) {
			getBean('fixtureDAO').deleteMembership(arguments.rc.userid, arguments.rc.groupid);
		} else {
			getBean('fixtureDAO').update(arguments.rc);
		}
	}

	public any function upload(rc) {
		getBean('fileManager').deleteVersion(arguments.rc.photoFileID);
	}

	public any function orphan(rc) {
		getBean('noSuchBean').save(arguments.rc);
	}

	public any function store(rc) {
		getBean('fixture').save(arguments.rc);
	}

	public any function relogin(rc) {
		getBean('fixtureManager').refreshLogin(arguments.rc.userBean);
	}

	public any function stats(rc) {
		getBean('fixtureManager').trackStats(arguments.rc.siteid);
	}
}
`,
  [FILE_MANAGER]: `<cfcomponent extends="mura.cfobject" output="false">

<cffunction name="deleteVersion" output="false">
		<cfargument name="fileID" type="any" required="yes"/>

		<cfset variables.fileDAO.deleteVersion(arguments.fileID) />

</cffunction>

</cfcomponent>
`,
  [LOOP_MANAGER]: `component output="false" {
	public any function spin(rc) { spin(arguments.rc); return this.spin(arguments.rc); }
}
`,
};

const BEANS: Readonly<Record<string, string>> = {
  fixturedao: FIXTURE_DAO,
  usermanager: ROSTER_MANAGER,
  fixturemanager: FIXTURE_MANAGER,
  filemanager: FILE_MANAGER,
  fixture: FIXTURE_BEAN,
};

const ORM_TABLES: Readonly<Record<string, string>> = { [FIXTURE_BEAN]: 'tfixture' };

const OVERRIDES_FIXTURE = fileURLToPath(new URL('../fixtures/inventory/writer-overrides.valid.yaml', import.meta.url));

let root: string;
let tree: SourceTree;
let index: ComponentIndex;

/** Component index over the temp tree with the fixture bean registrations. */
function fixtureIndex(source: SourceTree): ComponentIndex {
  const parsed = new Map<string, CfmlComponent | null>();
  return {
    resolveBean: (name) => BEANS[name.toLowerCase()] ?? null,
    ormTable: (p) => ORM_TABLES[p] ?? null,
    parsed(p) {
      if (!parsed.has(p)) {
        parsed.set(p, p.endsWith('.cfc') && source.exists(p) ? parseCfmlComponent(p, source.readText(p)) : null);
      }
      return parsed.get(p) ?? null;
    },
  };
}

function component(rel: string): CfmlComponent {
  const unit = index.parsed(rel);
  if (unit === null) throw new Error(`${rel} declares no component`);
  return unit;
}

function fn(unit: CfmlComponent, name: string): CfmlFunction {
  const found = unit.functions.find((f) => f.name === name);
  if (found === undefined) throw new Error(`${unit.path} has no function ${name}`);
  return found;
}

/** 1-based line of the first line of `rel` that contains `needle`. */
function lineWith(rel: string, needle: string): number {
  const line = tree.readText(rel).split('\n').findIndex((l) => l.includes(needle));
  if (line < 0) throw new Error(`${rel} has no line containing ${needle}`);
  return line + 1;
}

function closure(
  entry: string,
  method: string,
  opts: Omit<ClosureEntry, 'component' | 'method'> = {},
  overrides?: WriterOverrides,
): WriteClosure {
  return computeClosure({ component: entry, method, ...opts }, { tree, index, overrides });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-closure-'));
  for (const [rel, name] of Object.entries(FIXTURES)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await copyFile(fileURLToPath(new URL(`../fixtures/cfml/${name}`, import.meta.url)), path.join(root, rel));
  }
  for (const [rel, text] of Object.entries(INLINE)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, 'utf8');
  }
  tree = openSourceTree(root);
  index = fixtureIndex(tree);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('source tree', () => {
  it('copies the byte-order mark to disk but reads the text without it', async () => {
    const bytes = await readFile(path.join(root, FIXTURE_BEAN));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = tree.readText(FIXTURE_BEAN);
    expect(text.startsWith('\uFEFF')).toBe(false);
    expect(text.startsWith('component extends="mura.bean.beanORM"')).toBe(true);
  });

  it('reports files as existing, but not directories or absent paths', () => {
    expect(tree.exists(FIXTURE_BEAN)).toBe(true);
    expect(tree.exists(CBRANCH)).toBe(true);
    expect(tree.exists('core/mura/fixture')).toBe(false);
    expect(tree.exists('core/mura/fixture/absent.cfc')).toBe(false);
  });

  it('lists a directory in code-unit order and descends only when recursive', () => {
    expect(tree.list('core/mura/fixture')).toEqual([
      FIXTURE_BEAN,
      FIXTURE_DAO,
      FIXTURE_MANAGER,
      LOOP_MANAGER,
      ROSTER_MANAGER,
      TAG_COMPONENT,
    ]);
    expect(tree.list('admin/core/controllers', { ext: ['.cfc'] })).toEqual([CBRANCH, CFIXTURE]);
    expect(tree.list('core')).toEqual([]);
    expect(tree.list('core', { recursive: true, ext: ['cfc'] })).toEqual([
      FILE_MANAGER,
      FIXTURE_BEAN,
      FIXTURE_DAO,
      FIXTURE_MANAGER,
      LOOP_MANAGER,
      ROSTER_MANAGER,
      TAG_COMPONENT,
    ]);
    expect(tree.list('core/mura/absent')).toEqual([]);
  });

  it.each([
    [0, 1],
    [1, 1],
    [2, 2],
    [4, 3],
    [99, 3],
  ])('maps offset %i of a three-line text to line %i', (offset, line) => {
    expect(lineOf('a\nb\nc', offset)).toBe(line);
    expect(tree.lineOf('a\nb\nc', offset)).toBe(line);
  });
});

describe('stripComments', () => {
  const SCRIPT = [
    'component {',
    '  var site = "http://example.com"; // trailing note',
    '  /* block comment',
    '     spans lines */ var after = 1;',
    '}',
  ].join('\n');

  const TAG = [
    '<cfcomponent>',
    '<!--- tag comment',
    '      over two lines ---><cfset after = 1>',
    '<a href="http://example.com">',
    '<cfscript>x = 1; // script note',
    '</cfscript>',
    '</cfcomponent>',
  ].join('\n');

  it.each([
    ['script', SCRIPT],
    ['tag', TAG],
  ])('keeps the length and line count of %s text', (_mode, source) => {
    const stripped = stripComments(source);
    expect(stripped).toHaveLength(source.length);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('blanks line and block comments in script text but keeps // inside a string literal', () => {
    const lines = stripComments(SCRIPT).split('\n');
    expect(lines[1]?.trimEnd()).toBe('  var site = "http://example.com";');
    expect(lines[2]?.trim()).toBe('');
    expect(lines[3]?.trim()).toBe('var after = 1;');
    const stripped = lines.join('\n');
    expect(lineOf(stripped, stripped.indexOf('var after'))).toBe(4);
  });

  it('blanks a multi-line tag comment and script comments only inside cfscript', () => {
    const stripped = stripComments(TAG);
    const lines = stripped.split('\n');
    expect(lines[1]?.trim()).toBe('');
    expect(lines[2]?.trim()).toBe('<cfset after = 1>');
    expect(lineOf(stripped, stripped.indexOf('<cfset after'))).toBe(3);
    expect(lines[3]).toBe('<a href="http://example.com">');
    expect(lines[4]?.trimEnd()).toBe('<cfscript>x = 1;');
  });
});

describe('parseCfmlComponent', () => {
  it('parses tag syntax: declaration, cfproperty and cffunction spans', () => {
    const unit = component(TAG_COMPONENT);
    expect(unit.syntax).toBe('tag');
    expect(unit.declaration.line).toBe(2);
    expect(unit.declaration.attrs).toMatchObject({ extends: 'mura.cfobject', output: 'false' });
    expect(unit.properties.map((p) => [p.name, p.line])).toEqual([['label', 4]]);
    expect(unit.functions.map((f) => [f.name, f.startLine, f.endLine, f.access])).toEqual([
      ['getLabel', 6, 8, 'public'],
      ['setLabel', 10, 14, 'public'],
    ]);
    expect(fn(unit, 'setLabel').args).toEqual([{ name: 'label', line: 11 }]);
  });

  it('parses script syntax after a byte-order mark: entity attributes and properties', async () => {
    const raw = await readFile(path.join(root, FIXTURE_BEAN), 'utf8');
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    const unit = parseCfmlComponent(FIXTURE_BEAN, raw);
    expect(unit?.syntax).toBe('script');
    expect(unit?.declaration.line).toBe(1);
    expect(unit?.declaration.attrs).toMatchObject({
      extends: 'mura.bean.beanORM',
      table: 'tfixture',
      entityname: 'fixture',
      orderby: 'name',
    });
    expect(unit?.properties.map((p) => [p.name, p.line])).toEqual([
      ['fixtureid', 3],
      ['site', 4],
      ['name', 5],
    ]);
    expect(unit?.properties[1]?.attrs).toMatchObject({ fieldtype: 'many-to-one', cfc: 'site', fkcolumn: 'siteid' });
  });

  it('parses script manager functions with their line spans', () => {
    const unit = component(FIXTURE_MANAGER);
    expect(unit.syntax).toBe('script');
    expect(unit.declaration.line).toBe(2);
    expect(unit.functions.map((f) => [f.name, f.startLine, f.endLine, f.access])).toEqual([
      ['rename', 4, 6, 'public'],
      ['purgeSite', 8, 10, 'public'],
      ['trackStats', 12, 16, 'public'],
      ['refreshLogin', 18, 20, 'public'],
      ['create', 22, 24, 'public'],
    ]);
  });

  it('returns null for text that declares no component', () => {
    expect(parseCfmlComponent('core/mura/fixture/none.cfc', '<cfset x = 1>')).toBeNull();
    expect(parseCfmlComponent('core/mura/fixture/none.cfc', 'x = 1;')).toBeNull();
  });
});

describe('extractSqlWrites', () => {
  it.each([
    [FIXTURE_DAO, 'create', { table: 'tfixture', op: 'insert', line: 7, whereParams: [] }],
    [FIXTURE_DAO, 'update', { table: 'tfixture', op: 'update', line: 20, whereParams: ['userid'] }],
    [FIXTURE_DAO, 'deleteMembership', { table: 'tfixturemembers', op: 'delete', line: 30, whereParams: ['userid', 'groupid'] }],
    [FIXTURE_MANAGER, 'rename', { table: 'tfixture', op: 'update', line: 5, whereParams: ['userid'] }],
    [FIXTURE_MANAGER, 'purgeSite', { table: 'tfixture', op: 'delete', line: 9, whereParams: ['siteid'] }],
  ])('finds the request-time write of %s %s', (rel, name, expected) => {
    const unit = component(rel);
    const writes = extractSqlWrites(fn(unit, name), unit);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject(expected);
    expect(writes[0]?.thread).toBeUndefined();
    expect(writes[0]?.dynamic).toBeUndefined();
  });

  it.each([
    [FIXTURE_DAO, 'trackAsync', 38, { name: 'fixtureThread#createUUID()#', line: 36, endLine: 41 }],
    [FIXTURE_MANAGER, 'trackStats', 14, { name: 'fixtureStats', line: 13, endLine: 15 }],
  ])('marks the insert of %s %s as inside its thread', (rel, name, line, thread) => {
    const unit = component(rel);
    const writes = extractSqlWrites(fn(unit, name), unit);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ table: 'tfixturestats', op: 'insert', line, thread });
  });
});

describe('extractCalls', () => {
  it('yields one bean edge for the manager create', () => {
    const unit = component(FIXTURE_MANAGER);
    const calls = extractCalls(fn(unit, 'create'), unit, { tree, index });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      target: { bean: 'fixtureDAO', method: 'create' },
      resolved: FIXTURE_DAO,
      line: 23,
      args: [{ expr: 'arguments' }],
      text: "getBean('fixtureDAO').create",
    });
    expect(calls[0]?.guard).toBeUndefined();
  });

  it('resolves the getUserManager() accessor to the userManager bean in every switch case', () => {
    const unit = component(CFIXTURE);
    const calls = extractCalls(fn(unit, 'update'), unit, { tree, index });
    expect(calls.map((c) => [c.target.bean, c.target.method, c.resolved, c.line])).toEqual([
      ['userManager', 'update', ROSTER_MANAGER, 20],
      ['userManager', 'delete', ROSTER_MANAGER, 23],
      ['userManager', 'create', ROSTER_MANAGER, 26],
    ]);
    expect(calls.every((c) => c.guard !== undefined)).toBe(true);
  });
});

describe('computeClosure', () => {
  const VARIANTS: readonly Predicates[] = [{ action: 'Add' }, { action: 'Update' }, { action: 'Delete' }];

  it.each([
    ['Add', 'tfixture', 'insert', 'create', 'create'],
    ['Update', 'tfixture', 'update', 'update', 'update'],
    ['Delete', 'tfixturemembers', 'delete', 'deleteMembership', 'delete'],
  ])('prunes every switch case but %s', (action, table, op, daoMethod, managerMethod) => {
    const result = closure(CFIXTURE, 'update', { predicates: { action } });
    expect(result.tables).toEqual([table]);
    expect(result.writes.map((w) => [w.table, w.op, w.component, w.method, w.trigger])).toEqual([
      [table, op, FIXTURE_DAO, daoMethod, 'request'],
    ]);
    expect(result.visited).toEqual(
      [`${CFIXTURE}#update`, `${ROSTER_MANAGER}#${managerMethod}`, `${FIXTURE_DAO}#${daoMethod}`].sort(),
    );
    expect(result.conditionalWrites).toEqual([
      expect.objectContaining({ table, condition: 'arguments.rc.$.validateCSRFTokens(context="update")' }),
    ]);
  });

  it.each(['add', 'ADD', 'aDd'])('matches the case value %s case-insensitively, like a CFML switch', (action) => {
    expect(closure(CFIXTURE, 'update', { predicates: { action } })).toEqual(
      closure(CFIXTURE, 'update', { predicates: { action: 'Add' } }),
    );
  });

  it('leaves every case to the more specific variants of the base entry', () => {
    const base = closure(CFIXTURE, 'update', { excludePredicates: VARIANTS });
    expect(base.tables).toEqual([]);
    expect(base.writes).toEqual([]);
    expect(base.visited).toEqual([`${CFIXTURE}#update`]);
    expect(closure(CFIXTURE, 'update').tables).toEqual(['tfixture', 'tfixturemembers']);
  });

  it.each<[string, Predicates | undefined, string[], string[]]>([
    ['type=1', { type: '1' }, ['tfixturemembers'], []],
    ['type=2', { type: '2' }, ['tfixture'], []],
    ['no predicate', undefined, ['tfixture', 'tfixturemembers'], ['tfixture', 'tfixturemembers']],
  ])('prunes if branches for %s', (_label, predicates, tables, conditional) => {
    const result = closure(CBRANCH, 'save', predicates === undefined ? {} : { predicates });
    expect(result.tables).toEqual(tables);
    expect(result.conditionalWrites.map((c) => c.table)).toEqual(conditional);
  });

  it('records the undecided if condition of each branch', () => {
    expect(closure(CBRANCH, 'save').conditionalWrites.map((c) => [c.table, c.condition])).toEqual([
      ['tfixture', '!(arguments.rc.type == 1)'],
      ['tfixturemembers', 'arguments.rc.type == 1'],
    ]);
    expect(closure(CBRANCH, 'save', { predicates: { type: '2' } }).writes).toEqual([
      expect.objectContaining({ table: 'tfixture', op: 'update', method: 'update', conditional: false }),
    ]);
  });

  it.each<[string, string, Predicates | undefined, boolean]>([
    [CBRANCH, 'upload', undefined, true],
    [CFIXTURE, 'update', { action: 'Add' }, false],
  ])('flags the file store for %s %s: %s', (entry, method, predicates, fileStore) => {
    const result = closure(entry, method, predicates === undefined ? {} : { predicates });
    expect(result.fileStore).toBe(fileStore);
    expect(result.fileStoreEvidence.length > 0).toBe(fileStore);
  });

  it('cites the fileManager call as file-store evidence', () => {
    const line = lineWith(CBRANCH, "getBean('fileManager')");
    expect(closure(CBRANCH, 'upload').fileStoreEvidence).toContainEqual({
      component: FILE_MANAGER,
      method: 'deleteVersion',
      source: { path: CBRANCH, lines: [line, line] },
      conditional: false,
    });
  });

  it.each([
    [CBRANCH, 'relogin', 'relogin'],
    [FIXTURE_MANAGER, 'refreshLogin', 'relogin'],
    [FIXTURE_DAO, 'refreshLogin', 'relogin'],
    [CBRANCH, 'save', 'none'],
    [CFIXTURE, 'update', 'none'],
  ])('reports the session effects of %s %s as %s', (entry, method, effects) => {
    expect(closure(entry, method).sessionEffects).toBe(effects);
  });

  it.each([
    [CBRANCH, 'stats', FIXTURE_MANAGER, 'trackStats', 'fixtureStats', [13, 15]],
    [FIXTURE_DAO, 'trackAsync', FIXTURE_DAO, 'trackAsync', 'fixtureThread#createUUID()#', [36, 41]],
  ])('reaches the thread of %s %s and marks its write thread', (entry, method, owner, ownerMethod, name, lines) => {
    const result = closure(entry, method);
    expect(result.threads).toEqual([{ name, component: owner, method: ownerMethod, source: { path: owner, lines } }]);
    expect(result.tables).toEqual(['tfixturestats']);
    expect(result.writes.map((w) => [w.table, w.trigger])).toEqual([['tfixturestats', 'thread']]);
  });

  it('reports an unknown bean with its source and writes nothing', () => {
    const line = lineWith(CBRANCH, "getBean('noSuchBean')");
    const result = closure(CBRANCH, 'orphan');
    expect(result.unresolved).toEqual([
      { expr: "getBean('noSuchBean').save", kind: 'bean', source: { path: CBRANCH, lines: [line, line] } },
    ]);
    expect(result.tables).toEqual([]);
  });

  it('writes the ORM table of a saved entity and reports its missing save method', () => {
    const line = lineWith(CBRANCH, "getBean('fixture')");
    const result = closure(CBRANCH, 'store');
    expect(result.tables).toEqual(['tfixture']);
    expect(result.writes).toEqual([
      expect.objectContaining({ table: 'tfixture', op: 'save', component: FIXTURE_BEAN, method: 'save' }),
    ]);
    expect(result.unresolved).toEqual([
      { expr: "getBean('fixture').save", kind: 'method', source: { path: CBRANCH, lines: [line, line] } },
    ]);
  });

  it('applies the reviewed writer overrides with their ids', async () => {
    const overrides = await loadWriterOverrides(OVERRIDES_FIXTURE);
    const relogin = closure(CBRANCH, 'relogin', {}, overrides);
    expect(relogin.overrides).toEqual(['wov:fixture-relogin']);
    expect(relogin.tables).toEqual(['tusers']);
    expect(relogin.writes).toEqual([
      expect.objectContaining({
        table: 'tusers',
        op: 'update',
        component: FIXTURE_MANAGER,
        method: 'refreshLogin',
        source: { path: FIXTURE_MANAGER, lines: [18, 20] },
        trigger: 'request',
        whereParams: ['userid', 'siteid'],
        override: 'wov:fixture-relogin',
      }),
    ]);
    expect(relogin.sessionEffects).toBe('relogin');
    expect(closure(CBRANCH, 'relogin').tables).toEqual([]);

    const stats = closure(CBRANCH, 'stats', {}, overrides);
    expect(stats.overrides).toEqual(['wov:fixture-thread']);
    expect(stats.writes.filter((w) => w.override === 'wov:fixture-thread').map((w) => [w.table, w.trigger])).toEqual([
      ['tfixturestats', 'thread'],
    ]);
  });

  it('settles an unresolved call with the override for its method', async () => {
    const line = lineWith(CBRANCH, "getBean('noSuchBean')");
    const { sourceSha } = await loadWriterOverrides(OVERRIDES_FIXTURE);
    const overrides = parseWriterOverrides(
      stringify({
        sourceSha,
        writers: [
          {
            id: 'wov:fixture-orphan',
            tables: ['tnosuchbean'],
            component: CBRANCH,
            method: 'orphan',
            op: 'save',
            source: { path: CBRANCH, lines: [line, line] },
            routeKeys: ['cbranch.orphan'],
            keyScope: 'table',
            trigger: 'request',
            sessionEffects: 'none',
            reason: 'noSuchBean is registered outside the scanned tree.',
          },
        ],
      }),
      'inline orphan override',
    );
    const result = closure(CBRANCH, 'orphan', {}, overrides);
    expect(result.unresolved).toEqual([]);
    expect(result.overrides).toEqual(['wov:fixture-orphan']);
    expect(result.writes).toEqual([
      expect.objectContaining({ table: 'tnosuchbean', op: 'save', override: 'wov:fixture-orphan', conditional: false }),
    ]);
  });

  it('terminates on a component that calls itself', () => {
    const result = closure(LOOP_MANAGER, 'spin');
    expect(result.visited).toEqual([`${LOOP_MANAGER}#spin`]);
    expect(result.tables).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it('rejects an entry outside the tree or without the method', () => {
    expect(() => closure('core/mura/fixture/absent.cfc', 'update')).toThrow(/not a CFML unit/);
    expect(() => closure(CBRANCH, 'absent')).toThrow(/has no method/);
  });
});
