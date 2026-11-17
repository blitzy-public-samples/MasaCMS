// Scheduled-job inventory (scheduledJobs[]): the siteMonitor task's registration, run semantics and per-step write closures.
import {
  computeClosure,
  extractCalls,
  lineOf,
  parseAttributes,
  resolveComponentPath,
  stripComments,
  viaLabel,
  type CfmlFunction,
  type CfmlUnit,
  type ClosureContext,
  type ClosureWrite,
  type ConditionalWrite,
  type FileStoreEvidence,
  type SourceTree,
  type UnresolvedRef,
  type WriteClosure,
} from './closure.js';
import { inventoryRouteKey } from './route-keys.js';
import { STARTUP_PATH } from './services.js';

/** Id of the site-monitor job entry; `tablesFrom.job` writer overrides name it. */
export const JOB_ID = 'job:sitemonitor';

/** Archive path of the front controller whose API handler runs the site-monitor steps. */
export const CONTENT_SERVER_PATH = 'core/mura/content/contentServer.cfc';

/** Archive path of the settings template that declares each setting's default. */
export const SETTINGS_TEMPLATE_PATH = 'core/templates/settings.template.cfm';

/** API path the site-monitor task requests and the handler branch tests. */
export const SITE_MONITOR_ENDPOINT = '/_api/sitemonitor';

/** Provenance of every expected outcome below. */
export const AAP_REF = 'AAP 0.3.2';

/** Location of a fact in the archive. */
export type SourceRef = ClosureWrite['source'];

/** Trigger of the writes a job step reaches. */
export type Trigger = ClosureWrite['trigger'];

/** Route-key options `inventoryRouteKey` accepts. */
export type JobRouteKeyOptions = NonNullable<Parameters<typeof inventoryRouteKey>[1]>;

/** A legacy disposition value. */
export type Disposition = 'carry' | 'legacy-served' | 'decision' | 'retired';

/** Outcome the migration plan expects; `disposition.ts` computes the governing one and compares. */
export interface ExpectedOutcome {
  disposition: Disposition;
  /** Expected owner; null for a decision-list or ownerless item. */
  owningService: string | null;
  ref: string;
}

/** A known site-monitor step: the calls that identify it in source and the plan's expectations for it. */
export interface SiteMonitorStepSpec {
  step: string;
  /** Lower-cased `<bean>.<method>` of the identifying calls; `*` matches any receiver. */
  actions: readonly string[];
  /** Plural noun the semantics rules use. */
  noun: string;
  perSite: boolean;
  /** Site flag gating the step, read as `getSite(site).get<flag>()`; null when ungated. */
  gateFlag: string | null;
  targetMechanism: string;
  stateThisRun: string;
  expected: ExpectedOutcome;
}

const expectation = (disposition: Disposition, owningService: string | null): ExpectedOutcome =>
  Object.freeze({ disposition, owningService, ref: AAP_REF });

// Step names, and the `job:sitemonitor.<step>` ids built from them, are those the committed inventory, the decision list
// and the service traceability tables already reference, not `job:sitemonitor#<camelCase>`.
/** The site-monitor steps in the plan's order; the source decides the emitted order and set. */
export const SITE_MONITOR_STEPS: readonly SiteMonitorStepSpec[] = Object.freeze([
  {
    step: 'reminders',
    actions: ['contentmanager.sendreminders'],
    noun: 'reminders',
    perSite: false,
    gateFlag: null,
    targetMechanism: 'proposed communications step',
    stateThisRun: 'legacy step via gateway/legacy-bridge/cfml/jobs.cfm',
    expected: expectation('decision', null),
  },
  {
    step: 'email-send',
    actions: ['emailmanager.send'],
    noun: 'email sends',
    perSite: false,
    gateFlag: null,
    targetMechanism: 'proposed communications step; not built while cemail is legacy-served',
    stateThisRun: 'legacy step',
    expected: expectation('legacy-served', 'communications'),
  },
  {
    step: 'changeset-publish',
    actions: ['changesetmanager.publishbyschedule'],
    noun: 'scheduled change sets',
    perSite: false,
    gateFlag: null,
    targetMechanism: '/internal/v1/jobs/publish-scheduled-changesets',
    stateThisRun: 'target once its group is target-authoritative',
    expected: expectation('carry', 'strategies-content'),
  },
  {
    step: 'bounces',
    actions: ['emailmanager.trackbounces'],
    noun: 'bounces',
    perSite: true,
    gateFlag: 'EmailBroadcaster',
    targetMechanism: 'proposed communications step',
    stateThisRun: 'legacy step',
    expected: expectation('legacy-served', 'communications'),
  },
  {
    step: 'feed-import',
    actions: ['feedmanager.doautoimport'],
    noun: 'feed imports',
    perSite: true,
    gateFlag: 'FeedManager',
    targetMechanism: '/internal/v1/jobs/feed-auto-import?siteid=',
    stateThisRun: 'target once its group is target-authoritative',
    expected: expectation('carry', 'strategies-content'),
  },
  {
    step: 'cache-purge',
    actions: ['contentmanager.purgecontentcache', 'settingsbean.purgecache'],
    noun: 'display-window purges',
    perSite: false,
    gateFlag: null,
    targetMechanism: 'legacy only; the output cache exists only in legacy',
    stateThisRun: 'legacy step',
    expected: expectation('legacy-served', 'strategies-content'),
  },
  {
    step: 'cluster-cleanup',
    actions: ['clustermanager.clearoldcommands'],
    noun: 'cluster cleanups',
    perSite: false,
    gateFlag: null,
    targetMechanism: 'retired in target; Pub/Sub replaces tclustercommands',
    stateThisRun: 'legacy step',
    expected: expectation('decision', null),
  },
  {
    step: 'plugin-events',
    actions: ['*.announceevent'],
    noun: 'plugin monitor events',
    perSite: true,
    gateFlag: null,
    targetMechanism: 'none',
    stateThisRun: 'legacy step',
    expected: expectation('decision', null),
  },
].map((s) => Object.freeze({ ...s, actions: Object.freeze([...s.actions]) })));

/** Expected outcome of the job entry itself: the programs-sites orchestrator. */
export const SITE_MONITOR_JOB_EXPECTED: ExpectedOutcome = expectation('carry', 'programs-sites');

