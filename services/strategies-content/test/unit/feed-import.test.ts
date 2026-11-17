/** feedUtility.doImport and feedManager.doAutoImport through `domain/feeds` over a throwaway `content` schema, with recorded feed bodies and a stub fetch. */
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGzip } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { pgAvailable } from '@opt2/platform/testing';
import { saveContent } from '../../src/domain/content.js';
import {
  REMOTE_FEED_LIMIT_BYTES,
  RemoteFeedAuthUnsupportedError,
  RemoteFeedHttpError,
  RemoteFeedTooLargeError,
  createFeed,
  defaultFetchRemote,
  doAutoImport,
  importRemoteFeed,
  previewFeedImport,
  remoteFetchOptions,
  type FeedBean,
  type FeedData,
  type FetchRemote,
} from '../../src/domain/feeds.js';
import { XmlElementUndefinedError, XmlParseError, feedItemRemoteId, parseFeedXml, rssChannelItems } from '../../src/legacy/remote-feed.js';
import { ADMIN, END, HOME, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';
import { roundTripCounter } from '../helpers/round-trips.js';

const recorded = (name: string): Promise<string> => readFile(new URL(`../fixtures/legacy-feed/${name}.xml`, import.meta.url), 'utf8');

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>One</title><link href="http://atom.example/1"/><id>urn:1</id></entry></feed>`;

/** An RSS 2.0 body whose single item has an empty pubDate. */
const UNDATED = `<?xml version="1.0"?><rss version="2.0"><channel><title>U</title>
<item><title>Undated</title><link>http://undated.example/1</link><guid>undated-1</guid><pubDate></pubDate><description>d</description></item></channel></rss>`;
const PUB_DATE = 'Tue, 10 Jun 2025 04:00:00 GMT';

/** A fetch answering `body` and recording each URL it was asked for. */
function stubFetch(body: string, status = 200): FetchRemote & { calls: string[] } {
  const calls: string[] = [];
  const fetchRemote = async (url: string): Promise<{ status: number; body: string }> => {
    calls.push(url);
    return { status, body };
  };
  return Object.assign(fetchRemote, { calls });
}

describe('remote fetch', () => {
  it.each([
    ['NTLM', 'NTLM'],
    ['proxy', 'proxy'],
    ['basic', 'basic'],
    ['', 'BASIC'],
    ['DEFAULT', 'BASIC'],
  ])('getHTTPAttrs connection type for authtype %j is %j, without credentials', (authType, expected) => {
    expect(remoteFetchOptions(authType)).toEqual({ authType: expected });
  });

  describe('defaultFetchRemote', () => {
    const LIMIT = REMOTE_FEED_LIMIT_BYTES;
    const MIB = 1024 * 1024;
    const CHUNK = Buffer.alloc(64 * 1024, 'a');
    /** Each split body as label, content type, bytes, and the text a whole-buffer decode gives. */
    const SPLIT_BODIES: ReadonlyArray<readonly [string, string, Buffer, string]> = [
      ['UTF-8 multi-byte characters', 'text/xml; charset=utf-8', Buffer.from('<t>café ✓ 😀</t>', 'utf8'), '<t>café ✓ 😀</t>'],
      ['UTF-8 behind its BOM', 'text/xml', Buffer.concat([Buffer.of(0xef, 0xbb, 0xbf), Buffer.from('<t>✓</t>', 'utf8')]), '<t>✓</t>'],
      ['UTF-16LE behind its BOM', 'text/xml; charset=UTF-16LE', Buffer.concat([Buffer.of(0xff, 0xfe), Buffer.from('<t>é😀</t>', 'utf16le')]), '<t>é😀</t>'],
      ['Shift_JIS double-byte characters', 'text/xml; charset="Shift_JIS"', Buffer.of(0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea), '日本語'],
      ['a UTF-8 sequence cut off at the end', 'text/xml', Buffer.of(0x3c, 0xe2, 0x9c), '<\ufffd'],
    ];
    /** What each `/sized/` and `/declared-over` answer sent, by request URL, once its response closed: body bytes, and compressed bytes for gzip. */
    const served = new Map<string, Promise<{ written: number; wire: number }>>();
    let server: Server;
    let base = '';

    /** Writes `total` bytes of CHUNK to `sink` with backpressure, stopping when `res` closes. */
    const pump = (res: ServerResponse, sink: Writable, total: number, wire?: () => number): Promise<{ written: number; wire: number }> =>
      new Promise((resolve) => {
        let written = 0;
        let open = true;
        res.once('close', () => {
          open = false;
          resolve({ written, wire: wire?.() ?? written });
        });
        const write = (): void => {
          while (open && written < total) {
            const chunk = CHUNK.subarray(0, Math.min(CHUNK.length, total - written));
            written += chunk.length;
            if (!sink.write(chunk)) {
              sink.once('drain', write);
              return;
            }
          }
          if (open) sink.end();
        };
        write();
      });

    /** Serves `/sized/{length|chunked|gzip}/<bytes>` and the unbounded chunked `/sized/endless`. */
    const serveSized = (url: string, res: ServerResponse): void => {
      const [, , mode = '', size = ''] = url.split('/');
      const total = mode === 'endless' ? Infinity : Number(size);
      if (mode === 'gzip') {
        res.writeHead(200, { 'content-type': 'text/xml', 'content-encoding': 'gzip' });
        const gzip = createGzip();
        let wire = 0;
        gzip.on('data', (bytes: Buffer) => {
          wire += bytes.length;
        });
        gzip.pipe(res);
        served.set(url, pump(res, gzip, total, () => wire));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/xml', ...(mode === 'length' ? { 'content-length': String(total) } : {}) });
      served.set(url, pump(res, res, total));
    };

    beforeAll(async () => {
      server = createServer((req, res) => {
        const url = req.url ?? '';
        if (url.startsWith('/sized/')) {
          serveSized(url, res);
        } else if (url === '/declared-over') {
          // Headers only: a client that read the body would wait for it until its timeout.
          res.writeHead(200, { 'content-type': 'text/xml', 'content-length': String(LIMIT + 1) });
          res.flushHeaders();
          served.set(url, new Promise((resolve) => res.once('close', () => resolve({ written: 0, wire: 0 }))));
        } else if (url.startsWith('/split/')) {
          const [, contentType, bytes] = SPLIT_BODIES[Number(url.slice('/split/'.length))] ?? [];
          res.writeHead(200, { 'content-type': contentType ?? '' });
          void (async () => {
            for (const byte of bytes ?? []) {
              res.write(Buffer.of(byte));
              await sleep(5);
            }
            res.end();
          })();
        } else if (url === '/no-content') {
          res.writeHead(204);
          res.end();
        } else if (req.url === '/latin') {
          res.writeHead(200, { 'content-type': 'application/rss+xml; charset=ISO-8859-1' });
          res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
        } else if (req.url === '/moved') {
          res.writeHead(302, { location: '/latin' });
          res.end();
        } else if (req.url === '/unknown-charset') {
          res.writeHead(200, { 'content-type': 'text/xml; charset=x-unknown' });
          res.end('caf\u00e9');
        } else {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('missing');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    /** What defaultFetchRemote of `path` rejects with. */
    const refusalOf = (path: string): Promise<unknown> => defaultFetchRemote(`${base}${path}`, { authType: 'BASIC' }).then(() => undefined, (err: unknown) => err);

    /** Asserts `error` is the oversize halt of `path`, which the service answers as the legacy 503. */
    const expectHalt = (error: unknown, path: string): void => {
      expect(error).toBeInstanceOf(RemoteFeedTooLargeError);
      expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
      expect(error).toMatchObject({ name: 'RemoteFeedTooLargeError', url: `${base}${path}`, limit: LIMIT, surface: 'auto', reason: 'feed-remote-oversize-halted' });
    };

    it('follows redirects and decodes the body by the response charset, falling back to UTF-8', async () => {
      expect(await defaultFetchRemote(`${base}/moved`, { authType: 'BASIC' })).toEqual({ status: 200, body: 'café' });
      expect(await defaultFetchRemote(`${base}/unknown-charset`, { authType: 'BASIC' })).toEqual({ status: 200, body: 'café' });
    });

    it('answers a non-2xx status without retrying, for the import to raise', async () => {
      expect(await defaultFetchRemote(`${base}/gone`, { authType: 'BASIC' })).toEqual({ status: 404, body: 'missing' });
    });

    it('refuses credentials it cannot present', async () => {
      await expect(defaultFetchRemote(`${base}/latin`, { authType: 'NTLM', username: 'u', password: 'p' })).rejects.toBeInstanceOf(
        RemoteFeedAuthUnsupportedError,
      );
    });

    it('answers an empty body for a status that carries none', async () => {
      expect(await defaultFetchRemote(`${base}/no-content`, { authType: 'BASIC' })).toEqual({ status: 204, body: '' });
    });

    it.each(SPLIT_BODIES.map(([label, , , text], index) => [label, index, text] as const))(
      'decodes %s sent a byte per chunk as the whole body decodes',
      async (_label, index, text) => {
        expect(await defaultFetchRemote(`${base}/split/${String(index)}`, { authType: 'BASIC' })).toEqual({ status: 200, body: text });
      },
    );

    it.each([
      ['with its length', 'length'],
      ['chunked', 'chunked'],
      ['gzip-encoded', 'gzip'],
    ])('accepts a body of exactly the limit sent %s', async (_label, mode) => {
      const { status, body } = await defaultFetchRemote(`${base}/sized/${mode}/${String(LIMIT)}`, { authType: 'BASIC' });
      expect([status, body.length, /[^a]/.test(body)]).toEqual([200, LIMIT, false]);
    });

    it.each([
      ['chunked', 'chunked', LIMIT + 1],
      ['gzip-encoded, under 1 MiB on the wire,', 'gzip', MIB],
    ])('refuses a %s body one byte over the limit, counted decompressed', async (_label, mode, wireAtMost) => {
      const path = `/sized/${mode}/${String(LIMIT + 1)}`;
      expectHalt(await refusalOf(path), path);
      const sent = await served.get(path);
      expect(sent?.written).toBe(LIMIT + 1);
      expect(sent?.wire).toBeLessThanOrEqual(wireAtMost);
    });

    it('cancels an endless chunked body once past the limit, closing the connection', async () => {
      expectHalt(await refusalOf('/sized/endless'), '/sized/endless');
      const sent = await served.get('/sized/endless');
      // Past the limit by no more than the loopback socket buffers hold.
      expect(sent?.written).toBeGreaterThan(LIMIT);
      expect(sent?.written).toBeLessThan(LIMIT + 16 * MIB);
    });

    it('refuses a declared length over the limit before reading the body, closing the connection', async () => {
      expectHalt(await refusalOf('/declared-over'), '/declared-over');
      expect(await served.get('/declared-over')).toEqual({ written: 0, wire: 0 });
    });
  });
});

describe.skipIf(!(await pgAvailable()))('feed import', () => {
  let fx: ContentFixture;
  let rss20 = '';
  const categoryId = cfId('C', 1);
  const remoteFeed = (data: FeedData = {}): Promise<FeedBean> =>
    createFeed(fx.deps, ADMIN, {
      siteid: SITE_ID,
      name: 'Remote',
      type: 'Remote',
      version: 'RSS 2.0',
      channellink: 'http://feeds.example/rss',
      parentid: HOME,
      ...data,
    });
  const imported = () => fx.rows('content', "remoteid <> ''", [], 'tcontent_id');

  beforeAll(async () => {
    fx = await createContentFixture('feed-import-test');
    expect((await saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 })).errors).toEqual({});
    rss20 = await recorded('rss20-content');
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('saves every RSS 2.0 item as an approved page under the parent, last visible item first, keyed by its remote id', async () => {
    const feed = await remoteFeed({ categoryid: categoryId });
    expect(feed.errors).toEqual({});
    const fetchRemote = stubFetch(rss20);
    const result = await importRemoteFeed(fx.deps, ADMIN, SITE, { feedId: feed.text('feedid'), remoteId: 'All' }, fetchRemote);
    expect(fetchRemote.calls).toEqual(['http://feeds.example/rss']);
    expect(result.success).toBe(true);
    expect(result.parentBean?.isNew).toBe(0);
    expect(result.saves.map((save) => save.bean.text('title'))).toEqual(['Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha & <Beta> "q" \'a\' café\u00a0€']);
    const ids = rssChannelItems(parseFeedXml(rss20)).map((item) => feedItemRemoteId(item));
    const rows = await imported();
    expect(rows.map((row) => row.remoteid)).toEqual([...ids].reverse());
    expect(rows.every((row) => row.parentid === HOME && row.type === 'Page' && row.approved === 1 && row.active === 1)).toBe(true);
    expect(rows.every((row) => row.moduleid === '00000000000000000000000000000000000')).toBe(true);
  });

  it('re-imports an existing remote id as a new version and trims the item history, so no item is duplicated', async () => {
    const feed = await remoteFeed();
    const before = await imported();
    const result = await importRemoteFeed(fx.deps, ADMIN, SITE, { feedId: feed.text('feedid'), remoteId: 'All' }, stubFetch(rss20));
    expect(result.saves.every((save) => !save.refused && save.bean.isNew === 0)).toBe(true);
    const after = await imported();
    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((row) => row.contentid))).toEqual(new Set(before.map((row) => row.contentid)));
    expect(after.map((row) => row.contenthistid)).not.toEqual(before.map((row) => row.contenthistid));
  });

  it('imports only the listed remote ids and keeps their history when the selection is not All', async () => {
    const feed = await remoteFeed();
    const [first] = await imported();
    const selected = String(first?.remoteid);
    const result = await importRemoteFeed(fx.deps, ADMIN, SITE, { feedId: feed.text('feedid'), remoteId: selected }, stubFetch(rss20));
    expect(result.saves.map((save) => save.bean.text('remoteid'))).toEqual([selected]);
    expect(await fx.rows('content', 'remoteid = $1', [selected])).toHaveLength(2);
    expect((await importRemoteFeed(fx.deps, ADMIN, SITE, { feedId: feed.text('feedid') }, stubFetch(rss20))).saves).toEqual([]);
  });

  it('refuses a new item whose empty pubDate equals the remotePubDate of the bean it failed to find', async () => {
    const feed = await remoteFeed();
    const result = await importRemoteFeed(fx.deps, ADMIN, SITE, { feedId: feed.text('feedid'), remoteId: 'All' }, stubFetch(UNDATED));
    expect(result.success).toBe(true);
    expect(result.saves.map((save) => save.refused)).toEqual([true]);
    expect(await fx.rows('content', 'title = $1', ['Undated'])).toEqual([]);
  });

  it('caps the items at the feed maxItems', async () => {
    const feed = await remoteFeed({ maxitems: 2 });
    const result = await importRemoteFeed(fx.deps, ADMIN, SITE, { feedId: feed.text('feedid'), remoteId: 'All' }, stubFetch(rss20));
    expect(result.saves.map((save) => save.bean.text('title'))).toEqual(['Bravo', 'Alpha & <Beta> "q" \'a\' café\u00a0€']);
  });

  it.each([
    ['without a parent', { parentid: '' }],
    ['whose parent has no active version', { parentid: cfId('P', 404) }],
  ])('answers success false for a feed %s, before fetching', async (_label, data) => {
    const feed = await remoteFeed(data);
    const fetchRemote = stubFetch(rss20);
    expect(await importRemoteFeed(fx.deps, ADMIN, SITE, { feedId: feed.text('feedid'), remoteId: 'All' }, fetchRemote)).toMatchObject({
      success: false,
      saves: [],
    });
    expect(fetchRemote.calls).toEqual([]);
  });

  it('parses an Atom body but imports nothing and leaves success unset', async () => {
    const feed = await remoteFeed({ version: 'atom' });
    const result = await importRemoteFeed(fx.deps, ADMIN, SITE, { feedId: feed.text('feedid'), remoteId: 'All' }, stubFetch(ATOM));
    expect(result.success).toBeUndefined();
    expect(result.saves).toEqual([]);
  });

  it('raises the fetch status, the XML error and the missing item element as legacy does', async () => {
    const feed = await remoteFeed();
    const args = { feedId: feed.text('feedid'), remoteId: 'All' };
    await expect(importRemoteFeed(fx.deps, ADMIN, SITE, args, stubFetch('', 503))).rejects.toBeInstanceOf(RemoteFeedHttpError);
    await expect(importRemoteFeed(fx.deps, ADMIN, SITE, args, stubFetch('<rss><channel>'))).rejects.toBeInstanceOf(XmlParseError);
    await expect(importRemoteFeed(fx.deps, ADMIN, SITE, args, stubFetch(await recorded('rss20-empty')))).rejects.toBeInstanceOf(XmlElementUndefinedError);
  });

  it('previews every item against one batched active-version read, matching stored ids as SQL Server = does', async () => {
    const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>B</title>${[1, 2, 3, 4]
      .map((n) => `<item><title>Batch ${n}</title><link>http://batch.example/${n}</link><guid>batch-${n}</guid><pubDate>${PUB_DATE}</pubDate><description>b${n}</description></item>`)
      .join('')}</channel></rss>`;
    const ids = rssChannelItems(parseFeedXml(body)).map((item) => feedItemRemoteId(item));
    const feed = await remoteFeed({ maxitems: 4 });
    await importRemoteFeed(fx.deps, ADMIN, SITE, { feedId: feed.text('feedid'), remoteId: ids[1] }, stubFetch(body));
    await fx.inTenant((tx) => tx.query(`UPDATE ${fx.handle.schema}.content SET remoteid = lower(remoteid) || '  ' WHERE remoteid = $1`, [ids[1]]));
    const counter = roundTripCounter(fx.handle);
    const deps = { ...fx.deps, db: counter.db };
    const previews: Array<Array<[string, boolean]>> = [];
    const counts = [];
    for (const maxitems of [1, 4]) {
      const sized = await remoteFeed({ maxitems });
      counts.push(
        await counter.measure(async () => {
          const preview = await previewFeedImport(deps, ADMIN, { feedId: sized.text('feedid'), siteId: SITE_ID }, stubFetch(body));
          previews.push(preview.items.map((item) => [item.title, item.isNew]));
        }),
      );
    }
    expect(previews).toEqual([[['Batch 1', true]], [['Batch 1', true], ['Batch 3', true], ['Batch 4', true]]]);
    expect(counts[1]).toEqual(counts[0]);
  });

  describe('doAutoImport', () => {
    it('fetches only the active remote feeds marked autoimport of the registered site, matched case-insensitively', async () => {
      const auto = await remoteFeed({ name: 'Auto', channellink: 'http://feeds.example/auto', autoimport: 1 });
      await remoteFeed({ name: 'Inactive', channellink: 'http://feeds.example/inactive', autoimport: 1, isactive: 0 });
      await createFeed(fx.deps, ADMIN, { siteid: SITE_ID, name: 'Local', type: 'Local', autoimport: 1 });
      const fetchRemote = stubFetch(rss20);
      const sites: string[] = [];
      const result = await doAutoImport({
        ...fx.deps,
        siteId: SITE_ID.toUpperCase(),
        fetchRemote,
        siteFor: (siteId) => {
          sites.push(siteId);
          return SITE;
        },
      });
      expect(result.siteId).toBe(SITE_ID);
      expect(fetchRemote.calls).toEqual(['http://feeds.example/auto']);
      expect(sites).toEqual([SITE_ID]);
      expect(result.imports.map((entry) => [entry.feedBean.text('feedid'), entry.success])).toEqual([[auto.text('feedid'), true]]);
      expect(result.imports[0]?.saves.map((save) => save.refused)).toEqual([false, false, false, false, false]);
    });

    it('does nothing for a site the registry does not hold', async () => {
      const fetchRemote = stubFetch(rss20);
      expect(await doAutoImport({ ...fx.deps, siteId: 'nowhere', fetchRemote, siteFor: () => SITE })).toEqual({ siteId: 'nowhere', imports: [] });
      expect(fetchRemote.calls).toEqual([]);
    });

    it('propagates a failed fetch without retrying', async () => {
      let attempts = 0;
      const failing: FetchRemote = async () => {
        attempts += 1;
        throw new Error('connection refused');
      };
      await expect(doAutoImport({ ...fx.deps, siteId: SITE_ID, fetchRemote: failing, siteFor: () => SITE })).rejects.toThrow('connection refused');
      expect(attempts).toBe(1);
    });
  });
});
