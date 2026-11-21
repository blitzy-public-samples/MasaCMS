// Remote feed reader against ACF 2023.0.26 behaviour observed for xmlParse, hash(…, "CFMX_COMPAT"), isDate and parseDateTime.
import { cfHash } from '@opt2/platform/legacy-compat';
import { describe, expect, it } from 'vitest';
import {
  FEED_IMPORT_MODULE_ID,
  RemoteFeedError,
  XmlElementUndefinedError,
  XmlParseError,
  cfParseDateTime,
  feedItemRemoteId,
  importFormat,
  importItemFields,
  importOrder,
  isImportSelected,
  parseFeedXml,
  prepareRemoteFeedText,
  previewOrder,
  readRemoteFeed,
  rssChannelItems,
} from '../../src/legacy/remote-feed.js';

const CONTENT_NS = 'xmlns:content="http://purl.org/rss/1.0/modules/content/"';

const RSS20 =
  `<?xml version="1.0" encoding="UTF-8"?><!-- c --><rss version="2.0" ${CONTENT_NS}><channel>` +
  '<title>T &amp; <![CDATA[<b>x</b>]]> &#65;&#x42;</title>' +
  '<item><title>a<b>child</b>c</title><link>L1</link><guid>G1</guid><description>D1</description>' +
  '<pubDate>Tue, 10 Jun 2003 04:00:00 GMT</pubDate><content:encoded><![CDATA[<p>body</p>]]></content:encoded>' +
  '<content:encoded>second</content:encoded></item>' +
  '<ITEM><Title>t2</Title><link>L2</link><guid/></ITEM></channel></rss>';

const NAMESPACED_RSS =
  '<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="m" xmlns:a="http://www.w3.org/2005/Atom"><channel>' +
  '<a:title>AT</a:title><title>CT</title>' +
  '<item><dc:title>DCT</dc:title><title>T</title><media:item>MI</media:item><a:summary>AS</a:summary><dc:link>DL</dc:link><link>L</link></item>' +
  '<a:item><title>nsitem</title></a:item><item><title>T2</title><description>D</description></item></channel></rss>';

const RDF =
  '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">' +
  '<channel rdf:about="c"><title>RT</title><items><rdf:Seq><rdf:li resource="a"/></rdf:Seq></items></channel>' +
  '<item rdf:about="a"><title>I1</title><link>l1</link></item><item><title>I2</title></item></rdf:RDF>';

const ATOM =
  '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>AT</title>' +
  '<entry><title>E1</title><link href="h1"/><summary>S1</summary></entry><entry><title>E2</title></entry></feed>';

const firstItem = (xml: string) => rssChannelItems(parseFeedXml(xml))[0]!;
const item = (inner: string) => firstItem(`<rss ${CONTENT_NS}><channel><item>${inner}</item></channel></rss>`);
const FEED = { parentId: 'P1', siteId: 'tenant-a', categoryIds: '' };

/** RSS 2.0 text in the shape feedApiUtility.cfc:297-379 renders, tabs and line breaks included. */
function masaRss20(items: { title: string; link: string; contentId: string; pubDate: string; description: string; body: string }[]): string {
  const rendered = items
    .map(
      (i) =>
        `\n\t\t\t\n\t\t\t\t<item>\n\t\t\t\t\t<title>${i.title}</title>\n\t\t\t\t\t<link>${i.link}</link><guid isPermaLink="false">${i.contentId}</guid>` +
        `\n\t\t\t\t\t<pubDate>${i.pubDate}</pubDate>\n\t\t\t\t\t<description>${i.description}</description>\n\t\t\t\t\t<category>News</category>` +
        `\n\t\t\t\t\t<content:encoded><![CDATA[${i.body}]]></content:encoded>\n\t\t\t\t\t\n\t\t\t\t</item>`,
    )
    .join('');
  return (
    '<?xml version="1.0" ?>\n\t\t<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">' +
    '\n\t\t\t<channel>\n\t\t\t\t<title>News &amp; Events</title>\n\t\t\t\t<link>http://localhost:8080</link>' +
    '\n\t\t\t\t<description></description>\n\t\t\t\t<webMaster>admin@example.com</webMaster>\n\t\t\t\t<generator>https://www.masacms.com</generator>' +
    '\n\t\t\t\t<pubDate>Wed, 01 Jul 2026 10:00:00 GMT</pubDate>\n\t\t\t\t<language>en-us</language>' +
    '\n\t\t\t\t<atom:link href="http://localhost:8080/index.cfm/_api/feed/v1/tenant-a/?feedID=F1" rel="self" type="application/rss+xml" />' +
    `${rendered}\n\t\t</channel>\n\t\t</rss>`
  );
}

