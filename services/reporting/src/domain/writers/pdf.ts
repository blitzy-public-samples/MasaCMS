// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/**
 * PDF export writer matching the fixture's cfdocument output as pdfjs-dist extracts it per page: ICEbrowser's layout
 * (AWT Serif metrics, zoom to fit, page breaks at row and line boundaries) and iText's Times drawing, whose character
 * spacing stretches each line to its measured width.
 */
import PDFDocument from 'pdfkit';
import type { ExportTable } from '../sources.js';
import type { ExportRendering, ExportWriterInput } from './index.js';

type Style = 'regular' | 'bold';
type FontTable = Readonly<Record<Style, readonly number[]>>;

const CONTENT_TYPE = 'application/pdf';
const PDF_FONTS: Readonly<Record<Style, string>> = { regular: 'Times-Roman', bold: 'Times-Bold' };
const FONT_RESOURCES: Readonly<Record<Style, string>> = { regular: 'TimesRoman', bold: 'TimesBold' };

/** Noto Serif advances per 1000 em for Windows-1252 bytes 0x20-0xFF: the AWT Serif face the layout measures. */
const SERIF_UNITS: FontTable = {
  regular: [
    260, 332, 408, 559, 559, 896, 742, 220, 346, 346, 500, 559, 250, 310, 250, 288,
    559, 559, 559, 559, 559, 559, 559, 559, 559, 559, 286, 286, 559, 559, 559, 474,
    921, 705, 654, 614, 727, 623, 590, 714, 793, 367, 357, 700, 623, 938, 763, 742,
    604, 742, 656, 544, 613, 717, 675, 1047, 660, 625, 592, 360, 288, 360, 559, 459,
    274, 563, 614, 492, 614, 535, 369, 538, 635, 320, 300, 585, 310, 945, 645, 577,
    614, 614, 471, 451, 352, 635, 579, 862, 578, 565, 511, 428, 559, 428, 559, 0,
    559, 0, 250, 451, 450, 858, 448, 448, 375, 1291, 544, 333, 959, 0, 592, 0,
    0, 250, 250, 450, 450, 362, 500, 1000, 436, 835, 451, 333, 905, 0, 511, 625,
    260, 332, 559, 559, 559, 559, 559, 544, 577, 845, 382, 514, 559, 310, 845, 459,
    400, 559, 400, 400, 274, 615, 617, 250, 333, 400, 397, 514, 840, 840, 840, 474,
    705, 705, 705, 705, 705, 705, 951, 614, 623, 623, 623, 623, 367, 367, 367, 367,
    727, 763, 742, 742, 742, 742, 742, 559, 742, 717, 717, 717, 717, 625, 604, 647,
    563, 563, 563, 563, 563, 563, 841, 492, 535, 535, 535, 535, 320, 320, 320, 320,
    577, 645, 577, 577, 577, 577, 577, 559, 577, 635, 635, 635, 635, 565, 614, 565,
  ],
  bold: [
    260, 382, 508, 559, 559, 906, 801, 290, 400, 400, 502, 559, 294, 310, 294, 288,
    559, 559, 559, 559, 559, 559, 559, 559, 559, 559, 304, 304, 559, 559, 559, 550,
    921, 753, 672, 668, 767, 653, 621, 769, 819, 401, 397, 734, 654, 952, 788, 787,
    638, 787, 707, 586, 653, 747, 698, 1067, 732, 693, 666, 414, 288, 414, 559, 459,
    334, 599, 649, 527, 649, 571, 407, 560, 667, 352, 345, 636, 352, 986, 667, 613,
    645, 648, 523, 488, 405, 667, 606, 856, 646, 579, 529, 442, 559, 442, 559, 0,
    559, 0, 294, 497, 489, 912, 478, 478, 435, 1310, 586, 353, 1019, 0, 666, 0,
    0, 280, 280, 489, 489, 400, 500, 1000, 476, 835, 488, 353, 935, 0, 529, 693,
    260, 382, 559, 559, 559, 559, 559, 544, 577, 845, 420, 554, 559, 310, 845, 459,
    400, 559, 400, 400, 334, 665, 627, 294, 333, 400, 437, 554, 840, 840, 840, 550,
    753, 753, 753, 753, 753, 753, 993, 668, 653, 653, 653, 653, 401, 401, 401, 401,
    767, 788, 787, 787, 787, 787, 787, 559, 787, 747, 747, 747, 747, 693, 638, 706,
    599, 599, 599, 599, 599, 599, 875, 527, 571, 571, 571, 571, 352, 352, 352, 352,
    613, 667, 613, 613, 613, 613, 613, 559, 613, 667, 667, 667, 667, 579, 645, 579,
  ],
};

