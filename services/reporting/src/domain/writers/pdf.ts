// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** PDF export writer: the fixture's cfdocument page, an h1 of the export title over the table, in pdfkit's standard Times fonts. */
import PDFDocument from 'pdfkit';
import type { ExportRendering, ExportWriterInput } from './index.js';

const CONTENT_TYPE = 'application/pdf';

/** A standard font and size; standard fonts draw WinAnsi text and load no font file. */
interface Face {
  font: 'Times-Roman' | 'Times-Bold';
  size: number;
}

const TITLE: Face = { font: 'Times-Bold', size: 22 };
const HEADER: Face = { font: 'Times-Bold', size: 11 };
const BODY: Face = { font: 'Times-Roman', size: 11 };

// Geometry of the fixture's cfdocument output, in points from the top left of a Letter page: 0.5 in top and bottom
// margins, the body indented 5.5 pt within the 0.5 in side margins, an 11 pt table under a 22 pt heading.
const PAGE_HEIGHT = 792;
const TOP = 36;
const BOTTOM = PAGE_HEIGHT - TOP;
const LEFT = 41.5;
const CONTENT_WIDTH = 612 - 2 * LEFT;
const TITLE_BASELINE = 62;
const TITLE_LINE = 26;
const TITLE_TO_TABLE = 23;
const LINE = 13;
const ROW_EXTRA = 3;
const FIRST_BASELINE = 9;
const CELL_SPACING = 1.375;
const CELL_PADDING = 0.6875;
const EPSILON = 1e-6;

// Windows-1252's repertoire, all that WinAnsi Times fonts draw; tab, LF, FF and CR are HTML whitespace.
const UNDRAWABLE =
  /[^\t\n\f\r\x20-\x7E\xA0-\xFF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201A\u201C-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]/gu;
const HTML_WHITESPACE = /[\t\n\f\r ]+/g;
const END_SPACES = /^ | $/g;

type Doc = PDFKit.PDFDocument;

/** Pen position: the top of the next row on the current page. */
interface Pen {
  y: number;
}

/** `value` as the HTML renderer draws it: undrawable characters dropped, whitespace runs collapsed, ends trimmed; a no-break space stays. */
function drawable(value: string): string {
  return value.replace(UNDRAWABLE, '').replace(HTML_WHITESPACE, ' ').replace(END_SPACES, '');
}

function use(doc: Doc, face: Face): void {
  doc.font(face.font).fontSize(face.size);
}

/** Lines of `text` within `width` in the current face, broken at spaces, and between characters for a wider word. */
function wrap(doc: Doc, text: string, width: number): string[] {
  const lines: string[] = [];
  if (text === '') return lines;
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (doc.widthOfString(candidate) <= width + EPSILON) {
      line = candidate;
      continue;
    }
    if (line !== '') lines.push(line);
    line = '';
    for (const char of word) {
      if (line !== '' && doc.widthOfString(line + char) > width + EPSILON) {
        lines.push(line);
        line = char;
      } else {
        line += char;
      }
    }
  }
  lines.push(line);
  return lines;
}

/** Column widths by the HTML auto table layout: widest content when it fits, else each column's widest word plus a share of the rest. */
function columnWidths(doc: Doc, header: readonly string[], body: readonly (readonly string[])[], available: number): number[] {
  const min = header.map(() => 0);
  const max = header.map(() => 0);
  const measure = (cells: readonly string[]): void => {
    cells.forEach((text, c) => {
      max[c] = Math.max(max[c] ?? 0, doc.widthOfString(text));
      for (const word of text.split(' ')) min[c] = Math.max(min[c] ?? 0, doc.widthOfString(word));
    });
  };
  use(doc, HEADER);
  measure(header);
  use(doc, BODY);
  body.forEach(measure);
  const sumMin = min.reduce((a, b) => a + b, 0);
  const sumMax = max.reduce((a, b) => a + b, 0);
  if (sumMax <= available) return max;
  if (sumMin >= available) return min.map((w) => (w * available) / sumMin);
  const share = (available - sumMin) / (sumMax - sumMin);
  return min.map((w, c) => w + ((max[c] ?? 0) - w) * share);
}

