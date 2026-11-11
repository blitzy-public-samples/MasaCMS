import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
  PHOTO_CONDITION,
  routeKeyForRequest,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import {
  EMPTY_BODY_PARAMS,
  UnreadableBodyError,
  bodyParamsFrom,
  paramValue,
  tokenFromParams,
} from '../src/dispatcher/body.js';

const URLENCODED = 'application/x-www-form-urlencoded';
const BOUNDARY = 'XyZ';
const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;
const NOTHING_READ = { form: {}, json: undefined, files: [] };

const disposition = (name: string): string => `Content-Disposition: form-data; name="${name}"`;
/** A complete first part `a=1` of a raw multipart body, up to the next delimiter. */
const FIRST_PART = `--${BOUNDARY}\r\n${disposition('a')}\r\n\r\n1\r\n`;

/** A `multipart/form-data` body of `[part headers, content]` pairs, closed by `--boundary--`. */
function multipart(parts: ReadonlyArray<readonly [string, string | Buffer]>, boundary = BOUNDARY): Buffer {
  const chunks: Buffer[] = [];
  for (const [headers, content] of parts) {
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    chunks.push(Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`), bytes, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

/** Part headers whose text between the boundary line and the blank line is exactly `length` bytes. */
function headersOfLength(name: string, length: number): string {
  const prefix = `${disposition(name)}\r\nX-Pad: `;
  return prefix + 'a'.repeat(length - prefix.length);
}

/** The multipart body of the one part `a=1`. */
const A1 = multipart([[disposition('a'), '1']]);
const read = (form: Record<string, string>, files: unknown[] = []): object => ({ form, json: undefined, files });

describe('bodyParamsFrom without a keyed body', () => {
  it.each([
    ['no content type', undefined, Buffer.from('a=1')],
    ['no buffer', URLENCODED, undefined],
    ['an empty buffer', URLENCODED, Buffer.alloc(0)],
  ])('returns the empty params for %s', (_case, contentType, buffer) => {
    expect(bodyParamsFrom(contentType, buffer)).toBe(EMPTY_BODY_PARAMS);
  });

  it('keeps the empty params frozen', () => {
    expect(EMPTY_BODY_PARAMS).toEqual(NOTHING_READ);
    expect(Object.isFrozen(EMPTY_BODY_PARAMS)).toBe(true);
    expect(Object.isFrozen(EMPTY_BODY_PARAMS.form)).toBe(true);
    expect(Object.isFrozen(EMPTY_BODY_PARAMS.files)).toBe(true);
  });

  it.each([
    ['text/plain', 'a=1'],
    ['application/vnd.api+json', '{"a":1}'],
    ['application/jso', '{"a":1}'],
    [' application/json', '{"a":1}'],
    ['multipart/mixed; boundary=XyZ', `${FIRST_PART}--XyZ--`],
    ['multipart/form-datax; boundary=XyZ', `${FIRST_PART}--XyZ--`],
  ])('reads nothing for content type %j', (contentType, body) => {
    expect(bodyParamsFrom(contentType, Buffer.from(body))).toBe(EMPTY_BODY_PARAMS);
  });

  const formBodies: ReadonlyArray<readonly [string, Buffer]> = [
    [URLENCODED, Buffer.from('a=1')],
    [MULTIPART, A1],
    ['multipart/form-data', A1],
  ];
  it.each(
    ['GET', 'PUT', 'PATCH', 'DELETE'].flatMap((method) => formBodies.map(([contentType, buffer]) => [method, contentType, buffer] as const)),
  )('reads no form from a %s request line with %j', (method, contentType, buffer) => {
    expect(bodyParamsFrom(contentType, buffer, method)).toBe(EMPTY_BODY_PARAMS);
  });

  it.each(['post', 'Post'])('reads the form of a %s request line', (method) => {
    expect(bodyParamsFrom(MULTIPART, A1, method)).toEqual(read({ a: '1' }));
    expect(bodyParamsFrom(URLENCODED, Buffer.from('a=1'), method)).toEqual(read({ a: '1' }));
  });
});

describe('bodyParamsFrom with a url-encoded body', () => {
  it('decodes percent escapes and plus signs', () => {
    const params = bodyParamsFrom(URLENCODED, Buffer.from('name=J%C3%A9r%C3%B4me+Doe&q=a%2Bb%26c%3D'));
    expect(params).toEqual({ form: { name: 'Jérôme Doe', q: 'a+b&c=' }, json: undefined, files: [] });
  });

  it('joins repeated names with commas in body order, keeping empty values', () => {
    const { form } = bodyParamsFrom(URLENCODED, Buffer.from('a=1&b=x&a=&a=3'));
    expect(form).toEqual({ a: '1,,3', b: 'x' });
    expect(Object.keys(form)).toEqual(['a', 'b']);
  });

  it('reads a name without `=` as an empty value', () => {
    expect(bodyParamsFrom(URLENCODED, Buffer.from('flag&x=1')).form).toEqual({ flag: '', x: '1' });
  });

  it('keeps a leading `?` in the first name', () => {
    expect(bodyParamsFrom(URLENCODED, Buffer.from('?x=1')).form).toEqual({ '?x': '1' });
  });

  it('keeps `__proto__` as a data key', () => {
    const { form } = bodyParamsFrom(URLENCODED, Buffer.from('__proto__=p&__proto__=q'));
    expect(Object.hasOwn(form, '__proto__')).toBe(true);
    expect(form['__proto__']).toBe('p,q');
    expect(Object.getPrototypeOf(form)).toBe(Object.prototype);
  });

  it.each([
    'Application/X-WWW-Form-Urlencoded',
    'application/x-www-form-urlencoded; charset=UTF-8',
    'application/x-www-form-urlencoded ; charset="utf-8"',
  ])('matches content type %j by its type alone', (contentType) => {
    expect(bodyParamsFrom(contentType, Buffer.from('a=%C3%A9')).form).toEqual({ a: 'é' });
  });
});

describe('bodyParamsFrom media type and request charset as HttpCore reads them', () => {
  const MP = 'multipart/form-data';
  const UE_A1 = Buffer.from('a=1');
  type Outcome = 'read' | 'nothing' | 'refused';
  const expectOutcome = (contentType: string, buffer: Buffer, outcome: Outcome, form: Record<string, string> = { a: '1' }): void => {
    const parse = (): object => bodyParamsFrom(contentType, buffer);
    if (outcome === 'refused') expect(parse).toThrow(UnreadableBodyError);
    else if (outcome === 'nothing') expect(parse()).toBe(EMPTY_BODY_PARAMS);
    else expect(parse()).toEqual(read(form));
  };

  it.each<[string, (type: string) => string, Outcome, Outcome]>([
    ['another element after the type', (t) => `${t}, x`, 'read', 'read'],
    ['an empty element after the type', (t) => `${t},`, 'read', 'read'],
    ['empty elements before the type', (t) => `, ${t}`, 'nothing', 'read'],
    ['empty elements and blanks before the type', (t) => `,\t, ${t}`, 'nothing', 'read'],
    ['an empty element with a bogus charset before the type', (t) => `; charset=bogus, ${t}`, 'nothing', 'read'],
    ['another element before the type', (t) => `x, ${t}`, 'nothing', 'nothing'],
    ['a value after the type', (t) => `${t}=x`, 'read', 'read'],
    ['an empty value after the type', (t) => `${t}=`, 'read', 'read'],
    ['a quoted value after the type', (t) => `${t}="a;b,c"`, 'read', 'read'],
    ['tabs around the type', (t) => `\t${t}\t`, 'read', 'read'],
    ['a folded line after the type', (t) => `${t}\r\n\t`, 'read', 'read'],
    ['a folded line before the type', (t) => `\r\n ${t}`, 'read', 'read'],
    ['upper case', (t) => t.toUpperCase(), 'read', 'read'],
    ['an NBSP before the type', (t) => `\u00a0${t}`, 'nothing', 'nothing'],
    ['an NBSP after the type', (t) => `${t}\u00a0`, 'nothing', 'nothing'],
    ['a blank inside the type', (t) => t.replace('/', '/ '), 'nothing', 'nothing'],
    ['a tab inside the type', (t) => t.replace('/', '/\t'), 'nothing', 'nothing'],
    ['a blank before the slash', (t) => t.replace('/', ' /'), 'nothing', 'nothing'],
    ['text after the type', (t) => `${t} x`, 'nothing', 'nothing'],
    ['a quoted type', (t) => `"${t}"`, 'nothing', 'nothing'],
  ])('reads a header with %s as legacy does', (_case, shape, multipartOutcome, urlEncodedOutcome) => {
    expectOutcome(`${shape(MP)}; boundary=XyZ`, A1, multipartOutcome);
    expectOutcome(shape(URLENCODED), UE_A1, urlEncodedOutcome);
  });

  it.each(['', ' ', ',', ';', '; boundary=XyZ', ',; boundary=XyZ', '; charset=utf-8'])('refuses a POST under %j, which has no media type', (contentType) => {
    expect(() => bodyParamsFrom(contentType, A1)).toThrow(UnreadableBodyError);
  });

  it.each(['=x', '=', '=; boundary=XyZ'])('reads nothing under %j, whose media type is empty', (contentType) => {
    expect(bodyParamsFrom(contentType, A1)).toBe(EMPTY_BODY_PARAMS);
  });

  it.each(['GET', 'PUT'].flatMap((method) => ['; boundary=XyZ', `${URLENCODED}; charset=bogus`].map((contentType) => [method, contentType] as const)))(
    'reads nothing from a %s request line under %j, which legacy does not parse',
    (method, contentType) => {
      expect(bodyParamsFrom(contentType, A1, method)).toBe(EMPTY_BODY_PARAMS);
    },
  );

  it.each<[string, string]>([
    [`${MP}, x; charset=iso-8859-1; boundary=XyZ`, 'é'],
    [`${MP};, x; charset=iso-8859-1; boundary=XyZ`, 'é'],
    [`${MP}, x; charset=bogus; boundary=XyZ`, 'é'],
    [`${MP}=a; charset=iso-8859-1; boundary=XyZ`, 'Ã©'],
    [`${MP}="a;charset=utf-8"; charset=iso-8859-1; boundary=XyZ`, 'Ã©'],
  ])('reads the request charset of %j from its first element only', (contentType, value) => {
    expect(bodyParamsFrom(contentType, multipart([[disposition('v'), 'é']]))).toEqual(read({ v: value }));
  });

  it.each([
    [`${URLENCODED}; charset="a b"`, 'rejects'],
    [`${URLENCODED}; charset=a\u00e9`, 'rejects'],
    [`${URLENCODED}; charset=-utf-8`, 'rejects'],
    ['text/plain; charset="a b"', 'rejects'],
    ['text/plain; charset=a\u00e9', 'rejects'],
    ['text/plain; charset=-utf-8', 'rejects'],
    ['multipart/form-datax; charset="a b"; boundary=XyZ', 'rejects'],
    [`, ${MP}; charset=bogus; boundary=XyZ`, 'rejects'],
    [`${MP}=x; charset=bogus; boundary=XyZ`, 'rejects'],
    [`, ${MP}; charset=Shift_JIS; boundary=XyZ`, 'reads'],
  ])('refuses a POST under %j, whose charset legacy %s', (contentType) => {
    expect(() => bodyParamsFrom(contentType, UE_A1)).toThrow(UnreadableBodyError);
    expect(() => bodyParamsFrom(contentType, Buffer.alloc(0))).toThrow(UnreadableBodyError);
  });

  it.each([
    ['Shift_JIS', 'reads'],
    ['EUC-JP', 'reads'],
    ['UTF-32', 'rejects'],
    ['IBM037', 'rejects'],
  ])('refuses a url-encoded body in the charset %j, which legacy %s, and reads nothing without one', (charset) => {
    const contentType = `${URLENCODED}; charset=${charset}`;
    expect(() => bodyParamsFrom(contentType, UE_A1)).toThrow(UnreadableBodyError);
    expect(bodyParamsFrom(contentType, Buffer.alloc(0))).toBe(EMPTY_BODY_PARAMS);
  });

  it.each<[string, Outcome]>([
    [`${URLENCODED}, x; charset=bogus`, 'read'],
    [`${URLENCODED}; charset=" "`, 'read'],
    [`${URLENCODED}; charset=windows-1252`, 'read'],
    [`${URLENCODED}; charset=x-MacRoman`, 'read'],
    ['text/plain; charset=iso-8859-1', 'nothing'],
    ['text/plain; charset=Shift_JIS', 'nothing'],
    ['text/plain; charset=UTF-32', 'nothing'],
  ])('reads %j, whose charset legacy accepts', (contentType, outcome) => {
    expectOutcome(contentType, UE_A1, outcome);
  });

  it.each<[string, Outcome, Buffer]>([
    [`${URLENCODED}; charset=bogus`, 'refused', UE_A1],
    [`${URLENCODED}; charset=bogus`, 'nothing', Buffer.alloc(0)],
    [`${URLENCODED}\u00a0; charset=bogus`, 'nothing', UE_A1],
    ['text/plain; charset=bogus', 'nothing', UE_A1],
    ['x; charset=bogus', 'nothing', UE_A1],
    ['multipart/mixed; charset=bogus; boundary=XyZ', 'nothing', UE_A1],
    ['multipart/form-datax; charset=bogus; boundary=XyZ', 'nothing', A1],
  ])("handles %j, under a charset name legacy's Java does not know, as under any legal name: %s", (contentType, outcome, body) => {
    expectOutcome(contentType, body, outcome);
  });

  const PREAMBLE = Buffer.from(`junk\r\n${A1.toString()}`);
  it.each<[string, Buffer, Outcome]>([
    ['multipart/form-datax', A1, 'refused'],
    ['multipart/form-data\u00a0; boundary=', A1, 'refused'],
    ['multipart/form-data x; boundary=XyZ', PREAMBLE, 'refused'],
    ['multipart/form-data"; boundary=X\u00e9Z', multipart([[disposition('a'), '1']], 'X\u00e9Z'), 'refused'],
    ['multipart/form-data\u00a0; boundary=XyZ', A1, 'nothing'],
    ['Multipart/Form-Data\u00a0; boundary=XyZ', Buffer.alloc(0), 'nothing'],
    ['multipart/form-datax; boundary=XyZ', Buffer.from(`--XyZ\r\n${disposition('a')}\r\n\r\n1`), 'nothing'],
    ['multipart/form-datax; charset=GBK; boundary=XyZ', A1, 'nothing'],
    ['multipart/form-datax; charset=GBK; boundary=XyZ', PREAMBLE, 'refused'],
    ['multipart/form-data x; boundary=XyZ', multipart([[`${disposition('a')}\r\nContent-Type: text/plain; charset=bogus`, '1']]), 'nothing'],
    ['multipart/form-data"; boundary=XyZ', multipart([['Content-Type: text/plain', '1']]), 'nothing'],
    [`, ${MP}`, A1, 'nothing'],
    [`, ${MP}; boundary=`, A1, 'nothing'],
    [`, ${MP}; boundary=XyZ`, PREAMBLE, 'nothing'],
    [`, ${MP}; boundary=X\u00e9Z`, A1, 'nothing'],
  ])('checks a multipart body under %j only as far as legacy does', (contentType, body, outcome) => {
    expectOutcome(contentType, body, outcome);
  });
});

describe('bodyParamsFrom with a JSON body', () => {
  it.each(['application/json', 'APPLICATION/JSON; charset=utf-8', 'application/json-patch+json'])(
    'parses the body when %j passes the 16-character prefix gate',
    (contentType) => {
      const params = bodyParamsFrom(contentType, Buffer.from('{"method":"findOne","n":2}'));
      expect(params).toEqual({ form: {}, json: { method: 'findOne', n: 2 }, files: [] });
    },
  );

  it.each([
    ['[1,2]', [1, 2]],
    ['"text"', 'text'],
    ['42', 42],
    ['true', true],
    ['null', null],
  ])('keeps the non-object JSON value %s', (body, expected) => {
    expect(bodyParamsFrom('application/json', Buffer.from(body))).toEqual({ form: {}, json: expected, files: [] });
  });

  it.each(['{"a":', 'a=1', "{'a':1}"])('returns the empty params for the invalid JSON %j', (body) => {
    expect(bodyParamsFrom('application/json', Buffer.from(body))).toBe(EMPTY_BODY_PARAMS);
  });

  it.each([
    ['no buffer', undefined],
    ['an empty buffer', Buffer.alloc(0)],
  ])('returns the empty params for %s', (_case, buffer) => {
    expect(bodyParamsFrom('application/json', buffer)).toBe(EMPTY_BODY_PARAMS);
  });

  it.each(['GET', 'PUT', 'PATCH', 'DELETE'])('parses the body of a %s request line', (method) => {
    expect(bodyParamsFrom('application/json', Buffer.from('{"a":1}'), method)).toEqual({ form: {}, json: { a: 1 }, files: [] });
  });
});

describe('bodyParamsFrom with a multipart body', () => {
  it('reads text fields and records file parts without reading their bytes', () => {
    const body = multipart([
      [disposition('title'), 'Hello wörld'],
      [`${disposition('newFile')}; filename="photo.png"\r\nContent-Type: image/png`, Buffer.from([0x89, 0x50, 0x4e, 0x47])],
      [disposition('notes'), 'line1\r\nline2 with --XyZ inside'],
    ]);
    const original = Buffer.from(body);
    expect(bodyParamsFrom(MULTIPART, body)).toEqual({
      form: { title: 'Hello wörld', notes: 'line1\r\nline2 with --XyZ inside' },
      json: undefined,
      files: [{ field: 'newFile', filename: 'photo.png', contentType: 'image/png' }],
    });
    expect(body.equals(original)).toBe(true);
  });

  it('joins repeated text fields with commas in body order', () => {
    const body = multipart([
      [disposition('tag'), 'a'],
      [`${disposition('upload')}; filename="a.txt"`, 'file'],
      [disposition('tag'), 'c'],
    ]);
    expect(bodyParamsFrom(MULTIPART, body)).toEqual(read({ tag: 'a,c' }, [{ field: 'upload', filename: 'a.txt' }]));
  });

  it('records a file part without a content type, an empty file name and a large file', () => {
    const body = multipart([
      [`${disposition('a')}; filename="plain.bin"`, 'x'],
      [`${disposition('b')}; filename=""\r\nContent-Type: application/octet-stream`, ''],
      [`${disposition('c')}; filename="big.pdf"`, Buffer.alloc(200 * 1024, 0x41)],
    ]);
    const { form, files } = bodyParamsFrom(MULTIPART, body);
    expect(form).toEqual({});
    expect(files).toStrictEqual([
      { field: 'a', filename: 'plain.bin' },
      { field: 'b', filename: '', contentType: 'application/octet-stream' },
      { field: 'c', filename: 'big.pdf' },
    ]);
  });

  it.each([
    ['multipart/form-data; boundary="a b;c"', 'a b;c'],
    ['MULTIPART/FORM-DATA; boundary=XyZ', 'XyZ'],
    ['multipart/form-data; charset=utf-8; boundary=----WebKitFormBoundary7MA4', '----WebKitFormBoundary7MA4'],
    ['multipart/form-data; boundary="XyZ"; charset=utf-8', 'XyZ'],
    ['multipart/form-data; boundary=Old; boundary=XyZ', 'XyZ'],
    ['multipart/form-data; flag; boundary=XyZ', 'XyZ'],
    // `--` alone opens every line that starts with two dashes.
    ['multipart/form-data; boundary=""', 'XyZ'],
  ])('reads the boundary of %j', (contentType, boundary) => {
    expect(bodyParamsFrom(contentType, multipart([[disposition('a'), '1']], boundary))).toEqual(read({ a: '1' }));
  });

  it.each([
    ...[
      'multipart/form-data',
      'multipart/form-data; boundary=',
      'multipart/form-data; boundary="',
      'multipart/form-data; BOUNDARY=XyZ',
      'multipart/form-data; charset=bogus; boundary=XyZ',
    ].flatMap((contentType) => [A1, Buffer.alloc(0), undefined].map((buffer) => [contentType, buffer] as const)),
    ['multipart/form-data; boundary=XyZ; charset=utf-8', A1] as const,
  ])('refuses %j with the body %s', (contentType, buffer) => {
    expect(() => bodyParamsFrom(contentType, buffer)).toThrow(UnreadableBodyError);
  });

  it.each([MULTIPART, 'multipart/form-data; boundary=""', 'multipart/form-data; boundary=X\u00e9Z'])(
    'reads nothing for %j without a body',
    (contentType) => {
      expect(bodyParamsFrom(contentType, Buffer.alloc(0))).toBe(EMPTY_BODY_PARAMS);
      expect(bodyParamsFrom(contentType, undefined)).toBe(EMPTY_BODY_PARAMS);
    },
  );

  it.each([65537, 5 * 1024 * 1024])('reads a %i-byte text field whole', (size) => {
    const body = multipart([
      [disposition('newFile'), 'x'.repeat(size)],
      [disposition('after'), 'z'],
    ]);
    expect(bodyParamsFrom(MULTIPART, body)).toEqual(read({ newFile: 'x'.repeat(size), after: 'z' }));
  });

  it.each([10239, 20000])('reads %i bytes of part headers', (length) => {
    const body = multipart([
      [disposition('before'), 'ok'],
      [headersOfLength('big', length), 'v'],
      [disposition('after'), 'z'],
    ]);
    expect(bodyParamsFrom(MULTIPART, body)).toEqual(read({ before: 'ok', big: 'v', after: 'z' }));
  });

  it.each<[string, string, Record<string, string>]>([
    ['a folded line', 'Content-Disposition: form-data;\r\n\tname="folded"', { folded: '1' }],
    ['upper-case names', 'CONTENT-DISPOSITION: FORM-DATA; NAME="Upper"', { Upper: '1' }],
    ['a valueless parameter first', 'Content-Disposition: form-data; flag; name="n"', { n: '1' }],
    ['an escaped quote ending the name', 'Content-Disposition: form-data; name="say \\"hi\\""', { 'say \\': '1' }],
    ['lines without a header name', 'garbage line\r\n: no name\r\nContent-Disposition: form-data; name="n"', { n: '1' }],
    ['a file name before the name, naming the field', 'Content-Disposition: form-data; filename="f.txt"; name="n"', { 'f.txt': '1' }],
    ['a file name and no name, naming the field', 'Content-Disposition: form-data; filename="x.txt"', { 'x.txt': '1' }],
    ['two dispositions, the last winning', `${disposition('first')}\r\n${disposition('second')}`, { second: '1' }],
    ['an unclosed file name quote', `${disposition('f')}; filename="x.png`, { f: '1' }],
    ['an empty name', 'Content-Disposition: form-data; name=""', { '': '1' }],
    ['a dotted capital I, which lengthens the lower-cased line', 'Content-Disposition: form-data; name="\u0130x"', { '\u0130x"': '1' }],
    ['a dotted capital I before the name', 'Content-Disposition: form-data; x="\u0130"; name="abc"', { 'bc"': '1' }],
    ['a final sigma, which keeps the line length', 'Content-Disposition: form-data; name="\u03a3\u0391\u03a3"', { '\u03a3\u0391\u03a3': '1' }],
    ['its type after other text', 'Content-Disposition:xcontent-disposition: form-data; name="q"', { q: '1' }],
  ])('reads the disposition with %s', (_case, headers, form) => {
    expect(bodyParamsFrom(MULTIPART, multipart([[headers, '1']]))).toEqual(read(form));
  });

  it.each([
    ['photo.png', 'photo.png'],
    ['C:\\dir\\photo.JPG', 'photo.JPG'],
    ['a/b/', ''],
    ['a\\"b.png', ''],
  ])('records the file name %j as %j', (raw, filename) => {
    const body = multipart([[`${disposition('q')}; filename="${raw}"`, 'bytes']]);
    expect(bodyParamsFrom(MULTIPART, body)).toEqual(read({}, [{ field: 'q', filename }]));
  });

  it('records a file part after text after the quoted name, and one with an empty name', () => {
    const body = multipart([
      ['Content-Disposition: form-data; name="j" trailing; filename="j.txt"', 'bytes'],
      ['Content-Disposition: form-data; name=""; filename="z.txt"', '1'],
    ]);
    expect(bodyParamsFrom(MULTIPART, body)).toEqual(read({}, [{ field: 'j', filename: 'j.txt' }, { field: '', filename: 'z.txt' }]));
  });

  it.each([
    ['a dotted capital I between the name and the file name', 'Content-Disposition: form-data; name="a"; x="\u0130"; filename="b.png"', '.png'],
    ['a dotted capital I in the file name', 'Content-Disposition: form-data; name="a"; filename="\u0130.png"', '\u0130.png'],
  ])('records a file part with %s as legacy slices it', (_case, headers, filename) => {
    expect(bodyParamsFrom(MULTIPART, multipart([[headers, 'bytes']]))).toEqual(read({}, [{ field: 'a', filename }]));
  });

  it('records a file part whatever its charset', () => {
    const body = multipart([[`${disposition('f')}; filename="p.png"\r\nContent-Type: Image/PNG; charset=bogus`, Buffer.from([0x89, 0x50])]]);
    expect(bodyParamsFrom(MULTIPART, body)).toEqual(read({}, [{ field: 'f', filename: 'p.png', contentType: 'image/png; charset=bogus' }]));
  });

  const LATIN1_CAFE = Buffer.from('café', 'latin1');
  const partType = (type: string): string => `${disposition('v')}\r\nContent-Type: ${type}`;
  it.each<[string, string, string, string | Buffer, string]>([
    ['a request charset', 'multipart/form-data; charset=iso-8859-1; boundary=XyZ', disposition('v'), LATIN1_CAFE, 'café'],
    ['a quoted request charset', 'multipart/form-data; charset="iso-8859-1"; boundary=XyZ', disposition('v'), LATIN1_CAFE, 'café'],
    ['a request charset alias', 'multipart/form-data; charset=latin1; boundary=XyZ', disposition('v'), LATIN1_CAFE, 'café'],
    ['an upper-case request charset', 'multipart/form-data; charset=UTF-8; boundary=XyZ', disposition('v'), 'café', 'café'],
    ['a US-ASCII request charset', 'multipart/form-data; charset=us-ascii; boundary=XyZ', disposition('v'), 'café', 'caf\uFFFD\uFFFD'],
    ['a part charset', MULTIPART, partType('text/plain; charset=ISO-8859-1'), LATIN1_CAFE, 'café'],
    ['an upper-case part charset name', MULTIPART, partType('text/plain; CHARSET=ISO-8859-1'), LATIN1_CAFE, 'café'],
    ['a part charset alias', MULTIPART, partType('text/plain; charset=UTF8'), 'café', 'café'],
    ['a US-ASCII part charset', MULTIPART, partType('text/plain; charset=us-ascii'), 'café', 'caf\uFFFD\uFFFD'],
    ['a part charset before another parameter', MULTIPART, partType('text/plain; charset=iso-8859-1; format=flowed'), LATIN1_CAFE, 'café'],
    ['a later content type without a charset', MULTIPART, `${partType('text/plain; charset=iso-8859-1')}\r\nContent-Type: text/plain`, LATIN1_CAFE, 'café'],
    ['windows-1252, its euro sign and a byte Java leaves undefined', MULTIPART, partType('text/plain; charset=windows-1252'), Buffer.from([0x80, 0x81, 0x9f, 0xe9]), '€\uFFFDŸé'],
    ['the cp1252 alias', MULTIPART, partType('text/plain; charset=CP1252'), Buffer.from([0x80, 0x9d]), '€\uFFFD'],
    ['a windows-1251 byte Java leaves undefined', MULTIPART, partType('text/plain; charset=windows-1251'), Buffer.from([0x98, 0xc0]), '\uFFFDА'],
    ['ISO-8859-2', MULTIPART, partType('text/plain; charset=ISO-8859-2'), Buffer.from([0xa1, 0xb1]), 'Ąą'],
    ['ISO-8859-9 and its C1 control', MULTIPART, partType('text/plain; charset=latin5'), Buffer.from([0x80, 0xd0, 0xdd]), '\u0080Ğİ'],
    ['KOI8-R', MULTIPART, partType('text/plain; charset=KOI8-R'), Buffer.from([0xf0, 0xd2, 0xc9]), 'При'],
    ['IBM866 control bytes', MULTIPART, partType('text/plain; charset=cp866'), Buffer.from([0x1a, 0x1c, 0x7f, 0x80]), '\u001a\u001c\u007fА'],
    ['TIS-620, which leaves 0x80-0x9F undefined', MULTIPART, partType('text/plain; charset=TIS-620'), Buffer.from([0x80, 0xa1]), '\uFFFDก'],
    ['UTF-16LE', MULTIPART, partType('text/plain; charset=UTF-16LE'), Buffer.from('hello', 'utf16le'), 'hello'],
    ['UTF-16BE keeping a leading U+FEFF', MULTIPART, partType('text/plain; charset=UnicodeBigUnmarked'), Buffer.from([0xfe, 0xff, 0x00, 0x41]), '\uFEFFA'],
    ['UTF-16 and its big-endian mark', MULTIPART, partType('text/plain; charset=UTF-16'), Buffer.from([0xfe, 0xff, 0x00, 0x41]), 'A'],
    ['UTF-16 and its little-endian mark', MULTIPART, partType('text/plain; charset=UTF-16'), Buffer.from([0xff, 0xfe, 0x41, 0x00]), 'A'],
    ['UTF-16 without a mark as big-endian', MULTIPART, partType('text/plain; charset=unicode'), Buffer.from([0x00, 0x41, 0xff, 0xfe]), 'A\uFFFE'],
    ['UTF-16 with an unpaired surrogate and an odd byte', MULTIPART, partType('text/plain; charset=UTF-16'), Buffer.from([0xd8, 0x00, 0x00, 0x41, 0xdc, 0x00, 0x42]), '\uFFFD\uFFFD\uFFFD'],
    ['UTF-16 with a surrogate pair and a high surrogate left at the end', MULTIPART, partType('text/plain; charset=UTF-16'), Buffer.from([0xd8, 0x3d, 0xde, 0x00, 0xd8, 0x00, 0x41]), '\u{1F600}\uFFFD'],
    ['a windows-1252 request charset', 'multipart/form-data; charset=windows-1252; boundary=XyZ', disposition('v'), Buffer.from([0x80, 0xe9]), '€é'],
    ['x-MacRoman, keeping its private-use Apple logo', MULTIPART, partType('text/plain; charset=x-MacRoman'), Buffer.from([0x80, 0xdb, 0xf0]), 'Ä€\uF8FF'],
    ['a MacRoman request charset', 'multipart/form-data; charset=MacRoman; boundary=XyZ', disposition('v'), Buffer.from([0x8e, 0xa5]), 'é•'],
    ['x-IBM921 and its C1 control', MULTIPART, partType('text/plain; charset=cp921'), Buffer.from([0x80, 0xc0, 0xff]), '\u0080Ą’'],
    ['an IBM921 request charset', 'multipart/form-data; charset=ibm-921; boundary=XyZ', disposition('v'), Buffer.from([0xc0, 0xe0]), 'Ąą'],
  ])('decodes a text field with %s', (_case, contentType, headers, content, value) => {
    expect(bodyParamsFrom(contentType, multipart([[headers, content]]))).toEqual(read({ v: value }));
  });

  it.each([
    ['bogus-x', 'rejects'],
    ['"utf-8"', 'rejects'],
    [' utf-8', 'rejects'],
    ['utf-8 ', 'rejects'],
    ['UTF-32', 'decodes'],
    ['IBM037', 'decodes'],
    ['Shift_JIS', 'decodes'],
  ])('refuses a text field in the part charset %j, which legacy %s', (charset) => {
    expect(() => bodyParamsFrom(MULTIPART, multipart([[partType(`text/plain; charset=${charset}`), 'z']]))).toThrow(UnreadableBodyError);
  });

  const UTF8_E = Buffer.from('é');
  it.each<[string, string | undefined]>([
    ['charset=utf-8; charset=iso-8859-1', 'é'],
    ['charset=iso-8859-1; charset=utf-8', 'Ã©'],
    ['charset=', 'é'],
    ['charset=" "', 'é'],
    ['charset; charset=iso-8859-1', 'é'],
    ['Charset = ISO-8859-1', 'Ã©'],
    ['charset=\t iso-8859-1 \t', 'Ã©'],
    ['charset=iso"-8859-1"', 'Ã©'],
    ['charset=iso-8859-1, x', 'Ã©'],
    ['x=1, charset=iso-8859-1', 'é'],
    ['charset=\u00a0iso-8859-1', undefined],
    ['charset="iso-8859-1"x', undefined],
    ['charset=iso-8859-1 x', undefined],
    ['charset="iso\\-8859-1"', undefined],
    ['charset="iso-8859-1;x"', undefined],
    ['charset=" utf-8"', undefined],
  ])('reads the request charset of %j as legacy does', (params, value) => {
    const parse = (): object => bodyParamsFrom(`multipart/form-data; ${params}; boundary=XyZ`, multipart([[disposition('v'), UTF8_E]]));
    if (value === undefined) expect(parse).toThrow(UnreadableBodyError);
    else expect(parse()).toEqual(read({ v: value }));
  });

  it('decodes part names under a windows-1252 request charset', () => {
    const body = Buffer.concat([Buffer.from('--XyZ\r\nContent-Disposition: form-data; name="'), Buffer.from([0x80]), Buffer.from('"\r\n\r\n1\r\n--XyZ--\r\n')]);
    expect(bodyParamsFrom('multipart/form-data; charset=windows-1252; boundary=XyZ', body)).toEqual(read({ '€': '1' }));
  });

  const utf16be = (text: string): Buffer => Buffer.from(text, 'utf16le').swap16();
  it.each<[string, string, Buffer, Record<string, string> | undefined]>([
    ['an ASCII opening line and UTF-16 part lines', 'UTF-16', Buffer.concat([Buffer.from('--XyZ\r\n'), utf16be(`${disposition('v')}\r\n\r\nhi`), Buffer.from('\r\n--XyZ--\r\n')]), { v: 'hi' }],
    ['ASCII lines, whose part headers then run to the end', 'UTF-16', A1, {}],
    ['a UTF-16 opening line', 'UTF-16', Buffer.concat([utf16be(`--XyZ\r\n${disposition('v')}\r\n\r\nhi`), Buffer.from('\r\n--XyZ--\r\n')]), undefined],
    ['UTF-16LE part lines, each opening with the last byte of the line end before', 'UTF-16LE', Buffer.concat([Buffer.from('--XyZ\r\n'), Buffer.from(`${disposition('v')}\r\n\r\nhi`, 'utf16le'), Buffer.from('\r\n--XyZ--\r\n')]), {}],
  ])('reads a UTF-16 request charset body of %s as legacy does', (_case, charset, body, form) => {
    const parse = (): object => bodyParamsFrom(`multipart/form-data; charset=${charset}; boundary=XyZ`, body);
    if (form === undefined) expect(parse).toThrow(UnreadableBodyError);
    else expect(parse()).toEqual(read(form));
  });

  const FFFD = '\uFFFD';
  it.each<[string, number[], string]>([
    ['an encoded surrogate as one U+FFFD', [0xed, 0xa0, 0x80], FFFD],
    ['a truncated encoded surrogate before a character', [0xed, 0xa0, 0x78], `${FFFD}x`],
    ['a truncated encoded surrogate at the end', [0x78, 0xed, 0xa0], `x${FFFD}`],
    ['a low surrogate beside a three-byte character', [0xed, 0xbf, 0xbf, 0xed, 0x9f, 0xbf], `${FFFD}\uD7FF`],
    [
      'encoded surrogates after truncated sequences',
      [0xe2, 0xed, 0xa0, 0x80, 0xc3, 0xed, 0xb0, 0x80, 0xf0, 0x9f, 0xed, 0xa0, 0x80, 0xed],
      FFFD.repeat(7),
    ],
    [
      'other malformed sequences',
      [0xc3, 0x7c, 0xf0, 0x9f, 0x98, 0x7c, 0xe0, 0x80, 0x80, 0x7c, 0xf4, 0x90, 0x80, 0x80, 0x7c, 0xff, 0x7c, 0xc0, 0xaf, 0x7c, 0xf5, 0x80, 0x80, 0x80, 0x7c, 0xf0, 0x80, 0x80, 0x80, 0x7c, 0xe2, 0x82],
      [1, 1, 3, 4, 1, 2, 4, 4, 1].map((n) => FFFD.repeat(n)).join('|'),
    ],
  ])('decodes UTF-8 with %s as Java does', (_case, bytes, value) => {
    expect(bodyParamsFrom(MULTIPART, multipart([[disposition('a'), Buffer.from(bytes)]]))).toEqual(read({ a: value }));
  });

  it('decodes a part header line as Java does', () => {
    const body = Buffer.concat([Buffer.from(`--XyZ\r\n${disposition('a').slice(0, -1)}`), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('b"\r\n\r\n1\r\n--XyZ--\r\n')]);
    expect(bodyParamsFrom(MULTIPART, body)).toEqual(read({ [`a${FFFD}b`]: '1' }));
  });

  it.each([
    ['at content offset 65,536 of one line is found', `${'a'.repeat(65536)}--XyZtail`, 'a'.repeat(65534)],
    ['at content offset 65,535 of one line is not found', `${'a'.repeat(65535)}--XyZtail`, `${'a'.repeat(65535)}--XyZtail`],
    ['at the start of a later 64 KiB fill is found', `${'b'.repeat(29999)}\n${'c'.repeat(35536)}--XyZq`, `${'b'.repeat(29999)}\n${'c'.repeat(35534)}`],
  ])('a boundary %s', (_case, content, size) => {
    const body = multipart([
      [disposition('size'), content],
      [disposition('after'), 'z'],
    ]);
    expect(bodyParamsFrom(MULTIPART, body)).toEqual(read({ size, after: 'z' }));
  });

  const NAME_PREFIX = 'Content-Disposition: form-data; name="';
  it.each<[string, string, Record<string, string>]>([
    ['a part header line of exactly 8 KiB, which takes in the blank line', `--XyZ\r\n${disposition('a')}\r\nX-Pad: ${'a'.repeat(8183)}\r\n\r\n1\r\n--XyZ--\r\n`, {}],
    ['a part header line one byte under 8 KiB', `--XyZ\r\n${disposition('a')}\r\nX-Pad: ${'a'.repeat(8182)}\r\n\r\n1\r\n--XyZ--\r\n`, { a: '1' }],
    ['a first line of exactly 8 KiB, which takes in the part headers', `--XyZ${' '.repeat(8185)}\r\n${disposition('a')}\r\n\r\n1\r\n--XyZ--\r\n`, {}],
    [
      'a character split by the 8 KiB chunk end',
      `--XyZ\r\n${NAME_PREFIX}${'a'.repeat(8191 - NAME_PREFIX.length)}é"\r\n\r\n1\r\n--XyZ--\r\n`,
      { [`${'a'.repeat(8191 - NAME_PREFIX.length)}${FFFD}${FFFD}`]: '1' },
    ],
    ['a delimiter followed by other characters', `${FIRST_PART}--XyZjunk\r\n${disposition('b')}\r\n\r\n2\r\n--XyZ--`, { a: '1', b: '2' }],
    ['transport padding after a delimiter', `--XyZ  \r\n${disposition('a')}\r\n\r\n1\r\n--XyZ--\r\n`, { a: '1' }],
    ['a part after the close delimiter', `${FIRST_PART}--XyZ--\r\n${disposition('late')}\r\n\r\nx\r\n--XyZ--\r\n`, { a: '1', late: 'x' }],
    ['an epilogue line and a part after the close delimiter', `${FIRST_PART}--XyZ--\r\nepilogue\r\n--XyZ\r\n${disposition('late')}\r\n\r\nx\r\n--XyZ--`, { a: '1', late: 'x' }],
    ['text after the close delimiter', `${FIRST_PART}--XyZ--\r\njunk\r\n`, { a: '1' }],
    ['a close delimiter without a line end', `${FIRST_PART}--XyZ--`, { a: '1' }],
    ['unterminated part headers', `${FIRST_PART}--XyZ\r\n${disposition('b')}\r\n`, { a: '1' }],
    ['unterminated part headers without a disposition', `${FIRST_PART}--XyZ\r\nContent-Type: text/plain\r\n`, { a: '1' }],
    ['a delimiter after a bare LF in the content', `--XyZ\r\n${disposition('notes')}\r\n\r\nabc\n--XyZ\r\n${disposition('inj')}\r\n\r\nINJ\r\n--XyZ--\r\n`, { notes: 'ab', inj: 'INJ' }],
    ['a delimiter inside a content line', `--XyZ\r\n${disposition('notes')}\r\n\r\nline1\r\nline2 with --XyZ inside\r\n--XyZ--\r\n`, { notes: 'line1\r\nline2 with --XyZ inside' }],
    ['bare LF line ends', `--XyZ\n${disposition('a')}\n\n1\n--XyZ--\n`, { a: '' }],
    ['a content of one LF', `--XyZ\r\n${disposition('a')}\r\n\r\n\n--XyZ--\r\n`, { a: '' }],
    ['a bare CR in the content', `--XyZ\r\n${disposition('a')}\r\n\r\nx\ry\r\n--XyZ--\r\n`, { a: 'x\ry' }],
    ['a blank line after the first delimiter', `--XyZ\r\n\r\n${disposition('a')}\r\n\r\n1\r\n--XyZ--\r\n`, {}],
    ['only a delimiter', '--XyZ', {}],
    ['only a close delimiter', '--XyZ--', {}],
    [
      'a boundary line longer than the part buffer has room for',
      `--XyZ\r\n${disposition('a')}\r\n\r\n${'q'.repeat(65520)}\n--XyZ${'j'.repeat(70)}\r\n${disposition('b')}\r\n\r\n2\r\n--XyZ--\r\n`,
      { a: 'q'.repeat(65519), b: '2' },
    ],
  ])('reads %s as legacy does', (_case, body, form) => {
    expect(bodyParamsFrom(MULTIPART, Buffer.from(body))).toEqual(read(form));
  });

  it.each<[string, string | Buffer, string?]>([
    ['a preamble', `see --XyZ below\r\n${A1.toString()}`],
    ['a leading CRLF', `\r\n${A1.toString()}`],
    ['no delimiter', 'just text --XyZ\r\nmore'],
    ['a blank first line', '\r\n'],
    ['a first line without the boundary', 'x'],
    ['a first part without a closing delimiter', FIRST_PART],
    ['a last part without a closing delimiter', `${FIRST_PART}--XyZ\r\n${disposition('b')}\r\n\r\n2`],
    ['a file part without a closing delimiter', `${FIRST_PART}--XyZ\r\n${disposition('f')}; filename="x.png"\r\n\r\nbytes`],
    ['a CR before the close delimiter', `--XyZ\r\n${disposition('a')}\r\n\r\nab\r--XyZ--\r\n`],
    ['a non-ASCII boundary', multipart([[disposition('a'), '1']], 'X\u00e9Z'), 'multipart/form-data; boundary=X\u00e9Z'],
    ['a non-ASCII boundary in ISO-8859-1', Buffer.from(`--X\u00e9Z\r\n${disposition('a')}\r\n\r\n1\r\n--X\u00e9Z--\r\n`, 'latin1'), 'multipart/form-data; charset=iso-8859-1; boundary=X\u00e9Z'],
    ['a non-ASCII boundary without parts', '--X\u00e9Z\r\n', 'multipart/form-data; boundary=X\u00e9Z'],
  ])('refuses a body with %s', (_case, body, contentType = MULTIPART) => {
    expect(() => bodyParamsFrom(contentType, Buffer.from(body))).toThrow(UnreadableBodyError);
  });

  it.each([
    ['no disposition', 'Content-Type: text/plain'],
    ['a disposition without a blank after its colon', 'Content-Disposition:form-data; name="a"'],
    ['a blank before the semicolon', 'Content-Disposition: form-data ; name="a"'],
    ['a blank before the colon', 'Content-Disposition : form-data; name="a"'],
    ['a blank-led first line', ' Content-Disposition: form-data; name="lead"'],
    ['no semicolon', 'Content-Disposition: form-data'],
    ['a semicolon at the colon', 'Content-Disposition:; name="a"'],
    ['an attachment disposition', 'Content-Disposition: attachment; name="x"'],
    ['an unquoted name', 'Content-Disposition: form-data; name=bare'],
    ['blanks after `=`', 'Content-Disposition: form-data; name=\t "spaced"'],
    ['an unterminated name quote', 'Content-Disposition: form-data; name="tail'],
    ['a name ending past the line once dotted capital Is lengthen it', 'Content-Disposition: form-data; name="\u0130\u0130x"'],
    ['dotted capital Is before the name pushing its end past the line', 'Content-Disposition: form-data; x="\u0130\u0130"; name="abc"'],
    ['a content type without a blank', `${disposition('a')}\r\nContent-Type:text/plain`],
    ['a content type with a tab', `${disposition('a')}\r\nContent-Type:\ttext/plain`],
  ])('refuses a part with %s', (_case, headers) => {
    expect(() => bodyParamsFrom(MULTIPART, multipart([[headers, '1']]))).toThrow(UnreadableBodyError);
  });

  const huge = (length: number, content: string): [string, Buffer] => {
    const boundary = 'b'.repeat(length);
    return [`multipart/form-data; boundary=${boundary}`, Buffer.from(`--${boundary}\r\n${disposition('a')}\r\n\r\n${content}--${boundary}--\r\n`)];
  };
  it.each([
    [65540, '1\r\n', ''],
    [65531, 'ab\r\n', 'ab'],
    [65530, '\n\n', ''],
  ])('ends the part after one fill under a %i-character boundary', (length, content, value) => {
    expect(bodyParamsFrom(...huge(length, content))).toEqual(read({ a: value }));
  });

  it('refuses a part whose one fill holds a single byte', () => {
    expect(() => bodyParamsFrom(...huge(65531, '\n'))).toThrow(UnreadableBodyError);
  });

  it('keeps `__proto__` as a data key', () => {
    const { form } = bodyParamsFrom(MULTIPART, multipart([[disposition('__proto__'), 'p'], [disposition('__proto__'), 'q']]));
    expect(Object.hasOwn(form, '__proto__')).toBe(true);
    expect(form['__proto__']).toBe('p,q');
    expect(Object.getPrototypeOf(form)).toBe(Object.prototype);
  });

  it.each([
    ['read', multipart([[disposition('a'), 'x'.repeat(70000)], [`${disposition('f')}; filename="f.bin"`, Buffer.alloc(70000, 0xed)]])],
    ['refused', Buffer.from(`${FIRST_PART}--XyZ\r\n${disposition('f')}; filename="x.png"\r\n\r\n${'\u00e9'.repeat(40000)}`)],
  ])('leaves a %s body byte-identical', (outcome, body) => {
    const original = Buffer.from(body);
    const parse = (): unknown => bodyParamsFrom(MULTIPART, body);
    if (outcome === 'read') parse();
    else expect(parse).toThrow(UnreadableBodyError);
    expect(body.equals(original)).toBe(true);
  });
});

