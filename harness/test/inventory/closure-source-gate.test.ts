import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeClosure,
  describeCondition,
  detectMode,
  extractCalls,
  extractSqlWrites,
  lineOf,
  memorySourceTree,
  openSourceTree,
  parseAttributes,
  parseCfmTemplate,
  parseCfmlComponent,
  resolveComponentPath,
  stripComments,
} from '../../src/inventory/closure.js';
import type {
  CfmlComponent,
  CfmlFunction,
  CfmlUnit,
  ClosureContext,
  GuardCondition,
  SourceTree,
  SqlWrite,
} from '../../src/inventory/closure.js';
import { REPO_ROOT, assertOutsideRepo } from '../../src/lib/paths.js';

const FIXTURE_DIR = 'core/mura/fixture';
const FIXTURES = [
  'appstart-scan.cfm',
  'controller-gate.cfc',
  'dao-writes.cfc',
  'dbupdate-excerpt.cfm',
  'entity-with-bom.cfc',
  'manager-writes.cfc',
  'not-entity-manager.cfc',
  'orm-base.cfc',
  'tag-component.cfc',
  'view-json.cfm',
] as const;

let root: string;
let tree: SourceTree;

/** Absolute path of a committed CFML fixture. */
function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/cfml/${name}`, import.meta.url));
}

/** Raw UTF-8 text of a committed fixture, byte-order mark included. */
function rawFixture(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

function component(file: string, source: string): CfmlComponent {
  const unit = parseCfmlComponent(file, source);
  if (unit === null) throw new Error(`${file} declares no component`);
  return unit;
}

function fixtureComponent(name: string): CfmlComponent {
  return component(`${FIXTURE_DIR}/${name}`, tree.readText(`${FIXTURE_DIR}/${name}`));
}

function fn(unit: CfmlUnit, name: string): CfmlFunction {
  const found = unit.functions.find((f) => f.name === name);
  if (found === undefined) throw new Error(`${unit.path} has no function ${JSON.stringify(name)}`);
  return found;
}

/** Writes without their body offsets, which `offsetsPointAt` checks separately. */
function withoutOffsets(writes: readonly SqlWrite[]): Array<Omit<SqlWrite, 'offset'>> {
  return writes.map(({ offset: _offset, ...rest }) => rest);
}

/** Body text at each write's offset, cut to `width` characters. */
function offsetsPointAt(f: CfmlFunction, writes: readonly SqlWrite[], width: number): string[] {
  return writes.map((w) => f.body.slice(w.offset, w.offset + width));
}

/** Followed calls of `fnName` with no beans registered: guard as described text, thread as `name@line-endLine`. */
function guardedCalls(file: string, source: string, fnName: string, extra: Record<string, string> = {}) {
  const parsed = file.endsWith('.cfm') ? null : component(file, source);
  const unit: CfmlUnit = parsed ?? parseCfmTemplate(file, source);
  const ctx: ClosureContext = {
    tree: memorySourceTree({ [file]: source, ...extra }),
    index: { resolveBean: () => null, ormTable: () => null, parsed: (p) => (p === file ? parsed : null) },
  };
  return extractCalls(fn(unit, fnName), unit, ctx).map((site) => ({
    text: site.text,
    guard: site.guard === undefined ? null : describeCondition(site.guard),
    thread: site.thread === undefined ? null : `${site.thread.name}@${site.thread.line}-${site.thread.endLine}`,
    line: site.line,
    args: site.args,
    target: site.target,
  }));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-inv-closure-src-'));
  await mkdir(path.join(root, FIXTURE_DIR, 'sub', 'deeper'), { recursive: true });
  await mkdir(path.join(root, 'cache'));
  for (const name of FIXTURES) await copyFile(fixturePath(name), path.join(root, FIXTURE_DIR, name));
  await copyFile(fixturePath('tag-component.cfc'), path.join(root, FIXTURE_DIR, 'tagComponent.cfc'));
  await copyFile(fixturePath('tag-component.cfc'), path.join(root, FIXTURE_DIR, 'sub', 'Tagged.CFC'));
  await copyFile(fixturePath('view-json.cfm'), path.join(root, FIXTURE_DIR, 'sub', 'deeper', 'inner.cfm'));
  await copyFile(fixturePath('orm-base.cfc'), path.join(root, 'top.cfc'));
  await writeFile(path.join(root, FIXTURE_DIR, 'sub', 'notes.txt'), 'plain text\n');
  tree = openSourceTree(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('lineOf', () => {
  it('numbers lines from 1 and counts a newline as the end of its own line', () => {
    expect([0, 1, 2, 3, 4].map((offset) => lineOf('a\nb\nc', offset))).toEqual([1, 1, 2, 2, 3]);
  });

  it('clamps offsets before the start and past the end of the text', () => {
    expect(lineOf('a\nb\nc', -5)).toBe(1);
    expect(lineOf('a\nb\n', 99)).toBe(3);
    expect(lineOf('', 0)).toBe(1);
  });
});

describe('openSourceTree', () => {
  it('refuses the repository checkout and every directory inside it', () => {
    expect(() => openSourceTree(REPO_ROOT)).toThrow(/lies inside the repository checkout; extract the pinned commit instead/);
    expect(() => openSourceTree(path.join(REPO_ROOT, 'harness', 'test'))).toThrow(/lies inside the repository checkout/);
  });

  it('refuses a file and fails on a directory that does not exist', () => {
    const file = path.join(root, FIXTURE_DIR, 'orm-base.cfc');
    expect(() => openSourceTree(file)).toThrow(`source tree ${file} is not a directory`);
    expect(() => openSourceTree(path.join(root, 'absent'))).toThrow(/ENOENT/);
  });

  it('resolves a relative root to the absolute extraction directory', () => {
    expect(openSourceTree(path.relative(process.cwd(), root)).root).toBe(root);
    expect(tree.root).toBe(root);
    expect(tree.lineOf).toBe(lineOf);
  });

  it('reads a fixture byte-exact except for a leading byte-order mark', () => {
    const bom = rawFixture('entity-with-bom.cfc');
    expect(bom.charCodeAt(0)).toBe(0xfeff);
    expect(tree.readText(`${FIXTURE_DIR}/entity-with-bom.cfc`)).toBe(bom.slice(1));
    expect(tree.readText(`${FIXTURE_DIR}/tag-component.cfc`)).toBe(rawFixture('tag-component.cfc'));
  });

  it('memoises each file text, so a later change on disk is not observed', async () => {
    const file = path.join(root, 'cache', 'probe.cfm');
    await writeFile(file, 'first');
    const probe = openSourceTree(root);
    expect(probe.readText('cache/probe.cfm')).toBe('first');
    await writeFile(file, 'second');
    expect(probe.readText('cache/probe.cfm')).toBe('first');
    expect(openSourceTree(root).readText('cache/probe.cfm')).toBe('second');
  });

  it('throws for a missing file', () => {
    expect(() => tree.readText(`${FIXTURE_DIR}/absent.cfc`)).toThrow(/ENOENT/);
  });

  it.each(['', '/top.cfc', 'core/', 'core//mura', './top.cfc', 'core/../top.cfc', 'core\\mura\\x.cfc'])(
    'rejects %j as a repository-relative path in readText and exists',
    (rel) => {
      const message = `invalid repository-relative path ${JSON.stringify(rel)}`;
      expect(() => tree.readText(rel)).toThrow(message);
      expect(() => tree.exists(rel)).toThrow(message);
    },
  );

  it('reports files as existing, but neither directories nor absent paths', () => {
    expect(tree.exists(`${FIXTURE_DIR}/dao-writes.cfc`)).toBe(true);
    expect(tree.exists('top.cfc')).toBe(true);
    expect(tree.exists(FIXTURE_DIR)).toBe(false);
    expect(tree.exists(`${FIXTURE_DIR}/absent.cfc`)).toBe(false);
  });

  it('lists the direct files of a directory in code-unit order, prefixed with the directory', () => {
    expect(tree.list(FIXTURE_DIR)).toEqual(
      [...FIXTURES, 'tagComponent.cfc'].map((name) => `${FIXTURE_DIR}/${name}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(tree.list('')).toEqual(['top.cfc']);
    expect(tree.list('/')).toEqual(['top.cfc']);
  });

  it('filters by extension with or without the dot, case-insensitively, and descends only when recursive', () => {
    expect(tree.list(`/${FIXTURE_DIR}/`, { ext: ['cfm'] })).toEqual([
      `${FIXTURE_DIR}/appstart-scan.cfm`,
      `${FIXTURE_DIR}/dbupdate-excerpt.cfm`,
      `${FIXTURE_DIR}/view-json.cfm`,
    ]);
    expect(tree.list(`${FIXTURE_DIR}/sub`, { ext: ['.cfc', 'CFM'], recursive: true })).toEqual([
      `${FIXTURE_DIR}/sub/Tagged.CFC`,
      `${FIXTURE_DIR}/sub/deeper/inner.cfm`,
    ]);
    expect(tree.list(`${FIXTURE_DIR}/sub`, { ext: [] })).toEqual([`${FIXTURE_DIR}/sub/Tagged.CFC`, `${FIXTURE_DIR}/sub/notes.txt`]);
    expect(tree.list('', { ext: ['txt'], recursive: true })).toEqual([`${FIXTURE_DIR}/sub/notes.txt`]);
  });

  it('lists nothing under an absent directory or a file, and rejects an invalid prefix', () => {
    expect(tree.list('absent/dir')).toEqual([]);
    expect(tree.list('top.cfc')).toEqual([]);
    expect(() => tree.list('core/../top')).toThrow('invalid repository-relative path "core/../top"');
  });
});