/** Id of a site-monitor step entry. */
export function stepId(step: string): string {
  return `${JOB_ID}.${step}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------------------------------------------

/** The ACF task Masa registers at start-up, as `scheduleTask(...)` declares it. */
export interface JobRegistration {
  type: string;
  /** Task name per engine, `<webroot>` standing for the configured web root. */
  taskName: string;
  /** Path the task requests. */
  url: string;
  /** Full request URL with `<host>`, `<context>` and `<webroot>` placeholders. */
  urlTemplate: string;
  operation: string;
  publish: string;
  startTime: string;
  intervalSeconds: number;
  requestTimeoutSeconds: number;
  /** Readable registration condition, e.g. `ping is true`. */
  condition: string;
  conditionExpression: string;
  source: SourceRef;
  conditionSource: SourceRef;
  /** Settings-template default of the setting the condition reads; null when the template omits it. */
  pingDefault: { value: boolean | string; source: SourceRef } | null;
  liveTask: Record<string, unknown> | null;
  livePing: boolean | null;
  liveStatus: string;
}

/** The run-time rules of the job, each with its rule text and source. */
export interface JobSemantics {
  cursor: { rule: string; variable: string; default: string; source: SourceRef; endSource: SourceRef | null } | null;
  catchUp: { rule: string; step: string; predicate: string; argument: string; source: SourceRef } | null;
  order: { rule: string; steps: string[]; source: SourceRef | null };
  gating: { rule: string; source: SourceRef; dedupeSource: SourceRef | null } | null;
  purgeWindow: { rule: string; step: string; from: string; to: string; source: SourceRef } | null;
  /** The bounce step's dedupe list is never extended: its `listAppend` result is discarded. */
  bounceDedupeIneffective: boolean;
}

/** One call a step makes, as written in the handler. */
export interface StepCall {
  /** Bean or receiver name as written (`contentManager`, `$`); `settingsBean` for a `getSite(...)` result. */
  bean: string | null;
  method: string;
  /** Resolved component path; null when the receiver does not resolve. */
  component: string | null;
  text: string;
  line: number;
  perSite: boolean;
  /** Innermost enclosing `<cfif>` branch condition. */
  condition: string | null;
  /** Literal event name of an `announceEvent` call. */
  event: string | null;
}

/** A per-site flag gating a step. */
export interface StepGate {
  flag: string;
  condition: string;
  source: SourceRef;
  loopSource: SourceRef;
}

/**
 * One site-monitor step with its own write set; groups are formed from steps, never from the whole job.
 * Owner, disposition and correction fields are left to `generate.ts`, which decides them from these facts.
 */
export interface ScheduledJobStep {
  id: string;
  step: string;
  order: number;
  source: SourceRef;
  call: string;
  calls: StepCall[];
  trigger: Trigger;
  perSite: boolean;
  gating: StepGate | null;
  /** Writes come from handlers registered at run time; settled by `writer-overrides.yaml`. */
  dynamic?: true;
  tables: string[];
  writeSet: ClosureWrite[];
  conditionalWrites: ConditionalWrite[];
  fileStoreWrite: boolean;
  unresolved: UnresolvedRef[];
  overrides: string[];
  /** Merged write closure of the step's calls, the write evidence of `attachWriters`. */
  closure: WriteClosure;
  targetMechanism: string | null;
  stateThisRun: string | null;
  /** Null for a step the plan does not name. */
  expected: ExpectedOutcome | null;
}

/** A `scheduledJobs[]` entry. */
export interface ScheduledJobEntry {
  id: string;
  source: SourceRef;
  routeKey: string;
  trigger: Trigger;
  registration: JobRegistration;
  semantics: JobSemantics;
  expected: ExpectedOutcome;
  steps: ScheduledJobStep[];
}

/** A parsed step fact that differs from {@link SITE_MONITOR_STEPS}; `generate.ts` records it as a correction. */
export interface JobDifference {
  jobId: string;
  step: string;
  kind: 'missing-step' | 'unexpected-step' | 'order' | 'gating';
  expected: string | number | null;
  computed: string | number | null;
}

/** Result of {@link extractJobs}. */
export interface JobExtraction {
  scheduledJobs: ScheduledJobEntry[];
  differences: JobDifference[];
}

/** Write evidence of one step, in the shape `attachWriters` reads. */
export interface JobWriteEvidence {
  entryRouteKey: string;
  trigger: Trigger;
  closure: WriteClosure;
}

// ---------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------

const SCHEDULER_TRIGGER: Trigger = 'scheduler';
const SESSION_RANK: Readonly<Record<WriteClosure['sessionEffects'], number>> = { none: 0, relogin: 1, login: 2, logout: 3 };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byKeys<T>(...keys: Array<(x: T) => string | number>): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const x = key(a);
      const y = key(b);
      if (x !== y) return typeof x === 'number' && typeof y === 'number' ? x - y : compareText(String(x), String(y));
    }
    return 0;
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function unhash(value: string): string {
  const m = /^#([\s\S]*)#$/.exec(value.trim());
  return (m?.[1] ?? value).trim();
}

function unquote(value: string): string | null {
  const m = /^(["'])([\s\S]*)\1$/.exec(value.trim());
  return m?.[2] === undefined || m[1] === undefined ? null : m[2].split(`${m[1]}${m[1]}`).join(m[1]);
}

function ref(path: string, from: number, to: number): SourceRef {
  return { path, lines: [from, Math.max(from, to)] };
}

/** Index after the CFML string literal opening at `at`; a doubled quote escapes it. */
function skipString(text: string, at: number): number {
  const q = text.charAt(at);
  let i = at + 1;
  while (i < text.length) {
    if (text.charAt(i) === q) {
      if (text.charAt(i + 1) !== q) return i + 1;
      i += 2;
    } else {
      i++;
    }
  }
  return text.length;
}

/** Per-offset flag: true outside string literals. */
function codeMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(true);
  for (let i = 0; i < text.length; ) {
    const c = text.charAt(i);
    if (c === '"' || c === "'") {
      const end = skipString(text, i);
      for (let j = i; j < end; j++) mask[j] = false;
      i = end;
    } else {
      i++;
    }
  }
  return mask;
}

const PAIRS: Readonly<Record<string, string>> = { '(': ')', '{': '}', ')': '(', '}': '{' };

/** Index of the bracket matching the one at `at`, searching forward for an opener and backward for a closer; -1 when unbalanced. */
function matchBracket(text: string, mask: readonly boolean[], at: number): number {
  const c = text.charAt(at);
  const other = PAIRS[c];
  if (other === undefined) return -1;
  const step = c === '(' || c === '{' ? 1 : -1;
  let depth = 0;
  for (let i = at; i >= 0 && i < text.length; i += step) {
    if (mask[i] !== true) continue;
    const d = text.charAt(i);
    if (d === c) depth++;
    else if (d === other && --depth === 0) return i;
  }
  return -1;
}

/** Nearest unmatched `{` before `at`, or -1. */
function enclosingBrace(text: string, mask: readonly boolean[], at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (mask[i] !== true) continue;
    const c = text.charAt(i);
    if (c === '}') depth++;
    else if (c === '{' && depth-- === 0) return i;
  }
  return -1;
}

function prevCode(text: string, at: number): number {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text.charAt(i))) i--;
  return i;
}

function nextCode(text: string, at: number): number {
  let i = at;
  while (i < text.length && /\s/.test(text.charAt(i))) i++;
  return i;
}

/** Top-level pieces of `text` split on `sep`, skipping strings and brackets. */
function splitTopLevel(text: string, sep: string): string[] {
  const mask = codeMask(text);
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (mask[i] !== true) continue;
    const c = text.charAt(i);
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === sep) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

// ---------------------------------------------------------------------------------------------------------------
// Registration (script start-up template)
// ---------------------------------------------------------------------------------------------------------------

/** A script `if`/`else` branch holding an offset: its condition, or `else`. */
interface ScriptBranch {
  kind: 'if' | 'else';
  /** Condition of the `if`, or of the `if` an `else` belongs to. */
  condition: string;
  /** Offset of the branch's `if` keyword; for an `else`, of the `if` it follows. */
  ifStart: number;
  /** The `{` opening the branch body. */
  bodyOpen: number;
}

/** Offset of the keyword `word` ending at `end` (inclusive), or -1 when another word ends there. */
function keywordAt(text: string, end: number, word: string): number {
  const start = end - word.length + 1;
  if (start < 0 || text.slice(start, end + 1).toLowerCase() !== word) return -1;
  return start > 0 && /[\w$.]/.test(text.charAt(start - 1)) ? -1 : start;
}

/** The `if`/`else` branch whose braces directly enclose `at`; null when `at` is not inside one. */
function scriptBranchAt(text: string, mask: readonly boolean[], at: number): ScriptBranch | null {
  const open = enclosingBrace(text, mask, at);
  if (open < 0) return null;
  const before = prevCode(text, open);
  if (text.charAt(before) === ')') {
    const paren = matchBracket(text, mask, before);
    const kw = paren < 0 ? -1 : keywordAt(text, prevCode(text, paren), 'if');
    if (kw < 0) return null;
    return { kind: 'if', condition: squash(text.slice(paren + 1, before)), ifStart: kw, bodyOpen: open };
  }
  const elseAt = keywordAt(text, before, 'else');
  if (elseAt < 0) return null;
  const closeOfIf = prevCode(text, elseAt);
  if (text.charAt(closeOfIf) !== '}') return null;
  const branch = scriptBranchAt(text, mask, matchBracket(text, mask, closeOfIf) + 1);
  return branch === null ? null : { ...branch, kind: 'else', bodyOpen: open };
}

/** Start of the `if`/`else if` chain whose branch holds `at`; `at` itself outside any branch. */
function statementStart(text: string, mask: readonly boolean[], at: number): number {
  const branch = scriptBranchAt(text, mask, at);
  if (branch === null) return at;
  let start = branch.ifStart;
  for (;;) {
    const elseAt = keywordAt(text, prevCode(text, start), 'else');
    const closeOfIf = elseAt < 0 ? -1 : prevCode(text, elseAt);
    if (closeOfIf < 0 || text.charAt(closeOfIf) !== '}') return start;
    const outer = scriptBranchAt(text, mask, matchBracket(text, mask, closeOfIf) + 1);
    if (outer === null) return start;
    start = outer.ifStart;
  }
}

/** End (exclusive) of the block opened at `open`, including any `catch`, `finally` or `else` blocks that follow. */
function blockEnd(text: string, mask: readonly boolean[], open: number): number {
  let close = matchBracket(text, mask, open);
  while (close >= 0) {
    const next = nextCode(text, close + 1);
    const tail = /^(?:catch\s*\([^)]*\)|finally|else(?:\s+if\s*\([^{]*\))?)\s*\{/i.exec(text.slice(next));
    if (tail === null) return close + 1;
    close = matchBracket(text, mask, next + tail[0].length - 1);
  }
  throw new Error(`unbalanced braces after offset ${open}`);
}

/** Assignments of `name` before `before` in source order, each with its enclosing branch. */
interface ScriptAssignment {
  value: string;
  offset: number;
  branch: ScriptBranch | null;
}

function scriptAssignments(text: string, mask: readonly boolean[], name: string, before: number): ScriptAssignment[] {
  const re = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*=(?!=)\\s*([^;]+);`, 'gi');
  const out: ScriptAssignment[] = [];
  for (const m of text.matchAll(re)) {
    if (m.index >= before || mask[m.index] !== true || m[1] === undefined) continue;
    out.push({ value: m[1].trim(), offset: m.index, branch: scriptBranchAt(text, mask, m.index) });
  }
  return out;
}

const URL_PLACEHOLDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^listFirst\(\s*cgi\.http_host\b/i, '<host>'],
  [/getContext\(\s*\)$/i, '<context>'],
  [/getWebRoot\(\s*\)$/i, '<webroot>'],
];

