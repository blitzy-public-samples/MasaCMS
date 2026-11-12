// Feed API port against ACF 2023.0.26 output of Masa 7.6.1 (server TZ UTC, siteidinurls=false, indexfileinurls=false,
// port 21080, site `default`). test/fixtures/legacy-feed holds the captured bodies byte for byte.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';
import { parseFeedXml } from '../../src/legacy/remote-feed.js';
import {
  RSS_CONTENT_TYPE,
  addCompletePath,
  cfXmlFormat,
  decideFeed,
  feedArguments,
  feedContentType,
  feedErrorPacket,
  feedRenderContent,
  getHttpTimeString,
  hasDynamicTags,
  renderFeed,
  resolveFeedDispatch,
  rssItemDescription,
  stripHtml,
  wddxPacket,
  writeRss092,
  writeRss20,
  type FeedDecisionInput,
  type FeedErrorType,
  type FeedRequest,
  type RenderFeedOptions,
  type RssFeedView,
  type RssItemView,
} from '../../src/legacy/rss.js';
import { wddxStruct } from '../../src/domain/wddx.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/legacy-feed/${name}.xml`, import.meta.url), 'utf8');

/** The channel `<pubDate>` (`now()`) of a captured RSS 2.0 body, so the writer can be given the same clock. */
const channelPubDate = (xml: string): Date => new Date(/<pubDate>([^<]+)<\/pubDate>/.exec(xml)?.[1] ?? '');

const SITE: LegacySiteUrlConfig = {
  siteId: 'default',
  scheme: 'http',
  domain: 'localhost',
  requestDomain: 'localhost',
  previewDomain: '',
  serverPort: ':21080',
  context: '',
  siteIdInUrls: false,
  indexFileInUrls: false,
  hashUrls: false,
  useSSL: false,
  filePoolId: 'default',
  configFileAssetPath: '',
  assetPath: '',
  siteAssetPath: '/sites',
  fileStore: 'fileDir',
  legacyIndexFileLocation: false,
  urlTitleDelim: '-',
  allowUnicodeInFilenames: false,
  placeholderImgId: '',
  placeholderImgExt: '',
  directImages: true,
};

const OPTS: RenderFeedOptions = {
  site: SITE,
  contact: 'admin@example.com',
  config: { serverPort: ':21080', context: '', indexPath: '' },
  now: new Date(0),
  renderContent: false,
  requestHost: 'localhost:21080',
  javaLocale: 'en_US',
};

const feedView = (feedid: string, name: string, allowhtml: number, version: string): RssFeedView => ({
  feedid,
  siteid: 'default',
  name,
  altname: null,
  description: `Desc & <d> "q" 'a' \u00e9`,
  lang: 'en-us',
  allowhtml,
  version,
});

const F20 = feedView('15806482-DBA1-44F9-B534AC3CD46D6EF9', 'Probe "Feed" & <News>', 1, 'RSS 2.0');
const F20_TEXT = feedView('1580654E-F0FF-460A-D80F9C64C44650B0', 'Probe Text', 0, 'RSS 2.0');
const F092 = feedView('158065FB-BF79-B1DF-FE919BB330588A31', 'Probe 092 & co', 1, 'RSS 0.920');
const F092_TEXT = feedView('1580668F-D0FD-8263-F1BC1FDAA18B9343', 'Probe 092 text', 0, 'RSS 0.920');
const EMPTY20: RssFeedView = { ...feedView('15A1B276-ACD4-B50B-1BB45E4CD40D5435', 'Empty 20', 1, 'RSS 2.0'), description: null };
const EMPTY092: RssFeedView = { ...feedView('15A1B3C2-C82D-06B6-EE63DA7D8CA53B05', 'Empty 092', 1, 'RSS 0.920'), description: null };

const item = (fields: Partial<RssItemView> & Pick<RssItemView, 'contentid' | 'filename' | 'menutitle'>): RssItemView => ({
  siteid: 'default',
  type: 'Page',
  summary: null,
  body: null,
  releasedate: null,
  lastupdate: null,
  fileid: null,
  categories: [],
  file: null,
  ...fields,
});

