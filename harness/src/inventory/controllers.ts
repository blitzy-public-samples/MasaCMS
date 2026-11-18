// Admin circuits, their actions and action variants for the legacy inventory (controllers[]), and the core muraAction search.
import path from 'node:path';
import type { VariantCondition, VariantDeclaration } from '@opt2/platform/legacy-compat';
import {
  CFML_TRUTHY,
  cfTruthyText,
  computeClosure,
  detectMode,
  isTruthyPredicate,
  lineOf,
  parseAttributes,
  parseCfmlComponent,
  parseCfmTemplate,
  stripComments,
} from './closure.js';
import type {
  ClosureContext,
  ClosureWrite,
  CfmlComponent,
  CfmlFunction,
  ConditionalWrite,
  FileStoreEvidence,
  Predicates,
  SourceTree,
  UnresolvedRef,
  WriteClosure,
} from './closure.js';
import { OverrideError } from './overrides.js';
import type {
  ApplicationGate,
  ExtractorPattern,
  RequiredRole,
  RoleOverride,
  RoleOverrides,
  SessionEffects,
  SourceRef,
  ViewPartial,
  ViewPartials,
} from './overrides.js';
import { inventoryRouteKey, normaliseInventoryKey, variantsFor } from './route-keys.js';

/** Directory of the FW/1 admin circuits. */
export const CONTROLLERS_DIR = 'admin/core/controllers';

/** Directory of the admin views, one folder per circuit. */
export const VIEWS_DIR = 'admin/core/views';

/** Repository path override references point into, as `<path>#<id>`. */
export const ROLE_OVERRIDES_REF = 'harness/inventory/role-overrides.yaml';

/** Repository path reviewed-partial references point into, as `<path>#<id>`. */
export const VIEW_PARTIALS_REF = 'harness/inventory/view-partials.yaml';

/** Layouts a `page` response chooses between per request: `compactDisplay=true` selects compact (admin/common/layouts/default.cfm:1). */
export const PAGE_LAYOUTS: readonly string[] = Object.freeze(['template', 'compact']);

/** Value of `layout` on a page response: the layout is chosen per request from {@link PAGE_LAYOUTS}. */
export const REQUEST_LAYOUT = 'request';

/** The FW/1 action parameter the core search looks for. */
export const MURA_ACTION_QUERY = 'muraAction';

/** Scope of the core muraAction search. */
export const CORE_SEARCH_SCOPE = 'core/** excluding core/vendor';

/** Legacy content type of a response that declares none. */
const UNDECLARED_CONTENT_TYPE = 'text/html';

/** FW/1 lifecycle methods and the base controller's helpers, which are not admin actions. */
const LIFECYCLE_METHODS: Readonly<Record<string, ExclusionReason>> = Object.freeze({
  init: 'lifecycle',
  before: 'lifecycle',
  after: 'lifecycle',
  secure: 'base-helper',
  appendrequestscope: 'base-helper',
});

/** Callable through FW/1: public or remote functions. */
const CALLABLE_ACCESS = new Set(['public', 'remote']);

// Types

/** Extractor pattern id of a classified `before()` gate. */
export type GatePatternId = ExtractorPattern['id'];

/** Whether an action's branch consumes a CSRF token: validates it, short-circuits the check, or carries none. */
export type CsrfValidation = 'validates' | 'bypassed' | 'none';

/** Shape of a legacy admin response. */
export type ResponseMode = 'page' | 'fragment' | 'json' | 'redirect' | 'download';

/** A public controller method, or a view with no matching method. */
export type ActionKind = 'method' | 'view-only';

/** Why a controller function is not an action. */
export type ExclusionReason = 'lifecycle' | 'base-helper' | 'di-setter' | 'accessor' | 'not-public';

/** Why a file of a circuit's views folder is not a view-only action. */
export type ViewExclusionReason = 'dsp-include' | 'reviewed-partial' | 'subfolder';

/** The role a gate requires, how it was classified and the reviewed override that settles it. */
export interface RoleGate {
  /** The gate condition as the source states it, whitespace-collapsed. */
  gate: string;
  /** Required role; null while the gate is unclassified. */
  classification: RequiredRole | null;
  pattern: GatePatternId | null;
  unclassified: boolean;
  source: SourceRef;
  /** `harness/inventory/role-overrides.yaml#<id>` of the override applied, else null. */
  override: string | null;
  siteFrom?: string[];
  when?: NonNullable<RoleOverride['when']>;
  nodePermission?: NonNullable<RoleOverride['nodePermission']>;
  denial?: string;
}

/** One `before()` branch: `actions` null for every action no other branch names. */
export interface GateBranch extends RoleGate {
  actions: string[] | null;
}

/** A base-controller function, inherited by every circuit. */
export interface HelperRef {
  name: string;
  source: SourceRef;
}

/** A controller function that is not an action. */
export interface ExcludedMethod {
  name: string;
  reason: ExclusionReason;
  source: SourceRef;
}

/** A views-folder entry that is not a view-only action. */
export interface ExcludedView {
  path: string;
  reason: ViewExclusionReason;
  /** `harness/inventory/view-partials.yaml#<id>` of the reviewed partial, for `reviewed-partial`. */
  ref?: string;
  /** Views that include it, for `reviewed-partial`. */
  includedBy?: string[];
}

/** The request predicate that selects a variant, as `gateway/cutover/variants.json` declares it. */
export interface VariantPredicate {
  variant: string;
  when: readonly VariantCondition[];
}

/** One action variant: a declared variant, or the base key that matches no variant. */
export interface VariantEntry {
  id: string;
  source: SourceRef;
  routeKey: string;
  predicate: VariantPredicate | null;
  /** Declaration rank: the first declared variant has the highest value; the base key has 0. */
  precedence: number;
  /** 1-based position in match order, the base key last. */
  order: number;
  /** Sorted lower-case tables the branch writes. */
  writeSet: string[];
  conditionalWrites: ConditionalWrite[];
  fileStoreWrite: boolean;
  sessionEffects: SessionEffects;
  closureEvidence: ClosureWrite[];
  fileStoreEvidence: FileStoreEvidence[];
  unresolvedCalls: UnresolvedRef[];
  requiredRole: RoleGate;
  csrfContext: string | null;
  csrfValidation: CsrfValidation;
  responseMode: ResponseMode;
  layout: string | null;
  contentType: string | null;
  /** Action or URL expression of the redirect a `redirect` response ends in. */
  redirectTarget: string | null;
}

/** The includers of a view-only action another view includes, and the references addressing it. */
export interface ViewReachability {
  includedBy: string[];
  /** Literal `<circuit>.<action>` references to it in `admin/` and `core/`: muraAction or fuseaction links and fields, FW/1 calls. */
  addressedBy: SourceRef[];
}

/** An admin action of a circuit. */
export interface ActionEntry {
  id: string;
  source: SourceRef;
  /** Lower-cased action name. */
  action: string;
  /** Action name in its legacy casing. */
  name: string;
  kind: ActionKind;
  viewPath: string | null;
  /** Present on a view-only action whose view another view includes. */
  reachability?: ViewReachability;
  variants: VariantEntry[];
}

/** One admin circuit, or the base controller. */
export interface ControllerEntry {
  id: string;
  circuit: string;
  isBase: boolean;
  source: SourceRef;
  helpers: HelperRef[];
  /** The circuit-wide gate: the branch that applies to actions no other branch names. */
  requiredRole: RoleGate;
  gates: GateBranch[];
  excludedMethods: ExcludedMethod[];
  excludedViews: ExcludedView[];
  actions: ActionEntry[];
}

/** A gate no extractor pattern and no reviewed override classifies; generate.ts reports it as a hard error. */
export interface UnclassifiedGate {
  circuit: string;
  actions: string[] | null;
  source: SourceRef;
}

/** The writes one action variant reaches, keyed by its route key (shape of tables.ts `WriteEvidence`). */
export interface ControllerWriteEvidence {
  entryRouteKey: string;
  trigger: 'request';
  closure: WriteClosure;
}

/** Counts of the controllers section. */
export interface ControllerCounts {
  circuits: number;
  base: number;
  actions: number;
  viewOnlyActions: number;
  variants: number;
}

/** Reviewed inputs of {@link extractControllers}. */
export interface ControllerInputs {
  variants: readonly VariantDeclaration[];
  roleOverrides: RoleOverrides;
  /** Included views reviewed as partials; absent, every included view other than a dsp_ include is an action. */
  viewPartials?: ViewPartials;
}

/** Result of {@link extractControllers}. */
export interface ControllerExtraction {
  controllers: ControllerEntry[];
  applicationGate: ApplicationGate;
  denialDefault: RoleOverrides['denialDefault'];
  unclassifiedGates: UnclassifiedGate[];
  writeEvidence: ControllerWriteEvidence[];
  counts: ControllerCounts;
}

/** How a core file uses `muraAction`. */
export type MuraActionUse = 'builds-admin-url' | 'reads-admin-action' | 'dispatches-admin-action';

/** One core file mentioning `muraAction`. */
export interface MuraActionMention {
  path: string;
  lines: number[];
  use: MuraActionUse;
}

/** Result of {@link searchCoreMuraAction}. */
export interface CoreMuraActionSearch {
  query: string;
  scope: string;
  /** Files that dispatch on the action they read. */
  handlers: number;
  filesMentioning: number;
  conclusion: 'url-builder-only' | 'dispatches';
  /** The FW/1 configuration in admin/Application.cfc that dispatches `muraAction`. */
  dispatcher: SourceRef | null;
  files: MuraActionMention[];
}

// Text scanning

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Number of lines of `text`; a final newline ends the last line rather than starting another. */
function lineCount(text: string): number {
  return Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
}

function isIdentChar(c: string): boolean {
  return /[\w$]/.test(c);
}

/** End of a `#…#` expression inside a CFML string, which may itself hold quoted strings. */
function skipHash(text: string, from: number): number {
  for (let j = from; j < text.length; j++) {
    const c = text.charAt(j);
    if (c === '#') return j + 1;
    if (c === '"' || c === "'") j = skipString(text, j) - 1;
  }
  return text.length;
}

/** End offset of the CFML string literal opening at `at`: doubled quotes escape, `#…#` expressions nest. */
function skipString(text: string, at: number): number {
  const q = text.charAt(at);
  let j = at + 1;
  while (j < text.length) {
    const c = text.charAt(j);
    if (c === q) {
      if (text.charAt(j + 1) !== q) return j + 1;
      j += 2;
    } else if (c === '#') {
      j = text.charAt(j + 1) === '#' ? j + 2 : skipHash(text, j + 1);
    } else {
      j++;
    }
  }
  return text.length;
}

const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

/** Offset of the bracket closing the one at `open`, skipping strings and nested brackets; -1 when unbalanced. */
function matchClose(text: string, open: number): number {
  const stack: string[] = [];
  for (let j = open; j < text.length; j++) {
    const c = text.charAt(j);
    if (c === '"' || c === "'") {
      j = skipString(text, j) - 1;
    } else if (OPENERS[c] !== undefined) {
      stack.push(OPENERS[c]);
    } else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return j;
    }
  }
  return -1;
}

/** Whether a word of `text` starts at `at` (identifier boundary on both sides). */
function wordAt(text: string, at: number, word: string): boolean {
  return (
    text.slice(at, at + word.length).toLowerCase() === word &&
    (at === 0 || !isIdentChar(text.charAt(at - 1))) &&
    !isIdentChar(text.charAt(at + word.length))
  );
}

