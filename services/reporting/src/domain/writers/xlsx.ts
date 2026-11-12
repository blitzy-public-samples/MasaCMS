// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** XLSX export writer: the fixture's single `export` sheet with every cell stored as a string. */
import { PassThrough, Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import type { ExportTableStream } from '../sources.js';
import type { ExportRendering, ExportWriterInput } from './index.js';
import { createSpill, type Spill } from './spill.js';

const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SHEET_NAME = 'export';

const SHARED_STRINGS_PART = '/xl/sharedStrings.xml';
const SHARED_STRINGS_OPEN =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
// exceljs's rule for a shared string whose whitespace XML would otherwise trim.
const PRESERVE_SPACE = /^\s|\n|\s$/;

// exceljs writes CR raw, which XML reads back as LF, and drops the other control characters; OOXML's _xHHHH_ escape
// keeps them all, and a literal _xHHHH_, or _xHHHH before a control character whose escape supplies the closing
// underscore, keeps its underscore as _x005F_.
const LITERAL_ESCAPE = /_(?=x[0-9A-Fa-f]{4}(?:_|[\x00-\x08\x0B-\x1F\x7F]))/g;
const XML_UNSAFE = /[\x00-\x08\x0B-\x1F\x7F]/g;

/** `value` as shared-string text that reads back unchanged. */
function cellText(value: string): string {
  return value
    .replace(LITERAL_ESCAPE, '_x005F_')
    .replace(XML_UNSAFE, (char) => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
}

/** `text` with the five XML special characters escaped as exceljs escapes them. */
function xmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** A shared-string table spilled to a file, one `<si>` per string cell and never deduplicated, so it keeps no string in memory. */
class SpilledStrings {
  count = 0;

  constructor(private readonly spill: Spill) {}

  /** Appends `value`, a `cellText` result, as the table's next string and returns its index. */
  add(value: string): number {
    const space = PRESERVE_SPACE.test(value) ? ' xml:space="preserve"' : '';
    this.spill.append(`<si><t${space}>${xmlText(value)}</t></si>`);
    return this.count++;
  }

  /** Resolves once the spill file accepts more. */
  drain(): Promise<void> {
    return this.spill.drain();
  }

  /** The `sharedStrings.xml` part: every spilled string inside its `sst` element. */
  async *part(): AsyncGenerator<string | Buffer> {
    await this.spill.end();
    yield `${SHARED_STRINGS_OPEN} count="${String(this.count)}" uniqueCount="${String(this.count)}">`;
    yield* this.spill.open();
    yield '</sst>';
  }
}

/** The zip archive a workbook writer adds its parts to. */
interface ZipArchive {
  append(source: Readable, data: { name: string }): unknown;
}

// Relies on exceljs 4.4.0 internals: worksheets add every string cell to `sharedStrings`, and `addSharedStrings` writes
// that table to `zip`.
/** A streaming workbook whose shared strings go to a spill file and then to the zip as one streamed part. */
class SpilledStringsWorkbook extends ExcelJS.stream.xlsx.WorkbookWriter {
  declare sharedStrings: SpilledStrings;
  private declare readonly zip: ZipArchive;

  constructor(
    private readonly body: PassThrough,
    spill: Spill,
  ) {
    // Shared strings, because exceljs reads inline strings without their _xHHHH_ escapes and an empty one as no value.
    super({ stream: body, useSharedStrings: true, useStyles: false });
    this.sharedStrings = new SpilledStrings(spill);
  }

  override addSharedStrings(): Promise<void> {
    if (this.sharedStrings.count > 0) {
      const part = Readable.from(this.sharedStrings.part(), { objectMode: false });
      // A destroyed body stalls the zip mid-part, so its close also closes the part's reader of the spill file.
      this.body.once('close', () => part.destroy());
      this.zip.append(part, { name: SHARED_STRINGS_PART });
    }
    return Promise.resolve();
  }
}

/** A handler that destroys `body` with the error it receives. */
function failWith(body: PassThrough): (err: unknown) => void {
  return (err) => {
    body.destroy(err as Error);
  };
}

/** Resolves once `body` drains or closes. */
function drained(body: PassThrough): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      body.off('drain', done);
      body.off('close', done);
      resolve();
    };
    body.on('drain', done);
    body.on('close', done);
  });
}

/** Resolves once the spill accepts more strings or `body` closes, so rows stop as soon as the consumer has gone. */
function spillDrained(strings: SpilledStrings, body: PassThrough): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      body.off('close', done);
      resolve();
    };
    body.once('close', done);
    strings.drain().then(done, reject);
  });
}

/** Commits the header row, then each row as it is read, to the workbook's one sheet, waiting while `body` or the spill is full. */
async function writeSheet(workbook: SpilledStringsWorkbook, table: ExportTableStream, body: PassThrough): Promise<void> {
  const sheet = workbook.addWorksheet(SHEET_NAME);
  // Every value is a string, so exceljs stores a string cell, never a number or date, as the fixture's "string" cells.
  sheet.addRow(table.columns.map((column) => cellText(column.label))).commit();
  for await (const row of table.rows) {
    if (body.destroyed) return;
    sheet.addRow(row.map(cellText)).commit();
    await spillDrained(workbook.sharedStrings, body);
    // exceljs hands each row to its zip without waiting for compression or the body, so every row yields a turn to both.
    await (body.writableNeedDrain ? drained(body) : nextTurn());
  }
  sheet.commit();
  await workbook.commit();
}

/** Writes `table` to `body` as a workbook dated `created`, removing its spill file once it settles or `body` closes. */
async function writeWorkbook(created: Date, table: ExportTableStream, body: PassThrough): Promise<void> {
  const spill = await createSpill();
  // exceljs never settles once its body is destroyed, so the body's close removes the spill as well.
  const release = (): void => {
    spill.dispose().catch(failWith(body));
  };
  body.once('close', release);
  try {
    if (body.destroyed) return;
    const workbook = new SpilledStringsWorkbook(body, spill);
    workbook.created = created;
    workbook.modified = created;
    await writeSheet(workbook, table, body);
  } finally {
    body.off('close', release);
    await spill.dispose();
  }
}

/** Renders the header row of column labels, then every row, into one worksheet streamed as the body is consumed. */
export function renderXlsx({ job, table }: ExportWriterInput): ExportRendering {
  const body = new PassThrough();
  // Dated like the PDF, at the job's start, so exceljs never stamps the workbook from the clock.
  writeWorkbook(job.started_at ?? job.created, table, body).catch(failWith(body));
  return { body, fileName: `export-${job.job_id}.xlsx`, contentType: CONTENT_TYPE };
}
