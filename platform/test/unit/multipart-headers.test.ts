import { describe, expect, it } from 'vitest';
import { createMultipartHeaderScanner, fileUploadContentType, type MultipartHeaderScanner } from '../../src/service-kit/multipart-headers.js';

const BOUNDARY = 'opt2boundary';
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

type Part = { headers: readonly string[]; content?: string };

/** A multipart body of `parts`, each its header lines and content, closed by the close delimiter unless `close` is false. */
function body(parts: readonly Part[], { boundary = BOUNDARY, close = true }: { boundary?: string; close?: boolean } = {}): Buffer {
  const sections = parts.map(({ headers, content = 'bytes' }) => `--${boundary}\r\n${headers.map((line) => `${line}\r\n`).join('')}\r\n${content}\r\n`);
  return Buffer.from(`${sections.join('')}${close ? `--${boundary}--\r\n` : ''}`, 'utf8');
}

/** A new scanner for `contentType` fed `data` in chunks of `size` bytes. */
function scan(data: Buffer, size: number, contentType = CONTENT_TYPE): MultipartHeaderScanner {
  const scanner = createMultipartHeaderScanner(contentType);
  if (scanner === undefined) throw new Error(`no scanner for ${contentType}`);
  for (let at = 0; at < data.length; at += size) scanner.push(data.subarray(at, at + size));
  return scanner;
}

/** What `take` answers for each `[field, mimetype]`, in turn. */
function takeAll(scanner: MultipartHeaderScanner, parts: ReadonlyArray<readonly [string, string]>): Array<string | undefined> {
  return parts.map(([field, mimetype]) => scanner.take(field, mimetype));
}

const disposition = (name: string, filename?: string): string =>
  `Content-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}`;

describe('fileUploadContentType', () => {
  // Measured on ColdFusion 2023 with finance.cfc's fileUpload; the last two rows are lines legacy answers with HTTP 500.
  it.each<[string, readonly string[], string]>([
    ['type and parameters', ['Content-Type: Text/Plain; Charset=UTF-8'], 'text/plain; charset=utf-8'],
    ['a second space after the colon', ['Content-Type:  text/plain'], ' text/plain'],
    ['a tab after the space', ['Content-Type: \ttext/plain'], '\ttext/plain'],
    ['trailing spaces', ['Content-Type: text/plain  '], 'text/plain  '],
    ['no Content-Type line', [], 'text/plain'],
    ['quoted parameters', ['Content-Type: text/plain;charset=utf-8;foo="Bar Baz"'], 'text/plain;charset=utf-8;foo="bar baz"'],
    ['a lower-case header name', ['content-type: image/svg+xml'], 'image/svg+xml'],
    ['an upper-case line', ['CONTENT-TYPE: APPLICATION/PDF'], 'application/pdf'],
    ['a value without a slash', ['Content-Type: foo'], 'foo/foo'],
    ['an empty value', ['Content-Type: '], '/'],
    ['two Content-Type lines', ['Content-Type: text/plain', 'Content-Type: text/html'], 'text/html'],
    ['a line folded with a space', ['Content-Type: text/plain;', ' charset=utf-8'], 'text/plain; charset=utf-8'],
    ['a line folded with a tab', ['Content-Type: text/plain;', '\tcharset=utf-8'], 'text/plain;\tcharset=utf-8'],
    ['a value folded onto its own line', ['Content-Type:', ' text/plain'], 'text/plain'],
    ['UTF-8 text', ['Content-Type: text/plain; name=é'], 'text/plain; name=é'],
    ['upper-case UTF-8 text', ['Content-Type: text/plain; name=É'], 'text/plain; name=é'],
    ['no space after the colon but one later', ['Content-Type:text/plain; charset=utf-8'], 'charset=utf-8/charset=utf-8'],
    ['several slashes', ['Content-Type: a/b/c/d'], 'a/d'],
    ['a slash in a parameter', ['Content-Type: text/plain; name="a/b"'], 'text/b"'],
    ['a leading slash', ['Content-Type: /plain'], '/plain'],
    ['a trailing slash', ['Content-Type: text/'], 'text/'],
    ['a space before the colon', ['Content-Type : text/html'], 'text/plain'],
    ['a longer header name', ['Content-Typex: text/html'], 'text/plain'],
    ['a disposition line first', [disposition('file', 'a.txt'), 'Content-Type: text/html; q=1'], 'text/html; q=1'],
    ['no space at all', ['Content-Type:text/plain'], 'text/plain'],
    ['only a tab after the colon', ['Content-Type:\tText/Plain'], 'text/plain'],
  ])('reports %s as fileUpload does', (_case, lines, expected) => {
    expect(fileUploadContentType(lines)).toBe(expected);
  });
});