describe('memorySourceTree', () => {
  const files = {
    'a/x.cfc': '\uFEFFcomponent {}',
    'a/Y.CFM': '<cfset y = 1>',
    'a/b/z.cfc': 'component {}',
    'ab/w.cfc': 'component {}',
    'root.cfm': '<p>root</p>',
  };
  const mem = memorySourceTree(files);

  it('accepts a record or a map, strips byte-order marks and has no root directory', () => {
    const fromMap = memorySourceTree(new Map(Object.entries(files)));
    expect(mem.root).toBeNull();
    expect(mem.readText('a/x.cfc')).toBe('component {}');
    expect(fromMap.readText('a/x.cfc')).toBe('component {}');
    expect(fromMap.list('', { recursive: true })).toEqual(mem.list('', { recursive: true }));
    expect(mem.lineOf).toBe(lineOf);
  });

  it('rejects keys and lookups that are not repository-relative paths', () => {
    expect(() => memorySourceTree({ '../x.cfc': '' })).toThrow('invalid repository-relative path "../x.cfc"');
    expect(() => memorySourceTree(new Map([['a\\b.cfc', '']]))).toThrow('invalid repository-relative path "a\\\\b.cfc"');
    expect(() => mem.readText('/a/x.cfc')).toThrow('invalid repository-relative path "/a/x.cfc"');
  });

  it('throws for a file it does not hold and reports only held files as existing', () => {
    expect(() => mem.readText('a/absent.cfc')).toThrow('no file a/absent.cfc in the in-memory source tree');
    expect(mem.exists('a/b/z.cfc')).toBe(true);
    expect(mem.exists('a/b')).toBe(false);
    expect(mem.exists('a/absent.cfc')).toBe(false);
  });

  it('lists a directory without leaking a sibling that shares its name as a prefix', () => {
    expect(mem.list('a')).toEqual(['a/Y.CFM', 'a/x.cfc']);
    expect(mem.list('ab')).toEqual(['ab/w.cfc']);
    expect(mem.list('')).toEqual(['root.cfm']);
    expect(mem.list('a/x.cfc')).toEqual([]);
  });

  it('applies the extension filter to file names and descends only when recursive', () => {
    expect(mem.list('a', { recursive: true, ext: ['cfc'] })).toEqual(['a/b/z.cfc', 'a/x.cfc']);
    expect(mem.list('/a/', { ext: ['.cfm'] })).toEqual(['a/Y.CFM']);
    expect(mem.list('', { recursive: true })).toEqual(['a/Y.CFM', 'a/b/z.cfc', 'a/x.cfc', 'ab/w.cfc', 'root.cfm']);
  });
});

describe('detectMode', () => {
  it.each<[string, 'tag' | 'script']>([
    ['<cfcomponent output="false">', 'tag'],
    [' \n\t<!--- note --->', 'tag'],
    ['\uFEFF<cfset x = 1>', 'tag'],
    ['component {}', 'script'],
    ['\uFEFF// note\ncomponent {}', 'script'],
    ['', 'script'],
  ])('classifies %j as %s', (text, mode) => {
    expect(detectMode(text)).toBe(mode);
  });

  it('classifies the tag and script fixtures by their first character', () => {
    expect(detectMode(tree.readText(`${FIXTURE_DIR}/dao-writes.cfc`))).toBe('tag');
    expect(detectMode(rawFixture('entity-with-bom.cfc'))).toBe('script');
    expect(detectMode(tree.readText(`${FIXTURE_DIR}/manager-writes.cfc`))).toBe('script');
  });
});

describe('stripComments', () => {
  /** Offsets of every line-break character, which stripping must keep in place. */
  const breaks = (text: string): number[] => [...text].flatMap((ch, i) => (ch === '\n' || ch === '\r' ? [i] : []));

  it('blanks script line and block comments with spaces, keeping every offset and line break', () => {
    const input = 'a = 1; // note\nb = 2; /* c\n d */ e = 3;';
    const out = stripComments(input);
    expect(out).toBe(input.replace('// note', ' '.repeat(7)).replace('/* c\n d */', `${' '.repeat(4)}\n${' '.repeat(5)}`));
    expect(out).toHaveLength(input.length);
    expect(breaks(out)).toEqual(breaks(input));
  });

  it('leaves comment markers inside string literals and their interpolations intact', () => {
    const input = 'u = "http://x/*y*/"; v = \'//\'; w = "#fn(\'//\')#"; q = "a""//"; // tail';
    expect(stripComments(input, 'script')).toBe(input.replace('// tail', ' '.repeat(7)));
  });

  it('blanks an unterminated block comment and a final line comment to the end of the text', () => {
    expect(stripComments('a; /* open\nstill')).toBe(`a; ${' '.repeat(7)}\n${' '.repeat(5)}`);
    expect(stripComments('b; // last')).toBe(`b; ${' '.repeat(7)}`);
  });

  it('blanks a nested multi-line tag comment as one comment and keeps CRLF breaks', () => {
    const nested = '<!--- a <!--- nested ---> still\n comment --->';
    expect(stripComments(`${nested}<p>x</p>`)).toBe(`${nested.replace(/[^\n]/g, ' ')}<p>x</p>`);
    expect(stripComments('<p>\r\n<!--- x\r\ny ---></p>', 'tag')).toBe(`<p>\r\n${' '.repeat(7)}\r\n${' '.repeat(6)}</p>`);
    expect(stripComments('<!--- open\nrest')).toBe(`${' '.repeat(10)}\n${' '.repeat(4)}`);
  });

  it('takes script comments in tag mode only inside cfscript bodies, ending a line comment at the closing tag', () => {
    const input = '<p>// kept</p><cfscript>x = 1; // c</cfscript>// after<CFSCRIPT>/* b\n */y=2;</CFSCRIPT><cfscriptx // not>';
    expect(stripComments(input)).toBe(input.replace('// c', ' '.repeat(4)).replace('/* b\n */', `${' '.repeat(4)}\n${' '.repeat(3)}`));
    expect(stripComments('<cfscript>a = 1; // no close')).toBe(`<cfscript>a = 1; ${' '.repeat(11)}`);
  });

  it('honours an explicit mode over the first character', () => {
    expect(stripComments('// a\n<x>', 'script')).toBe('    \n<x>');
    expect(stripComments('<a> // x', 'script')).toBe('<a>     ');
    expect(stripComments('<a> // x')).toBe('<a> // x');
    expect(stripComments('<!--- c --->', 'script')).toBe('<!--- c --->');
  });

  it('blanks the comment line of the byte-order-mark fixture and nothing else', () => {
    const text = tree.readText(`${FIXTURE_DIR}/entity-with-bom.cfc`);
    const lines = text.split('\n');
    const stripped = stripComments(text).split('\n');
    expect(stripped).toHaveLength(lines.length);
    expect(stripped[1]).toBe(`\t${' '.repeat((lines[1] ?? '').length - 1)}`);
    expect(stripped.filter((_, i) => i !== 1)).toEqual(lines.filter((_, i) => i !== 1));
  });
});

