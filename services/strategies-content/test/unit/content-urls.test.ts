// Seeded tenant-a titles, rows and URL settings through the content URL port; string values observed on ACF 2023.0.26.
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
  getUrlStem,
  getWebPath,
  imageUrl,
  materializedPath,
  shouldArchiveFilename,
  uniqueFilename,
  uniqueTitle,
  uniqueUrlTitle,
  urlSafeFormat,
  type LegacySiteUrlConfig,
} from '../../src/legacy/content-urls.js';
import { IDS, contentRow, fileRow } from '../helpers/seed.js';

const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const SITE_ID = IDS.sites.tenantA;
const CAFE = 'Café Déjà Vu';
const PAGE_FILENAME = 'about-us/cafe-deja-vu';

/** tenant-a behind context `/masa` on port 8080, reached through an alias host, with the umbrella file pool. */
const TENANT_A: LegacySiteUrlConfig = {
  siteId: SITE_ID,
  scheme: 'http',
  domain: 'tenant-a.example',
  requestDomain: 'alias.tenant-a.example',
  previewDomain: '',
  serverPort: ':8080',
  context: '/masa',
  siteIdInUrls: true,
  indexFileInUrls: true,
  hashUrls: false,
  useSSL: false,
  filePoolId: IDS.sites.umbrella,
  configFileAssetPath: '',
  assetPath: '/masa/sites',
  siteAssetPath: '/sites',
  fileStore: 'fileDir',
  legacyIndexFileLocation: false,
  urlTitleDelim: '-',
  allowUnicodeInFilenames: false,
  placeholderImgId: '',
  placeholderImgExt: '',
  directImages: true,
};
const tenantA = (overrides: Partial<LegacySiteUrlConfig>): LegacySiteUrlConfig => ({ ...TENANT_A, ...overrides });
const UNICODE = { urlTitleDelim: '-', allowUnicodeInFilenames: true };
const ORIGIN = 'http://alias.tenant-a.example:8080';

describe('title text [contentUtility.cfc urlSafeFormat, formatFilename]', () => {
  it('cfHtmlEditFormat encodes title markup and re-encodes an entity, as HTMLEditFormat does', () => {
    const row = contentRow({ title: 'Q&A <b>"Live"</b> &amp; more' });
    expect(cfHtmlEditFormat(row.title ?? '')).toBe('Q&amp;A &lt;b&gt;&quot;Live&quot;&lt;/b&gt; &amp;amp; more');
  });

  it('approximate keeps accented letters, deaccent strips them, urlSafeFormat lower-cases and joins with the delimiter', () => {
    expect([approximate(CAFE), deaccent(CAFE), urlSafeFormat(CAFE), urlSafeFormat(CAFE, '_')]).toEqual([
      CAFE,
      'Cafe Deja Vu',
      'cafe-deja-vu',
      'cafe_deja_vu',
    ]);
  });

  it.each([
    [CAFE, 'cafe-deja-vu', 'café-déjà-vu'],
    [' -- Café Déjà Vu! -- ', 'cafe-deja-vu', '-café-déjà-vu-'],
    ['News/Events & More', 'news-events-more', 'newsevents-more'],
    ['Q&A: 2026/27 Budget', 'q-a-2026-27-budget', 'qa-202627-budget'],
    ['10 Tips & Tricks', '10-tips-tricks', '10-tips-tricks'],
    ["Rock 'n' Roll", 'rock-n-roll', 'rock-n-roll'],
    ['Новости 2026', '2026', 'новости-2026'],
  ])('formatFilename(%j) is %j, or %j with unicode filenames', (title, ascii, unicode) => {
    expect(formatFilename(title, TENANT_A)).toBe(ascii);
    expect(formatFilename(title, UNICODE)).toBe(unicode);
  });

  it.each([
    ['Новости', 'новости'],
    ['東京 / 大阪', '東京-大阪'],
  ])('formatFilename(%j) falls back to a new CF UUID, or is %j with unicode filenames', (title, unicode) => {
    expect(formatFilename(title, TENANT_A)).toMatch(CF_UUID);
    expect(formatFilename(title, UNICODE)).toBe(unicode);
  });
});

