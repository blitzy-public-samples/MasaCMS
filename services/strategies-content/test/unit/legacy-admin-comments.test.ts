// ccomments fragment and cnav.searchsitedata renderers against bodies captured from Masa 7.6.1 on ACF 2023.0.26
// (GS-CO-11 comment grid and thread page, GS-CO-06 site search), seeded with the comments built below.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAdminLabels, type AdminRenderContext } from '../../src/legacy/admin-markup.js';
import {
  COMMENTS_AJAX_CONTENT_TYPE,
  COMMENTS_FRAGMENT_CONTENT_TYPE,
  SEARCH_SITE_DATA_CONTENT_TYPE,
  renderCommentsAjax,
  renderLoadComments,
  renderLoadCommentsPage,
  renderSearchSiteDataJson,
  type CommentsCategoryNode,
  type CommentsListRow,
  type CommentsPageRow,
  type CommentsViewComment,
  type LoadCommentsModel,
  type LoadCommentsPageModel,
} from '../../src/legacy/admin-render-comments.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/legacy-comments/${name}.html`, import.meta.url), 'utf8');

const HOME_ID = '00000000000000000000000000000000001';
const ADMIN_ID = 'AF1841AB-0ED4-34A5-AF2596AB342BA3E6';
const id = (n: number): string => `C${n}000000-0000-0000-000000000000000${n}`;

