import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Browser } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isInsideRepo } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';
import {
  CDN_PINS,
  FONT_WEIGHTS,
  MERMAID_THEME_VARIABLES,
  REQUIRED_CLASSES,
  REQUIRED_CUSTOM_PROPERTIES,
  REVEAL_CONFIG,
  checkDeckHtml,
  renderDeck,
} from '../../src/reporting/check-deck.js';
import type { CdnLibrary, DeckCheck, DeckFinding, RenderState } from '../../src/reporting/check-deck.js';

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/decks/${name}`, import.meta.url));
}

const SHA = pinnedSha();
const OTHER_SHA = '0'.repeat(40);
const VALID_PATH = fixturePath('valid-deck.html');
const VALID = await readFile(VALID_PATH, 'utf8');
const EMOJI = await readFile(fixturePath('emoji-deck.html'), 'utf8');
const ROCKET = String.fromCodePoint(0x1f680);
const NO_VISUAL = 'slide has no Mermaid diagram, KPI card, styled table or Lucide icon';
const CDN_LABELS: Readonly<Record<CdnLibrary, string>> = { reveal: 'reveal.js', mermaid: 'Mermaid', lucide: 'Lucide' };

type StaticCheck = Exclude<DeckCheck, `render-${string}`>;

/** Every finding kind checkDeckHtml can emit; the compiler rejects a missing or unknown kind. */
const STATIC_CHECKS: Readonly<Record<StaticCheck, true>> = {
  'section-count': true,
  'non-text-visual': true,
  'slide-order': true,
  divider: true,
  'content-bullets': true,
  'content-words': true,
  closing: true,
  'slide-style': true,
  emoji: true,
  'fenced-code': true,
  'mermaid-block': true,
  cdn: true,
  'local-reference': true,
  fonts: true,
  'theme-property': true,
  'theme-class': true,
  'reveal-config': true,
  'mermaid-config': true,
  'visual-wiring': true,
  'pinned-sha': true,
};

/** `html` with its one occurrence of `from` replaced by `to`; throws when `from` is absent or repeated. */
function edit(html: string, from: string, to: string): string {
  const at = html.indexOf(from);
  if (at === -1) throw new Error(`edit: ${JSON.stringify(from)} is absent`);
  if (html.includes(from, at + 1)) throw new Error(`edit: ${JSON.stringify(from)} occurs more than once`);
  return html.slice(0, at) + to + html.slice(at + from.length);
}

/** `html` with every occurrence of `from` replaced by `to`; throws when `from` is absent. */
function editAll(html: string, from: string, to: string): string {
  if (!html.includes(from)) throw new Error(`editAll: ${JSON.stringify(from)} is absent`);
  return html.split(from).join(to);
}

function kinds(findings: DeckFinding[]): DeckCheck[] {
  return findings.map((finding) => finding.check);
}

/** Source of each top-level slide of the valid fixture, in order. */
const SLIDES = [...VALID.matchAll(/^ {6}<section\b[\s\S]*?^ {6}<\/section>\n/gm)].map((match) => match[0]);

function slide(n: number): string {
  const source = SLIDES[n - 1];
  if (source === undefined) throw new Error(`the valid fixture has no slide ${n}`);
  return source;
}

/** The valid fixture with `from` replaced by `to` inside slide `n` only. */
function editSlide(n: number, from: string, to: string): string {
  return edit(VALID, slide(n), edit(slide(n), from, to));
}

function withoutSlides(...numbers: number[]): string {
  return numbers.reduce((html, n) => edit(html, slide(n), ''), VALID);
}

/** The valid fixture with `copies` extra copies of content slide 15 ahead of the closing slide. */
function withContentCopies(copies: number): string {
  return edit(VALID, slide(15), slide(15).repeat(copies + 1));
}

/** 1-based line of the first `needle` in `html`. */
function lineOf(html: string, needle: string): number {
  const at = html.indexOf(needle);
  if (at === -1) throw new Error(`lineOf: ${JSON.stringify(needle)} is absent`);
  return html.slice(0, at).split('\n').length;
}

/** The span of `text` from `start` through the next `end`; throws when either is absent. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = from === -1 ? -1 : text.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`between: ${JSON.stringify(start)} to ${JSON.stringify(end)} is absent`);
  return text.slice(from, to + end.length);
}

/** The inline-theme line holding the one rule whose selector ends in `.name`. */
function classRule(name: string): string {
  const lines = VALID.split('\n').filter((line) => {
    const brace = line.indexOf(' {');
    return brace !== -1 && line.slice(0, brace).trimStart().endsWith(`.${name}`);
  });
  const [line] = lines;
  if (lines.length !== 1 || line === undefined) throw new Error(`classRule: ${lines.length} rules select .${name}`);
  return `${line}\n`;
}

function words(count: number): string {
  return Array.from({ length: count }, () => 'fixture').join(' ');
}

/** A deck variant and every finding checkDeckHtml must return for it. */
interface Case {
  name: string;
  html: string;
  sha?: string;
  expected: DeckFinding[];
}

const SECTION_CASES: Case[] = [
  {
    name: 'flags 11 slides as one section-count finding',
    html: withoutSlides(6, 7, 8, 9, 14),
    expected: [{ check: 'section-count', detail: '11 top-level slides and 11 <section> elements; both must be 12–18' }],
  },
  { name: 'accepts 12 slides', html: withoutSlides(6, 7, 8, 9), expected: [] },
  { name: 'accepts 18 slides', html: withContentCopies(2), expected: [] },
  {
    name: 'flags 19 slides as one section-count finding',
    html: withContentCopies(3),
    expected: [{ check: 'section-count', detail: '19 top-level slides and 19 <section> elements; both must be 12–18' }],
  },
];

const ICON_ROW = '<div class="icon-row"><i data-lucide="server"></i><i data-lucide="cpu"></i><i data-lucide="cloud"></i></div>';

const STRUCTURE_CASES: Case[] = [
  {
    name: 'flags a content slide whose only visual became a paragraph',
    html: editSlide(7, ICON_ROW, '<p>Fixture paragraph</p>'),
    expected: [{ check: 'non-text-visual', slide: 7, detail: NO_VISUAL }],
  },
  {
    name: 'flags a first slide without slide-title',
    html: editSlide(1, '<section class="slide-title">', '<section>'),
    expected: [{ check: 'slide-order', slide: 1, detail: 'slide 1 must be the title slide (class slide-title)' }],
  },
  {
    name: 'flags a title slide without an eyebrow',
    html: editSlide(1, '<p class="eyebrow">', '<p class="kicker">'),
    expected: [{ check: 'slide-order', slide: 1, detail: 'title slide has no .eyebrow' }],
  },
  {
    name: 'flags a second slide that is not a content slide',
    html: editSlide(2, '<section>', '<section class="slide-divider">'),
    expected: [{ check: 'slide-order', slide: 2, detail: 'slide 2 must be a content slide' }],
  },
  {
    name: 'flags a third slide without the architecture diagram',
    html: editSlide(3, between(slide(3), '<pre class="mermaid">', '</pre>'), '<i data-lucide="network"></i>'),
    expected: [{ check: 'slide-order', slide: 3, detail: 'slide 3 must hold the architecture overview as a Mermaid diagram' }],
  },
  {
    name: 'flags a fourth slide that is not a section divider',
    html: editSlide(4, '<section class="slide-divider">', '<section>'),
    expected: [{ check: 'slide-order', slide: 4, detail: 'slide 4 must be a section divider (class slide-divider)' }],
  },
  {
    name: 'flags adjacent section dividers',
    html: withoutSlides(5),
    expected: [{ check: 'slide-order', slide: 5, detail: 'slides 4 and 5 are adjacent section dividers' }],
  },
  {
    name: 'flags a section divider directly before the closing slide',
    html: withoutSlides(15),
    expected: [{ check: 'slide-order', slide: 14, detail: 'a section divider directly precedes the closing slide' }],
  },
  {
    name: 'flags a last slide without slide-closing',
    html: editSlide(16, '<section class="slide-closing">', '<section>'),
    expected: [{ check: 'slide-order', slide: 16, detail: 'last slide must be the closing slide (class slide-closing)' }],
  },
  {
    name: 'flags a section divider without a heading',
    html: editSlide(4, '<h2>Fixture topic one</h2>', '<p>Fixture topic one</p>'),
    expected: [{ check: 'divider', slide: 4, detail: 'section divider has no h1 or h2 heading' }],
  },
  {
    name: 'flags a content slide with five bullets',
    html: editSlide(5, '<li>Fixture bullet three</li>', '<li>Fixture bullet three</li><li>Fixture bullet four</li><li>Fixture bullet five</li>'),
    expected: [{ check: 'content-bullets', slide: 5, detail: '5 bullets; content slides allow at most 4' }],
  },
  {
    name: 'flags a content slide with 41 words of body text',
    html: editSlide(7, '<div class="icon-row">', `<p>${words(35)}</p><div class="icon-row">`),
    expected: [{ check: 'content-words', slide: 7, detail: '41 words of body text; content slides allow at most 40' }],
  },
  {
    name: 'flags a two-word closing takeaway',
    html: editSlide(16, '<h2>Fixture deck ends here</h2>', '<h2>Fixture ends</h2>'),
    expected: [{ check: 'closing', slide: 16, detail: 'takeaway heading has 2 words; 3–6 required' }],
  },
  {
    name: 'flags a closing slide without its accent bar',
    html: editSlide(16, '        <div class="accent-bar"></div>\n', ''),
    expected: [{ check: 'closing', slide: 16, detail: 'closing slide has no .accent-bar' }],
  },
  {
    name: 'flags a closing slide that is not navy',
    html: edit(VALID, 'section.slide-closing { background: var(--blitzy-primary-navy);', 'section.slide-closing { background: var(--blitzy-primary);'),
    expected: [{ check: 'slide-style', slide: 16, detail: 'closing slide background must be navy #1A105F' }],
  },
  {
    name: 'flags an image loaded from a local path',
    html: editSlide(7, '<div class="icon-row">', '<img src="images/fixture.png"><div class="icon-row">'),
    expected: [{ check: 'local-reference', slide: 7, detail: '<img src="images/fixture.png"> must be an https:// or data: URL' }],
  },
];

const FENCED = editSlide(5, '<table class="deck-table">', '<p>```\nfixture code\n```</p>\n        <table class="deck-table">');
const FENCE_LINE = lineOf(FENCED, '```');
const CODE_BLOCK = editSlide(5, '<table class="deck-table">', '<pre><code>fixture = 1</code></pre>\n        <table class="deck-table">');
const CODE_LINE = lineOf(CODE_BLOCK, '<pre><code>');