describe('unique names [contentUtility.cfc setUniqueFilename, setUniqueURLTitle, setUniqueTitle]', () => {
  const section = contentRow({ contentid: IDS.content.section, type: 'Folder', title: 'About Us', filename: 'about-us', urltitle: 'about-us' });
  const page = contentRow({ contentid: IDS.content.pageOne, parentid: IDS.content.section, title: CAFE });
  const unique = (parentId: string, parentFilename: string, exists: (candidate: string) => boolean) =>
    uniqueFilename({ ...TENANT_A, urlTitle: page.title ?? '', contentId: IDS.content.pageOne, parentId, parentFilename, exists });

  it('uniqueFilename prefixes the parent filename and probes 1, 2… until a candidate is free', () => {
    const exists = vi.fn((candidate: string) => candidate !== `${PAGE_FILENAME}2`);
    expect(unique(page.parentid ?? '', section.filename ?? '', exists)).toEqual({ filename: `${PAGE_FILENAME}2`, urlTitle: 'cafe-deja-vu2' });
    expect(exists.mock.calls.map(([candidate]) => candidate)).toEqual([PAGE_FILENAME, `${PAGE_FILENAME}1`, `${PAGE_FILENAME}2`]);
  });

  it('uniqueFilename under the home node checks the bare filename once', () => {
    const exists = vi.fn(() => false);
    expect(unique(IDS.content.root, '', exists)).toEqual({ filename: 'cafe-deja-vu', urlTitle: 'cafe-deja-vu' });
    expect(exists).toHaveBeenCalledExactlyOnceWith('cafe-deja-vu');
  });

  it('uniqueUrlTitle and uniqueTitle probe the value, then value1, value2…', () => {
    const urlTitleExists = vi.fn((candidate: string) => candidate === 'cafe-deja-vu');
    expect(uniqueUrlTitle({ urlTitle: 'cafe-deja-vu', exists: urlTitleExists })).toBe('cafe-deja-vu1');
    expect(urlTitleExists.mock.calls.map(([candidate]) => candidate)).toEqual(['cafe-deja-vu', 'cafe-deja-vu1']);

    const titleExists = vi.fn((candidate: string) => candidate !== `${CAFE}2`);
    expect(uniqueTitle({ title: CAFE, exists: titleExists })).toBe(`${CAFE}2`);
    expect(titleExists.mock.calls.map(([candidate]) => candidate)).toEqual([CAFE, `${CAFE}1`, `${CAFE}2`]);
  });
});

describe('filename archive and materialized path [contentManager.cfc]', () => {
  // Legacy archives on every approved save of these types, whether or not the filename changed (contentManager.cfc:1693).
  it.each([
    ['Folder', 1, true],
    ['Gallery', 1, true],
    ['Calendar', 1, true],
    ['Link', 1, true],
    ['Form', 1, false],
    ['Module', 1, false],
    ['Folder', 0, false],
  ])('shouldArchiveFilename of a %s version with approved=%s is %s', (type, approved, expected) => {
    expect(shouldArchiveFilename(contentRow({ type, approved, filename: 'about-us' }))).toBe(expected);
  });

  // setMaterializedPath joins bare ids (contentManager.cfc:906-920); only the bootstrap home row of mssql.sql is quoted.
  it('materializedPath of a seeded page lists root, section and page unquoted, as setMaterializedPath stores it', () => {
    expect(materializedPath([IDS.content.section, IDS.content.root], IDS.content.pageOne)).toBe(
      `${IDS.content.root},${IDS.content.section},${IDS.content.pageOne}`,
    );
  });
});