describe('parseAttributes', () => {
  it('reads double-quoted, single-quoted and unquoted values under lower-cased keys', () => {
    expect(parseAttributes(' Name="x" type=\'string\' required=true')).toEqual({ name: 'x', type: 'string', required: 'true' });
  });

  it('keeps the first occurrence of a repeated or bare attribute', () => {
    expect(parseAttributes('name="a" NAME="b" bare bare="later"')).toEqual({ name: 'a', bare: '' });
  });

  it('collapses doubled quotes and keeps interpolations verbatim', () => {
    expect(parseAttributes('default="say ""hi""" alt=\'it\'\'s\' value="#arguments.x#"')).toEqual({
      default: 'say "hi"',
      alt: "it's",
      value: '#arguments.x#',
    });
  });

  it('accepts spaces around the equals sign and names with colon, dot and dash', () => {
    expect(parseAttributes('name = "x" data-x="1" xmlns:foo="u" a.b=2')).toEqual({ name: 'x', 'data-x': '1', 'xmlns:foo': 'u', 'a.b': '2' });
  });

  it('reads both sides of == as bare words rather than an attribute', () => {
    expect(parseAttributes('a == b')).toEqual({ a: '', b: '' });
  });

  it('ends an unquoted value at whitespace, >, a brace, a semicolon or a comma', () => {
    expect(parseAttributes('cfc=site fkcolumn=siteid;rest=1,more={x} q= >')).toEqual({
      cfc: 'site',
      fkcolumn: 'siteid',
      rest: '1',
      more: '',
      x: '',
      q: '',
    });
  });

  it('skips quoted text that is no value and reads an unterminated value to the end', () => {
    expect(parseAttributes('"lit" name="abc')).toEqual({ name: 'abc' });
    expect(parseAttributes('')).toEqual({});
  });
});

describe('parseCfmlComponent in script syntax', () => {
  it('parses the byte-order-mark entity: declaration attributes and properties with their lines', () => {
    const unit = component('core/mura/fixture/entity-with-bom.cfc', rawFixture('entity-with-bom.cfc'));
    expect(unit.path).toBe('core/mura/fixture/entity-with-bom.cfc');
    expect(unit.syntax).toBe('script');
    expect(unit.text.charCodeAt(0)).not.toBe(0xfeff);
    expect(unit.text).not.toContain('ORM entity sample');
    expect(unit.declaration).toEqual({
      line: 1,
      endLine: 1,
      attrs: { extends: 'mura.bean.beanORM', table: 'tfixture', entityname: 'fixture', displayname: 'fixtureBean', orderby: 'name' },
    });
    expect(unit.properties).toEqual([
      { name: 'fixtureid', attrs: { name: 'fixtureid', fieldtype: 'id' }, line: 3 },
      { name: 'site', attrs: { name: 'site', fieldtype: 'many-to-one', cfc: 'site', fkcolumn: 'siteid' }, line: 4 },
      { name: 'name', attrs: { name: 'name', datatype: 'varchar', length: '100' }, line: 5 },
    ]);
    expect(unit.functions).toEqual([]);
  });

  it('places the declaration after a leading comment line', () => {
    const unit = fixtureComponent('orm-base.cfc');
    expect(unit.declaration).toEqual({ line: 2, endLine: 2, attrs: { extends: 'mura.bean.beanORM', displayname: 'fixtureBase' } });
    expect(unit.properties).toEqual([{ name: 'created', attrs: { name: 'created', datatype: 'timestamp', fieldtype: 'none' }, line: 3 }]);
  });

  it('parses manager functions with access, arguments, defaults, line spans and comment-stripped bodies', () => {
    const unit = fixtureComponent('manager-writes.cfc');
    expect(unit.declaration.attrs).toEqual({ extends: 'mura.cfobject', output: 'false' });
    expect(unit.functions.map((f) => [f.name, f.access, f.startLine, f.endLine, f.bodyLine])).toEqual([
      ['rename', 'public', 4, 6, 4],
      ['purgeSite', 'public', 8, 10, 8],
      ['trackStats', 'public', 12, 16, 12],
      ['refreshLogin', 'public', 18, 20, 18],
      ['create', 'public', 22, 24, 22],
    ]);
    expect(fn(unit, 'rename').args).toEqual([
      { name: 'userid', line: 4 },
      { name: 'name', line: 4 },
    ]);
    expect(fn(unit, 'create').args).toEqual([
      { name: 'fixtureid', line: 22 },
      { name: 'siteid', line: 22 },
      { name: 'name', line: 22, default: '""' },
    ]);
    for (const f of unit.functions) {
      expect(unit.text.slice(f.offset, f.offset + f.body.length)).toBe(f.body);
      expect(f.includes).toEqual([]);
    }
    expect(fn(unit, 'refreshLogin').body.trim()).toBe('arguments.userBean.login();');
  });

  it('parses the controller sample with one rc argument per action', () => {
    const unit = fixtureComponent('controller-gate.cfc');
    expect(unit.declaration).toEqual({ line: 2, endLine: 2, attrs: { extends: 'controller', output: 'false' } });
    expect(unit.functions.map((f) => [f.name, f.startLine, f.endLine, f.args])).toEqual([
      ['before', 4, 14, [{ name: 'rc', line: 4 }]],
      ['update', 16, 30, [{ name: 'rc', line: 16 }]],
      ['remove', 32, 36, [{ name: 'rc', line: 32 }]],
      ['list', 38, 40, [{ name: 'rc', line: 38 }]],
    ]);
  });

  it('reads modifiers, default expressions, includes, shorthand properties, and skips interfaces and nested functions', () => {
    const unit = component(
      'm/s.cfc',
      [
        'component accessors=true {',
        '  property string label;',
        '  property name="kind" type="string";',
        '  private string function hidden() { return 1; }',
        '  remote function rem(numeric n = 1 + 2, struct opts = {a=1, b=2}, boolean b = x == y, 5) {',
        '    include "inc/a.cfm"; cfinclude(template="inc/b.cfm"); x.include "no"; include \'#dyn#.cfm\'; include "";',
        '  }',
        '  package mura.bean.x function pkg() {}',
        '  public any function attrs() output=false returnformat="json" { return 1; }',
        '  function iface();',
        '  function outer() { function inner() {} }',
        '}',
      ].join('\n'),
    );
    expect(unit.declaration.attrs).toEqual({ accessors: 'true' });
    expect(unit.properties).toEqual([
      { name: 'label', attrs: { string: '', label: '' }, line: 2 },
      { name: 'kind', attrs: { name: 'kind', type: 'string' }, line: 3 },
    ]);
    expect(unit.functions.map((f) => [f.name, f.access, f.startLine, f.endLine])).toEqual([
      ['hidden', 'private', 4, 4],
      ['rem', 'remote', 5, 7],
      ['pkg', 'package', 8, 8],
      ['attrs', 'public', 9, 9],
      ['outer', 'public', 11, 11],
    ]);
    expect(fn(unit, 'attrs').body.trim()).toBe('return 1;');
    const rem = fn(unit, 'rem');
    expect(rem.args).toEqual([
      { name: 'n', line: 5, default: '1 + 2' },
      { name: 'opts', line: 5, default: '{a=1, b=2}' },
      { name: 'b', line: 5, default: 'x == y' },
    ]);
    expect(rem.includes.map((i) => [i.template, i.line, rem.body.slice(i.offset, i.offset + 9)])).toEqual([
      ['inc/a.cfm', 6, 'include "'],
      ['inc/b.cfm', 6, 'cfinclude'],
      ['#dyn#.cfm', 6, "include '"],
    ]);
  });

  it('names a shorthand property by its last bare word before any attribute', () => {
    const unit = component(
      'm/p.cfc',
      [
        'component {',
        '  property string title default="";',
        '  property mura.user.userBean owner fkcolumn="ownerid" cfc="user";',
        '  property fixtureid fieldtype="id";',
        '}',
      ].join('\n'),
    );
    expect(unit.properties).toEqual([
      { name: 'title', attrs: { string: '', title: '', default: '' }, line: 2 },
      { name: 'owner', attrs: { 'mura.user.userbean': '', owner: '', fkcolumn: 'ownerid', cfc: 'user' }, line: 3 },
      { name: 'fixtureid', attrs: { fixtureid: '', fieldtype: 'id' }, line: 4 },
    ]);
  });

  it('reads members to the end of a component whose closing brace is missing', () => {
    expect(component('u.cfc', 'component { function a() { return 1; }').functions.map((f) => f.name)).toEqual(['a']);
  });

  it.each([
    ['script without a component keyword', 'x = 1;'],
    ['a component keyword without a body', 'component extends="x"'],
    ['markup without a cfcomponent tag', '<div>component {}</div>'],
  ])('returns null for %s', (_label, source) => {
    expect(parseCfmlComponent('n.cfc', source)).toBeNull();
  });
});