// The seeded children of the captured feeds' folder, as the feed query returns them (sorted by title).
const ITEMS: RssItemView[] = [
  item({
    contentid: '158053EF-C9D4-6929-05C6A52C84A6295E',
    filename: 'rss-probe/alpha-q-a-cafe',
    menutitle: `Alpha & <Beta> "q" 'a' caf\u00e9\u00a0\u20ac`,
    summary: `<p>Hello <a href="/x/">link</a> <IMG SRC='/img.png'> caf\u00e9 & more</p>\r\nline2`,
    body: '<p>Body one</p>',
    releasedate: new Date(Date.UTC(2026, 2, 4, 5, 6, 7)),
    lastupdate: new Date(Date.UTC(2026, 10, 12, 8, 50, 9, 470)),
    categories: ['News & <Views>', 'Second'],
  }),
  item({
    contentid: '158057D4-D512-B5BF-CF8E199A6A1A8533',
    filename: 'rss-probe/bravo',
    menutitle: 'Bravo',
    body: '<div>Only <b>body</b> text &amp; stuff</div>',
    lastupdate: new Date(Date.UTC(2026, 10, 12, 8, 50, 9, 560)),
  }),
  item({
    contentid: '15805ACF-05EE-4B82-49CAD469874A2D99',
    filename: 'rss-probe/charlie',
    menutitle: 'Charlie',
    summary: `<p>${'word '.repeat(60)}</p>`,
    releasedate: new Date(Date.UTC(2026, 1, 1)),
    lastupdate: new Date(Date.UTC(2026, 10, 12, 8, 50, 9, 637)),
  }),
  item({
    contentid: '15805DD8-BC63-79EF-E9476218A9EB9996',
    filename: 'rss-probe/delta',
    menutitle: 'Delta',
    summary: 'Delta summary',
    lastupdate: new Date(Date.UTC(2026, 10, 12, 8, 50, 9, 727)),
    fileid: '15805D62-C8CA-4E0E-9698777D3A1BE112',
    categories: ['Second'],
    file: { fileext: 'pdf', filesize: 4321, contenttype: 'application', contentsubtype: 'pdf' },
  }),
  item({
    contentid: '15A1A0C9-9605-64D4-F3C64A03CF41A5DA',
    type: 'File',
    filename: 'rss-probe/echo',
    menutitle: 'Echo',
    body: "<p>File <a href='/f/'>body</a></p>",
    lastupdate: new Date(Date.UTC(2026, 10, 12, 8, 53, 47, 747)),
    fileid: '15A180F6-BD5F-82C0-1ED6DE7462FC2744',
    file: { fileext: 'txt', filesize: 77, contenttype: 'text', contentsubtype: 'plain' },
  }),
];

describe('writeRss20', () => {
  it.each([
    ['rss20-html', F20, ITEMS, false],
    ['rss20-content', F20, ITEMS, true],
    ['rss20-text', F20_TEXT, ITEMS, false],
    ['rss20-empty', EMPTY20, [], false],
  ] as const)('reproduces the captured %s body', (name, feed, items, renderContent) => {
    const expected = fixture(name);
    const xml = writeRss20(feed, items, { ...OPTS, now: channelPubDate(expected), renderContent });
    expect(xml).toBe(expected);
    expect(parseFeedXml(xml).child('channel').child('title').xmlText).toBe(feed.name);
  });

  it('builds links, enclosures and completed paths with the item site when it differs from the feed site', () => {
    const other: LegacySiteUrlConfig = { ...SITE, siteId: 'tenant-b', domain: 'b.example', requestDomain: 'b.example' };
    const pooled = item({ ...ITEMS[3]!, siteid: 'tenant-b', summary: '<img src="/i.png">' });
    const xml = writeRss20(F20, [pooled], { ...OPTS, siteFor: () => other });
    expect(xml).toContain('<link>http://b.example:21080/rss-probe/delta/</link>');
    expect(xml).toContain('&lt;img src=&quot;http://b.example:21080/i.png&quot;&gt;');
    expect(xml).toContain('<enclosure url="http://b.example:21080/_api/render/file/?fileID=');
    expect(() => writeRss20(F20, [pooled], OPTS)).toThrow(TypeError);
  });

  it('writes empty enclosure values when the file row is missing, and fails without any item date', () => {
    const missing = item({ ...ITEMS[3]!, file: null });
    expect(writeRss20(F20, [missing], OPTS)).toContain('fileEXT=." length="" type="/" />');
    expect(() => writeRss20(F20, [item({ ...ITEMS[1]!, lastupdate: null })], OPTS)).toThrow(TypeError);
  });
});