function skipSpace(text: string, from: number): number {
  let j = from;
  while (j < text.length && /\s/.test(text.charAt(j))) j++;
  return j;
}

/** Matches of the global `re` in a script `text` that start outside string literals. */
function codeMatches(text: string, re: RegExp): RegExpExecArray[] {
  const strings: Array<[number, number]> = [];
  for (let j = 0; j < text.length; j++) {
    const c = text.charAt(j);
    if (c === '"' || c === "'") {
      const end = skipString(text, j);
      strings.push([j, end]);
      j = end - 1;
    }
  }
  return [...text.matchAll(re)].filter((m) => !strings.some(([s, e]) => m.index >= s && m.index < e));
}

/** Top-level comma-separated arguments of the call whose `(` is at `open`, named or positional. */
function callArguments(text: string, open: number): Array<{ name?: string; expr: string }> {
  const close = matchClose(text, open);
  if (close < 0) return [];
  const inner = text.slice(open + 1, close);
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let j = 0; j < inner.length; j++) {
    const c = inner.charAt(j);
    if (c === '"' || c === "'") j = skipString(inner, j) - 1;
    else if (OPENERS[c] !== undefined) depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(last, j));
      last = j + 1;
    }
  }
  parts.push(inner.slice(last));
  return parts
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => {
      const named = /^([A-Za-z_$][\w$]*)\s*=(?!=)\s*([\s\S]*)$/.exec(p);
      return named?.[1] !== undefined && named[2] !== undefined ? { name: named[1].toLowerCase(), expr: named[2].trim() } : { expr: p };
    });
}

/** The value of a quoted literal, or undefined when `expr` is not exactly one literal without `#` expressions. */
function literalValue(expr: string): string | undefined {
  const e = expr.trim();
  const q = e.charAt(0);
  if ((q !== '"' && q !== "'") || skipString(e, 0) !== e.length) return undefined;
  const body = e.slice(1, -1);
  if (/#(?!#)/.test(body.replace(/##/g, ''))) return undefined;
  return body.replaceAll(q + q, q).replaceAll('##', '#');
}

/** `expr` as the inventory records request expressions: scope prefixes dropped, whitespace collapsed, a lone literal unquoted. */
function recordedExpression(expr: string): string {
  const literal = literalValue(expr);
  if (literal !== undefined) return literal;
  return collapse(expr.replace(/(?<![\w$.])arguments\./gi, ''));
}

/** `text` without whitespace outside string literals, with `arguments.`, `variables.` and `application.` prefixes dropped. */
function normaliseExpression(text: string): string {
  let out = '';
  for (let j = 0; j < text.length; j++) {
    const c = text.charAt(j);
    if (c === '"' || c === "'") {
      const end = skipString(text, j);
      out += text.slice(j, end);
      j = end - 1;
    } else if (!/\s/.test(c)) {
      out += c;
    }
  }
  return out.replace(/(?<![\w$.])(?:arguments|variables|application)\./gi, '');
}

// Boolean conditions

/** A CFML condition: comparisons and other operands are atoms joined by `!`/`not`, `&&`/`and` and `||`/`or`. */
type Cond =
  | { k: 'const'; v: boolean }
  | { k: 'atom'; text: string; lhs: string; op: string | null; rhs: string | null }
  | { k: 'not'; of: Cond }
  | { k: 'and' | 'or'; of: Cond[] };

interface Tok {
  t: 'str' | 'word' | 'num' | 'op' | 'open' | 'close' | 'comma' | 'other';
  v: string;
  s: number;
  e: number;
}

const WORD_RE = /[A-Za-z_$][\w$]*/y;
const NUMBER_RE = /\d+(?:\.\d+)?/y;
const TWO_CHAR_OPS = new Set(['&&', '||', '==', '!=', '<=', '>=', '<>']);
const COMPARISON_OPS: Readonly<Record<string, string>> = {
  '==': 'eq',
  '!=': 'neq',
  '<>': 'neq',
  '<': 'lt',
  '>': 'gt',
  '<=': 'lte',
  '>=': 'gte',
};
const COMPARISON_WORDS: Readonly<Record<string, string>> = {
  eq: 'eq',
  is: 'eq',
  neq: 'neq',
  gt: 'gt',
  lt: 'lt',
  gte: 'gte',
  ge: 'gte',
  lte: 'lte',
  le: 'lte',
  contains: 'contains',
  does: 'ncontains',
};
const OPERAND_STOP_OPS = new Set(['&&', '||', '!', ...Object.keys(COMPARISON_OPS)]);
const OPERAND_STOP_WORDS = new Set(['and', 'or', 'not', ...Object.keys(COMPARISON_WORDS)]);

function tokenizeCondition(text: string): Tok[] {
  const toks: Tok[] = [];
  let j = 0;
  while (j < text.length) {
    const c = text.charAt(j);
    if (/\s/.test(c)) {
      j++;
      continue;
    }
    if (c === '"' || c === "'") {
      const e = skipString(text, j);
      toks.push({ t: 'str', v: text.slice(j, e), s: j, e });
      j = e;
      continue;
    }
    WORD_RE.lastIndex = j;
    NUMBER_RE.lastIndex = j;
    const word = WORD_RE.exec(text);
    const num = word === null ? NUMBER_RE.exec(text) : null;
    const two = text.slice(j, j + 2);
    let tok: Tok;
    if (word !== null) tok = { t: 'word', v: word[0].toLowerCase(), s: j, e: j + word[0].length };
    else if (num !== null) tok = { t: 'num', v: num[0], s: j, e: j + num[0].length };
    else if (TWO_CHAR_OPS.has(two)) tok = { t: 'op', v: two, s: j, e: j + 2 };
    else if (c === '!' || c === '<' || c === '>') tok = { t: 'op', v: c, s: j, e: j + 1 };
    else if (OPENERS[c] !== undefined) tok = { t: 'open', v: c, s: j, e: j + 1 };
    else if (c === ')' || c === ']' || c === '}') tok = { t: 'close', v: c, s: j, e: j + 1 };
    else if (c === ',') tok = { t: 'comma', v: c, s: j, e: j + 1 };
    else tok = { t: 'other', v: c, s: j, e: j + 1 };
    toks.push(tok);
    j = tok.e;
  }
  return toks;
}

/** Recursive-descent parser of one condition; throws on a shape it cannot split into atoms. */
class ConditionParser {
  private i = 0;

  constructor(
    private readonly text: string,
    private readonly toks: readonly Tok[],
  ) {}

  parse(): Cond {
    const c = this.or();
    if (this.i !== this.toks.length) throw new Error(`unexpected token at ${this.i}`);
    return c;
  }

  private tok(at = this.i): Tok | undefined {
    return this.toks[at];
  }

  private isBool(t: Tok | undefined, op: string, word: string): boolean {
    return t !== undefined && ((t.t === 'op' && t.v === op) || (t.t === 'word' && t.v === word));
  }

  private or(): Cond {
    const parts = [this.and()];
    while (this.isBool(this.tok(), '||', 'or')) {
      this.i++;
      parts.push(this.and());
    }
    return parts.length === 1 && parts[0] !== undefined ? parts[0] : { k: 'or', of: parts };
  }

  private and(): Cond {
    const parts = [this.not()];
    while (this.isBool(this.tok(), '&&', 'and')) {
      this.i++;
      parts.push(this.not());
    }
    return parts.length === 1 && parts[0] !== undefined ? parts[0] : { k: 'and', of: parts };
  }

  private not(): Cond {
    if (this.isBool(this.tok(), '!', 'not')) {
      this.i++;
      return { k: 'not', of: this.not() };
    }
    return this.comparison();
  }

  /** Index of the token closing the bracket token at `at`. */
  private closeOf(at: number): number {
    let depth = 0;
    for (let j = at; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t?.t === 'open') depth++;
      else if (t?.t === 'close' && --depth === 0) return j;
    }
    throw new Error('unbalanced brackets');
  }

  private stopsOperand(t: Tok | undefined): boolean {
    if (t === undefined || t.t === 'close' || t.t === 'comma') return true;
    if (t.t === 'op') return OPERAND_STOP_OPS.has(t.v);
    return t.t === 'word' && OPERAND_STOP_WORDS.has(t.v);
  }

  private comparison(): Cond {
    const start = this.i;
    const first = this.tok();
    if (first?.t === 'open' && first.v === '(') {
      const after = this.tok(this.closeOf(this.i) + 1);
      const endsGroup = after === undefined || after.t === 'close' || after.t === 'comma';
      if (endsGroup || this.isBool(after, '&&', 'and') || this.isBool(after, '||', 'or')) {
        this.i++;
        const inner = this.or();
        if (this.tok()?.t !== 'close') throw new Error('unclosed group');
        this.i++;
        return inner;
      }
    }
    const lhsEnd = this.operand();
    const op = this.comparisonOp();
    if (op === null) return this.atom(start, lhsEnd, null, lhsEnd, lhsEnd);
    const rhsStart = this.i;
    const rhsEnd = this.operand();
    return this.atom(start, lhsEnd, op, rhsStart, rhsEnd);
  }

  private operand(): number {
    const from = this.i;
    while (!this.stopsOperand(this.tok())) {
      this.i = this.tok()?.t === 'open' ? this.closeOf(this.i) + 1 : this.i + 1;
    }
    if (this.i === from) throw new Error('empty operand');
    return this.i;
  }

  private comparisonOp(): string | null {
    const t = this.tok();
    if (t === undefined) return null;
    if (t.t === 'op' && COMPARISON_OPS[t.v] !== undefined) {
      this.i++;
      return COMPARISON_OPS[t.v] ?? null;
    }
    if (t.t !== 'word' || COMPARISON_WORDS[t.v] === undefined) return null;
    this.i++;
    if (t.v === 'is' && this.tok()?.t === 'word' && this.tok()?.v === 'not') {
      this.i++;
      return 'neq';
    }
    if (t.v === 'does') {
      if (this.tok()?.v !== 'not' || this.tok(this.i + 1)?.v !== 'contain') throw new Error('does without not contain');
      this.i += 2;
    }
    return COMPARISON_WORDS[t.v] ?? null;
  }

  private slice(from: number, to: number): string {
    const a = this.toks[from];
    const b = this.toks[to - 1];
    return a === undefined || b === undefined ? '' : this.text.slice(a.s, b.e);
  }

  private atom(start: number, lhsEnd: number, op: string | null, rhsStart: number, rhsEnd: number): Cond {
    return {
      k: 'atom',
      text: collapse(this.slice(start, op === null ? lhsEnd : rhsEnd)),
      lhs: this.slice(start, lhsEnd),
      op,
      rhs: op === null ? null : this.slice(rhsStart, rhsEnd),
    };
  }
}

/** Parsed `text`; a condition the parser cannot split is one opaque atom. */
function parseCondition(text: string): Cond {
  try {
    return new ConditionParser(text, tokenizeCondition(text)).parse();
  } catch {
    return { k: 'atom', text: collapse(text), lhs: text, op: null, rhs: null };
  }
}

function and(of: Cond[]): Cond {
  return of.length === 1 && of[0] !== undefined ? of[0] : { k: 'and', of };
}

function or(of: Cond[]): Cond {
  return of.length === 1 && of[0] !== undefined ? of[0] : { k: 'or', of };
}