const SITE: LegacySiteUrlConfig = {
  siteId: 'default',
  scheme: 'http',
  domain: 'localhost',
  requestDomain: 'localhost',
  previewDomain: '',
  serverPort: ':25380',
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

// en.properties values of the admin keys the views print; comments.morecomments and comments.inreplyto are absent.
const LABELS = createAdminLabels({
  'sitemanager.search': 'Search',
  'params.from': 'From',
  'params.to': 'To',
  'comments.message.confirm.approve': 'Are you sure you want to approve the selected comments?',
  'comments.message.confirm.delete': 'Are you sure you want to delete the selected comments?',
  'comments.all': 'ALL',
  'comments.selectall': 'Select All',
  'comments.sortbydatetime': 'Sort By Date/Time',
  'comments.sortbyname': 'Sort By Name',
  'comments.delete': 'Delete',
  'comments.unapprove': 'Unapprove',
  'comments.approve': 'Approve',
  'user.email': 'Email',
});

const CTX: AdminRenderContext = {
  labels: LABELS,
  session: {
    userId: ADMIN_ID,
    siteId: 'default',
    memberships: 'S2IsPrivate;default,S2',
    nextN: 20,
    dateKeyFormat: 'MM/DD/YYYY',
    rb: 'en',
    locale: 'en_US',
    openSectionList: '',
    flatViewArgs: {},
    copyContentId: '',
    copySiteId: '',
    copyAll: false,
  },
  site: SITE,
  siteSettings: { locking: 'none', hasComments: true, hasLockableNodes: false, privateUserPoolId: 'default', extranet: true },
  config: { sortPermission: '', adminDir: '/admin', context: '' },
  csrf: () => ({ token: 'F'.repeat(32), expires: '261112143000000' }),
};

const comment = (overrides: Partial<CommentsViewComment> & Pick<CommentsViewComment, 'commentid'>): CommentsViewComment => ({
  contentid: HOME_ID,
  parentid: null,
  url: '',
  name: '',
  comments: '',
  entered: null,
  email: '',
  isapproved: 0,
  isspam: 0,
  isdeleted: 0,
  flagcount: 0,
  ...overrides,
});

// The rows seeded into tcontentcomments for the captures.
const C1 = comment({
  commentid: id(1),
  url: 'http://example.com/a?x=1&y=2',
  name: 'Alice <b> & "Co"',
  comments: 'Short line one.\r\nLine two with http://x.y and a@b.co\ttab',
  entered: new Date(2026, 10, 10, 9, 5, 7),
  email: 'Alice@Example.com',
  isapproved: 1,
});
const C2 = comment({
  commentid: id(2),
  contentid: 'DEADBEEF-0000-0000-0000000000000000',
  url: 'not a url',
  name: 'Bob',
  comments: `${'word '.repeat(50)}tail`,
  entered: new Date(2026, 10, 11, 21, 45, 0),
  email: 'bob@example.com',
  flagcount: 3,
});
const C3 = comment({
  commentid: id(3),
  parentid: id(1),
  url: 'https://carol.example.org',
  name: 'Carol',
  comments: `  ${'abcdefghi '.repeat(20)}abcdefghi.${'x'.repeat(40)}`,
  entered: new Date(2026, 10, 11, 0, 0, 0),
  isspam: 1,
  flagcount: 1,
});
const C4 = comment({
  commentid: id(4),
  parentid: id(1),
  name: 'Dave',
  comments: '  Spaces around  ',
  entered: new Date(2026, 10, 12, 12, 30, 0),
  email: 'dave@x.org',
  isdeleted: 1,
});
const C5 = comment({
  commentid: id(5),
  url: 'example.com/no-scheme',
  name: 'Eve',
  comments: '\u00e9 \u2713 <script>x</script> \u{1F642}',
  entered: new Date(2026, 10, 12, 13, 0, 0),
  email: 'EVE@EXAMPLE.COM',
  isapproved: 1,
  flagcount: 12,
});

const HOME = { menutitle: 'Home', filename: null };
const listRow = (c: CommentsViewComment): CommentsListRow => ({ comment: c, content: c === C2 ? null : HOME });

const CATEGORIES: CommentsCategoryNode[] = [
  { categoryid: 'CA000000-0000-0000-00000000000000A1', name: 'Alpha', isopen: 1, children: [] },
  {
    categoryid: 'CA000000-0000-0000-00000000000000N1',
    name: 'News & <Events>',
    isopen: 1,
    children: [
      { categoryid: 'CA000000-0000-0000-00000000000000L1', name: 'Local', isopen: 0, children: [] },
      {
        categoryid: 'CA000000-0000-0000-00000000000000W1',
        name: 'World',
        isopen: 1,
        children: [{ categoryid: 'CA000000-0000-0000-00000000000000X1', name: 'Deep', isopen: null, children: [] }],
      },
    ],
  },
];

const listModel = (overrides: Partial<LoadCommentsModel>): LoadCommentsModel => ({
  keywords: '',
  commentStatus: '',
  startDate: '11/309/2026',
  endDate: '11/316/2026',
  categoryId: '',
  categories: CATEGORIES,
  sortBy: 'entered',
  sortDirection: 'asc',
  sortDirLink: 'desc',
  nextN: 25,
  pageNo: 1,
  totalPages: 1,
  startPage: 1,
  endPage: 1,
  recordCount: 5,
  rows: [C1, C3, C2, C4, C5].map(listRow),
  now: new Date(2026, 10, 12, 14, 19, 0),
  ...overrides,
});

describe('renderLoadComments', () => {
  it.each<[string, Partial<LoadCommentsModel>]>([
    ['all', {}],
    ['p2', { nextN: 2, pageNo: 2, totalPages: 3, endPage: 3, rows: [C2, C4].map(listRow) }],
    [
      'n1p4',
      {
        sortBy: 'flagCount',
        startDate: '11/01/2026',
        endDate: '11/30/2026',
        nextN: 1,
        pageNo: 4,
        totalPages: 5,
        endPage: 5,
        rows: [listRow(C2)],
      },
    ],
    [
      'cat',
      {
        commentStatus: '<b>x',
        categoryId: 'CA000000-0000-0000-00000000000000W1,CA000000-0000-0000-00000000000000L1',
        recordCount: 0,
        rows: [],
      },
    ],
    [
      'spam',
      {
        keywords: 'Car"<',
        commentStatus: 'spam',
        sortBy: 'name',
        sortDirection: 'desc',
        sortDirLink: 'asc',
        recordCount: 0,
        rows: [],
      },
    ],
  ])('reproduces the captured %s body byte for byte', (name, overrides) => {
    const result = renderLoadComments(listModel(overrides), CTX);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe(COMMENTS_FRAGMENT_CONTENT_TYPE);
    expect(result.body).toBe(fixture(`loadcomments-${name}`));
  });

  it('hides the select-all link once both the record count and nextN exceed 100', () => {
    const body = renderLoadComments(listModel({ recordCount: 101, nextN: 250, rows: [listRow(C1)] }), CTX).body;
    expect(body).not.toContain('id="checkall"');
    expect(renderLoadComments(listModel({ recordCount: 101, nextN: 100 }), CTX).body).toContain('id="checkall"');
  });

  it('falls back to the bean defaults for NULL cells', () => {
    const blank = comment({ commentid: id(6), contentid: null, name: null, comments: null, email: null, url: null });
    const nulls: CommentsViewComment = { ...blank, isapproved: null, isspam: null, isdeleted: null, flagcount: null };
    const body = renderLoadComments(listModel({ rows: [{ comment: nulls, content: null }] }), CTX).body;
    expect(body).toContain('data-contentid="" data-commentid="C6000000-0000-0000-0000000000000006"');
    expect(body).toContain('\t\t\t\t\t\t\t\t\t\t26/11/12\n');
    expect(body).toContain('\t\t\t\t\t\t\t\t\t\t2:19 PM\n');
    expect(body).toContain('<i class="mi-ban"></i>');
    expect(body).toContain('data-action="approve"');
    expect(body).not.toContain('class="mi-link"');
  });

  it('prefixes the site scheme to a schemeless URL and keeps an uppercase scheme', () => {
    const secure = { ...CTX, site: { ...SITE, scheme: 'https' as const } };
    const rows = [listRow({ ...C5, url: ' HTTPS://upper.example.com ' }), listRow(C5)];
    const body = renderLoadComments(listModel({ rows }), secure).body;
    expect(body).toContain('href="HTTPS&#x3a;&#x2f;&#x2f;upper.example.com"');
    expect(body).toContain('href="https&#x3a;&#x2f;&#x2f;example.com&#x2f;no-scheme"');
  });

  it.each([
    ['!', `${'a'.repeat(209)}!zz`, `${'a'.repeat(209)}&#x21;`],
    ['?', `${'b'.repeat(209)}?tail`, `${'b'.repeat(209)}&#x3f;`],
    ['a letter', `${'c'.repeat(211)}`, `${'c'.repeat(210)} ...`],
  ])('cuts a long comment ending in %s as legacy does', (_ending, comments, preview) => {
    const body = renderLoadComments(listModel({ rows: [listRow({ ...C1, comments })] }), CTX).body;
    expect(body).toContain(`data-toggle="modal">${preview}</a>`);
  });
});

const HOME_THREAD = [C1, C3, C4, C5];
const pageRow = (c: CommentsViewComment): CommentsPageRow => ({
  comment: c,
  commenterRemoteId: c === C1 ? ADMIN_ID : '',
  remoteUser: c === C1 ? { photoFileId: 'F0000000-0000-0000-0000000000000001', site: SITE } : null,
  parentName: c.parentid === null ? null : (C1.name ?? ''),
});
const pageModel = (overrides: Partial<LoadCommentsPageModel>): LoadCommentsPageModel => ({
  commentId: '',
  upperId: '',
  lowerId: '',
  rows: HOME_THREAD.map(pageRow),
  now: new Date(2026, 10, 12, 14, 19, 0),
  ...overrides,
});

describe('renderLoadCommentsPage', () => {
  it.each<[string, Partial<LoadCommentsPageModel>]>([
    ['c3', { commentId: id(3) }],
    ['none', {}],
    ['up', { upperId: id(4) }],
    ['low', { lowerId: id(1) }],
    ['desc', { commentId: id(1), rows: [...HOME_THREAD].reverse().map(pageRow) }],
  ])('reproduces the captured %s window byte for byte', (name, overrides) => {
    const result = renderLoadCommentsPage(pageModel(overrides), CTX);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe(COMMENTS_FRAGMENT_CONTENT_TYPE);
    expect(result.body).toBe(fixture(`loadcommentspage-${name}`));
  });

  it('renders the empty thread captured for content without comments', () => {
    expect(renderLoadCommentsPage(pageModel({ rows: [], lowerId: id(1) }), CTX).body).toBe(
      '\n\t<div id="commentsPage">\n\t\t\n\t\t\n\t</div>\n',
    );
  });

  it('uses the Gravatar when the remote user has no photo or the remote id is not a uuid', () => {
    const noPhoto = { ...pageRow(C1), remoteUser: { photoFileId: '  ', site: SITE } };
    const notUuid = { ...pageRow(C1), commenterRemoteId: 'alice@example.com' };
    for (const row of [noPhoto, notUuid]) {
      const body = renderLoadCommentsPage(pageModel({ rows: [row] }), CTX).body;
      expect(body).toMatch(/<img src="http:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{64}" \/>/);
    }
  });

  // ACF 2023 LSDateFormat(entered, 'long') and LSTimeFormat(entered, 'short') after setLocale(locale).
  it.each([
    { locale: 'en_US', expected: 'October 29, 2026, 3:04 PM' },
    { locale: 'de_DE', expected: '29. Oktober 2026, 15:04' },
    { locale: 'en_GB', expected: '29 October 2026, 15:04' },
  ])('prints the thread date and time under the $locale session', ({ locale, expected }) => {
    const row = { ...pageRow(C1), comment: { ...C1, entered: new Date(2026, 9, 29, 15, 4, 5) } };
    const body = renderLoadCommentsPage(pageModel({ rows: [row] }), { ...CTX, session: { ...CTX.session, locale } }).body;
    expect(body).toContain(`<dd class="date-time">\n\t\t\t\t\t${expected}\n\t\t\t\t</dd>`);
  });

  it('prints an empty parent name when the parent comment is gone, and the NULL-entered default', () => {
    const orphan = { ...pageRow(C3), parentName: null, comment: { ...C3, entered: null } };
    const body = renderLoadCommentsPage(pageModel({ rows: [orphan] }), CTX).body;
    expect(body).toContain('data-contentid="00000000000000000000000000000000001"></a>)</em>');
    expect(body).toContain('November 12, 2026, 2:19 PM');
  });
});

describe('renderCommentsAjax', () => {
  it('answers the empty body ccomments.ajax sends after cfcontent reset', () => {
    expect(renderCommentsAjax()).toEqual({ status: 200, contentType: COMMENTS_AJAX_CONTENT_TYPE, body: '' });
  });
});

describe('renderSearchSiteDataJson', () => {
  it.each([
    ['the captured default site', [{ siteid: 'default', site: 'Default' }], '[{"id":"default","value":"Default"}] '],
    ['no sites', [], '[] '],
    ['a quoted name', [{ siteid: 'default', site: 'O\'Brien "Q" \u00e9' }], '[{"id":"default","value":"O\\\'Brien \\"Q\\" \u00e9"}] '],
    ['a numeric id and a NULL name', [{ siteid: '42', site: null }], '[{"id":42,"value":""}] '],
  ])('encodes %s with mura.json and the trailing space', (_label, sites, body) => {
    expect(renderSearchSiteDataJson(sites)).toEqual({ status: 200, contentType: SEARCH_SITE_DATA_CONTENT_TYPE, body });
  });
});
