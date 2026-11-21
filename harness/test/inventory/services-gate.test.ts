import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memorySourceTree, openSourceTree, parseCfmlComponent } from '../../src/inventory/closure.js';
import type { ComponentIndex, SourceTree } from '../../src/inventory/closure.js';
import { extractEntities, ormEntityIndex } from '../../src/inventory/entities.js';
import {
  DI1_AUTO_EXCLUDE,
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
import type { AliasExtraction, BeanEntry, RegistrationStatus } from '../../src/inventory/services.js';
import { assertOutsideRepo } from '../../src/lib/paths.js';

/** `variables.serviceList` as the legacy start-up assigns it [onApplicationStart_include.cfm:495]. */
const LEGACY_SERVICE_LIST =
  'utility,pluginManager,settingsManager,fileManager,contentManager,eventManager,contentRenderer,contentUtility,contentGateway,categoryManager,clusterManager,contentServer,changesetManager,scriptProtectionFilter,permUtility,emailManager,loginManager,mailinglistManager,userManager,dataCollectionManager,feedManager,sessionTrackingManager,favoriteManager,raterManager,dashboardManager,autoUpdater';
/** Scan `exclude` and `transientPattern` as the legacy start-up passes them [onApplicationStart_include.cfm:231-233]. */
const LEGACY_EXCLUDE = [
  '/.',
  '/mura/autoUpdater/global',
  '/mura/configBean.cfc',
  '/mura/bean/beanFactory.cfc',
  '/mura/cache/provider',
  '/mura/moment.cfc',
  '/mura/client/oath',
  '/mura/client/api/json/v1/apiUtility.cfc',
  '/mura/client/api/feed/v1/apiUtility.cfc',
];
const LEGACY_TRANSIENT_PATTERN = '(Iterator|Bean|executor|MuraScope|Event|dbUtility|extendObject)$';
const SCAN_SOURCE = { path: STARTUP_PATH, lines: [3, 8] as [number, number] };

/** Start-up lines appended after the committed scan fixture, which ends at line 13. */
const STARTUP_TAIL = [
  '<cfscript>',
  '\tapplication.configBean=new mura.configBean();',
  '\tvariables.serviceFactory.addBean("configBean",application.configBean);',
  '\tvariables.serviceFactory.addBean("tempDir",application.configBean.getTempDir());',
  '\tvariables.serviceFactory.addBean("data","");',
  '\tvariables.serviceFactory.addBean("fixtureManager",new mura.fixture.fixtureManager());',
  '\tvariables.serviceFactory.addBean("unassigned",variables.neverAssigned);',
  '\tvariables.serviceFactory.declareBean("beanValidator", "mura.bean.beanValidator", true);',
  '\tvariables.serviceFactory.declareBean(beanName="moment", dottedPath="mura.moment", isSingleton=false);',
  '\tvariables.serviceFactory.declareBean("missing", "mura.fixture.missingService");',
  '\tvariables.serviceFactory.declareBean("dynamic", variables.dottedPath);',
  '\tvariables.serviceFactory.declareBean("fixtureContract", "mura.fixture.fixtureContract");',
  "\tif(server.coldfusion.productName eq 'Coldfusion Server'){",
  '\t\tvariables.serviceFactory.addAlias("contentGateway","contentGatewayAdobe");',
  '\t} else {',
  '\t\tvariables.serviceFactory.addAlias("contentGateway","contentGatewayLucee");',
  '\t\tvariables.serviceFactory.declareBean("luceeLoader","mura.content.contentGatewayLucee");',
  '\t}',
  '\tvariables.serviceFactory.addAlias("eventManager","pluginManager");',
  '\tvariables.serviceFactory.addAlias("settingsBundle","settingsBundleBean");',
  '\tvariables.serviceFactory.addAlias("bundle","settingsBundle");',
  '\tvariables.serviceFactory.addAlias("groupDAO","userDAO");',
  '\tvariables.serviceFactory.addAlias("ghost","noSuchBean");',
  '\tvariables.serviceFactory.addAlias("fixture","fixtureManager");',
  '\tvariables.serviceFactory.addBean("data",{});',
  `\tvariables.serviceList="${LEGACY_SERVICE_LIST}";`,
  '</cfscript>',
  '',
].join('\n');

/** Script component with an optional body. */
function cfc(body = ''): string {
  return `component extends="mura.cfobject" output="false" {${body}}\n`;
}

/** Files of the on-disk tree copied from committed fixtures. */
const COPIED: Readonly<Record<string, string>> = {
  'core/mura/fixture/fixtureManager.cfc': 'manager-writes.cfc',
  'core/mura/fixture/fixtureDAO.cfc': 'dao-writes.cfc',
  'core/mura/fixture/fixtureBean.cfc': 'entity-with-bom.cfc',
};

/** Paths the scan must skip: DI1_SCAN excludes and DI1 auto-excludes, matched as case-insensitive substrings. */
const EXCLUDED = [
  'core/mura/configBean.cfc',
  'core/mura/moment.cfc',
  'core/mura/bean/beanFactory.cfc',
  'core/mura/client/oath/oauthHelper.cfc',
  'core/mura/Client/Oath/legacyManager.cfc',
  'core/mura/cache/providerRegistry.cfc',
  'core/mura/.cache/hiddenManager.cfc',
  'core/mura/Application.cfc',
  'core/mura/framework/ioc.cfc',
  'core/mura/WEB-INF/serverManager.cfc',
] as const;

/** Files of the on-disk tree written inline. */
const INLINE: Readonly<Record<string, string>> = {
  ...Object.fromEntries(EXCLUDED.map((file) => [file, cfc()])),
  'core/mura/fixture/fixtureIterator.cfc': cfc(),
  'core/mura/fixture/fixtureevent.cfc': cfc(),
  'core/mura/fixture/beans/fixtureHelper.cfc': cfc(),
  'core/mura/fixture/fixtureContract.cfc': 'interface {\n\tpublic void function run();\n}\n',
  'core/mura/fixture/tagContract.cfc': '<cfinterface>\n<cffunction name="run"></cffunction>\n</cfinterface>\n',
  'core/mura/fixture/notes.txt': 'plain text\n',
  'core/mura/fixture/page.cfm': '<cfoutput>page</cfoutput>\n',
  'core/mura/bean/beanHelper.cfc': cfc(),
  'core/mura/bean/beanValidator.cfc': cfc(),
  'core/mura/user/userManager.cfc': cfc('\n\tpublic any function read(required string userid) {\n\t\treturn getBean("userDAO").read(arguments.userid);\n\t}\n'),
  'core/mura/user/userDAO.cfc': cfc(),
  'core/mura/user/userBean.cfc': cfc(),
  'core/mura/settings/settingsManager.cfc': cfc(),
  'core/mura/settings/settingsBundleBean.cfc': cfc(),
  'core/mura/plugin/pluginManager.cfc': cfc(),
  'core/mura/content/contentGatewayAdobe.cfc': cfc(),
  'core/mura/content/contentGatewayLucee.cfc': cfc(),
  'core/mura/content/contentUtility.cfc': cfc(),
  'core/mura/utility.cfc': cfc(),
};

let root: string;
let tree: SourceTree;
let startupText: string;

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/cfml/${name}`, import.meta.url));
}

/** 1-based line of the only occurrence of `needle` in the on-disk start-up template. */
function startupLine(needle: string): number {
  const offset = startupText.indexOf(needle);
  if (offset < 0 || startupText.indexOf(needle, offset + 1) >= 0) throw new Error(`${JSON.stringify(needle)} is not unique in the start-up`);
  return startupText.slice(0, offset).split('\n').length;
}

/** Start-up source of a span of one line. */
function at(line: number): { path: string; lines: [number, number] } {
  return { path: STARTUP_PATH, lines: [line, line] };
}

/** Lines 3-8 of the committed scan fixture: the `new mura.bean.beanFactory(...)` constructor. */
function scanCtor(): string[] {
  return readFileSync(fixturePath('appstart-scan.cfm'), 'utf8').split('\n').slice(2, 8);
}

/** The committed scan constructor inside a script block, followed by `lines`. */
function scanStartup(...lines: string[]): string {
  return ['<cfscript>', ...scanCtor(), ...lines, '</cfscript>', ''].join('\n');
}

function byName<T extends { name: string }>(entries: readonly T[], name: string): T {
  const found = entries.find((e) => e.name === name);
  if (found === undefined) throw new Error(`no entry named ${name}`);
  return found;
}

function indexFor(source: SourceTree, overrides: Partial<{ aliases: AliasExtraction; transients: BeanEntry[] }> = {}): ComponentIndex {
  return buildComponentIndex({
    services: extractServices(source),
    transients: overrides.transients,
    aliases: overrides.aliases ?? extractAliases(source),
    ormIndex: ormEntityIndex(extractEntities(source).entities),
    tree: source,
  });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-inv-services-gate-'));
  const put = async (rel: string, text: string): Promise<void> => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  startupText = readFileSync(fixturePath('appstart-scan.cfm'), 'utf8') + STARTUP_TAIL;
  await put(STARTUP_PATH, startupText);
  for (const [rel, text] of Object.entries(INLINE)) await put(rel, text);
  for (const [rel, name] of Object.entries(COPIED)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await copyFile(fixturePath(name), path.join(root, rel));
  }
  tree = openSourceTree(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('DI1 constants', () => {
  it('match the scan arguments and the 26-name service list of the legacy start-up', () => {
    expect(parseScanConfig(tree)).toEqual({
      mapping: '/mura',
      recursive: true,
      exclude: LEGACY_EXCLUDE,
      transientPattern: LEGACY_TRANSIENT_PATTERN,
      source: SCAN_SOURCE,
    });
    expect({ mapping: DI1_SCAN.mapping, recursive: DI1_SCAN.recursive, exclude: [...DI1_SCAN.exclude] }).toEqual({
      mapping: '/mura',
      recursive: true,
      exclude: LEGACY_EXCLUDE,
    });
    expect(DI1_SCAN.transientPattern.source).toBe(LEGACY_TRANSIENT_PATTERN);
    expect(DI1_SCAN.transientPattern.flags).toBe('i');
    expect(DI1_SCAN.root).toBe('core/mura');
    expect(SERVICE_LIST.join(',')).toBe(LEGACY_SERVICE_LIST);
    expect(SERVICE_LIST).toHaveLength(26);
  });

  it('list the framework files DI1 appends to every exclude list', () => {
    expect(DI1_AUTO_EXCLUDE).toEqual([
      '/WEB-INF',
      '/Application.cfc',
      '/MyApplication.cfc',
      'framework.cfc',
      'ioc.cfc',
      '/framework/aop.cfc',
      '/framework/beanProxy.cfc',
      '/framework/ioc.cfc',
      '/framework/WireBoxAdapter.cfc',
      '/framework/one.cfc',
    ]);
  });
});

describe('parseScanConfig', () => {
  it('returns null for a tree without the start-up template or without a factory constructor', () => {
    expect(parseScanConfig(memorySourceTree({ 'core/mura/foo/fooManager.cfc': cfc() }))).toBeNull();
    expect(parseScanConfig(memorySourceTree({ [STARTUP_PATH]: '<cfset x = 1>\n' }))).toBeNull();
  });

  it('reads named folder and config arguments as written', () => {
    const source = memorySourceTree({
      [STARTUP_PATH]: `<cfscript>\nvariables.serviceFactory=new mura.bean.beanFactory(folders="/mura", config={recurse=false, exclude=['/x', "/y"], transientPattern='Bean$'});\n</cfscript>\n`,
    });
    expect(parseScanConfig(source)).toEqual({
      mapping: '/mura',
      recursive: false,
      exclude: ['/x', '/y'],
      transientPattern: 'Bean$',
      source: at(2),
    });
  });

  it('defaults recurse to true and leaves an absent or computed argument empty', () => {
    const source = memorySourceTree({
      [STARTUP_PATH]: '<cfscript>\nvariables.serviceFactory=new mura.bean.beanFactory(variables.folders);\n</cfscript>\n',
    });
    expect(parseScanConfig(source)).toEqual({ mapping: '', recursive: true, exclude: [], transientPattern: '', source: at(2) });
  });
});

describe('parseServiceList', () => {
  it('reads the variables.serviceList names and line of the start-up', () => {
    expect(parseServiceList(tree)).toEqual({ names: [...SERVICE_LIST], line: startupLine('variables.serviceList=') });
  });

  it('trims names and drops empty ones', () => {
    const source = memorySourceTree({ [STARTUP_PATH]: "<cfscript>\n\n\tvariables.serviceList = ' utility , pluginManager,,';\n</cfscript>\n" });
    expect(parseServiceList(source)).toEqual({ names: ['utility', 'pluginManager'], line: 3 });
  });

  it('returns null without the start-up template or without the assignment', () => {
    expect(parseServiceList(memorySourceTree({ 'core/mura/foo/fooManager.cfc': cfc() }))).toBeNull();
    expect(parseServiceList(memorySourceTree({ [STARTUP_PATH]: scanStartup() }))).toBeNull();
  });
});

describe('extractAliases', () => {
  it('records each addAlias in source order with its resolved target, component and status', () => {
    const { aliases } = extractAliases(tree);
    const adobe = startupLine('"contentGatewayAdobe"');
    const lucee = startupLine('"contentGatewayLucee");');
    const alias = (name: string, target: string, resolvedTarget: string, file: string | null, status: RegistrationStatus, line: number, condition: string | null = null) => ({
      alias: name,
      target,
      resolvedTarget,
      path: file,
      status,
      condition,
      line,
      source: at(line),
    });
    expect(aliases).toEqual([
      alias('user', 'userBean', 'userBean', 'core/mura/user/userBean.cfc', 'effective', 10),
      alias('group', 'userBean', 'userBean', 'core/mura/user/userBean.cfc', 'effective', 11),
      alias('fixture', 'fixtureBean', 'fixtureBean', 'core/mura/fixture/fixtureBean.cfc', 'overridden', 12),
      alias('contentGateway', 'contentGatewayAdobe', 'contentGatewayAdobe', 'core/mura/content/contentGatewayAdobe.cfc', 'effective', adobe, "server.coldfusion.productName eq 'Coldfusion Server'"),
      alias('contentGateway', 'contentGatewayLucee', 'contentGatewayLucee', 'core/mura/content/contentGatewayLucee.cfc', 'inactive', lucee, "!(server.coldfusion.productName eq 'Coldfusion Server')"),
      alias('eventManager', 'pluginManager', 'pluginManager', 'core/mura/plugin/pluginManager.cfc', 'effective', startupLine('"eventManager"')),
      alias('settingsBundle', 'settingsBundleBean', 'settingsBundleBean', 'core/mura/settings/settingsBundleBean.cfc', 'effective', startupLine('"settingsBundle","')),
      alias('bundle', 'settingsBundle', 'settingsBundleBean', 'core/mura/settings/settingsBundleBean.cfc', 'effective', startupLine('"bundle"')),
      alias('groupDAO', 'userDAO', 'userDAO', 'core/mura/user/userDAO.cfc', 'effective', startupLine('"groupDAO"')),
      alias('ghost', 'noSuchBean', 'noSuchBean', null, 'effective', startupLine('"ghost"')),
      alias('fixture', 'fixtureManager', 'fixtureManager', 'core/mura/fixture/fixtureManager.cfc', 'effective', startupLine('"fixture","fixtureManager"')),
    ]);
  });

  it('records declareBean and addBean registrations with component, file, singleton flag and status', () => {
    const { declaredBeans } = extractAliases(tree);
    const bean = (name: string, via: 'declareBean' | 'addBean', component: string | null, file: string | null, singleton: boolean, status: RegistrationStatus, needle: string, condition: string | null = null) => {
      const line = startupLine(needle);
      return { name, via, component, path: file, singleton, status, condition, line, source: at(line) };
    };
    expect(declaredBeans).toEqual([
      bean('configBean', 'addBean', 'mura.configBean', 'core/mura/configBean.cfc', true, 'effective', '"configBean",'),
      bean('tempDir', 'addBean', null, null, true, 'effective', '"tempDir"'),
      bean('data', 'addBean', null, null, true, 'overridden', '"data",""'),
      bean('fixtureManager', 'addBean', 'mura.fixture.fixtureManager', 'core/mura/fixture/fixtureManager.cfc', true, 'effective', 'addBean("fixtureManager"'),
      bean('unassigned', 'addBean', null, null, true, 'effective', '"unassigned"'),
      bean('beanValidator', 'declareBean', 'mura.bean.beanValidator', 'core/mura/bean/beanValidator.cfc', true, 'effective', '"beanValidator"'),
      bean('moment', 'declareBean', 'mura.moment', 'core/mura/moment.cfc', false, 'effective', 'beanName="moment"'),
      bean('missing', 'declareBean', 'mura.fixture.missingService', null, true, 'effective', '"missing"'),
      bean('fixtureContract', 'declareBean', 'mura.fixture.fixtureContract', 'core/mura/fixture/fixtureContract.cfc', true, 'effective', '"fixtureContract"'),
      bean('luceeLoader', 'declareBean', 'mura.content.contentGatewayLucee', 'core/mura/content/contentGatewayLucee.cfc', true, 'inactive', '"luceeLoader"', "!(server.coldfusion.productName eq 'Coldfusion Server')"),
      bean('data', 'addBean', null, null, true, 'effective', '"data",{}'),
    ]);
  });

  it('returns fresh arrays over one memoised start-up', () => {
    const first = extractAliases(tree);
    first.aliases.length = 0;
    first.declaredBeans.length = 0;
    const second = extractAliases(tree);
    expect(second.aliases).toHaveLength(11);
    expect(second.declaredBeans).toHaveLength(11);
    expect(second.aliases[0]).toBe(extractAliases(tree).aliases[0]);
  });

  it.each([
    ['server.coldfusion.productName == "ColdFusion Server"', 'effective'],
    ["server.coldfusion.productName eq 'COLDFUSION SERVER'", 'effective'],
    ['server.coldfusion.productName != "ColdFusion Server"', 'inactive'],
    ['server.coldfusion.productName neq "Lucee"', 'effective'],
    ['server.coldfusion.productName is "Lucee"', 'inactive'],
    ['request.muraInDocker', 'effective'],
  ] as const)('decides a call guarded by %s as the Adobe oracle runs it: %s', (condition, status) => {
    const source = memorySourceTree({
      [STARTUP_PATH]: scanStartup(
        '\tvariables.serviceFactory.containsBean("fooManager");',
        `\tif (${condition}) { variables.serviceFactory.addAlias("guarded","fooManager"); }`,
      ),
      'core/mura/foo/fooManager.cfc': cfc(),
    });
    const [entry] = extractAliases(source).aliases;
    expect(entry).toMatchObject({ alias: 'guarded', status, condition, path: 'core/mura/foo/fooManager.cfc' });
    expect(byName(extractServices(source), 'fooManager').aliases).toEqual(status === 'effective' ? ['guarded'] : []);
  });

  it('decides nested, else-if and switch branches and drops the guard the constructor shares', () => {
    const lucee = 'server.coldfusion.productName eq "Lucee"';
    const adobe = 'server.coldfusion.productName eq "ColdFusion Server"';
    const alias = (name: string): string => `variables.serviceFactory.addAlias("${name}","fooManager");`;
    const source = memorySourceTree({
      [STARTUP_PATH]: [
        '<cfscript>',
        'if (request.boot) {',
        ...scanCtor(),
        `  ${alias('plain')}`,
        `  if (${lucee}) { ${alias('first')} } else if (${adobe}) { ${alias('second')} } else { ${alias('third')} }`,
        `  if (request.x) { if (${lucee}) { ${alias('mixedFalse')} } }`,
        `  if (request.x) { if (request.y) { ${alias('undecided')} } }`,
        `  if (${adobe}) { if (server.coldfusion.productName neq "Lucee") { ${alias('bothTrue')} } }`,
        `  switch (server.coldfusion.productName) { case "Lucee": ${alias('onCase')} break; default: ${alias('onDefault')} }`,
        '}',
        '</cfscript>',
        '',
      ].join('\n'),
      'core/mura/foo/fooManager.cfc': cfc(),
    });
    const decided = extractAliases(source).aliases.map((a) => [a.alias, a.status, a.condition]);
    expect(decided).toEqual([
      ['plain', 'effective', null],
      ['first', 'inactive', lucee],
      ['second', 'effective', `!(${lucee}) && ${adobe}`],
      ['third', 'inactive', `!(${lucee}) && !(${adobe})`],
      ['mixedFalse', 'inactive', `request.x && ${lucee}`],
      ['undecided', 'effective', 'request.x && request.y'],
      ['bothTrue', 'effective', `${adobe} && server.coldfusion.productName neq "Lucee"`],
      ['onCase', 'effective', "switch(server.coldfusion.productName) case 'Lucee'"],
      ['onDefault', 'effective', "!(switch(server.coldfusion.productName) case 'Lucee')"],
    ]);
    expect(parseScanConfig(source)?.source).toEqual({ path: STARTUP_PATH, lines: [3, 8] });
  });

  it('keeps only literal names, unescapes doubled quotes and ignores calls on other objects', () => {
    const source = memorySourceTree({
      [STARTUP_PATH]: scanStartup(
        '\tvariables.serviceFactory.addAlias(aliasName="named", beanName="fooManager");',
        '\tvariables.serviceFactory.addAlias("computedTarget", variables.target);',
        '\tvariables.serviceFactory.addAlias(variables.name, "fooManager");',
        '\tvariables.serviceFactory.addAlias("say""hi", "fooManager");',
        "\tvariables.serviceFactory.addAlias('alias#suffix#', 'fooManager');",
        '\tvariables.serviceFactory.declareBean(variables.beanName, "mura.foo.fooManager");',
        '\tvariables.serviceFactory.addBean("odd(1)", "a)b");',
        '\tvariables.other=new mura.foo.fooManager();',
        '\tvariables.other.addAlias("elsewhere","fooManager");',
        '\tvariables.loader=new mura.foo.fooManager();',
        '\tvariables.loader=new mura.foo.fooLoader();',
        '\tvariables.serviceFactory.addBean("loader",variables.loader);',
        '\tvariables.serviceFactory.addBean("early",local.svc);',
        '\tlocal.svc=new mura.foo.fooManager();',
        '\tvariables.serviceFactory.addBean("spanning",',
        '\t\tnew mura.foo.fooLoader()',
        '\t);',
      ),
      'core/mura/foo/fooManager.cfc': cfc(),
      'core/mura/foo/fooLoader.cfc': cfc(),
    });
    const { aliases, declaredBeans } = extractAliases(source);
    expect(aliases.map((a) => [a.alias, a.target, a.line])).toEqual([
      ['named', 'fooManager', 8],
      ['say"hi', 'fooManager', 11],
    ]);
    expect(declaredBeans.map((d) => [d.name, d.component, d.path, d.source.lines])).toEqual([
      ['odd(1)', null, null, [14, 14]],
      ['loader', 'mura.foo.fooLoader', 'core/mura/foo/fooLoader.cfc', [19, 19]],
      ['early', null, null, [20, 20]],
      ['spanning', 'mura.foo.fooLoader', 'core/mura/foo/fooLoader.cfc', [22, 24]],
    ]);
  });
});

describe('extractServices', () => {
  it('lists every scanned or declared singleton, sorted by svc:<name> id', () => {
    expect(extractServices(tree).map((s) => s.id)).toEqual([
      'svc:beanValidator',
      'svc:configBean',
      'svc:contentGatewayAdobe',
      'svc:contentGatewayLucee',
      'svc:contentUtility',
      'svc:fixtureDAO',
      'svc:fixtureManager',
      'svc:pluginManager',
      'svc:settingsManager',
      'svc:userDAO',
      'svc:userManager',
      'svc:utility',
    ]);
  });

  it('describes a scanned service with its declaration, names, aliases and service-list membership', () => {
    expect(byName(extractServices(tree), 'userManager')).toEqual({
      id: 'svc:userManager',
      name: 'userManager',
      component: 'mura.user.userManager',
      source: { path: 'core/mura/user/userManager.cfc', lines: [1, 1] },
      registration: 'scan',
      registrationSource: SCAN_SOURCE,
      registrationCondition: null,
      qualifiedName: 'userManageruser',
      beanNames: ['userManager', 'userManageruser'],
      aliases: [],
      kind: 'manager',
      inServiceList: true,
      serviceListNames: ['userManager'],
    });
  });

  it('joins a scanned component and its later addBean into one scan+addBean entry with the alias that moved to it', () => {
    expect(byName(extractServices(tree), 'fixtureManager')).toMatchObject({
      id: 'svc:fixtureManager',
      source: { path: 'core/mura/fixture/fixtureManager.cfc', lines: [2, 2] },
      registration: 'scan+addBean',
      registrationSource: SCAN_SOURCE,
      qualifiedName: 'fixtureManagerfixture',
      beanNames: ['fixtureManager', 'fixtureManagerfixture'],
      aliases: ['fixture'],
      inServiceList: false,
      serviceListNames: [],
    });
  });

  it('keeps an excluded component that addBean registers from a variable assigned with new', () => {
    expect(byName(extractServices(tree), 'configBean')).toMatchObject({
      component: 'mura.configBean',
      source: { path: 'core/mura/configBean.cfc', lines: [1, 1] },
      registration: 'addBean',
      registrationSource: at(startupLine('"configBean",')),
      qualifiedName: null,
      beanNames: ['configBean'],
      kind: 'other',
    });
  });

  it('gives a declareBean singleton its own entry beside the transient scan of the same file', () => {
    expect(byName(extractServices(tree), 'beanValidator')).toMatchObject({
      registration: 'declareBean',
      registrationSource: at(startupLine('"beanValidator"')),
      qualifiedName: null,
      beanNames: ['beanValidator'],
    });
    expect(byName(extractTransients(tree), 'beanValidator')).toMatchObject({ registration: 'scan', qualifiedName: 'beanValidatorbean', beanNames: ['beanValidatorbean'] });
  });

  it('classifies kind by name suffix, treating the Adobe and Lucee gateways as gateways', () => {
    expect(Object.fromEntries(extractServices(tree).map((s) => [s.name, s.kind]))).toEqual({
      beanValidator: 'other',
      configBean: 'other',
      contentGatewayAdobe: 'gateway',
      contentGatewayLucee: 'gateway',
      contentUtility: 'utility',
      fixtureDAO: 'dao',
      fixtureManager: 'manager',
      pluginManager: 'manager',
      settingsManager: 'manager',
      userDAO: 'dao',
      userManager: 'manager',
      utility: 'utility',
    });
  });

  it('marks service-list membership through the names and aliases that resolve to each bean, in list order', () => {
    const listed = extractServices(tree)
      .filter((s) => s.inServiceList)
      .map((s) => [s.id, s.aliases, s.serviceListNames]);
    expect(listed).toEqual([
      ['svc:contentGatewayAdobe', ['contentGateway'], ['contentGateway']],
      ['svc:contentUtility', [], ['contentUtility']],
      ['svc:pluginManager', ['eventManager'], ['pluginManager', 'eventManager']],
      ['svc:settingsManager', [], ['settingsManager']],
      ['svc:userManager', [], ['userManager']],
      ['svc:utility', [], ['utility']],
    ]);
    expect(byName(extractServices(tree), 'contentGatewayLucee')).toMatchObject({ aliases: [], inServiceList: false, serviceListNames: [] });
    expect(byName(extractServices(tree), 'userDAO').aliases).toEqual(['groupDAO']);
  });

  it('scans every component file except excluded paths and interfaces', () => {
    const scanned = [...extractServices(tree), ...extractTransients(tree)]
      .filter((e) => e.registration.split('+').includes('scan'))
      .map((e) => e.source.path);
    const expected = [...Object.keys(INLINE), ...Object.keys(COPIED)].filter(
      (f) => f.endsWith('.cfc') && !(EXCLUDED as readonly string[]).includes(f) && !f.endsWith('Contract.cfc'),
    );
    expect(scanned.sort()).toEqual(expected.sort());
  });

  it('scans with the DI1 constants when the tree has no start-up template', () => {
    const source = memorySourceTree({ 'core/mura/foo/fooManager.cfc': cfc(), 'core/mura/foo/fooBean.cfc': cfc() });
    expect(extractAliases(source)).toEqual({ aliases: [], declaredBeans: [] });
    expect(extractServices(source)).toEqual([
      expect.objectContaining({ id: 'svc:fooManager', registration: 'scan', registrationSource: null, beanNames: ['fooManager', 'fooManagerfoo'] }),
    ]);
    expect(extractTransients(source).map((t) => t.name)).toEqual(['fooBean']);
  });

  it('accepts a constructor that omits recurse, since DI1 defaults it to true', () => {
    const ctor = scanCtor().filter((l) => !l.includes('recurse'));
    const source = memorySourceTree({ [STARTUP_PATH]: ['<cfscript>', ...ctor, '</cfscript>', ''].join('\n'), 'core/mura/foo/fooManager.cfc': cfc() });
    expect(parseScanConfig(source)?.recursive).toBe(true);
    expect(extractServices(source).map((s) => s.id)).toEqual(['svc:fooManager']);
  });

  it('defers discovery to the first running trigger, so an earlier addBean of a scanned name loses that name', () => {
    const source = memorySourceTree({
      [STARTUP_PATH]: scanStartup(
        '\tvariables.serviceFactory.addBean("fooManager",new mura.foo.fooManager());',
        '\tif (server.coldfusion.productName eq "Lucee") { variables.serviceFactory.getBean("fooManager"); }',
        '\tvariables.serviceFactory.addBean("barManager",new mura.foo.barManager());',
        '\tvariables.serviceFactory.containsBean("fooManager");',
        '\tvariables.serviceFactory.addBean("fooDAO",new mura.foo.fooDAO());',
      ),
      'core/mura/foo/fooManager.cfc': cfc(),
      'core/mura/foo/barManager.cfc': cfc(),
      'core/mura/foo/fooDAO.cfc': cfc(),
    });
    expect(extractAliases(source).declaredBeans.map((d) => [d.name, d.status])).toEqual([
      ['fooManager', 'overridden'],
      ['barManager', 'overridden'],
      ['fooDAO', 'effective'],
    ]);
    expect(extractServices(source).map((s) => [s.id, s.registration, s.beanNames])).toEqual([
      ['svc:barManager', 'scan', ['barManagerfoo']],
      ['svc:fooDAO', 'scan+addBean', ['fooDAO', 'fooDAOfoo']],
      ['svc:fooManager', 'scan', ['fooManagerfoo']],
    ]);
  });

  it('discovers after the last call when no trigger runs', () => {
    const source = memorySourceTree({
      [STARTUP_PATH]: scanStartup('\tvariables.serviceFactory.addBean("fooLoader",new mura.foo.fooLoader());'),
      'core/mura/foo/fooLoader.cfc': cfc(),
      'core/mura/foo/fooManager.cfc': cfc(),
    });
    expect(extractAliases(source).declaredBeans.map((d) => d.status)).toEqual(['overridden']);
    expect(extractServices(source).map((s) => [s.id, s.beanNames])).toEqual([
      ['svc:fooLoader', ['fooLoaderfoo']],
      ['svc:fooManager', ['fooManager', 'fooManagerfoo']],
    ]);
  });

  it('drops a plain name several components share and ids them by qualified name', () => {
    const source = memorySourceTree({
      [STARTUP_PATH]: scanStartup(),
      'core/mura/content/utility.cfc': cfc(),
      'core/mura/site/utility.cfc': cfc(),
      'core/mura/user/utility.cfc': cfc(),
    });
    expect(extractServices(source).map((s) => [s.id, s.name, s.beanNames, s.inServiceList])).toEqual([
      ['svc:utilitycontent', 'utility', ['utilitycontent'], false],
      ['svc:utilitysite', 'utility', ['utilitysite'], false],
      ['svc:utilityuser', 'utility', ['utilityuser'], false],
    ]);
    const index = indexFor(source);
    expect(index.resolveBean('utility')).toBeNull();
    expect(index.resolveBean('UtilityUser')).toBe('core/mura/user/utility.cfc');
  });

  it.each([
    ['a scan that differs from DI1_SCAN', { [STARTUP_PATH]: '<cfscript>\nvariables.serviceFactory=new mura.bean.beanFactory("/mura",{recurse=false});\n</cfscript>\n' }, `the DI1 scan at ${STARTUP_PATH}:2 differs from DI1_SCAN`],
    ['a service list that differs from SERVICE_LIST', { [STARTUP_PATH]: scanStartup('\tvariables.serviceList="utility,pluginManager";') }, `variables.serviceList at ${STARTUP_PATH}:8 differs from SERVICE_LIST`],
    ['a scanned file that is not a component', { [STARTUP_PATH]: scanStartup(), 'core/mura/broken.cfc': '<cfset x = 1>\n' }, 'DI1 cannot read component metadata of core/mura/broken.cfc'],
    ['two files with one qualified name', { 'core/mura/a/items/fooManager.cfc': cfc(), 'core/mura/b/item/fooManager.cfc': cfc() }, 'fooManageritem is not unique'],
  ] as const)('throws on %s', (_case, files, message) => {
    const source = memorySourceTree(files);
    expect(() => extractServices(source)).toThrow(message);
    expect(() => extractAliases(source)).toThrow(message);
  });
});

describe('extractTransients', () => {
  it('lists transients by folder, pattern (any case) or declaration, sorted by name', () => {
    expect(extractTransients(tree).map((t) => [t.name, t.component, t.registration, t.qualifiedName, t.beanNames, t.aliases])).toEqual([
      ['beanHelper', 'mura.bean.beanHelper', 'scan', 'beanHelperbean', ['beanHelper', 'beanHelperbean'], []],
      ['beanValidator', 'mura.bean.beanValidator', 'scan', 'beanValidatorbean', ['beanValidatorbean'], []],
      ['fixtureBean', 'mura.fixture.fixtureBean', 'scan', 'fixtureBeanfixture', ['fixtureBean', 'fixtureBeanfixture'], []],
      ['fixtureHelper', 'mura.fixture.beans.fixtureHelper', 'scan', 'fixtureHelperbean', ['fixtureHelper', 'fixtureHelperbean'], []],
      ['fixtureIterator', 'mura.fixture.fixtureIterator', 'scan', 'fixtureIteratorfixture', ['fixtureIterator', 'fixtureIteratorfixture'], []],
      ['fixtureevent', 'mura.fixture.fixtureevent', 'scan', 'fixtureeventfixture', ['fixtureevent', 'fixtureeventfixture'], []],
      ['moment', 'mura.moment', 'declareBean', null, ['moment'], []],
      ['settingsBundleBean', 'mura.settings.settingsBundleBean', 'scan', 'settingsBundleBeansetting', ['settingsBundleBean', 'settingsBundleBeansetting'], ['bundle', 'settingsBundle']],
      ['userBean', 'mura.user.userBean', 'scan', 'userBeanuser', ['userBean', 'userBeanuser'], ['group', 'user']],
    ]);
  });

  it('reads the declaration span after a byte-order mark and sorts same-named transients by path', () => {
    expect(byName(extractTransients(tree), 'fixtureBean').source).toEqual({ path: 'core/mura/fixture/fixtureBean.cfc', lines: [1, 1] });
    const source = memorySourceTree({ 'core/mura/user/addressBean.cfc': cfc(), 'core/mura/site/addressBean.cfc': cfc() });
    expect(extractTransients(source).map((t) => t.source.path)).toEqual(['core/mura/site/addressBean.cfc', 'core/mura/user/addressBean.cfc']);
  });
});

describe('buildComponentIndex', () => {
  it('resolves aliases, then bean names, then components and paths, ignoring case', () => {
    const index = indexFor(tree);
    const resolved = Object.fromEntries(
      ['bundle', 'BUNDLE', 'contentGateway', 'fixture', 'eventManager', 'fixtureDAO', 'fixtureDAOfixture', 'MURA.FIXTURE.FIXTUREDAO', 'core/mura/fixture/fixtureDAO.cfc', 'fixtureIterator', 'moment', 'configBean'].map((n) => [n, index.resolveBean(n)]),
    );
    expect(resolved).toEqual({
      bundle: 'core/mura/settings/settingsBundleBean.cfc',
      BUNDLE: 'core/mura/settings/settingsBundleBean.cfc',
      contentGateway: 'core/mura/content/contentGatewayAdobe.cfc',
      fixture: 'core/mura/fixture/fixtureManager.cfc',
      eventManager: 'core/mura/plugin/pluginManager.cfc',
      fixtureDAO: 'core/mura/fixture/fixtureDAO.cfc',
      fixtureDAOfixture: 'core/mura/fixture/fixtureDAO.cfc',
      'MURA.FIXTURE.FIXTUREDAO': 'core/mura/fixture/fixtureDAO.cfc',
      'core/mura/fixture/fixtureDAO.cfc': 'core/mura/fixture/fixtureDAO.cfc',
      fixtureIterator: 'core/mura/fixture/fixtureIterator.cfc',
      moment: 'core/mura/moment.cfc',
      configBean: 'core/mura/configBean.cfc',
    });
  });

  it('returns null for an unknown name, an alias of an unknown bean and a declared bean without a file', () => {
    const index = indexFor(tree);
    expect(index.resolveBean('noSuchBean')).toBeNull();
    expect(index.resolveBean('ghost')).toBeNull();
    expect(index.resolveBean('missing')).toBeNull();
  });

  it('uses only effective aliases and the transients it is given', () => {
    const { aliases, declaredBeans } = extractAliases(tree);
    const index = indexFor(tree, { aliases: { aliases: aliases.filter((a) => a.status !== 'effective'), declaredBeans }, transients: [] });
    expect(index.resolveBean('contentGateway')).toBeNull();
    expect(index.resolveBean('fixture')).toBeNull();
    expect(index.resolveBean('fixtureIterator')).toBeNull();
    expect(index.resolveBean('fixtureManager')).toBe('core/mura/fixture/fixtureManager.cfc');
  });

  it('maps ORM components to their tables and parses components once', () => {
    const index = indexFor(tree);
    expect(index.ormTable('core/mura/fixture/fixtureBean.cfc')).toBe('tfixture');
    expect(index.ormTable('core/mura/fixture/fixtureDAO.cfc')).toBeNull();
    const parsed = index.parsed('core/mura/user/userManager.cfc');
    expect(parsed).toEqual(parseCfmlComponent('core/mura/user/userManager.cfc', INLINE['core/mura/user/userManager.cfc'] ?? ''));
    expect(parsed?.functions.map((f) => f.name)).toEqual(['read']);
    expect(index.parsed('core/mura/user/userManager.cfc')).toBe(parsed);
    expect(indexFor(tree).parsed('core/mura/user/userManager.cfc')).toBe(parsed);
    expect(index.parsed('core/mura/fixture/page.cfm')).toBeNull();
    expect(index.parsed('core/mura/fixture/absent.cfc')).toBeNull();
    expect(index.parsed('core/mura/fixture/fixtureContract.cfc')).toBeNull();
  });
});