function placeholderFor(expr: string): string {
  return URL_PLACEHOLDERS.find(([re]) => re.test(expr.trim()))?.[1] ?? `<${squash(expr)}>`;
}

/** A string literal with `#expr#` interpolations replaced by placeholders. */
function renderLiteral(literal: string): string {
  return literal.replace(/#([^#]+)#/g, (_m, expr: string) => placeholderFor(expr));
}

/** Parts of a `&` concatenation, each a rendered literal or a placeholder. */
function renderConcat(expr: string): Array<{ literal: boolean; text: string }> {
  return splitTopLevel(expr, '&').map((p) => {
    const lit = unquote(p);
    return lit === null ? { literal: false, text: placeholderFor(p) } : { literal: true, text: renderLiteral(lit) };
  });
}

/** Value of a `scheduleTask` argument: a literal, or the literal parts of the variable it interpolates. */
function argumentValue(text: string, mask: readonly boolean[], value: string, before: number): { template: string; path: string; names: string[] } {
  const variable = /^#([\w$.]+)#$/.exec(value.trim())?.[1];
  if (variable === undefined) return { template: renderLiteral(value), path: renderLiteral(value), names: [renderLiteral(value)] };
  const assignments = scriptAssignments(text, mask, variable, before);
  const last = assignments.at(-1);
  if (last === undefined) throw new Error(`${STARTUP_PATH}: ${variable} is never assigned before the scheduleTask call`);
  const parts = renderConcat(last.value);
  let tail = parts.length;
  while (tail > 0 && parts[tail - 1]?.literal === true) tail--;
  const names = assignments.map((a) => {
    const rendered = renderConcat(a.value).map((p) => p.text).join('');
    const engines = a.branch?.kind === 'if' ? /listFindNoCase\(\s*'([^']*)'\s*,[^)]*getCompiler\(\s*\)/i.exec(a.branch.condition)?.[1] : undefined;
    return engines === undefined ? rendered : `${rendered} (${engines.split(',').map((e) => e.trim()).sort(compareText).join('/')})`;
  });
  return { template: parts.map((p) => p.text).join(''), path: parts.slice(tail).map((p) => p.text).join(''), names };
}

function seconds(name: string, value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) {
    throw new Error(`${STARTUP_PATH}: scheduleTask ${name} ${JSON.stringify(value)} is not a number of seconds`);
  }
  return Number(value.trim());
}

