import { describe, expect, it } from 'vitest';
import { legacyPortReferences } from '../../src/isolation/legacy-origin.js';
import type { HttpHop, HttpResult } from '../../src/lib/http.js';

const LEGACY = 'http://localhost:20480';
const GATEWAY = 'http://localhost:20400';

/** A hop answering with `responseHeaders`, recording its `location` header the way the HTTP session does. */
function hop(responseHeaders: Record<string, string | string[]> = {}): HttpHop {
  const location = responseHeaders.location;
  return {
    method: 'GET',
    url: `${GATEWAY}/`,
    status: location === undefined ? 200 : 302,
    ...(typeof location === 'string' ? { location } : {}),
    setCookie: [],
    requestHeaders: {},
    responseHeaders,
  };
}

/** A final response with body `text` reached through `hops`. */
function resultOf(text: string, hops: HttpHop[] = [hop()]): HttpResult {
  return {
    status: hops.at(-1)?.status ?? 200,
    url: `${GATEWAY}/`,
    headers: hops.at(-1)?.responseHeaders ?? {},
    bytes: new TextEncoder().encode(text),
    text,
    json: <T>() => JSON.parse(text) as T,
    hops,
  };
}

describe('legacyPortReferences', () => {
  it.each<[string, string, string, string[]]>([
    ['a plain http URL', LEGACY, '<a href="http://localhost:20480/admin/">', ['http://localhost:20480/admin/']],
    ['a scheme-relative URL', LEGACY, '<script src="//localhost:20480/core/a.js"></script>', ['//localhost:20480/core/a.js']],
    ['a \\x-escaped URL', LEGACY, String.raw`rootpath:'http\x3A\x2F\x2Flocalhost\x3A20480'`, ['http://localhost:20480']],
    ['a \\u-escaped URL', LEGACY, String.raw`'http\u003A\u002F\u002Flocalhost\u003A20480\u002Fadmin'`, ['http://localhost:20480/admin']],
    ['a JSON \\/-escaped URL', LEGACY, String.raw`{"url":"http:\/\/localhost:20480\/_api\/json"}`, ['http://localhost:20480/_api/json']],
    ['a hex HTML-entity URL', LEGACY, 'href="http&#x3a;&#x2F;&#x2f;localhost&#X3A;20480&#x2f;admin"', ['http://localhost:20480/admin']],
    ['a decimal and named HTML-entity URL', LEGACY, 'http&colon;&sol;&sol;localhost&#58;20480&#47;', ['http://localhost:20480/']],
    ['a percent-encoded URL', LEGACY, 'returnUrl=http%3A%2F%2Flocalhost%3A20480%2Fadmin%2F', ['http://localhost:20480/admin/']],
    ['a doubly percent-encoded URL', LEGACY, 'next=http%253A%252F%252Flocalhost%253A20480', ['http://localhost:20480']],
    ['a URL with userinfo', LEGACY, '"https://editor:x@localhost:20480/x"', ['https://editor:x@localhost:20480/x']],
    ['an IPv6 host', LEGACY, "'http://[::1]:20480/admin/'", ['http://[::1]:20480/admin/']],
    ['a 127.0.0.1 host', LEGACY, 'url(//127.0.0.1:20480/a.png)', ['//127.0.0.1:20480/a.png']],
    ['two URLs in order', LEGACY, '"//localhost:20480/a" "http://LOCALHOST:20480"', ['//localhost:20480/a', 'http://LOCALHOST:20480']],
    ['an out-of-range numeric reference', LEGACY, '&#x110000;&#99999999;//localhost:20480/', ['//localhost:20480/']],
    ['the default port of a port-less origin', 'http://localhost', '"http://localhost:80/" "http://localhost:8080/"', ['http://localhost:80/']],
    ['the https default port', 'https://legacy.example.test', '"//legacy.example.test:443/x"', ['//legacy.example.test:443/x']],
    ['no URL at the gateway port', LEGACY, '"http://localhost:20400/admin/" "//localhost:20400/x"', []],
    ['no URL at a longer port', LEGACY, '"http://localhost:204800/" "//localhost:120480/"', []],
    ['no URL at a port 8080 when the port is 80', 'http://localhost:80', '"http://localhost:8080/"', []],
    ['no bare host:port or relative path', LEGACY, 'localhost:20480 /admin/?port=20480 :20480', []],
  ])('reports %s', (_label, origin, body, urls) => {
    expect(legacyPortReferences(resultOf(body), origin)).toEqual(urls.map((url) => ({ where: 'body', url })));
  });

  it('reports each header of every hop once, set-cookie lines and an earlier Location included', () => {
    const hops = [
      hop({ location: `${LEGACY}/`, server: 'gateway' }),
      hop({ 'set-cookie': ['CFID=1; Path=/', 'next=http%3A%2F%2Flocalhost%3A20480%2Fadmin'], link: '</a.css>' }),
    ];
    expect(legacyPortReferences(resultOf('', hops), LEGACY)).toEqual([
      { where: 'hop 1 location', url: `${LEGACY}/` },
      { where: 'hop 2 set-cookie', url: `${LEGACY}/admin` },
    ]);
  });

  it('reports a hop location the response headers do not repeat', () => {
    const redirect: HttpHop = { ...hop(), status: 301, location: `${LEGACY}/` };
    expect(legacyPortReferences(resultOf('', [redirect, hop()]), LEGACY)).toEqual([
      { where: 'hop 1 location', url: `${LEGACY}/` },
    ]);
  });

  it('rejects an origin without an explicit or default port', () => {
    expect(() => legacyPortReferences(resultOf(''), 'ftp://legacy.example.test')).toThrow(
      'legacy origin ftp://legacy.example.test names no port and has no default one',
    );
  });
});