describe('MultipartHeaderScanner', () => {
  const MIXED = body([
    { headers: [disposition('title')], content: 'Hello' },
    { headers: [disposition('attach', 'a.txt'), 'Content-Type: Text/Plain; Charset=UTF-8'] },
    { headers: [disposition('tag'), 'Content-Type: text/plain'], content: 'one' },
    { headers: [disposition('attach', 'b.bin')] },
    { headers: [disposition('blob'), 'Content-Type: application/octet-stream; x=1'] },
    { headers: [`Content-Disposition: form-data; name="doc"; filename*=utf-8''r%C3%A9.pdf`, 'Content-Type: application/pdf;', ' name="R é"'] },
    { headers: [disposition('attach', 'c.png'), 'Content-Type: image/png', 'Content-Type: image/gif'] },
    { headers: [disposition('tag')], content: `two\r\n--${BOUNDARY.slice(0, -1)}\r\n\r\n` },
  ]);
  const MIXED_FILES = [
    ['attach', 'text/plain'],
    ['attach', 'text/plain'],
    ['blob', 'application/octet-stream'],
    ['doc', 'application/pdf'],
    // busboy reads the first Content-Type line, fileUpload the last.
    ['attach', 'image/png'],
  ] as const;
  const MIXED_TYPES = ['text/plain; charset=utf-8', 'text/plain', 'application/octet-stream; x=1', 'application/pdf; name="r é"', 'image/gif'];

  it.each([1, 3, 64, Number.MAX_SAFE_INTEGER])('records the file parts in body order, fields excluded, fed %i bytes at a time', (size) => {
    const scanner = scan(MIXED, size);
    expect(takeAll(scanner, MIXED_FILES)).toEqual(MIXED_TYPES);
    expect(scanner.take('attach', 'text/plain')).toBeUndefined();
  });

  it('answers no part for a field, or a name or media type busboy did not report', () => {
    const scanner = scan(MIXED, MIXED.length);
    expect(takeAll(scanner, [['title', 'text/plain'], ['tag', 'text/plain'], ['attach', 'image/gif'], ['ATTACH', 'text/plain']])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(takeAll(scanner, MIXED_FILES)).toEqual(MIXED_TYPES);
  });

  it('drops the parts before the one taken, as busboy handed them to no one', () => {
    const scanner = scan(MIXED, MIXED.length);
    expect(scanner.take('blob', 'application/octet-stream')).toBe('application/octet-stream; x=1');
    expect(takeAll(scanner, MIXED_FILES)).toEqual([undefined, undefined, undefined, 'application/pdf; name="r é"', 'image/gif']);
  });

  // busboy hands none of these over as a file, except the over-long block, which it truncates and the scan does not read.
  it.each<[string, Buffer]>([
    ['a part whose header block holds a delimiter', Buffer.from(`--${BOUNDARY}\r\n${disposition('a', 'a.txt')}\r\nX-Note: x\r\n--${BOUNDARY}\r\n\r\nx\r\n--${BOUNDARY}--\r\n`)],
    ['a disposition other than form-data', body([{ headers: ['Content-Disposition: attachment; name="a"; filename="a.txt"'] }])],
    ['a part without a disposition', body([{ headers: ['Content-Type: application/octet-stream'] }])],
    ['a disposition after a line without a colon', body([{ headers: ['Malformed line', disposition('a', 'a.txt')] }])],
    ['a line break in the decoded file name', body([{ headers: [`Content-Disposition: form-data; name="a"; filename*=utf-8''a%0Ab`] }])],
    ['padding after the boundary', Buffer.from(`--${BOUNDARY}  \r\n${disposition('a', 'a.txt')}\r\n\r\nx\r\n--${BOUNDARY}--\r\n`)],
    ['a part after the close delimiter', Buffer.concat([body([]), body([{ headers: [disposition('a', 'a.txt')] }])])],
    ['a header block over 80 KiB', body([{ headers: [disposition('a', 'a.txt'), `X-Long: ${'x'.repeat(80 * 1024)}`] }])],
  ])('records no file part for %s', (_case, data) => {
    for (const size of [1, data.length]) expect(scan(data, size).take('a', 'text/plain'), String(size)).toBeUndefined();
  });

  it('records the 1000th part and none past it, where busboy stops', () => {
    const fields = Array.from({ length: 999 }, () => ({ headers: [disposition('f')] }));
    const data = body([...fields, { headers: [disposition('a', 'a.txt')] }, { headers: [disposition('b', 'b.txt')] }]);
    expect(takeAll(scan(data, 4096), [['a', 'text/plain'], ['b', 'text/plain']])).toEqual(['text/plain', undefined]);
  });

  it('stops at a header block over 80 KiB, recording the parts before it and none after', () => {
    const data = body([
      { headers: [disposition('a', 'a.txt'), 'Content-Type: text/plain; q=1'] },
      { headers: [disposition('b', 'b.txt'), `X-Long: ${'x'.repeat(80 * 1024)}`] },
      { headers: [disposition('c', 'c.txt')] },
    ]);
    expect(takeAll(scan(data, 4096), [['a', 'text/plain'], ['b', 'text/plain'], ['c', 'text/plain']])).toEqual(['text/plain; q=1', undefined, undefined]);
  });

  it.each([
    ['in one chunk, which closes the body there', Number.MAX_SAFE_INTEGER, undefined],
    ['across chunks, which opens a part without headers', 1, 'text/plain'],
  ])('reads a delimiter after a lone dash arriving %s, as busboy does', (_case, size, expected) => {
    const data = Buffer.from(
      `--${BOUNDARY}\r\n${disposition('a', 'a.txt')}\r\n\r\nx\r\n--${BOUNDARY}-\r\n--${BOUNDARY}-\r\n--${BOUNDARY}\r\n${disposition('b', 'b.txt')}\r\n\r\ny\r\n--${BOUNDARY}--\r\n`,
    );
    expect(takeAll(scan(data, size), [['a', 'text/plain'], ['b', 'text/plain']])).toEqual(['text/plain', expected]);
  });

  // Names as busboy reports them for the same dispositions.
  it.each([
    ['form-data; name="a\\"b"; filename="f"', 'a"b'],
    ['form-data; name="a\\\\b"; filename="f"', 'a\\b'],
    [`form-data; name*=utf-8''r%C3%A9; filename="f"`, 'ré'],
    [`form-data; name*=iso-8859-1''r%E9; filename="f"`, 'ré'],
    ['form-data ; name = a ; filename = f ; size=3', 'a'],
    ['form-data; name="é"; filename="f"', 'é'],
    ['form-data; filename="f"; name="a"; name="b"', 'b'],
    ['form-data; name="b"; filename="f"; name="a"', 'b'],
    ['form-data; name="b" x; filename="f"', 'b'],
  ])('names the file part of disposition %j as busboy does, %j', (value, name) => {
    const scanner = scan(body([{ headers: [`Content-Disposition: ${value}`, 'Content-Type: text/plain; v=1'] }]), 2);
    expect(scanner.take(name, 'text/plain')).toBe('text/plain; v=1');
  });

  it('reads parts after a preamble, and a first delimiter that opens the body', () => {
    const parts = [{ headers: [disposition('a', 'a.txt'), 'Content-Type: text/csv; header=present'] }];
    for (const data of [body(parts), Buffer.concat([Buffer.from('preamble\r\n'), body(parts)])]) {
      expect(scan(data, 1).take('a', 'text/csv')).toBe('text/csv; header=present');
    }
  });

  it.each([
    `multipart/form-data; boundary="${BOUNDARY}"`,
    `Multipart/Form-Data; BOUNDARY = ${BOUNDARY} ; charset=utf-8`,
    `multipart/form-data; charset=utf-8; boundary=${BOUNDARY}`,
  ])('reads the boundary of %s', (contentType) => {
    expect(scan(body([{ headers: [disposition('a', 'a.txt')] }]), 5, contentType).take('a', 'text/plain')).toBe('text/plain');
  });

  it.each([undefined, 'multipart/form-data', 'multipart/form-data; boundary', `multipart/form-data; boundary=${'b'.repeat(253)}`])(
    'creates no scanner for %j, under which busboy finds no boundary',
    (contentType) => {
      expect(createMultipartHeaderScanner(contentType)).toBeUndefined();
    },
  );
});
