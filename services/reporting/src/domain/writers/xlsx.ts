// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** XLSX export writer: the fixture's single `export` sheet with every cell stored as a string. */
import ExcelJS from 'exceljs';
import type { ExportRendering, ExportWriterInput } from './index.js';

const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SHEET_NAME = 'export';

// exceljs writes CR raw, which XML reads back as LF, and drops the other control characters; OOXML's _xHHHH_ escape
// keeps them all, and a literal _xHHHH_ keeps its underscore as _x005F_.
const LITERAL_ESCAPE = /_(?=x[0-9A-Fa-f]{4}_)/g;
const XML_UNSAFE = /[\x00-\x08\x0B-\x1F\x7F]/g;

/** `value` as shared-string text that reads back unchanged. */
function cellText(value: string): string {
  return value
    .replace(LITERAL_ESCAPE, '_x005F_')
    .replace(XML_UNSAFE, (char) => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
}

/** Renders the header row of column labels, then every row, into one worksheet. */
export async function renderXlsx({ job, table }: ExportWriterInput): Promise<ExportRendering> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(SHEET_NAME);
  // Every value is a string, so exceljs stores a string cell, never a number or date, as the fixture's "string" cells.
  [table.columns.map((column) => column.label), ...table.rows].forEach((values, r) => {
    values.forEach((value, c) => {
      sheet.getCell(r + 1, c + 1).value = cellText(value);
    });
  });
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  return { bytes, fileName: `export-${job.job_id}.xlsx`, contentType: CONTENT_TYPE };
}
