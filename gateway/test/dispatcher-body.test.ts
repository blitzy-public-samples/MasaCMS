import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
} from '@opt2/platform/legacy-compat';
import { EMPTY_BODY_PARAMS, bodyParamsFrom, paramValue, tokenFromParams } from '../src/dispatcher/body.js';

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
    ['multipart/form-data', `${FIRST_PART}--XyZ--`],
    ['multipart/form-data; boundary=', `${FIRST_PART}--XyZ--`],
    ['multipart/form-data; boundary=""', `${FIRST_PART}--XyZ--`],
  ])('reads nothing for content type %j', (contentType, body) => {
    expect(bodyParamsFrom(contentType, Buffer.from(body))).toBe(EMPTY_BODY_PARAMS);
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
      [disposition('tag'), ''],
      [disposition('tag'), 'c'],
    ]);
    expect(bodyParamsFrom(MULTIPART, body).form).toEqual({ tag: 'a,,c' });
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
    ['Multipart/Form-Data; BOUNDARY=XyZ', 'XyZ'],
    ['multipart/form-data; charset=utf-8; boundary=----WebKitFormBoundary7MA4', '----WebKitFormBoundary7MA4'],
  ])('finds the boundary in %j', (contentType, boundary) => {
    expect(bodyParamsFrom(contentType, multipart([[disposition('a'), '1']], boundary)).form).toEqual({ a: '1' });
  });

  it.each([
    [65536, { size: 'x'.repeat(65536), after: 'z' }],
    [65537, { after: 'z' }],
  ])('reads a %i-byte text part only within 64 KiB', (size, expected) => {
    const body = multipart([
      [disposition('size'), 'x'.repeat(size)],
      [disposition('after'), 'z'],
    ]);
    expect(bodyParamsFrom(MULTIPART, body).form).toEqual(expected);
  });

  it.each([
    [10236, { before: 'ok', big: 'v', after: 'z' }],
    [10239, { before: 'ok' }],
  ])('reads %i bytes of part headers only within the 10 KiB limit', (length, expected) => {
    const body = multipart([
      [disposition('before'), 'ok'],
      [headersOfLength('big', length), 'v'],
      [disposition('after'), 'z'],
    ]);
    expect(bodyParamsFrom(MULTIPART, body).form).toEqual(expected);
  });

  it.each([
    ['no disposition', 'Content-Type: text/plain'],
    ['a non form-data disposition', 'Content-Disposition: attachment; name="x"'],
    ['a disposition without a name', 'Content-Disposition: form-data; filename="x.txt"'],
  ])('skips a part with %s', (_case, headers) => {
    const body = multipart([
      [headers, 'skipped'],
      [disposition('kept'), 'k'],
    ]);
    expect(bodyParamsFrom(MULTIPART, body)).toEqual({ form: { kept: 'k' }, json: undefined, files: [] });
  });

  it.each([
    ['a folded line', 'Content-Disposition: form-data;\r\n\tname="folded"', { folded: '1' }],
    ['a valueless parameter first', 'Content-Disposition: form-data; flag; name="n"', { n: '1' }],
    ['a valueless parameter last', 'Content-Disposition: form-data; name="n"; flag', { n: '1' }],
    ['blanks after `=`', 'Content-Disposition: form-data; name=\t "spaced"', { spaced: '1' }],
    ['upper-case names', 'CONTENT-DISPOSITION: FORM-DATA; NAME="upper"', { upper: '1' }],
    ['an unquoted value', 'Content-Disposition: form-data; name=bare ; x=y', { bare: '1' }],
    ['an escaped quote', 'Content-Disposition: form-data; name="say \\"hi\\""', { 'say \\"hi\\"': '1' }],
    ['a parameter without a name', 'Content-Disposition: form-data; =orphan; name="n"', { n: '1' }],
    ['an unterminated quote', 'Content-Disposition: form-data; name="tail', { tail: '1' }],
    ['lines without a header name', 'garbage line\r\n: no name\r\nContent-Disposition: form-data; name="n"', { n: '1' }],
    ['a blank-led first line', ' Content-Disposition: form-data; name="lead"', { lead: '1' }],
  ])('reads the disposition with %s', (_case, headers, expected) => {
    expect(bodyParamsFrom(MULTIPART, multipart([[headers, '1']])).form).toEqual(expected);
  });

  it.each([
    ['a Windows path', 'Content-Disposition: form-data; name="q"; filename="C:\\dir\\photo.JPG"', 'q', 'C:\\dir\\photo.JPG'],
    ['text after a quoted value', 'Content-Disposition: form-data; name="j" trailing; filename="j.txt"', 'j', 'j.txt'],
  ])('reads the file name after %s', (_case, headers, field, filename) => {
    expect(bodyParamsFrom(MULTIPART, multipart([[headers, 'bytes']])).files).toEqual([{ field, filename }]);
  });

  it('keeps `__proto__` as a data key', () => {
    const { form } = bodyParamsFrom(MULTIPART, multipart([[disposition('__proto__'), 'p'], [disposition('__proto__'), 'q']]));
    expect(Object.hasOwn(form, '__proto__')).toBe(true);
    expect(form['__proto__']).toBe('p,q');
    expect(Object.getPrototypeOf(form)).toBe(Object.prototype);
  });

  it('skips a preamble up to the first CRLF-led delimiter', () => {
    const body = Buffer.concat([Buffer.from('see --XyZ below\r\n'), multipart([[disposition('a'), '1']])]);
    expect(bodyParamsFrom(MULTIPART, body).form).toEqual({ a: '1' });
  });

  it('ignores the epilogue after the close delimiter', () => {
    const body = Buffer.concat([
      multipart([[disposition('a'), '1']]),
      Buffer.from(`epilogue\r\n--XyZ\r\n${disposition('late')}\r\n\r\nx\r\n--XyZ--`),
    ]);
    expect(bodyParamsFrom(MULTIPART, body).form).toEqual({ a: '1' });
  });

  it.each([
    ['a missing delimiter', 'just text --XyZ\r\nmore', {}],
    ['bare LF line ends', `--XyZ\n${disposition('a')}\n\n1\n--XyZ--\n`, {}],
    ['a delimiter followed by other characters', `${FIRST_PART}--XyZjunk\r\n${disposition('b')}\r\n\r\n2\r\n--XyZ--`, { a: '1' }],
    ['unterminated part headers', `${FIRST_PART}--XyZ\r\n${disposition('b')}\r\n`, { a: '1' }],
    ['a last part without a closing delimiter', `${FIRST_PART}--XyZ\r\n${disposition('b')}\r\n\r\n2`, { a: '1' }],
  ])('reads only the parts before %s', (_case, body, form) => {
    expect(bodyParamsFrom(MULTIPART, Buffer.from(body))).toEqual({ form, json: undefined, files: [] });
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
  it('takes the field token with its expiry', () => {
    const params = { [CSRF_FIELD_TOKEN]: 'TOKEN-F', [CSRF_FIELD_EXPIRES]: 'EXP-F' };
    expect(tokenFromParams(params, { [CSRF_HEADER_TOKEN]: 'TOKEN-H' })).toStrictEqual({ token: 'TOKEN-F', expires: 'EXP-F' });
  });

  it.each([
    ['no expiry', { [CSRF_FIELD_TOKEN]: 'TOKEN-F' }, { token: 'TOKEN-F' }],
    ['an empty expiry', { [CSRF_FIELD_TOKEN]: 'TOKEN-F', [CSRF_FIELD_EXPIRES]: '' }, { token: 'TOKEN-F' }],
    [
      'upper-case names',
      { [CSRF_FIELD_TOKEN.toUpperCase()]: 'TOKEN-F', [CSRF_FIELD_EXPIRES.toUpperCase()]: 'EXP-F' },
      { token: 'TOKEN-F', expires: 'EXP-F' },
    ],
    ['a numeric token', { [CSRF_FIELD_TOKEN]: 123 }, { token: '123' }],
  ])('reads the field token with %s', (_case, params, expected) => {
    expect(tokenFromParams(params, {})).toStrictEqual(expected);
  });

  it.each([
    ['no field', {}],
    ['an empty field', { [CSRF_FIELD_TOKEN]: '' }],
    ['a complex field', { [CSRF_FIELD_TOKEN]: ['TOKEN-F'] }],
    ['a field expiry alone', { [CSRF_FIELD_EXPIRES]: 'EXP-F' }],
  ])('falls back to the header pair with %s', (_case, params) => {
    const headers = { [CSRF_HEADER_TOKEN.toLowerCase()]: 'TOKEN-H', [CSRF_HEADER_EXPIRES.toUpperCase()]: 'EXP-H' };
    expect(tokenFromParams(params, headers)).toStrictEqual({ token: 'TOKEN-H', expires: 'EXP-H' });
  });

  it.each([
    ['joins repeated header values', { [CSRF_HEADER_TOKEN]: ['T1', 'T2'] }, { token: 'T1, T2' }],
    [
      'skips an undefined spelling',
      { [CSRF_HEADER_TOKEN]: undefined, [CSRF_HEADER_TOKEN.toLowerCase()]: 'TOKEN-H' },
      { token: 'TOKEN-H' },
    ],
    ['drops an empty header expiry', { [CSRF_HEADER_TOKEN]: 'TOKEN-H', [CSRF_HEADER_EXPIRES]: '' }, { token: 'TOKEN-H' }],
  ])('%s', (_case, headers, expected) => {
    expect(tokenFromParams({}, headers)).toStrictEqual(expected);
  });

  it.each([
    ['no token anywhere', {}],
    ['an empty header', { [CSRF_HEADER_TOKEN]: '' }],
    ['an empty header list', { [CSRF_HEADER_TOKEN]: [] }],
    ['only an undefined header', { [CSRF_HEADER_TOKEN]: undefined }],
  ])('returns undefined with %s', (_case, headers) => {
    expect(tokenFromParams({}, headers)).toBeUndefined();
  });
});
