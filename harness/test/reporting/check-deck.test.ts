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
const FIXTURE_TABLE = '<table class="fixture-table"><tr><th>Fixture</th><td>One</td></tr></table>';

/** The valid fixture with slide 7's only visual replaced by `table` and `css` appended to the inline theme. */
function tableSlide(table: string, css: string): string {
  const html = editSlide(7, ICON_ROW, table);
  return css === '' ? html : edit(html, '  </style>\n', `    ${css}\n  </style>\n`);
}

/** Slide 7 holding only a table, and whether that table must count as its styled-table visual. */
const TABLE_VISUALS: { name: string; table?: string; css?: string; styled: boolean }[] = [
  { name: 'a class no rule selects', styled: false },
  { name: 'a class no rule selects and an unrelated table rule', css: '.appendix table { border: 1px solid #D9D9D9; }', styled: false },
  { name: 'an empty style attribute', table: '<table style=""><tr><td>One</td></tr></table>', styled: false },
  { name: 'a style attribute without a value', table: '<table style="border: ;"><tr><td>One</td></tr></table>', styled: false },
  {
    name: 'a comment-only style attribute',
    table: '<table style="/* border: 1px solid #D9D9D9 */"><tr><td>One</td></tr></table>',
    styled: false,
  },
  {
    name: 'a style value that is only a comment',
    table: '<table style="border: /* no value */"><tr><td>One</td></tr></table>',
    styled: false,
  },
  {
    name: 'a style value cut off by an unclosed comment',
    table: '<table style="border: /* 1px solid #D9D9D9"><tr><td>One</td></tr></table>',
    styled: false,
  },
  {
    name: 'a style value that is only !important',
    table: '<table style="border: !important"><tr><td>One</td></tr></table>',
    styled: false,
  },
  { name: 'a style value without a property', table: '<table style="1px solid"><tr><td>One</td></tr></table>', styled: false },
  { name: 'a style declaration without a property name', table: '<table style=": #D9D9D9"><tr><td>One</td></tr></table>', styled: false },
  {
    name: 'a style property that is not an identifier',
    table: '<table style="1px solid: #D9D9D9"><tr><td>One</td></tr></table>',
    styled: false,
  },
  { name: 'a matching rule without declarations', css: '.fixture-table { }', styled: false },
  { name: 'a matching rule holding only a comment', css: '.fixture-table { /* border: 0 */ }', styled: false },
  { name: 'a matching rule css-select cannot evaluate', css: '.fixture-table td:placeholder-shown { color: #333333; }', styled: false },
  { name: 'the deck-table class', table: '<table class="deck-table"><tr><td>One</td></tr></table>', styled: true },
  { name: 'an inline style declaration', table: '<table style="border-collapse: collapse"><tr><td>One</td></tr></table>', styled: true },
  {
    name: 'a commented inline style declaration',
    table: '<table style="/* frame */ border: 1px solid #D9D9D9"><tr><td>One</td></tr></table>',
    styled: true,
  },
  {
    name: 'an important style declaration before an ineffective repeat',
    table: '<table style="border: 1px solid #D9D9D9 !important; border: !important"><tr><td>One</td></tr></table>',
    styled: true,
  },
  { name: 'an inline style declaration on a cell', table: '<table><tr><td style="color: #5B39F3">One</td></tr></table>', styled: true },
  { name: 'a rule selecting its cells', css: '.fixture-table td { border: 1px solid #D9D9D9; }', styled: true },
  { name: 'a rule selecting a pseudo-element of its cells', css: ".fixture-table td::before { content: '-'; }", styled: true },
  { name: 'a rule selecting its parts by state alone', css: '.fixture-table :focus-within { outline: 1px solid #5B39F3; }', styled: true },
];

