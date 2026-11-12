import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { cfUuid, isCfUuid } from '@opt2/platform/legacy-compat';
import { sha256Hex } from '@opt2/platform/migration-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  csvModel,
  exportKindFor,
  exportModel,
  fileModel,
  pdfModel,
  xlsxModel,
  type CsvModel,
  type ExportKind,
  type XlsxModel,
} from '../../../src/golden/normalise/exports.js';
import { createIdOrdinals } from '../../../src/golden/normalise/ids.js';
import { loadRules, type NormaliseRules } from '../../../src/golden/normalise/rules.js';
import { normaliseTimestamp } from '../../../src/golden/normalise/values.js';
import type { BodyRepresentation, RecordedResponse } from '../../../src/golden/steps.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/exports/${name}`, import.meta.url));

const USERS_CSV_SHA256 = 'cca9eec959ce8ce6e8542495acd16cb4115994885bcc251537b6c1b913b3b23f';
const TINY_PDF_SHA256 = 'bb7ad3f693a1c54b3f72e48e9c3b1165b314778e28504ed2e94c15852c5a5964';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TIMESTAMP_COLUMNS = ['CREATED', 'LASTUPDATE', 'LASTLOGIN', 'PASSWORDCREATED'] as const;
const JDBC_TIMESTAMP = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d+)/g;
const SHIFT_MS = 3 * 86_400_000 + 7 * 60_000;
const CF_UUID_ANYWHERE = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}/i;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48]);
const DETAIL_ID = 'C0FFEE00-1111-4C22-9D3333333333E444';
const DETAIL_CREATED = new Date(Date.UTC(2026, 5, 30, 9, 12, 45));

let rules: NormaliseRules;
let usersCsv: string;
let usersCsvBytes: Buffer;
let tinyPdf: Buffer;

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
  usersCsvBytes = readFileSync(fixture('users.csv'));
  usersCsv = usersCsvBytes.toString('utf8');
  tinyPdf = readFileSync(fixture('tiny.pdf'));
});

function columnIndex(model: CsvModel, name: string): number {
  const index = model.rows[0]?.indexOf(name) ?? -1;
  expect(index, `column ${name}`).toBeGreaterThanOrEqual(0);
  return index;
}

function column(model: CsvModel, name: string): string[] {
  const index = columnIndex(model, name);
  return model.rows.slice(1).map((row) => row[index] ?? '');
}

// Every CF UUID swapped for a fresh one (consistently) and every timestamp moved, its format kept.
function replayCopy(text: string): string {
  const remapped = new Map<string, string>();
  const withIds = text.replace(new RegExp(CF_UUID_ANYWHERE.source, 'gi'), (id) => {
    const key = id.toUpperCase();
    const next = remapped.get(key) ?? cfUuid();
    remapped.set(key, next);
    return next;
  });
  return withIds.replace(JDBC_TIMESTAMP, (_match, ...parts: string[]) => {
    const [y, mo, d, h, mi, s, fraction] = parts.map(String);
    const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    const shifted = new Date(at + SHIFT_MS);
    return `${shifted.toISOString().slice(0, 19).replace('T', ' ')}.${fraction}`;
  });
}

interface WorkbookProps {
  creator: string;
  lastModifiedBy: string;
  created: Date;
  modified: Date;
}

const PROPS_A: WorkbookProps = {
  creator: 'Masa CMS',
  lastModifiedBy: 'admin',
  created: new Date(Date.UTC(2026, 5, 1, 8, 0, 0)),
  modified: new Date(Date.UTC(2026, 5, 2, 8, 0, 0)),
};

const PROPS_B: WorkbookProps = {
  creator: 'opt2-reporting',
  lastModifiedBy: 'reporting-export-run',
  created: new Date(Date.UTC(2026, 6, 15, 17, 30, 0)),
  modified: new Date(Date.UTC(2026, 6, 16, 17, 30, 0)),
};