describe('site links [settingsBean.cfc getWebPath, contentServer.cfc getURLStem, contentRendererUtility.cfc createHREF]', () => {
  it.each([
    ['default', TENANT_A, {}, '/masa'],
    ['complete', TENANT_A, { complete: true }, `${ORIGIN}/masa`],
    ['useSSL', tenantA({ useSSL: true }), {}, 'https://alias.tenant-a.example:8080/masa'],
    ['useSSL, secure=false', tenantA({ useSSL: true }), { secure: false }, '/masa'],
    ['https request, default port', tenantA({ scheme: 'https', serverPort: '' }), { complete: true }, 'https://alias.tenant-a.example/masa'],
  ])('getWebPath of tenant-a (%s)', (_case, site, opts, expected) => {
    expect(getWebPath(site, opts)).toBe(expected);
  });

  it.each([
    [true, true, false, '/index.cfm/tenant-a/about-us/cafe-deja-vu/'],
    [true, false, false, '/tenant-a/about-us/cafe-deja-vu/'],
    [false, true, false, '/index.cfm/about-us/cafe-deja-vu/'],
    [false, false, false, '/about-us/cafe-deja-vu/'],
    [true, true, true, '/index.cfm/tenant-a/#/about-us/cafe-deja-vu'],
    [false, false, true, '/#/about-us/cafe-deja-vu'],
  ])('siteIdInUrls=%s indexFileInUrls=%s hashUrls=%s: stem %s behind the context', (siteIdInUrls, indexFileInUrls, hashUrls, stem) => {
    const site = tenantA({ siteIdInUrls, indexFileInUrls, hashUrls });
    expect(getUrlStem(site, SITE_ID, PAGE_FILENAME)).toBe(stem);
    expect(createHref(site, { filename: PAGE_FILENAME })).toBe(`/masa${stem}`);
    expect(createHref(site, { filename: PAGE_FILENAME, complete: true })).toBe(`${ORIGIN}/masa${stem}`);
  });

  // Link bodies and File cache paths replace the stem only in export HTML, which stays legacy-served (contentRendererUtility.cfc:1636-1647).
  it.each([
    contentRow({ contentid: IDS.content.pageOne, type: 'Page', filename: PAGE_FILENAME }),
    contentRow({ contentid: IDS.content.section, type: 'Folder', filename: 'about-us' }),
    contentRow({ contentid: IDS.content.fileNode, type: 'File', filename: 'files/guide', fileid: IDS.files.pdf, body: 'guide.pdf' }),
    contentRow({ contentid: IDS.content.linkNode, type: 'Link', filename: 'go/elsewhere', body: 'https://example.org/elsewhere' }),
  ])('createHref of a seeded $type builds its filename stem', (row) => {
    expect(createHref(TENANT_A, { filename: row.filename ?? '', contentId: row.contentid ?? '' })).toBe(`/masa/index.cfm/tenant-a/${row.filename}/`);
  });

  it.each([
    [false, '/masa/index.cfm/tenant-a/news/?page=2&amp;sort=title'],
    [true, '/masa/index.cfm/tenant-a/#/news/_/page/2/sort/title'],
  ])('createHref with a querystring and hashUrls=%s', (hashUrls, expected) => {
    expect(createHref(tenantA({ hashUrls }), { filename: 'news', querystring: 'page=2&sort=title' })).toBe(expected);
  });

  const guide = fileRow({ fileid: IDS.files.pdf, contentid: IDS.content.fileNode, filename: 'guide.pdf', fileext: 'pdf' });
  it.each([
    ['File', { fileExt: guide.fileext ?? '', showMeta: '2' }, 'files/guide', '/?showMeta=2&amp;fileExt=.pdf'],
    ['Link', {}, 'go/elsewhere', '/?showMeta=0'],
    ['Page', {}, 'about-us', '/'],
  ])('createHrefForRss of a %s stays relative, as createHREFforRSS passes no complete', (type, opts, filename, tail) => {
    expect(createHrefForRss(TENANT_A, { type, filename, ...opts })).toBe(`/masa/index.cfm/tenant-a/${filename}${tail}`);
  });

  const pageStem = `/masa/index.cfm/tenant-a/${PAGE_FILENAME}/`;
  it.each([
    ['home', contentRow({ contentid: IDS.content.root, filename: null }), {}, '/masa/index.cfm/tenant-a/'],
    ['page, complete and secure', contentRow({ filename: PAGE_FILENAME }), { complete: true, secure: true }, `https://alias.tenant-a.example:8080${pageStem}`],
    ['page with ?querystring', contentRow({ filename: PAGE_FILENAME }), { querystring: '?preview=1' }, `${pageStem}?preview=1`],
  ])('contentUrl of the seeded %s [contentManager.cfc getURL]', (_case, row, opts, expected) => {
    expect(contentUrl(TENANT_A, row, opts)).toBe(expected);
  });
});

