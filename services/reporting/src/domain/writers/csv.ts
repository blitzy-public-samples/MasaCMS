// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** CSV export writer: the fixture's RFC 4180 text, UTF-8 without a BOM. */
import { stringify, type Options } from 'csv-stringify/sync';
import type { ExportRendering, ExportWriterInput } from './index.js';

const CONTENT_TYPE = 'text/csv';

// The fixture quotes a field holding `"`, `,`, CR or LF and ends every line, the last included, with CRLF.
const CSV_OPTIONS: Options = { record_delimiter: '\r\n', quoted_match: /[\r\n]/, eof: true };

/** Renders the header row of column labels, then every row, as CSV. */
export async function renderCsv({ job, table }: ExportWriterInput): Promise<ExportRendering> {
  const text = stringify([table.columns.map((column) => column.label), ...table.rows], CSV_OPTIONS);
  return { bytes: Buffer.from(text, 'utf8'), fileName: `export-${job.job_id}.csv`, contentType: CONTENT_TYPE };
}
