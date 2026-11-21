/** `/_api/feed/v1` and `/tasks/feed` (feedApiUtility.cfc:74-446): dispatch, error packets, the RSS writers against literal documents, and the routes through the service's composition root with a programs-sites double. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import { subscriptionName } from '@opt2/platform/events';
import { fixedClock } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, assertResponseMatchesOpenApi, pushTo, testEnvelope } from '@opt2/platform/testing';
import { SITE_CHANGED_TOPIC } from '../../src/events/consumers.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';
import {
  RSS_CONTENT_TYPE,
  cfXmlFormat,
  feedContentType,
  feedErrorPacket,
  getHttpTimeString,
  renderFeed,
  resolveFeedDispatch,
  rssItemDescription,
  wddxPacket,
  writeRss092,
  writeRss20,
  type FeedDispatch,
  type FeedErrorType,
  type RenderFeedOptions,
  type RssDescriptionOptions,
  type RssFeedView,
  type RssFileView,
  type RssItemView,
} from '../../src/legacy/rss.js';
import { FEED_PATHS } from '../../src/routes/feed.js';
import { SERVICE, buildTestApp, createRecordingDb, userHeaders, type ClientHandlers, type TestApp } from '../helpers/app.js';
import { IDS, contentRow, feedRow, seedRecordingDb, type ContentSeedRow } from '../helpers/seed.js';
import { contentHeaders } from '../helpers/tokens.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const MOZILLA = 'Mozilla/5.0 (X11; Linux x86_64)';
const CURL = 'curl/8.5.0';
const XML_TYPE = 'text/xml; charset=UTF-8';
const RSS_TYPE = 'application/rss+xml; charset=UTF-8';

const FEED_ID = IDS.feeds.local;
const RESTRICTED_FEED_ID = 'A9000000-0000-0000-0000000000000101';
const UNKNOWN_FEED_ID = 'A9000000-0000-0000-0000000000000404';
const FAILING_FEED_ID = 'A9000000-0000-0000-0000000000000500';

// Fixed UTC instants of the business date, so every printed HTTP date is independent of the process time zone.
const NOW = new Date(Date.UTC(2026, 5, 30, 12, 0, 0));

/** tenant-a's URL settings: no site id or index file in URLs, configBean port 8080. */
const SITE: LegacySiteUrlConfig = {
  siteId: TENANT_A.siteId,
  scheme: 'http',
  domain: 'tenant-a.example',
  requestDomain: 'tenant-a.example',
  previewDomain: '',
  serverPort: ':8080',
  context: '',
  siteIdInUrls: false,
  indexFileInUrls: false,
  hashUrls: false,
  useSSL: false,
  filePoolId: 'umbrella',
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
  contact: 'webmaster@tenant-a.example',
  config: { serverPort: ':8080', context: '', indexPath: '' },
  now: NOW,
  renderContent: false,
  requestHost: 'tenant-a.example:8080',
  javaLocale: 'en_US',
};

/** The local feed every writer test renders, as feedDAO.read loads it. */
const FEED = feedRow({ feedid: FEED_ID, name: 'News & Views', description: 'Daily "picks" & <more>', lang: 'en-us', allowhtml: 1, version: 'RSS 2.0' });

/** A feed whose allowFeed verdict needs member credentials. */
const RESTRICTED_FEED = feedRow({ feedid: RESTRICTED_FEED_ID, name: 'Members Only', restricted: 1, restrictgroups: 'Members' });

const PDF: RssFileView = { fileext: 'pdf', filesize: 2048, contenttype: 'application', contentsubtype: 'pdf' };

