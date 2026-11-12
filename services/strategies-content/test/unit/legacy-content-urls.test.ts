// Content filename and URL rules against ACF 2023.0.26 output of the legacy functions, captured on a Masa 7.6.1
// instance with siteidinurls=false, indexfileinurls=false, port 22980 and the installed `default` site.
import { describe, expect, it, vi } from 'vitest';
import {
  approximate,
  cfHtmlEditFormat,
  contentImageUrl,
  contentUrl,
  createHref,
  createHrefForRss,
  deaccent,
  formatFilename,
  getFileAssetPath,
  getUrlStem,
  getWebPath,
  hasImage,
  imageUrl,
  materializedPath,
  shouldArchiveFilename,
  uniqueFilename,
  uniqueTitle,
  uniqueUrlTitle,
  urlSafeFormat,
  type LegacySiteUrlConfig,
} from '../../src/legacy/content-urls.js';

const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const HOME = '00000000000000000000000000000000001';
const FID = 'ABCDEF01-2345-6789-ABCDEF0123456789';

const SITE: LegacySiteUrlConfig = {
  siteId: 'default',
  scheme: 'http',
  domain: 'localhost',
  requestDomain: 'localhost',
  previewDomain: '',
  serverPort: ':22980',
  context: '',
  siteIdInUrls: false,
  indexFileInUrls: false,
  hashUrls: false,
  useSSL: false,
  filePoolId: 'default',
  configFileAssetPath: '',
  assetPath: '/sites',
  siteAssetPath: '/sites',
  fileStore: 'fileDir',
  legacyIndexFileLocation: false,
  urlTitleDelim: '-',
  allowUnicodeInFilenames: false,
  placeholderImgId: '',
  placeholderImgExt: '',
  directImages: true,
};
const UNICODE = { urlTitleDelim: '-', allowUnicodeInFilenames: true };
const site = (overrides: Partial<LegacySiteUrlConfig>): LegacySiteUrlConfig => ({ ...SITE, ...overrides });
const existing = (...names: string[]) => (candidate: string) => names.includes(candidate);

describe('CF string helpers', () => {
  it('HTMLEditFormat encodes & < > " only and drops CR', () => {
    expect(cfHtmlEditFormat('a&b<c>d"e\'f\r\ng\th\u00e9\u00a0/:#')).toBe('a&amp;b&lt;c&gt;d&quot;e\'f\ng\th\u00e9\u00a0/:#');
  });

  it.each([
    ['\u00e6\u00c6|\u00e4\u00c4|\u00f6\u00d6|\u00fc\u00dc|\u00f8\u00d8|\u00df\u1e9e|\u2019\u201c\u201d\u00ab\u00bb', 'aeae|AeAe|oeoe|ueue|oo|ss\u1e9e|\'""""'],
    ['\u00c6\u00e6|\u00c4\u00e4|\u00d6\u00f6|\u00dc\u00fc|\u00d8\u00f8', 'aeae|AeAe|oeoe|ueue|oo'],
  ])('approximate(%j) follows the ACF struct order', (input, expected) => {
    expect(approximate(input)).toBe(expected);
  });

  it('deaccent strips combining marks after NFD', () => {
    expect(deaccent('Cr\u00e8me Br\u00fbl\u00e9e \u0142')).toBe('Creme Brulee \u0142');
  });

  it.each([
    ['H\u00e9llo W\u00f6rld <b>Bold</b> it\'s \u201cquoted\u201d \u00c6sir --- end-', '-', 'hello-woerld-bold-its-quoted-aesir-end'],
    ['\u65e5\u672c\u8a9e text', '-', 'text'],
    ['A_B c', '_', 'a_b_c'],
    ['\u00c5\u00c7\u00d1 \u00f1 \u0142 \u0110 \u0131 \u1e9e', '-', 'acn-n'],
    ['My Page Title!', '-', 'my-page-title'],
  ])('urlSafeFormat(%j, %j)', (input, delim, expected) => {
    expect(urlSafeFormat(input, delim)).toBe(expected);
  });

  it('urlSafeFormat of nothing usable is a new upper-case CF UUID', () => {
    expect(urlSafeFormat("<i></i>'")).toMatch(CF_UUID);
  });
});

