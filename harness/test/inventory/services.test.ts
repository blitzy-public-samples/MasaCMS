import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSourceTree } from '../../src/inventory/closure.js';
import type { ComponentIndex, SourceTree } from '../../src/inventory/closure.js';
import { extractEntities, ormEntityIndex } from '../../src/inventory/entities.js';
import {
  DI1_SCAN,
  SERVICE_LIST,
  STARTUP_PATH,
  buildComponentIndex,
  extractAliases,
  extractServices,
  extractTransients,
  parseScanConfig,
  parseServiceList,
} from '../../src/inventory/services.js';
import type { AliasEntry, ServiceEntry } from '../../src/inventory/services.js';

const MANAGER = 'core/mura/fixture/fixtureManager.cfc';
const DAO = 'core/mura/fixture/fixtureDAO.cfc';
const BEAN = 'core/mura/fixture/fixtureBean.cfc';
const ITERATOR = 'core/mura/fixture/fixtureIterator.cfc';
const USER_MANAGER = 'core/mura/user/userManager.cfc';
const CONFIG_BEAN = 'core/mura/configBean.cfc';

/** Temp-tree destination → committed fixture copied byte for byte. */
const COPIED: Readonly<Record<string, string>> = {
  [STARTUP_PATH]: 'appstart-scan.cfm',
  [MANAGER]: 'manager-writes.cfc',
  [DAO]: 'dao-writes.cfc',
  [BEAN]: 'entity-with-bom.cfc',
};

const MINIMAL_CFC = 'component extends="mura.cfobject" output="false" {\n}\n';

/** Temp-tree destination → inline component text. */
const INLINE: Readonly<Record<string, string>> = {
  [USER_MANAGER]: MINIMAL_CFC,
  [CONFIG_BEAN]: MINIMAL_CFC,
  [ITERATOR]: MINIMAL_CFC,
};

