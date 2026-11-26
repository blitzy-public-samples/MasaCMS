// Legacy inventory routes[]: handleAPIRequest families, JSON API entries, OAuth endpoints, SOAP v1 and fixture routes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTENTNAV_ENTITY,
  GENERIC_METHODS,
  PUBLIC_METHODS,
  REGISTERED_ENTITIES,
  VARIATION_ENTITY,
  type RouteEntryPoint,
  type RouteFamily,
  type RouteKeyOptions,
  type VariantCondition,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import {
  CFML_TRUTHY,
  computeClosure,
  lineOf,
  memorySourceTree,
  parseCfmlComponent,
  resolveComponentPath,
  sqlColumns,
  stripComments,
  viaLabel,
  type CfmlComponent,
  type CfmlFunction,
  type ClosureContext,
  type ClosureThread,
  type ClosureWrite,
  type ComponentIndex,
  type ConditionalWrite,
  type FileStoreEvidence,
  type Predicates,
  type SourceTree,
  type UnresolvedRef,
  type WriteClosure,
} from './closure.js';
import { inventoryRouteKey, loadInventoryVariants, normaliseInventoryKey, variantsFor } from './route-keys.js';
import { STARTUP_PATH } from './services.js';

/** Repository root: this module sits at harness/src/inventory/. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/** Repository-relative file and inclusive 1-based line span. */
export type SourceRef = ClosureWrite['source'];

/** Session effect of an entry point, as the closure reports it. */
export type SessionEffects = WriteClosure['sessionEffects'];

/** Reviewed writer overrides and settled calls the closure walk applies. */
export type WriterOverrides = NonNullable<ClosureContext['overrides']>;

/** Inventory classification of a `routes[]` entry. */
export type RouteKind = 'api-family' | 'api-entity-method' | 'api-method' | 'oauth' | 'fixture' | 'job' | 'static' | 'soap';

/** Whether the branch's writes are checked against a CSRF token, as the gateway's claim protocol reads it. */
export type CsrfValidation = 'validates' | 'bypassed' | 'none';

/** CFML runtime dependence that makes the disposition rule keep an entry legacy-served. */
export type RuntimeCategory = 'bean-metadata';

/** Where an entry's write facts come from: its own closure, its per-method entries, the job's steps, or nowhere. */
export type WriteFacts = 'closure' | 'per-method' | 'scheduled-jobs' | 'none';

/** A variant declaration an entry stands for. */
export interface RoutePredicate {
  variant: string;
  when: VariantCondition[];
}

/** A stored procedure a fixture branch executes; its writes live in the fixture SQL, outside the CFML walk. */
export interface ProcedureCall {
  /** The procedure reference as the CFML executes it. */
  procedure: string;
  source: SourceRef;
  /** Fixture procedures it resolves to; empty when the fixture SQL defines none. */
  resolved: string[];
  /** Tables those procedures write, through the procedures they execute. */
  writes: string[];
}

/** How a family resolves its site: path segment, then request scopes, then the fallback for an unknown site. */
export interface SiteResolution {
  pathSegment: number | null;
  scopes: string[];
  fallback: string | null;
  source: SourceRef;
}

/** A redirect a family answers with. */
export interface RouteRedirect {
  statusCode: number;
  from: string;
  to: string;
}

/** One `routes[]` fact record; owners and dispositions are added by `generate.ts` except for fixture routes. */
export interface RouteEntry {
  id: string;
  kind: RouteKind;
  family: RouteFamily;
  /** Platform route key; null for the API umbrella families and SOAP. */
  routeKey: string | null;
  /** Key the platform gives a request for an undeclared public method, which never reaches the method. */
  keyedAs: string | null;
  source: SourceRef;
  /** The whole `cfif` branch a family entry belongs to. */
  branch: SourceRef | null;
  entity: string | null;
  method: string | null;
  /** Verbs that select the entry on their own; empty when path or `method` name selects it under any verb. */
  httpMethods: string[];
  predicate: RoutePredicate | null;
  /** Request params the JSON API dispatcher assigns the entity before the method runs; absent when it assigns none. */
  assignedParams?: Record<string, string>;
  /** 0 for a base key; 1.. is the order in which the platform tries the base's variants. */
  precedence: number;
  legacyAliases: string[];
  /** The legacy guard expression of a family branch. */
  condition: string | null;
  /** Registration or runtime condition under which the entry exists. */
  conditional: string | null;
  /** Request values the guard requires. */
  requires: string[];
  /** configBean settings the guard requires. */
  config: string[];
  modulePermissions: string[];
  siteResolution: SiteResolution | null;
  redirect: RouteRedirect | null;
  sessionless: boolean;
  reachable: boolean;
  reason: string | null;
  guard: string | null;
  rendersCfml: boolean;
  rendersCfmlEvidence: SourceRef | null;
  webRootFilesystem: boolean;
  runtimeCategory: RuntimeCategory | null;
  /** Area key the disposition rule looks owners and expectations up by: `api:<entity or method>`, `fixture:<module>`, the family, or `soap:v1`. */
  areaKey: string;
  fixtureModule: string | null;
  owningService: string | null;
  disposition: 'carry' | null;
  dispositionStep: 'fixture-definition' | null;
  jobRef: string | null;
  csrfContext: string | null;
  csrfValidation: CsrfValidation | null;
  /** Setting the validating call is conditioned on (`getContentRenderer().validateCSRFTokens &&`); null when unconditioned. */
  csrfGate: string | null;
  sessionEffects: SessionEffects;
  writeFacts: WriteFacts;
  /** `component#method` roots the closure walked; a `[keep]`/`[drop]` suffix marks a masked span. */
  roots: string[];
  writeSet: string[];
  conditionalWrites: ConditionalWrite[];
  fileStoreWrite: boolean;
  closureEvidence: ClosureWrite[];
  fileStoreEvidence: FileStoreEvidence[];
  threads: ClosureThread[];
  unresolved: UnresolvedRef[];
  overrides: string[];
  procedureCalls: ProcedureCall[];
  available: null;
  liveStatus: 'pending-run' | null;
}

/** Per-kind counts, as `counts.routes` of the inventory names them. */
export interface RouteCounts {
  families: number;
  apiEntityMethods: number;
  apiMethods: number;
  oauth: number;
  soap: number;
  fixture: number;
}

/** Whether the working tree holds the fixture front controller the `fix:` entries come from. */
export type FixtureRoutesStatus = 'present' | 'absent';

/** Result of {@link extractRoutes}; `routes` is sorted by id in code-unit order. */
export interface RouteExtraction {
  routes: RouteEntry[];
  counts: RouteCounts;
  fixtureRoutesStatus: FixtureRoutesStatus;
  /** Fixture tree the `fix:` entries were read from; null when absent. */
  fixtureTree: SourceTree | null;
}

/** Inputs of {@link extractRoutes}; `fixtureTree` undefined reads the working tree, null means no fixtures. */
export interface ExtractRoutesOptions {
  index: ComponentIndex;
  overrides?: WriterOverrides;
  variants?: readonly VariantDeclaration[];
  fixtureTree?: SourceTree | null;
}

export const CONTENT_SERVER_PATH = 'core/mura/content/contentServer.cfc';
export const JSON_API_PATH = 'core/mura/client/api/json/v1/jsonApiUtility.cfc';
export const APPLICATION_SETTINGS_PATH = 'core/appcfc/applicationSettings.cfm';
export const SETTINGS_BEAN_PATH = 'core/mura/settings/settingsBean.cfc';
export const SOAP_DIR = 'core/mura/client/api/soap/v1';
/** Base every `application.objectMappings` entity extends; its registration collects remote functions (bean.cfc:777-795). */
export const BEAN_ROOT_PATH = 'core/mura/bean/bean.cfc';
/** Core modules whose `model/` directories `registerBeanDir` loads per site (settingsBean.cfc:1794). */
export const MODULE_ROOT = 'core/modules/v1';
export const FIXTURE_DIR = 'legacy-fixtures/cfml';
export const FIXTURE_API_PATH = `${FIXTURE_DIR}/api.cfm`;
/** Request path of the fixture front controller, as the platform keys it. */
export const FIXTURE_PREFIX = '/legacy-fixtures/cfml/api.cfm';
/** Fixture module → owning service, by definition. */
export const FIXTURE_SERVICES: Readonly<Record<string, string>> = Object.freeze({
  people: 'people',
});

/** JSON API request mode per family: the `processRequest` default, and the REST branch's assignment. */
export const FAMILY_MODES: Readonly<Record<'api' | 'rest', string>> = Object.freeze({ api: 'json', rest: 'rest' });

/** Entry ids of the OAuth endpoints, as the committed inventory names them. */
export const OAUTH_IDS: Readonly<Record<string, string>> = Object.freeze({
  oauth: 'rte:/oauth',
  oauth2: 'rte:/oauth2',
  tokeninfo: 'rte:tokeninfo',
});

/** Components that operate on the legacy web-root filesystem, with the evidence that says so. */
export const WEB_ROOT_COMPONENTS: Readonly<Record<string, string>> = Object.freeze({
  'core/modules/v1/filebrowser/model/beans/filebrowser.cfc': 'browses User_Assets under the legacy web root (getBaseFileDir)',
});

/** API methods whose output is built from runtime CFML bean metadata. */
export const RUNTIME_METHODS: Readonly<Record<string, RuntimeCategory>> = Object.freeze({ swagger: 'bean-metadata' });

/** Area key of the JSON API family entries, whose methods carry their own areas. */
export const API_AREA = 'api';

/** Area key of the SOAP v1 components. */
export const SOAP_AREA = 'soap:v1';

/** Area key of a route key: `api:<entity or method>` (REST keys share it), `fixture:<module>`, else its family. */
export function areaKeyOf(routeKey: string): string {
  const key = normaliseInventoryKey(routeKey).replace(/^rest:/, 'api:').replace(/\{[^{}]*\}$/, '');
  const colon = key.indexOf(':');
  if (colon < 0) return key;
  const family = key.slice(0, colon);
  const body = key.slice(colon + 1);
  if (family === 'api') return `api:${body.split('.')[0] ?? ''}`;
  if (family === 'fixture') return `fixture:${body.split('/')[0] ?? ''}`;
  return family;
}

/** One family of the `handleAPIRequest` chain, keyed by the endpoint variable its guard tests. */
export interface FamilyRow {
  endpoint: string;
  aliases: readonly string[];
  kind: 'api-family' | 'job' | 'static';
  family: RouteFamily;
  keyed: boolean;
  query: Readonly<Record<string, string>>;
  cases: { on: string; defaultLabel: string } | null;
  keyOptions: RouteKeyOptions;
  rendersCfml: readonly string[];
  webRootFilesystem: boolean;
  jobRef: string | null;
  conditional: string | null;
}

const SAMPLE_ID = '6B9B1F2C-0A1B-4C2D-9E8F70A1B2C3D4E5';
const ALL = '*';

function row(endpoint: string, family: RouteFamily, extra: Partial<FamilyRow> = {}): FamilyRow {
  return Object.freeze({
    endpoint,
    aliases: [],
    kind: 'api-family',
    family,
    keyed: true,
    query: {},
    cases: null,
    keyOptions: {},
    rendersCfml: [],
    webRootFilesystem: false,
    jobRef: null,
    conditional: null,
    ...extra,
  });
}

/** The route families of `handleAPIRequest` [contentServer.cfc:593-777]; `rendersCfml` lists the cases (or `*`) that render CFML. */
export const FAMILY_TABLE: readonly FamilyRow[] = Object.freeze([
  row('jsonendpoint', 'api', { keyed: false }),
  row('ajaxendpoint', 'api', { keyed: false }),
  row('restendpoint', 'rest', { keyed: false }),
  row('feedendpoint', 'feed', { aliases: ['legacyfeedendpoint'], query: { feedid: SAMPLE_ID } }),
  // variation.js.cfm renders through the theme's content renderer, so the rule's legacy-served outcome stands against the expected carry.
  row('variationendpoint', 'variation', {
    query: { siteid: 'default' },
    keyOptions: { variationsEnabled: true },
    rendersCfml: [ALL],
    conditional: 'only when the variations config is on',
  }),
  row('emailendpoint', 'trackopen', { query: { emailid: SAMPLE_ID, email: 'reader@example.com' } }),
  row('fileendpoint', 'render', {
    aliases: ['legacyfileendpoint'],
    query: { fileid: SAMPLE_ID },
    cases: { on: 'url.size', defaultLabel: 'file' },
  }),
  row('sitemonitorendpoint', 'sitemonitor', {
    kind: 'job',
    jobRef: 'job:sitemonitor',
    conditional: 'steps are listed under scheduledJobs[]',
  }),
  row('legacywidgetendpoint', 'widgets', { kind: 'static' }),
  row('assetendpoint', 'asset', {
    query: { siteId: 'default', filePath: '/assets/Image/sample.png' },
    cases: { on: 'url.action', defaultLabel: 'render' },
    rendersCfml: ['render'],
    webRootFilesystem: true,
  }),
]);

// Text scanning

type Span = readonly [number, number];

const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '{': '}', '[': ']' };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function ref(p: string, first: number, last: number): SourceRef {
  return { path: p, lines: [first, Math.max(first, last)] };
}

/** Source span of the text between two offsets, ignoring trailing whitespace. */
function spanRef(p: string, text: string, start: number, end: number): SourceRef {
  const trimmed = text.slice(start, end).trimEnd();
  const from = start + (trimmed.length - trimmed.trimStart().length);
  return ref(p, lineOf(text, from), lineOf(text, start + Math.max(0, trimmed.length - 1)));
}

/** 1-based line of the last non-blank character of a file. */
function lastLine(text: string): number {
  return lineOf(text, Math.max(0, text.trimEnd().length - 1));
}

function parseUnit(tree: SourceTree, p: string): CfmlComponent {
  const unit = parseCfmlComponent(p, tree.readText(p));
  if (unit === null) throw new Error(`${p} is not a CFML component`);
  return unit;
}

function functionOf(unit: CfmlComponent, name: string): CfmlFunction {
  const fn = unit.functions.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (fn === undefined) throw new Error(`${unit.path} declares no function ${name}`);
  return fn;
}

function bodySpan(fn: CfmlFunction): Span {
  return [fn.offset, fn.offset + fn.body.length];
}

/** Index just past the quoted string opening at `i`; CFML doubles a quote to escape it. */
function skipString(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] !== quote) continue;
    if (text[j + 1] === quote) j++;
    else return j + 1;
  }
  return text.length;
}

/** Offset of the bracket closing the one at `open`, skipping strings; throws when unbalanced. */
function matchBracket(text: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (ch === '"' || ch === "'") {
      i = skipString(text, i) - 1;
    } else if (CLOSERS[ch] !== undefined) {
      stack.push(CLOSERS[ch] ?? '');
    } else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== ch) break;
      if (stack.length === 0) return i;
    }
  }
  throw new Error(`unbalanced ${text[open] ?? ''} at offset ${open}`);
}

/** Offset of the `>` ending the CFML tag opening at `start`, skipping quoted strings and parentheses. */
function tagEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") i = skipString(text, i) - 1;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '>' && depth <= 0) return i;
  }
  throw new Error(`unterminated tag at offset ${start}`);
}

/** `text` with every range blanked to spaces, newlines kept so offsets and lines stay put. */
function blankRanges(text: string, ranges: readonly Span[]): string {
  const units = text.split('');
  for (const [from, to] of ranges) {
    for (let i = Math.max(0, from); i < Math.min(units.length, to); i++) if (units[i] !== '\n' && units[i] !== '\r') units[i] = ' ';
  }
  return units.join('');
}

/** One clause of a script `if (…) {…} else if (…) {…} else {…}` chain; `cond` is null for the final `else`. */
interface ScriptClause {
  cond: string | null;
  open: number;
  close: number;
}

/** Length of the sticky match of `re` at `i`, or -1. */
function stickyAt(re: RegExp, text: string, i: number): number {
  re.lastIndex = i;
  const m = re.exec(text);
  return m === null ? -1 : m[0].length;
}

const IF_HEAD = /if\s*\(/y;
const BLOCK_OPEN = /\s*\{/y;
const ELSE = /\s*else\b\s*/y;

/** The script if-chain whose `if` keyword starts at `at`, and the offset past it; null for a brace-less clause. */
function ifChain(text: string, at: number): { clauses: ScriptClause[]; end: number } | null {
  const clauses: ScriptClause[] = [];
  let i = at;
  for (;;) {
    const head = stickyAt(IF_HEAD, text, i);
    let cond: string | null = null;
    if (head >= 0) {
      const paren = i + head - 1;
      const close = matchBracket(text, paren);
      cond = collapse(text.slice(paren + 1, close));
      i = close + 1;
    }
    const brace = stickyAt(BLOCK_OPEN, text, i);
    if (brace < 0) return null;
    const open = i + brace - 1;
    const close = matchBracket(text, open);
    clauses.push({ cond, open, close });
    i = close + 1;
    const next = stickyAt(ELSE, text, i);
    if (cond === null || next < 0) return { clauses, end: i };
    i += next;
  }
}

/** The innermost script `if` statement in `[from, to)` whose blocks contain `offset`. */
function enclosingIf(text: string, offset: number, from: number, to: number): { start: number; end: number; cond: string } | null {
  let best: { start: number; end: number; cond: string } | null = null;
  const re = /\bif\s*\(/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m !== null && m.index < to; m = re.exec(text)) {
    const chain = ifChain(text, m.index);
    if (chain === null) continue;
    const { clauses, end } = chain;
    const hit = clauses.find((c) => offset > c.open && offset < c.close);
    if (hit !== undefined && (best === null || m.index > best.start)) best = { start: m.index, end, cond: hit.cond ?? '' };
  }
  return best;
}

/** One label of a script `switch` block; `label` is null for `default`. */
interface ScriptCase {
  label: string | null;
  bodyStart: number;
  bodyEnd: number;
}

/** The top-level `case`/`default` labels of the script switch block `[open, close]`. */
function switchCases(text: string, open: number, close: number): ScriptCase[] {
  const labels: Array<{ label: string | null; at: number; bodyStart: number }> = [];
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const ch = text[i] ?? '';
    if (ch === '"' || ch === "'") {
      i = skipString(text, i) - 1;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (depth !== 0 || /[\w$.]/.test(text[i - 1] ?? '')) continue;
    const m = /^(?:case\s+("(?:[^"]|"")*"|'(?:[^']|'')*'|[\w.]+)\s*:|default\s*:)/.exec(text.slice(i, close));
    if (m === null) continue;
    labels.push({ label: m[1] === undefined ? null : unquote(m[1]), at: i, bodyStart: i + m[0].length });
    i += m[0].length - 1;
  }
  return labels.map((l, k) => ({ label: l.label, bodyStart: l.bodyStart, bodyEnd: labels[k + 1]?.at ?? close }));
}

function unquote(s: string): string {
  const q = s[0];
  return (q === '"' || q === "'") && s.endsWith(q) ? s.slice(1, -1).split(q + q).join(q) : s;
}

/** One clause of a tag `<cfif>`/`<cfelseif>`/`<cfelse>` chain with its body range. */
interface TagClause {
  cond: string | null;
  tagStart: number;
  bodyStart: number;
  bodyEnd: number;
}

/** The first top-level `<cfif>` chain of `[from, to)`. */
function cfifChain(text: string, from: number, to: number): TagClause[] {
  const clauses: TagClause[] = [];
  const re = /<(\/?)cf(elseif|else|if)\b/gi;
  re.lastIndex = from;
  let depth = 0;
  for (let m = re.exec(text); m !== null && m.index < to; m = re.exec(text)) {
    const closing = m[1] === '/';
    const name = (m[2] ?? '').toLowerCase();
    if (name === 'if' && !closing) depth++;
    if (depth === 1 && !closing) {
      const end = tagEnd(text, m.index);
      const last = clauses.at(-1);
      if (last !== undefined) last.bodyEnd = m.index;
      const cond = name === 'else' ? null : collapse(text.slice(m.index + m[0].length, end));
      clauses.push({ cond, tagStart: m.index, bodyStart: end + 1, bodyEnd: to });
      re.lastIndex = end + 1;
    }
    if (name === 'if' && closing) {
      depth--;
      if (depth === 0) {
        const last = clauses.at(-1);
        if (last !== undefined) last.bodyEnd = m.index;
        return clauses;
      }
    }
  }
  if (clauses.length > 0) throw new Error(`unterminated <cfif> chain at offset ${clauses[0]?.tagStart ?? from}`);
  return clauses;
}

/** One `<cfcase>` or `<cfdefaultcase>` of a tag switch; `label` is null for the default. */
interface TagCase {
  label: string | null;
  tagStart: number;
  bodyStart: number;
  bodyEnd: number;
}

/** The `<cfswitch expression="#…#">` in `[from, to)`, its expression and its cases. */
function cfSwitch(text: string, from: number, to: number): { expression: string; cases: TagCase[] } | null {
  const head = /<cfswitch\s+expression\s*=\s*"#([^#"]+)#"\s*>/i.exec(text.slice(from, to));
  if (head === null) return null;
  const cases: TagCase[] = [];
  const re = /<cf(case|defaultcase)\b([^>]*)>/gi;
  re.lastIndex = from + head.index + head[0].length;
  for (let m = re.exec(text); m !== null && m.index < to; m = re.exec(text)) {
    const closeTag = m[1]?.toLowerCase() === 'case' ? '</cfcase>' : '</cfdefaultcase>';
    const bodyEnd = text.toLowerCase().indexOf(closeTag, m.index);
    if (bodyEnd < 0 || bodyEnd > to) throw new Error(`unterminated <cf${m[1] ?? ''}> at offset ${m.index}`);
    const value = /\bvalue\s*=\s*"([^"]*)"/i.exec(m[2] ?? '')?.[1];
    cases.push({ label: m[1]?.toLowerCase() === 'case' ? (value ?? '') : null, tagStart: m.index, bodyStart: m.index + m[0].length, bodyEnd });
    re.lastIndex = bodyEnd + closeTag.length;
  }
  return { expression: (head[1] ?? '').trim(), cases };
}

