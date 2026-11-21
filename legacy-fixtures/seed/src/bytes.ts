// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { crc32, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { SeedRandom } from './random.js';

/** One table cell; `null` is an empty cell. */
export type TableCell = string | number | null;

/** Rows of table cells, first row first. */
export type TableRows = readonly (readonly TableCell[])[];

/** Lowercase hex SHA-256 of `buf`; strings are hashed as UTF-8. */
export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Lowercase hex of `buf`, without a `0x` prefix. */
export function toHex(buf: Buffer): string {
  return buf.toString('hex');
}

/** Standard base64 of `buf`. */
export function toBase64(buf: Buffer): string {
  return buf.toString('base64');
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** Truecolour 8-bit PNG (default 8x8) whose pixels are drawn from `rng`, so equal streams yield equal bytes. */
export function pngBytes(rng: SeedRandom, opts: { width?: number; height?: number } = {}): Buffer {
  const { width = 8, height = 8 } = opts;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError(`pngBytes: width and height must be positive integers, got ${width}x${height}`);
  }
  const rowBytes = width * 3;
  const pixels = rng.bytes(rowBytes * height);
  const scanlines = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    pixels.copy(scanlines, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function pdfString(text: string): string {
  if (!PRINTABLE_ASCII.test(text)) {
    throw new RangeError(`pdfBytes: text must be printable ASCII, got ${JSON.stringify(text)}`);
  }
  return `(${text.replace(/[\\()]/g, (ch) => `\\${ch}`)})`;
}

/** Single-page Letter PDF 1.4 showing `title` in 18 pt and each of `lines` in 12 pt Helvetica; printable ASCII only. */
export function pdfBytes(title: string, lines: readonly string[]): Buffer {
  const ops = ['BT', '/F1 18 Tf', '72 720 Td', `${pdfString(title)} Tj`, '/F1 12 Tf'];
  lines.forEach((line, i) => ops.push(`0 ${i === 0 ? -28 : -16} Td`, `${pdfString(line)} Tj`));
  ops.push('ET');
  const content = ops.join('\n');
  // WinAnsiEncoding keeps ' and ` as typed; Helvetica's built-in StandardEncoding extracts them as curly quotes.
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

function numberText(fn: string, value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`${fn}: numeric cells must be finite, got ${value}`);
  return String(value);
}

function csvField(value: TableCell): string {
  if (value === null) return '';
  if (typeof value === 'number') return numberText('csvBytes', value);
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180 CSV of `rows` in UTF-8 without BOM, every record ending in CRLF; `null` cells are empty fields. */
export function csvBytes(rows: TableRows): Buffer {
  return Buffer.from(rows.map((row) => `${row.map(csvField).join(',')}\r\n`).join(''), 'utf8');
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_DOC_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;
const MODIFIED_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}$/;

function xmlText(value: string): string {
  if (XML_FORBIDDEN.test(value)) {
    throw new RangeError(`xlsxBytes: string cells must hold only XML characters, got ${JSON.stringify(value)}`);
  }
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function sheetCell(value: TableCell, ref: string): string {
  // exceljs reads an empty inline string back as a merge placeholder, so '' is written as an empty cell, like null.
  if (value === null || value === '') return '';
  if (typeof value === 'number') return `<c r="${ref}"><v>${numberText('xlsxBytes', value)}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function dosDateTime(modifiedAt: string): { date: number; time: number } {
  const fields = (MODIFIED_AT.exec(modifiedAt) ?? []).slice(1).map(Number);
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = fields;
  // A rolled-over Date.UTC (Feb 30, hour 24) no longer renders as the input, so this also rejects impossible values.
  const exact = year >= 1980 && year <= 2107 && new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString().slice(0, 19) === modifiedAt.slice(0, 19);
  if (!exact) {
    throw new RangeError(`xlsxBytes: modifiedAt must be a yyyy-MM-ddTHH:mm:ss.SSS timestamp in years 1980..2107, got ${JSON.stringify(modifiedAt)}`);
  }
  return { date: ((year - 1980) << 9) | (month << 5) | day, time: (hour << 11) | (minute << 5) | (second >> 1) };
}

function storedZip(entries: readonly (readonly [string, string])[], modifiedAt: string): Buffer {
  const { date, time } = dosDateTime(modifiedAt);
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}

/** Single-sheet XLSX of `rows` as an uncompressed ZIP stamped with `opts.modifiedAt`; `null` and empty-string cells are left empty. */
export function xlsxBytes(rows: TableRows, opts: { modifiedAt: string }): Buffer {
  const sheetRows = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((value, c) => sheetCell(value, `${columnName(c)}${r + 1}`)).join('')}</row>`)
    .join('');
  return storedZip(
    [
      [
        '[Content_Types].xml',
        `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      ],
      [
        '_rels/.rels',
        `${XML_DECLARATION}<Relationships xmlns="${NS_PACKAGE_RELS}">` +
          `<Relationship Id="rId1" Type="${NS_DOC_RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ],
      [
        'xl/workbook.xml',
        `${XML_DECLARATION}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_DOC_RELS}">` +
          '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ],
      [
        'xl/_rels/workbook.xml.rels',
        `${XML_DECLARATION}<Relationships xmlns="${NS_PACKAGE_RELS}">` +
          `<Relationship Id="rId1" Type="${NS_DOC_RELS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ],
      ['xl/worksheets/sheet1.xml', `${XML_DECLARATION}<worksheet xmlns="${NS_MAIN}"><sheetData>${sheetRows}</sheetData></worksheet>`],
    ],
    opts.modifiedAt,
  );
}