const CHARACTER_CASES: Case[] = [
  {
    name: 'flags the emoji fixture once, at its U+1F680 on slide 5',
    html: EMOJI,
    expected: [{ check: 'emoji', slide: 5, detail: `emoji are not allowed; use Lucide icons: U+1F680 (line ${lineOf(EMOJI, ROCKET)})` }],
  },
  {
    name: 'flags a fenced code block inside a slide',
    html: FENCED,
    expected: [
      {
        check: 'fenced-code',
        slide: 5,
        detail: `code blocks are not allowed; use inline Fira Code: triple backticks (line ${FENCE_LINE}), triple backticks (line ${FENCE_LINE + 2})`,
      },
    ],
  },
  {
    name: 'flags a <pre><code> block inside a slide',
    html: CODE_BLOCK,
    expected: [
      {
        check: 'fenced-code',
        slide: 5,
        detail: `code blocks are not allowed; use inline Fira Code: <pre> outside a Mermaid diagram (line ${CODE_LINE}), <pre><code> block (line ${CODE_LINE})`,
      },
    ],
  },
  {
    name: 'flags a Mermaid diagram written as a <div>',
    html: editSlide(7, '<div class="icon-row">', '<div class="mermaid">flowchart LR</div><div class="icon-row">'),
    expected: [{ check: 'mermaid-block', slide: 7, detail: 'Mermaid diagram must be a <pre class="mermaid">, not <div>' }],
  },
  {
    name: 'flags a pre.mermaid holding markup',
    html: editSlide(9, between(slide(9), '<pre class="mermaid">', '</pre>'), '<pre class="mermaid"><b>flowchart LR</b></pre>'),
    expected: [{ check: 'mermaid-block', slide: 9, detail: 'pre.mermaid must hold raw Mermaid syntax, not markup' }],
  },
  {
    name: 'flags an empty pre.mermaid',
    html: editSlide(9, between(slide(9), '<pre class="mermaid">', '</pre>'), '<pre class="mermaid"></pre>'),
    expected: [{ check: 'mermaid-block', slide: 9, detail: 'pre.mermaid is empty' }],
  },
];