// Closures

/** A closure root: a function walked whole, over one span only (`keep`), or without some spans (`drop`). */
interface Root {
  component: string;
  method: string;
  keep?: Span;
  drop?: readonly Span[];
  /** An entry function: overrides declared on it apply only to the entries their route keys name. */
  entryFunction?: boolean;
  /** Session effect the root stands for in place of the one its walk reports. */
  effect?: SessionEffects;
  /** The root method runs on a bean populated from the request, holding these keys beyond the request's. */
  populated?: readonly string[];
}

/** A request branch: the params it pins and the more specific branches it excludes. */
interface Branch {
  predicates?: Predicates;
  excludePredicates?: readonly Predicates[];
}

/** Closure context of one extraction, with its caches. */
interface Walker {
  tree: SourceTree;
  index: ComponentIndex;
  overrides: WriterOverrides | undefined;
  closures: Map<string, WriteClosure>;
  masked: Map<string, ComponentIndex>;
  /** Trees whose one template has the text outside a kept span blanked, by template and span. */
  overlays: Map<string, SourceTree>;
}

const SESSION_RANK: Readonly<Record<SessionEffects, number>> = Object.freeze({ none: 0, relogin: 1, login: 2, logout: 3 });

function emptyClosure(): WriteClosure {
  return {
    tables: [],
    writes: [],
    conditionalWrites: [],
    fileStore: false,
    fileStoreEvidence: [],
    sessionEffects: 'none',
    threads: [],
    unresolved: [],
    overrides: [],
    visited: [],
  };
}

function walker(tree: SourceTree, index: ComponentIndex, overrides: WriterOverrides | undefined): Walker {
  return { tree, index, overrides, closures: new Map(), masked: new Map(), overlays: new Map() };
}

/** The component and its `extends` ancestors present in the tree, nearest first. */
function chainOf(w: Walker, component: string): string[] {
  const out: string[] = [];
  for (let cur: string | null = component; cur !== null && !out.includes(cur); ) {
    const unit = w.index.parsed(cur);
    if (unit === null) break;
    out.push(cur);
    const ext = unit.declaration.attrs.extends;
    cur = ext === undefined || ext === '' ? null : resolveComponentPath(ext, cur, w.tree);
  }
  return out;
}

/** The function `name` as `component` resolves it through its chain, with the unit declaring it. */
function findInChain(w: Walker, component: string, name: string): { unit: CfmlComponent; fn: CfmlFunction } | null {
  for (const p of chainOf(w, component)) {
    const unit = w.index.parsed(p);
    const fn = unit?.functions.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (unit !== null && fn !== undefined) return { unit, fn };
  }
  return null;
}

function rootLabel(w: Walker, r: Root): string {
  const text = w.tree.readText(r.component);
  const lines = (s: Span): string => `${lineOf(text, s[0])}-${lineOf(text, Math.max(s[0], s[1] - 1))}`;
  if (r.keep !== undefined) return `${r.component}#${r.method}[keep:${lines(r.keep)}]`;
  if (r.drop !== undefined && r.drop.length > 0) return `${r.component}#${r.method}[drop:${r.drop.map(lines).join(',')}]`;
  return `${r.component}#${r.method}`;
}

/** The component index with the root's function masked to its kept span, or without its dropped spans. */
function indexFor(w: Walker, r: Root): ComponentIndex {
  if (r.keep === undefined && (r.drop === undefined || r.drop.length === 0)) return w.index;
  const key = JSON.stringify([r.component, r.method, r.keep ?? null, r.drop ?? null]);
  const cached = w.masked.get(key);
  if (cached !== undefined) return cached;
  const unit = w.index.parsed(r.component);
  if (unit === null) throw new Error(`closure root ${r.component} is not a component of the source tree`);
  const [from, to] = bodySpan(functionOf(unit, r.method));
  const ranges: Span[] = r.keep !== undefined ? [[from, r.keep[0]], [r.keep[1], to]] : [...(r.drop ?? [])];
  const masked = parseCfmlComponent(r.component, blankRanges(w.tree.readText(r.component), ranges));
  if (masked === null) throw new Error(`masked ${r.component} no longer parses as a component`);
  const base = w.index;
  const index: ComponentIndex = {
    resolveBean: (name) => base.resolveBean(name),
    ormTable: (p) => base.ormTable(p),
    parsed: (p) => (p === r.component ? masked : base.parsed(p)),
    transient: (p) => base.transient?.(p) === true,
  };
  w.masked.set(key, index);
  return index;
}

/** The tree with a masked root template's text outside its kept span blanked; templates are read from the tree, not the index. */
function treeFor(w: Walker, r: Root): SourceTree {
  if (!r.component.toLowerCase().endsWith('.cfm') || (r.keep === undefined && (r.drop ?? []).length === 0)) return w.tree;
  const key = JSON.stringify([r.component, r.keep ?? null, r.drop ?? null]);
  const cached = w.overlays.get(key);
  if (cached !== undefined) return cached;
  const text = w.tree.readText(r.component);
  const ranges: Span[] = r.keep !== undefined ? [[0, r.keep[0]], [r.keep[1], text.length]] : [...(r.drop ?? [])];
  const masked = blankRanges(text, ranges);
  const base = w.tree;
  const tree: SourceTree = {
    root: base.root,
    readText: (rel) => (rel === r.component ? masked : base.readText(rel)),
    exists: (rel) => base.exists(rel),
    list: (prefix, opts) => base.list(prefix, opts),
    lineOf: base.lineOf,
  };
  w.overlays.set(key, tree);
  return tree;
}

/** The overrides with those declared on an entry function kept only for the keys they name. */
function overridesFor(w: Walker, r: Root, keys: readonly string[]): { overrides: WriterOverrides | undefined; dropped: string[] } {
  const all = w.overrides;
  if (all === undefined || r.entryFunction !== true) return { overrides: all, dropped: [] };
  const method = r.method.toLowerCase();
  const dropped: string[] = [];
  const writers = all.writers.filter((o) => {
    const own = o.component === r.component && (o.method ?? '').toLowerCase() === method && o.routeKeys.length > 0;
    const kept = !own || o.routeKeys.some((k) => keys.includes(normaliseInventoryKey(k)));
    if (!kept) dropped.push(o.id);
    return kept;
  });
  return { overrides: dropped.length === 0 ? all : { ...all, writers }, dropped };
}

/** The closure of one root for one branch, cached per root, branch and applicable overrides. */
function walk(w: Walker, r: Root, branch: Branch, keys: readonly string[]): WriteClosure {
  const { overrides, dropped } = overridesFor(w, r, keys);
  const cacheKey = JSON.stringify([
    r.component,
    r.method,
    r.keep ?? null,
    r.drop ?? null,
    r.effect ?? null,
    r.populated ?? null,
    branch.predicates ?? null,
    branch.excludePredicates ?? [],
    dropped,
  ]);
  const hit = w.closures.get(cacheKey);
  if (hit !== undefined) return hit;
  const template = r.component.toLowerCase().endsWith('.cfm');
  const index = template ? w.index : indexFor(w, r);
  const tree = treeFor(w, r);
  const ctx: ClosureContext = overrides === undefined ? { tree, index } : { tree, index, overrides };
  let closure = computeClosure(
    {
      component: r.component,
      method: r.method,
      predicates: branch.predicates,
      excludePredicates: branch.excludePredicates,
      ...(r.populated === undefined ? {} : { populated: r.populated }),
    },
    ctx,
  );
  if (r.effect !== undefined && closure.sessionEffects !== 'none') closure = { ...closure, sessionEffects: r.effect };
  w.closures.set(cacheKey, closure);
  return closure;
}

function uniqueSorted<T>(items: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  // The call path and columns are facts about an item, not its identity: the first sighting's are kept.
  const keyOf = (item: T): string => JSON.stringify(item, (k, v: unknown) => (k === 'via' || k === 'columns' ? undefined : v));
  for (const item of items) if (!byKey.has(keyOf(item))) byKey.set(keyOf(item), item);
  return [...byKey.entries()].sort(([a], [b]) => compareText(a, b)).map(([, item]) => item);
}

/** Union of several closures; every array is de-duplicated and sorted. */
function mergeClosures(parts: readonly WriteClosure[]): WriteClosure {
  return {
    tables: [...new Set(parts.flatMap((p) => p.tables))].sort(compareText),
    writes: uniqueSorted(parts.flatMap((p) => p.writes)),
    conditionalWrites: uniqueSorted(parts.flatMap((p) => p.conditionalWrites)),
    fileStore: parts.some((p) => p.fileStore),
    fileStoreEvidence: uniqueSorted(parts.flatMap((p) => p.fileStoreEvidence)),
    sessionEffects: parts.reduce<SessionEffects>(
      (acc, p) => (SESSION_RANK[p.sessionEffects] > SESSION_RANK[acc] ? p.sessionEffects : acc),
      'none',
    ),
    threads: uniqueSorted(parts.flatMap((p) => p.threads)),
    unresolved: uniqueSorted(parts.flatMap((p) => p.unresolved)),
    overrides: [...new Set(parts.flatMap((p) => p.overrides))].sort(compareText),
    visited: [...new Set(parts.flatMap((p) => p.visited))].sort(compareText),
  };
}

type Clause = Record<string, Predicates[string]>;

/** Alternatives of one condition as request-param clauses; null when it has no params form. */
function atomClauses(c: VariantCondition): Clause[] | null {
  if ('anyOf' in c) {
    const out: Clause[] = [];
    for (const alt of c.anyOf) {
      const clauses = atomClauses(alt);
      if (clauses === null) return null;
      out.push(...clauses);
    }
    return out;
  }
  if ('not' in c || 'multipartExtensionIn' in c || 'sessionManaged' in c || 'startupSiteId' in c || 'listItemIn' in c) return null;
  if ('equals' in c) return [{ [c.param]: c.equals }];
  if ('in' in c) return c.in.map((v) => ({ [c.param]: v }));
  return [{ [c.param]: 'nonEmpty' in c ? true : CFML_TRUTHY }];
}

/** Disjunctive normal form of a conjunction of conditions; null when one of them has no params form. */
function clausesOf(when: readonly VariantCondition[]): Clause[] | null {
  let acc: Clause[] = [{}];
  for (const c of when) {
    const alts = atomClauses(c);
    if (alts === null) return null;
    const next: Clause[] = [];
    for (const a of acc) {
      for (const b of alts) {
        const lower = new Map(Object.entries(a).map(([k, v]) => [k.toLowerCase(), v]));
        if (Object.entries(b).every(([k, v]) => !lower.has(k.toLowerCase()) || lower.get(k.toLowerCase()) === v)) next.push({ ...a, ...b });
      }
    }
    acc = next;
  }
  return acc;
}

/** The branch of a base key (`at` -1) or of its `at`-th variant: first declaration wins, so earlier ones are excluded. */
function branchOf(decls: readonly VariantDeclaration[], at: number): Branch {
  const excluded = (at < 0 ? decls : decls.slice(0, at)).flatMap((d) => clausesOf(d.when) ?? []);
  const own = at < 0 ? null : clausesOf(decls[at]?.when ?? []);
  const branch: Branch = {};
  if (own !== null && own.length === 1 && own[0] !== undefined) branch.predicates = own[0];
  if (excluded.length > 0) branch.excludePredicates = excluded;
  return branch;
}

/** A request sample: params, multipart parts and, for a session-managed REST sample, the index.cfm spelling it is sent behind. */
interface RequestSample {
  params: Record<string, string>;
  files: Array<{ field: string; filename: string }>;
  frontController?: string;
}

/** The index.cfm spelling a session-managed sample is sent behind; the container maps only the lower-case one. */
const SESSION_FRONT_CONTROLLER = 'INDEX.CFM';

/** Request facts that satisfy a variant's conditions; null when one cannot be synthesised. */
function sampleOf(when: readonly VariantCondition[]): RequestSample | null {
  const params: Record<string, string> = {};
  const files: Array<{ field: string; filename: string }> = [];
  let frontController: string | undefined;
  const add = (c: VariantCondition): boolean => {
    if ('anyOf' in c) return c.anyOf[0] !== undefined && add(c.anyOf[0]);
    if ('not' in c) return false;
    if ('sessionManaged' in c) {
      frontController = SESSION_FRONT_CONTROLLER;
      return true;
    }
    if ('startupSiteId' in c) {
      // Legacy's own default site, which the synthetic API path addresses and every install has.
      params.siteid ||= 'default';
      return true;
    }
    if ('multipartExtensionIn' in c) {
      files.push({ field: 'newfile', filename: `sample.${c.multipartExtensionIn[0] ?? 'bin'}` });
      return true;
    }
    if ('equals' in c) params[c.param] = c.equals;
    else if ('in' in c) params[c.param] = c.in[0] ?? '';
    else if ('listItemIn' in c) params[c.param] = c.listItemIn[0] ?? '';
    else if ('nonEmpty' in c) params[c.param] = 'sample';
    else params[c.param] = 'true';
    return true;
  };
  if (!when.every(add)) return null;
  return frontController === undefined ? { params, files } : { params, files, frontController };
}

/** `entry` sent behind `frontController`: an API entry point names it, a path gets it as its first segment. */
function behindFrontController(entry: RouteEntryPoint, frontController: string | undefined): RouteEntryPoint {
  if (frontController === undefined) return entry;
  if (entry.kind === 'api') return { ...entry, frontController };
  return entry.kind === 'path' ? { ...entry, path: `/${frontController}${entry.path}` } : entry;
}

/** Whether a sessionless family's entry keeps legacy session management under `predicate` (applicationSettings.cfm:179). */
function sessionlessUnder(sessionless: boolean, predicate: RoutePredicate | null): boolean {
  return sessionless && !(predicate?.when.some((c) => 'sessionManaged' in c) ?? false);
}

/** A `validateCSRFTokens` call: its context and the short-circuits in front of it. */
interface CsrfCall {
  /** Offset of the call in its unit's text. */
  at: number;
  context: string;
  sessionGuarded: boolean;
  constantBypass: boolean;
  /** Condition joined before the call with `&&`, such as the renderer's `validateCSRFTokens` setting; null when none. */
  gate: string | null;
  /** HTTP methods for which the enclosing function returns before the call (`if (listFind("GET,HEAD", ….httpMethod)) return;`). */
  skipMethods: string[];
}

/** Value of `variables.<name>.<key>` from a `variables.<name> = {…}` struct literal in `text`; undefined when none. */
function structField(text: string, name: string, key: string): string | undefined {
  const head = new RegExp(`\\bvariables\\.${name}\\s*=\\s*\\{`, 'i').exec(text);
  if (head === null) return undefined;
  const open = head.index + head[0].length - 1;
  const literal = text.slice(open + 1, matchBracket(text, open));
  return new RegExp(`(?:^|,)\\s*["']?${key}["']?\\s*[=:]\\s*([^,]+)`, 'i').exec(literal)?.[1]?.trim();
}

