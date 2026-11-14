/** feedUtility.doImport and feedManager.doAutoImport through `domain/feeds` over a throwaway `content` schema, with recorded feed bodies and a stub fetch. */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import { saveContent } from '../../src/domain/content.js';
import {
  RemoteFeedAuthUnsupportedError,
  RemoteFeedHttpError,
  createFeed,
  defaultFetchRemote,
  doAutoImport,
  importRemoteFeed,
  remoteFetchOptions,
  type FeedBean,
  type FeedData,
  type FetchRemote,
} from '../../src/domain/feeds.js';
import { XmlElementUndefinedError, XmlParseError, feedItemRemoteId, parseFeedXml, rssChannelItems } from '../../src/legacy/remote-feed.js';
import { ADMIN, END, HOME, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

const recorded = (name: string): Promise<string> => readFile(new URL(`../fixtures/legacy-feed/${name}.xml`, import.meta.url), 'utf8');

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>One</title><link href="http://atom.example/1"/><id>urn:1</id></entry></feed>`;

/** An RSS 2.0 body whose single item has an empty pubDate. */
const UNDATED = `<?xml version="1.0"?><rss version="2.0"><channel><title>U</title>
<item><title>Undated</title><link>http://undated.example/1</link><guid>undated-1</guid><pubDate></pubDate><description>d</description></item></channel></rss>`;

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
    let server: Server;
    let base = '';

    beforeAll(async () => {
      server = createServer((req, res) => {
        if (req.url === '/latin') {
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
      await new Promise((resolve) => server.close(resolve));
    });

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
