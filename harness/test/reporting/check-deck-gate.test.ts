import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Browser } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isInsideRepo } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';
import {
  CDN_PINS,
  DECK_PATH,
  FONT_WEIGHTS,
  MERMAID_THEME_VARIABLES,
  REQUIRED_CLASSES,
  REQUIRED_CUSTOM_PROPERTIES,
  REVEAL_CONFIG,
  checkDeckHtml,
  renderDeck,
} from '../../src/reporting/check-deck.js';
import type { DeckCheck, DeckFinding, RenderState } from '../../src/reporting/check-deck.js';

const DECK_URL = new URL('../../../opt2/executive-summary/index.html', import.meta.url);
const DECK = readFileSync(DECK_URL, 'utf8');
const SHA = pinnedSha();
const HEX_DIGITS = '0123456789abcdef';
/** A 40-hex SHA that differs from the pinned one in every digit. */
const OTHER_SHA = [...SHA].map((digit) => HEX_DIGITS.charAt((HEX_DIGITS.indexOf(digit) + 1) % 16)).join('');
const COMMAND = 'harness/src/reporting/check-deck.ts';
const USAGE = 'check-deck [--file <path>] [--render]';
const SLIDE_SELECTOR = '.reveal .slides > section';
const ROCKET = String.fromCodePoint(0x1f680);
const PARTY = String.fromCodePoint(0x1f389);
const NO_VISUAL = 'has no Mermaid diagram, KPI card, styled table or Lucide icon';

/** Source text of each top-level slide of the committed deck, in order. */
const SLIDES = [...DECK.matchAll(/^ {6}<section\b[\s\S]*?^ {6}<\/section>\n/gm)].map((match) => match[0]);

type Edit = readonly [from: string, to: string];

/** `html` with its one occurrence of `from` replaced by `to`; throws when `from` is absent or ambiguous. */
function edit(html: string, from: string, to: string): string {
  const at = html.indexOf(from);
  if (at === -1) throw new Error(`edit: ${JSON.stringify(from)} is absent`);
  if (html.indexOf(from, at + 1) !== -1) throw new Error(`edit: ${JSON.stringify(from)} occurs more than once`);
  return html.slice(0, at) + to + html.slice(at + from.length);
}

/** `html` with `edits` applied in order. */
function edits(html: string, ...list: Edit[]): string {
  return list.reduce((current, [from, to]) => edit(current, from, to), html);
}

/** The span of `text` from `start` through the next `end`; throws when either is absent. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = from === -1 ? -1 : text.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`between: ${JSON.stringify(start)} to ${JSON.stringify(end)} is absent`);
  return text.slice(from, to + end.length);
}

/** Source of the committed deck's 1-based slide `n`. */
function slide(n: number): string {
  const source = SLIDES[n - 1];
  if (source === undefined) throw new Error(`the deck has no slide ${n}`);
  return source;
}

/** `html` with `edits` applied inside `region` only. */
function editIn(html: string, region: string, ...list: Edit[]): string {
  return edit(html, region, edits(region, ...list));
}

/** `html` with `edits` applied inside the committed deck's slide `n`. */
function editSlide(html: string, n: number, ...list: Edit[]): string {
  return editIn(html, slide(n), ...list);
}

/** The committed deck without the slides numbered `numbers`. */
function withoutSlides(...numbers: number[]): string {
  return numbers.reduce((html, n) => edit(html, slide(n), ''), DECK);
}

/** The committed deck with `copies` extra copies of slide 14 before the closing slide. */
function withExtraSlides(copies: number): string {
  return edit(DECK, slide(16), slide(14).repeat(copies) + slide(16));
}

/** 1-based line of the committed deck holding `needle`. */
function lineOf(needle: string): number {
  const at = DECK.indexOf(needle);
  if (at === -1) throw new Error(`lineOf: ${JSON.stringify(needle)} is absent`);
  return DECK.slice(0, at).split('\n').length;
}

function words(count: number): string {
  return Array.from({ length: count }, () => 'word').join(' ');
}

/** A deck variant and the findings checkDeckHtml must return for it. */
interface Case {
  name: string;
  html: string;
  sha?: string;
  expected: DeckFinding[];
}

const CUTOVER_CAPTION = '        <p class="caption">Each stage must pass';
const CUTOVER_LINE = lineOf(CUTOVER_CAPTION);
const REVEAL_BLOCK = between(DECK, 'Reveal.initialize({', '});');
const MERMAID_BLOCK = between(DECK, 'mermaid.initialize({', '});');
const STYLE_BLOCK = between(DECK, '  <style>\n', '  </style>\n');
const EYEBROW = `            <p class="eyebrow">OPT-2 Migration | Source <span class="sha">${SHA}</span></p>\n`;
const HERO_GRADIENT = REQUIRED_CUSTOM_PROPERTIES['--gradient-hero'] ?? '';

/** Slide 14 with `markup` inserted on the caption's line, ahead of the caption. */
function beforeCutoverCaption(markup: string): string {
  return editSlide(DECK, 14, [CUTOVER_CAPTION, `        ${markup}${CUTOVER_CAPTION.trimStart()}`]);
}

function revealLiteral(value: string | number | boolean): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

function changedRevealLiteral(value: string | number | boolean): string {
  if (typeof value === 'boolean') return String(!value);
  return typeof value === 'number' ? String(value / 2) : `'${value}-changed'`;
}

function bumpPatch(version: string): string {
  return version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
}

const SECTION_COUNT_CASES: Case[] = [
  {
    name: 'reports 11 slides as one section-count finding',
    html: withoutSlides(10, 11, 12, 13, 14),
    expected: [{ check: 'section-count', detail: '11 top-level slides and 11 <section> elements; both must be 12–18' }],
  },
  { name: 'accepts 12 slides', html: withoutSlides(10, 11, 12, 13), expected: [] },
  { name: 'accepts 18 slides', html: withExtraSlides(2), expected: [] },
  {
    name: 'reports 19 slides as one section-count finding',
    html: withExtraSlides(3),
    expected: [{ check: 'section-count', detail: '19 top-level slides and 19 <section> elements; both must be 12–18' }],
  },
  {
    name: 'counts a nested <section> toward the section total',
    html: editSlide(withExtraSlides(2), 13, ['        <ul>\n', '        <section><i data-lucide="map"></i></section>\n        <ul>\n']),
    expected: [{ check: 'section-count', detail: '18 top-level slides and 19 <section> elements; both must be 12–18' }],
  },
];