function clockTime(value: string): string {
  const m = /^createTime\(\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/i.exec(unhash(value));
  if (m === null) return unhash(value);
  const pad = (n: string | undefined): string => (n ?? '0').padStart(2, '0');
  return `${pad(m[1])}:${pad(m[2])}${m[3] !== undefined && Number(m[3]) !== 0 ? `:${pad(m[3])}` : ''}`;
}

/** Settings-template default of `setting`: `true`/`false` as booleans, anything else as written. */
function settingDefault(tree: SourceTree, setting: string): JobRegistration['pingDefault'] {
  if (!tree.exists(SETTINGS_TEMPLATE_PATH)) return null;
  const text = tree.readText(SETTINGS_TEMPLATE_PATH);
  const m = new RegExp(`^[ \\t]*${escapeRegExp(setting)}[ \\t]*=[ \\t]*([^\\r\\n]*?)[ \\t]*\\r?$`, 'im').exec(text);
  if (m === null || m[1] === undefined) return null;
  const line = lineOf(text, m.index);
  const raw = m[1];
  const value = /^(true|false)$/i.test(raw) ? raw.toLowerCase() === 'true' : raw;
  return { value, source: ref(SETTINGS_TEMPLATE_PATH, line, line) };
}

/** The site-monitor `scheduleTask(...)` registration of the start-up template, with its condition and setting default. */
export function parseRegistration(tree: SourceTree): JobRegistration {
  const raw = tree.readText(STARTUP_PATH);
  const text = stripComments(raw);
  const mask = codeMask(text);
  for (const m of text.matchAll(/\bscheduleTask\s*\(/gi)) {
    if (mask[m.index] !== true) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, mask, open);
    if (close < 0) continue;
    const args = parseAttributes(text.slice(open + 1, close));
    const url = argumentValue(text, mask, args.url ?? '', m.index);
    if (!url.template.includes(`${SITE_MONITOR_ENDPOINT}/`) && !url.template.endsWith(SITE_MONITOR_ENDPOINT)) continue;

    const branch = scriptBranchAt(text, mask, m.index);
    if (branch === null || branch.kind !== 'if') throw new Error(`${STARTUP_PATH}: the site-monitor scheduleTask call is not guarded by an if`);
    const setting = /\biniProperties\.([\w$]+)/i.exec(branch.condition)?.[1];
    const flagOnly = setting !== undefined && new RegExp(`^isBoolean\\(\\s*([\\w$.]+)\\s*\\)\\s*(?:&&|and)\\s*\\1$`, 'i').test(branch.condition);

    const tryOpen = enclosingBrace(text, mask, branch.ifStart);
    const tryAt = tryOpen < 0 ? -1 : keywordAt(text, prevCode(text, tryOpen), 'try');
    const end = blockEnd(text, mask, tryAt < 0 ? branch.bodyOpen : tryOpen);
    const head = tryAt < 0 ? statementStart(text, mask, branch.ifStart) : tryAt;
    const used = [...new Set(Object.values(args).flatMap((v) => [...v.matchAll(/#([\w$]+\.[\w$.]+)#/g)].map((u) => u[1] ?? '')))];
    const starts = used.flatMap((name) => scriptAssignments(text, mask, name, head).map((a) => statementStart(text, mask, a.offset)));
    let startLine = lineOf(text, Math.min(head, ...starts));
    if (/^\s*(?:\/\/|\/\*|<!---)/.test(raw.split('\n')[startLine - 2] ?? '')) startLine--;
    const conditionLine = lineOf(text, branch.ifStart);
    const operation = args.operation ?? '';
    return {
      type: `ACF ${operation} task`,
      taskName: argumentValue(text, mask, args.task ?? '', m.index).names.join(' or '),
      url: url.path.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, ''),
      urlTemplate: url.template,
      operation,
      publish: args.publish ?? '',
      startTime: clockTime(args.starttime ?? ''),
      intervalSeconds: seconds('interval', args.interval),
      requestTimeoutSeconds: seconds('requestTimeOut', args.requesttimeout),
      condition: flagOnly ? `${setting} is true` : branch.condition,
      conditionExpression: branch.condition,
      source: ref(STARTUP_PATH, startLine, lineOf(text, end - 1)),
      conditionSource: ref(STARTUP_PATH, conditionLine, conditionLine),
      pingDefault: setting === undefined ? null : settingDefault(tree, setting),
      liveTask: null,
      livePing: null,
      liveStatus: 'pending-run',
    };
  }
  throw new Error(`${STARTUP_PATH}: no scheduleTask call registers ${SITE_MONITOR_ENDPOINT}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Handler block (tag-mode API handler)
// ---------------------------------------------------------------------------------------------------------------

interface Tag {
  name: string;
  close: boolean;
  selfClosing: boolean;
  start: number;
  end: number;
  attrs: string;
}

/** A tag with, for containers, its children, close-tag start and `<cfelseif>`/`<cfelse>` markers. */
interface TagNode {
  tag: Tag;
  closeStart: number;
  end: number;
  children: TagNode[];
  markers: Tag[];
}

const CONTAINERS: ReadonlySet<string> = new Set([
  'cfif',
  'cfloop',
  'cfquery',
  'cfoutput',
  'cftry',
  'cfcatch',
  'cffinally',
  'cfswitch',
  'cfcase',
  'cfdefaultcase',
  'cfthread',
  'cflock',
  'cftransaction',
  'cfsavecontent',
  'cfsilent',
  'cfscript',
  'cfmail',
]);

/** Index after the `>` closing a tag whose name ends before `from`, skipping strings and parentheses. */
function tagEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; ) {
    const c = text.charAt(i);
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return i + 1;
    i++;
  }
  return text.length;
}

function scanTags(text: string, from: number, to: number): Tag[] {
  const out: Tag[] = [];
  const re = /<(\/?)(cf[a-z]+)\b/gi;
  re.lastIndex = from;
  for (let m = re.exec(text); m !== null && m.index < to; m = re.exec(text)) {
    const end = tagEnd(text, re.lastIndex);
    const inner = text.slice(re.lastIndex, end - 1);
    const selfClosing = /\/\s*$/.test(inner);
    out.push({
      name: (m[2] ?? '').toLowerCase(),
      close: m[1] === '/',
      selfClosing,
      start: m.index,
      end,
      attrs: inner.replace(/\/\s*$/, '').trim(),
    });
    re.lastIndex = end;
  }
  return out;
}

function buildTree(tags: readonly Tag[], to: number): TagNode[] {
  const roots: TagNode[] = [];
  const stack: TagNode[] = [];
  const add = (n: TagNode): void => {
    (stack.at(-1)?.children ?? roots).push(n);
  };
  for (const t of tags) {
    const top = stack.at(-1);
    if (t.close) {
      const at = stack.map((n) => n.tag.name).lastIndexOf(t.name);
      if (at < 0) continue;
      stack.splice(at).forEach((n, i) => {
        n.closeStart = t.start;
        n.end = i === 0 ? t.end : t.start;
      });
    } else if (CONTAINERS.has(t.name) && !t.selfClosing) {
      const n: TagNode = { tag: t, closeStart: to, end: to, children: [], markers: [] };
      add(n);
      stack.push(n);
    } else if ((t.name === 'cfelseif' || t.name === 'cfelse') && top?.tag.name === 'cfif') {
      top.markers.push(t);
    } else {
      add({ tag: t, closeStart: t.end, end: t.end, children: [], markers: [] });
    }
  }
  return roots;
}

function walk(nodes: readonly TagNode[]): TagNode[] {
  return nodes.flatMap((n) => [n, ...walk(n.children)]);
}

/** Containers whose bodies hold `offset`, outermost first. */
function chainAt(nodes: readonly TagNode[], offset: number): TagNode[] {
  const inner = nodes.find((n) => n.tag.end <= offset && offset < n.closeStart);
  return inner === undefined ? [] : [inner, ...chainAt(inner.children, offset)];
}

/** Condition of the `<cfif>`/`<cfelseif>` branch of `node` holding `offset`; null in a `<cfelse>` branch. */
function branchCondition(node: TagNode, offset: number): string | null {
  const marker = node.markers.filter((m) => m.start < offset).at(-1);
  if (marker === undefined) return squash(node.tag.attrs);
  return marker.name === 'cfelseif' ? squash(marker.attrs) : null;
}

/** The site-monitor branch of the API handler. */
interface MonitorBlock {
  unit: CfmlUnit;
  fn: CfmlFunction;
  mask: boolean[];
  start: number;
  bodyStart: number;
  bodyEnd: number;
  roots: TagNode[];
  lineAt: (offset: number) => number;
  lastLine: (end: number) => number;
}

function findBlock(ctx: ClosureContext): MonitorBlock {
  const unit = ctx.index.parsed(CONTENT_SERVER_PATH);
  if (unit === null) throw new Error(`${CONTENT_SERVER_PATH} is not a component of the source tree`);
  const decl = new RegExp(`<cfset\\s+var\\s+([\\w$]+)\\s*=\\s*(["'])${escapeRegExp(SITE_MONITOR_ENDPOINT)}/?\\2\\s*/?>`, 'i');
  for (const fn of unit.functions) {
    const name = decl.exec(fn.body)?.[1];
    if (name === undefined) continue;
    const tags = scanTags(fn.body, 0, fn.body.length);
    const test = new RegExp(`\\beq\\s+${escapeRegExp(name)}(?![\\w$])`, 'i');
    const at = tags.findIndex((t) => !t.close && (t.name === 'cfif' || t.name === 'cfelseif') && test.test(t.attrs));
    const anchor = tags[at];
    if (anchor === undefined) continue;
    let depth = 0;
    let bodyEnd = fn.body.length;
    for (const t of tags.slice(at + 1)) {
      const sibling = (t.name === 'cfelseif' || t.name === 'cfelse') && depth === 0;
      if (t.name === 'cfif' && !t.selfClosing && !t.close) depth++;
      else if (t.name === 'cfif' && t.close && depth > 0) depth--;
      else if (sibling || (t.name === 'cfif' && t.close)) {
        bodyEnd = t.start;
        break;
      }
    }
    const lineAt = (offset: number): number => fn.bodyLine - 1 + lineOf(fn.body, offset);
    return {
      unit,
      fn,
      mask: codeMask(fn.body),
      start: anchor.start,
      bodyStart: anchor.end,
      bodyEnd,
      roots: buildTree(scanTags(fn.body, anchor.end, bodyEnd), bodyEnd),
      lineAt,
      lastLine: (end) => lineAt(Math.max(0, prevCode(fn.body, end))),
    };
  }
  throw new Error(`${CONTENT_SERVER_PATH}: no handler branch tests the ${SITE_MONITOR_ENDPOINT} endpoint`);
}

// ---------------------------------------------------------------------------------------------------------------
// Calls and steps
// ---------------------------------------------------------------------------------------------------------------

// settingsManager.getSite returns the site's settingsBean (settingsManager.cfc getSite), so a call chained on it is that bean's.
const RETURN_BEANS: Readonly<Record<string, string>> = { 'settingsmanager.getsite': 'settingsBean' };
const AUXILIARY = /^(?:(?:get|set|has|is)[A-Za-z_$][\w$]*|init|loadby)$/i;
const SITE_FLAG = /\bgetSite\s*\([^()]*\)\s*\.\s*get([A-Za-z_$][\w$]*)\s*\(\s*\)/i;
const DATEADD_MINUTES = /^dateadd\(\s*["']n["']\s*,\s*(-?\d+)\s*,\s*([\w$.]+)\s*\)$/i;

interface ActionCall extends StepCall {
  key: string;
  offset: number;
  args: string[];
  gate: StepGate | null;
  innerIf: TagNode | null;
}

function specOf(step: string): SiteMonitorStepSpec | undefined {
  return SITE_MONITOR_STEPS.find((s) => s.step === step);
}

/** Catalogue step of a call, or a step name made from the call when the plan names none. */
function stepKey(bean: string | null, method: string): string {
  const id = `${bean ?? ''}.${method}`.toLowerCase();
  const spec = SITE_MONITOR_STEPS.find((s) => s.actions.some((a) => a === id || (a.startsWith('*.') && a.slice(2) === method.toLowerCase())));
  return spec?.step ?? `${bean ?? 'call'}-${method}`.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
}

function lastSegment(name: string): string {
  return name.split('.').at(-1) ?? name;
}

function mentions(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, 'i').test(text);
}

function minutesOf(expr: string, base: string | null): number | null {
  const m = DATEADD_MINUTES.exec(squash(expr));
  return m === null || base === null || m[2]?.toLowerCase() !== base.toLowerCase() ? null : Number(m[1]);
}

/** The handler's step-performing calls in source order: bean calls that are not accessors, plus calls on a `getSite(...)` result. */
function actionCalls(ctx: ClosureContext, block: MonitorBlock, siteQueries: ReadonlySet<string>): ActionCall[] {
  const body = block.fn.body;
  const sites = extractCalls(block.fn, block.unit, ctx)
    .filter((c) => c.offset >= block.bodyStart && c.offset < block.bodyEnd)
    .sort((a, b) => a.offset - b.offset);
  const out: ActionCall[] = [];
  const push = (bean: string | null, method: string, component: string | null, text: string, offset: number, args: string[]): void => {
    const chain = chainAt(block.roots, offset);
    const loopAt = chain.findIndex((n) => isSiteLoop(n, siteQueries));
    const ifs = chain.filter((n) => n.tag.name === 'cfif');
    const innerIf = ifs.at(-1) ?? null;
    let gate: StepGate | null = null;
    const loop = chain[loopAt];
    if (loop !== undefined) {
      for (const n of chain.slice(loopAt + 1)) {
        const cond = n.tag.name === 'cfif' ? branchCondition(n, offset) : null;
        const flag = cond === null ? undefined : SITE_FLAG.exec(cond)?.[1];
        if (cond === null || flag === undefined) continue;
        const line = block.lineAt(n.markers.filter((m) => m.start < offset).at(-1)?.start ?? n.tag.start);
        gate = {
          flag,
          condition: cond,
          source: ref(CONTENT_SERVER_PATH, line, line),
          loopSource: ref(CONTENT_SERVER_PATH, block.lineAt(loop.tag.start), block.lastLine(loop.end)),
        };
        break;
      }
    }
    out.push({
      bean,
      method,
      component,
      text,
      line: block.lineAt(offset),
      perSite: loop !== undefined,
      condition: innerIf === null ? null : branchCondition(innerIf, offset),
      event: method.toLowerCase() === 'announceevent' && args[0] !== undefined ? unquote(args[0]) : null,
      key: stepKey(bean, method),
      offset,
      args,
      gate,
      innerIf,
    });
  };
  for (const site of sites) {
    const bean = site.target.bean ?? site.target.component ?? site.target.self ?? null;
    const method = site.target.method;
    if (!AUXILIARY.test(method)) {
      push(bean, method, site.resolved, squash(site.text), site.offset, site.args.map((a) => squash(a.expr)));
      continue;
    }
    const chained = RETURN_BEANS[`${bean ?? ''}.${method}`.toLowerCase()];
    const open = nextCode(body, site.offset + method.length);
    if (chained === undefined || body.charAt(open) !== '(') continue;
    const close = matchBracket(body, block.mask, open);
    const next = close < 0 ? null : /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(body.slice(close + 1));
    const name = next?.[1];
    if (next === null || name === undefined || AUXILIARY.test(name)) continue;
    const argsOpen = close + next[0].length;
    const argsClose = matchBracket(body, block.mask, argsOpen);
    const args = argsClose < 0 ? [] : splitTopLevel(body.slice(argsOpen + 1, argsClose), ',').map(squash);
    const text = `${squash(site.text)}(${squash(body.slice(open + 1, close))}).${name}`;
    push(chained, name, ctx.index.resolveBean(chained), text, close + 1 + next[0].indexOf(name, next[0].indexOf('.')), args);
  }
  return out;
}

function isSiteLoop(node: TagNode, siteQueries: ReadonlySet<string>): boolean {
  if (node.tag.name !== 'cfloop') return false;
  const attrs = parseAttributes(node.tag.attrs);
  return /\.getSites\s*\(/i.test(attrs.collection ?? '') || siteQueries.has((attrs.query ?? '').toLowerCase());
}

/** `name = expr` of a `<cfset>` (with or without `var`); null for a bare expression. */
function assignment(tag: Tag): { name: string; expr: string } | null {
  if (tag.name !== 'cfset') return null;
  const m = /^(?:var\s+)?([\w$][\w$.]*)\s*=(?!=)\s*([\s\S]+)$/i.exec(tag.attrs);
  return m?.[1] === undefined || m[2] === undefined ? null : { name: m[1], expr: squash(m[2]) };
}

// ---------------------------------------------------------------------------------------------------------------
// Write closures
// ---------------------------------------------------------------------------------------------------------------

function uniqueBy<T>(items: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Union of closures, kept in the order and shape `computeClosure` returns; `gaps` adds calls the walk could not enter. */
function mergeClosures(parts: readonly WriteClosure[], gaps: readonly UnresolvedRef[]): WriteClosure {
  const writes = new Map<string, ClosureWrite>();
  for (const w of parts.flatMap((p) => p.writes)) {
    const key = JSON.stringify([w.table, w.op, w.component, w.method, w.source, w.trigger, w.override ?? '']);
    const prev = writes.get(key);
    if (prev === undefined || (prev.conditional && !w.conditional)) writes.set(key, w);
  }
  const merged = [...writes.values()].sort(
    byKeys<ClosureWrite>(
      (w) => w.table ?? '',
      (w) => w.op,
      (w) => w.component,
      (w) => w.method,
      (w) => w.source.path,
      (w) => w.source.lines[0],
      (w) => w.trigger,
      (w) => w.override ?? '',
    ),
  );
  const settled = new Set(merged.filter((w) => !w.conditional).map((w) => JSON.stringify([w.table, w.source])));
  const evidence = new Map<string, FileStoreEvidence>();
  for (const e of parts.flatMap((p) => p.fileStoreEvidence)) {
    const key = JSON.stringify([e.component, e.method, e.source]);
    const prev = evidence.get(key);
    if (prev === undefined || (prev.conditional && !e.conditional)) evidence.set(key, e);
  }
  const fileStoreEvidence = [...evidence.values()].sort(
    byKeys<FileStoreEvidence>((e) => e.component, (e) => e.method, (e) => e.source.path, (e) => e.source.lines[0]),
  );
  return {
    tables: [...new Set(merged.flatMap((w) => (w.table === null ? [] : [w.table])))].sort(compareText),
    writes: merged,
    conditionalWrites: uniqueBy(
      parts.flatMap((p) => p.conditionalWrites),
      (c) => JSON.stringify([c.table, c.source, c.condition]),
    )
      .filter((c) => !settled.has(JSON.stringify([c.table, c.source])))
      .sort(byKeys<ConditionalWrite>((c) => c.table, (c) => c.source.path, (c) => c.source.lines[0], (c) => c.condition)),
    fileStore: fileStoreEvidence.length > 0,
    fileStoreEvidence,
    sessionEffects: parts.reduce<WriteClosure['sessionEffects']>(
      (acc, p) => (SESSION_RANK[p.sessionEffects] > SESSION_RANK[acc] ? p.sessionEffects : acc),
      'none',
    ),
    threads: uniqueBy(parts.flatMap((p) => p.threads), (t) => JSON.stringify([t.component, t.method, t.source])).sort(
      byKeys((t) => t.component, (t) => t.method, (t) => t.source.path, (t) => t.source.lines[0]),
    ),
    unresolved: uniqueBy([...parts.flatMap((p) => p.unresolved), ...gaps], (u) => JSON.stringify([u.source, u.expr, u.kind])).sort(
      byKeys<UnresolvedRef>((u) => u.source.path, (u) => u.source.lines[0], (u) => u.expr, (u) => u.kind),
    ),
    overrides: [...new Set(parts.flatMap((p) => p.overrides))].sort(compareText),
    visited: [...new Set(parts.flatMap((p) => p.visited))].sort(compareText),
  };
}

/** Why `method` of `component` cannot start a closure walk; null when it, or an ancestor, defines it. */
function entryGap(ctx: ClosureContext, component: string, method: string): UnresolvedRef['kind'] | null {
  const seen = new Set<string>();
  const wanted = method.toLowerCase();
  let path: string | null = component;
  while (path !== null && !seen.has(path)) {
    const unit = ctx.index.parsed(path);
    if (unit === null) return seen.size === 0 ? 'component' : 'method';
    seen.add(path);
    if (unit.functions.some((f) => f.name.toLowerCase() === wanted)) return null;
    const parent = unit.declaration.attrs.extends ?? '';
    path = parent === '' ? null : resolveComponentPath(parent, path, ctx.tree);
  }
  return 'method';
}

// The write set is the closure as computed, conditional writes included. The plan's expectation that the cache purge
// writes no table is compared downstream through `expected`, never imposed here.
/** Merged scheduler-triggered closure of the distinct methods a step calls; `via` is the call path of the calling function. */
function stepClosure(ctx: ClosureContext, calls: readonly ActionCall[], via: readonly string[]): WriteClosure {
  const parts: WriteClosure[] = [];
  const gaps: UnresolvedRef[] = [];
  const entered = new Set<string>();
  for (const c of calls) {
    const source = ref(CONTENT_SERVER_PATH, c.line, c.line);
    if (c.component === null) {
      gaps.push({ expr: c.text, kind: 'bean', source, via: [...via] });
      continue;
    }
    const key = `${c.component}#${c.method.toLowerCase()}`;
    if (entered.has(key)) continue;
    entered.add(key);
    const gap = entryGap(ctx, c.component, c.method);
    if (gap === null) parts.push(computeClosure({ component: c.component, method: c.method, trigger: SCHEDULER_TRIGGER }, ctx));
    else gaps.push({ expr: c.text, kind: gap, source, via: [...via] });
  }
  return mergeClosures(parts, gaps);
}

// ---------------------------------------------------------------------------------------------------------------
// Steps and semantics
// ---------------------------------------------------------------------------------------------------------------

interface StepSpan {
  key: string;
  start: number;
  end: number;
}

/**
 * Top-level statements grouped into steps by the step their calls identify. A statement without one joins the next
 * step, adjacent statements of one step merge, and a statement holding several steps is split into its children.
 */
function stepSpans(block: MonitorBlock, actions: readonly ActionCall[], excluded: ReadonlySet<TagNode>): StepSpan[] {
  const keysIn = (from: number, to: number): string[] => [
    ...new Set(actions.filter((a) => a.offset >= from && a.offset < to).map((a) => a.key)),
  ];
  const unitsOf = (node: TagNode): Array<{ start: number; end: number; key: string | null }> => {
    const keys = keysIn(node.tag.start, node.end);
    if (keys.length < 2 || node.children.length === 0) return [{ start: node.tag.start, end: node.end, key: keys[0] ?? null }];
    const units = node.children.flatMap(unitsOf);
    const first = units[0];
    if (first !== undefined) first.start = node.tag.start;
    return units;
  };
  const spans: StepSpan[] = [];
  let pending: number | null = null;
  for (const u of block.roots.filter((n) => !excluded.has(n)).flatMap(unitsOf)) {
    if (u.key === null) {
      pending ??= u.start;
      continue;
    }
    const last = spans.at(-1);
    if (last?.key === u.key) last.end = u.end;
    else spans.push({ key: u.key, start: pending ?? u.start, end: u.end });
    pending = null;
  }
  return spans;
}

interface StepFacts {
  span: StepSpan;
  name: string;
  calls: ActionCall[];
  source: SourceRef;
  catchUp: { call: ActionCall; predicate: string; source: SourceRef } | null;
  window: { from: string; to: string; source: SourceRef } | null;
  dedupe: { label: string; source: SourceRef } | null;
}

/** One `scheduledJobs[]` entry for the site-monitor task: registration, semantics and steps in source order. */
async function siteMonitorJob(ctx: ClosureContext, opts: JobRouteKeyOptions | undefined): Promise<{ job: ScheduledJobEntry; differences: JobDifference[] }> {
  const registration = parseRegistration(ctx.tree);
  const block = findBlock(ctx);
  const nodes = walk(block.roots);
  const sets = nodes.flatMap((n) => {
    const a = assignment(n.tag);
    return a === null ? [] : [{ name: a.name.toLowerCase(), expr: a.expr, start: n.tag.start }];
  });
  /** The last assignment of `name` before `offset`. */
  const assignedBefore = (name: string, offset: number): { expr: string; start: number } | undefined =>
    sets.filter((a) => a.name === name.toLowerCase() && a.start < offset).at(-1);
  const siteQueries = new Set(sets.filter((a) => /\bsettingsManager\b[\s\S]*\.getList\s*\(/i.test(a.expr)).map((a) => a.name));

  const excluded = new Set<TagNode>();
  let runTime: string | null = null;
  for (const n of block.roots) {
    const a = assignment(n.tag);
    if (a === null || !/^var\s/i.test(n.tag.attrs) || !/^(?:"[^"]*"|'[^']*'|[\w$.]+\(\s*\)|-?\d+)$/.test(a.expr)) break;
    excluded.add(n);
    if (/^now\(\s*\)$/i.test(a.expr)) runTime ??= a.name;
  }
  const cursorNode = block.roots.find((n) => n.tag.name === 'cfparam' && /^application\./i.test(parseAttributes(n.tag.attrs).name ?? ''));
  const cursorAttrs = cursorNode === undefined ? null : parseAttributes(cursorNode.tag.attrs);
  const cursorVar = cursorAttrs?.name ?? null;
  const cursorEnd =
    cursorVar === null
      ? undefined
      : block.roots.find((n) => !/^var\s/i.test(n.tag.attrs) && assignment(n.tag)?.name.toLowerCase() === cursorVar.toLowerCase());
  // The cursor's default and final assignment are job semantics, so no step span includes them.
  for (const n of [cursorNode, cursorEnd, ...block.roots.filter((r) => r.tag.name === 'cfreturn')]) if (n !== undefined) excluded.add(n);
  const label = (name: string): string =>
    cursorVar !== null && name.toLowerCase() === cursorVar.toLowerCase()
      ? lastSegment(cursorVar)
      : runTime !== null && name.toLowerCase() === runTime.toLowerCase()
        ? 'now'
        : name;

  const actions = actionCalls(ctx, block, siteQueries);
  const counts = new Map<string, number>();
  const facts: StepFacts[] = stepSpans(block, actions, excluded).map((span) => {
    const seen = (counts.get(span.key) ?? 0) + 1;
    counts.set(span.key, seen);
    const inSpan = (offset: number): boolean => offset >= span.start && offset < span.end;
    const calls = actions.filter((a) => inSpan(a.offset));
    const spanNodes = nodes.filter((n) => inSpan(n.tag.start));

    let catchUp: StepFacts['catchUp'] = null;
    for (const c of calls) {
      if (c.innerIf === null || c.condition === null || cursorVar === null) continue;
      const named = /^[\w$]+$/.test(c.condition) ? assignedBefore(c.condition, c.offset) : undefined;
      const predicate = named?.expr ?? c.condition;
      if (!mentions(predicate, cursorVar)) continue;
      const from = block.lineAt(named?.start ?? c.innerIf.tag.start);
      catchUp = { call: c, predicate, source: ref(CONTENT_SERVER_PATH, from, block.lastLine(c.innerIf.end)) };
      break;
    }

    let window: StepFacts['window'] = null;
    for (const q of spanNodes.filter((n) => n.tag.name === 'cfquery')) {
      const params = uniqueBy(
        walk(q.children)
          .filter((p) => p.tag.name === 'cfqueryparam')
          .map((p) => unhash(parseAttributes(p.tag.attrs).value ?? '')),
        (v) => v.toLowerCase(),
      );
      const first = params[0];
      const last = params.at(-1);
      if (cursorVar === null || first === undefined || last === undefined || !params.some((p) => p.toLowerCase() === cursorVar.toLowerCase())) continue;
      window = { from: label(first), to: label(last), source: ref(CONTENT_SERVER_PATH, block.lineAt(q.tag.start), block.lastLine(q.end)) };
      break;
    }

    let dedupe: StepFacts['dedupe'] = null;
    const append = spanNodes.find((n) => n.tag.name === 'cfset' && /^listAppend\s*\(/i.test(n.tag.attrs));
    if (append !== undefined) {
      const args = splitTopLevel(append.tag.attrs.slice(append.tag.attrs.indexOf('(') + 1, append.tag.attrs.lastIndexOf(')')), ',');
      const value = assignedBefore(args[1] ?? '', append.tag.start)?.expr ?? '';
      const line = block.lineAt(append.tag.start);
      dedupe = { label: /getMailServer/i.test(value) ? 'mail-server' : (args[0] ?? 'list'), source: ref(CONTENT_SERVER_PATH, line, line) };
    }

    return {
      span,
      name: seen === 1 ? span.key : `${span.key}-${seen}`,
      calls,
      source: ref(CONTENT_SERVER_PATH, block.lineAt(span.start), block.lastLine(span.end)),
      catchUp,
      window,
      dedupe,
    };
  });

  const nounOf = (f: StepFacts): string => specOf(f.span.key)?.noun ?? f.name;
  const catchUpText = (f: StepFacts): { rule: string; suffix: string } | null => {
    if (f.catchUp === null || cursorVar === null) return null;
    const argument = f.catchUp.call.args[0] ?? '';
    const offset = minutesOf(argument, runTime);
    const inner = /^minute\(\s*([\w$.]+)\s*\)\s+neq\s+minute\(\s*([\s\S]+?)\s*\)$/i.exec(f.catchUp.predicate);
    const compact = (s: string): string => s.replace(/\s+/g, '').toLowerCase();
    if (offset === null || inner?.[1]?.toLowerCase() !== cursorVar.toLowerCase() || compact(inner[2] ?? '') !== compact(argument)) {
      return { rule: `${nounOf(f)} also run for ${argument} when ${f.catchUp.predicate}`, suffix: ` (catch-up when ${f.catchUp.predicate})` };
    }
    const at = `now ${offset < 0 ? '-' : '+'} ${Math.abs(offset)} min`;
    return {
      rule: `${nounOf(f)} also run for ${at} when the minute of ${lastSegment(cursorVar)} differs from the minute of ${at}`,
      suffix: ` (catch-up at ${at} when the minutes differ)`,
    };
  };
  const callText = (f: StepFacts, gate: StepGate | null): string => {
    const named = [...new Set(f.calls.filter((c) => c.method.toLowerCase() !== 'announceevent').map((c) => `${c.bean ?? '?'}.${c.method}`))];
    const events = f.calls
      .filter((c) => c.method.toLowerCase() === 'announceevent')
      .map((c) => `${c.event ?? c.args[0] ?? '?'}${c.perSite ? ' per site' : ''}`);
    let text = [named.join(' and '), events.length > 0 ? `announceEvent ${events.join(', then ')}` : ''].filter((t) => t !== '').join('; ');
    text += catchUpText(f)?.suffix ?? '';
    if (gate !== null) text += ` per site with ${gate.flag}`;
    if (f.dedupe !== null) text += `; ${f.dedupe.label} dedupe ineffective (listAppend result discarded)`;
    if (f.window !== null) text += ` for display windows in [${f.window.from}, ${f.window.to}]`;
    return text;
  };

  const writers = ctx.overrides?.writers ?? [];
  const steps: ScheduledJobStep[] = facts.map((f, i) => {
    const spec = f.name === f.span.key ? specOf(f.span.key) : undefined;
    const gate = f.calls.find((c) => c.gate !== null)?.gate ?? null;
    const closure = stepClosure(ctx, f.calls, [viaLabel(CONTENT_SERVER_PATH, block.fn.name)]);
    const [from, to] = f.source.lines;
    const spanOverrides = writers
      .filter((o) => o.source.path === CONTENT_SERVER_PATH && o.source.lines[0] >= from && o.source.lines[1] <= to)
      .map((o) => o.id);
    const step: ScheduledJobStep = {
      id: stepId(f.name),
      step: f.name,
      order: i + 1,
      source: f.source,
      call: callText(f, gate),
      calls: f.calls.map((c) => ({
        bean: c.bean,
        method: c.method,
        component: c.component,
        text: c.text,
        line: c.line,
        perSite: c.perSite,
        condition: c.condition,
        event: c.event,
      })),
      trigger: SCHEDULER_TRIGGER,
      perSite: f.calls.some((c) => c.perSite),
      gating: gate,
      tables: closure.tables,
      writeSet: closure.writes,
      conditionalWrites: closure.conditionalWrites,
      fileStoreWrite: closure.fileStore,
      unresolved: closure.unresolved,
      overrides: [...new Set([...closure.overrides, ...spanOverrides])].sort(compareText),
      closure,
      targetMechanism: spec?.targetMechanism ?? null,
      stateThisRun: spec?.stateThisRun ?? null,
      expected: spec?.expected ?? null,
    };
    if (f.calls.some((c) => c.method.toLowerCase() === 'announceevent')) step.dynamic = true;
    return step;
  });

  const gated = steps.flatMap((s, i) => (s.gating === null || facts[i] === undefined ? [] : [{ step: s, gate: s.gating, noun: nounOf(facts[i]) }]));
  const bounceDedupe = facts.find((f) => f.span.key === 'bounces')?.dedupe ?? null;
  const gatingRules = [
    ...gated.map((g) => `${g.noun} only where ${g.gate.flag} is set`),
    ...(bounceDedupe === null ? [] : [`the ${bounceDedupe.label} dedupe discards the listAppend result`]),
  ];
  const firstGated = gated[0]?.step;
  const lastGated = gated.at(-1)?.step;
  const catchUpFacts = facts.find((f) => f.catchUp !== null);
  const catchUp = catchUpFacts === undefined ? null : catchUpText(catchUpFacts);
  const windowFacts = facts.find((f) => f.window !== null);
  const firstStep = steps[0];
  const lastStep = steps.at(-1);
  const cursorDefault = cursorAttrs === null ? '' : unhash(cursorAttrs.default ?? '');
  const cursorMinutes = minutesOf(cursorDefault, runTime);
  const cursorEndValue = cursorEnd === undefined ? null : (assignment(cursorEnd.tag)?.expr ?? null);

  const semantics: JobSemantics = {
    cursor:
      cursorNode === undefined || cursorVar === null
        ? null
        : {
            rule:
              (cursorMinutes !== null && cursorMinutes < 0
                ? `${cursorVar} defaults to now - ${-cursorMinutes} minute${cursorMinutes === -1 ? '' : 's'}`
                : `${cursorVar} defaults to ${cursorDefault}`) +
              (cursorEndValue === null
                ? ''
                : runTime !== null && cursorEndValue.toLowerCase() === runTime.toLowerCase()
                  ? ' and is set to the run time at the end'
                  : ` and is set to ${cursorEndValue} at the end`),
            variable: cursorVar,
            default: cursorDefault,
            source: ref(CONTENT_SERVER_PATH, block.lineAt(cursorNode.tag.start), block.lastLine(cursorNode.end)),
            endSource: cursorEnd === undefined ? null : ref(CONTENT_SERVER_PATH, block.lineAt(cursorEnd.tag.start), block.lastLine(cursorEnd.end)),
          },
    catchUp:
      catchUpFacts?.catchUp === undefined || catchUpFacts.catchUp === null || catchUp === null
        ? null
        : {
            rule: catchUp.rule,
            step: catchUpFacts.name,
            predicate: catchUpFacts.catchUp.predicate,
            argument: catchUpFacts.catchUp.call.args[0] ?? '',
            source: catchUpFacts.catchUp.source,
          },
    order: {
      rule: 'steps run in the fixed order of steps[]',
      steps: steps.map((s) => s.step),
      source: firstStep === undefined || lastStep === undefined ? null : ref(CONTENT_SERVER_PATH, firstStep.source.lines[0], lastStep.source.lines[1]),
    },
    gating:
      firstGated === undefined || lastGated === undefined
        ? null
        : {
            rule: gatingRules.join('; '),
            source: ref(CONTENT_SERVER_PATH, firstGated.source.lines[0], lastGated.source.lines[1]),
            dedupeSource: bounceDedupe?.source ?? null,
          },
    purgeWindow:
      windowFacts?.window === undefined || windowFacts.window === null
        ? null
        : {
            rule: `display-window purge covers [${windowFacts.window.from}, ${windowFacts.window.to}]`,
            step: windowFacts.name,
            from: windowFacts.window.from,
            to: windowFacts.window.to,
            source: windowFacts.window.source,
          },
    bounceDedupeIneffective: bounceDedupe !== null,
  };

  const job: ScheduledJobEntry = {
    id: JOB_ID,
    source: ref(CONTENT_SERVER_PATH, block.lineAt(block.start), block.lastLine(block.bodyEnd)),
    routeKey: (await inventoryRouteKey({ kind: 'path', httpMethod: 'GET', path: registration.url }, opts)).key,
    trigger: SCHEDULER_TRIGGER,
    registration,
    semantics,
    expected: SITE_MONITOR_JOB_EXPECTED,
    steps,
  };
  return { job, differences: stepDifferences(steps) };
}

/** Parsed steps against {@link SITE_MONITOR_STEPS}: missing and unexpected steps, order and gating. */
function stepDifferences(steps: readonly ScheduledJobStep[]): JobDifference[] {
  const out: JobDifference[] = [];
  const diff = (step: string, kind: JobDifference['kind'], expected: string | number | null, computed: string | number | null): void => {
    out.push({ jobId: JOB_ID, step, kind, expected, computed });
  };
  const rank = new Map(SITE_MONITOR_STEPS.map((s, i) => [s.step, i + 1]));
  const known = steps.filter((s) => rank.has(s.step));
  for (const spec of SITE_MONITOR_STEPS) if (!steps.some((s) => s.step === spec.step)) diff(spec.step, 'missing-step', rank.get(spec.step) ?? null, null);
  for (const s of steps) if (!rank.has(s.step)) diff(s.step, 'unexpected-step', null, s.order);
  const expectedSeq = SITE_MONITOR_STEPS.map((s) => s.step).filter((n) => known.some((k) => k.step === n));
  known.forEach((s, i) => {
    if (expectedSeq[i] !== s.step) diff(s.step, 'order', rank.get(s.step) ?? null, s.order);
  });
  for (const s of known) {
    const flag = specOf(s.step)?.gateFlag ?? null;
    const computed = s.gating?.flag ?? null;
    if (flag !== computed) diff(s.step, 'gating', flag, computed);
  }
  return out;
}

/** `scheduledJobs[]` from the archive: the site-monitor job and how its parsed steps differ from the plan's. */
export async function extractJobs(ctx: ClosureContext, opts: { routeKeyOptions?: JobRouteKeyOptions } = {}): Promise<JobExtraction> {
  const { job, differences } = await siteMonitorJob(ctx, opts.routeKeyOptions);
  return { scheduledJobs: [job], differences };
}

/** Write evidence of every job step for `attachWriters`, keyed by the job's route key. */
export function jobWriteEvidence(jobs: readonly ScheduledJobEntry[]): JobWriteEvidence[] {
  return jobs.flatMap((j) => j.steps.map((s) => ({ entryRouteKey: j.routeKey, trigger: s.trigger, closure: s.closure })));
}