function draw(doc: Doc, text: string, x: number, baseline: number): void {
  doc.text(text, x, baseline, { lineBreak: false, baseline: 'alphabetic' });
}

/** Draws one table row of wrapped cells at the pen, vertically centred; a row taller than a page runs on, top-aligned. */
function drawRow(doc: Doc, pen: Pen, cells: readonly string[][], xs: readonly number[], widths: readonly number[], centred: boolean): void {
  const lineCount = Math.max(0, ...cells.map((lines) => lines.length));
  const height = lineCount * LINE + ROW_EXTRA;
  const xOf = (c: number, line: string): number =>
    (xs[c] ?? 0) + (centred ? ((widths[c] ?? 0) - doc.widthOfString(line)) / 2 : 0);
  if (pen.y + height > BOTTOM && pen.y > TOP) {
    doc.addPage();
    pen.y = TOP;
  }
  if (pen.y + height <= BOTTOM) {
    cells.forEach((lines, c) => {
      const offset = ((lineCount - lines.length) * LINE) / 2;
      lines.forEach((line, i) => {
        draw(doc, line, xOf(c, line), pen.y + FIRST_BASELINE + offset + i * LINE);
      });
    });
    pen.y += height;
    return;
  }
  let top = pen.y;
  for (let i = 0; i < lineCount; i += 1) {
    if (top + LINE + ROW_EXTRA > BOTTOM) {
      doc.addPage();
      top = TOP;
    }
    cells.forEach((lines, c) => {
      const line = lines[i];
      if (line !== undefined) draw(doc, line, xOf(c, line), top + FIRST_BASELINE);
    });
    top += LINE;
  }
  pen.y = top + ROW_EXTRA;
}

/** Collects the document's bytes once it ends. */
function bytesOf(doc: Doc): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });
}

// The creation date is the job's, not the clock's, so a re-run of one job renders the same bytes.
/** Renders the export title, then the table with its header row first, as a PDF. */
export async function renderPdf({ job, table }: ExportWriterInput): Promise<ExportRendering> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: TOP, bottom: TOP, left: LEFT, right: LEFT },
    info: { CreationDate: job.started_at ?? job.created },
  });
  const bytes = bytesOf(doc);

  use(doc, TITLE);
  let baseline = TITLE_BASELINE;
  for (const line of wrap(doc, drawable(table.title), CONTENT_WIDTH)) {
    if (baseline > BOTTOM) {
      doc.addPage();
      baseline = TITLE_BASELINE;
    }
    draw(doc, line, LEFT, baseline);
    baseline += TITLE_LINE;
  }
  const pen: Pen = { y: baseline - TITLE_LINE + TITLE_TO_TABLE };

  const header = table.columns.map((column) => drawable(column.label));
  const body = table.rows.map((row) => row.map(drawable));
  const count = header.length;
  const widths = columnWidths(doc, header, body, Math.max(0, CONTENT_WIDTH - (count + 1) * CELL_SPACING - count * 2 * CELL_PADDING));
  const xs: number[] = [];
  let x = LEFT + CELL_SPACING + CELL_PADDING;
  for (const width of widths) {
    xs.push(x);
    x += width + 2 * CELL_PADDING + CELL_SPACING;
  }

  if (count > 0) {
    use(doc, HEADER);
    drawRow(doc, pen, header.map((text, c) => wrap(doc, text, widths[c] ?? 0)), xs, widths, true);
    use(doc, BODY);
    for (const row of body) drawRow(doc, pen, row.map((text, c) => wrap(doc, text, widths[c] ?? 0)), xs, widths, false);
  }
  doc.end();
  return { bytes: await bytes, fileName: `export-${job.job_id}.pdf`, contentType: CONTENT_TYPE };
}
