// DI1 bean registry of the legacy start-up: the emulated `/mura` directory scan, aliases, declared beans and the ComponentIndex.
import path from 'node:path';
import {
  describeCondition,
  extractCalls,
  lineOf,
  parseCfmTemplate,
  parseCfmlComponent,
  resolveComponentPath,
  stripComments,
  type CallArgument,
  type CallSite,
  type CfmlComponent,
  type CfmlTemplate,
  type ComponentIndex,
  type GuardCondition,
  type SourceTree,
} from './closure.js';
import type { OrmEntityIndex } from './entities.js';

/** Archive path of the start-up template that builds the service factory. */
export const STARTUP_PATH = 'core/appcfc/onApplicationStart_include.cfm';

/** Archive path of `mura.bean.beanFactory`. */
const FACTORY_PATH = 'core/mura/bean/beanFactory.cfc';
const FACTORY_COMPONENT = 'mura.bean.beanfactory';

/** The scan `new mura.bean.beanFactory("/mura", {…})` performs [onApplicationStart_include.cfm:229-234]. */
export const DI1_SCAN = {
  mapping: '/mura',
  root: 'core/mura',
  recursive: true,
  exclude: [
    '/.',
    '/mura/autoUpdater/global',
    '/mura/configBean.cfc',
    '/mura/bean/beanFactory.cfc',
    '/mura/cache/provider',
    '/mura/moment.cfc',
    '/mura/client/oath',
    '/mura/client/api/json/v1/apiUtility.cfc',
    '/mura/client/api/feed/v1/apiUtility.cfc',
  ],
  // DI1 matches with refindNoCase (ioc.cfc:360), hence the `i` flag.
  transientPattern: /(Iterator|Bean|executor|MuraScope|Event|dbUtility|extendObject)$/i,
} as const;

/** Patterns DI1 appends to every exclude list [ioc.cfc:50-59]. */
export const DI1_AUTO_EXCLUDE = [
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
] as const;

/** The application-scope services instantiated at start-up, in order [onApplicationStart_include.cfm:495]. */
export const SERVICE_LIST = [
  'utility',
  'pluginManager',
  'settingsManager',
  'fileManager',
  'contentManager',
  'eventManager',
  'contentRenderer',
  'contentUtility',
  'contentGateway',
  'categoryManager',
  'clusterManager',
  'contentServer',
  'changesetManager',
  'scriptProtectionFilter',
  'permUtility',
  'emailManager',
  'loginManager',
  'mailinglistManager',
  'userManager',
  'dataCollectionManager',
  'feedManager',
  'sessionTrackingManager',
  'favoriteManager',
  'raterManager',
  'dashboardManager',
  'autoUpdater',
] as const;

/** Repository-relative file and 1-based inclusive line span. */
export interface ServiceSource {
  path: string;
  lines: [number, number];
}

/** How a bean entered the factory. */
export type RegistrationKind = 'scan' | 'declareBean' | 'addBean';

/** Inventory kind of a service, from its bean-name suffix. */
export type ServiceKind = 'manager' | 'dao' | 'gateway' | 'utility' | 'other';

/** Whether a start-up registration holds its name at the end of start-up, was replaced, or never runs on the oracle. */
export type RegistrationStatus = 'effective' | 'overridden' | 'inactive';

/** The scan arguments as written in the start-up template. */
export interface ScanConfig {
  mapping: string;
  recursive: boolean;
  exclude: string[];
  transientPattern: string;
  source: ServiceSource;
}

/** One `addAlias(alias, target)` call of the start-up template. */
export interface AliasEntry {
  alias: string;
  target: string;
  /** Bean name the alias chain lands on when the call runs (`bundle` → `settingsBundleBean`). */
  resolvedTarget: string;
  /** Component the alias addresses when the call runs; null for an unknown target or a non-component value. */
  path: string | null;
  status: RegistrationStatus;
  /** Branch condition beyond the factory's own; null when unconditional. */
  condition: string | null;
  line: number;
  source: ServiceSource;
}

/** One `declareBean(name, dottedPath, singleton)` or `addBean(name, value)` call of the start-up template. */
export interface DeclaredBean {
  name: string;
  via: 'declareBean' | 'addBean';
  /** Dotted component as written; null when an added value is not a component. */
  component: string | null;
  /** Component file; null when the value is not a component or the tree lacks the file. */
  path: string | null;
  singleton: boolean;
  status: RegistrationStatus;
  condition: string | null;
  line: number;
  source: ServiceSource;
}

