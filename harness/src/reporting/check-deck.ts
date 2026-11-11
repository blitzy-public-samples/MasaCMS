// Verifies the executive summary deck against the user rule "Executive Presentation": static checks always, a Chromium render with --render.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Browser } from '@playwright/test';
import { load, type CheerioAPI } from 'cheerio';

import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { isInsideRepo, opt2Path, REPO_ROOT } from '../lib/paths.js';
import { pinnedSha } from '../lib/pin.js';

/** The deck checked when no `--file` is given. */
export const DECK_PATH: string = opt2Path('executive-summary/index.html');

const HERO_GRADIENT = 'linear-gradient(68deg, #7A6DEC 15.56%, #5B39F3 62.74%, #4101DB 84.44%)';

/** `:root` custom properties the inline theme must define, with their exact values. */
export const REQUIRED_CUSTOM_PROPERTIES: Readonly<Record<string, string>> = {
  '--blitzy-primary': '#5B39F3',
  '--blitzy-primary-dark': '#2D1C77',
  '--blitzy-primary-navy': '#1A105F',
  '--blitzy-primary-light': '#7A6DEC',
  '--blitzy-primary-deep': '#4101DB',
  '--blitzy-accent-teal': '#94FAD5',
  '--blitzy-surface-0': '#FFFFFF',
  '--blitzy-surface-1': '#F4EFF6',
  '--blitzy-surface-2': '#F2F0FE',
  '--blitzy-surface-3': '#F5F5F5',
  '--blitzy-border': '#D9D9D9',
  '--blitzy-border-soft': 'rgba(91, 57, 243, 0.18)',
  '--blitzy-text': '#333333',
  '--blitzy-text-muted': '#999999',
  '--blitzy-text-invert': '#FFFFFF',
  '--ff-body': "'Inter', system-ui, sans-serif",
  '--ff-display': "'Space Grotesk', 'Inter', sans-serif",
  '--ff-mono': "'Fira Code', 'Courier New', monospace",
  '--gradient-hero': HERO_GRADIENT,
  '--gradient-divider': 'linear-gradient(135deg, #2D1C77 0%, #5B39F3 100%)',
  '--gradient-accent-bar': 'linear-gradient(90deg, #5B39F3 0%, #94FAD5 100%)',
};

/** Slide-type and component classes the inline theme must select. */
export const REQUIRED_CLASSES: readonly string[] = [
  'slide-title',
  'slide-divider',
  'slide-closing',
  'kpi-card',
  'kpi-grid',
  'kpi-value',
  'kpi-label',
  'kpi-icon',
  'eyebrow',
  'accent-bar',
  'brand-lockup',
  'hero-icon',
  'icon-row',
];

/** A selector the Mermaid container rule must match: `.mermaid`, `pre.mermaid` or `.mermaid-container`. */
export const MERMAID_CONTAINER_SELECTOR: RegExp = /\.mermaid[\w-]*/;

/** Pinned CDN versions. */
export const CDN_PINS = { reveal: '5.1.0', mermaid: '11.4.0', lucide: '0.460.0' } as const;

/** A library pinned in {@link CDN_PINS}. */
export type CdnLibrary = keyof typeof CDN_PINS;

/** Whole-pathname-segment matchers per library: `<package>@<version>` captures the version; a bare `<package>` takes it from the next segment. */
export const CDN_MATCHERS: Readonly<Record<CdnLibrary, RegExp>> = {
  reveal: /^reveal\.js(?:@(.+))?$/,
  mermaid: /^mermaid(?:@(.+))?$/,
  lucide: /^lucide(?:@(.+))?$/,
};

/** Mermaid `themeVariables` values `mermaid.initialize` must set. */
export const MERMAID_THEME_VARIABLES: Readonly<Record<string, string>> = {
  primaryColor: '#F2F0FE',
  primaryTextColor: '#333333',
  primaryBorderColor: '#5B39F3',
  lineColor: '#999999',
  secondaryColor: '#F4EFF6',
};

/** `Reveal.initialize` options and their required values. */
export const REVEAL_CONFIG: Readonly<Record<string, string | number | boolean>> = {
  hash: true,
  transition: 'slide',
  controlsTutorial: false,
  width: 1920,
  height: 1080,
};

/** Google Fonts families and the weights each must load. */
export const FONT_WEIGHTS: Readonly<Record<string, readonly number[]>> = {
  Inter: [400, 500, 600, 700],
  'Space Grotesk': [500, 600, 700],
  'Fira Code': [400, 500],
};

/** What a finding is about; `render-*` kinds come only from {@link renderDeck}. */
export type DeckCheck =
  | 'section-count'
  | 'non-text-visual'
  | 'slide-order'
  | 'divider'
  | 'content-bullets'
  | 'content-words'
  | 'closing'
  | 'slide-style'
  | 'emoji'
  | 'fenced-code'
  | 'mermaid-block'
  | 'cdn'
  | 'local-reference'
  | 'fonts'
  | 'theme-property'
  | 'theme-class'
  | 'reveal-config'
  | 'mermaid-config'
  | 'visual-wiring'
  | 'pinned-sha'
  | 'render-unavailable'
  | 'render-ready'
  | 'render-mermaid'
  | 'render-lucide'
  | 'render-error';

/** One rule violation; `slide` is the 1-based top-level slide it lies in, when it lies in one. */
export interface DeckFinding {
  check: DeckCheck;
  slide?: number;
  detail: string;
}

/** Options of {@link renderDeck}; `launch` replaces the headless Chromium launch. */
export interface RenderOptions {
  timeoutMs?: number;
  /** Total ms from launch through close; by default every step's own wait plus launch and close slack. */
  budgetMs?: number;
  launch?: () => Promise<Browser>;
  /** With `launch`, terminates the browser it started once that browser outlasts the budget or fails to close. */
  kill?: () => Promise<void>;
}

const USAGE = 'check-deck [--file <path>] [--render]';
const SLIDE_SELECTOR = '.reveal .slides > section';
const SLIDE_RANGE = { min: 12, max: 18 } as const;
const CONTENT_MAX_BULLETS = 4;
const CONTENT_MAX_WORDS = 40;
const CLOSING_MAX_BULLETS = 3;
const CLOSING_HEADING_WORDS = { min: 3, max: 6 } as const;
const RENDER_TIMEOUT_MS = 30_000;
// Lets each slide's `slidechanged` handler start its Mermaid and Lucide work before the next slide is shown.
const SLIDE_SETTLE_MS = 200;
// Budget beyond the per-step waits for launch, page creation, probe overhead and the close reserve.
const RENDER_SLACK_MS = 30_000;
// The end of the budget kept for close: this, or a third of a smaller budget.
const CLOSE_RESERVE_MS = 5_000;
// How long a kill may wait, past the budget, for the killed browser to exit.
const KILL_WAIT_MS = 1_000;
const RENDER_VIEWPORT = { width: 1920, height: 1080 } as const;

const CDN_LABELS: Readonly<Record<CdnLibrary, string>> = { reveal: 'reveal.js', mermaid: 'Mermaid', lucide: 'Lucide' };
// A URL whose pathname names a library without a version the matcher can read is unpinned.
const CDN_NAMES: Readonly<Record<CdnLibrary, RegExp>> = {
  reveal: /\breveal\b/i,
  mermaid: /\bmermaid\b/i,
  lucide: /\blucide\b/i,
};
// Resolves relative and protocol-relative CDN URLs so their pathname can be read.
const CDN_URL_BASE = 'https://deck.invalid/';