/** The three published items of {@link FEED}, in the feed's order: a file, an HTML summary with categories, and XMLFormat characters. */
const ALPHA = contentRow({
  contentid: 'A1000000-0000-0000-0000000000000101',
  type: 'File',
  title: 'Annual Report',
  filename: 'news/annual-report',
  summary: 'Download the report.',
  releasedate: new Date(Date.UTC(2026, 5, 1, 9, 0, 0)),
  fileid: IDS.files.pdf,
});
const BRAVO = contentRow({
  contentid: 'A1000000-0000-0000-0000000000000102',
  title: 'Bravo Update',
  filename: 'news/bravo-update',
  summary: ' <p>Read <a href="/news/bravo-update/">more</a></p> ',
  lastupdate: new Date(Date.UTC(2026, 5, 29, 10, 0, 0)),
});
const CAFE = contentRow({
  contentid: 'A1000000-0000-0000-0000000000000103',
  title: `Caf\u00e9 & <Co> "Quotes" 'n' \u20ac`,
  filename: 'news/cafe-co',
  summary: 'Prix: 5 \u20ac & <b>caf\u00e9</b>',
  releasedate: new Date(Date.UTC(2026, 2, 4, 5, 6, 7)),
});

/** The feed bean values the writers read. */
function feedView(row: ReturnType<typeof feedRow>): RssFeedView {
  const { feedid, siteid, name, altname, description, lang, allowhtml, version } = row;
  return { feedid, siteid, name, altname, description, lang, allowhtml, version };
}

/** A feed query row with its category names and file meta. */
function itemView(row: ContentSeedRow, categories: readonly string[] = [], file: RssFileView | null = null): RssItemView {
  const { contentid, siteid, type, filename, menutitle, summary, body, releasedate, lastupdate, fileid } = row;
  return { contentid, siteid, type, filename, menutitle, summary, body, releasedate, lastupdate, fileid, categories, file };
}

const ITEMS: readonly RssItemView[] = [itemView(ALPHA, [], PDF), itemView(BRAVO, ['News & <Views>', 'Zeta']), itemView(CAFE)];

/** rss20 of {@link FEED} and {@link ITEMS} under ACF whitespace management, written out from the template (feedApiUtility.cfc:297-379). */
const RSS20 = [
  '<?xml version="1.0" ?>',
  '\t\t<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">',
  '\t\t\t<channel>',
  '\t\t\t\t<title>News &amp; Views</title>',
  '\t\t\t\t<link>http://tenant-a.example:8080</link>',
  '\t\t\t\t<description>Daily &quot;picks&quot; &amp; &lt;more&gt;</description>',
  '\t\t\t\t<webMaster>webmaster@tenant-a.example</webMaster>',
  '\t\t\t\t<generator>https://www.masacms.com</generator>',
  '\t\t\t\t<pubDate>Tue, 30 Jun 2026 12:00:00 GMT</pubDate>',
  '\t\t\t\t<language>en-us</language>',
  '\t\t\t\t<atom:link href="http://tenant-a.example:8080/_api/feed/v1/tenant-a/?feedID=A9000000-0000-0000-0000000000000001" rel="self" type="application/rss+xml" />',
  '\t\t\t',
  '\t\t\t\t<item>',
  '\t\t\t\t\t<title>Annual Report</title>',
  '\t\t\t\t\t<link>http://tenant-a.example:8080/news/annual-report/</link><guid isPermaLink="false">A1000000-0000-0000-0000000000000101</guid>',
  '\t\t\t\t\t<pubDate>Mon, 01 Jun 2026 09:00:00 GMT</pubDate>',
  '\t\t\t\t\t<description>Download the report.</description>',
  '\t\t\t\t\t<enclosure url="http://tenant-a.example:8080/_api/render/file/?fileID=A3000000-0000-0000-0000000000000001&amp;fileEXT=.pdf" length="2048" type="application/pdf" />',
  '\t\t\t\t</item>',
  '\t\t',
  '\t\t\t\t<item>',
  '\t\t\t\t\t<title>Bravo Update</title>',
  '\t\t\t\t\t<link>http://tenant-a.example:8080/news/bravo-update/</link><guid isPermaLink="false">A1000000-0000-0000-0000000000000102</guid>',
  '\t\t\t\t\t<pubDate>Mon, 29 Jun 2026 10:00:00 GMT</pubDate>',
  '\t\t\t\t\t<description>&lt;p&gt;Read &lt;a href=&quot;http://tenant-a.example:8080/news/bravo-update/&quot;&gt;more&lt;/a&gt;&lt;/p&gt;</description>',
  '\t\t\t\t\t<category>News &amp; &lt;Views&gt;</category><category>Zeta</category> ',
  '\t\t\t\t</item>',
  '\t\t',
  '\t\t\t\t<item>',
  '\t\t\t\t\t<title>Caf&#xe9; &amp; &lt;Co&gt; &quot;Quotes&quot; &apos;n&apos; \u20ac</title>',
  '\t\t\t\t\t<link>http://tenant-a.example:8080/news/cafe-co/</link><guid isPermaLink="false">A1000000-0000-0000-0000000000000103</guid>',
  '\t\t\t\t\t<pubDate>Wed, 04 Mar 2026 05:06:07 GMT</pubDate>',
  '\t\t\t\t\t<description>Prix: 5 \u20ac &amp; &lt;b&gt;caf&#xe9;&lt;/b&gt;</description>',
  '\t\t\t\t\t',
  '\t\t\t\t</item>',
  '\t\t</channel>',
  '\t\t</rss> ',
].join('\n');