const SLIDE_CASES: Case[] = [
  {
    name: 'reports a text-only slide as one non-text-visual finding',
    html: edit(DECK, slide(14), '      <section>\n        <h2>Cut-over sequence</h2>\n        <p>Each stage must pass.</p>\n      </section>\n'),
    expected: [{ check: 'non-text-visual', slide: 14, detail: `slide ${NO_VISUAL}` }],
  },
  {
    name: 'reports a text-only nested <section> as one non-text-visual finding',
    html: editSlide(DECK, 13, ['        <ul>\n', '        <section><p>Nested words only</p></section>\n        <ul>\n']),
    expected: [{ check: 'non-text-visual', slide: 13, detail: `nested <section> ${NO_VISUAL}` }],
  },
  {
    name: 'does not count an unstyled table as a visual',
    html: edit(DECK, slide(14), '      <section>\n        <h2>Plain</h2>\n        <table><tr><td>One</td></tr></table>\n      </section>\n'),
    expected: [{ check: 'non-text-visual', slide: 14, detail: `slide ${NO_VISUAL}` }],
  },
  {
    name: 'counts a classed table as a visual',
    html: edit(DECK, slide(14), '      <section>\n        <h2>Plain</h2>\n        <table class="deck-table"><tr><td>One</td></tr></table>\n      </section>\n'),
    expected: [],
  },
  {
    name: 'reports a first slide without slide-title as one slide-order finding',
    html: editSlide(DECK, 1, ['<section class="slide-title" ', '<section ']),
    expected: [{ check: 'slide-order', slide: 1, detail: 'slide 1 must be the title slide (class slide-title)' }],
  },
  {
    name: 'reports a title slide without an eyebrow as one slide-order finding',
    html: editSlide(DECK, 1, [EYEBROW, '']),
    expected: [{ check: 'slide-order', slide: 1, detail: 'title slide has no .eyebrow' }],
  },
  {
    name: 'reports a last slide without slide-closing as one slide-order finding',
    html: editSlide(DECK, 16, ['<section class="slide-closing" ', '<section ']),
    expected: [{ check: 'slide-order', slide: 16, detail: 'last slide must be the closing slide (class slide-closing)' }],
  },
  {
    name: 'reports a slide with two slide-type classes as one slide-order finding',
    html: editSlide(DECK, 4, ['<section class="slide-divider"', '<section class="slide-divider slide-closing"']),
    expected: [{ check: 'slide-order', slide: 4, detail: 'slide carries 2 slide-type classes' }],
  },
  {
    name: 'reports slide-title on a middle slide as one slide-order finding',
    html: editSlide(DECK, 5, ['<section>', '<section class="slide-title">']),
    expected: [{ check: 'slide-order', slide: 5, detail: 'only the first slide may be slide-title' }],
  },
  {
    name: 'reports a second slide that is not a content slide as one slide-order finding',
    html: editSlide(DECK, 2, ['<section>', '<section class="slide-divider">']),
    expected: [{ check: 'slide-order', slide: 2, detail: 'slide 2 must be a content slide' }],
  },
  {
    name: 'reports a third slide without a Mermaid diagram as one slide-order finding',
    html: editSlide(DECK, 3, [
      between(slide(3), '        <div class="mermaid-container">', '        </div>\n'),
      '        <i data-lucide="network"></i>\n',
    ]),
    expected: [{ check: 'slide-order', slide: 3, detail: 'slide 3 must hold the architecture overview as a Mermaid diagram' }],
  },
  {
    name: 'reports a fourth slide that is not a divider as one slide-order finding',
    html: editSlide(DECK, 4, ['<section class="slide-divider" data-background-color="#2D1C77">', '<section>']),
    expected: [{ check: 'slide-order', slide: 4, detail: 'slide 4 must be a section divider (class slide-divider)' }],
  },
  {
    name: 'reports adjacent dividers as one slide-order finding',
    html: edit(DECK, slide(4), slide(4) + slide(4)),
    expected: [{ check: 'slide-order', slide: 5, detail: 'slides 4 and 5 are adjacent section dividers' }],
  },
  {
    name: 'reports a divider directly before the closing slide as one slide-order finding',
    html: withoutSlides(13, 14, 15),
    expected: [{ check: 'slide-order', slide: 12, detail: 'a section divider directly precedes the closing slide' }],
  },
  {
    name: 'reports a divider without a heading as one divider finding',
    html: editSlide(DECK, 4, ['        <h2>Scope and mapping</h2>\n', '']),
    expected: [{ check: 'divider', slide: 4, detail: 'section divider has no h1 or h2 heading' }],
  },
  {
    name: 'reports a divider whose icon names nothing as a slide without visuals and a divider without an icon',
    html: editSlide(DECK, 4, ['<i data-lucide="map"', '<i data-lucide=""']),
    expected: [
      { check: 'non-text-visual', slide: 4, detail: `slide ${NO_VISUAL}` },
      { check: 'divider', slide: 4, detail: 'section divider has no Lucide icon' },
    ],
  },
  {
    name: 'accepts four bullets on a content slide',
    html: beforeCutoverCaption(`<ul>${'<li>Item</li>'.repeat(4)}</ul>`),
    expected: [],
  },
  {
    name: 'reports five bullets on a content slide as one content-bullets finding',
    html: beforeCutoverCaption(`<ul>${'<li>Item</li>'.repeat(5)}</ul>`),
    expected: [{ check: 'content-bullets', slide: 14, detail: '5 bullets; content slides allow at most 4' }],
  },
  {
    name: 'accepts 40 words of body text on a content slide',
    html: editSlide(DECK, 14, ['no calendar dates are set.', `no calendar dates are set. ${words(27)}`]),
    expected: [],
  },
  {
    name: 'reports 41 words of body text on a content slide as one content-words finding',
    html: editSlide(DECK, 14, ['no calendar dates are set.', `no calendar dates are set. ${words(28)}`]),
    expected: [{ check: 'content-words', slide: 14, detail: '41 words of body text; content slides allow at most 40' }],
  },
  {
    name: 'reports four closing bullets as one closing finding',
    html: editSlide(DECK, 16, ['never apply</li>\n', 'never apply</li>\n            <li>Celebrate</li>\n']),
    expected: [{ check: 'closing', slide: 16, detail: '4 bullets; the closing slide allows at most 3' }],
  },
  ...(
    [
      ['Behaviour kept', 2],
      ['Behaviour kept, platform', 3],
      ['Behaviour kept and platform fully modernised', 6],
      ['Behaviour kept and the platform fully modernised', 7],
    ] as const
  ).map(
    ([heading, count]): Case => ({
      name: `${count === 3 || count === 6 ? 'accepts' : 'reports'} a ${count}-word closing heading`,
      html: editSlide(DECK, 16, ['<h2>Behaviour kept, platform modernised</h2>', `<h2>${heading}</h2>`]),
      expected:
        count === 3 || count === 6 ? [] : [{ check: 'closing', slide: 16, detail: `takeaway heading has ${count} words; 3–6 required` }],
    }),
  ),
  {
    name: 'reports a closing slide without a heading as one closing finding',
    html: editSlide(DECK, 16, ['<h2>Behaviour kept, platform modernised</h2>', '<p>Behaviour kept, platform modernised</p>']),
    expected: [{ check: 'closing', slide: 16, detail: 'closing slide has no h1 or h2 takeaway heading' }],
  },
  {
    name: 'reports a closing slide without a brand lockup as one closing finding',
    html: editSlide(DECK, 16, ['<div class="brand-lockup">', '<div class="brand">']),
    expected: [{ check: 'closing', slide: 16, detail: 'closing slide has no .brand-lockup' }],
  },
  {
    name: 'reports a closing slide without an accent bar as one closing finding',
    html: editSlide(DECK, 16, ['        <div class="accent-bar"></div>\n', '']),
    expected: [{ check: 'closing', slide: 16, detail: 'closing slide has no .accent-bar' }],
  },
];