/** iText's Times widths per 1000 em for the same bytes; with the Serif width they set each line's character spacing. */
const TIMES_UNITS: FontTable = {
  regular: [
    250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
    921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
    556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
    333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
    500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541, 0,
    500, 0, 333, 500, 444, 1000, 500, 500, 333, 1000, 556, 333, 889, 0, 611, 0,
    0, 333, 333, 444, 444, 350, 500, 1000, 333, 980, 389, 333, 722, 0, 444, 722,
    250, 333, 500, 500, 500, 500, 200, 500, 333, 760, 276, 500, 564, 0, 760, 333,
    400, 564, 300, 300, 333, 0, 453, 250, 333, 300, 310, 500, 750, 750, 750, 444,
    722, 722, 722, 722, 722, 722, 889, 667, 611, 611, 611, 611, 333, 333, 333, 333,
    722, 722, 722, 722, 722, 722, 722, 564, 722, 722, 722, 722, 722, 722, 556, 500,
    444, 444, 444, 444, 444, 444, 667, 444, 444, 444, 444, 444, 278, 278, 278, 278,
    500, 500, 500, 500, 500, 500, 500, 564, 500, 500, 500, 500, 500, 500, 500, 500,
  ],
  bold: [
    250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
    930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
    611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
    333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
    556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520, 0,
    500, 0, 333, 500, 500, 1000, 500, 500, 333, 1000, 556, 333, 1000, 0, 667, 0,
    0, 333, 333, 500, 500, 350, 500, 1000, 333, 1000, 389, 333, 722, 0, 444, 722,
    250, 333, 500, 500, 500, 500, 220, 500, 333, 747, 300, 500, 570, 0, 747, 333,
    400, 570, 300, 300, 333, 0, 540, 250, 333, 300, 330, 500, 750, 750, 750, 500,
    722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 389, 389, 389, 389,
    722, 722, 778, 778, 778, 778, 778, 570, 778, 722, 722, 722, 722, 722, 611, 556,
    500, 500, 500, 500, 500, 500, 722, 444, 444, 444, 444, 444, 278, 278, 278, 278,
    500, 556, 500, 500, 500, 500, 500, 570, 500, 556, 556, 556, 556, 500, 556, 500,
  ],
};

/** AWT Serif ascent and descent in pixels for font sizes 4 to 26, the same for both weights. */
const SERIF_ASCENT: readonly number[] = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28];
const SERIF_DESCENT: readonly number[] = [2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 7, 7, 7, 7, 8, 8];