/** `c` with atoms replaced by `map` (undefined keeps the atom), folded where constants decide. */
function mapAtoms(c: Cond, map: (atom: Extract<Cond, { k: 'atom' }>) => Cond | undefined): Cond {
  switch (c.k) {
    case 'const':
      return c;
    case 'atom':
      return map(c) ?? c;
    case 'not': {
      const of = mapAtoms(c.of, map);
      return of.k === 'const' ? { k: 'const', v: !of.v } : { k: 'not', of };
    }
    case 'and':
    case 'or': {
      const absorbing = c.k === 'or';
      const parts: Cond[] = [];
      for (const part of c.of.map((p) => mapAtoms(p, map))) {
        if (part.k === 'const') {
          if (part.v === absorbing) return part;
        } else {
          parts.push(part);
        }
      }
      if (parts.length === 0) return { k: 'const', v: !absorbing };
      return c.k === 'and' ? and(parts) : or(parts);
    }
  }
}

function atomsOf(c: Cond, out: Array<Extract<Cond, { k: 'atom' }>> = []): Array<Extract<Cond, { k: 'atom' }>> {
  if (c.k === 'atom') out.push(c);
  else if (c.k === 'not') atomsOf(c.of, out);
  else if (c.k === 'and' || c.k === 'or') for (const p of c.of) atomsOf(p, out);
  return out;
}

// before() gates

/** What an atom of a gate tests: a membership, module grant or login, the requested action, a local flag, or unknown. */
type GateAtom =
  | { k: 'admin' | 's2' | 'loggedin' | 'unknown' }
  | { k: 'module'; id: string }
  | { k: 'action'; holds: (circuit: string, action: string) => boolean; names: (circuit: string) => string[] }
  | { k: 'flag'; name: string }
  | { k: 'const'; v: boolean };

// Membership lists as before() reads them: session.mura.memberships or $.currentUser().getMemberships().
const MEMBERSHIPS = String.raw`(?:session\.mura\.memberships|rc\.\$\.currentuser\(\)\.getmemberships\(\))`;
// The site's private user pool: settingsManager.getSite(rc.siteid).getPrivateUserPoolID() or $.siteConfig('privateUserPoolID').
const PRIVATE_POOL =
  String.raw`(?:settingsmanager\.getsite\(rc\.siteid\)\.getprivateuserpoolid\(\)` +
  String.raw`|rc\.\$\.siteconfig\((["'])privateuserpoolid\2\))`;
