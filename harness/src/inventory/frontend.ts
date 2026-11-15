// Public front-end entries of the legacy inventory (frontEnd[]): page render, doaction values, form submissions,
// remote CFC proxies, ajax endpoints and the application reload, with the facts disposition.ts decides from.
import path from 'node:path';
import {
  SAVEFORM_CONDITION,
  type RouteEntryPoint,
  type RouteKeyOptions,
  type VariantCondition,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import {
  computeClosure,
  detectMode,
  lineOf,
  parseAttributes,
  parseCfmTemplate,
  parseCfmlComponent,
  stripComments,
  type CfmlComponent,
  type CfmlFunction,
  type CfmlUnit,
  type ClosureContext,
  type ClosureEntry,
  type ClosureWrite,
  type ComponentIndex,
  type ConditionalWrite,
  type FileStoreEvidence,
  type ClosureThread,
  type Predicates,
  type SourceTree,
  type UnresolvedRef,
  type WriteClosure,
} from './closure.js';
import { inventoryRouteKey, loadInventoryVariants, variantsFor } from './route-keys.js';

/** Root front controller component and method of every page request [contentServer.cfc:779-799]. */
export const ROOT_REQUEST = Object.freeze({ path: 'core/mura/content/contentServer.cfc', method: 'handleRootRequest' });

/** Standard event handlers: the doAction switch and the handler, validator and translator methods. */
export const EVENTS_HANDLER_PATH = 'core/mura/Handler/standardEventsHandler.cfc';

/** Fallback components of translators the events handler does not define [pluginStandardEventFactory.cfc:150-155]. */
export const TRANSLATOR_DIR = 'core/mura/Translator';

/** Form display object holding the `saveform` submission branch [form/index.cfm:114-119]. */
export const FORM_TEMPLATE_PATH = 'core/modules/v1/form/index.cfm';

/** JSON API method that renders display objects asynchronously, form submissions included. */
export const ASYNC_OBJECT = Object.freeze({ path: 'core/mura/client/api/json/v1/jsonApiUtility.cfc', method: 'processAsyncObject' });

/** Display-object modules scanned for doaction comparisons and ajax endpoints. */
export const MODULES_ROOT = 'core/modules/v1';

/** Request start-up that re-runs application start-up for the reload key [onRequestStart_include.cfm:114-136]. */
export const REQUEST_START_PATH = 'core/appcfc/onRequestStart_include.cfm';

/** Application start-up template a reload re-runs. */
export const APP_START_PATH = 'core/appcfc/onApplicationStart_include.cfm';

const LINK_SCAN_ROOT = 'core';
const LINK_SCAN_EXCLUDE = 'core/vendor/';
const ADMIN_ROOT = 'admin';
const AJAX_TEMPLATE = /^core\/modules\/v1\/[^/]+\/ajax\/[^/]+\.cfm$/i;

/** Repository-relative file and inclusive 1-based line span. */
export type SourceRef = ClosureWrite['source'];

/** Change an entry makes to the session user's login state. */
export type SessionEffects = WriteClosure['sessionEffects'];

/** Reviewed writer overrides applied by the closure walk. */
export type FrontEndWriterOverrides = NonNullable<ClosureContext['overrides']>;

/** Kind of a front-end entry. */
export type FrontEndKind = 'page-render' | 'doaction' | 'form-submission' | 'remote-proxy' | 'ajax-endpoint' | 'reload';

/** Where a doaction value is read: a doAction case, a comparison that acts on it, or only a link or hidden input naming it. */
export type DoactionEvidence = 'handler-case' | 'comparison' | 'link';

/** Whether the entry's code checks a CSRF token: `bypassed` when every check is short-circuited by a constant. */
export type CsrfValidation = 'validates' | 'bypassed' | 'none';

/** A construct showing that code renders CFML output rather than returning data. */
export interface RenderEvidence {
  marker: 'include' | 'display-object' | 'content-renderer' | 'saved-output';
  source: SourceRef;
}

/** The variant a front-end entry is keyed with. */
export interface FrontEndPredicate {
  variant: string;
  when: VariantCondition[];
}

/** One public front-end entry point with the facts its disposition is decided from. */
export interface FrontEndEntry {
  /** In the committed inventory's forms: `fe:render`, `fe:doaction=<value>`, `fe:<component>.<method>`, `fe:<cfm route key>`. */
  id: string;
  kind: FrontEndKind;
  /** Legacy casing: the doaction value, proxy method, template file name or entry name. */
  name: string;
  entry: string;
  source: SourceRef;
  extraSources: SourceRef[];
  routeKey: string | null;
  unkeyed: boolean;
  predicate: FrontEndPredicate | null;
  doactionEvidence: DoactionEvidence | null;
  reachable: boolean;
  unreachableReason: string | null;
  rendersCfml: boolean;
  returnsDataOnly: boolean;
  renderEvidence: RenderEvidence[];
  writeSet: string[];
  fileStoreWrite: boolean;
  closure: WriteClosure;
  sessionEffects: SessionEffects;
  csrfContext: string | null;
  csrfValidation: CsrfValidation;
  trigger: 'request';
}

/** A remote method HTTP cannot reach because the nearest `Application.cfc` aborts the request. */
export interface UnreachableRemote {
  path: string;
  method: string;
  line: number;
  /** `<file>:<start>-<end>` of the aborting `onRequestStart`. */
  guard: string;
}

/** Result of {@link extractFrontEnd}; both arrays are sorted. */
export interface FrontEndExtraction {
  frontEnd: FrontEndEntry[];
  unreachableRemote: UnreachableRemote[];
}

/** Inputs of {@link extractFrontEnd}; `routeKeyOptions` defaults to the committed variants and static sites. */
export interface FrontEndOptions {
  index: ComponentIndex;
  overrides?: FrontEndWriterOverrides;
  routeKeyOptions?: RouteKeyOptions;
}

/** Whether HTTP can reach a file, and the guard that decides it. */
export interface HttpReachability {
  reachable: boolean;
  /** `<file>:<start>-<end>` of the nearest aborting `onRequestStart`; null when no ancestor aborts. */
  guard: string | null;
  /** Script names the guard lets through; null when no ancestor aborts. */
  allow: string[] | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Lexical helpers over comment-stripped CFML (offsets are those of the original text)
// ---------------------------------------------------------------------------------------------------------------

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSource(a: SourceRef, b: SourceRef): number {
  return compareText(a.path, b.path) || a.lines[0] - b.lines[0] || a.lines[1] - b.lines[1];
}

function span(file: string, from: number, to: number): SourceRef {
  return { path: file, lines: [from, Math.max(from, to)] };
}

/** Index just after the string literal opening at `at`: doubled quotes escape, `##` escapes, `#…#` may nest strings. */
function stringEnd(text: string, at: number): number {
  const quote = text.charAt(at);
  let j = at + 1;
  while (j < text.length) {
    const c = text.charAt(j);
    if (c === quote) {
      if (text.charAt(j + 1) !== quote) return j + 1;
      j += 2;
    } else if (c === '#') {
      if (text.charAt(j + 1) === '#') {
        j += 2;
        continue;
      }
      j++;
      while (j < text.length && text.charAt(j) !== '#') {
        const d = text.charAt(j);
        j = d === '"' || d === "'" ? stringEnd(text, j) : j + 1;
      }
      j++;
    } else {
      j++;
    }
  }
  return text.length;
}

/** Text of a quoted literal without its quotes, doubled quotes collapsed; undefined when `expr` is not one plain literal. */
function literalValue(expr: string): string | undefined {
  const t = expr.trim();
  const q = t.charAt(0);
  if ((q !== '"' && q !== "'") || stringEnd(t, 0) !== t.length) return undefined;
  const inner = t.slice(1, -1);
  return inner.replace(/##/g, '').includes('#') ? undefined : inner.split(q + q).join(q).replace(/##/g, '#');
}

function closerOf(c: string): string | undefined {
  return c === '(' ? ')' : c === '{' ? '}' : c === '[' ? ']' : undefined;
}

/** Index of the bracket closing the one at `open`, skipping string literals; -1 when unbalanced. */
function matching(text: string, open: number, to: number = text.length): number {
  const stack: string[] = [];
  let j = open;
  while (j < to) {
    const c = text.charAt(j);
    if (c === '"' || c === "'") {
      j = stringEnd(text, j);
      continue;
    }
    const closer = closerOf(c);
    if (closer !== undefined) stack.push(closer);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return j;
    }
    j++;
  }
  return -1;
}

/** Top-level comma-separated parts of an argument list. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let from = 0;
  let j = 0;
  while (j < args.length) {
    const c = args.charAt(j);
    if (c === '"' || c === "'") {
      j = stringEnd(args, j);
      continue;
    }
    if (closerOf(c) !== undefined) {
      const close = matching(args, j);
      j = close < 0 ? args.length : close + 1;
      continue;
    }
    if (c === ',') {
      out.push(args.slice(from, j));
      from = j + 1;
    }
    j++;
  }
  out.push(args.slice(from));
  return out.map((a) => a.trim()).filter((a) => a !== '');
}

/** Index just after the tag opening at `at`, skipping quoted attribute values. */
function tagEnd(text: string, at: number): number {
  let j = at + 1;
  while (j < text.length) {
    const c = text.charAt(j);
    if (c === '"' || c === "'") {
      j = stringEnd(text, j);
      continue;
    }
    if (c === '>') return j + 1;
    j++;
  }
  return text.length;
}

/** Attributes of the tag opening at `at` whose name is `nameLength` characters long (`<cfif` is 5). */
function tagAttributes(text: string, at: number, nameLength: number): Record<string, string> {
  const end = tagEnd(text, at);
  return parseAttributes(text.slice(at + nameLength, text.charAt(end - 2) === '/' ? end - 2 : end - 1));
}

/** `[from, to)` ranges of `text` in script syntax: the whole text, or every `<cfscript>` body of tag syntax. */
function scriptRanges(text: string): Array<[number, number]> {
  if (detectMode(text) === 'script') return [[0, text.length]];
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(/<cfscript\b/gi)) {
    const open = tagEnd(text, m.index);
    const close = text.slice(open).search(/<\/cfscript\s*>/i);
    out.push([open, close < 0 ? text.length : open + close]);
  }
  return out;
}

/** `<cfscript>` open and close tags of tag-syntax `text` around every script range holding one of `ranges`. */
function enclosingScriptTags(text: string, ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  if (detectMode(text) === 'script') return [];
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(/<cfscript\b/gi)) {
    const open = tagEnd(text, m.index);
    const close = text.slice(open).search(/<\/cfscript\s*>/i);
    const end = close < 0 ? text.length : open + close;
    if (ranges.some(([a, b]) => a >= open && b <= end)) out.push([m.index, open], [end, tagEnd(text, end)]);
  }
  return out;
}