/** Result of {@link extractAliases}. */
export interface AliasExtraction {
  aliases: AliasEntry[];
  declaredBeans: DeclaredBean[];
}

/** A component the factory resolves at the end of start-up. */
export interface BeanEntry {
  /** Bean name: the file name for a scanned component, the declared name otherwise. */
  name: string;
  /** Dotted component name (`mura.user.userDAO`). */
  component: string;
  source: ServiceSource;
  /** Registration kinds in start-up order, joined with `+` (`scan+addBean`). */
  registration: string;
  /** Start-up call that registered it first; null when the tree has no such call. */
  registrationSource: ServiceSource | null;
  registrationCondition: string | null;
  /** DI1's folder-qualified name `<name><singular folder>`; null for declared and added beans. */
  qualifiedName: string | null;
  /** Non-alias names that resolve to it, sorted. */
  beanNames: string[];
  /** Alias names that resolve to it, sorted. */
  aliases: string[];
}

/** A singleton bean; owners and dispositions are added by `generate.ts`. */
export interface ServiceEntry extends BeanEntry {
  id: string;
  kind: ServiceKind;
  inServiceList: boolean;
  /** {@link SERVICE_LIST} names that resolve to it, in list order. */
  serviceListNames: string[];
}

/** A transient bean, kept for the component index only. */
export type TransientEntry = BeanEntry;

/** Inputs of {@link buildComponentIndex}; `transients` defaults to {@link extractTransients} of `tree`. */
export interface ComponentIndexInputs {
  services: readonly ServiceEntry[];
  transients?: readonly TransientEntry[];
  aliases: AliasExtraction;
  ormIndex: OrmEntityIndex;
  tree: SourceTree;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function lower(name: string): string {
  return name.trim().toLowerCase();
}

const parsedCache = new WeakMap<SourceTree, Map<string, CfmlComponent | null>>();

/** Memoised `parseCfmlComponent` of a `.cfc` in `tree`; null when absent or not a component. */
function parsedIn(tree: SourceTree, file: string): CfmlComponent | null {
  let cache = parsedCache.get(tree);
  if (cache === undefined) {
    cache = new Map();
    parsedCache.set(tree, cache);
  }
  if (!cache.has(file)) {
    const comp = file.toLowerCase().endsWith('.cfc') && tree.exists(file) ? parseCfmlComponent(file, tree.readText(file)) : null;
    cache.set(file, comp);
  }
  return cache.get(file) ?? null;
}

function startupTemplate(tree: SourceTree): CfmlTemplate | null {
  return tree.exists(STARTUP_PATH) ? parseCfmTemplate(STARTUP_PATH, tree.readText(STARTUP_PATH)) : null;
}

/** A call on the start-up factory, with its span in the template. */
interface FactoryCall {
  site: CallSite;
  method: string;
  source: ServiceSource;
}

/** Line of the `)` closing the first `(` at or after `offset`; string literals are skipped. */
function closingLine(text: string, offset: number, bodyLine: number): number {
  const at = (i: number): number => lineOf(text, i) + bodyLine - 1;
  let depth = 0;
  for (let i = text.indexOf('(', offset); i >= 0 && i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) break;
      i = end;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' && --depth === 0) {
      return at(i);
    }
  }
  return at(offset);
}

/** Whether a call addresses `mura.bean.beanFactory`, resolved to its file or, when the tree lacks it, by dotted name. */
function onFactory(site: CallSite): boolean {
  const { component, bean } = site.target;
  return component === FACTORY_PATH || [component, bean].some((v) => v !== undefined && v.toLowerCase() === FACTORY_COMPONENT);
}

/** Calls on the start-up factory, in source order. */
function factoryCalls(tree: SourceTree, unit: CfmlTemplate): FactoryCall[] {
  const fn = unit.functions[0];
  if (fn === undefined) return [];
  const index: ComponentIndex = { resolveBean: () => null, ormTable: () => null, parsed: (p) => parsedIn(tree, p) };
  return extractCalls(fn, unit, { tree, index })
    .filter(onFactory)
    .sort((a, b) => a.offset - b.offset)
    .map((site) => ({
      site,
      method: site.target.method.toLowerCase(),
      source: { path: STARTUP_PATH, lines: [site.line, closingLine(fn.body, site.offset, fn.bodyLine)] },
    }));
}