describe('writeRss092', () => {
  it.each([
    ['rss092-html', F092, ITEMS],
    ['rss092-text', F092_TEXT, ITEMS],
    ['rss092-empty', EMPTY092, []],
  ] as const)('reproduces the captured %s body', (name, feed, items) => {
    const xml = writeRss092(feed, items, OPTS);
    expect(xml).toBe(fixture(name));
    expect(parseFeedXml(xml).child('channel').child('title').xmlText).toBe(feed.name);
  });
});

describe('renderFeed', () => {
  it.each([
    ['RSS 2.0', RSS_CONTENT_TYPE, '<rss version="2.0"'],
    ['rss 0.920', RSS_CONTENT_TYPE, '<rss version="0.92"'],
    ['Atom', 'text/html;charset=UTF-8', ''],
    [null, 'text/html;charset=UTF-8', ''],
  ] as const)('answers version %s with its body and the setLocale language', (version, contentType, start) => {
    const response = renderFeed({ ...EMPTY20, version }, [], OPTS);
    expect(response).toMatchObject({ status: 200, contentType, contentLanguage: 'en-US' });
    expect(response.body.includes(start)).toBe(true);
    if (start === '') expect(response.body).toBe('');
  });

  it('titles the channel with the alternate name when one is set', () => {
    expect(renderFeed({ ...EMPTY20, altname: 'Alt & Co' }, [], OPTS).body).toContain('<title>Alt &amp; Co</title>');
  });
});

describe('error packets', () => {
  it('reproduces the captured invalid-method and authorization packets', () => {
    expect(feedErrorPacket('invalidMethodCall', 'Mozilla/5.0')).toEqual({
      status: 400,
      contentType: 'text/xml; charset=UTF-8',
      body: "<wddxPacket version='1.0'><header/><data><struct><var name='error'><struct><var name='message'><string>Invalid method call</string></var></struct></var></struct></data></wddxPacket>",
    });
    expect(feedErrorPacket('authorization', 'curl/8')).toEqual({
      status: 401,
      contentType: 'application/rss+xml; charset=UTF-8',
      body: "<wddxPacket version='1.0'><header/><data><struct><var name='error'><struct><var name='message'><string>Insufficient Account Permissions</string></var></struct></var></struct></data></wddxPacket>",
    });
  });

  it.each([
    ['invalidParameters', 400, 'Insufficient parameters'],
    ['badRequest', 400, 'Bad Request'],
    ['invalidTokens', 400, 'Invalid CSRF tokens'],
    ['unhandled', 500, 'Unhandled Exception'],
  ] as const)('maps %s to %i %s', (type: FeedErrorType, status, message) => {
    const packet = feedErrorPacket(type, '');
    expect(packet.status).toBe(status);
    expect(packet.body).toBe(wddxPacket(wddxStruct([['error', wddxStruct([['message', message]])]])));
  });

  it.each([
    ['Mozilla/5.0 (X11)', 'text/xml; charset=UTF-8'],
    ['some MOZILLA client', 'text/xml; charset=UTF-8'],
    ['curl/8', 'application/rss+xml; charset=UTF-8'],
    ['', 'application/rss+xml; charset=UTF-8'],
  ])('content type for user agent %j is %s', (userAgent, contentType) => {
    expect(feedContentType(userAgent)).toBe(contentType);
  });
});

