// The default Content-Language comes from the MURA_LOCALE setting, so every suite pins it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_ERROR_PAGE_HTML } from '@opt2/platform/legacy-compat';
import { resetLegacySettingsForTests } from '@/lib/env';
import { html, raw } from '@/lib/html';
import {
  HTML_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  NO_CACHE_HEADERS,
  contentLanguage,
  downloadResponse,
  fw1Redirect,
  htmlResponse,
  isCompactDisplay,
  jsonResponse,
  legacyPageHeaders,
  legacyUnavailable,
  negotiatesIdentityEncoding,
  notFound,
  withSetCookies,
  type LegacyResponseContext,
} from '@/lib/responses';

const bytes = [0, 255, 1];

const builders: Array<[string, (context?: LegacyResponseContext) => Response]> = [
  ['htmlResponse', (context) => htmlResponse('<p>x</p>', { context })],
  ['jsonResponse', (context) => jsonResponse('{}', { context })],
  ['downloadResponse', (context) => downloadResponse({ status: 200, headers: {}, body: 'a' }, context)],
  ['fw1Redirect', (context) => fw1Redirect('./', { context })],
  ['legacyUnavailable', (context) => legacyUnavailable(context)],
  ['notFound', (context) => notFound(context)],
];

const pinLocale = (locale: string): void => {
  vi.stubEnv('MURA_LOCALE', locale);
  resetLegacySettingsForTests();
};