describe('parseCfmlComponent in tag syntax', () => {
  it('parses the tag component: declaration, cfproperty and cffunction members with cfargument parameters', () => {
    const unit = fixtureComponent('tag-component.cfc');
    expect(unit.syntax).toBe('tag');
    expect(unit.declaration).toEqual({ line: 2, endLine: 2, attrs: { extends: 'mura.cfobject', output: 'false' } });
    expect(unit.properties).toEqual([{ name: 'label', attrs: { name: 'label', type: 'string', default: '' }, line: 4 }]);
    expect(unit.functions.map((f) => [f.name, f.access, f.args, f.startLine, f.endLine, f.bodyLine])).toEqual([
      ['getLabel', 'public', [], 6, 8, 6],
      ['setLabel', 'public', [{ name: 'label', line: 11 }], 10, 14, 10],
    ]);
    expect(fn(unit, 'getLabel').body.trim()).toBe('<cfreturn variables.label>');
  });

  it('re-quotes a tag argument default as a CFML string expression', () => {
    const unit = fixtureComponent('dao-writes.cfc');
    expect(unit.functions.map((f) => f.name)).toEqual(['create', 'update', 'deleteMembership', 'trackAsync', 'refreshLogin']);
    expect(fn(unit, 'update').args).toEqual([
      { name: 'userid', line: 17 },
      { name: 'name', line: 18, default: '""' },
    ]);
  });

  it('does not mistake component source inside a string literal for the declaration', () => {
    const unit = fixtureComponent('not-entity-manager.cfc');
    expect(unit.declaration.attrs).toEqual({ extends: 'mura.cfobject', displayname: 'FixtureManager', output: 'false' });
    expect(unit.properties).toEqual([]);
    expect(unit.functions.map((f) => [f.name, f.args])).toEqual([['createEntitySource', [{ name: 'name', line: 5 }]]]);
  });

  it('takes properties and functions from top-level cfscript blocks but not from function bodies', () => {
    const unit = component(
      't.cfc',
      [
        '<cfproperty name="before">',
        '<cfcomponent output="false"',
        '  hint="multi">',
        '<cfproperty name="p1" type="string">',
        '<cffunction name="F1" access="Private">',
        '  <cfargument name="a" default=\'say "hi"\'>',
        '  <cfargument type="string">',
        '  <cfproperty name="inside">',
        '  <cfinclude template="inc/x.cfm">',
        '  <cfscript>function hiddenScript() {}</cfscript>',
        '</cffunction>',
        '<cfscript>',
        '  property name="p2";',
        '  function s1(x) { include "y.cfm"; }',
        '</cfscript>',
        '<cffunction>',
        '</cffunction>',
        '<cfproperty nametype="none">',
      ].join('\n'),
    );
    expect(unit.declaration).toEqual({ line: 2, endLine: 3, attrs: { output: 'false', hint: 'multi' } });
    expect(unit.properties).toEqual([
      { name: 'p1', attrs: { name: 'p1', type: 'string' }, line: 4 },
      { name: 'p2', attrs: { name: 'p2' }, line: 13 },
    ]);
    expect(unit.functions.map((f) => [f.name, f.access, f.args, f.startLine, f.endLine, f.includes.map((i) => [i.template, i.line])])).toEqual([
      ['F1', 'private', [{ name: 'a', line: 6, default: '"say ""hi"""' }], 5, 11, [['inc/x.cfm', 9]]],
      ['s1', 'public', [{ name: 'x', line: 14 }], 14, 14, [['y.cfm', 14]]],
      ['', 'public', [], 16, 17, []],
    ]);
  });

  it('runs an unclosed cffunction to the end of the file', () => {
    const unit = component('o.cfc', '<cfcomponent>\n<cffunction name="open">\n<cfset x = 1>');
    expect(unit.functions.map((f) => [f.name, f.startLine, f.body])).toEqual([['open', 2, '\n<cfset x = 1>']]);
  });
});

describe('parseCfmTemplate', () => {
  it('models a view as the pseudo-function "" over the comment-stripped file', () => {
    const text = tree.readText(`${FIXTURE_DIR}/view-json.cfm`);
    const unit = parseCfmTemplate(`${FIXTURE_DIR}/view-json.cfm`, text);
    expect(unit.syntax).toBe('template');
    expect(unit.properties).toEqual([]);
    expect(unit.text).toBe(stripComments(text, 'tag'));
    expect(unit.text).not.toContain('<!---');
    expect(unit.functions).toHaveLength(1);
    const whole = fn(unit, '');
    expect([whole.access, whole.args, whole.startLine, whole.offset, whole.bodyLine, whole.includes]).toEqual(['public', [], 1, 0, 1, []]);
    expect(whole.body).toBe(unit.text);
  });

  it.each<[string, number]>([
    ['view-json.cfm', 5],
    ['appstart-scan.cfm', 13],
    ['dbupdate-excerpt.cfm', 14],
  ])('ends the pseudo-function of %s on its last line, %i', (name, last) => {
    expect(fn(parseCfmTemplate(name, tree.readText(`${FIXTURE_DIR}/${name}`)), '').endLine).toBe(last);
  });

  it.each<[string, number]>([
    ['', 1],
    ['<p>', 1],
    ['<p>\n', 1],
    ['<p>\n</p>', 2],
    ['<p>\n\n', 2],
  ])('ends the pseudo-function of %j on line %i', (source, last) => {
    expect(fn(parseCfmTemplate('v/e.cfm', source), '').endLine).toBe(last);
  });

  it('adds template functions after the pseudo-function, ignores script properties and strips a byte-order mark', () => {
    const unit = parseCfmTemplate(
      'v/t.cfm',
      '\uFEFF<cfinclude template="a.cfm">\n<cffunction name="helper"><cfreturn 1></cffunction>\n<cfscript>function sh() {} property name="ignored";</cfscript>\n',
    );
    expect(unit.text.startsWith('<cfinclude')).toBe(true);
    expect(unit.properties).toEqual([]);
    expect(unit.functions.map((f) => [f.name, f.startLine])).toEqual([
      ['', 1],
      ['helper', 2],
      ['sh', 3],
    ]);
    expect(fn(unit, '').includes).toEqual([{ template: 'a.cfm', line: 1, offset: 0 }]);
  });
});

describe('describeCondition', () => {
  const a: GuardCondition = { k: 'expr', text: 'a' };
  const b: GuardCondition = { k: 'expr', text: 'b' };
  const c: GuardCondition = { k: 'expr', text: 'c' };
  it.each<[string, GuardCondition, string]>([
    ['collapses whitespace in an expression', { k: 'expr', text: '  rc.type\n\t eq  1 ' }, 'rc.type eq 1'],
    ['quotes case values and marks a non-literal value', { k: 'case', subject: ' rc.action ', values: ['Add', null] }, "switch(rc.action) case 'Add', ?"],
    ['wraps a negation', { k: 'not', of: a }, '!(a)'],
    ['parenthesises a disjunction inside a conjunction', { k: 'and', of: [a, { k: 'or', of: [b, c] }] }, 'a && (b || c)'],
    ['leaves a conjunction inside a disjunction bare', { k: 'or', of: [{ k: 'and', of: [a, b] }, c] }, 'a && b || c'],
    ['negates a whole conjunction', { k: 'not', of: { k: 'and', of: [a, b] } }, '!(a && b)'],
  ])('%s', (_label, cond, text) => {
    expect(describeCondition(cond)).toBe(text);
  });
});