const STYLE_CASES: Case[] = [
  {
    name: 'reports a title slide without the hero gradient as one slide-style finding',
    html: edit(
      editSlide(DECK, 1, [` data-background-gradient="${HERO_GRADIENT}"`, '']),
      'section.slide-title { background: var(--gradient-hero); }',
      'section.slide-title { background: var(--blitzy-primary); }',
    ),
    expected: [{ check: 'slide-style', slide: 1, detail: 'title slide background must be the hero gradient' }],
  },
  {
    name: 'reports a divider with a light background as one slide-style finding',
    html: edit(
      editSlide(DECK, 4, ['data-background-color="#2D1C77"', 'data-background-color="#FFFFFF"']),
      'section.slide-divider { background: var(--blitzy-primary-dark);',
      'section.slide-divider { background: var(--blitzy-surface-0);',
    ),
    expected: [{ check: 'slide-style', slide: 4, detail: 'divider slide background must be dark purple #2D1C77 or a gradient' }],
  },
  {
    name: 'reports a closing slide without the navy background as one slide-style finding',
    html: edit(
      editSlide(DECK, 16, ['data-background-color="#1A105F"', 'data-background-color="#5B39F3"']),
      'section.slide-closing { background: var(--blitzy-primary-navy); }',
      'section.slide-closing { background: var(--blitzy-primary); }',
    ),
    expected: [{ check: 'slide-style', slide: 16, detail: 'closing slide background must be navy #1A105F' }],
  },
  {
    name: 'reports an uncentred divider heading as one slide-style finding',
    html: edit(DECK, 'var(--blitzy-primary-dark); text-align: center;', 'var(--blitzy-primary-dark); text-align: left;'),
    expected: [{ check: 'slide-style', slide: 4, detail: 'no CSS rule centres the section divider heading (text-align: center)' }],
  },
  {
    name: 'reports a title slide without white text as one slide-style finding',
    html: edits(
      DECK,
      ['section.slide-closing { color: var(--blitzy-text-invert); }', 'section.slide-closing { color: var(--blitzy-text); }'],
      ['.reveal .slide-closing h2 { color: var(--blitzy-text-invert); }', '.reveal .slide-closing h2 { color: var(--blitzy-text); }'],
      ['height: 260px; color: var(--blitzy-text-invert);', 'height: 260px; color: var(--blitzy-text);'],
    ),
    expected: [{ check: 'slide-style', slide: 1, detail: 'no CSS rule sets white text on the title slide' }],
  },
  {
    name: 'reports an eyebrow outside Fira Code as one slide-style finding',
    html: edit(DECK, '.reveal .eyebrow {\n      font-family: var(--ff-mono);', '.reveal .eyebrow {\n      font-family: var(--ff-body);'),
    expected: [{ check: 'slide-style', slide: 1, detail: 'no CSS rule sets the eyebrow in Fira Code (--ff-mono)' }],
  },
  {
    name: 'reports a title eyebrow that is not teal as one slide-style finding',
    html: edit(DECK, '.slide-closing .eyebrow { color: var(--blitzy-accent-teal); }', '.slide-closing .eyebrow { color: var(--blitzy-primary); }'),
    expected: [{ check: 'slide-style', slide: 1, detail: 'no CSS rule colours the title eyebrow teal (--blitzy-accent-teal)' }],
  },
];