/** Windows-1252 bytes 0x80-0x9F keyed by the UTF-16 code unit each encodes. */
const CP1252_HIGH: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91],
  [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
  [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

// Code units outside Windows-1252 are never drawn but still measured, by AWT's fallback faces: controls, marks and
// format characters take no width, line and paragraph separators 600 units, accented letters their base letter's width,
// private-use code units Serif's missing glyph, and anything else, such as CJK, one em. Only Windows-1252 text is
// measured exactly; other scripts take their widths from whichever fonts the legacy host has installed.
const ZERO_ADVANCE = /^[\p{Cc}\p{Mn}\p{Me}\p{Cf}]$/u;
const SEPARATOR_UNITS = 600;
const FALLBACK_UNITS = 1000;
const MISSING_GLYPH_UNITS: Readonly<Record<Style, number>> = { regular: 600, bold: 582 };
const PRIVATE_USE_FIRST = 0xe000;
const PRIVATE_USE_LAST = 0xf8ff;

// encodeForHTML turns control characters other than tab, LF and CR into U+FFFD and other characters into references,
// which ICEbrowser decodes to one UTF-16 unit, dropping the bits above U+FFFF. It tests its immune characters as a UTF-16
// unit too, so a code point above U+FFFF whose low unit is immune stays raw, and ICEbrowser's UTF-8 reader replaces it
// with an inverted question mark. The HTML builder then collapses each run of whitespace into one space.
const ILLEGAL_CHARACTER = /^[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]$/;
const UTF16_UNIT = 0xffff;
const ENCODER_IMMUNE: ReadonlySet<number> = new Set([0x20, 0x2c, 0x2d, 0x2e, 0x5f]);
const NON_JAVA_CHARACTER = '\u00bf';
const HTML_WHITESPACE: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r', '\f', '\0']);
const ZERO_WIDTH_SPACE = '\u200b';

// Letter with cfdocument's half-inch margins: a 540 x 720 pt imageable area at (36, 36).
const MARGIN = 36;
const PAGE_WIDTH = 540;
const PAGE_HEIGHT = 720;

// ICEbrowser zooms in 1/256 steps; printing applies a 0.77 adjustment, and a page scale below 0.01 is ignored.
const ZOOM_UNIT = 256;
const PRINT_ADJUSTMENT = 0.77;
const MIN_PAGE_SCALE = 0.01;
const DEFAULT_ZOOM = Math.round(ZOOM_UNIT * PRINT_ADJUSTMENT);

// User-agent stylesheet: a 17 px medium font (10 px base x 442/256) never below 4 px, body padding 8px and margin-top
// 4px, h1 at 2em with a .67em bottom margin, and line heights of 1.10 (html) and 1.2 (table) as percentages.
const MEDIUM_FONT = 17;
const MIN_FONT = 4;
const BODY_PADDING_PX = 8;
const BODY_MARGIN_TOP_PX = 4;
const TITLE_SCALE = 2;
const TITLE_MARGIN_EM = Math.fround(0.67);
const TITLE_LINE_HEIGHT = 110;
const CELL_LINE_HEIGHT = 120;

// HTML table defaults: 3 px cell spacing that does not zoom, no cell padding, empty cells 1 px tall; the page splitter
// reads the absent cellspacing and border attributes as -1.
const CELL_SPACING = 3;
const EMPTY_CELL_HEIGHT = 1;
const ABSENT_ATTRIBUTE = -1;

const FLOAT_MILLI = Math.fround(0.001);
const f32 = Math.fround;

/** Java's Math.round for a float. */
function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** Windows-1252 byte of a UTF-16 code unit, or undefined when the encoding has none. */
function cp1252(code: number): number | undefined {
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return CP1252_HIGH.get(code);
}

/** The AWT Serif advance of a UTF-16 code unit, in units per 1000 em. */
function serifUnits(code: number, style: Style): number {
  const byte = cp1252(code);
  if (byte !== undefined) return SERIF_UNITS[style][byte - 0x20] ?? 0;
  if (code >= PRIVATE_USE_FIRST && code <= PRIVATE_USE_LAST) return MISSING_GLYPH_UNITS[style];
  const char = String.fromCharCode(code);
  if (ZERO_ADVANCE.test(char)) return 0;
  if (code === 0x2028 || code === 0x2029) return SEPARATOR_UNITS;
  const base = cp1252(char.normalize('NFD').charCodeAt(0));
  return base === undefined ? FALLBACK_UNITS : (SERIF_UNITS[style][base - 0x20] ?? FALLBACK_UNITS);
}

/** FreeType's linear advance of a 1000-unit-em glyph, as AWT reports it, at a size given in 26.6 fixed point. */
function freetypeAdvance(units: number, size26: number): number {
  const xScale = Math.floor((size26 * 65536 + 500) / 1000);
  return f32(Math.floor((units * xScale + 32) / 64) / 65536);
}

/** Text widths as the layout measures them, with advances cached per style and size. */
class Metrics {
  private readonly advances = new Map<string, Map<number, number>>();

  /** FontMetrics.charsWidth: the float sum of advances over `text[from, to)`, rounded half up. */
  width(text: string, from: number, to: number, style: Style, size: number): number {
    const key = `${style}${size}`;
    let table = this.advances.get(key);
    if (table === undefined) {
      table = new Map();
      this.advances.set(key, table);
    }
    let sum = 0;
    for (let i = from; i < to; i++) {
      const code = text.charCodeAt(i);
      let advance = table.get(code);
      if (advance === undefined) {
        advance = freetypeAdvance(serifUnits(code, style), size * 64);
        table.set(code, advance);
      }
      sum = f32(sum + advance);
    }
    return Math.floor(0.5 + sum);
  }
}

/** iText's number formatting: five decimals below 1, two above, nothing below 1.5e-5. */
function pdfNumber(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude < 1.5e-5) return 0;
  const sign = Math.sign(value);
  if (magnitude < 1) {
    const shifted = magnitude + 5e-6;
    return shifted >= 1 ? sign : (sign * Math.trunc(shifted * 100000)) / 100000;
  }
  return (sign * Math.trunc((magnitude + 0.005) * 100)) / 100;
}

/**
 * The Tc iText sets for a drawn line: the line's Serif width, measured at 1000 px through a scaled font, less its Times
 * width, spread over the gaps between its code units.
 */
function characterSpacing(text: string, style: Style, size: number): number {
  if (text.length < 2) return 0;
  const scale = f32(1000 / size);
  const size26 = Math.trunc(size * scale * 64);
  let serif = 0;
  let times = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    serif = f32(serif + freetypeAdvance(serifUnits(code, style), size26));
    const byte = cp1252(code);
    times += byte === undefined ? 0 : (TIMES_UNITS[style][byte - 0x20] ?? 0);
  }
  const timesWidth = f32(f32(times * FLOAT_MILLI) * size);
  return pdfNumber(f32(f32(f32(serif / scale) - timesWidth) / (text.length - 1)));
}