const SLIDE_TYPE_CLASSES = [
  ['slide-title', 'title'],
  ['slide-divider', 'divider'],
  ['slide-closing', 'closing'],
] as const;

type SlideKind = 'title' | 'divider' | 'closing' | 'content';

const BODY_TEXT_EXCLUDED = 'h1, h2, h3, h4, h5, h6, .eyebrow, pre.mermaid, table, .kpi-card, aside.notes, script, style';
// Text of these elements runs on into its neighbours; every other element separates words.
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark',
  'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
]);
// A keycap or a flag (regional-indicator pair) is one emoji; so is each other pictograph, emoji-presentation character or FE0F.
const EMOJI = /[0-9#*]\u{FE0F}?\u{20E3}|\p{Regional_Indicator}{2}|[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{FE0F}]/gu;
// A character reference, or a bare `&`, taken whole so it decodes alone as the parser decodes it in text.
const REFERENCE = /&[#\w]*;?/g;
const FENCE = /`{3,}/g;
const GOOGLE_FONTS_CSS2 = 'https://fonts.googleapis.com/css2?';
const INVERT_COLOURS = ['var(--blitzy-text-invert)', '#fff', '#ffffff', 'white', 'rgb(255, 255, 255)'];

function slideElements($: CheerioAPI) {
  return $(SLIDE_SELECTOR).toArray();
}

// cheerio does not re-export domhandler's node types, so the element type is read from its API.
type DeckElement = ReturnType<typeof slideElements>[number];

interface Slide {
  el: DeckElement;
  number: number;
  kind: SlideKind;
  kinds: SlideKind[];
  start: number;
  end: number;
}

interface CssRule {
  selectors: string[];
  declarations: Map<string, string>;
  /** Rule body with comments masked. */
  body: string;
}

interface InlineScript {
  code: string;
  at: number;
}

interface Deck {
  html: string;
  $: CheerioAPI;
  slides: Slide[];
  hasStyle: boolean;
  rules: CssRule[];
  scripts: InlineScript[];
  themeAt: number;
  scriptsAt: number;
  lineStarts: number[];
}

/** Splits `text` at `separator` outside quotes and brackets. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Comments replaced by spaces of the same length, so offsets survive. */
function maskCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** Declarations of a rule body; property names lower-cased except custom properties. */
function cssDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const declaration of splitTopLevel(body, ';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) continue;
    const name = declaration.slice(0, colon).trim();
    declarations.set(name.startsWith('--') ? name : name.toLowerCase(), declaration.slice(colon + 1).trim());
  }
  return declarations;
}

/** Innermost style rules of `css` with their selector lists and declarations. */
function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  for (const match of maskCssComments(css).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const prelude = (match[1] ?? '').slice((match[1] ?? '').lastIndexOf(';') + 1).trim();
    if (prelude === '' || prelude.startsWith('@')) continue;
    const body = match[2] ?? '';
    const declarations = cssDeclarations(body);
    rules.push({ selectors: splitTopLevel(prelude, ',').map((s) => s.trim()).filter((s) => s !== ''), declarations, body });
  }
  return rules;
}

/** CSS value with insignificant whitespace collapsed, lower-case hex colours and single quotes. */
function normaliseCss(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .replace(/"/g, "'")
    .replace(/#[0-9a-f]{3,8}\b/gi, (hex) => hex.toLowerCase());
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches a selector that selects class `name`. */
function classPattern(name: string): RegExp {
  return new RegExp(`\\.${escapeRegExp(name)}(?![\\w-])`);
}

/** Comments replaced by spaces of the same length; string literals are kept and never read as comments. */
function maskJsComments(js: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < js.length; i += 1) {
    const ch = js.charAt(i);
    if (quote !== '') {
      out += ch;
      if (ch === '\\' && i + 1 < js.length) {
        i += 1;
        out += js.charAt(i);
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    const next = js.charAt(i + 1);
    if (ch === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? js.indexOf('\n', i) : js.indexOf('*/', i + 2);
      const stop = close === -1 ? js.length : next === '/' ? close : close + 2;
      out += js.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
  }
  return out;
}

/** Index of the bracket closing the one at `open`, or -1 when it is never closed. */
function closingBracket(code: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (quote !== '') {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The object literal passed to the first call matching `call` (a pattern ending at the literal's `{`). */
function objectArgument(scripts: InlineScript[], call: RegExp): { literal: string; at: number } | null {
  for (const script of scripts) {
    const match = call.exec(script.code);
    if (match === null) continue;
    const open = match.index + match[0].length - 1;
    const close = closingBracket(script.code, open);
    return { literal: script.code.slice(open, close === -1 ? undefined : close + 1), at: script.at + match.index };
  }
  return null;
}

/** Top-level `key: value` entries of an object literal, keys unquoted and values as written. */
function objectEntries(literal: string): Map<string, string> {
  const entries = new Map<string, string>();
  const body = literal.trim().replace(/^\{/, '').replace(/\}$/, '');
  for (const entry of splitTopLevel(body, ',')) {
    const [key, ...value] = splitTopLevel(entry, ':');
    if (key === undefined || value.length === 0) continue;
    entries.set(key.trim().replace(/^(['"`])(.*)\1$/, '$2'), value.join(':').trim());
  }
  return entries;
}