beforeEach(() => pinLocale('Server'));

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('responses', () => {
  it.each(builders)('%s carries the onRequestStart headers', (_name, build) => {
    const res = build();
    expect(res.headers.get('generator')).toBe('Masa CMS 7.6.1');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=1200');
  });

  describe.each(builders)('%s container headers', (_name, build) => {
    it('sends the configured locale as Content-Language and no Content-Encoding by default', () => {
      const res = build();
      expect(res.headers.get('content-language')).toBe('en-US');
      expect(res.headers.get('content-encoding')).toBeNull();
    });

    it.each<[LegacyResponseContext, string]>([
      [{ locale: 'de_DE' }, 'de-DE'],
      [{ locale: '' }, 'en-US'],
    ])('sends Content-Language for %o', (context, expected) => {
      expect(build(context).headers.get('content-language')).toBe(expected);
    });

    it('follows a configured locale setting', () => {
      pinLocale('German (Standard)');
      expect(build().headers.get('content-language')).toBe('de-DE');
    });

    it.each<[string | null, string | null]>([
      ['identity', 'identity'],
      ['gzip, deflate', null],
      [null, null],
    ])('answers Accept-Encoding %j with Content-Encoding %j', (acceptEncoding, expected) => {
      expect(build({ acceptEncoding }).headers.get('content-encoding')).toBe(expected);
    });
  });

  describe('isCompactDisplay', () => {
    it.each([
      'true', 'TRUE', 'TrUe', 'yes', 'Yes', ' yes', 'yes ', '1', '1.0', '01', '1e0', '1E0', '+1', '.1e1', '1e-0',
      '100e-2', ' 1', '1 ', '\t1', '1\0',
    ])('selects the compact layout for %j', (value) => {
      expect(isCompactDisplay(value)).toBe(true);
    });

    it.each([
      null, undefined, '', ' ', 'false', 'no', 'on', 't', 'y', '2', '-1', '0', '0.5', '1.', '1d', '1f', '0x1', ' true',
      'true ', '\ttrue', 'true,false', 'yes,no',
    ])('keeps the full layout for %j', (value) => {
      expect(isCompactDisplay(value)).toBe(false);
    });
  });

  describe('negotiatesIdentityEncoding', () => {
    it.each([
      'identity', 'identity, gzip', 'gzip, identity', '*', 'identity;q=0.001', 'identity ;q=1',
      'gzip;q=0.5, identity;q=0.1', 'br, identity;q=0.5', '*, gzip;q=0', 'identity, *;q=0',
    ])('negotiates identity for %j', (value) => {
      expect(negotiatesIdentityEncoding(value)).toBe(true);
    });

    it.each([
      'IDENTITY', 'gzip', 'deflate', 'gzip, deflate', 'br', '', null, undefined, 'identity;q=0', 'identity;q=0.000',
      'identity;q=0.0000', 'identity;q=', 'gzip;q=0, identity;q=0',
    ])('negotiates nothing for %j', (value) => {
      expect(negotiatesIdentityEncoding(value)).toBe(false);
    });
  });

  it.each([
    ['en_US', 'en-US'],
    ['de_DE', 'de-DE'],
    ['zh_TW', 'zh-TW'],
    ['ja_JP_JP', 'ja-JP'],
    ['iw_IL', 'he-IL'],
    ['ji_US', 'yi-US'],
    ['in_ID', 'id-ID'],
    ['EN_us', 'en-US'],
    ['de', 'de-'],
  ])('contentLanguage(%j) is %j', (javaLocale, expected) => {
    expect(contentLanguage(javaLocale)).toBe(expected);
  });

  describe('legacyPageHeaders', () => {
    it.each<[string, boolean]>([
      ['', true],
      ['compactDisplay=false', true],
      ['compactDisplay=true', false],
      ['compactDisplay=Yes', false],
      ['COMPACTDISPLAY=1', false],
      ['compactdisplay=true&muraAction=carch.list', false],
      ['compactDisplay=true&compactDisplay=false', true],
      ['compactDisplay=true&COMPACTDISPLAY=true', true],
    ])('answers ?%s with the full layout cache headers: %s', (query, full) => {
      const headers = legacyPageHeaders(new URLSearchParams(query), new Headers());
      expect(headers.get('expires')).toBe(full ? '06 Nov 1994 08:37:34 GMT' : null);
      expect(headers.get('cache-control')).toBe(full ? 'no-cache, no-store, must-revalidate' : null);
      expect(headers.get('generator')).toBe('Masa CMS 7.6.1');
      expect(headers.get('strict-transport-security')).toBe('max-age=1200');
      expect(headers.get('content-language')).toBe('en-US');
    });

    it.each<[string, string | null]>([
      ['identity', 'identity'],
      ['gzip, deflate', null],
    ])('answers Accept-Encoding %j with Content-Encoding %j', (acceptEncoding, expected) => {
      const headers = legacyPageHeaders(new URLSearchParams(), new Headers({ 'accept-encoding': acceptEncoding }));
      expect(headers.get('content-encoding')).toBe(expected);
    });
  });

  describe('htmlResponse', () => {
    it('sends the markup as cfm output', async () => {
      const res = htmlResponse('<p>é</p>');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html;charset=UTF-8');
      expect(HTML_CONTENT_TYPE).toBe('text/html;charset=UTF-8');
      expect(res.headers.get('cache-control')).toBeNull();
      expect(res.headers.get('expires')).toBeNull();
      expect(await res.text()).toBe('<p>é</p>');
    });

    it('adds the template.cfm cache headers with noCache', () => {
      const res = htmlResponse('<p>x</p>', { noCache: true });
      expect(res.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
      expect(res.headers.get('expires')).toBe('06 Nov 1994 08:37:34 GMT');
      expect({ ...NO_CACHE_HEADERS }).toEqual({
        'cache-control': 'no-cache, no-store, must-revalidate',
        expires: '06 Nov 1994 08:37:34 GMT',
      });
    });

    it('honours status, contentType and headers', async () => {
      const res = htmlResponse('x', {
        status: 400,
        contentType: 'text/plain',
        headers: [
          ['x-a', '1'],
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
        ],
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toBe('text/plain');
      expect(res.headers.get('x-a')).toBe('1');
      expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
      expect(await res.text()).toBe('x');
    });

    it.each([
      ['html', html`<b>${'<x>'}</b>`, '<b>&lt;x&gt;</b>'],
      ['raw', raw('<i>r</i>'), '<i>r</i>'],
    ])('accepts SafeHtml from %s', async (_name, body, expected) => {
      expect(await htmlResponse(body).text()).toBe(expected);
    });
  });

  describe('jsonResponse', () => {
    it('sends the body text unchanged with the loadsitemanager content type', async () => {
      const res = jsonResponse('{"a":1, "b" : 2}');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json;charset=utf-8');
      expect(JSON_CONTENT_TYPE).toBe('application/json;charset=utf-8');
      expect(await res.text()).toBe('{"a":1, "b" : 2}');
    });

    it('honours status, contentType and headers', () => {
      const res = jsonResponse('[]', { status: 201, contentType: 'application/json; charset=utf-8', headers: { 'x-b': '2' } });
      expect(res.status).toBe(201);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(res.headers.get('x-b')).toBe('2');
    });
  });

  describe('downloadResponse', () => {
    it('passes status, end-to-end headers and body through', async () => {
      const res = downloadResponse({
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'content-disposition': 'attachment;filename=users.csv',
          'content-length': '4',
          'set-cookie': ['a=1', 'b=2'],
          generator: 'Masa CMS 7.6.1',
        },
        body: 'a,b\n',
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv');
      expect(res.headers.get('content-disposition')).toBe('attachment;filename=users.csv');
      expect(res.headers.get('content-length')).toBe('4');
      expect(res.headers.get('generator')).toBe('Masa CMS 7.6.1');
      expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
      expect(await res.text()).toBe('a,b\n');
    });

    it('keeps the service Content-Encoding and Content-Language over the container ones', () => {
      const res = downloadResponse(
        { status: 200, headers: { 'Content-Encoding': 'gzip', 'content-language': 'fr-FR' }, body: '' },
        { acceptEncoding: 'identity' },
      );
      expect(res.headers.get('content-encoding')).toBe('gzip');
      expect(res.headers.get('content-language')).toBe('fr-FR');
    });

    it.each(['connection', 'Keep-Alive', 'transfer-encoding', 'upgrade', 'X-Opt2-Write-Position', 'x-opt2-request-id'])(
      'drops %s',
      (name) => {
        const res = downloadResponse({ status: 200, headers: { [name]: 'v', 'content-type': 'text/csv' }, body: '' });
        expect(res.headers.get(name)).toBeNull();
        expect(res.headers.get('content-type')).toBe('text/csv');
      },
    );

    it.each<[string, Record<string, string | string[]>]>([
      ['a string value', { connection: 'x-private-hop', 'X-Private-Hop': 'v' }],
      ['an array value', { Connection: ['keep-alive', 'X-Private-Hop'], 'x-private-hop': 'v' }],
      ['a list with spaces, tabs and empty tokens', { connection: ' ,\tX-Private-HOP\t, ,', 'x-PRIVATE-hop': 'v' }],
      ['an upper-case CONNECTION key', { CONNECTION: 'close, x-private-hop', 'X-Private-Hop': 'v' }],
      ['two Connection keys', { connection: 'close', Connection: 'X-Private-Hop', 'X-Private-Hop': 'v' }],
    ])('drops the fields Connection nominates with %s', (_name, nominated) => {
      const res = downloadResponse({
        status: 200,
        headers: { ...nominated, 'content-type': 'text/csv', 'x-public': 'kept' },
        body: '',
      });
      expect(res.headers.get('x-private-hop')).toBeNull();
      expect(res.headers.get('connection')).toBeNull();
      expect(res.headers.get('content-type')).toBe('text/csv');
      expect(res.headers.get('x-public')).toBe('kept');
    });

    it.each([
      ['Uint8Array', () => new Uint8Array(bytes)],
      ['Buffer', () => Buffer.from(bytes)],
      [
        'ReadableStream',
        () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(bytes));
              controller.close();
            },
          }),
      ],
    ])('streams a %s body byte for byte', async (_name, body) => {
      const res = downloadResponse({ status: 206, headers: { 'content-type': 'application/pdf' }, body: body() });
      expect(res.status).toBe(206);
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(bytes);
    });
  });

  describe('fw1Redirect', () => {
    it('answers the cflocation 302 with the relative Location and an empty body', async () => {
      const res = fw1Redirect('./?muraAction=cusers.list&siteid=default');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('./?muraAction=cusers.list&siteid=default');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('pragma')).toBe('no-cache');
      expect(res.headers.get('content-type')).toBe('text/html;charset=UTF-8');
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await res.text()).toBe('');
    });

    it('emits setCookies in order', () => {
      const res = fw1Redirect('./', { setCookies: ['CFID=1;path=/;HttpOnly;', 'CFTOKEN=2;path=/;HttpOnly;'] });
      expect(res.headers.getSetCookie()).toEqual(['CFID=1;path=/;HttpOnly;', 'CFTOKEN=2;path=/;HttpOnly;']);
    });
  });

  it('legacyUnavailable answers the error.html page with 503', async () => {
    const res = legacyUnavailable();
    expect(res.status).toBe(503);
    expect(res.statusText).toBe('An Error Occurred');
    expect(res.headers.get('content-type')).toBe('text/html;charset=UTF-8');
    expect(await res.text()).toBe(LEGACY_ERROR_PAGE_HTML);
  });

  it('notFound answers an empty 404', async () => {
    const res = notFound();
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html;charset=UTF-8');
    expect(await res.text()).toBe('');
  });

  describe('withSetCookies', () => {
    it('appends cookies in order and keeps status, headers and body', async () => {
      const res = withSetCookies(htmlResponse('x', { status: 201, headers: { 'set-cookie': 'z=0' } }), [
        'a=1;path=/;',
        'b=2;path=/;',
      ]);
      expect(res.status).toBe(201);
      expect(res.headers.get('content-type')).toBe('text/html;charset=UTF-8');
      expect(res.headers.get('generator')).toBe('Masa CMS 7.6.1');
      expect(res.headers.getSetCookie()).toEqual(['z=0', 'a=1;path=/;', 'b=2;path=/;']);
      expect(await res.text()).toBe('x');
    });

    it('copies a response whose headers are immutable', () => {
      const res = withSetCookies(Response.redirect('http://localhost/admin/', 302), ['c=3']);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('http://localhost/admin/');
      expect(res.headers.getSetCookie()).toEqual(['c=3']);
    });

    it('keeps the status text', () => {
      expect(withSetCookies(legacyUnavailable(), []).statusText).toBe('An Error Occurred');
    });
  });
});