describe('bodyParamsFrom facts for the route key', () => {
  const variants: VariantDeclaration[] = [{ route: 'admin:cusers.update', variant: 'photo', when: [PHOTO_CONDITION] }];

  it.each([
    ['a 65,537-byte newFile text field', 'x'.repeat(65537), 'admin:cusers.update{photo}'],
    ['an empty newFile text field', '', 'admin:cusers.update'],
  ])('keys a multipart user save with %s', (_case, newFile, key) => {
    const body = multipart([
      [disposition('muraAction'), 'cUsers.update'],
      [disposition('newFile'), newFile],
      [disposition('after'), 'z'],
    ]);
    const { form, files } = bodyParamsFrom(MULTIPART, body, 'POST');
    const request = { method: 'POST', path: '/admin/', query: {}, form, headers: { 'content-type': MULTIPART }, multipartFileNames: files };
    expect(routeKeyForRequest(request, { variants }).key).toBe(key);
  });
});

describe('paramValue', () => {
  it.each([
    [{ Method: 'a', METHOD: 'b' }, 'b'],
    [{ method: 'a', MeThOd: { nested: true } }, undefined],
    [{ other: 'x' }, undefined],
  ])('matches names ignoring case, the last spelling winning: %j', (params, expected) => {
    expect(paramValue(params, 'method')).toBe(expected);
  });

  it.each<[string, unknown, string | undefined]>([
    ['a string as itself', 'text', 'text'],
    ['a number as its text', 3.5, '3.5'],
    ['true as its text', true, 'true'],
    ['false as its text', false, 'false'],
    ['a bigint as its text', 10n, '10'],
    ['null as an empty string', null, ''],
    ['an object as undefined', { a: 1 }, undefined],
    ['an array as undefined', [1, 2], undefined],
    ['undefined as undefined', undefined, undefined],
  ])('reads %s', (_case, value, expected) => {
    expect(paramValue({ v: value }, 'V')).toBe(expected);
  });
});

