// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { crc32, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { SeedRandom } from './random.js';

/** Lowercase hex SHA-256 of `buf`; strings are hashed as UTF-8. */
export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
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