const MARKUP_CASES: Case[] = [
  {
    name: 'reports an emoji inserted in a slide as one emoji finding',
    html: editSlide(DECK, 14, ['<h2>Cut-over sequence</h2>', `<h2>Cut-over sequence ${ROCKET}</h2>`]),
    expected: [
      {
        check: 'emoji',
        slide: 14,
        detail: `emoji are not allowed; use Lucide icons: U+1F680 (line ${lineOf('<h2>Cut-over sequence</h2>')})`,
      },
    ],
  },
  {
    name: 'groups two emoji of one slide into one emoji finding',
    html: editSlide(DECK, 14, ['<h2>Cut-over sequence</h2>', `<h2>${PARTY} Cut-over sequence ${ROCKET}</h2>`]),
    expected: [
      {
        check: 'emoji',
        slide: 14,
        detail: `emoji are not allowed; use Lucide icons: U+1F389 (line ${lineOf('<h2>Cut-over sequence</h2>')}), U+1F680 (line ${lineOf('<h2>Cut-over sequence</h2>')})`,
      },
    ],
  },
  {
    name: 'reports an emoji outside every slide as one emoji finding without a slide',
    html: edit(DECK, '<title>OPT-2 Migration - Executive Summary</title>', `<title>OPT-2 Migration ${ROCKET}</title>`),
    expected: [{ check: 'emoji', detail: `emoji are not allowed; use Lucide icons: U+1F680 (line ${lineOf('<title>')})` }],
  },
  {
    name: 'reports triple backticks in a slide as one fenced-code finding',
    html: editSlide(DECK, 14, ['no calendar dates are set.', 'no calendar dates are set. ```npm test```']),
    expected: [
      {
        check: 'fenced-code',
        slide: 14,
        detail: `code blocks are not allowed; use inline Fira Code: triple backticks (line ${CUTOVER_LINE}), triple backticks (line ${CUTOVER_LINE})`,
      },
    ],
  },
  {
    name: 'reports a <pre> block in a slide as one fenced-code finding',
    html: beforeCutoverCaption('<pre>npm test</pre>'),
    expected: [
      {
        check: 'fenced-code',
        slide: 14,
        detail: `code blocks are not allowed; use inline Fira Code: <pre> outside a Mermaid diagram (line ${CUTOVER_LINE})`,
      },
    ],
  },
  {
    name: 'reports a <pre><code> block in a slide as one fenced-code finding',
    html: beforeCutoverCaption('<pre><code>npm test</code></pre>'),
    expected: [
      {
        check: 'fenced-code',
        slide: 14,
        detail: `code blocks are not allowed; use inline Fira Code: <pre> outside a Mermaid diagram (line ${CUTOVER_LINE}), <pre><code> block (line ${CUTOVER_LINE})`,
      },
    ],
  },
  {
    name: 'reports a Mermaid diagram outside <pre> as one mermaid-block finding',
    html: editSlide(DECK, 7, ['        <div class="flow-detail">', '        <div class="mermaid">graph LR; A --> B</div>\n        <div class="flow-detail">']),
    expected: [{ check: 'mermaid-block', slide: 7, detail: 'Mermaid diagram must be a <pre class="mermaid">, not <div>' }],
  },
  {
    name: 'reports markup inside pre.mermaid as one mermaid-block finding',
    html: editSlide(DECK, 7, ['M1["Consistent snapshot"] --> M2', '<b>M1["Consistent snapshot"]</b> --> M2']),
    expected: [{ check: 'mermaid-block', slide: 7, detail: 'pre.mermaid must hold raw Mermaid syntax, not markup' }],
  },
  {
    name: 'reports an empty pre.mermaid as one mermaid-block finding',
    html: editSlide(DECK, 7, [between(slide(7), 'flowchart LR', 'legacy"]\n'), '']),
    expected: [{ check: 'mermaid-block', slide: 7, detail: 'pre.mermaid is empty' }],
  },
  ...(
    [
      ['<img src="assets/logo.png" alt="">', '<img src="assets/logo.png"> must be an https:// or data: URL'],
      [
        '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" srcset="https://example.com/a.png 1x, b.png 2x" alt="">',
        '<img srcset="b.png"> must be an https:// or data: URL',
      ],
      ['<a href="docs/readme.html">Docs</a>', '<a href="docs/readme.html"> must be https://, # or mailto:'],
      [`<span style="background: url('bg.png')"></span>`, 'CSS url(bg.png) must be an https: or data: URL'],
    ] as const
  ).map(
    ([markup, detail]): Case => ({
      name: `reports ${markup} in a slide as one local-reference finding`,
      html: beforeCutoverCaption(markup),
      expected: [{ check: 'local-reference', slide: 14, detail }],
    }),
  ),
  {
    name: 'reports a relative url() in the inline theme as one local-reference finding',
    html: edit(DECK, '.accent-bar { height: 12px;', '.accent-bar { background-image: url(img/bar.png); height: 12px;'),
    expected: [{ check: 'local-reference', detail: 'CSS url(img/bar.png) must be an https: or data: URL' }],
  },
  {
    name: 'reports a relative @import in the inline theme as one local-reference finding',
    html: edit(DECK, '  <style>\n', '  <style>\n    @import "theme.css";\n'),
    expected: [{ check: 'local-reference', detail: 'CSS @import theme.css must be an https: URL' }],
  },
];

const CDN_URLS = [
  { label: 'reveal.js', pin: CDN_PINS.reveal, url: `https://cdn.jsdelivr.net/npm/reveal.js@${CDN_PINS.reveal}/dist/reveal.css` },
  { label: 'reveal.js', pin: CDN_PINS.reveal, url: `https://cdn.jsdelivr.net/npm/reveal.js@${CDN_PINS.reveal}/dist/reveal.js` },
  { label: 'Mermaid', pin: CDN_PINS.mermaid, url: `https://cdn.jsdelivr.net/npm/mermaid@${CDN_PINS.mermaid}/dist/mermaid.min.js` },
  { label: 'Lucide', pin: CDN_PINS.lucide, url: `https://unpkg.com/lucide@${CDN_PINS.lucide}/dist/umd/lucide.min.js` },
] as const;
const LUCIDE_UNVERSIONED = 'https://unpkg.com/lucide/dist/umd/lucide.min.js';