describe('tokenFromParams', () => {
  type Headers = Record<string, string | string[] | undefined>;
  type Pair = { token: string; expires?: string } | undefined;
  const FIELDS = { [CSRF_FIELD_TOKEN]: 'TOKEN-F', [CSRF_FIELD_EXPIRES]: 'EXP-F' };
  const HEADERS = { [CSRF_HEADER_TOKEN]: 'TOKEN-H', [CSRF_HEADER_EXPIRES]: 'EXP-H' };
  const FIELD_PAIR = { token: 'TOKEN-F', expires: 'EXP-F' };
  const HEADER_PAIR = { token: 'TOKEN-H', expires: 'EXP-H' };

  it.each<[string, Record<string, unknown>, Headers, Pair]>([
    ['the header pair over the field pair', FIELDS, HEADERS, HEADER_PAIR],
    ['the field token with the header expiry', FIELDS, { [CSRF_HEADER_EXPIRES]: 'EXP-H' }, { token: 'TOKEN-F', expires: 'EXP-H' }],
    ['the header token with the field expiry', FIELDS, { [CSRF_HEADER_TOKEN]: 'TOKEN-H' }, { token: 'TOKEN-H', expires: 'EXP-F' }],
    ['no token for an empty header token', FIELDS, { [CSRF_HEADER_TOKEN]: '' }, undefined],
    ['no token for an empty header list', FIELDS, { [CSRF_HEADER_TOKEN]: [] }, undefined],
    ['no expiry for an empty header expiry', FIELDS, { [CSRF_HEADER_EXPIRES]: '' }, { token: 'TOKEN-F' }],
    ['the header pair alone', {}, HEADERS, HEADER_PAIR],
    ['the field pair alone', FIELDS, {}, FIELD_PAIR],
    ['params already carrying the headers', { [CSRF_FIELD_TOKEN]: 'TOKEN-H', [CSRF_FIELD_EXPIRES]: 'EXP-H' }, HEADERS, HEADER_PAIR],
    [
      'header names ignoring case',
      {},
      { [CSRF_HEADER_TOKEN.toLowerCase()]: 'TOKEN-H', [CSRF_HEADER_EXPIRES.toUpperCase()]: 'EXP-H' },
      HEADER_PAIR,
    ],
    [
      'field names ignoring case',
      { [CSRF_FIELD_TOKEN.toUpperCase()]: 'TOKEN-F' },
      { [CSRF_HEADER_EXPIRES.toLowerCase()]: 'EXP-H' },
      { token: 'TOKEN-F', expires: 'EXP-H' },
    ],
    ['repeated header values joined', {}, { [CSRF_HEADER_TOKEN]: ['T1', 'T2'] }, { token: 'T1, T2' }],
    [
      'a defined header spelling past an undefined one',
      FIELDS,
      { [CSRF_HEADER_TOKEN]: undefined, [CSRF_HEADER_TOKEN.toLowerCase()]: 'TOKEN-H' },
      { token: 'TOKEN-H', expires: 'EXP-F' },
    ],
    ['the field pair past undefined headers', FIELDS, { [CSRF_HEADER_TOKEN]: undefined, [CSRF_HEADER_EXPIRES]: undefined }, FIELD_PAIR],
    ['the header token over a complex field', { [CSRF_FIELD_TOKEN]: ['TOKEN-F'] }, { [CSRF_HEADER_TOKEN]: 'TOKEN-H' }, { token: 'TOKEN-H' }],
    ['no token anywhere', {}, {}, undefined],
  ])('family api reads %s', (_case, params, headers, expected) => {
    expect(tokenFromParams(params, headers, 'api')).toStrictEqual(expected);
  });

  const NON_API_CASES: ReadonlyArray<[string, Record<string, unknown>, Pair]> = [
    ['the field pair over the header pair', FIELDS, FIELD_PAIR],
    ['the field token without the header expiry', { [CSRF_FIELD_TOKEN]: 'TOKEN-F' }, { token: 'TOKEN-F' }],
    ['no token from the header pair alone', {}, undefined],
    ['no token from an empty field and the header pair', { [CSRF_FIELD_TOKEN]: '' }, undefined],
  ];
  it.each((['admin', 'page', 'rest', 'cfc'] as const).flatMap((family) => NON_API_CASES.map((row) => [family, ...row] as const)))(
    'family %s reads %s',
    (family, _case, params, expected) => {
      expect(tokenFromParams(params, HEADERS, family)).toStrictEqual(expected);
    },
  );

  it.each<[string, Record<string, unknown>, Pair]>([
    ['no expiry', { [CSRF_FIELD_TOKEN]: 'TOKEN-F' }, { token: 'TOKEN-F' }],
    ['an empty expiry', { [CSRF_FIELD_TOKEN]: 'TOKEN-F', [CSRF_FIELD_EXPIRES]: '' }, { token: 'TOKEN-F' }],
    ['upper-case names', { [CSRF_FIELD_TOKEN.toUpperCase()]: 'TOKEN-F', [CSRF_FIELD_EXPIRES.toUpperCase()]: 'EXP-F' }, FIELD_PAIR],
    ['a numeric token', { [CSRF_FIELD_TOKEN]: 123 }, { token: '123' }],
    ['a complex token as none', { [CSRF_FIELD_TOKEN]: ['TOKEN-F'] }, undefined],
    ['an expiry alone as none', { [CSRF_FIELD_EXPIRES]: 'EXP-F' }, undefined],
  ])('family admin reads the field token with %s', (_case, params, expected) => {
    expect(tokenFromParams(params, {}, 'admin')).toStrictEqual(expected);
  });
});