/** The WinAnsi bytes iText draws for `text`, as hex; code units the encoding lacks are dropped. */
function winAnsiHex(text: string): string {
  let hex = '';
  for (let i = 0; i < text.length; i++) {
    const byte = cp1252(text.charCodeAt(i));
    if (byte !== undefined) hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Whether the HTML builder's last text ended in whitespace, which drops the next text's leading whitespace. */
interface TextState {
  spaceAdded: boolean;
}

/**
 * The text a title, header or cell holds after encodeForHTML and the builder's whitespace collapsing; undefined when
 * the block stays empty, which a lone space also does. Only th and h1 keep a leading space.
 */
function textNode(value: string, leadingSpace: boolean, state: TextState): string | undefined {
  let text = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const unit = code & UTF16_UNIT;
    if (code === unit) text += ILLEGAL_CHARACTER.test(char) ? '\uFFFD' : char;
    else text += ENCODER_IMMUNE.has(unit) ? NON_JAVA_CHARACTER : String.fromCharCode(unit);
  }
  let i = 0;
  while (i < text.length && HTML_WHITESPACE.has(text.charAt(i))) i++;
  let out = '';
  if (i > 0 && !state.spaceAdded) {
    if (leadingSpace) out = ' ';
    state.spaceAdded = true;
  }
  if (i < text.length) {
    let inWord = true;
    out += text.charAt(i++);
    for (; i < text.length; i++) {
      const char = text.charAt(i);
      if (!HTML_WHITESPACE.has(char)) {
        out += char;
        inWord = true;
      } else if (inWord) {
        out += ' ';
        inWord = false;
      }
    }
    state.spaceAdded = !inWord;
  }
  return out === '' || out === ' ' ? undefined : out;
}

// The HTML builder also splits a text longer than 8192 characters into separate text nodes, which iText draws as
// separate strings; that is not reproduced, because every exported value is far shorter (titles at most 255 characters,
// definition names 100).
/** The export's HTML as the builder holds it: the title, then rows of cell texts with the header row first. */
interface DocumentText {
  title: string | undefined;
  rows: (string | undefined)[][];
  columns: number;
}

function documentText(table: ExportTable): DocumentText {
  const state: TextState = { spaceAdded: false };
  const title = textNode(table.title, true, state);
  const header = table.columns.map((column) => textNode(column.label, true, state));
  const body = table.rows.map((row) => row.map((value) => textNode(value, false, state)));
  const rows = [header, ...body];
  return { title, rows, columns: rows.reduce((columns, row) => Math.max(columns, row.length), 0) };
}

/** A text box: its text, the offsets just past each break opportunity, their cumulative pixel positions and width. */
interface TextRun {
  text: string;
  style: Style;
  size: number;
  breaks: number[];
  pixels: number[];
  width: number;
}

// Break positions accumulate each segment's rounded width while the width is the whole text's rounded width, so the
// last segment can fit a line its own width would overflow; the fixture wraps exactly that way.
function textRun(text: string, style: Style, size: number, metrics: Metrics): TextRun {
  const breaks: number[] = [];
  let position = 0;
  while (position < text.length) {
    while (position < text.length && text.charAt(position) !== ' ' && text.charAt(position) !== ZERO_WIDTH_SPACE) {
      position++;
    }
    if (position >= text.length) break;
    if (text.charAt(position) === ZERO_WIDTH_SPACE) {
      breaks.push(++position);
      continue;
    }
    while (position < text.length && text.charAt(position) === ' ') position++;
    breaks.push(position);
  }
  const pixels: number[] = [];
  let sum = 0;
  let from = 0;
  for (const offset of breaks) {
    sum += metrics.width(text, from, offset, style, size);
    pixels.push(sum);
    from = offset;
  }
  return { text, style, size, breaks, pixels, width: Math.max(metrics.width(text, 0, text.length, style, size), sum) };
}

/** Minimum and maximum content widths of a block holding `run`; an empty block is 1 px either way. */
function widthRange(run: TextRun | undefined): [number, number] {
  if (run === undefined) return [1, 1];
  const { pixels, width } = run;
  if (pixels.length === 0) {
    const single = width > 1 ? width : 1;
    return [single, single];
  }
  const max = Math.max(1, width);
  let min = pixels[0] ?? 0;
  for (let i = 1; i < pixels.length; i++) min = Math.max(min, (pixels[i] ?? 0) - (pixels[i - 1] ?? 0));
  min = Math.max(min, width - (pixels[pixels.length - 1] ?? 0));
  if (max !== width) min -= 1;
  return [min, Math.max(min, max)];
}

/** One line of a text box: its pixel span within the text and its x offset within the block. */
interface Line {
  start: number;
  end: number;
  x: number;
}

/** Breaks `run` into lines no wider than `available` where breaks allow, centring them in a header cell. */
function breakLines(run: TextRun, available: number, centred: boolean): Line[] {
  const positions = [...run.pixels, run.width];
  const last = run.pixels.length;
  const lines: Line[] = [];
  const push = (start: number, end: number): void => {
    const chunk = end - start;
    lines.push({ start, end, x: centred && chunk < available ? Math.trunc((available - chunk) / 2) : 0 });
  };
  let start = 0;
  let index = 0;
  while (index <= last) {
    let position = positions[index] ?? 0;
    if (position - start > available) {
      let breakIndex = index;
      if (breakIndex > 0 && positions[breakIndex - 1] !== start) {
        breakIndex--;
        position = positions[breakIndex] ?? 0;
      }
      push(start, position);
      start = position;
      index = breakIndex + 1;
      continue;
    }
    if (index === last) push(start, position);
    index++;
  }
  return lines;
}

/** The characters a line draws: from its starting break to its ending one, less the space before a soft break. */
function lineText(run: TextRun, line: Line): string {
  const { text, breaks, pixels, width } = run;
  const first = line.start === 0 ? 0 : pixels.indexOf(line.start) + 1;
  const start = first === 0 ? 0 : (breaks[first - 1] ?? 0);
  let end = text.length;
  if (line.end !== width) {
    end = breaks[pixels.indexOf(line.end, Math.max(0, first - 1))] ?? text.length;
    if (text.charAt(end - 1) === ' ') end--;
  }
  return start < end ? text.slice(start, end) : '';
}

/** A CSS px length at `zoom`, rounded as ICEbrowser rounds it, with fractions of a pixel kept as one. */
function zoomedPixels(px: number, zoom: number): number {
  const value = f32(f32(px * zoom) / ZOOM_UNIT);
  return roundHalfUp(value > 0.01 && value < 1 ? 1 : value);
}

/** Baseline offset of a text line within its line box: the compressed ascent less the half leading. */
function baselineOffset(size: number, lineHeight: number): number {
  const index = Math.min(Math.max(size, MIN_FONT), SERIF_ASCENT.length + MIN_FONT - 1) - MIN_FONT;
  const ascent = SERIF_ASCENT[index] ?? size;
  const descent = SERIF_DESCENT[index] ?? 1;
  const compressedDescent = roundHalfUp(f32(size / f32(1 + f32(ascent / descent))));
  const lineAscent = size - compressedDescent + 1;
  const lineDescent = compressedDescent + 1;
  return lineAscent - roundHalfUp(f32((lineAscent + lineDescent - lineHeight) / 2));
}

/** The document's text boxes at one zoom with the widths the table and page are sized from. */
interface Measured {
  size: number;
  titleSize: number;
  padding: number;
  marginTop: number;
  title: TextRun | undefined;
  cells: (TextRun | undefined)[][];
  columnMin: number[];
  columnMax: number[];
  tableMin: number;
  tableMax: number;
  width: number;
}

function measure(doc: DocumentText, zoom: number, metrics: Metrics): Measured {
  const size = Math.max(MIN_FONT, (MEDIUM_FONT * zoom) >> 8);
  const titleSize = Math.max(MIN_FONT, TITLE_SCALE * size);
  const padding = zoomedPixels(BODY_PADDING_PX, zoom);
  const title = doc.title === undefined ? undefined : textRun(doc.title, 'bold', titleSize, metrics);
  const cells = doc.rows.map((row, r) =>
    row.map((text) => (text === undefined ? undefined : textRun(text, r === 0 ? 'bold' : 'regular', size, metrics))),
  );
  const columnMin = new Array<number>(doc.columns).fill(0);
  const columnMax = new Array<number>(doc.columns).fill(0);
  for (const row of cells) {
    row.forEach((run, c) => {
      const [min, max] = widthRange(run);
      columnMin[c] = Math.max(columnMin[c] ?? 0, min);
      columnMax[c] = Math.max(columnMax[c] ?? 0, max);
    });
  }
  const spacing = CELL_SPACING * (doc.columns + 1);
  const tableMin = columnMin.reduce((a, b) => a + b, spacing);
  const tableMax = columnMax.reduce((a, b) => a + b, spacing);
  const bodyMin = Math.max(1, widthRange(title)[0], tableMin) + 2 * padding;
  return {
    size,
    titleSize,
    padding,
    marginTop: zoomedPixels(BODY_MARGIN_TOP_PX, zoom),
    title,
    cells,
    columnMin,
    columnMax,
    tableMin,
    tableMax,
    width: Math.max(PAGE_WIDTH, bodyMin),
  };
}

/** The zoom cfdocument prints at: the default, shrunk by the share of the page the document's width overflows. */
function printZoom(doc: DocumentText, metrics: Metrics): number {
  const width = measure(doc, DEFAULT_ZOOM, metrics).width;
  const scale = width > PAGE_WIDTH ? (1 / width) * PAGE_WIDTH : 1;
  return Math.round(ZOOM_UNIT * PRINT_ADJUSTMENT * (scale < MIN_PAGE_SCALE ? 1 : scale));
}

/** Column widths of the automatic table layout for a table `width` wide. */
function columnWidths(m: Measured, width: number): number[] {
  if (width >= m.tableMax) return [...m.columnMax];
  if (width <= m.tableMin) return [...m.columnMin];
  let share = width - m.tableMin;
  let range = m.tableMax - m.tableMin;
  return m.columnMin.map((min, c) => {
    const max = m.columnMax[c] ?? min;
    const column = range > 0 ? min + Math.trunc(Math.imul(max - min, share) / range) : min;
    range -= max - min;
    share -= column - min;
    return column;
  });
}

/** A laid-out line: its document box, baseline offset, x, font and the characters it draws. */
interface PlacedLine {
  top: number;
  height: number;
  baseline: number;
  x: number;
  style: Style;
  size: number;
  text: string;
}

/** A laid-out title or cell: its document box and lines. */
interface PlacedBlock {
  x: number;
  width: number;
  top: number;
  height: number;
  lines: PlacedLine[];
}

interface PlacedRow {
  top: number;
  height: number;
  cells: PlacedBlock[];
}

/** A natural page break: a block or line boundary, or a table row boundary. */
interface PageBreak {
  y: number;
  table: boolean;
}

/** A table wider than the page, positioned as the page splitter sees it: relative to the body, not the page. */
interface WideTable {
  x: number;
  y: number;
  width: number;
  height: number;
  columnBreaks: number[];
}

interface Layout {
  height: number;
  bodyTop: number;
  bodyHeight: number;
  title: PlacedBlock;
  tableTop: number;
  tableHeight: number;
  rows: PlacedRow[];
  breaks: PageBreak[];
  wide: WideTable | undefined;
}

function placeLines(run: TextRun, lines: Line[], x: number, top: number, lineHeight: number): PlacedLine[] {
  const baseline = baselineOffset(run.size, lineHeight);
  return lines.map((line, i) => ({
    top: top + i * lineHeight,
    height: lineHeight,
    baseline,
    x: x + line.x,
    style: run.style,
    size: run.size,
    text: lineText(run, line),
  }));
}

/** Column boundaries the page splitter may cut at, offset by the unset cellspacing and border attributes. */
function columnBreaks(x: number, widths: number[]): number[] {
  let offset = x;
  return widths.map((width, i) => {
    if (i === 0) {
      offset += ABSENT_ATTRIBUTE + ABSENT_ATTRIBUTE + width;
      if (widths.length === 1) offset += ABSENT_ATTRIBUTE + ABSENT_ATTRIBUTE;
    } else if (i === widths.length - 1) {
      offset += width + 3 * ABSENT_ATTRIBUTE;
    } else {
      offset += width + ABSENT_ATTRIBUTE;
    }
    return offset;
  });
}

function layoutDocument(doc: DocumentText, zoom: number, metrics: Metrics): Layout {
  const m = measure(doc, zoom, metrics);
  const contentWidth = PAGE_WIDTH - 2 * m.padding;
  const titleLineHeight = Math.trunc((TITLE_LINE_HEIGHT * m.titleSize) / 100);
  const titleTop = m.marginTop + m.padding;
  const titleLines = m.title === undefined ? [] : breakLines(m.title, contentWidth, false);
  const title: PlacedBlock = {
    x: m.padding,
    width: contentWidth,
    top: titleTop,
    height: titleLines.length * titleLineHeight,
    lines: m.title === undefined ? [] : placeLines(m.title, titleLines, m.padding, titleTop, titleLineHeight),
  };
  const tableOffset = m.padding + title.height + Math.trunc(f32(TITLE_MARGIN_EM * m.titleSize));
  const tableTop = m.marginTop + tableOffset;
  const tableWidth = Math.min(Math.max(contentWidth, m.tableMin), m.tableMax);
  const widths = columnWidths(m, tableWidth);
  const coordinates: number[] = [];
  let next = CELL_SPACING;
  for (const width of widths) {
    coordinates.push(next);
    next += width + CELL_SPACING;
  }
  const cellLineHeight = Math.trunc((CELL_LINE_HEIGHT * m.size) / 100);
  const rows: PlacedRow[] = [];
  let rowTop = tableTop + CELL_SPACING;
  m.cells.forEach((row, r) => {
    const laidOut = row.map((run, c) => {
      const width = widths[c] ?? 0;
      const lines = run === undefined ? [] : breakLines(run, width, r === 0);
      return { run, width, lines, height: run === undefined ? EMPTY_CELL_HEIGHT : lines.length * cellLineHeight };
    });
    const height = Math.max(0, ...laidOut.map((cell) => cell.height));
    const cells = laidOut.map(({ run, width, lines, height: own }, c) => {
      const x = m.padding + (coordinates[c] ?? 0);
      const top = rowTop + (own < height ? Math.trunc((height - own) / 2) : 0);
      return { x, width, top: rowTop, height, lines: run === undefined ? [] : placeLines(run, lines, x, top, cellLineHeight) };
    });
    rows.push({ top: rowTop, height, cells });
    rowTop += height + CELL_SPACING;
  });
  const groupHeight = rows.length === 0 ? 0 : rowTop - CELL_SPACING - (tableTop + CELL_SPACING);
  const tableHeight = 2 * CELL_SPACING + groupHeight;
  const bodyHeight = 2 * m.padding + tableOffset - m.padding + tableHeight;
  const height = Math.max(PAGE_HEIGHT, m.marginTop + bodyHeight);

  // ICEbrowser keeps natural breaks in a set ordered by y in which the first break recorded at a y wins.
  const recorded = new Map<number, boolean>();
  const record = (y: number, table: boolean): void => {
    if (!recorded.has(y)) recorded.set(y, table);
  };
  const recordBlock = (top: number, lines: number, lineHeight: number, blockHeight: number): void => {
    record(top, false);
    for (let i = 1; i <= lines && lineHeight > 0; i++) record(top + i * lineHeight, false);
    record(top + blockHeight, false);
  };
  record(0, false);
  record(height, false);
  record(m.marginTop, false);
  record(m.marginTop + bodyHeight, false);
  recordBlock(title.top, titleLines.length, titleLineHeight, title.height);
  rows.forEach((row, r) => {
    record(row.top, true);
    record(row.top + row.height, true);
    (m.cells[r] ?? []).forEach((run, c) => {
      const lines = run === undefined ? 0 : (row.cells[c]?.lines.length ?? 0);
      recordBlock(row.top, lines, cellLineHeight, row.height);
    });
  });
  const breaks = [...recorded].map(([y, table]) => ({ y, table })).sort((a, b) => a.y - b.y);
  const wide =
    tableWidth > PAGE_WIDTH && widths.length > 0
      ? { x: m.padding, y: tableOffset, width: tableWidth, height: tableHeight, columnBreaks: columnBreaks(m.padding, widths) }
      : undefined;
  return { height, bodyTop: m.marginTop, bodyHeight, title, tableTop, tableHeight, rows, breaks, wide };
}

/** A printed page: the document area it shows. */
interface Page {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Where a page starting at `start` ends: at the last natural break on it whose successor lies on the next page, unless
 * that is in the page's top quarter; a line break defers to a row break up to a tenth of a page above it.
 */
function pageEnd(breaks: PageBreak[], start: number): number {
  const quarter = Math.trunc(PAGE_HEIGHT / 4);
  const tenth = Math.trunc(PAGE_HEIGHT / 10);
  let low = 0;
  let high = breaks.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((breaks[mid]?.y ?? 0) <= start) low = mid + 1;
    else high = mid;
  }
  for (let i = low; i < breaks.length - 1; i++) {
    const current = breaks[i];
    const following = breaks[i + 1];
    if (current === undefined || following === undefined) break;
    if (current.y > start + PAGE_HEIGHT) break;
    if (current.y <= start + quarter) continue;
    if (following.y <= start + PAGE_HEIGHT || following.y >= start + 2 * PAGE_HEIGHT) continue;
    if (!current.table) {
      for (let j = i - 1; j >= 0; j--) {
        const earlier = breaks[j];
        if (earlier === undefined || current.y - earlier.y > tenth) break;
        if (earlier.table) return earlier.y;
      }
    }
    return current.y;
  }
  return start + PAGE_HEIGHT;
}

function verticalPages(layout: Layout): Page[] {
  const pages: Page[] = [];
  let start = 0;
  while (start < layout.height) {
    const end = pageEnd(layout.breaks, start);
    pages.push({ x0: 0, x1: PAGE_WIDTH, y0: start, y1: end });
    start = end;
  }
  return pages;
}

/** Whether the page splitter counts `table` as on `page`, by its overlap test, whose horizontal arm reuses the height. */
function tableOnPage(table: WideTable, page: Page): boolean {
  const { x, y, width, height } = table;
  const bottom = y + height;
  const vertical = (y >= page.y0 && y < page.y1) || (y < page.y0 && (bottom >= page.y1 || (bottom < page.y1 && bottom >= page.y0)));
  const horizontal =
    (x >= page.x0 && x < page.x1) || (x < page.x0 && (x + width >= page.x0 || (x + width < page.x1 && x + height >= page.x0)));
  return vertical && horizontal;
}

/** Where a horizontal page part starting at `start` ends: at a column boundary past its middle, else a page width on. */
function partEnd(boundaries: number[], start: number): number {
  for (let i = 0; i < boundaries.length - 1; i++) {
    const current = boundaries[i] ?? 0;
    const following = boundaries[i + 1] ?? 0;
    if (current <= start || current >= start + PAGE_WIDTH) continue;
    if (following <= start + PAGE_WIDTH || following >= start + 2 * PAGE_WIDTH) continue;
    if ((current - start) / PAGE_WIDTH > 0.5) return current;
  }
  return start + PAGE_WIDTH;
}

// Parts of a split page are inserted after a running count that skips unsplit pages, as ICEbrowser inserts them.
function splitWidePages(pages: Page[], table: WideTable | undefined): Page[] {
  if (table === undefined) return pages;
  const boundaries = [...table.columnBreaks].sort((a, b) => a - b);
  for (let i = boundaries.length - 1; i > 1; i--) {
    if (boundaries[i - 1] === boundaries[i]) boundaries.splice(i, 1);
  }
  const all = [...pages];
  let count = 0;
  for (const page of pages) {
    if (!tableOnPage(table, page)) continue;
    let end = 0;
    let part = 0;
    while (end <= table.x + table.width) {
      const start = end;
      end = partEnd(boundaries, start);
      if (part === 0) {
        page.x1 = end;
      } else {
        all.splice(count + 1, 0, { x0: start, x1: end, y0: page.y0, y1: page.y1 });
        count++;
      }
      part++;
    }
    count++;
  }
  return all;
}

/** A string iText draws: its page position (baseline below the imageable area's top), font and characters. */
interface DrawnText {
  x: number;
  t: number;
  style: Style;
  size: number;
  text: string;
}

// ICEbrowser paints every box the page's clip touches, so a row cut by a page break paints on both pages; iText then
// skips strings whose baseline lies outside the imageable area.
function paintPage(layout: Layout, page: Page): DrawnText[] {
  const drawn: DrawnText[] = [];
  const paintLines = (lines: PlacedLine[]): void => {
    for (const line of lines) {
      if (line.top > page.y1) break;
      if (line.top + line.height < page.y0 || line.text === '') continue;
      const t = line.top + line.baseline - page.y0;
      if (t >= 0 && t <= PAGE_HEIGHT) {
        drawn.push({ x: line.x - page.x0, t, style: line.style, size: line.size, text: line.text });
      }
    }
  };
  const touches = (top: number, height: number): boolean => top + height >= page.y0 && top <= page.y1;
  if (!touches(layout.bodyTop, layout.bodyHeight)) return drawn;
  if (layout.title.top > page.y1) return drawn;
  if (touches(layout.title.top, layout.title.height)) paintLines(layout.title.lines);
  if (!touches(layout.tableTop, layout.tableHeight)) return drawn;
  const { rows } = layout;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const row = rows[mid];
    if (row !== undefined && row.top + row.height <= page.y0) low = mid + 1;
    else high = mid;
  }
  for (let r = low; r < rows.length; r++) {
    const row = rows[r];
    if (row === undefined || row.top > page.y1) break;
    for (const cell of row.cells) {
      if (cell.x + cell.width > page.x0 && cell.x < page.x1) paintLines(cell.lines);
    }
  }
  return drawn;
}