/** rss092 of {@link FEED} as `RSS 0.920` and {@link ITEMS}, written out from the template (feedApiUtility.cfc:401-442). */
const RSS092 = [
  '<?xml version="1.0" ?>',
  '\t\t<rss version="0.92"',
  '\t\t\txmlns:dc="http://purl.org/dc/elements/1.1/">',
  '\t\t\t<channel>',
  '\t\t\t\t<title>News &amp; Views</title>',
  '\t\t\t\t<link>http://tenant-a.example:8080</link>',
  '\t\t\t\t<description>Daily &quot;picks&quot; &amp; &lt;more&gt;</description>',
  '\t\t\t\t<webMaster>webmaster@tenant-a.example</webMaster>',
  '\t\t\t\t<language>en-us</language>',
  '\t\t\t',
  '\t\t\t\t\t<item>',
  '\t\t\t\t\t\t<title>Annual Report</title>',
  '\t\t\t\t\t\t<description><![CDATA[Download the report. ]]></description>',
  '\t\t\t\t\t\t<link>http://tenant-a.example:8080/news/annual-report/</link>',
  '\t\t\t\t\t\t<guid isPermaLink="true">http://tenant-a.example:8080/news/annual-report/</guid>',
  '\t\t\t\t\t\t<dc:date>Mon, 01 Jun 2026 09:00:00 GMT</dc:date>',
  '\t\t\t\t\t\t<enclosure url="http://tenant-a.example:8080/_api/render/file/?fileID=A3000000-0000-0000-0000000000000001&amp;fileEXT=.pdf" length="2048" type="application/pdf" />',
  '\t\t\t\t\t</item>',
  '\t\t\t',
  '\t\t\t\t\t<item>',
  '\t\t\t\t\t\t<title>Bravo Update</title>',
  '\t\t\t\t\t\t<description><![CDATA[ <p>Read <a href="http://tenant-a.example:8080/news/bravo-update/">more</a></p>  ]]></description>',
  '\t\t\t\t\t\t<link>http://tenant-a.example:8080/news/bravo-update/</link>',
  '\t\t\t\t\t\t<guid isPermaLink="true">http://tenant-a.example:8080/news/bravo-update/</guid>',
  '\t\t\t\t\t\t<dc:date>Mon, 29 Jun 2026 10:00:00 GMT</dc:date>',
  '\t\t\t\t\t\t',
  '\t\t\t\t\t</item>',
  '\t\t\t',
  '\t\t\t\t\t<item>',
  '\t\t\t\t\t\t<title>Caf&#xe9; &amp; &lt;Co&gt; &quot;Quotes&quot; &apos;n&apos; \u20ac</title>',
  '\t\t\t\t\t\t<description><![CDATA[Prix: 5 \u20ac & <b>caf\u00e9</b> ]]></description>',
  '\t\t\t\t\t\t<link>http://tenant-a.example:8080/news/cafe-co/</link>',
  '\t\t\t\t\t\t<guid isPermaLink="true">http://tenant-a.example:8080/news/cafe-co/</guid>',
  '\t\t\t\t\t\t<dc:date>Wed, 04 Mar 2026 05:06:07 GMT</dc:date>',
  '\t\t\t\t\t\t',
  '\t\t\t\t\t</item>',
  '\t\t\t',
  '\t\t\t</channel>',
  '\t\t</rss> ',
].join('\n');

