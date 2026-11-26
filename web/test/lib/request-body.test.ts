// Tests of the admin request body reader: multipart staged to a private file while its fields are scanned.
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayableBody } from '@/lib/gateway-client';
import { receiveRequestBody } from '@/lib/request-body';

const BOUNDARY = '----opt2web7MA4YWxkTrZu0gW';
const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;
const FORM = 'application/x-www-form-urlencoded';

type Entry = readonly [string, string | { readonly file: string; readonly type: string }];

const pairsOf = (form: FormData | URLSearchParams): Array<[string, FormDataEntryValue]> => [
  ...(form as Iterable<[string, FormDataEntryValue]>),
];

/** Form entries in order, a file part as its name and type. */
const entriesOf = (form: FormData | URLSearchParams): Entry[] =>
  pairsOf(form).map(([name, value]) => [name, typeof value === 'string' ? value : { file: value.name, type: value.type }]);

/** Sizes of the form's file parts. */
const fileSizes = (form: FormData | URLSearchParams): number[] =>
  pairsOf(form).flatMap(([, value]) => (typeof value === 'string' ? [] : [value.size]));

/** A multipart body of `parts` (header lines, then the value) between `boundary` delimiters. */
function multipartOf(parts: ReadonlyArray<readonly [string[], Buffer | string]>, boundary = BOUNDARY): Buffer {
  const chunks = parts.flatMap(([headers, value]) => [
    Buffer.from(`--${boundary}\r\n${headers.map((header) => `${header}\r\n`).join('')}\r\n`),
    Buffer.isBuffer(value) ? value : Buffer.from(value),
    Buffer.from('\r\n'),
  ]);
  return Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]);
}

const disposition = (name: string, filename?: string): string =>
  `Content-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}`;

/** `--<boundary>`, then `rest`, then the closing delimiter. */
const onePart = (rest: string): Buffer => Buffer.from(`--${BOUNDARY}${rest}--${BOUNDARY}--`);

/** One part of value `v` under `headers`. */
const headedPart = (...headers: string[]): Buffer => onePart(`\r\n${headers.join('\r\n')}\r\n\r\nv\r\n`);

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4 '),
  Buffer.from([0x00, 0xff, 0x80]),
  Buffer.from('\r\n--\r\n end'),
]);

const WELL_FORMED = multipartOf([
  [[disposition('siteid')], 'default'],
  [[disposition('body')], 'line 1\r\n--not-a-delimiter\r\n\r\nline 2'],
  [[disposition('newfile', 'brochure.pdf'), 'Content-Type: application/pdf'], PDF_BYTES],
  [[disposition('newfile', 'notes.txt')], 'plain'],
  [[disposition('empty', ''), 'Content-Type: application/octet-stream'], ''],
  [[disposition('bom')], '\ufeffkept'],
  [[disposition('caf\u00e9 %22q%22')], '\u00e9t\u00e9'],
  [[disposition('encoded'), 'Content-Transfer-Encoding: base64'], Buffer.from('h\u00e9llo\r\n').toString('base64')],
  [[disposition('title'), 'X-Opt2-Note: ignored; name="other"'], 'Report'],
  [[disposition('newfile', 'report.pdf'), 'Content-Type: application/pdf \t '], 'x'],
  [[disposition('newfile', 'data.csv'), ' \tContent-Type \t: text/csv'], 'a,b'],
  [[disposition('a%0Ab%0dc%22', 'l1%0al2%0D%22.txt')], 'x'],
]);

const WELL_FORMED_ENTRIES: Entry[] = [
  ['siteid', 'default'],
  ['body', 'line 1\r\n--not-a-delimiter\r\n\r\nline 2'],
  ['newfile', { file: 'brochure.pdf', type: 'application/pdf' }],
  ['newfile', { file: 'notes.txt', type: 'text/plain' }],
  ['empty', { file: '', type: 'application/octet-stream' }],
  ['bom', '\ufeffkept'],
  ['caf\u00e9 "q"', '\u00e9t\u00e9'],
  ['encoded', 'h\u00e9llo\r\n'],
  ['title', 'Report'],
  ['newfile', { file: 'report.pdf', type: 'application/pdf' }],
  ['newfile', { file: 'data.csv', type: 'text/csv' }],
  ['a\nb\rc"', { file: 'l1\nl2\r".txt', type: 'text/plain' }],
];

const RESUME = { file: 'r\u00e9sum\u00e9.pdf', type: 'text/plain' };

/** A POST of `bytes` streamed `chunkSize` bytes at a time. */
function postOf(bytes: Buffer, contentType: string | undefined, chunkSize = bytes.length): Request {
  const step = Math.max(1, chunkSize);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += step) controller.enqueue(new Uint8Array(bytes.subarray(at, at + step)));
      controller.close();
    },
  });
  const headers: Record<string, string> = contentType === undefined ? {} : { 'content-type': contentType };
  const init = { method: 'POST', headers, body, duplex: 'half' } as RequestInit;
  return new Request('http://web/admin-actions/carch/update', init);
}