/** The valid fixture with `library` moved from its pin to `version` in every CDN URL, one cdn finding per URL. */
function cdnCase(library: CdnLibrary, version: string): Case {
  const label = CDN_LABELS[library];
  const pin = CDN_PINS[library];
  const token = `${label.toLowerCase()}@`;
  const html = editAll(VALID, `${token}${pin}`, `${token}${version}`);
  const urls = [...html.matchAll(/(?:src|href)="([^"]*)"/g)]
    .map((match) => match[1] ?? '')
    .filter((url) => url.includes(`${token}${version}`));
  if (urls.length === 0) throw new Error(`cdnCase: no ${label} URL in the valid fixture`);
  return {
    name: `flags ${label} ${version} as an unpinned CDN`,
    html,
    expected: urls.map((url): DeckFinding => ({ check: 'cdn', detail: `${label} ${version} in ${url}; the pinned version is ${pin}` })),
  };
}

const MERMAID_UNPINNED = cdnCase('mermaid', '11.3.0');
const MERMAID_SCRIPT = '  <script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.0/dist/mermaid.min.js"></script>\n';
const UNVERSIONED_LUCIDE = 'https://unpkg.com/lucide/dist/umd/lucide.min.js';

const CDN_CASES: Case[] = [
  cdnCase('reveal', '5.0.0'),
  MERMAID_UNPINNED,
  cdnCase('lucide', '0.459.0'),
  {
    name: 'flags a deck that loads no Mermaid script',
    html: edit(VALID, MERMAID_SCRIPT, ''),
    expected: [{ check: 'cdn', detail: 'no <script src> loads Mermaid 11.4.0' }],
  },
  {
    name: 'flags a Lucide script URL without a version',
    html: edit(VALID, 'https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js', UNVERSIONED_LUCIDE),
    expected: [
      { check: 'cdn', detail: `Lucide URL ${UNVERSIONED_LUCIDE} carries no version; pin 0.460.0` },
      { check: 'cdn', detail: 'no <script src> loads Lucide 0.460.0' },
    ],
  },
];