/** The cfwddx packet `{error: {message}}` processRequest answers a caught error with. */
const errorPacket = (message: string): string =>
  `<wddxPacket version='1.0'><header/><data><struct><var name='error'><struct><var name='message'><string>${message}</string></var></struct></var></struct></data></wddxPacket>`;

describe('processRequest dispatch', () => {
  const FEED_PARAMS = new Map([['feedid', FEED_ID]]);

  it.each<[string, string, Record<string, string>, FeedDispatch]>([
    ['the site root reaches feed() with the url params', '/_api/feed/v1/tenant-a/', { feedid: FEED_ID }, { kind: 'feed', params: FEED_PARAMS }],
    ['the legacy root drops two segments', '/tasks/feed/', { feedid: FEED_ID, siteid: 'tenant-a' }, { kind: 'feed', params: new Map([...FEED_PARAMS, ['siteid', 'tenant-a']]) }],
    // invoke(this,'feed',params) passes params as the argument collection, so path params never reach arguments.params.
    ['the path method `feed` invokes feed() without its params', `/_api/feed/v1/tenant-a/feed/feedid/${FEED_ID}`, { feedid: FEED_ID }, { kind: 'feed', params: new Map() }],
    ['a defined, non-public method is an invalid method call', '/_api/feed/v1/tenant-a/rss20/', { feedid: FEED_ID }, { kind: 'invalidMethodCall' }],
    ['a defined method after the legacy lead is an invalid method call', '/tasks/feed/getConfig/', { feedid: FEED_ID, siteid: 'tenant-a' }, { kind: 'invalidMethodCall' }],
    ['a path param named method is an invalid method call', '/_api/feed/v1/tenant-a/feed/a/method', { feedid: FEED_ID }, { kind: 'invalidMethodCall' }],
    ['an undefined method name falls through to feed() as a param', '/_api/feed/v1/tenant-a/latest/', { feedid: FEED_ID }, { kind: 'feed', params: new Map([...FEED_PARAMS, ['method', 'latest']]) }],
  ])('%s', (_label, pathInfo, url, expected) => {
    expect(resolveFeedDispatch({ pathInfo, url, form: {}, siteId: TENANT_A.siteId })).toEqual(expected);
  });
});

describe('response packets', () => {
  it.each([
    [MOZILLA, XML_TYPE],
    ['mozilla/5.0', XML_TYPE],
    [CURL, RSS_TYPE],
    ['', RSS_TYPE],
  ])('sets the content type of user agent %j to %s, matching "Mozilla" in any case', (userAgent, contentType) => {
    expect(feedContentType(userAgent)).toBe(contentType);
  });

  it.each<[FeedErrorType, number, string]>([
    ['authorization', 401, 'Insufficient Account Permissions'],
    ['invalidParameters', 400, 'Insufficient parameters'],
    ['invalidMethodCall', 400, 'Invalid method call'],
    ['badRequest', 400, 'Bad Request'],
    ['invalidTokens', 400, 'Invalid CSRF tokens'],
    ['unhandled', 500, 'Unhandled Exception'],
  ])('answers %s with HTTP %i and the WDDX error "%s"', (type, status, message) => {
    expect(feedErrorPacket(type, MOZILLA)).toEqual({ status, contentType: XML_TYPE, body: errorPacket(message) });
    expect(feedErrorPacket(type, CURL).contentType).toBe(RSS_TYPE);
  });

  it('writes a nested struct as cfwddx does, escaping text and keeping entry order', () => {
    const value: Parameters<typeof wddxPacket>[0] = {
      kind: 'struct',
      entries: [
        ['error', { kind: 'struct', entries: [['message', 'Tom & <Jerry>'], ['codes', ['a', 'b']]] }],
        ['ok', false],
      ],
    };
    expect(wddxPacket(value)).toBe(
      "<wddxPacket version='1.0'><header/><data><struct><var name='error'><struct><var name='message'><string>Tom &amp; &lt;Jerry&gt;</string></var>" +
        "<var name='codes'><array length='2'><string>a</string><string>b</string></array></var></struct></var>" +
        "<var name='ok'><boolean value='false'/></var></struct></data></wddxPacket>",
    );
  });
});