/** A braced script block; `cond` is the condition of an `if`, `else` for an else block, '' for any other block. */
interface ScriptBlock {
  keyword: 'if' | 'else' | 'other';
  cond: string;
  start: number;
  open: number;
  close: number;
}

/** Script blocks of `[from, to)`, closed ones only; a braceless `if` body runs to its `;`. */
function scriptBlocks(text: string, from: number, to: number): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  const stack: ScriptBlock[] = [];
  let pending: Omit<ScriptBlock, 'open' | 'close'> | null = null;
  let j = from;
  while (j < to) {
    const c = text.charAt(j);
    if (c === '"' || c === "'") {
      j = stringEnd(text, j);
      continue;
    }
    if (/[A-Za-z_]/.test(c) && !/[\w$.]/.test(text.charAt(j - 1))) {
      const word = /^[A-Za-z_][\w$]*/.exec(text.slice(j, j + 64))?.[0] ?? c;
      const after = j + word.length;
      const next = after + (/^\s*/.exec(text.slice(after))?.[0].length ?? 0);
      const lower = word.toLowerCase();
      if (lower === 'if' && text.charAt(next) === '(') {
        const close = matching(text, next, to);
        if (close < 0) break;
        const body = close + 1 + (/^\s*/.exec(text.slice(close + 1))?.[0].length ?? 0);
        const cond = text.slice(next + 1, close);
        if (text.charAt(body) === '{') {
          pending = { keyword: 'if', cond, start: j };
          j = body;
        } else {
          const semi = text.indexOf(';', body);
          out.push({ keyword: 'if', cond, start: j, open: body - 1, close: semi < 0 ? to : semi });
          j = close + 1;
        }
        continue;
      }
      if (lower === 'else' && text.charAt(next) === '{') {
        pending = { keyword: 'else', cond: 'else', start: j };
        j = next;
        continue;
      }
      j = after;
      continue;
    }
    if (c === '{') {
      stack.push({ ...(pending ?? { keyword: 'other', cond: '', start: j }), open: j, close: -1 });
      pending = null;
    } else if (c === '}') {
      const block = stack.pop();
      if (block !== undefined) out.push({ ...block, close: j });
    }
    j++;
  }
  return out.sort((a, b) => a.open - b.open);
}

/** One branch of a `<cfif>` chain: its condition tag and body; `cond` is `else` for a `<cfelse>` branch. */
interface TagBranch {
  cond: string;
  tagStart: number;
  bodyStart: number;
  bodyEnd: number;
}

/** Every branch of the `<cfif>`/`<cfelseif>`/`<cfelse>` chains of `[from, to)`. */
function tagBranches(text: string, from: number, to: number): TagBranch[] {
  const out: TagBranch[] = [];
  const open: Array<Omit<TagBranch, 'bodyEnd'>> = [];
  const re = /<(\/?)cf(if|elseif|else)\b/gi;
  re.lastIndex = from;
  for (let m = re.exec(text); m !== null && m.index < to; m = re.exec(text)) {
    const end = tagEnd(text, m.index);
    const kind = (m[2] ?? '').toLowerCase();
    if (m[1] === '/') {
      if (kind !== 'if') continue;
      const top = open.pop();
      if (top !== undefined) out.push({ ...top, bodyEnd: m.index });
    } else if (kind === 'if') {
      open.push({ cond: text.slice(m.index + 5, end - 1).trim(), tagStart: m.index, bodyStart: end });
    } else {
      const top = open.pop();
      if (top === undefined) continue;
      out.push({ ...top, bodyEnd: m.index });
      const cond = kind === 'elseif' ? text.slice(m.index + 9, end - 1).trim() : 'else';
      open.push({ cond, tagStart: m.index, bodyStart: end });
    }
    re.lastIndex = end;
  }
  return out.sort((a, b) => a.tagStart - b.tagStart);
}

/** `[start, end)` spans of nested `<!--- … --->` comments in raw text. */
function tagCommentSpans(raw: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = 0;
  let j = 0;
  while (j < raw.length) {
    if (raw.startsWith('<!---', j)) {
      if (depth === 0) start = j;
      depth++;
      j += 5;
    } else if (depth > 0 && raw.startsWith('--->', j)) {
      depth--;
      j += 4;
      if (depth === 0) out.push([start, j]);
    } else {
      j++;
    }
  }
  return out;
}

/** `text` with `[from, to)` blanked to spaces, keeping newlines and the `keep` ranges. */
function blankExcept(text: string, from: number, to: number, keep: ReadonlyArray<readonly [number, number]>): string {
  const kept = [...keep].filter(([a, b]) => b > from && a < to).sort((x, y) => x[0] - y[0]);
  const parts: string[] = [text.slice(0, from)];
  const blank = (a: number, b: number): void => {
    if (b > a) parts.push(text.slice(a, b).replace(/[^\r\n]/g, ' '));
  };
  let at = from;
  for (const [a, b] of kept) {
    const s = Math.max(a, at);
    const e = Math.min(b, to);
    if (e <= s) continue;
    blank(at, s);
    parts.push(text.slice(s, e));
    at = e;
  }
  blank(at, to);
  parts.push(text.slice(to));
  return parts.join('');
}

/** First and last lines of `[from, to)` holding a non-blank character. */
function contentLines(text: string, from: number, to: number): [number, number] | null {
  const slice = text.slice(from, to);
  const first = slice.search(/\S/);
  if (first < 0) return null;
  const last = slice.length - 1 - (/\s*$/.exec(slice)?.[0].length ?? 0);
  return [lineOf(text, from + first), lineOf(text, from + last)];
}

/** `[start, end)` of `fn`'s body in its unit text. */
function bodyRange(fn: CfmlFunction): [number, number] {
  return [fn.offset, fn.offset + fn.body.length];
}