describe('guard and thread regions of cfscript', () => {
  it('conditions each if, else-if and else branch on the earlier conditions failing', () => {
    const calls = guardedCalls(
      'x.cfc',
      [
        'component {',
        ' function run(rc) {',
        '  if (rc.type == 1) { application.aManager.save(rc); }',
        '  else if (rc.type == 2) application.bManager.save(rc);',
        '  else { application.cManager.save(rc); }',
        '  application.dManager.save(rc);',
        '  if (rc.x) { if (rc.y) application.eManager.save(); } else application.fManager.save();',
        ' }',
        '}',
      ].join('\n'),
      'run',
    );
    expect(calls.map((s) => [s.text, s.guard, s.line])).toEqual([
      ['application.aManager.save', 'rc.type == 1', 3],
      ['application.bManager.save', '!(rc.type == 1) && rc.type == 2', 4],
      ['application.cManager.save', '!(rc.type == 1) && !(rc.type == 2)', 5],
      ['application.dManager.save', null, 6],
      ['application.eManager.save', 'rc.x && rc.y', 7],
      ['application.fManager.save', '!(rc.x)', 7],
    ]);
  });

  it('conditions switch cases on their literal values, falls through grouped cases and negates them all for default', () => {
    const calls = guardedCalls(
      'x.cfc',
      [
        'component {',
        ' function run(rc) {',
        '  switch (rc.action) {',
        "   case 'Add':",
        '   case "Update":',
        '     application.aManager.save(rc); break;',
        '   case 30: application.bManager.save(rc); break;',
        '   case flag: application.pManager.save(rc); break;',
        '   case variables.x: application.cManager.save(rc);',
        '   case "#y#": application.dManager.save(rc); break;',
        "   case true: application.eManager.save(); break;",
        "   case 'it''s': application.fManager.save(); break;",
        '   case "a##b": application.gManager.save(); break;',
        '   default: application.hManager.save(rc);',
        '  }',
        ' }',
        '}',
      ].join('\n'),
      'run',
    );
    const cases = ["'Add', 'Update'", "'30'", '?', '?', '?', "'true'", "'it's'", "'a#b'"].map((v) => `switch(rc.action) case ${v}`);
    expect(calls.map((s) => [s.text, s.guard])).toEqual([
      ['application.aManager.save', cases[0]],
      ['application.bManager.save', cases[1]],
      ['application.pManager.save', cases[2]],
      ['application.cManager.save', cases[3]],
      ['application.dManager.save', cases[4]],
      ['application.eManager.save', cases[5]],
      ['application.fManager.save', cases[6]],
      ['application.gManager.save', cases[7]],
      ['application.hManager.save', `!(${cases.join(' || ')})`],
    ]);
  });

  it('marks running thread bodies, conditions catch bodies and treats loops, locks and plain blocks as unconditional', () => {
    const calls = guardedCalls(
      'x.cfc',
      [
        'component {',
        ' function run(rc) {',
        '  thread action="run" name="t1" {',
        '    application.aManager.save();',
        '  }',
        '  thread name="t2" action="join";',
        '  thread action="terminate" name="t3" { application.bManager.save(); }',
        '  cfthread(action="run", name="t4") { application.cManager.save(); }',
        '  try { application.dManager.save(); } catch (any e) { application.eManager.save(); } finally { application.fManager.save(); }',
        '  for (var i = 1; i <= 3; i++) { if (i == 2) application.gManager.save(); }',
        '  while (rc.more) application.hManager.save();',
        '  transaction action="begin" { application.iManager.save(); }',
        '  lock name="x" timeout="5" type="exclusive" { if (rc.z) { application.jManager.save(); } }',
        '  function inner(x) { if (x) application.kManager.save(); }',
        '  { if (rc.w) application.lManager.save(); }',
        '  do { application.mManager.save(); } while (rc.more);',
        '  try { application.nManager.save(); } catch { application.oManager.save(); }',
        ' }',
        '}',
      ].join('\n'),
      'run',
    );
    expect(calls.map((s) => [s.text.split('.')[1], s.guard, s.thread])).toEqual([
      ['aManager', null, 't1@3-5'],
      ['bManager', null, null],
      ['cManager', null, 't4@8-8'],
      ['dManager', null, null],
      ['eManager', 'catch(any e)', null],
      ['fManager', null, null],
      ['gManager', 'i == 2', null],
      ['hManager', null, null],
      ['iManager', null, null],
      ['jManager', 'rc.z', null],
      ['kManager', null, null],
      ['lManager', 'rc.w', null],
      ['mManager', null, null],
      ['nManager', null, null],
      ['oManager', 'catch', null],
    ]);
  });
});

describe('guard and thread regions of tag syntax', () => {
  it('conditions cfif chains, cfswitch cases, cfcatch bodies, cfscript blocks and nested tags, and marks cfthread bodies', () => {
    const calls = guardedCalls(
      'v/t.cfm',
      [
        '<cfif rc.type eq 1>',
        '  <cfset application.aManager.save(rc)>',
        '<cfelseif rc.type eq 2>',
        '  <cfset application.bManager.save(rc)>',
        '<cfelse>',
        '  <cfset application.cManager.save(rc)>',
        '</cfif>',
        '<cfswitch expression="#rc.action#">',
        '  <cfcase value="Add, Update"><cfset application.dManager.save()></cfcase>',
        '  <cfcase value="Delete|Remove" delimiters="|"><cfset application.eManager.save()></cfcase>',
        '  <cfcase value="#x#"><cfset application.fManager.save()></cfcase>',
        '  <cfdefaultcase><cfset application.gManager.save()></cfdefaultcase>',
        '</cfswitch>',
        '<cftry><cfset application.hManager.save()>',
        '<cfcatch type="database"><cfset application.iManager.save()></cfcatch>',
        '<cfcatch /></cftry>',
        '<cfthread action="run" name="tt"><cfset application.jManager.save()></cfthread>',
        '<cfthread action="join" name="tt" />',
        '<cfscript>if (rc.s) application.kManager.save();</cfscript>',
        '</cfif><cfelse>',
        '<cfif rc.a><cfif rc.b><cfset application.lManager.save()></cfif></cfif>',
        '<cfif rc.c><cfelse><cfset application.mManager.save()><cfelse><cfset application.nManager.save()></cfif>',
      ].join('\n'),
      '',
    );
    const cases = ["'Add', 'Update'", "'Delete', 'Remove'", '?'].map((v) => `switch(rc.action) case ${v}`);
    expect(calls.map((s) => [s.text.split('.')[1], s.guard, s.thread, s.line])).toEqual([
      ['aManager', 'rc.type eq 1', null, 2],
      ['bManager', '!(rc.type eq 1) && rc.type eq 2', null, 4],
      ['cManager', '!(rc.type eq 1) && !(rc.type eq 2)', null, 6],
      ['dManager', cases[0], null, 9],
      ['eManager', cases[1], null, 10],
      ['fManager', cases[2], null, 11],
      ['gManager', `!(${cases.join(' || ')})`, null, 12],
      ['hManager', null, null, 14],
      ['iManager', 'cfcatch type="database"', null, 15],
      ['jManager', null, 'tt@17-17', 17],
      ['kManager', 'rc.s', null, 19],
      ['lManager', 'rc.a && rc.b', null, 21],
      ['mManager', '!(rc.c)', null, 22],
      ['nManager', '!(rc.c)', null, 22],
    ]);
  });

  it('places the cfthread write of the DAO fixture inside the thread span', () => {
    const unit = fixtureComponent('dao-writes.cfc');
    const [write] = extractSqlWrites(fn(unit, 'trackAsync'), unit);
    expect(write?.thread).toEqual({ name: 'fixtureThread#createUUID()#', line: 36, endLine: 41 });
  });
});