describe('filename and title rules', () => {
  it.each([
    ['H\u00e9llo, W\u00f6rld! a-b_c  d\te<b>x</b>svphsvY --Z\n\u00dcn\u00ef', 'h\u00e9llo-w\u00f6rld-a-bc-dex-y-z\u00fcn\u00ef'],
    ['\u216b Stra\u00dfe/\u00fcber.html?q=1', '\u217b-stra\u00dfe\u00fcberhtmlq1'],
  ])('formatFilename keeps unicode when allowed: %j', (input, expected) => {
    expect(formatFilename(input, UNICODE)).toBe(expected);
  });

  it('formatFilename applies urlSafeFormat when unicode is not allowed', () => {
    expect(formatFilename('\u216b Stra\u00dfe', SITE)).toBe('strasse');
  });

  const base = { ...SITE, contentId: 'C1', parentId: HOME, parentFilename: '', exists: () => false };

  it.each([
    ['home parent', { urlTitle: 'About Us' }, { filename: 'about-us', urlTitle: 'about-us' }],
    ['nested', { urlTitle: 'About Us', parentId: 'P1', parentFilename: 'company' }, { filename: 'company/about-us', urlTitle: 'about-us' }],
    ['short parent ending in /', { urlTitle: 'x', parentId: 'P1', parentFilename: 'company/' }, { filename: 'company//x', urlTitle: 'x' }],
    [
      'collisions',
      { urlTitle: 'About Us', parentId: 'P1', parentFilename: 'company', exists: existing('company/about-us', 'company/about-us1') },
      { filename: 'company/about-us2', urlTitle: 'about-us2' },
    ],
    ['unicode, empty', { ...UNICODE, urlTitle: '!!!' }, { filename: '-', urlTitle: '-' }],
    ['unicode, empty home', { ...UNICODE, urlTitle: '!!!', contentId: HOME }, { filename: '', urlTitle: '' }],
    ['unicode, empty home under END', { ...UNICODE, urlTitle: '!!!', contentId: HOME, parentId: '00000000000000000000000000000000END' }, { filename: '/', urlTitle: '' }],
    ['parent without an active version', { urlTitle: 'About', parentId: 'P1' }, { filename: '/about', urlTitle: 'about' }],
  ])('uniqueFilename: %s', (_case, input, expected) => {
    expect(uniqueFilename({ ...base, ...input })).toEqual(expected);
  });

  it('uniqueFilename keeps the upper-case UUID urlSafeFormat returns for an empty title', () => {
    const result = uniqueFilename({ ...base, urlTitle: '' });
    expect(result.filename).toMatch(CF_UUID);
    expect(result.urlTitle).toBe(result.filename);
  });

  it('uniqueFilename truncates a colliding filename past 250 characters', () => {
    const parentFilename = 'p'.repeat(240);
    const first = `${parentFilename}/abcdefghijklmnop`;
    const result = uniqueFilename({ ...base, urlTitle: 'abcdefghijklmnop', parentId: 'P1', parentFilename, exists: existing(first) });
    expect(result).toEqual({ filename: `${parentFilename}/abcdefgh1`, urlTitle: 'abcdefgh1' });
  });

  it('uniqueFilename drops a character before a slash the truncation ends on', () => {
    const parentFilename = 'p'.repeat(248);
    const result = uniqueFilename({ ...base, urlTitle: 'name', parentId: 'P1', parentFilename, exists: existing(`${parentFilename}/name`) });
    expect(result).toEqual({ filename: `${'p'.repeat(247)}/1`, urlTitle: '1' });
  });

  it('uniqueFilename cuts a long parent filename to 250 or 249 characters', () => {
    expect(uniqueFilename({ ...base, urlTitle: 'x', parentId: 'P1', parentFilename: 'q'.repeat(300) }).filename).toBe(`${'q'.repeat(250)}/x`);
    const slashAt250 = `${'q'.repeat(249)}/rest`;
    expect(uniqueFilename({ ...base, urlTitle: 'x', parentId: 'P1', parentFilename: slashAt250 }).filename).toBe(`${'q'.repeat(249)}/x`);
  });

  it('uniqueUrlTitle and uniqueTitle append the first free pass number', () => {
    expect(uniqueUrlTitle({ urlTitle: 'news', exists: existing('news', 'news1') })).toBe('news2');
    expect(uniqueTitle({ title: 'News', exists: existing('News') })).toBe('News1');
    expect(uniqueTitle({ title: 'Free', exists: () => false })).toBe('Free');
  });

  it.each([
    [{ approved: 1, type: 'Page' }, true],
    [{ approved: 1, type: 'FILE' }, true],
    [{ approved: 0, type: 'Page' }, false],
    [{ approved: null, type: 'Link' }, false],
    [{ approved: 1, type: 'Component' }, false],
    [{ approved: 1, type: null }, false],
  ])('shouldArchiveFilename(%j) is %s', (row, expected) => {
    expect(shouldArchiveFilename(row)).toBe(expected);
  });

  it('materializedPath lists the root first and the content last', () => {
    expect(materializedPath(['PARENT', 'GRANDPARENT', HOME], 'C1')).toBe(`${HOME},GRANDPARENT,PARENT,C1`);
    expect(materializedPath([], 'C1')).toBe('C1');
  });
});