let root: string;
let tree: SourceTree;

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/cfml/${name}`, import.meta.url));
}

function service(name: string): ServiceEntry {
  const found = extractServices(tree).find((s) => s.name === name);
  if (found === undefined) throw new Error(`no service named ${name}`);
  return found;
}

function alias(name: string, target: string, file: string | null, line: number): AliasEntry {
  return {
    alias: name,
    target,
    resolvedTarget: target,
    path: file,
    status: 'effective',
    condition: null,
    line,
    source: { path: STARTUP_PATH, lines: [line, line] },
  };
}

function componentIndex(): ComponentIndex {
  return buildComponentIndex({
    services: extractServices(tree),
    aliases: extractAliases(tree),
    ormIndex: ormEntityIndex(extractEntities(tree).entities),
    tree,
  });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-services-'));
  for (const [rel, name] of Object.entries(COPIED)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await copyFile(fixturePath(name), path.join(root, rel));
  }
  for (const [rel, text] of Object.entries(INLINE)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  tree = openSourceTree(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('DI1 constants', () => {
  it.each([
    ['contentBean', true],
    ['userIterator', true],
    ['dbUtility', true],
    ['extendObject', true],
    ['contentMuraScope', true],
    ['userManager', false],
    ['contentDAO', false],
    ['contentGateway', false],
  ] as const)('classifies %s as transient: %s', (name, transient) => {
    expect(new RegExp(DI1_SCAN.transientPattern).test(name)).toBe(transient);
  });

  it('equals the scan arguments written in the start-up fixture', () => {
    const ctor = readFileSync(fixturePath('appstart-scan.cfm'), 'utf8').split('\n').slice(2, 8).join('\n');
    const excludeLiteral = /exclude=\[([^\]]*)\]/.exec(ctor)?.[1];
    const patternLiteral = /transientPattern\s*=\s*"([^"]*)"/.exec(ctor)?.[1];
    expect(ctor).toMatch(/new mura\.bean\.beanFactory\("\/mura",\{/);
    expect(ctor).toMatch(/recurse=true,/);
    expect(JSON.parse(`[${excludeLiteral ?? ''}]`)).toEqual([...DI1_SCAN.exclude]);
    expect(patternLiteral).toBe(DI1_SCAN.transientPattern.source);

    expect(DI1_SCAN.mapping).toBe('/mura');
    expect(DI1_SCAN.recursive).toBe(true);
    expect(DI1_SCAN.exclude).toHaveLength(9);
    expect(DI1_SCAN.exclude).toEqual(expect.arrayContaining(['/mura/client/oath', '/mura/configBean.cfc']));
    expect(parseScanConfig(tree)).toEqual({
      mapping: DI1_SCAN.mapping,
      recursive: DI1_SCAN.recursive,
      exclude: [...DI1_SCAN.exclude],
      transientPattern: DI1_SCAN.transientPattern.source,
      source: { path: STARTUP_PATH, lines: [3, 8] },
    });
  });

  it('lists the 26 application services from utility to autoUpdater', () => {
    expect(SERVICE_LIST).toHaveLength(26);
    expect(new Set(SERVICE_LIST).size).toBe(26);
    expect(SERVICE_LIST[0]).toBe('utility');
    expect(SERVICE_LIST.at(-1)).toBe('autoUpdater');
    expect(SERVICE_LIST).toEqual(expect.arrayContaining(['userManager', 'contentServer', 'permUtility']));
  });
});

describe('extractAliases', () => {
  it('records each addAlias with its target, component file and start-up line', () => {
    expect(extractAliases(tree)).toEqual({
      aliases: [alias('user', 'userBean', null, 10), alias('group', 'userBean', null, 11), alias('fixture', 'fixtureBean', BEAN, 12)],
      declaredBeans: [],
    });
  });
});

describe('extractServices', () => {
  it('lists the scanned singletons sorted by id', () => {
    const ids = extractServices(tree).map((s) => s.id);
    expect(ids).toEqual(['svc:fixtureDAO', 'svc:fixtureManager', 'svc:userManager']);
    expect(ids).toEqual([...ids].sort());
  });

  it('classifies managers and DAOs by name with their component paths', () => {
    expect(service('fixtureManager')).toMatchObject({
      id: 'svc:fixtureManager',
      kind: 'manager',
      component: 'mura.fixture.fixtureManager',
      source: { path: MANAGER, lines: [2, 2] },
      registration: 'scan',
      beanNames: ['fixtureManager', 'fixtureManagerfixture'],
      inServiceList: false,
      serviceListNames: [],
    });
    expect(service('fixtureDAO')).toMatchObject({
      id: 'svc:fixtureDAO',
      kind: 'dao',
      component: 'mura.fixture.fixtureDAO',
      source: { path: DAO, lines: [2, 2] },
      inServiceList: false,
    });
  });

  it('marks service-list members from SERVICE_LIST when the start-up assigns no serviceList', () => {
    expect(parseServiceList(tree)).toBeNull();
    expect(service('userManager')).toMatchObject({
      kind: 'manager',
      source: { path: USER_MANAGER, lines: [1, 1] },
      inServiceList: true,
      serviceListNames: ['userManager'],
    });
  });

  it('skips excluded paths and keeps Bean and Iterator components as transients', () => {
    const singletons = extractServices(tree);
    const transients = extractTransients(tree);
    for (const name of ['configBean', 'fixtureBean', 'fixtureIterator']) expect(singletons.map((s) => s.name)).not.toContain(name);
    expect([...singletons, ...transients].map((e) => e.source.path)).not.toContain(CONFIG_BEAN);
    expect(transients.map((t) => [t.name, t.source.path])).toEqual([
      ['fixtureBean', BEAN],
      ['fixtureIterator', ITERATOR],
    ]);
  });

  it('gives every entry a source span and leaves owner and disposition unset', () => {
    for (const entry of extractServices(tree)) {
      const [start, end] = entry.source.lines;
      expect(entry.source.path).toMatch(/^core\/mura\/.+\.cfc$/);
      expect(start).toBeGreaterThanOrEqual(1);
      expect(end).toBeGreaterThanOrEqual(start);
      expect(entry).not.toHaveProperty('owningService');
      expect(entry).not.toHaveProperty('disposition');
    }
  });
});

describe('buildComponentIndex', () => {
  it.each([
    ['fixtureDAO', DAO],
    ['FIXTUREMANAGER', MANAGER],
    ['fixture', BEAN],
    ['fixtureIterator', ITERATOR],
    ['mura.user.userManager', USER_MANAGER],
    ['noSuchBean', null],
    ['user', null],
    ['configBean', null],
  ] as const)('resolves bean %s to %s', (name, file) => {
    expect(componentIndex().resolveBean(name)).toBe(file);
  });

  it('maps the ORM entity component to its table', () => {
    const index = componentIndex();
    expect(index.ormTable(BEAN)).toBe('tfixture');
    expect(index.ormTable(DAO)).toBeNull();
  });

  it('parses the components the closure walk visits', () => {
    const index = componentIndex();
    expect(index.parsed(MANAGER)?.functions.map((f) => f.name)).toEqual(['rename', 'purgeSite', 'trackStats', 'refreshLogin', 'create']);
    expect(index.parsed('core/mura/fixture/absent.cfc')).toBeNull();
  });
});