function isConstructor(call: FactoryCall): boolean {
  return call.method === 'init' && /^new\s/i.test(call.site.text);
}

/** Expression of the argument named `name`, else of the `index`-th positional argument. */
function argExpr(args: readonly CallArgument[], index: number, name: string): string | undefined {
  const named = args.find((a) => a.name !== undefined && a.name.toLowerCase() === name.toLowerCase());
  return (named ?? args.filter((a) => a.name === undefined)[index])?.expr;
}

/** Value of a quoted CFML string literal without interpolation; null for any other expression. */
function stringLiteral(expr: string | undefined): string | null {
  const m = expr === undefined ? null : /^(["'])([\s\S]*)\1$/.exec(expr.trim());
  if (m === null) return null;
  const [, quote = '"', inner = ''] = m;
  if (inner.split(quote + quote).join('').includes(quote) || inner.includes('#')) return null;
  return inner.split(quote + quote).join(quote);
}

function guardTerms(c: GuardCondition | undefined): GuardCondition[] {
  if (c === undefined) return [];
  return c.k === 'and' ? c.of.flatMap(guardTerms) : [c];
}

/** The guard terms of `site` the factory constructor does not share, as source text. */
function ownCondition(site: CallSite, baseline: ReadonlySet<string>): string | null {
  const own = guardTerms(site.guard).filter((t) => !baseline.has(describeCondition(t)));
  if (own.length === 0) return null;
  return own.length === 1 && own[0] !== undefined ? describeCondition(own[0]) : describeCondition({ k: 'and', of: own });
}

// The oracle runs Adobe ColdFusion 2023, whose server.coldfusion.productName is "ColdFusion Server". Start-up picks
// contentGatewayAdobe or contentGatewayLucee on that value [onApplicationStart_include.cfm:249-253], so a branch
// comparing it is decided as the oracle decides it; every other condition is left undecided and treated as running.
const ORACLE_PRODUCT_NAME = 'coldfusion server';
const PRODUCT_NAME_TEST = /^server\.coldfusion\.productname\s*(==|!=|\beq\b|\bneq\b|\bis\b)\s*(["'])([^"']*)\2$/i;

/** Truth of a guard on the oracle engine; null when the guard does not depend on the engine alone. */
function onOracle(c: GuardCondition): boolean | null {
  switch (c.k) {
    case 'expr': {
      const m = PRODUCT_NAME_TEST.exec(c.text.trim());
      if (m === null) return null;
      const equal = (m[3] ?? '').toLowerCase() === ORACLE_PRODUCT_NAME;
      return /^(!=|neq)$/i.test(m[1] ?? '') ? !equal : equal;
    }
    case 'not': {
      const v = onOracle(c.of);
      return v === null ? null : !v;
    }
    case 'and': {
      const vs = c.of.map(onOracle);
      return vs.includes(false) ? false : vs.every((v) => v === true) ? true : null;
    }
    case 'or': {
      const vs = c.of.map(onOracle);
      return vs.includes(true) ? true : vs.every((v) => v === false) ? false : null;
    }
    case 'case':
      return null;
  }
}

const SCAN_RECURSE = /\brecurse\s*[=:]\s*(true|false)\b/i;
const SCAN_EXCLUDE = /\bexclude\s*[=:]\s*\[([^\]]*)\]/i;
const SCAN_TRANSIENT = /\btransientPattern\s*[=:]\s*(["'])((?:(?!\1)[\s\S])*)\1/i;
const QUOTED = /"([^"]*)"|'([^']*)'/g;

function scanConfigOf(call: FactoryCall): ScanConfig {
  const args = call.site.args;
  const options = argExpr(args, 1, 'config') ?? '';
  const excludeList = SCAN_EXCLUDE.exec(options)?.[1] ?? '';
  return {
    mapping: stringLiteral(argExpr(args, 0, 'folders')) ?? '',
    // DI1 defaults recurse to true [ioc.cfc:954].
    recursive: (SCAN_RECURSE.exec(options)?.[1] ?? 'true').toLowerCase() === 'true',
    exclude: [...excludeList.matchAll(QUOTED)].map((m) => m[1] ?? m[2] ?? ''),
    transientPattern: SCAN_TRANSIENT.exec(options)?.[2] ?? '',
    source: call.source,
  };
}

/** The scan arguments of the start-up factory constructor; null when the tree has no such call. */
export function parseScanConfig(tree: SourceTree): ScanConfig | null {
  const unit = startupTemplate(tree);
  const ctor = unit === null ? undefined : factoryCalls(tree, unit).find(isConstructor);
  return ctor === undefined ? null : scanConfigOf(ctor);
}

const SERVICE_LIST_ASSIGNMENT = /\bvariables\.serviceList\s*=\s*(["'])([^"']*)\1/i;

function serviceListOf(unit: CfmlTemplate): { names: string[]; line: number } | null {
  const m = SERVICE_LIST_ASSIGNMENT.exec(unit.text);
  if (m === null) return null;
  const names = (m[2] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return { names, line: lineOf(unit.text, m.index) };
}

/** The `variables.serviceList` names of the start-up template; null when it assigns none. */
export function parseServiceList(tree: SourceTree): { names: string[]; line: number } | null {
  const unit = startupTemplate(tree);
  return unit === null ? null : serviceListOf(unit);
}

/** One `beanInfo` value: a scanned, declared or added bean, shared by every name that holds it. */
interface Registration {
  seq: number;
  name: string;
  via: RegistrationKind | 'constant';
  path: string | null;
  component: string | null;
  singleton: boolean;
  qualifiedName: string | null;
  site: ServiceSource | null;
  condition: string | null;
}

/** One `beanInfo` key; `resolvedTarget` is set for alias keys. */
interface Slot {
  key: string;
  reg: Registration | null;
  alias: boolean;
  resolvedTarget: string;
}

/** Final factory state after the emulated start-up. */
interface Startup {
  registry: Map<string, Slot>;
  aliases: AliasEntry[];
  declaredBeans: DeclaredBean[];
}

const DISCOVERY_TRIGGERS = new Set(['addalias', 'getbean', 'containsbean', 'issingleton', 'getbeaninfo', 'load']);

function sameScan(found: ScanConfig): boolean {
  return (
    found.mapping === DI1_SCAN.mapping &&
    found.recursive === DI1_SCAN.recursive &&
    found.transientPattern === DI1_SCAN.transientPattern.source &&
    found.exclude.join('\n') === DI1_SCAN.exclude.join('\n')
  );
}

/** Whether DI1 skips `file`: a case-insensitive substring test of every pattern against its path [ioc.cfc:543-548]. */
function excluded(file: string, patterns: readonly string[]): boolean {
  // DI1 tests the absolute path; the part above the repository root is environment-specific and is left out.
  const probe = `/${file}`.toLowerCase();
  return patterns.some((p) => probe.includes(p.toLowerCase()));
}

/** DI1 `singular()` with no `singulars` map and `liberal` off: one trailing `s` dropped [ioc.cfc:1010-1025]. */
function singular(dir: string): string {
  return /s$/i.test(dir) ? dir.slice(0, -1) : dir;
}

function isInterface(source: string): boolean {
  const text = stripComments(source);
  return /<cfinterface\b/i.test(text) || /(?:^|\n)\s*interface\b/.test(text);
}

const NEW_COMPONENT = /^new\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/i;
const SCOPED_VARIABLE = /^(?:application|variables|local)\.[A-Za-z_$][\w$]*$/i;

/** Dotted component an `addBean` value constructs: `new x.y()`, or a scoped variable last assigned `new x.y()` before it. */
function constructedComponent(expr: string, text: string, before: number): string | null {
  const value = expr.trim();
  const direct = NEW_COMPONENT.exec(value);
  if (direct !== null) return direct[1] ?? null;
  if (!SCOPED_VARIABLE.test(value)) return null;
  const escaped = value.replace(/[.$]/g, (c) => `\\${c}`);
  const assigned = new RegExp(`(?:^|[^\\w$.])${escaped}\\s*=\\s*new\\s+([A-Za-z_$][\\w$.]*)\\s*\\(`, 'gi');
  let found: string | null = null;
  for (const m of text.slice(0, before).matchAll(assigned)) found = m[1] ?? null;
  return found;
}

function dottedOfScanned(file: string): string {
  return [DI1_SCAN.mapping.slice(1), ...file.slice(DI1_SCAN.root.length + 1, -'.cfc'.length).split('/')].join('.');
}

const startupCache = new WeakMap<SourceTree, Startup>();

/**
 * Replays the factory set-up of the start-up template over `tree`, following DI1 (`core/mura/bean/ioc.cfc`):
 * the `beanFactory` constant and auto-excludes (50-59, 953-1001); `addBean` (79-84) and `declareBean` (166-185) as
 * they come; discovery on the first `addAlias`/`getBean`-family call (72, 89, 200, 221, 279, 320, 512-526); the
 * folder scan of discoverBeansInFolder (529-595) with interfaces skipped, duplicate plain names dropped and the
 * folder-qualified name always registered; transience from beanIsTransient (354-361); `addAlias` copying the target's
 * registration as it stands (71-75). The scan arguments and the service list must equal {@link DI1_SCAN} and
 * {@link SERVICE_LIST} where the template states them; a tree without them uses the constants.
 */
function emulateStartup(tree: SourceTree): Startup {
  const cached = startupCache.get(tree);
  if (cached !== undefined) return cached;

  const unit = startupTemplate(tree);
  const calls = unit === null ? [] : factoryCalls(tree, unit);
  const ctor = calls.find(isConstructor);
  if (ctor !== undefined && !sameScan(scanConfigOf(ctor))) {
    throw new Error(`the DI1 scan at ${STARTUP_PATH}:${ctor.site.line} differs from DI1_SCAN`);
  }
  const listed = unit === null ? null : serviceListOf(unit);
  if (listed !== null && listed.names.join(',') !== SERVICE_LIST.join(',')) {
    throw new Error(`variables.serviceList at ${STARTUP_PATH}:${listed.line} differs from SERVICE_LIST`);
  }
  const baseline = new Set(guardTerms(ctor?.site.guard).map(describeCondition));
  const body = unit?.functions[0]?.body ?? '';

  const registry = new Map<string, Slot>();
  let seq = 0;
  const register = (fields: Omit<Registration, 'seq'>): Registration => ({ seq: seq++, ...fields });
  const setName = (key: string, reg: Registration | null): Slot => {
    const slot: Slot = { key, reg, alias: false, resolvedTarget: key };
    registry.set(lower(key), slot);
    return slot;
  };
  setName('beanFactory', register({ name: 'beanFactory', via: 'constant', path: null, component: null, singleton: true, qualifiedName: null, site: null, condition: null }));

  const discover = (): void => {
    const patterns = [...DI1_SCAN.exclude, ...DI1_AUTO_EXCLUDE];
    const duplicates = new Set<string>();
    for (const file of tree.list(DI1_SCAN.root, { ext: ['cfc'], recursive: DI1_SCAN.recursive })) {
      if (excluded(file, patterns)) continue;
      if (parsedIn(tree, file) === null) {
        if (isInterface(tree.readText(file))) continue;
        throw new Error(`DI1 cannot read component metadata of ${file}`);
      }
      const name = path.posix.basename(file).slice(0, -'.cfc'.length);
      const singleDir = singular(path.posix.basename(path.posix.dirname(file)));
      const transient = singleDir.toLowerCase() === 'bean' || DI1_SCAN.transientPattern.test(name);
      const qualifiedName = name + singleDir;
      const reg = register({ name, via: 'scan', path: file, component: dottedOfScanned(file), singleton: !transient, qualifiedName, site: ctor?.source ?? null, condition: null });
      // A plain name two registrations claim is dropped for good; the qualified name always registers.
      const key = lower(name);
      if (!duplicates.has(key)) {
        if (registry.has(key)) {
          registry.delete(key);
          duplicates.add(key);
        } else {
          setName(name, reg);
        }
      }
      if (registry.has(lower(qualifiedName))) throw new Error(`${qualifiedName} is not unique`);
      setName(qualifiedName, reg);
    }
  };

  const aliases: Array<{ entry: AliasEntry; slot: Slot | null }> = [];
  const declared: Array<{ entry: DeclaredBean; slot: Slot | null }> = [];
  let discovered = false;
  for (const call of calls) {
    if (call === ctor) continue;
    const runs = call.site.guard === undefined || onOracle(call.site.guard) !== false;
    if (runs && !discovered && DISCOVERY_TRIGGERS.has(call.method)) {
      discover();
      discovered = true;
    }
    if (call.method !== 'addalias' && call.method !== 'addbean' && call.method !== 'declarebean') continue;
    const args = call.site.args;
    const name = stringLiteral(argExpr(args, 0, call.method === 'addalias' ? 'aliasName' : 'beanName'));
    if (name === null) continue;
    const status: RegistrationStatus = runs ? 'effective' : 'inactive';
    const common = { status, condition: ownCondition(call.site, baseline), line: call.site.line, source: call.source };

    if (call.method === 'addalias') {
      const target = stringLiteral(argExpr(args, 1, 'beanName'));
      if (target === null) continue;
      const held = registry.get(lower(target));
      const resolvedTarget = held?.resolvedTarget ?? target;
      let slot: Slot | null = null;
      if (runs) {
        slot = { key: name, reg: held?.reg ?? null, alias: true, resolvedTarget };
        registry.set(lower(name), slot);
      }
      aliases.push({ entry: { alias: name, target, resolvedTarget, path: held?.reg?.path ?? null, ...common }, slot });
      continue;
    }

    let component: string | null;
    let singleton = true;
    if (call.method === 'declarebean') {
      component = stringLiteral(argExpr(args, 1, 'dottedPath'));
      if (component === null) continue;
      singleton = !/^["']?(false|no|0)["']?$/i.test((argExpr(args, 2, 'isSingleton') ?? 'true').trim());
    } else {
      component = constructedComponent(argExpr(args, 1, 'beanValue') ?? '', body, call.site.offset);
    }
    // Both forms reach `mura.*` through the /mura mapping; declareBean expands from the web root [ioc.cfc:173-176].
    const file = component === null ? null : resolveComponentPath(component, 'Application.cfc', tree);
    const via = call.method === 'declarebean' ? 'declareBean' : 'addBean';
    let slot: Slot | null = null;
    if (runs) {
      const reg = register({ name, via, path: file, component, singleton, qualifiedName: null, site: call.source, condition: common.condition });
      slot = setName(name, reg);
    }
    declared.push({ entry: { name, via, component, path: file, singleton, ...common }, slot });
  }
  if (!discovered) discover();

  const settle = <T extends { status: RegistrationStatus }>(e: T, slot: Slot | null): T =>
    slot !== null && registry.get(lower(slot.key)) !== slot ? { ...e, status: 'overridden' } : e;
  const startup: Startup = {
    registry,
    aliases: aliases.map(({ entry, slot }) => settle(entry, slot)),
    declaredBeans: declared.map(({ entry, slot }) => settle(entry, slot)),
  };
  startupCache.set(tree, startup);
  return startup;
}

function kindOf(name: string): ServiceKind {
  // contentGatewayAdobe and contentGatewayLucee are the engine variants of one gateway [onApplicationStart_include.cfm:249-253].
  const base = name.replace(/(Adobe|Lucee)$/, '');
  if (base.endsWith('Manager')) return 'manager';
  if (base.endsWith('DAO')) return 'dao';
  if (base.endsWith('Gateway')) return 'gateway';
  if (/(Utility|utility)$/.test(base)) return 'utility';
  return 'other';
}

interface Beans {
  services: ServiceEntry[];
  transients: TransientEntry[];
}

const beansCache = new WeakMap<SourceTree, Beans>();

/** Components reachable through the final registry; registrations of one name and file share an entry (`scan+addBean`). */
function beansOf(tree: SourceTree): Beans {
  const cached = beansCache.get(tree);
  if (cached !== undefined) return cached;
  const { registry } = emulateStartup(tree);

  const holders = new Map<Registration, { names: string[]; aliases: string[] }>();
  for (const slot of registry.values()) {
    if (slot.reg === null || slot.reg.path === null) continue;
    const held = holders.get(slot.reg) ?? { names: [], aliases: [] };
    (slot.alias ? held.aliases : held.names).push(slot.key);
    holders.set(slot.reg, held);
  }
  const groups = new Map<string, { regs: Registration[]; names: string[]; aliases: string[] }>();
  for (const [reg, held] of holders) {
    const key = `${lower(reg.path ?? '')}\n${lower(reg.name)}\n${reg.singleton}`;
    const group = groups.get(key) ?? { regs: [], names: [], aliases: [] };
    group.regs.push(reg);
    group.names.push(...held.names);
    group.aliases.push(...held.aliases);
    groups.set(key, group);
  }

  const byReg = new Map<Registration, BeanEntry>();
  const singletonOf = new Map<BeanEntry, boolean>();
  for (const group of groups.values()) {
    const regs = group.regs.sort((a, b) => a.seq - b.seq);
    const first = regs[0];
    if (first === undefined || first.path === null || first.component === null) continue;
    const comp = parsedIn(tree, first.path);
    if (comp === null) continue;
    const entry: BeanEntry = {
      name: first.name,
      component: first.component,
      source: { path: first.path, lines: [comp.declaration.line, comp.declaration.endLine] },
      registration: [...new Set(regs.map((r) => r.via))].join('+'),
      registrationSource: first.site,
      registrationCondition: first.condition,
      qualifiedName: regs.find((r) => r.qualifiedName !== null)?.qualifiedName ?? null,
      beanNames: [...group.names].sort(compareText),
      aliases: [...group.aliases].sort(compareText),
    };
    singletonOf.set(entry, first.singleton);
    for (const reg of regs) byReg.set(reg, entry);
  }
  const entries = [...singletonOf.keys()];

  const listed = new Map<BeanEntry, string[]>();
  for (const name of SERVICE_LIST) {
    const reg = registry.get(lower(name))?.reg;
    const entry = reg ? byReg.get(reg) : undefined;
    if (entry !== undefined) listed.set(entry, [...(listed.get(entry) ?? []), name]);
  }
  const singletons = entries.filter((e) => singletonOf.get(e) === true);
  const nameCounts = new Map<string, number>();
  for (const e of singletons) nameCounts.set(lower(e.name), (nameCounts.get(lower(e.name)) ?? 0) + 1);

  const services = singletons
    .map((e): ServiceEntry => {
      // A plain name shared by several components is not registered (ioc.cfc:572-575); the qualified name keeps ids unique.
      const idName = (nameCounts.get(lower(e.name)) ?? 0) > 1 ? (e.qualifiedName ?? e.name) : e.name;
      const serviceListNames = listed.get(e) ?? [];
      return { id: `svc:${idName}`, ...e, kind: kindOf(e.name), inServiceList: serviceListNames.length > 0, serviceListNames };
    })
    .sort((a, b) => compareText(a.id, b.id));
  const transients = entries
    .filter((e) => singletonOf.get(e) === false)
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.source.path, b.source.path));
  const beans = { services, transients };
  beansCache.set(tree, beans);
  return beans;
}

/** The start-up `addAlias` calls and the `declareBean`/`addBean` registrations, in source order. */
export function extractAliases(tree: SourceTree): AliasExtraction {
  const { aliases, declaredBeans } = emulateStartup(tree);
  return { aliases: [...aliases], declaredBeans: [...declaredBeans] };
}

/** Every singleton bean the factory resolves after start-up, scanned or declared, sorted by id. */
export function extractServices(tree: SourceTree): ServiceEntry[] {
  return [...beansOf(tree).services];
}

/** Every transient bean the factory resolves after start-up, sorted by name. */
export function extractTransients(tree: SourceTree): TransientEntry[] {
  return [...beansOf(tree).transients];
}

/** The closure walk's `ComponentIndex`: bean lookup by alias, then bean name, then component, all case-insensitive. */
export function buildComponentIndex(inputs: ComponentIndexInputs): ComponentIndex {
  const { tree, ormIndex } = inputs;
  const transients = inputs.transients ?? extractTransients(tree);
  const byAlias = new Map<string, string | null>();
  for (const a of inputs.aliases.aliases) if (a.status === 'effective') byAlias.set(lower(a.alias), a.path);
  const byName = new Map<string, string>();
  const byComponent = new Map<string, string>();
  for (const e of [...inputs.services, ...transients]) {
    for (const n of e.beanNames) byName.set(lower(n), e.source.path);
    byComponent.set(lower(e.component), e.source.path);
    byComponent.set(lower(e.source.path), e.source.path);
  }
  return {
    resolveBean(name) {
      const key = lower(name);
      if (byAlias.has(key)) return byAlias.get(key) ?? null;
      return byName.get(key) ?? byComponent.get(key) ?? null;
    },
    ormTable: (p) => ormIndex.byComponent.get(p) ?? null,
    parsed: (p) => parsedIn(tree, p),
  };
}