/** XLSX bytes of the two-sheet export workbook under `props`; `detailName` sets the Detail data row's NAME cell. */
async function workbookBytes(props: WorkbookProps, detailName = 'Ines Arkin'): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  Object.assign(workbook, props);
  const summary = workbook.addWorksheet('Summary');
  summary.addRow(['Metric', 'Value']);
  summary.addRow(['Users', 4]);
  summary.addRow(['Pass rate', 0.95]);
  summary.addRow(['Active', true]);
  const detail = workbook.addWorksheet('Detail');
  detail.addRow(['USERID', 'NAME', 'CREATED', 'AMOUNT', 'NOTE']);
  detail.addRow([DETAIL_ID, detailName, DETAIL_CREATED, '1234.5000', '']);
  detail.addRow([
    { richText: [{ text: 'Bold ' }, { font: { bold: true }, text: 'part' }] },
    null,
    { formula: 'B2&"!"', result: 'computed' },
    { text: 'Report link', hyperlink: 'https://example.test/report' },
    { error: '#N/A' },
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('csvModel', () => {
  it('reads the users download as a 36-column grid with its header row', () => {
    const model = csvModel(usersCsv, createIdOrdinals(), rules);

    expect(model.kind).toBe('csv');
    expect(model.rows).toHaveLength(5);
    for (const row of model.rows) expect(row).toHaveLength(36);
    expect(model.rows[0]?.[0]).toBe('COMPANY');
    expect(model.rows[0]?.at(-1)).toBe('WEBSITE');
  });

  it('keeps embedded commas and the appended trailing spaces of each cell', () => {
    const model = csvModel(usersCsv, createIdOrdinals(), rules);
    const cells = model.rows.flat();

    expect(column(model, 'NOTES')[0]).toBe('Prefers mail, then phone ');
    expect(column(model, 'COMPANY')[2]).toBe('Okafor Analytics, Ltd ');
    expect(column(model, 'TAGS')[3]).toBe('alpha,ops ');
    expect(column(model, 'JOBTITLE')[0]).toBe('Editor  ');
    expect(column(model, 'LASTLOGIN')[1]).toBe(' ');
    expect(cells.some((cell) => cell.includes('**comma**'))).toBe(false);
  });

  it('replaces ids by first-sight ordinals and timestamps by their class placeholder', () => {
    const model = csvModel(usersCsv, createIdOrdinals(), rules);
    const jdbc = `${normaliseTimestamp('2026-05-04 10:00:00.0', rules)} `;

    expect(jdbc).toMatch(/^<ts:[a-z0-9-]+> $/);
    expect(column(model, 'USERID')).toStrictEqual(['<id:2> ', '<id:3> ', '<id:4> ', '<id:5> ']);
    expect(column(model, 'LASTUPDATEBYID')).toStrictEqual(Array<string>(4).fill('<id:1> '));
    for (const name of TIMESTAMP_COLUMNS) {
      for (const cell of column(model, name)) expect([jdbc, ' ']).toContain(cell);
    }
    for (const cell of model.rows.flat()) {
      expect(cell).not.toMatch(CF_UUID_ANYWHERE);
      expect(cell).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    }
  });

  it('matches a replay that differs only in ids and timestamps, and not one with a changed cell', () => {
    const replay = replayCopy(usersCsv);
    const capture = csvModel(usersCsv, createIdOrdinals(), rules);

    expect(replay).not.toBe(usersCsv);
    expect(csvModel(replay, createIdOrdinals(), rules)).toStrictEqual(capture);
    const edited = replay.replace('"Northwind Studio "', '"Northwind Studios "');
    expect(csvModel(edited, createIdOrdinals(), rules)).not.toStrictEqual(capture);
  });

  it('ignores a byte-order mark and keeps date-only columns literal', () => {
    const text = '\uFEFF"asOf","DUE_DATE","shippedOn"\n"2026-06-30","2026-07-01","2026-07-02"\n';

    expect(csvModel(text, createIdOrdinals(), rules).rows).toStrictEqual([
      ['asOf', 'DUE_DATE', 'shippedOn'],
      ['2026-06-30', '2026-07-01', normaliseTimestamp('2026-07-02', rules)],
    ]);
  });
});

describe('xlsxModel', () => {
  it('compares cell values per sheet, never workbook metadata or bytes', async () => {
    const a = await workbookBytes(PROPS_A);
    const b = await workbookBytes(PROPS_B);

    expect(Buffer.compare(a, b)).not.toBe(0);
    const modelA = await xlsxModel(a, createIdOrdinals(), rules);
    expect(await xlsxModel(b, createIdOrdinals(), rules)).toStrictEqual(modelA);
    expect(modelA.sheets.map((sheet) => sheet.name)).toStrictEqual(['Summary', 'Detail']);
  });

  it('reads each cell kind as its displayed value, ids and dates normalised', async () => {
    const model: XlsxModel = await xlsxModel(await workbookBytes(PROPS_A), createIdOrdinals(), rules);

    expect(model).toStrictEqual({
      kind: 'xlsx',
      sheets: [
        {
          name: 'Summary',
          rows: [
            ['Metric', 'Value'],
            ['Users', 4],
            ['Pass rate', 0.95],
            ['Active', true],
          ],
        },
        {
          name: 'Detail',
          rows: [
            ['USERID', 'NAME', 'CREATED', 'AMOUNT', 'NOTE'],
            ['<id:1>', 'Ines Arkin', normaliseTimestamp('2026-06-30T09:12:45', rules, 'CREATED'), '1234.5000'],
            ['Bold part', null, 'computed', 'Report link', '#N/A'],
          ],
        },
      ],
    });
    expect(isCfUuid(DETAIL_ID)).toBe(true);
  });

  it('tells workbooks apart when one cell value differs', async () => {
    const a = await xlsxModel(await workbookBytes(PROPS_A), createIdOrdinals(), rules);
    const b = await xlsxModel(await workbookBytes(PROPS_B, 'Theo Brandt'), createIdOrdinals(), rules);

    expect(b).not.toStrictEqual(a);
  });
});

describe('pdfModel', () => {
  interface PdfInfo {
    Producer: string;
    Creator: string;
    CreationDate: string;
    ModDate: string;
    Title: string;
  }

  const pdfString = (text: string): string => `(${text.replace(/[\\()]/g, '\\$&')})`;

  /**
   * PDF 1.4 in tiny.pdf's layout: catalog, page tree, a page and content stream per text, Helvetica, optional /Info.
   * `order` lists the page tree's kids as indexes into `texts`; by default the pages follow `texts`.
   */
  function pdfBytes(texts: readonly string[], options: { info?: PdfInfo; order?: readonly number[] } = {}): Buffer {
    const fontObject = 3 + 2 * texts.length;
    const kids = (options.order ?? texts.map((_text, i) => i)).map((i) => `${3 + 2 * i} 0 R`);
    const bodies = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`,
      ...texts.flatMap((text, i) => {
        const stream = `BT /F1 12 Tf 72 720 Td ${pdfString(text)} Tj ET`;
        return [
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> ` +
            `/Contents ${4 + 2 * i} 0 R >>`,
          `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
        ];
      }),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    if (options.info !== undefined) {
      const entries = Object.entries(options.info).map(([key, value]) => `/${key} ${pdfString(value)}`);
      bodies.push(`<< ${entries.join(' ')} >>`);
    }
    let pdf = '%PDF-1.4\n';
    const offsets = bodies.map((body, i) => {
      const offset = pdf.length;
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
      return offset;
    });
    const xref = pdf.length;
    const info = options.info === undefined ? '' : ` /Info ${bodies.length} 0 R`;
    pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R${info} >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
  }

  const REPORT_PAGES = ['Registrations report', 'Ines Arkin 1234.5000', 'Total registrations 4'];
  const INFO_A: PdfInfo = {
    Producer: 'Adobe ColdFusion cfdocument',
    Creator: 'Masa CMS',
    CreationDate: 'D:20260601080000Z',
    ModDate: 'D:20260602080000Z',
    Title: 'Registrations',
  };
  const INFO_B: PdfInfo = {
    Producer: 'PDFKit',
    Creator: 'opt2-reporting',
    CreationDate: 'D:20260715173000Z',
    ModDate: 'D:20260716173000Z',
    Title: 'Registrations',
  };

  it('reads the text of each page', async () => {
    expect(await pdfModel(tinyPdf, createIdOrdinals(), rules)).toStrictEqual({
      kind: 'pdf',
      pages: ['Fixture report page 1'],
    });
  });

  it('builds tiny.pdf byte for byte from its page text', () => {
    expect(pdfBytes(['Fixture report page 1']).equals(tinyPdf)).toBe(true);
  });

  it('reads every page of a multi-page document in order', async () => {
    expect(await pdfModel(pdfBytes(REPORT_PAGES), createIdOrdinals(), rules)).toStrictEqual({
      kind: 'pdf',
      pages: ['Registrations report', 'Ines Arkin 1234.5000', 'Total registrations 4'],
    });
  });

  it.each<{ name: string; texts: string[]; order?: number[]; pages: string[]; differing: number[] }>([
    {
      name: 'changed text on page 3',
      texts: ['Registrations report', 'Ines Arkin 1234.5000', 'Total registrations 5'],
      pages: ['Registrations report', 'Ines Arkin 1234.5000', 'Total registrations 5'],
      differing: [2],
    },
    {
      name: 'pages 2 and 3 swapped in the page tree',
      texts: ['Registrations report', 'Ines Arkin 1234.5000', 'Total registrations 4'],
      order: [0, 2, 1],
      pages: ['Registrations report', 'Total registrations 4', 'Ines Arkin 1234.5000'],
      differing: [1, 2],
    },
  ])('keeps $name as a difference through exportModel', async ({ texts, order, pages, differing }) => {
    const capture = await pdfModel(pdfBytes(REPORT_PAGES), createIdOrdinals(), rules);
    const bytes = pdfBytes(texts, { order });
    const response = recorded('application/pdf', { bytesBase64: bytes.toString('base64') }, sha256Hex(bytes));
    const replay = await exportModel(response, createIdOrdinals(), rules);

    expect(replay).toStrictEqual({ kind: 'pdf', pages });
    expect(replay).not.toStrictEqual(capture);
    expect(pages.flatMap((text, i) => (text === capture.pages[i] ? [] : [i]))).toStrictEqual(differing);
  });

  it('compares extracted text, never document metadata or bytes', async () => {
    const a = pdfBytes(REPORT_PAGES, { info: INFO_A });
    const b = pdfBytes(REPORT_PAGES, { info: INFO_B });

    expect(fileModel({ bytes: b, contentType: 'application/pdf' }).sha256).not.toBe(
      fileModel({ bytes: a, contentType: 'application/pdf' }).sha256,
    );
    const modelA = await pdfModel(a, createIdOrdinals(), rules);
    expect(modelA).toStrictEqual({
      kind: 'pdf',
      pages: ['Registrations report', 'Ines Arkin 1234.5000', 'Total registrations 4'],
    });
    expect(await pdfModel(b, createIdOrdinals(), rules)).toStrictEqual(modelA);
  });
});

describe('fileModel', () => {
  it('hashes the body bytes and keeps the content type', () => {
    expect(fileModel({ bytes: tinyPdf, contentType: 'application/pdf' })).toStrictEqual({
      kind: 'file',
      sha256: TINY_PDF_SHA256,
      contentType: 'application/pdf',
    });
    expect(fileModel({ bytes: usersCsvBytes, contentType: 'text/csv' })).toStrictEqual({
      kind: 'file',
      sha256: USERS_CSV_SHA256,
      contentType: 'text/csv',
    });
  });

  it('passes a recorded digest through in preference to the bytes', () => {
    const recorded = sha256Hex('recorded body');

    expect(fileModel({ sha256: recorded, contentType: 'image/png; name=x' })).toStrictEqual({
      kind: 'file',
      sha256: recorded,
      contentType: 'image/png; name=x',
    });
    expect(fileModel({ sha256: recorded, bytes: PNG_BYTES, contentType: 'image/png' }).sha256).toBe(recorded);
  });
});

describe('exportKindFor', () => {
  it.each<[string, ExportKind]>([
    ['text/csv', 'csv'],
    ['text/csv; charset=utf-8', 'csv'],
    ['Text/CSV;charset=UTF-8', 'csv'],
    [XLSX_TYPE, 'xlsx'],
    ['application/pdf', 'pdf'],
    ['application/octet-stream', 'file'],
    ['image/png', 'file'],
    ['application/zip', 'file'],
    ['', 'file'],
  ])('compares %j as %s', (contentType, kind) => {
    expect(exportKindFor(contentType)).toBe(kind);
  });
});

function recorded(contentType: string, body: BodyRepresentation, sha256: string): RecordedResponse {
  return { status: 200, headers: { 'content-type': contentType }, contentType, sha256, hops: [], ...body };
}

describe('exportModel', () => {
  it('builds the model its content type selects, equal to the direct call', async () => {
    const workbook = await workbookBytes(PROPS_A);
    const csv = recorded('text/csv; charset=utf-8', { text: usersCsv }, USERS_CSV_SHA256);
    const xlsx = recorded(XLSX_TYPE, { bytesBase64: workbook.toString('base64') }, sha256Hex(workbook));
    const pdf = recorded('application/pdf', { bytesBase64: tinyPdf.toString('base64') }, TINY_PDF_SHA256);
    const png = recorded('image/png', { bytesBase64: PNG_BYTES.toString('base64') }, sha256Hex(PNG_BYTES));

    expect(await exportModel(csv, createIdOrdinals(), rules)).toStrictEqual(
      csvModel(usersCsv, createIdOrdinals(), rules),
    );
    expect(await exportModel(xlsx, createIdOrdinals(), rules)).toStrictEqual(
      await xlsxModel(workbook, createIdOrdinals(), rules),
    );
    expect(await exportModel(pdf, createIdOrdinals(), rules)).toStrictEqual(
      await pdfModel(tinyPdf, createIdOrdinals(), rules),
    );
    expect(await exportModel(png, createIdOrdinals(), rules)).toStrictEqual(
      fileModel({ bytes: PNG_BYTES, contentType: 'image/png' }),
    );
    const headerless = { contentType: 'application/zip', sha256: sha256Hex(PNG_BYTES) };
    expect(await exportModel(headerless, createIdOrdinals(), rules)).toStrictEqual(fileModel(headerless));
  });

  it('decodes a CSV body recorded as bytes', async () => {
    const csv = recorded('text/csv', { bytesBase64: usersCsvBytes.toString('base64') }, USERS_CSV_SHA256);

    expect(await exportModel(csv, createIdOrdinals(), rules)).toStrictEqual(
      csvModel(usersCsv, createIdOrdinals(), rules),
    );
  });

  it.each<[string | string[], string]>([
    [`attachment; filename="${DETAIL_ID}.png"`, '<id:1>.png'],
    ['attachment; filename=report-2026.png', 'report-2026.png'],
    ['inline; filename="say \\"hi\\".png"', 'say "hi".png'],
    [['attachment; filename="first.png"', 'attachment; filename="second.png"'], 'first.png'],
  ])('compares downloads by digest, content type and Content-Disposition %j', async (disposition, filename) => {
    const png = recorded('image/png', { bytesBase64: PNG_BYTES.toString('base64') }, sha256Hex(PNG_BYTES));
    png.headers['content-disposition'] = disposition;

    expect(await exportModel(png, createIdOrdinals(), rules)).toStrictEqual({
      kind: 'file',
      sha256: sha256Hex(PNG_BYTES),
      contentType: 'image/png',
      filename,
    });
  });

  it('follows the export switches of the rules', async () => {
    const switched: NormaliseRules = {
      ...rules,
      exports: {
        ...rules.exports,
        csv: { ...rules.exports.csv, whitespace: 'collapse-and-trim' },
        xlsx: { ...rules.exports.xlsx, sheetNames: 'ignore' },
        file: { compare: ['sha256', 'contentType'] },
      },
    };
    const png = recorded('image/png', { bytesBase64: PNG_BYTES.toString('base64') }, sha256Hex(PNG_BYTES));
    png.headers['content-disposition'] = 'attachment; filename="photo.png"';

    expect(column(csvModel(usersCsv, createIdOrdinals(), switched), 'JOBTITLE')[0]).toBe('Editor');
    const xlsx = await xlsxModel(await workbookBytes(PROPS_A), createIdOrdinals(), switched);
    expect(xlsx.sheets.map((sheet) => sheet.name)).toStrictEqual(['', '']);
    expect(await exportModel(png, createIdOrdinals(), switched)).toStrictEqual(
      fileModel({ bytes: PNG_BYTES, contentType: 'image/png' }),
    );
  });
});