describe('resolveFeedDispatch', () => {
  const FEED_ID = '15A1B276-ACD4-B50B-1BB45E4CD40D5435';
  const request = (pathInfo: string, url: Record<string, string>, form: Record<string, string> = {}): FeedRequest => ({
    pathInfo,
    url,
    form,
    siteId: 'default',
  });

  // Each case was probed on the legacy server: 400 = invalidMethodCall, otherwise feed() ran with the params.
  it.each([
    ['getConfig', 'invalidMethodCall'],
    ['GetConfig', 'invalidMethodCall'],
    ['zzzz', 'params'],
    ['feedid', 'params'],
    ['method', 'invalidMethodCall'],
    ['server_name', 'params'],
    ['cgi', 'invalidMethodCall'],
    ['cgi.zz', 'invalidMethodCall'],
    ['cgi.a.b', 'invalidMethodCall'],
    ['url.feedid', 'invalidMethodCall'],
    ['url.FEEDID', 'invalidMethodCall'],
    ['url.zz', 'params'],
    ['url.feedid.x', 'params'],
    ['form.feedid', 'invalidMethodCall'],
    ['url.method', 'invalidMethodCall'],
    ['a.b', 'params'],
    ['1abc', 'params'],
    ['ab-c', 'params'],
    ['a..b', 'params'],
    ['variables.config', 'invalidMethodCall'],
    ['variables.zz', 'params'],
    ['variables.this', 'invalidMethodCall'],
    ['this.feed', 'invalidMethodCall'],
    ['this.siteid', 'params'],
    ['local.params', 'invalidMethodCall'],
    ['local.zz', 'params'],
    ['params.feedid', 'invalidMethodCall'],
    ['params.zz', 'params'],
    ['config.publicMethods', 'invalidMethodCall'],
    ['config.zz', 'params'],
    ['arguments.zz', 'params'],
    ['super', 'invalidMethodCall'],
    ['cfthread', 'invalidMethodCall'],
    ['thistag', 'params'],
    ['backportdir', 'invalidMethodCall'],
    ['logError', 'invalidMethodCall'],
    ['_serializeWDDX', 'invalidMethodCall'],
    ['instance', 'params'],
    ['', 'params'],
    ['feed', 'empty'],
    ['Feed', 'empty'],
  ])('method=%j dispatches to %s', (method, outcome) => {
    const dispatch = resolveFeedDispatch(request('/_api/feed/v1/default/', { feedID: FEED_ID, method }));
    if (outcome === 'invalidMethodCall') expect(dispatch).toEqual({ kind: 'invalidMethodCall' });
    else if (outcome === 'empty') expect(dispatch).toEqual({ kind: 'feed', params: new Map() });
    else expect(dispatch).toEqual({ kind: 'feed', params: new Map([['feedid', FEED_ID], ['method', method]]) });
  });

  it.each([
    ['/_api/feed/v1/default/feed/a/method', { kind: 'invalidMethodCall' }],
    ['/_api/feed/v1/default/feed/method/b', { kind: 'feed', params: new Map() }],
    ['/_api/feed/v1/default/getConfig/', { kind: 'invalidMethodCall' }],
    ['/_api/feed/v1/default/zzz/', { kind: 'feed', params: new Map([['feedid', FEED_ID], ['method', 'zzz']]) }],
    ['/_api/feed/v1/DEFAULT/', { kind: 'feed', params: new Map([['feedid', FEED_ID]]) }],
    ['/tasks/feed/default/', { kind: 'feed', params: new Map([['feedid', FEED_ID]]) }],
    ['/tasks/feed', { kind: 'feed', params: new Map([['feedid', FEED_ID]]) }],
    ['/_api/feed/v1/', { kind: 'feed', params: new Map([['feedid', FEED_ID]]) }],
    ['', { kind: 'feed', params: new Map([['feedid', FEED_ID]]) }],
  ])('path %s dispatches as legacy does', (pathInfo, expected) => {
    expect(resolveFeedDispatch(request(pathInfo, { feedID: FEED_ID }))).toEqual(expected);
  });

  it('merges form over url, and keeps form-only names out of the url scope', () => {
    const dispatch = resolveFeedDispatch(request('/_api/feed/v1/default/', { feedID: 'a', method: 'url.zzf' }, { FEEDID: 'b', zzf: '1' }));
    expect(dispatch).toEqual({ kind: 'feed', params: new Map([['feedid', 'b'], ['method', 'url.zzf'], ['zzf', '1']]) });
  });

  it('feeds method=feed an empty argument set, so the feed is not found', () => {
    const dispatch = resolveFeedDispatch(request('/_api/feed/v1/default/', { method: 'feed', feedID: FEED_ID }));
    expect(dispatch.kind).toBe('feed');
    const args = feedArguments(dispatch.kind === 'feed' ? dispatch.params : new Map());
    expect(args).toEqual({
      username: '',
      password: '',
      filter: '',
      feedId: '',
      contentId: '',
      categoryId: '',
      siteId: '',
      maxItems: '20',
      tag: '',
    });
    expect(decideFeed({ ...ALLOWED, feedId: args.feedId, siteId: args.siteId, feed: null }).kind).toBe('notFound');
  });
});

const ALLOWED: FeedDecisionInput = {
  feedId: 'F',
  siteId: '',
  allowOpenFeeds: false,
  feed: { restricted: false, version: 'RSS 2.0' },
  cgiHttps: '',
  extranetSSL: false,
  allowFeed: true,
};

