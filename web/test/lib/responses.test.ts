// The builders read no environment variable, so these suites install no test environment.
import { describe, expect, it } from 'vitest';
import { LEGACY_ERROR_PAGE_HTML } from '@opt2/platform/legacy-compat';
import { html, raw } from '@/lib/html';
import {
  HTML_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  NO_CACHE_HEADERS,
  downloadResponse,
  fw1Redirect,
  htmlResponse,
  jsonResponse,
  legacyUnavailable,
  notFound,
  withSetCookies,
} from '@/lib/responses';

const bytes = [0, 255, 1];

describe('responses', () => {
  it.each<[string, () => Response]>([
    ['htmlResponse', () => htmlResponse('<p>x</p>')],
    ['jsonResponse', () => jsonResponse('{}')],
    ['downloadResponse', () => downloadResponse({ status: 200, headers: {}, body: 'a' })],
    ['fw1Redirect', () => fw1Redirect('./')],
    ['legacyUnavailable', () => legacyUnavailable()],
    ['notFound', () => notFound()],
  ])('%s carries the onRequestStart headers', (_name, build) => {
    const res = build();
    expect(res.headers.get('generator')).toBe('Masa CMS 7.6.1');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=1200');
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

    it.each(['connection', 'Keep-Alive', 'transfer-encoding', 'upgrade', 'X-Opt2-Write-Position', 'x-opt2-request-id'])(
      'drops %s',
      (name) => {
        const res = downloadResponse({ status: 200, headers: { [name]: 'v', 'content-type': 'text/csv' }, body: '' });
        expect(res.headers.get(name)).toBeNull();
        expect(res.headers.get('content-type')).toBe('text/csv');
      },
    );

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