describe('site paths', () => {
  it.each([
    [{}, ''],
    [{ complete: true }, 'http://localhost:22980'],
    [{ secure: true }, 'https://localhost:22980'],
    [{ complete: true, useProtocol: false }, '//localhost:22980'],
    [{ complete: true, domain: 'other.example' }, 'http://other.example:22980'],
  ])('getWebPath(%j)', (opts, expected) => {
    expect(getWebPath(SITE, opts)).toBe(expected);
  });

  it('getWebPath prefers the preview domain and defaults secure to useSSL', () => {
    expect(getWebPath(site({ previewDomain: 'preview.example', useSSL: true, context: '/ctx' }))).toBe('https://preview.example:22980/ctx');
    expect(getWebPath(site({ scheme: 'https' }), { complete: true })).toBe('https://localhost:22980');
  });

  it.each([
    [SITE, {}, '/sites/default'],
    [SITE, { complete: true }, 'http://localhost:22980/sites/default'],
    [site({ requestDomain: 'alias.example' }), { complete: true }, 'http://localhost:22980/sites/default'],
    [site({ domain: '', requestDomain: 'alias.example' }), { complete: true }, 'http://alias.example:22980/sites/default'],
    [site({ configFileAssetPath: 'https://files.example/assets', filePoolId: 'umbrella' }), { complete: true }, 'https://files.example/assets/umbrella'],
    [site({ resource: { domain: 'res.example', ssl: false, serverPort: ':81', context: '/c' } }), {}, 'http://res.example:81/c/sites/default'],
    [site({ resource: { domain: 'res.example', ssl: true, serverPort: '', context: '' } }), {}, 'https://res.example/sites/default'],
    [site({ resource: { domain: 'res.example', ssl: false, serverPort: '', context: '' } }), { secure: true }, 'https://res.example/sites/default'],
    [site({ resource: { domain: 'res.example', ssl: false, serverPort: '', context: '' } }), { useProtocol: false }, '//res.example/sites/default'],
  ])('getFileAssetPath', (config, opts, expected) => {
    expect(getFileAssetPath(config, opts)).toBe(expected);
  });

  const STEMS: Array<[boolean, boolean, boolean, string, string, string]> = [
    [true, true, true, '/index.cfm/default/#/about', '/index.cfm/default/#/about/x/', '/index.cfm/default/'],
    [true, true, false, '/index.cfm/default/about/', '/index.cfm/default/about/x/', '/index.cfm/default/'],
    [true, false, true, '/default/#/about', '/default/#/about/x/', '/default/'],
    [true, false, false, '/default/about/', '/default/about/x/', '/default/'],
    [false, true, true, '/index.cfm/#/about', '/index.cfm/#/about/x/', '/'],
    [false, true, false, '/index.cfm/about/', '/index.cfm/about/x/', '/'],
    [false, false, true, '/#/about', '/#/about/x/', '/'],
    [false, false, false, '/about/', '/about/x/', '/'],
  ];
  it.each(STEMS)('getUrlStem siteIdInUrls=%s indexFileInUrls=%s hashUrls=%s', (siteIdInUrls, indexFileInUrls, hashUrls, about, nested, empty) => {
    const config = site({ siteIdInUrls, indexFileInUrls, hashUrls });
    expect([getUrlStem(config, 'default', 'about'), getUrlStem(config, 'default', '/about/x/'), getUrlStem(config, 'default', '')]).toEqual([
      about,
      nested,
      empty,
    ]);
  });

  it.each([
    [false, 'about', '/sites/default/index.cfm/about/'],
    [false, '', '/sites/default/'],
    [true, 'about', '/sites/default/index.cfm/#/about'],
  ])('getUrlStem with legacyIndexFileLocation, hashUrls=%s, %j', (hashUrls, filename, expected) => {
    const config = site({ siteIdInUrls: true, indexFileInUrls: true, legacyIndexFileLocation: true, hashUrls });
    expect(getUrlStem(config, 'default', filename)).toBe(expected);
  });
});