const REVEAL_EDITS: readonly (readonly [key: string, from: string, to: string, detail: string])[] = [
  ['hash', 'hash: true', 'hash: false', 'hash is false; expected true'],
  ['transition', "transition: 'slide'", "transition: 'fade'", "transition is 'fade'; expected 'slide'"],
  ['controlsTutorial', 'controlsTutorial: false', 'controlsTutorial: true', 'controlsTutorial is true; expected false'],
  ['width', 'width: 1920', 'width: 1280', 'width is 1280; expected 1920'],
  ['height', 'height: 1080', 'height: 720', 'height is 720; expected 1080'],
];

const REVEAL_CASES: Case[] = REVEAL_EDITS.map(([, from, to, detail]): Case => ({
  name: `flags Reveal.initialize with ${to}`,
  html: edit(VALID, from, to),
  expected: [{ check: 'reveal-config', detail }],
}));

const SCRIPT_CASES: Case[] = [
  {
    name: 'flags mermaid.initialize with startOnLoad: true',
    html: edit(VALID, 'startOnLoad: false', 'startOnLoad: true'),
    expected: [{ check: 'mermaid-config', detail: 'startOnLoad is true; expected false' }],
  },
  ...Object.entries(MERMAID_THEME_VARIABLES).map(
    ([key, value]): Case => ({
      name: `flags themeVariables.${key} set to #000000`,
      html: edit(VALID, `${key}: '${value}'`, `${key}: '#000000'`),
      expected: [{ check: 'mermaid-config', detail: `themeVariables.${key} is '#000000'; expected '${value}'` }],
    }),
  ),
  ...['ready', 'slidechanged'].map(
    (event): Case => ({
      name: `flags a deck that renders no visuals on the reveal.js ${event} event`,
      html: edit(VALID, `    Reveal.on('${event}', renderVisuals);\n`, ''),
      expected: [{ check: 'visual-wiring', detail: `no handler for the reveal.js ${event} event` }],
    }),
  ),
  {
    name: 'flags a visuals handler that never calls mermaid.run()',
    html: edit(VALID, '      mermaid.run();\n', ''),
    expected: [{ check: 'visual-wiring', detail: 'no mermaid.run() call in an inline script' }],
  },
  {
    name: 'flags a visuals handler that never calls lucide.createIcons()',
    html: edit(VALID, '      lucide.createIcons();\n', ''),
    expected: [{ check: 'visual-wiring', detail: 'no lucide.createIcons() call in an inline script' }],
  },
];

