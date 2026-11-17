// CFML source model and per-branch write closure for the legacy inventory (tables[].writers[], action write sets).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { cfIsBoolean, cfToBoolean } from '@opt2/platform/legacy-compat';
import { isInsideRepo } from '../lib/paths.js';
import type {
  SessionEffects,
  SettledCall,
  SourceRef,
  Trigger,
  WriterOp,
  WriterOverride,
  WriterOverrides,
} from './overrides.js';

// ---------------------------------------------------------------------------------------------------------------
// Source tree
// ---------------------------------------------------------------------------------------------------------------

/** Options of `SourceTree.list`: file extensions to keep (with or without the dot) and whether to descend. */
export interface ListOptions {
  ext?: readonly string[];
  recursive?: boolean;
}

/** Read-only view of an extracted source tree, addressed by repository-relative forward-slash paths. */
export interface SourceTree {
  /** Absolute extraction directory, or null for an in-memory tree. */
  readonly root: string | null;
  /** UTF-8 text of `rel` without a leading byte-order mark; throws when the file is absent. */
  readText(rel: string): string;
  /** Whether `rel` names a file in the tree. */
  exists(rel: string): boolean;
  /** Files under the directory `prefix` ('' for the root), sorted in code-unit order. */
  list(prefix: string, opts?: ListOptions): string[];
  /** 1-based line of `offset` in `text`. */
  lineOf(text: string, offset: number): number;
}

/** Plain code-unit string comparison, the order every sorted result uses. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normaliseRel(rel: string): string {
  const segments = rel.split('/');
  if (rel === '' || rel.includes('\\') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`invalid repository-relative path ${JSON.stringify(rel)}`);
  }
  return rel;
}

function normalisePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : normaliseRel(trimmed);
}

function extensionFilter(ext: readonly string[] | undefined): (name: string) => boolean {
  if (ext === undefined || ext.length === 0) return () => true;
  const wanted = ext.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
  return (name) => {
    const lower = name.toLowerCase();
    return wanted.some((e) => lower.endsWith(e));
  };
}

/** 1-based line of `offset` in `text`. */
export function lineOf(text: string, offset: number): number {
  const end = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < end; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** Source tree over a `git archive` extraction directory; refuses a directory inside the checkout. */
export function openSourceTree(rootDir: string): SourceTree {
  const root = path.resolve(rootDir);
  if (isInsideRepo(root)) {
    throw new Error(`source tree ${root} lies inside the repository checkout; extract the pinned commit instead`);
  }
  if (!statSync(root).isDirectory()) throw new Error(`source tree ${root} is not a directory`);
  const texts = new Map<string, string>();
  return {
    root,
    readText(rel) {
      const key = normaliseRel(rel);
      let text = texts.get(key);
      if (text === undefined) {
        text = stripBom(readFileSync(path.join(root, key), 'utf8'));
        texts.set(key, text);
      }
      return text;
    },
    exists(rel) {
      const abs = path.join(root, normaliseRel(rel));
      return existsSync(abs) && statSync(abs).isFile();
    },
    list(prefix, opts = {}) {
      const base = normalisePrefix(prefix);
      const dir = base === '' ? root : path.join(root, base);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
      const keep = extensionFilter(opts.ext);
      const out: string[] = [];
      const walk = (abs: string, rel: string): void => {
        for (const entry of readdirSync(abs, { withFileTypes: true })) {
          const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) {
            if (opts.recursive === true) walk(path.join(abs, entry.name), child);
          } else if (entry.isFile() && keep(entry.name)) {
            out.push(child);
          }
        }
      };
      walk(dir, base);
      return out.sort(compareText);
    },
    lineOf,
  };
}

/** In-memory source tree keyed by repository-relative path, for tests and synthetic inputs. */
export function memorySourceTree(files: Readonly<Record<string, string>> | ReadonlyMap<string, string>): SourceTree {
  const texts = new Map<string, string>();
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
  for (const [rel, text] of entries) texts.set(normaliseRel(rel), stripBom(text));
  return {
    root: null,
    readText(rel) {
      const text = texts.get(normaliseRel(rel));
      if (text === undefined) throw new Error(`no file ${rel} in the in-memory source tree`);
      return text;
    },
    exists(rel) {
      return texts.has(normaliseRel(rel));
    },
    list(prefix, opts = {}) {
      const base = normalisePrefix(prefix);
      const keep = extensionFilter(opts.ext);
      const out: string[] = [];
      for (const rel of texts.keys()) {
        if (base !== '' && !rel.startsWith(`${base}/`)) continue;
        const rest = base === '' ? rel : rel.slice(base.length + 1);
        if (opts.recursive !== true && rest.includes('/')) continue;
        if (keep(rel.slice(rel.lastIndexOf('/') + 1))) out.push(rel);
      }
      return out.sort(compareText);
    },
    lineOf,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------------------------------------------

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

function isIdentStart(ch: string): boolean {
  return ch !== '' && IDENT_START.test(ch);
}

function isIdentPart(ch: string): boolean {
  return ch !== '' && IDENT_PART.test(ch);
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function startsWithCi(text: string, word: string, at: number): boolean {
  return text.slice(at, at + word.length).toLowerCase() === word;
}

function indexOfCi(text: string, word: string, from: number): number {
  const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'gi');
  re.lastIndex = from;
  const m = re.exec(text);
  return m === null ? -1 : m.index;
}

// `#…#` inside a string is an expression, and CFML lets it hold strings of either quote.
function skipInterpolation(text: string, from: number, end: number): number {
  let j = from;
  while (j < end) {
    const c = text.charAt(j);
    if (c === '#') return j + 1;
    if (c === '"' || c === "'") {
      j = skipString(text, j, end);
      continue;
    }
    j++;
  }
  return end;
}

/** Index just after the string literal opening at `at`: doubled quotes escape, `##` escapes, `#…#` interpolates (`onExpr` gets each span). */
function skipString(text: string, at: number, end: number = text.length, onExpr?: (from: number, to: number) => void): number {
  const quote = text.charAt(at);
  let j = at + 1;
  while (j < end) {
    const c = text.charAt(j);
    if (c === quote) {
      if (text.charAt(j + 1) === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    if (c === '#') {
      if (text.charAt(j + 1) === '#') {
        j += 2;
        continue;
      }
      const from = j + 1;
      j = skipInterpolation(text, from, end);
      onExpr?.(from, j);
      continue;
    }
    j++;
  }
  return end;
}

/** Text of a quoted literal without its quotes and with doubled quotes collapsed. */
function unquote(literal: string): string {
  const quote = literal.charAt(0);
  const inner = literal.length >= 2 && literal.endsWith(quote) ? literal.slice(1, -1) : literal.slice(1);
  return inner.split(quote + quote).join(quote);
}

/** Whether a literal's inner text interpolates an expression (a `#` that is not `##`). */
function interpolates(inner: string): boolean {
  return /#/.test(inner.replace(/##/g, ''));
}

/** Index just after the tag opening at `at` (`<…>`), skipping quoted attribute values. */
function tagEnd(text: string, at: number): number {
  let j = at + 1;
  while (j < text.length) {
    const c = text.charAt(j);
    if (c === '"' || c === "'") {
      j = skipString(text, j);
      continue;
    }
    if (c === '>') return j + 1;
    j++;
  }
  return text.length;
}

/** Index of the bracket closing the one at `at` (`(`, `[` or `{`), skipping strings; -1 when unbalanced. */
function matchBracket(text: string, at: number, end: number = text.length): number {
  const stack: string[] = [];
  let j = at;
  while (j < end) {
    const c = text.charAt(j);
    if (c === '"' || c === "'") {
      j = skipString(text, j, end);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') stack.push(c === '(' ? ')' : c === '[' ? ']' : '}');
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return j;
    }
    j++;
  }
  return -1;
}

/** Fast 1-based line lookup over one text. */
class LineIndex {
  private readonly breaks: number[] = [];

  constructor(text: string) {
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) this.breaks.push(i);
  }

  line(offset: number): number {
    let lo = 0;
    let hi = this.breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.breaks[mid] ?? Infinity) < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  }
}

/** Lexical syntax of a CFML text: cfscript, or tags with embedded `<cfscript>` blocks. */
export type SourceMode = 'script' | 'tag';

/** Tag mode when the first non-blank character opens a tag, otherwise script mode. */
export function detectMode(text: string): SourceMode {
  const first = /\S/.exec(stripBom(text));
  return first !== null && first[0] === '<' ? 'tag' : 'script';
}

function endOfTagComment(text: string, at: number): number {
  let depth = 0;
  let j = at;
  while (j < text.length) {
    if (text.startsWith('<!---', j)) {
      depth++;
      j += 5;
    } else if (text.startsWith('--->', j)) {
      depth--;
      j += 4;
      if (depth === 0) return j;
    } else {
      j++;
    }
  }
  return text.length;
}

/**
 * Blanks `//`, `/* … *\/` and nested `<!--- … --->` comments with spaces, keeping newlines and every offset.
 * String literals are left intact; in tag mode only `<cfscript>` bodies take script comments.
 */
export function stripComments(text: string, mode: SourceMode | 'auto' = 'auto'): string {
  const n = text.length;
  const parts: string[] = [];
  let last = 0;
  const blank = (from: number, to: number): void => {
    parts.push(text.slice(last, from), text.slice(from, to).replace(/[^\r\n]/g, ' '));
    last = to;
  };
  const scanScript = (from: number, embedded: boolean): number => {
    let i = from;
    while (i < n) {
      const c = text.charAt(i);
      if (c === '"' || c === "'") {
        i = skipString(text, i);
        continue;
      }
      if (embedded && c === '<' && startsWithCi(text, '</cfscript', i)) return i;
      if (c === '/' && text.charAt(i + 1) === '/') {
        let j = text.indexOf('\n', i);
        if (j < 0) j = n;
        if (embedded) {
          const close = indexOfCi(text, '</cfscript', i);
          if (close >= 0 && close < j) j = close;
        }
        blank(i, j);
        i = j;
        continue;
      }
      if (c === '/' && text.charAt(i + 1) === '*') {
        const close = text.indexOf('*/', i + 2);
        const j = close < 0 ? n : close + 2;
        blank(i, j);
        i = j;
        continue;
      }
      i++;
    }
    return n;
  };
  const resolved = mode === 'auto' ? detectMode(text) : mode;
  if (resolved === 'script') {
    scanScript(0, false);
  } else {
    let i = 0;
    while (i < n) {
      if (text.charAt(i) === '<') {
        if (text.startsWith('<!---', i)) {
          const j = endOfTagComment(text, i);
          blank(i, j);
          i = j;
          continue;
        }
        if (startsWithCi(text, '<cfscript', i) && !isIdentPart(text.charAt(i + 9))) {
          i = scanScript(tagEnd(text, i), true);
          continue;
        }
      }
      i++;
    }
  }
  parts.push(text.slice(last));
  return parts.join('');
}

/** Marks the interior of the string literal at `at` as literal text, except its `#…#` expressions; returns its end. */
function markString(text: string, at: number, end: number, mask: Uint8Array): number {
  let from = at + 1;
  const close = skipString(text, at, end, (exprFrom, exprTo) => {
    mask.fill(1, from, exprFrom);
    markStrings(text, exprFrom, exprTo, mask);
    from = exprTo;
  });
  mask.fill(1, from, close);
  return close;
}

const EVALUATED = /\bevaluate\s*\(\s*$/i;

/** Marks the string literals of the code in `[from, to)`; an `evaluate` argument, or a quote `isCode` accepts, is code. */
function markStrings(text: string, from: number, to: number, mask: Uint8Array, isCode?: (quoteAt: number) => boolean): void {
  let i = from;
  while (i < to) {
    const c = text.charAt(i);
    if (c !== '"' && c !== "'") {
      i++;
    } else if (isCode?.(i) === true || EVALUATED.test(text.slice(Math.max(from, i - 32), i))) {
      const close = skipString(text, i, to);
      markStrings(text, i + 1, close - 1, mask);
      i = close;
    } else {
      i = markString(text, i, to, mask);
    }
  }
}

const CF_TAG = /<\/?cf/gi;

/** Start of the first CFML tag at or after `from`, or the end of `text`. */
function nextCfTag(text: string, from: number): number {
  CF_TAG.lastIndex = from;
  return CF_TAG.exec(text)?.index ?? text.length;
}

/** Marks template text outside CFML tags and `<cfscript>` bodies, except `#…#`, plus the string literals of both. */
function markTagText(text: string, mask: Uint8Array): void {
  const n = text.length;
  let lit = 0;
  let i = 0;
  while (i < n) {
    const c = text.charAt(i);
    if (c === '#' && text.charAt(i + 1) === '#') {
      i += 2;
    } else if (c === '#') {
      // An interpolation never spans a CFML tag, so a stray `#` outside `<cfoutput>` cannot swallow one.
      mask.fill(1, lit, i + 1);
      const stop = skipInterpolation(text, i + 1, nextCfTag(text, i + 1));
      markStrings(text, i + 1, stop, mask);
      lit = i = stop;
    } else if (c === '<' && (startsWithCi(text, '<cf', i) || startsWithCi(text, '</cf', i))) {
      mask.fill(1, lit, i);
      const at = i;
      const end = tagEnd(text, at);
      if (startsWithCi(text, '<cfscript', at) && !isIdentPart(text.charAt(at + 9))) {
        const close = indexOfCi(text, '</cfscript', end);
        i = close < 0 ? n : close;
        markStrings(text, end, i, mask);
      } else {
        const loop = startsWithCi(text, '<cfloop', at) && !isIdentPart(text.charAt(at + 7));
        markStrings(text, at, end, mask, loop ? (q) => /\bcondition\s*=\s*$/i.test(text.slice(at, q)) : undefined);
        i = end;
      }
      lit = i;
    } else {
      i++;
    }
  }
  mask.fill(1, lit, n);
}

/** Offsets of `body` (flagged 1) holding text that never runs: string interiors and, in tag mode, template text. */
function literalMask(body: string, mode: SourceMode): Uint8Array {
  const mask = new Uint8Array(body.length);
  if (mode === 'script') markStrings(body, 0, body.length, mask);
  else markTagText(body, mask);
  return mask;
}

/** `name=value` attributes with single, double or no quotes; keys lower-cased, first occurrence kept. */
export function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source.charAt(i);
    if (c === '"' || c === "'") {
      i = skipString(source, i);
      continue;
    }
    if (!isIdentStart(c)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && /[\w$:.-]/.test(source.charAt(j))) j++;
    const name = source.slice(i, j).toLowerCase();
    let k = j;
    while (k < n && isSpace(source.charAt(k))) k++;
    if (source.charAt(k) !== '=' || source.charAt(k + 1) === '=') {
      if (!Object.hasOwn(attrs, name)) attrs[name] = '';
      i = j;
      continue;
    }
    k++;
    while (k < n && isSpace(source.charAt(k))) k++;
    const q = source.charAt(k);
    let next: number;
    let value: string;
    if (q === '"' || q === "'") {
      next = skipString(source, k);
      value = unquote(source.slice(k, next));
    } else {
      next = k;
      while (next < n && !/[\s>{};,]/.test(source.charAt(next))) next++;
      value = source.slice(k, next);
    }
    if (!Object.hasOwn(attrs, name)) attrs[name] = value;
    i = Math.max(next, k + 1);
  }
  return attrs;
}

// ---------------------------------------------------------------------------------------------------------------
// CFML model
// ---------------------------------------------------------------------------------------------------------------

/** Component declaration: attributes with lower-cased keys and the 1-based line span up to `{` or `>`. */
export interface CfmlDeclaration {
  line: number;
  endLine: number;
  attrs: Record<string, string>;
}

/** A script `property …;` or tag `<cfproperty …>`. */
export interface CfmlProperty {
  name: string;
  attrs: Record<string, string>;
  line: number;
}

/** A formal parameter; `default` is the raw default expression when one is declared. */
export interface CfmlArgument {
  name: string;
  line: number;
  default?: string;
}

/** A `<cfinclude template>` or script `include` inside a function body. */
export interface CfmlInclude {
  template: string;
  line: number;
  offset: number;
}

/**
 * A function; `body` is comment-stripped, `offset` is its start in the unit text and `bodyLine` its first line.
 * A `.cfm` template is modelled as the pseudo-function `''` spanning the whole file.
 */
export interface CfmlFunction {
  name: string;
  access: string;
  args: CfmlArgument[];
  startLine: number;
  endLine: number;
  body: string;
  offset: number;
  bodyLine: number;
  includes: CfmlInclude[];
  /** Lexical syntax of `body`; absent, it follows the unit's syntax. */
  mode?: SourceMode;
}

/** A parsed CFML file: components carry a declaration, templates (`syntax: 'template'`) do not. */
export interface CfmlUnit {
  path: string;
  syntax: 'script' | 'tag' | 'template';
  /** Comment-stripped text with original offsets. */
  text: string;
  properties: CfmlProperty[];
  functions: CfmlFunction[];
}

/** A parsed `.cfc` component. */
export interface CfmlComponent extends CfmlUnit {
  syntax: 'script' | 'tag';
  declaration: CfmlDeclaration;
}

/** A parsed `.cfm` template. */
export interface CfmlTemplate extends CfmlUnit {
  syntax: 'template';
}

// ---------------------------------------------------------------------------------------------------------------
// Script tokens
// ---------------------------------------------------------------------------------------------------------------

interface Token {
  k: 'id' | 'str' | 'num' | 'p';
  v: string;
  s: number;
  e: number;
}