describe('template formatting', () => {
  it.each([
    ['Tom & Jerry', 'Tom &amp; Jerry'],
    [`<a href="x">'y'</a>`, '&lt;a href=&quot;x&quot;&gt;&apos;y&apos;&lt;/a&gt;'],
    ['caf\u00e9\u00a0\u00ff', 'caf&#xe9;&#xa0;&#xff;'],
    ['\u20ac \u0100 \u009f', '\u20ac \u0100 \u009f'],
    ['a\r\nb', 'a\nb'],
  ])('XMLFormat(%j) is %j', (input, expected) => {
    expect(cfXmlFormat(input)).toBe(expected);
  });

  it.each([
    [NOW, 'Tue, 30 Jun 2026 12:00:00 GMT'],
    [new Date(Date.UTC(2026, 2, 4, 5, 6, 7)), 'Wed, 04 Mar 2026 05:06:07 GMT'],
  ])('GetHttpTimeString(%s) is %s', (date, expected) => {
    expect(getHttpTimeString(date)).toBe(expected);
  });

  const ORIGIN = 'http://tenant-a.example:8080';
  it.each<[string, string, string, Omit<RssDescriptionOptions, 'origin'>, string]>([
    ['RSS 2.0 trims HTML and completes root paths', ' <p><a href="/x/">x</a></p> ', '', { allowHtml: 1, version: 'RSS 2.0' }, '<p><a href="http://tenant-a.example:8080/x/">x</a></p>'],
    ['RSS 0.92 keeps surrounding whitespace', ' <p><a href="/x/">x</a></p> ', '', { allowHtml: 1, version: 'RSS 0.920' }, ' <p><a href="http://tenant-a.example:8080/x/">x</a></p> '],
    ['a NULL allowHTML is not 0, so HTML is kept', '<b>bold</b>', '', { allowHtml: null, version: 'RSS 2.0' }, '<b>bold</b>'],
    ['allowHTML 0 strips tags and appends an ellipsis', '<p>Hello <b>world</b></p>', '<p>body</p>', { allowHtml: 0, version: 'RSS 2.0' }, 'Hello world...'],
    ['RSS 0.92 text falls back to the body for an empty summary', '', '<div>Body <i>text</i></div>', { allowHtml: 0, version: 'RSS 0.920' }, 'Body text...'],
  ])('describes an item: %s', (_label, summary, body, opts, expected) => {
    expect(rssItemDescription(summary, body, { ...opts, origin: ORIGIN })).toBe(expected);
  });
});

describe('RSS writers', () => {
  it('writes the RSS 2.0 document: channel, then each item with link, guid, pubDate, escaped description, categories and enclosure', () => {
    expect(writeRss20(feedView(FEED), ITEMS, OPTS)).toBe(RSS20);
  });

  it('writes an item body as content:encoded CDATA with completed paths for url.content', () => {
    const item = itemView({ ...BRAVO, body: ' <p>Body <img src="/b.png"></p> ' }, ['Zeta']);
    expect(writeRss20(feedView(FEED), [item], { ...OPTS, renderContent: true })).toContain(
      '\t\t\t\t\t<category>Zeta</category> <content:encoded><![CDATA[<p>Body <img src="http://tenant-a.example:8080/b.png"></p>]]></content:encoded> \n\t\t\t\t</item>',
    );
  });

  it('writes the RSS 0.92 document: request-host link, CDATA descriptions, permalink guids and File enclosures', () => {
    expect(writeRss092({ ...feedView(FEED), version: 'RSS 0.920' }, ITEMS, OPTS)).toBe(RSS092);
  });

  // rss20 and rss092 reset the content and set `text/xml;charset=UTF-8` themselves (feedApiUtility.cfc:296,400), replacing the user-agent type.
  it.each([
    ['RSS 2.0', RSS20],
    ['rss 0.920', RSS092],
  ])('answers version %s with 200, the cfheader text/xml type, the site locale and the document', (version, body) => {
    expect(renderFeed({ ...feedView(FEED), version }, ITEMS, OPTS)).toEqual({
      status: 200,
      contentType: 'text/xml;charset=UTF-8',
      contentLanguage: 'en-US',
      body,
    });
  });
});