const DELIVERY_CASES: Case[] = [
  ...CDN_URLS.map(({ label, pin, url }): Case => {
    const bumped = url.replace(`@${pin}`, `@${bumpPatch(pin)}`);
    return {
      name: `reports ${bumped} as one cdn finding`,
      html: edit(DECK, `"${url}"`, `"${bumped}"`),
      expected: [{ check: 'cdn', detail: `${label} ${bumpPatch(pin)} in ${bumped}; the pinned version is ${pin}` }],
    };
  }),
  {
    name: 'reports an unversioned Lucide script as unpinned and Lucide as not loaded',
    html: edit(DECK, `"${CDN_URLS[3].url}"`, `"${LUCIDE_UNVERSIONED}"`),
    expected: [
      { check: 'cdn', detail: `Lucide URL ${LUCIDE_UNVERSIONED} carries no version; pin ${CDN_PINS.lucide}` },
      { check: 'cdn', detail: `no <script src> loads Lucide ${CDN_PINS.lucide}` },
    ],
  },
  ...Object.entries(FONT_WEIGHTS).flatMap(([family, weights]): Case[] => {
    const plus = family.replaceAll(' ', '+');
    const loaded = `family=${plus}:wght@${weights.join(';')}`;
    return [
      {
        name: `reports a Google Fonts link without ${family} as one fonts finding`,
        html: edit(DECK, loaded, 'family=Roboto:wght@400'),
        expected: [{ check: 'fonts', detail: `Google Fonts link does not load ${family}` }],
      },
      {
        name: `reports ${family} loaded without weight ${String(weights.at(-1))} as one fonts finding`,
        html: edit(DECK, loaded, `family=${plus}:wght@${weights.slice(0, -1).join(';')}`),
        expected: [{ check: 'fonts', detail: `${family} is loaded without weight ${String(weights.at(-1))}` }],
      },
    ];
  }),
  {
    name: 'accepts a variable weight range covering every Inter weight',
    html: edit(DECK, 'family=Inter:wght@400;500;600;700', 'family=Inter:wght@400..700'),
    expected: [],
  },
  {
    name: 'reports a weight loaded only in italics as missing',
    html: edit(DECK, 'family=Space+Grotesk:wght@500;600;700', 'family=Space+Grotesk:ital,wght@0,500;0,600;1,700'),
    expected: [{ check: 'fonts', detail: 'Space Grotesk is loaded without weight 700' }],
  },
  {
    name: 'reads a family without a weight axis as weight 400 only',
    html: edit(DECK, 'family=Fira+Code:wght@400;500', 'family=Fira+Code'),
    expected: [{ check: 'fonts', detail: 'Fira Code is loaded without weight 500' }],
  },
  {
    name: 'reports a deck without a Google Fonts stylesheet as one fonts finding',
    html: edit(DECK, between(DECK, '  <link rel="stylesheet" href="https://fonts.googleapis.com/', '">\n'), ''),
    expected: [{ check: 'fonts', detail: 'no Google Fonts css2 <link rel="stylesheet">' }],
  },
  ...Object.entries(REQUIRED_CUSTOM_PROPERTIES).map(
    ([property, value]): Case => ({
      name: `reports a :root without ${property} as one theme-property finding`,
      html: edit(DECK, `      ${property}: ${value};\n`, ''),
      expected: [{ check: 'theme-property', detail: `:root does not define ${property}` }],
    }),
  ),
  {
    name: 'reports a changed custom property value as one theme-property finding',
    html: edit(DECK, '--blitzy-primary: #5B39F3;', '--blitzy-primary: #5B39F4;'),
    expected: [{ check: 'theme-property', detail: '--blitzy-primary is #5B39F4; expected #5B39F3' }],
  },
  {
    name: 'compares custom property hex colours case-insensitively',
    html: edit(DECK, '--blitzy-primary: #5B39F3;', '--blitzy-primary: #5b39f3;'),
    expected: [],
  },
  {
    name: 'reports a required class no inline rule selects as one theme-class finding',
    html: edit(DECK, '.kpi-label {', '.kpi-labelled {'),
    expected: [{ check: 'theme-class', detail: 'no inline CSS rule selects .kpi-label' }],
  },
  {
    name: 'reports a theme without a Mermaid container rule as one theme-class finding',
    html: edit(DECK, STYLE_BLOCK, STYLE_BLOCK.replaceAll('.mermaid', '.diagram')),
    expected: [{ check: 'theme-class', detail: 'no inline CSS rule selects the Mermaid container (.mermaid…)' }],
  },
  {
    name: 'reports a deck without an inline theme once, then each slide style and table style the theme no longer sets',
    html: edit(DECK, STYLE_BLOCK, ''),
    expected: [
      { check: 'theme-property', detail: 'deck has no inline <style> theme' },
      { check: 'slide-style', slide: 1, detail: 'no CSS rule sets white text on the title slide' },
      { check: 'slide-style', slide: 1, detail: 'no CSS rule sets the eyebrow in Fira Code (--ff-mono)' },
      { check: 'slide-style', slide: 1, detail: 'no CSS rule colours the title eyebrow teal (--blitzy-accent-teal)' },
      { check: 'slide-style', slide: 4, detail: 'no CSS rule centres the section divider heading (text-align: center)' },
      ...[9, 11, 15].map((n): DeckFinding => ({ check: 'non-text-visual', slide: n, detail: `slide ${NO_VISUAL}` })),
    ],
  },
  ...Object.entries(REVEAL_CONFIG).map(
    ([key, value]): Case => ({
      name: `reports reveal.js ${key} set to ${changedRevealLiteral(value)} as one reveal-config finding`,
      html: editIn(DECK, REVEAL_BLOCK, [`${key}: ${revealLiteral(value)}`, `${key}: ${changedRevealLiteral(value)}`]),
      expected: [{ check: 'reveal-config', detail: `${key} is ${changedRevealLiteral(value)}; expected ${revealLiteral(value)}` }],
    }),
  ),
  {
    name: 'reports a reveal.js option left unset as one reveal-config finding',
    html: editIn(DECK, REVEAL_BLOCK, ['      controlsTutorial: false,\n', '']),
    expected: [{ check: 'reveal-config', detail: 'controlsTutorial is not set; expected false' }],
  },
  {
    name: 'reports a deck that never calls Reveal.initialize as one reveal-config finding',
    html: editIn(DECK, REVEAL_BLOCK, ['Reveal.initialize({', 'Reveal.configure({']),
    expected: [{ check: 'reveal-config', detail: 'no Reveal.initialize({…}) call in an inline script' }],
  },
  {
    name: 'reports Mermaid startOnLoad true as one mermaid-config finding',
    html: editIn(DECK, MERMAID_BLOCK, ['startOnLoad: false', 'startOnLoad: true']),
    expected: [{ check: 'mermaid-config', detail: 'startOnLoad is true; expected false' }],
  },
  {
    name: 'reports Mermaid startOnLoad left unset as one mermaid-config finding',
    html: editIn(DECK, MERMAID_BLOCK, ['      startOnLoad: false,\n', '']),
    expected: [{ check: 'mermaid-config', detail: 'startOnLoad is not set; expected false' }],
  },
  {
    name: 'reports a deck that never calls mermaid.initialize as one mermaid-config finding',
    html: editIn(DECK, MERMAID_BLOCK, ['mermaid.initialize({', 'mermaid.setup({']),
    expected: [{ check: 'mermaid-config', detail: 'no mermaid.initialize({…}) call in an inline script' }],
  },
  ...Object.entries(MERMAID_THEME_VARIABLES).map(
    ([key, value]): Case => ({
      name: `reports Mermaid themeVariables.${key} changed as one mermaid-config finding`,
      html: editIn(DECK, MERMAID_BLOCK, [`${key}: '${value}'`, `${key}: '#000000'`]),
      expected: [{ check: 'mermaid-config', detail: `themeVariables.${key} is '#000000'; expected '${value}'` }],
    }),
  ),
  {
    name: 'compares Mermaid theme hex colours case-insensitively',
    html: editIn(DECK, MERMAID_BLOCK, ["primaryColor: '#F2F0FE'", "primaryColor: '#f2f0fe'"]),
    expected: [],
  },
  ...(['ready', 'slidechanged'] as const).map(
    (event): Case => ({
      name: `reports a deck without a reveal.js ${event} handler as one visual-wiring finding`,
      html: edit(DECK, `    Reveal.on('${event}', event => renderVisuals(event.currentSlide));\n`, ''),
      expected: [{ check: 'visual-wiring', detail: `no handler for the reveal.js ${event} event` }],
    }),
  ),
  {
    name: 'accepts a ready handler registered through addEventListener',
    html: edit(DECK, "Reveal.on('ready',", "Reveal.addEventListener('ready',"),
    expected: [],
  },
  {
    name: 'reports a deck without mermaid.run() as one visual-wiring finding',
    html: edit(DECK, between(DECK, 'mermaid.run(', "data-processed])') })"), 'Promise.resolve()'),
    expected: [{ check: 'visual-wiring', detail: 'no mermaid.run() call in an inline script' }],
  },
  {
    name: 'reports a deck without lucide.createIcons() as one visual-wiring finding',
    html: edit(DECK, '      lucide.createIcons();\n', ''),
    expected: [{ check: 'visual-wiring', detail: 'no lucide.createIcons() call in an inline script' }],
  },
  {
    name: 'does not count a commented-out lucide.createIcons() call',
    html: edit(DECK, 'lucide.createIcons();', '// lucide.createIcons();'),
    expected: [{ check: 'visual-wiring', detail: 'no lucide.createIcons() call in an inline script' }],
  },
  {
    name: 'reports a pinned SHA the title eyebrow does not carry as one pinned-sha finding',
    html: DECK,
    sha: OTHER_SHA,
    expected: [{ check: 'pinned-sha', slide: 1, detail: `title eyebrow does not carry the pinned SHA ${OTHER_SHA}` }],
  },
  {
    name: 'reports a title eyebrow without the SHA as one pinned-sha finding',
    html: editSlide(DECK, 1, [` | Source <span class="sha">${SHA}</span>`, '']),
    expected: [{ check: 'pinned-sha', slide: 1, detail: `title eyebrow does not carry the pinned SHA ${SHA}` }],
  },
  {
    name: 'reports a deck with neither an eyebrow nor the pinned SHA once for each',
    html: editSlide(DECK, 1, [EYEBROW, '']),
    sha: OTHER_SHA,
    expected: [
      { check: 'pinned-sha', detail: `deck does not contain the pinned SHA ${OTHER_SHA}` },
      { check: 'slide-order', slide: 1, detail: 'title slide has no .eyebrow' },
    ],
  },
];

