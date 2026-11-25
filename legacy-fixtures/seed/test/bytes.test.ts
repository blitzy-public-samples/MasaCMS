// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pdfBytes, pngBytes, sha256Hex, toBase64 } from '../src/bytes.js';
import { createRandom } from '../src/random.js';

interface PngChunk {
  type: string;
  data: Buffer;
}

/** Splits a PNG after its signature into chunks, checking each CRC. */
function pngChunks(png: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('ascii');
    const data = png.subarray(at + 8, at + 8 + length);
    expect(png.readUInt32BE(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
    chunks.push({ type, data });
    at += 12 + length;
  }
  return chunks;
}

describe('hash and text helpers', () => {
  it('hashes buffers and UTF-8 strings as lowercase hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(Buffer.from('Zoë', 'utf8'))).toBe(sha256Hex('Zoë'));
    expect(sha256Hex(Buffer.from([0xff]))).toBe(createHash('sha256').update(Buffer.from([0xff])).digest('hex'));
  });

  it('renders standard base64', () => {
    expect(toBase64(Buffer.from([0xfb, 0xff]))).toBe('+/8=');
  });
});

describe('pngBytes', () => {
  it('writes the signature, IHDR, IDAT and IEND of an 8x8 truecolour image by default', () => {
    const png = pngBytes(createRandom('png'));
    expect(png.subarray(0, 8).toString('hex').toUpperCase()).toBe('89504E470D0A1A0A');
    const chunks = pngChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const header = chunks[0]?.data ?? Buffer.alloc(0);
    expect([header.readUInt32BE(0), header.readUInt32BE(4)]).toEqual([8, 8]);
    expect([...header.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
    expect(chunks[2]?.data.length).toBe(0);
  });

  it.each([
    [{}, 8, 8],
    [{ width: 3 }, 3, 8],
    [{ width: 5, height: 2 }, 5, 2],
    [{ width: 1, height: 1 }, 1, 1],
  ])('scanlines of %j are %ix%i, filter 0 and the drawn pixel bytes', (opts, width, height) => {
    const png = pngBytes(createRandom('dims'), opts);
    const chunks = pngChunks(png);
    const header = chunks[0]?.data ?? Buffer.alloc(0);
    expect([header.readUInt32BE(0), header.readUInt32BE(4)]).toEqual([width, height]);
    const raw = inflateSync(chunks[1]?.data ?? Buffer.alloc(0));
    expect(raw.length).toBe((width * 3 + 1) * height);
    const pixels = createRandom('dims').bytes(width * 3 * height);
    for (let y = 0; y < height; y += 1) {
      const line = raw.subarray(y * (width * 3 + 1), (y + 1) * (width * 3 + 1));
      expect(line[0]).toBe(0);
      expect(line.subarray(1).equals(pixels.subarray(y * width * 3, (y + 1) * width * 3))).toBe(true);
    }
  });

  it('repeats for an equal seed and differs between seeds', () => {
    const first = pngBytes(createRandom(20260601));
    expect(pngBytes(createRandom(20260601)).equals(first)).toBe(true);
    const hashes = new Set(Array.from({ length: 20 }, (_, i) => sha256Hex(pngBytes(createRandom(`file-${i}`)))));
    expect(hashes.size).toBe(20);
  });

  it.each([{ width: 0 }, { height: -1 }, { width: 1.5 }, { height: Number.NaN }])('rejects %j', (opts) => {
    expect(() => pngBytes(createRandom(1), opts)).toThrow(RangeError);
  });
});

describe('pdfBytes', () => {
  it('lays out a PDF 1.4 whose xref offsets point at each object', () => {
    const pdf = pdfBytes('T', ['a']).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF$/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 9)).toBe('xref\n0 6\n');
    const entries = pdf.slice(startxref + 9, pdf.indexOf('trailer')).match(/.{20}/gs) ?? [];
    expect(entries).toHaveLength(6);
    expect(entries[0]).toBe('0000000000 65535 f \n');
    entries.slice(1).forEach((entry, i) => {
      expect(entry).toMatch(/^\d{10} 00000 n \n$/);
      const offset = Number(entry.slice(0, 10));
      expect(pdf.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(pdf).toContain('trailer\n<< /Size 6 /Root 1 0 R >>');
    expect(pdf).toContain('/MediaBox [0 0 612 792]');
    expect(pdf).toContain('/BaseFont /Helvetica');
    expect(pdf).not.toMatch(/CreationDate|\/ID/);
  });

  it('declares the exact content stream length and escapes backslashes and parentheses', () => {
    const pdf = pdfBytes('Report (Q2)', ['a\\b', 'c)d(', "it's `ok`"]).toString('latin1');
    const match = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(pdf);
    expect(Number(match?.[1])).toBe(match?.[2]?.length);
    expect(match?.[2]).toBe(
      ['BT', '/F1 18 Tf', '72 720 Td', '(Report \\(Q2\\)) Tj', '/F1 12 Tf', '0 -28 Td', '(a\\\\b) Tj', '0 -16 Td', '(c\\)d\\() Tj', '0 -16 Td', "(it's `ok`) Tj", 'ET'].join('\n'),
    );
  });

  it('is identical for equal input and draws only the title when there are no lines', () => {
    expect(pdfBytes('Title', ['x', 'y']).equals(pdfBytes('Title', ['x', 'y']))).toBe(true);
    expect(pdfBytes('Only', []).toString('latin1')).toContain('(Only) Tj\n/F1 12 Tf\nET');
  });

  it.each([['Zoë'], ['tab\there'], ['line\nbreak']])('rejects non-printable-ASCII text %j', (text) => {
    expect(() => pdfBytes(text, [])).toThrow(RangeError);
    expect(() => pdfBytes('ok', [text])).toThrow(RangeError);
  });
});
