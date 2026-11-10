// Remote feed import over literal RSS 2.0, RDF 1.0 and Atom 1.0 feeds: cases legacy-remote-feed.test.ts does not already hold.
import { cfHash } from '@opt2/platform/legacy-compat';
import { describe, expect, it } from 'vitest';
import {
  FEED_IMPORT_MODULE_ID,
  RemoteFeedError,
  XmlParseError,
  feedItemRemoteId,
  importItemFields,
  parseFeedXml,
  prepareRemoteFeedText,
  readRemoteFeed,
  type XmlElement,
} from '../../src/legacy/remote-feed.js';

const CONTENT_URI = 'http://purl.org/rss/1.0/modules/content/';
const DC_URI = 'http://purl.org/dc/elements/1.1/';
const ATOM_URI = 'http://www.w3.org/2005/Atom';

const RSS20 =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  `<rss version="2.0" xmlns:content="${CONTENT_URI}" xmlns:dc="${DC_URI}" xmlns:atom="${ATOM_URI}">\n<channel>\n` +
  '<atom:link href="https://example.test/feed" rel="self" type="application/rss+xml"/>\n' +
  '<title>Programs &amp; Sites</title>\n<link>https://example.test/</link>\n' +
  '<item>\n<title>First</title>\n<link>https://example.test/1</link>\n<guid isPermaLink="false">\n  <![CDATA[urn:a]]>&amp;b\n</guid>\n' +
  '<description>Summary &lt;one&gt;</description>\n<pubDate>\n Tue, 10 Jun 2003 04:00:00 GMT \n</pubDate>\n' +
  '<dc:date>2003-06-10T04:00:00Z</dc:date>\n<content:encoded><![CDATA[<p>Body one</p>]]></content:encoded>\n</item>\n' +
  '<item>\n<title>Second</title>\n<link>https://example.test/2</link>\n<dc:date>2003-06-11T04:00:00Z</dc:date>\n</item>\n' +
  '<item>\n<title>Third</title>\n<link>https://example.test/3</link>\n</item>\n' +
  '</channel>\n</rss>\n';