// listFind(memberships, 'Admin;#<private pool>#;0').
const ADMIN_ATOM = new RegExp(String.raw`^listfind(?:nocase)?\(${MEMBERSHIPS},(["'])admin;#${PRIVATE_POOL}#;0\1\)$`);
// listFind(memberships, 'S2').
const S2_ATOM = new RegExp(String.raw`^listfind(?:nocase)?\(${MEMBERSHIPS},(["'])s2\1\)$`);
// permUtility.getModulePerm('<35-digit module id>', rc.siteid).
const MODULE_ATOM = /^permutility\.getmoduleperm\((["'])\d{32}(\d{3})\1,rc\.siteid\)$/;
const LOGGEDIN_ATOM = /^session\.mura\.isloggedin$/;
const FLAG_ATOM = /^(?:rc|local)\.[\w$]+$/;
// listFindNoCase('<actions>', listLast(rc.muraAction, '.')).
const ACTION_LIST_ATOM = /^listfindnocase\((["'])([^"']*)\1,listlast\(rc\.muraaction,(["'])\.\3\)\)$/;
// listLast(rc.muraAction, ':'), the circuit-qualified action.
const QUALIFIED_ACTION_OPERAND = /^listlast\(rc\.muraaction,(["']):\1\)$/;
// listLast(rc.muraAction, '.'), the bare action.
const ACTION_OPERAND = /^listlast\(rc\.muraaction,(["'])\.\1\)$/;
const CONSTANTS: Readonly<Record<string, boolean>> = { true: true, yes: true, false: false, no: false };

/** Action names of `circuit` a comparison literal or list names. */
function namesIn(values: readonly string[], circuit: string, qualified: boolean): string[] {
  const out: string[] = [];
  for (const v of values) {
    const value = v.trim().toLowerCase();
    if (!qualified) out.push(value);
    else if (value.startsWith(`${circuit.toLowerCase()}.`)) out.push(value.slice(circuit.length + 1));
  }
  return out.filter((n) => n !== '');
}

/** Gate meaning of `atom`. */
function gateAtom(atom: Extract<Cond, { k: 'atom' }>): GateAtom {
  const lhs = normaliseExpression(atom.lhs).toLowerCase();
  if (atom.op === null) {
    if (CONSTANTS[lhs] !== undefined) return { k: 'const', v: CONSTANTS[lhs] ?? false };
    if (ADMIN_ATOM.test(lhs)) return { k: 'admin' };
    if (S2_ATOM.test(lhs)) return { k: 's2' };
    if (LOGGEDIN_ATOM.test(lhs)) return { k: 'loggedin' };
    const module = MODULE_ATOM.exec(lhs);
    if (module?.[2] !== undefined) return { k: 'module', id: module[2] };
    const list = ACTION_LIST_ATOM.exec(lhs);
    if (list?.[2] !== undefined) {
      const actions = list[2].split(',').map((a) => a.trim().toLowerCase());
      return { k: 'action', holds: (_c, action) => actions.includes(action.toLowerCase()), names: (c) => namesIn(actions, c, false) };
    }
    return FLAG_ATOM.test(lhs) ? { k: 'flag', name: lhs } : { k: 'unknown' };
  }
  if (atom.op !== 'eq' && atom.op !== 'neq') return { k: 'unknown' };
  const rhs = normaliseExpression(atom.rhs ?? '').toLowerCase();
  const [operand, literal] = literalValue(rhs) !== undefined ? [lhs, literalValue(rhs)] : [rhs, literalValue(lhs)];
  if (literal === undefined) return { k: 'unknown' };
  const qualified = QUALIFIED_ACTION_OPERAND.test(operand);
  if (!qualified && !ACTION_OPERAND.test(operand)) return { k: 'unknown' };
  const expected = literal.toLowerCase();
  const equal = atom.op === 'eq';
  return {
    k: 'action',
    holds: (circuit, action) => ((qualified ? `${circuit}.${action}` : action).toLowerCase() === expected) === equal,
    names: (c) => namesIn([expected], c, qualified),
  };
}

const atomMeanings = new WeakMap<object, GateAtom>();

function meaningOf(atom: Extract<Cond, { k: 'atom' }>): GateAtom {
  let meaning = atomMeanings.get(atom);
  if (meaning === undefined) {
    meaning = gateAtom(atom);
    atomMeanings.set(atom, meaning);
  }
  return meaning;
}

/** Truth-table key of a membership, module or login atom; null for any other atom. */
function atomKey(meaning: GateAtom): string | null {
  switch (meaning.k) {
    case 'admin':
      return 'A';
    case 's2':
      return 'S';
    case 'loggedin':
      return 'L';
    case 'module':
      return `M:${meaning.id}`;
    default:
      return null;
  }
}

type Assignment = ReadonlyMap<string, boolean>;

function evaluate(c: Cond, assignment: Assignment): boolean {
  switch (c.k) {
    case 'const':
      return c.v;
    case 'atom': {
      const key = atomKey(meaningOf(c));
      return key !== null && assignment.get(key) === true;
    }
    case 'not':
      return !evaluate(c.of, assignment);
    case 'and':
      return c.of.every((p) => evaluate(p, assignment));
    case 'or':
      return c.of.some((p) => evaluate(p, assignment));
  }
}

/** Whether `deny` and `candidate` agree on every assignment of `keys`. */
function equivalent(deny: Cond, candidate: (a: Assignment) => boolean, keys: readonly string[]): boolean {
  for (let bits = 0; bits < 1 << keys.length; bits++) {
    const assignment = new Map(keys.map((k, i) => [k, (bits & (1 << i)) !== 0] as const));
    if (evaluate(deny, assignment) !== candidate(assignment)) return false;
  }
  return true;
}

/** Module id substituted for `m:X` in a pattern's role, and whether a single module grant replaces the module pair. */
interface PatternMatch {
  module?: string;
  single?: boolean;
}

const ADMIN_OR_S2 = (a: Assignment): boolean => a.get('A') === true || a.get('S') === true;

/** The deny condition each extractor pattern names, over the membership (A, S2), login (L) and module (M:nnn) atoms. */
function matchPattern(id: GatePatternId, deny: Cond, keys: ReadonlySet<string>): PatternMatch | null {
  const modules = [...keys].filter((k) => k.startsWith('M:')).sort(compareText);
  const others = [...keys].filter((k) => !k.startsWith('M:'));
  const universe = (...extra: string[]): string[] => [...new Set([...keys, 'A', 'S', 'L', ...extra])].sort(compareText);
  const membershipsOnly = others.every((k) => k === 'A' || k === 'S');
  switch (id) {
    case 'P0':
      return null;
    case 'P1':
      return modules.length === 0 && membershipsOnly && equivalent(deny, (a) => !ADMIN_OR_S2(a), universe()) ? {} : null;
    case 'P3':
      return modules.length === 0 && membershipsOnly && equivalent(deny, (a) => a.get('S') !== true, universe()) ? {} : null;
    case 'P5':
      return modules.length === 0 && others.every((k) => k === 'L') && equivalent(deny, (a) => a.get('L') !== true, universe()) ? {} : null;
    case 'P4': {
      const [m] = modules;
      if (m === undefined || modules.length !== 1 || others.length > 0) return null;
      return equivalent(deny, (a) => a.get(m) !== true, universe()) ? { module: m.slice(2) } : null;
    }
    case 'P2': {
      if (!membershipsOnly) return null;
      if (modules.length === 1 && modules[0] !== undefined) {
        const m = modules[0];
        return equivalent(deny, (a) => !ADMIN_OR_S2(a) && a.get(m) !== true, universe()) ? { module: m.slice(2), single: true } : null;
      }
      const x = modules.find((k) => k !== 'M:000');
      if (modules.length !== 2 || x === undefined || !modules.includes('M:000')) return null;
      const both = (a: Assignment): boolean => a.get(x) === true && a.get('M:000') === true;
      const matched =
        equivalent(deny, (a) => !ADMIN_OR_S2(a) && !both(a), universe()) || equivalent(deny, (a) => !both(a), universe());
      return matched ? { module: x.slice(2) } : null;
    }
  }
}

/** A pattern's role with `m:X` bound; a single grant replaces the `allOf` that pairs `m:X` with another grant. */
function instantiateRole(role: RequiredRole, match: PatternMatch): RequiredRole {
  if (typeof role === 'string') {
    if (role !== 'm:X') return role;
    if (match.module === undefined) throw new Error('extractor pattern role names m:X without a matched module');
    return `m:${match.module}`;
  }
  if ('allOf' in role && match.single === true && role.allOf.includes('m:X')) return instantiateRole('m:X', match);
  const key = 'anyOf' in role ? 'anyOf' : 'allOf';
  const terms = ('anyOf' in role ? role.anyOf : role.allOf).map((r) => instantiateRole(r, match));
  const distinct = terms.filter((t, i) => terms.findIndex((u) => JSON.stringify(u) === JSON.stringify(t)) === i);
  if (distinct.length === 1 && distinct[0] !== undefined) return distinct[0];
  return key === 'anyOf' ? { anyOf: distinct } : { allOf: distinct };
}

/** One guard of a script region: an `if` condition, negated for the `else`/`else if` branches that follow it. */
interface GuardTerm {
  text: string;
  negate: boolean;
}

/** A script `if`/`else` body: `[start, end)` offsets, its header offset and every guard from the outermost in. */
interface Region {
  start: number;
  end: number;
  header: number;
  guards: GuardTerm[];
}

/** Body of the statement starting at or after `from`: a `{…}` block, or a single statement up to `;`. */
function statementBody(text: string, from: number): { start: number; end: number; next: number } {
  const j = skipSpace(text, from);
  if (text.charAt(j) === '{') {
    const close = matchClose(text, j);
    return close < 0 ? { start: j + 1, end: text.length, next: text.length } : { start: j + 1, end: close, next: close + 1 };
  }
  for (let k = j; k < text.length; k++) {
    const c = text.charAt(k);
    if (c === '"' || c === "'") k = skipString(text, k) - 1;
    else if (OPENERS[c] !== undefined) k = Math.max(k, matchClose(text, k));
    else if (c === ';') return { start: j, end: k, next: k + 1 };
  }
  return { start: j, end: text.length, next: text.length };
}

/** Every `if`/`else if`/`else` body of a cfscript text. */
function scriptRegions(text: string): Region[] {
  const out: Region[] = [];
  const scan = (from: number, to: number, outer: readonly GuardTerm[]): void => {
    for (let j = from; j < to; j++) {
      const c = text.charAt(j);
      if (c === '"' || c === "'") {
        j = skipString(text, j) - 1;
        continue;
      }
      if (!wordAt(text, j, 'if')) continue;
      let header = j;
      let at = j;
      const chain: string[] = [];
      for (;;) {
        const open = skipSpace(text, at + 2);
        const close = text.charAt(open) === '(' ? matchClose(text, open) : -1;
        if (close < 0) break;
        const cond = text.slice(open + 1, close);
        const body = statementBody(text, close + 1);
        const guards = [...outer, ...chain.map((t) => ({ text: t, negate: true })), { text: cond, negate: false }];
        out.push({ start: body.start, end: body.end, header, guards });
        scan(body.start, body.end, guards);
        chain.push(cond);
        j = body.next - 1;
        const next = skipSpace(text, body.next);
        if (!wordAt(text, next, 'else')) break;
        const afterElse = skipSpace(text, next + 4);
        if (wordAt(text, afterElse, 'if')) {
          header = next;
          at = afterElse;
          continue;
        }
        const elseBody = statementBody(text, next + 4);
        const elseGuards = [...outer, ...chain.map((t) => ({ text: t, negate: true }))];
        out.push({ start: elseBody.start, end: elseBody.end, header: next, guards: elseGuards });
        scan(elseBody.start, elseBody.end, elseGuards);
        j = elseBody.next - 1;
        break;
      }
    }
  };
  scan(0, text.length, []);
  return out;
}

/** The innermost region holding `offset`. */
function regionAt(regions: readonly Region[], offset: number): Region | undefined {
  let best: Region | undefined;
  for (const r of regions) if (r.start <= offset && offset < r.end && (best === undefined || r.start >= best.start)) best = r;
  return best;
}

/** A `secure()` call of `before()` and the condition under which it runs. */
interface SecureSite {
  cond: Cond;
  text: string;
  /** Body offset of the guarding region's header, or of the call when it is unguarded. */
  at: number;
  source: SourceRef;
}

/** What `before()` of one circuit gates. */
interface BeforeAnalysis {
  path: string;
  /** The `before()` span, or the declaration line when there is none. */
  span: SourceRef;
  hasBefore: boolean;
  /** False for a tag-syntax `before()` that calls `secure()`, which the script scanner does not read. */
  analysable: boolean;
  sites: SecureSite[];
  /** Body offset of the first statement that assigns `rc.siteid` a default. */
  siteDefaultAt: number | null;
}

// secure() calls, bare or through this., variables. or super.
const SECURE_CALL = /(?<![\w$.])(?:(?:this|variables|super)\s*\.\s*)?secure\s*\(/gi;
// `(arguments.)rc.x = …` and `local.x = …` assignments whose flags a gate may read.
const FLAG_ASSIGNMENT = /(?<![\w$.])((?:arguments\.)?rc\.[\w$]+|local\.[\w$]+)\s*=(?!=)/gi;
// A `param` of rc.siteid, or an assignment to it.
const SITE_DEFAULT = [
  /(?<![\w$.])param\b[^;]*?\bname\s*=\s*(["'])(?:arguments\.)?rc\.siteid\1/i,
  /<cfparam\b[^>]*\bname\s*=\s*(["'])(?:arguments\.)?rc\.siteid\1/i,
  /(?<![\w$.])(?:arguments\.)?rc\.siteid\s*=(?!=)/i,
];

/** Flag assignments of a script body: normalised target, body offset and value expression. */
function flagAssignments(body: string): Array<{ name: string; at: number; expr: string }> {
  return codeMatches(body, FLAG_ASSIGNMENT).map((m) => {
    const end = statementBody(body, m.index + m[0].length).end;
    return { name: normaliseExpression(m[1] ?? '').toLowerCase(), at: m.index, expr: body.slice(m.index + m[0].length, end) };
  });
}

/** `cond` with each local flag replaced by the value assigned to it before `at`. */
function resolveFlags(cond: Cond, assignments: ReturnType<typeof flagAssignments>, at: number, depth = 0): Cond {
  if (depth > 3) return cond;
  return mapAtoms(cond, (atom) => {
    const meaning = meaningOf(atom);
    if (meaning.k !== 'flag') return undefined;
    const assigned = assignments.filter((a) => a.name === meaning.name && a.at < at).at(-1);
    return assigned === undefined ? undefined : resolveFlags(parseCondition(assigned.expr), assignments, assigned.at, depth + 1);
  });
}

function guardCond(terms: readonly GuardTerm[]): Cond {
  if (terms.length === 0) return { k: 'const', v: true };
  return and(terms.map((t): Cond => (t.negate ? { k: 'not', of: parseCondition(t.text) } : parseCondition(t.text))));
}

function guardText(terms: readonly GuardTerm[]): string {
  if (terms.length === 0) return 'true';
  return terms.map((t) => (t.negate ? `!(${collapse(t.text)})` : collapse(t.text))).join(' && ');
}

/** The `secure()` calls of `component`'s `before()`, with their guards. */
function analyseBefore(component: CfmlComponent): BeforeAnalysis {
  const p = component.path;
  const fn = component.functions.find((f) => f.name.toLowerCase() === 'before');
  if (fn === undefined) {
    const line = component.declaration.line;
    return { path: p, span: { path: p, lines: [line, line] }, hasBefore: false, analysable: true, sites: [], siteDefaultAt: null };
  }
  const span: SourceRef = { path: p, lines: [fn.startLine, fn.endLine] };
  const calls = codeMatches(fn.body, SECURE_CALL);
  const mode = fn.mode ?? (component.syntax === 'tag' ? 'tag' : 'script');
  if (mode === 'tag') {
    return { path: p, span, hasBefore: true, analysable: calls.length === 0, sites: [], siteDefaultAt: null };
  }
  const line = (offset: number): number => fn.bodyLine - 1 + lineOf(fn.body, offset);
  const regions = scriptRegions(fn.body);
  const assignments = flagAssignments(fn.body);
  const sites = calls.map((m): SecureSite => {
    const region = regionAt(regions, m.index);
    const terms = region?.guards ?? [];
    const at = region?.header ?? m.index;
    const lines: [number, number] = region === undefined ? [line(m.index), line(m.index)] : [line(region.header), line(region.end)];
    return { cond: resolveFlags(guardCond(terms), assignments, m.index), text: guardText(terms), at, source: { path: p, lines } };
  });
  const defaults = SITE_DEFAULT.flatMap((re) => {
    const m = re.exec(fn.body);
    return m === null ? [] : [m.index];
  });
  return { path: p, span, hasBefore: true, analysable: true, sites, siteDefaultAt: defaults.length > 0 ? Math.min(...defaults) : null };
}

/** The gate one action passes before an override: its pattern and role, or unclassified. */
interface ExtractedGate {
  gate: string;
  classification: RequiredRole | null;
  pattern: GatePatternId | null;
  unclassified: boolean;
  source: SourceRef;
}

/** A request action matching no literal of any action test. */
const OTHER_ACTION = '\u0000';

/** `cond` with every test of the requested action decided for `circuit`.`action`. */
function forAction(cond: Cond, circuit: string, action: string): Cond {
  return mapAtoms(cond, (atom) => {
    const meaning = meaningOf(atom);
    if (meaning.k === 'action') return { k: 'const', v: meaning.holds(circuit, action) };
    return meaning.k === 'const' ? { k: 'const', v: meaning.v } : undefined;
  });
}

/** Classifies the gate `before()` applies to `action` against the extractor patterns, in file order. */
function classifyGate(analysis: BeforeAnalysis, circuit: string, action: string, patterns: readonly ExtractorPattern[]): ExtractedGate {
  const applicable = analysis.sites
    .map((site) => ({ site, deny: forAction(site.cond, circuit, action) }))
    .filter(({ deny }) => !(deny.k === 'const' && !deny.v));
  if (applicable.length === 0) {
    const p0 = patterns.find((p) => p.id === 'P0');
    const gate = analysis.hasBefore ? 'before() calls no secure()' : 'no before()';
    const source = analysis.span;
    if (p0 === undefined || !analysis.analysable) return { gate, classification: null, pattern: null, unclassified: true, source };
    return { gate, classification: p0.requiredRole, pattern: 'P0', unclassified: false, source };
  }
  const lines = applicable.flatMap(({ site }) => site.source.lines);
  const source: SourceRef = { path: analysis.path, lines: [Math.min(...lines), Math.max(...lines)] };
  const unclassified: ExtractedGate = {
    gate: applicable.map(({ site }) => site.text).join(' || '),
    classification: null,
    pattern: null,
    unclassified: true,
    source,
  };
  const deny = or(applicable.map(({ deny }) => deny));
  const keys = new Set<string>();
  for (const atom of atomsOf(deny)) {
    const key = atomKey(meaningOf(atom));
    if (key === null) return unclassified;
    keys.add(key);
  }
  if (keys.size === 0) return unclassified;
  const readsSite = [...keys].some((k) => k === 'A' || k.startsWith('M:'));
  const defaultAt = analysis.siteDefaultAt;
  if (readsSite && defaultAt !== null && applicable.some(({ site }) => defaultAt < site.at)) return unclassified;
  for (const pattern of patterns) {
    const match = matchPattern(pattern.id, deny, keys);
    if (match !== null) {
      return { ...unclassified, classification: instantiateRole(pattern.requiredRole, match), pattern: pattern.id, unclassified: false };
    }
  }
  return unclassified;
}

/** Lower-cased action names the action tests of `before()` single out. */
function namedActions(analysis: BeforeAnalysis, circuit: string): string[] {
  const names = new Set<string>();
  for (const site of analysis.sites) {
    for (const atom of atomsOf(site.cond)) {
      const meaning = meaningOf(atom);
      if (meaning.k === 'action') for (const n of meaning.names(circuit)) names.add(n);
    }
  }
  return [...names].sort(compareText);
}

/** Override reference as the inventory records it. */
function overrideRef(o: RoleOverride): string {
  return `${ROLE_OVERRIDES_REF}#${o.id}`;
}

/** The reviewed override of `circuit`.`action`, else of `circuit`.*; `action` null looks up the wildcard only. */
function overrideFor(overrides: readonly RoleOverride[], circuit: string, action: string | null): RoleOverride | undefined {
  const c = circuit.toLowerCase();
  const exact = action === null ? undefined : overrides.find((o) => o.circuit.toLowerCase() === c && o.action.toLowerCase() === action);
  return exact ?? overrides.find((o) => o.circuit.toLowerCase() === c && o.action === '*');
}

/** `gate` settled by `o`: the reviewed role replaces the extracted one and its conditions are copied through. */
function settle(gate: ExtractedGate, o: RoleOverride | undefined): RoleGate {
  if (o === undefined) return { ...gate, override: null };
  // `source` stays the extracted gate span; the override reference locates the reviewed gate.
  const settled: RoleGate = { ...gate, classification: o.requiredRole, unclassified: false, override: overrideRef(o) };
  if (o.siteFrom !== undefined) settled.siteFrom = [...o.siteFrom];
  if (o.when !== undefined) settled.when = o.when;
  if (o.nodePermission !== undefined) settled.nodePermission = o.nodePermission;
  if (o.denial !== undefined) settled.denial = o.denial;
  return settled;
}

function sameGate(a: ExtractedGate, b: ExtractedGate): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A gate branch for the actions an action test of `before()` names. */
interface NamedBranch {
  actions: string[];
  gate: ExtractedGate;
}

/** The gate of actions no action test names, and one branch per distinct gate of the actions the tests name. */
function gateBranches(
  analysis: BeforeAnalysis,
  circuit: string,
  patterns: readonly ExtractorPattern[],
): { fallback: ExtractedGate; named: NamedBranch[] } {
  const fallback = classifyGate(analysis, circuit, OTHER_ACTION, patterns);
  const named: NamedBranch[] = [];
  for (const name of namedActions(analysis, circuit)) {
    const gate = classifyGate(analysis, circuit, name, patterns);
    if (sameGate(gate, fallback)) continue;
    const branch = named.find((b) => sameGate(b.gate, gate));
    if (branch === undefined) named.push({ actions: [name], gate });
    else branch.actions.push(name);
  }
  return { fallback, named };
}

// Circuits, actions and views

function sourceRef(p: string, from: number, to: number): SourceRef {
  return { path: p, lines: [from, Math.max(from, to)] };
}

function isTruthyAttribute(value: string | undefined): boolean {
  return value !== undefined && ['true', 'yes'].includes(value.trim().toLowerCase());
}

/** The functions of a circuit that are actions, and every function or generated accessor that is not. */
function methodActions(component: CfmlComponent): { actions: CfmlFunction[]; excluded: ExcludedMethod[] } {
  const actions: CfmlFunction[] = [];
  const excluded: ExcludedMethod[] = [];
  for (const fn of component.functions) {
    let reason: ExclusionReason | undefined = LIFECYCLE_METHODS[fn.name.toLowerCase()];
    if (reason === undefined && !CALLABLE_ACCESS.has(fn.access.toLowerCase())) reason = 'not-public';
    if (reason === undefined && /^set[A-Z]/.test(fn.name) && fn.args.length === 1) reason = 'di-setter';
    if (reason === undefined) actions.push(fn);
    else excluded.push({ name: fn.name, reason, source: sourceRef(component.path, fn.startLine, fn.endLine) });
  }
  if (isTruthyAttribute(component.declaration.attrs.accessors)) {
    const declared = new Set(component.functions.map((f) => f.name.toLowerCase()));
    for (const prop of component.properties) {
      const suffix = prop.name.charAt(0).toUpperCase() + prop.name.slice(1);
      for (const name of [`get${suffix}`, `set${suffix}`]) {
        if (!declared.has(name.toLowerCase())) {
          excluded.push({ name, reason: 'accessor', source: sourceRef(component.path, prop.line, prop.line) });
        }
      }
    }
  }
  excluded.sort((a, b) => compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.name, b.name));
  return { actions, excluded };
}

/** The template an include names from `from`; null for a dynamic or mapping-relative template. */
function includeTarget(from: string, template: string): string | null {
  if (template.includes('#') || template.startsWith('/')) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), template));
  return target.startsWith('../') ? null : target;
}

/** A circuit's views folder: its direct `.cfm` files, its subfolders, who includes each template and each include's line. */
interface ViewFolder {
  files: string[];
  subfolders: string[];
  includedBy: Map<string, string[]>;
  includes: Map<string, SourceRef[]>;
}

function viewFolder(tree: SourceTree, circuit: string): ViewFolder {
  const dir = `${VIEWS_DIR}/${circuit}`;
  const all = tree.list(dir, { recursive: true });
  const nested = (p: string): boolean => p.slice(dir.length + 1).includes('/');
  const isCfm = (p: string): boolean => p.toLowerCase().endsWith('.cfm');
  const files = all.filter((p) => isCfm(p) && !nested(p));
  const subfolders = [...new Set(all.filter(nested).map((p) => `${dir}/${p.slice(dir.length + 1).split('/')[0] ?? ''}`))].sort(compareText);
  const includedBy = new Map<string, string[]>();
  const includes = new Map<string, SourceRef[]>();
  for (const p of all.filter(isCfm)) {
    for (const inc of parseCfmTemplate(p, tree.readText(p)).functions[0]?.includes ?? []) {
      const target = includeTarget(p, inc.template);
      if (target === null || target === p) continue;
      const key = target.toLowerCase();
      const by = includedBy.get(key) ?? [];
      if (!by.includes(p)) by.push(p);
      includedBy.set(key, by);
      includes.set(key, [...(includes.get(key) ?? []), sourceRef(p, inc.line, inc.line)]);
    }
  }
  return { files, subfolders, includedBy, includes };
}

function viewName(p: string): string {
  return path.posix.basename(p).replace(/\.cfm$/i, '');
}

/** Comment-stripped text of the template `rel` with the text of each static include spliced in before its tag. */
function expandTemplate(tree: SourceTree, rel: string, cache: Map<string, string>, seen: ReadonlySet<string> = new Set()): string {
  const cached = cache.get(rel);
  if (cached !== undefined) return cached;
  const unit = parseCfmTemplate(rel, tree.readText(rel));
  let text = unit.text;
  for (const inc of [...(unit.functions[0]?.includes ?? [])].reverse()) {
    const target = includeTarget(rel, inc.template);
    if (target === null || seen.has(target) || !tree.exists(target)) continue;
    text = text.slice(0, inc.offset) + expandTemplate(tree, target, cache, new Set([...seen, rel])) + text.slice(inc.offset);
  }
  if (seen.size === 0) cache.set(rel, text);
  return text;
}

/** Folders searched for references that address an admin action, and the folder skipped within them. */
const ACTION_REFERENCE_ROOTS: readonly string[] = ['admin', 'core'];
const ACTION_REFERENCE_SKIP = 'core/vendor/';

/** An optionally `core:`-qualified `<circuit>.<action>` literal; groups 1 and 2 are circuit and action. */
const ACTION_LITERAL = String.raw`(?:core:)?([A-Za-z_]\w*)\.([A-Za-z_]\w*)(?![\w$]|\.\w)`;
const ACTION_PARAM = '(?:muraAction|fuseaction)';

/** Literal action references: a URL or script value, a form field in either attribute order, an FW/1 redirect, buildURL or setView. */
const ACTION_REFERENCES: readonly RegExp[] = [
  new RegExp(String.raw`\b${ACTION_PARAM}\s*[=:]\s*["']?${ACTION_LITERAL}`, 'gi'),
  new RegExp(String.raw`\bname\s*=\s*["']${ACTION_PARAM}["'][^<>]*?\bvalue\s*=\s*["']${ACTION_LITERAL}`, 'gi'),
  new RegExp(String.raw`\bvalue\s*=\s*["']${ACTION_LITERAL}["'][^<>]*?\bname\s*=\s*["']${ACTION_PARAM}["']`, 'gi'),
  new RegExp(String.raw`\b(?:redirect|buildURL|setView)\s*\(\s*(?:action\s*=\s*)?["']${ACTION_LITERAL}`, 'gi'),
];

/** Text searched for action references: CFML with its comments blanked, script files as they are. */
function referenceText(p: string, text: string): string {
  const lower = p.toLowerCase();
  if (lower.endsWith('.cfm')) return stripComments(text, 'tag');
  return lower.endsWith('.cfc') ? stripComments(text, detectMode(text)) : text;
}

/** Literal action references in the `.cfm`, `.cfc` and `.js` files of {@link ACTION_REFERENCE_ROOTS}, by lower-cased action. */
function scanActionReferences(tree: SourceTree): Map<string, SourceRef[]> {
  const found = new Map<string, Map<string, SourceRef>>();
  for (const root of ACTION_REFERENCE_ROOTS) {
    for (const p of tree.list(root, { ext: ['cfm', 'cfc', 'js'], recursive: true })) {
      if (p.startsWith(ACTION_REFERENCE_SKIP)) continue;
      const text = referenceText(p, tree.readText(p));
      for (const re of ACTION_REFERENCES) {
        for (const m of text.matchAll(re)) {
          const ref = sourceRef(p, lineOf(text, m.index), lineOf(text, m.index + m[0].length - 1));
          const key = `${m[1] ?? ''}.${m[2] ?? ''}`.toLowerCase();
          const refs = found.get(key) ?? new Map<string, SourceRef>();
          refs.set(`${ref.path}:${String(ref.lines[0])}:${String(ref.lines[1])}`, ref);
          found.set(key, refs);
        }
      }
    }
  }
  const byPlace = (a: SourceRef, b: SourceRef): number => compareText(a.path, b.path) || a.lines[0] - b.lines[0] || a.lines[1] - b.lines[1];
  return new Map([...found].map(([key, refs]) => [key, [...refs.values()].sort(byPlace)]));
}

// Variants and write closures

type PredicateValue = Predicates[string];

/** Closure predicates under which `c` holds, one per alternative; null when `c` has no predicate form. */
function conditionAlternatives(c: VariantCondition): Predicates[] | null {
  if ('anyOf' in c) {
    const alternatives = c.anyOf.map(conditionAlternatives);
    return alternatives.some((a) => a === null) ? null : alternatives.flatMap((a) => a ?? []);
  }
  if ('not' in c || 'multipartExtensionIn' in c || 'sessionManaged' in c || 'startupSiteId' in c || 'listItemIn' in c) return null;
  if ('equals' in c) return [{ [c.param]: c.equals }];
  if ('in' in c) return c.in.map((v) => ({ [c.param]: v }));
  return [{ [c.param]: 'nonEmpty' in c ? true : CFML_TRUTHY }];
}

/** Both values of a CFML-truthy predicate and another on one parameter; undefined when they contradict. */
function conjoinTruthy(prev: PredicateValue, value: PredicateValue): PredicateValue | undefined {
  const other = isTruthyPredicate(prev) ? value : prev;
  if (isTruthyPredicate(other) || other === true) return CFML_TRUTHY;
  return typeof other === 'string' && cfTruthyText(other) ? other : undefined;
}

/** Both predicate sets at once, or null when they contradict. */
function conjoin(a: Predicates, b: Predicates): Predicates | null {
  const out: Record<string, PredicateValue> = { ...a };
  for (const [name, value] of Object.entries(b)) {
    const key = Object.keys(out).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
    const prev = out[key];
    const sameText = typeof prev === 'string' && typeof value === 'string' && prev.toLowerCase() === value.toLowerCase();
    if (prev !== undefined && (isTruthyPredicate(prev) || isTruthyPredicate(value))) {
      const both = conjoinTruthy(prev, value);
      if (both === undefined) return null;
      out[key] = both;
    } else if (prev === undefined || prev === value) out[key] = value;
    else if (prev === true && typeof value === 'string' && value !== '') out[key] = value;
    else if (!sameText && !(value === true && typeof prev === 'string' && prev !== '')) return null;
  }
  return out;
}

/** Disjunctive normal form of a conjunction of alternatives, dropping contradictory combinations. */
function disjunctiveForm(conjunction: readonly Predicates[][]): Predicates[] {
  let dnf: Predicates[] = [{}];
  for (const alternatives of conjunction) {
    dnf = dnf.flatMap((d) => alternatives.map((alt) => conjoin(d, alt)).filter((p): p is Predicates => p !== null));
  }
  return dnf;
}

/** Predicates of a variant's own branch; a condition without a predicate form constrains nothing (over-approximated). */
function branchPredicates(when: readonly VariantCondition[]): Predicates[] {
  return disjunctiveForm(when.map(conditionAlternatives).filter((a): a is Predicates[] => a !== null));
}

/** Predicates a less specific branch excludes; a variant with a condition that cannot be stated is not excluded, never narrowed. */
function exclusionPredicates(when: readonly VariantCondition[]): Predicates[] {
  const conjunction = when.map(conditionAlternatives);
  return conjunction.some((a) => a === null) ? [] : disjunctiveForm(conjunction.filter((a): a is Predicates[] => a !== null));
}

/** Parameters and upload names of a request that satisfies `when`, for keying the variant through the platform. */
function satisfyingRequest(when: readonly VariantCondition[]): {
  params: Record<string, string>;
  multipartFileNames: Array<{ field: string; filename: string }>;
} {
  const params: Record<string, string> = {};
  const multipartFileNames: Array<{ field: string; filename: string }> = [];
  const satisfy = (c: VariantCondition): void => {
    if ('anyOf' in c) {
      const first = c.anyOf[0];
      if (first !== undefined) satisfy(first);
    } else if ('multipartExtensionIn' in c) {
      const ext = c.multipartExtensionIn[0];
      if (ext !== undefined) multipartFileNames.push({ field: 'file', filename: `upload.${ext}` });
    } else if ('not' in c || 'sessionManaged' in c) {
      // An admin request is always session-managed (applicationSettings.cfm:179).
      return;
    } else if ('startupSiteId' in c) {
      // Legacy's own default site, which every install has.
      params.siteid ||= 'default';
    } else if ('equals' in c) {
      params[c.param] = c.equals;
    } else if ('in' in c) {
      params[c.param] = c.in[0] ?? '';
    } else if ('listItemIn' in c) {
      params[c.param] = c.listItemIn[0] ?? '';
    } else {
      params[c.param] = 'nonEmpty' in c ? params[c.param] || 'x' : 'true';
    }
  };
  when.forEach(satisfy);
  return { params, multipartFileNames };
}

const SESSION_RANK: Readonly<Record<SessionEffects, number>> = { none: 0, relogin: 1, login: 2, logout: 3 };

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

const EMPTY_CLOSURE: WriteClosure = Object.freeze({
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
}) as WriteClosure;

/** Union of closures in closure.ts order: an unconditional sighting of a write or file-store call wins over a conditional one. */
function mergeClosures(closures: readonly WriteClosure[]): WriteClosure {
  if (closures.length === 0) return EMPTY_CLOSURE;
  if (closures.length === 1 && closures[0] !== undefined) return closures[0];
  const writes = new Map<string, ClosureWrite>();
  const conditional = new Map<string, ConditionalWrite>();
  const evidence = new Map<string, FileStoreEvidence>();
  const threads = new Map<string, WriteClosure['threads'][number]>();
  const unresolved = new Map<string, UnresolvedRef>();
  const overrides = new Set<string>();
  const visited = new Set<string>();
  let session: SessionEffects = 'none';
  for (const c of closures) {
    for (const w of c.writes) {
      const key = JSON.stringify([w.table, w.op, w.component, w.method, w.source, w.trigger, w.override ?? '']);
      const prev = writes.get(key);
      if (prev === undefined || (prev.conditional && !w.conditional)) writes.set(key, w);
    }
    // Keys leave out `via`: the first closure's call path is kept, as for the writes above.
    for (const w of c.conditionalWrites) {
      const key = JSON.stringify([w.table, w.condition, w.source]);
      if (!conditional.has(key)) conditional.set(key, w);
    }
    for (const e of c.fileStoreEvidence) {
      const key = JSON.stringify([e.component, e.method, e.source]);
      const prev = evidence.get(key);
      if (prev === undefined || (prev.conditional && !e.conditional)) evidence.set(key, e);
    }
    for (const t of c.threads) threads.set(JSON.stringify([t.component, t.method, t.source]), t);
    for (const u of c.unresolved) {
      const key = JSON.stringify([u.source, u.expr, u.kind]);
      if (!unresolved.has(key)) unresolved.set(key, u);
    }
    c.overrides.forEach((o) => overrides.add(o));
    c.visited.forEach((v) => visited.add(v));
    if (SESSION_RANK[c.sessionEffects] > SESSION_RANK[session]) session = c.sessionEffects;
  }
  const merged = [...writes.values()];
  const unconditional = new Set(merged.filter((w) => !w.conditional).map((w) => JSON.stringify([w.table, w.source])));
  const fileStoreEvidence = [...evidence.values()].sort(
    compareBy<FileStoreEvidence>((e) => e.component, (e) => e.method, (e) => e.source.path, (e) => e.source.lines[0]),
  );
  return {
    tables: [...new Set(merged.flatMap((w) => (w.table === null ? [] : [w.table])))].sort(compareText),
    writes: merged.sort(
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
    conditionalWrites: [...conditional.values()]
      .filter((w) => !unconditional.has(JSON.stringify([w.table, w.source])))
      .sort(compareBy<ConditionalWrite>((w) => w.table, (w) => w.source.path, (w) => w.source.lines[0], (w) => w.condition)),
    fileStore: fileStoreEvidence.length > 0,
    fileStoreEvidence,
    sessionEffects: session,
    threads: [...threads.values()].sort(
      compareBy<WriteClosure['threads'][number]>((t) => t.component, (t) => t.method, (t) => t.source.path, (t) => t.source.lines[0]),
    ),
    unresolved: [...unresolved.values()].sort(
      compareBy<UnresolvedRef>((u) => u.source.path, (u) => u.source.lines[0], (u) => u.expr, (u) => u.kind),
    ),
    overrides: [...overrides].sort(compareText),
    visited: [...visited].sort(compareText),
  };
}

// CSRF and response mode

/** Text an action runs: its comment-stripped method body, or its view with includes spliced in. */
interface ActionText {
  text: string;
  where: 'method' | 'view';
}

// validateCSRFTokens( on any receiver; a constant `true or` / `true ||` before the receiver short-circuits it.
const CSRF_CALL = /(\b(?:true|yes)\s*(?:\bor\b|\|\|)\s*)?((?:[\w$]+\s*\.\s*)*)validateCSRFTokens\s*\(/gi;
// Content-Disposition set through <cfheader>, cfheader() or a script header statement.
const DISPOSITION = /\b(?:cf)?header\b[^>;]*?\bname\s*=\s*["']content-disposition["']/i;
// <cfcontent …> tags.
const CFCONTENT_TAG = /<cfcontent\b([^>]*)>/gi;
// cfcontent( script calls.
const CFCONTENT_CALL = /(?<![\w$.])cfcontent\s*\(/gi;
// getPageContext().getResponse().setContentType( calls.
const SET_CONTENT_TYPE = /\bsetContentType\s*\(/gi;
// <cfabort> tags and script abort statements.
const ABORT = /<cfabort\b|(?<![\w$.])abort\s*;/gi;
// A script body whose last statement is abort.
const ENDS_IN_ABORT = /(?<![\w$.])abort\s*;?\s*$/i;
const LAYOUT_OFF = /\brequest\.layout\s*=\s*false\b/i;
const INCLUDE_TAG = /<cfinclude\b[^>]*>/gi;
// An optional <cfcontent>, one <cfoutput> block and <cfabort>, nothing else.
const BARE_VIEW = /^\s*(?:<cfcontent\b[^>]*>\s*)?<cfoutput>((?:(?!<\/?cfoutput\b)[\s\S])*)<\/cfoutput>\s*<cfabort\b[^>]*>\s*$/i;
// variables.fw.redirect( and location( calls.
const REDIRECT_CALL = /(?<![\w$])(?:variables\s*\.\s*)?fw\s*\.\s*redirect\s*\(|(?<![\w$.])location\s*\(/gi;
// fileUpload( and fileManager.upload( calls, which read a multipart file part.
const UPLOAD_CALL = /(?<![\w$.])fileUpload\s*\(|\.\s*upload\s*\(/i;

/** The CSRF context an action's token checks name, and whether they validate, are short-circuited, or are absent. */
function csrfFacts(texts: readonly ActionText[]): { csrfContext: string | null; csrfValidation: CsrfValidation } {
  const contexts: string[] = [];
  let calls = 0;
  let validates = false;
  for (const { text } of texts) {
    for (const m of text.matchAll(CSRF_CALL)) {
      calls++;
      if (m[1] === undefined) validates = true;
      const args = callArguments(text, m.index + m[0].length - 1);
      const context = args.find((a) => a.name === 'context') ?? args.find((a) => a.name === undefined);
      const recorded = context === undefined ? '' : recordedExpression(context.expr);
      if (!contexts.includes(recorded)) contexts.push(recorded);
    }
  }
  if (calls === 0) return { csrfContext: null, csrfValidation: 'none' };
  // An empty context is written "" when joined, so it stays visible.
  const csrfContext = contexts.length === 1 ? (contexts[0] ?? '') : contexts.map((c) => (c === '' ? '""' : c)).join(' | ');
  return { csrfContext, csrfValidation: validates ? 'validates' : 'bypassed' };
}

/** A declared response type and whether its `<cfcontent>` streams a file or variable. */
interface ContentDeclaration {
  type: string | undefined;
  offset: number;
  streams: boolean;
}

function contentDeclarations(text: string): ContentDeclaration[] {
  const out: ContentDeclaration[] = [];
  for (const m of text.matchAll(CFCONTENT_TAG)) {
    const attrs = parseAttributes(m[1] ?? '');
    out.push({ type: attrs.type, offset: m.index, streams: attrs.file !== undefined || attrs.variable !== undefined });
  }
  for (const m of text.matchAll(CFCONTENT_CALL)) {
    const args = callArguments(text, m.index + m[0].length - 1);
    const named = (n: string): string | undefined => args.find((a) => a.name === n)?.expr;
    const type = named('type');
    const streams = named('file') !== undefined || named('variable') !== undefined;
    out.push({ type: type === undefined ? undefined : literalValue(type), offset: m.index, streams });
  }
  for (const m of text.matchAll(SET_CONTENT_TYPE)) {
    const type = callArguments(text, m.index + m[0].length - 1)[0]?.expr;
    out.push({ type: type === undefined ? undefined : literalValue(type), offset: m.index, streams: false });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** Lower-cased media type of a declared content type. */
function mediaType(type: string): string {
  return type.split(';')[0]?.trim().toLowerCase() || UNDECLARED_CONTENT_TYPE;
}

/** Response facts derived from the source; `layout` is set only for `page`, `contentType` for every mode but `redirect`. */
interface ResponseFacts {
  responseMode: ResponseMode;
  layout: string | null;
  contentType: string | null;
  redirectTarget: string | null;
}

/** Target of the last `fw.redirect()` or `location()` call in `text`: its action or URL expression. */
function lastRedirect(text: string): string | null {
  const calls = codeMatches(text, REDIRECT_CALL);
  const last = calls.at(-1);
  if (last === undefined) return null;
  const args = callArguments(text, last.index + last[0].length - 1);
  const target = args.find((a) => a.name === 'action' || a.name === 'url') ?? args.find((a) => a.name === undefined);
  return target === undefined ? null : recordedExpression(target.expr);
}

/** Redirect target of `fn`, else of the last same-component function it calls that redirects. */
function redirectTarget(fn: CfmlFunction, component: CfmlComponent): string | null {
  const own = lastRedirect(fn.body);
  if (own !== null) return own;
  let found: string | null = null;
  for (const callee of component.functions) {
    const name = callee.name.replace(/\$/g, '\\$');
    if (callee === fn || !new RegExp(String.raw`(?<![\w$.])${name}\s*\(`, 'i').test(fn.body)) continue;
    found = lastRedirect(callee.body) ?? found;
  }
  return found;
}

/**
 * Response mode of an action, first match wins: download, json, fragment, redirect, page. Redirect is a method with no
 * view, or one that answers an uploaded file with a redirect: a page request folds a POST into a query and cannot
 * carry the file, so that action is served as a post-action.
 */
function responseFacts(
  texts: readonly ActionText[],
  method: { fn: CfmlFunction; component: CfmlComponent } | null,
  hasView: boolean,
): ResponseFacts {
  const declarations = texts.flatMap((t) => contentDeclarations(t.text).map((d) => ({ ...d, text: t.text })));
  const firstDeclared = declarations.find((d) => d.type !== undefined)?.type;
  const contentType = firstDeclared === undefined ? UNDECLARED_CONTENT_TYPE : mediaType(firstDeclared);
  const facts = (responseMode: ResponseMode, type: string | null = contentType): ResponseFacts => ({
    responseMode,
    layout: responseMode === 'page' ? REQUEST_LAYOUT : null,
    contentType: type,
    redirectTarget: null,
  });

  const streams = declarations.some((d) => d.streams && d.type !== undefined && mediaType(d.type) !== 'text/html');
  if (streams || texts.some((t) => DISPOSITION.test(t.text))) return facts('download');

  for (const d of declarations) {
    if (d.type === undefined || mediaType(d.type) !== 'application/json') continue;
    if ([...d.text.matchAll(ABORT)].some((m) => m.index > d.offset)) return facts('json', 'application/json');
  }
  // A method that aborts without declaring a type answers with legacy's default text/html, never an assumed JSON type.
  if (method !== null && ENDS_IN_ABORT.test(method.fn.body.trim())) return facts('json');
  const view = texts.find((t) => t.where === 'view');
  const bare = view === undefined ? null : BARE_VIEW.exec(view.text.replace(INCLUDE_TAG, ''));
  if (bare !== null) return facts(/^\s*[{[]/.test(bare[1] ?? '') ? 'json' : 'fragment');
  if (texts.some((t) => LAYOUT_OFF.test(t.text))) return facts('fragment');
  if (method !== null) {
    const target = redirectTarget(method.fn, method.component);
    const postAction = target !== null && UPLOAD_CALL.test(method.fn.body);
    if (!hasView || postAction) return { responseMode: 'redirect', layout: null, contentType: null, redirectTarget: target };
  }
  return facts('page');
}

// Extraction

/** State shared by the controllers of one extraction. */
interface ExtractionState {
  ctx: ClosureContext;
  inputs: ControllerInputs;
  expanded: Map<string, string>;
  writeEvidence: ControllerWriteEvidence[];
  /** Literal action references, scanned on first use. */
  actionReferences: Map<string, SourceRef[]> | null;
  /** Reviewed partials by lower-cased view path. */
  partials: ReadonlyMap<string, ViewPartial>;
}

/** Literal references in the tree that address `action` (`<circuit>.<action>`), in path and line order. */
function referencesTo(state: ExtractionState, action: string): SourceRef[] {
  state.actionReferences ??= scanActionReferences(state.ctx.tree);
  return state.actionReferences.get(action.toLowerCase()) ?? [];
}

function refText(r: SourceRef): string {
  return `${r.path}:${String(r.lines[0])}-${String(r.lines[1])}`;
}

/** Literal action references of `tree`, scanned on the first lookup. */
function lazyReferences(tree: SourceTree): (action: string) => SourceRef[] {
  let scanned: Map<string, SourceRef[]> | null = null;
  return (action) => (scanned ??= scanActionReferences(tree)).get(action.toLowerCase()) ?? [];
}

/**
 * A check of reviewed partials against `tree`, returning what the tree contradicts in one: an absent view, no or other
 * includes, a method or dsp_ name, or a reference addressing it as an action. Checks share one parse per circuit.
 */
export function viewPartialChecker(
  tree: SourceTree,
  references: (action: string) => SourceRef[] = lazyReferences(tree),
): (partial: ViewPartial) => string[] {
  const controllers = tree.list(CONTROLLERS_DIR, { ext: ['cfc'] });
  const circuits = new Map<string, { component: CfmlComponent | null; folder: ViewFolder }>();
  const circuitOf = (circuit: string): { component: CfmlComponent | null; folder: ViewFolder } => {
    const known = circuits.get(circuit);
    if (known !== undefined) return known;
    const p = controllers.find((c) => path.posix.basename(c).replace(/\.cfc$/i, '').toLowerCase() === circuit.toLowerCase());
    const parsed = { component: p === undefined ? null : parseCfmlComponent(p, tree.readText(p)), folder: viewFolder(tree, circuit) };
    circuits.set(circuit, parsed);
    return parsed;
  };
  return (partial) => {
    const circuit = path.posix.basename(path.posix.dirname(partial.view));
    const name = viewName(partial.view);
    if (!tree.exists(partial.view)) return [`${partial.view} does not exist`];
    const { component, folder } = circuitOf(circuit);
    if (component === null) return [`${partial.view} belongs to no controller of ${CONTROLLERS_DIR}`];
    const issues: string[] = [];
    if (name.toLowerCase().startsWith('dsp_')) issues.push(`${partial.view} is a dsp_ include, excluded by its name`);
    if (methodActions(component).actions.some((fn) => fn.name.toLowerCase() === name.toLowerCase())) {
      issues.push(`${partial.view} is the view of the ${circuit}.${name} method action`);
    }
    const includes = (folder.includes.get(partial.view.toLowerCase()) ?? []).map(refText).sort(compareText);
    const recorded = partial.includers.map(refText).sort(compareText);
    if (includes.length === 0) issues.push(`${partial.view} is not included by another view`);
    else if (includes.join() !== recorded.join()) {
      issues.push(`includers ${recorded.join(', ')} differ from its includes ${includes.join(', ')}`);
    }
    const addressed = references(`${circuit}.${name}`);
    if (addressed.length > 0) issues.push(`${circuit}.${name} is addressed as an action at ${addressed.map(refText).join(', ')}`);
    return issues;
  };
}

/** Throws an `OverrideError` naming {@link VIEW_PARTIALS_REF} with every issue `check` finds in `partials`. */
function checkPartials(partials: readonly ViewPartial[], check: (partial: ViewPartial) => string[]): void {
  const issues = partials.flatMap((p) => check(p).map((issue) => `${p.id}: ${issue}`));
  if (issues.length > 0) throw new OverrideError(VIEW_PARTIALS_REF, issues);
}

/** An action before its variants: its method or view and its settled role. */
type ActionSeed = { name: string; role: RoleGate } & (
  | { kind: 'method'; fn: CfmlFunction; viewPath: string | null }
  | { kind: 'view-only'; fn: null; viewPath: string; reachability?: ViewReachability }
);

function idOfKey(key: string): string {
  return `ctl:${key.slice(key.indexOf(':') + 1)}`;
}

/** The variants of one action: each declared variant in match order, then the base key; every key through the platform. */
async function buildAction(
  component: CfmlComponent,
  circuit: string,
  seed: ActionSeed,
  state: ExtractionState,
): Promise<ActionEntry> {
  const { ctx, inputs } = state;
  const { fn, viewPath, name } = seed;
  const action = `${circuit}.${name}`;
  const opts = { variants: inputs.variants };
  const base = await inventoryRouteKey({ kind: 'admin', action }, opts);
  if (base.variant !== undefined) {
    throw new Error(`${action}: a request without parameters already matches variant ${base.variant}`);
  }
  const declared = variantsFor(base.baseKey, inputs.variants);

  // An action method that ends in abort never renders its view.
  const aborts = fn !== null && ENDS_IN_ABORT.test(fn.body.trim());
  const rendersView = viewPath !== null && !aborts;
  const texts: ActionText[] = [];
  if (fn !== null) texts.push({ text: fn.body, where: 'method' });
  if (rendersView) texts.push({ text: expandTemplate(ctx.tree, viewPath, state.expanded), where: 'view' });
  // CSRF and response facts are the action's: every variant records the token checks of its method and view.
  const csrf = csrfFacts(texts);
  const response = responseFacts(texts, fn === null ? null : { fn, component }, rendersView);
  const entries = [
    ...(fn === null ? [] : [{ component: component.path, method: fn.name }]),
    ...(rendersView ? [{ component: viewPath, method: '' }] : []),
  ];
  const source =
    seed.kind === 'method'
      ? sourceRef(component.path, seed.fn.startLine, seed.fn.endLine)
      : sourceRef(seed.viewPath, 1, lineCount(ctx.tree.readText(seed.viewPath)));

  // A request reaches a variant only when every earlier declaration fails, so each earlier one is excluded.
  const variant = (key: string, index: number, decl: VariantDeclaration | null): VariantEntry => {
    const positive = decl === null ? [{}] : branchPredicates(decl.when);
    const exclusions = declared.slice(0, index).flatMap((d) => exclusionPredicates(d.when));
    const closure = mergeClosures(
      positive.flatMap((predicates) =>
        entries.map((e) => computeClosure({ ...e, predicates, excludePredicates: exclusions }, ctx)),
      ),
    );
    state.writeEvidence.push({ entryRouteKey: key, trigger: 'request', closure });
    return {
      id: idOfKey(key),
      source,
      routeKey: key,
      predicate: decl === null ? null : { variant: decl.variant, when: decl.when },
      precedence: decl === null ? 0 : declared.length - index,
      order: decl === null ? declared.length + 1 : index + 1,
      writeSet: [...new Set(closure.tables.map((t) => t.toLowerCase()))].sort(compareText),
      conditionalWrites: closure.conditionalWrites,
      fileStoreWrite: closure.fileStore,
      sessionEffects: closure.sessionEffects,
      closureEvidence: closure.writes,
      fileStoreEvidence: closure.fileStoreEvidence,
      unresolvedCalls: closure.unresolved,
      requiredRole: seed.role,
      ...csrf,
      ...response,
    };
  };

  const variants: VariantEntry[] = [];
  for (const [index, decl] of declared.entries()) {
    const request = satisfyingRequest(decl.when);
    const keyed = await inventoryRouteKey({ kind: 'admin', action, ...request }, opts);
    if (keyed.variant !== normaliseInventoryKey(decl.variant)) {
      const by = keyed.variant ?? 'the base key';
      throw new Error(`${base.baseKey}: variant ${decl.variant} is shadowed by ${by} for a request satisfying it`);
    }
    variants.push(variant(keyed.key, index, decl));
  }
  variants.push(variant(base.key, declared.length, null));
  const reachability = seed.kind === 'view-only' && seed.reachability !== undefined ? { reachability: seed.reachability } : {};
  return { id: idOfKey(base.baseKey), source, action: name.toLowerCase(), name, kind: seed.kind, viewPath, ...reachability, variants };
}

/** Lower-cased names of the controllers another controller extends. */
function baseNames(components: readonly CfmlComponent[]): Set<string> {
  const names = new Set<string>();
  for (const c of components) {
    const parent = c.declaration.attrs.extends?.split('.').at(-1)?.toLowerCase();
    if (parent !== undefined && parent !== '') names.add(parent);
  }
  return names;
}

/** The gates of a circuit that no pattern or override settles: per action, and per named branch for no action. */
function unsettledGates(
  circuit: string,
  actions: readonly ActionSeed[],
  gates: readonly GateBranch[],
  requiredRole: RoleGate,
): UnclassifiedGate[] {
  const bySource = new Map<string, UnclassifiedGate>();
  const add = (actionsOf: string[] | null, source: SourceRef): void => {
    const key = JSON.stringify(source);
    const prev = bySource.get(key);
    if (prev === undefined) bySource.set(key, { circuit, actions: actionsOf, source });
    else if (prev.actions !== null && actionsOf !== null) prev.actions = [...new Set([...prev.actions, ...actionsOf])].sort(compareText);
  };
  for (const a of actions) if (a.role.unclassified) add([a.name.toLowerCase()], a.role.source);
  const known = new Set(actions.map((a) => a.name.toLowerCase()));
  for (const g of gates) {
    const absent = (g.actions ?? []).filter((n) => !known.has(n));
    if (g.unclassified && absent.length > 0) add(absent, g.source);
  }
  if (actions.length === 0 && requiredRole.unclassified) add(null, requiredRole.source);
  return [...bySource.values()];
}

/** One controller entry and the gates of it no pattern or override settles. */
async function extractController(
  component: CfmlComponent,
  isBase: boolean,
  state: ExtractionState,
): Promise<{ entry: ControllerEntry; unclassified: UnclassifiedGate[] }> {
  const { tree } = state.ctx;
  const { roleOverrides } = state.inputs;
  const p = component.path;
  const circuit = path.posix.basename(p).replace(/\.cfc$/i, '');
  const { actions: methods, excluded } = methodActions(component);
  const folder = viewFolder(tree, circuit);
  const methodNames = new Set(methods.map((m) => m.name.toLowerCase()));

  const analysis = analyseBefore(component);
  const { fallback, named } = gateBranches(analysis, circuit, roleOverrides.extractorPatterns);
  const requiredRole = settle(fallback, overrideFor(roleOverrides.overrides, circuit, null));
  const gates: GateBranch[] = [
    { ...requiredRole, actions: null },
    ...named.map((b) => {
      // A branch of one action takes that action's own override; a wider branch only the circuit's.
      const only = b.actions.length === 1 ? (b.actions[0] ?? null) : null;
      return { ...settle(b.gate, overrideFor(roleOverrides.overrides, circuit, only)), actions: b.actions };
    }),
  ];
  const roleOf = (name: string): RoleGate => {
    const lower = name.toLowerCase();
    const gate = named.find((b) => b.actions.includes(lower))?.gate ?? fallback;
    return settle(gate, overrideFor(roleOverrides.overrides, circuit, lower));
  };

  const viewOf = (name: string): string | null =>
    folder.files.find((f) => viewName(f).toLowerCase() === name.toLowerCase()) ?? null;
  const seeds: ActionSeed[] = methods.map((fn) => ({
    name: fn.name,
    kind: 'method',
    fn,
    viewPath: viewOf(fn.name),
    role: roleOf(fn.name),
  }));
  const excludedViews: ExcludedView[] = folder.subfolders.map((s) => ({ path: s, reason: 'subfolder' }));
  for (const file of folder.files) {
    const name = viewName(file);
    if (methodNames.has(name.toLowerCase())) continue;
    const includers = folder.includedBy.get(file.toLowerCase())?.slice().sort(compareText);
    const partial = state.partials.get(file.toLowerCase());
    if (name.toLowerCase().startsWith('dsp_')) {
      excludedViews.push({ path: file, reason: 'dsp-include' });
    } else if (partial !== undefined && includers !== undefined) {
      excludedViews.push({ path: file, reason: 'reviewed-partial', ref: `${VIEW_PARTIALS_REF}#${partial.id}`, includedBy: includers });
    } else {
      // FW/1 renders any requested view, so an included view stays an action unless it is a reviewed partial.
      const reachability =
        includers === undefined ? {} : { reachability: { includedBy: includers, addressedBy: referencesTo(state, `${circuit}.${name}`) } };
      seeds.push({ name, kind: 'view-only', fn: null, viewPath: file, role: roleOf(name), ...reachability });
    }
  }
  excludedViews.sort((a, b) => compareText(a.path, b.path));
  seeds.sort((a, b) => compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.name, b.name));

  const actions: ActionEntry[] = [];
  for (const seed of seeds) actions.push(await buildAction(component, circuit, seed, state));
  const helpers = isBase
    ? component.functions
        .map((f) => ({ name: f.name, source: sourceRef(p, f.startLine, f.endLine) }))
        .sort((a, b) => compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.name, b.name))
    : [];
  const entry: ControllerEntry = {
    id: `ctl:${circuit.toLowerCase()}`,
    circuit,
    isBase,
    source: sourceRef(p, component.declaration.line, lineCount(tree.readText(p))),
    helpers,
    requiredRole,
    gates,
    excludedMethods: excluded,
    excludedViews,
    actions,
  };
  return { entry, unclassified: unsettledGates(circuit, seeds, gates, requiredRole) };
}

/**
 * Every controller of `admin/core/controllers/` with its actions, their variants, write closures, gates, CSRF facts and
 * response modes; throws `OverrideError` when the tree contradicts a reviewed partial.
 */
export async function extractControllers(ctx: ClosureContext, inputs: ControllerInputs): Promise<ControllerExtraction> {
  const components = ctx.tree.list(CONTROLLERS_DIR, { ext: ['cfc'] }).map((p) => {
    const component = parseCfmlComponent(p, ctx.tree.readText(p));
    if (component === null) throw new Error(`${p} is not a CFML component`);
    return component;
  });
  const bases = baseNames(components);
  const reviewed = inputs.viewPartials?.partials ?? [];
  const partials = new Map(reviewed.map((p) => [p.view.toLowerCase(), p]));
  const state: ExtractionState = { ctx, inputs, expanded: new Map(), writeEvidence: [], actionReferences: null, partials };
  checkPartials(reviewed, viewPartialChecker(ctx.tree, (action) => referencesTo(state, action)));
  const controllers: ControllerEntry[] = [];
  const unclassifiedGates: UnclassifiedGate[] = [];
  for (const component of components) {
    const isBase = bases.has(path.posix.basename(component.path).replace(/\.cfc$/i, '').toLowerCase());
    const { entry, unclassified } = await extractController(component, isBase, state);
    controllers.push(entry);
    unclassifiedGates.push(...unclassified);
  }
  controllers.sort((a, b) => compareText(a.id, b.id));
  const actions = controllers.flatMap((c) => c.actions);
  return {
    controllers,
    applicationGate: inputs.roleOverrides.applicationGate,
    denialDefault: inputs.roleOverrides.denialDefault,
    unclassifiedGates: unclassifiedGates.sort((a, b) => compareText(a.circuit, b.circuit) || a.source.lines[0] - b.source.lines[0]),
    writeEvidence: state.writeEvidence.sort((a, b) => compareText(a.entryRouteKey, b.entryRouteKey)),
    counts: {
      circuits: controllers.filter((c) => !c.isBase).length,
      base: controllers.filter((c) => c.isBase).length,
      actions: actions.length,
      viewOnlyActions: actions.filter((a) => a.kind === 'view-only').length,
      variants: actions.reduce((n, a) => n + a.variants.length, 0),
    },
  };
}

// Core muraAction search

const MURA_ACTION = /muraAction/gi;
// A read of the action: a scope member (url.muraAction, rc.muraAction) or an isDefined('….muraAction') test.
const READ_BEFORE = /(?:\.|isDefined\(\s*["'][\w.]*)$/i;
// A read that selects code to run.
const DISPATCH = /\b(?:switch|invoke|cfinvoke|evaluate)\b/i;
const ADMIN_APPLICATION = 'admin/Application.cfc';

/** admin/Application.cfc from the first FW/1 setting through the last line that folds `fuseaction` into `muraAction`. */
function dispatcherSource(tree: SourceTree): SourceRef | null {
  if (!tree.exists(ADMIN_APPLICATION)) return null;
  const lines = tree.readText(ADMIN_APPLICATION).split('\n');
  const start = lines.findIndex((l) => /\bvariables\.framework\.[\w$]+\s*=/i.test(l));
  const fold = lines.findLastIndex((l) => /\bmuraAction\s*=\s*(?:url|form)\.fuseaction\b/i.test(l));
  return start < 0 || fold < start ? null : sourceRef(ADMIN_APPLICATION, start + 1, fold + 1);
}

/** Every `core/` file outside `core/vendor/` that mentions `muraAction`, with the lines and how it uses the action. */
export function searchCoreMuraAction(tree: SourceTree): CoreMuraActionSearch {
  const files: MuraActionMention[] = [];
  let handlers = 0;
  for (const p of tree.list('core', { ext: ['cfc', 'cfm'], recursive: true })) {
    if (p.startsWith('core/vendor/')) continue;
    const text = tree.readText(p);
    const matches = [...text.matchAll(MURA_ACTION)];
    if (matches.length === 0) continue;
    const textLines = text.split('\n');
    const lines = new Set<number>();
    let reads = false;
    let dispatches = false;
    for (const m of matches) {
      const line = lineOf(text, m.index);
      lines.add(line);
      if (!READ_BEFORE.test(text.slice(Math.max(0, m.index - 60), m.index))) continue;
      reads = true;
      if (DISPATCH.test(textLines[line - 1] ?? '')) dispatches = true;
    }
    if (dispatches) handlers++;
    const use: MuraActionUse = dispatches ? 'dispatches-admin-action' : reads ? 'reads-admin-action' : 'builds-admin-url';
    files.push({ path: p, lines: [...lines].sort((a, b) => a - b), use });
  }
  return {
    query: MURA_ACTION_QUERY,
    scope: CORE_SEARCH_SCOPE,
    handlers,
    filesMentioning: files.length,
    conclusion: handlers === 0 ? 'url-builder-only' : 'dispatches',
    dispatcher: dispatcherSource(tree),
    files,
  };
}