type StaticCheck = Exclude<DeckCheck, `render-${string}`>;

const STATIC_CHECKS: Record<StaticCheck, true> = {
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

const ALL_CASES = [...SECTION_COUNT_CASES, ...SLIDE_CASES, ...STYLE_CASES, ...MARKUP_CASES, ...DELIVERY_CASES];

/** A request the fake page reports as failed. */
interface FailedRequest {
  url(): string;
  failure(): { errorText: string } | null;
}

/** How the fake page behaves; every wait settles and nothing fails unless set. */
interface PageScript {
  state?: RenderState;
  revealReady?: boolean;
  visualsSettle?: boolean;
  pageErrors?: string[];
  failedRequests?: { url: string; errorText?: string }[];
  gotoError?: Error;
  collectError?: Error;
}

interface Call {
  method: string;
  args: unknown[];
}

type Listener = (payload: never) => void;

const DIAGRAM_SLIDES = SLIDES.flatMap((source, i) => (source.includes('<pre class="mermaid">') ? [i + 1] : []));
const DECLARED_ICONS = (DECK.match(/<i data-lucide="[^"]+"/g) ?? []).length;
const RENDERED: RenderState = {
  slides: SLIDES.length,
  diagrams: DIAGRAM_SLIDES.map((n) => ({ slide: n, svg: true, error: false })),
  placeholders: [],
  icons: DECLARED_ICONS,
};
const DRIVEN = ['newPage', 'on pageerror', 'on requestfailed', 'goto', 'waitForFunction', 'evaluate', 'waitForFunction', 'evaluate', 'close'];

/** A launch() whose browser serves one page scripted by `script`, recording every call renderDeck makes. */
function fakeChromium(script: PageScript = {}): { launch: () => Promise<Browser>; calls: Call[] } {
  const calls: Call[] = [];
  const listeners = new Map<string, Listener[]>();
  const emit = <T>(event: string, payload: T): void => {
    for (const listener of listeners.get(event) ?? []) (listener as (value: T) => void)(payload);
  };
  let waits = 0;
  const page = {
    on(event: 'pageerror' | 'requestfailed', listener: Listener): void {
      calls.push({ method: `on ${event}`, args: [] });
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    async goto(url: string, options: { waitUntil: string; timeout: number }): Promise<null> {
      calls.push({ method: 'goto', args: [url, options] });
      for (const message of script.pageErrors ?? []) emit('pageerror', new Error(message));
      for (const { url: failed, errorText } of script.failedRequests ?? []) {
        emit<FailedRequest>('requestfailed', { url: () => failed, failure: () => (errorText === undefined ? null : { errorText }) });
      }
      if (script.gotoError !== undefined) throw script.gotoError;
      return null;
    },
    async waitForFunction(_probe: () => boolean, arg: undefined, options: { timeout: number }): Promise<boolean> {
      waits += 1;
      calls.push({ method: 'waitForFunction', args: [arg, options] });
      const settles = waits === 1 ? (script.revealReady ?? true) : (script.visualsSettle ?? true);
      if (!settles) throw new Error(`page.waitForFunction: Timeout ${options.timeout}ms exceeded.`);
      return true;
    },
    async evaluate(_probe: (arg: never) => unknown, arg: unknown): Promise<unknown> {
      calls.push({ method: 'evaluate', args: [arg] });
      const state = script.state ?? RENDERED;
      if (typeof arg !== 'string') return state.slides;
      if (script.collectError !== undefined) throw script.collectError;
      return state;
    },
  };
  const browser = {
    async newPage(options: unknown): Promise<typeof page> {
      calls.push({ method: 'newPage', args: [options] });
      return page;
    },
    async close(): Promise<void> {
      calls.push({ method: 'close', args: [] });
    },
  };
  // renderDeck touches only these members, so the fake stands in for the whole Playwright Browser.
  return { launch: async () => browser as unknown as Browser, calls };
}

function methods(calls: Call[]): string[] {
  return calls.map((call) => call.method);
}

describe('check-deck: Executive Presentation rule', () => {
  describe('checkDeckHtml', () => {
    it('reads the committed deck from DECK_PATH and finds nothing wrong with it', () => {
      expect(DECK_PATH).toBe(fileURLToPath(DECK_URL));
      expect(SLIDES).toHaveLength(16);
      expect(checkDeckHtml(DECK, { sha: SHA })).toEqual([]);
    });

    it.each(ALL_CASES)('$name', ({ html, sha, expected }) => {
      expect(checkDeckHtml(html, { sha: sha ?? SHA })).toEqual(expected);
    });

    it('selects .kpi-label as one of the required classes', () => {
      expect(REQUIRED_CLASSES).toContain('kpi-label');
    });

    it('has a case for every finding kind it emits', () => {
      const exercised = new Set(ALL_CASES.flatMap((c) => c.expected.map((finding) => finding.check)));
      expect([...exercised].sort()).toEqual(Object.keys(STATIC_CHECKS).sort());
    });
  });

  describe('renderDeck', () => {
    it('reports nothing when every diagram and icon renders, driving the page in order and closing the browser', async () => {
      const fake = fakeChromium();
      await expect(renderDeck(DECK_PATH, { launch: fake.launch, timeoutMs: 5000 })).resolves.toEqual([]);
      expect(methods(fake.calls)).toEqual(DRIVEN);
      expect(fake.calls).toEqual([
        { method: 'newPage', args: [{ viewport: { width: 1920, height: 1080 } }] },
        { method: 'on pageerror', args: [] },
        { method: 'on requestfailed', args: [] },
        { method: 'goto', args: [pathToFileURL(DECK_PATH).href, { waitUntil: 'load', timeout: 5000 }] },
        { method: 'waitForFunction', args: [undefined, { timeout: 5000 }] },
        { method: 'evaluate', args: [{ selector: SLIDE_SELECTOR, settleMs: 200 }] },
        { method: 'waitForFunction', args: [undefined, { timeout: 5000 }] },
        { method: 'evaluate', args: [SLIDE_SELECTOR] },
        { method: 'close', args: [] },
      ]);
    });

    it.each<{ name: string; state: RenderState; expected: DeckFinding[] }>([
      {
        name: 'reports a diagram that rendered no SVG',
        state: { ...RENDERED, diagrams: RENDERED.diagrams.map((d) => (d.slide === 7 ? { ...d, svg: false } : d)) },
        expected: [{ check: 'render-mermaid', slide: 7, detail: 'Mermaid diagram rendered no SVG' }],
      },
      {
        name: 'reports a diagram that rendered a syntax error',
        state: { ...RENDERED, diagrams: RENDERED.diagrams.map((d) => (d.slide === 7 ? { ...d, error: true } : d)) },
        expected: [{ check: 'render-mermaid', slide: 7, detail: 'Mermaid rendered a syntax-error diagram' }],
      },
      {
        name: 'reports an icon left as a placeholder',
        state: { ...RENDERED, placeholders: [{ slide: 4, name: 'map' }], icons: DECLARED_ICONS - 1 },
        expected: [{ check: 'render-lucide', slide: 4, detail: 'Lucide icon "map" was not replaced by an SVG' }],
      },
      {
        name: 'reports a placeholder outside every slide without a slide number',
        state: { ...RENDERED, placeholders: [{ slide: 0, name: 'map' }], icons: DECLARED_ICONS - 1 },
        expected: [{ check: 'render-lucide', detail: 'Lucide icon "map" was not replaced by an SVG' }],
      },
      {
        name: 'reports icons that became neither an SVG nor a placeholder',
        state: { ...RENDERED, icons: DECLARED_ICONS - 2 },
        expected: [
          { check: 'render-lucide', detail: `2 of ${DECLARED_ICONS} Lucide icons became neither an SVG nor a placeholder` },
        ],
      },
    ])('$name after the visuals wait times out, and closes the browser', async ({ state, expected }) => {
      const fake = fakeChromium({ state, visualsSettle: false });
      await expect(renderDeck(DECK_PATH, { launch: fake.launch, timeoutMs: 50 })).resolves.toEqual(expected);
      expect(methods(fake.calls)).toEqual(DRIVEN);
    });

    it('lists failed requests first and page errors last, counting repeated errors once, and closes the browser', async () => {
      const mermaidUrl = CDN_URLS[2].url;
      const fake = fakeChromium({
        state: { ...RENDERED, placeholders: [{ slide: 4, name: 'map' }], icons: DECLARED_ICONS - 1 },
        pageErrors: ['mermaid is not defined', 'mermaid is not defined', 'lucide is not defined'],
        failedRequests: [{ url: mermaidUrl, errorText: 'net::ERR_INTERNET_DISCONNECTED' }, { url: CDN_URLS[3].url }],
      });
      await expect(renderDeck(DECK_PATH, { launch: fake.launch })).resolves.toEqual([
        { check: 'render-unavailable', detail: `request failed: ${mermaidUrl} (net::ERR_INTERNET_DISCONNECTED)` },
        { check: 'render-unavailable', detail: `request failed: ${CDN_URLS[3].url} (failed)` },
        { check: 'render-lucide', slide: 4, detail: 'Lucide icon "map" was not replaced by an SVG' },
        { check: 'render-error', detail: 'page error (×2): mermaid is not defined' },
        { check: 'render-error', detail: 'page error: lucide is not defined' },
      ]);
      expect(methods(fake.calls)).toEqual(DRIVEN);
    });

    it('reports reveal.js never becoming ready without visiting slides, and closes the browser', async () => {
      const fake = fakeChromium({ revealReady: false });
      await expect(renderDeck(DECK_PATH, { launch: fake.launch, timeoutMs: 50 })).resolves.toEqual([
        { check: 'render-ready', detail: 'reveal.js was not ready within 50 ms' },
      ]);
      expect(methods(fake.calls)).toEqual(['newPage', 'on pageerror', 'on requestfailed', 'goto', 'waitForFunction', 'close']);
    });

    it('reports a deck that does not load, and closes the browser', async () => {
      const fake = fakeChromium({ gotoError: new Error('net::ERR_FILE_NOT_FOUND') });
      await expect(renderDeck(DECK_PATH, { launch: fake.launch })).resolves.toEqual([
        { check: 'render-unavailable', detail: 'deck did not load: net::ERR_FILE_NOT_FOUND' },
      ]);
      expect(methods(fake.calls)).toEqual(['newPage', 'on pageerror', 'on requestfailed', 'goto', 'close']);
    });

    it('propagates a failing in-page probe and still closes the browser', async () => {
      const fake = fakeChromium({ collectError: new Error('Execution context was destroyed') });
      await expect(renderDeck(DECK_PATH, { launch: fake.launch })).rejects.toThrow('Execution context was destroyed');
      expect(methods(fake.calls)).toEqual(DRIVEN);
    });

    it('reports a browser that does not launch', async () => {
      const launch = async (): Promise<Browser> => {
        throw new Error('Executable does not exist');
      };
      await expect(renderDeck(DECK_PATH, { launch })).resolves.toEqual([
        { check: 'render-unavailable', detail: 'Chromium did not launch (npx playwright install chromium): Executable does not exist' },
      ]);
    });
  });

  describe('main through runCli', () => {
    const WS_ENDPOINT = 'ws://127.0.0.1:9/check-deck-gate';
    const playwright = { imports: 0, launches: [] as unknown[], connects: [] as string[], server: [] as string[] };
    let browser = fakeChromium();

    afterEach(() => {
      vi.doUnmock('@playwright/test');
      vi.resetModules();
      playwright.imports = 0;
      playwright.launches = [];
      playwright.connects = [];
      playwright.server = [];
    });

    /** Runs a freshly imported `main` with `@playwright/test` mocked, capturing the summary line and exit code. */
    async function runCheck(argv: string[]): Promise<{ code: number; exits: number[]; line: Record<string, unknown> }> {
      vi.resetModules();
      vi.doMock('@playwright/test', () => {
        playwright.imports += 1;
        return {
          chromium: {
            launchServer: async (options: unknown) => {
              playwright.launches.push(options);
              return {
                wsEndpoint: () => WS_ENDPOINT,
                close: async (): Promise<void> => {
                  playwright.server.push('close');
                },
                kill: async (): Promise<void> => {
                  playwright.server.push('kill');
                },
              };
            },
            connect: async (endpoint: string): Promise<Browser> => {
              playwright.connects.push(endpoint);
              return browser.launch();
            },
          },
        };
      });
      // runCli comes from the same fresh module graph as main, so it recognises that graph's UsageError.
      const { main } = await import('../../src/reporting/check-deck.js');
      const { runCli } = await import('../../src/lib/cli.js');
      const chunks: string[] = [];
      const exits: number[] = [];
      const code = await runCli(main, {
        argv,
        command: COMMAND,
        stdout: { write: (chunk: string) => chunks.push(chunk) },
        exit: (exitCode) => exits.push(exitCode),
      });
      expect(chunks.join('').split('\n').filter((entry) => entry !== '')).toHaveLength(1);
      return { code, exits, line: JSON.parse(chunks.join('')) as Record<string, unknown> };
    }

    it('checks the committed deck statically, exits 0 and never imports Playwright', async () => {
      const outcome = await runCheck([]);
      expect(outcome.code).toBe(0);
      expect(outcome.exits).toEqual([0]);
      expect(outcome.line).toEqual({
        command: COMMAND,
        ok: true,
        code: 0,
        file: 'opt2/executive-summary/index.html',
        sections: 16,
        findings: [],
      });
      expect(playwright.imports).toBe(0);
    });

    it('--render imports Playwright once, launches headless Chromium on the committed deck and exits 0', async () => {
      browser = fakeChromium();
      const outcome = await runCheck(['--render']);
      expect(outcome.code).toBe(0);
      expect(outcome.line).toMatchObject({ ok: true, file: 'opt2/executive-summary/index.html', sections: 16, findings: [] });
      expect(playwright.imports).toBe(1);
      expect(playwright.launches).toEqual([{ headless: true }]);
      expect(playwright.connects).toEqual([WS_ENDPOINT]);
      expect(browser.calls.find((call) => call.method === 'goto')?.args).toEqual([
        pathToFileURL(DECK_PATH).href,
        { waitUntil: 'load', timeout: 30_000 },
      ]);
      expect(methods(browser.calls)).toEqual(DRIVEN);
      expect(playwright.server).toEqual(['close']);
    });

    it('--file checks a failing deck copy outside the checkout and exits 1 with its findings', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-check-deck-gate-'));
      try {
        expect(isInsideRepo(dir)).toBe(false);
        const file = path.join(dir, 'index.html');
        await writeFile(file, editSlide(DECK, 14, ['<h2>Cut-over sequence</h2>', `<h2>Cut-over sequence ${ROCKET}</h2>`]));
        const outcome = await runCheck(['--file', file]);
        expect(outcome.code).toBe(1);
        expect(outcome.exits).toEqual([1]);
        expect(outcome.line).toEqual({
          command: COMMAND,
          ok: false,
          code: 1,
          file,
          sections: 16,
          findings: [
            {
              check: 'emoji',
              slide: 14,
              detail: `emoji are not allowed; use Lucide icons: U+1F680 (line ${lineOf('<h2>Cut-over sequence</h2>')})`,
            },
          ],
        });
        expect(playwright.imports).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it.each<[string, string[], string]>([
      ['an empty --file', ['--file', ''], '--file needs a path'],
      ['an unknown flag', ['--verbose'], "Unknown option '--verbose'"],
    ])('rejects %s with exit 2 and the usage text', async (_label, argv, message) => {
      const outcome = await runCheck(argv);
      expect(outcome.code).toBe(2);
      expect(outcome.line).toMatchObject({
        command: COMMAND,
        ok: false,
        code: 2,
        error: { type: 'UsageError', message: expect.stringContaining(message) },
        usage: USAGE,
      });
      expect(playwright.imports).toBe(0);
    });
  });
});