const STRUCTURE_CASES: Case[] = [
  {
    name: 'flags a content slide whose only visual became a paragraph',
    html: editSlide(7, ICON_ROW, '<p>Fixture paragraph</p>'),
    expected: [{ check: 'non-text-visual', slide: 7, detail: NO_VISUAL }],
  },
  ...TABLE_VISUALS.map(
    ({ name, table, css, styled }): Case => ({
      name: styled ? `counts a table with ${name} as a styled-table visual` : `flags a slide whose only table has ${name}`,
      html: tableSlide(table ?? FIXTURE_TABLE, css ?? ''),
      expected: styled ? [] : [{ check: 'non-text-visual', slide: 7, detail: NO_VISUAL }],
    }),
  ),
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
const US_FLAG = String.fromCodePoint(0x1f1fa, 0x1f1f8);
const LONE_INDICATOR = String.fromCodePoint(0x1f1fa);
const SKIN_TONE = String.fromCodePoint(0x1f3fd);

/** The valid fixture with `markup` ahead of slide 7's icon row. */
function withMarkup(markup: string): string {
  return editSlide(7, '<div class="icon-row">', `${markup}\n        <div class="icon-row">`);
}

/** A case whose `html` yields one emoji finding, on `slide` when given, listing each label at the line of its needle. */
function emojiCase(name: string, html: string, hits: [label: string, needle: string][], slide?: number): Case {
  const labels = hits.map(([label, needle]) => `${label} (line ${lineOf(html, needle)})`).join(', ');
  const detail = `emoji are not allowed; use Lucide icons: ${labels}`;
  return { name, html, expected: [slide === undefined ? { check: 'emoji', detail } : { check: 'emoji', slide, detail }] };
}

const CHARACTER_CASES: Case[] = [
  {
    name: 'flags the emoji fixture once, at its U+1F680 on slide 5',
    html: EMOJI,
    expected: [{ check: 'emoji', slide: 5, detail: `emoji are not allowed; use Lucide icons: U+1F680 (line ${lineOf(EMOJI, ROCKET)})` }],
  },
  emojiCase('flags a literal flag as one regional-indicator pair', withMarkup(`<p>Fixture ${US_FLAG} region</p>`), [['U+1F1FA U+1F1F8', US_FLAG]], 7),
  emojiCase(
    'flags literal keycaps with and without FE0F as one sequence each',
    withMarkup('<p>Fixture 1\u20E3 and\n          #\uFE0F\u20E3 steps</p>'),
    [
      ['U+0031 U+20E3', '1\u20E3'],
      ['U+0023 U+FE0F U+20E3', '#\uFE0F\u20E3'],
    ],
    7,
  ),
  emojiCase(
    'flags a lone regional indicator and a skin-tone modifier',
    withMarkup(`<p>Fixture ${LONE_INDICATOR} and ${SKIN_TONE} marks</p>`),
    [
      ['U+1F1FA', LONE_INDICATOR],
      ['U+1F3FD', SKIN_TONE],
    ],
    7,
  ),
  {
    name: 'accepts digits, # and * outside keycaps, references to non-emoji characters and references in raw text',
    html: withMarkup('<style>/* &#x1F680; */</style><p title="1 &amp; 2">Fixture 1, 2 and 3; #4 *5 &amp; &lt;b&gt; &nbsp; &rarr; done</p>'),
    expected: [],
  },
  emojiCase('flags a hexadecimal reference to an emoji at its line', withMarkup('<p>Fixture\n          &#x1F680; launch</p>'), [['U+1F680', '&#x1F680;']], 7),
  emojiCase('flags a decimal reference to an emoji', withMarkup('<p>Fixture &#128640; launch</p>'), [['U+1F680', '&#128640;']], 7),
  emojiCase(
    'flags named references to pictographs',
    withMarkup('<p>Fixture &copy; &reg; &trade; notice</p>'),
    [
      ['U+00A9', '&copy;'],
      ['U+00AE', '&reg;'],
      ['U+2122', '&trade;'],
    ],
    7,
  ),
  emojiCase('flags a reference to an emoji in an attribute at its line', withMarkup('<p\n          title="Fixture &#x2B50;">Fixture star</p>'), [['U+2B50', '&#x2B50;']], 7),
  emojiCase('flags an encoded flag as one regional-indicator pair', withMarkup('<p>Fixture &#x1F1FA;&#x1F1F8; region</p>'), [['U+1F1FA U+1F1F8', '&#x1F1FA;']], 7),
  emojiCase('flags a keycap completed by a reference', withMarkup('<p>Fixture #&#x20E3; step</p>'), [['U+0023 U+20E3', '&#x20E3;']], 7),
  emojiCase('locates a reference in a case-adjusted SVG attribute at its line', withMarkup('<svg\n          viewBox="&#x1F680;"></svg>'), [['U+1F680', '&#x1F680;']], 7),
  emojiCase(
    'reports a literal and an encoded emoji of one text node once each',
    withMarkup(`<p>Fixture ${ROCKET} and &#x1F680; launch</p>`),
    [
      ['U+1F680', ROCKET],
      ['U+1F680', '&#x1F680;'],
    ],
    7,
  ),
  emojiCase('locates a reference after a CRLF line break', withMarkup('<p>Fixture\r\n          &#x1F680; launch</p>'), [['U+1F680', '&#x1F680;']], 7),
  emojiCase(
    'locates a reference in a Mermaid diagram at its line',
    editSlide(3, 'A[Fixture client]', 'A[Fixture &#x1F680; client]'),
    [['U+1F680', '&#x1F680;']],
    3,
  ),
  emojiCase(
    'places an emoji at its attribute value when the decoding does not map onto the source',
    withMarkup(`<p title="&copy2024 &#x1F680; ${ROCKET}">Fixture mark</p>`),
    [
      ['U+1F680', '&copy2024'],
      ['U+1F680', ROCKET],
    ],
    7,
  ),
  emojiCase('flags a reference in the <title> without a slide', edit(VALID, '<title>', '<title>&#x1F680; '), [['U+1F680', '<title>']]),
  emojiCase('places a reference in an attribute merged into <body> at the <body> tag', withMarkup('<body title="&#x1F680;">'), [['U+1F680', '<body>']]),
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
const REVEAL_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js';
const LUCIDE_SCRIPT_URL = 'https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js';
const MALFORMED_LUCIDE = 'https://unpkg.com/lucide@0.460.0%zz/dist/umd/lucide.min.js';
const UNPARSEABLE_LUCIDE = 'https://unpkg.com:bad/lucide@0.460.0/dist/umd/lucide.min.js';

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
  cdnCase('reveal', '5.1.0-beta'),
  cdnCase('mermaid', '11.4.0-rc.1'),
  cdnCase('lucide', '0.460.0-beta'),
  cdnCase('reveal', '^5.1.0'),
  ...(
    [
      ['lucide', LUCIDE_SCRIPT_URL, `${UNVERSIONED_LUCIDE}?expected=lucide@0.460.0`],
      ['lucide', LUCIDE_SCRIPT_URL, `${UNVERSIONED_LUCIDE}#lucide@0.460.0`],
      ['lucide', LUCIDE_SCRIPT_URL, 'https://unpkg.com/lucide-static@0.460.0/dist/umd/lucide.min.js'],
      ['reveal', REVEAL_SCRIPT_URL, 'https://cdn.example/x/reveal.min.js?expected=reveal.js@5.1.0'],
    ] as const
  ).map(([library, from, url]): Case => ({
    name: `reads no ${CDN_LABELS[library]} version from the pathname of ${url}`,
    html: edit(VALID, from, url),
    expected: [
      { check: 'cdn', detail: `${CDN_LABELS[library]} URL ${url} carries no version; pin ${CDN_PINS[library]}` },
      { check: 'cdn', detail: `no <script src> loads ${CDN_LABELS[library]} ${CDN_PINS[library]}` },
    ],
  })),
  ...['5.1.0', '5.1.0-beta'].map((version): Case => {
    const url = `https://cdnjs.cloudflare.com/ajax/libs/reveal.js/${version}/reveal.min.js`;
    return {
      name: `reads reveal.js ${version} from the segment after reveal.js in ${url}`,
      html: edit(VALID, REVEAL_SCRIPT_URL, url),
      expected: version === CDN_PINS.reveal ? [] : [{ check: 'cdn', detail: `reveal.js ${version} in ${url}; the pinned version is 5.1.0` }],
    };
  }),
  {
    name: 'reads a Lucide version with malformed percent-encoding as written',
    html: edit(VALID, LUCIDE_SCRIPT_URL, MALFORMED_LUCIDE),
    expected: [{ check: 'cdn', detail: `Lucide 0.460.0%zz in ${MALFORMED_LUCIDE}; the pinned version is 0.460.0` }],
  },
  {
    name: 'does not count an unparseable Lucide script URL as loading Lucide',
    html: edit(VALID, LUCIDE_SCRIPT_URL, UNPARSEABLE_LUCIDE),
    expected: [{ check: 'cdn', detail: 'no <script src> loads Lucide 0.460.0' }],
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
  /** Calls that never settle: `newPage`, `goto`, the slide-visit and state-collection `evaluate`s, `close` or `kill`. */
  stalls?: readonly Stall[];
  /** Milliseconds before launch() settles. */
  launchDelayMs?: number;
  /** Rejects launch() with this error once `launchDelayMs` has passed. */
  launchError?: Error;
  /** Milliseconds before close() settles. */
  closeDelayMs?: number;
  /** Rejects close() with this error. */
  closeError?: Error;
  /** Rejects kill() with this error. */
  killError?: Error;
}

type Stall = 'newPage' | 'goto' | 'visit' | 'collect' | 'close' | 'kill';

const never = (): Promise<never> => new Promise<never>(() => undefined);

interface FakeChromium {
  launch: () => Promise<Browser>;
  /** Terminates the fake browser, recorded as a `kill` call. */
  kill: () => Promise<void>;
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
  const stalls = new Set(script.stalls);
  let waits = 0;
  const page = {
    on(event: 'pageerror' | 'requestfailed', listener: (payload: never) => void): void {
      calls.push(`on ${event}`);
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    async goto(url: string): Promise<null> {
      calls.push('goto');
      gotos.push(url);
      if (stalls.has('goto')) return never();
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
      if (stalls.has(typeof arg === 'string' ? 'collect' : 'visit')) return never();
      if (typeof arg !== 'string') return state.slides;
      if (script.collectError !== undefined) throw script.collectError;
      return state;
    },
  };
  const browser = {
    async newPage(): Promise<typeof page> {
      calls.push('newPage');
      if (stalls.has('newPage')) return never();
      return page;
    },
    async close(): Promise<void> {
      calls.push('close');
      if (stalls.has('close')) await never();
      if (script.closeError !== undefined) throw script.closeError;
      const delayMs = script.closeDelayMs;
      if (delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, delayMs));
    },
  };
  const launch = async (): Promise<Browser> => {
    const delayMs = script.launchDelayMs;
    if (delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (script.launchError !== undefined) throw script.launchError;
    // renderDeck touches only these members, so the fake stands in for the whole Playwright Browser.
    return browser as unknown as Browser;
  };
  const kill = async (): Promise<void> => {
    calls.push('kill');
    if (stalls.has('kill')) await never();
    if (script.killError !== undefined) throw script.killError;
  };
  return { launch, kill, calls, gotos };
}

function closes(chromium: FakeChromium): number {
  return chromium.calls.filter((call) => call === 'close').length;
}

function kills(chromium: FakeChromium): number {
  return chromium.calls.filter((call) => call === 'kill').length;
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
    it('reports nothing when every diagram and icon renders, and closes the browser without killing it', async () => {
      const chromium = fakeChromium();
      await expect(renderDeck(VALID_PATH, { launch: chromium.launch, kill: chromium.kill, timeoutMs: 50 })).resolves.toEqual([]);
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

    it.each<{ name: string; script: PageScript; message: string; killed: boolean }>([
      {
        name: 'an in-page probe throws, closing the browser',
        script: { collectError: new Error('Execution context was destroyed') },
        message: 'Execution context was destroyed',
        killed: false,
      },
      {
        name: 'closing the browser fails, killing it',
        script: { closeError: new Error('Target page, context or browser has been closed') },
        message: 'Target page, context or browser has been closed',
        killed: true,
      },
    ])('rejects when $name', async ({ script, message, killed }) => {
      const chromium = fakeChromium(script);
      await expect(renderDeck(VALID_PATH, { launch: chromium.launch, kill: chromium.kill, timeoutMs: 50 })).rejects.toThrow(message);
      expect(closes(chromium)).toBe(1);
      expect(kills(chromium)).toBe(killed ? 1 : 0);
    });

    it('reports a browser that does not launch', async () => {
      const launch = async (): Promise<Browser> => {
        throw new Error('Executable does not exist');
      };
      await expect(renderDeck(VALID_PATH, { launch })).resolves.toEqual([
        { check: 'render-unavailable', detail: 'Chromium did not launch (npx playwright install chromium): Executable does not exist' },
      ]);
    });

    describe('render budget', () => {
      const BUDGET_MS = 150;
      // The budget covers launch through close; the margin absorbs deck parsing and timer latency.
      const BOUND_MS = BUDGET_MS + 100;
      const stalledIn = (step: string): DeckFinding => ({
        check: 'render-unavailable',
        detail: `render did not finish within the ${BUDGET_MS} ms budget: stalled in ${step}`,
      });
      const NOT_CLOSED = `browser did not close within the ${BUDGET_MS} ms render budget`;
      const KILLED: DeckFinding = { check: 'render-unavailable', detail: `${NOT_CLOSED} and was killed` };

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it.each<{ name: string; stalls: Stall[]; expected: DeckFinding[]; killed: boolean }>([
        { name: 'newPage', stalls: ['newPage'], expected: [stalledIn('newPage')], killed: false },
        { name: 'goto', stalls: ['goto'], expected: [stalledIn('goto')], killed: false },
        { name: 'the slide-visit probe', stalls: ['visit'], expected: [stalledIn('slide visits')], killed: false },
        { name: 'the state-collection probe', stalls: ['collect'], expected: [stalledIn('state collection')], killed: false },
        { name: 'close after a full render', stalls: ['close'], expected: [KILLED], killed: true },
        { name: 'close after a stalled probe', stalls: ['visit', 'close'], expected: [stalledIn('slide visits'), KILLED], killed: true },
      ])('reports $name outlasting the budget, closes the browser once, kills it only when close is late and leaves no timer', async ({
        stalls,
        expected,
        killed,
      }) => {
        const chromium = fakeChromium({ stalls });
        const setTimer = vi.spyOn(globalThis, 'setTimeout');
        const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
        const started = performance.now();
        await expect(
          renderDeck(VALID_PATH, { launch: chromium.launch, kill: chromium.kill, timeoutMs: 50, budgetMs: BUDGET_MS }),
        ).resolves.toEqual(expected);
        expect(performance.now() - started).toBeLessThan(BOUND_MS);
        expect(closes(chromium)).toBe(1);
        expect(kills(chromium)).toBe(killed ? 1 : 0);
        const timers = setTimer.mock.results.map((result) => result.value as unknown);
        expect(timers.length).toBeGreaterThan(0);
        expect(clearTimer.mock.calls.map(([timer]) => timer)).toEqual(expect.arrayContaining(timers));
      });

      it.each<{ name: string; script: PageScript; killable: boolean; detail: string; boundMs: number }>([
        { name: 'with nothing to kill it', script: { stalls: ['close'] }, killable: false, detail: NOT_CLOSED, boundMs: BOUND_MS },
        {
          name: 'whose kill fails',
          script: { stalls: ['close'], killError: new Error('kill EPERM') },
          killable: true,
          detail: `${NOT_CLOSED} and could not be killed: kill EPERM`,
          boundMs: BOUND_MS,
        },
        {
          name: 'whose kill never finishes',
          script: { stalls: ['close', 'kill'] },
          killable: true,
          detail: `${NOT_CLOSED} and could not be killed: no exit within 1000 ms`,
          // A kill may wait 1000 ms past the budget for the browser to exit.
          boundMs: BOUND_MS + 1_000,
        },
      ])('reports an unclosed browser $name, and resolves', async ({ script, killable, detail, boundMs }) => {
        const chromium = fakeChromium(script);
        const started = performance.now();
        const kill = killable ? chromium.kill : undefined;
        await expect(renderDeck(VALID_PATH, { launch: chromium.launch, kill, timeoutMs: 50, budgetMs: BUDGET_MS })).resolves.toEqual([
          { check: 'render-unavailable', detail },
        ]);
        expect(performance.now() - started).toBeLessThan(boundMs);
        expect(closes(chromium)).toBe(1);
        expect(kills(chromium)).toBe(killable ? 1 : 0);
      });

      it('gives close the budget a quick render leaves, beyond its reserve', async () => {
        const closeDelayMs = (2 * BUDGET_MS) / 3;
        const chromium = fakeChromium({ closeDelayMs });
        const started = performance.now();
        await expect(
          renderDeck(VALID_PATH, { launch: chromium.launch, kill: chromium.kill, timeoutMs: 50, budgetMs: BUDGET_MS }),
        ).resolves.toEqual([]);
        const elapsed = performance.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(closeDelayMs - 5);
        expect(elapsed).toBeLessThan(BOUND_MS);
        expect(closes(chromium)).toBe(1);
        expect(kills(chromium)).toBe(0);
      });

      it.each<{ name: string; killable: boolean; launchError?: Error; calls: string[] }>([
        { name: 'kills its browser when it arrives', killable: true, calls: ['kill'] },
        { name: 'closes its browser on arrival when nothing can kill it', killable: false, calls: ['close'] },
        { name: 'absorbs its later failure', killable: true, launchError: new Error('Executable does not exist'), calls: [] },
      ])('reports a launch outlasting the budget and $name', async ({ killable, launchError, calls }) => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
          unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
          const chromium = fakeChromium({ launchDelayMs: 2 * BUDGET_MS, launchError });
          const kill = killable ? chromium.kill : undefined;
          const started = performance.now();
          await expect(renderDeck(VALID_PATH, { launch: chromium.launch, kill, budgetMs: BUDGET_MS })).resolves.toEqual([stalledIn('launch')]);
          expect(performance.now() - started).toBeLessThan(BOUND_MS);
          expect(chromium.calls).toEqual([]);
          await new Promise((resolve) => setTimeout(resolve, 3 * BUDGET_MS));
          expect(chromium.calls).toEqual(calls);
          expect(unhandled).toEqual([]);
        } finally {
          process.off('unhandledRejection', onUnhandled);
        }
      });
    });
  });

  describe('main', () => {
    const WS_ENDPOINT = 'ws://127.0.0.1:9/check-deck-test';
    const playwright = { imported: 0, launches: [] as unknown[], connects: [] as string[], server: [] as string[] };

    /** How the mocked Chromium server behaves; it starts, connects and closes at once unless set. */
    interface ServerScript {
      launchDelayMs?: number;
      connectError?: Error;
      connectStalls?: boolean;
    }

    afterEach(() => {
      vi.doUnmock('@playwright/test');
      vi.resetModules();
      playwright.imported = 0;
      playwright.launches = [];
      playwright.connects = [];
      playwright.server = [];
    });

    /** Mocks `@playwright/test` with a Chromium server, recording its `close` and `kill`, whose connect yields `chromium`'s browser. */
    function mockPlaywright(chromium: FakeChromium, server: ServerScript = {}): void {
      vi.resetModules();
      vi.doMock('@playwright/test', () => {
        playwright.imported += 1;
        return {
          chromium: {
            launchServer: async (options: unknown) => {
              playwright.launches.push(options);
              const delayMs = server.launchDelayMs;
              if (delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, delayMs));
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
              if (server.connectStalls === true) return never();
              if (server.connectError !== undefined) throw server.connectError;
              return chromium.launch();
            },
          },
        };
      });
    }

    /** Runs a freshly imported main through runCli with `@playwright/test` mocked by `chromium`. */
    async function runCheck(
      argv: string[],
      chromium: FakeChromium = fakeChromium(),
    ): Promise<{ code: number; exits: number[]; summary: Record<string, unknown> }> {
      mockPlaywright(chromium);
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
      expect(playwright.connects).toEqual([WS_ENDPOINT]);
      expect(chromium.gotos).toEqual([pathToFileURL(VALID_PATH).href]);
      expect(closes(chromium)).toBe(1);
      expect(playwright.server).toEqual(['close']);
    });

    describe('default launcher', () => {
      const BUDGET_MS = 150;
      const STALLED: DeckFinding = {
        check: 'render-unavailable',
        detail: `render did not finish within the ${BUDGET_MS} ms budget: stalled in launch`,
      };

      it.each<{ name: string; server: ServerScript; expected: DeckFinding[]; connects: string[] }>([
        {
          name: 'whose connect fails',
          server: { connectError: new Error('WebSocket error: connect ECONNREFUSED') },
          expected: [
            {
              check: 'render-unavailable',
              detail: 'Chromium did not launch (npx playwright install chromium): WebSocket error: connect ECONNREFUSED',
            },
          ],
          connects: [WS_ENDPOINT],
        },
        { name: 'whose connect outlasts the budget', server: { connectStalls: true }, expected: [STALLED], connects: [WS_ENDPOINT] },
        { name: 'that starts after the budget, without connecting', server: { launchDelayMs: 2 * BUDGET_MS }, expected: [STALLED], connects: [] },
      ])('kills a Chromium server $name', async ({ server, expected, connects }) => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
          unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
          mockPlaywright(fakeChromium(), server);
          const fresh = await import('../../src/reporting/check-deck.js');
          const started = performance.now();
          await expect(fresh.renderDeck(VALID_PATH, { budgetMs: BUDGET_MS })).resolves.toEqual(expected);
          expect(performance.now() - started).toBeLessThan(BUDGET_MS + 100);
          await new Promise((resolve) => setTimeout(resolve, 3 * BUDGET_MS));
          expect(playwright.launches).toEqual([{ headless: true }]);
          expect(playwright.connects).toEqual(connects);
          expect(playwright.server).toEqual(['kill']);
          expect(unhandled).toEqual([]);
        } finally {
          process.off('unhandledRejection', onUnhandled);
        }
      });
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