/** Unembedded standard-font dictionaries, created when a style is first drawn and shared by every page. */
class FontResources {
  private readonly refs = new Map<Style, PDFKit.PDFKitReference>();

  constructor(private readonly pdf: PDFKit.PDFDocument) {}

  /** The resource name of `style`'s font, registered on the current page. */
  use(style: Style): string {
    let ref = this.refs.get(style);
    if (ref === undefined) {
      ref = this.pdf.ref({ Type: 'Font', Subtype: 'Type1', BaseFont: PDF_FONTS[style], Encoding: 'WinAnsiEncoding' });
      ref.end(undefined);
      this.refs.set(style, ref);
    }
    const name = FONT_RESOURCES[style];
    this.pdf.page.fonts[name] = ref;
    return name;
  }
}

// Each string is its own text object, as iText writes it: pdfkit's text() would kern standard fonts, which iText does
// not, and pdfjs-dist derives its spacing from glyph positions.
function drawPage(pdf: PDFKit.PDFDocument, fonts: FontResources, items: DrawnText[]): void {
  const ops: string[] = [];
  for (const item of items) {
    const hex = winAnsiHex(item.text);
    if (hex === '') continue;
    const spacing = characterSpacing(item.text, item.style, item.size);
    const name = fonts.use(item.style);
    ops.push('BT', `/${name} ${item.size} Tf`, `1 0 0 1 ${MARGIN + item.x} ${MARGIN + PAGE_HEIGHT - item.t} Tm`);
    ops.push(`${spacing} Tc`, `<${hex}> Tj`, 'ET');
  }
  if (ops.length === 0) return;
  pdf.save();
  pdf.transform(1, 0, 0, -1, 0, pdf.page.height);
  pdf.addContent(ops.join('\n'));
  pdf.restore();
}

/** Renders an export table as the PDF the fixture's cfdocument produces. */
export async function renderPdf({ table, job }: ExportWriterInput): Promise<ExportRendering> {
  const text = documentText(table);
  const metrics = new Metrics();
  const layout = layoutDocument(text, printZoom(text, metrics), metrics);
  const pages = splitWidePages(verticalPages(layout), layout.wide);
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const pdf = new PDFDocument({ autoFirstPage: false, info: { CreationDate: job.started_at ?? job.created } });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    const fonts = new FontResources(pdf);
    for (const page of pages) {
      pdf.addPage({ size: 'LETTER', margin: 0 });
      drawPage(pdf, fonts, paintPage(layout, page));
    }
    pdf.end();
  });
  return { bytes, fileName: `export-${job.job_id}.pdf`, contentType: CONTENT_TYPE };
}