/** Innermost function of `unit` whose body holds `offset`; a template's named functions win over its `''` body. */
function functionAt(unit: CfmlUnit, offset: number): CfmlFunction | undefined {
  const holding = unit.functions.filter((f) => offset >= f.offset && offset < f.offset + f.body.length);
  return holding.sort((a, b) => b.offset - a.offset || (a.name === '' ? 1 : 0) - (b.name === '' ? 1 : 0))[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Reachability: the nearest Application.cfc and whether its onRequestStart aborts
// ---------------------------------------------------------------------------------------------------------------

interface RequestGuard {
  guard: string;
  /** Script names let through; null when the abort is under a condition other than a script-name allow-list. */
  allow: string[] | null;
}

// `!(listFindNoCase("runner.cfm,", listLast(cgi.SCRIPT_NAME, "/")))` with whitespace removed [core/Application.cfc:98].
const SCRIPT_ALLOW_LIST =
  /^(?:!|not)\(?listfind(?:nocase)?\((["'])(.*?)\1,listlast\(cgi\.script_name,(["'])\/\3\)\)\)?$/i;

const guardCache = new WeakMap<SourceTree, Map<string, RequestGuard | null>>();

/** Template a component-level include names: `#repeatString('../', depth)#rest` climbs `depth` directories. */
function resolveAppInclude(template: string, appPath: string, depth: number | undefined, tree: SourceTree): string | null {
  const climb = /^#\s*repeatString\(\s*(['"])\.\.\/\1\s*,\s*([\w.]+)\s*\)\s*#(.*)$/i.exec(template);
  let rel: string;
  if (climb !== null) {
    const count = /^\d+$/.test(climb[2] ?? '') ? Number(climb[2]) : depth;
    if (count === undefined) return null;
    let dir = path.posix.dirname(appPath);
    for (let i = 0; i < count; i++) dir = path.posix.dirname(dir);
    rel = path.posix.normalize(dir === '.' ? (climb[3] ?? '') : `${dir}/${climb[3] ?? ''}`);
  } else if (template.includes('#')) {
    return null;
  } else if (template.startsWith('/')) {
    rel = template.replace(/^\/murawrm\//i, '').replace(/^\/+/, '');
  } else {
    rel = path.posix.normalize(path.posix.join(path.posix.dirname(appPath), template));
  }
  return rel !== '' && !rel.startsWith('..') && tree.exists(rel) ? rel : null;
}

/** Templates a component includes outside its functions, resolved in the tree. */
function componentIncludes(comp: CfmlComponent, tree: SourceTree): string[] {
  const inFunction = (offset: number): boolean => comp.functions.some((f) => offset >= f.offset && offset < f.offset + f.body.length);
  const depthLiteral = /\bdepth\s*=\s*["']?(\d+)/i.exec(comp.text)?.[1];
  const depth = depthLiteral === undefined ? undefined : Number(depthLiteral);
  const templates: Array<{ offset: number; template: string }> = [];
  for (const m of comp.text.matchAll(/<cfinclude\b/gi)) {
    const template = tagAttributes(comp.text, m.index, 10).template;
    if (template !== undefined) templates.push({ offset: m.index, template });
  }
  for (const r of scriptRanges(comp.text)) {
    const re = /\binclude\s+(?=["'])/gi;
    re.lastIndex = r[0];
    for (let m = re.exec(comp.text); m !== null && m.index < r[1]; m = re.exec(comp.text)) {
      const at = m.index + m[0].length;
      const value = comp.text.slice(at + 1, stringEnd(comp.text, at) - 1);
      templates.push({ offset: m.index, template: value });
    }
  }
  return templates
    .filter((t) => !inFunction(t.offset))
    .sort((a, b) => a.offset - b.offset)
    .flatMap((t) => resolveAppInclude(t.template, comp.path, depth, tree) ?? []);
}

/** The `onRequestStart` an `Application.cfc` defines or includes, with the unit holding it. */
function onRequestStart(appPath: string, tree: SourceTree): { unit: CfmlUnit; fn: CfmlFunction } | null {
  const comp = parseCfmlComponent(appPath, tree.readText(appPath));
  if (comp === null) return null;
  const own = comp.functions.find((f) => f.name.toLowerCase() === 'onrequeststart');
  if (own !== undefined) return { unit: comp, fn: own };
  for (const file of componentIncludes(comp, tree)) {
    const unit = parseCfmTemplate(file, tree.readText(file));
    const fn = unit.functions.find((f) => f.name.toLowerCase() === 'onrequeststart');
    if (fn !== undefined) return { unit, fn };
  }
  return null;
}

/** Abort offsets of a function body: `<cfabort>` tags and script `abort;` statements outside string literals. */
function abortOffsets(fn: CfmlFunction): number[] {
  const body = fn.body;
  const out = [...body.matchAll(/<cfabort\b/gi)].map((m) => m.index);
  for (const [from, to] of scriptRanges(body)) {
    let j = from;
    while (j < to) {
      const c = body.charAt(j);
      if (c === '"' || c === "'") {
        j = stringEnd(body, j);
        continue;
      }
      if (/^abort\s*;/i.test(body.slice(j, j + 16)) && !/[\w$.]/.test(body.charAt(j - 1))) out.push(j);
      j++;
    }
  }
  return out.sort((a, b) => a - b);
}

/** Conditions enclosing `offset` in a function body, outermost first. */
function enclosingConditions(body: string, offset: number): string[] {
  const script = scriptRanges(body).find(([a, b]) => offset >= a && offset < b);
  if (script !== undefined) {
    return scriptBlocks(body, script[0], script[1])
      .filter((b) => b.keyword !== 'other' && b.open < offset && offset <= b.close)
      .map((b) => b.cond);
  }
  return tagBranches(body, 0, body.length)
    .filter((b) => b.bodyStart <= offset && offset < b.bodyEnd)
    .map((b) => b.cond);
}

/** The abort an `Application.cfc` applies to every request in its directory tree; null when it never aborts. */
function requestGuard(tree: SourceTree, appPath: string): RequestGuard | null {
  let cache = guardCache.get(tree);
  if (cache === undefined) {
    cache = new Map();
    guardCache.set(tree, cache);
  }
  if (cache.has(appPath)) return cache.get(appPath) ?? null;
  let result: RequestGuard | null = null;
  const found = onRequestStart(appPath, tree);
  if (found !== null) {
    const guard = `${found.unit.path}:${found.fn.startLine}-${found.fn.endLine}`;
    const verdicts = abortOffsets(found.fn).map((offset) => {
      const conds = enclosingConditions(found.fn.body, offset);
      if (conds.length === 0) return { allow: [] as string[] };
      const listed = conds.length === 1 ? SCRIPT_ALLOW_LIST.exec((conds[0] ?? '').replace(/\s+/g, '')) : null;
      return { allow: listed === null ? null : (listed[2] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '') };
    });
    const unconditional = verdicts.find((v) => v.allow !== null && v.allow.length === 0);
    const listed = verdicts.find((v) => v.allow !== null);
    if (unconditional !== undefined || listed !== undefined) result = { guard, allow: (unconditional ?? listed)?.allow ?? [] };
    else if (verdicts.length > 0) result = { guard, allow: null };
  }
  cache.set(appPath, result);
  return result;
}

/** Reachability of `rel` over HTTP: under `core/`, the nearest ancestor `Application.cfc` must not abort for its name. */
export function httpReachability(tree: SourceTree, rel: string): HttpReachability {
  if (!rel.startsWith('core/')) return { reachable: true, guard: null, allow: null };
  const name = path.posix.basename(rel).toLowerCase();
  for (let dir = path.posix.dirname(rel); ; dir = path.posix.dirname(dir)) {
    const app = dir === '.' ? 'Application.cfc' : `${dir}/Application.cfc`;
    if (tree.exists(app)) {
      const g = requestGuard(tree, app);
      if (g === null || g.allow === null) return { reachable: true, guard: g?.guard ?? null, allow: null };
      return { reachable: g.allow.some((a) => a.toLowerCase() === name), guard: g.guard, allow: [...g.allow] };
    }
    if (dir === '.') return { reachable: true, guard: null, allow: null };
  }
}

/** Whether HTTP can reach `rel`; see {@link httpReachability}. */
export function isHttpReachable(tree: SourceTree, rel: string): boolean {
  return httpReachability(tree, rel).reachable;
}

// ---------------------------------------------------------------------------------------------------------------
// Closures: overlays that isolate a branch, merging, and evidence read from the code
// ---------------------------------------------------------------------------------------------------------------

const SESSION_RANK: Record<SessionEffects, number> = { none: 0, relogin: 1, login: 2, logout: 3 };

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

function uniqueSorted<T>(items: Iterable<T>, key: (x: T) => string, order: (a: T, b: T) => number): T[] {
  const byKey = new Map<string, T>();
  for (const x of items) if (!byKey.has(key(x))) byKey.set(key(x), x);
  return [...byKey.values()].sort(order);
}

/** Union of closures; an unconditional sighting of a write or file-store call supersedes a conditional one. */
function mergeClosures(closures: readonly WriteClosure[], extraUnresolved: readonly UnresolvedRef[] = []): WriteClosure {
  if (closures.length === 1 && extraUnresolved.length === 0 && closures[0] !== undefined) return closures[0];
  const writeKey = (w: ClosureWrite): string =>
    JSON.stringify([w.table, w.op, w.component, w.method, w.source, w.trigger, w.override ?? '', w.whereParams, w.dynamic ?? false]);
  const writes = new Map<string, ClosureWrite>();
  for (const w of closures.flatMap((c) => c.writes)) {
    const prev = writes.get(writeKey(w));
    if (prev === undefined || (prev.conditional && !w.conditional)) writes.set(writeKey(w), w);
  }
  const mergedWrites = [...writes.values()].sort(
    (a, b) =>
      compareText(a.table ?? '', b.table ?? '') ||
      compareText(a.op, b.op) ||
      compareText(a.component, b.component) ||
      compareText(a.method, b.method) ||
      compareSource(a.source, b.source) ||
      compareText(a.trigger, b.trigger) ||
      compareText(a.override ?? '', b.override ?? ''),
  );
  const settled = new Set(mergedWrites.filter((w) => !w.conditional).map((w) => JSON.stringify([w.table, w.source])));
  const conditionalWrites = uniqueSorted<ConditionalWrite>(
    closures.flatMap((c) => c.conditionalWrites).filter((c) => !settled.has(JSON.stringify([c.table, c.source]))),
    (c) => JSON.stringify([c.table, c.condition, c.source]),
    (a, b) => compareText(a.table, b.table) || compareSource(a.source, b.source) || compareText(a.condition, b.condition),
  );
  const evidence = new Map<string, FileStoreEvidence>();
  for (const e of closures.flatMap((c) => c.fileStoreEvidence)) {
    const key = JSON.stringify([e.component, e.method, e.source]);
    const prev = evidence.get(key);
    if (prev === undefined || (prev.conditional && !e.conditional)) evidence.set(key, e);
  }
  const fileStoreEvidence = [...evidence.values()].sort(
    (a, b) => compareText(a.component, b.component) || compareText(a.method, b.method) || compareSource(a.source, b.source),
  );
  return {
    tables: [...new Set(mergedWrites.flatMap((w) => (w.table === null ? [] : [w.table])))].sort(compareText),
    writes: mergedWrites,
    conditionalWrites,
    fileStore: fileStoreEvidence.length > 0,
    fileStoreEvidence,
    sessionEffects: closures.reduce<SessionEffects>(
      (acc, c) => (SESSION_RANK[c.sessionEffects] > SESSION_RANK[acc] ? c.sessionEffects : acc),
      'none',
    ),
    threads: uniqueSorted<ClosureThread>(
      closures.flatMap((c) => c.threads),
      (t) => JSON.stringify([t.component, t.method, t.source, t.name]),
      (a, b) => compareText(a.component, b.component) || compareText(a.method, b.method) || compareSource(a.source, b.source),
    ),
    unresolved: uniqueSorted<UnresolvedRef>(
      [...closures.flatMap((c) => c.unresolved), ...extraUnresolved],
      (u) => JSON.stringify([u.source, u.expr, u.kind]),
      (a, b) => compareSource(a.source, b.source) || compareText(a.expr, b.expr) || compareText(a.kind, b.kind),
    ),
    overrides: [...new Set(closures.flatMap((c) => c.overrides))].sort(compareText),
    visited: [...new Set(closures.flatMap((c) => c.visited))].sort(compareText),
  };
}

/** Closure context in which `file` reads as `source`: a component through the index, a template through the tree. */
function overlayContext(ctx: ClosureContext, file: string, source: string): ClosureContext {
  if (file.toLowerCase().endsWith('.cfc')) {
    const unit = parseCfmlComponent(file, source);
    const index = ctx.index;
    return {
      ...ctx,
      index: {
        resolveBean: (name) => index.resolveBean(name),
        ormTable: (p) => index.ormTable(p),
        parsed: (p) => (p === file ? unit : index.parsed(p)),
      },
    };
  }
  const tree = ctx.tree;
  return {
    ...ctx,
    tree: {
      root: tree.root,
      readText: (rel) => (rel === file ? source : tree.readText(rel)),
      exists: (rel) => tree.exists(rel),
      list: (prefix, opts) => tree.list(prefix, opts),
      lineOf: (text, offset) => tree.lineOf(text, offset),
    },
  };
}

/** A part of a function that runs on its own: the function, and the `[from, to)` ranges of its body to keep. */
interface Branch {
  unit: CfmlUnit;
  fn: CfmlFunction;
  keep: Array<[number, number]>;
}

/** Context in which a branch's function holds only the branch: the rest of its body is blanked, `<cfargument>` and enclosing `<cfscript>` tags kept. */
function branchContext(branch: Branch, ctx: ClosureContext): ClosureContext {
  const [from, to] = bodyRange(branch.fn);
  const text = branch.unit.text;
  const formals = [...text.slice(from, to).matchAll(/<cfargument\b/gi)].map((m): [number, number] => [
    from + m.index,
    tagEnd(text, from + m.index),
  ]);
  const scripts = enclosingScriptTags(text, branch.keep);
  return overlayContext(ctx, branch.unit.path, blankExcept(text, from, to, [...branch.keep, ...formals, ...scripts]));
}

/** Closure of a branch alone, entered at its function with `predicates`. */
function branchClosure(branch: Branch, predicates: Predicates, ctx: ClosureContext): WriteClosure {
  const entry: ClosureEntry = { component: branch.unit.path, method: branch.fn.name, predicates };
  return computeClosure(entry, branchContext(branch, ctx));
}

/** Text of the kept ranges, the part of a branch its own checks are read from. */
function branchText(branch: Branch): string {
  return branch.keep.map(([a, b]) => branch.unit.text.slice(a, b)).join('\n');
}

/** `visited` key of a branch's function, lower-cased: its original body is not the code the branch runs. */
function branchKey(branch: Branch): string {
  return `${branch.unit.path}#${branch.fn.name}`.toLowerCase();
}

const DATA_HELPERS = new Set(['jsonencode', 'jsondecode']);

/** Constructs in `fn` that render CFML: includes, display-object calls, content-renderer calls and saved output. */
function renderEvidence(unit: CfmlUnit, fn: CfmlFunction): RenderEvidence[] {
  const out: RenderEvidence[] = fn.includes.map((inc) => ({ marker: 'include', source: span(unit.path, inc.line, inc.line) }));
  const body = fn.body;
  const at = (offset: number): SourceRef => {
    const line = fn.bodyLine + lineOf(body, offset) - 1;
    return span(unit.path, line, line);
  };
  for (const m of body.matchAll(/\.\s*(dsp[A-Za-z_]\w*|renderEvent)\s*\(/gi)) out.push({ marker: 'display-object', source: at(m.index) });
  for (const m of body.matchAll(/\bget(?:Content)?Renderer\s*\(\s*\)(\s*\.\s*([A-Za-z_]\w*))?/gi)) {
    if (!DATA_HELPERS.has((m[2] ?? '').toLowerCase())) out.push({ marker: 'content-renderer', source: at(m.index) });
  }
  for (const m of body.matchAll(/\bcontentRenderer\s*\.\s*([A-Za-z_]\w*)\s*\(/gi)) {
    if (!DATA_HELPERS.has((m[1] ?? '').toLowerCase())) out.push({ marker: 'content-renderer', source: at(m.index) });
  }
  for (const m of body.matchAll(/<cfsavecontent\b|\bsavecontent\s+variable\b/gi)) out.push({ marker: 'saved-output', source: at(m.index) });
  return uniqueSorted(
    out,
    (e) => JSON.stringify([e.marker, e.source]),
    (a, b) => compareSource(a.source, b.source) || compareText(a.marker, b.marker),
  );
}

interface CsrfCall {
  context: string | null;
  bypassed: boolean;
}

/** `validateCSRFTokens` calls in code text, with their `context` argument and whether a constant short-circuits them. */
function csrfCalls(text: string): CsrfCall[] {
  const out: CsrfCall[] = [];
  for (const m of text.matchAll(/\.\s*validateCSRFTokens\s*\(/gi)) {
    const open = m.index + m[0].length - 1;
    const close = matching(text, open);
    const args = splitArgs(text.slice(open + 1, close < 0 ? text.length : close));
    if (args.some((a) => /^argumentCollection\s*=/i.test(a))) continue;
    const named = args.find((a) => /^context\s*=/i.test(a))?.replace(/^context\s*=\s*/i, '');
    const context = named === undefined ? null : (literalValue(named) ?? named.replace(/\s+/g, ' '));
    const before = text.slice(Math.max(0, m.index - 160), m.index);
    out.push({ context, bypassed: /\btrue\s*(?:\bor\b|\|\|)\s*(?:not\s+|!\s*)?[\w$.]*$/i.test(before) });
  }
  return out;
}

/** The CSRF facts of an entry from its own code, then from the other functions its closure visited. */
function csrfFacts(
  own: readonly string[],
  ownFunctions: ReadonlySet<string>,
  closure: WriteClosure,
  bodies: VisitedBodies,
): { csrfContext: string | null; csrfValidation: CsrfValidation } {
  const visited = closure.visited.filter((v) => !ownFunctions.has(v.toLowerCase()));
  const calls = [...own.flatMap(csrfCalls), ...visited.flatMap((v) => csrfCalls(bodies.body(v)))];
  if (calls.length === 0) return { csrfContext: null, csrfValidation: 'none' };
  const live = calls.filter((c) => !c.bypassed);
  const context = (live.length > 0 ? live : calls).find((c) => c.context !== null)?.context ?? null;
  return { csrfContext: context, csrfValidation: live.length > 0 ? 'validates' : 'bypassed' };
}

/** Bodies of the functions a closure lists in `visited` (`<owner>#<name>`), read once per extraction. */
class VisitedBodies {
  private readonly bodies = new Map<string, string>();
  private readonly templates = new Map<string, CfmlUnit>();

  constructor(private readonly ctx: ClosureContext) {}

  /** Comment-stripped body of `<owner>#<name>`; '' when the owner does not define it, and for `validateCSRFTokens` itself. */
  body(visited: string): string {
    const cached = this.bodies.get(visited);
    if (cached !== undefined) return cached;
    const hash = visited.lastIndexOf('#');
    const owner = visited.slice(0, hash);
    const name = visited.slice(hash + 1).toLowerCase();
    const fn = name === 'validatecsrftokens' ? undefined : this.unit(owner)?.functions.find((f) => f.name.toLowerCase() === name);
    const text = fn?.body ?? '';
    this.bodies.set(visited, text);
    return text;
  }

  /** Parsed unit of a visited owner: a template from the tree, a component through the index. */
  unit(owner: string): CfmlUnit | null {
    if (!owner.toLowerCase().endsWith('.cfm')) return this.ctx.index.parsed(owner);
    let unit = this.templates.get(owner);
    if (unit === undefined) {
      if (!this.ctx.tree.exists(owner)) return null;
      unit = parseCfmTemplate(owner, this.ctx.tree.readText(owner));
      this.templates.set(owner, unit);
    }
    return unit;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Page render: the root request plus the handler, validator and translator methods it dispatches by name
// ---------------------------------------------------------------------------------------------------------------

const DISPATCH_CALL = /\.\s*get(Handler|Validator|Translator)\s*\(\s*(["'])((?:(?!\2).)*)\2\s*\)/gi;
const KIND_METHOD: Record<string, string> = { handler: 'handle', validator: 'validate', translator: 'translate' };

/** Function names a dispatch name can address: a literal name, or a pattern when it interpolates `#…#`. */
function dispatchMatcher(name: string, kind: string): (candidate: string) => boolean {
  if (!name.includes('#')) {
    const wanted = `${name}${kind}`.toLowerCase();
    return (candidate) => candidate.toLowerCase() === wanted;
  }
  const pattern = name
    .split(/#[^#]*#/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('.+');
  const re = new RegExp(`^${pattern}${kind}$`, 'i');
  return (candidate) => re.test(candidate);
}

/** Entries a `get<Kind>('<name>')` call dispatches to: events-handler methods, else translator components. */
function dispatchTargets(name: string, kind: string, ctx: ClosureContext): ClosureEntry[] {
  const matches = dispatchMatcher(name, kind);
  const handler = ctx.index.parsed(EVENTS_HANDLER_PATH);
  const own = (handler?.functions ?? []).filter((f) => f.name !== '' && matches(f.name));
  if (own.length > 0) return own.map((f) => ({ component: EVENTS_HANDLER_PATH, method: f.name }));
  const method = KIND_METHOD[kind.toLowerCase()] ?? 'handle';
  return ctx.tree
    .list(TRANSLATOR_DIR, { ext: ['cfc'] })
    .filter((file) => matches(path.posix.basename(file, '.cfc')))
    .filter((file) => ctx.index.parsed(file)?.functions.some((f) => f.name.toLowerCase() === method) === true)
    .map((file) => ({ component: file, method }));
}

/** Root-branch closure with every name-dispatched event method it reaches, to a fixpoint. */
function renderChainClosure(root: Branch, predicates: Predicates, ctx: ClosureContext, bodies: VisitedBodies): WriteClosure {
  const rootEntry: ClosureEntry = { component: root.unit.path, method: root.fn.name, predicates };
  const closures: WriteClosure[] = [computeClosure(rootEntry, branchContext(root, ctx))];
  const unresolved: UnresolvedRef[] = [];
  const scanned = new Set<string>([branchKey(root)]);
  const entered = new Set<string>([branchKey(root)]);
  const dispatch = (unit: CfmlUnit, body: string, bodyLine: number): void => {
    for (const m of body.matchAll(DISPATCH_CALL)) {
      const kind = m[1] ?? 'Handler';
      const dispatched = m[3] ?? '';
      const targets = dispatchTargets(dispatched, kind, ctx);
      if (targets.length === 0) {
        const line = bodyLine + lineOf(body, m.index) - 1;
        unresolved.push({ expr: `get${kind}('${dispatched}')`, kind: 'method', source: span(unit.path, line, line) });
      }
      for (const target of targets) {
        const key = `${target.component}#${target.method}`.toLowerCase();
        if (entered.has(key)) continue;
        entered.add(key);
        closures.push(computeClosure({ ...target, predicates }, ctx));
      }
    }
  };
  for (const [from, to] of root.keep) dispatch(root.unit, root.unit.text.slice(from, to), lineOf(root.unit.text, from));
  for (let i = 0; i < closures.length; i++) {
    for (const visited of closures[i]?.visited ?? []) {
      if (scanned.has(visited.toLowerCase())) continue;
      scanned.add(visited.toLowerCase());
      const owner = visited.slice(0, visited.lastIndexOf('#'));
      const name = visited.slice(visited.lastIndexOf('#') + 1).toLowerCase();
      const unit = bodies.unit(owner);
      const fn = unit?.functions.find((f) => f.name.toLowerCase() === name);
      if (unit !== null && unit !== undefined && fn !== undefined) dispatch(unit, fn.body, fn.bodyLine);
    }
  }
  return mergeClosures(closures, unresolved);
}

/** The root request with its API-family branch blanked: `/_api` and `/tasks` requests are route entries of their own. */
function rootPageBranch(unit: CfmlUnit, fn: CfmlFunction): Branch {
  const [from, to] = bodyRange(fn);
  const api = tagBranches(unit.text, from, to).find(
    (b) => /_api/i.test(b.cond) && /handleAPIRequest\s*\(/i.test(unit.text.slice(b.bodyStart, b.bodyEnd)),
  );
  return { unit, fn, keep: api === undefined ? [[from, to]] : [[from, api.bodyStart], [api.bodyEnd, to]] };
}

// ---------------------------------------------------------------------------------------------------------------
// doaction values: doAction cases, comparisons that act on a value, and links or hidden inputs naming one
// ---------------------------------------------------------------------------------------------------------------

// `$.event('doaction')`, `arguments.event.getValue("doaction")`, `request.doaction` and the like.
const DOACTION_REF = String.raw`(?:(?<![\w$])(?:[\w$]+(?:\(\s*\))?\s*\.\s*)*(?:event|getValue)\s*\(\s*["']doaction["']\s*\)|(?<![\w$.])(?:request|rc|url|form|event)\.doaction\b)`;
const COMPARISONS: readonly RegExp[] = [
  new RegExp(String.raw`${DOACTION_REF}\s*(?:\beq\b|\bneq\b|\bis\s+not\b|\bis\b|==|!=)\s*(["'])([A-Za-z_][\w-]*)\1`, 'gi'),
  new RegExp(String.raw`(["'])([A-Za-z_][\w-]*)\1\s*(?:\beq\b|\bneq\b|\bis\s+not\b|\bis\b|==|!=)\s*${DOACTION_REF}`, 'gi'),
  new RegExp(String.raw`\blistFind(?:NoCase)?\s*\(\s*${DOACTION_REF}\s*,\s*(["'])([A-Za-z_][\w-]*)\1`, 'gi'),
];
const VALUE = /^[A-Za-z_][\w-]*$/;

/** One place a doaction value is read or named. */
interface DoactionSite {
  value: string;
  evidence: DoactionEvidence;
  /** Whether `branch` runs because the request carries the value: a live case, or a positive comparison guarding it. */
  acting: boolean;
  /** A doAction case inside a CFML comment. */
  commented: boolean;
  source: SourceRef;
  branch: Branch | null;
}

/** The doAction cases, live and commented out, of the switch the `<cfloop list="…doaction…">` dispatches to. */
function handlerCaseSites(ctx: ClosureContext): DoactionSite[] {
  if (!ctx.tree.exists(EVENTS_HANDLER_PATH)) return [];
  const unit = ctx.index.parsed(EVENTS_HANDLER_PATH);
  if (unit === null) return [];
  const text = unit.text;
  const raw = ctx.tree.readText(EVENTS_HANDLER_PATH);
  const doaction = new RegExp(DOACTION_REF, 'i');
  const out: DoactionSite[] = [];
  for (const loop of text.matchAll(/<cfloop\b/gi)) {
    const attrs = tagAttributes(text, loop.index, 7);
    const loopVar = attrs.index ?? '';
    if (!doaction.test(attrs.list ?? '') || !VALUE.test(loopVar)) continue;
    const bodyStart = tagEnd(text, loop.index);
    const close = text.slice(bodyStart).search(/<\/cfloop\s*>/i);
    const loopBody = text.slice(bodyStart, close < 0 ? text.length : bodyStart + close);
    for (const switchSite of switchesOn(unit, loopVar, loopBody, bodyStart)) {
      out.push(...casesOf(unit, raw, switchSite));
    }
  }
  return out;
}

/** The `<cfswitch>` regions a doaction loop reaches: one on the loop variable, or on the formal it is passed to. */
function switchesOn(unit: CfmlComponent, loopVar: string, loopBody: string, bodyStart: number): Array<{ fn: CfmlFunction; at: number }> {
  const subjects: Array<{ fn: CfmlFunction; names: string[] }> = [];
  const own = functionAt(unit, bodyStart);
  if (own !== undefined) subjects.push({ fn: own, names: [loopVar] });
  for (const call of loopBody.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const fn = unit.functions.find((f) => f.name.toLowerCase() === (call[1] ?? '').toLowerCase());
    if (fn === undefined) continue;
    const open = call.index + call[0].length - 1;
    const args = splitArgs(loopBody.slice(open + 1, Math.max(open + 1, matching(loopBody, open))));
    args.forEach((arg, i) => {
      const named = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(arg);
      const value = (named?.[2] ?? arg).trim();
      const formal = named?.[1] ?? fn.args[i]?.name;
      if (value.toLowerCase() === loopVar.toLowerCase() && formal !== undefined) subjects.push({ fn, names: [formal] });
    });
  }
  const out: Array<{ fn: CfmlFunction; at: number }> = [];
  for (const { fn, names } of subjects) {
    const [from, to] = bodyRange(fn);
    const wanted = new Set(names.flatMap((n) => [n.toLowerCase(), `arguments.${n.toLowerCase()}`]));
    for (const m of unit.text.slice(from, to).matchAll(/<cfswitch\b/gi)) {
      const subject = (tagAttributes(unit.text, from + m.index, 9).expression ?? '').replace(/[#\s]/g, '').toLowerCase();
      if (wanted.has(subject)) out.push({ fn, at: from + m.index });
    }
  }
  return uniqueSorted(out, (s) => String(s.at), (a, b) => a.at - b.at);
}

/** The `<cfcase>` branches of the switch opening at `at`, plus cases its comments hold. */
function casesOf(unit: CfmlComponent, raw: string, site: { fn: CfmlFunction; at: number }): DoactionSite[] {
  const text = unit.text;
  const out: DoactionSite[] = [];
  const re = /<(\/?)cf(switch|case|defaultcase)\b/gi;
  re.lastIndex = tagEnd(text, site.at);
  let depth = 0;
  let open: { at: number; body: number; values: string[] } | null = null;
  let end = text.length;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const closing = m[1] === '/';
    const kind = (m[2] ?? '').toLowerCase();
    if (kind === 'switch') {
      if (!closing) depth++;
      else if (depth === 0) {
        end = m.index;
        break;
      } else depth--;
    } else if (depth === 0 && kind === 'case' && !closing) {
      const attrs = tagAttributes(text, m.index, 7);
      const delimiter = attrs.delimiters ?? ',';
      const values = (attrs.value ?? '').split(delimiter).map((v) => v.trim()).filter((v) => VALUE.test(v));
      open = { at: m.index, body: tagEnd(text, m.index), values };
    } else if (depth === 0 && kind === 'case' && closing && open !== null) {
      const branch: Branch = { unit, fn: site.fn, keep: [[open.body, m.index]] };
      const source = span(unit.path, lineOf(text, open.at), lineOf(text, m.index));
      for (const value of open.values) out.push({ value, evidence: 'handler-case', acting: true, commented: false, source, branch });
      open = null;
    }
  }
  for (const [from, to] of tagCommentSpans(raw)) {
    if (to <= site.at || from >= end) continue;
    for (const m of raw.slice(from, to).matchAll(/<cfcase\b/gi)) {
      const attrs = tagAttributes(raw, from + m.index, 7);
      const source = span(unit.path, lineOf(raw, from), lineOf(raw, to - 1));
      for (const value of (attrs.value ?? '').split(attrs.delimiters ?? ',').map((v) => v.trim()).filter((v) => VALUE.test(v))) {
        out.push({ value, evidence: 'handler-case', acting: false, commented: true, source, branch: null });
      }
    }
  }
  return out;
}

/** A branch whose condition holds an offset, with the condition text before that offset. */
interface GuardedBranch {
  branch: Branch;
  conditionStart: number;
  prefix: string;
}

/** The branch whose condition holds `offset`: a `<cfif>`/`<cfelseif>` tag, or a script `if`; null outside one. */
function branchAt(unit: CfmlUnit, offset: number, branches: readonly TagBranch[]): GuardedBranch | null {
  const fn = functionAt(unit, offset);
  if (fn === undefined) return null;
  const script = scriptRanges(unit.text).find(([a, b]) => offset >= a && offset < b);
  if (script !== undefined) {
    const block = scriptBlocks(unit.text, script[0], script[1]).find(
      (b) => b.keyword === 'if' && b.start <= offset && offset < b.open,
    );
    if (block === undefined) return null;
    const branch: Branch = { unit, fn, keep: [[block.open + 1, block.close]] };
    return { branch, conditionStart: block.start, prefix: unit.text.slice(unit.text.indexOf('(', block.start) + 1, offset) };
  }
  const tag = branches.find((b) => b.tagStart <= offset && offset < b.bodyStart);
  if (tag === undefined) return null;
  const branch: Branch = { unit, fn, keep: [[tag.bodyStart, tag.bodyEnd]] };
  return { branch, conditionStart: tag.tagStart, prefix: unit.text.slice(tag.tagStart, offset).replace(/^<cf(?:else)?if\b/i, '') };
}

/** Whether condition text ending just before a comparison negates it: an open `not (`/`!(` or `not f(`/`!f(`, or a trailing `not`/`!`. */
function negated(prefix: string): boolean {
  const open: boolean[] = [];
  let j = 0;
  while (j < prefix.length) {
    const c = prefix.charAt(j);
    if (c === '"' || c === "'") {
      j = stringEnd(prefix, j);
      continue;
    }
    if (c === '(') open.push(/(?:\bnot\b|!)\s*(?:[A-Za-z_$][\w$.]*\s*)?$/i.test(prefix.slice(0, j)));
    else if (c === ')') open.pop();
    j++;
  }
  return open.some(Boolean) || /(?:\bnot|!)\s*$/i.test(prefix);
}

/** doaction comparisons in the display-object templates and the events handler, each with the branch it guards. */
function comparisonSites(ctx: ClosureContext): DoactionSite[] {
  const files = [
    ...ctx.tree.list(MODULES_ROOT, { ext: ['cfm'], recursive: true }),
    ...(ctx.tree.exists(EVENTS_HANDLER_PATH) ? [EVENTS_HANDLER_PATH] : []),
  ];
  const out: DoactionSite[] = [];
  for (const file of files) {
    if (!/doaction/i.test(ctx.tree.readText(file))) continue;
    const unit = file.toLowerCase().endsWith('.cfc') ? ctx.index.parsed(file) : parseCfmTemplate(file, ctx.tree.readText(file));
    if (unit === null) continue;
    const branches = tagBranches(unit.text, 0, unit.text.length);
    for (const re of COMPARISONS) {
      for (const m of unit.text.matchAll(re)) {
        const value = m[2] ?? '';
        const guarded = branchAt(unit, m.index, branches);
        const positive = !/\bneq\b|\bis\s+not\b|!=/i.test(m[0]);
        const acting = guarded !== null && positive && !negated(guarded.prefix);
        const first = lineOf(unit.text, guarded?.conditionStart ?? m.index);
        const body = guarded?.branch.keep[0];
        const last = body === undefined ? null : contentLines(unit.text, body[0], body[1]);
        out.push({
          value,
          evidence: 'comparison',
          acting,
          commented: false,
          source: span(file, first, last?.[1] ?? first),
          branch: acting ? (guarded?.branch ?? null) : null,
        });
      }
    }
  }
  return out;
}

/** Links (`doaction=<value>`) and hidden inputs (`name="doaction" value=…`) under `core/`, so values no code reads still get an entry. */
function linkSites(tree: SourceTree): DoactionSite[] {
  const out: DoactionSite[] = [];
  for (const file of tree.list(LINK_SCAN_ROOT, { ext: ['cfm', 'cfc'], recursive: true })) {
    if (file.startsWith(LINK_SCAN_EXCLUDE)) continue;
    const raw = tree.readText(file);
    if (!/doaction/i.test(raw)) continue;
    const text = stripComments(raw, file.toLowerCase().endsWith('.cfm') ? 'tag' : 'auto');
    const site = (value: string, offset: number): DoactionSite => {
      const line = lineOf(text, offset);
      return { value, evidence: 'link', acting: false, commented: false, source: span(file, line, line), branch: null };
    };
    for (const m of text.matchAll(/\bdoaction=([A-Za-z_][\w-]*)/gi)) out.push(site(m[1] ?? '', m.index));
    for (const m of text.matchAll(/<input\b/gi)) {
      const attrs = tagAttributes(text, m.index, 6);
      if ((attrs.name ?? '').toLowerCase() === 'doaction' && VALUE.test(attrs.value ?? '')) out.push(site(attrs.value ?? '', m.index));
    }
  }
  return out;
}

/** Precedence of a site as an entry's primary source: live case, acting comparison, commented case, other comparison, link. */
function siteRank(s: DoactionSite): number {
  if (s.evidence === 'handler-case') return s.commented ? 2 : 0;
  if (s.evidence === 'comparison') return s.acting ? 1 : 3;
  return 4;
}

// ---------------------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------------------

/** State shared by the entry builders of one extraction. */
interface Run {
  ctx: ClosureContext;
  bodies: VisitedBodies;
  keyOptions: RouteKeyOptions;
  variants: readonly VariantDeclaration[];
}

/** An entry before keying; `ownText` is the code its CSRF checks are read from first. */
interface Draft {
  id: string;
  kind: FrontEndKind;
  name: string;
  entry: string;
  source: SourceRef;
  extraSources?: SourceRef[];
  entryPoint: RouteEntryPoint;
  /** Ajax templates only: a key the platform cannot compute is recorded as `unkeyed` rather than failing. */
  keyMayFail?: boolean;
  predicate?: FrontEndPredicate;
  doactionEvidence?: DoactionEvidence;
  reachable?: boolean;
  unreachableReason?: string;
  rendersCfml: boolean;
  returnsDataOnly: boolean;
  renderEvidence?: RenderEvidence[];
  closure: WriteClosure;
  ownText: string[];
  /** Lower-cased `visited` keys of the functions `ownText` stands for. */
  ownFunctions?: string[];
}

const NO_PAGE_PARAMS: Predicates = Object.freeze({ doaction: null, saveform: null });

async function finish(run: Run, d: Draft): Promise<FrontEndEntry> {
  let routeKey: string | null;
  try {
    routeKey = (await inventoryRouteKey(d.entryPoint, run.keyOptions)).key;
  } catch (err) {
    if (d.keyMayFail !== true) throw err;
    routeKey = null;
  }
  return {
    id: d.id,
    kind: d.kind,
    name: d.name,
    entry: d.entry,
    source: d.source,
    extraSources: uniqueSorted(d.extraSources ?? [], (s) => JSON.stringify(s), compareSource),
    routeKey,
    unkeyed: routeKey === null,
    predicate: d.predicate ?? null,
    doactionEvidence: d.doactionEvidence ?? null,
    reachable: d.reachable ?? true,
    unreachableReason: d.unreachableReason ?? null,
    rendersCfml: d.rendersCfml,
    returnsDataOnly: d.returnsDataOnly,
    renderEvidence: d.renderEvidence ?? [],
    writeSet: [...d.closure.tables],
    fileStoreWrite: d.closure.fileStore,
    closure: d.closure,
    sessionEffects: d.closure.sessionEffects,
    ...csrfFacts(d.ownText, new Set(d.ownFunctions ?? []), d.closure, run.bodies),
    trigger: 'request',
  };
}

/** The plain page render: the root request without its API branch, plus its name-dispatched event methods. */
function pageRenderDraft(run: Run): Draft | null {
  const unit = run.ctx.index.parsed(ROOT_REQUEST.path);
  const fn = unit?.functions.find((f) => f.name.toLowerCase() === ROOT_REQUEST.method.toLowerCase());
  if (unit === null || unit === undefined || fn === undefined) return null;
  const branch = rootPageBranch(unit, fn);
  return {
    id: 'fe:render',
    kind: 'page-render',
    name: 'render',
    entry: `page render through ${fn.name}; the theme and display objects render in CFML`,
    source: span(unit.path, fn.startLine, fn.endLine),
    entryPoint: { kind: 'page' },
    rendersCfml: true,
    returnsDataOnly: false,
    closure: renderChainClosure(branch, NO_PAGE_PARAMS, run.ctx, run.bodies),
    ownText: [branchText(branch)],
    ownFunctions: [branchKey(branch)],
  };
}

/** One entry per doaction value, case-insensitively, from its doAction cases, comparisons and links. */
function doactionDrafts(run: Run): Draft[] {
  const sites = [...handlerCaseSites(run.ctx), ...comparisonSites(run.ctx), ...linkSites(run.ctx.tree)];
  const groups = new Map<string, DoactionSite[]>();
  for (const s of sites) groups.set(s.value.toLowerCase(), [...(groups.get(s.value.toLowerCase()) ?? []), s]);
  return [...groups.values()].map((group) => {
    const ordered = [...group].sort((a, b) => siteRank(a) - siteRank(b) || compareSource(a.source, b.source));
    const primary = ordered[0] as DoactionSite;
    const value = primary.value;
    const acting = ordered.filter((s) => s.acting);
    const commentedOnly = acting.length === 0 && ordered.some((s) => s.commented);
    const branches = acting.flatMap((s) => (s.branch === null ? [] : [s.branch]));
    const closures = branches.map((b) => branchClosure(b, { doaction: value }, run.ctx));
    const entry =
      primary.evidence === 'handler-case'
        ? primary.commented
          ? `doaction=${value}: doAction case commented out at the pin, so the value only renders the page`
          : `doaction=${value}: standardEventsHandler.doAction case`
        : primary.acting
          ? `doaction=${value}: read by ${primary.source.path}; not a doAction case`
          : `doaction=${value}: named by ${primary.source.path}; no code acts on it, so the page renders`;
    const draft: Draft = {
      id: `fe:doaction=${value}`,
      kind: 'doaction',
      name: value,
      entry,
      source: primary.source,
      extraSources: ordered.slice(1).filter((s) => s.evidence !== 'link').map((s) => s.source),
      entryPoint: { kind: 'page', doaction: [value] },
      doactionEvidence: primary.evidence,
      reachable: !commentedOnly,
      rendersCfml: true,
      returnsDataOnly: false,
      closure: closures.length === 0 ? emptyClosure() : mergeClosures(closures),
      ownText: branches.map(branchText),
      ownFunctions: branches.map(branchKey),
    };
    if (commentedOnly) draft.unreachableReason = 'doAction case commented out at the pin';
    return draft;
  });
}

/** The `saveform` submission branch of the form display object, if the tree holds one. */
function saveformBranch(run: Run): Branch | null {
  if (!run.ctx.tree.exists(FORM_TEMPLATE_PATH)) return null;
  const unit = parseCfmTemplate(FORM_TEMPLATE_PATH, run.ctx.tree.readText(FORM_TEMPLATE_PATH));
  const branches = tagBranches(unit.text, 0, unit.text.length);
  for (const m of unit.text.matchAll(/(?<![\w$])(?:[\w$]+(?:\(\s*\))?\s*\.\s*)*(?:event|getValue)\s*\(\s*["']saveform["']\s*\)/gi)) {
    const guarded = branchAt(unit, m.index, branches);
    if (guarded !== null && !negated(guarded.prefix)) return guarded.branch;
  }
  return null;
}

/** Source of a branch: its condition line through its last body line. */
function branchSource(branch: Branch): SourceRef {
  const [from, to] = branch.keep[0] ?? [0, 0];
  const condition = tagBranches(branch.unit.text, 0, branch.unit.text.length).find((b) => b.bodyStart === from);
  const first = lineOf(branch.unit.text, condition?.tagStart ?? from);
  return span(branch.unit.path, first, contentLines(branch.unit.text, from, to)?.[1] ?? first);
}

/** Form submissions made while rendering: the `saveform` branch, and the JSON API's processAsyncObject with `saveform`. */
async function formSubmissionDrafts(run: Run): Promise<Draft[]> {
  const out: Draft[] = [];
  const form = saveformBranch(run);
  const formClosure = form === null ? null : branchClosure(form, { saveform: '1' }, run.ctx);
  if (form !== null && formClosure !== null) {
    out.push({
      id: 'fe:saveform',
      kind: 'form-submission',
      name: 'saveform',
      entry: 'form display object submits through dataCollectionBean while the page renders (saveform)',
      source: branchSource(form),
      entryPoint: { kind: 'page', saveform: true },
      rendersCfml: true,
      returnsDataOnly: false,
      closure: formClosure,
      ownText: [branchText(form)],
      ownFunctions: [branchKey(form)],
    });
  }
  const api = run.ctx.index.parsed(ASYNC_OBJECT.path);
  const fn = api?.functions.find((f) => f.name.toLowerCase() === ASYNC_OBJECT.method.toLowerCase());
  if (api === null || api === undefined || fn === undefined) return out;
  const base = await inventoryRouteKey({ kind: 'api', method: fn.name }, run.keyOptions);
  const declared = variantsFor(base.baseKey, run.variants).find(
    (v) => JSON.stringify(v.when) === JSON.stringify([SAVEFORM_CONDITION]),
  );
  if (declared === undefined) throw new Error(`no variant of ${base.baseKey} is declared with the saveform condition`);
  const closure = computeClosure({ component: api.path, method: fn.name, predicates: { saveform: '1' } }, run.ctx);
  out.push({
    id: `fe:${fn.name.toLowerCase()}{${declared.variant}}`,
    kind: 'form-submission',
    name: `${fn.name}{${declared.variant}}`,
    entry: `${fn.name} rendering the form display object with saveform`,
    source: span(api.path, fn.startLine, fn.endLine),
    entryPoint: { kind: 'api', method: fn.name, params: { saveform: '1' } },
    predicate: { variant: declared.variant, when: [...declared.when] },
    rendersCfml: true,
    returnsDataOnly: false,
    closure: formClosure === null ? closure : mergeClosures([closure, formClosure]),
    ownText: form === null ? [] : [branchText(form)],
    ownFunctions: form === null ? [] : [branchKey(form)],
  });
  return out;
}

/** Remote methods of every component: entries where HTTP reaches them, `unreachableRemote` records elsewhere. */
function remoteProxyDrafts(run: Run): { drafts: Draft[]; unreachable: UnreachableRemote[] } {
  const drafts: Draft[] = [];
  const unreachable: UnreachableRemote[] = [];
  for (const file of run.ctx.tree.list('', { ext: ['cfc'], recursive: true })) {
    if (!/\bremote\b/i.test(run.ctx.tree.readText(file))) continue;
    const comp = run.ctx.index.parsed(file);
    const remote = (comp?.functions ?? []).filter((f) => f.access.toLowerCase() === 'remote');
    if (comp === null || remote.length === 0) continue;
    const reach = httpReachability(run.ctx.tree, file);
    if (!reach.reachable) {
      for (const fn of remote) unreachable.push({ path: file, method: fn.name, line: fn.startLine, guard: reach.guard ?? '' });
      continue;
    }
    const component = path.posix.basename(file, path.posix.extname(file));
    for (const fn of remote) {
      const evidence = renderEvidence(comp, fn);
      drafts.push({
        id: `fe:${component.toLowerCase()}.${fn.name}`,
        kind: 'remote-proxy',
        name: fn.name,
        entry: `${component}.${fn.name} remote method`,
        source: span(file, fn.startLine, fn.endLine),
        entryPoint: { kind: 'cfc', path: `/${file}`, method: fn.name },
        rendersCfml: evidence.length > 0,
        returnsDataOnly: evidence.length === 0,
        renderEvidence: evidence,
        closure: computeClosure({ component: file, method: fn.name }, run.ctx),
        ownText: [fn.body],
      });
    }
  }
  return { drafts, unreachable };
}

/** Every reachable template directly under a module's `ajax/` folder. */
function ajaxEndpointDrafts(run: Run): Draft[] {
  const tree = run.ctx.tree;
  return tree
    .list(MODULES_ROOT, { ext: ['cfm'], recursive: true })
    .filter((file) => AJAX_TEMPLATE.test(file) && isHttpReachable(tree, file))
    .map((file): Draft => {
      const unit = parseCfmTemplate(file, tree.readText(file));
      const whole = unit.functions[0] as CfmlFunction;
      const [first, last] = contentLines(unit.text, 0, unit.text.length) ?? [1, 1];
      const evidence = renderEvidence(unit, whole);
      const name = path.posix.basename(file);
      return {
        id: `fe:cfm:/${file.toLowerCase()}`,
        kind: 'ajax-endpoint',
        name,
        entry: `${file.split('/')[3] ?? ''} ajax endpoint ${name}`,
        source: span(file, first, last),
        entryPoint: { kind: 'path', httpMethod: 'GET', path: `/${file}` },
        keyMayFail: true,
        rendersCfml: evidence.length > 0,
        returnsDataOnly: evidence.length === 0,
        renderEvidence: evidence,
        closure: computeClosure({ component: file, method: '' }, run.ctx),
        ownText: [unit.text],
      };
    });
}

/** Lines of `file` whose comment-stripped text matches `re` (global). */
function matchingLines(tree: SourceTree, file: string, re: RegExp): SourceRef[] {
  const text = stripComments(tree.readText(file), file.toLowerCase().endsWith('.cfm') ? 'tag' : 'auto');
  return [...text.matchAll(re)].map((m) => {
    const line = lineOf(text, m.index);
    return span(file, line, line);
  });
}

/** The application reload, the one inventoried `reload:` key: request start-up re-runs application start-up for the reload URL key. */
function reloadDraft(run: Run): Draft | null {
  const tree = run.ctx.tree;
  if (!tree.exists(REQUEST_START_PATH)) return null;
  const text = parseCfmTemplate(REQUEST_START_PATH, tree.readText(REQUEST_START_PATH)).text;
  const include = /\binclude\s+(["'])[^"']*onApplicationStart_include\.cfm\1|<cfinclude\s+template\s*=\s*(["'])[^"']*onApplicationStart_include\.cfm\2/i.exec(
    text,
  );
  if (include === null) return null;
  const at = include.index;
  const script = scriptRanges(text).find(([a, b]) => at >= a && at < b);
  const guards = (script === undefined ? [] : scriptBlocks(text, script[0], script[1]))
    .filter((b) => b.keyword === 'if' && b.open < at && at <= b.close && /appReloadKey/i.test(b.cond))
    .sort((a, b) => a.start - b.start);
  const guard = guards[0];
  const extraSources = [
    ...(tree.exists(APP_START_PATH) ? matchingLines(tree, APP_START_PATH, /application\.appReloadKey\b[^;\n]*\bdefault\b/gi) : []),
    ...tree
      .list(ADMIN_ROOT, { ext: ['cfm'], recursive: true })
      .filter((file) => /appreloadkey/i.test(tree.readText(file)))
      .flatMap((file) => matchingLines(tree, file, /\bhref\s*=\s*(["'])(?:(?!\1).)*appreloadkey/gi)),
  ];
  return {
    id: 'fe:appreload',
    kind: 'reload',
    name: 'appreload',
    entry: 'application reload by ?<appreloadkey> (default appreload) or the Global Config reload link; start-up re-runs',
    source:
      guard === undefined
        ? span(REQUEST_START_PATH, lineOf(text, at), lineOf(text, at))
        : span(REQUEST_START_PATH, lineOf(text, guard.start), lineOf(text, guard.close)),
    extraSources,
    entryPoint: { kind: 'reload' },
    rendersCfml: true,
    returnsDataOnly: false,
    closure: tree.exists(APP_START_PATH) ? computeClosure({ component: APP_START_PATH, method: '' }, run.ctx) : emptyClosure(),
    ownText: [],
  };
}

/**
 * The public front-end entries of a source tree and the remote methods HTTP cannot reach, both sorted.
 * @param tree the pinned archive extraction (or an in-memory tree)
 * @param opts component index, writer overrides and route-key options for the closures and keys
 */
export async function extractFrontEnd(tree: SourceTree, opts: FrontEndOptions): Promise<FrontEndExtraction> {
  const variants = opts.routeKeyOptions?.variants ?? (await loadInventoryVariants()).variants;
  const ctx: ClosureContext = { tree, index: opts.index, ...(opts.overrides === undefined ? {} : { overrides: opts.overrides }) };
  const run: Run = { ctx, bodies: new VisitedBodies(ctx), keyOptions: { ...opts.routeKeyOptions, variants }, variants };
  const remote = remoteProxyDrafts(run);
  const drafts: Draft[] = [
    ...[pageRenderDraft(run), reloadDraft(run)].flatMap((d) => (d === null ? [] : [d])),
    ...doactionDrafts(run),
    ...(await formSubmissionDrafts(run)),
    ...remote.drafts,
    ...ajaxEndpointDrafts(run),
  ];
  const frontEnd: FrontEndEntry[] = [];
  for (const d of drafts) frontEnd.push(await finish(run, d));
  for (const e of frontEnd) if (e.kind === 'ajax-endpoint' && e.routeKey !== null) e.id = `fe:${e.routeKey}`;
  frontEnd.sort((a, b) => compareText(a.id, b.id));
  const duplicate = frontEnd.find((e, i) => i > 0 && frontEnd[i - 1]?.id === e.id);
  if (duplicate !== undefined) throw new Error(`two front-end entries share the id ${duplicate.id}`);
  const unreachableRemote = remote.unreachable.sort(
    (a, b) => compareText(a.path, b.path) || a.line - b.line || compareText(a.method, b.method),
  );
  return { frontEnd, unreachableRemote };
}
