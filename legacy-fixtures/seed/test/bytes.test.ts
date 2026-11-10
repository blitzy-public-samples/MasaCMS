// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { csvBytes, pdfBytes, pngBytes, sha256Hex, toBase64, toHex, xlsxBytes } from '../src/bytes.js';
import { createRandom } from '../src/random.js';

const MODIFIED_AT = '2026-06-30T13:45:58.120';

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

interface ZipEntry {
  name: string;
  method: number;
  time: number;
  date: number;
  data: Buffer;
}

/** Reads every entry through the end-of-central-directory record and the central directory. */
function readZip(zip: Buffer): ZipEntry[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  const entries: ZipEntry[] = [];
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    expect(crc32(data)).toBe(zip.readUInt32LE(at + 16));
    entries.push({
      name: zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      method: zip.readUInt16LE(at + 10),
      time: zip.readUInt16LE(at + 12),
      date: zip.readUInt16LE(at + 14),
      data,
    });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  expect(at).toBe(end);
  return entries;
}

describe('hash and text helpers', () => {
  it('hashes buffers and UTF-8 strings as lowercase hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(Buffer.from('Zoë', 'utf8'))).toBe(sha256Hex('Zoë'));
    expect(sha256Hex(Buffer.from([0xff]))).toBe(createHash('sha256').update(Buffer.from([0xff])).digest('hex'));
  });

  it('renders lowercase hex without a prefix and standard base64', () => {
    expect(toHex(Buffer.from([0x00, 0xab, 0xcd, 0xef]))).toBe('00abcdef');
    expect(toHex(Buffer.alloc(0))).toBe('');
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

describe('csvBytes', () => {
  it('quotes only fields holding quotes, commas or line breaks and ends every record with CRLF', () => {
    const csv = csvBytes([
      ['id', 'name', 'amount'],
      ['A-1', 'Smith, Jo', 12.5],
      ['A-2', 'say "hi"', null],
      ['A-3', 'two\nlines', -3],
      ['A-4', 'cr\rhere', 0],
      [' padded ', '', 1e21],
    ]).toString('utf8');
    expect(csv).toBe(
      'id,name,amount\r\nA-1,"Smith, Jo",12.5\r\nA-2,"say ""hi""",\r\nA-3,"two\nlines",-3\r\nA-4,"cr\rhere",0\r\n padded ,,1e+21\r\n',
    );
  });

  it('encodes UTF-8 without a byte-order mark and yields nothing for no rows', () => {
    const csv = csvBytes([['Zoë']]);
    expect([...csv.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.equals(Buffer.from('Zoë\r\n', 'utf8'))).toBe(true);
    expect(csvBytes([]).length).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects the number %d', (value) => {
    expect(() => csvBytes([[value]])).toThrow(RangeError);
  });
});

describe('xlsxBytes', () => {
  it('stores the five workbook parts in a fixed order with CRCs and the DOS stamp of modifiedAt', () => {
    const entries = readZip(xlsxBytes([['a', 1]], { modifiedAt: MODIFIED_AT }));
    expect(entries.map((e) => e.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
    ]);
    for (const entry of entries) {
      expect(entry.method).toBe(0);
      expect(entry.date).toBe(((2026 - 1980) << 9) | (6 << 5) | 30);
      expect(entry.time).toBe((13 << 11) | (45 << 5) | 29);
      expect(entry.data.toString('utf8').startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true);
    }
    expect(entries[4]?.data.toString('utf8')).toContain(
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">a</t></is></c><c r="B1"><v>1</v></c></row></sheetData>',
    );
  });

  it('escapes markup, keeps carriage returns, skips empty cells and names columns past Z', () => {
    const wide = Array.from({ length: 28 }, (_, i) => i);
    const sheet = readZip(
      xlsxBytes(
        [
          ['<a & b>', null, '', 'x\r\ny'],
          wide,
        ],
        { modifiedAt: MODIFIED_AT },
      ),
    )[4]?.data.toString('utf8');
    expect(sheet).toContain('<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">&lt;a &amp; b&gt;</t></is></c>');
    expect(sheet).toContain('<c r="D1" t="inlineStr"><is><t xml:space="preserve">x&#13;\ny</t></is></c></row>');
    expect(sheet).not.toContain('r="B1"');
    expect(sheet).not.toContain('r="C1"');
    expect(sheet).toContain('<c r="Z2"><v>25</v></c><c r="AA2"><v>26</v></c><c r="AB2"><v>27</v></c></row>');
  });

  it('is byte-identical for equal input and changes only with its rows or stamp', () => {
    const first = xlsxBytes([['h'], [2]], { modifiedAt: MODIFIED_AT });
    expect(xlsxBytes([['h'], [2]], { modifiedAt: MODIFIED_AT }).equals(first)).toBe(true);
    expect(xlsxBytes([['h'], [3]], { modifiedAt: MODIFIED_AT }).equals(first)).toBe(false);
    expect(xlsxBytes([['h'], [2]], { modifiedAt: '2026-06-30T13:46:00.000' }).equals(first)).toBe(false);
    expect(readZip(xlsxBytes([], { modifiedAt: '1980-01-01T00:00:00.000' }))[4]?.data.toString('utf8')).toContain('<sheetData></sheetData>');
  });

  it.each([
    ['2026-06-30 13:45:58.120'],
    ['2026-06-30T13:45:58'],
    ['2026-02-30T00:00:00.000'],
    ['2026-06-30T24:00:00.000'],
    ['1979-12-31T23:59:59.990'],
    ['2108-01-01T00:00:00.000'],
  ])('rejects modifiedAt %j', (modifiedAt) => {
    expect(() => xlsxBytes([['a']], { modifiedAt })).toThrow(RangeError);
  });

  it.each([[['bell\u0007']], [[Number.NaN]]])('rejects the cell %j', (row) => {
    expect(() => xlsxBytes([row], { modifiedAt: MODIFIED_AT })).toThrow(RangeError);
  });
});