/** Required classes whose theme rule styles nothing the slide-style checks read. */
const COMPONENT_CLASSES = ['kpi-card', 'kpi-grid', 'kpi-value', 'kpi-label', 'kpi-icon', 'accent-bar', 'brand-lockup', 'hero-icon', 'icon-row'];
/** Required classes whose theme rule also carries a slide background, text colour or eyebrow font. */
const SLIDE_STYLED_CLASSES = ['slide-title', 'slide-divider', 'slide-closing', 'eyebrow'];

const THEME_CASES: Case[] = [
  ...Object.entries(REQUIRED_CUSTOM_PROPERTIES).map(
    ([property, value]): Case => ({
      name: `flags :root without ${property}`,
      html: edit(VALID, `      ${property}: ${value};\n`, ''),
      expected: [{ check: 'theme-property', detail: `:root does not define ${property}` }],
    }),
  ),
  {
    name: 'flags --blitzy-primary set to #5B39F4',
    html: edit(VALID, '--blitzy-primary: #5B39F3;', '--blitzy-primary: #5B39F4;'),
    expected: [{ check: 'theme-property', detail: '--blitzy-primary is #5B39F4; expected #5B39F3' }],
  },
  ...COMPONENT_CLASSES.map(
    (name): Case => ({
      name: `flags a theme without a .${name} rule`,
      html: edit(VALID, classRule(name), ''),
      expected: [{ check: 'theme-class', detail: `no inline CSS rule selects .${name}` }],
    }),
  ),
  {
    name: 'flags a theme without a Mermaid container rule',
    html: edit(VALID, classRule('mermaid'), ''),
    expected: [{ check: 'theme-class', detail: 'no inline CSS rule selects the Mermaid container (.mermaid…)' }],
  },
];

/** A Google Fonts css2 `family` value as the fixture link writes it. */
function fontSpec(family: string, weights: readonly number[]): string {
  return `${family.replaceAll(' ', '+')}:wght@${weights.join(';')}`;
}

const FONT_CASES: Case[] = [
  ...Object.entries(FONT_WEIGHTS).map(
    ([family, weights]): Case => ({
      name: `flags a Google Fonts link without ${family}`,
      html: edit(VALID, `family=${fontSpec(family, weights)}&`, ''),
      expected: [{ check: 'fonts', detail: `Google Fonts link does not load ${family}` }],
    }),
  ),
  ...Object.entries(FONT_WEIGHTS).flatMap(([family, weights]) =>
    weights.map(
      (weight): Case => ({
        name: `flags ${family} loaded without weight ${weight}`,
        html: edit(VALID, fontSpec(family, weights), fontSpec(family, weights.filter((w) => w !== weight))),
        expected: [{ check: 'fonts', detail: `${family} is loaded without weight ${weight}` }],
      }),
    ),
  ),
];

const SHA_CASES: Case[] = [
  {
    name: 'flags a title eyebrow without the pinned SHA',
    html: editSlide(1, `Source SHA ${SHA}`, 'Source SHA'),
    expected: [{ check: 'pinned-sha', slide: 1, detail: `title eyebrow does not carry the pinned SHA ${SHA}` }],
  },
  {
    name: 'flags the valid fixture against a different pinned SHA',
    html: VALID,
    sha: OTHER_SHA,
    expected: [{ check: 'pinned-sha', slide: 1, detail: `title eyebrow does not carry the pinned SHA ${OTHER_SHA}` }],
  },
];

const ALL_CASES: Case[] = [
  ...SECTION_CASES,
  ...STRUCTURE_CASES,
  ...CHARACTER_CASES,
  ...CDN_CASES,
  ...REVEAL_CASES,
  ...SCRIPT_CASES,
  ...THEME_CASES,
  ...FONT_CASES,
  ...SHA_CASES,
];

function checks(list: Case[]): void {
  it.each(list)('$name', ({ html, sha, expected }) => {
    expect(checkDeckHtml(html, { sha: sha ?? SHA })).toEqual(expected);
  });
}

const DECLARED_ICONS = VALID.split('data-lucide="').length - 1;

/** The state of the valid fixture once both diagrams and every icon have rendered. */
const RENDERED: RenderState = {
  slides: 16,
  diagrams: [
    { slide: 3, svg: true, error: false },
    { slide: 9, svg: true, error: false },
  ],
  placeholders: [],
  icons: DECLARED_ICONS,
};

