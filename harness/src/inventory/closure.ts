// CFML source model and per-branch write closure for the legacy inventory (tables[].writers[], action write sets).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isInsideRepo } from '../lib/paths.js';
import type {
  SessionEffects,
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

/** Index just after the string literal opening at `at`: doubled quotes escape, `##` escapes, `#…#` interpolates. */
function skipString(text: string, at: number, end: number = text.length): number {
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
      j = skipInterpolation(text, j + 1, end);
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

/** `<cfinclude template>`, script `include "…";` and `cfinclude(template=…)` in `body`. */
function findIncludes(body: string, offset: number, lines: LineIndex): CfmlInclude[] {
  const found: CfmlInclude[] = [];
  const push = (template: string | undefined, at: number): void => {
    if (template !== undefined && template !== '') found.push({ template, line: lines.line(offset + at), offset: at });
  };
  for (const m of body.matchAll(/<cfinclude\b/gi)) {
    push(parseAttributes(body.slice(m.index + m[0].length, tagEnd(body, m.index) - 1)).template, m.index);
  }
  for (const m of body.matchAll(/\bcfinclude\s*\(/gi)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(body, open);
    if (close > open) push(parseAttributes(body.slice(open + 1, close)).template, m.index);
  }
  for (const m of body.matchAll(/(?<![\w$.<])include\s+(["'])/gi)) {
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
          includes: findIncludes(body, offset, lines),
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
      includes: findIncludes(body, bodyStart, lines),
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
    includes: findIncludes(text, 0, lines),
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
}

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

const BLOCK_WORDS = new Set(['for', 'while', 'do', 'try', 'catch', 'finally', 'else', 'transaction', 'lock', 'savecontent']);
const ATTRIBUTE_BLOCKS = new Set(['transaction', 'lock', 'savecontent']);

/** Guard and thread regions of the cfscript between `from` and `to` of `text`. */
function scriptRegions(text: string, from: number, to: number, out: Region[]): void {
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
  const simple = (i: number, end: number): number => {
    let j = i;
    while (j < end) {
      if (isP(toks[j], ';')) return j + 1;
      if (j > i && isP(toks[j], '}')) return j;
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
        return isP(toks[j], '{') ? closeOf(j, end) + 1 : j + 1;
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
        if (isP(toks[j], '{')) {
          const c = closeOf(j, end);
          seq(j + 1, c);
          return c + 1;
        }
        return j >= end ? end : stmt(j, end);
      }
    }
    return simple(i, end);
  };
  seq(0, toks.length);
}

function stripHashes(expr: string): string {
  const t = expr.trim();
  return t.length > 1 && t.startsWith('#') && t.endsWith('#') ? t.slice(1, -1).trim() : t;
}

/** Guard and thread regions of tag-syntax `text`, descending into `<cfscript>` blocks. */
function tagRegions(text: string, out: Region[]): void {
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
    | { k: 'thread'; name: string; open: number; start: number };
  const frames: Frame[] = [];
  const innermost = (k: Frame['k']): number => {
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i]?.k === k) return i;
    return -1;
  };
  const innermostSwitch = (): SwitchFrame | undefined => {
    const f = frames[innermost('switch')];
    return f?.k === 'switch' ? f : undefined;
  };
  const re = /<(\/?)cf(if|elseif|else|switch|case|defaultcase|catch|thread|script)\b/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const at = m.index;
    const end = tagEnd(text, at);
    const name = (m[2] ?? '').toLowerCase();
    const rawInner = text.slice(at + m[0].length, Math.max(at + m[0].length, end - 1));
    const selfClosing = /\/\s*$/.test(rawInner);
    const inner = rawInner.replace(/\/\s*$/, '');
    re.lastIndex = end;
    if (m[1] !== '/') {
      if (name === 'script') {
        const close = indexOfCi(text, '</cfscript', end);
        const stop = close < 0 ? text.length : close;
        scriptRegions(text, end, stop, out);
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

/** Request predicates: a value, `true` (present and non-empty) or `false`/`null` (absent or empty). */
export type Predicates = Readonly<Record<string, string | boolean | null>>;

type PredicateValue = string | boolean | null;

/** A name the request reaches the code under: a struct (`rc.p`), an event (`event.getValue('p')`) or a Mura scope (`$.event('p')`). */
interface Alias {
  name: string;
  kind: 'struct' | 'event' | 'scope';
}

type Val =
  | { k: 'u' }
  | { k: 'a' }
  | { k: 'x' }
  | { k: 'p' }
  | { k: 's'; v: string }
  | { k: 'n'; v: number }
  | { k: 'b'; v: boolean };

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

  constructor(
    private readonly toks: readonly Token[],
    private readonly aliases: readonly Alias[],
  ) {}

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

  /** Maps a reference chain onto request parameters, builtins or unknown. */
  private interpret(segs: readonly Seg[]): Ex {
    const last = segs[segs.length - 1];
    if (last === undefined) return UNK;
    const head = segs.slice(0, -1);
    const plainHead = head.every((s) => s.call === undefined && s.index === undefined);
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
        case 'structkeyexists': {
          const key = lit(a1);
          return a0?.t === 'alias' && key !== undefined ? { t: 'has', p: key.toLowerCase() } : UNK;
        }
        case 'isdefined': {
          const target = lit(a0)?.toLowerCase();
          if (target === undefined) return UNK;
          for (const a of this.aliases) {
            const rest = target.startsWith(`${a.name}.`) ? target.slice(a.name.length + 1) : '';
            if (a.kind === 'struct' && /^[\w$]+$/.test(rest)) return { t: 'has', p: rest };
          }
          return UNK;
        }
        default:
          return UNK;
      }
    }
    if (!plainHead) return UNK;
    const fullPath = segs.map((s) => s.name).join('.');
    if (last.call === undefined && last.index === undefined) {
      if (this.aliasNamed(fullPath, 'struct')) return { t: 'alias', name: fullPath };
      return head.length > 0 && this.aliasNamed(headPath, 'struct') ? { t: 'ref', p: last.name } : UNK;
    }
    if (last.call === undefined && last.index !== undefined) {
      const key = lit(last.index);
      return key !== undefined && this.aliasNamed(fullPath, 'struct') ? { t: 'ref', p: key.toLowerCase() } : UNK;
    }
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

function parseGuard(text: string, aliases: readonly Alias[]): Ex {
  const toks = tokenize(text, 0, text.length).filter((t) => !isP(t, '#'));
  return toks.length === 0 ? UNK : new GuardParser(toks, aliases).parse();
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
  if (a.k === 'u' || b.k === 'u') return 'U';
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
    case 'x':
      return 'U';
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

/** Value of one parameter in an enumerated world: absent, a known string, or some other non-empty string. */
type WorldValue = { k: 'a' } | { k: 's'; v: string } | { k: 'x' };
type World = ReadonlyMap<string, WorldValue>;

function exValue(e: Ex, w: World): Val {
  switch (e.t) {
    case 'lit':
      return e.v;
    case 'ref':
      return w.get(e.p) ?? U;
    case 'fn': {
      const v = exValue(e.e, w);
      if (e.f === 'len') {
        if (v.k === 'u') return U;
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
      const a = exValue(e.a, w);
      const b = exValue(e.b, w);
      if (e.op === 'eq') return cfEq(a, b);
      if (e.op === 'neq') return notTri(cfEq(a, b));
      if (e.op === 'contains' || e.op === 'ncontains') {
        if (a.k === 'u' || b.k === 'u' || a.k === 'x' || b.k === 'x' || a.k === 'p' || b.k === 'p') return 'U';
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
  else if (e.t === 'cmp' || e.t === 'and' || e.t === 'or') {
    exParams(e.a, out);
    exParams(e.b, out);
  }
  return out;
}

function exLiterals(e: Ex, out: Set<string>): Set<string> {
  if (e.t === 'lit') out.add(toText(e.v));
  else if (e.t === 'fn' || e.t === 'not') exLiterals(e.e, out);
  else if (e.t === 'cmp' || e.t === 'and' || e.t === 'or') {
    exLiterals(e.a, out);
    exLiterals(e.b, out);
  }
  return out;
}

function sameText(a: string, b: string): boolean {
  return cfEq({ k: 's', v: a }, { k: 's', v: b }) === 'T';
}

/** Whether a world value satisfies one predicate value. */
function atomHolds(v: WorldValue, p: PredicateValue): boolean {
  if (typeof p === 'string') return v.k === 'a' ? p === '' : v.k === 's' && sameText(v.v, p);
  if (p === true) return v.k === 'x' || (v.k === 's' && v.v !== '');
  return v.k === 'a' || (v.k === 's' && v.v === '');
}

/** Whether an exclusion atom holds given only the entry predicate on the same parameter. */
function atomUnderPredicate(pinned: PredicateValue, atom: PredicateValue): Tri {
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
    return [{ k: 'a' }, { k: 's', v: '' }, ...[...texts.values()].map((v): WorldValue => ({ k: 's', v })), { k: 'x' }];
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

function conditionEx(c: GuardCondition, aliases: readonly Alias[]): Ex {
  switch (c.k) {
    case 'expr':
      return parseGuard(c.text, aliases);
    case 'case': {
      const subject = parseGuard(c.subject, aliases);
      return c.values.reduce<Ex>(
        (acc, v) => {
          const test: Ex = v === null ? UNK : { t: 'cmp', op: 'eq', a: subject, b: { t: 'lit', v: { k: 's', v } } };
          return acc.t === 'lit' ? test : { t: 'or', a: acc, b: test };
        },
        { t: 'lit', v: { k: 'b', v: false } },
      );
    }
    case 'not':
      return { t: 'not', e: conditionEx(c.of, aliases) };
    case 'and':
    case 'or':
      return c.of.reduce<Ex>(
        (acc, x) => ({ t: c.k, a: acc, b: conditionEx(x, aliases) }),
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

/** A SQL write statement in a function body; `table` is null when the target is an unresolved expression. */
export interface SqlWrite {
  table: string | null;
  op: 'insert' | 'update' | 'delete';
  line: number;
  endLine: number;
  whereParams: string[];
  tableExpr: string;
  offset: number;
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
  calls: RawCall[];
  writes: SqlWrite[];
  assignments: Assignment[];
  returns: string[];
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

function chainCalls(body: string): RawCall[] {
  const calls: RawCall[] = [];
  let skipUntil = -1;
  for (const m of body.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const at = m.index;
    if (at < skipUntil) continue;
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

/** End of the expression starting at `from`: `;`, a newline or (in tags) `>` at depth 0. */
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
    } else if (depth === 0 && (c === ';' || c === '\n' || (tagged && c === '>'))) {
      return i;
    }
    i++;
  }
  return text.length;
}

function cleanRhs(raw: string): string {
  return raw.trim().replace(/\/$/, '').trim();
}

function findAssignments(body: string): Assignment[] {
  const found: Assignment[] = [];
  const re = /(<cfset\s+|(?:^|[;{}\n])[ \t]*)(?:var\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=(?!=)/gi;
  for (const m of body.matchAll(re)) {
    const lvalue = (m[2] ?? '').toLowerCase().replace(/^local\./, '');
    const start = m.index + m[0].length;
    const rhs = cleanRhs(body.slice(start, expressionEnd(body, start, (m[1] ?? '').toLowerCase().startsWith('<cfset'))));
    if (rhs !== '') found.push({ lvalue, rhs, offset: m.index });
  }
  return found;
}

function findReturns(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/(<cfreturn\s+|\breturn\s+)/gi)) {
    const start = m.index + m[0].length;
    const rhs = cleanRhs(body.slice(start, expressionEnd(body, start, (m[1] ?? '').startsWith('<'))));
    if (rhs !== '') out.push(rhs);
  }
  return out;
}

/** Text spans holding SQL: `<cfquery>` bodies and string literals given to queryExecute, `sql=` or setSql. */
function sqlSpans(body: string): Array<{ start: number; end: number; tag: boolean }> {
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

function threadAt(regions: readonly Region[], offset: number, lineAt: (pos: number) => number): ThreadSpan | undefined {
  let inner: Region | undefined;
  for (const r of regions) if (r.thread !== undefined && r.start <= offset && offset < r.end && (inner === undefined || r.start >= inner.start)) inner = r;
  return inner?.thread === undefined ? undefined : { name: inner.thread.name, line: lineAt(inner.thread.open), endLine: lineAt(inner.thread.close) };
}

function sqlWrites(body: string, regions: readonly Region[], lineAt: (pos: number) => number): SqlWrite[] {
  const writes: SqlWrite[] = [];
  for (const span of sqlSpans(body)) {
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
  if (syntax === 'script') scriptRegions(fn.body, 0, fn.body.length, regions);
  else tagRegions(fn.body, regions);
  const analysis: Analysis = {
    regions,
    calls: chainCalls(fn.body),
    writes: sqlWrites(fn.body, regions, lineAt),
    assignments: findAssignments(fn.body),
    returns: findReturns(fn.body),
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
    const copy: SqlWrite = { ...w, whereParams: [...w.whereParams] };
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

type Resolution =
  | { kind: 'resolved'; path: string; from: string; bean?: string }
  | { kind: 'unresolved'; why: UnresolvedKind; name?: string }
  | { kind: 'unknown' };

const UNKNOWN: Resolution = { kind: 'unknown' };
const FLUENT = /^(init|loadby|set[A-Za-z_$]*|add[A-Za-z_$]*)$/i;
const GETTER = /^get[A-Za-z_$]/;

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

/** Where resolution happens: the component whose variables and `this` apply, and the function being read. */
interface Scope {
  receiver: string;
  unit: CfmlUnit;
  fn: CfmlFunction;
}

const templateCache = new WeakMap<SourceTree, Map<string, CfmlTemplate>>();
const chainCache = new WeakMap<ComponentIndex, Map<string, string[]>>();

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
      const fn = unit?.functions.find((f) => f.name.toLowerCase() === lower);
      if (unit !== null && fn !== undefined) return { unit, fn };
    }
    return null;
  }

  hasOnMissingMethod(from: string): boolean {
    return this.findFunction(from, 'onMissingMethod') !== null;
  }

  /** First non-trivial assignment of `lvalue` (lower-case) in the current unit, then up the receiver's chain. */
  componentAssignment(scope: Scope, lvalue: string): { rhs: string; unit: CfmlUnit; fn: CfmlFunction } | null {
    const units = [scope.unit, ...this.chain(scope.receiver).map((p) => this.unit(p))];
    for (const unit of units) {
      if (unit === null) continue;
      for (const fn of unit.functions) {
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

  private local(scope: Scope, lvalue: string, seen: Set<string>): Resolution | null {
    const hit = analyse(scope.fn, scope.unit.syntax).assignments.find((a) => a.lvalue === lvalue && !isTrivialValue(a.rhs));
    return hit === undefined ? null : this.expr(hit.rhs, scope, seen);
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
      res = p === null ? { kind: 'unresolved', why: 'component', name: s0.name } : { kind: 'resolved', path: p, from: p };
    } else if (s0.args !== undefined) {
      const lower = s0.name.toLowerCase();
      if (lower === 'createobject') {
        const type = literalString(s0.args[0]?.expr)?.toLowerCase();
        const name = literalString(s0.args[1]?.expr);
        const p = name === undefined ? null : resolveComponentPath(name, scope.unit.path, this.ctx.tree);
        if (type === 'component') res = p === null ? { kind: 'unresolved', why: 'component', name } : { kind: 'resolved', path: p, from: p };
      } else if (s0.args.length === 0 && GETTER.test(s0.name)) {
        res = this.getter(scope.receiver, s0.name, seen, true);
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
        res = this.bean(s1.name);
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
        next = 2;
        const localName = w === 'arguments' ? `arguments.${s1.name.toLowerCase()}` : s1.name.toLowerCase();
        const r = this.local(scope, localName, seen);
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
      }
    }
    for (let k = next; k < upto && res.kind === 'resolved'; k++) {
      const s = segs[k];
      if (s === undefined || s.args === undefined || s.indexed === true) {
        res = UNKNOWN;
      } else if (s.args.length === 0 && GETTER.test(s.name)) {
        res = this.getter(res.path, s.name, seen, false);
      } else if (!FLUENT.test(s.name)) {
        res = UNKNOWN;
      }
    }
    return res;
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
    out.push({ site, resolution, from, regions });
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
}

/** One table write the closure reaches; `table` is null for an unresolved dynamic target. */
export interface ClosureWrite {
  table: string | null;
  op: WriterOp;
  component: string;
  method: string;
  source: SourceRef;
  trigger: Trigger;
  whereParams: string[];
  conditional: boolean;
  override?: string;
  dynamic?: true;
}

/** A write reached only under a guard the predicates cannot decide. */
export interface ConditionalWrite {
  table: string;
  condition: string;
  source: SourceRef;
}

/** A call that writes or deletes stored file objects. */
export interface FileStoreEvidence {
  component: string;
  method: string;
  source: SourceRef;
  conditional: boolean;
}

/** A thread body reached by the closure. */
export interface ClosureThread {
  name: string;
  component: string;
  method: string;
  source: SourceRef;
}

/** A reference the walk could not follow; settled by a writer override or reported for review. */
export interface UnresolvedRef {
  expr: string;
  kind: UnresolvedKind;
  source: SourceRef;
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
  /** Ids of the writer overrides applied, including those naming tables through a job (`tablesFrom`). */
  overrides: string[];
  visited: string[];
}

interface WalkNode {
  receiver: string;
  from: string;
  method: string;
  aliases: readonly Alias[];
  literals: Readonly<Record<string, string>>;
  thread: boolean;
  relogin: boolean;
  conditions: readonly string[];
}

// fileDAO.cfc:111-209 writes originals and renditions; the delete paths flag or purge stored objects.
const FILE_STORE_METHODS = new Set(['create', 'deleteversion', 'deleteall', 'purgedeleted', 'deleteifnotused']);
const FILE_WRITER_METHODS = new Set(['writefile', 'movefile', 'copyfile', 'renamefile', 'uploadfile', 'appendfile']);
const SESSION_RANK: Record<SessionEffects, number> = { none: 0, relogin: 1, login: 2, logout: 3 };

function baseName(p: string): string {
  return path.posix.basename(p).toLowerCase();
}

function aliasKey(aliases: readonly Alias[]): string {
  return aliases
    .map((a) => `${a.kind}:${a.name}`)
    .sort(compareText)
    .join(',');
}

function addAlias(list: Alias[], name: string, kind: Alias['kind']): void {
  if (!list.some((a) => a.name === name)) list.push({ name, kind });
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

/** Callee request aliases and literal bindings from the actual arguments of a call. */
function bindArguments(
  args: readonly CallArgument[],
  callee: CfmlFunction,
  calleeSyntax: CfmlUnit['syntax'],
  node: WalkNode,
): { aliases: Alias[]; literals: Record<string, string> } {
  const aliases: Alias[] = [];
  addAlias(aliases, 'request.context', 'struct');
  const literals: Record<string, string> = {};
  const formals = callee.args;
  const relevant = relevantFormals(callee, calleeSyntax);
  args.forEach((a, i) => {
    const expr = a.expr.replace(/\s+/g, '').toLowerCase();
    const named = a.name?.toLowerCase();
    if (named === 'argumentcollection') {
      const alias = node.aliases.find((al) => al.name === expr && al.kind === 'struct');
      if (alias !== undefined) structAlias(aliases, 'arguments');
      if (expr === 'arguments') {
        for (const al of node.aliases) {
          const rest = al.name.startsWith('arguments.') ? al.name.slice('arguments.'.length) : '';
          if (rest !== '' && formals.some((f) => f.name.toLowerCase() === rest.split('.')[0])) {
            addAlias(aliases, al.name, al.kind);
            addAlias(aliases, rest, al.kind);
          }
        }
      }
      return;
    }
    const formal = named === undefined ? formals[i] : formals.find((f) => f.name.toLowerCase() === named);
    if (formal === undefined) return;
    const fname = formal.name.toLowerCase();
    const alias = node.aliases.find((al) => al.name === expr);
    if (alias !== undefined) {
      if (alias.kind === 'struct') {
        structAlias(aliases, `arguments.${fname}`);
        structAlias(aliases, fname);
      } else {
        addAlias(aliases, `arguments.${fname}`, alias.kind);
        addAlias(aliases, fname, alias.kind);
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
  return { aliases, literals };
}

function nodeKey(n: WalkNode): string {
  const literals = Object.entries(n.literals)
    .map(([k, v]) => `${k}=${v}`)
    .sort(compareText)
    .join(',');
  return [n.receiver, n.from, n.method.toLowerCase(), aliasKey(n.aliases), literals, n.thread ? 't' : '', n.relogin ? 'r' : ''].join('|');
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
    this.unresolved.set(JSON.stringify([u.source, u.expr, u.kind]), u);
  }

  result(): WriteClosure {
    const writes = [...this.writes.values()];
    const conditionalWrites = writes
      .filter((w): w is ClosureWrite & { condition: string; table: string } => w.conditional && w.table !== null)
      .map((w) => ({ table: w.table, condition: w.condition, source: w.source }))
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

function sourceRef(p: string, from: number, to: number): SourceRef {
  return { path: p, lines: [from, Math.max(from, to)] };
}


/**
 * Union of the table and file-store writes a branch reaches: breadth-first over `(component, method)` from the
 * entry, pruning guards the predicates decide false and recording undecidable ones as conditional writes.
 */
export function computeClosure(entry: ClosureEntry, ctx: ClosureContext): WriteClosure {
  const resolver = new Resolver(ctx);
  const predicates = lowerKeys(entry.predicates);
  const exclusions = (entry.excludePredicates ?? []).map(lowerKeys);
  const baseTrigger: Trigger = entry.trigger ?? 'request';
  const overrides = indexOverrides(ctx.overrides);
  const acc = new ClosureAccumulator();
  const decided = new Map<string, Tri>();
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
  const decideConds = (conds: readonly GuardCondition[], aliases: readonly Alias[], key: string): Tri => {
    const cacheKey = `${key}|${conds.map(condId).join(',')}`;
    let tri = decided.get(cacheKey);
    if (tri === undefined) {
      const c: GuardCondition = conds.length === 1 && conds[0] !== undefined ? conds[0] : { k: 'and', of: conds };
      tri = decide(conditionEx(c, aliases), predicates, exclusions);
      decided.set(cacheKey, tri);
    }
    return tri;
  };
  /** Joint verdict of the guards around an offset, with the texts of the undecided ones. */
  const evaluate = (regions: readonly Region[], aliases: readonly Alias[]): { tri: Tri; texts: string[] } => {
    const conds = regions.flatMap((r) => (r.cond === undefined ? [] : [r.cond]));
    if (conds.length === 0) return { tri: 'T', texts: [] };
    const key = aliasKey(aliases);
    const tri = decideConds(conds, aliases, key);
    if (tri !== 'U') return { tri, texts: [] };
    const texts = conds.filter((c) => decideConds([c], aliases, key) !== 'T').map(describeCondition);
    return { tri, texts: texts.length > 0 ? texts : [describeCondition({ k: 'and', of: conds })] };
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
  enqueue({
    receiver: entry.component,
    from: entry.component,
    method: entryFn.name,
    aliases: entryAliases(entryFn),
    literals: {},
    thread: false,
    relogin: false,
    conditions: [],
  });

  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (node === undefined || states.get(nodeKey(node)) !== node) continue;
    const loc = locate(node);
    if (loc === null) continue;
    const { unit, fn } = loc;
    const analysis = analyse(fn, unit.syntax);
    const owner = unit.syntax === 'template' ? unit.path : node.receiver;
    const triggerOf = (inThread: boolean): Trigger => (node.thread || inThread ? 'thread' : baseTrigger);
    acc.visited.add(`${owner}#${fn.name}`);

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
            override: o.id,
          },
          conditions,
        );
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
      if (r.thread === undefined || evaluate(regionsAt(analysis.regions, r.thread.open), node.aliases).tri === 'F') continue;
      acc.thread({
        name: r.thread.name,
        component: owner,
        method: fn.name,
        source: sourceRef(unit.path, analysis.lineAt(r.thread.open), analysis.lineAt(r.thread.close)),
      });
    }

    for (const w of analysis.writes) {
      const verdict = evaluate(regionsAt(analysis.regions, w.offset), node.aliases);
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
      };
      if (table === null) {
        write.dynamic = true;
        acc.unresolvedRef({ expr: w.tableExpr, kind: 'table', source });
      }
      acc.write(write, conditions);
    }

    for (const c of resolveCalls(resolver, { receiver: node.receiver, unit, fn })) {
      const verdict = evaluate(c.regions, node.aliases);
      if (verdict.tri === 'F') continue;
      const conditions = [...node.conditions, ...verdict.texts];
      const source = sourceRef(unit.path, c.site.line, c.site.line);
      const inThread = node.thread || c.site.thread !== undefined;
      const method = c.site.target.method;
      const lowerMethod = method.toLowerCase();
      const calleeName = (c.site.resolved === null ? (c.site.target.bean ?? '') : path.posix.basename(c.site.resolved, '.cfc')).toLowerCase();
      const callerName = path.posix.basename(unit.path, '.cfc').toLowerCase();
      if (
        ((calleeName === 'filemanager' || calleeName === 'filedao') && FILE_STORE_METHODS.has(lowerMethod)) ||
        ((callerName === 'filemanager' || callerName === 'filedao') && calleeName === 'filewriter' && FILE_WRITER_METHODS.has(lowerMethod))
      ) {
        acc.fileStore({ component: c.site.resolved ?? c.site.target.bean ?? c.site.text, method, source, conditional: conditions.length > 0 });
      }
      const relogin =
        lowerMethod === 'login' &&
        c.site.args.length === 0 &&
        (/(^|\.)userbean$/i.test(c.site.text.slice(0, -'.login'.length)) || (c.site.resolved !== null && baseName(c.site.resolved) === 'userbean.cfc'));
      if (relogin) acc.effect('relogin');

      if (c.resolution.kind !== 'resolved') {
        const reportable = c.resolution.kind === 'unresolved' || lowerMethod === 'save' || lowerMethod === 'delete';
        if (reportable && !settled) {
          acc.unresolvedRef({ expr: c.site.text, kind: c.resolution.kind === 'unresolved' ? c.resolution.why : 'receiver', source });
        }
        continue;
      }
      const target = c.resolution.path;
      const from = c.from ?? target;
      if (lowerMethod === 'save' || lowerMethod === 'delete') {
        const table = ctx.index.ormTable(target);
        if (table !== null) {
          acc.write(
            { table, op: lowerMethod, component: target, method, source, trigger: inThread ? 'thread' : baseTrigger, whereParams: [], conditional: conditions.length > 0 },
            conditions,
          );
        }
      }
      const found = locate({ ...node, receiver: target, from, method });
      if (found === null) {
        if (resolver.unit(from) === null) {
          if (!settled) acc.unresolvedRef({ expr: c.site.text, kind: 'component', source });
        } else if (resolver.hasOnMissingMethod(from)) {
          enqueue({ receiver: target, from, method: 'onMissingMethod', aliases: [{ name: 'request.context', kind: 'struct' }], literals: {}, thread: inThread, relogin: node.relogin || relogin, conditions });
        } else if (!/^(get|set|has)[A-Za-z_$]/.test(method) && !settled) {
          acc.unresolvedRef({ expr: c.site.text, kind: 'method', source });
        }
        continue;
      }
      const bound = bindArguments(c.site.args, found.fn, found.unit.syntax, node);
      enqueue({
        receiver: target,
        from,
        method: found.fn.name,
        aliases: bound.aliases,
        literals: bound.literals,
        thread: inThread,
        relogin: node.relogin || relogin,
        conditions,
      });
    }

    for (const inc of fn.includes) {
      const regions = regionsAt(analysis.regions, inc.offset);
      const verdict = evaluate(regions, node.aliases);
      if (verdict.tri === 'F') continue;
      const template = resolveTemplatePath(inc.template, unit.path, ctx.tree);
      if (template === null) {
        if (!settled) acc.unresolvedRef({ expr: inc.template, kind: 'include', source: sourceRef(unit.path, inc.line, inc.line) });
        continue;
      }
      const aliases = templateAliases([...node.aliases]);
      enqueue({
        receiver: node.receiver,
        from: template,
        method: '',
        aliases,
        literals: {},
        thread: node.thread || threadAt(analysis.regions, inc.offset, analysis.lineAt) !== undefined,
        relogin: node.relogin,
        conditions: [...node.conditions, ...verdict.texts],
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