describe('decideFeed', () => {
  it.each([
    ['a missing feedID', { feedId: '' }, 'notFound'],
    ['an unknown feed', { feed: null }, 'notFound'],
    ['an allowed feed', {}, 'render'],
    ['a refused feed', { allowFeed: false }, 'authorization'],
    ['a refused feed with open feeds', { allowFeed: false, allowOpenFeeds: true }, 'render'],
    ['an open feed from URL settings', { feedId: '', siteId: 'default', allowOpenFeeds: true }, 'render'],
    ['an open feed without feedID or siteid', { feedId: '', allowOpenFeeds: true }, 'notFound'],
    ['a restricted extranet-SSL feed over https off', { feed: { restricted: true, version: 'RSS 2.0' }, extranetSSL: true, cgiHttps: 'Off' }, 'unhandled'],
    ['a restricted extranet-SSL feed under CommandBox http', { feed: { restricted: true, version: 'RSS 2.0' }, extranetSSL: true }, 'render'],
  ] as const)('answers %s with %s', (_label, overrides: Partial<FeedDecisionInput>, kind) => {
    expect(decideFeed({ ...ALLOWED, ...overrides }).kind).toBe(kind);
  });

  it('needs the URL-built bean for an open feed without feedID', () => {
    expect(() => decideFeed({ ...ALLOWED, feedId: '', siteId: 'default', allowOpenFeeds: true, feed: null })).toThrow(TypeError);
  });
});

describe('helpers', () => {
  it.each([
    [{ content: 'true' }, true],
    [{ CONTENT: 'Yes' }, true],
    [{ content: '1' }, true],
    [{ content: 'false' }, false],
    [{ content: '0' }, false],
    [{ content: ' 1' }, false],
    [{ content: 'x' }, false],
    [{}, false],
  ])('feedRenderContent(%j) is %s', (url, expected) => {
    expect(feedRenderContent(url)).toBe(expected);
  });

  it.each([
    ['[m]1+1[/m]', true],
    ['x[SAVA]y[/sava]', true],
    ['[mura]a[/m]', true],
    ['[m][/m]', false],
    ['[m]a\nb[/m]', false],
    ['plain', false],
  ])('hasDynamicTags(%j) is %s', (s, expected) => {
    expect(hasDynamicTags(s)).toBe(expected);
  });

  it('formats like ACF XMLFormat', () => {
    expect(cfXmlFormat(`a&b<c>d"e'f\r\ng`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f\ng');
    expect(cfXmlFormat('\u00a0\u00e9\u00ff')).toBe('&#xa0;&#xe9;&#xff;');
    expect(cfXmlFormat('\u0085\u009f\u0100\u20ac\t\n\u0001')).toBe('\u0085\u009f\u0100\u20ac\t\n\u0001');
  });

  it('completes root-relative paths with the legacy quote and case quirks', () => {
    expect(addCompletePath(`<a HREF='/a'><img Src="/b"><a href="//c"><a href="d">`, 'https://x:8')).toBe(
      '<a href="https://x:8/a\'><img src="https://x:8/b"><a href="https://x:8//c"><a href="d">',
    );
    expect(stripHtml('<p class="x">a<br\n/>b</p>')).toBe('ab');
  });

  it('prepares item descriptions per version', () => {
    const html = { allowHtml: 1, origin: 'http://h' } as const;
    const text = { allowHtml: 0, origin: 'http://h' } as const;
    expect(rssItemDescription(' <a href="/x">y</a> ', 'body', { ...html, version: 'RSS 2.0' })).toBe('<a href="http://h/x">y</a>');
    expect(rssItemDescription(' <a href="/x">y</a> ', 'body', { ...html, version: 'RSS 0.920' })).toBe(' <a href="http://h/x">y</a> ');
    expect(rssItemDescription('', '<b>body</b>', { ...text, version: 'RSS 2.0' })).toBe('...');
    expect(rssItemDescription('', '<b>body</b>', { ...text, version: 'RSS 0.920' })).toBe('body...');
    expect(rssItemDescription('x'.repeat(250), '', { ...text, version: 'RSS 2.0' })).toBe(`${'x'.repeat(200)}...`);
  });

  it('prints HTTP dates in GMT', () => {
    expect(getHttpTimeString(new Date(Date.UTC(2026, 0, 5, 3, 4, 5)))).toBe('Mon, 05 Jan 2026 03:04:05 GMT');
    expect(() => getHttpTimeString(new Date(Number.NaN))).toThrow(RangeError);
  });
});