/** How the fake page behaves; by default the deck loads, becomes ready and renders as {@link RENDERED}. */
interface PageScript {
  state?: RenderState;
  pageErrors?: string[];
  failedRequests?: { url: string; errorText: string }[];
  gotoError?: Error;
  revealReady?: boolean;
  collectError?: Error;
}

interface FakeChromium {
  launch: () => Promise<Browser>;
  calls: string[];
  gotos: string[];
}

/** A launch() whose browser serves one page answering renderDeck's probes from `script`. */
function fakeChromium(script: PageScript = {}): FakeChromium {
  const calls: string[] = [];
  const gotos: string[] = [];
  const listeners = new Map<string, ((payload: never) => void)[]>();
  const emit = <T>(event: string, payload: T): void => {
    for (const listener of listeners.get(event) ?? []) (listener as (value: T) => void)(payload);
  };
  const state = script.state ?? RENDERED;
  const settled = state.diagrams.every((diagram) => diagram.svg) && state.placeholders.length === 0;
  let waits = 0;
  const page = {
    on(event: 'pageerror' | 'requestfailed', listener: (payload: never) => void): void {
      calls.push(`on ${event}`);
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    async goto(url: string): Promise<null> {
      calls.push('goto');
      gotos.push(url);
      for (const message of script.pageErrors ?? []) emit('pageerror', new Error(message));
      for (const { url: failed, errorText } of script.failedRequests ?? []) {
        emit('requestfailed', { url: () => failed, failure: () => ({ errorText }) });
      }
      if (script.gotoError !== undefined) throw script.gotoError;
      return null;
    },
    async waitForFunction(): Promise<true> {
      calls.push('waitForFunction');
      waits += 1;
      const done = waits === 1 ? script.revealReady !== false : settled;
      if (!done) throw new Error('page.waitForFunction: Timeout exceeded');
      return true;
    },
    async evaluate(_probe: unknown, arg: unknown): Promise<unknown> {
      calls.push('evaluate');
      if (typeof arg !== 'string') return state.slides;
      if (script.collectError !== undefined) throw script.collectError;
      return state;
    },
  };
  const browser = {
    async newPage(): Promise<typeof page> {
      calls.push('newPage');
      return page;
    },
    async close(): Promise<void> {
      calls.push('close');
    },
  };
  // renderDeck touches only these members, so the fake stands in for the whole Playwright Browser.
  return { launch: async () => browser as unknown as Browser, calls, gotos };
}

function closes(chromium: FakeChromium): number {
  return chromium.calls.filter((call) => call === 'close').length;
}

describe('check-deck: Executive Presentation rule', () => {
  describe('checkDeckHtml', () => {
    it('passes the valid fixture deck and its 16 slides', () => {
      expect(SLIDES).toHaveLength(16);
      expect(checkDeckHtml(VALID, { sha: SHA })).toEqual([]);
    });

    it('reads the emoji fixture as the valid fixture plus one U+1F680 on slide 5', () => {
      expect(EMOJI).toBe(editSlide(5, 'Fixture bullet one</li>', `Fixture bullet one${ROCKET}</li>`));
      expect(kinds(checkDeckHtml(EMOJI, { sha: SHA }))).toEqual(['emoji']);
    });

    describe('slide count', () => checks(SECTION_CASES));

    describe('slide visuals, order and bodies', () => checks(STRUCTURE_CASES));

    describe('emoji, fenced code and Mermaid blocks', () => checks(CHARACTER_CASES));

    describe('CDN pins', () => {
      it('pins reveal.js 5.1.0, Mermaid 11.4.0 and Lucide 0.460.0', () => {
        expect(CDN_PINS).toEqual({ reveal: '5.1.0', mermaid: '11.4.0', lucide: '0.460.0' });
      });

      checks(CDN_CASES);
    });

    describe('reveal.js configuration', () => {
      it('changes each REVEAL_CONFIG option once', () => {
        expect(REVEAL_EDITS.map(([key]) => key)).toEqual(Object.keys(REVEAL_CONFIG));
      });

      checks(REVEAL_CASES);
    });

    describe('Mermaid and Lucide initialisation', () => checks(SCRIPT_CASES));

    describe('inline theme', () => {
      it('lists 21 custom properties and splits the required classes by what their rule styles', () => {
        expect(Object.keys(REQUIRED_CUSTOM_PROPERTIES)).toHaveLength(21);
        expect([...COMPONENT_CLASSES, ...SLIDE_STYLED_CLASSES].sort()).toEqual([...REQUIRED_CLASSES].sort());
      });

      checks(THEME_CASES);

      it.each(SLIDE_STYLED_CLASSES)('flags a theme without a .%s rule once, beside the slide styles it set', (name) => {
        const findings = checkDeckHtml(edit(VALID, classRule(name), ''), { sha: SHA });
        expect(findings.filter((finding) => finding.check === 'theme-class')).toEqual([
          { check: 'theme-class', detail: `no inline CSS rule selects .${name}` },
        ]);
        expect(new Set(kinds(findings))).toEqual(new Set(['theme-class', 'slide-style']));
      });
    });

    describe('fonts', () => checks(FONT_CASES));

    describe('pinned SHA', () => checks(SHA_CASES));

    it('has a case for every finding kind it emits', () => {
      const exercised = new Set(ALL_CASES.flatMap((c) => kinds(c.expected)));
      expect([...exercised].sort()).toEqual(Object.keys(STATIC_CHECKS).sort());
    });
  });

  describe('renderDeck', () => {
    it('reports nothing when every diagram and icon renders, and closes the browser', async () => {
      const chromium = fakeChromium();
      await expect(renderDeck(VALID_PATH, { launch: chromium.launch, timeoutMs: 50 })).resolves.toEqual([]);
      expect(chromium.gotos).toEqual([pathToFileURL(VALID_PATH).href]);
      expect(chromium.calls).toEqual([
        'newPage',
        'on pageerror',
        'on requestfailed',
        'goto',
        'waitForFunction',
        'evaluate',
        'waitForFunction',
        'evaluate',
        'close',
      ]);
    });

    it.each<{ name: string; script: PageScript; expected: DeckFinding[] }>([
      {
        name: 'reports a pre.mermaid that rendered no SVG',
        script: { state: { ...RENDERED, diagrams: RENDERED.diagrams.map((d) => (d.slide === 9 ? { ...d, svg: false } : d)) } },
        expected: [{ check: 'render-mermaid', slide: 9, detail: 'Mermaid diagram rendered no SVG' }],
      },
      {
        name: 'reports a pre.mermaid that rendered a syntax-error diagram',
        script: { state: { ...RENDERED, diagrams: RENDERED.diagrams.map((d) => (d.slide === 3 ? { ...d, error: true } : d)) } },
        expected: [{ check: 'render-mermaid', slide: 3, detail: 'Mermaid rendered a syntax-error diagram' }],
      },
      {
        name: 'reports a [data-lucide] placeholder left unreplaced',
        script: { state: { ...RENDERED, placeholders: [{ slide: 7, name: 'server' }], icons: DECLARED_ICONS - 1 } },
        expected: [{ check: 'render-lucide', slide: 7, detail: 'Lucide icon "server" was not replaced by an SVG' }],
      },
      {
        name: 'reports Lucide icons that became neither an SVG nor a placeholder',
        script: { state: { ...RENDERED, icons: DECLARED_ICONS - 2 } },
        expected: [
          { check: 'render-lucide', detail: `2 of ${DECLARED_ICONS} Lucide icons became neither an SVG nor a placeholder` },
        ],
      },
      {
        name: 'reports a CDN request that failed while the deck loads',
        script: { failedRequests: [{ url: 'https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js', errorText: 'net::ERR_NAME_NOT_RESOLVED' }] },
        expected: [
          {
            check: 'render-unavailable',
            detail: 'request failed: https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js (net::ERR_NAME_NOT_RESOLVED)',
          },
        ],
      },
      {
        name: 'reports a page error raised while the deck loads',
        script: { pageErrors: ['mermaid is not defined'] },
        expected: [{ check: 'render-error', detail: 'page error: mermaid is not defined' }],
      },
      {
        name: 'reports reveal.js never becoming ready',
        script: { revealReady: false },
        expected: [{ check: 'render-ready', detail: 'reveal.js was not ready within 50 ms' }],
      },
      {
        name: 'reports a deck that does not load',
        script: { gotoError: new Error('net::ERR_FILE_NOT_FOUND') },
        expected: [{ check: 'render-unavailable', detail: 'deck did not load: net::ERR_FILE_NOT_FOUND' }],
      },
    ])('$name, and closes the browser', async ({ script, expected }) => {
      const chromium = fakeChromium(script);
      await expect(renderDeck(VALID_PATH, { launch: chromium.launch, timeoutMs: 50 })).resolves.toEqual(expected);
      expect(closes(chromium)).toBe(1);
    });

    it('closes the browser when an in-page probe throws', async () => {
      const chromium = fakeChromium({ collectError: new Error('Execution context was destroyed') });
      await expect(renderDeck(VALID_PATH, { launch: chromium.launch, timeoutMs: 50 })).rejects.toThrow(
        'Execution context was destroyed',
      );
      expect(closes(chromium)).toBe(1);
    });

    it('reports a browser that does not launch', async () => {
      const launch = async (): Promise<Browser> => {
        throw new Error('Executable does not exist');
      };
      await expect(renderDeck(VALID_PATH, { launch })).resolves.toEqual([
        { check: 'render-unavailable', detail: 'Chromium did not launch (npx playwright install chromium): Executable does not exist' },
      ]);
    });
  });

  describe('main', () => {
    const playwright = { imported: 0, launches: [] as unknown[] };

    afterEach(() => {
      vi.doUnmock('@playwright/test');
      vi.resetModules();
      playwright.imported = 0;
      playwright.launches = [];
    });

    /** Runs a freshly imported main through runCli with `@playwright/test` mocked by `chromium`. */
    async function runCheck(
      argv: string[],
      chromium: FakeChromium = fakeChromium(),
    ): Promise<{ code: number; exits: number[]; summary: Record<string, unknown> }> {
      vi.resetModules();
      vi.doMock('@playwright/test', () => {
        playwright.imported += 1;
        return {
          chromium: {
            launch: async (options: unknown): Promise<Browser> => {
              playwright.launches.push(options);
              return chromium.launch();
            },
          },
        };
      });
      const { main } = await import('../../src/reporting/check-deck.js');
      // runCli comes from the same fresh module graph as main, so it recognises that graph's UsageError.
      const { runCli } = await import('../../src/lib/cli.js');
      const chunks: string[] = [];
      const exits: number[] = [];
      const code = await runCli(main, {
        argv,
        command: 'check-deck',
        stdout: { write: (chunk: string) => chunks.push(chunk) },
        exit: (exitCode: number) => {
          exits.push(exitCode);
        },
      });
      return { code, exits, summary: JSON.parse(chunks.join('')) as Record<string, unknown> };
    }

    it('checks the --file deck statically, exits 0 and never imports Playwright', async () => {
      const outcome = await runCheck(['--file', VALID_PATH]);
      expect(outcome.code).toBe(0);
      expect(outcome.exits).toEqual([0]);
      expect(outcome.summary).toEqual({
        command: 'check-deck',
        ok: true,
        code: 0,
        file: 'harness/test/fixtures/decks/valid-deck.html',
        sections: 16,
        findings: [],
      });
      expect(playwright.imported).toBe(0);
    });

    it('--render imports Playwright once, renders the deck in headless Chromium and exits 0', async () => {
      const chromium = fakeChromium();
      const outcome = await runCheck(['--file', VALID_PATH, '--render'], chromium);
      expect(outcome.code).toBe(0);
      expect(outcome.summary).toMatchObject({ ok: true, sections: 16, findings: [] });
      expect(playwright.imported).toBe(1);
      expect(playwright.launches).toEqual([{ headless: true }]);
      expect(chromium.gotos).toEqual([pathToFileURL(VALID_PATH).href]);
      expect(closes(chromium)).toBe(1);
    });

    it('exits 1 with the findings of a failing deck copy outside the checkout', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'check-deck-test-'));
      try {
        expect(isInsideRepo(dir)).toBe(false);
        const file = path.join(dir, 'index.html');
        await writeFile(file, MERMAID_UNPINNED.html);
        const outcome = await runCheck(['--file', file]);
        expect(outcome.code).toBe(1);
        expect(outcome.exits).toEqual([1]);
        expect(outcome.summary).toEqual({
          command: 'check-deck',
          ok: false,
          code: 1,
          file,
          sections: 16,
          findings: MERMAID_UNPINNED.expected,
        });
        expect(playwright.imported).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects an empty --file with exit 2', async () => {
      const outcome = await runCheck(['--file', '']);
      expect(outcome.code).toBe(2);
      expect(outcome.summary).toMatchObject({ ok: false, code: 2, error: { type: 'UsageError', message: '--file needs a path' } });
    });
  });
});