/** `SELECT … FROM content.feed tcontentfeeds WHERE tcontentfeeds.feedid = ANY($1)`, feedDAO.read by id. */
const FEED_BY_ID = /FROM "?content"?\."?feed"? tcontentfeeds WHERE tcontentfeeds\.feedid = ANY\(\$1/i;

/** The contract path a request URL reaches: a family root, or its `{path}` template. */
function contractPath(url: string): string {
  const requestPath = (url.split('?')[0] ?? url).toLowerCase();
  const prefix = FEED_PATHS.find((candidate) => requestPath.startsWith(candidate.toLowerCase())) ?? requestPath;
  return requestPath.replace(/\/$/, '') === prefix.toLowerCase() ? prefix : `${prefix}/p`;
}

describe('feed routes through the composition root', () => {
  let t: TestApp;

  beforeAll(async () => {
    const db = createRecordingDb();
    seedRecordingDb(db);
    db.respond(FEED_BY_ID, (params, _sql, { tenantId }) => {
      const ids = (params[0] as string[]).map((id) => id.toLowerCase());
      if (ids.includes(FAILING_FEED_ID.toLowerCase())) throw new Error('feed read failed');
      return tenantId === TENANT_A.tenantId ? [FEED, RESTRICTED_FEED].filter((row) => ids.includes(row.feedid.toLowerCase())) : [];
    });
    t = await buildTestApp({ db, clientHandlers: SITES_HANDLERS });
  });

  afterAll(async () => {
    await t.close();
  });

  /** A GET whose answer must be one its contract operation declares. */
  async function get(url: string, headers: Record<string, string>, userAgent = MOZILLA) {
    const res = await t.app.inject({ method: 'GET', url, headers: { ...headers, 'user-agent': userAgent } });
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: contractPath(url), status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  const anonymous = (): Promise<Record<string, string>> => contentHeaders('anonymous', { site: TENANT_A.siteId });
  const member = (): Promise<Record<string, string>> => contentHeaders('member', { site: TENANT_A.siteId });
  // The gateway relays a visitor without a signed-in user with identity's anonymous-principal token (`sub` '').
  const anonymousPrincipal = (): Promise<Record<string, string>> => userHeaders({ sub: '', site: TENANT_A.siteId, roles: [] });

  it.each([
    ['the site root', '/_api/feed/v1/tenant-a/'],
    ['the legacy root with only a siteid', '/tasks/feed/?siteid=tenant-a'],
    ['a feedid in the path alone', `/_api/feed/v1/tenant-a/feed/feedid/${FEED_ID}`],
  ])('answers the unmatched empty page without a url feedid: %s', async (_label, url) => {
    const res = await get(url, await anonymous());
    expect({ status: res.statusCode, type: res.headers['content-type'], body: res.body }).toEqual({ status: 200, type: LEGACY_HTML_CONTENT_TYPE, body: '' });
  });

  it.each([
    [`/_api/feed/v1/tenant-a/rss20/?feedid=${FEED_ID}`, MOZILLA, XML_TYPE],
    [`/_api/feed/v1/tenant-a/rss20/?feedid=${FEED_ID}`, CURL, RSS_TYPE],
    [`/tasks/feed/getConfig/?siteid=tenant-a&feedid=${FEED_ID}`, MOZILLA, XML_TYPE],
  ])('answers the non-public method of %s with the 400 packet for user agent %s', async (url, userAgent, contentType) => {
    const res = await get(url, await anonymous(), userAgent);
    expect({ status: res.statusCode, type: res.headers['content-type'], body: res.body }).toEqual({ status: 400, type: contentType, body: errorPacket('Invalid method call') });
  });

  it.each([
    ['an empty feedid', '/_api/feed/v1/tenant-a/?feedid=', anonymous],
    ['the path method feed, whose params never reach feed()', `/_api/feed/v1/tenant-a/feed/feedid/${FEED_ID}?feedid=${FEED_ID}`, anonymous],
    ['an unknown feed', `/_api/feed/v1/tenant-a/?feedid=${UNKNOWN_FEED_ID}`, member],
    ['an unknown feed under a lead in another letter case', `/_API/Feed/V1/tenant-a/?feedid=${UNKNOWN_FEED_ID}`, member],
    ['an unknown feed on the legacy endpoint', `/tasks/feed/?feedid=${UNKNOWN_FEED_ID}&siteid=tenant-a`, member],
  ])('answers render404 for %s', async (_label, url, headers) => {
    const res = await get(url, await headers());
    expect({ status: res.statusCode, message: res.statusMessage, type: res.headers['content-type'], body: res.body }).toEqual({
      status: 404,
      message: 'Content Not Found',
      type: LEGACY_HTML_CONTENT_TYPE,
      body: '',
    });
  });

  it.each([
    [MOZILLA, XML_TYPE],
    [CURL, RSS_TYPE],
  ])('refuses a restricted feed to an anonymous reader with the 401 packet for user agent %s', async (userAgent, contentType) => {
    const res = await get(`/_api/feed/v1/tenant-a/?feedid=${RESTRICTED_FEED_ID}`, await anonymousPrincipal(), userAgent);
    expect({ status: res.statusCode, type: res.headers['content-type'], body: res.body }).toEqual({
      status: 401,
      type: contentType,
      body: errorPacket('Insufficient Account Permissions'),
    });
  });

  it('answers an unexpected read error with the 500 packet', async () => {
    const res = await get(`/_api/feed/v1/tenant-a/?feedid=${FAILING_FEED_ID}`, await member());
    expect({ status: res.statusCode, type: res.headers['content-type'], body: res.body }).toEqual({ status: 500, type: XML_TYPE, body: errorPacket('Unhandled Exception') });
  });

  it.each([
    ['a token of another site', `/_api/feed/v1/tenant-a/?feedid=${FEED_ID}`, () => contentHeaders('other-tenant')],
    ['a token of another site on the legacy endpoint', `/tasks/feed/?feedid=${FEED_ID}&siteid=tenant-a`, () => contentHeaders('other-tenant')],
    ['an unregistered site segment, which falls back to default', `/_api/feed/v1/nosuch/?feedid=${FEED_ID}`, member],
  ])('refuses %s with 403', async (_label, url, headers) => {
    expect((await get(url, await headers())).statusCode).toBe(403);
  });

  it.each([
    ['answers non-200', () => t.client.on(SITES_SERVICE, 'POST', FEED_SETTINGS_PATH, () => ({ status: 503, headers: {}, body: {} }))],
    // One unreachable call per family.
    ['is unreachable', () => {
      t.client.failNext(SITES_SERVICE);
      t.client.failNext(SITES_SERVICE);
    }],
  ])('answers the legacy 503 on both families when programs-sites %s, the feed read in the token tenant', async (_label, arrange) => {
    arrange();
    t.db.clear();
    t.client.clear();
    const api = await get(`/_api/feed/v1/tenant-a/?feedid=${FEED_ID}`, await member());
    const tasks = await get(`/tasks/feed/?feedid=${FEED_ID}&siteid=tenant-a`, await member(), CURL);
    expect([api.statusCode, tasks.statusCode]).toEqual([503, 503]);
    expect(tasks.body).toBe(api.body);
    expect(t.db.statements.filter((statement) => FEED_BY_ID.test(statement.sql)).map((statement) => statement.tenantId)).toEqual([TENANT_A.tenantId, TENANT_A.tenantId]);
    expect(t.client.requests.filter((req) => req.service === SITES_SERVICE)).toHaveLength(2);
  });
});

/** feedID of the RSS 2.0 and 0.92 feeds of site `default` whose bodies test/fixtures/legacy-feed holds as legacy answered them. */
const CAPTURED = [
  { fixture: 'rss20-empty', feedid: '15A1B276-ACD4-B50B-1BB45E4CD40D5435', name: 'Empty 20', version: 'RSS 2.0' },
  { fixture: 'rss092-empty', feedid: '15A1B3C2-C82D-06B6-EE63DA7D8CA53B05', name: 'Empty 092', version: 'RSS 0.920' },
] as const;

/** The channel `<pubDate>` legacy printed into the captured RSS 2.0 body. */
const CAPTURED_NOW = new Date('2026-11-12T08:54:02Z');

const SITES_SERVICE = 'programs-sites';
const FEED_SETTINGS_PATH = '/internal/v1/sites/feed-settings:lookup';

/** programs-sites' answer for the captured server's site `default`: settings as Masa installs them. */
function capturedSiteSettings(siteIds: readonly string[]): Array<Record<string, unknown>> {
  return siteIds.map(() => ({
    siteID: 'default',
    contact: 'admin@example.com',
    javaLocale: 'en_US',
    domain: 'localhost',
    domainAliases: [],
    enforcePrimaryDomain: false,
    useSSL: false,
    remote: null,
  }));
}

/** programs-sites answering every feed settings lookup with {@link capturedSiteSettings}. */
const SITES_HANDLERS: ClientHandlers = {
  [SITES_SERVICE]: {
    [`POST ${FEED_SETTINGS_PATH}`]: (req) => ({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: { items: capturedSiteSettings((req.json as { siteIds: string[] }).siteIds) },
    }),
  },
};

describe('rendered feeds through the composition root and a programs-sites double', () => {
  const DEFAULT_TENANT = tenantIdForSite('default');
  let t: TestApp;

  beforeAll(async () => {
    // The captured server named neither a port nor a context, so configBean takes the request's port.
    vi.stubEnv('MURA_PORT', undefined);
    vi.stubEnv('MURA_CONTEXT', undefined);
    const db = createRecordingDb();
    db.respond(FEED_BY_ID, (params, _sql, { tenantId }) => {
      const ids = (params[0] as string[]).map((id) => id.toLowerCase());
      const rows = CAPTURED.map(({ feedid, name, version }) => feedRow({ tenant_id: DEFAULT_TENANT, siteid: 'default', feedid, name, version }));
      return tenantId === DEFAULT_TENANT ? rows.filter((row) => ids.includes(row.feedid.toLowerCase())) : [];
    });
    t = await buildTestApp({
      db,
      clock: fixedClock(CAPTURED_NOW),
      clientHandlers: SITES_HANDLERS,
    });
    vi.unstubAllEnvs();
    // Site `default` reaches the registry as every site does, through its programs-sites state event.
    const payload = { siteId: 'default', publicUserPoolId: 'default', privateUserPoolId: 'default', categoryPoolId: 'default', filePoolId: 'default', displayPoolId: 'default', contentPoolIds: ['default'], domains: ['localhost'] };
    const envelope = testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: DEFAULT_TENANT, aggregateType: 'site', aggregateId: 'default', aggregateVersion: 1, payload });
    expect((await pushTo(t.app, subscriptionName(SERVICE, SITE_CHANGED_TOPIC), envelope)).statusCode).toBe(204);
  });

  afterAll(async () => {
    await t.close();
  });

  it.each(CAPTURED.flatMap(({ fixture, feedid }) => [
    [fixture, `/_api/feed/v1/default/?feedID=${feedid}`],
    [fixture, `/tasks/feed/?siteid=default&feedID=${feedid}`],
  ]))('renders %s byte for byte as legacy answered it for %s, with one programs-sites lookup as the service itself', async (fixture, url) => {
    t.client.clear();
    const headers = { ...(await contentHeaders('member', { site: 'default' })), host: 'localhost:21080', 'user-agent': MOZILLA };
    const res = await t.app.inject({ method: 'GET', url, headers });
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: contractPath(url), status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    expect({ status: res.statusCode, type: res.headers['content-type'], language: res.headers['content-language'], body: res.body }).toEqual({
      status: 200,
      type: RSS_CONTENT_TYPE,
      language: 'en-US',
      body: readFileSync(new URL(`../fixtures/legacy-feed/${fixture}.xml`, import.meta.url), 'utf8'),
    });
    expect(t.client.requests.map(({ service, method, path, json, userToken }) => ({ service, method, path, json, userToken }))).toEqual([
      { service: SITES_SERVICE, method: 'POST', path: FEED_SETTINGS_PATH, json: { siteIds: ['default'] }, userToken: null },
    ]);
  });
});