const RDF10 =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="${DC_URI}">\n` +
  '<channel rdf:about="https://example.test/rdf">\n<title>RDF Channel</title>\n<link>https://example.test/</link>\n' +
  '<items><rdf:Seq><rdf:li rdf:resource="https://example.test/r1"/><rdf:li rdf:resource="https://example.test/r2"/></rdf:Seq></items>\n' +
  '</channel>\n' +
  '<item rdf:about="https://example.test/r1"><title>R1</title><link>https://example.test/r1</link><dc:date>2003-06-10T04:00:00Z</dc:date></item>\n' +
  '<item rdf:about="https://example.test/r2"><title>R2</title><link>https://example.test/r2</link><dc:date>2003-06-11T04:00:00Z</dc:date></item>\n' +
  '</rdf:RDF>\n';

const ATOM10 =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  `<feed xmlns="${ATOM_URI}">\n<title type="html">News &amp;amp; Notes</title>\n<link href="https://example.test/"/>\n` +
  '<updated>2003-12-13T18:30:02Z</updated>\n<id>urn:feed</id>\n' +
  '<entry><title>A1</title><link href="https://example.test/a1"/><id>urn:a1</id><summary>S1</summary></entry>\n' +
  '<entry><title>A2</title><link href="https://example.test/a2"/><id>urn:a2</id></entry>\n' +
  '<entry><title>A3</title><link href="https://example.test/a3"/><id>urn:a3</id></entry>\n' +
  '</feed>\n';

const NO_CATEGORIES = { parentId: 'P1', siteId: 'tenant-a', categoryIds: '' };

const rssItem = (inner: string): XmlElement =>
  parseFeedXml(`<rss xmlns:content="${CONTENT_URI}" xmlns:c="${CONTENT_URI}"><channel><item>${inner}</item></channel></rss>`)
    .child('channel')
    .child('item');

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('prepareRemoteFeedText', () => {
  it.each([
    { raw: '\uFEFF\u0014 \r\n<rss/>', stripChr20: true, expected: '<rss/>' },
    { raw: '\r\n\t<!-- generator --><rss/>', stripChr20: false, expected: '<!-- generator --><rss/>' },
    { raw: '<rss>\u0013\u0014\u0015</rss>', stripChr20: true, expected: '<rss>\u0013\u0015</rss>' },
  ])('removes chr(20) only, then text before the first "<" (stripChr20=$stripChr20)', ({ raw, stripChr20, expected }) => {
    expect(prepareRemoteFeedText(raw, { stripChr20 })).toBe(expected);
  });
});

describe('parseFeedXml', () => {
  it('keeps namespace declarations among the attributes of the document element', () => {
    expect(parseFeedXml(RSS20).attributes).toEqual({
      version: '2.0',
      'xmlns:content': CONTENT_URI,
      'xmlns:dc': DC_URI,
      'xmlns:atom': ATOM_URI,
    });
    expect(parseFeedXml(ATOM10).attributes).toEqual({ xmlns: ATOM_URI });
  });

  it('reads RSS 2.0 items with content:encoded, dc:date, CDATA and decoded entities', () => {
    const [first, second] = parseFeedXml(RSS20).child('channel').children('item');
    expect(first?.child('dc:date')).toBe(first?.child('date'));
    expect(first?.child('dc:date')).toMatchObject({ name: 'dc:date', localName: 'date', xmlText: '2003-06-10T04:00:00Z' });
    expect(first?.child('content:encoded').xmlText).toBe('<p>Body one</p>');
    expect(first?.child('description').xmlText).toBe('Summary <one>');
    expect(first?.child('guid')).toMatchObject({ attributes: { isPermaLink: 'false' }, xmlText: '\n  urn:a&b\n' });
    expect(second?.child('dc:date').xmlText).toBe('2003-06-11T04:00:00Z');
    expect(second?.has('content:encoded')).toBe(false);
  });

  it('reads RDF 1.0 with prefixed attributes and items beside the channel in document order', () => {
    const root = parseFeedXml(RDF10);
    expect(root).toMatchObject({ name: 'rdf:RDF', localName: 'RDF' });
    expect(root.child('channel').child('title').xmlText).toBe('RDF Channel');
    const sequence = root.child('channel').child('items').child('rdf:Seq').children('li');
    expect(sequence.map((li) => li.attributes['rdf:resource'])).toEqual(['https://example.test/r1', 'https://example.test/r2']);
    const items = root.children('item');
    expect(items.map((item) => item.attributes['rdf:about'])).toEqual(['https://example.test/r1', 'https://example.test/r2']);
    expect(items.map((item) => item.child('dc:date').xmlText)).toEqual(['2003-06-10T04:00:00Z', '2003-06-11T04:00:00Z']);
  });

  it('decodes one level of entities in Atom text and keeps attributes of default-namespace elements', () => {
    const title = parseFeedXml(ATOM10).child('title');
    expect(title).toMatchObject({ name: 'title', localName: 'title', attributes: { type: 'html' }, xmlText: 'News &amp; Notes' });
  });

  it('throws XmlParseError at the end of a feed truncated mid-item', () => {
    const truncated = RSS20.slice(0, RSS20.indexOf('</item>'));
    const error = thrownBy(() => parseFeedXml(truncated));
    expect(error).toBeInstanceOf(XmlParseError);
    expect(error).toMatchObject({
      name: 'XmlParseError',
      position: truncated.length,
      namespaceError: false,
      message: `The element type "item" must be terminated (offset ${String(truncated.length)})`,
    });
  });

  it.each([
    ['in the line-end-normalised text', '<rss>\r\n<a></b></rss>', 12, 'The element type "a" must be terminated by the matching end-tag "</a>"'],
    ['of an end tag holding more than white space', '<rss></rss x>', 11, 'The end-tag for element type "rss" must end with a ">" delimiter'],
  ])('reports the offset %s', (_label, text, position, message) => {
    const error = thrownBy(() => parseFeedXml(text));
    expect(error).toBeInstanceOf(XmlParseError);
    expect(error).toMatchObject({ position, namespaceError: false, message: `${message} (offset ${String(position)})` });
  });
});

describe('readRemoteFeed', () => {
  const raw = `\uFEFF\r\n ${RSS20.replace('<title>Programs', '<title>\u0014Programs')}`;

  it('reads a response carrying a BOM and chr(20) once prepared with stripChr20, as getRemoteFeedData does', () => {
    const feed = readRemoteFeed(prepareRemoteFeedText(raw, { stripChr20: true }), 2);
    expect(feed).toMatchObject({ type: 'rss', channelTitle: 'Programs & Sites', maxItems: 2 });
    expect(feed.items.map((item) => item.child('title').xmlText)).toEqual(['First', 'Second', 'Third']);
  });

  it('leaves chr(20) for cfeed.import1, whose parseXML then rejects the same response', () => {
    const error = thrownBy(() => parseFeedXml(prepareRemoteFeedText(raw)));
    expect(error).toBeInstanceOf(XmlParseError);
    expect((error as XmlParseError).message).toMatch(/^An invalid XML character \(Unicode: 0x0014\) was found/);
  });

  it('caps maxItems for Atom 1.0 while keeping every entry in document order', () => {
    const feed = readRemoteFeed(ATOM10, 2);
    expect(feed).toMatchObject({ type: 'atom', channelTitle: 'News &amp; Notes', maxItems: 2 });
    expect(feed.items.map((entry) => entry.child('id').xmlText)).toEqual(['urn:a1', 'urn:a2', 'urn:a3']);
  });

  it('detects the document element case-insensitively, as StructKeyExists does', () => {
    const feed = readRemoteFeed('<RSS><CHANNEL><TITLE>Upper</TITLE><ITEM><LINK>l</LINK></ITEM></CHANNEL></RSS>', 20);
    expect(feed).toMatchObject({ type: 'rss', channelTitle: 'Upper', maxItems: 1 });
  });

  it('detects RDF 1.0 by its rdf:RDF element and fails with the XMLSearch error ACF 2023 raises for "//:channel"', () => {
    const error = thrownBy(() => readRemoteFeed(RDF10, 20));
    expect(error).toBeInstanceOf(RemoteFeedError);
    expect(error).toMatchObject({
      name: 'RemoteFeedError',
      message: 'Unable to process the result of the XMLSearch for Unexpected token ":" at start of expression.',
    });
  });

  it('reports a truncated response as no XML, as isXML does', () => {
    expect(readRemoteFeed(RSS20.slice(0, RSS20.indexOf('</item>')), 20)).toEqual({ items: [], maxItems: 0 });
  });
});

describe('feedItemRemoteId', () => {
  it.each([
    ['an untrimmed guid with CDATA and entities decoded', '<guid isPermaLink="false">\n <![CDATA[a]]>&amp;b\n</guid><link>L</link>', '\n a&b\n'],
    ['a GUID element matched case-insensitively', '<GUID>G</GUID><link>L</link>', 'G'],
    ['the first 255 characters of a link without a guid', `<link>${'l'.repeat(300)}</link>`, 'l'.repeat(255)],
  ])('hashes %s with CFMX_COMPAT', (_label, inner, hashed) => {
    expect(feedItemRemoteId(rssItem(inner))).toBe(cfHash(hashed, 'CFMX_COMPAT'));
  });

  it('gives guids that share their first 255 characters one remoteID', () => {
    const prefix = 'p'.repeat(255);
    const first = feedItemRemoteId(rssItem(`<guid>${prefix}${'A'.repeat(45)}</guid>`));
    expect(feedItemRemoteId(rssItem(`<guid>${prefix}${'B'.repeat(45)}</guid>`))).toBe(first);
    expect(first).toBe(cfHash(prefix, 'CFMX_COMPAT'));
    expect(first).not.toBe(cfHash(`${prefix}${'A'.repeat(45)}`, 'CFMX_COMPAT'));
  });
});

describe('importItemFields', () => {
  it('builds the feedItem struct without categoryAssign keys for a feed without categories, keeping pubDate untrimmed', () => {
    const first = parseFeedXml(RSS20).child('channel').child('item');
    expect(importItemFields(first, NO_CATEGORIES)).toEqual({
      remoteURL: 'https://example.test/1',
      title: 'First',
      summary: 'Summary <one>',
      remotePubDate: '\n Tue, 10 Jun 2003 04:00:00 GMT \n',
      releaseDate: new Date('2003-06-10T04:00:00.000Z'),
      remoteID: cfHash('\n  urn:a&b\n', 'CFMX_COMPAT'),
      body: '<p>Body one</p>',
      parentID: 'P1',
      siteID: 'tenant-a',
      approved: 1,
      type: 'Page',
      display: 1,
      isNav: 1,
      moduleID: FEED_IMPORT_MODULE_ID,
      mode: 'import',
    });
  });

  it.each([
    ['an empty content:encoded over the description', '<content:encoded/><description>D</description>', 'D', ''],
    ['the description when the content module uses another prefix', '<c:encoded>C</c:encoded><description>D</description>', 'D', 'D'],
    ['an empty description over the summary', '<description/><summary>S</summary>', '', ''],
  ])('takes summary and body from %s', (_label, extra, summary, body) => {
    const fields = importItemFields(rssItem(`<link>L</link><title>T</title><pubDate>x</pubDate>${extra}`), NO_CATEGORIES);
    expect(fields.summary).toBe(summary);
    expect(fields.body).toBe(body);
  });

  it('keeps summary and body whole while truncating remoteURL and title', () => {
    const long = 'd'.repeat(300);
    const fields = importItemFields(rssItem(`<link>L</link><title>T</title><pubDate/><description>${long}</description>`), NO_CATEGORIES);
    expect([fields.summary, fields.body]).toEqual([long, long]);
  });

  it('uses options.hash for remoteID and options.now for the milliseconds of a zone-converted releaseDate', () => {
    const now = new Date(Date.UTC(2026, 5, 30, 0, 0, 0, 645));
    const item = rssItem('<guid>G</guid><link>L</link><title>T</title><pubDate>10 Jun 2003 04:00:00 EST</pubDate>');
    const fields = importItemFields(item, NO_CATEGORIES, { hash: (s) => `h(${s})`, now });
    expect(fields.remoteID).toBe('h(G)');
    expect(fields.releaseDate?.toISOString()).toBe('2003-06-10T09:00:00.645Z');
  });
});