describe('content links', () => {
  it.each([
    [{ filename: 'about/sub', querystring: 'a=1&b=<2>' }, '/about/sub/?a=1&amp;b=&lt;2&gt;'],
    [{ filename: 'about', querystring: '?a=1', complete: true }, 'http://localhost:22980/about/?a=1'],
    [{ filename: '', contentId: HOME, complete: true, secure: true }, 'https://localhost:22980/'],
    [{ filename: 'files/doc' }, '/files/doc/'],
    [{ filename: 'about', eventSiteId: 'tenant-a' }, 'http://localhost:22980/about/'],
    [{ filename: 'about', eventSiteId: 'DEFAULT' }, '/about/'],
  ])('createHref(%j)', (opts, expected) => {
    expect(createHref(SITE, opts)).toBe(expected);
  });

  it('createHref loads the filename of a non-home content id only when asked', () => {
    const filenameOf = vi.fn(() => 'loaded/page');
    expect(createHref(SITE, { filename: '', contentId: 'C1', filenameOf })).toBe('/loaded/page/');
    expect(createHref(SITE, { filename: '', contentId: HOME, filenameOf })).toBe('/');
    expect(filenameOf).toHaveBeenCalledTimes(1);
  });

  const HASH = site({ hashUrls: true });
  it.each([
    [{ filename: 'about', querystring: 'a=1&b&c=x=y&d e=f g&&' }, '/#/about/_/a/1/b/true/c/true/d%20e/f g'],
    [{ filename: 'about/', querystring: '?k=v', complete: true }, 'http://localhost:22980/#/about/_/k/v'],
    [{ filename: '', querystring: 'k=v' }, '/#/_/k/v'],
    [{ filename: 'about', querystring: '?' }, '/#/about/_'],
    [{ filename: 'about', querystring: "a b-c_d.e*f~!'()\u00e9+=v" }, "/#/about/_/a%20b%2Dc%5Fd%2Ee%2Af%7E%21%27%28%29%C3%A9%2B/v"],
  ])('createHref with hash URLs (%j)', (opts, expected) => {
    expect(createHref(HASH, opts)).toBe(expected);
  });

  it('createHref fails on a hash query pair without a name, as legacy does', () => {
    expect(() => createHref(HASH, { filename: 'about', querystring: 'a=1&=' })).toThrow(RangeError);
  });

  it.each([
    [{ type: 'File', filename: 'files/doc', showMeta: '2', fileExt: 'pdf' }, '/files/doc/?showMeta=2&amp;fileExt=.pdf'],
    [{ type: 'link', filename: 'lnk', showMeta: '1' }, '/lnk/?showMeta=1'],
    [{ type: 'Link', filename: 'lnk' }, '/lnk/?showMeta=0'],
    [{ type: 'Page', filename: 'about', secure: true }, 'https://localhost:22980/about/'],
  ])('createHrefForRss(%j)', (opts, expected) => {
    expect(createHrefForRss(SITE, opts)).toBe(expected);
  });

  it('contentUrl builds the complete link of a content row', () => {
    expect(contentUrl(site({ serverPort: ':8080' }), { filename: '' }, { complete: true })).toBe('http://localhost:8080/');
    expect(contentUrl(SITE, { filename: 'news/item' }, { querystring: 'x=1' })).toBe('/news/item/?x=1');
    expect(contentUrl(site({ siteIdInUrls: true }), { filename: null })).toBe('/default/');
  });
});