/** Every byte a body source streams, from its start. */
async function bytesOf(source: ReplayableBody | undefined): Promise<Buffer> {
  if (source === undefined) throw new TypeError('No body source');
  return Buffer.from(await new Response(source.stream()).arrayBuffer());
}

/** What `Body.formData()` parses from `bytes`, the reference for well-formed bodies. */
const referenceForm = (bytes: Buffer, contentType: string): Promise<FormData> =>
  new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } }).formData();

const referenceEntries = async (bytes: Buffer, contentType: string): Promise<Entry[]> =>
  entriesOf(await referenceForm(bytes, contentType));

let staging: string;

beforeEach(async () => {
  staging = await mkdtemp(path.join(os.tmpdir(), 'opt2-web-request-body-'));
  vi.stubEnv('TMPDIR', staging);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(staging, { recursive: true, force: true });
});

describe('multipart bodies', () => {
  it.each([1, 2, 3, 7, 64, WELL_FORMED.length])(
    'scans fields and file parts fed %i bytes at a time, as Body.formData() does',
    async (chunkSize) => {
      const received = await receiveRequestBody(postOf(WELL_FORMED, MULTIPART, chunkSize));

      expect(entriesOf(received.form)).toEqual(WELL_FORMED_ENTRIES);
      // Node 22's bundled parser strips a value's leading BOM, which the multipart/form-data parser keeps.
      const withoutBom = (entries: Entry[]): Entry[] => entries.filter(([name]) => name !== 'bom');
      expect(withoutBom(entriesOf(received.form))).toEqual(withoutBom(await referenceEntries(WELL_FORMED, MULTIPART)));
      expect(fileSizes(received.form)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(received.body?.form).toBe(received.form);
      expect(received.body?.contentType).toBe(MULTIPART);
      expect(received.body?.body.size).toBe(WELL_FORMED.length);
      expect((await bytesOf(received.body?.body)).equals(WELL_FORMED)).toBe(true);
      await received.dispose?.();
    },
  );

  it.each([
    ['a quoted boundary', `multipart/form-data; boundary="${BOUNDARY}"`, BOUNDARY],
    ['a boundary after another parameter', `multipart/form-data; charset=utf-8; boundary=${BOUNDARY}`, BOUNDARY],
    ['upper-case names', `Multipart/Form-Data; BOUNDARY=${BOUNDARY}`, BOUNDARY],
    ['a quoted boundary with a space', 'multipart/form-data; boundary="opt2 web"', 'opt2 web'],
  ])('reads the boundary from %s', async (_label, contentType, boundary) => {
    const bytes = multipartOf([[[disposition('title')], 'Report']], boundary);

    const received = await receiveRequestBody(postOf(bytes, contentType));

    expect(entriesOf(received.form)).toEqual([['title', 'Report']]);
    expect(entriesOf(received.form)).toEqual(await referenceEntries(bytes, contentType));
    await received.dispose?.();
  });

  // Node 22's bundled parser rejects these dispositions, so the entries are asserted directly.
  it.each<[string, string, Entry]>([
    ['an unquoted name', 'form-data; name=title', ['title', 'Report']],
    ['an extended filename', `form-data; name="newfile"; filename*=utf-8''r%C3%A9sum%C3%A9.pdf`, ['newfile', RESUME]],
    [
      'an extended filename after a plain one',
      `form-data; name="newfile"; filename="x.pdf"; filename*=UTF-8'en'r%C3%A9sum%C3%A9.pdf`,
      ['newfile', RESUME],
    ],
    [
      'an extended filename before a plain one',
      `form-data; name="newfile"; filename*=utf-8''r%C3%A9sum%C3%A9.pdf; filename="x.pdf"`,
      ['newfile', RESUME],
    ],
    ['blanks after the disposition', 'form-data; name="title" \t', ['title', 'Report']],
  ])('reads a disposition with %s', async (_label, value, entry) => {
    const bytes = multipartOf([[[`Content-Disposition: ${value}`], 'Report']]);

    const received = await receiveRequestBody(postOf(bytes, MULTIPART, 3));

    expect(entriesOf(received.form)).toEqual([entry]);
    expect((await bytesOf(received.body?.body)).equals(bytes)).toBe(true);
    await received.dispose?.();
  });

  it.each([
    ['a preamble', 'ignored preamble\r\n', ''],
    ['an epilogue', '', 'ignored epilogue'],
    ['both', 'preamble --', '\r\nepilogue --x'],
  ])('ignores %s while staging every byte', async (_label, preamble, epilogue) => {
    const parts = multipartOf([[[disposition('title')], 'Report']]);
    const bytes = Buffer.concat([Buffer.from(preamble), parts, Buffer.from(epilogue)]);

    const received = await receiveRequestBody(postOf(bytes, MULTIPART, 5));

    expect(entriesOf(received.form)).toEqual([['title', 'Report']]);
    expect((await bytesOf(received.body?.body)).equals(bytes)).toBe(true);
    await received.dispose?.();
  });

  it('stages a private file that streams on each read, opens when read and goes on dispose', async () => {
    const received = await receiveRequestBody(postOf(WELL_FORMED, MULTIPART, 64));
    const dirs = await readdir(staging);

    expect(dirs).toEqual([expect.stringMatching(/^opt2-web-upload-/)]);
    const dir = path.join(staging, dirs[0] ?? '');
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, files[0] ?? ''))).mode & 0o777).toBe(0o600);
    const source = received.body?.body;
    expect((await bytesOf(source)).equals(WELL_FORMED)).toBe(true);
    expect((await bytesOf(source)).equals(WELL_FORMED)).toBe(true);
    const unread = source?.stream();
    await source?.stream().cancel();

    await received.dispose?.();

    expect(await readdir(staging)).toEqual([]);
    await expect(new Response(unread).arrayBuffer()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['no boundary parameter', 'multipart/form-data', multipartOf([[[disposition('a')], 'v']])],
    ['no delimiter in the body', MULTIPART, Buffer.from('no parts at all')],
    ['no closing delimiter', MULTIPART, Buffer.from(`--${BOUNDARY}\r\n${disposition('a')}\r\n\r\nvalue`)],
    ['a part without a name', MULTIPART, onePart('\r\nContent-Type: text/plain\r\n\r\nv\r\n')],
    ['no CRLF after a delimiter', MULTIPART, onePart(`x\r\n${disposition('a')}\r\n\r\nv\r\n`)],
    ['a header without a colon', MULTIPART, onePart('\r\nContent-Disposition form-data\r\n\r\nv\r\n')],
    ['an unclosed quoted name', MULTIPART, onePart('\r\nContent-Disposition: form-data; name="a\r\n\r\nv\r\n')],
    ['no part headers', MULTIPART, onePart('\r\n\r\nv\r\n')],
    ['an unparsable content type', `\v${MULTIPART}`, multipartOf([[[disposition('a')], 'v']])],
    ['a disposition other than form-data', MULTIPART, headedPart('Content-Disposition: attachment; name="a"')],
    ['a disposition without a name', MULTIPART, headedPart('Content-Disposition: form-data; filename="a.txt"')],
    ['a valueless parameter before another', MULTIPART, headedPart(`${disposition('a')}; flag; size=1`)],
    ['a header name alone on its line', MULTIPART, headedPart(disposition('a'), 'X-Opt2-Note')],
    ['an extended filename without apostrophes', MULTIPART, headedPart(`${disposition('a')}; filename*=utf-8a`)],
    ['an extended filename with one apostrophe', MULTIPART, headedPart(`${disposition('a')}; filename*=utf-8'a`)],
    ['an extended filename not in utf-8', MULTIPART, headedPart(`${disposition('a')}; filename*=latin1''r%E9`)],
  ])('rejects a body with %s as Body.formData() does, leaving no staging', async (_label, contentType, bytes) => {
    const error = await receiveRequestBody(postOf(bytes, contentType, 3)).catch((caught: unknown) => caught);
    const reference = await referenceForm(bytes, contentType).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe('Failed to parse body as FormData.');
    expect(reference).toBeInstanceOf(TypeError);
    expect(await readdir(staging)).toEqual([]);
  });
});