function tokenize(text: string, from: number, to: number): Token[] {
  const toks: Token[] = [];
  let i = from;
  while (i < to) {
    const c = text.charAt(i);
    if (isSpace(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      const e = Math.min(skipString(text, i, to), to);
      toks.push({ k: 'str', v: text.slice(i, e), s: i, e });
      i = e;
    } else if (isIdentStart(c)) {
      let e = i + 1;
      while (e < to && isIdentPart(text.charAt(e))) e++;
      toks.push({ k: 'id', v: text.slice(i, e), s: i, e });
      i = e;
    } else if (/\d/.test(c)) {
      let e = i + 1;
      while (e < to && /[\d.]/.test(text.charAt(e))) e++;
      toks.push({ k: 'num', v: text.slice(i, e), s: i, e });
      i = e;
    } else {
      toks.push({ k: 'p', v: c, s: i, e: i + 1 });
      i++;
    }
  }
  return toks;
}

/** For each opening bracket token, the index of its closing token (-1 when unbalanced). */
function bracketPairs(toks: readonly Token[]): Int32Array {
  const pairs = new Int32Array(toks.length).fill(-1);
  const stack: number[] = [];
  const closer: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  toks.forEach((t, i) => {
    if (t.k !== 'p') return;
    if (t.v in closer) {
      stack.push(i);
    } else if (t.v === ')' || t.v === ']' || t.v === '}') {
      const open = stack.pop();
      if (open !== undefined && closer[toks[open]?.v ?? ''] === t.v) {
        pairs[open] = i;
        pairs[i] = open;
      }
    }
  });
  return pairs;
}


function isP(t: Token | undefined, v: string): boolean {
  return t !== undefined && t.k === 'p' && t.v === v;
}

function isWord(t: Token | undefined, w: string): boolean {
  return t !== undefined && t.k === 'id' && t.v.toLowerCase() === w;
}

// ---------------------------------------------------------------------------------------------------------------
// Component and template parsing
// ---------------------------------------------------------------------------------------------------------------

const ACCESS = new Set(['public', 'private', 'remote', 'package']);

/** `<cfinclude template>`, script `include "…";` and `cfinclude(template=…)` in `body`, outside its literal text. */
function findIncludes(body: string, offset: number, lines: LineIndex, mode: SourceMode): CfmlInclude[] {
  const found: CfmlInclude[] = [];
  const literal = literalMask(body, mode);
  const push = (template: string | undefined, at: number): void => {
    if (template !== undefined && template !== '') found.push({ template, line: lines.line(offset + at), offset: at });
  };
  for (const m of body.matchAll(/<cfinclude\b/gi)) {
    if (literal[m.index] === 1) continue;
    push(parseAttributes(body.slice(m.index + m[0].length, tagEnd(body, m.index) - 1)).template, m.index);
  }
  for (const m of body.matchAll(/\bcfinclude\s*\(/gi)) {
    if (literal[m.index] === 1) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(body, open);
    if (close > open) push(parseAttributes(body.slice(open + 1, close)).template, m.index);
  }
  for (const m of body.matchAll(/(?<![\w$.<])include\s+(["'])/gi)) {
    if (literal[m.index] === 1) continue;
    const quoteAt = m.index + m[0].length - 1;
    push(unquote(body.slice(quoteAt, skipString(body, quoteAt))), m.index);
  }
  return found.sort((a, b) => a.offset - b.offset);
}

function scriptParams(text: string, toks: readonly Token[], pairs: Int32Array, open: number, close: number, lines: LineIndex): CfmlArgument[] {
  const args: CfmlArgument[] = [];
  const param = (from: number, to: number): void => {
    let eq = -1;
    for (let j = from; j < to; j++) {
      const t = toks[j];
      if (t === undefined) break;
      if (isP(t, '=') && !isP(toks[j + 1], '=')) {
        eq = j;
        break;
      }
      const pair = pairs[j] ?? -1;
      if (t.k === 'p' && '([{'.includes(t.v) && pair > j) j = pair;
    }
    const prefixEnd = eq < 0 ? to : eq;
    let nameTok: Token | undefined;
    for (let j = from; j < prefixEnd; j++) if (toks[j]?.k === 'id') nameTok = toks[j];
    if (nameTok === undefined) return;
    const arg: CfmlArgument = { name: nameTok.v, line: lines.line(nameTok.s) };
    const first = toks[eq + 1];
    const lastTok = toks[to - 1];
    if (eq >= 0 && first !== undefined && lastTok !== undefined && eq + 1 < to) arg.default = text.slice(first.s, lastTok.e).trim();
    args.push(arg);
  };
  let segStart = open + 1;
  for (let j = open + 1; j <= close; j++) {
    const t = toks[j];
    if (j === close || isP(t, ',')) {
      if (j > segStart) param(segStart, j);
      segStart = j + 1;
      continue;
    }
    const pair = pairs[j] ?? -1;
    if (t !== undefined && t.k === 'p' && '([{'.includes(t.v) && pair > j) j = pair;
  }
  return args;
}

/** Script `function` and `property` members at the top level of the token range `[from, to)`. */
function scanScriptMembers(
  text: string,
  toks: readonly Token[],
  pairs: Int32Array,
  from: number,
  to: number,
  lines: LineIndex,
  functions: CfmlFunction[],
  properties: CfmlProperty[] | null,
): void {
  let i = from;
  let stmtStart = from;
  while (i < to) {
    const t = toks[i];
    if (t === undefined) break;
    if (t.k === 'p') {
      if (t.v === ';' || t.v === '}') {
        i++;
        stmtStart = i;
        continue;
      }
      const pair = pairs[i] ?? -1;
      if ('([{'.includes(t.v) && pair > i) {
        i = pair + 1;
        if (t.v === '{') stmtStart = i;
        continue;
      }
      i++;
      continue;
    }
    const word = t.k === 'id' ? t.v.toLowerCase() : '';
    if (word === 'property' && i === stmtStart && properties !== null) {
      let j = i + 1;
      while (j < to && !isP(toks[j], ';') && !isP(toks[j], '}')) j++;
      const end = toks[j]?.s ?? text.length;
      const attrs = parseAttributes(text.slice(t.e, end));
      let name = attrs.name;
      if (name === undefined) {
        for (let k = i + 1; k < j && !isP(toks[k + 1], '='); k++) if (toks[k]?.k === 'id') name = toks[k]?.v;
      }
      if (name !== undefined) properties.push({ name, attrs, line: lines.line(t.s) });
      i = j + 1;
      stmtStart = i;
      continue;
    }
    const nameTok = toks[i + 1];
    const open = i + 2;
    if (word === 'function' && nameTok?.k === 'id' && isP(toks[open], '(') && (pairs[open] ?? -1) > open) {
      const close = pairs[open] ?? open;
      let k = i - 1;
      while (k >= stmtStart && (toks[k]?.k === 'id' || isP(toks[k], '.'))) k--;
      const modifiers = toks.slice(k + 1, i).filter((m) => m.k === 'id').map((m) => m.v.toLowerCase());
      const startTok = toks[k + 1] ?? t;
      let j = close + 1;
      while (j < to && !isP(toks[j], '{') && !isP(toks[j], ';')) j++;
      const braceTok = toks[j];
      const bodyClose = pairs[j] ?? -1;
      if (isP(braceTok, '{') && braceTok !== undefined && bodyClose > j) {
        const closeTok = toks[bodyClose] ?? braceTok;
        const offset = braceTok.e;
        const body = text.slice(offset, closeTok.s);
        functions.push({
          name: nameTok.v,
          access: modifiers.find((m) => ACCESS.has(m)) ?? 'public',
          args: scriptParams(text, toks, pairs, open, close, lines),
          startLine: lines.line(startTok.s),
          endLine: lines.line(closeTok.s),
          body,
          offset,
          bodyLine: lines.line(offset),
          includes: findIncludes(body, offset, lines, 'script'),
          mode: 'script',
        });
        i = bodyClose + 1;
      } else {
        i = j + 1;
      }
      stmtStart = i;
      continue;
    }
    i++;
  }
}

/** Script members of every `<cfscript>` block of `text` that lies outside the `skip` ranges. */
function scriptBlockMembers(
  text: string,
  lines: LineIndex,
  skip: ReadonlyArray<readonly [number, number]>,
  functions: CfmlFunction[],
  properties: CfmlProperty[] | null,
): void {
  for (const m of text.matchAll(/<cfscript\b/gi)) {
    if (skip.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const start = tagEnd(text, m.index);
    const close = indexOfCi(text, '</cfscript', start);
    const end = close < 0 ? text.length : close;
    const toks = tokenize(text, start, end);
    scanScriptMembers(text, toks, bracketPairs(toks), 0, toks.length, lines, functions, properties);
  }
}

/** `<cffunction>` members from `from` on, with their `<cfargument>` parameters, and the ranges they span. */
function tagFunctions(text: string, lines: LineIndex, from: number): { functions: CfmlFunction[]; ranges: Array<[number, number]> } {
  const functions: CfmlFunction[] = [];
  const ranges: Array<[number, number]> = [];
  const re = /<cffunction\b/gi;
  re.lastIndex = from;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const open = m.index;
    const bodyStart = tagEnd(text, open);
    const attrs = parseAttributes(text.slice(open + m[0].length, bodyStart - 1));
    const close = indexOfCi(text, '</cffunction', bodyStart);
    const bodyEnd = close < 0 ? text.length : close;
    const body = text.slice(bodyStart, bodyEnd);
    const args: CfmlArgument[] = [];
    for (const a of body.matchAll(/<cfargument\b/gi)) {
      const argAttrs = parseAttributes(body.slice(a.index + a[0].length, tagEnd(body, a.index) - 1));
      if (argAttrs.name === undefined) continue;
      const arg: CfmlArgument = { name: argAttrs.name, line: lines.line(bodyStart + a.index) };
      // Re-quoted so tag and script defaults share one form: a CFML expression.
      if (argAttrs.default !== undefined) arg.default = `"${argAttrs.default.replace(/"/g, '""')}"`;
      args.push(arg);
    }
    functions.push({
      name: attrs.name ?? '',
      access: (attrs.access ?? 'public').toLowerCase(),
      args,
      startLine: lines.line(open),
      endLine: lines.line(bodyEnd),
      body,
      offset: bodyStart,
      bodyLine: lines.line(bodyStart),
      includes: findIncludes(body, bodyStart, lines, 'tag'),
      mode: 'tag',
    });
    ranges.push([open, bodyEnd]);
    re.lastIndex = bodyEnd;
  }
  return { functions, ranges };
}

function byOffset(a: CfmlFunction, b: CfmlFunction): number {
  return a.offset - b.offset;
}

/** Parses a `.cfc` in script or tag syntax; null when it declares no component. */
export function parseCfmlComponent(path: string, source: string): CfmlComponent | null {
  const raw = stripBom(source);
  const mode = detectMode(raw);
  const text = stripComments(raw, mode);
  const lines = new LineIndex(text);
  const properties: CfmlProperty[] = [];
  if (mode === 'script') {
    const toks = tokenize(text, 0, text.length);
    const kw = toks.findIndex((t) => isWord(t, 'component'));
    if (kw < 0) return null;
    let brace = kw + 1;
    while (brace < toks.length && !isP(toks[brace], '{')) brace++;
    const kwTok = toks[kw];
    const braceTok = toks[brace];
    if (kwTok === undefined || braceTok === undefined) return null;
    const pairs = bracketPairs(toks);
    const close = pairs[brace] ?? -1;
    const functions: CfmlFunction[] = [];
    scanScriptMembers(text, toks, pairs, brace + 1, close > brace ? close : toks.length, lines, functions, properties);
    return {
      path,
      syntax: 'script',
      text,
      declaration: { line: lines.line(kwTok.s), endLine: lines.line(braceTok.s), attrs: parseAttributes(text.slice(kwTok.e, braceTok.s)) },
      properties,
      functions: functions.sort(byOffset),
    };
  }
  const decl = /<cfcomponent\b/i.exec(text);
  if (decl === null) return null;
  const declEnd = tagEnd(text, decl.index);
  const { functions, ranges } = tagFunctions(text, lines, declEnd);
  for (const m of text.matchAll(/<cfproperty\b/gi)) {
    if (m.index < declEnd || ranges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const attrs = parseAttributes(text.slice(m.index + m[0].length, tagEnd(text, m.index) - 1));
    if (attrs.name !== undefined) properties.push({ name: attrs.name, attrs, line: lines.line(m.index) });
  }
  scriptBlockMembers(text, lines, ranges, functions, properties);
  return {
    path,
    syntax: 'tag',
    text,
    declaration: {
      line: lines.line(decl.index),
      endLine: lines.line(declEnd - 1),
      attrs: parseAttributes(text.slice(decl.index + decl[0].length, declEnd - 1)),
    },
    properties: properties.sort((a, b) => a.line - b.line),
    functions: functions.sort(byOffset),
  };
}

/** Parses a `.cfm` as the pseudo-function `''` over the whole file plus any functions it defines. */
export function parseCfmTemplate(path: string, source: string): CfmlTemplate {
  const text = stripComments(stripBom(source), 'tag');
  const lines = new LineIndex(text);
  const whole: CfmlFunction = {
    name: '',
    access: 'public',
    args: [],
    startLine: 1,
    endLine: lines.line(Math.max(0, text.length - 1)),
    body: text,
    offset: 0,
    bodyLine: 1,
    includes: findIncludes(text, 0, lines, 'tag'),
    mode: 'tag',
  };
  const { functions, ranges } = tagFunctions(text, lines, 0);
  scriptBlockMembers(text, lines, ranges, functions, null);
  return { path, syntax: 'template', text, properties: [], functions: [whole, ...functions.sort(byOffset)] };
}


// ---------------------------------------------------------------------------------------------------------------
// Control structure: guards and threads
// ---------------------------------------------------------------------------------------------------------------

/** A branch condition as the source states it: an expression, a switch case, or a combination. */
export type GuardCondition =
  | { k: 'expr'; text: string }
  | { k: 'case'; subject: string; values: ReadonlyArray<string | null> }
  | { k: 'not'; of: GuardCondition }
  | { k: 'and'; of: readonly GuardCondition[] }
  | { k: 'or'; of: readonly GuardCondition[] };

/** A `<cfthread>` or script `thread` body that runs outside its request. */
export interface ThreadSpan {
  name: string;
  line: number;
  endLine: number;
}

interface Region {
  start: number;
  end: number;
  cond?: GuardCondition;
  thread?: { name: string; open: number; close: number };
  /** A body that may run any number of times (`loop`: a loop or nested function) or stop part-way (`try`). */
  block?: 'loop' | 'try';
  /** What must hold for a loop body to run at all; it prunes the body when false and is otherwise ignored. */
  entry?: GuardCondition;
}

/** A statement that leaves the function or request: `abort`, `return`, `throw`/`rethrow` or `location`. */
interface Exit {
  at: number;
  kind: 'abort' | 'return' | 'throw' | 'location';
}

const EXIT_WORDS: Readonly<Record<string, Exit['kind']>> = {
  abort: 'abort',
  cfabort: 'abort',
  return: 'return',
  throw: 'throw',
  rethrow: 'throw',
  cfthrow: 'throw',
  location: 'location',
  cflocation: 'location',
};
const LOOP_WORDS = new Set(['for', 'while', 'do']);

/** Readable source form of a guard condition. */
export function describeCondition(c: GuardCondition): string {
  switch (c.k) {
    case 'expr':
      return c.text.replace(/\s+/g, ' ').trim();
    case 'case':
      return `switch(${c.subject.replace(/\s+/g, ' ').trim()}) case ${c.values.map((v) => (v === null ? '?' : `'${v}'`)).join(', ')}`;
    case 'not':
      return `!(${describeCondition(c.of)})`;
    case 'and':
      return c.of.map((x) => (x.k === 'or' ? `(${describeCondition(x)})` : describeCondition(x))).join(' && ');
    case 'or':
      return c.of.map(describeCondition).join(' || ');
  }
}

function exprCond(text: string): GuardCondition {
  return { k: 'expr', text: text.trim() };
}

/** Condition of branch `index` of an if/else-if chain, or of its trailing else. */
function branchCond(chain: readonly GuardCondition[], index: number, isElse: boolean): GuardCondition {
  const negated = chain.slice(0, isElse ? chain.length : index).map((c): GuardCondition => ({ k: 'not', of: c }));
  const own = chain[index];
  if (isElse || own === undefined) return negated.length === 1 && negated[0] !== undefined ? negated[0] : { k: 'and', of: negated };
  return negated.length === 0 ? own : { k: 'and', of: [...negated, own] };
}

function literalValue(t: Token | undefined): string | null {
  if (t === undefined) return null;
  if (t.k === 'num') return t.v;
  if (t.k === 'str') {
    const inner = unquote(t.v);
    return interpolates(inner) ? null : inner.replace(/##/g, '#');
  }
  if (t.k === 'id' && /^(true|false)$/i.test(t.v)) return t.v.toLowerCase();
  return null;
}

/** The expression a tag attribute holds: the inside of a whole `#…#`, a number as written, else undefined. */
function attributeExpr(value: string | undefined): string | undefined {
  const t = value?.trim() ?? '';
  if (/^#[^#]+#$/.test(t)) return t.slice(1, -1).trim();
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(t) ? t : undefined;
}

/** What must hold for a `<cfloop>` body to run once: its index range is not empty, its array has an item, or its condition holds. */
function tagLoopEntry(attrs: Readonly<Record<string, string>>): GuardCondition | undefined {
  if (attrs.condition !== undefined) return attrs.condition.trim() === '' ? undefined : exprCond(stripHashes(attrs.condition));
  if (attrs.array !== undefined) {
    const array = attributeExpr(attrs.array);
    return array === undefined ? undefined : exprCond(`arrayLen(${array}) gte 1`);
  }
  const from = attributeExpr(attrs.from);
  const to = attributeExpr(attrs.to);
  const step = attrs.step === undefined ? '1' : attributeExpr(attrs.step);
  if (from === undefined || to === undefined || step === undefined || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(step) || Number(step) === 0) return undefined;
  return exprCond(Number(step) > 0 ? `(${to}) gte (${from})` : `(${from}) gte (${to})`);
}

/**
 * What must hold for a script loop body to run once: a `while` condition, or a `for` condition with its loop
 * variable replaced by the literal the header starts it at.
 */
function scriptLoopEntry(word: string, header: string): GuardCondition | undefined {
  if (word === 'while') return header.trim() === '' ? undefined : exprCond(header);
  if (word !== 'for') return undefined;
  const toks = tokenize(header, 0, header.length);
  const pairs = bracketPairs(toks);
  const semis: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    const p = pairs[i] ?? -1;
    if (p > i) i = p;
    else if (isP(toks[i], ';')) semis.push(i);
  }
  if (semis.length !== 2) return undefined;
  const [s1 = 0, s2 = 0] = semis;
  const cond = toks.slice(s1 + 1, s2);
  if (cond.length === 0) return undefined;
  const init = toks.slice(isWord(toks[0], 'var') ? 1 : 0, s1);
  const name = init.length === 3 && init[0]?.k === 'id' && isP(init[1], '=') ? init[0].v.toLowerCase() : undefined;
  const start = name === undefined ? null : literalValue(init[2]);
  const from = cond[0]?.s ?? 0;
  let text = '';
  let at = from;
  cond.forEach((t, i) => {
    const loopVar = t.k === 'id' && t.v.toLowerCase() === name && !isP(cond[i - 1], '.') && !isP(cond[i + 1], '(');
    if (!loopVar) return;
    text += header.slice(at, t.s) + (start === null ? '' : `(${init[2]?.v ?? ''})`);
    at = t.e;
  });
  if (name !== undefined && start === null && at !== from) return undefined;
  text += header.slice(at, cond[cond.length - 1]?.e ?? at);
  return exprCond(text);
}

const BLOCK_WORDS = new Set(['for', 'while', 'do', 'try', 'catch', 'finally', 'else', 'transaction', 'lock', 'savecontent']);
const ATTRIBUTE_BLOCKS = new Set(['transaction', 'lock', 'savecontent']);

/** Guard, thread and block regions of the cfscript between `from` and `to` of `text`, and its exit statements. */
function scriptRegions(text: string, from: number, to: number, out: Region[], exits: Exit[]): void {
  const toks = tokenize(text, from, to);
  const pairs = bracketPairs(toks);
  const startOf = (i: number): number => toks[i]?.s ?? to;
  const endOf = (i: number): number => toks[i]?.e ?? to;
  const closeOf = (i: number, end: number): number => {
    const p = pairs[i] ?? -1;
    return p > i && p < end ? p : end;
  };
  const skipBracket = (j: number, end: number): number => {
    const t = toks[j];
    const p = pairs[j] ?? -1;
    return t !== undefined && t.k === 'p' && '([{'.includes(t.v) && p > j && p < end ? p + 1 : j + 1;
  };
  const seq = (from0: number, end: number): void => {
    let i = from0;
    while (i < end) i = stmt(i, end);
  };
  /** Marks the brace body opening at `j` as a nested function; returns the index past it, or -1 when none opens there. */
  const nested = (j: number, end: number): number => {
    const brace = toks[j];
    if (brace === undefined || !isP(brace, '{')) return -1;
    const c = closeOf(j, end);
    out.push({ start: brace.e, end: startOf(c), block: 'loop' });
    return c + 1;
  };
  const simple = (i: number, end: number): number => {
    let j = i;
    while (j < end) {
      if (isP(toks[j], ';')) return j + 1;
      if (j > i && isP(toks[j], '}')) return j;
      // Closure bodies run when and as often as their callee chooses.
      if (isWord(toks[j], 'function') && isP(toks[j + 1], '(')) {
        const past = nested(closeOf(j + 1, end) + 1, end);
        if (past >= 0) {
          j = past;
          continue;
        }
      }
      if (isP(toks[j], '=') && isP(toks[j + 1], '>') && toks[j]?.e === toks[j + 1]?.s) {
        const past = nested(j + 2, end);
        if (past >= 0) {
          j = past;
          continue;
        }
      }
      j = skipBracket(j, end);
    }
    return end;
  };
  const branch = (j: number, end: number, cond: GuardCondition): number => {
    const t = toks[j];
    if (t === undefined || j >= end) return end;
    if (isP(t, '{')) {
      const c = closeOf(j, end);
      out.push({ start: t.e, end: startOf(c), cond });
      seq(j + 1, c);
      return c + 1;
    }
    const next = stmt(j, end);
    out.push({ start: t.s, end: endOf(next - 1), cond });
    return next;
  };
  const ifStmt = (i: number, end: number): number => {
    const chain: GuardCondition[] = [];
    let j = i;
    for (;;) {
      const close = closeOf(j + 1, end);
      chain.push(exprCond(text.slice(endOf(j + 1), startOf(close))));
      j = branch(close + 1, end, branchCond(chain, chain.length - 1, false));
      if (!isWord(toks[j], 'else') || j >= end) return j;
      if (isWord(toks[j + 1], 'if') && isP(toks[j + 2], '(')) {
        j++;
        continue;
      }
      return branch(j + 1, end, branchCond(chain, chain.length, true));
    }
  };
  const switchStmt = (i: number, end: number): number => {
    const close = closeOf(i + 1, end);
    const subject = text.slice(endOf(i + 1), startOf(close)).trim();
    const open = close + 1;
    if (!isP(toks[open], '{')) return open;
    const bodyClose = closeOf(open, end);
    const caseConds: GuardCondition[] = [];
    let current: { start: number; values: Array<string | null>; isDefault: boolean; hasStmt: boolean } | null = null;
    const finish = (endOffset: number): void => {
      if (current === null) return;
      const cond: GuardCondition = current.isDefault
        ? { k: 'not', of: { k: 'or', of: caseConds } }
        : { k: 'case', subject, values: current.values };
      if (!current.isDefault) caseConds.push(cond);
      out.push({ start: current.start, end: endOffset, cond });
      current = null;
    };
    let k = open + 1;
    while (k < bodyClose) {
      const t = toks[k];
      if (isWord(t, 'case') && t !== undefined) {
        let q = k + 1;
        while (q < bodyClose && !isP(toks[q], ':')) q = skipBracket(q, bodyClose);
        const valueToks = toks.slice(k + 1, q);
        const value = valueToks.length === 1 ? literalValue(valueToks[0]) : null;
        if (current !== null && !current.isDefault && !current.hasStmt) {
          current.values.push(value);
        } else {
          finish(t.s);
          current = { start: endOf(q), values: [value], isDefault: false, hasStmt: false };
        }
        k = q + 1;
        continue;
      }
      if (isWord(t, 'default') && isP(toks[k + 1], ':') && t !== undefined) {
        finish(t.s);
        current = { start: endOf(k + 1), values: [], isDefault: true, hasStmt: false };
        k += 2;
        continue;
      }
      if (current !== null) current.hasStmt = true;
      k = stmt(k, bodyClose);
    }
    finish(startOf(bodyClose));
    return bodyClose + 1;
  };
  const threadStmt = (i: number, end: number): number => {
    let j = i + 1;
    if (isWord(toks[i], 'cfthread')) j = closeOf(i + 1, end) + 1;
    else while (j < end && !isP(toks[j], '{') && !isP(toks[j], ';')) j = skipBracket(j, end);
    const brace = toks[j];
    if (brace === undefined || !isP(brace, '{')) return j + 1;
    const c = closeOf(j, end);
    const attrs = parseAttributes(text.slice(endOf(i), brace.s));
    if ((attrs.action ?? 'run').toLowerCase() === 'run') {
      out.push({ start: brace.e, end: startOf(c), thread: { name: attrs.name ?? '', open: startOf(i), close: startOf(c) } });
    }
    seq(j + 1, c);
    return c + 1;
  };
  const stmt = (i: number, end: number): number => {
    const t = toks[i];
    if (t === undefined) return end;
    if (t.k === 'p') {
      if (t.v === '{') {
        const c = closeOf(i, end);
        seq(i + 1, c);
        return c + 1;
      }
      if (t.v === ';' || t.v === '}') return i + 1;
    }
    if (t.k === 'id') {
      const w = t.v.toLowerCase();
      if (w === 'if' && isP(toks[i + 1], '(')) return ifStmt(i, end);
      if (w === 'switch' && isP(toks[i + 1], '(')) return switchStmt(i, end);
      if ((w === 'thread' && toks[i + 1]?.k === 'id') || (w === 'cfthread' && isP(toks[i + 1], '('))) return threadStmt(i, end);
      if (w === 'function') {
        let j = i + 1;
        while (j < end && !isP(toks[j], '{') && !isP(toks[j], ';')) j = skipBracket(j, end);
        const past = nested(j, end);
        return past >= 0 ? past : j + 1;
      }
      if (BLOCK_WORDS.has(w)) {
        let j = i + 1;
        const header = isP(toks[j], '(') ? closeOf(j, end) : -1;
        if (header >= 0) j = header + 1;
        if (ATTRIBUTE_BLOCKS.has(w)) while (j < end && !isP(toks[j], '{') && !isP(toks[j], ';')) j++;
        // A catch body runs only when its try block throws, which no request predicate decides.
        if (w === 'catch' && isP(toks[j], '{')) {
          return branch(j, end, exprCond(`catch${header >= 0 ? text.slice(startOf(i + 1), endOf(header)) : ''}`));
        }
        const block: Region['block'] = LOOP_WORDS.has(w) ? 'loop' : w === 'try' ? 'try' : undefined;
        const entry = block === 'loop' && header >= 0 ? scriptLoopEntry(w, text.slice(endOf(i + 1), startOf(header))) : undefined;
        const region = (start: number, stop: number): Region => ({ start, end: stop, block, ...(entry === undefined ? {} : { entry }) });
        const brace = toks[j];
        if (brace !== undefined && isP(brace, '{')) {
          const c = closeOf(j, end);
          if (block !== undefined) out.push(region(brace.e, startOf(c)));
          seq(j + 1, c);
          return c + 1;
        }
        if (j >= end) return end;
        const next = stmt(j, end);
        if (block !== undefined) out.push(region(startOf(j), endOf(next - 1)));
        return next;
      }
      const exit = EXIT_WORDS[w];
      if (exit !== undefined && !isP(toks[i + 1], '.') && !(isP(toks[i + 1], '=') && !isP(toks[i + 2], '='))) exits.push({ at: t.s, kind: exit });
    }
    return simple(i, end);
  };
  seq(0, toks.length);
}

function stripHashes(expr: string): string {
  const t = expr.trim();
  return t.length > 1 && t.startsWith('#') && t.endsWith('#') ? t.slice(1, -1).trim() : t;
}

/** Guard, thread and block regions of tag-syntax `text` and its exit tags, descending into `<cfscript>` blocks. */
function tagRegions(text: string, out: Region[], exits: Exit[]): void {
  interface SwitchFrame {
    k: 'switch';
    subject: string;
    caseConds: GuardCondition[];
  }
  type Frame =
    | { k: 'if'; chain: GuardCondition[]; start: number; isElse: boolean }
    | SwitchFrame
    | { k: 'case'; sw: SwitchFrame | undefined; values: Array<string | null>; start: number }
    | { k: 'default'; sw: SwitchFrame | undefined; start: number }
    | { k: 'catch'; text: string; start: number }
    | { k: 'thread'; name: string; open: number; start: number }
    | { k: 'loop' | 'try' | 'output'; block: Region['block']; start: number; entry?: GuardCondition };
  const frames: Frame[] = [];
  const innermost = (k: Frame['k']): number => {
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i]?.k === k) return i;
    return -1;
  };
  const innermostSwitch = (): SwitchFrame | undefined => {
    const f = frames[innermost('switch')];
    return f?.k === 'switch' ? f : undefined;
  };
  const re = /<(\/?)cf(if|elseif|else|switch|case|defaultcase|catch|thread|script|loop|try|output|abort|return|throw|rethrow|location)\b/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const at = m.index;
    const end = tagEnd(text, at);
    const name = (m[2] ?? '').toLowerCase();
    const rawInner = text.slice(at + m[0].length, Math.max(at + m[0].length, end - 1));
    const selfClosing = /\/\s*$/.test(rawInner);
    const inner = rawInner.replace(/\/\s*$/, '');
    re.lastIndex = end;
    const exit = m[1] === '/' ? undefined : EXIT_WORDS[name];
    if (exit !== undefined) {
      exits.push({ at, kind: exit });
      continue;
    }
    if (name === 'loop' || name === 'try' || name === 'output') {
      if (m[1] !== '/') {
        const attrs = name === 'try' ? {} : parseAttributes(inner);
        const block: Region['block'] = name === 'try' ? 'try' : name === 'loop' || attrs.query !== undefined || attrs.group !== undefined ? 'loop' : undefined;
        const entry = name === 'loop' ? tagLoopEntry(attrs) : undefined;
        if (!selfClosing) frames.push({ k: name, block, start: end, ...(entry === undefined ? {} : { entry }) });
      } else {
        const idx = innermost(name);
        const f = frames[idx];
        if (f !== undefined && (f.k === 'loop' || f.k === 'try' || f.k === 'output')) {
          if (f.block !== undefined) out.push({ start: f.start, end: at, block: f.block, ...(f.entry === undefined ? {} : { entry: f.entry }) });
          frames.splice(idx);
        }
      }
      continue;
    }
    if (m[1] !== '/') {
      if (name === 'script') {
        const close = indexOfCi(text, '</cfscript', end);
        const stop = close < 0 ? text.length : close;
        scriptRegions(text, end, stop, out, exits);
        re.lastIndex = stop;
      } else if (name === 'if') {
        frames.push({ k: 'if', chain: [exprCond(inner)], start: end, isElse: false });
      } else if (name === 'elseif' || name === 'else') {
        const f = frames[innermost('if')];
        if (f?.k !== 'if' || f.isElse) continue;
        out.push({ start: f.start, end: at, cond: branchCond(f.chain, f.chain.length - 1, false) });
        if (name === 'elseif') f.chain.push(exprCond(inner));
        else f.isElse = true;
        f.start = end;
      } else if (name === 'switch') {
        frames.push({ k: 'switch', subject: stripHashes(parseAttributes(inner).expression ?? ''), caseConds: [] });
      } else if (name === 'case') {
        const attrs = parseAttributes(inner);
        const delimiters = attrs.delimiters ?? ',';
        const values = (attrs.value ?? '')
          .split(new RegExp(`[${delimiters.replace(/[\]\\^-]/g, '\\$&')}]`))
          .map((v) => (interpolates(v) ? null : v.trim()));
        frames.push({ k: 'case', sw: innermostSwitch(), values, start: end });
      } else if (name === 'defaultcase') {
        frames.push({ k: 'default', sw: innermostSwitch(), start: end });
      } else if (name === 'catch' && !selfClosing) {
        // A catch body runs only when its try block throws, which no request predicate decides.
        frames.push({ k: 'catch', text: `cfcatch ${inner.trim()}`.trim(), start: end });
      } else if (name === 'thread') {
        const attrs = parseAttributes(inner);
        if ((attrs.action ?? 'run').toLowerCase() === 'run' && !selfClosing) {
          frames.push({ k: 'thread', name: attrs.name ?? '', open: at, start: end });
        }
      }
      continue;
    }
    const idx = innermost(name === 'defaultcase' ? 'default' : (name as Frame['k']));
    const f = frames[idx];
    if (f === undefined) continue;
    if (f.k === 'if') {
      out.push({ start: f.start, end: at, cond: branchCond(f.chain, f.isElse ? f.chain.length : f.chain.length - 1, f.isElse) });
    } else if (f.k === 'case') {
      const cond: GuardCondition = { k: 'case', subject: f.sw?.subject ?? '', values: f.values };
      f.sw?.caseConds.push(cond);
      out.push({ start: f.start, end: at, cond });
    } else if (f.k === 'default') {
      out.push({ start: f.start, end: at, cond: { k: 'not', of: { k: 'or', of: f.sw?.caseConds ?? [] } } });
    } else if (f.k === 'catch') {
      out.push({ start: f.start, end: at, cond: exprCond(f.text) });
    } else if (f.k === 'thread') {
      out.push({ start: f.start, end: at, thread: { name: f.name, open: f.open, close: at } });
    }
    frames.splice(idx);
  }
}


// ---------------------------------------------------------------------------------------------------------------
// Guard evaluation over request parameters
// ---------------------------------------------------------------------------------------------------------------

/** A predicate that holds when the parameter is present and CFML-true, as the gateway matches a `truthy` variant. */
export interface TruthyPredicate {
  readonly truthy: true;
}

/** The one {@link TruthyPredicate} value. */
export const CFML_TRUTHY: TruthyPredicate = Object.freeze({ truthy: true });

/**
 * Request predicates: a value (present and equal), `true` (present and non-empty), {@link CFML_TRUTHY} (present and
 * CFML-true) or `false`/`null` (absent or empty).
 */
export type Predicates = Readonly<Record<string, PredicateValue>>;

export type PredicateValue = string | boolean | null | TruthyPredicate;

/** Whether `p` is the CFML-truthy predicate kind. */
export function isTruthyPredicate(p: PredicateValue | undefined): p is TruthyPredicate {
  return typeof p === 'object' && p !== null;
}

/** CFML truthiness of request text as the gateway reads it: a CFML boolean that converts to true. */
export function cfTruthyText(s: string): boolean {
  return cfIsBoolean(s) && cfToBoolean(s);
}

/**
 * A name the request reaches the code under: a struct (`rc.p`), an event (`event.getValue('p')`), a Mura scope
 * (`$.event('p')`) or a bean populated from the request (`bean.getP()`), whose `component` holds keys of its own.
 */
interface Alias {
  name: string;
  kind: 'struct' | 'event' | 'scope' | 'bean';
  /** A bean's component. */
  component?: string;
  /** Lower-cased keys a bean holds a value of its own for, beyond those its component declares. */
  extra?: readonly string[];
  /** Body offsets a bean alias applies in: from `since` (its population) up to `until` (a reload or reassignment). */
  since?: number;
  until?: number;
  /** A bean not populated from the request: it holds a value of its own for every key. */
  opaque?: boolean;
  /** Known values of keys, as expressions over the request, wherever the alias applies. */
  values?: Readonly<Record<string, Ex>>;
  /** Key writes in the body that refine `values` per offset. */
  defs?: readonly KeyDef[];
  /** The bean alias and offset whose values a population copied. */
  copyFrom?: { name: string; at: number };
  /** Component of a never-loaded instance: a key without a value of its own holds the literal its init chain sets. */
  fresh?: string;
}

/**
 * A write of one key of a bean at body offset `at`: the CFML expression it stores (null when unknown; key `*` for
 * every key), and whether it is a statement of its own, so that it runs whenever its enclosing guards hold.
 */
interface KeyDef {
  key: string;
  at: number;
  expr: string | null;
  stmt: boolean;
}

/**
 * Keys a bean component holds a value of its own for (declared properties, `variables.instance` assignments and
 * its own keyed setter calls up its chain) and the functions it defines. Stored extended attributes, merged under
 * their own names, are taken not to shadow the request's control parameters.
 */
interface BeanFacts {
  held: ReadonlySet<string>;
  defined: ReadonlySet<string>;
  /** Literal values the init chain gives keys unconditionally, as a fresh instance holds them. */
  initial: Readonly<Record<string, Ex>>;
  /** By lower-cased getter name, the ORM mapping flag an inherited zero-argument mapping getter returns. */
  mapping: Readonly<Record<string, Ex>>;
}

/** CFML truthiness of an unlisted string: true, false, or not a CFML boolean. */
type CfTruth = 'T' | 'F' | 'N';

type Val =
  | { k: 'u' }
  | { k: 'a' }
  | { k: 'x'; cf?: CfTruth }
  | { k: 'p' }
  | { k: 's'; v: string }
  | { k: 'n'; v: number }
  | { k: 'b'; v: boolean }
  // An empty array or struct literal.
  | { k: 'c'; c: 'array' | 'struct' };

type Tri = 'T' | 'F' | 'U';

type CmpOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'ncontains';

type Ex =
  | { t: 'lit'; v: Val }
  | { t: 'ref'; p: string }
  | { t: 'has'; p: string }
  | { t: 'alias'; name: string }
  | { t: 'fn'; f: 'len' | 'trim' | 'case'; e: Ex }
  | { t: 'cmp'; op: CmpOp; a: Ex; b: Ex }
  | { t: 'and' | 'or'; a: Ex; b: Ex }
  | { t: 'not'; e: Ex }
  // One of several values, one per path that reaches the read.
  | { t: 'one'; of: Ex[] }
  | { t: 'unk' };

const U: Val = { k: 'u' };
const UNK: Ex = { t: 'unk' };

class GuardSyntaxError extends Error {
  override name = 'GuardSyntaxError';
}

interface Seg {
  name: string;
  call?: Ex[];
  index?: Ex;
}

/** Recursive-descent parser for the CFML expressions this module can decide; anything else becomes unknown. */
class GuardParser {
  private i = 0;
  private readonly aliases: readonly Alias[];
  private readonly formals: ReadonlyMap<string, Val>;

  constructor(
    private readonly toks: readonly Token[],
    private readonly env: GuardEnv,
  ) {
    this.aliases = env.aliases;
    this.formals = env.formals;
  }

  parse(): Ex {
    try {
      const e = this.or();
      return this.i >= this.toks.length ? e : UNK;
    } catch (err) {
      if (err instanceof GuardSyntaxError) return UNK;
      throw err;
    }
  }

  private peek(offset = 0): Token | undefined {
    return this.toks[this.i + offset];
  }

  private word(offset = 0): string {
    const t = this.peek(offset);
    return t?.k === 'id' ? t.v.toLowerCase() : '';
  }

  /** Punctuation operator at the cursor, joining adjacent characters such as `==` and `&&`. */
  private punct(): string {
    const t = this.peek();
    if (t?.k !== 'p') return '';
    const n = this.peek(1);
    const two = n?.k === 'p' && n.s === t.e ? t.v + n.v : '';
    return ['==', '!=', '<>', '>=', '<=', '&&', '||'].includes(two) ? two : t.v;
  }

  private expect(v: string): void {
    if (!isP(this.peek(), v)) throw new GuardSyntaxError(`expected ${v}`);
    this.i++;
  }

  private or(): Ex {
    let left = this.and();
    for (;;) {
      const p = this.punct();
      const w = this.word();
      if (p === '||' || w === 'or' || w === 'xor') {
        this.i += p === '||' ? 2 : 1;
        const right = this.and();
        left = w === 'xor' ? UNK : { t: 'or', a: left, b: right };
      } else {
        return left;
      }
    }
  }

  private and(): Ex {
    let left = this.not();
    for (;;) {
      const p = this.punct();
      if (p === '&&' || this.word() === 'and') {
        this.i += p === '&&' ? 2 : 1;
        left = { t: 'and', a: left, b: this.not() };
      } else {
        return left;
      }
    }
  }

  private not(): Ex {
    const p = this.punct();
    if (this.word() === 'not' || p === '!') {
      this.i++;
      return { t: 'not', e: this.not() };
    }
    return this.cmp();
  }

  private cmpOp(): CmpOp | null {
    const p = this.punct();
    const byPunct: Record<string, CmpOp> = { '==': 'eq', '!=': 'neq', '<>': 'neq', '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt' };
    const op = byPunct[p];
    if (op !== undefined) {
      this.i += p.length;
      return op;
    }
    const w = this.word();
    const single: Record<string, CmpOp> = { eq: 'eq', equal: 'eq', neq: 'neq', gt: 'gt', gte: 'gte', ge: 'gte', lt: 'lt', lte: 'lte', le: 'lte', contains: 'contains' };
    if (w === 'is') {
      this.i++;
      if (this.word() === 'not') {
        this.i++;
        return 'neq';
      }
      return 'eq';
    }
    if (w === 'not' && this.word(1) === 'equal') {
      this.i += 2;
      return 'neq';
    }
    if (w === 'does' && this.word(1) === 'not' && this.word(2) === 'contain') {
      this.i += 3;
      return 'ncontains';
    }
    if (w === 'greater' || w === 'less') {
      this.i++;
      if (this.word() === 'than') this.i++;
      if (this.word() === 'or' && this.word(1) === 'equal') {
        this.i += this.word(2) === 'to' ? 3 : 2;
        return w === 'greater' ? 'gte' : 'lte';
      }
      return w === 'greater' ? 'gt' : 'lt';
    }
    const named = single[w];
    if (named !== undefined) {
      this.i++;
      return named;
    }
    return null;
  }

  private cmp(): Ex {
    const a = this.concat();
    const op = this.cmpOp();
    return op === null ? a : { t: 'cmp', op, a, b: this.concat() };
  }

  private concat(): Ex {
    let left = this.unary();
    for (;;) {
      const p = this.punct();
      if (['&', '+', '-', '*', '/', '%', '^', '\\'].includes(p) || this.word() === 'mod') {
        this.i++;
        this.unary();
        left = UNK;
      } else if (p === '?') {
        throw new GuardSyntaxError('ternary');
      } else {
        return left;
      }
    }
  }

  private unary(): Ex {
    const p = this.punct();
    if (p === '-' || p === '+') {
      this.i++;
      this.unary();
      return UNK;
    }
    return this.primary();
  }

  private primary(): Ex {
    const t = this.peek();
    if (t === undefined) throw new GuardSyntaxError('unexpected end');
    if (isP(t, '(')) {
      this.i++;
      const e = this.or();
      this.expect(')');
      return e;
    }
    if (t.k === 'str') {
      this.i++;
      const inner = unquote(t.v);
      return interpolates(inner) ? UNK : { t: 'lit', v: { k: 's', v: inner.replace(/##/g, '#') } };
    }
    if (t.k === 'num') {
      this.i++;
      return { t: 'lit', v: { k: 'n', v: Number(t.v) } };
    }
    if ((isP(t, '[') && isP(this.peek(1), ']')) || (isP(t, '{') && isP(this.peek(1), '}'))) {
      this.i += 2;
      return { t: 'lit', v: { k: 'c', c: t.v === '[' ? 'array' : 'struct' } };
    }
    if (t.k === 'id') {
      const w = t.v.toLowerCase();
      if ((w === 'true' || w === 'false') && !isP(this.peek(1), '.') && !isP(this.peek(1), '(')) {
        this.i++;
        return { t: 'lit', v: { k: 'b', v: w === 'true' } };
      }
      return this.reference();
    }
    throw new GuardSyntaxError(`unexpected ${t.v}`);
  }

  private callArgs(): Ex[] {
    this.expect('(');
    const args: Ex[] = [];
    if (isP(this.peek(), ')')) {
      this.i++;
      return args;
    }
    for (;;) {
      if (this.peek()?.k === 'id' && isP(this.peek(1), '=') && !isP(this.peek(2), '=')) this.i += 2;
      args.push(this.or());
      if (isP(this.peek(), ',')) {
        this.i++;
        continue;
      }
      this.expect(')');
      return args;
    }
  }

  private reference(): Ex {
    const segs: Seg[] = [];
    for (;;) {
      const t = this.peek();
      if (t?.k !== 'id') throw new GuardSyntaxError('expected a name');
      this.i++;
      const seg: Seg = { name: t.v.toLowerCase() };
      if (isP(this.peek(), '(')) seg.call = this.callArgs();
      if (isP(this.peek(), '[')) {
        this.i++;
        seg.index = this.or();
        this.expect(']');
      }
      segs.push(seg);
      if (isP(this.peek(), '.') && this.peek(1)?.k === 'id') {
        this.i++;
        continue;
      }
      return this.interpret(segs);
    }
  }

  private aliasNamed(path: string, kind: Alias['kind']): boolean {
    return this.aliases.some((a) => a.kind === kind && a.name === path);
  }

  /** Whether the bean alias named `path` holds a value of its own for `key`; undefined when `path` names none. */
  private beanHolds(path: string, key: string): boolean | undefined {
    const alias = this.aliases.find((a) => a.kind === 'bean' && a.name === path);
    if (alias?.component === undefined) return undefined;
    return alias.opaque === true || this.env.facts(alias.component).held.has(key) || (alias.extra ?? []).includes(key);
  }

  /** The value bean `path` is known to hold for `key`: one it was given, else a fresh instance's init literal. */
  private knownValue(path: string, key: string): Ex | undefined {
    const alias = this.aliases.find((a) => a.kind === 'bean' && a.name === path);
    const given = alias?.values?.[key];
    if (given !== undefined) return given;
    return alias?.fresh === undefined ? undefined : this.env.facts(alias.fresh).initial[key];
  }

  /** Whether bean `path` is a never-loaded instance, whose keys are its component's and those written since. */
  private isFresh(path: string): boolean {
    return this.aliases.some((a) => a.kind === 'bean' && a.name === path && a.fresh !== undefined);
  }

  /**
   * Key `key` of bean `path`: its known value, else the request's parameter unless the bean holds a value of its own
   * for it; a fresh instance has no other keys.
   */
  private beanValue(path: string, key: string): Ex {
    const known = this.knownValue(path, key);
    if (known !== undefined) return known;
    return this.beanHolds(path, key) === false && !this.isFresh(path) ? { t: 'ref', p: key } : UNK;
  }

  /**
   * Whether bean `path` has key `key`: yes for a known value, as the request has it, unknown for a key the bean
   * holds itself; a fresh instance lacks every key it does not hold.
   */
  private beanHas(path: string, key: string): Ex {
    const known = this.knownValue(path, key);
    if (known !== undefined && known.t !== 'unk') return { t: 'lit', v: { k: 'b', v: true } };
    if (this.beanHolds(path, key) !== false) return UNK;
    return this.isFresh(path) ? { t: 'lit', v: { k: 'b', v: false } } : { t: 'has', p: key };
  }

  /** A member call on bean `path`: its values view, a keyed read or existence test, or an implicit `get<Key>()`. */
  private beanCall(path: string, call: Seg, lit: (e: Ex | undefined) => string | undefined): Ex {
    const alias = this.aliases.find((a) => a.kind === 'bean' && a.name === path);
    const args = call.call ?? [];
    if (alias?.component === undefined) return UNK;
    const key = args.length === 1 ? lit(args[0])?.toLowerCase() : undefined;
    if (call.name === 'getallvalues' && args.length === 0) {
      if (call.index === undefined) return { t: 'alias', name: path };
      const indexKey = lit(call.index)?.toLowerCase();
      return indexKey === undefined ? UNK : this.beanValue(path, indexKey);
    }
    if (call.index !== undefined) return UNK;
    if (call.name === 'getvalue' || call.name === 'get') return key === undefined ? UNK : this.beanValue(path, key);
    if (call.name === 'valueexists') return key === undefined ? UNK : this.beanHas(path, key);
    const prop = /^get([\w$]+)$/.exec(call.name)?.[1];
    const implicit = prop !== undefined && args.length === 0 && !this.env.facts(alias.component).defined.has(call.name);
    return implicit ? this.beanValue(path, prop) : UNK;
  }

  /** A zero-argument mapping getter called on the body's own receiver: the flag its component metadata fixes. */
  private mappingFlag(call: Seg): Ex | undefined {
    const receiver = this.env.receiver;
    if (receiver === undefined || call.index !== undefined || call.call?.length !== 0) return undefined;
    return this.env.facts(receiver).mapping[call.name];
  }

  /** Maps a reference chain onto request parameters, builtins or unknown. */
  private interpret(segs: readonly Seg[]): Ex {
    const last = segs[segs.length - 1];
    if (last === undefined) return UNK;
    const head = segs.slice(0, -1);
    const plain = (s: Seg): boolean => s.call === undefined && s.index === undefined;
    const plainHead = head.every(plain);
    const headPath = head.map((s) => s.name).join('.');
    const lit = (e: Ex | undefined): string | undefined => (e?.t === 'lit' && e.v.k === 's' ? e.v.v : undefined);
    if (segs.length === 1 && last.call !== undefined && last.index === undefined) {
      const [a0, a1] = last.call;
      switch (last.name) {
        case 'len':
          return { t: 'fn', f: 'len', e: a0 ?? UNK };
        case 'trim':
          return { t: 'fn', f: 'trim', e: a0 ?? UNK };
        case 'lcase':
        case 'ucase':
          return { t: 'fn', f: 'case', e: a0 ?? UNK };
        case 'arraynew':
          return { t: 'lit', v: { k: 'c', c: 'array' } };
        case 'structnew':
          return { t: 'lit', v: { k: 'c', c: 'struct' } };
        case 'isarray':
        case 'isstruct':
        case 'issimplevalue':
        case 'isjson':
        case 'arraylen':
        case 'arrayisempty':
        case 'structisempty':
          return last.call.length === 1 ? kindTest(last.name, a0 ?? UNK) : UNK;
        case 'structkeyexists': {
          const key = lit(a1)?.toLowerCase();
          if (a0?.t !== 'alias' || key === undefined) return UNK;
          return this.aliasNamed(a0.name, 'bean') ? this.beanHas(a0.name, key) : { t: 'has', p: key };
        }
        case 'isdefined': {
          const target = lit(a0)?.toLowerCase();
          if (target === undefined) return UNK;
          for (const a of this.aliases) {
            const rest = target.startsWith(`${a.name}.`) ? target.slice(a.name.length + 1) : '';
            if (!/^[\w$]+$/.test(rest)) continue;
            if (a.kind === 'struct') return { t: 'has', p: rest };
            if (a.kind === 'bean') return this.beanHas(a.name, rest);
          }
          return UNK;
        }
        default:
          return this.mappingFlag(last) ?? this.beanCall('this', last, lit);
      }
    }
    if (!plainHead) {
      // `<bean>.getAllValues().key`: the values view of a bean, `this` when the call has no receiver.
      const view = head[head.length - 1];
      const base = head.slice(0, -1);
      if (view?.name !== 'getallvalues' || view.call?.length !== 0 || view.index !== undefined || !base.every(plain) || last.call !== undefined) return UNK;
      const viewPath = base.length === 0 ? 'this' : base.map((s) => s.name).join('.');
      const key = last.index === undefined ? last.name : lit(last.index)?.toLowerCase();
      return key === undefined ? UNK : this.beanValue(viewPath, key);
    }
    const fullPath = segs.map((s) => s.name).join('.');
    if (last.call === undefined && last.index === undefined) {
      const local = segs.length === 1 || (segs.length === 2 && headPath === 'local') ? this.env.locals?.(last.name) : undefined;
      if (local !== undefined) return local;
      if (this.aliasNamed(fullPath, 'struct')) return { t: 'alias', name: fullPath };
      if (head.length > 0 && this.aliasNamed(headPath, 'struct')) return { t: 'ref', p: last.name };
      if (this.aliasNamed(fullPath, 'bean')) return { t: 'alias', name: fullPath };
      if (head.length > 0 && this.aliasNamed(headPath, 'bean')) return this.beanValue(headPath, last.name);
      const formal = segs.length === 1 || headPath === 'arguments' ? this.formals.get(last.name) : undefined;
      return segs.length <= 2 && formal !== undefined ? { t: 'lit', v: formal } : UNK;
    }
    if (last.call === undefined && last.index !== undefined) {
      const key = lit(last.index);
      if (key === undefined) return UNK;
      if (this.aliasNamed(fullPath, 'struct')) return { t: 'ref', p: key.toLowerCase() };
      return this.aliasNamed(fullPath, 'bean') ? this.beanValue(fullPath, key.toLowerCase()) : UNK;
    }
    const receiver = headPath === '' ? 'this' : headPath;
    const flag = receiver === 'this' ? this.mappingFlag(last) : undefined;
    if (flag !== undefined) return flag;
    if (this.aliasNamed(receiver, 'bean')) return this.beanCall(receiver, last, lit);
    const key = lit(last.call?.[0]);
    if (key === undefined || last.index !== undefined) return UNK;
    if (this.aliasNamed(headPath, 'event')) {
      if (last.name === 'getvalue') return { t: 'ref', p: key.toLowerCase() };
      if (last.name === 'valueexists') return { t: 'has', p: key.toLowerCase() };
    }
    if (this.aliasNamed(headPath, 'scope') && last.name === 'event' && last.call?.length === 1) {
      return { t: 'ref', p: key.toLowerCase() };
    }
    return UNK;
  }
}

const guardTokens = new Map<string, readonly Token[]>();

function parseGuard(text: string, env: GuardEnv): Ex {
  let toks = guardTokens.get(text);
  if (toks === undefined) {
    toks = tokenize(text, 0, text.length).filter((t) => !isP(t, '#'));
    guardTokens.set(text, toks);
  }
  return toks.length === 0 ? UNK : new GuardParser(toks, env).parse();
}

/** A boolean literal. */
function boolLit(b: boolean): Ex {
  return { t: 'lit', v: { k: 'b', v: b } };
}

/** `isArray`, `isStruct`, `isSimpleValue`, `isJSON`, `arrayLen`, `arrayIsEmpty` or `structIsEmpty` of a literal; unknown otherwise. */
function kindTest(name: string, e: Ex): Ex {
  if (e.t === 'one') return oneOf(e.of.map((o) => kindTest(name, o)));
  if (e.t !== 'lit') return UNK;
  const v = e.v;
  const simple = v.k === 's' || v.k === 'n' || v.k === 'b';
  switch (name) {
    case 'isarray':
      return v.k === 'c' ? boolLit(v.c === 'array') : simple ? boolLit(false) : UNK;
    case 'isstruct':
      return v.k === 'c' ? boolLit(v.c === 'struct') : simple ? boolLit(false) : UNK;
    case 'issimplevalue':
      return v.k === 'c' ? boolLit(false) : simple ? boolLit(true) : UNK;
    case 'isjson':
      // Only the empty string is certain not to parse; CFML accepts more than strict JSON.
      return v.k === 's' && v.v.trim() === '' ? boolLit(false) : UNK;
    case 'arraylen':
      return v.k === 'c' && v.c === 'array' ? { t: 'lit', v: { k: 'n', v: 0 } } : UNK;
    case 'arrayisempty':
      return v.k === 'c' && v.c === 'array' ? boolLit(true) : UNK;
    case 'structisempty':
      return v.k === 'c' && v.c === 'struct' ? boolLit(true) : UNK;
    default:
      return UNK;
  }
}

function toNum(v: Val): number | undefined {
  if (v.k === 'n') return v.v;
  if (v.k === 's' && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(v.v)) return Number(v.v);
  return undefined;
}

function toBool(v: Val): boolean | undefined {
  if (v.k === 'b') return v.v;
  if (v.k === 'n') return v.v !== 0;
  if (v.k !== 's') return undefined;
  const lower = v.v.trim().toLowerCase();
  if (lower === 'true' || lower === 'yes') return true;
  if (lower === 'false' || lower === 'no') return false;
  const n = toNum(v);
  return n === undefined ? undefined : n !== 0;
}

function toText(v: Val): string {
  if (v.k === 's') return v.v;
  if (v.k === 'n') return String(v.v);
  if (v.k === 'b') return v.v ? 'true' : 'false';
  return '';
}

/** CFML `eq`: numeric when both sides are numbers, boolean when one side is a boolean, else case-insensitive text. */
function cfEq(a: Val, b: Val): Tri {
  if (a.k === 'u' || b.k === 'u' || a.k === 'c' || b.k === 'c') return 'U';
  const x: Val = a.k === 'a' ? { k: 's', v: '' } : a;
  const y: Val = b.k === 'a' ? { k: 's', v: '' } : b;
  if (x.k === 'x' || y.k === 'x') {
    const other = x.k === 'x' ? y : x;
    if (other.k === 'x' || other.k === 'p') return 'U';
    return 'F';
  }
  if (x.k === 'p' || y.k === 'p') {
    const n = toNum(x.k === 'p' ? y : x);
    return n !== undefined && n <= 0 ? 'F' : 'U';
  }
  const nx = toNum(x);
  const ny = toNum(y);
  if (nx !== undefined && ny !== undefined) return nx === ny ? 'T' : 'F';
  if (x.k === 'b' || y.k === 'b') {
    const bx = toBool(x);
    const by = toBool(y);
    return bx !== undefined && by !== undefined && bx === by ? 'T' : 'F';
  }
  return toText(x).toLowerCase() === toText(y).toLowerCase() ? 'T' : 'F';
}

function truthy(v: Val): Tri {
  switch (v.k) {
    case 'u':
    case 'c':
      return 'U';
    case 'x':
      return v.cf === undefined ? 'U' : v.cf === 'T' ? 'T' : 'F';
    case 'a':
      return 'F';
    case 'p':
      return 'T';
    default: {
      const b = toBool(v);
      return b === true ? 'T' : 'F';
    }
  }
}

function notTri(t: Tri): Tri {
  return t === 'T' ? 'F' : t === 'F' ? 'T' : 'U';
}

/**
 * Value of one parameter in an enumerated world: absent, a known string, or some other non-empty string, split by
 * its CFML truthiness where a truthy predicate constrains the parameter.
 */
type WorldValue = { k: 'a' } | { k: 's'; v: string } | { k: 'x'; cf?: CfTruth };
type World = ReadonlyMap<string, WorldValue>;

/** The alternatives a value expression stands for: those of a `one`, else itself. */
function alternatives(e: Ex): Ex[] {
  return e.t === 'one' ? e.of.flatMap(alternatives) : [e];
}

/** The verdict every alternative agrees on, else unknown. */
function agreed(ts: readonly Tri[]): Tri {
  const first = ts[0];
  return first !== undefined && ts.every((t) => t === first) ? first : 'U';
}

function exValue(e: Ex, w: World): Val {
  switch (e.t) {
    case 'lit':
      return e.v;
    case 'ref':
      return w.get(e.p) ?? U;
    case 'one': {
      const vs = e.of.map((o) => exValue(o, w));
      const first = vs[0];
      return first !== undefined && vs.every((v) => JSON.stringify(v) === JSON.stringify(first)) ? first : U;
    }
    case 'fn': {
      if (e.e.t === 'one') return exValue({ t: 'one', of: alternatives(e.e).map((o) => ({ ...e, e: o })) }, w);
      const v = exValue(e.e, w);
      if (e.f === 'len') {
        if (v.k === 'u' || v.k === 'c') return U;
        if (v.k === 'a') return { k: 'n', v: 0 };
        if (v.k === 'x' || v.k === 'p') return { k: 'p' };
        return { k: 'n', v: toText(v).length };
      }
      if (e.f === 'trim') return v.k === 's' ? { k: 's', v: v.v.trim() } : v.k === 'x' ? U : v;
      return v;
    }
    case 'alias':
    case 'unk':
      return U;
    default: {
      const t = exTruth(e, w);
      return t === 'U' ? U : { k: 'b', v: t === 'T' };
    }
  }
}

function exTruth(e: Ex, w: World): Tri {
  switch (e.t) {
    case 'has': {
      const v = w.get(e.p);
      return v === undefined ? 'U' : v.k === 'a' ? 'F' : 'T';
    }
    case 'not':
      return notTri(exTruth(e.e, w));
    case 'one':
      return agreed(e.of.map((o) => exTruth(o, w)));
    case 'and': {
      const a = exTruth(e.a, w);
      if (a === 'F') return 'F';
      const b = exTruth(e.b, w);
      return b === 'F' ? 'F' : a === 'T' && b === 'T' ? 'T' : 'U';
    }
    case 'or': {
      const a = exTruth(e.a, w);
      if (a === 'T') return 'T';
      const b = exTruth(e.b, w);
      return b === 'T' ? 'T' : a === 'F' && b === 'F' ? 'F' : 'U';
    }
    case 'cmp': {
      if (e.a.t === 'one' || e.b.t === 'one') {
        const bs = alternatives(e.b);
        return agreed(alternatives(e.a).flatMap((a) => bs.map((b) => exTruth({ ...e, a, b }, w))));
      }
      const a = exValue(e.a, w);
      const b = exValue(e.b, w);
      if (e.op === 'eq') return cfEq(a, b);
      if (e.op === 'neq') return notTri(cfEq(a, b));
      if (e.op === 'contains' || e.op === 'ncontains') {
        if (a.k === 'u' || b.k === 'u' || a.k === 'x' || b.k === 'x' || a.k === 'p' || b.k === 'p' || a.k === 'c' || b.k === 'c') return 'U';
        const has = toText(a).toLowerCase().includes(toText(b).toLowerCase());
        return (e.op === 'contains') === has ? 'T' : 'F';
      }
      const na = toNum(a.k === 'a' ? { k: 's', v: '' } : a);
      const nb = toNum(b.k === 'a' ? { k: 's', v: '' } : b);
      if (na === undefined || nb === undefined) return 'U';
      const holds = e.op === 'gt' ? na > nb : e.op === 'gte' ? na >= nb : e.op === 'lt' ? na < nb : na <= nb;
      return holds ? 'T' : 'F';
    }
    default:
      return truthy(exValue(e, w));
  }
}

function exParams(e: Ex, out: Set<string>): Set<string> {
  if (e.t === 'ref' || e.t === 'has') out.add(e.p);
  else if (e.t === 'fn' || e.t === 'not') exParams(e.e, out);
  else if (e.t === 'one') e.of.forEach((o) => exParams(o, out));
  else if (e.t === 'cmp' || e.t === 'and' || e.t === 'or') {
    exParams(e.a, out);
    exParams(e.b, out);
  }
  return out;
}

function exLiterals(e: Ex, out: Set<string>): Set<string> {
  if (e.t === 'lit') out.add(toText(e.v));
  else if (e.t === 'fn' || e.t === 'not') exLiterals(e.e, out);
  else if (e.t === 'one') e.of.forEach((o) => exLiterals(o, out));
  else if (e.t === 'cmp' || e.t === 'and' || e.t === 'or') {
    exLiterals(e.a, out);
    exLiterals(e.b, out);
  }
  return out;
}

function sameText(a: string, b: string): boolean {
  return cfEq({ k: 's', v: a }, { k: 's', v: b }) === 'T';
}

/** Whether a world value satisfies one predicate value; a value, `''` included, needs the parameter present, as the gateway matches it. */
function atomHolds(v: WorldValue, p: PredicateValue): boolean {
  if (isTruthyPredicate(p)) return v.k === 's' ? cfTruthyText(v.v) : v.k === 'x' && v.cf === 'T';
  if (typeof p === 'string') return v.k === 's' && sameText(v.v, p);
  if (p === true) return v.k === 'x' || (v.k === 's' && v.v !== '');
  return v.k === 'a' || (v.k === 's' && v.v === '');
}

/** Whether an exclusion atom holds given only the entry predicate on the same parameter. */
function atomUnderPredicate(pinned: PredicateValue, atom: PredicateValue): Tri {
  if (isTruthyPredicate(atom)) {
    if (typeof pinned === 'string') return cfTruthyText(pinned) ? 'T' : 'F';
    if (isTruthyPredicate(pinned)) return 'T';
    return pinned === true ? 'U' : 'F';
  }
  if (isTruthyPredicate(pinned)) {
    // A CFML-true value is present and non-empty.
    if (typeof atom === 'string') return cfTruthyText(atom) ? 'U' : 'F';
    return atom === true ? 'T' : 'F';
  }
  if (typeof pinned === 'string') {
    if (typeof atom === 'string') return sameText(pinned, atom) ? 'T' : 'F';
    return (atom === true) === (pinned !== '') ? 'T' : 'F';
  }
  if (typeof atom === 'string') return 'U';
  return (pinned === true) === (atom === true) ? 'T' : 'F';
}

function lowerKeys(p: Predicates | undefined): Map<string, PredicateValue> {
  const out = new Map<string, PredicateValue>();
  for (const [k, v] of Object.entries(p ?? {})) out.set(k.toLowerCase(), v);
  return out;
}

/**
 * Evaluates `e` over every assignment of the parameters the entry or its exclusions constrain: true or false only
 * when every consistent assignment agrees. An exclusion holds when all of its atoms hold; the entry excludes those
 * assignments, so the less specific branch is evaluated under the negation of each more specific variant.
 */
function decide(e: Ex, predicates: ReadonlyMap<string, PredicateValue>, exclusions: ReadonlyArray<ReadonlyMap<string, PredicateValue>>): Tri {
  const params = exParams(e, new Set<string>());
  const constrained = [...params].filter((p) => predicates.has(p) || exclusions.some((c) => c.has(p))).sort(compareText);
  const clauses: Array<Map<string, PredicateValue>> = [];
  for (const clause of exclusions) {
    const reduced = new Map<string, PredicateValue>();
    let holds = true;
    for (const [q, v] of clause) {
      if (constrained.includes(q)) {
        reduced.set(q, v);
      } else if (predicates.has(q)) {
        if (atomUnderPredicate(predicates.get(q) ?? null, v) !== 'T') holds = false;
      } else {
        holds = false;
      }
    }
    if (holds && reduced.size > 0) clauses.push(reduced);
  }
  const literals = exLiterals(e, new Set<string>());
  const domain = (p: string): WorldValue[] => {
    const texts = new Map<string, string>();
    const add = (s: string): void => {
      if (s !== '' && !texts.has(s.toLowerCase())) texts.set(s.toLowerCase(), s);
    };
    literals.forEach(add);
    const pinned = predicates.get(p);
    if (typeof pinned === 'string') add(pinned);
    for (const c of clauses) {
      const v = c.get(p);
      if (typeof v === 'string') add(v);
    }
    const truthyAtom = isTruthyPredicate(pinned) || clauses.some((c) => isTruthyPredicate(c.get(p)));
    const others: WorldValue[] = truthyAtom ? [{ k: 'x', cf: 'T' }, { k: 'x', cf: 'F' }, { k: 'x', cf: 'N' }] : [{ k: 'x' }];
    return [{ k: 'a' }, { k: 's', v: '' }, ...[...texts.values()].map((v): WorldValue => ({ k: 's', v })), ...others];
  };
  const domains = constrained.map(domain);
  const seen = new Set<Tri>();
  const world = new Map<string, WorldValue>();
  const visit = (i: number): void => {
    if (seen.size > 1) return;
    const p = constrained[i];
    if (p === undefined) {
      if (clauses.some((c) => [...c].every(([q, v]) => atomHolds(world.get(q) ?? { k: 'a' }, v)))) return;
      seen.add(exTruth(e, world));
      return;
    }
    const pinned = predicates.get(p);
    for (const v of domains[i] ?? []) {
      if (predicates.has(p) && !atomHolds(v, pinned ?? null)) continue;
      world.set(p, v);
      visit(i + 1);
    }
    world.delete(p);
  };
  visit(0);
  if (seen.size !== 1) return 'U';
  return seen.has('T') ? 'T' : seen.has('F') ? 'F' : 'U';
}

/** What a guard is read against: the request aliases in scope, the known literal formals and the bean facts. */
interface GuardEnv {
  aliases: readonly Alias[];
  formals: ReadonlyMap<string, Val>;
  facts: (component: string) => BeanFacts;
  /** The component the body runs on, whose mapping flags its own unqualified getters read. */
  receiver?: string;
  /** The body's analysis, for the values of its tracked beans at each offset. */
  analysis?: Analysis;
  /** Writes of the body's tracked locals, by name. */
  localDefs?: ReadonlyMap<string, readonly KeyDef[]>;
  /** Value of a tracked local where the guard is read; undefined for a name that is none. */
  locals?: (name: string) => Ex | undefined;
  /** Whether the write at `x` cannot run on the way to `site`: a guard or loop entry around it alone is false. */
  dead?: (x: number, site: number) => boolean;
  /** The truth a guard leaf of the body is known to have where it is read. */
  fixed?: FixedAtom;
}

function conditionEx(c: GuardCondition, env: GuardEnv): Ex {
  switch (c.k) {
    case 'expr':
      return parseGuard(c.text, env);
    case 'case': {
      const subject = parseGuard(c.subject, env);
      return c.values.reduce<Ex>(
        (acc, v) => {
          const test: Ex = v === null ? UNK : { t: 'cmp', op: 'eq', a: subject, b: { t: 'lit', v: { k: 's', v } } };
          return acc.t === 'lit' ? test : { t: 'or', a: acc, b: test };
        },
        { t: 'lit', v: { k: 'b', v: false } },
      );
    }
    case 'not':
      return { t: 'not', e: conditionEx(c.of, env) };
    case 'and':
    case 'or':
      return c.of.reduce<Ex>(
        (acc, x) => ({ t: c.k, a: acc, b: conditionEx(x, env) }),
        { t: 'lit', v: { k: 'b', v: c.k === 'and' } },
      );
  }
}


// ---------------------------------------------------------------------------------------------------------------
// Function analysis: call chains, SQL writes, assignments
// ---------------------------------------------------------------------------------------------------------------

/** An actual argument: named (`name=expr`) or positional. */
export interface CallArgument {
  name?: string;
  expr: string;
}

interface ChainSegment {
  name: string;
  s: number;
  e: number;
  args?: CallArgument[];
  indexed?: boolean;
}

/** A member chain such as `getBean('x').loadBy(…).save()`; `new` chains start with the constructed component. */
interface Chain {
  kind: 'name' | 'new';
  segs: ChainSegment[];
}

interface RawCall {
  chain: Chain;
  k: number;
  offset: number;
}

/**
 * A SQL write statement in a function body; `table` is null when the target is an unresolved expression.
 * `columns` lists the lower-cased columns an `INSERT (…)` or `UPDATE … SET` names, null when the statement names none statically.
 */
export interface SqlWrite {
  table: string | null;
  op: 'insert' | 'update' | 'delete';
  line: number;
  endLine: number;
  whereParams: string[];
  tableExpr: string;
  offset: number;
  columns: string[] | null;
  dynamic?: true;
  thread?: ThreadSpan;
}

interface Assignment {
  lvalue: string;
  rhs: string;
  offset: number;
}

interface Analysis {
  regions: Region[];
  exits: Exit[];
  calls: RawCall[];
  writes: SqlWrite[];
  assignments: Assignment[];
  returns: string[];
  /** Offsets of the body flagged 1 where text never runs. */
  literal: Uint8Array;
  lineAt(pos: number): number;
}

function splitArgs(text: string): CallArgument[] {
  const args: CallArgument[] = [];
  const push = (raw: string): void => {
    const t = raw.trim();
    if (t === '') return;
    const m = /^([A-Za-z_$][\w$]*)\s*=(?!=)\s*/.exec(t);
    if (m?.[1] !== undefined) args.push({ name: m[1], expr: t.slice(m[0].length).trim() });
    else args.push({ expr: t });
  };
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i <= text.length) {
    const c = text.charAt(i);
    if (i === text.length || (c === ',' && depth === 0)) {
      push(text.slice(start, i));
      start = i + 1;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    i++;
  }
  return args;
}

const NEW_RE = /new\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/iy;

function parseChainAt(body: string, at: number, kind: Chain['kind']): Chain {
  const segs: ChainSegment[] = [];
  let i = at;
  if (kind === 'new') {
    NEW_RE.lastIndex = at;
    const m = NEW_RE.exec(body);
    const open = at + (m?.[0].length ?? 1) - 1;
    const close = matchBracket(body, open);
    if (m?.[1] === undefined || close < 0) return { kind, segs };
    segs.push({ name: m[1], s: at, e: close + 1, args: splitArgs(body.slice(open + 1, close)) });
    const dot = afterSpace(body, close + 1);
    if (body.charAt(dot) !== '.' || !isIdentStart(body.charAt(dot + 1))) return { kind, segs };
    i = dot + 1;
  }
  while (isIdentStart(body.charAt(i))) {
    let e = i + 1;
    while (isIdentPart(body.charAt(e))) e++;
    const seg: ChainSegment = { name: body.slice(i, e), s: i, e };
    i = e;
    if (body.charAt(i) === '(') {
      const close = matchBracket(body, i);
      if (close < 0) {
        segs.push(seg);
        break;
      }
      seg.args = splitArgs(body.slice(i + 1, close));
      i = close + 1;
      seg.e = i;
    }
    while (body.charAt(i) === '[') {
      const close = matchBracket(body, i);
      if (close < 0) break;
      seg.indexed = true;
      i = close + 1;
      seg.e = i;
    }
    segs.push(seg);
    const dot = afterSpace(body, i);
    if (body.charAt(dot) !== '.' || !isIdentStart(body.charAt(dot + 1))) break;
    i = dot + 1;
  }
  return { kind, segs };
}

/** First index at or after `i` that is not whitespace; fluent chains break lines before `.method(`. */
function afterSpace(text: string, i: number): number {
  let j = i;
  while (isSpace(text.charAt(j))) j++;
  return j;
}

/** Text of the first `k` chain segments, as written. */
function chainText(chain: Chain, k: number, body: string): string {
  const first = chain.segs[0];
  const last = chain.segs[k - 1];
  return first === undefined || last === undefined ? '' : body.slice(first.s, last.e).replace(/\s+/g, ' ');
}

function chainCalls(body: string, literal: Uint8Array): RawCall[] {
  const calls: RawCall[] = [];
  let skipUntil = -1;
  for (const m of body.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const at = m.index;
    if (at < skipUntil || literal[at] === 1) continue;
    const prev = body.charAt(at - 1);
    if (prev !== '' && (isIdentPart(prev) || prev === '.')) continue;
    let kind: Chain['kind'] = 'name';
    if (m[0].toLowerCase() === 'new') {
      NEW_RE.lastIndex = at;
      const nm = NEW_RE.exec(body);
      if (nm === null) continue;
      kind = 'new';
      skipUntil = at + nm[0].length;
    }
    const chain = parseChainAt(body, at, kind);
    const last = chain.segs.length - 1;
    chain.segs.forEach((seg, k) => {
      if (seg.args === undefined) return;
      const lower = seg.name.toLowerCase();
      if (kind === 'name' && (lower === 'getbean' || lower === 'getentity' || lower === 'createobject')) return;
      if (k < last && /^get/i.test(seg.name) && seg.args.length === 0) return;
      calls.push({ chain, k, offset: seg.s });
    });
  }
  return calls.sort((a, b) => a.offset - b.offset);
}

/** End of the expression starting at `from`: `;`, a newline not continued by `.member`, or (in tags) `>` at depth 0. */
function expressionEnd(text: string, from: number, tagged: boolean): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && c === '\n') {
      const next = afterSpace(text, i);
      if (text.charAt(next) !== '.' || !isIdentStart(text.charAt(next + 1))) return i;
      i = next;
      continue;
    } else if (depth === 0 && (c === ';' || (tagged && c === '>'))) {
      return i;
    }
    i++;
  }
  return text.length;
}

function cleanRhs(raw: string): string {
  return raw.trim().replace(/\/$/, '').trim();
}

function findAssignments(body: string, literal: Uint8Array): Assignment[] {
  const found: Assignment[] = [];
  const re = /(<cfset\s+|(?:^|[;{}\n])[ \t]*)(?:var\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=(?!=)/dgi;
  for (const m of body.matchAll(re)) {
    const at = m.indices?.[2]?.[0] ?? m.index;
    if (literal[at] === 1) continue;
    const lvalue = (m[2] ?? '').toLowerCase().replace(/^local\./, '');
    const start = m.index + m[0].length;
    const rhs = cleanRhs(body.slice(start, expressionEnd(body, start, (m[1] ?? '').toLowerCase().startsWith('<cfset'))));
    // The offset of the assigned name, which lies inside every region that holds the statement.
    if (rhs !== '') found.push({ lvalue, rhs, offset: at });
  }
  return found;
}

function findReturns(body: string, literal: Uint8Array): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/(<cfreturn\s+|\breturn\s+)/gi)) {
    if (literal[m.index] === 1) continue;
    const start = m.index + m[0].length;
    const rhs = cleanRhs(body.slice(start, expressionEnd(body, start, (m[1] ?? '').startsWith('<'))));
    if (rhs !== '') out.push(rhs);
  }
  return out;
}

/** Text spans holding SQL: `<cfquery>` bodies and string literals given to queryExecute, `sql=` or setSql. */
export function sqlSpans(body: string): Array<{ start: number; end: number; tag: boolean }> {
  const spans: Array<{ start: number; end: number; tag: boolean }> = [];
  for (const m of body.matchAll(/<cfquery\b/gi)) {
    const start = tagEnd(body, m.index);
    const close = indexOfCi(body, '</cfquery', start);
    spans.push({ start, end: close < 0 ? body.length : close, tag: true });
  }
  for (const m of body.matchAll(/(?:\bqueryExecute\s*\(\s*|\bsql\s*=\s*|\bsetSql\s*\(\s*)(["'])/gi)) {
    const quoteAt = m.index + m[0].length - 1;
    spans.push({ start: quoteAt + 1, end: Math.max(quoteAt + 1, skipString(body, quoteAt) - 1), tag: false });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * String literals a function assigns (`x = '…'`, `x &= '…'`) to a variable it hands to queryExecute,
 * `execute(sql=…)` or setSql as the SQL text, as script `Query` objects are given SQL built up in a local.
 */
function sqlVariableSpans(body: string, literal: Uint8Array): Array<{ start: number; end: number; tag: boolean }> {
  const names = new Set<string>();
  for (const m of body.matchAll(/(?:\bqueryExecute\s*\(\s*|\bexecute\s*\(\s*sql\s*=\s*|\bsetSql\s*\(\s*)((?:local\.)?[A-Za-z_$][\w$]*)\s*[,)]/gi)) {
    if (literal[m.index] !== 1) names.add((m[1] ?? '').toLowerCase().replace(/^local\./, ''));
  }
  const spans: Array<{ start: number; end: number; tag: boolean }> = [];
  for (const name of names) {
    const n = name.replace(/\$/g, '\\$');
    for (const m of body.matchAll(new RegExp(String.raw`(?<![\w$.])(?:var\s+)?(?:local\.)?${n}\s*&?=\s*(["'])`, 'gi'))) {
      if (literal[m.index] === 1) continue;
      const quoteAt = m.index + m[0].length - 1;
      spans.push({ start: quoteAt + 1, end: Math.max(quoteAt + 1, skipString(body, quoteAt) - 1), tag: false });
    }
  }
  return spans;
}

function readTableRef(text: string, from: number, end: number): number {
  let j = from;
  while (j < end) {
    const c = text.charAt(j);
    if (c === '[' || c === '#') {
      const k = text.indexOf(c === '[' ? ']' : '#', j + 1);
      if (k < 0 || k >= end) break;
      j = k + 1;
    } else if (/[\w$.]/.test(c)) {
      j++;
    } else {
      break;
    }
  }
  return j;
}

/** Lower-cased table name of a static target, dropping brackets and the `dbo` schema; null when not a name. */
function staticTableName(ref: string): string | null {
  const parts = ref
    .split('.')
    .map((p) => p.replace(/^\[|\]$/g, '').trim())
    .filter((p) => p !== '' && p.toLowerCase() !== 'dbo');
  const name = parts.slice(-2).join('.').toLowerCase();
  return /^[a-z_][\w$]*(?:\.[a-z_][\w$]*)?$/.test(name) ? name : null;
}

function whereParamsOf(clause: string, placeholders: boolean): string[] {
  const hits: Array<[number, string]> = [];
  for (const m of clause.matchAll(/#\s*arguments\.((?:[\w$]+\.)*)([\w$]+)\s*(\(\s*\))?\s*#/gi)) {
    const name = m[2] ?? '';
    hits.push([m.index, (m[3] !== undefined && /^get./i.test(name) ? name.slice(3) : name).toLowerCase()]);
  }
  if (placeholders) for (const m of clause.matchAll(/(?<![:\w]):([A-Za-z_]\w*)/g)) hits.push([m.index, (m[1] ?? '').toLowerCase()]);
  return [...new Set(hits.sort((a, b) => a[0] - b[0]).map(([, n]) => n))];
}

/** `text` with every `<cf…>` and `</cf…>` tag replaced by `sep` padded to the tag's length. */
function maskCfTags(text: string, sep: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/<\/?cf[a-z]/gi)) {
    if (m.index < last) continue;
    const end = tagEnd(text, m.index);
    out += text.slice(last, m.index) + sep.padEnd(end - m.index, ' ');
    last = end;
  }
  return out + text.slice(last);
}

/**
 * Top-level comma-separated items of SQL `text` from `from`, skipping strings, `#…#` expressions and brackets.
 * The scan ends at an unmatched `)` (`paren`), at a top-level `where`/`from` keyword when `clause` is set, or at the end.
 */
function sqlItems(text: string, from: number, clause: boolean): { items: string[]; end: 'paren' | 'clause' | 'eof' } {
  const items: string[] = [];
  let depth = 0;
  let start = from;
  let i = from;
  let end: 'paren' | 'clause' | 'eof' = 'eof';
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === '#') {
      i = text.charAt(i + 1) === '#' ? i + 2 : skipInterpolation(text, i + 1, text.length);
      continue;
    }
    if (isIdentStart(c)) {
      let e = i + 1;
      while (isIdentPart(text.charAt(e))) e++;
      const word = text.slice(i, e).toLowerCase();
      if (clause && depth === 0 && (word === 'where' || word === 'from') && text.charAt(i - 1) !== '.') {
        end = 'clause';
        break;
      }
      i = e;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) {
        end = 'paren';
        break;
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      items.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  items.push(text.slice(start, i));
  return { items: items.map((s) => s.trim()).filter((s) => s !== ''), end };
}

const COLUMN_NAME = /^\[?([A-Za-z_][\w$]*)\]?$/;
const SET_TARGET = /^(?:\[?[A-Za-z_][\w$]*\]?\s*\.\s*)?\[?([A-Za-z_][\w$]*)\]?\s*[-+*/%&|^]?=(?!=)/;
const SET_DYNAMIC = /^\s*[-+*/%&|^]?=(?!=)/;

/**
 * Lower-cased columns a write statement names: the `INSERT` column list or the `UPDATE … SET` targets (every
 * conditional `<cfif>` alternative included). `rest` is the statement text after its table reference; null when the
 * statement is a `DELETE` or names no static column list.
 */
export function sqlColumns(op: SqlWrite['op'], rest: string): string[] | null {
  const names: string[] = [];
  if (op === 'insert') {
    const open = /^\s*\(/.exec(rest);
    if (open === null) return null;
    const { items, end } = sqlItems(maskCfTags(rest, ' '), open[0].length, false);
    if (end !== 'paren') return null;
    for (const item of items) {
      const name = COLUMN_NAME.exec(item)?.[1];
      if (name === undefined) return null;
      names.push(name.toLowerCase());
    }
  } else if (op === 'update') {
    const set = /^\s+set\b/i.exec(rest);
    if (set === null) return null;
    // A tag separates SET items as a comma does, so each `<cfif>`/`<cfelse>` alternative is its own item.
    for (const item of sqlItems(maskCfTags(rest, ','), set[0].length, true).items) {
      if (item.startsWith('#') && SET_DYNAMIC.test(item.slice(skipInterpolation(item, 1, item.length)))) return null;
      const name = SET_TARGET.exec(item)?.[1];
      if (name !== undefined) names.push(name.toLowerCase());
    }
  }
  return names.length === 0 ? null : [...new Set(names)];
}

function threadAt(regions: readonly Region[], offset: number, lineAt: (pos: number) => number): ThreadSpan | undefined {
  let inner: Region | undefined;
  for (const r of regions) if (r.thread !== undefined && r.start <= offset && offset < r.end && (inner === undefined || r.start >= inner.start)) inner = r;
  return inner?.thread === undefined ? undefined : { name: inner.thread.name, line: lineAt(inner.thread.open), endLine: lineAt(inner.thread.close) };
}

function sqlWrites(body: string, regions: readonly Region[], lineAt: (pos: number) => number, literal: Uint8Array): SqlWrite[] {
  const writes: SqlWrite[] = [];
  const spans = sqlSpans(body);
  const starts = new Set(spans.map((s) => s.start));
  for (const s of sqlVariableSpans(body, literal)) if (!starts.has(s.start)) spans.push(s);
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const text = body.slice(0, span.end);
    const re = /\b(insert\s+into|update|delete\s+from|delete)\s+/gi;
    re.lastIndex = span.start;
    const stmts: Array<{ at: number; op: SqlWrite['op']; ref: string; refEnd: number }> = [];
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const kw = (m[1] ?? '').toLowerCase();
      const refStart = m.index + m[0].length;
      const refEnd = readTableRef(text, refStart, span.end);
      const ref = text.slice(refStart, refEnd);
      const after = text.slice(refEnd, Math.min(span.end, refEnd + 40));
      if (ref === '') continue;
      if (kw === 'update' && !/^\s+set\b/i.test(after)) continue;
      if (kw === 'delete' && !/^(\s+(where|from)\b|\s*(;|$))/i.test(after)) continue;
      const op: SqlWrite['op'] = kw.startsWith('insert') ? 'insert' : kw === 'update' ? 'update' : 'delete';
      stmts.push({ at: m.index, op, ref, refEnd });
      re.lastIndex = refEnd;
    }
    stmts.forEach((st, idx) => {
      const stmtEnd = stmts[idx + 1]?.at ?? span.end;
      const stmtText = body.slice(st.refEnd, stmtEnd);
      const where = /\bwhere\b/i.exec(stmtText);
      const dynamic = st.ref.includes('#');
      const table = dynamic ? null : staticTableName(st.ref);
      if (!dynamic && table === null) return;
      const trailing = body.slice(st.at, stmtEnd).replace(/\s+$/, '');
      const write: SqlWrite = {
        table,
        op: st.op,
        line: lineAt(st.at),
        endLine: lineAt(st.at + Math.max(0, trailing.length - 1)),
        whereParams: where === null ? [] : whereParamsOf(stmtText.slice(where.index), !span.tag),
        tableExpr: st.ref.trim(),
        offset: st.at,
        columns: sqlColumns(st.op, stmtText),
      };
      if (dynamic) write.dynamic = true;
      const thread = threadAt(regions, st.at, lineAt);
      if (thread !== undefined) write.thread = thread;
      writes.push(write);
    });
  }
  return writes;
}

const analyses = new WeakMap<CfmlFunction, Analysis>();

function analyse(fn: CfmlFunction, syntax: CfmlUnit['syntax']): Analysis {
  const cached = analyses.get(fn);
  if (cached !== undefined) return cached;
  const index = new LineIndex(fn.body);
  const lineAt = (pos: number): number => fn.bodyLine + index.line(pos) - 1;
  const regions: Region[] = [];
  const exits: Exit[] = [];
  if (syntax === 'script') scriptRegions(fn.body, 0, fn.body.length, regions, exits);
  else tagRegions(fn.body, regions, exits);
  const literal = literalMask(fn.body, fn.mode ?? (syntax === 'script' ? 'script' : 'tag'));
  const analysis: Analysis = {
    regions,
    exits: exits.filter((e) => literal[e.at] !== 1),
    calls: chainCalls(fn.body, literal),
    writes: sqlWrites(fn.body, regions, lineAt, literal),
    assignments: findAssignments(fn.body, literal),
    returns: findReturns(fn.body, literal),
    literal,
    lineAt,
  };
  analyses.set(fn, analysis);
  return analysis;
}

/** Literal string value of a CFML expression, or undefined when it is not a plain literal. */
function literalString(expr: string | undefined): string | undefined {
  const t = expr?.trim() ?? '';
  if (t.length < 2 || !((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return undefined;
  if (skipString(t, 0) !== t.length) return undefined;
  const inner = unquote(t);
  return interpolates(inner) ? undefined : inner.replace(/##/g, '#');
}

/** Value of a literal CFML expression: a plain string, a number or `true`/`false`; undefined for anything else. */
function literalVal(expr: string | undefined): Val | undefined {
  const s = literalString(expr);
  if (s !== undefined) return { k: 's', v: s };
  const t = expr?.trim() ?? '';
  if (/^(true|false)$/i.test(t)) return { k: 'b', v: t.toLowerCase() === 'true' };
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(t) ? { k: 'n', v: Number(t) } : undefined;
}

/** Table named by a literal `variables.table = '…'` assignment in the component, or its `table` attribute. */
function declaredTable(unit: CfmlUnit): string | undefined {
  if (unit.syntax !== 'template') {
    const attr = (unit as CfmlComponent).declaration.attrs.table;
    if (attr !== undefined && attr !== '') return attr.toLowerCase();
  }
  for (const fn of unit.functions) {
    for (const a of analyse(fn, unit.syntax).assignments) {
      const lit = a.lvalue === 'variables.table' ? literalString(a.rhs) : undefined;
      if (lit !== undefined && lit !== '') return lit.toLowerCase();
    }
  }
  return undefined;
}

const SELF_TABLE = /^(?:variables\.(?:instance\.)?table|(?:this\.)?gettable\(\))$/;

/** SQL `INSERT`, `UPDATE` and `DELETE` targets of `fn`; `#variables.table#` and `#getTable()#` resolve through `component`. */
export function extractSqlWrites(fn: CfmlFunction, component?: CfmlUnit): SqlWrite[] {
  const syntax = component?.syntax ?? (detectMode(fn.body) === 'script' ? 'script' : 'tag');
  const own = component === undefined ? undefined : declaredTable(component);
  return analyse(fn, syntax).writes.map((w) => {
    const copy: SqlWrite = { ...w, whereParams: [...w.whereParams], columns: w.columns === null ? null : [...w.columns] };
    if (w.dynamic === true && own !== undefined && SELF_TABLE.test(stripHashes(w.tableExpr).replace(/\s+/g, '').toLowerCase())) {
      copy.table = own;
      delete copy.dynamic;
    }
    return copy;
  });
}


// ---------------------------------------------------------------------------------------------------------------
// Call resolution
// ---------------------------------------------------------------------------------------------------------------

/** Lookups the closure walk needs; services.ts and entities.ts implement it and generate.ts composes them. */
export interface ComponentIndex {
  /** Component path of a DI1 bean, alias or `addBean` registration (case-insensitive); null when unknown. */
  resolveBean(name: string): string | null;
  /** Lower-cased table of a concrete ORM entity component; null when the component is not one. */
  ormTable(path: string): string | null;
  /** Parsed component at `path`; null when absent or not a component. */
  parsed(path: string): CfmlComponent | null;
  /** Whether the factory hands out a new instance of the component at `path` per call (a DI1 transient); absent means never. */
  transient?(path: string): boolean;
}

/** Context of extraction and closure: the archive tree, the component index and the reviewed writer overrides. */
export interface ClosureContext {
  tree: SourceTree;
  index: ComponentIndex;
  overrides?: WriterOverrides;
}

/** What a call addresses as written: a bean name, a component path, or the component itself. */
export interface CallTarget {
  bean?: string;
  component?: string;
  self?: 'this' | 'super' | 'local';
  method: string;
}

/** A call the closure can follow; `resolved` is null when its receiver cannot be resolved. */
export interface CallSite {
  target: CallTarget;
  resolved: string | null;
  line: number;
  offset: number;
  args: CallArgument[];
  text: string;
  guard?: GuardCondition;
  thread?: ThreadSpan;
}

/** Why a reference was left unresolved. */
export type UnresolvedKind = 'bean' | 'component' | 'method' | 'receiver' | 'table' | 'include';

/** What an expression evaluates to; `item` is the entity component a feed or iterator yields. */
type Resolution =
  | { kind: 'resolved'; path: string; from: string; bean?: string; item?: string }
  | { kind: 'unresolved'; why: UnresolvedKind; name?: string }
  | { kind: 'unknown' };

type Resolved = Extract<Resolution, { kind: 'resolved' }>;

const UNKNOWN: Resolution = { kind: 'unknown' };
const FLUENT = /^(init|loadby|set[A-Za-z_$]*|add[A-Za-z_$]*)$/i;
const GETTER = /^get[A-Za-z_$]/;
/** Methods of an ORM entity, feed or iterator that hand on the entity they yield. */
const COLLECTION = /^(getfeed|getiterator)$/i;
/** Iterator methods that return one yielded entity. */
const ITEM = /^(next|previous|peek)$/i;
/** Script components ColdFusion provides (`new Query()`), which run no CFML of the source tree. */
const BUILTIN_COMPONENTS = new Set(['dbinfo', 'feed', 'ftp', 'http', 'imap', 'ldap', 'mail', 'pdf', 'pop', 'query', 'storedproc']);
/** Start-up template whose `application.<name>` assignments stand for those names in every request. */
const APP_START_TEMPLATE = 'core/appcfc/onApplicationStart_include.cfm';

/** Path of the component a dotted name addresses from `fromPath`: `mura.*` is `core/mura/*`, bare names are siblings. */
export function resolveComponentPath(name: string, fromPath: string, tree: SourceTree): string | null {
  const dotted = name.trim();
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(dotted)) return null;
  const parts = dotted.split('.');
  const head = (parts[0] ?? '').toLowerCase();
  const dir = path.posix.dirname(fromPath);
  const candidates: string[] = [];
  if (head === 'mura' && parts.length > 1) candidates.push(['core', 'mura', ...parts.slice(1)].join('/'));
  else if (head === 'murawrm' && parts.length > 1) candidates.push(parts.slice(1).join('/'));
  else {
    candidates.push(dir === '.' ? parts.join('/') : `${dir}/${parts.join('/')}`);
    if (parts.length > 1) candidates.push(parts.join('/'));
  }
  for (const c of candidates) if (tree.exists(`${c}.cfc`)) return `${c}.cfc`;
  return null;
}

/** Path of an included template: `/mura/…` and `/muraWRM/…` mappings, root-absolute, or relative to the includer. */
function resolveTemplatePath(template: string, fromPath: string, tree: SourceTree): string | null {
  if (template.includes('#')) return null;
  let rel: string;
  if (template.startsWith('/')) {
    const [head = '', ...rest] = template.slice(1).split('/');
    const lower = head.toLowerCase();
    rel = lower === 'mura' ? ['core', 'mura', ...rest].join('/') : lower === 'murawrm' ? rest.join('/') : template.slice(1);
  } else {
    rel = path.posix.join(path.posix.dirname(fromPath), template);
  }
  rel = path.posix.normalize(rel);
  if (rel === '.' || rel.startsWith('../') || rel.startsWith('/') || rel === '..') return null;
  return tree.exists(rel) ? rel : null;
}

function isTrivialValue(rhs: string): boolean {
  return (
    literalString(rhs) !== undefined ||
    /^[-+]?[\d.]+$/.test(rhs) ||
    /^(true|false)$/i.test(rhs) ||
    /^(structnew|arraynew|querynew)\s*\(/i.test(rhs) ||
    rhs.startsWith('{') ||
    rhs.startsWith('[')
  );
}

function isInjector(fn: CfmlFunction): boolean {
  return fn.name.toLowerCase() === 'init' || /^set[A-Za-z_$]/.test(fn.name);
}

/**
 * Whether `fn` keeps the lower-cased `name` out of the variables scope: a formal, a `var` or `local.` declaration or a
 * loop variable; with `assigned`, any assignment of it in `fn` counts as well.
 */
function holdsLocally(fn: CfmlFunction, syntax: CfmlUnit['syntax'], name: string, assigned: boolean): boolean {
  if (fn.args.some((a) => a.name.toLowerCase() === name)) return true;
  if (assigned && analyse(fn, syntax).assignments.some((a) => a.lvalue === name)) return true;
  const n = name.replace(/\$/g, '\\$');
  return new RegExp(String.raw`\bvar\s+${n}\b|\blocal\.${n}\b|\bfor\s*\(\s*(?:var\s+)?${n}\s+in\b|\b(?:item|index)\s*=\s*["']${n}["']`, 'i').test(fn.body);
}

/** Where resolution happens: the component whose variables and `this` apply, and the function being read. */
interface Scope {
  receiver: string;
  unit: CfmlUnit;
  fn: CfmlFunction;
}

const templateCache = new WeakMap<SourceTree, Map<string, CfmlTemplate>>();
const functionIndex = new WeakMap<CfmlUnit, Map<string, CfmlFunction>>();

/** The functions of `unit` by lower-cased name, the first of a name winning. */
function functionsByName(unit: CfmlUnit): ReadonlyMap<string, CfmlFunction> {
  let byName = functionIndex.get(unit);
  if (byName === undefined) {
    byName = new Map();
    for (const f of unit.functions) {
      const lower = f.name.toLowerCase();
      if (!byName.has(lower)) byName.set(lower, f);
    }
    functionIndex.set(unit, byName);
  }
  return byName;
}
const chainCache = new WeakMap<ComponentIndex, Map<string, string[]>>();
const returnCache = new WeakMap<ComponentIndex, Map<string, Resolution>>();
/** Return inferences in progress, innermost last; `partial` marks one a cycle cut short. */
const returnStack: Array<{ key: string; partial: boolean }> = [];

/** Resolves receivers, functions and assignments over one context, memoising per tree and index. */
class Resolver {
  constructor(readonly ctx: ClosureContext) {}

  unit(p: string): CfmlUnit | null {
    if (p.toLowerCase().endsWith('.cfm')) {
      let cache = templateCache.get(this.ctx.tree);
      if (cache === undefined) {
        cache = new Map();
        templateCache.set(this.ctx.tree, cache);
      }
      let t = cache.get(p);
      if (t === undefined) {
        if (!this.ctx.tree.exists(p)) return null;
        t = parseCfmTemplate(p, this.ctx.tree.readText(p));
        cache.set(p, t);
      }
      return t;
    }
    return this.ctx.index.parsed(p);
  }

  /** `p` and its `extends` ancestors that exist in the tree. */
  chain(p: string): string[] {
    let cache = chainCache.get(this.ctx.index);
    if (cache === undefined) {
      cache = new Map();
      chainCache.set(this.ctx.index, cache);
    }
    const cached = cache.get(p);
    if (cached !== undefined) return cached;
    const out: string[] = [];
    let cur: string | null = p;
    while (cur !== null && !out.includes(cur)) {
      const u = this.unit(cur);
      if (u === null) break;
      out.push(cur);
      const ext = u.syntax === 'template' ? undefined : (u as CfmlComponent).declaration.attrs.extends;
      cur = ext === undefined || ext === '' ? null : resolveComponentPath(ext, cur, this.ctx.tree);
    }
    cache.set(p, out);
    return out;
  }

  parent(p: string): string | null {
    return this.chain(p)[1] ?? null;
  }

  /** The function `name` found from `from` up its chain, with the unit that defines it. */
  findFunction(from: string, name: string): { unit: CfmlUnit; fn: CfmlFunction } | null {
    const lower = name.toLowerCase();
    for (const p of this.chain(from)) {
      const unit = this.unit(p);
      const fn = unit === null ? undefined : functionsByName(unit).get(lower);
      if (unit !== null && fn !== undefined) return { unit, fn };
    }
    return null;
  }

  hasOnMissingMethod(from: string): boolean {
    return this.findFunction(from, 'onMissingMethod') !== null;
  }

  /**
   * First non-trivial assignment of `lvalue` (lower-case) in the current unit, then up the receiver's chain; `keep`
   * limits the functions searched.
   */
  componentAssignment(
    scope: Scope,
    lvalue: string,
    keep?: (fn: CfmlFunction) => boolean,
  ): { rhs: string; unit: CfmlUnit; fn: CfmlFunction } | null {
    const units = [scope.unit, ...this.chain(scope.receiver).map((p) => this.unit(p))];
    for (const unit of units) {
      if (unit === null) continue;
      for (const fn of unit.functions) {
        if (keep !== undefined && !keep(fn)) continue;
        const hit = analyse(fn, unit.syntax).assignments.find((a) => a.lvalue === lvalue && !isTrivialValue(a.rhs));
        if (hit !== undefined) return { rhs: hit.rhs, unit, fn };
      }
    }
    return null;
  }

  private bean(name: string): Resolution {
    const p = this.ctx.index.resolveBean(name);
    return p === null ? { kind: 'unresolved', why: 'bean', name } : { kind: 'resolved', path: p, from: p, bean: name };
  }

  /** `application.<name>`: its bean, else the component the start-up template assigns to it. */
  private application(name: string, seen: Set<string>): Resolution {
    const direct = this.bean(name);
    const unit = direct.kind === 'resolved' ? null : this.unit(APP_START_TEMPLATE);
    if (unit === null) return direct;
    const lvalue = `application.${name.toLowerCase()}`;
    for (const fn of unit.functions) {
      for (const a of analyse(fn, unit.syntax).assignments) {
        if (a.lvalue !== lvalue || isTrivialValue(a.rhs)) continue;
        const r = this.expr(a.rhs, { receiver: unit.path, unit, fn }, seen);
        if (r.kind === 'resolved') return r;
      }
    }
    return direct;
  }

  /**
   * An unscoped `name` a component function neither takes, declares nor assigns: the variables-scope value the
   * component assigns as `variables.<name>`, or as `<name>` in a function that does not keep it local.
   */
  private unscoped(scope: Scope, name: string, seen: Set<string>): Resolution | null {
    if (scope.unit.syntax === 'template' || holdsLocally(scope.fn, scope.unit.syntax, name, true)) return null;
    const assigned =
      this.componentAssignment(scope, `variables.${name}`) ??
      this.componentAssignment(scope, name, (fn) => fn !== scope.fn && !holdsLocally(fn, scope.unit.syntax, name, false));
    if (assigned === null) return null;
    return this.expr(assigned.rhs, { receiver: scope.receiver, unit: assigned.unit, fn: assigned.fn }, seen);
  }

  /**
   * What `out.<name>(…)` returns: the receiver itself for `return this`, else the first return expression that
   * resolves. A feed or iterator of an entity hands on the entity, which its `next()`/`previous()` return.
   */
  private returned(out: Resolved, name: string): Resolution {
    if (out.item !== undefined && ITEM.test(name)) return { kind: 'resolved', path: out.item, from: out.item };
    const found = this.findFunction(out.from, name);
    if (found === null) return UNKNOWN;
    const r = this.returnOf({ receiver: out.path, unit: found.unit, fn: found.fn });
    if (r.kind !== 'resolved') return UNKNOWN;
    if (r.path === out.path) return out.from === out.path ? out : { ...out, from: out.path };
    const yielded = out.item ?? (COLLECTION.test(name) && this.ctx.index.ormTable(out.path) !== null ? out.path : undefined);
    return yielded !== undefined && COLLECTION.test(name) ? { ...r, item: yielded } : r;
  }

  /**
   * The first return expression of `scope.fn` that resolves on `scope.receiver`, memoised per index; a return that
   * leads back into an inference in progress counts as unknown, and the inferences it cut short are not memoised.
   */
  private returnOf(scope: Scope): Resolution {
    let cache = returnCache.get(this.ctx.index);
    if (cache === undefined) {
      cache = new Map();
      returnCache.set(this.ctx.index, cache);
    }
    const key = `${scope.receiver}|${scope.unit.path}|${scope.fn.name}|${scope.fn.offset}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const open = returnStack.findIndex((f) => f.key === key);
    if (open >= 0) {
      for (const f of returnStack.slice(open + 1)) f.partial = true;
      return UNKNOWN;
    }
    const frame = { key, partial: false };
    returnStack.push(frame);
    try {
      let out: Resolution = UNKNOWN;
      for (const rhs of analyse(scope.fn, scope.unit.syntax).returns) {
        const r = this.expr(rhs, scope, new Set());
        if (r.kind === 'resolved') {
          out = r;
          break;
        }
      }
      if (!frame.partial) cache.set(key, out);
      return out;
    } finally {
      returnStack.pop();
    }
  }

  private getter(receiver: string, getterName: string, seen: Set<string>, bare: boolean): Resolution {
    const name = getterName.slice(3);
    const p = this.ctx.index.resolveBean(name);
    if (p !== null) return { kind: 'resolved', path: p, from: p, bean: name.charAt(0).toLowerCase() + name.slice(1) };
    const found = this.findFunction(receiver, getterName);
    if (found === null) return bare ? { kind: 'unresolved', why: 'bean', name: `${getterName}()` } : UNKNOWN;
    for (const rhs of analyse(found.fn, found.unit.syntax).returns) {
      const r = this.expr(rhs, { receiver, unit: found.unit, fn: found.fn }, seen);
      if (r.kind === 'resolved') return r;
    }
    return UNKNOWN;
  }

  /** The first non-trivial assignment of `lvalue` in the function that resolves, else the first one's result; null when none. */
  private local(scope: Scope, lvalue: string, seen: Set<string>): Resolution | null {
    let first: Resolution | null = null;
    for (const a of analyse(scope.fn, scope.unit.syntax).assignments) {
      if (a.lvalue !== lvalue || isTrivialValue(a.rhs)) continue;
      const r = this.expr(a.rhs, scope, seen);
      if (r.kind === 'resolved') return r;
      first ??= r;
    }
    return first;
  }

  /** Resolves a whole expression such as `createObject("component","mura.x").init()` or `arguments.userDAO`. */
  expr(text: string, scope: Scope, seen: Set<string>): Resolution {
    const t = text.trim();
    const key = `${scope.receiver}|${scope.unit.path}|${scope.fn.name}|${t}`;
    if (seen.has(key)) return UNKNOWN;
    seen.add(key);
    const isNew = /^new\s/i.test(t);
    if (!isNew && !isIdentStart(t.charAt(0))) return UNKNOWN;
    const chain = parseChainAt(t, 0, isNew ? 'new' : 'name');
    const last = chain.segs[chain.segs.length - 1];
    if (last === undefined || last.e !== t.length) return UNKNOWN;
    return this.value(chain, chain.segs.length, scope, seen);
  }

  /** Component the first `upto` segments of `chain` evaluate to. */
  value(chain: Chain, upto: number, scope: Scope, seen: Set<string>): Resolution {
    const segs = chain.segs;
    let res: Resolution = UNKNOWN;
    let next = 1;
    let factory = -1;
    for (let k = upto - 1; k >= (chain.kind === 'new' ? 1 : 0); k--) {
      const s = segs[k];
      if (s?.args !== undefined && /^get(bean|entity)$/i.test(s.name)) {
        factory = k;
        break;
      }
    }
    const s0 = segs[0];
    if (s0 === undefined) return UNKNOWN;
    if (factory >= 0) {
      const name = literalString(segs[factory]?.args?.[0]?.expr);
      res = name === undefined ? { kind: 'unresolved', why: 'bean' } : this.bean(name);
      next = factory + 1;
    } else if (chain.kind === 'new') {
      const p = resolveComponentPath(s0.name, scope.unit.path, this.ctx.tree);
      if (p !== null) res = { kind: 'resolved', path: p, from: p };
      else if (!BUILTIN_COMPONENTS.has(s0.name.toLowerCase())) res = { kind: 'unresolved', why: 'component', name: s0.name };
    } else if (s0.args !== undefined) {
      const lower = s0.name.toLowerCase();
      const entity = lower === 'getfeed' ? literalString(s0.args[0]?.expr) : undefined;
      if (lower === 'createobject') {
        const type = literalString(s0.args[0]?.expr)?.toLowerCase();
        const name = literalString(s0.args[1]?.expr);
        const p = name === undefined ? null : resolveComponentPath(name, scope.unit.path, this.ctx.tree);
        if (type === 'component') res = p === null ? { kind: 'unresolved', why: 'component', name } : { kind: 'resolved', path: p, from: p };
      } else if (s0.args.length === 0 && GETTER.test(s0.name)) {
        res = this.getter(scope.receiver, s0.name, seen, true);
      } else if (entity !== undefined) {
        // `getFeed('<entity>')` is the feed of `getBean('<entity>')`.
        const bean = this.bean(entity);
        res = bean.kind === 'resolved' ? this.returned(bean, s0.name) : bean;
      } else {
        const self = this.selfFunction(scope, s0.name);
        if (self !== null) res = this.returned({ kind: 'resolved', path: scope.receiver, from: self.from }, s0.name);
      }
    } else if (!s0.indexed) {
      const w = s0.name.toLowerCase();
      const s1 = segs[1];
      const plain1 = s1 !== undefined && upto > 1 && s1.args === undefined && s1.indexed !== true;
      if (w === 'this') {
        res = { kind: 'resolved', path: scope.receiver, from: scope.receiver };
      } else if (w === 'super') {
        const parent = scope.unit.syntax === 'template' ? null : this.parent(scope.unit.path);
        if (parent !== null) res = { kind: 'resolved', path: scope.receiver, from: parent };
      } else if (w === 'application' && plain1 && s1 !== undefined) {
        res = this.application(s1.name, seen);
        next = 2;
      } else if (w === 'variables' && plain1 && s1 !== undefined) {
        let lvalue = `variables.${s1.name.toLowerCase()}`;
        next = 2;
        const s2 = segs[2];
        if (s1.name.toLowerCase() === 'instance' && s2 !== undefined && upto > 2 && s2.args === undefined) {
          lvalue += `.${s2.name.toLowerCase()}`;
          next = 3;
        }
        const assigned = this.componentAssignment(scope, lvalue);
        if (assigned !== null) {
          const r = this.expr(assigned.rhs, { receiver: scope.receiver, unit: assigned.unit, fn: assigned.fn }, seen);
          res = r.kind === 'unknown' ? { kind: 'unresolved', why: 'bean', name: lvalue } : r;
        } else {
          res = this.bean(lvalue.slice(lvalue.lastIndexOf('.') + 1));
        }
      } else if ((w === 'arguments' || w === 'local') && plain1 && s1 !== undefined) {
        // The longest plain path assigned in the function, as `arguments.rc.bean`, then its shorter prefixes.
        let k = upto;
        while (k > 2 && segs.slice(0, k).some((s) => s.args !== undefined || s.indexed === true)) k--;
        let r: Resolution | null = null;
        for (; k >= 2 && r === null; k--) {
          r = this.local(scope, segs.slice(w === 'arguments' ? 0 : 1, k).map((s) => s.name.toLowerCase()).join('.'), seen);
          next = k;
        }
        if (r !== null) res = r;
        else if (w === 'arguments' && isInjector(scope.fn)) res = this.bean(s1.name);
      } else {
        let k = upto;
        while (k > 1 && segs.slice(0, k).some((s) => s.args !== undefined || s.indexed === true)) k--;
        for (; k >= 1; k--) {
          const r = this.local(scope, segs.slice(0, k).map((s) => s.name.toLowerCase()).join('.'), seen);
          if (r !== null) {
            res = r;
            next = k;
            break;
          }
        }
        if (k === 0 && !/^(?:request|session|form|url|cgi|cookie|server|client)$/.test(w)) {
          const r = this.unscoped(scope, w, seen);
          if (r !== null) res = r;
        }
      }
    }
    res = this.members(res, segs, next, upto, seen);
    if (res.kind === 'resolved') return res;
    // A `get<Bean>()` accessor names its bean whatever its receiver, so an unresolved chain resumes at the last one.
    for (let k = upto - 1; k >= next; k--) {
      const s = segs[k];
      if (s?.args?.length === 0 && s.indexed !== true && GETTER.test(s.name) && this.ctx.index.resolveBean(s.name.slice(3)) !== null) {
        return this.members(this.getter(scope.receiver, s.name, seen, false), segs, k + 1, upto, seen);
      }
    }
    return res;
  }

  /**
   * `res` carried through the members of `segs[from..upto)`: getters, fluent calls, an entity's feed or iterator, and
   * any other method by what it returns; unknown at a property or an index.
   */
  private members(res: Resolution, segs: readonly ChainSegment[], from: number, upto: number, seen: Set<string>): Resolution {
    let out = res;
    for (let k = from; k < upto && out.kind === 'resolved'; k++) {
      const s = segs[k];
      if (s === undefined || s.args === undefined || s.indexed === true) {
        out = UNKNOWN;
      } else if (COLLECTION.test(s.name) && (out.item !== undefined || this.ctx.index.ormTable(out.path) !== null)) {
        out = this.returned(out, s.name);
      } else if (s.args.length === 0 && GETTER.test(s.name)) {
        out = this.getter(out.path, s.name, seen, false);
      } else if (!FLUENT.test(s.name)) {
        out = this.returned(out, s.name);
      }
    }
    return out;
  }

  /** Names callable without a receiver: functions up the receiver's chain and those the current template defines. */
  selfFunction(scope: Scope, name: string): { from: string } | null {
    const lower = name.toLowerCase();
    if (scope.unit.syntax === 'template' && scope.unit.functions.some((f) => f.name !== '' && f.name.toLowerCase() === lower)) {
      return { from: scope.unit.path };
    }
    return this.findFunction(scope.receiver, name) === null ? null : { from: scope.receiver };
  }
}

interface ResolvedCall {
  site: CallSite;
  resolution: Resolution;
  /** Lookup start for the target method (the parent for `super`, a template for its own functions). */
  from: string | null;
  regions: Region[];
  /** Receiver as written in normal form (`exprKey`): `''` for an unqualified call, null for `new`. */
  receiver: string | null;
}

function regionsAt(regions: readonly Region[], offset: number): Region[] {
  return regions.filter((r) => r.start <= offset && offset < r.end).sort((a, b) => a.start - b.start || b.end - a.end);
}

function guardOf(applicable: readonly Region[]): GuardCondition | undefined {
  const conds = applicable.flatMap((r) => (r.cond === undefined ? [] : [r.cond]));
  if (conds.length === 0) return undefined;
  return conds.length === 1 ? conds[0] : { k: 'and', of: conds };
}

function resolveCalls(resolver: Resolver, scope: Scope): ResolvedCall[] {
  const analysis = analyse(scope.fn, scope.unit.syntax);
  const body = scope.fn.body;
  const out: ResolvedCall[] = [];
  for (const call of analysis.calls) {
    const seg = call.chain.segs[call.k];
    if (seg === undefined) continue;
    let resolution: Resolution;
    let from: string | null = null;
    let target: CallTarget;
    const s0 = call.chain.segs[0]?.name.toLowerCase();
    if (call.chain.kind === 'new' && call.k === 0) {
      resolution = resolver.value(call.chain, 1, scope, new Set());
      target = { component: resolution.kind === 'resolved' ? resolution.path : seg.name, method: 'init' };
    } else if (call.k === 0) {
      const self = resolver.selfFunction(scope, seg.name);
      if (self === null) continue;
      resolution = { kind: 'resolved', path: scope.receiver, from: self.from };
      target = { self: 'local', method: seg.name };
    } else {
      resolution = resolver.value(call.chain, call.k, scope, new Set());
      // Unknown receivers are kept only where the method may write (`save`, `delete`) or re-login (`login`).
      if (resolution.kind === 'unknown' && !/^(save|delete|login)$/i.test(seg.name)) continue;
      if (s0 === 'this' || s0 === 'super') target = { self: s0, method: seg.name };
      else if (resolution.kind === 'resolved' && resolution.bean !== undefined) target = { bean: resolution.bean, method: seg.name };
      else if (resolution.kind === 'resolved') target = { component: resolution.path, method: seg.name };
      else if (resolution.kind === 'unresolved' && resolution.name !== undefined) target = { bean: resolution.name, method: seg.name };
      else target = { method: seg.name };
    }
    if (resolution.kind === 'resolved') from = resolution.from;
    const regions = regionsAt(analysis.regions, call.offset);
    const site: CallSite = {
      target,
      resolved: resolution.kind === 'resolved' ? resolution.path : null,
      line: analysis.lineAt(call.offset),
      offset: call.offset,
      args: seg.args ?? [],
      text:
        call.k === 0
          ? `${call.chain.kind === 'new' ? 'new ' : ''}${seg.name}`
          : `${chainText(call.chain, call.k, body)}.${seg.name}`,
    };
    const guard = guardOf(regions);
    if (guard !== undefined) site.guard = guard;
    const thread = threadAt(analysis.regions, call.offset, analysis.lineAt);
    if (thread !== undefined) site.thread = thread;
    const receiver = call.chain.kind === 'new' && call.k === 0 ? null : call.k === 0 ? '' : exprKey(chainText(call.chain, call.k, body));
    out.push({ site, resolution, from, regions, receiver });
  }
  return out;
}

/**
 * Calls of `fn` the closure follows: `application.<bean>`, `getBean('<bean>')` chains, `variables.<bean>`,
 * `get<Bean>()` accessors, `this`/`super`/local functions and `new`/`createObject` components.
 */
export function extractCalls(
  fn: CfmlFunction,
  component: CfmlUnit,
  ctx: ClosureContext & { receiver?: string },
): CallSite[] {
  const resolver = new Resolver(ctx);
  return resolveCalls(resolver, { receiver: ctx.receiver ?? component.path, unit: component, fn }).map((c) => c.site);
}

// ---------------------------------------------------------------------------------------------------------------
// Write closure
// ---------------------------------------------------------------------------------------------------------------

/** An entry point: a component method (or `''` for a `.cfm`), the request predicates of its branch, and the more specific variants it excludes. */
export interface ClosureEntry {
  component: string;
  method: string;
  predicates?: Predicates;
  excludePredicates?: readonly Predicates[];
  /** Trigger of the writes the entry reaches outside threads; defaults to `request`. */
  trigger?: Trigger;
  /**
   * The entry method runs on a bean its caller populated from the request (`bean.set(<request values>)`): the
   * lower-cased keys the caller set on it, or on the request values, beyond those the request carries.
   */
  populated?: readonly string[];
}

/**
 * One table write the closure reaches; `table` is null for an unresolved dynamic target.
 * `via` is the call path from the entry to the writing method (an ORM save or delete ends with the entity's method);
 * `columns` lists the lower-cased columns the statement or override names, null when it names none (ORM, `DELETE`).
 */
export interface ClosureWrite {
  table: string | null;
  op: WriterOp;
  component: string;
  method: string;
  source: SourceRef;
  trigger: Trigger;
  whereParams: string[];
  conditional: boolean;
  columns: string[] | null;
  via: string[];
  override?: string;
  dynamic?: true;
}

/** A write reached only under a guard the predicates cannot decide, with the call path of its write. */
export interface ConditionalWrite {
  table: string;
  condition: string;
  source: SourceRef;
  via: string[];
}

/**
 * A call or file operation that writes or deletes stored file objects; `via` ends with the called file-store method,
 * or with the function holding the operation.
 */
export interface FileStoreEvidence {
  component: string;
  /** The file-store method called, or the operation and its path operand, as `cffile:delete(file)`. */
  method: string;
  source: SourceRef;
  conditional: boolean;
  via: string[];
  /** What a file operation does to the stored object; absent for a file-store method, whose name decides it. */
  op?: 'write' | 'delete';
}

/** A thread body reached by the closure. */
export interface ClosureThread {
  name: string;
  component: string;
  method: string;
  source: SourceRef;
}

/**
 * A reference the walk could not follow; settled by a writer override or a settled call, else reported for review.
 * `via` is the call path from the entry to the method holding the reference.
 */
export interface UnresolvedRef {
  expr: string;
  kind: UnresolvedKind;
  source: SourceRef;
  via: string[];
}

/** Union of everything a branch writes, with the evidence and gaps behind it; every array is sorted. */
export interface WriteClosure {
  tables: string[];
  writes: ClosureWrite[];
  conditionalWrites: ConditionalWrite[];
  fileStore: boolean;
  fileStoreEvidence: FileStoreEvidence[];
  sessionEffects: SessionEffects;
  threads: ClosureThread[];
  unresolved: UnresolvedRef[];
  /** Ids of the writer overrides (including `tablesFrom` writers) and settled calls applied. */
  overrides: string[];
  visited: string[];
}

interface WalkNode {
  receiver: string;
  from: string;
  method: string;
  aliases: readonly Alias[];
  literals: Readonly<Record<string, string>>;
  /**
   * Tracked formals the call passed, with their literal value or null when unknown; a formal it omits takes its
   * literal default. Absent for a node whose caller is unknown (the entry, an override's reach, onMissingMethod).
   */
  formals?: Readonly<Record<string, Val | null>>;
  /** Lower-cased formals, sorted, whose bound value is a path in the file store. */
  storePaths?: readonly string[];
  thread: boolean;
  relogin: boolean;
  conditions: readonly string[];
  /** Call path of the caller that enqueued the node, empty for the entry; not part of the node's identity. */
  trail: readonly string[];
}

/** Call-path label of a function: `<file name without extension>.<function>`, or `<file>.(template)` for a template body. */
export function viaLabel(unitPath: string, fnName: string): string {
  return `${path.posix.basename(unitPath).replace(/\.cf[cm]$/i, '')}.${fnName === '' ? '(template)' : fnName}`;
}

// fileDAO.cfc:111-209 writes originals and renditions; the delete paths flag or purge stored objects.
const FILE_STORE_METHODS = new Set(['create', 'deleteversion', 'deleteall', 'purgedeleted', 'deleteifnotused']);
const FILE_WRITER_METHODS = new Set(['writefile', 'movefile', 'copyfile', 'renamefile', 'uploadfile', 'appendfile']);
// getCustomImage writes custom-size renditions, a cache rebuilt from the stored image whenever one is missing
// (processImgCfimage.cfc:207-262), so none is a stored object.
const RENDITION_CACHE_METHODS = new Set(['getcustomimage']);
const SESSION_RANK: Record<SessionEffects, number> = { none: 0, relogin: 1, login: 2, logout: 3 };

// ---------------------------------------------------------------------------------------------------------------
// File operations on the file store
// ---------------------------------------------------------------------------------------------------------------

/** A path operand of a file operation and what the operation does to the object it names. */
interface FileOperand {
  /** Position of a builtin's operand, or the tag attribute holding it. */
  at: number | string;
  /** Names a builtin's operand may be passed by. */
  names: readonly string[];
  op: 'write' | 'delete';
}

/** One path operand of a builtin call or tag in a function body that writes or deletes the object it names. */
interface FileOperation {
  name: string;
  op: 'write' | 'delete';
  /** The operand as a CFML expression; a tag attribute is given as a string literal. */
  path: string;
  offset: number;
}

/** A path operand at a builtin position or a tag attribute; a tag attribute is its own name. */
const operand = (at: number | string, op: FileOperand['op'], ...names: string[]): FileOperand => ({ at, names: names.length > 0 ? names : [String(at)], op });

/** Builtins writing or deleting the file or directory their path operands name. */
const FILE_FUNCTIONS: Readonly<Record<string, readonly FileOperand[]>> = {
  filewrite: [operand(0, 'write', 'file', 'filepath')],
  fileappend: [operand(0, 'write', 'file', 'filepath')],
  filedelete: [operand(0, 'delete', 'file', 'filepath')],
  filemove: [operand(0, 'delete', 'source'), operand(1, 'write', 'destination')],
  filecopy: [operand(1, 'write', 'destination')],
  fileupload: [operand(0, 'write', 'destination')],
  fileuploadall: [operand(0, 'write', 'destination')],
  imagewrite: [operand(1, 'write', 'destination')],
  directorydelete: [operand(0, 'delete', 'path')],
  directoryrename: [operand(0, 'delete', 'oldpath', 'path'), operand(1, 'write', 'newpath')],
  directorycopy: [operand(1, 'write', 'destination')],
};

/** Tag actions writing or deleting the file or directory their path attributes name; `*` is any action of the tag. */
const FILE_TAGS: Readonly<Record<string, Readonly<Record<string, readonly FileOperand[]>>>> = {
  file: {
    write: [operand('file', 'write')],
    append: [operand('file', 'write')],
    delete: [operand('file', 'delete')],
    upload: [operand('destination', 'write')],
    uploadall: [operand('destination', 'write')],
    copy: [operand('destination', 'write')],
    move: [operand('source', 'delete'), operand('destination', 'write')],
    rename: [operand('source', 'delete'), operand('destination', 'write')],
  },
  image: { '*': [operand('destination', 'write')] },
  directory: { delete: [operand('directory', 'delete')], rename: [operand('directory', 'delete'), operand('newdirectory', 'write')] },
  zip: { unzip: [operand('destination', 'write')], zip: [operand('file', 'write')], delete: [operand('file', 'write')] },
};

/** A configured file-store root: the global or site `fileDir` or `assetDir`. */
const FILE_STORE_ROOT = /\bget(?:File|Asset)Dir\s*\(/i;
const PATH_REFERENCE = /(?<![\w$.])([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)(\s*\()?/g;

const fileOperationCache = new WeakMap<CfmlFunction, FileOperation[]>();

/** The path operands of the builtins and tags of `fn` that write or delete files or directories. */
function fileOperations(fn: CfmlFunction, analysis: Analysis): FileOperation[] {
  const cached = fileOperationCache.get(fn);
  if (cached !== undefined) return cached;
  const ops: FileOperation[] = [];
  for (const call of analysis.calls) {
    const seg = call.chain.segs[call.k];
    if (call.chain.kind !== 'name' || call.k !== 0 || call.chain.segs.length !== 1 || seg?.args === undefined) continue;
    for (const o of FILE_FUNCTIONS[seg.name.toLowerCase()] ?? []) {
      const args = seg.args;
      const arg = args.find((a) => a.name !== undefined && o.names.includes(a.name.toLowerCase())) ?? (typeof o.at === 'number' && args[o.at]?.name === undefined ? args[o.at] : undefined);
      if (arg !== undefined) ops.push({ name: `${seg.name}(${o.names[0] ?? ''})`, op: o.op, path: arg.expr, offset: call.offset });
    }
  }
  for (const m of fn.body.matchAll(/<cf(file|image|directory|zip)\b/gi)) {
    if (analysis.literal[m.index] === 1) continue;
    const tag = (m[1] ?? '').toLowerCase();
    const attrs = parseAttributes(fn.body.slice(m.index + m[0].length, Math.max(m.index + m[0].length, tagEnd(fn.body, m.index) - 1)));
    const action = (attrs.action ?? '').toLowerCase();
    for (const o of FILE_TAGS[tag]?.[action] ?? FILE_TAGS[tag]?.['*'] ?? []) {
      const value = attrs[String(o.at)];
      if (value !== undefined && value !== '') ops.push({ name: `cf${tag}:${action}(${String(o.at)})`, op: o.op, path: `"${value.replace(/"/g, '""')}"`, offset: m.index });
    }
  }
  ops.sort((a, b) => a.offset - b.offset);
  fileOperationCache.set(fn, ops);
  return ops;
}

/** `expr` with each string literal replaced by the expressions it interpolates, so that only code remains. */
function codeOf(expr: string): string {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr.charAt(i);
    if (c !== '"' && c !== "'") {
      out += c;
      i++;
      continue;
    }
    const parts: string[] = [];
    i = skipString(expr, i, expr.length, (from, to) => parts.push(codeOf(expr.slice(from, Math.max(from, to - 1)))));
    out += ` ${parts.join(' ')} `;
  }
  return out;
}

/**
 * Whether the CFML path expression `expr` of `fn` names an object in the file store: it is built on a configured
 * file-store root, directly or through the locals assigned to it, or on a formal in `storePaths` or declared with such
 * a default. Temp and upload paths are built on no root, so they never qualify.
 */
function storePath(expr: string, fn: CfmlFunction, analysis: Analysis, storePaths: ReadonlySet<string>, seen: Set<Assignment>): boolean {
  const code = codeOf(expr);
  if (FILE_STORE_ROOT.test(code)) return true;
  const formal = (name: string): boolean => {
    if (storePaths.has(name)) return true;
    const declared = fn.args.find((a) => a.name.toLowerCase() === name)?.default;
    return declared !== undefined && FILE_STORE_ROOT.test(codeOf(declared));
  };
  for (const m of code.matchAll(PATH_REFERENCE)) {
    const head = (m[1] ?? '').toLowerCase();
    const members = (m[2] ?? '').replace(/\s+/g, '').toLowerCase();
    if (m[3] !== undefined && members === '') continue;
    const first = members.slice(1).split('.')[0] ?? '';
    let names: string[];
    if (head === 'arguments' && first !== '') {
      if (formal(first)) return true;
      names = [`arguments.${first}`];
    } else if (head === 'local' && first !== '') {
      names = [members.slice(1), first];
    } else {
      if (fn.args.some((a) => a.name.toLowerCase() === head) && formal(head)) return true;
      names = [head + members, head];
    }
    for (const a of analysis.assignments) {
      if (!names.includes(a.lvalue) || seen.has(a)) continue;
      seen.add(a);
      if (storePath(a.rhs, fn, analysis, storePaths, seen)) return true;
    }
  }
  return false;
}

const storeRootCache = new WeakMap<CfmlFunction, boolean>();
const storePathCache = new WeakMap<CfmlFunction, Map<string, boolean>>();

/** {@link storePath} memoised per function and `storePaths`; false at once when neither `fn` nor `storePaths` names a root. */
function isStorePath(expr: string, fn: CfmlFunction, analysis: Analysis, storePaths: ReadonlySet<string>): boolean {
  let roots = storeRootCache.get(fn);
  if (roots === undefined) {
    roots = FILE_STORE_ROOT.test(fn.body) || fn.args.some((a) => a.default !== undefined && FILE_STORE_ROOT.test(a.default));
    storeRootCache.set(fn, roots);
  }
  if (!roots && storePaths.size === 0) return false;
  let memo = storePathCache.get(fn);
  if (memo === undefined) {
    memo = new Map();
    storePathCache.set(fn, memo);
  }
  const key = `${[...storePaths].join(',')}\u0000${expr}`;
  let hit = memo.get(key);
  if (hit === undefined) {
    hit = storePath(expr, fn, analysis, storePaths, new Set());
    memo.set(key, hit);
  }
  return hit;
}

/**
 * Lower-cased formals of `callee`, sorted, that a call binds to file-store paths: arguments `isStore` accepts, and
 * the caller's own `storePaths` passed on by `argumentCollection=arguments`; undefined when it binds none.
 */
function storePathFormals(
  args: readonly CallArgument[],
  callee: CfmlFunction,
  isStore: (expr: string) => boolean,
  storePaths: ReadonlySet<string>,
): string[] | undefined {
  const out = new Set<string>();
  args.forEach((a, i) => {
    const named = a.name?.toLowerCase();
    if (named === 'argumentcollection') {
      if (a.expr.replace(/\s+/g, '').toLowerCase() === 'arguments') for (const f of storePaths) out.add(f);
      return;
    }
    const formal = named ?? callee.args[i]?.name.toLowerCase();
    if (formal !== undefined && isStore(a.expr)) out.add(formal);
  });
  return out.size === 0 ? undefined : [...out].sort(compareText);
}

function baseName(p: string): string {
  return path.posix.basename(p).toLowerCase();
}

function aliasKey(aliases: readonly Alias[]): string {
  return aliases
    .map((a) =>
      a.kind === 'bean'
        ? `bean:${a.name}:${a.component ?? ''}:${(a.extra ?? []).join('+')}${a.opaque === true ? ':opaque' : ''}${a.fresh === undefined ? '' : `:fresh=${a.fresh}`}${a.values === undefined ? '' : `:${JSON.stringify(Object.entries(a.values).sort(([x], [y]) => compareText(x, y)))}`}`
        : `${a.kind}:${a.name}`,
    )
    .sort(compareText)
    .join(',');
}

/** The tracking state a bean alias hands on: whether it is opaque or fresh and the values it knows. */
type BeanState = Pick<Alias, 'component' | 'extra' | 'opaque' | 'values' | 'fresh'>;

function addAlias(list: Alias[], name: string, kind: Alias['kind'], bean?: BeanState): void {
  if (list.some((a) => a.name === name)) return;
  if (kind !== 'bean' || bean === undefined) {
    list.push({ name, kind });
    return;
  }
  const alias: Alias = { name, kind, component: bean.component, extra: [...(bean.extra ?? [])].sort(compareText) };
  if (bean.opaque === true) alias.opaque = true;
  if (bean.fresh !== undefined) alias.fresh = bean.fresh;
  if (bean.values !== undefined && Object.keys(bean.values).length > 0) alias.values = bean.values;
  list.push(alias);
}

function structAlias(list: Alias[], name: string): void {
  addAlias(list, name, 'struct');
  addAlias(list, `${name}.$`, 'scope');
}

/** The request as the entry function sees it: `rc`, `event` and `$` formals, plus `request.context`. */
function entryAliases(fn: CfmlFunction): Alias[] {
  const out: Alias[] = [];
  addAlias(out, 'request.context', 'struct');
  if (fn.name === '') templateAliases(out);
  for (const a of fn.args) {
    const n = a.name.toLowerCase();
    if (n === 'rc') {
      structAlias(out, 'arguments.rc');
      structAlias(out, 'rc');
    } else if (n === 'event') {
      addAlias(out, 'arguments.event', 'event');
      addAlias(out, 'event', 'event');
    } else if (n === '$') {
      addAlias(out, 'arguments.$', 'scope');
      addAlias(out, '$', 'scope');
    }
  }
  return out;
}

/** Names a view or display-object template reads the request under. */
function templateAliases(out: Alias[]): Alias[] {
  structAlias(out, 'rc');
  addAlias(out, 'event', 'event');
  addAlias(out, '$', 'scope');
  addAlias(out, 'm', 'scope');
  return out;
}

const factsCache = new WeakMap<ComponentIndex, Map<string, BeanFacts>>();

/** Keys `component` and its ancestors hold a value of their own for, and the functions they define. */
function beanFacts(resolver: Resolver, component: string): BeanFacts {
  let cache = factsCache.get(resolver.ctx.index);
  if (cache === undefined) {
    cache = new Map();
    factsCache.set(resolver.ctx.index, cache);
  }
  const hit = cache.get(component);
  if (hit !== undefined) return hit;
  const held = new Set<string>();
  const defined = new Set<string>();
  for (const p of resolver.chain(component)) {
    const unit = resolver.unit(p);
    if (unit === null) continue;
    for (const prop of unit.properties) held.add(prop.name.toLowerCase());
    for (const fn of unit.functions) {
      defined.add(fn.name.toLowerCase());
      const analysis = analyse(fn, unit.syntax);
      for (const a of analysis.assignments) {
        const key = /^variables\.instance\.([\w$]+)/.exec(a.lvalue)?.[1];
        if (key !== undefined) held.add(key);
      }
      for (const m of fn.body.matchAll(/\bvariables\.instance\s*\[\s*(["'])([\w$]+)\1\s*\]\s*=(?!=)/gi)) held.add((m[2] ?? '').toLowerCase());
      for (const c of analysis.calls) {
        const seg = c.chain.segs[c.k];
        const own = c.k === 0 || (c.k === 1 && c.chain.segs[0]?.name.toLowerCase() === 'this');
        if (!own || seg === undefined) continue;
        const key = setterKey(seg.name, seg.args ?? []);
        if (typeof key === 'string') held.add(key);
      }
    }
  }
  const facts: BeanFacts = { held, defined, initial: initialValues(resolver, component), mapping: mappingFlags(resolver, component) };
  cache.set(component, facts);
  return facts;
}

/** ORM mapping flags the bean records per entity from its component metadata, with the value an absent attribute leaves. */
const MAPPING_FLAG_DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({ usetrash: false, historical: false });

/** Body of a getter returning `application.objectMappings[variables.entityName].<flag>`, after an optional `param`. */
const MAPPING_GETTER =
  /^\s*(?:param\s+name\s*=\s*(["'])application\.objectMappings\.#variables\.entityName#\.[\w$]+\1[^;]*;\s*)?return\s+application\.objectMappings\s*\[\s*variables\.entityName\s*\]\s*\.\s*([\w$]+)\s*;?\s*$/i;

/** A metadata attribute as a CFML boolean; undefined for a value that is none. */
function cfBoolean(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (v === 'true' || v === 'yes') return true;
  if (v === 'false' || v === 'no') return false;
  return v !== undefined && /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) !== 0 : undefined;
}

/**
 * The mapping flags the metadata of `component` fixes, by the lower-cased name of the inherited getter returning
 * each; none unless its whole chain is in the source tree. A flag is the component's own attribute, else its
 * default, and `historical` also holds when a property up the chain is historical.
 */
function mappingFlags(resolver: Resolver, component: string): Record<string, Ex> {
  const out: Record<string, Ex> = {};
  const units = resolver.chain(component).flatMap((p) => resolver.unit(p) ?? []);
  const own = units[0];
  const root = units[units.length - 1];
  if (own === undefined || root === undefined || own.syntax === 'template' || root.syntax === 'template') return out;
  const ext = (root as CfmlComponent).declaration.attrs.extends;
  if (ext !== undefined && ext !== '') return out;
  const attrs = (own as CfmlComponent).declaration.attrs;
  const historicalProperty = units.some((u) => u.properties.some((p) => cfBoolean(p.attrs.historical) === true));
  const seen = new Set<string>();
  units.forEach((unit, depth) => {
    for (const fn of unit.functions) {
      const name = fn.name.toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      const flag = depth > 0 && fn.args.length === 0 ? MAPPING_GETTER.exec(fn.body)?.[2]?.toLowerCase() : undefined;
      const fallback = flag === undefined ? undefined : MAPPING_FLAG_DEFAULTS[flag];
      if (flag === undefined || fallback === undefined) continue;
      const declared = attrs[flag];
      const value = flag === 'historical' && historicalProperty ? true : declared === undefined ? fallback : cfBoolean(declared);
      if (value !== undefined) out[name] = boolLit(value);
    }
  });
  return out;
}

/**
 * The literals the init chain of `component` leaves in `variables.instance`: inits run base first through
 * `super.init()`, and a key keeps a literal only when the last init to touch it assigns one unconditionally after
 * its own `super.init()`, with no call of that init changing the key and no bulk rewrite of the instance.
 */
function initialValues(resolver: Resolver, component: string): Readonly<Record<string, Ex>> {
  const chain = resolver.chain(component);
  const lastUnit = resolver.unit(chain[chain.length - 1] ?? '');
  const ext = lastUnit === null || lastUnit.syntax === 'template' ? undefined : (lastUnit as CfmlComponent).declaration.attrs.extends;
  // An ancestor outside the source tree may set anything.
  if (lastUnit === null || (ext !== undefined && ext !== '')) return {};
  const runs: Array<{ unit: CfmlUnit; fn: CfmlFunction; superAt: number }> = [];
  for (const p of chain) {
    const unit = resolver.unit(p);
    const fn = unit?.functions.find((f) => f.name.toLowerCase() === 'init');
    if (unit === null || unit === undefined || fn === undefined) continue;
    const superCall = analyse(fn, unit.syntax).calls.find((c) => c.k === 1 && c.chain.segs[0]?.name.toLowerCase() === 'super' && c.chain.segs[1]?.name.toLowerCase() === 'init');
    runs.push({ unit, fn, superAt: superCall?.offset ?? -1 });
    if (superCall === undefined) break;
  }
  const out = new Map<string, Ex>();
  for (const { unit, fn, superAt } of runs.reverse()) {
    const analysis = analyse(fn, unit.syntax);
    const body = fn.body;
    if (/\bstruct(?:append|clear|insert|update|delete)\s*\(\s*variables\.instance\b|\bvariables\.instance\s*\[/i.test(body)) out.clear();
    for (const a of analysis.assignments) {
      if (a.lvalue === 'variables.instance') {
        out.clear();
        continue;
      }
      const key = /^variables\.instance\.([\w$]+)(\.)?/.exec(a.lvalue);
      if (key?.[1] === undefined) continue;
      const v = key[2] === undefined ? literalVal(a.rhs) : undefined;
      const settled = v !== undefined && a.offset > superAt && regionsAt(analysis.regions, a.offset).length === 0;
      out.set(key[1], settled ? { t: 'lit', v } : UNK);
    }
    // What the init's calls do to the instance, through its own methods or those it hands itself to.
    const scope: Scope = { receiver: component, unit, fn };
    for (const c of analysis.calls) {
      const seg = c.chain.segs[c.k];
      if (seg?.args === undefined) continue;
      const own = c.k === 0 || (c.k === 1 && c.chain.segs[0]?.name.toLowerCase() === 'this');
      const key = own ? setterKey(seg.name, seg.args) : undefined;
      if (key === null || (own && seg.name.toLowerCase() === 'set' && seg.args.length === 1)) {
        out.clear();
        continue;
      }
      if (key !== undefined) {
        out.set(key, UNK);
        continue;
      }
      const callee = own || seg.args.some((a) => exprKey(a.expr) === 'this') ? calleeOf(resolver, scope, c.chain, c.k) : null;
      const formal = callee === null ? undefined : own ? 'this' : passedFormal(seg.args, callee.fn, ['this']);
      if (callee === null || formal === undefined) continue;
      const m = formalMutation(resolver, callee, formal);
      if (m.wholesale) out.clear();
      for (const k of m.keys) out.set(k, UNK);
    }
  }
  return Object.fromEntries([...out].filter(([, v]) => v.t !== 'unk'));
}

/**
 * The key a bean call sets: `setX(v)` and `setValue('x', v)`/`set('x', v)` name one; null when the call may set any
 * key (`setAllValues`, a computed key); undefined when it sets none (`set(struct)` is a population, judged apart).
 */
function setterKey(name: string, args: readonly CallArgument[]): string | null | undefined {
  const lower = name.toLowerCase();
  if (lower === 'setallvalues') return null;
  if (lower === 'set' || lower === 'setvalue') {
    if (args.length < 2) return undefined;
    return literalString(args[0]?.expr)?.toLowerCase() ?? null;
  }
  const prop = /^set([\w$]+)$/.exec(lower)?.[1];
  return prop;
}

/** The keys of `keys` a bean of `component` does not already hold, unique and sorted. */
function extraKeys(resolver: Resolver, component: string | undefined, keys: Iterable<string>): string[] {
  const held = component === undefined ? new Set<string>() : beanFacts(resolver, component).held;
  return [...new Set([...keys].map((k) => k.toLowerCase()))].filter((k) => k !== '' && !held.has(k)).sort(compareText);
}

/** Normal form of a receiver or argument expression: no whitespace, lower-cased, without a `local.` scope. */
function exprKey(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase().replace(/^local\./, '');
}

/** The bean alias a values expression (`x` or `x.getAllValues()`) reads; undefined when it reads none. */
function sourceBean(expr: string, aliases: readonly Alias[]): Alias | undefined {
  const e = exprKey(expr);
  return aliases.find((a) => a.kind === 'bean' && a.component !== undefined && (e === a.name || e === `${a.name}.getallvalues()`));
}

/** The expression a keyed setter call stores: `propertyValue`, the argument after the key, or the only one of `setX(v)`. */
function setterValue(name: string, args: readonly CallArgument[]): string | null {
  const lower = name.toLowerCase();
  const named = args.find((a) => a.name?.toLowerCase() === 'propertyvalue');
  const arg = named ?? (lower === 'set' || lower === 'setvalue' ? args[1] : args.length === 1 ? args[0] : undefined);
  return arg?.expr ?? null;
}

/** Whether the expression starting at `offset` begins a statement of its own. */
function atStatement(body: string, offset: number): boolean {
  let i = offset - 1;
  while (i >= 0 && isSpace(body.charAt(i))) i--;
  return i < 0 || ';{}'.includes(body.charAt(i)) || /<cfset$/i.test(body.slice(Math.max(0, i - 5), i + 1));
}

/**
 * Keys a bean factory function (`getBean` of a base component) may set on the instance it hands out: those of its
 * keyed setter calls; null when it may set any.
 */
function factoryKeys(factory: Scope): string[] | null {
  const keys = new Set<string>();
  for (const c of analyse(factory.fn, factory.unit.syntax).calls) {
    const seg = c.chain.segs[c.k];
    if (seg?.args === undefined) continue;
    const key = setterKey(seg.name, seg.args);
    if (key === null || (seg.name.toLowerCase() === 'set' && seg.args.length === 1)) return null;
    if (key !== undefined) keys.add(key);
  }
  return [...keys];
}

/** Keys a request-values expression brings into a bean it populates; null when `expr` is not one. */
function requestSource(resolver: Resolver, expr: string, aliases: readonly Alias[]): string[] | null {
  const e = exprKey(expr);
  for (const a of aliases) {
    if (a.kind === 'struct' && e === a.name) return [];
    if (a.kind === 'event' && e === `${a.name}.getallvalues()`) return [];
    if (a.kind === 'scope' && e === `${a.name}.event().getallvalues()`) return [];
    if (a.kind === 'bean' && a.component !== undefined && (e === a.name || e === `${a.name}.getallvalues()`)) {
      return [...beanFacts(resolver, a.component).held, ...(a.extra ?? [])];
    }
  }
  return null;
}

/**
 * Keys a function sets on the value one of its formals (or `this`) receives, whether it may rewrite it wholesale,
 * and whether it keeps the value in its component (`variables.x = formal`), making the receiver a view of it.
 */
interface Mutation {
  keys: readonly string[];
  wholesale: boolean;
  escapes: boolean;
}

const NO_MUTATION: Mutation = Object.freeze({ keys: [], wholesale: false, escapes: false });
const mutationCache = new WeakMap<ComponentIndex, WeakMap<CfmlFunction, Map<string, Mutation>>>();
/** Mutation analyses in progress, innermost last; `partial` marks one a cycle cut short, whose result is not cached. */
const mutationStack: Array<{ fn: CfmlFunction; key: string; partial: boolean }> = [];
/** Member calls that reload or bulk-rewrite their receiver's values. */
const REWRITES = /^(load|loadby|init|setallvalues)$/;

/** The function a call of `scope.fn` reaches, with the receiver it runs on, when the walk can locate it. */
function calleeOf(resolver: Resolver, scope: Scope, chain: Chain, k: number): Scope | null {
  const seg = chain.segs[k];
  if (seg === undefined || (chain.kind === 'new' && k === 0)) return null;
  if (k === 0) {
    const self = resolver.selfFunction(scope, seg.name);
    const found = self === null ? null : resolver.findFunction(self.from, seg.name);
    return found === null ? null : { receiver: scope.receiver, unit: found.unit, fn: found.fn };
  }
  const r = resolver.value(chain, k, scope, new Set());
  if (r.kind !== 'resolved') return null;
  const found = resolver.findFunction(r.from, seg.name);
  return found === null ? null : { receiver: r.path, unit: found.unit, fn: found.fn };
}

/** Index of the argument of `args` passing one of `names`, with the callee formal it binds; undefined when none does. */
function passedFormal(args: readonly CallArgument[], callee: CfmlFunction, names: readonly string[]): string | undefined {
  for (const [i, a] of args.entries()) {
    if (!names.includes(exprKey(a.expr))) continue;
    const named = a.name?.toLowerCase();
    if (named === 'argumentcollection') continue;
    const formal = named === undefined ? callee.args[i] : callee.args.find((f) => f.name.toLowerCase() === named);
    if (formal !== undefined) return formal.name.toLowerCase();
  }
  return undefined;
}

/**
 * Keys a body writes straight into its own `variables.instance`, and whether it replaces or overwrites it in bulk.
 * Writes under computed names (display-region object lists, extended attributes merged without overwriting) are
 * taken to add keys of their own rather than change one written by name; an init's property loop is judged apart.
 */
function instanceWrites(body: string, analysis: Analysis): { keys: string[]; wholesale: boolean } {
  const keys = new Set<string>();
  let wholesale = false;
  for (const a of analysis.assignments) {
    if (a.lvalue === 'variables.instance') wholesale = true;
    const key = /^variables\.instance\.([\w$]+)/.exec(a.lvalue)?.[1];
    if (key !== undefined) keys.add(key);
  }
  const code = (re: RegExp): RegExpExecArray[] => [...body.matchAll(re)].filter((m) => analysis.literal[m.index] !== 1);
  for (const m of code(/\bvariables\.instance\s*\[\s*(["'])([\w$]+)\1\s*\]\s*=(?!=)/gi)) keys.add((m[2] ?? '').toLowerCase());
  for (const m of code(/\bstruct(?:insert|update|delete)\s*\(\s*variables\.instance\s*,\s*(["'])([\w$]+)\1/gi)) keys.add((m[2] ?? '').toLowerCase());
  if (code(/\bstructclear\s*\(\s*variables\.instance\s*\)/gi).length > 0) wholesale = true;
  for (const m of code(/\bstructappend\s*\(\s*variables\.instance\s*,/gi)) {
    const open = body.lastIndexOf('(', m.index + m[0].length);
    const close = matchBracket(body, open);
    const args = close < 0 ? [] : splitArgs(body.slice(open + 1, close));
    if (!/^false$/i.test(args[2]?.expr.trim() ?? '')) wholesale = true;
  }
  return { keys: [...keys], wholesale };
}

/**
 * What `scope.fn` does to the value formal `formal` receives (`this` for the receiver itself): the keys it assigns or
 * sets on it, and whether it reloads, repopulates or bulk-rewrites it, through the callees it passes the value to.
 */
function formalMutation(resolver: Resolver, scope: Scope, formal: string): Mutation {
  let byFn = mutationCache.get(resolver.ctx.index);
  if (byFn === undefined) {
    byFn = new WeakMap();
    mutationCache.set(resolver.ctx.index, byFn);
  }
  let cache = byFn.get(scope.fn);
  if (cache === undefined) {
    cache = new Map();
    byFn.set(scope.fn, cache);
  }
  const cacheKey = `${scope.receiver}|${formal}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  const open = mutationStack.findIndex((f) => f.fn === scope.fn && f.key === cacheKey);
  if (open >= 0) {
    // A cycle back into an analysis in progress, which collects its own effects itself; the frames between see only part.
    for (const f of mutationStack.slice(open + 1)) f.partial = true;
    return NO_MUTATION;
  }
  const frame = { fn: scope.fn, key: cacheKey, partial: false };
  mutationStack.push(frame);
  try {
    const out = analyseMutation(resolver, scope, formal);
    if (!frame.partial) cache.set(cacheKey, out);
    return out;
  } finally {
    mutationStack.pop();
  }
}

function analyseMutation(resolver: Resolver, scope: Scope, formal: string): Mutation {
  const self = formal === 'this';
  const names = self ? ['this'] : [formal, `arguments.${formal}`];
  const analysis = analyse(scope.fn, scope.unit.syntax);
  const body = scope.fn.body;
  const keys = new Set<string>();
  let wholesale = false;
  let escapes = false;
  const merge = (m: Mutation): void => {
    m.keys.forEach((k) => keys.add(k));
    wholesale ||= m.wholesale;
  };
  for (const a of analysis.assignments) {
    const name = names.find((n) => a.lvalue.startsWith(`${n}.`));
    if (name !== undefined) keys.add(a.lvalue.slice(name.length + 1).split('.')[0] ?? '');
    else if (!self && /^(?:variables|this)\./.test(a.lvalue) && names.includes(exprKey(a.rhs))) escapes = true;
  }
  if (self) {
    const own = instanceWrites(body, analysis);
    own.keys.forEach((k) => keys.add(k));
    wholesale ||= own.wholesale;
  }
  const calls = analysis.calls.flatMap((c) => {
    const seg = c.chain.segs[c.k];
    const receiver = c.chain.kind === 'new' && c.k === 0 ? null : c.k === 0 ? '' : exprKey(chainText(c.chain, c.k, body));
    return seg?.args === undefined ? [] : [{ c, seg, args: seg.args, receiver }];
  });
  /** A setter or bulk call on the value itself, or on a receiver that keeps it. */
  const onValue = (seg: ChainSegment, args: readonly CallArgument[]): boolean => {
    const lower = seg.name.toLowerCase();
    if (REWRITES.test(lower) || (lower === 'set' && args.length === 1)) {
      wholesale = true;
      return true;
    }
    const key = setterKey(seg.name, args);
    if (key === null) wholesale = true;
    else if (key !== undefined) keys.add(key);
    return key !== undefined;
  };
  const views = new Set<string>();
  for (const { c, seg, args, receiver } of calls) {
    const own = receiver !== null && (names.includes(receiver) || (self && receiver === ''));
    if (own) {
      if (onValue(seg, args)) continue;
      // A defined getter may still write the instance, as `getAllValues()` merges stored extend sets.
      const callee = calleeOf(resolver, scope, c.chain, c.k);
      if (callee !== null) merge(formalMutation(resolver, callee, 'this'));
      continue;
    }
    if (!args.some((a) => names.includes(exprKey(a.expr)))) continue;
    const callee = calleeOf(resolver, scope, c.chain, c.k);
    const passed = callee === null ? undefined : passedFormal(args, callee.fn, names);
    if (callee === null || passed === undefined) continue;
    const m = formalMutation(resolver, callee, passed);
    merge(m);
    if (m.escapes && receiver !== null && receiver !== '' && receiver !== 'this') views.add(receiver);
  }
  for (const { c, seg, args, receiver } of calls) {
    if (receiver === null || !views.has(receiver)) continue;
    const key = setterKey(seg.name, args);
    if (key === null) wholesale = true;
    else if (key !== undefined) keys.add(key);
    else if (!REWRITES.test(seg.name.toLowerCase())) {
      const callee = calleeOf(resolver, scope, c.chain, c.k);
      if (callee !== null) merge(formalMutation(resolver, callee, 'this'));
    }
  }
  // A kept value takes the keys the component sets on itself.
  if (escapes) merge(formalMutation(resolver, scope, 'this'));
  for (const n of names) {
    const at = n.replace(/[.$]/g, (ch) => `\\${ch}`);
    if (new RegExp(String.raw`\bstruct(?:append|clear)\s*\(\s*${at}\s*[,)]`, 'i').test(body)) wholesale = true;
    for (const m of body.matchAll(new RegExp(String.raw`\bstruct(?:insert|update|delete)\s*\(\s*${at}\s*,\s*([^,)]*)`, 'gi'))) {
      const key = literalString(m[1]?.trim());
      if (key === undefined) wholesale = true;
      else keys.add(key.toLowerCase());
    }
  }
  keys.delete('');
  return { keys: [...keys].sort(compareText), wholesale, escapes };
}

/**
 * Request-populated beans as the body of `scope.fn` sees them: the inherited ones and the locals it populates
 * (`l = x.set(<request values>)`, `l.set(<request values>)`), each with the keys the body sets on it. A local applies
 * from its population on; a bean stops applying past a reload, a wholesale rewrite or a reassignment to anything but
 * its own values view (`data = data.getAllValues()`, or `x.getAllValues()` of a bean `x.set(data)` copied it into).
 */
function beanAliases(resolver: Resolver, scope: Scope, inherited: readonly Alias[]): Alias[] {
  const analysis = analyse(scope.fn, scope.unit.syntax);
  const body = scope.fn.body;
  const out = inherited.filter((a) => a.kind !== 'bean');
  const calls = analysis.calls.flatMap((c) => {
    const seg = c.chain.segs[c.k];
    return seg?.args === undefined ? [] : [{ c, seg, receiver: c.k === 0 ? '' : exprKey(chainText(c.chain, c.k, body)) }];
  });

  const formals = new Set(scope.fn.args.map((a) => a.name.toLowerCase()));
  /** The names a local is read under: `arguments.x.y` and `x.y` for a path through a formal, else `x` and `local.x`. */
  const formsOf = (name: string): [string, string] => {
    if (name.startsWith('arguments.')) return [name, name.slice('arguments.'.length)];
    return formals.has(name.split('.')[0] ?? '') ? [`arguments.${name}`, name] : [name, `local.${name}`];
  };

  /**
   * The bean an expression populates from the request (`x.set(<request values>)`, optionally followed by keyed
   * setters), with the keys it then holds beyond its component's; null when it is no such population.
   */
  const population = (text: string): { component: string | null; extra: string[]; source?: Alias } | null => {
    const rhs = text.trim();
    const chain = parseChainAt(rhs, 0, /^new\s/i.test(rhs) ? 'new' : 'name');
    const at = chain.segs.findIndex((s) => s.name.toLowerCase() === 'set' && s.args?.length === 1 && s.args[0]?.name === undefined);
    if (at < 0) return null;
    const expr = chain.segs[at]?.args?.[0]?.expr ?? '';
    const extra = requestSource(resolver, expr, inherited);
    if (extra === null) return null;
    for (const s of chain.segs.slice(at + 1)) {
      const key = s.args === undefined ? null : setterKey(s.name, s.args);
      if (typeof key !== 'string') return null;
      extra.push(key);
    }
    const r = resolver.expr(rhs, scope, new Set());
    const source = sourceBean(expr, inherited);
    return { component: r.kind === 'resolved' ? r.path : null, extra, ...(source === undefined ? {} : { source }) };
  };

  /**
   * The transient bean an expression creates, `getBean('x')`, `new X()` or `createObject(…)`, optionally
   * initialised, loaded and given keyed setters: its component, whether it is fresh, and the keys the chain sets.
   */
  const creation = (text: string, at: number): { component: string; fresh: boolean; defs: KeyDef[] } | null => {
    const rhs = text.trim();
    const kind = /^new\s/i.test(rhs) ? 'new' : 'name';
    const chain = parseChainAt(rhs, 0, kind);
    const last = chain.segs[chain.segs.length - 1];
    if (last === undefined || last.e !== rhs.length) return null;
    const factoryAt = kind === 'new' ? 0 : chain.segs.findLastIndex((s) => s.args !== undefined && /^get(bean|entity)$/i.test(s.name));
    const object = kind === 'name' && factoryAt < 0 && chain.segs[0]?.name.toLowerCase() === 'createobject' && chain.segs[0].args !== undefined;
    const start = object ? 0 : factoryAt;
    if (start < 0) return null;
    let fresh = !object;
    const defs: KeyDef[] = [];
    // A factory of the caller's own may set keys on the instance it hands out.
    const factory = kind === 'name' && factoryAt >= 0 ? calleeOf(resolver, scope, chain, factoryAt) : null;
    const preset = factory === null ? [] : factoryKeys(factory);
    if (preset === null) fresh = false;
    else preset.forEach((key) => defs.push({ key, at, expr: null, stmt: true }));
    for (const s of chain.segs.slice(start + 1)) {
      const lower = s.name.toLowerCase();
      if (s.args === undefined) return null;
      if (lower === 'init' || lower === 'load' || lower === 'loadby') {
        // Both replace the values any earlier setter of the chain gave.
        fresh = lower === 'init';
        defs.length = 0;
        continue;
      }
      const key = setterKey(s.name, s.args);
      if (typeof key !== 'string') return null;
      defs.push({ key, at, expr: setterValue(s.name, s.args), stmt: true });
    }
    const r = resolver.expr(rhs, scope, new Set());
    if (r.kind !== 'resolved') return null;
    // DI1 hands out a new instance only for a transient; any other bean is shared state.
    if (factoryAt >= 0 && kind === 'name' && resolver.ctx.index.transient?.(r.path) !== true) return null;
    return { component: r.path, fresh, defs };
  };

  /**
   * Keys the body sets on the bean named by `names`, the first offset past `from` where it stops applying, and the
   * key writes that track its values; a `tracked` bean also stops at a population from the request.
   */
  const fate = (
    names: readonly string[],
    from: number,
    component: string | undefined,
    tracked = false,
  ): { keys: string[]; until?: number; defs: KeyDef[] } => {
    const keys = new Set<string>();
    const defs: KeyDef[] = [];
    let until = Number.POSITIVE_INFINITY;
    const cut = (at: number): void => {
      if (at > from) until = Math.min(until, at);
    };
    const apply = (m: Mutation, at: number, def: number): void => {
      m.keys.forEach((k) => {
        keys.add(k);
        defs.push({ key: k, at: def, expr: null, stmt: false });
      });
      if (m.wholesale) cut(at);
    };
    const stmtAt = (c: RawCall): boolean => atStatement(body, c.chain.segs[0]?.s ?? c.offset);
    /** A getter the bean does not define, which its generic accessor answers without writing. */
    const implicitRead = (name: string): boolean =>
      /^(get|has|is)[\w$]*$/i.test(name) && component !== undefined && !beanFacts(resolver, component).defined.has(name.toLowerCase());
    /** The method a member call on the bean runs: as the resolver finds it, else on the bean's own component. */
    const methodOf = (c: RawCall, name: string): Scope | null => {
      const found = calleeOf(resolver, scope, c.chain, c.k);
      if (found !== null || component === undefined) return found;
      const own = resolver.findFunction(component, name);
      return own === null ? null : { receiver: component, unit: own.unit, fn: own.fn };
    };
    const copies = new Set(
      calls
        .filter(({ seg, receiver }) => {
          const arg = exprKey(seg.args?.[0]?.expr ?? '');
          return receiver !== '' && seg.name.toLowerCase() === 'set' && seg.args?.length === 1 && names.some((n) => arg === n || arg === `${n}.getallvalues()`);
        })
        .map(({ receiver }) => receiver),
    );
    const views = new Set<string>();
    for (const { c, seg, receiver } of calls) {
      if (c.chain.kind === 'new' && c.k === 0) continue;
      const own =
        names.some((n) => receiver === n || (receiver.startsWith(`${n}.`) && /^set[\w$]*\(/.test(receiver.slice(n.length + 1)))) ||
        (names.includes('this') && (c.k === 0 || receiver === 'this'));
      if (!own) {
        if (!(seg.args ?? []).some((a) => names.includes(exprKey(a.expr)))) continue;
        const callee = calleeOf(resolver, scope, c.chain, c.k);
        const passed = callee === null ? undefined : passedFormal(seg.args ?? [], callee.fn, names);
        if (callee === null || passed === undefined) continue;
        const m = formalMutation(resolver, callee, passed);
        apply(m, seg.e, seg.s);
        if (m.escapes && receiver !== '' && receiver !== 'this') {
          views.add(receiver);
          defs.push({ key: '*', at: seg.s, expr: null, stmt: false });
        }
        continue;
      }
      const lower = seg.name.toLowerCase();
      if (REWRITES.test(lower)) {
        cut(seg.e);
        continue;
      }
      if (lower === 'set' && seg.args?.length === 1) {
        const extra = requestSource(resolver, seg.args[0]?.expr ?? '', inherited);
        if (extra === null) cut(seg.e);
        else if (tracked) cut(seg.s);
        else {
          extra.forEach((k) => keys.add(k));
          // A later population from the request replaces the values the bean holds.
          if (seg.s !== from) defs.push({ key: '*', at: seg.s, expr: null, stmt: false });
        }
        continue;
      }
      const key = setterKey(seg.name, seg.args ?? []);
      if (key === null) cut(seg.e);
      else if (key !== undefined) {
        keys.add(key);
        defs.push({ key, at: seg.s, expr: setterValue(seg.name, seg.args ?? []), stmt: stmtAt(c) });
      } else if (!implicitRead(seg.name)) {
        const callee = methodOf(c, seg.name);
        if (callee !== null) apply(formalMutation(resolver, callee, 'this'), seg.e, seg.s);
      }
    }
    for (const { c, seg, receiver } of calls) {
      if (!views.has(receiver)) continue;
      const key = setterKey(seg.name, seg.args ?? []);
      if (key === null) cut(seg.e);
      else if (key !== undefined) {
        keys.add(key);
        defs.push({ key, at: seg.s, expr: null, stmt: false });
      } else if (!REWRITES.test(seg.name.toLowerCase())) {
        const callee = calleeOf(resolver, scope, c.chain, c.k);
        if (callee !== null) apply(formalMutation(resolver, callee, 'this'), seg.e, seg.s);
      }
    }
    for (const a of analysis.assignments) {
      // A copy of the reference lets later writes through it bypass the tracked values.
      if (names.includes(exprKey(a.rhs))) defs.push({ key: '*', at: a.offset, expr: null, stmt: false });
      const name = names.find((n) => a.lvalue === n || a.lvalue.startsWith(`${n}.`));
      if (name === undefined || (a.offset === from && a.lvalue === name)) continue;
      if (a.lvalue !== name) {
        const path = a.lvalue.slice(name.length + 1).split('.');
        const key = path[0] ?? '';
        keys.add(key);
        defs.push({ key, at: a.offset, expr: path.length === 1 ? a.rhs : null, stmt: true });
        continue;
      }
      const view = /^(.+)\.getallvalues\(\)$/.exec(exprKey(a.rhs))?.[1];
      if (view !== undefined && (names.includes(view) || copies.has(view))) continue;
      const again = population(a.rhs);
      if (again !== null && again.component !== null && again.component === component) {
        again.extra.forEach((k) => keys.add(k));
        defs.push({ key: '*', at: a.offset, expr: null, stmt: false });
        continue;
      }
      const at = body.indexOf(a.rhs, a.offset);
      cut(at < 0 ? a.offset : at + a.rhs.length);
    }
    for (const n of names) {
      const at = n.replace(/[.$]/g, (ch) => `\\${ch}`);
      for (const m of body.matchAll(new RegExp(String.raw`\bstruct(?:append|clear)\s*\(\s*(?:local\.)?${at}\s*[,)]`, 'gi'))) cut(m.index);
      for (const m of body.matchAll(new RegExp(String.raw`\bstruct(?:insert|update|delete)\s*\(\s*(?:local\.)?${at}\s*,\s*([^,)]*)`, 'gi'))) {
        const key = literalString(m[1]?.trim());
        if (key === undefined) cut(m.index);
        else {
          keys.add(key.toLowerCase());
          defs.push({ key: key.toLowerCase(), at: m.index, expr: null, stmt: false });
        }
      }
    }
    keys.delete('');
    const kept = defs.filter((d) => d.key !== '');
    return until === Number.POSITIVE_INFINITY ? { keys: [...keys], defs: kept } : { keys: [...keys], until, defs: kept };
  };
  const bounded = (a: Alias, since: number | undefined, until: number | undefined): Alias => ({
    ...a,
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  });

  /** The alias list entry for one name, carrying the tracking state and the body's key writes. */
  const tracking = (a: Alias, defs: readonly KeyDef[], copyFrom: Alias['copyFrom']): Alias => {
    const out0: Alias = { ...a };
    if (defs.length > 0) out0.defs = defs;
    if (copyFrom !== undefined) out0.copyFrom = copyFrom;
    return out0;
  };

  const groups = new Map<string, Alias[]>();
  for (const a of inherited) {
    if (a.kind !== 'bean') continue;
    const key = `${a.component ?? ''}|${(a.extra ?? []).join('+')}|${a.name.replace(/^arguments\./, '')}|${aliasKey([{ ...a, name: '' }])}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  for (const members of groups.values()) {
    const component = members[0]?.component;
    const { keys, until, defs } = fate(
      members.map((m) => m.name),
      -1,
      component,
    );
    for (const m of members) {
      const list: Alias[] = [];
      addAlias(list, m.name, 'bean', { component, extra: extraKeys(resolver, component, [...(m.extra ?? []), ...keys]), opaque: m.opaque, values: m.values, fresh: m.fresh });
      for (const a of list) out.push(tracking(bounded(a, undefined, until), defs, undefined));
    }
  }

  interface Local {
    component: string;
    extra: string[];
    from: number;
    source?: Alias;
    /** A created bean: whether it is a never-loaded instance, and the keys its creating chain sets. */
    made?: { fresh: boolean; defs: KeyDef[] };
  }
  /** Populated (`locals`) and created (`created`) beans by the first name they are written under. */
  const locals = new Map<string, Local>();
  const created = new Map<string, Local>();
  const note = (into: Map<string, Local>, written: string, local: Local | null): void => {
    if (local === null || !/^[\w$]+(?:\.[\w$]+)*$/.test(written) || written === 'this') return;
    const forms = formsOf(written);
    if (inherited.some((a) => forms.includes(a.name))) return;
    const prev = into.get(forms[0]);
    if (prev === undefined || local.from < prev.from) into.set(forms[0], { ...local, extra: [...new Set([...(prev?.extra ?? []), ...local.extra])] });
  };
  /** A population's local: an unresolved receiver takes the class of the bean it copies, as a manager fills its own entity. */
  const populated = (component: string | null, extra: string[], from: number, source: Alias | undefined): Local | null => {
    const c = component ?? source?.component ?? null;
    return c === null ? null : { component: c, extra, from, ...(source === undefined ? {} : { source }) };
  };
  for (const a of analysis.assignments) {
    const pop = population(a.rhs);
    if (pop !== null) {
      note(locals, a.lvalue, populated(pop.component, pop.extra, a.offset, pop.source));
      continue;
    }
    const made = creation(a.rhs, a.offset);
    if (made !== null) note(created, a.lvalue, { component: made.component, extra: [], from: a.offset, made: { fresh: made.fresh, defs: made.defs } });
  }
  for (const { c, seg, receiver } of calls) {
    if (seg.name.toLowerCase() !== 'set' || seg.args?.length !== 1 || seg.args[0]?.name !== undefined || receiver === '') continue;
    const expr = seg.args[0]?.expr ?? '';
    const extra = requestSource(resolver, expr, inherited);
    if (extra === null) continue;
    const r = resolver.value(c.chain, c.k, scope, new Set());
    note(locals, receiver, populated(r.kind === 'resolved' ? r.path : null, extra, seg.s, sourceBean(expr, inherited)));
  }
  for (const [name, l] of locals) {
    const forms = formsOf(name);
    const { keys, until, defs } = fate(forms, l.from, l.component);
    const list: Alias[] = [];
    for (const n of forms) {
      // A copy of a fresh instance lands on a bean of unknown keys.
      const opaque = l.source?.opaque === true || l.source?.fresh !== undefined ? true : undefined;
      addAlias(list, n, 'bean', { component: l.component, extra: extraKeys(resolver, l.component, [...l.extra, ...keys]), opaque });
    }
    const copyFrom = l.source === undefined ? undefined : { name: l.source.name, at: l.from };
    for (const a of list) out.push(tracking(bounded(a, l.from, until), defs, copyFrom));
  }
  for (const [name, l] of created) {
    const forms = formsOf(name);
    const { keys, until, defs } = fate(forms, l.from, l.component, true);
    const made = l.made?.defs ?? [];
    for (const n of forms) {
      // A fresh instance holds its component's keys and those written since; a loaded one may hold any.
      const a: Alias =
        l.made?.fresh === true
          ? { name: n, kind: 'bean', component: l.component, extra: extraKeys(resolver, l.component, [...keys, ...made.map((d) => d.key)]), fresh: l.component }
          : { name: n, kind: 'bean', component: l.component, extra: [], opaque: true };
      out.push(tracking(bounded(a, l.from, until), [...made, ...defs], undefined));
    }
  }
  return out;
}

/** Whether region `r` holds body offset `at`. */
function holdsOffset(r: Region, at: number): boolean {
  return r.start <= at && at < r.end;
}

/** The truth a guard leaf is known to have where it is read, if any. */
type FixedAtom = (atom: GuardCondition) => boolean | undefined;

/**
 * Whether the GuardCondition formula can hold for some truth assignment of its leaf conditions, taken as independent
 * atoms except those `fixed` settles.
 */
function satisfiable(c: GuardCondition, fixed?: FixedAtom): boolean {
  const atoms: GuardCondition[] = [];
  const truth = new Map<GuardCondition, boolean>();
  collectAtoms(c, atoms, truth, fixed);
  if (atoms.length > 14) return true;
  for (let mask = 0; mask < 1 << atoms.length; mask++) {
    for (let i = 0; i < atoms.length; i++) truth.set(atoms[i] as GuardCondition, (mask & (1 << i)) !== 0);
    if (holdsUnder(c, truth)) return true;
  }
  return false;
}

/** The free leaves of `x` into `atoms`, and the truth of those `fixed` settles into `truth`. */
function collectAtoms(x: GuardCondition, atoms: GuardCondition[], truth: Map<GuardCondition, boolean>, fixed: FixedAtom | undefined): void {
  if (x.k === 'expr' || x.k === 'case') {
    if (atoms.includes(x) || truth.has(x)) return;
    const known = fixed?.(x);
    if (known === undefined) atoms.push(x);
    else truth.set(x, known);
  } else if (x.k === 'not') collectAtoms(x.of, atoms, truth, fixed);
  else for (const y of x.of) collectAtoms(y, atoms, truth, fixed);
}

/** Truth of `x` under a truth assignment of its leaves. */
function holdsUnder(x: GuardCondition, truth: ReadonlyMap<GuardCondition, boolean>): boolean {
  if (x.k === 'expr' || x.k === 'case') return truth.get(x) === true;
  if (x.k === 'not') return !holdsUnder(x.of, truth);
  if (x.k === 'and') {
    for (const y of x.of) if (!holdsUnder(y, truth)) return false;
    return true;
  }
  for (const y of x.of) if (holdsUnder(y, truth)) return true;
  return false;
}

const holdingCache = new WeakMap<Analysis, Map<number, readonly Region[]>>();

/** The regions of `analysis` that hold body offset `x`. */
function regionsHolding(analysis: Analysis, x: number): readonly Region[] {
  let byOffset = holdingCache.get(analysis);
  if (byOffset === undefined) {
    byOffset = new Map();
    holdingCache.set(analysis, byOffset);
  }
  let hit = byOffset.get(x);
  if (hit === undefined) {
    hit = analysis.regions.filter((r) => holdsOffset(r, x));
    byOffset.set(x, hit);
  }
  return hit;
}

/**
 * The guards around body offset `x` that neither `at` nor `from` lies in, or null when a loop, try block or thread
 * around `x` but not `at` may skip it (`exit` judges a throw, which a try block catches, and a loop's own exits).
 */
function outerGuards(analysis: Analysis, x: number, at: number, from: number, exit?: Exit['kind']): GuardCondition[] | null {
  const conds: GuardCondition[] = [];
  for (const r of regionsHolding(analysis, x)) {
    if (holdsOffset(r, at)) continue;
    if (r.thread !== undefined) return null;
    if (exit === undefined ? r.block !== undefined : r.block === 'loop' || (exit === 'throw' && r.block === 'try')) return null;
    if (r.cond !== undefined && !(from >= 0 && holdsOffset(r, from))) conds.push(r.cond);
  }
  return conds;
}

/**
 * Whether every path that reaches `at` (from body offset `from`, else from the start) runs one of `defs` there:
 * the formula "no def ran and no earlier exit was taken" over the guards that enclose each def or exit but neither
 * `at` nor `from` cannot hold. A def counts only as a statement of its own outside loops, try blocks and threads
 * that do not enclose `at`; exits in loops or threads do not count, nor a throw inside a try block.
 */
function coversPath(analysis: Analysis, defs: readonly KeyDef[], at: number, fixed?: FixedAtom, from = -1): boolean {
  const negated: GuardCondition[] = [];
  let killers = 0;
  for (const d of defs) {
    if (!d.stmt || d.at >= at || d.at <= from) continue;
    const conds = outerGuards(analysis, d.at, at, from);
    if (conds === null) continue;
    if (conds.length === 0) return true;
    killers++;
    negated.push({ k: 'not', of: { k: 'and', of: conds } });
  }
  if (killers === 0) return false;
  for (const e of analysis.exits) {
    if (e.at >= at || e.at <= from) continue;
    if (regionsHolding(analysis, e.at).some((r) => r.thread !== undefined)) continue;
    const conds = outerGuards(analysis, e.at, at, from, e.kind);
    if (conds === null) continue;
    if (conds.length === 0) return true;
    negated.push({ k: 'not', of: { k: 'and', of: conds } });
  }
  return !satisfiable({ k: 'and', of: negated }, fixed);
}

/** The writes of `writes` whose value may still stand at `at`: those no later write of them overwrites on every path. */
function standing(analysis: Analysis, writes: readonly KeyDef[], at: number, fixed?: FixedAtom): readonly KeyDef[] {
  if (writes.length < 2) return writes;
  return writes.filter((d) => d.at > at || !coversPath(analysis, writes, at, fixed, d.at));
}

/** What resolving tracked bean values at an offset needs: the body's analysis and the guard environment. */
interface ValueContext {
  analysis: Analysis;
  formals: ReadonlyMap<string, Val>;
  facts: (component: string) => BeanFacts;
  dead?: (x: number, site: number) => boolean;
  fixed?: FixedAtom;
}

/** One expression for several alternatives, flattened and de-duplicated. */
function oneOf(options: readonly Ex[]): Ex {
  const seen = new Map<string, Ex>();
  for (const o of options.flatMap(alternatives)) seen.set(JSON.stringify(o), o);
  const unique = [...seen.values()];
  return unique.length === 1 && unique[0] !== undefined ? unique[0] : { t: 'one', of: unique };
}

/** A bean alias without its in-body tracking state. */
function untracked(a: Alias): Alias {
  const { defs: _defs, copyFrom: _copyFrom, values: _values, fresh: _fresh, ...rest } = a;
  return rest;
}

/**
 * The aliases that apply at body offset `at`, each tracked bean with the values its key writes leave there: per
 * key, the value of every write that may reach `at`, and the prior value (inherited, fresh or copied) unless every
 * path to `at` writes the key. A key any reaching value of which is unknown is unknown.
 */
function trackedAt(all: readonly Alias[], at: number, vc: ValueContext): readonly Alias[] {
  const live = aliasesAt(all, at);
  if (!live.some((a) => a.defs !== undefined || a.copyFrom !== undefined)) return live;
  return live.map((a) => (a.defs === undefined && a.copyFrom === undefined ? a : valuedAt(a, all, at, vc, 0)));
}

/** Whether body offset `x` lies in a loop that also holds `at`, so a write there may run again before `at`. */
function sharesLoop(analysis: Analysis, x: number, at: number): boolean {
  return analysis.regions.some((r) => r.block === 'loop' && holdsOffset(r, x) && holdsOffset(r, at));
}

/** The writes of `defs` that may run before `at`: earlier ones, or later ones in a loop around both, unless dead. */
function reachingDefs(defs: readonly KeyDef[], since: number, at: number, vc: ValueContext): KeyDef[] {
  return defs.filter((d) => d.at >= since && (d.at < at || sharesLoop(vc.analysis, d.at, at)) && vc.dead?.(d.at, at) !== true);
}

/** The value a key write stores, as far as it is tracked: a literal or a request parameter, else unknown. */
function storedValue(d: KeyDef, all: readonly Alias[], vc: ValueContext): Ex {
  if (d.expr === null) return UNK;
  const v = parseGuard(d.expr, { aliases: aliasesAt(all, d.at).map(untracked), formals: vc.formals, facts: vc.facts });
  return v.t === 'lit' || v.t === 'ref' ? v : UNK;
}

const valuedCache = new WeakMap<Alias, Map<number, Alias>>();

/** Tracked bean `a` of `all` as it stands at `at`; a copy reads its source where it was made, up to a few copies deep. */
function valuedAt(a: Alias, all: readonly Alias[], at: number, vc: ValueContext, depth: number): Alias {
  let byOffset = valuedCache.get(a);
  if (byOffset === undefined) {
    byOffset = new Map();
    valuedCache.set(a, byOffset);
  }
  let hit = byOffset.get(at);
  if (hit === undefined) {
    hit = valueAt(a, all, at, vc, depth);
    byOffset.set(at, hit);
  }
  return hit;
}

function valueAt(a: Alias, all: readonly Alias[], at: number, vc: ValueContext, depth: number): Alias {
  const { defs: _defs, copyFrom, values: inherited, fresh, ...rest } = a;
  let prior: Readonly<Record<string, Ex>> = inherited ?? {};
  let base = fresh;
  if (copyFrom !== undefined) {
    const source = depth < 4 ? aliasesAt(all, copyFrom.at).find((s) => s.kind === 'bean' && s.name === copyFrom.name) : undefined;
    const copied = source === undefined ? undefined : valuedAt(source, all, copyFrom.at, vc, depth + 1);
    prior = copied?.values ?? {};
    base = copied?.fresh;
  }
  const reaching = reachingDefs(a.defs ?? [], a.since ?? -1, at, vc);
  // A write of every key leaves nothing known; a fresh instance may then hold any key.
  if (reaching.some((d) => d.key === '*')) return base === undefined ? rest : { ...rest, opaque: true };
  const initial = base === undefined ? {} : vc.facts(base).initial;
  const values: Record<string, Ex> = {};
  for (const key of new Set([...Object.keys(prior), ...reaching.map((d) => d.key)])) {
    const writes = reaching.filter((d) => d.key === key);
    const given = prior[key];
    if (writes.length === 0) {
      if (given !== undefined) values[key] = given;
      continue;
    }
    const options = standing(vc.analysis, writes, at, vc.fixed).map((d) => storedValue(d, all, vc));
    if (!coversPath(vc.analysis, writes, at, vc.fixed)) options.push(given ?? initial[key] ?? UNK);
    // An unknown value is kept as such, so that no init literal stands in for it.
    values[key] = options.some((o) => alternatives(o).some((x) => x.t === 'unk')) ? UNK : oneOf(options);
  }
  const out: Alias = { ...rest };
  if (Object.keys(values).length > 0) out.values = values;
  if (base !== undefined) out.fresh = base;
  return out;
}

/** The aliases that apply at body offset `at`. */
function aliasesAt(aliases: readonly Alias[], at: number): readonly Alias[] {
  return aliases.some((a) => a.since !== undefined || a.until !== undefined)
    ? aliases.filter((a) => (a.since === undefined || at >= a.since) && (a.until === undefined || at < a.until))
    : aliases;
}

/** Builtins that read their arguments without changing them or keeping a reference to them. */
const PURE_FUNCTIONS = new Set([
  'arraycontains', 'arrayfind', 'arrayfindnocase', 'arrayisempty', 'arraylen', 'arraytolist', 'compare', 'comparenocase',
  'dateformat', 'deserializejson', 'encodeforhtml', 'encodeforurl', 'find', 'findnocase', 'hash', 'htmleditformat', 'int',
  'isarray', 'isboolean', 'isdate', 'isjson', 'isnull', 'isnumeric', 'isobject', 'isquery', 'issimplevalue', 'isstruct',
  'isvalid', 'lcase', 'left', 'len', 'listcontains', 'listcontainsnocase', 'listfind', 'listfindnocase', 'listfirst',
  'listgetat', 'listlast', 'listlen', 'mid', 'numberformat', 'replace', 'replacenocase', 'right', 'serializejson',
  'structcount', 'structisempty', 'structkeyarray', 'structkeyexists', 'structkeylist', 'timeformat', 'tostring', 'trim',
  'ucase', 'urlencodedformat', 'val', 'yesnoformat',
]);

/** Name of the call whose argument list directly holds body offset `at`; null when no call's parentheses hold it. */
function enclosingCall(body: string, literal: Uint8Array, at: number): string | null {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (literal[i] === 1) continue;
    const c = body.charAt(i);
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (c !== '(') return null;
      let e = i - 1;
      while (e >= 0 && isSpace(body.charAt(e))) e--;
      let s = e;
      while (s >= 0 && isIdentPart(body.charAt(s))) s--;
      return e > s && body.charAt(s) !== '.' ? body.slice(s + 1, e + 1).toLowerCase() : null;
    } else if (depth === 0 && (c === ';' || c === '=' || c === '>' || c === '<' || c === '#')) {
      return null;
    }
  }
  return null;
}

/**
 * Whether every use of local `name` in `body` leaves its value to the plain assignments `defs`: no compound or
 * keyed write, no member call, no use that names it in a string (`<cfquery name="x">`, `cfparam`), no loop or
 * catch variable, and, unless every value it is given is a scalar literal, no read but as a direct argument of a
 * builtin that keeps no reference.
 */
function localSafe(body: string, literal: Uint8Array, name: string, defs: readonly KeyDef[]): boolean {
  const n = name.replace(/\$/g, '\\$');
  const ref = String.raw`(?<![\w$.])(?:local\s*\.\s*)?${n}(?![\w$])`;
  if (new RegExp(String.raw`(["'])(?:local\.)?${n}\1`, 'i').test(body)) return false;
  if (new RegExp(String.raw`\bfor\s*\(\s*(?:var\s+)?${ref}\s+in\b|\bcatch\s*\(\s*[\w$.]+\s+${ref}\s*\)|\bparam\s+(?:name\s*=\s*)?${ref}`, 'i').test(body)) return false;
  const scalar = defs.every((d) => literalVal(d.expr ?? undefined) !== undefined);
  const assigned = new Set(defs.map((d) => d.at));
  for (const m of body.matchAll(new RegExp(ref, 'gi'))) {
    const at = m.index;
    if (literal[at] === 1) continue;
    let b = at - 1;
    while (b >= 0 && isSpace(body.charAt(b))) b--;
    if (/^(\+\+|--)$/.test(body.slice(Math.max(0, b - 1), b + 1))) return false;
    let i = afterSpace(body, at + m[0].length);
    let path = false;
    for (;;) {
      if (body.charAt(i) === '[') {
        const close = matchBracket(body, i);
        if (close < 0) return false;
        i = afterSpace(body, close + 1);
      } else if (body.charAt(i) === '.' && isIdentStart(body.charAt(afterSpace(body, i + 1)))) {
        i = afterSpace(body, i + 1);
        while (isIdentPart(body.charAt(i))) i++;
        i = afterSpace(body, i);
        if (body.charAt(i) === '(') return false;
      } else {
        break;
      }
      path = true;
    }
    const next = body.slice(i, i + 2);
    if (/^(\+\+|--|[-+*/&%^]=)/.test(next)) return false;
    if (next.charAt(0) === '=' && next.charAt(1) !== '=') {
      if (path || !assigned.has(at)) return false;
      continue;
    }
    if (path || scalar) continue;
    // A `<cfloop array|collection|list="#x#">` only iterates it.
    if (body.charAt(i) === '#' && /\b(?:array|collection|list)\s*=\s*["']#$/i.test(body.slice(Math.max(0, at - 16), at))) continue;
    const callee = enclosingCall(body, literal, at);
    if (callee === null || !PURE_FUNCTIONS.has(callee)) return false;
  }
  return true;
}

const localsCache = new WeakMap<CfmlFunction, ReadonlyMap<string, readonly KeyDef[]>>();

/**
 * Locals of `fn` whose values the walk tracks, with their writes: names declared `var` or written as `local.x`
 * (never formals) that `localSafe` admits, in a body that includes no template and neither evaluates code nor
 * touches the local scope as a whole.
 */
function trackedLocals(fn: CfmlFunction, syntax: CfmlUnit['syntax']): ReadonlyMap<string, readonly KeyDef[]> {
  const cached = localsCache.get(fn);
  if (cached !== undefined) return cached;
  const out = new Map<string, KeyDef[]>();
  localsCache.set(fn, out);
  const analysis = analyse(fn, syntax);
  const body = fn.body;
  const code = (re: RegExp): RegExpExecArray[] => [...body.matchAll(re)].filter((m) => analysis.literal[m.index] !== 1);
  if (fn.includes.length > 0 || code(/(?<![\w$.])(?:evaluate|setvariable)\s*\(|(?<![\w$.])local\b(?!\s*\.\s*[A-Za-z_$])/gi).length > 0) return out;
  const formals = new Set(fn.args.map((a) => a.name.toLowerCase()));
  const names = new Set<string>();
  for (const m of code(/(?<![\w$.])var\s+([A-Za-z_$][\w$]*)/gi)) names.add((m[1] ?? '').toLowerCase());
  for (const m of code(/(?<![\w$.])local\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/gi)) names.add((m[1] ?? '').toLowerCase());
  for (const name of names) {
    if (formals.has(name)) continue;
    const defs = analysis.assignments.filter((a) => a.lvalue === name).map((a): KeyDef => ({ key: name, at: a.offset, expr: a.rhs, stmt: true }));
    if (defs.length > 0 && localSafe(body, analysis.literal, name, defs)) out.set(name, defs);
  }
  return out;
}

/** Value of tracked local `defs` at body offset `at`: one per write that may reach it, unknown unless every path writes it. */
function localValue(defs: readonly KeyDef[], all: readonly Alias[], at: number, vc: ValueContext): Ex {
  const reaching = reachingDefs(defs, -1, at, vc);
  const options = standing(vc.analysis, reaching, at, vc.fixed).map((d) => storedValue(d, all, vc));
  if (!coversPath(vc.analysis, reaching, at, vc.fixed)) options.push(UNK);
  return options.some((o) => alternatives(o).some((x) => x.t === 'unk')) ? UNK : oneOf(options);
}


const relevantCache = new WeakMap<CfmlFunction, Set<string>>();

/** Formals whose literal value matters: used as a dynamic write table or passed on to another call. */
function relevantFormals(fn: CfmlFunction, syntax: CfmlUnit['syntax']): Set<string> {
  const cached = relevantCache.get(fn);
  if (cached !== undefined) return cached;
  const formals = new Set(fn.args.map((a) => a.name.toLowerCase()));
  const out = new Set<string>();
  const consider = (expr: string): void => {
    const m = /^(?:arguments\.)?([\w$]+)$/i.exec(stripHashes(expr).replace(/\s+/g, ''));
    const name = m?.[1]?.toLowerCase();
    if (name !== undefined && formals.has(name)) out.add(name);
  };
  const analysis = analyse(fn, syntax);
  for (const w of analysis.writes) if (w.dynamic === true) consider(w.tableExpr);
  for (const c of analysis.calls) for (const a of c.chain.segs[c.k]?.args ?? []) consider(a.expr);
  relevantCache.set(fn, out);
  return out;
}

const trackedCache = new WeakMap<CfmlFunction, Set<string>>();

/** Texts of a guard condition: its expressions and switch subjects. */
function conditionTexts(c: GuardCondition, out: string[] = []): string[] {
  if (c.k === 'expr') out.push(c.text);
  else if (c.k === 'case') out.push(c.subject);
  else if (c.k === 'not') conditionTexts(c.of, out);
  else c.of.forEach((x) => conditionTexts(x, out));
  return out;
}

/** Whether the body of `fn` may give formal `name` a value other than the one the call passed. */
function mayReassign(body: string, name: string): boolean {
  const n = name.replace(/\$/g, '\\$');
  return [
    new RegExp(String.raw`(?<![\w$.])(?:arguments\s*\.\s*|local\s*\.\s*|var\s+)?${n}\s*(?:[-+*/&]?=(?!=)|\+\+|--)`, 'i'),
    new RegExp(String.raw`(?:\+\+|--)\s*(?:arguments\s*\.\s*)?${n}(?![\w$])`, 'i'),
    new RegExp(String.raw`\b(?:name|index|item|key|variable|returnvariable|result)\s*=\s*["'](?:arguments\.|local\.)?${n}["']`, 'i'),
    new RegExp(String.raw`\bparam\s+(?:name\s*=\s*)?["']?(?:arguments\.)?${n}(?![\w$])`, 'i'),
    new RegExp(String.raw`\bfor\s*\(\s*(?:var\s+)?${n}\s+in\b`, 'i'),
  ].some((re) => re.test(body));
}

/**
 * Formals whose literal value the walk tracks: read by a guard or passed on to another call, and never given another
 * value in the body (nor the whole `arguments` scope rewritten).
 */
function trackedFormals(fn: CfmlFunction, syntax: CfmlUnit['syntax']): Set<string> {
  const cached = trackedCache.get(fn);
  if (cached !== undefined) return cached;
  const formals = new Set(fn.args.map((a) => a.name.toLowerCase()));
  const used = new Set<string>();
  const analysis = analyse(fn, syntax);
  for (const r of analysis.regions) {
    for (const text of r.cond === undefined ? [] : conditionTexts(r.cond)) {
      const toks = tokenize(text, 0, text.length);
      toks.forEach((t, i) => {
        const name = t.k === 'id' ? t.v.toLowerCase() : '';
        if (!formals.has(name) || isP(toks[i + 1], '(')) return;
        const bare = !isP(toks[i - 1], '.');
        const scoped = isP(toks[i - 1], '.') && isWord(toks[i - 2], 'arguments') && !isP(toks[i - 3], '.');
        if (bare || scoped) used.add(name);
      });
    }
  }
  for (const c of analysis.calls) {
    for (const a of c.chain.segs[c.k]?.args ?? []) {
      const name = /^(?:arguments\.)?([\w$]+)$/i.exec(a.expr.replace(/\s+/g, ''))?.[1]?.toLowerCase();
      if (name !== undefined && formals.has(name)) used.add(name);
    }
  }
  const body = fn.body.replace(/<cfargument\b[^>]*>/gi, '');
  const rewritesAll = /\barguments\s*\[|\bstruct(?:append|delete|clear|insert|update)\s*\(\s*arguments\b/i.test(body);
  const out = new Set([...used].filter((f) => !rewritesAll && !mayReassign(body, f)));
  trackedCache.set(fn, out);
  return out;
}

/** Known literal values of the tracked formals of `fn` at a node: what the call passed, else the literal default. */
function formalValues(fn: CfmlFunction, syntax: CfmlUnit['syntax'], bound: WalkNode['formals']): Map<string, Val> {
  const out = new Map<string, Val>();
  if (bound === undefined) return out;
  const tracked = trackedFormals(fn, syntax);
  for (const a of fn.args) {
    const f = a.name.toLowerCase();
    if (!tracked.has(f)) continue;
    const v = Object.hasOwn(bound, f) ? bound[f] : literalVal(a.default);
    if (v !== null && v !== undefined) out.set(f, v);
  }
  return out;
}

function formalsKey(entries: Iterable<readonly [string, Val | null]> | undefined): string {
  if (entries === undefined) return '-';
  return [...entries]
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .sort(compareText)
    .join(',');
}

/** Callee request aliases and literal bindings from the actual arguments of a call, read against the caller's aliases there. */
function bindArguments(
  args: readonly CallArgument[],
  callee: CfmlFunction,
  calleeSyntax: CfmlUnit['syntax'],
  node: WalkNode,
  callerAliases: readonly Alias[],
  callerFormals: ReadonlyMap<string, Val>,
): { aliases: Alias[]; literals: Record<string, string>; formals: Record<string, Val | null> } {
  const aliases: Alias[] = [];
  addAlias(aliases, 'request.context', 'struct');
  const literals: Record<string, string> = {};
  const bound: Record<string, Val | null> = {};
  const formals = callee.args;
  const relevant = relevantFormals(callee, calleeSyntax);
  const tracked = trackedFormals(callee, calleeSyntax);
  args.forEach((a, i) => {
    const expr = a.expr.replace(/\s+/g, '').toLowerCase();
    const named = a.name?.toLowerCase();
    if (named === 'argumentcollection') {
      for (const f of tracked) bound[f] = null;
      const alias = callerAliases.find((al) => al.name === expr && al.kind === 'struct');
      if (alias !== undefined) structAlias(aliases, 'arguments');
      if (expr === 'arguments') {
        for (const al of callerAliases) {
          const rest = al.name.startsWith('arguments.') ? al.name.slice('arguments.'.length) : '';
          if (rest !== '' && formals.some((f) => f.name.toLowerCase() === rest.split('.')[0])) {
            addAlias(aliases, al.name, al.kind, al);
            addAlias(aliases, rest, al.kind, al);
          }
        }
      }
      return;
    }
    const formal = named === undefined ? formals[i] : formals.find((f) => f.name.toLowerCase() === named);
    if (formal === undefined) return;
    const fname = formal.name.toLowerCase();
    const alias = callerAliases.find((al) => al.name === expr);
    if (tracked.has(fname)) {
      const passed = /^(?:arguments\.)?([\w$]+)$/.exec(expr)?.[1];
      bound[fname] = alias !== undefined ? null : (literalVal(a.expr) ?? (passed === undefined ? undefined : callerFormals.get(passed)) ?? null);
    }
    if (alias !== undefined) {
      if (alias.kind === 'struct') {
        structAlias(aliases, `arguments.${fname}`);
        structAlias(aliases, fname);
      } else {
        addAlias(aliases, `arguments.${fname}`, alias.kind, alias);
        addAlias(aliases, fname, alias.kind, alias);
      }
      return;
    }
    if (!relevant.has(fname)) return;
    const lit = literalString(a.expr);
    const passed = /^(?:arguments\.)?([\w$]+)$/.exec(expr)?.[1];
    const value = lit ?? (passed === undefined ? undefined : node.literals[passed]);
    // A passed argument replaces the formal's default even when its value is unknown, which binds as ''.
    literals[fname] = value ?? '';
  });
  return { aliases, literals, formals: bound };
}

function nodeKey(n: WalkNode): string {
  const literals = Object.entries(n.literals)
    .map(([k, v]) => `${k}=${v}`)
    .sort(compareText)
    .join(',');
  const formals = formalsKey(n.formals === undefined ? undefined : Object.entries(n.formals));
  const storePaths = (n.storePaths ?? []).join(',');
  return [n.receiver, n.from, n.method.toLowerCase(), aliasKey(n.aliases), literals, formals, n.thread ? 't' : '', n.relogin ? 'r' : '', storePaths].join('|');
}

function compareBy<T>(...keys: Array<(x: T) => string | number>): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const x = key(a);
      const y = key(b);
      if (x !== y) return typeof x === 'number' && typeof y === 'number' ? x - y : compareText(String(x), String(y));
    }
    return 0;
  };
}

/** Collects closure results, merging conditional and unconditional sightings of the same evidence. */
class ClosureAccumulator {
  private readonly writes = new Map<string, ClosureWrite & { condition: string }>();
  private readonly evidence = new Map<string, FileStoreEvidence>();
  private readonly threads = new Map<string, ClosureThread>();
  private readonly unresolved = new Map<string, UnresolvedRef>();
  readonly overrides = new Set<string>();
  readonly visited = new Set<string>();
  private session: SessionEffects = 'none';

  effect(e: SessionEffects): void {
    if (SESSION_RANK[e] > SESSION_RANK[this.session]) this.session = e;
  }

  write(w: ClosureWrite, conditions: readonly string[]): void {
    const key = JSON.stringify([w.table, w.op, w.component, w.method, w.source, w.trigger, w.override ?? '']);
    const prev = this.writes.get(key);
    if (prev !== undefined && !prev.conditional) return;
    if (prev !== undefined && w.conditional) return;
    this.writes.set(key, { ...w, condition: conditions.join(' && ') });
  }

  fileStore(e: FileStoreEvidence): void {
    const key = JSON.stringify([e.component, e.method, e.source]);
    const prev = this.evidence.get(key);
    if (prev === undefined || (prev.conditional && !e.conditional)) this.evidence.set(key, e);
  }

  thread(t: ClosureThread): void {
    this.threads.set(JSON.stringify([t.component, t.method, t.source]), t);
  }

  unresolvedRef(u: UnresolvedRef): void {
    const key = JSON.stringify([u.source, u.expr, u.kind]);
    if (!this.unresolved.has(key)) this.unresolved.set(key, u);
  }

  result(): WriteClosure {
    const writes = [...this.writes.values()];
    const conditionalWrites = writes
      .filter((w): w is ClosureWrite & { condition: string; table: string } => w.conditional && w.table !== null)
      .map((w) => ({ table: w.table, condition: w.condition, source: w.source, via: [...w.via] }))
      .sort(compareBy<ConditionalWrite>((c) => c.table, (c) => c.source.path, (c) => c.source.lines[0], (c) => c.condition));
    const tables = [...new Set(writes.flatMap((w) => (w.table === null ? [] : [w.table])))].sort(compareText);
    const evidence = [...this.evidence.values()].sort(
      compareBy<FileStoreEvidence>((e) => e.component, (e) => e.method, (e) => e.source.path, (e) => e.source.lines[0]),
    );
    return {
      tables,
      writes: writes
        .map(({ condition: _condition, ...w }) => w)
        .sort(
          compareBy<ClosureWrite>(
            (w) => w.table ?? '',
            (w) => w.op,
            (w) => w.component,
            (w) => w.method,
            (w) => w.source.path,
            (w) => w.source.lines[0],
            (w) => w.trigger,
            (w) => w.override ?? '',
          ),
        ),
      conditionalWrites,
      fileStore: evidence.length > 0,
      fileStoreEvidence: evidence,
      sessionEffects: this.session,
      threads: [...this.threads.values()].sort(
        compareBy<ClosureThread>((t) => t.component, (t) => t.method, (t) => t.source.path, (t) => t.source.lines[0]),
      ),
      unresolved: [...this.unresolved.values()].sort(
        compareBy<UnresolvedRef>((u) => u.source.path, (u) => u.source.lines[0], (u) => u.expr, (u) => u.kind),
      ),
      overrides: [...this.overrides].sort(compareText),
      visited: [...this.visited].sort(compareText),
    };
  }
}

function indexOverrides(overrides: WriterOverrides | undefined): Map<string, WriterOverride[]> {
  const byKey = new Map<string, WriterOverride[]>();
  for (const o of overrides?.writers ?? []) {
    const key = `${o.component}#${(o.method ?? '').toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) ?? []), o]);
  }
  return byKey;
}

/** Settled-call records keyed by the path of their source span. */
function indexSettledCalls(overrides: WriterOverrides | undefined): Map<string, SettledCall[]> {
  const byPath = new Map<string, SettledCall[]>();
  for (const s of overrides?.settledCalls ?? []) byPath.set(s.source.path, [...(byPath.get(s.source.path) ?? []), s]);
  return byPath;
}

function sourceRef(p: string, from: number, to: number): SourceRef {
  return { path: p, lines: [from, Math.max(from, to)] };
}


/**
 * Union of the table and file-store writes a branch reaches: breadth-first over `(component, method)` from the
 * entry, pruning guards the predicates decide false and recording undecidable ones as conditional writes.
 * `visitedVia`, when given, receives the first call path of each `visited` key.
 */
export function computeClosure(entry: ClosureEntry, ctx: ClosureContext, visitedVia?: Map<string, readonly string[]>): WriteClosure {
  const resolver = new Resolver(ctx);
  const predicates = lowerKeys(entry.predicates);
  const exclusions = (entry.excludePredicates ?? []).map(lowerKeys);
  const baseTrigger: Trigger = entry.trigger ?? 'request';
  const overrides = indexOverrides(ctx.overrides);
  const settledCalls = indexSettledCalls(ctx.overrides);
  const acc = new ClosureAccumulator();
  /** Reports `u` unless a settled call's span in its file holds its first line; that record's id is applied instead. */
  const unresolvedRef = (u: UnresolvedRef): void => {
    const line = u.source.lines[0];
    const settledBy = settledCalls.get(u.source.path)?.find(({ source: { lines } }) => lines[0] <= line && line <= lines[1]);
    if (settledBy === undefined) acc.unresolvedRef(u);
    else acc.overrides.add(settledBy.id);
  };
  /** The settled call naming `site` in its span that rules out its writes (unreachable, not CFML, non-write); the walk stops there. */
  const prunedCall = (p: string, site: CallSite): SettledCall | undefined =>
    settledCalls
      .get(p)
      ?.find((s) => s.resolution !== 'counted' && s.source.lines[0] <= site.line && site.line <= s.source.lines[1] && s.calls.includes(site.text));
  const decided = new WeakMap<GuardEnv, Map<string, Tri>>();
  const condIds = new WeakMap<GuardCondition, number>();
  let nextCondId = 0;

  const condId = (c: GuardCondition): number => {
    let id = condIds.get(c);
    if (id === undefined) {
      id = nextCondId++;
      condIds.set(c, id);
    }
    return id;
  };
  const scoped = new WeakMap<GuardEnv, Map<number, readonly Alias[]>>();
  const localMemo = new WeakMap<GuardEnv, Map<string, Ex>>();
  /** The aliases of a node that apply at body offset `at`, tracked beans with their values there. */
  const scopedAliases = (nodeEnv: GuardEnv, at: number): readonly Alias[] => {
    const analysis = nodeEnv.analysis;
    if (analysis === undefined) return aliasesAt(nodeEnv.aliases, at);
    let byOffset = scoped.get(nodeEnv);
    if (byOffset === undefined) {
      byOffset = new Map();
      scoped.set(nodeEnv, byOffset);
    }
    let hit = byOffset.get(at);
    if (hit === undefined) {
      hit = trackedAt(nodeEnv.aliases, at, { ...nodeEnv, analysis });
      byOffset.set(at, hit);
    }
    return hit;
  };
  /** A node's guard environment as it stands at body offset `at`: the aliases there, and its tracked locals' values. */
  const envAt = (nodeEnv: GuardEnv, at: number): GuardEnv => {
    const aliases = scopedAliases(nodeEnv, at);
    const defs = nodeEnv.localDefs;
    const analysis = nodeEnv.analysis;
    if (defs === undefined || defs.size === 0 || analysis === undefined) return aliases === nodeEnv.aliases ? nodeEnv : { ...nodeEnv, aliases };
    const vc: ValueContext = { ...nodeEnv, analysis };
    let memo = localMemo.get(nodeEnv);
    if (memo === undefined) {
      memo = new Map();
      localMemo.set(nodeEnv, memo);
    }
    const known = memo;
    const locals = (name: string): Ex | undefined => {
      const d = defs.get(name);
      if (d === undefined) return undefined;
      const key = `${name}@${at}`;
      let v = known.get(key);
      if (v === undefined) {
        v = localValue(d, nodeEnv.aliases, at, vc);
        known.set(key, v);
      }
      return v;
    };
    return { ...nodeEnv, aliases, locals };
  };
  const condExs = new WeakMap<GuardEnv, Map<Region, Ex>>();
  /** A region's guard in a node, read where the region opens. */
  const regionEx = (r: Region & { cond: GuardCondition }, nodeEnv: GuardEnv): Ex => {
    let byRegion = condExs.get(nodeEnv);
    if (byRegion === undefined) {
      byRegion = new Map();
      condExs.set(nodeEnv, byRegion);
    }
    let ex = byRegion.get(r);
    if (ex === undefined) {
      ex = conditionEx(r.cond, envAt(nodeEnv, r.start));
      byRegion.set(r, ex);
    }
    return ex;
  };
  const verdicts = new WeakMap<GuardEnv, Map<Region, Tri>>();
  const pending = new Set<Region>();
  const atomRegions = new WeakMap<Analysis, Map<GuardCondition, Region>>();
  /**
   * Verdict of one region alone in a node, read where it opens: false when its loop entry fails, else its guard's
   * verdict. A region met again while its own verdict is in progress counts as undecided.
   */
  const regionTri = (r: Region, nodeEnv: GuardEnv): Tri => {
    if (r.cond === undefined && r.entry === undefined) return 'T';
    let byRegion = verdicts.get(nodeEnv);
    if (byRegion === undefined) {
      byRegion = new Map();
      verdicts.set(nodeEnv, byRegion);
    }
    const hit = byRegion.get(r);
    if (hit !== undefined) return hit;
    if (pending.has(r)) return 'U';
    pending.add(r);
    try {
      let tri: Tri = r.cond === undefined ? 'U' : 'T';
      if (r.entry !== undefined && decide(conditionEx(r.entry, envAt(nodeEnv, r.start)), predicates, exclusions) === 'F') tri = 'F';
      else if (r.cond !== undefined) tri = decide(regionEx(r as Region & { cond: GuardCondition }, nodeEnv), predicates, exclusions);
      byRegion.set(r, tri);
      return tri;
    } finally {
      pending.delete(r);
    }
  };
  /** Whether a write at body offset `x` cannot run on the way to `site`: a region around it but not `site` is false alone. */
  const deadIn = (nodeEnv: GuardEnv, analysis: Analysis) => (x: number, site: number): boolean =>
    regionsHolding(analysis, x).some((r) => !holdsOffset(r, site) && (r.cond !== undefined || r.entry !== undefined) && regionTri(r, nodeEnv) === 'F');
  /** The truth of a guard leaf that is the whole guard of a region, when that region alone is decided. */
  const fixedIn = (nodeEnv: GuardEnv, analysis: Analysis): FixedAtom => {
    let owners = atomRegions.get(analysis);
    if (owners === undefined) {
      owners = new Map();
      for (const r of analysis.regions) if (r.cond !== undefined && (r.cond.k === 'expr' || r.cond.k === 'case') && !owners.has(r.cond)) owners.set(r.cond, r);
      atomRegions.set(analysis, owners);
    }
    const byAtom = owners;
    return (atom) => {
      const r = byAtom.get(atom);
      const tri = r === undefined ? 'U' : regionTri(r, nodeEnv);
      return tri === 'T' ? true : tri === 'F' ? false : undefined;
    };
  };
  /** Joint verdict of the guards around body offset `at`, each read where its region opens, with the texts of the undecided ones. */
  const evaluate = (regions: readonly Region[], nodeEnv: GuardEnv, _at: number): { tri: Tri; texts: string[] } => {
    if (regions.some((r) => r.entry !== undefined && regionTri(r, nodeEnv) === 'F')) return { tri: 'F', texts: [] };
    const guarded = regions.filter((r): r is Region & { cond: GuardCondition } => r.cond !== undefined);
    if (guarded.length === 0) return { tri: 'T', texts: [] };
    let joint = decided.get(nodeEnv);
    if (joint === undefined) {
      joint = new Map();
      decided.set(nodeEnv, joint);
    }
    const key = guarded.map((r) => condId(r.cond)).join(',');
    let tri = joint.get(key);
    if (tri === undefined) {
      const parts = guarded.map((r) => regionEx(r, nodeEnv));
      tri = decide(parts.reduce<Ex>((acc, e) => ({ t: 'and', a: acc, b: e }), { t: 'lit', v: { k: 'b', v: true } }), predicates, exclusions);
      joint.set(key, tri);
    }
    if (tri !== 'U') return { tri, texts: [] };
    const texts = guarded.filter((r) => regionTri(r, nodeEnv) !== 'T').map((r) => describeCondition(r.cond));
    return { tri, texts: texts.length > 0 ? texts : [describeCondition({ k: 'and', of: guarded.map((r) => r.cond) })] };
  };

  const locate = (n: WalkNode): { unit: CfmlUnit; fn: CfmlFunction } | null => {
    if (n.from.toLowerCase().endsWith('.cfm')) {
      const unit = resolver.unit(n.from);
      const fn = unit?.functions.find((f) => f.name.toLowerCase() === n.method.toLowerCase());
      if (unit !== null && fn !== undefined) return { unit, fn };
      return n.method === '' ? null : resolver.findFunction(n.receiver, n.method);
    }
    return resolver.findFunction(n.from, n.method);
  };

  const states = new Map<string, WalkNode>();
  const queue: WalkNode[] = [];
  const enqueue = (n: WalkNode): void => {
    const key = nodeKey(n);
    const prev = states.get(key);
    if (prev !== undefined && (prev.conditions.length === 0 || n.conditions.length > 0)) return;
    states.set(key, n);
    queue.push(n);
  };

  const entryUnit = resolver.unit(entry.component);
  if (entryUnit === null) throw new Error(`closure entry ${entry.component} is not a CFML unit of the source tree`);
  const entryFn =
    entryUnit.functions.find((f) => f.name.toLowerCase() === entry.method.toLowerCase()) ??
    resolver.findFunction(entry.component, entry.method)?.fn;
  if (entryFn === undefined) throw new Error(`closure entry ${entry.component} has no method ${JSON.stringify(entry.method)}`);
  const rootAliases = entryAliases(entryFn);
  if (entry.populated !== undefined) addAlias(rootAliases, 'this', 'bean', { component: entry.component, extra: extraKeys(resolver, entry.component, entry.populated) });
  enqueue({
    receiver: entry.component,
    from: entry.component,
    method: entryFn.name,
    aliases: rootAliases,
    literals: {},
    thread: false,
    relogin: false,
    conditions: [],
    trail: [],
  });

  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (node === undefined || states.get(nodeKey(node)) !== node) continue;
    const loc = locate(node);
    if (loc === null) continue;
    const { unit, fn } = loc;
    // First path in walk order to reach this node; a later unconditional path that supersedes it brings its own.
    const via: readonly string[] = [...node.trail, viaLabel(unit.path, fn.name)];
    const analysis = analyse(fn, unit.syntax);
    const env: GuardEnv = {
      aliases: beanAliases(resolver, { receiver: node.receiver, unit, fn }, node.aliases),
      formals: formalValues(fn, unit.syntax, node.formals),
      facts: (component) => beanFacts(resolver, component),
      receiver: node.receiver,
      analysis,
      localDefs: trackedLocals(fn, unit.syntax),
    };
    env.dead = deadIn(env, analysis);
    env.fixed = fixedIn(env, analysis);
    const owner = unit.syntax === 'template' ? unit.path : node.receiver;
    const triggerOf = (inThread: boolean): Trigger => (node.thread || inThread ? 'thread' : baseTrigger);
    const visitedKey = `${owner}#${fn.name}`;
    acc.visited.add(visitedKey);
    if (visitedVia !== undefined && !visitedVia.has(visitedKey)) visitedVia.set(visitedKey, via);

    const lowerName = fn.name.toLowerCase();
    const matching = [
      ...new Set([...(overrides.get(`${unit.path}#${lowerName}`) ?? []), ...(overrides.get(`${owner}#${lowerName}`) ?? [])]),
    ];
    for (const o of matching) {
      acc.overrides.add(o.id);
      acc.effect(node.relogin && o.sessionEffects === 'login' ? 'relogin' : o.sessionEffects);
      const conditions = [...node.conditions, ...(o.condition === undefined ? [] : [o.condition])];
      for (const table of o.tables ?? []) {
        acc.write(
          {
            table,
            op: o.op,
            component: owner,
            method: fn.name,
            source: o.source,
            trigger: node.thread ? 'thread' : o.trigger === 'request' ? baseTrigger : o.trigger,
            whereParams: Array.isArray(o.keyScope) ? [...o.keyScope] : [],
            conditional: conditions.length > 0,
            columns: o.columns === undefined ? null : o.columns.map((col) => col.toLowerCase()),
            via: [...via],
            override: o.id,
          },
          conditions,
        );
      }
      for (const r of o.reaches ?? []) {
        const callee = resolver.findFunction(r.component, r.method);
        if (callee === null) throw new Error(`writer override ${o.id} reaches ${r.component}#${r.method}, which the source tree does not define`);
        enqueue({
          receiver: r.component,
          from: r.component,
          method: callee.fn.name,
          aliases: [{ name: 'request.context', kind: 'struct' }],
          literals: {},
          thread: node.thread,
          relogin: node.relogin,
          conditions,
          trail: via,
        });
      }
    }
    // A reviewed override for this method stands for the writes it cannot resolve, so its gaps are not reported.
    const settled = matching.length > 0;

    const base = baseName(unit.path);
    if (base === 'userutility.cfc' && (lowerName === 'loginbyquery' || lowerName === 'loginbyuserid')) {
      acc.effect(node.relogin ? 'relogin' : 'login');
    } else if (base === 'userbean.cfc' && lowerName === 'login') {
      acc.effect('relogin');
    } else if ((base === 'loginmanager.cfc' || base === 'userutility.cfc') && lowerName === 'logout') {
      acc.effect('logout');
    }

    for (const r of analysis.regions) {
      if (r.thread === undefined || evaluate(regionsAt(analysis.regions, r.thread.open), env, r.thread.open).tri === 'F') continue;
      acc.thread({
        name: r.thread.name,
        component: owner,
        method: fn.name,
        source: sourceRef(unit.path, analysis.lineAt(r.thread.open), analysis.lineAt(r.thread.close)),
      });
    }

    for (const w of analysis.writes) {
      const verdict = evaluate(regionsAt(analysis.regions, w.offset), env, w.offset);
      if (verdict.tri === 'F') continue;
      const conditions = [...node.conditions, ...verdict.texts];
      const source = sourceRef(unit.path, w.line, w.endLine);
      const table = w.dynamic === true ? dynamicTable(w.tableExpr, node, unit, fn) : w.table;
      const write: ClosureWrite = {
        table,
        op: w.op,
        component: owner,
        method: fn.name,
        source,
        trigger: triggerOf(w.thread !== undefined),
        whereParams: [...w.whereParams],
        conditional: conditions.length > 0,
        columns: w.columns === null ? null : [...w.columns],
        via: [...via],
      };
      if (table === null) {
        write.dynamic = true;
        unresolvedRef({ expr: w.tableExpr, kind: 'table', source, via: [...via] });
      }
      acc.write(write, conditions);
    }

    const storePaths = new Set(node.storePaths ?? []);
    const isStore = (expr: string): boolean => isStorePath(expr, fn, analysis, storePaths);
    for (const f of fileOperations(fn, analysis)) {
      if (!isStore(f.path)) continue;
      const verdict = evaluate(regionsAt(analysis.regions, f.offset), env, f.offset);
      if (verdict.tri === 'F') continue;
      const line = analysis.lineAt(f.offset);
      acc.fileStore({
        component: owner,
        method: f.name,
        source: sourceRef(unit.path, line, line),
        conditional: node.conditions.length > 0 || verdict.texts.length > 0,
        via: [...via],
        op: f.op,
      });
    }

    for (const c of resolveCalls(resolver, { receiver: node.receiver, unit, fn })) {
      const verdict = evaluate(c.regions, env, c.site.offset);
      if (verdict.tri === 'F') continue;
      const pruned = c.resolution.kind === 'resolved' ? prunedCall(unit.path, c.site) : undefined;
      if (pruned !== undefined) {
        acc.overrides.add(pruned.id);
        continue;
      }
      const conditions = [...node.conditions, ...verdict.texts];
      const source = sourceRef(unit.path, c.site.line, c.site.line);
      const inThread = node.thread || c.site.thread !== undefined;
      const method = c.site.target.method;
      const lowerMethod = method.toLowerCase();
      const calleeName = (c.site.resolved === null ? (c.site.target.bean ?? '') : path.posix.basename(c.site.resolved, '.cfc')).toLowerCase();
      const callerName = path.posix.basename(unit.path, '.cfc').toLowerCase();
      const found = c.resolution.kind === 'resolved' ? locate({ ...node, receiver: c.resolution.path, from: c.from ?? c.resolution.path, method }) : null;
      /** Call path through the called method: its defining unit when located, else the receiver as written. */
      const calleeVia = (): string[] => [
        ...via,
        found !== null
          ? viaLabel(found.unit.path, found.fn.name)
          : c.site.resolved !== null
            ? viaLabel(c.site.resolved, method)
            : c.site.target.bean !== undefined
              ? `${c.site.target.bean}.${method}`
              : c.site.text,
      ];
      const storeCall =
        ((calleeName === 'filemanager' || calleeName === 'filedao') && FILE_STORE_METHODS.has(lowerMethod)) ||
        ((callerName === 'filemanager' || callerName === 'filedao') && calleeName === 'filewriter' && FILE_WRITER_METHODS.has(lowerMethod));
      if (storeCall) {
        acc.fileStore({
          component: c.site.resolved ?? c.site.target.bean ?? c.site.text,
          method,
          source,
          conditional: conditions.length > 0,
          via: calleeVia(),
        });
      }
      const relogin =
        lowerMethod === 'login' &&
        c.site.args.length === 0 &&
        (/(^|\.)userbean$/i.test(c.site.text.slice(0, -'.login'.length)) || (c.site.resolved !== null && baseName(c.site.resolved) === 'userbean.cfc'));
      if (relogin) acc.effect('relogin');

      if (c.resolution.kind !== 'resolved') {
        const reportable = c.resolution.kind === 'unresolved' || lowerMethod === 'save' || lowerMethod === 'delete';
        if (reportable && !settled) {
          unresolvedRef({ expr: c.site.text, kind: c.resolution.kind === 'unresolved' ? c.resolution.why : 'receiver', source, via: [...via] });
        }
        continue;
      }
      const target = c.resolution.path;
      const from = c.from ?? target;
      if (lowerMethod === 'save' || lowerMethod === 'delete') {
        const table = ctx.index.ormTable(target);
        if (table !== null) {
          acc.write(
            {
              table,
              op: lowerMethod,
              component: target,
              method,
              source,
              trigger: inThread ? 'thread' : baseTrigger,
              whereParams: [],
              conditional: conditions.length > 0,
              columns: null,
              via: calleeVia(),
            },
            conditions,
          );
        }
      }
      if (found === null) {
        if (resolver.unit(from) === null) {
          if (!settled) unresolvedRef({ expr: c.site.text, kind: 'component', source, via: [...via] });
        } else if (resolver.hasOnMissingMethod(from)) {
          enqueue({
            receiver: target,
            from,
            method: 'onMissingMethod',
            aliases: [{ name: 'request.context', kind: 'struct' }],
            literals: {},
            thread: inThread,
            relogin: node.relogin || relogin,
            conditions,
            trail: via,
          });
        } else if (!/^(get|set|has)[A-Za-z_$]/.test(method) && !settled) {
          unresolvedRef({ expr: c.site.text, kind: 'method', source, via: [...via] });
        }
        continue;
      }
      const callerAliases = scopedAliases(env, c.site.offset);
      const bound = bindArguments(c.site.args, found.fn, found.unit.syntax, node, callerAliases, env.formals);
      // The callee runs on a request-populated bean when called on one, or on the caller's own when it calls itself.
      const self = c.receiver === '' || c.receiver === 'this' || c.receiver === 'super' ? 'this' : c.receiver;
      const onBean = self === null ? undefined : callerAliases.find((a) => a.kind === 'bean' && a.name === self);
      if (onBean !== undefined) addAlias(bound.aliases, 'this', 'bean', onBean);
      // A call already cited as a file-store write stands for the file operations of its callee; a rendition-cache
      // call writes no stored object.
      const renditionCall = (calleeName === 'filemanager' || calleeName === 'processimgcfimage') && RENDITION_CACHE_METHODS.has(lowerMethod);
      const calleeStorePaths = storeCall || renditionCall ? undefined : storePathFormals(c.site.args, found.fn, isStore, storePaths);
      enqueue({
        receiver: target,
        from,
        method: found.fn.name,
        aliases: bound.aliases,
        literals: bound.literals,
        formals: bound.formals,
        ...(calleeStorePaths === undefined ? {} : { storePaths: calleeStorePaths }),
        thread: inThread,
        relogin: node.relogin || relogin,
        conditions,
        trail: via,
      });
    }

    for (const inc of fn.includes) {
      const regions = regionsAt(analysis.regions, inc.offset);
      const verdict = evaluate(regions, env, inc.offset);
      if (verdict.tri === 'F') continue;
      const template = resolveTemplatePath(inc.template, unit.path, ctx.tree);
      if (template === null) {
        if (!settled) unresolvedRef({ expr: inc.template, kind: 'include', source: sourceRef(unit.path, inc.line, inc.line), via: [...via] });
        continue;
      }
      // An included template shares the includer's scopes, so it sees the aliases that apply at the include.
      const aliases = templateAliases(scopedAliases(env, inc.offset).map(({ since: _since, until: _until, ...a }) => a));
      enqueue({
        receiver: node.receiver,
        from: template,
        method: '',
        aliases,
        literals: {},
        ...(node.storePaths === undefined ? {} : { storePaths: node.storePaths }),
        thread: node.thread || threadAt(analysis.regions, inc.offset, analysis.lineAt) !== undefined,
        relogin: node.relogin,
        conditions: [...node.conditions, ...verdict.texts],
        trail: via,
      });
    }
  }
  return acc.result();

  /** Table of `#arguments.x#` from the call's literal or the formal's default, or of `#getTable()#` from the receiver. */
  function dynamicTable(expr: string, node: WalkNode, unit: CfmlUnit, fn: CfmlFunction): string | null {
    const e = stripHashes(expr).replace(/\s+/g, '').toLowerCase();
    const formal = /^(?:arguments\.)?([\w$]+)$/.exec(e)?.[1];
    const arg = formal === undefined ? undefined : fn.args.find((a) => a.name.toLowerCase() === formal);
    if (formal !== undefined && arg !== undefined) {
      const value = node.literals[formal] ?? literalString(arg.default);
      return value === undefined ? null : staticTableName(value);
    }
    if (SELF_TABLE.test(e)) {
      const orm = ctx.index.ormTable(node.receiver);
      if (orm !== null) return orm;
      for (const p of [...resolver.chain(node.receiver), unit.path]) {
        const u = resolver.unit(p);
        const t = u === null ? undefined : declaredTable(u);
        if (t !== undefined) return t;
      }
    }
    return null;
  }
}

