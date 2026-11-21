// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** CSV export writer: the fixture's RFC 4180 text, UTF-8 without a BOM. */
import { Readable, pipeline } from 'node:stream';
import { stringify, type Options } from 'csv-stringify';
import type { ExportCell, ExportTableStream } from '../sources.js';
import type { ExportRendering, ExportWriterInput } from './index.js';

const CONTENT_TYPE = 'text/csv';

// A set record_delimiter turns off csv-stringify's quoting of bare CR and LF; quoted_match restores it.
const CSV_OPTIONS: Options = { record_delimiter: '\r\n', quoted_match: /[\r\n]/, eof: true };

/** The header row of column labels, then every row of `table`. */
async function* records(table: ExportTableStream): AsyncGenerator<readonly ExportCell[]> {
  yield table.columns.map((column) => column.label);
  yield* table.rows;
}

/** Renders the header row of column labels, then every row, as CSV text that reads each row as the body is consumed. */
export function renderCsv({ job, table }: ExportWriterInput): ExportRendering {
  const body = stringify(CSV_OPTIONS);
  // A failed row read destroys the body with its error, which reaches the body's consumer; a destroyed body stops the rows.
  pipeline(Readable.from(records(table)), body, () => undefined);
  return { body, fileName: `export-${job.job_id}.csv`, contentType: CONTENT_TYPE };
}