describe('prepareRemoteFeedText', () => {
  it.each([
    { raw: '\uFEFF  junk <?xml version="1.0"?><rss/>', stripChr20: false, expected: '<?xml version="1.0"?><rss/>' },
    { raw: 'a\u0014b<rss>\u0014</rss>', stripChr20: true, expected: '<rss></rss>' },
    { raw: 'a\u0014b<rss>\u0014</rss>', stripChr20: false, expected: '<rss>\u0014</rss>' },
    { raw: 'no markup at all', stripChr20: true, expected: '' },
  ])('strips leading text (stripChr20=$stripChr20)', ({ raw, stripChr20, expected }) => {
    expect(prepareRemoteFeedText(raw, { stripChr20 })).toBe(expected);
  });

  it('keeps the text unchanged without options when it starts with markup', () => {
    expect(prepareRemoteFeedText('<rss/>')).toBe('<rss/>');
  });
});

describe('parseFeedXml', () => {
  it('reads RSS 2.0 with CDATA, entities and character references', () => {
    const root = parseFeedXml(RSS20);
    const channel = root.child('channel');
    expect(root.name).toBe('rss');
    expect(root.attributes).toMatchObject({ version: '2.0' });
    expect(channel.child('Title').xmlText).toBe('T & <b>x</b> AB');
    const [first, second] = channel.children('item');
    expect(first!.child('title').xmlText).toBe('ac');
    expect(first!.children('CONTENT:ENCODED').map((e) => e.xmlText)).toEqual(['<p>body</p>', 'second']);
    expect(first!.child('encoded').xmlText).toBe('<p>body</p>');
    expect(first!.xmlText).toBe('');
    expect(second!.name).toBe('ITEM');
    expect(second!.child('guid').xmlText).toBe('');
    expect(second!.has('pubDate')).toBe(false);
    expect(() => second!.child('pubDate')).toThrow(XmlElementUndefinedError);
  });

  it('matches children by qualified or local name, first match winning', () => {
    const channel = parseFeedXml(NAMESPACED_RSS).child('channel');
    expect(channel.child('title').xmlText).toBe('AT');
    expect(channel.children('item').map((e) => e.name)).toEqual(['item', 'a:item', 'item']);
    const first = channel.child('item');
    expect(first.child('title').xmlText).toBe('DCT');
    expect(first.child('DC:TITLE').localName).toBe('title');
    expect(first.child('summary').xmlText).toBe('AS');
    expect(first.child('link').xmlText).toBe('DL');
    expect(first.has('x:title')).toBe(false);
  });

  it('keeps direct text untrimmed, skips comments and processing instructions, and normalises line ends', () => {
    expect(parseFeedXml('<rss>  <a>x</a>\n t <!--c--><?pi d?></rss>').xmlText).toBe('  \n t ');
    expect(parseFeedXml('<rss>a\r\nb\rc<![CDATA[d\r\ne]]>&#13;</rss>').xmlText).toBe('a\nb\ncd\ne\r');
    expect(parseFeedXml("<rss a='x\ty\r\nz' b=\"&lt;&#65;&quot;\" xml:lang='en'/>").attributes).toEqual({
      a: 'x y z',
      b: '<A"',
      'xml:lang': 'en',
    });
  });

  it.each([
    ["<?xml version='1.1' standalone='yes'?>\n  <rss>a</rss>", 'a'],
    ["<?xml version='1.0' encoding='ISO-8859-1'?><?xml-stylesheet href='a'?><!-- c --><rss>é</rss> <!-- c --> <?pi x?>\n", 'é'],
    ["<rss xmlns=''>&#x1F600;&#x85;\u007F</rss >", '\u{1F600}\u0085\u007F'],
    ['<été>x<![CDATA[]]>y</été>', 'xy'],
    ['<rss a = "1"><!----></rss>', ''],
    ['<rss>a<?pi?>b</rss>', 'ab'],
  ])('accepts %j', (text, xmlText) => {
    expect(parseFeedXml(text).xmlText).toBe(xmlText);
  });

  it.each([
    ['leading white space', " <?xml version='1.0'?><rss/>", false],
    ['leading text', 'abc<rss/>', false],
    ['a byte-order mark', "\uFEFF<?xml version='1.0'?><rss/>", false],
    ['an empty document', '', false],
    ['an internal DOCTYPE', '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY foo "bar">]><rss>&foo;</rss>', false],
    ['a public DOCTYPE', '<!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "http://my.netscape.com/rss-0.91.dtd"><rss/>', false],
    ['an undeclared entity', '<rss>a&nbsp;b</rss>', false],
    ['a bare ampersand', '<rss>a & b</rss>', false],
    ['"]]>" in text', '<rss>a ]]> c</rss>', false],
    ['chr(20)', '<rss>a\u0014b</rss>', false],
    ['U+FFFE', '<rss>a\uFFFEb</rss>', false],
    ['a NUL reference', '<rss>&#0;</rss>', false],
    ['a control reference', '<rss>&#x1F;</rss>', false],
    ['a surrogate reference', '<rss>&#xD800;</rss>', false],
    ['mismatched tags', '<rss><a></b></rss>', false],
    ['an unterminated element', '<rss><a>', false],
    ['an end tag with leading space', '<rss></ rss>', false],
    ['trailing text', '<rss></rss>junk', false],
    ['a second root', '<rss></rss><x/>', false],
    ['an unquoted attribute', '<rss a=b></rss>', false],
    ['a duplicate attribute', "<rss a='1' a='2'></rss>", false],
    ['"<" in an attribute', "<rss a='<'></rss>", false],
    ['attributes without white space', "<rss a='1'b='2'/>", false],
    ['an attribute without "="', "<rss a '1'/>", false],
    ['an unterminated attribute', "<rss a='1", false],
    ['an uppercase XML declaration', "<?XML version='1.0'?><rss/>", false],
    ['a declaration without version', "<?xml encoding='UTF-8'?><rss/>", false],
    ['an "xml" PI in content', "<rss>a<?xml version='1.0'?></rss>", false],
    ['a PI without space before data', '<rss><?pi?x?></rss>', false],
    ['an unterminated PI', '<rss><?pi x</rss>', false],
    ['"--" in a comment', '<rss>a<!-- x -- y --></rss>', false],
    ['a comment ending in "--->"', '<rss>a<!-- x ---></rss>', false],
    ['an unterminated comment', '<rss><!-- x</rss>', false],
    ['an unterminated CDATA section', '<rss><![CDATA[x</rss>', false],
    ['a name starting with a digit', '<1rss/>', false],
    ['an unbound element prefix', '<rss><dc:date>x</dc:date></rss>', true],
    ['a prefix whose case differs from its declaration', `<rss ${CONTENT_NS}><Content:Encoded/></rss>`, true],
    ['an unbound attribute prefix', "<rss foo:a='1'/>", true],
    ['a name with two colons', '<a:b:c>x</a:b:c>', true],
    ['an empty prefix declaration', "<rss xmlns:p=''/>", true],
    ['the xmlns element prefix', '<xmlns:a/>', true],
    ['attributes with one expanded name', "<rss xmlns:a='u' xmlns:b='u' a:x='1' b:x='2'/>", true],
  ])('throws for %s', (_label, text, namespaceError) => {
    let thrown: unknown;
    try {
      parseFeedXml(text);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(XmlParseError);
    expect((thrown as XmlParseError).namespaceError).toBe(namespaceError);
  });
});

describe('readRemoteFeed', () => {
  it('reads RSS channel title and items, clamping maxItems', () => {
    const feed = readRemoteFeed(RSS20, 1);
    expect(feed).toMatchObject({ type: 'rss', channelTitle: 'T & <b>x</b> AB', maxItems: 1 });
    expect(feed.items.map((e) => e.child('link').xmlText)).toEqual(['L1', 'L2']);
    expect(readRemoteFeed(RSS20, 20).maxItems).toBe(2);
  });

  it('reads Atom entries for the preview', () => {
    const feed = readRemoteFeed(ATOM, 20);
    expect(feed).toMatchObject({ type: 'atom', channelTitle: 'AT', maxItems: 2 });
    expect(feed.items[0]!.child('link').attributes).toEqual({ href: 'h1' });
  });

  it.each([
    ['an RSS channel without items', '<rss><channel><title>t</title></channel></rss>', 'rss'],
    ['an Atom feed without entries', '<feed><title>t</title></feed>', 'atom'],
    ['an unknown document element', '<html><title>t</title></html>', undefined],
  ])('reports no items for %s', (_label, text, type) => {
    const feed = readRemoteFeed(text, 20);
    expect(feed.type).toBe(type);
    expect(feed.items).toEqual([]);
    expect(feed.maxItems).toBe(0);
  });

  it('returns maxItems 0 without xml for text CFML isXML rejects', () => {
    expect(readRemoteFeed('<!DOCTYPE rss><rss/>', 20)).toEqual({ items: [], maxItems: 0 });
  });

  it('throws for namespace errors, which isXML accepts but parseXML rejects', () => {
    expect(() => readRemoteFeed('<rss><dc:date>x</dc:date></rss>', 20)).toThrow(XmlParseError);
  });

  it('throws the legacy XMLSearch error for RDF feeds, which parse as XML', () => {
    expect(parseFeedXml(RDF).name).toBe('rdf:RDF');
    expect(() => readRemoteFeed(RDF, 20)).toThrow(RemoteFeedError);
  });

  it('throws when an RSS channel lacks a title, as legacy does', () => {
    expect(() => readRemoteFeed('<rss><channel><item/></channel></rss>', 20)).toThrow(XmlElementUndefinedError);
  });
});

describe('doImport selection', () => {
  it.each([
    ['RSS 2.0', 'rss'],
    ['rss 2.0', 'rss'],
    ['Rss 0.920', 'rss'],
    ['ATOM', 'atom'],
    ['atom ', undefined],
    ['RSS 2.0 ', undefined],
    ['RSS 1.0', undefined],
  ])('maps version %j to %j', (version, format) => {
    expect(importFormat(version)).toBe(format);
  });

  it('reads xmlFeed.rss.channel.item and throws where CFML does', () => {
    expect(rssChannelItems(parseFeedXml(RSS20))).toHaveLength(2);
    expect(() => rssChannelItems(parseFeedXml(ATOM))).toThrow(XmlElementUndefinedError);
    expect(() => rssChannelItems(parseFeedXml('<rss><channel/></rss>'))).toThrow(XmlElementUndefinedError);
  });

  it.each([
    [5, ['c', 'b', 'a'], ['a', 'b', 'c']],
    [2, ['b', 'a'], ['a', 'b']],
    [0, [], []],
    [-1, [], []],
  ])('orders items for maxItems %i', (maxItems, imported, previewed) => {
    expect(importOrder(['a', 'b', 'c'], maxItems)).toEqual(imported);
    expect(previewOrder(['a', 'b', 'c'], maxItems)).toEqual(previewed);
  });

  it.each([
    [undefined, false],
    ['All', true],
    ['ALL', true],
    ['X,,ID1', true],
    ['id1', false],
    ['X', false],
  ])('selects remoteID %j: %j', (param, selected) => {
    expect(isImportSelected(param, 'ID1')).toBe(selected);
  });
});

describe('feedItemRemoteId', () => {
  const long = 'g'.repeat(300);

  it.each([
    ['the guid', '<guid>G1</guid><link>L1</link>', 'G1'],
    ['an empty guid', '<guid/><link>L1</link>', ''],
    ['the link without a guid', '<link>L1</link>', 'L1'],
    ['the first 255 characters of the guid', `<guid>${long}</guid>`, long.slice(0, 255)],
  ])('hashes %s with CFMX_COMPAT', (_label, inner, hashed) => {
    expect(feedItemRemoteId(item(inner))).toBe(cfHash(hashed, 'CFMX_COMPAT'));
  });

  it('matches the hash legacy stores for an empty guid', () => {
    expect(feedItemRemoteId(item('<guid></guid>'))).toBe('D41D8CD98F00B204E9800998ECF8427E');
  });

  it('uses an injected hash and throws without guid and link', () => {
    expect(feedItemRemoteId(item('<guid>G</guid>'), (s) => `h(${s})`)).toBe('h(G)');
    expect(() => feedItemRemoteId(item('<title>t</title>'))).toThrow(XmlElementUndefinedError);
  });
});

describe('importItemFields', () => {
  it('builds the feedItem struct of doImport', () => {
    const fields = importItemFields(firstItem(RSS20), { parentId: 'P1', siteId: 'tenant-a', categoryIds: 'A-B-C,,D-E' });
    expect(fields).toEqual({
      remoteURL: 'L1',
      title: 'ac',
      summary: 'D1',
      remotePubDate: 'Tue, 10 Jun 2003 04:00:00 GMT',
      releaseDate: new Date('2003-06-10T04:00:00.000Z'),
      remoteID: cfHash('G1', 'CFMX_COMPAT'),
      body: '<p>body</p>',
      parentID: 'P1',
      siteID: 'tenant-a',
      approved: 1,
      type: 'Page',
      display: 1,
      isNav: 1,
      moduleID: FEED_IMPORT_MODULE_ID,
      mode: 'import',
      categoryAssignABC: 0,
      categoryAssignDE: 0,
    });
  });

  it.each([
    ['description', '<description>D</description><summary>S</summary>', 'D', 'D'],
    ['summary', '<summary>S</summary>', 'S', 'S'],
    ['neither', '', '', undefined],
  ])('takes summary and body from %s', (_label, extra, summary, body) => {
    const fields = importItemFields(item(`<link>L</link><title>T</title><pubDate>soon</pubDate>${extra}`), FEED);
    expect(fields.summary).toBe(summary);
    expect(fields.body).toBe(body);
    expect('body' in fields).toBe(body !== undefined);
    expect('releaseDate' in fields).toBe(false);
  });

  it('truncates link and title to 255 characters and assigns categories from an id array', () => {
    const long = 'x'.repeat(300);
    const fields = importItemFields(item(`<link>${long}</link><title>${long}</title><pubDate/>`), { ...FEED, categoryIds: ['1-2'] });
    expect(fields.remoteURL).toHaveLength(255);
    expect(fields.title).toHaveLength(255);
    expect(fields.categoryAssign12).toBe(0);
  });

  it.each([['link', '<title>T</title><pubDate/>'], ['title', '<link>L</link><pubDate/>'], ['pubDate', '<link>L</link><title>T</title>']])(
    'throws without %s',
    (_missing, inner) => {
      expect(() => importItemFields(item(inner), FEED)).toThrow(XmlElementUndefinedError);
    },
  );

  it('round-trips the RSS 2.0 Masa renders', () => {
    const rendered = [
      { title: 'First &amp; best', link: 'http://localhost:8080/news/first/', contentId: 'C1', pubDate: 'Tue, 30 Jun 2026 09:15:00 GMT', description: 'One', body: '<p>1</p>' },
      { title: 'Second', link: 'http://localhost:8080/news/second/?a=1&amp;b=2', contentId: 'C2', pubDate: 'Mon, 29 Jun 2026 08:00:00 GMT', description: 'Two', body: '<p>2</p>' },
    ];
    const text = masaRss20(rendered);
    expect(readRemoteFeed(prepareRemoteFeedText(text, { stripChr20: true }), 20)).toMatchObject({ type: 'rss', channelTitle: 'News & Events', maxItems: 2 });
    const imported = importOrder(rssChannelItems(parseFeedXml(text)), 20).map((i) => importItemFields(i, FEED));
    expect(imported.map((f) => [f.title, f.remoteURL, f.remoteID, f.body, f.releaseDate?.toISOString()])).toEqual([
      ['Second', 'http://localhost:8080/news/second/?a=1&b=2', cfHash('C2', 'CFMX_COMPAT'), '<p>2</p>', '2026-06-29T08:00:00.000Z'],
      ['First & best', 'http://localhost:8080/news/first/', cfHash('C1', 'CFMX_COMPAT'), '<p>1</p>', '2026-06-30T09:15:00.000Z'],
    ]);
  });

  it('throws for the RSS 0.92 Masa renders, whose items carry dc:date instead of pubDate', () => {
    const rss092 =
      '<?xml version="1.0" ?>\n\t\t<rss version="0.92"\n\t\t\txmlns:dc="http://purl.org/dc/elements/1.1/">\n\t\t\t<channel><title>N</title>' +
      '<item><title>T</title><description><![CDATA[d ]]></description><link>L</link><guid isPermaLink="true">L</guid>' +
      '<dc:date>Tue, 30 Jun 2026 09:15:00 GMT</dc:date></item></channel></rss>';
    expect(() => importItemFields(firstItem(rss092), FEED)).toThrow(XmlElementUndefinedError);
  });
});

describe('cfParseDateTime', () => {
  const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 645));
  const local = (d: Date): string =>
    `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;

  it.each([
    'Tue, 10 Jun 2003 04:00:00',
    'Tue, 10 Jun 2003 04:00:00 -0500',
    'Tue, 10 Jun 2003 04:00:00 +0530',
    'Tue, 10 Jun 2003 04:00:00 UT',
    'Tue, 10 Jun 2003 04:00:00 EDT',
    'Tue, 10 Jun 2003 04:00:00 CEST',
    'Tue, 10 Jun 2003 04:00:00 AST',
    'Tue, 10 Jun 2003 04:00:00 America/New_York',
    'Tue, 10 Jun 2003 04:00:00 -0500 (EST)',
    'Tue, 10 Jun 2003 04:00:00 A',
    '10 Jun 2003 04:00:00 AM',
    'Tuesday, 10 June 2003 04:00:00',
    'Mon, 10 Jun 2003 04:00:00',
    'Tue 10 Jun 2003 4:0:0',
    'Tue, 010 Jun 03 04.00.00',
    'Jun 10, 2003 04:00:00',
    'Tue Jun 10 2003 04:00:00',
    '2003-06-10T04:00:00',
    '2003-06-10 04:00:00',
    "{ts '2003-06-10 04:00:00'}",
  ])('keeps the wall clock of %j', (text) => {
    expect(local(cfParseDateTime(text, now)!)).toBe('2003-06-10 04:00:00.000');
  });

  it.each([
    ['Tue, 10 Jun 2003 04:00:00 PM', '2003-06-10 16:00:00.000'],
    ['Tue, 10 Jun 2003 04:00:00 PST', '2003-06-10 16:00:00.000'],
    ['Tue, 10 Jun 2003 04:00:00 PT', '2003-06-10 16:00:00.000'],
    ['Tue, 10 Jun 2003 4 PM', '2003-06-10 16:00:00.000'],
    ['Tue, 10 Jun 2003 12:00:00 AM', '2003-06-10 00:00:00.000'],
    ['Tue, 10 Jun 2003 12:00:00 PM', '2003-06-10 12:00:00.000'],
    ['Tue, 10 Jun 2003 13:00:00 PM', '2003-06-10 13:00:00.000'],
    ['Fri, 13 Feb 2026 09:15:30 +0100', '2026-02-13 09:15:30.000'],
    ['Tue, 10 Jun 2003', '2003-06-10 00:00:00.000'],
    ['10-Jun-2003', '2003-06-10 00:00:00.000'],
    ['June 10, 2003', '2003-06-10 00:00:00.000'],
    ['Jun 2003', '2003-06-01 00:00:00.000'],
    ['Jun 10, 2003 04:00:00 PM', '2003-06-10 16:00:00.000'],
    ['2003-06-10', '2003-06-10 00:00:00.000'],
    ['2003/06/10', '2003-06-10 00:00:00.000'],
    ['2003-6-1', '2003-06-01 00:00:00.000'],
    ['2003-06-10 4:00 PM', '2003-06-10 16:00:00.000'],
    ['06/10/2003', '2003-06-10 00:00:00.000'],
    ['6/10/03', '2003-06-10 00:00:00.000'],
    ['06/10/2003 4:00 PM', '2003-06-10 16:00:00.000'],
    ['10.06.2003', '2003-10-06 00:00:00.000'],
    ['04:00:00', '1899-12-30 04:00:00.000'],
    ['4:00 PM', '1899-12-30 16:00:00.000'],
    ['Tue, 10 Jun 69 04:00:00', '1969-06-10 04:00:00.000'],
    ['Tue, 10 Jun 29 04:00:00', '2029-06-10 04:00:00.000'],
    ['Tue, 10 Jun 30 04:00:00', '1930-06-10 04:00:00.000'],
    ['Tue, 10 Jun 0003 04:00:00', '2003-06-10 04:00:00.000'],
    ['Tue, 10 Jun 103 04:00:00', '0103-06-10 04:00:00.000'],
    ['Tue, 29 Feb 2004 04:00:00', '2004-02-29 04:00:00.000'],
  ])('reads %j as local %s', (text, expected) => {
    expect(local(cfParseDateTime(text, now)!)).toBe(expected);
  });

  it.each([
    ['Tue, 10 Jun 2003 04:00:00 GMT', '2003-06-10T04:00:00.000Z'],
    ['\n  Tue, 10 Jun 2003 04:00:00 gmt  \n', '2003-06-10T04:00:00.000Z'],
    ['10 Jun 2003 04:00:00 +0000', '2003-06-10T04:00:00.000Z'],
    ['10 Jun 2003 04:00:00 Z', '2003-06-10T04:00:00.000Z'],
    ['Tue, 10 Jun 2003 04 GMT', '2003-06-10T04:00:00.000Z'],
    ['Tue, 10 Jun 2003 04:00:00.5 GMT', '2003-06-10T04:00:00.500Z'],
    ['Tue, 10/Jun/2003T04:00:00 GMT', '2003-06-10T04:00:00.000Z'],
    ['10 Jun 2003 04:00:00 GMT+1', '2003-06-10T03:00:00.000Z'],
    ['10 Jun 2003 04:00:00 GMT-05:00', '2003-06-10T09:00:00.000Z'],
    ['10 Jun 2003 04:00:00 +05:30', '2003-06-09T22:30:00.000Z'],
    ['10 Jun 2003 04:00:00 -08:00', '2003-06-10T12:00:00.000Z'],
    ['2003-06-10T04:00Z', '2003-06-10T04:00:00.000Z'],
    ['2003-06-10t04:00:00.123456z', '2003-06-10T04:00:00.123Z'],
    ['2003-06-10T04:00:00+02:00', '2003-06-10T02:00:00.000Z'],
    ['2003-06-10T04:00:00+02', '2003-06-10T02:00:00.000Z'],
    ['2003-06-10T04:00:00 GMT', '2003-06-10T04:00:00.000Z'],
    ['10 Jun 2003 04:00:00 EST', '2003-06-10T09:00:00.645Z'],
    ['Tue, 10 Jun 2003 04:00:00 est', '2003-06-10T09:00:00.645Z'],
    ['10 Jun 2003 04:00:00 EST5EDT', '2003-06-10T09:00:00.645Z'],
    ['10 Jun 2003 04:00:00 AEST', '2003-06-10T09:00:00.645Z'],
    ['10 Jun 2003 04:00:00 CST', '2003-06-10T09:00:00.645Z'],
    ['10 Jun 2003 04:00:00 MST', '2003-06-10T11:00:00.645Z'],
    ['10 Jun 2003 04:00:00 HST', '2003-06-10T14:00:00.645Z'],
    ['10 Jun 2003 04:00:00 UTC', '2003-06-10T04:00:00.645Z'],
    ['10 Jun 2003 04:00:00 UTC+1', '2003-06-10T04:00:00.645Z'],
    ['10 Jun 2003 04:00:00 GMT0', '2003-06-10T04:00:00.645Z'],
    ['10 Jun 2003 04:00:00 WET', '2003-06-10T03:00:00.645Z'],
    ['10 Jun 2003 04:00:00 CET', '2003-06-10T02:00:00.645Z'],
    ['10 Jun 2003 04:00:00 EET', '2003-06-10T01:00:00.645Z'],
    ['10 Jun 2003 04:00:00 BST', '2003-06-09T22:00:00.645Z'],
    ['10 Jun 2003 04:00:00 IST', '2003-06-09T22:30:00.645Z'],
    ['10 Jun 2003 04:00:00 JST', '2003-06-09T19:00:00.645Z'],
    ['10 Jun 2003 04:00:00 CTT', '2003-06-09T20:00:00.645Z'],
    ['10 Jun 2003 04:00:00 NST', '2003-06-09T16:00:00.645Z'],
    ['10 Jun 2003 04:00:00 BET', '2003-06-10T07:00:00.645Z'],
    ['10 Jun 2003 04:00:00 IET', '2003-06-10T09:00:00.645Z'],
  ])('reads %j as instant %s', (text, expected) => {
    expect(cfParseDateTime(text, now)!.toISOString()).toBe(expected);
  });

  it.each([
    '',
    'not a date',
    '2003',
    '12',
    '1/1',
    'Tue, 31 Feb 2003 04:00:00 GMT',
    'Tue, 29 Feb 2003 04:00:00 GMT',
    'Tue, 00 Jun 2003 04:00:00 GMT',
    'Tue, 10 Jun 2003 24:00:00 GMT',
    'Tue, 10 Jun 2003 04:00:60 GMT',
    'Tue, 10 Jun 2003 04',
    'Tues, 10 Jun 2003 04:00:00 GMT',
    'Tue., 10 Jun 2003 04:00:00 GMT',
    'Foo, 10 Jun 2003 04:00:00 GMT',
    'Tue, 10 Foo 2003 04:00:00 GMT',
    '13 Feb 2026 09:15:30 +0100',
    '10 Jun 2003 04:00:00 UT',
    '10 Jun 2003 04:00:00 EDT',
    '10 Jun 2003 04:00:00 PST',
    '10 Jun 2003 04:00:00 America/New_York',
    '2003-06-10T04:00:00-0500',
    '20030610T040000Z',
    '2003-06-10T24:00:00Z',
    '2003-13-10',
  ])('rejects %j as CFML isDate does', (text) => {
    expect(cfParseDateTime(text, now)).toBeUndefined();
  });

  it('defaults the clock to the current time', () => {
    expect(cfParseDateTime('10 Jun 2003 04:00:00 EST')!.getUTCHours()).toBe(9);
  });
});