describe('image URLs', () => {
  it.each([
    [{ fileExt: 'jpg' }, `/sites/default/cache/file/${FID}.jpg`],
    [{ fileExt: 'JPG', size: 'Small', complete: true }, `http://localhost:22980/sites/default/cache/file/${FID}_small.JPG`],
    [{ fileExt: 'png', size: 'LARGE' }, `/sites/default/cache/file/${FID}.png`],
    [{ fileExt: 'png', size: 'source' }, `/sites/default/cache/file/${FID}_source.png`],
    [{ fileExt: 'svg', size: 'small' }, `/sites/default/cache/file/${FID}.svg`],
    [{ fileExt: 'gif', width: '100' }, `/sites/default/cache/file/${FID}_W100_Hauto.gif`],
    [{ fileExt: 'gif', size: 'custom', width: '100', height: 50 }, `/sites/default/cache/file/${FID}_W100_H50.gif`],
    [{ fileExt: 'gif', size: 'custom' }, `/sites/default/cache/file/${FID}_small.gif`],
    [{ fileExt: 'jpg', size: 'Banner Wide' }, `/sites/default/cache/file/${FID}_banner wide.jpg`],
    [{ fileExt: 'pdf' }, ''],
    [{ fileExt: 'jpg', direct: false }, `/index.cfm/_api/render/undefined/?fileID=${FID}&fileEXT=jpg`],
    [{ fileExt: 'jpg', size: 'Small', direct: false, complete: true }, `http://localhost:22980/index.cfm/_api/render/Small/?fileID=${FID}&fileEXT=jpg`],
    [{ fileExt: 'jpg', size: 'Large', direct: false, secure: true }, `https://localhost:22980/index.cfm/_api/render/file/?fileID=${FID}&fileEXT=jpg`],
    [{ fileExt: 'svg', size: 'medium', direct: false }, `/index.cfm/_api/render/file/?fileID=${FID}&fileEXT=svg`],
  ])('imageUrl(%j)', (opts, expected) => {
    expect(imageUrl(SITE, { fileId: FID, ...opts })).toBe(expected);
  });

  it('imageUrl uses the render route for a database file store', () => {
    expect(imageUrl(site({ fileStore: 'database' }), { fileId: FID, fileExt: 'jpg', size: 'medium' })).toBe(
      `/index.cfm/_api/render/medium/?fileID=${FID}&fileEXT=jpg`,
    );
  });

  it('imageUrl falls back to the placeholder and to the stored extension', () => {
    expect(imageUrl(SITE, { fileId: '' })).toBe('');
    const withPlaceholder = site({ placeholderImgId: 'PH', placeholderImgExt: 'png' });
    expect(imageUrl(withPlaceholder, { fileId: '', size: 'small' })).toBe('/sites/default/cache/file/PH_small.png');
    expect(imageUrl(SITE, { fileId: FID, fileExtOf: () => 'gif' })).toBe(`/sites/default/cache/file/${FID}.gif`);
    expect(imageUrl(SITE, { fileId: FID })).toBe('');
  });

  it('imageUrl returns nothing for a custom size legacy cannot render', () => {
    const name = `${FID}_hero.jpg`;
    const original = existing(`${FID}_source.jpg`);
    expect(imageUrl(SITE, { fileId: FID, fileExt: 'jpg', size: 'Hero', variantExists: original })).toBe('');
    expect(
      imageUrl(SITE, { fileId: FID, fileExt: 'jpg', size: 'Hero', variantExists: original, customImageSize: () => ({ width: '800', height: 'AUTO' }) }),
    ).toBe(`/sites/default/cache/file/${name}`);
    expect(imageUrl(SITE, { fileId: FID, fileExt: 'jpg', size: 'Hero', variantExists: existing(name) })).toBe(`/sites/default/cache/file/${name}`);
    expect(imageUrl(SITE, { fileId: FID, fileExt: 'jpg', size: 'Hero', variantExists: () => false })).toBe(`/sites/default/cache/file/${name}`);
  });

  it('imageUrl looks custom sizes up by formatted name', () => {
    const customImageSize = vi.fn(() => undefined);
    imageUrl(SITE, { fileId: FID, fileExt: 'jpg', size: 'Banner Wide', variantExists: existing(`${FID}.jpg`), customImageSize });
    expect(customImageSize).toHaveBeenCalledWith('banner-wide');
  });

  it.each([
    ['/sites', false],
    ['http://localhost:8080/sites', true],
    ['http://localhost', true],
    ['https://cdn.example.com/a/b', true],
    ['//cdn.example.com', false],
    ['ftp://x.y', true],
    ['file:///tmp/x', false],
    ['file://host/x', true],
    ['file:/x', false],
    ['mailto:a@b.c', false],
    ['news:comp.lang', true],
    ['news:', false],
    ['news:x y', false],
    ['http://', false],
    ['http://a b', false],
    ['HTTP://X.COM', true],
    ['http://x_y.com/p', false],
    ['http://1.2.3.4:8080/x?y=1', true],
    ['http://-a.com', false],
    ['http://a..b', false],
    ['http://a.com:abc', false],
    ['http://user:pw@a.com/x', true],
    ['http://a.com/p q', false],
    ['http://a.com/\u00fc', true],
    ['https://cdn.example.com/sites?x#y', true],
    ['http://a.b.c.d.e/x_y-z~a', true],
    ['http://a.com/x{y}', false],
    ['http://a.com/x|y', false],
    ['http://a.com/x[y]', false],
    ["http://a.com/x%20y'()*!;@:", true],
    ['http://ab-.com', false],
    ['http://a.123', false],
    ['http://a.com.', true],
    ['http://.a.com', false],
    ['  http://a.com', true],
    ['sftp://a.com', false],
    ['https://a.com?q=1', true],
  ])('a URL asset path %j prefixes direct images: %s', (assetPath, isUrl) => {
    const expected = isUrl ? `${assetPath}/default/cache/file/${FID}.jpg` : `/sites/default/cache/file/${FID}.jpg`;
    expect(imageUrl(site({ assetPath }), { fileId: FID, fileExt: 'jpg' })).toBe(expected);
  });

  it('contentImageUrl shows the placeholder for a non-image file and falls back to defaultUrl', () => {
    const withPlaceholder = site({ placeholderImgId: 'PH', placeholderImgExt: 'jpg' });
    const pdf = { type: 'File', fileid: FID, fileext: 'pdf' };
    expect(contentImageUrl(withPlaceholder, pdf, { size: 'small' })).toBe('/sites/default/cache/file/PH_small.jpg');
    expect(contentImageUrl(SITE, pdf, { defaultUrl: '/none.png' })).toBe('/none.png');
    expect(contentImageUrl(SITE, { type: 'Page', fileid: FID, fileext: 'jpg' }, { complete: true, size: 'medium' })).toBe(
      `http://localhost:22980/sites/default/cache/file/${FID}_medium.jpg`,
    );
    expect(contentImageUrl(site({ directImages: false }), { type: 'Page', fileid: FID, fileext: 'png' })).toBe(
      `/index.cfm/_api/render/undefined/?fileID=${FID}&fileEXT=png`,
    );
    expect(contentImageUrl(withPlaceholder, { type: null, fileid: null, fileext: null })).toBe('/sites/default/cache/file/PH.jpg');
  });

  it.each([
    [{ fileid: FID, fileext: 'JPEG' }, SITE, true, true],
    [{ fileid: FID, fileext: 'pdf' }, SITE, true, false],
    [{ fileid: '', fileext: 'jpg' }, SITE, true, false],
    [{ fileid: FID, fileext: null }, SITE, true, false],
    [{ fileid: null, fileext: null }, site({ placeholderImgId: 'PH' }), true, true],
    [{ fileid: null, fileext: null }, site({ placeholderImgId: 'PH' }), false, false],
  ])('hasImage(%j)', (row, config, usePlaceholder, expected) => {
    expect(hasImage(row, config, usePlaceholder)).toBe(expected);
  });
});