/** Whether the written literal `raw` equals `expected`; hex colours compare case-insensitively. */
function isLiteral(raw: string, expected: string | number | boolean): boolean {
  if (typeof expected !== 'string') return raw === String(expected);
  const quoted = /^(['"`])([\s\S]*)\1$/.exec(raw);
  return quoted !== null && normaliseCss(quoted[2] ?? '') === normaliseCss(expected);
}

function describeLiteral(value: string | number | boolean): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/** Whitespace-separated tokens holding a letter or digit. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

function startOf(el: DeckElement): number {
  return el.startIndex ?? 0;
}

/** Offset of an element's first child (the text of `<style>` and `<script>`), else of the element. */
function contentStart(el: DeckElement): number {
  return el.children[0]?.startIndex ?? startOf(el);
}

function parseDeck(html: string): Deck {
  const $ = load(html, { sourceCodeLocationInfo: true });
  const slides = slideElements($).map((el, i): Slide => {
    const kinds = SLIDE_TYPE_CLASSES.filter(([cls]) => $(el).hasClass(cls)).map(([, kind]): SlideKind => kind);
    return { el, number: i + 1, kind: kinds[0] ?? 'content', kinds, start: startOf(el), end: el.endIndex ?? html.length };
  });
  const styles = $('style').toArray();
  const scripts = $('script')
    .not('[src]')
    .toArray()
    .map((el): InlineScript => ({ code: maskJsComments($(el).text()), at: contentStart(el) }));
  const head = $('head').get(0);
  const lineStarts = [0];
  for (let i = html.indexOf('\n'); i !== -1; i = html.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  return {
    html,
    $,
    slides,
    hasStyle: styles.length > 0,
    rules: styles.flatMap((el) => cssRules($(el).text())),
    scripts,
    themeAt: styles[0] !== undefined ? contentStart(styles[0]) : head !== undefined ? startOf(head) : 0,
    scriptsAt: scripts.at(-1)?.at ?? html.length,
    lineStarts,
  };
}

/** 1-based line of `offset`. */
function lineOf(deck: Deck, offset: number): number {
  let low = 0;
  let high = deck.lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((deck.lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Number of the top-level slide holding `offset`, if any. */
function slideAt(deck: Deck, offset: number): number | undefined {
  return deck.slides.find((s) => s.start <= offset && offset < s.end)?.number;
}

/** Findings with their offsets, returned in document order. */
class FindingList {
  private readonly items: { at: number; finding: DeckFinding }[] = [];

  constructor(private readonly deck: Deck) {}

  add(check: DeckCheck, at: number, detail: string): void {
    const slide = slideAt(this.deck, at);
    this.items.push({ at, finding: slide === undefined ? { check, detail } : { check, slide, detail } });
  }

  /** One finding per slide (or for everything outside slides) listing each hit with its line. */
  addGrouped(check: DeckCheck, hits: { at: number; label: string }[], prefix: string): void {
    const groups = new Map<number, { at: number; labels: string[] }>();
    for (const hit of [...hits].sort((a, b) => a.at - b.at)) {
      const key = slideAt(this.deck, hit.at) ?? 0;
      const group = groups.get(key) ?? { at: hit.at, labels: [] };
      group.labels.push(`${hit.label} (line ${lineOf(this.deck, hit.at)})`);
      groups.set(key, group);
    }
    for (const group of groups.values()) this.add(check, group.at, `${prefix}: ${group.labels.join(', ')}`);
  }

  sorted(): DeckFinding[] {
    // Array sort is stable, so findings at one offset keep the order the checks raised them.
    return [...this.items].sort((a, b) => a.at - b.at).map((item) => item.finding);
  }
}

/** Visible text of `root` outside {@link BODY_TEXT_EXCLUDED}, with block boundaries kept as spaces. */
function bodyText($: CheerioAPI, root: DeckElement): string {
  const parts: string[] = [];
  const walk = (el: DeckElement): void => {
    for (const node of $(el).contents().toArray()) {
      if (node.nodeType === 3) {
        parts.push(node.data);
      } else if (node.nodeType === 1 && 'attribs' in node && !$(node).is(BODY_TEXT_EXCLUDED)) {
        const separator = INLINE_TAGS.has(node.name) ? '' : ' ';
        parts.push(separator);
        walk(node);
        parts.push(separator);
      }
    }
  };
  walk(root);
  return parts.join('');
}

function hasIcon($: CheerioAPI, root: DeckElement, selector: string): boolean {
  return $(root)
    .find(selector)
    .toArray()
    .some((el) => ($(el).attr('data-lucide') ?? '').trim() !== '');
}

function checkSectionCount(deck: Deck, out: FindingList): void {
  const slides = deck.slides.length;
  const sections = deck.$('section').length;
  const inRange = (n: number): boolean => n >= SLIDE_RANGE.min && n <= SLIDE_RANGE.max;
  if (!inRange(slides) || !inRange(sections)) {
    out.add(
      'section-count',
      0,
      `${slides} top-level slides and ${sections} <section> elements; both must be ${SLIDE_RANGE.min}–${SLIDE_RANGE.max}`,
    );
  }
}

const TABLE_PARTS = 'table, caption, thead, tbody, tfoot, tr, th, td';
// Pseudo-elements and state pseudo-classes, dropped so a rule styling an element's part or state counts for it; a bare one becomes `*`.
const UNEVALUATED_PSEUDOS =
  /::[\w-]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter|hover|active|focus(?:-visible|-within)?|visited|target)(?![\w-])/gi;

// A custom property (`--x`) or an identifier such as `border` or `-webkit-x`.
const CSS_PROPERTY = /^(?:--(?=.)|-?(?:[a-z_]|[\u0080-\uffff]|\\.))(?:[\w-]|[\u0080-\uffff]|\\.)*$/i;
const IMPORTANT = /!\s*important\s*$/i;

/** Whether a rule body or `style` attribute, comments ignored, has a declaration with a valid name and a value besides `!important`. */
function hasDeclaration(body: string): boolean {
  // An unclosed comment runs to the end of the CSS.
  return splitTopLevel(maskCssComments(body).replace(/\/\*[\s\S]*/, ''), ';').some((declaration) => {
    const colon = declaration.indexOf(':');
    return (
      colon !== -1 &&
      CSS_PROPERTY.test(declaration.slice(0, colon).trim()) &&
      declaration.slice(colon + 1).replace(IMPORTANT, '').trim() !== ''
    );
  });
}

/** Whether a table or its own parts carry an inline style or match an inline-CSS rule passing {@link hasDeclaration}. */
function styledTableTest(deck: Deck): (table: DeckElement) => boolean {
  const { $ } = deck;
  const parts = $(TABLE_PARTS);
  const matching = (selector: string): DeckElement[] => {
    const evaluable = selector.replace(UNEVALUATED_PSEUDOS, (_: string, at: number, all: string) =>
      /(^|[\s>+~(,])$/.test(all.slice(0, at)) ? '*' : '',
    );
    try {
      return parts.filter(evaluable).toArray();
    } catch {
      return [];
    }
  };
  const reached = parts.filter((_, el) => hasDeclaration($(el).attr('style') ?? '')).toArray();
  for (const rule of deck.rules) if (hasDeclaration(rule.body)) reached.push(...rule.selectors.flatMap(matching));
  const owners = new Set(reached.flatMap((el) => $(el).closest('table').toArray()));
  return (table) => owners.has(table);
}

/** Flags each `<section>` without a Mermaid diagram, KPI card, Lucide icon or table passing {@link styledTableTest}. */
function checkVisuals(deck: Deck, out: FindingList): void {
  const { $ } = deck;
  const isStyled = styledTableTest(deck);
  for (const section of $('section').toArray()) {
    const styledTable = $(section)
      .find('table')
      .toArray()
      .some((t) => isStyled(t));
    if ($(section).find('pre.mermaid, .kpi-card').length > 0 || styledTable || hasIcon($, section, 'i[data-lucide]')) continue;
    const nested = $(section).parent().is('section') ? 'nested <section>' : 'slide';
    out.add('non-text-visual', startOf(section), `${nested} has no Mermaid diagram, KPI card, styled table or Lucide icon`);
  }
}

function checkOrder(deck: Deck, out: FindingList): void {
  const { $, slides } = deck;
  const first = slides[0];
  const last = slides.at(-1);
  if (first === undefined || last === undefined) return;
  for (const slide of slides) {
    if (slide.kinds.length > 1) out.add('slide-order', slide.start, `slide carries ${slide.kinds.length} slide-type classes`);
  }
  if (first.kind !== 'title') out.add('slide-order', first.start, 'slide 1 must be the title slide (class slide-title)');
  if ($(first.el).find('.eyebrow').length === 0) out.add('slide-order', first.start, 'title slide has no .eyebrow');
  if (last !== first && last.kind !== 'closing') {
    out.add('slide-order', last.start, 'last slide must be the closing slide (class slide-closing)');
  }
  for (const slide of slides.slice(1, -1)) {
    if (slide.kind === 'title' || slide.kind === 'closing') {
      out.add('slide-order', slide.start, `only the ${slide.kind === 'title' ? 'first' : 'last'} slide may be slide-${slide.kind}`);
    }
  }
  const middle = (n: number): Slide | undefined => {
    const slide = slides[n - 1];
    return slide === undefined || slide === last ? undefined : slide;
  };
  for (const n of [2, 3]) {
    const slide = middle(n);
    if (slide !== undefined && slide.kind !== 'content') out.add('slide-order', slide.start, `slide ${n} must be a content slide`);
  }
  const architecture = middle(3);
  if (architecture !== undefined && $(architecture.el).find('pre.mermaid').length === 0) {
    out.add('slide-order', architecture.start, 'slide 3 must hold the architecture overview as a Mermaid diagram');
  }
  const firstDivider = middle(4);
  if (firstDivider !== undefined && firstDivider.kind !== 'divider') {
    out.add('slide-order', firstDivider.start, 'slide 4 must be a section divider (class slide-divider)');
  }
  slides.forEach((slide, i) => {
    const previous = slides[i - 1];
    if (previous?.kind === 'divider' && slide.kind === 'divider') {
      out.add('slide-order', slide.start, `slides ${previous.number} and ${slide.number} are adjacent section dividers`);
    }
  });
  const beforeLast = slides.at(-2);
  if (last.kind === 'closing' && beforeLast !== undefined && beforeLast !== first && beforeLast.kind === 'divider') {
    out.add('slide-order', beforeLast.start, 'a section divider directly precedes the closing slide');
  }
}

function checkSlideBodies(deck: Deck, out: FindingList): void {
  const { $ } = deck;
  for (const slide of deck.slides) {
    const $slide = $(slide.el);
    const bullets = $slide.find('li').length;
    if (slide.kind === 'divider') {
      if ($slide.find('h1, h2').length === 0) out.add('divider', slide.start, 'section divider has no h1 or h2 heading');
      if (!hasIcon($, slide.el, '[data-lucide]')) out.add('divider', slide.start, 'section divider has no Lucide icon');
    } else if (slide.kind === 'content') {
      if (bullets > CONTENT_MAX_BULLETS) {
        out.add('content-bullets', slide.start, `${bullets} bullets; content slides allow at most ${CONTENT_MAX_BULLETS}`);
      }
      const words = wordCount(bodyText($, slide.el));
      if (words > CONTENT_MAX_WORDS) {
        out.add('content-words', slide.start, `${words} words of body text; content slides allow at most ${CONTENT_MAX_WORDS}`);
      }
    } else if (slide.kind === 'closing') {
      if (bullets > CLOSING_MAX_BULLETS) {
        out.add('closing', slide.start, `${bullets} bullets; the closing slide allows at most ${CLOSING_MAX_BULLETS}`);
      }
      const heading = $slide.find('h1').first().length > 0 ? $slide.find('h1').first() : $slide.find('h2').first();
      const words = wordCount(heading.text());
      if (heading.length === 0) {
        out.add('closing', slide.start, 'closing slide has no h1 or h2 takeaway heading');
      } else if (words < CLOSING_HEADING_WORDS.min || words > CLOSING_HEADING_WORDS.max) {
        out.add(
          'closing',
          slide.start,
          `takeaway heading has ${words} words; ${CLOSING_HEADING_WORDS.min}–${CLOSING_HEADING_WORDS.max} required`,
        );
      }
      for (const component of ['brand-lockup', 'accent-bar']) {
        if ($slide.find(`.${component}`).length === 0) out.add('closing', slide.start, `closing slide has no .${component}`);
      }
    }
  }
}

const BACKGROUND_PROPERTIES = ['background', 'background-color', 'background-image'] as const;
const SLIDE_BACKGROUNDS: Readonly<Record<Exclude<SlideKind, 'content'>, { accepts: string[]; expected: string }>> = {
  title: { accepts: [normaliseCss(HERO_GRADIENT).toLowerCase(), 'var(--gradient-hero)'], expected: 'the hero gradient' },
  divider: {
    accepts: ['#2d1c77', 'var(--blitzy-primary-dark)', 'var(--gradient-divider)', 'gradient('],
    expected: 'dark purple #2D1C77 or a gradient',
  },
  closing: { accepts: ['#1a105f', 'var(--blitzy-primary-navy)'], expected: 'navy #1A105F' },
};

/** Normalised, lower-cased values of `properties` in rules having a selector that matches `selector`. */
function cssValues(deck: Deck, selector: RegExp, properties: readonly string[]): string[] {
  return deck.rules.flatMap((rule) =>
    rule.selectors.some((s) => selector.test(s))
      ? properties.flatMap((p) => {
          const value = rule.declarations.get(p);
          return value === undefined ? [] : [normaliseCss(value).toLowerCase()];
        })
      : [],
  );
}

function checkSlideStyle(deck: Deck, out: FindingList): void {
  const { $ } = deck;
  for (const slide of deck.slides) {
    if (slide.kind === 'content') continue;
    const spec = SLIDE_BACKGROUNDS[slide.kind];
    const attributes = ['data-background-color', 'data-background-gradient', 'data-background']
      .map((name) => $(slide.el).attr(name))
      .filter((value): value is string => value !== undefined)
      .map((value) => normaliseCss(value).toLowerCase());
    // The slide-type class must sit on the selector's last compound, i.e. on the slide itself.
    const ownRule = new RegExp(`\\.slide-${slide.kind}(?![\\w-])[^\\s>+~]*$`);
    const values = [...attributes, ...cssValues(deck, ownRule, BACKGROUND_PROPERTIES)];
    if (!values.some((value) => spec.accepts.some((accepted) => value.includes(accepted)))) {
      out.add('slide-style', slide.start, `${slide.kind} slide background must be ${spec.expected}`);
    }
  }
  const divider = deck.slides.find((s) => s.kind === 'divider');
  if (divider !== undefined && !cssValues(deck, classPattern('slide-divider'), ['text-align']).includes('center')) {
    out.add('slide-style', divider.start, 'no CSS rule centres the section divider heading (text-align: center)');
  }
  const title = deck.slides.find((s) => s.kind === 'title');
  if (title === undefined) return;
  if (!cssValues(deck, classPattern('slide-title'), ['color']).some((value) => INVERT_COLOURS.includes(value))) {
    out.add('slide-style', title.start, 'no CSS rule sets white text on the title slide');
  }
  const mono = cssValues(deck, classPattern('eyebrow'), ['font-family', 'font']);
  if (!mono.some((value) => value.includes('var(--ff-mono)') || value.includes('fira code'))) {
    out.add('slide-style', title.start, 'no CSS rule sets the eyebrow in Fira Code (--ff-mono)');
  }
  // A rule for the title's eyebrow, or one for every eyebrow that names no slide type.
  const titleEyebrow = /\.slide-title(?![\w-]).*\.eyebrow(?![\w-])|^(?!.*\.slide-).*\.eyebrow(?![\w-])/;
  const teal = cssValues(deck, titleEyebrow, ['color']);
  if (!teal.some((value) => value.includes('var(--blitzy-accent-teal)') || value.includes('#94fad5'))) {
    out.add('slide-style', title.start, 'no CSS rule colours the title eyebrow teal (--blitzy-accent-teal)');
  }
}

/** `U+XXXX` label of each code point of `text`, space-separated. */
function codePoints(text: string): string {
  return [...text].map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
}

// parse5 records each attribute's source span, which domhandler's location type omits.
type AttributeSpans = NonNullable<DeckElement['sourceCodeLocation']> & {
  attrs?: Record<string, { startOffset: number; endOffset: number }>;
};

/** Emoji in `value`, the parser's decoding of `html` from `start` to `end`, that a character reference produced. */
function referencedEmoji(
  html: string,
  value: string,
  start: number,
  end: number,
  decode: (reference: string) => string,
): { at: number; label: string }[] {
  const found = [...value.matchAll(EMOJI)];
  if (found.length === 0) return [];
  const raw = html.slice(start, end);
  const referenceAt = new Map<number, number>();
  let text = '';
  let last = 0;
  for (const m of raw.matchAll(REFERENCE)) {
    text += raw.slice(last, m.index).replace(/\r\n?/g, '\n');
    const decoded = decode(m[0]);
    for (let i = 0; i < decoded.length; i++) referenceAt.set(text.length + i, start + m.index);
    text += decoded;
    last = m.index + m[0].length;
  }
  text += raw.slice(last).replace(/\r\n?/g, '\n');
  // The parser drops the newline opening a <pre>, <textarea> or <listing> but keeps it in the span.
  const skip = text.length - value.length;
  if (text.endsWith(value)) {
    return found.flatMap((m) => {
      const units = Array.from({ length: m[0].length }, (_, i) => referenceAt.get(skip + m.index + i));
      const at = units.find((offset) => offset !== undefined);
      return at === undefined ? [] : [{ at, label: codePoints(m[0]) }];
    });
  }
  // The decoding does not map onto the span: each hit its literal characters do not account for is placed at its start.
  const literal = [...raw.matchAll(EMOJI)].map((m) => m[0]);
  return found.flatMap((m) => {
    const i = literal.indexOf(m[0]);
    if (i === -1) return [{ at: start, label: codePoints(m[0]) }];
    literal.splice(i, 1);
    return [];
  });
}

/** Emoji that character references put into text nodes and attribute values, each at its reference's offset. */
function encodedEmoji(deck: Deck): { at: number; label: string }[] {
  const { $, html } = deck;
  const cache = new Map<string, string>();
  const decode = (reference: string): string => {
    const decoded = cache.get(reference) ?? load(reference, null, false).text();
    cache.set(reference, decoded);
    return decoded;
  };
  const elements = $.root().find('*').toArray();
  const texts = $(elements)
    .contents()
    .toArray()
    .flatMap((node) => {
      if (node.nodeType !== 3) return [];
      const start = node.startIndex ?? 0;
      return referencedEmoji(html, node.data, start, node.endIndex ?? start, decode);
    });
  const attributes = elements.flatMap((el) => {
    const spans = (el.sourceCodeLocation as AttributeSpans | null | undefined)?.attrs;
    return Object.entries(el.attribs).flatMap(([name, value]) => {
      // SVG attribute names are case-adjusted after their spans are recorded; attributes merged into <html> or <body> have none.
      const span = spans?.[name] ?? spans?.[name.toLowerCase()];
      if (span === undefined) return referencedEmoji(html, value, startOf(el), startOf(el), decode);
      const open = /^[^=]*=\s*["']?/.exec(html.slice(span.startOffset, span.endOffset))?.[0] ?? '';
      const end = span.endOffset - (/["']$/.test(open) ? 1 : 0);
      return referencedEmoji(html, value, span.startOffset + open.length, end, decode);
    });
  });
  return [...texts, ...attributes];
}

function checkCharacters(deck: Deck, out: FindingList): void {
  const { $, html } = deck;
  out.addGrouped(
    'emoji',
    [...[...html.matchAll(EMOJI)].map((m) => ({ at: m.index, label: codePoints(m[0]) })), ...encodedEmoji(deck)],
    'emoji are not allowed; use Lucide icons',
  );
  out.addGrouped(
    'fenced-code',
    [
      ...[...html.matchAll(FENCE)].map((m) => ({ at: m.index, label: 'triple backticks' })),
      ...$('pre').not('.mermaid').toArray().map((el) => ({ at: startOf(el), label: '<pre> outside a Mermaid diagram' })),
      ...$('pre code').toArray().map((el) => ({ at: startOf(el), label: '<pre><code> block' })),
    ],
    'code blocks are not allowed; use inline Fira Code',
  );
  for (const el of $('.mermaid').not('pre').toArray()) {
    out.add('mermaid-block', startOf(el), `Mermaid diagram must be a <pre class="mermaid">, not <${el.name}>`);
  }
  for (const el of $('pre.mermaid').toArray()) {
    if ($(el).children().length > 0) out.add('mermaid-block', startOf(el), 'pre.mermaid must hold raw Mermaid syntax, not markup');
    else if ($(el).text().trim() === '') out.add('mermaid-block', startOf(el), 'pre.mermaid is empty');
  }
}

/** Decoded pathname segments of `url`, without its query or fragment; none when `url` does not parse. */
function pathSegments(url: string): string[] {
  let pathname: string;
  try {
    pathname = new URL(url, CDN_URL_BASE).pathname;
  } catch {
    return [];
  }
  return pathname.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

/** Versions of `library` in `segments`: the rest of a `<package>@…` segment, or the digit-led segment after a bare `<package>`. */
function cdnVersions(library: CdnLibrary, segments: readonly string[]): string[] {
  return segments.flatMap((segment, i) => {
    const match = CDN_MATCHERS[library].exec(segment);
    if (match === null) return [];
    if (match[1] !== undefined) return [match[1]];
    const next = segments[i + 1];
    return next !== undefined && /^\d/.test(next) ? [next] : [];
  });
}

function checkCdns(deck: Deck, out: FindingList): void {
  const { $ } = deck;
  const urls = $('script[src], link[href]')
    .toArray()
    .map((el) => ({ tag: el.name, url: ($(el).attr(el.name === 'script' ? 'src' : 'href') ?? '').trim(), at: startOf(el) }));
  for (const library of Object.keys(CDN_PINS) as CdnLibrary[]) {
    const pin = CDN_PINS[library];
    const label = CDN_LABELS[library];
    let scripted = false;
    for (const { tag, url, at } of urls) {
      const segments = pathSegments(url);
      const versions = cdnVersions(library, segments);
      if (versions.length === 0) {
        if (CDN_NAMES[library].test(segments.join('/'))) out.add('cdn', at, `${label} URL ${url} carries no version; pin ${pin}`);
        continue;
      }
      if (tag === 'script') scripted = true;
      for (const version of versions) {
        if (version !== pin) out.add('cdn', at, `${label} ${version} in ${url}; the pinned version is ${pin}`);
      }
    }
    if (!scripted) out.add('cdn', deck.scriptsAt, `no <script src> loads ${label} ${pin}`);
  }
}

const RESOURCE_URL = /^(https:\/\/|data:)/i;
const LINK_URL = /^(https:\/\/|#|mailto:)/i;
const CSS_URL = /^(https:|data:)/i;

/** Every `url(…)` and `@import` target in `css` that is neither https: nor data:; `at` maps a match index to an offset. */
function checkCssUrls(css: string, at: (index: number) => number, out: FindingList): void {
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi)) {
    const url = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!CSS_URL.test(url)) out.add('local-reference', at(m.index), `CSS url(${url}) must be an https: or data: URL`);
  }
  for (const m of css.matchAll(/@import\s+(['"])(.*?)\1/gi)) {
    const url = (m[2] ?? '').trim();
    if (!CSS_URL.test(url)) out.add('local-reference', at(m.index), `CSS @import ${url} must be an https: URL`);
  }
}

function checkReferences(deck: Deck, out: FindingList): void {
  const { $ } = deck;
  for (const el of $('[src], [srcset], [poster], link[href], object[data]').toArray()) {
    const names = ['src', 'poster', ...(el.name === 'link' ? ['href'] : []), ...(el.name === 'object' ? ['data'] : [])];
    const refs = names.flatMap((name) => {
      const value = $(el).attr(name);
      return value === undefined ? [] : [{ name, value: value.trim() }];
    });
    for (const candidate of ($(el).attr('srcset') ?? '').split(',').filter((c) => c.trim() !== '')) {
      refs.push({ name: 'srcset', value: candidate.trim().split(/\s+/)[0] ?? '' });
    }
    for (const { name, value } of refs) {
      if (!RESOURCE_URL.test(value)) {
        out.add('local-reference', startOf(el), `<${el.name} ${name}="${value}"> must be an https:// or data: URL`);
      }
    }
  }
  for (const el of $('a[href], area[href]').toArray()) {
    const href = ($(el).attr('href') ?? '').trim();
    if (!LINK_URL.test(href)) out.add('local-reference', startOf(el), `<${el.name} href="${href}"> must be https://, # or mailto:`);
  }
  for (const el of $('style').toArray()) {
    const base = contentStart(el);
    checkCssUrls(maskCssComments($(el).text()), (index) => base + index, out);
  }
  for (const el of $('[style]').toArray()) checkCssUrls($(el).attr('style') ?? '', () => startOf(el), out);
}

interface WeightRange {
  min: number;
  max: number;
}

/** Family name and normal-style weight ranges of one Google Fonts css2 `family` value, e.g. `Inter:wght@400;700`. */
function parseFamily(spec: string): { name: string; ranges: WeightRange[] } {
  const colon = spec.indexOf(':');
  const name = (colon === -1 ? spec : spec.slice(0, colon)).trim();
  const [axisList = '', tupleList = ''] = colon === -1 ? [] : spec.slice(colon + 1).split('@');
  const axes = axisList.split(',');
  const wght = axes.indexOf('wght');
  if (wght === -1) return { name, ranges: [{ min: 400, max: 400 }] };
  const ital = axes.indexOf('ital');
  const ranges = tupleList
    .split(';')
    .map((tuple) => tuple.split(','))
    .filter((values) => ital === -1 || values[ital] === '0')
    .flatMap((values): WeightRange[] => {
      const [low = '', high = low] = (values[wght] ?? '').split('..');
      const range = { min: Number(low), max: Number(high) };
      return low !== '' && Number.isFinite(range.min) && Number.isFinite(range.max) ? [range] : [];
    });
  return { name, ranges };
}

function checkFonts(deck: Deck, out: FindingList): void {
  const { $ } = deck;
  const links = $('link[href]')
    .toArray()
    .filter(
      (el) =>
        /\b(stylesheet|preload)\b/i.test($(el).attr('rel') ?? '') && ($(el).attr('href') ?? '').startsWith(GOOGLE_FONTS_CSS2),
    );
  const first = links[0];
  if (first === undefined) {
    out.add('fonts', deck.themeAt, 'no Google Fonts css2 <link rel="stylesheet">');
    return;
  }
  const loaded = new Map<string, WeightRange[]>();
  for (const el of links) {
    for (const spec of new URL($(el).attr('href') ?? '').searchParams.getAll('family')) {
      const { name, ranges } = parseFamily(spec);
      loaded.set(name, [...(loaded.get(name) ?? []), ...ranges]);
    }
  }
  for (const [family, weights] of Object.entries(FONT_WEIGHTS)) {
    const ranges = loaded.get(family);
    const missing = weights.filter((w) => !(ranges ?? []).some((r) => r.min <= w && w <= r.max));
    if (ranges === undefined) out.add('fonts', startOf(first), `Google Fonts link does not load ${family}`);
    else if (missing.length > 0) out.add('fonts', startOf(first), `${family} is loaded without weight ${missing.join(', ')}`);
  }
}

function checkTheme(deck: Deck, out: FindingList): void {
  if (!deck.hasStyle) {
    out.add('theme-property', deck.themeAt, 'deck has no inline <style> theme');
    return;
  }
  const root = new Map<string, string>();
  for (const rule of deck.rules) {
    if (rule.selectors.includes(':root')) for (const [name, value] of rule.declarations) root.set(name, value);
  }
  for (const [property, expected] of Object.entries(REQUIRED_CUSTOM_PROPERTIES)) {
    const actual = root.get(property);
    if (actual === undefined) out.add('theme-property', deck.themeAt, `:root does not define ${property}`);
    else if (normaliseCss(actual) !== normaliseCss(expected)) {
      out.add('theme-property', deck.themeAt, `${property} is ${actual}; expected ${expected}`);
    }
  }
  const selectors = deck.rules.flatMap((rule) => rule.selectors);
  for (const name of REQUIRED_CLASSES) {
    const pattern = classPattern(name);
    if (!selectors.some((s) => pattern.test(s))) out.add('theme-class', deck.themeAt, `no inline CSS rule selects .${name}`);
  }
  if (!selectors.some((s) => MERMAID_CONTAINER_SELECTOR.test(s))) {
    out.add('theme-class', deck.themeAt, 'no inline CSS rule selects the Mermaid container (.mermaid…)');
  }
}

function checkScripts(deck: Deck, out: FindingList): void {
  const reveal = objectArgument(deck.scripts, /\bReveal\.initialize\(\s*\{/);
  if (reveal === null) {
    out.add('reveal-config', deck.scriptsAt, 'no Reveal.initialize({…}) call in an inline script');
  } else {
    const options = objectEntries(reveal.literal);
    for (const [key, expected] of Object.entries(REVEAL_CONFIG)) {
      const raw = options.get(key);
      if (raw === undefined || !isLiteral(raw, expected)) {
        out.add('reveal-config', reveal.at, `${key} is ${raw ?? 'not set'}; expected ${describeLiteral(expected)}`);
      }
    }
  }
  const mermaid = objectArgument(deck.scripts, /\bmermaid\.initialize\(\s*\{/);
  if (mermaid === null) {
    out.add('mermaid-config', deck.scriptsAt, 'no mermaid.initialize({…}) call in an inline script');
  } else {
    const options = objectEntries(mermaid.literal);
    const startOnLoad = options.get('startOnLoad');
    if (startOnLoad !== 'false') out.add('mermaid-config', mermaid.at, `startOnLoad is ${startOnLoad ?? 'not set'}; expected false`);
    const themeVariables = options.get('themeVariables');
    const variables = themeVariables?.startsWith('{') === true ? objectEntries(themeVariables) : new Map<string, string>();
    for (const [key, expected] of Object.entries(MERMAID_THEME_VARIABLES)) {
      const raw = variables.get(key);
      if (raw === undefined || !isLiteral(raw, expected)) {
        out.add('mermaid-config', mermaid.at, `themeVariables.${key} is ${raw ?? 'not set'}; expected '${expected}'`);
      }
    }
  }
  const code = deck.scripts.map((script) => script.code).join('\n');
  for (const event of ['ready', 'slidechanged']) {
    if (!new RegExp(`\\.(?:on|addEventListener)\\(\\s*(['"\`])${event}\\1`).test(code)) {
      out.add('visual-wiring', deck.scriptsAt, `no handler for the reveal.js ${event} event`);
    }
  }
  if (!/\bmermaid\.run\(/.test(code)) out.add('visual-wiring', deck.scriptsAt, 'no mermaid.run() call in an inline script');
  if (!/\blucide\.createIcons\(/.test(code)) {
    out.add('visual-wiring', deck.scriptsAt, 'no lucide.createIcons() call in an inline script');
  }
}

function checkSha(deck: Deck, out: FindingList, sha: string): void {
  const title = deck.slides[0];
  const eyebrow = title === undefined ? undefined : deck.$(title.el).find('.eyebrow');
  if (title !== undefined && eyebrow !== undefined && eyebrow.length > 0) {
    if (!eyebrow.text().includes(sha)) out.add('pinned-sha', title.start, `title eyebrow does not carry the pinned SHA ${sha}`);
  } else if (!deck.html.includes(sha)) {
    out.add('pinned-sha', 0, `deck does not contain the pinned SHA ${sha}`);
  }
}

/** Static findings for the deck markup `html`, in document order; an empty array means the deck passes. */
export function checkDeckHtml(html: string, opts: { sha: string }): DeckFinding[] {
  const deck = parseDeck(html);
  const out = new FindingList(deck);
  checkSectionCount(deck, out);
  checkVisuals(deck, out);
  checkOrder(deck, out);
  checkSlideBodies(deck, out);
  checkSlideStyle(deck, out);
  checkCharacters(deck, out);
  checkCdns(deck, out);
  checkReferences(deck, out);
  checkFonts(deck, out);
  checkTheme(deck, out);
  checkScripts(deck, out);
  checkSha(deck, out, opts.sha);
  return out.sorted();
}

/** The browser globals the in-page probes touch; the harness compiles without the DOM library. */
interface ProbeElement {
  closest(selector: string): ProbeElement | null;
  querySelector(selector: string): ProbeElement | null;
  getAttribute(name: string): string | null;
}

interface ProbeWindow {
  document: { querySelectorAll(selector: string): ArrayLike<ProbeElement> };
  Reveal?: { isReady(): boolean; slide(indexh: number): void };
  setTimeout(handler: () => void, ms: number): unknown;
}

/** What the deck shows once every slide has been visited; slide 0 means outside any slide. */
export interface RenderState {
  slides: number;
  diagrams: { slide: number; svg: boolean; error: boolean }[];
  placeholders: { slide: number; name: string }[];
  icons: number;
}

// In-page probes are serialised into the browser: they may use only their argument and browser
// globals, and must not declare named inner functions (tsx would wrap them in an absent __name helper).
// They never run in Node, so Node coverage skips them; `check:deck --render` executes them.
/* v8 ignore start */
const revealReady = (): boolean => (globalThis as unknown as ProbeWindow).Reveal?.isReady() === true;

const visitSlides = async (args: { selector: string; settleMs: number }): Promise<number> => {
  const win = globalThis as unknown as ProbeWindow;
  const total = win.document.querySelectorAll(args.selector).length;
  for (let index = 0; index < total; index += 1) {
    win.Reveal?.slide(index);
    await new Promise<void>((resolve) => win.setTimeout(() => resolve(), args.settleMs));
  }
  return total;
};

const visualsRendered = (): boolean => {
  const doc = (globalThis as unknown as ProbeWindow).document;
  return (
    Array.from(doc.querySelectorAll('pre.mermaid')).every((el) => el.querySelector('svg') !== null) &&
    doc.querySelectorAll('i[data-lucide]').length === 0
  );
};

const collectState = (selector: string): RenderState => {
  const doc = (globalThis as unknown as ProbeWindow).document;
  const slides = Array.from(doc.querySelectorAll(selector));
  return {
    slides: slides.length,
    diagrams: Array.from(doc.querySelectorAll('pre.mermaid')).map((el) => ({
      slide: slides.indexOf(el.closest(selector) as ProbeElement) + 1,
      svg: el.querySelector('svg') !== null,
      error: el.querySelector('svg[aria-roledescription="error"]') !== null,
    })),
    placeholders: Array.from(doc.querySelectorAll('i[data-lucide]')).map((el) => ({
      slide: slides.indexOf(el.closest(selector) as ProbeElement) + 1,
      name: el.getAttribute('data-lucide') ?? '',
    })),
    icons: doc.querySelectorAll('svg[data-lucide], svg.lucide').length,
  };
};
/* v8 ignore stop */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderFinding(check: DeckCheck, slide: number, detail: string): DeckFinding {
  return slide > 0 ? { check, slide, detail } : { check, detail };
}

/** Findings for the rendered `state` of a deck that declares `declaredIcons` Lucide placeholders. */
function renderFindings(state: RenderState, declaredIcons: number): DeckFinding[] {
  const findings: DeckFinding[] = [];
  for (const diagram of state.diagrams) {
    if (!diagram.svg) findings.push(renderFinding('render-mermaid', diagram.slide, 'Mermaid diagram rendered no SVG'));
    else if (diagram.error) findings.push(renderFinding('render-mermaid', diagram.slide, 'Mermaid rendered a syntax-error diagram'));
  }
  for (const placeholder of state.placeholders) {
    findings.push(renderFinding('render-lucide', placeholder.slide, `Lucide icon "${placeholder.name}" was not replaced by an SVG`));
  }
  const lost = declaredIcons - state.icons - state.placeholders.length;
  if (lost > 0) {
    findings.push({ check: 'render-lucide', detail: `${lost} of ${declaredIcons} Lucide icons became neither an SVG nor a placeholder` });
  }
  return findings;
}

/** The render budget ran out while `step` was pending. */
class RenderExpired extends Error {
  override name = 'RenderExpired';
  readonly step: string;

  constructor(step: string) {
    super(`render budget expired during ${step}`);
    this.step = step;
  }
}

/** Settles as `work` does, or rejects with {@link RenderExpired} once `deadline` (a `performance.now()` time) passes. */
function beforeDeadline<T>(work: Promise<T>, step: string, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RenderExpired(step)), Math.max(0, deadline - performance.now()));
  });
  // race() keeps a handler on `work`, so a rejection it raises after expiry stays handled.
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

function stalledFinding(err: RenderExpired, budgetMs: number): DeckFinding {
  return { check: 'render-unavailable', detail: `render did not finish within the ${budgetMs} ms budget: stalled in ${err.step}` };
}

/** A launched browser; `close` ends what started it after the browser closes, `kill` terminates it. */
interface Launched {
  browser: Browser;
  close?: () => Promise<void>;
  kill?: () => Promise<void>;
}

/** Kills through `kill`, waiting at most {@link KILL_WAIT_MS}; why the kill did not finish, when it did not. */
async function killBrowser(kill: () => Promise<void>): Promise<string | undefined> {
  try {
    await beforeDeadline(kill(), 'kill', performance.now() + KILL_WAIT_MS);
    return undefined;
  } catch (err) {
    return err instanceof RenderExpired ? `no exit within ${KILL_WAIT_MS} ms` : errorMessage(err);
  }
}

/** Starts a headless Chromium server and connects to it by `deadline`; a server that arrives later or fails to connect is killed. */
async function launchChromium(deadline: number): Promise<Launched> {
  const { chromium } = await import('@playwright/test');
  const server = await chromium.launchServer({ headless: true });
  const kill = (): Promise<void> => server.kill();
  try {
    if (performance.now() >= deadline) throw new RenderExpired('launch');
    const browser = await beforeDeadline(chromium.connect(server.wsEndpoint()), 'launch', deadline);
    return { browser, close: () => server.close(), kill };
  } catch (err) {
    await killBrowser(kill);
    throw err;
  }
}

/** Closes the browser, then what launched it, by `deadline`; kills it when that fails or is late, with a finding when late. */
async function closeBrowser({ browser, close, kill }: Launched, budgetMs: number, deadline: number): Promise<DeckFinding | undefined> {
  try {
    await beforeDeadline(browser.close().then(() => close?.()), 'close', deadline);
    return undefined;
  } catch (err) {
    const unkilled = kill === undefined ? undefined : await killBrowser(kill);
    if (!(err instanceof RenderExpired)) throw err;
    const detail = `browser did not close within the ${budgetMs} ms render budget`;
    if (kill === undefined) return { check: 'render-unavailable', detail };
    const outcome = unkilled === undefined ? 'was killed' : `could not be killed: ${unkilled}`;
    return { check: 'render-unavailable', detail: `${detail} and ${outcome}` };
  }
}

/** Drives a new page of `browser` over the deck at `absolute`; rejects with {@link RenderExpired} past `deadline`. */
async function renderPage(
  browser: Browser,
  absolute: string,
  { timeoutMs, declaredIcons, deadline }: { timeoutMs: number; declaredIcons: number; deadline: number },
): Promise<DeckFinding[]> {
  const step = <T>(name: string, work: Promise<T>): Promise<T> => beforeDeadline(work, name, deadline);
  const page = await step('newPage', browser.newPage({ viewport: RENDER_VIEWPORT }));
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? 'failed'})`));
  const findings: DeckFinding[] = [];
  try {
    await step('goto', page.goto(pathToFileURL(absolute).href, { waitUntil: 'load', timeout: timeoutMs }));
  } catch (err) {
    if (err instanceof RenderExpired) throw err;
    return [{ check: 'render-unavailable', detail: `deck did not load: ${errorMessage(err)}` }];
  }
  const ready = await step(
    'reveal.js ready wait',
    page.waitForFunction(revealReady, undefined, { timeout: timeoutMs }).then(
      () => true,
      () => false,
    ),
  );
  if (ready) {
    await step('slide visits', page.evaluate(visitSlides, { selector: SLIDE_SELECTOR, settleMs: SLIDE_SETTLE_MS }));
    // A timeout here is reported through the collected state, which names each unrendered visual.
    await step('visuals wait', page.waitForFunction(visualsRendered, undefined, { timeout: timeoutMs }).catch(() => undefined));
    findings.push(...renderFindings(await step('state collection', page.evaluate(collectState, SLIDE_SELECTOR)), declaredIcons));
  } else {
    findings.push({ check: 'render-ready', detail: `reveal.js was not ready within ${timeoutMs} ms` });
  }
  const errorCounts = new Map<string, number>();
  for (const message of pageErrors) errorCounts.set(message, (errorCounts.get(message) ?? 0) + 1);
  return [
    ...failedRequests.map((request): DeckFinding => ({ check: 'render-unavailable', detail: `request failed: ${request}` })),
    ...findings,
    ...[...errorCounts].map(
      ([message, count]): DeckFinding => ({ check: 'render-error', detail: `page error${count > 1 ? ` (×${count})` : ''}: ${message}` }),
    ),
  ];
}

/**
 * Renders the deck at `file` in headless Chromium and reports what failed to render.
 * Page calls, in order: `on('pageerror')`, `on('requestfailed')`, `goto`, `waitForFunction` (reveal.js ready),
 * `evaluate` (visit every slide; `{ selector, settleMs }` argument), `waitForFunction` (all visuals rendered; a timeout is
 * tolerated), `evaluate` (collect a {@link RenderState}; selector argument). The browser is always closed, or else killed.
 * Launch through close finish within one budget whose end is reserved for close; the step it runs out in is reported.
 */
export async function renderDeck(file: string, opts: RenderOptions = {}): Promise<DeckFinding[]> {
  const timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS;
  const absolute = path.resolve(file);
  const $ = load(await readFile(absolute, 'utf8'));
  const declaredIcons = $('i[data-lucide]')
    .toArray()
    .filter((el) => ($(el).attr('data-lucide') ?? '').trim() !== '').length;
  const budgetMs = opts.budgetMs ?? 3 * timeoutMs + slideElements($).length * SLIDE_SETTLE_MS + RENDER_SLACK_MS;
  const deadline = performance.now() + budgetMs;
  const workDeadline = deadline - Math.min(CLOSE_RESERVE_MS, budgetMs / 3);
  const launching: Promise<Launched> =
    opts.launch === undefined ? launchChromium(workDeadline) : opts.launch().then((browser) => ({ browser, kill: opts.kill }));
  let launched: Launched;
  try {
    launched = await beforeDeadline(launching, 'launch', workDeadline);
  } catch (err) {
    if (!(err instanceof RenderExpired)) {
      return [{ check: 'render-unavailable', detail: `Chromium did not launch (npx playwright install chromium): ${errorMessage(err)}` }];
    }
    // A browser that launches too late to render is killed on arrival, or closed when nothing can kill it.
    void launching.then(({ browser, kill }) => (kill === undefined ? browser.close() : kill())).catch(() => undefined);
    return [stalledFinding(err, budgetMs)];
  }
  let findings: DeckFinding[];
  try {
    findings = await renderPage(launched.browser, absolute, { timeoutMs, declaredIcons, deadline: workDeadline });
  } catch (err) {
    if (!(err instanceof RenderExpired)) {
      await closeBrowser(launched, budgetMs, deadline);
      throw err;
    }
    findings = [stalledFinding(err, budgetMs)];
  }
  const unclosed = await closeBrowser(launched, budgetMs, deadline);
  return unclosed === undefined ? findings : [...findings, unclosed];
}

/** Number of top-level slides in `html`. */
function slideCount(html: string): number {
  return slideElements(load(html)).length;
}

function displayPath(file: string): string {
  return isInsideRepo(file) ? path.relative(REPO_ROOT, file).split(path.sep).join('/') : file;
}

/** `check-deck [--file <path>] [--render]`: exit 1 when any static or render check fails. */
export async function main(argv: string[]): Promise<CliOutcome> {
  const { values } = parseFlags(argv, {
    options: { file: { type: 'string' }, render: { type: 'boolean', default: false } },
    usage: USAGE,
  });
  if (values.file === '') throw new UsageError('--file needs a path', USAGE);
  const file = path.resolve(values.file ?? DECK_PATH);
  const html = await readFile(file, 'utf8');
  const findings = checkDeckHtml(html, { sha: pinnedSha() });
  if (values.render) findings.push(...(await renderDeck(file)));
  return { code: findings.length > 0 ? 1 : 0, summary: { file: displayPath(file), sections: slideCount(html), findings } };
}

if (isMainModule(import.meta.url)) void runCli(main);