describe('image URLs [fileManager.cfc createHREFForImage]', () => {
  const photo = fileRow({
    fileid: IDS.files.image,
    siteid: IDS.sites.umbrella,
    filename: 'photo.jpg',
    contenttype: 'image',
    contentsubtype: 'jpeg',
    fileext: 'jpg',
  });
  const FID = IDS.files.image;
  const DIRECT = `/masa/sites/umbrella/cache/file/${FID}`;
  const RENDER = (route: string) => `/masa/index.cfm/_api/render/${route}/?fileID=${FID}&fileEXT=jpg`;

  // Direct URLs take the site's primary domain (getFileAssetPath's default) and ignore `secure` unless complete;
  // render-route URLs take the request host through getWebPath.
  it.each([
    ['small', TENANT_A, { size: 'small' }, `${DIRECT}_small.jpg`],
    ['medium', TENANT_A, { size: 'medium' }, `${DIRECT}_medium.jpg`],
    ['large', TENANT_A, { size: 'large' }, `${DIRECT}.jpg`],
    ['no size', TENANT_A, {}, `${DIRECT}.jpg`],
    ['width and height', TENANT_A, { width: 300, height: 200 }, `${DIRECT}_W300_H200.jpg`],
    ['secure', TENANT_A, { size: 'small', secure: true }, `${DIRECT}_small.jpg`],
    ['complete', TENANT_A, { size: 'small', complete: true }, `http://tenant-a.example:8080${DIRECT}_small.jpg`],
    ['complete and secure', TENANT_A, { size: 'small', complete: true, secure: true }, `https://tenant-a.example:8080${DIRECT}_small.jpg`],
    ['s3 store', tenantA({ fileStore: 's3' }), { size: 'medium' }, `${DIRECT}_medium.jpg`],
    ['render, secure', TENANT_A, { size: 'small', direct: false, secure: true }, `https://alias.tenant-a.example:8080${RENDER('small')}`],
    ['render, complete', TENANT_A, { size: 'medium', direct: false, complete: true }, `${ORIGIN}${RENDER('medium')}`],
    ['render, large', TENANT_A, { size: 'large', direct: false }, RENDER('file')],
    ['render for a site without direct images', tenantA({ directImages: false }), { size: 'small' }, RENDER('small')],
  ])('imageUrl of the seeded umbrella photo: %s', (_case, site, opts, expected) => {
    expect(imageUrl(site, { fileId: photo.fileid, fileExt: photo.fileext ?? '', ...opts })).toBe(expected);
  });

  it('imageUrl is empty for a non-image file and for a missing file without a placeholder', () => {
    const binary = fileRow();
    expect(imageUrl(TENANT_A, { fileId: binary.fileid, fileExt: binary.fileext ?? '' })).toBe('');
    expect(imageUrl(TENANT_A, { fileId: '' })).toBe('');
  });

  it('a File node with a PDF and a row without a file show the site placeholder [contentManager.cfc getImageURL]', () => {
    const site = tenantA({ placeholderImgId: FID, placeholderImgExt: 'jpg' });
    const pdf = fileRow({ fileid: IDS.files.pdf, contentid: IDS.content.fileNode, filename: 'guide.pdf', fileext: 'pdf' });
    const fileNode = contentRow({ contentid: IDS.content.fileNode, type: 'File', fileid: pdf.fileid });
    const row = { type: fileNode.type, fileid: fileNode.fileid, fileext: pdf.fileext };
    expect(contentImageUrl(site, row, { size: 'small' })).toBe(`${DIRECT}_small.jpg`);
    expect(imageUrl(site, { fileId: '', size: 'medium' })).toBe(`${DIRECT}_medium.jpg`);
  });
});