describe('other bodies', () => {
  it.each<{ label: string; contentType?: string; body: string; entries: Entry[] }>([
    {
      label: 'an urlencoded body',
      contentType: FORM,
      body: 'a=1&b=x+y&a=%C3%A9',
      entries: [
        ['a', '1'],
        ['b', 'x y'],
        ['a', '\u00e9'],
      ],
    },
    { label: 'a JSON body', contentType: 'application/json', body: '{"a":1}', entries: [] },
    { label: 'a body without a content type', body: 'raw', entries: [] },
  ])('holds $label whole with its form scope and stages nothing', async ({ contentType, body, entries }) => {
    const bytes = Buffer.from(body);

    const received = await receiveRequestBody(postOf(bytes, contentType));

    expect(received.form).toBeInstanceOf(URLSearchParams);
    expect(entriesOf(received.form)).toEqual(entries);
    expect(received.body?.contentType).toBe(contentType ?? '');
    expect(received.body?.body.size).toBe(bytes.length);
    expect((await bytesOf(received.body?.body)).equals(bytes)).toBe(true);
    expect(received).not.toHaveProperty('dispose');
    expect(await readdir(staging)).toEqual([]);
  });

  it('gives a request without a body an empty form scope and no body', async () => {
    const received = await receiveRequestBody(new Request('http://web/admin-actions/cusers/update'));

    expect(received.form).toBeInstanceOf(URLSearchParams);
    expect([...(received.form as URLSearchParams)]).toEqual([]);
    expect(received.body).toBeUndefined();
    expect(received).not.toHaveProperty('dispose');
  });
});