/** `validateCSRFTokens` calls in `text[from, to)`; a bare-identifier or struct-field context resolves to its assigned expression. */
function csrfCalls(text: string, from: number, to: number, scope: string): CsrfCall[] {
  const out: CsrfCall[] = [];
  const re = /\bvalidateCSRFTokens\s*\(/gi;
  re.lastIndex = from;
  for (let m = re.exec(text); m !== null && m.index < to; m = re.exec(text)) {
    const paren = m.index + m[0].length - 1;
    const args = text.slice(paren + 1, matchBracket(text, paren));
    const raw = /\bcontext\s*=\s*([\s\S]+)$/i.exec(args)?.[1]?.trim();
    let context = raw === undefined ? '' : unquote(raw);
    if (raw !== undefined && /^[A-Za-z_$][\w$]*$/.test(raw)) {
      const local = new RegExp(`\\bvar\\s+${raw}\\s*=\\s*([^;]+);`, 'i').exec(scope)?.[1];
      if (local !== undefined) context = collapse(local);
    }
    const field = raw === undefined ? null : /^variables\.(\w+)\.(\w+)$/i.exec(raw);
    const assigned = field === null ? undefined : structField(text, field[1] ?? '', field[2] ?? '');
    if (assigned !== undefined) context = collapse(assigned).replace(/^arguments\./i, '');
    const head = text.slice(Math.max(from, ...[';', '{', '}', '>'].map((c) => text.lastIndexOf(c, m.index) + 1)), m.index);
    const gate = /^\s*(?:<cfif\s+|if\s*\(\s*)?([\w$.()'"]+)\s*(?:&&|\band\b)\s*(?:!|\bnot\b)?\s*[\w$.]*$/i.exec(head)?.[1] ?? null;
    const skip = /\bif\s*\(\s*listFind(?:NoCase)?\(\s*["']([A-Za-z,]+)["']\s*,\s*[\w.]*\bhttpMethod\s*\)[^{;]*\{\s*return\s*;\s*\}/i.exec(text.slice(from, m.index));
    out.push({
      at: m.index,
      context,
      sessionGuarded: /!\s*request\.muraSessionManagement\s*(?:\|\||\bor\b)/i.test(head),
      constantBypass: /\btrue\s*(?:\|\||\bor\b)/i.test(head),
      gate: gate !== null && !/^request\.muraSessionManagement$/i.test(gate) ? gate : null,
      skipMethods: skip === null ? [] : (skip[1] ?? '').split(',').map((v) => v.trim().toUpperCase()),
    });
  }
  return out;
}

/** CSRF facts of an entry: the calls' common context and whether any call gates the branch in this family and method. */
function csrfFacts(
  calls: readonly CsrfCall[],
  sessionless: boolean,
  httpMethod?: string,
): { csrfContext: string | null; csrfValidation: CsrfValidation; csrfGate: string | null } {
  const applicable = calls.filter((c) => httpMethod === undefined || !c.skipMethods.includes(httpMethod.toUpperCase()));
  if (applicable.length === 0) return { csrfContext: null, csrfValidation: 'none', csrfGate: null };
  const validating = applicable.filter((c) => !c.constantBypass && !(c.sessionGuarded && sessionless));
  const contexts = new Set((validating.length > 0 ? validating : applicable).map((c) => c.context));
  const gates = new Set(validating.map((c) => c.gate));
  return {
    csrfContext: contexts.size === 1 ? ([...contexts][0] ?? null) : null,
    csrfValidation: validating.length > 0 ? 'validates' : 'bypassed',
    csrfGate: gates.size === 1 ? ([...gates][0] ?? null) : null,
  };
}

/** CSRF calls in the root functions of an entry, honouring kept and dropped spans. */
function rootCsrfCalls(w: Walker, roots: readonly Root[]): CsrfCall[] {
  return roots.flatMap((r) => {
    const found = findInChain(w, r.component, r.method);
    if (found === null) return [];
    const [from, to] = r.keep ?? bodySpan(found.fn);
    return csrfCalls(found.unit.text, from, to, found.fn.body).filter((c) => !(r.drop ?? []).some(([a, z]) => c.at >= a && c.at < z));
  });
}

/** CSRF facts of an entry from its root functions' calls, else its closure's visited functions', else `fallback` (rendered templates). */
function entryCsrf(
  w: Walker,
  roots: readonly Root[],
  closure: WriteClosure,
  sessionless: boolean,
  httpMethod?: string,
  fallback: readonly CsrfCall[] = [],
): ReturnType<typeof csrfFacts> {
  const own = rootCsrfCalls(w, roots);
  const visited = own.length > 0 ? own : visitedCsrfCalls(w, closure.visited);
  return csrfFacts(visited.length > 0 ? visited : fallback, sessionless, httpMethod);
}

/** CSRF calls in the display-object templates under {@link MODULE_ROOT}, which a rendering method may run. */
function displayCsrfCalls(w: Walker): CsrfCall[] {
  return w.tree
    .list(MODULE_ROOT, { ext: ['cfm'], recursive: true })
    .filter((file) => /validateCSRFTokens/i.test(w.tree.readText(file)))
    .flatMap((file) => {
      const text = stripComments(w.tree.readText(file), 'tag');
      return csrfCalls(text, 0, text.length, text);
    });
}

/** CSRF calls in the functions a closure visited, for entries whose own functions delegate the check. */
function visitedCsrfCalls(w: Walker, visited: readonly string[]): CsrfCall[] {
  return visited.flatMap((v) => {
    const hash = v.lastIndexOf('#');
    const found = findInChain(w, v.slice(0, hash), v.slice(hash + 1));
    if (found === null) return [];
    const [from, to] = bodySpan(found.fn);
    return csrfCalls(found.unit.text, from, to, found.fn.body);
  });
}

// Entries

type EntryCore = Pick<RouteEntry, 'id' | 'kind' | 'family' | 'routeKey' | 'source' | 'areaKey'>;

function newEntry(core: EntryCore, extra: Partial<RouteEntry> = {}): RouteEntry {
  return {
    keyedAs: null,
    branch: null,
    entity: null,
    method: null,
    httpMethods: [],
    predicate: null,
    precedence: 0,
    legacyAliases: [],
    condition: null,
    conditional: null,
    requires: [],
    config: [],
    modulePermissions: [],
    siteResolution: null,
    redirect: null,
    sessionless: false,
    reachable: true,
    reason: null,
    guard: null,
    rendersCfml: false,
    rendersCfmlEvidence: null,
    webRootFilesystem: false,
    runtimeCategory: null,
    fixtureModule: null,
    owningService: null,
    disposition: null,
    dispositionStep: null,
    jobRef: null,
    csrfContext: null,
    csrfValidation: null,
    csrfGate: null,
    sessionEffects: 'none',
    writeFacts: 'none',
    roots: [],
    writeSet: [],
    conditionalWrites: [],
    fileStoreWrite: false,
    closureEvidence: [],
    fileStoreEvidence: [],
    threads: [],
    unresolved: [],
    overrides: [],
    procedureCalls: [],
    available: null,
    liveStatus: null,
    ...core,
    ...extra,
  };
}

/** The entry fields a closure supplies. */
function closureFields(c: WriteClosure): Partial<RouteEntry> {
  return {
    writeFacts: 'closure',
    writeSet: c.tables,
    conditionalWrites: c.conditionalWrites,
    fileStoreWrite: c.fileStore,
    closureEvidence: c.writes,
    fileStoreEvidence: c.fileStoreEvidence,
    threads: c.threads,
    unresolved: c.unresolved,
    overrides: c.overrides,
    sessionEffects: c.sessionEffects,
  };
}

type Keyer = (entry: RouteEntryPoint, extra?: RouteKeyOptions) => Promise<string>;

function keyerFor(base: RouteKeyOptions): Keyer {
  return async (entry, extra = {}) => (await inventoryRouteKey(entry, { ...base, ...extra })).key;
}

// Route families

/** One case of a family branch, or the whole branch when the family has no switch. */
export interface FamilyCase {
  label: string | null;
  source: SourceRef;
  bodyStart: number;
  bodyEnd: number;
}

/** A `handleAPIRequest` branch with the family row it serves and the endpoint values it tests. */
export interface FamilyBranch {
  row: FamilyRow;
  method: string;
  endpoint: string;
  aliases: string[];
  condition: string;
  source: SourceRef;
  bodyStart: number;
  bodyEnd: number;
  cases: FamilyCase[];
}

/** The path prefix whose requests run without a session (`this.sessionManagement`, applicationSettings.cfm:179). */
export function parseSessionlessPrefix(tree: SourceTree): { prefix: string; source: SourceRef } {
  const text = tree.readText(APPLICATION_SETTINGS_PATH);
  const m = /this\.sessionManagement\s*=\s*!\s*\(\s*left\(\s*cgi\.path_info\s*,\s*(\d+)\s*\)\s*==\s*'([^']*)'\s*\)/i.exec(text);
  if (m === null || (m[2] ?? '').length !== Number(m[1])) {
    throw new Error(`${APPLICATION_SETTINGS_PATH}: no this.sessionManagement path-prefix assignment`);
  }
  const line = lineOf(text, m.index);
  return { prefix: m[2] ?? '', source: ref(APPLICATION_SETTINGS_PATH, line, line) };
}

/** Parses the endpoint variables and the `cfif`/`cfelseif` chain of `handleAPIRequest`, one branch per family row. */
export function parseRouteFamilies(tree: SourceTree): FamilyBranch[] {
  const unit = parseUnit(tree, CONTENT_SERVER_PATH);
  const fn = functionOf(unit, 'handleAPIRequest');
  const { text } = unit;
  const [from, to] = bodySpan(fn);
  const values = new Map<string, string>();
  for (const m of text.slice(from, to).matchAll(/<cfset\s+var\s+(\w+)\s*=\s*"([^"]*)"\s*>/gi)) values.set((m[1] ?? '').toLowerCase(), m[2] ?? '');
  const clauses = cfifChain(text, from, to);
  const claimed = new Set<TagClause>();
  const valueOf = (name: string): string => {
    const v = values.get(name.toLowerCase());
    if (v === undefined) throw new Error(`${CONTENT_SERVER_PATH}: handleAPIRequest declares no endpoint variable ${name}`);
    return v;
  };
  const tests = (clause: TagClause, name: string): boolean => new RegExp(`\\b${name}\\b`, 'i').test(clause.cond ?? '');
  const branches = FAMILY_TABLE.map((row): FamilyBranch => {
    const hits = clauses.filter((c) => tests(c, row.endpoint));
    const clause = hits[0];
    if (hits.length !== 1 || clause === undefined) {
      throw new Error(`${CONTENT_SERVER_PATH}: ${hits.length} handleAPIRequest branches test ${row.endpoint}, expected 1`);
    }
    claimed.add(clause);
    const aliases = row.aliases.map((a) => {
      if (!tests(clause, a)) throw new Error(`${CONTENT_SERVER_PATH}: the ${row.endpoint} branch does not test ${a}`);
      return valueOf(a);
    });
    const source = spanRef(CONTENT_SERVER_PATH, text, clause.tagStart, clause.bodyEnd);
    let cases: FamilyCase[] = [{ label: null, source, bodyStart: clause.bodyStart, bodyEnd: clause.bodyEnd }];
    if (row.cases !== null) {
      const sw = cfSwitch(text, clause.bodyStart, clause.bodyEnd);
      if (sw === null || sw.expression.toLowerCase() !== row.cases.on.toLowerCase()) {
        throw new Error(`${CONTENT_SERVER_PATH}: the ${row.endpoint} branch has no <cfswitch> on ${row.cases.on}`);
      }
      const defaultLabel = row.cases.defaultLabel;
      cases = sw.cases.map((c) => ({
        label: c.label ?? defaultLabel,
        source: spanRef(CONTENT_SERVER_PATH, text, c.tagStart, text.indexOf('>', c.bodyEnd) + 1),
        bodyStart: c.bodyStart,
        bodyEnd: c.bodyEnd,
      }));
    }
    const condition = clause.cond ?? '';
    return { row, method: fn.name, endpoint: valueOf(row.endpoint), aliases, condition, source, bodyStart: clause.bodyStart, bodyEnd: clause.bodyEnd, cases };
  });
  const unclaimed = clauses.filter((c) => !claimed.has(c));
  if (unclaimed.length > 0) {
    const lines = unclaimed.map((c) => lineOf(text, c.tagStart)).join(', ');
    throw new Error(`${CONTENT_SERVER_PATH}: handleAPIRequest branches at lines ${lines} serve no family row`);
  }
  return branches;
}

/** How a family branch resolves its site, from `listGetAt(arguments.path, n)`, `isDefined('<scope>.siteid')` and the fallback. */
function siteResolutionOf(text: string, from: number, to: number): SiteResolution | null {
  const body = text.slice(from, to);
  const segment = /listGetAt\(\s*arguments\.path\s*,\s*(\d+)\s*,\s*'\/'\s*\)/i.exec(body);
  const scopes = [...body.matchAll(/isDefined\(\s*'((?:form|url)\.siteid)'\s*\)/gi)];
  if (segment === null && scopes.length === 0) return null;
  const fallback = /siteExists\(\s*siteid\s*\)\s*>\s*<cfset\s+siteid\s*=\s*"([^"]*)"/i.exec(body);
  const offsets = [segment, ...scopes, fallback].flatMap((m) => (m === null ? [] : [m.index]));
  return {
    pathSegment: segment === null ? null : Number(segment[1]),
    scopes: scopes.map((m) => (m[1] ?? '').toLowerCase()),
    fallback: fallback?.[1] ?? null,
    source: ref(CONTENT_SERVER_PATH, lineOf(text, from + Math.min(...offsets)), lineOf(text, from + Math.max(...offsets))),
  };
}

/** The `#type#ApiUtility` component `settingsBean.getApi(type, version)` instantiates (settingsBean.cfc:1249-1254). */
function apiUtilityPath(tree: SourceTree, type: string, version: string): string {
  const unit = parseUnit(tree, SETTINGS_BEAN_PATH);
  const fn = functionOf(unit, 'getApi');
  const template = /\bnew\s+(mura\.client\.api\.[#\w.]+)\s*\(/i.exec(fn.body)?.[1];
  if (template === undefined) throw new Error(`${SETTINGS_BEAN_PATH}: getApi instantiates no mura.client.api component`);
  const dotted = template.replace(/#arguments\.type#/gi, type).replace(/#arguments\.version#/gi, version);
  const p = resolveComponentPath(dotted, SETTINGS_BEAN_PATH, tree);
  if (p === null || !tree.exists(p)) throw new Error(`${SETTINGS_BEAN_PATH}: getApi('${type}','${version}') names no component (${dotted})`);
  return p;
}

/** Roots a family case reaches through calls the walk cannot follow: `getApi(…).<method>(` and `mura.executor` templates. */
function boundFamilyRoots(tree: SourceTree, body: string): Root[] {
  const roots: Root[] = [];
  for (const m of body.matchAll(/getApi\(\s*'(\w+)'\s*,\s*'(\w+)'\s*\)\s*\.\s*(\w+)\s*\(/gi)) {
    roots.push({ component: apiUtilityPath(tree, m[1] ?? '', m[2] ?? ''), method: m[3] ?? '' });
  }
  for (const m of body.matchAll(/\bnew\s+mura\.executor\(\s*\)\s*\.\s*execute\(\s*'([^']+)'\s*\)/gi)) {
    const template = (m[1] ?? '').replace(/^\/mura\//i, 'core/mura/');
    if (!tree.exists(template)) throw new Error(`${CONTENT_SERVER_PATH}: mura.executor runs ${m[1] ?? ''}, absent from the tree`);
    roots.push({ component: template, method: '' });
  }
  return roots;
}

/** Context the entry builders share. */
interface BuildContext {
  w: Walker;
  key: Keyer;
  variants: readonly VariantDeclaration[];
  sessionless: { prefix: string; source: SourceRef };
}

/** The closure fields of an entry walked from `roots` for one branch. */
function rootsClosure(b: BuildContext, roots: readonly Root[], branch: Branch, keys: readonly string[], sessionless: boolean): Partial<RouteEntry> {
  const closure = mergeClosures(roots.map((r) => walk(b.w, r, branch, keys)));
  return { ...closureFields(closure), roots: roots.map((r) => rootLabel(b.w, r)), ...entryCsrf(b.w, roots, closure, sessionless) };
}

/** `rte:` entries of the `handleAPIRequest` families, one per switch case where the family branches on one. */
async function familyEntries(b: BuildContext, branches: readonly FamilyBranch[]): Promise<RouteEntry[]> {
  const text = b.w.tree.readText(CONTENT_SERVER_PATH);
  const out: RouteEntry[] = [];
  for (const branch of branches) {
    const { row } = branch;
    const base = branch.endpoint.endsWith('/') ? branch.endpoint : `${branch.endpoint}/`;
    for (const c of branch.cases) {
      const samplePath = c.label === null ? base : `${base}${c.label}/`;
      const idPath = (c.label === null ? branch.endpoint : `${base}${c.label}`).replace(/\/+$/, '');
      const pathEntry = (p: string): RouteEntryPoint => ({ kind: 'path', path: p, query: { ...row.query } });
      const routeKey = row.keyed ? await b.key(pathEntry(samplePath), row.keyOptions) : null;
      const legacyAliases: string[] = [];
      for (const alias of branch.aliases) {
        const aliasPath = c.label === null ? alias : `${alias.endsWith('/') ? alias : `${alias}/`}${c.label}/`;
        if (routeKey !== null) {
          const aliasKey = await b.key(pathEntry(aliasPath.endsWith('/') ? aliasPath : `${aliasPath}/`), row.keyOptions);
          if (aliasKey !== routeKey) throw new Error(`${CONTENT_SERVER_PATH}: ${aliasPath} keys to ${aliasKey}, not ${routeKey}`);
        }
        legacyAliases.push(aliasPath);
      }
      const body = text.slice(c.bodyStart, c.bodyEnd);
      const sessionless = samplePath.toLowerCase().startsWith(b.sessionless.prefix.toLowerCase());
      const renders = row.rendersCfml.includes(ALL) || (c.label !== null && row.rendersCfml.includes(c.label));
      const entry = newEntry(
        { id: `rte:${idPath}`, kind: row.kind, family: row.family, routeKey, source: c.source, areaKey: routeKey === null ? API_AREA : areaKeyOf(routeKey) },
        {
          branch: branch.source,
          legacyAliases,
          condition: branch.condition,
          conditional: row.conditional ?? (sessionless ? `REST mode is sessionless (${b.sessionless.source.path}:${b.sessionless.source.lines[0]})` : null),
          requires: [...new Set([...branch.condition.matchAll(/isDefined\(\s*'([\w.]+)'\s*\)/gi)].map((m) => m[1] ?? ''))],
          config: [...new Set([...branch.condition.matchAll(/getValue\(\s*property\s*=\s*'(\w+)'/gi)].map((m) => m[1] ?? ''))],
          modulePermissions: [...new Set([...body.matchAll(/getModulePerm\(\s*'(\w+)'/gi)].map((m) => m[1] ?? ''))],
          siteResolution: siteResolutionOf(text, branch.bodyStart, branch.bodyEnd),
          redirect: redirectOf(body),
          sessionless,
          rendersCfml: renders,
          rendersCfmlEvidence: renders ? c.source : null,
          webRootFilesystem: row.webRootFilesystem,
          jobRef: row.jobRef,
          writeFacts: row.kind === 'job' ? 'scheduled-jobs' : row.keyed ? 'closure' : 'per-method',
        },
      );
      if (row.keyed) {
        const roots: Root[] = [
          { component: CONTENT_SERVER_PATH, method: branch.method, keep: [c.bodyStart, c.bodyEnd], entryFunction: true },
          ...boundFamilyRoots(b.w.tree, body),
        ];
        // A job's writes are its steps' (scheduledJobs[]); its branch is scanned for CSRF only.
        if (row.kind === 'job') Object.assign(entry, csrfFacts(rootCsrfCalls(b.w, roots), sessionless));
        else Object.assign(entry, rootsClosure(b, roots, {}, routeKey === null ? [] : [routeKey], sessionless));
        if (renders) entry.rendersCfmlEvidence = templateRenderEvidence(b.w.tree, roots) ?? c.source;
      }
      out.push(entry);
    }
  }
  return out;
}

const TEMPLATE_RENDER = /\bgetContentRenderer\s*\(|\bdspObjects?\s*\(|\brenderEvent\s*\(/i;

/** First line of a root template that renders through the theme's content renderer or display objects; null when none does. */
function templateRenderEvidence(tree: SourceTree, roots: readonly Root[]): SourceRef | null {
  for (const r of roots) {
    if (!r.component.toLowerCase().endsWith('.cfm') || !tree.exists(r.component)) continue;
    const text = stripComments(tree.readText(r.component), 'tag');
    const m = TEMPLATE_RENDER.exec(text);
    if (m !== null) {
      const line = lineOf(text, m.index);
      return ref(r.component, line, line);
    }
  }
  return null;
}

/** A `<cflocation>` whose URL rewrites the request path, as the widgets family answers. */
function redirectOf(body: string): RouteRedirect | null {
  const m = /<cflocation\b[^>]*\bstatuscode\s*=\s*"(\d+)"[^>]*\burl\s*=\s*"#replaceNoCase\(\s*cgi\.path_info\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)#"/i.exec(body);
  return m === null ? null : { statusCode: Number(m[1]), from: m[2] ?? '', to: m[3] ?? '' };
}

// JSON API

/** An entity the JSON API serves: registered in `init`, possibly under a config guard, or declared in its config. */
export interface JsonApiEntity {
  name: string;
  via: 'registerEntity' | 'config';
  condition: string | null;
  config: string | null;
  source: SourceRef;
}

/** The re-login after users save their own record (jsonApiUtility.cfc:2065-2071): request mode, entity and span. */
export interface SelfSaveRelogin {
  mode: string;
  entityName: string;
  span: Span;
  source: SourceRef;
}

/** What jsonApiUtility.cfc registers and how it dispatches. */
export interface JsonApiRegistry {
  publicMethods: string[];
  publicMethodsSource: SourceRef;
  entities: JsonApiEntity[];
  /** Lower-cased entity alias → the entity it is served as (`contentnav` → `content`). */
  aliases: Readonly<Record<string, string>>;
  /** Lower-cased served entity → the literal request params processRequest assigns before dispatch (`user` → `{ type: '2' }`). */
  entityParams: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Lower-cased names of the functions the component declares. */
  declared: ReadonlySet<string>;
  /** Lower-cased method → verbs of the entity-route switch that call it. */
  verbs: Readonly<Record<string, string[]>>;
  defaultMode: string;
  selfSave: SelfSaveRelogin | null;
}

/** `text[open, close]` with the contents of nested brackets blanked, so top-level syntax can be matched. */
function topLevel(text: string, open: number, close: number): string {
  let out = '';
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const ch = text[i] ?? '';
    if ((ch === '"' || ch === "'") && depth === 0) {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    out += depth > 0 ? ' ' : ch;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
  }
  return out;
}

/** Parses the JSON API registry: `publicMethods`, `registerEntity` calls, config entities, aliases and dispatch. */
export function parseJsonApi(tree: SourceTree): JsonApiRegistry {
  const unit = parseUnit(tree, JSON_API_PATH);
  const { text } = unit;
  const [iFrom, iTo] = bodySpan(functionOf(unit, 'init'));
  const initBody = text.slice(iFrom, iTo);
  const at = (offset: number): number => lineOf(text, offset);

  const pm = /\bpublicMethods\s*=\s*"([^"]*)"/i.exec(initBody);
  if (pm === null) throw new Error(`${JSON_API_PATH}: init sets no publicMethods`);
  const publicMethods = (pm[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const publicMethodsLine = at(iFrom + pm.index);

  const entities: JsonApiEntity[] = [];
  const cfg = /\bentities\s*=\s*\{/i.exec(initBody);
  if (cfg !== null) {
    const open = iFrom + cfg.index + cfg[0].length - 1;
    const close = matchBracket(text, open);
    const inner = topLevel(text, open, close);
    for (const m of inner.matchAll(/(?:^|,)\s*(?:'(\w+)'|"(\w+)"|([A-Za-z_]\w*))\s*[=:]/g)) {
      const line = at(open + 1 + m.index + (m[0].length - m[0].trimStart().length));
      entities.push({ name: m[1] ?? m[2] ?? m[3] ?? '', via: 'config', condition: null, config: null, source: ref(JSON_API_PATH, line, line) });
    }
  }
  for (const m of initBody.matchAll(/\bregisterEntity\(\s*(['"])(\w+)\1/g)) {
    const offset = iFrom + (m.index ?? 0);
    const guard = enclosingIf(text, offset, iFrom, iTo);
    const config = guard === null ? null : (/getValue\(\s*property\s*=\s*'(\w+)'/i.exec(guard.cond)?.[1] ?? null);
    entities.push({ name: m[2] ?? '', via: 'registerEntity', condition: guard?.cond ?? null, config, source: ref(JSON_API_PATH, at(offset), at(offset)) });
  }

  const pr = functionOf(unit, 'processRequest');
  const [pFrom, pTo] = bodySpan(pr);
  const aliases: Record<string, string> = {};
  const al = /listFindNoCase\(\s*'([^']+)'\s*,\s*params\.entityName\s*\)\s*\)\s*\{\s*params\.entityName\s*=\s*"(\w+)"/i.exec(pr.body);
  for (const name of (al?.[1] ?? '').split(',')) if (name.trim() !== '') aliases[name.trim().toLowerCase()] = al?.[2] ?? '';
  // `if(params.entityName=="user"){ params.type=2; … }`: literal params a brace-free entity branch assigns.
  const entityParams: Record<string, Record<string, string>> = {};
  for (const m of pr.body.matchAll(/\bparams\.entityName\s*==\s*(["'])(\w+)\1\s*\)\s*\{([^{}]*)\}/gi)) {
    const entity = (m[2] ?? '').toLowerCase();
    for (const a of (m[3] ?? '').matchAll(/\bparams\.(\w+)\s*=\s*(?:(["'])([^"'\n]*)\2|(\d+))\s*;/gi)) {
      entityParams[entity] = { ...(entityParams[entity] ?? {}), [(a[1] ?? '').toLowerCase()]: a[3] ?? a[4] ?? '' };
    }
  }
  const defaultMode = /param\s+name\s*=\s*"request\.muraAPIRequestMode"\s+default\s*=\s*"(\w+)"/i.exec(pr.body)?.[1];
  if (defaultMode === undefined) throw new Error(`${JSON_API_PATH}: processRequest sets no request.muraAPIRequestMode default`);

  const verbs: Record<string, string[]> = {};
  const sw = /\bswitch\s*\(\s*method\s*\)\s*\{/i.exec(text.slice(pFrom, pTo));
  if (sw === null) throw new Error(`${JSON_API_PATH}: processRequest has no switch(method) entity-route dispatch`);
  const swOpen = pFrom + sw.index + sw[0].length - 1;
  let pending: string[] = [];
  for (const c of switchCases(text, swOpen, matchBracket(text, swOpen))) {
    pending.push((c.label ?? 'default').toUpperCase());
    const calls = [...text.slice(c.bodyStart, c.bodyEnd).matchAll(/\b(\w+)\s*\(\s*argumentCollection\s*=\s*params\s*\)/gi)];
    if (calls.length === 0 && text.slice(c.bodyStart, c.bodyEnd).trim() === '') continue;
    for (const call of calls) {
      const name = (call[1] ?? '').toLowerCase();
      verbs[name] = [...new Set([...(verbs[name] ?? []), ...pending])].sort(compareText);
    }
    pending = [];
  }

  let selfSave: SelfSaveRelogin | null = null;
  const save = unit.functions.find((f) => f.name.toLowerCase() === 'save');
  if (save !== undefined) {
    const [sFrom, sTo] = bodySpan(save);
    const login = /\bloginByUserID\s*\(/i.exec(save.body);
    const guard = login === null ? null : enclosingIf(text, sFrom + login.index, sFrom, sTo);
    const mode = guard === null ? undefined : /request\.muraAPIRequestMode\s*==\s*'(\w+)'/i.exec(guard.cond)?.[1];
    const entityName = guard === null ? undefined : /getEntityName\(\)\s*==\s*'(\w+)'/i.exec(guard.cond)?.[1];
    if (guard !== null && mode !== undefined && entityName !== undefined) {
      selfSave = { mode, entityName, span: [guard.start, guard.end], source: ref(JSON_API_PATH, at(guard.start), at(guard.end - 1)) };
    }
  }

  return {
    publicMethods,
    publicMethodsSource: ref(JSON_API_PATH, publicMethodsLine, publicMethodsLine),
    entities,
    aliases,
    entityParams,
    declared: new Set(unit.functions.map((f) => f.name.toLowerCase())),
    verbs,
    defaultMode,
    selfSave,
  };
}

/** Throws unless the parsed registry is the pinned one the platform keys by (REGISTERED_ENTITIES, PUBLIC_METHODS, …). */
export function assertPinnedRegistry(reg: JsonApiRegistry): void {
  const problems: string[] = [];
  const same = (label: string, got: readonly string[], want: readonly string[]): void => {
    if (got.join(',') !== want.join(',')) problems.push(`${label}: parsed [${got.join(', ')}], platform [${want.join(', ')}]`);
  };
  const registered = reg.entities.filter((e) => e.via === 'registerEntity');
  same('unconditional registerEntity', registered.filter((e) => e.condition === null).map((e) => e.name), REGISTERED_ENTITIES);
  same('conditional registerEntity', registered.filter((e) => e.condition !== null).map((e) => e.name), [VARIATION_ENTITY]);
  same('config entities', reg.entities.filter((e) => e.via === 'config').map((e) => e.name), [CONTENTNAV_ENTITY]);
  same('publicMethods', reg.publicMethods, PUBLIC_METHODS);
  const missing = GENERIC_METHODS.filter((m) => !reg.publicMethods.some((p) => p.toLowerCase() === m.toLowerCase()));
  if (missing.length > 0) problems.push(`generic methods missing from publicMethods: ${missing.join(', ')}`);
  if (reg.aliases[CONTENTNAV_ENTITY.toLowerCase()] === undefined) problems.push(`processRequest maps no alias for ${CONTENTNAV_ENTITY}`);
  if (problems.length > 0) throw new Error(`${JSON_API_PATH} differs from the pinned JSON API:\n- ${problems.join('\n- ')}`);
}

/** Calls the walk cannot follow on the dynamically addressed entity, bound to the entity's own component. */
interface EntityBinding {
  roots: Root[];
  ormWrites: ClosureWrite[];
  conditional: string | null;
  /** Matches unresolved-call expressions on the addressed entity, which the binding stands for. */
  receivers: RegExp;
}

const DYNAMIC_BEAN = String.raw`(?:\$\s*\.\s*)?getBean\(\s*(?:arguments\.)?entityName\s*\)`;
const PERSIST_METHOD = /^(save|delete\w*)$/i;

/** Table pattern of the entities declared at runtime (`tentity` and plugin declarations), as the table inventory names it. */
export const DECLARED_ENTITY_TABLES = 'tentity-declared:*';

/** The schema write a method makes by calling `checkSchema()` on the request-named bean: static tables already match, declared ones may not. */
function dynamicSchemaWrites(fn: CfmlFunction, unit: CfmlComponent): ClosureWrite[] {
  const at = dynamicEntityCalls(fn).calls.get('checkschema');
  if (at === undefined) return [];
  const line = lineOf(unit.text, at);
  return [
    {
      table: DECLARED_ENTITY_TABLES,
      op: 'update',
      component: unit.path,
      method: fn.name,
      source: ref(unit.path, line, line),
      trigger: 'request',
      whereParams: [],
      conditional: false,
      columns: null,
      via: [viaLabel(unit.path, fn.name)],
      dynamic: true,
    },
  ];
}

/** Method calls `fn` makes on `getBean(arguments.entityName)` and on the locals assigned from it, first offset each. */
function dynamicEntityCalls(fn: CfmlFunction): { vars: string[]; calls: Map<string, number> } {
  const body = fn.body;
  const vars = [...body.matchAll(new RegExp(String.raw`\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*${DYNAMIC_BEAN}`, 'gi'))].map((m) => m[1] ?? '');
  const heads = [DYNAMIC_BEAN, ...vars.map((v) => String.raw`(?<![\w$.])${v.replace(/\$/g, '\\$')}(?![\w$])`)];
  const calls = new Map<string, number>();
  for (const m of body.matchAll(new RegExp(heads.join('|'), 'gi'))) {
    let i = (m.index ?? 0) + m[0].length;
    for (;;) {
      const member = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*/.exec(body.slice(i, i + 200));
      if (member === null) break;
      i += member[0].length;
      if (body[i] !== '(') continue;
      const name = member[1] ?? '';
      if (!calls.has(name.toLowerCase())) calls.set(name.toLowerCase(), fn.offset + i);
      i = matchBracket(body, i) + 1;
    }
  }
  return { vars, calls };
}

const REQUEST_VALUES = /^\s*\$\s*\.\s*event\s*\(\s*\)\s*\.\s*getAllValues\s*\(\s*\)\s*$/i;
const QUOTED_KEY = /^\s*(["'])([\w$]+)\1\s*$/;

/** The lower-cased keys a key expression of `fn` may name: a quoted key, or a local only ever assigned quoted keys. */
function keyNames(fn: CfmlFunction, expr: string): string[] | null {
  const quoted = QUOTED_KEY.exec(expr)?.[2];
  if (quoted !== undefined) return [quoted.toLowerCase()];
  const local = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(expr)?.[1];
  if (local === undefined) return null;
  const out: string[] = [];
  const at = local.replace(/\$/g, '\\$');
  for (const m of stripComments(fn.body).matchAll(new RegExp(String.raw`(?:^|[;{}])\s*(?:var\s+)?${at}\s*=(?!=)\s*([^;\n]*)`, 'gi'))) {
    const rhs = (m[1] ?? '').trim();
    const key = QUOTED_KEY.exec(rhs)?.[2];
    // The entity's own primary key is a property the bean declares, so it adds no key of the request's.
    if (key === undefined && !/^[A-Za-z_$][\w$]*\s*\.\s*getPrimaryKey\s*\(\s*\)$/i.test(rhs)) return null;
    if (key !== undefined) out.push(key.toLowerCase());
  }
  return out;
}

/**
 * For each persistence method `fn` calls on the addressed entity, the keys beyond the request's that the entity holds
 * when every such call runs on it right after `set($.event().getAllValues())` (setters it chains in between, and keys
 * `fn` sets on the request with `$.event('k', v)`); undefined for a method one of whose calls may run otherwise.
 */
export function requestPopulations(fn: CfmlFunction): Map<string, string[] | undefined> {
  const body = stripComments(fn.body);
  const { vars } = dynamicEntityCalls(fn);
  const heads = [DYNAMIC_BEAN, ...vars.map((v) => String.raw`(?<![\w$.])${v.replace(/\$/g, '\\$')}(?![\w$])`)];
  const eventKeys: string[] = [];
  let eventKnown = true;
  for (const m of body.matchAll(/\$\s*\.\s*event\s*\(/gi)) {
    const open = m.index + m[0].length - 1;
    const args = splitTopLevel(body.slice(open + 1, matchBracket(body, open)));
    if (args.length < 2) continue;
    const keys = keyNames(fn, args[0] ?? '');
    if (keys === null) eventKnown = false;
    else eventKeys.push(...keys);
  }
  const out = new Map<string, string[] | undefined>();
  let populated = false;
  let set: string[] = [];
  for (const m of body.matchAll(new RegExp(heads.join('|'), 'gi'))) {
    // A new `getBean(entityName)` starts from a bean the request has not populated.
    if (!vars.some((v) => v.toLowerCase() === m[0].toLowerCase())) populated = false;
    let i = m.index + m[0].length;
    for (;;) {
      const member = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*/.exec(body.slice(i, i + 200));
      if (member === null || body[i + member[0].length] !== '(') break;
      const name = (member[1] ?? '').toLowerCase();
      const open = i + member[0].length;
      const close = matchBracket(body, open);
      const args = splitTopLevel(body.slice(open + 1, close));
      i = close + 1;
      if (name === 'set' && args.length === 1) {
        populated = REQUEST_VALUES.test(args[0] ?? '');
        set = [];
      } else if (/^(load\w*|init|setallvalues)$/.test(name)) {
        populated = false;
      } else if (name === 'set' || name === 'setvalue') {
        const keys = keyNames(fn, args[0] ?? '');
        if (keys === null) populated = false;
        else set.push(...keys);
      } else if (/^set[\w$]+$/.test(name)) {
        set.push(name.slice('set'.length));
      } else if (PERSIST_METHOD.test(name)) {
        const prev = out.has(name) ? out.get(name) : [];
        out.set(name, populated && eventKnown && prev !== undefined ? [...new Set([...prev, ...set, ...eventKeys])].sort(compareText) : undefined);
      }
    }
  }
  return out;
}

/** Top-level comma-separated parts of an argument list, skipping strings and brackets. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (ch === '"' || ch === "'") i = skipString(text, i) - 1;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  if (text.trim() !== '') parts.push(text.slice(from));
  return parts;
}

/** Binds the persistence calls `fn` makes on the addressed entity to `component`, the bean the entity name resolves to. */
function bindEntity(w: Walker, fn: CfmlFunction, component: string | null, entity: string, primary: string): EntityBinding {
  const { vars, calls } = dynamicEntityCalls(fn);
  const receivers = new RegExp(String.raw`^(?:${[DYNAMIC_BEAN, ...vars.map((v) => v.replace(/\$/g, '\\$'))].join('|')})\s*\.`, 'i');
  if (component === null) return { roots: [], ormWrites: [], conditional: `no bean is registered as ${entity}`, receivers };
  const roots: Root[] = [];
  const ormWrites: ClosureWrite[] = [];
  let conditional: string | null = null;
  const text = w.tree.readText(JSON_API_PATH);
  const populations = requestPopulations(fn);
  for (const [lower, offset] of calls) {
    if (!PERSIST_METHOD.test(lower)) continue;
    const found = findInChain(w, component, lower);
    if (found === null) {
      if (lower === primary.toLowerCase()) conditional = `${path.posix.basename(component, '.cfc')} defines no ${primary}; the call raises an error`;
      continue;
    }
    const populated = populations.get(lower);
    roots.push(populated === undefined ? { component, method: found.fn.name } : { component, method: found.fn.name, populated });
    const table = w.index.ormTable(component);
    if (table !== null && (lower === 'save' || lower === 'delete')) {
      const line = lineOf(text, offset);
      const op = lower === 'save' ? 'save' : 'delete';
      ormWrites.push({
        table,
        op,
        component,
        method: found.fn.name,
        source: ref(JSON_API_PATH, line, line),
        trigger: 'request',
        whereParams: [],
        conditional: false,
        columns: null,
        via: [viaLabel(JSON_API_PATH, fn.name), viaLabel(found.unit.path, found.fn.name)],
      });
    }
  }
  return { roots, ormWrites, conditional, receivers };
}

/** Roots for `getServiceFactory().<method>(…)` calls, bound to the bean factory component start-up instantiates. */
function serviceFactoryRoots(w: Walker, fn: CfmlFunction): Root[] {
  const calls = [...fn.body.matchAll(/\bgetServiceFactory\(\s*\)\s*\.\s*(\w+)\s*\(/gi)].map((m) => m[1] ?? '');
  if (calls.length === 0) return [];
  const dotted = /\bvariables\.serviceFactory\s*=\s*new\s+([\w.]+)\s*\(/i.exec(w.tree.readText(STARTUP_PATH))?.[1];
  const factory = dotted === undefined ? null : resolveComponentPath(dotted, STARTUP_PATH, w.tree);
  if (factory === null) throw new Error(`${STARTUP_PATH}: no variables.serviceFactory=new <component>(…) start-up assignment`);
  return [...new Set(calls.map((c) => c.toLowerCase()))].flatMap((c) => {
    const found = findInChain(w, factory, c);
    return found === null ? [] : [{ component: factory, method: found.fn.name }];
  });
}

/** An entity component with the remote functions `application.objectMappings` records for it (bean.cfc:777-795). */
export interface RemoteFunctionEntity {
  key: string;
  component: string;
  /** Core module whose `model/beans` registers the component per site; null for a start-up bean. */
  module: string | null;
  functions: Array<{ unit: string; fn: CfmlFunction }>;
}

const REMOTE_TEXT = /\baccess\s*=\s*["']remote["']|\bremote\s+(?:[\w.]+\s+)?function\b/i;

/** The `objectMappings` key of an entity component: its `variables.entityName` literal or `entityname` attribute. */
function entityKeyOf(w: Walker, chain: readonly string[]): string {
  for (const p of chain) {
    const unit = w.index.parsed(p);
    const literal = unit === null ? undefined : /\bvariables\.entityName\s*=\s*['"](\w+)['"]/i.exec(unit.text)?.[1];
    const attr = unit?.declaration.attrs.entityname;
    if (literal !== undefined) return literal;
    if (attr !== undefined && attr !== '') return attr;
  }
  return path.posix.basename(chain[0] ?? '', '.cfc').replace(/Bean$/i, '');
}

/** Entities whose components declare or inherit `remote` functions the JSON API invokes on `/<entity>/<id>/<function>`. */
function remoteFunctionEntities(w: Walker, served: readonly string[]): RemoteFunctionEntity[] {
  const candidates = new Set<string>();
  for (const name of served) {
    const p = w.index.resolveBean(name);
    if (p !== null) candidates.add(p);
  }
  for (const p of w.tree.list(MODULE_ROOT, { ext: ['cfc'], recursive: true })) if (/\/model\/beans\//.test(p)) candidates.add(p);
  for (const p of w.tree.list('core/mura', { ext: ['cfc'], recursive: true })) if (REMOTE_TEXT.test(w.tree.readText(p))) candidates.add(p);
  const out: RemoteFunctionEntity[] = [];
  for (const component of [...candidates].sort(compareText)) {
    const chain = chainOf(w, component);
    if (!chain.includes(BEAN_ROOT_PATH)) continue;
    const seen = new Set<string>();
    const functions: Array<{ unit: string; fn: CfmlFunction }> = [];
    for (const p of chain) {
      for (const fn of w.index.parsed(p)?.functions ?? []) {
        if (fn.access.toLowerCase() !== 'remote' || seen.has(fn.name.toLowerCase())) continue;
        seen.add(fn.name.toLowerCase());
        functions.push({ unit: p, fn });
      }
    }
    if (functions.length === 0) continue;
    const key = entityKeyOf(w, chain);
    const module = component.startsWith(`${MODULE_ROOT}/`) ? (component.split('/')[3] ?? null) : null;
    // A start-up bean is reachable only when the entity name resolves to this component.
    if (module === null && w.index.resolveBean(key) !== component) continue;
    out.push({ key, component, module, functions });
  }
  return out;
}

const API_FAMILIES = ['api', 'rest'] as const;
type ApiFamily = (typeof API_FAMILIES)[number];
const API_ENDPOINTS: Readonly<Record<ApiFamily, string>> = Object.freeze({ api: '/_api/json/v1', rest: '/_api/rest/v1' });

/** `<entity>/<id>/<suffix>` paths processRequest answers with a public method (jsonApiUtility.cfc:1011-1062). */
const PATH_OPERATIONS: ReadonlyArray<{ suffix: string; method: string; entities: readonly string[] }> = Object.freeze([
  { suffix: 'crumbs', method: 'findCrumbArray', entities: ['comment', 'content', 'category'] },
  { suffix: 'relatedcontent', method: 'findRelatedContent', entities: ['content'] },
  { suffix: 'history', method: 'findVersionHistory', entities: ['content'] },
]);

/** Display-object rendering calls whose output is CFML-rendered markup (processAsyncObject). */
const DISPLAY_RENDER = /\.\s*(?:dspObjects?|dspObject_include|dspContentTypeBody)\s*\(/i;

/** Branches of display-object templates under {@link MODULE_ROOT} that a `<cfif>` opens on a request parameter being set. */
function displayParamRoots(w: Walker, params: readonly string[]): Root[] {
  const roots: Root[] = [];
  if (params.length === 0) return roots;
  const names = params.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const test = new RegExp(`(?:event|getValue)\\s*\\(\\s*["'](?:${names})["']\\s*\\)`, 'i');
  for (const file of w.tree.list(MODULE_ROOT, { ext: ['cfm'], recursive: true })) {
    const raw = w.tree.readText(file);
    if (!test.test(raw)) continue;
    const text = stripComments(raw, 'tag');
    for (const m of text.matchAll(/<cfif\b/gi)) {
      const [clause] = cfifChain(text, m.index, text.length);
      if (clause?.cond === null || clause === undefined || !test.test(clause.cond)) continue;
      // `not len(event('x'))` opens on the parameter being absent.
      if (/(?:\bnot\b|!)\s*(?:len\s*\(\s*)?[\w$.()]*(?:event|getValue)\s*\(\s*["']/i.test(clause.cond)) continue;
      roots.push({ component: file, method: '', keep: [clause.bodyStart, clause.bodyEnd] });
    }
  }
  return roots;
}

type VariantBuilder = (key: string, branch: Branch, predicate: RoutePredicate | null, precedence: number) => RouteEntry;

/** The entry of a base key and one per declared variant, each keyed by the platform from a request that selects it. */
async function withVariants(b: BuildContext, entryPoint: RouteEntryPoint, baseKey: string, build: VariantBuilder): Promise<RouteEntry[]> {
  const decls = variantsFor(baseKey, b.variants);
  const out = [build(baseKey, branchOf(decls, -1), null, 0)];
  for (const [i, decl] of decls.entries()) {
    const expected = `${baseKey}{${normaliseInventoryKey(decl.variant)}}`;
    const sample = sampleOf(decl.when);
    if (sample === null) throw new Error(`variant ${expected} has a condition no request sample can satisfy`);
    const sampled = {
      ...behindFrontController(entryPoint, sample.frontController),
      params: { ...(entryPoint.params ?? {}), ...sample.params },
      multipartFileNames: [...(entryPoint.multipartFileNames ?? []), ...sample.files],
    } as RouteEntryPoint;
    const key = await b.key(sampled);
    if (key !== expected) throw new Error(`a request satisfying ${expected} keys to ${key}`);
    out.push(build(key, branchOf(decls, i), { variant: decl.variant, when: [...decl.when] }, i + 1));
  }
  return out;
}

/** A closure holding only the call-site ORM writes of a binding. */
function ormClosure(writes: readonly ClosureWrite[]): WriteClosure {
  return { ...emptyClosure(), tables: [...new Set(writes.flatMap((w) => (w.table === null ? [] : [w.table])))], writes: [...writes] };
}

/** `api:`/`rest:` entries: entity × generic method, the other public methods, their variants, entity-path operations and entity remote functions. */
async function apiEntries(b: BuildContext, reg: JsonApiRegistry, remote: readonly RemoteFunctionEntity[]): Promise<RouteEntry[]> {
  const unit = b.w.index.parsed(JSON_API_PATH) ?? parseUnit(b.w.tree, JSON_API_PATH);
  const out: RouteEntry[] = [];
  const rendered = displayCsrfCalls(b.w);
  const closureOf = (
    roots: readonly Root[],
    branch: Branch,
    keys: readonly string[],
    sessionless: boolean,
    extra: readonly WriteClosure[] = [],
    rendered: readonly CsrfCall[] = [],
  ): Partial<RouteEntry> => {
    const closure = mergeClosures([...roots.map((r) => walk(b.w, r, branch, keys)), ...extra]);
    return {
      ...closureFields(closure),
      roots: roots.map((r) => rootLabel(b.w, r)),
      ...entryCsrf(b.w, roots, closure, sessionless, undefined, rendered),
    };
  };
  for (const family of API_FAMILIES) {
    const sessionless = `${API_ENDPOINTS[family]}/`.toLowerCase().startsWith(b.sessionless.prefix.toLowerCase());
    const mode = FAMILY_MODES[family];

    for (const entity of reg.entities) {
      const served = reg.aliases[entity.name.toLowerCase()] ?? entity.name;
      const component = b.w.index.resolveBean(served);
      for (const method of GENERIC_METHODS) {
        const fn = functionOf(unit, method);
        const binding = bindEntity(b.w, fn, component, served, method);
        const own: Root = { component: JSON_API_PATH, method: fn.name, entryFunction: true };
        const jRoots: Root[] = [own];
        const self = reg.selfSave;
        if (self !== null && fn.name.toLowerCase() === 'save') {
          jRoots[0] = { ...own, drop: [self.span] };
          if (mode === self.mode && served.toLowerCase() === self.entityName.toLowerCase()) {
            jRoots.push({ ...own, keep: self.span, effect: 'relogin' });
          }
        }
        const roots = [...jRoots, ...binding.roots];
        const params = reg.entityParams[served.toLowerCase()];
        const assigned = params === undefined || Object.keys(params).length === 0 ? {} : { assignedParams: { ...params } };
        const conditions = [entity.condition === null ? null : `registered only when the ${entity.config ?? entity.condition} config is on`, binding.conditional];
        const conditional = conditions.filter((c): c is string => c !== null).join('; ') || null;
        const entryPoint: RouteEntryPoint = { kind: 'api', family, method, entity: entity.name };
        const baseKey = await b.key(entryPoint);
        const source = ref(JSON_API_PATH, fn.startLine, fn.endLine);
        out.push(
          ...(await withVariants(b, entryPoint, baseKey, (key, branch, predicate, precedence) => {
            const own = sessionlessUnder(sessionless, predicate);
            const facts = closureOf(roots, branch, [key, baseKey], own, [ormClosure(binding.ormWrites)]);
            // Calls on the addressed entity inside the method itself are bound above; deeper ones stay reported.
            const unresolved = (facts.unresolved ?? []).filter(
              (u) => !(u.source.path === JSON_API_PATH && u.source.lines[0] >= fn.startLine && u.source.lines[0] <= fn.endLine && binding.receivers.test(u.expr)),
            );
            return newEntry(
              { id: key, kind: 'api-entity-method', family, routeKey: key, source, areaKey: areaKeyOf(baseKey) },
              {
                ...facts,
                ...assigned,
                unresolved,
                entity: entity.name,
                method,
                httpMethods: reg.verbs[method.toLowerCase()] ?? [],
                predicate,
                precedence,
                conditional,
                sessionless: own,
              },
            );
          })),
        );
      }
    }

    for (const name of reg.publicMethods) {
      if (GENERIC_METHODS.some((g) => g.toLowerCase() === name.toLowerCase())) continue;
      const entryPoint: RouteEntryPoint = { kind: 'api', family, method: name };
      const platformKey = await b.key(entryPoint);
      const ownKey = normaliseInventoryKey(`${family}:${name}`);
      const area = areaKeyOf(ownKey);
      if (!reg.declared.has(name.toLowerCase())) {
        const routeKey = ownKey;
        out.push(
          newEntry(
            { id: routeKey, kind: 'api-method', family, routeKey, source: reg.publicMethodsSource, areaKey: area },
            {
              method: name,
              keyedAs: platformKey,
              sessionless,
              reachable: false,
              reason: `listed in publicMethods but jsonApiUtility defines no ${name} function, so the request keys to ${platformKey}`,
              csrfValidation: 'none',
            },
          ),
        );
        continue;
      }
      const fn = functionOf(unit, name);
      const roots: Root[] = [{ component: JSON_API_PATH, method: fn.name, entryFunction: true }, ...serviceFactoryRoots(b.w, fn)];
      const runtime = Object.entries(RUNTIME_METHODS).find(([m]) => m.toLowerCase() === name.toLowerCase())?.[1] ?? null;
      const render = DISPLAY_RENDER.exec(fn.body);
      const renderLine = render === null ? null : lineOf(unit.text, fn.offset + render.index);
      const rendersCfmlEvidence =
        runtime !== null ? ref(JSON_API_PATH, fn.startLine, fn.startLine) : renderLine === null ? null : ref(JSON_API_PATH, renderLine, renderLine);
      const source = ref(JSON_API_PATH, fn.startLine, fn.endLine);
      out.push(
        ...(await withVariants(b, entryPoint, platformKey, (key, branch, predicate, precedence) =>
          newEntry(
            { id: key, kind: 'api-method', family, routeKey: key, source, areaKey: area },
            {
              // A rendering method's variant also runs the display-object branches its parameters open (the form's saveform).
              ...closureOf(
                render === null ? roots : [...roots, ...displayParamRoots(b.w, Object.keys(branch.predicates ?? {}))],
                branch,
                [key, platformKey],
                sessionlessUnder(sessionless, predicate),
                [ormClosure(dynamicSchemaWrites(fn, unit))],
                render === null ? [] : rendered,
              ),
              method: name,
              predicate,
              precedence,
              sessionless: sessionlessUnder(sessionless, predicate),
              rendersCfml: rendersCfmlEvidence !== null,
              rendersCfmlEvidence,
              runtimeCategory: runtime,
            },
          ),
        )),
      );
    }

    // Entity-path operations key as `<entity>.<method>` and run the public method's closure; an undeclared method has
    // no path entry, its publicMethods entry already recording it as unreachable.
    for (const op of PATH_OPERATIONS) {
      if (!reg.declared.has(op.method.toLowerCase())) continue;
      const fn = functionOf(unit, op.method);
      const roots: Root[] = [{ component: JSON_API_PATH, method: fn.name, entryFunction: true }, ...serviceFactoryRoots(b.w, fn)];
      const source = ref(JSON_API_PATH, fn.startLine, fn.endLine);
      const area = areaKeyOf(`${family}:${op.method}`);
      for (const entity of op.entities) {
        const entryPoint: RouteEntryPoint = { kind: 'path', path: `${API_ENDPOINTS[family]}/default/${entity}/${SAMPLE_ID}/${op.suffix}` };
        const baseKey = await b.key(entryPoint);
        if (baseKey !== `${family}:${entity}.${op.method.toLowerCase()}`) throw new Error(`${entity}/<id>/${op.suffix} keys to ${baseKey}`);
        out.push(
          ...(await withVariants(b, entryPoint, baseKey, (key, branch, predicate, precedence) =>
            newEntry(
              { id: key, kind: 'api-entity-method', family, routeKey: key, source, areaKey: area },
              {
                ...closureOf(roots, branch, [key, baseKey], sessionless, [ormClosure(dynamicSchemaWrites(fn, unit))]),
                entity,
                method: op.method,
                predicate,
                precedence,
                sessionless,
              },
            ),
          )),
        );
      }
    }

    // Remote functions are routes of their own (`<entity>.~<fn>`): the gateway's route-key options are derived from these entries.
    for (const entity of remote) {
      for (const { unit: declaring, fn } of entity.functions) {
        const entryPoint: RouteEntryPoint = { kind: 'path', path: `${API_ENDPOINTS[family]}/default/${entity.key}/${SAMPLE_ID}/${fn.name}` };
        const baseKey = await b.key(entryPoint);
        if (!baseKey.endsWith(`.~${fn.name.toLowerCase()}`)) throw new Error(`remote function ${entity.key}.${fn.name} keys to ${baseKey}`);
        const roots: Root[] = [{ component: entity.component, method: fn.name }];
        const conditional =
          entity.module === null ? 'remote function registered in application.objectMappings' : `registered when the core ${entity.module} module model loads`;
        const source = ref(declaring, fn.startLine, fn.endLine);
        const webRoot = WEB_ROOT_COMPONENTS[entity.component] !== undefined;
        out.push(
          ...(await withVariants(b, entryPoint, baseKey, (key, branch, predicate, precedence) =>
            newEntry(
              { id: key, kind: 'api-entity-method', family, routeKey: key, source, areaKey: areaKeyOf(baseKey) },
              {
                ...closureOf(roots, branch, [key, baseKey], sessionlessUnder(sessionless, predicate)),
                entity: entity.key,
                method: fn.name,
                predicate,
                precedence,
                conditional,
                sessionless: sessionlessUnder(sessionless, predicate),
                webRootFilesystem: webRoot,
              },
            ),
          )),
        );
      }
    }
  }
  return out;
}

// OAuth endpoints and SOAP v1

/** The REST credential-exchange blocks of `processRequest` behind the OAuth endpoints (jsonApiUtility.cfc:422-835). */
export interface OAuthSpans {
  /** `if(isDefined('params.access_token')){…}`: Bearer tokens, including the token-info request. */
  bearer: Span;
  bearerSource: SourceRef;
  /** The final `else {…}`: client credentials and the token grants. */
  grant: Span;
  grantSource: SourceRef;
  /** Path segments the grant block answers, as its `listFind('oauth,oauth2', …)` tests them. */
  endpoints: string[];
  /** The path segment the Bearer block answers with token info, and the method it calls. */
  tokenInfo: { segment: string; method: string; source: SourceRef };
}

/** Parses the OAuth blocks of `processRequest` and the token-info method they call. */
export function parseOAuth(tree: SourceTree): OAuthSpans {
  const unit = parseUnit(tree, JSON_API_PATH);
  const { text } = unit;
  const [from, to] = bodySpan(functionOf(unit, 'processRequest'));
  const fail = (what: string): never => {
    throw new Error(`${JSON_API_PATH}: processRequest has no ${what}`);
  };
  const rest = /\bif\s*\(\s*!\s*request\.muraSessionManagement\s*\)\s*\{/i.exec(text.slice(from, to)) ?? fail('REST credential block');
  const restOpen = from + rest.index + rest[0].length - 1;
  const restClose = matchBracket(text, restOpen);
  const head = /\bif\s*\(\s*isDefined\(\s*'params\.access_token'\s*\)\s*\)\s*\{/i.exec(text.slice(restOpen, restClose)) ?? fail('Bearer token block');
  const chain = ifChain(text, restOpen + head.index) ?? fail('braced Bearer/grant chain');
  const bearer = chain.clauses[0];
  const grant = chain.clauses.at(-1);
  if (bearer === undefined || grant === undefined || grant.cond !== null || chain.clauses.length < 2) fail('Bearer … else grant chain');
  const bearerBody = text.slice(bearer?.open ?? 0, bearer?.close ?? 0);
  const grantBody = text.slice(grant?.open ?? 0, grant?.close ?? 0);
  const endpoints = /listFind\(\s*'([\w,]+)'\s*,\s*pathInfo\[\d+\]\s*\)/i.exec(grantBody)?.[1]?.split(',') ?? fail('oauth endpoint test in the grant block');
  const segment = /pathInfo\[\d+\]\s*==\s*'(\w+)'/i.exec(bearerBody)?.[1] ?? fail('token-info path test');
  const method = /\b(\w*TokenInfo)\s*\(/i.exec(bearerBody)?.[1] ?? fail('token-info call');
  const info = functionOf(unit, method);
  const span = (c: ScriptClause): Span => [c.open + 1, c.close];
  const lines = (c: ScriptClause): SourceRef => ref(JSON_API_PATH, lineOf(text, c.open), lineOf(text, c.close));
  return {
    bearer: span(bearer as ScriptClause),
    bearerSource: lines(bearer as ScriptClause),
    grant: span(grant as ScriptClause),
    grantSource: lines(grant as ScriptClause),
    endpoints,
    tokenInfo: { segment, method: info.name, source: ref(JSON_API_PATH, info.startLine, info.endLine) },
  };
}

/** One OAuth entry and one per declared variant (`<id>{<variant>}`), keyed through a REST request to its path. */
async function oauthEntry(b: BuildContext, id: string, entryPoint: RouteEntryPoint, source: SourceRef, roots: readonly Root[]): Promise<RouteEntry[]> {
  const baseKey = await b.key(entryPoint);
  const sessionless = entryPoint.kind === 'path' && entryPoint.path.toLowerCase().startsWith(b.sessionless.prefix.toLowerCase());
  const family = baseKey.slice(0, baseKey.indexOf(':')) as RouteFamily;
  return withVariants(b, entryPoint, baseKey, (key, branch, predicate, precedence) => {
    const own = sessionlessUnder(sessionless, predicate);
    return newEntry(
      { id: `${id}${key.slice(baseKey.length)}`, kind: 'oauth', family, routeKey: key, source, areaKey: areaKeyOf(baseKey) },
      { ...rootsClosure(b, roots, branch, [key, baseKey], own), predicate, precedence, sessionless: own },
    );
  });
}

/** `rte:` entries of the OAuth grant endpoints and the token-info endpoint. */
async function oauthEntries(b: BuildContext, spans: OAuthSpans): Promise<RouteEntry[]> {
  const rest = `${API_ENDPOINTS.rest}/default`;
  const grantRoot: Root = { component: JSON_API_PATH, method: 'processRequest', keep: spans.grant, entryFunction: true };
  const out: RouteEntry[] = [];
  for (const name of spans.endpoints) {
    out.push(...(await oauthEntry(b, OAUTH_IDS[name] ?? `rte:/${name}`, { kind: 'path', path: `${rest}/${name}/` }, spans.grantSource, [grantRoot])));
  }
  const { segment, method, source } = spans.tokenInfo;
  const tokenInfo: RouteEntryPoint = { kind: 'path', path: `${rest}/${segment}`, query: { access_token: 'sample', client_id: SAMPLE_ID } };
  out.push(
    ...(await oauthEntry(b, OAUTH_IDS[segment] ?? `rte:${segment}`, tokenInfo, source, [
      { component: JSON_API_PATH, method, entryFunction: true },
      { component: JSON_API_PATH, method: 'processRequest', keep: spans.bearer, entryFunction: true },
    ])),
  );
  return out;
}

/** The nearest `Application.cfc` above `file` and whether its `onRequestStart` aborts unconditionally. */
function requestGuard(tree: SourceTree, file: string): { path: string; aborts: boolean; source: SourceRef } | null {
  for (let dir = path.posix.dirname(file); dir !== '.' && dir !== ''; dir = path.posix.dirname(dir)) {
    const p = `${dir}/Application.cfc`;
    if (!tree.exists(p)) continue;
    const unit = parseUnit(tree, p);
    const fn = unit.functions.find((f) => f.name.toLowerCase() === 'onrequeststart');
    const stop = fn === undefined ? null : /\babort\b|<cfabort\b/i.exec(fn.body);
    const [from, to] = fn === undefined ? [0, 0] : bodySpan(fn);
    const conditional = fn !== undefined && stop !== null && (/<cfif\b/i.test(fn.body.slice(0, stop.index)) || enclosingIf(unit.text, from + stop.index, from, to) !== null);
    return { path: p, aborts: stop !== null && !conditional, source: ref(p, unit.declaration.line, lastLine(tree.readText(p))) };
  }
  return null;
}

/** First path segments `handleRootRequest` hands to `handleAPIRequest` (contentServer.cfc:783). */
function apiRootSegments(tree: SourceTree): string[] {
  const fn = functionOf(parseUnit(tree, CONTENT_SERVER_PATH), 'handleRootRequest');
  const list = /listFindNoCase\(\s*'([\w,]+)'\s*,\s*listFirst\(\s*path\s*,\s*'\/'\s*\)\s*\)/i.exec(fn.body)?.[1];
  if (list === undefined) throw new Error(`${CONTENT_SERVER_PATH}: handleRootRequest routes no path segments to handleAPIRequest`);
  return list.split(',').map((s) => s.toLowerCase());
}

/** `rte:soap:<name>` entries for the SOAP v1 components, with the routing and guard facts that make them unreachable. */
export function soapEntries(tree: SourceTree): RouteEntry[] {
  const segments = apiRootSegments(tree);
  return tree
    .list(SOAP_DIR, { ext: ['cfc'] })
    .filter((p) => path.posix.basename(p).toLowerCase() !== 'application.cfc')
    .map((p) => {
      const unit = parseUnit(tree, p);
      const name = path.posix.basename(p, '.cfc');
      const routed = segments.includes((p.split('/')[0] ?? '').toLowerCase());
      const guard = requestGuard(tree, p);
      const blocked = guard !== null && guard.aborts;
      const reasons = [
        routed ? 'routed by handleAPIRequest' : 'not routed by handleAPIRequest',
        blocked ? `blocked by ${path.posix.dirname(guard.path)} directory guard` : 'no directory guard aborts it',
      ];
      return newEntry(
        // Ids keep the committed inventory's `rte:soap:<name>` form, without a `v1` segment.
        { id: `rte:soap:${name}`, kind: 'soap', family: 'cfc', routeKey: null, source: ref(p, unit.declaration.line, lastLine(tree.readText(p))), areaKey: SOAP_AREA },
        {
          reachable: routed || !blocked,
          reason: reasons.join('; '),
          guard: guard === null ? null : `${guard.path}:${guard.source.lines[0]}-${guard.source.lines[1]}`,
        },
      );
    });
}

// Fixture routes

/** How the fixture front controller dispatches (api.cfm): modules, path grammar, module entry point and helpers. */
export interface FixtureController {
  modules: string[];
  minSegments: number;
  maxSegments: number;
  /** Dotted package of the module components, relative to the controller. */
  modulePackage: string;
  method: string;
  /** Helper components the controller creates and hands to every module, by variable name. */
  helpers: Readonly<Record<string, string>>;
}

/** Parses the fixture front controller's module list, segment grammar and `createObject(…).init(…).<method>(route)` dispatch. */
export function parseFixtureController(tree: SourceTree): FixtureController {
  const text = stripComments(tree.readText(FIXTURE_API_PATH));
  const fail = (what: string): never => {
    throw new Error(`${FIXTURE_API_PATH}: no ${what}`);
  };
  const modules = /\bvariables\.fixtureModules\s*=\s*"([^"]+)"/i.exec(text)?.[1] ?? fail('variables.fixtureModules list');
  const grammar = /segmentCount\s*>=\s*(\d+)\s*&&\s*variables\.segmentCount\s*<=\s*(\d+)/i.exec(text) ?? fail('segment-count grammar');
  const modulePackage = /createObject\(\s*"component"\s*,\s*"([\w.]+)\."\s*&\s*variables\.route\.module\s*\)/i.exec(text)?.[1] ?? fail('module createObject');
  const method = /\bvariables\.module\.(\w+)\(\s*variables\.route\s*\)/i.exec(text)?.[1] ?? fail('module dispatch call');
  const helpers: Record<string, string> = {};
  for (const m of text.matchAll(/\bvariables\.(\w+)\s*=\s*createObject\(\s*"component"\s*,\s*"([\w.]+)"\s*\)/gi)) helpers[m[1] ?? ''] = m[2] ?? '';
  return {
    modules: modules.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== ''),
    minSegments: Number(grammar[1]),
    maxSegments: Number(grammar[2]),
    modulePackage,
    method,
    helpers,
  };
}

/** Repository-relative path of a component the controller names by dotted path. */
function fixtureComponent(dotted: string): string {
  return `${FIXTURE_DIR}/${dotted.replace(/\./g, '/')}.cfc`;
}

class FixtureDispatchError extends Error {
  override name = 'FixtureDispatchError';
}

type Tok = { k: 'id' | 'str' | 'num' | 'op'; v: string; at: number };

const MULTI_OPS = ['&&', '||', '==', '!=', '<=', '>=', '&=', '+=', '-=', '++', '--'];

/** Script tokens of `text[from, to)`; offsets are absolute. */
function tokenize(text: string, from: number, to: number): Tok[] {
  const toks: Tok[] = [];
  for (let i = from; i < to; ) {
    const ch = text[i] ?? '';
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      toks.push({ k: 'str', v: unquote(text.slice(i, end)), at: i });
      i = end;
    } else if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 128))?.[0] ?? ch;
      toks.push({ k: 'id', v: m, at: i });
      i += m.length;
    } else if (/\d/.test(ch)) {
      const m = /^\d+(?:\.\d+)?/.exec(text.slice(i, i + 64))?.[0] ?? ch;
      toks.push({ k: 'num', v: m, at: i });
      i += m.length;
    } else {
      const op = MULTI_OPS.find((o) => text.startsWith(o, i)) ?? ch;
      toks.push({ k: 'op', v: op, at: i });
      i += op.length;
    }
  }
  return toks;
}

type Val = { k: 's'; v: string } | { k: 'n'; v: number } | { k: 'b'; v: boolean } | { k: 'o'; v: Map<string, Val> } | { k: 'u' };

type Expr =
  | { t: 'lit'; v: Val }
  | { t: 'ref'; path: string[]; at: number }
  | { t: 'call'; callee: string[]; args: Expr[]; at: number }
  | { t: 'not'; e: Expr }
  | { t: 'bin'; op: string; a: Expr; b: Expr; at: number }
  | { t: 'tern'; c: Expr; a: Expr; b: Expr };

type Stmt =
  | { t: 'block'; body: Stmt[] }
  | { t: 'if'; c: Expr; then: Stmt; else: Stmt | null; at: number }
  | { t: 'switch'; e: Expr; cases: Array<{ label: Expr | null; body: Stmt[] }>; at: number }
  | { t: 'return'; e: Expr | null; at: number }
  | { t: 'break' }
  | { t: 'assign'; target: string[]; op: '=' | '&='; e: Expr }
  | { t: 'expr'; e: Expr };

const UNKNOWN: Val = { k: 'u' };
const WORD_OPS: Readonly<Record<string, string>> = { eq: '==', neq: '!=', and: '&&', or: '||' };

/** Recursive-descent parser for the CFScript a fixture `handle` dispatcher uses; anything else is an error. */
class ScriptParser {
  private i = 0;

  constructor(
    private readonly toks: readonly Tok[],
    private readonly where: (at: number) => string,
  ) {}

  statements(): Stmt[] {
    const out: Stmt[] = [];
    while (this.i < this.toks.length) out.push(this.statement());
    return out;
  }

  private peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }

  private isOp(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t?.k === 'op' && t.v === v;
  }

  private isWord(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t?.k === 'id' && t.v.toLowerCase() === v;
  }

  private fail(what: string): never {
    throw new FixtureDispatchError(`${this.where(this.peek()?.at ?? this.toks.at(-1)?.at ?? 0)}: ${what}`);
  }

  private expect(v: string): void {
    if (!this.isOp(v)) this.fail(`expected ${v}`);
    this.i++;
  }

  private statement(): Stmt {
    const t = this.peek() ?? this.fail('unexpected end of dispatcher');
    if (this.isOp('{')) {
      this.i++;
      const body: Stmt[] = [];
      while (!this.isOp('}')) body.push(this.statement());
      this.i++;
      return { t: 'block', body };
    }
    if (this.isOp(';')) {
      this.i++;
      return { t: 'block', body: [] };
    }
    if (this.isWord('if')) {
      this.i++;
      this.expect('(');
      const c = this.expr();
      this.expect(')');
      const then = this.statement();
      let otherwise: Stmt | null = null;
      if (this.isWord('else')) {
        this.i++;
        otherwise = this.statement();
      }
      return { t: 'if', c, then, else: otherwise, at: t.at };
    }
    if (this.isWord('switch')) {
      this.i++;
      this.expect('(');
      const e = this.expr();
      this.expect(')');
      this.expect('{');
      const cases: Array<{ label: Expr | null; body: Stmt[] }> = [];
      while (!this.isOp('}')) {
        let label: Expr | null = null;
        if (this.isWord('case')) {
          this.i++;
          label = this.expr();
        } else if (this.isWord('default')) {
          this.i++;
        } else {
          this.fail('expected case or default');
        }
        this.expect(':');
        const body: Stmt[] = [];
        while (!this.isWord('case') && !this.isWord('default') && !this.isOp('}')) body.push(this.statement());
        cases.push({ label, body });
      }
      this.i++;
      return { t: 'switch', e, cases, at: t.at };
    }
    if (this.isWord('return')) {
      this.i++;
      const e = this.isOp(';') ? null : this.expr();
      this.expect(';');
      return { t: 'return', e, at: t.at };
    }
    if (this.isWord('break')) {
      this.i++;
      this.expect(';');
      return { t: 'break' };
    }
    if (['for', 'while', 'do', 'try', 'function', 'throw'].some((w) => this.isWord(w))) this.fail(`unsupported ${t.v} statement`);
    const local = this.isWord('var');
    if (local) this.i++;
    const e = this.expr();
    if (this.isOp('=') || this.isOp('&=')) {
      const op = this.peek()?.v === '=' ? '=' : '&=';
      if (e.t !== 'ref') this.fail('assignment to a non-variable');
      this.i++;
      const value = this.expr();
      this.expect(';');
      return { t: 'assign', target: local ? ['local', ...e.path] : e.path, op, e: value };
    }
    this.expect(';');
    return { t: 'expr', e };
  }

  private expr(): Expr {
    const c = this.or();
    if (!this.isOp('?')) return c;
    this.i++;
    const a = this.expr();
    this.expect(':');
    return { t: 'tern', c, a, b: this.expr() };
  }

  private binary(next: () => Expr, ops: readonly string[]): Expr {
    let a = next();
    for (;;) {
      const t = this.peek();
      const op = t?.k === 'op' ? t.v : t?.k === 'id' ? WORD_OPS[t.v.toLowerCase()] : undefined;
      if (t === undefined || op === undefined || !ops.includes(op)) return a;
      this.i++;
      a = { t: 'bin', op, a, b: next(), at: t.at };
    }
  }

  private or(): Expr {
    return this.binary(() => this.and(), ['||']);
  }

  private and(): Expr {
    return this.binary(() => this.compare(), ['&&']);
  }

  private compare(): Expr {
    return this.binary(() => this.concat(), ['==', '!=', '<', '>', '<=', '>=']);
  }

  private concat(): Expr {
    return this.binary(() => this.unary(), ['&']);
  }

  private unary(): Expr {
    if (this.isOp('!') || this.isWord('not')) {
      this.i++;
      return { t: 'not', e: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    const t = this.peek() ?? this.fail('unexpected end of expression');
    if (t.k === 'str') {
      this.i++;
      return { t: 'lit', v: /#[^#]/.test(t.v.replace(/##/g, '')) ? UNKNOWN : { k: 's', v: t.v.replace(/##/g, '#') } };
    }
    if (t.k === 'num') {
      this.i++;
      return { t: 'lit', v: { k: 'n', v: Number(t.v) } };
    }
    if (this.isOp('(')) {
      this.i++;
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (this.isOp('[') || this.isOp('{')) {
      const close = this.isOp('[') ? ']' : '}';
      for (let depth = 0; this.i < this.toks.length; this.i++) {
        const v = this.peek()?.v;
        if (v === '[' || v === '{') depth++;
        if (v === ']' || v === '}') depth--;
        if (depth === 0 && v === close) break;
      }
      this.i++;
      return { t: 'lit', v: UNKNOWN };
    }
    if (t.k !== 'id') this.fail(`unexpected ${t.v}`);
    this.i++;
    const lower = t.v.toLowerCase();
    if (lower === 'true' || lower === 'false') return { t: 'lit', v: { k: 'b', v: lower === 'true' } };
    const pathParts = [t.v];
    for (;;) {
      if (this.isOp('.') && this.peek(1)?.k === 'id') {
        pathParts.push(this.peek(1)?.v ?? '');
        this.i += 2;
      } else if (this.isOp('(')) {
        this.i++;
        const args: Expr[] = [];
        while (!this.isOp(')')) {
          if (this.peek(1)?.k === 'op' && this.peek(1)?.v === '=' && this.peek()?.k === 'id') this.i += 2;
          args.push(this.expr());
          if (this.isOp(',')) this.i++;
        }
        this.i++;
        const call: Expr = { t: 'call', callee: pathParts, args, at: t.at };
        // A member access or call on a call result is opaque to the dispatcher model.
        if (this.isOp('.') || this.isOp('(') || this.isOp('[')) {
          while (this.isOp('.') || this.isOp('(') || this.isOp('[')) {
            if (this.isOp('.')) this.i += 2;
            else this.skipGroup();
          }
          return { t: 'lit', v: UNKNOWN };
        }
        return call;
      } else if (this.isOp('[')) {
        this.skipGroup();
        return { t: 'lit', v: UNKNOWN };
      } else {
        return { t: 'ref', path: pathParts, at: t.at };
      }
    }
  }

  private skipGroup(): void {
    const open = this.peek()?.v ?? '';
    const close = CLOSERS[open] ?? '';
    for (let depth = 0; this.i < this.toks.length; this.i++) {
      const v = this.peek()?.v;
      if (v === open) depth++;
      if (v === close) depth--;
      if (depth === 0) break;
    }
    this.i++;
  }
}

type Outcome = { k: 'next' } | { k: 'break' } | { k: 'raise' } | { k: 'return'; handler: string | null; guards: string[] };

/** Unqualified functions called inside `args`, such as a `gate(…)` whose result the handler receives. */
function nestedCalls(args: readonly Expr[]): string[] {
  const out: string[] = [];
  const visit = (e: Expr): void => {
    if (e.t === 'call') {
      if (e.callee.length === 1 && e.callee[0] !== undefined) out.push(e.callee[0]);
      e.args.forEach(visit);
    } else if (e.t === 'not') visit(e.e);
    else if (e.t === 'bin') [e.a, e.b].forEach(visit);
    else if (e.t === 'tern') [e.c, e.a, e.b].forEach(visit);
  };
  args.forEach(visit);
  return [...new Set(out)];
}

const NEXT: Outcome = { k: 'next' };

function str(v: string): Val {
  return { k: 's', v };
}

/** Evaluates a parsed fixture dispatcher over one candidate route, as ColdFusion would. */
class DispatchEvaluator {
  private local = new Map<string, Val>();

  constructor(
    private readonly args: Map<string, Val>,
    private readonly variables: Map<string, Val>,
    private readonly where: (at: number) => string,
  ) {}

  run(body: readonly Stmt[]): Outcome {
    this.local = new Map();
    return this.block(body);
  }

  private block(body: readonly Stmt[]): Outcome {
    for (const s of body) {
      const o = this.exec(s);
      if (o.k !== 'next') return o;
    }
    return NEXT;
  }

  private exec(s: Stmt): Outcome {
    switch (s.t) {
      case 'block':
        return this.block(s.body);
      case 'if':
        if (this.truthy(this.eval(s.c), s.at)) return this.exec(s.then);
        return s.else === null ? NEXT : this.exec(s.else);
      case 'switch': {
        const v = this.text(this.eval(s.e), s.at);
        let start = s.cases.findIndex((c) => c.label !== null && this.text(this.eval(c.label), s.at).toLowerCase() === v.toLowerCase());
        if (start < 0) start = s.cases.findIndex((c) => c.label === null);
        if (start < 0) return NEXT;
        for (const c of s.cases.slice(start)) {
          const o = this.block(c.body);
          if (o.k === 'break') return NEXT;
          if (o.k !== 'next') return o;
        }
        return NEXT;
      }
      case 'return': {
        const call = s.e?.t === 'call' && s.e.callee.length === 1 ? s.e : null;
        return { k: 'return', handler: call?.callee[0] ?? null, guards: call === null ? [] : nestedCalls(call.args) };
      }
      case 'break':
        return { k: 'break' };
      case 'assign': {
        const value = this.eval(s.e);
        const scope = s.target[0]?.toLowerCase() === 'variables' ? this.variables : this.local;
        const name = (s.target[0]?.toLowerCase() === 'local' || s.target[0]?.toLowerCase() === 'variables' ? s.target.slice(1) : s.target).join('.').toLowerCase();
        const current = scope.get(name) ?? str('');
        scope.set(name, s.op === '=' ? value : value.k === 'u' || current.k === 'u' ? UNKNOWN : str(this.text(current, 0) + this.text(value, 0)));
        return NEXT;
      }
      case 'expr':
        return s.e.t === 'call' && s.e.callee.at(-1)?.toLowerCase() === 'raise' ? { k: 'raise' } : NEXT;
    }
  }

  private lookup(p: readonly string[]): Val {
    const [head = '', ...rest] = p.map((s) => s.toLowerCase());
    let scope: Map<string, Val>;
    let names: string[];
    if (head === 'arguments') [scope, names] = [this.args, rest];
    else if (head === 'variables') [scope, names] = [this.variables, rest];
    else if (head === 'local') [scope, names] = [this.local, rest];
    else [scope, names] = [this.local.has(head) ? this.local : this.args.has(head) ? this.args : this.variables, [head, ...rest]];
    // Locals are stored by dotted name; struct values are walked a segment at a time.
    for (let n = names.length; n > 0; n--) {
      const direct = scope.get(names.slice(0, n).join('.'));
      if (direct === undefined) continue;
      let v: Val = direct;
      for (const seg of names.slice(n)) v = v.k === 'o' ? (v.v.get(seg) ?? UNKNOWN) : UNKNOWN;
      return v;
    }
    return UNKNOWN;
  }

  private eval(e: Expr): Val {
    switch (e.t) {
      case 'lit':
        return e.v;
      case 'ref':
        return this.lookup(e.path);
      case 'not':
        return { k: 'b', v: !this.truthy(this.eval(e.e), 0) };
      case 'tern':
        return this.truthy(this.eval(e.c), 0) ? this.eval(e.a) : this.eval(e.b);
      case 'bin':
        return this.binary(e);
      case 'call':
        return this.call(e);
    }
  }

  private binary(e: Extract<Expr, { t: 'bin' }>): Val {
    if (e.op === '&&') return { k: 'b', v: this.truthy(this.eval(e.a), e.at) && this.truthy(this.eval(e.b), e.at) };
    if (e.op === '||') return { k: 'b', v: this.truthy(this.eval(e.a), e.at) || this.truthy(this.eval(e.b), e.at) };
    const a = this.eval(e.a);
    const b = this.eval(e.b);
    if (e.op === '&') return a.k === 'u' || b.k === 'u' ? UNKNOWN : str(this.text(a, e.at) + this.text(b, e.at));
    const x = this.text(a, e.at);
    const y = this.text(b, e.at);
    const nx = Number(x);
    const ny = Number(y);
    const numeric = x.trim() !== '' && y.trim() !== '' && !Number.isNaN(nx) && !Number.isNaN(ny);
    const cmp = numeric ? nx - ny : compareText(x.toLowerCase(), y.toLowerCase());
    const result = { '==': cmp === 0, '!=': cmp !== 0, '<': cmp < 0, '>': cmp > 0, '<=': cmp <= 0, '>=': cmp >= 0 }[e.op];
    if (result === undefined) throw new FixtureDispatchError(`${this.where(e.at)}: unsupported operator ${e.op}`);
    return { k: 'b', v: result };
  }

  private call(e: Extract<Expr, { t: 'call' }>): Val {
    if (e.callee.length !== 1) return UNKNOWN;
    const args = e.args.map((a) => this.eval(a));
    const at = (n: number): string => this.text(args[n] ?? UNKNOWN, e.at);
    switch ((e.callee[0] ?? '').toLowerCase()) {
      case 'len':
        return { k: 'n', v: at(0).length };
      case 'listfind':
        return { k: 'n', v: at(0).split(',').indexOf(at(1)) + 1 };
      case 'listfindnocase':
        return { k: 'n', v: at(0).toLowerCase().split(',').indexOf(at(1).toLowerCase()) + 1 };
      case 'lcase':
        return str(at(0).toLowerCase());
      case 'ucase':
        return str(at(0).toUpperCase());
      case 'trim':
        return str(at(0).trim());
      default:
        return UNKNOWN;
    }
  }

  private text(v: Val, at: number): string {
    if (v.k === 's') return v.v;
    if (v.k === 'n') return String(v.v);
    if (v.k === 'b') return v.v ? 'true' : 'false';
    throw new FixtureDispatchError(`${this.where(at)}: the dispatcher depends on a value it cannot know`);
  }

  private truthy(v: Val, at: number): boolean {
    if (v.k === 'b') return v.v;
    if (v.k === 'n') return v.v !== 0;
    const s = this.text(v, at).trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
    if (s !== '' && !Number.isNaN(Number(s))) return Number(s) !== 0;
    throw new FixtureDispatchError(`${this.where(at)}: ${JSON.stringify(s)} is not a boolean`);
  }
}

/** String literals of a dispatcher's statements and expressions. */
function literalsOf(node: Stmt | Expr | readonly Stmt[], out: Set<string> = new Set(), refs: Set<string> = new Set()): { literals: Set<string>; refs: Set<string> } {
  const visit = (n: Stmt | Expr | null | undefined): void => {
    if (n === null || n === undefined) return;
    switch (n.t) {
      case 'lit':
        if (n.v.k === 's') out.add(n.v.v);
        return;
      case 'ref':
        refs.add(n.path.map((s) => s.toLowerCase()).join('.'));
        return;
      case 'call':
        n.args.forEach(visit);
        return;
      case 'not':
        visit(n.e);
        return;
      case 'bin':
        visit(n.a);
        visit(n.b);
        return;
      case 'tern':
        [n.c, n.a, n.b].forEach(visit);
        return;
      case 'block':
        n.body.forEach(visit);
        return;
      case 'if':
        [n.c, n.then, n.else].forEach(visit);
        return;
      case 'switch':
        visit(n.e);
        n.cases.forEach((c) => {
          visit(c.label);
          c.body.forEach(visit);
        });
        return;
      case 'return':
        visit(n.e);
        return;
      case 'assign':
        visit(n.e);
        return;
      case 'break':
      case 'expr':
        if (n.t === 'expr') visit(n.e);
        return;
    }
  };
  if (Array.isArray(node)) node.forEach(visit);
  else visit(node as Stmt | Expr);
  return { literals: out, refs };
}

/** A route the fixture controller dispatches to a module handler. */
export interface FixtureRoute {
  module: string;
  /** Path segments after the module; ids are the sample id. */
  segments: string[];
  httpMethod: string;
  handler: string;
  /** Functions of the module the dispatcher calls in the handler's arguments, such as `gate`. */
  guards: string[];
}

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const UNMATCHED = 'opt2-unmatched';

/** String variables a component's `init` assigns (`variables.x = "…";`), lower-cased by name. */
function initStrings(unit: CfmlComponent): Map<string, Val> {
  const out = new Map<string, Val>();
  const init = unit.functions.find((f) => f.name.toLowerCase() === 'init');
  for (const m of (init?.body ?? '').matchAll(/\bvariables\.(\w+)\s*=\s*("(?:[^"]|"")*"|'(?:[^']|'')*')\s*;/gi)) {
    out.set((m[1] ?? '').toLowerCase(), str(unquote(m[2] ?? '')));
  }
  return out;
}

/** Every route a module's dispatcher accepts, found by evaluating it over the routes its literals can form. */
export function fixtureModuleRoutes(tree: SourceTree, controller: FixtureController, module: string): FixtureRoute[] {
  const p = fixtureComponent(`${controller.modulePackage}.${module}`);
  const unit = parseUnit(tree, p);
  const fn = functionOf(unit, controller.method);
  const where = (at: number): string => `${p}:${lineOf(unit.text, at)}`;
  const [from, to] = bodySpan(fn);
  const body = new ScriptParser(tokenize(unit.text, from, to), where).statements();
  const variables = initStrings(unit);
  const { literals, refs } = literalsOf(body);
  const atoms = new Set<string>();
  for (const lit of literals) for (const piece of lit.split(/[\s:/+{}]+/)) if (piece !== '') atoms.add(piece.toLowerCase());
  for (const r of refs) {
    const v = r.startsWith('variables.') ? variables.get(r.slice('variables.'.length)) : undefined;
    if (v?.k === 's') for (const item of v.v.split(',')) if (item.trim() !== '') atoms.add(item.trim().toLowerCase());
  }
  const verbs = HTTP_VERBS.filter((v) => atoms.has(v.toLowerCase()));
  const names = [...atoms].filter((a) => !HTTP_VERBS.includes(a.toUpperCase())).sort(compareText);
  const accepts = (segments: readonly string[], httpMethod: string): { handler: string; guards: string[] } | null => {
    const [resource = '', id = '', action = '', tail = ''] = segments;
    const route = new Map<string, Val>(
      Object.entries({ module, resource, id, action, tail, httpmethod: httpMethod, siteid: '', method: '' }).map(([k, v]) => [k, str(v)]),
    );
    route.set('params', { k: 'o', v: new Map() });
    const args = new Map<string, Val>([['route', { k: 'o', v: route }]]);
    const o = new DispatchEvaluator(args, new Map(variables), where).run(body);
    if (o.k === 'return' && o.handler === null) throw new FixtureDispatchError(`${p}: a dispatcher branch returns something other than a handler call`);
    return o.k === 'return' && o.handler !== null ? { handler: o.handler, guards: o.guards } : null;
  };
  // Segments after the module are resource, id, action and tail (api.cfm), within the controller's segment counts.
  const shapes: string[][] = [];
  for (const resource of [...names, UNMATCHED]) {
    shapes.push([resource], [resource, SAMPLE_ID]);
    for (const action of [...names, UNMATCHED]) {
      shapes.push([resource, SAMPLE_ID, action]);
      for (const tail of [...names, SAMPLE_ID, UNMATCHED]) shapes.push([resource, SAMPLE_ID, action, tail]);
    }
  }
  const allowed = shapes.filter((s) => s.length + 1 >= controller.minSegments && s.length + 1 <= Math.min(controller.maxSegments, 5));
  const out: FixtureRoute[] = [];
  for (const httpMethod of verbs.length > 0 ? verbs : HTTP_VERBS) {
    const accepted = new Map<string, { handler: string; guards: string[] }>();
    for (const segments of allowed) {
      const target = accepts(segments, httpMethod);
      if (target !== null) accepted.set(segments.join('/'), target);
    }
    for (const [joined, { handler, guards }] of accepted) {
      const segments = joined.split('/');
      if (segments[0] === UNMATCHED || segments[2] === UNMATCHED) {
        throw new FixtureDispatchError(`${p}: ${handler} accepts any ${segments[0] === UNMATCHED ? 'resource' : 'action'} (${httpMethod})`);
      }
      const tail = segments[3];
      if (tail === UNMATCHED) continue;
      // A dispatcher that takes any tail treats it as an id: only the id form is a route of its own.
      if (tail !== undefined && tail !== SAMPLE_ID && accepted.get([...segments.slice(0, 3), UNMATCHED].join('/'))?.handler === handler) continue;
      out.push({ module, segments, httpMethod, handler, guards });
    }
  }
  return out;
}

/** The component index of the fixture tree: helper beans by the names the controller gives them. */
function fixtureIndex(tree: SourceTree, controller: FixtureController): ComponentIndex {
  const helpers = new Map(Object.entries(controller.helpers).map(([name, dotted]) => [name.toLowerCase(), fixtureComponent(dotted)]));
  const parsed = new Map<string, CfmlComponent | null>();
  return {
    resolveBean: (name) => helpers.get(name.toLowerCase()) ?? null,
    ormTable: () => null,
    parsed: (p) => {
      if (!parsed.has(p)) parsed.set(p, p.toLowerCase().endsWith('.cfc') && tree.exists(p) ? parseCfmlComponent(p, tree.readText(p)) : null);
      return parsed.get(p) ?? null;
    },
  };
}

/** Fixture SQL scripts: the procedures the module components execute and the program tables they create. */
export const FIXTURE_SQL_DIR = 'legacy-fixtures/sql';

/** sqlcmd variable `*.program.sql` scripts use for the per-program schema, and the schema `Program_<id>` tables fold to. */
export const PROGRAM_SCHEMA_VAR = '$(PROGRAM_SCHEMA)';
export const PROGRAM_SCHEMA_FOLD = 'Program_N';

/**
 * One write statement of a fixture procedure; `op` is `save` for a `MERGE`. `whereParams` are the lower-cased procedure
 * parameters its `WHERE` clause names, and `columns` the columns it names, null when it names none.
 */
export interface FixtureWrite {
  table: string;
  op: ClosureWrite['op'];
  source: SourceRef;
  whereParams: string[];
  columns: string[] | null;
}

/** A fixture stored procedure: the schema-qualified tables it writes, its write statements and the fixture procedures it executes. */
export interface FixtureProcedure {
  name: string;
  source: SourceRef;
  writes: string[];
  statements: FixtureWrite[];
  calls: string[];
}

/** Procedures and per-program tables of the fixture SQL scripts. */
export interface FixtureSql {
  procedures: FixtureProcedure[];
  /** Tables the scripts create in the per-program schema. */
  programTables: string[];
}

/** SQL text with `--` and block comments blanked (strings kept), so offsets and lines stay. */
export function blankSqlComments(sql: string): string {
  const out = sql.split('');
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "'") {
      for (i++; i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'"); i += sql[i] === "'" ? 2 : 1);
    } else if (sql.startsWith('--', i)) {
      for (; i < sql.length && sql[i] !== '\n'; i++) out[i] = ' ';
    } else if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      const stop = close < 0 ? sql.length : close + 2;
      for (; i < stop; i++) if (sql[i] !== '\n') out[i] = ' ';
      i--;
    }
  }
  return out.join('');
}

const SQL_NAME = String.raw`(?:\[[^\]]+\]|\$\(\w+\)|[A-Za-z_#][\w#$]*)`;
const SQL_QUALIFIED = new RegExp(String.raw`(${SQL_NAME})\s*\.\s*(${SQL_NAME})`, 'y');

/** A bracketed or bare SQL name as written; the program-schema variable folds to {@link PROGRAM_SCHEMA_FOLD}. */
function sqlName(raw: string): string {
  const bare = raw.replace(/^\[|\]$/g, '');
  return bare === PROGRAM_SCHEMA_VAR ? PROGRAM_SCHEMA_FOLD : bare;
}

/** Schema-qualified name starting at `at` and the offset just past it, or null when the text there is not one. */
function qualifiedSpanAt(text: string, at: number): { name: string; end: number } | null {
  SQL_QUALIFIED.lastIndex = at;
  const m = SQL_QUALIFIED.exec(text);
  return m === null ? null : { name: `${sqlName(m[1] ?? '')}.${sqlName(m[2] ?? '')}`, end: at + m[0].length };
}

/** Schema-qualified name starting at `at`, or null when the text there is not one. */
function qualifiedAt(text: string, at: number): string | null {
  return qualifiedSpanAt(text, at)?.name ?? null;
}

const SQL_WRITE = /\b(INSERT\s+(?:INTO\s+)?|UPDATE\s+|DELETE\s+(?:FROM\s+)?|MERGE\s+(?:INTO\s+)?)(?=[[\w$])/gi;

/** Write statements of a procedure whose `body` starts at offset `at` of `file`'s comment-blanked `text`; each ends at its `;` or the next write. */
function procedureStatements(file: string, text: string, at: number, body: string): FixtureWrite[] {
  const params = new Set([...(/^[\s\S]*?\bAS\b/i.exec(body)?.[0] ?? '').matchAll(/@(\w+)/g)].map((p) => (p[1] ?? '').toLowerCase()));
  const verbs = [...body.matchAll(SQL_WRITE)];
  return verbs.flatMap((m, i): FixtureWrite[] => {
    const target = qualifiedSpanAt(body, m.index + m[0].length);
    if (target === null) return [];
    const next = verbs[i + 1]?.index ?? body.length;
    const semi = body.indexOf(';', target.end);
    const rest = body.slice(target.end, semi >= 0 && semi < next ? semi : next);
    const where = /\bWHERE\b/i.exec(rest);
    const bound = where === null ? [] : [...rest.slice(where.index).matchAll(/@(\w+)/g)].map((p) => (p[1] ?? '').toLowerCase());
    const verb = (m[1] ?? '').slice(0, 6).toLowerCase();
    const op = verb === 'insert' || verb === 'update' || verb === 'delete' ? verb : 'save';
    return [
      {
        table: target.name,
        op,
        source: spanRef(file, text, at + m.index, at + target.end + rest.length),
        whereParams: [...new Set(bound.filter((p) => params.has(p)))],
        columns: op === 'save' ? null : sqlColumns(op, rest),
      },
    ];
  });
}

/** Parses the fixture SQL scripts in `tree`; empty when the tree holds none. */
export function parseFixtureSql(tree: SourceTree): FixtureSql {
  const drafts: Array<{ name: string; source: SourceRef; body: string; statements: FixtureWrite[] }> = [];
  const programTables = new Set<string>();
  for (const file of tree.list(FIXTURE_SQL_DIR, { ext: ['sql'], recursive: true })) {
    const text = blankSqlComments(tree.readText(file));
    for (const m of text.matchAll(new RegExp(String.raw`\bCREATE\s+TABLE\s+`, 'gi'))) {
      const name = qualifiedAt(text, (m.index ?? 0) + m[0].length);
      if (name?.startsWith(`${PROGRAM_SCHEMA_FOLD}.`) === true) programTables.add(name.slice(PROGRAM_SCHEMA_FOLD.length + 1));
    }
    const batches = [...text.matchAll(/^\s*GO\s*$/gim)].map((g) => g.index ?? 0);
    for (const m of text.matchAll(/\bCREATE\s+(?:OR\s+ALTER\s+)?PROC(?:EDURE)?\s+/gi)) {
      const at = (m.index ?? 0) + m[0].length;
      const name = qualifiedAt(text, at);
      if (name === null) throw new Error(`${file}:${lineOf(text, at)}: a fixture procedure must be schema-qualified`);
      const end = batches.find((g) => g > at) ?? text.length;
      const body = text.slice(at, end);
      drafts.push({ name, source: ref(file, lineOf(text, m.index ?? 0), lineOf(text, end)), body, statements: procedureStatements(file, text, at, body) });
    }
  }
  const bare = (q: string): string => q.slice(q.lastIndexOf('.') + 1).toLowerCase();
  const procedures = drafts.map((d): FixtureProcedure => {
    const writes = [...new Set(d.statements.map((s) => s.table))].sort(compareText);
    // A procedure that names another fixture procedure, in an EXEC or a dynamic statement it builds, executes it.
    const calls = drafts.filter((o) => o.name !== d.name && new RegExp(String.raw`\b${bare(o.name)}\b`, 'i').test(d.body)).map((o) => o.name);
    return { name: d.name, source: d.source, writes, statements: d.statements, calls: [...new Set(calls)].sort(compareText) };
  });
  return { procedures: procedures.sort((a, b) => compareText(a.name, b.name)), programTables: [...programTables].sort(compareText) };
}

/** Procedures a CFML `EXEC <reference>` reaches: by name, in the per-program schema when the reference's schema is an expression. */
function resolveProcedure(sql: FixtureSql, reference: string): FixtureProcedure[] {
  const cleaned = reference.replace(/[[\]]/g, '');
  const dot = cleaned.lastIndexOf('.');
  const name = cleaned.slice(dot + 1).toLowerCase();
  const schema = dot < 0 ? null : cleaned.slice(0, dot);
  return sql.procedures.filter((p) => {
    const [pSchema = '', pName = ''] = p.name.split('.');
    if (pName.toLowerCase() !== name) return false;
    if (schema === null) return true;
    return schema.includes('#') ? pSchema === PROGRAM_SCHEMA_FOLD : pSchema.toLowerCase() === schema.toLowerCase();
  });
}

/** `start` and the fixture procedures it executes, breadth-first, each with the procedure names that lead to it. */
function reachedProcedures(sql: FixtureSql, start: FixtureProcedure): Array<{ procedure: FixtureProcedure; path: string[] }> {
  const byName = new Map(sql.procedures.map((p) => [p.name, p]));
  const reached = [{ procedure: start, path: [start.name] }];
  const seen = new Set([start.name]);
  // The array iterator also yields the entries pushed while it runs.
  for (const { procedure, path: chain } of reached) {
    for (const c of procedure.calls) {
      const next = byName.get(c);
      if (next === undefined || seen.has(c)) continue;
      seen.add(c);
      reached.push({ procedure: next, path: [...chain, c] });
    }
  }
  return reached;
}

/** Tables a procedure writes, through the fixture procedures it executes. */
function procedureWrites(sql: FixtureSql, start: FixtureProcedure): string[] {
  return [...new Set(reachedProcedures(sql, start).flatMap((r) => r.procedure.writes))].sort(compareText);
}

/** An `EXEC` in a visited fixture function: the call, the procedures it resolves to, and the function as the walk visited it. */
interface ProcedureSite {
  call: ProcedureCall;
  targets: FixtureProcedure[];
  /** `component#method` as the closure's `visited` lists it. */
  visited: string;
  unitPath: string;
  method: string;
  line: number;
}

/** `EXEC` statements in the SQL strings of the visited fixture functions, with the procedures and writes they reach. */
function procedureSitesOf(w: Walker, visited: readonly string[], sql: FixtureSql): ProcedureSite[] {
  const sites: ProcedureSite[] = [];
  for (const v of visited) {
    const hash = v.lastIndexOf('#');
    const found = findInChain(w, v.slice(0, hash), v.slice(hash + 1));
    if (found === null) continue;
    for (const m of found.fn.body.matchAll(/\bEXEC(?:UTE)?\s+((?:\[?[#\w.]+\]?\.)?\[?\w+\]?)/gi)) {
      const line = lineOf(found.unit.text, found.fn.offset + (m.index ?? 0));
      const procedure = (m[1] ?? '').replace(/[[\]]/g, '');
      const targets = resolveProcedure(sql, procedure);
      const call: ProcedureCall = {
        procedure,
        source: ref(found.unit.path, line, line),
        resolved: targets.map((t) => t.name),
        writes: uniqueSorted(targets.flatMap((t) => procedureWrites(sql, t))),
      };
      sites.push({ call, targets, visited: v, unitPath: found.unit.path, method: found.fn.name, line });
    }
  }
  return sites;
}

/** Offsets spanning whole lines `first`..`last` of `text`. */
function linesSpan(text: string, [first, last]: readonly [number, number]): Span {
  const starts = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)];
  return [starts[first - 1] ?? text.length, starts[last] ?? text.length];
}

/** Functions an entry reaches outside its cfthread bodies (roots walked with the bodies dropped) and inside them (each body walked alone). */
function threadReach(w: Walker, roots: readonly Root[], closure: WriteClosure, keys: readonly string[]): { request: Set<string>; thread: Set<string> } {
  if (closure.threads.length === 0) return { request: new Set(closure.visited), thread: new Set() };
  const body = (t: ClosureThread): Span => linesSpan(w.tree.readText(t.component), t.source.lines);
  const outside = roots.flatMap((r) => {
    const drop = closure.threads.filter((t) => t.component === r.component).map(body);
    return walk(w, { ...r, drop: [...(r.drop ?? []), ...drop] }, {}, keys).visited;
  });
  const inside = closure.threads.flatMap((t) =>
    walk(w, { component: t.component, method: t.method, keep: body(t) }, {}, keys).visited.filter((v) => v !== `${t.component}#${t.method}`),
  );
  return { request: new Set(outside), thread: new Set(inside) };
}

/** Call path the closure records through the function labelled `label`, or the label alone when no evidence passes it. */
function pathThrough(closure: WriteClosure, label: string): string[] {
  for (const e of [...closure.writes, ...closure.unresolved, ...closure.fileStoreEvidence]) {
    const at = e.via.indexOf(label);
    if (at >= 0) return e.via.slice(0, at + 1);
  }
  return [label];
}

/**
 * One write per statement of every fixture procedure an `EXEC` site reaches, sourced at the statement in its SQL
 * script, under `thread` when the site runs in a cfthread body and `request` when it runs outside one.
 */
function procedureEvidence(w: Walker, roots: readonly Root[], closure: WriteClosure, sites: readonly ProcedureSite[], sql: FixtureSql, keys: readonly string[]): ClosureWrite[] {
  if (sites.length === 0) return [];
  const reach = threadReach(w, roots, closure, keys);
  return sites.flatMap((s) => {
    const owner = s.visited.slice(0, s.visited.lastIndexOf('#'));
    const inBody = closure.threads.some((t) => t.component === owner && t.method === s.method && t.source.lines[0] <= s.line && s.line <= t.source.lines[1]);
    const thread = inBody || reach.thread.has(s.visited);
    const triggers: Array<ClosureWrite['trigger']> = [...(!inBody && (reach.request.has(s.visited) || !thread) ? ['request' as const] : []), ...(thread ? ['thread' as const] : [])];
    const via = pathThrough(closure, viaLabel(s.unitPath, s.method));
    return s.targets.flatMap((start) =>
      reachedProcedures(sql, start).flatMap(({ procedure, path: chain }) =>
        procedure.statements.flatMap((st) =>
          triggers.map((trigger): ClosureWrite => ({
            table: st.table,
            op: st.op,
            component: st.source.path,
            method: '',
            source: st.source,
            trigger,
            whereParams: [...st.whereParams],
            conditional: false,
            columns: st.columns === null ? null : [...st.columns],
            via: [...via, ...chain],
          })),
        ),
      ),
    );
  });
}

/** Per-program tables written through a dynamic schema (`#arguments.schema#.<table>`), folded to `Program_N`, by the reference that names each. */
function programTableWrites(unresolved: readonly UnresolvedRef[], sql: FixtureSql): { tables: string[]; resolved: Map<UnresolvedRef, string> } {
  const resolved = new Map<UnresolvedRef, string>();
  for (const u of unresolved) {
    const m = u.kind === 'table' ? /^\[?#[^#]+#\]?\.\[?(\w+)\]?$/.exec(u.expr.trim()) : null;
    const table = m?.[1];
    const created = table === undefined ? undefined : sql.programTables.find((t) => t.toLowerCase() === table.toLowerCase());
    if (created !== undefined) resolved.set(u, `${PROGRAM_SCHEMA_FOLD}.${created}`);
  }
  return { tables: [...new Set(resolved.values())].sort(compareText), resolved };
}

/** A dynamic-schema write with the `Program_N` table its reference folds to; any other write unchanged. */
function foldProgramWrite(write: ClosureWrite, resolved: ReadonlyMap<UnresolvedRef, string>): ClosureWrite {
  if (write.table !== null || write.dynamic !== true) return write;
  const at = (u: UnresolvedRef): boolean => u.source.path === write.source.path && u.source.lines[0] === write.source.lines[0] && u.source.lines[1] === write.source.lines[1];
  const tables = new Set([...resolved].filter(([u]) => at(u)).map(([, t]) => t));
  const [table] = tables;
  if (table === undefined || tables.size > 1) return write;
  const { dynamic: _dynamic, ...rest } = write;
  return { ...rest, table };
}

/** Reads the fixture front controller, its components and the fixture SQL from the working tree; null when the controller is absent. */
export function loadFixtureTree(root: string = REPO_ROOT): SourceTree | null {
  if (!existsSync(path.join(root, FIXTURE_API_PATH))) return null;
  const files: Record<string, string> = {};
  const visit = (rel: string): void => {
    for (const d of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) visit(child);
      else if (d.isFile() && /\.(cfc|cfm|sql)$/i.test(d.name)) files[child] = readFileSync(path.join(root, child), 'utf8');
    }
  };
  visit(FIXTURE_DIR);
  if (existsSync(path.join(root, FIXTURE_SQL_DIR))) visit(FIXTURE_SQL_DIR);
  return memorySourceTree(files);
}

/** `fix:` entries of the fixture routes, carried to their module's service by definition. */
async function fixtureEntries(b: BuildContext, tree: SourceTree): Promise<RouteEntry[]> {
  const controller = parseFixtureController(tree);
  const w = walker(tree, fixtureIndex(tree, controller), undefined);
  const sql = parseFixtureSql(tree);
  const byKey = new Map<string, RouteEntry>();
  for (const module of controller.modules) {
    const owningService = FIXTURE_SERVICES[module];
    if (owningService === undefined) throw new Error(`${FIXTURE_API_PATH}: fixture module ${module} has no owning service`);
    const component = fixtureComponent(`${controller.modulePackage}.${module}`);
    const unit = parseUnit(tree, component);
    for (const route of fixtureModuleRoutes(tree, controller, module)) {
      const routeKey = await b.key({ kind: 'fixture', httpMethod: route.httpMethod, path: `${FIXTURE_PREFIX}/${[module, ...route.segments].join('/')}` });
      const fn = functionOf(unit, route.handler);
      const guards = route.guards.filter((g) => unit.functions.some((f) => f.name.toLowerCase() === g.toLowerCase()));
      const roots: Root[] = [{ component, method: fn.name }, ...guards.map((g) => ({ component, method: functionOf(unit, g).name }))];
      const closure = mergeClosures(roots.map((r) => walk(w, r, {}, [routeKey])));
      const sites = procedureSitesOf(w, closure.visited, sql);
      const procedureCalls = uniqueSorted(sites.map((s) => s.call));
      const program = programTableWrites(closure.unresolved, sql);
      const evidence = [...closure.writes.map((x) => foldProgramWrite(x, program.resolved)), ...procedureEvidence(w, roots, closure, sites, sql, [routeKey])];
      const csrf = entryCsrf(w, roots, closure, false, route.httpMethod);
      // A context naming a route segment the path lacks is the empty string the token is generated for.
      const segment = /^route\.(resource|id|action|tail)$/i.exec(csrf.csrfContext ?? '')?.[1]?.toLowerCase();
      const position = segment === undefined ? -1 : ['resource', 'id', 'action', 'tail'].indexOf(segment);
      if (position >= 0 && route.segments[position] === undefined) csrf.csrfContext = '';
      const entry = newEntry(
        { id: `fix:${routeKey.slice(routeKey.indexOf(':') + 1)}`, kind: 'fixture', family: 'fixture', routeKey, source: ref(component, fn.startLine, fn.endLine), areaKey: areaKeyOf(routeKey) },
        {
          ...closureFields(closure),
          writeSet: uniqueSorted([...closure.tables, ...program.tables, ...procedureCalls.flatMap((c) => c.writes)]),
          // Procedure and per-program writes are evidence too, so attachWriters records them on their tables.
          closureEvidence: uniqueSorted(evidence),
          unresolved: closure.unresolved.filter((u) => !program.resolved.has(u)),
          roots: roots.map((r) => rootLabel(w, r)),
          procedureCalls,
          method: fn.name,
          httpMethods: [route.httpMethod],
          fixtureModule: module,
          // Fixture routes are carried to their module's service by definition; the rule decides every other entry.
          owningService,
          disposition: 'carry',
          dispositionStep: 'fixture-definition',
          liveStatus: 'pending-run',
          ...csrf,
        },
      );
      const prior = byKey.get(routeKey);
      if (prior !== undefined && prior.method !== entry.method) {
        throw new Error(`${component}: ${routeKey} dispatches to both ${prior.method ?? ''} and ${entry.method ?? ''}`);
      }
      byKey.set(routeKey, entry);
    }
  }
  return [...byKey.values()];
}

// Extraction

/** Throws unless the JSON API default mode and the REST branch's mode are the ones {@link FAMILY_MODES} keys by. */
function assertModes(tree: SourceTree, branches: readonly FamilyBranch[], reg: JsonApiRegistry): void {
  const text = tree.readText(CONTENT_SERVER_PATH);
  const rest = branches.find((br) => br.row.family === 'rest');
  const restMode = rest === undefined ? undefined : /request\.muraAPIRequestMode\s*=\s*'(\w+)'/i.exec(text.slice(rest.bodyStart, rest.bodyEnd))?.[1];
  if (reg.defaultMode !== FAMILY_MODES.api || restMode !== FAMILY_MODES.rest) {
    throw new Error(`JSON API request modes are ${reg.defaultMode}/${restMode ?? 'unset'}, expected ${FAMILY_MODES.api}/${FAMILY_MODES.rest}`);
  }
}

/** `writes in cfthread (…)`: the functions that start each thread and those its body calls; null without threads. */
function threadNote(tree: SourceTree, threads: readonly ClosureThread[]): string | null {
  if (threads.length === 0) return null;
  const names: string[] = [];
  for (const t of threads) {
    names.push(t.method);
    const unit = tree.exists(t.component) ? parseCfmlComponent(t.component, tree.readText(t.component)) : null;
    if (unit === null) continue;
    const lines = unit.text.split('\n').slice(t.source.lines[0] - 1, t.source.lines[1]).join('\n');
    for (const m of lines.matchAll(/(?<![\w$.])(?:variables\.)?(\w+)\s*\(/gi)) {
      const fn = unit.functions.find((f) => f.name.toLowerCase() === (m[1] ?? '').toLowerCase());
      if (fn !== undefined) names.push(fn.name);
    }
  }
  return `writes in cfthread (${[...new Set(names)].join(', ')})`;
}

/** Counts per kind, as `counts.routes` of the inventory names them. */
export function countRoutes(routes: readonly RouteEntry[]): RouteCounts {
  const n = (kinds: readonly RouteKind[]): number => routes.filter((r) => kinds.includes(r.kind)).length;
  return {
    families: n(['api-family', 'job', 'static']),
    apiEntityMethods: n(['api-entity-method']),
    apiMethods: n(['api-method']),
    oauth: n(['oauth']),
    soap: n(['soap']),
    fixture: n(['fixture']),
  };
}

/** Builds `routes[]` from the archive tree, the component index and overrides, the variants and the working-tree fixtures. */
export async function extractRoutes(tree: SourceTree, opts: ExtractRoutesOptions): Promise<RouteExtraction> {
  const variants = opts.variants ?? (await loadInventoryVariants()).variants;
  const w = walker(tree, opts.index, opts.overrides);
  const branches = parseRouteFamilies(tree);
  const reg = parseJsonApi(tree);
  assertPinnedRegistry(reg);
  assertModes(tree, branches, reg);
  const served = [...new Set(reg.entities.map((e) => reg.aliases[e.name.toLowerCase()] ?? e.name))];
  const remote = remoteFunctionEntities(w, served);
  const entityRemoteFunctions: Record<string, string[]> = {};
  for (const r of remote) {
    const key = r.key.toLowerCase();
    entityRemoteFunctions[key] = [...new Set([...(entityRemoteFunctions[key] ?? []), ...r.functions.map((f) => f.fn.name.toLowerCase())])].sort(compareText);
  }
  const b: BuildContext = { w, key: keyerFor({ variants, entityRemoteFunctions }), variants, sessionless: parseSessionlessPrefix(tree) };
  const fixtureTree = opts.fixtureTree === undefined ? loadFixtureTree() : opts.fixtureTree;
  const routes = [
    ...(await familyEntries(b, branches)),
    ...(await oauthEntries(b, parseOAuth(tree))),
    ...(await apiEntries(b, reg, remote)),
    ...soapEntries(tree),
    ...(fixtureTree === null ? [] : await fixtureEntries(b, fixtureTree)),
  ];
  for (const r of routes) {
    if (r.conditional === null) r.conditional = threadNote(r.kind === 'fixture' && fixtureTree !== null ? fixtureTree : tree, r.threads);
  }
  const ids = new Set<string>();
  for (const r of routes) {
    if (ids.has(r.id)) throw new Error(`two routes[] entries share the id ${r.id}`);
    ids.add(r.id);
  }
  routes.sort((x, y) => compareText(x.id, y.id));
  return { routes, counts: countRoutes(routes), fixtureRoutesStatus: fixtureTree === null ? 'absent' : 'present', fixtureTree };
}
