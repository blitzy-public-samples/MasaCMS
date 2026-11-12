// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export writers: the shared writer types and the dispatch from a job's format to its writer. */
import type { Readable } from 'node:stream';
import type { ExportTableStream } from '../sources.js';
import type { ExportDefinitionRow, ExportFormat, ExportJobRow } from '../../repo/tables.js';
import { renderCsv } from './csv.js';
import { renderPdf } from './pdf.js';
import { renderXlsx } from './xlsx.js';

/** What every writer renders: the job, its definition and the opened table, whose rows a writer reads once. */
export interface ExportWriterInput {
  definition: ExportDefinitionRow;
  table: ExportTableStream;
  job: ExportJobRow;
}

/** A rendered export: its byte stream, destroyed with a row read's error, and the file name and content type stored with the job. */
export interface ExportRendering {
  body: Readable;
  fileName: string;
  contentType: string;
}

const EXTENSIONS: Readonly<Record<ExportFormat, 'xlsx' | 'csv' | 'pdf'>> = { xlsx: 'xlsx', csv: 'csv', pdf: 'pdf' };

// Async so an unsupported format surfaces as a rejection, as a failing writer does, never as a synchronous throw.
/** Renders an export table in the job's format. */
export async function renderExport(format: ExportFormat, input: ExportWriterInput): Promise<ExportRendering> {
  switch (format) {
    case 'xlsx':
      return renderXlsx(input);
    case 'csv':
      return renderCsv(input);
    case 'pdf':
      return renderPdf(input);
    default: {
      const unreachable: never = format;
      throw new Error(`unsupported export format: ${String(unreachable)}`);
    }
  }
}

/** File extension of the export object stored for `format`. */
export function extensionFor(format: ExportFormat): 'xlsx' | 'csv' | 'pdf' {
  return EXTENSIONS[format];
}

export { renderCsv, renderPdf, renderXlsx };