describe('call chains and actual arguments', () => {
  it('splits named and positional arguments at top-level commas only', () => {
    const calls = guardedCalls(
      'x.cfc',
      [
        'component {',
        ' function run(rc) {',
        '  application.aManager.save(siteid=arguments.rc.siteid, ispublic = 0);',
        '  application.bManager.save(a == b, "c,d", other(g, h), {k=1, m=2}, [1,2], );',
        '  application.cManager',
        '     .save();',
        '  application.dManager.items[1].delete(x);',
        '  application.eManager.save(',
        ' }',
        '}',
      ].join('\n'),
      'run',
    );
    expect(calls.map((s) => [s.text, s.line, s.args])).toEqual([
      [
        'application.aManager.save',
        3,
        [
          { name: 'siteid', expr: 'arguments.rc.siteid' },
          { name: 'ispublic', expr: '0' },
        ],
      ],
      ['application.bManager.save', 4, [{ expr: 'a == b' }, { expr: '"c,d"' }, { expr: 'other(g, h)' }, { expr: '{k=1, m=2}' }, { expr: '[1,2]' }]],
      ['application.cManager.save', 6, []],
      ['application.dManager.items[1].delete', 7, [{ expr: 'x' }]],
    ]);
  });

  it('starts a new chain at the constructed component and follows a variable assigned from it', () => {
    const file = `${FIXTURE_DIR}/appstart-scan.cfm`;
    const calls = guardedCalls(file, tree.readText(file), '', { 'core/mura/bean/beanFactory.cfc': 'component {}' });
    const factory = 'core/mura/bean/beanFactory.cfc';
    expect(calls.map((s) => [s.text, s.target, s.line])).toEqual([
      ['new mura.bean.beanFactory', { component: factory, method: 'init' }, 3],
      ['application.configBean.getStrictFactory', { bean: 'configBean', method: 'getStrictFactory' }, 6],
      ['variables.serviceFactory.addAlias', { component: factory, method: 'addAlias' }, 10],
      ['variables.serviceFactory.addAlias', { component: factory, method: 'addAlias' }, 11],
      ['variables.serviceFactory.addAlias', { component: factory, method: 'addAlias' }, 12],
    ]);
    const [base, options, ...rest] = calls[0]?.args ?? [];
    expect([base, rest]).toEqual([{ expr: '"/mura"' }, []]);
    expect(options?.name).toBeUndefined();
    expect(options?.expr).toMatch(/^\{\s+recurse=true,[\s\S]+strict=application\.configBean\.getStrictFactory\(\),[\s\S]+transientPattern = "[^"]+"\s+\}$/);
    expect(calls.filter((s) => s.target.method === 'addAlias').map((s) => s.args)).toEqual([
      [{ expr: '"user"' }, { expr: '"userBean"' }],
      [{ expr: '"group"' }, { expr: '"userBean"' }],
      [{ expr: '"fixture"' }, { expr: '"fixtureBean"' }],
    ]);
  });

  it('continues a new chain past the constructor call', () => {
    const calls = guardedCalls('v/n.cfm', '<cfset new mura.bean.beanFactory("/x").addAlias("a", "b")>', '', {
      'core/mura/bean/beanFactory.cfc': 'component {}',
    });
    expect(calls.map((s) => [s.text, s.target, s.args])).toEqual([
      ['new mura.bean.beanFactory', { component: 'core/mura/bean/beanFactory.cfc', method: 'init' }, [{ expr: '"/x"' }]],
      ['new mura.bean.beanFactory("/x").addAlias', { component: 'core/mura/bean/beanFactory.cfc', method: 'addAlias' }, [{ expr: '"a"' }, { expr: '"b"' }]],
    ]);
  });

  it('reports an accessor chain once, at the call made on the accessor result', () => {
    const file = `${FIXTURE_DIR}/controller-gate.cfc`;
    const calls = guardedCalls(file, tree.readText(file), 'list');
    expect(calls.map((s) => [s.text, s.target, s.line, s.args])).toEqual([
      [
        'getUserManager().getUserGroups',
        { bean: 'getUserManager()', method: 'getUserGroups' },
        39,
        [
          { name: 'siteid', expr: 'arguments.rc.siteid' },
          { name: 'ispublic', expr: '0' },
        ],
      ],
    ]);
  });
});

describe('literal text', () => {
  const script = (body: string) => `component {\n function f(rc) {\n  ${body}\n }\n}`;

  it.each<[string, string, string, string, string[]]>([
    ['a double-quoted literal', 'x.cfc', 'f', script('var example = "application.userManager.delete(arguments.rc.userid)";'), []],
    ['a single-quoted literal with doubled quotes', 'x.cfc', 'f', script("var s = 'getBean(''user'').save()';"), []],
    ['escaped hashes', 'x.cfc', 'f', script('var s = "##application.userManager.delete(x)##";'), []],
    ['an interpolation', 'x.cfc', 'f', script('var x = "#application.userManager.delete(arguments.rc.userid)#";'), ['application.userManager.delete']],
    ['an interpolation inside an argument', 'x.cfc', 'f', script(`foo("#getBean('user').save()#");`), ["getBean('user').save"]],
    ['an evaluate argument', 'x.cfc', 'f', script(`evaluate('getBean("user").save()');`), ['getBean("user").save']],
    ['template JavaScript', 'v/t.cfm', '', '<script>document.createElement("a"); obj.save();</script>', []],
    ['template output interpolation', 'v/t.cfm', '', "<cfoutput><p>#getBean('content').save()#</p></cfoutput>", ["getBean('content').save"]],
    ['a cfset expression', 'v/t.cfm', '', '<cfset application.userManager.delete(x)>', ['application.userManager.delete']],
    ['a cfset string literal', 'v/t.cfm', '', '<cfset s = "obj.save()">', []],
    ['a cfloop condition', 'v/t.cfm', '', `<cfloop condition="getBean('feed').save() eq false"></cfloop>`, ["getBean('feed').save"]],
    ['another cfloop attribute', 'v/t.cfm', '', '<cfloop list="application.userManager.delete(x)" index="i"></cfloop>', []],
    ['a tag attribute interpolation', 'v/t.cfm', '', `<cfparam name="x" default="getBean('a').save()"><cfparam name="y" default="#getBean('b').save()#">`, ["getBean('b').save"]],
    ['a cfscript block of a template', 'v/t.cfm', '', `<p>obj.save()</p><cfscript>var s = "obj.save()"; getBean('user').save();</cfscript>`, ["getBean('user').save"]],
    ['a stray hash outside cfoutput', 'v/t.cfm', '', "<p>Item #1</p><cfoutput><p>#getBean('a').save()#</p></cfoutput>", ["getBean('a').save"]],
    ['a cffunction body', 'x.cfc', 'f', '<cfcomponent><cffunction name="f"><cfset var s = "obj.save()"><p>obj.save()</p><cfset obj.save()></cffunction></cfcomponent>', ['obj.save']],
    ['a cfscript function of a tag component', 'x.cfc', 'f', '<cfcomponent><cfscript>function f() { var s = "<cfset obj.save()>"; }</cfscript></cfcomponent>', []],
    ['a cfscript function of a template', 'v/t.cfm', 'f', '<cfscript>function f() { var s = "<cfset obj.save()>"; }</cfscript>', []],
  ])('follows calls of %s only where they run', (_label, file, fnName, source, texts) => {
    expect(guardedCalls(file, source, fnName).map((s) => s.text)).toEqual(texts);
  });

  it.each<[string, string, string, string]>([
    ['a script literal assignment', 'x.cfc', 'f', script(`var s = "x; dao = getBean('wrongDAO');"; var dao = getBean('rightDAO'); dao.save();`)],
    ['a template JavaScript assignment', 'v/t.cfm', '', "<script>\ndao = getBean('wrongDAO');\n</script>\n<cfset dao = getBean('rightDAO')>\n<cfset dao.save()>"],
    [
      'a script literal return',
      'x.cfc',
      'f',
      `component { function getDao() { var s = "return getBean('wrongDAO');"; return getBean('rightDAO'); } function f() { getDao().save(); } }`,
    ],
    [
      'a tag literal return',
      'x.cfc',
      'f',
      `<cfcomponent><cffunction name="getDao"><p>return getBean('wrongDAO');</p><cfset var s = "<cfreturn getBean('wrongDAO')>"><cfreturn getBean('rightDAO')></cffunction><cffunction name="f"><cfset getDao().save()></cffunction></cfcomponent>`,
    ],
  ])('binds the receiver past %s', (_label, file, fnName, source) => {
    const unit = file.endsWith('.cfm') ? parseCfmTemplate(file, source) : component(file, source);
    const beans: Record<string, string> = { wrongdao: 'm/wrong.cfc', rightdao: 'm/right.cfc' };
    const ctx: ClosureContext = {
      tree: memorySourceTree({ [file]: source }),
      index: {
        resolveBean: (name) => beans[name.toLowerCase()] ?? null,
        ormTable: () => null,
        parsed: (p) => (p === file && unit.syntax !== 'template' ? (unit as CfmlComponent) : null),
      },
    };
    expect(extractCalls(fn(unit, fnName), unit, ctx).map((s) => [s.text.split('.').pop(), s.target])).toEqual([['save', { bean: 'rightDAO', method: 'save' }]]);
  });

  it.each<[string, string, string, string[]]>([
    ['script literals', 'x.cfc', script(`var s = "include 'x.cfm'"; var t = "cfinclude(template='y.cfm')"; include "real.cfm";`), ['real.cfm']],
    ['template text', 'v/t.cfm', '<p>Please include "your name".</p><cfinclude template="a.cfm"><cfscript>var s = "include \'x.cfm\'"; include "b.cfm";</cfscript>', ['a.cfm', 'b.cfm']],
  ])('ignores includes inside %s', (_label, file, source, templates) => {
    const unit = file.endsWith('.cfm') ? parseCfmTemplate(file, source) : component(file, source);
    expect(unit.functions[0]?.includes.map((i) => i.template)).toEqual(templates);
  });

  it.each<[string, string, string, string, string[], string[], string[]]>([
    ['a script string', 'x.cfc', 'f', script(`var s = "<cfinclude template='writer.cfm'>";`), [], [], []],
    ['a cfset string of a template', 'v/t.cfm', '', `<cfset s = "<cfinclude template='writer.cfm'>">`, [], [], []],
    ['a cfset string of a cffunction', 'x.cfc', 'f', `<cfcomponent><cffunction name="f"><cfset var s = "<cfinclude template='writer.cfm'>"></cffunction></cfcomponent>`, [], [], []],
    ['a cfscript string of a template', 'v/t.cfm', '', `<cfscript>var s = "<cfinclude template='writer.cfm'>";</cfscript>`, [], [], []],
    ['template text', 'v/t.cfm', '', '<p>x</p><cfinclude template="writer.cfm">', ['writer.cfm'], ['tinvented'], []],
    ['a cffunction body', 'x.cfc', 'f', '<cfcomponent><cffunction name="f"><cfinclude template="writer.cfm"></cffunction></cfcomponent>', ['writer.cfm'], ['tinvented'], []],
    ['template JavaScript quotes', 'v/t.cfm', '', `<script>var s = "<cfinclude template='writer.cfm'>";</script>`, ['writer.cfm'], ['tinvented'], []],
    ['template text with an interpolated name', 'v/t.cfm', '', '<cfset n = "writer"><cfinclude template="#n#.cfm">', ['#n#.cfm'], [], ['include:#n#.cfm']],
  ])('follows a <cfinclude> in %s only where it runs', (_label, file, fnName, source, templates, tables, unresolved) => {
    const unit = file.endsWith('.cfm') ? parseCfmTemplate(file, source) : component(file, source);
    const writer = path.posix.join(path.posix.dirname(file), 'writer.cfm');
    const ctx: ClosureContext = {
      tree: memorySourceTree({ [file]: source, [writer]: '<cfquery>delete from tinvented</cfquery>' }),
      index: { resolveBean: () => null, ormTable: () => null, parsed: (p) => (p === file && unit.syntax !== 'template' ? (unit as CfmlComponent) : null) },
    };
    const closure = computeClosure({ component: file, method: fnName }, ctx);
    expect(fn(unit, fnName).includes.map((i) => i.template)).toEqual(templates);
    expect(closure.tables).toEqual(tables);
    expect(closure.unresolved.map((u) => `${u.kind}:${u.expr}`)).toEqual(unresolved);
  });

  it.each<[string, string, string, string, 'script' | 'tag']>([
    ['a script component function', 'x.cfc', 'component { function f() {} }', 'f', 'script'],
    ['a cffunction', 'x.cfc', '<cfcomponent><cffunction name="f"></cffunction></cfcomponent>', 'f', 'tag'],
    ['a cfscript function of a tag component', 'x.cfc', '<cfcomponent><cfscript>function f() {}</cfscript></cfcomponent>', 'f', 'script'],
    ['the template pseudo-function', 'v/t.cfm', '<cfscript>function f() {}</cfscript>', '', 'tag'],
    ['a cfscript function of a template', 'v/t.cfm', '<cfscript>function f() {}</cfscript>', 'f', 'script'],
  ])('records the lexical mode of %s', (_label, file, source, fnName, mode) => {
    const unit = file.endsWith('.cfm') ? parseCfmTemplate(file, source) : component(file, source);
    expect(fn(unit, fnName).mode).toBe(mode);
  });
});


describe('extractSqlWrites', () => {
  it('finds the cfquery writes of the DAO fixture with their lines and WHERE argument references', () => {
    const unit = fixtureComponent('dao-writes.cfc');
    const writes = (name: string) => withoutOffsets(extractSqlWrites(fn(unit, name), unit));
    expect(writes('create')).toEqual([{ table: 'tfixture', op: 'insert', line: 7, endLine: 12, whereParams: [], tableExpr: 'tfixture' }]);
    expect(writes('update')).toEqual([{ table: 'tfixture', op: 'update', line: 20, endLine: 22, whereParams: ['userid'], tableExpr: 'tfixture' }]);
    expect(writes('deleteMembership')).toEqual([
      { table: 'tfixturemembers', op: 'delete', line: 30, endLine: 30, whereParams: ['userid', 'groupid'], tableExpr: 'tfixturemembers' },
    ]);
    expect(writes('trackAsync')).toEqual([
      {
        table: 'tfixturestats',
        op: 'insert',
        line: 38,
        endLine: 39,
        whereParams: [],
        tableExpr: 'tfixturestats',
        thread: { name: 'fixtureThread#createUUID()#', line: 36, endLine: 41 },
      },
    ]);
    expect(writes('refreshLogin')).toEqual([]);
    const create = fn(unit, 'create');
    expect(offsetsPointAt(create, extractSqlWrites(create, unit), 11)).toEqual(['INSERT INTO']);
  });

  it('finds the queryExecute writes of the manager fixture with placeholder WHERE parameters and the thread write', () => {
    const unit = fixtureComponent('manager-writes.cfc');
    const writes = (name: string) => withoutOffsets(extractSqlWrites(fn(unit, name), unit));
    expect(writes('rename')).toEqual([{ table: 'tfixture', op: 'update', line: 5, endLine: 5, whereParams: ['userid'], tableExpr: 'tfixture' }]);
    expect(writes('purgeSite')).toEqual([{ table: 'tfixture', op: 'delete', line: 9, endLine: 9, whereParams: ['siteid'], tableExpr: 'tfixture' }]);
    expect(writes('trackStats')).toEqual([
      {
        table: 'tfixturestats',
        op: 'insert',
        line: 14,
        endLine: 14,
        whereParams: [],
        tableExpr: 'tfixturestats',
        thread: { name: 'fixtureStats', line: 13, endLine: 15 },
      },
    ]);
    expect(writes('refreshLogin')).toEqual([]);
    expect(writes('create')).toEqual([]);
  });

  it('splits one SQL string into statements, normalising bracketed and dbo-qualified names and deduplicating parameters', () => {
    const unit = component(
      'm/x.cfc',
      'component { function f() { queryExecute("INSERT INTO ta (a) VALUES (1); UPDATE [dbo].[TB] SET x = 1 WHERE id = :id AND id = :id; DELETE FROM dbo.tc WHERE k = :k::text AND z = \'::x\'"); } }',
    );
    const f = fn(unit, 'f');
    const writes = extractSqlWrites(f, unit);
    expect(withoutOffsets(writes)).toEqual([
      { table: 'ta', op: 'insert', line: 1, endLine: 1, whereParams: [], tableExpr: 'ta' },
      { table: 'tb', op: 'update', line: 1, endLine: 1, whereParams: ['id'], tableExpr: '[dbo].[TB]' },
      { table: 'tc', op: 'delete', line: 1, endLine: 1, whereParams: ['k'], tableExpr: 'dbo.tc' },
    ]);
    expect(offsetsPointAt(f, writes, 6)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
  });

  it('spans a multi-line statement from its keyword to its last non-blank line', () => {
    const unit = component(
      'm/x.cfc',
      ['component {', '  function f() {', '    queryExecute("', '      UPDATE tmulti', '      SET a = 1', '      WHERE id = :id', '    ");', '  }', '}'].join('\n'),
    );
    expect(withoutOffsets(extractSqlWrites(fn(unit, 'f'), unit))).toEqual([
      { table: 'tmulti', op: 'update', line: 4, endLine: 6, whereParams: ['id'], tableExpr: 'tmulti' },
    ]);
  });

  it('accepts DELETE with or without FROM and keeps a schema-qualified program table', () => {
    const unit = component(
      'm/x.cfc',
      'component { function f() { queryExecute("DELETE tz WHERE a = :a"); queryExecute("DELETE tq"); queryExecute("delete from tr"); queryExecute("UPDATE [Program_1].[timesheet] SET a = 1"); } }',
    );
    expect(extractSqlWrites(fn(unit, 'f'), unit).map((w) => [w.op, w.table, w.whereParams])).toEqual([
      ['delete', 'tz', ['a']],
      ['delete', 'tq', []],
      ['delete', 'tr', []],
      ['update', 'program_1.timesheet', []],
    ]);
  });

  it('ignores SQL words outside SQL spans, UPDATE without SET, DELETE of prose and targets that are not names', () => {
    const unit = component(
      'm/x.cfc',
      [
        'component { function f() {',
        '  var msg = "insert into tnot values (1)";',
        '  queryExecute("SELECT x FROM t WHERE flag = \'update me\' AND y = \'delete me please\'");',
        '  queryExecute("UPDATE 123abc SET a = 1");',
        '  queryExecute("INSERT INTO (SELECT 1)");',
        '  queryExecute("UPDATE [broken SET a = 1");',
        '} }',
      ].join('\n'),
    );
    expect(extractSqlWrites(fn(unit, 'f'), unit)).toEqual([]);
  });

  it('reads SQL given to setSql, a sql= argument and a sql variable, and an unclosed cfquery to the end', () => {
    const script = component(
      'm/x.cfc',
      'component { function f() { q.setSql("DELETE FROM tq1 WHERE id = :id"); var q2 = new Query(sql="UPDATE tq2 SET a=1 WHERE id = :id2"); sql = \'INSERT INTO tq3 (a) VALUES (1)\'; } }',
    );
    expect(extractSqlWrites(fn(script, 'f'), script).map((w) => [w.op, w.table, w.whereParams])).toEqual([
      ['delete', 'tq1', ['id']],
      ['update', 'tq2', ['id2']],
      ['insert', 'tq3', []],
    ]);
    const open = component('m/o.cfc', '<cfcomponent><cffunction name="f"><cfquery>INSERT INTO topen (a) VALUES (1)');
    expect(extractSqlWrites(fn(open, 'f'), open).map((w) => w.table)).toEqual(['topen']);
  });

  it('reads cfquery WHERE parameters from argument references and getters, never from colon placeholders', () => {
    const unit = component(
      'm/x.cfc',
      '<cfcomponent><cffunction name="f"><cfquery>UPDATE t SET a = #arguments.a# WHERE b = :b AND c = #arguments.data.getUserID()# AND d = #arguments.rc.siteid# AND e = #arguments.getx# AND f = #  arguments.userid  #</cfquery></cffunction></cfcomponent>',
    );
    expect(extractSqlWrites(fn(unit, 'f'), unit).map((w) => w.whereParams)).toEqual([['userid', 'siteid', 'getx']]);
  });

  it('resolves the self-table expressions through the declared table attribute and leaves other expressions dynamic', () => {
    const unit = component(
      'm/x.cfc',
      [
        'component table="tDecl" { function f() {',
        '  queryExecute("INSERT INTO #variables.table# (a) VALUES (1)");',
        '  queryExecute("UPDATE #getTable()# SET a=1");',
        '  queryExecute("UPDATE # this.getTable() # SET a=1");',
        '  queryExecute("UPDATE #variables.instance.table# SET a=1");',
        '  queryExecute("DELETE FROM #arguments.tablename# WHERE x = :x");',
        '  queryExecute("INSERT INTO #application.prefix#tfixture (a) VALUES (1)");',
        '} }',
      ].join('\n'),
    );
    const f = fn(unit, 'f');
    expect(extractSqlWrites(f, unit).map((w) => [w.table, w.dynamic ?? false, w.tableExpr, w.line])).toEqual([
      ['tdecl', false, '#variables.table#', 2],
      ['tdecl', false, '#getTable()#', 3],
      ['tdecl', false, '# this.getTable() #', 4],
      ['tdecl', false, '#variables.instance.table#', 5],
      [null, true, '#arguments.tablename#', 6],
      [null, true, '#application.prefix#tfixture', 7],
    ]);
    expect(extractSqlWrites(f).map((w) => [w.table, w.dynamic])).toEqual(Array.from({ length: 6 }, () => [null, true]));
  });

  it('resolves the self table from a literal variables.table assignment but not from an interpolated one', () => {
    const write = (init: string) => {
      const unit = component('m/x.cfc', `component { function init() { ${init} } function f() { queryExecute("DELETE FROM #variables.table# WHERE id = :id"); } }`);
      return extractSqlWrites(fn(unit, 'f'), unit).map((w) => [w.table, w.dynamic ?? false]);
    };
    expect(write('variables.table = "tAssigned";')).toEqual([['tassigned', false]]);
    expect(write('local.x = 1; variables.table = "t#x#";')).toEqual([[null, true]]);
    expect(write('variables.table = "";')).toEqual([[null, true]]);
    expect(write('variables.table = "t" & "x";')).toEqual([[null, true]]);
  });

  it('resolves a template self table from a cfset and detects the syntax of a body given without its unit', () => {
    const unit = parseCfmTemplate('t.cfm', '<cfset variables.table = "tpl" />\n<cfquery>UPDATE #variables.table# SET a = 1</cfquery>\n');
    const whole = fn(unit, '');
    expect(extractSqlWrites(whole, unit).map((w) => [w.table, w.line])).toEqual([['tpl', 2]]);
    expect(extractSqlWrites(whole).map((w) => [w.table, w.dynamic])).toEqual([[null, true]]);
    const dao = fixtureComponent('dao-writes.cfc');
    const detached = fn(fixtureComponent('dao-writes.cfc'), 'update');
    expect(withoutOffsets(extractSqlWrites(detached))).toEqual(withoutOffsets(extractSqlWrites(fn(dao, 'update'), dao)));
    expect(extractSqlWrites(fn(fixtureComponent('manager-writes.cfc'), 'purgeSite')).map((w) => [w.table, w.line])).toEqual([['tfixture', 9]]);
  });

  it('returns fresh copies, so changing one result leaves the next unchanged', () => {
    const unit = fixtureComponent('dao-writes.cfc');
    const first = extractSqlWrites(fn(unit, 'deleteMembership'), unit);
    first[0]?.whereParams.push('changed');
    const second = extractSqlWrites(fn(unit, 'deleteMembership'), unit);
    expect(second).not.toBe(first);
    expect(second[0]?.whereParams).toEqual(['userid', 'groupid']);
  });
});

describe('resolveComponentPath', () => {
  it('maps mura and muraWRM names and resolves bare names as siblings in the extracted tree', () => {
    const target = `${FIXTURE_DIR}/tagComponent.cfc`;
    expect(resolveComponentPath('mura.fixture.tagComponent', 'admin/core/controllers/cusers.cfc', tree)).toBe(target);
    expect(resolveComponentPath('MuraWRM.core.mura.fixture.tagComponent', 'x.cfc', tree)).toBe(target);
    expect(resolveComponentPath('tagComponent', `${FIXTURE_DIR}/dao-writes.cfc`, tree)).toBe(target);
    expect(resolveComponentPath('fixture.tagComponent', 'core/mura/content.cfc', tree)).toBe(target);
    expect(resolveComponentPath('top', 'Application.cfc', tree)).toBe('top.cfc');
    expect(resolveComponentPath('top', `${FIXTURE_DIR}/dao-writes.cfc`, tree)).toBeNull();
  });

  it('prefers the dotted path relative to the caller and falls back to the root', () => {
    const mem = memorySourceTree({ 'a/sub/x.cfc': '', 'sub/x.cfc': '', 'sub/y.cfc': '', 'a/mura.cfc': '', 'a/mura/only.cfc': '' });
    expect(resolveComponentPath('sub.x', 'a/b.cfc', mem)).toBe('a/sub/x.cfc');
    expect(resolveComponentPath('sub.y', 'a/b.cfc', mem)).toBe('sub/y.cfc');
    expect(resolveComponentPath(' sub.y ', 'q.cfc', mem)).toBe('sub/y.cfc');
    expect(resolveComponentPath('mura', 'a/b.cfc', mem)).toBe('a/mura.cfc');
    expect(resolveComponentPath('mura.only', 'a/b.cfc', mem)).toBeNull();
  });

  it.each(['', 'a..b', '#dyn#', 'a/b', '1abc', 'missing', 'mura.missing'])('returns null for %j', (name) => {
    expect(resolveComponentPath(name, 'a/b.cfc', memorySourceTree({ 'a/missing.cfc.bak': '', 'a/b.cfc': '' }))).toBeNull();
  });
});
