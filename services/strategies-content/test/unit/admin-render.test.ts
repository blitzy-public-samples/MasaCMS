// Admin response builders web's admin-raw handler relays (fragment and json modes), over literal models and labels.
import { describe, expect, it } from 'vitest';
import { LEGACY_ADMIN_SENTINEL_ID, adminUrl, esapiUrlEncode } from '@opt2/platform/legacy-compat';
import {
  ADMIN_JSON_CONTENT_TYPE,
  ADMIN_VIEW_CONTENT_TYPE,
  COMMENTS_AJAX_CONTENT_TYPE,
  COMMENTS_FRAGMENT_CONTENT_TYPE,
  CONTENT_COMPARABLE_EXCLUDED,
  DEFAULT_RELATED_CONTENT_SET,
  SEARCH_SITE_DATA_CONTENT_TYPE,
  SITE_MANAGER_FRAGMENT_CONTENT_TYPE,
  acfStructKeyOrder,
  createAdminLabels,
  renderApprovalActionJson,
  renderCformResponse,
  renderCommentsAjax,
  renderLoadComments,
  renderLoadDiff,
  renderLoadSelectedRelatedContent,
  renderLoadSiteFlat,
  renderLockCheck,
  renderSearchSiteDataJson,
  renderSiteManagerJson,
  renderSiteManagerTab,
  renderStatusModal,
  renderTagArray,
  renderUpdateResponse,
  type AdminRenderContext,
  type AdminRenderResult,
  type DiffVersion,
  type LoadCommentsModel,
  type LoadSiteFlatModel,
  type LockCheckModel,
  type NestNode,
  type SiteFlatRow,
  type SiteManagerModel,
  type SiteManagerRow,
  type StatusModalModel,
  type UpdateResponseModel,
} from '../../src/legacy/admin-render.js';
import {
  esapiEncode,
  getNextN,
  renderCsrfTokensUrl,
  renderZoom,
  type AdminSession,
  type EsapiContext,
} from '../../src/legacy/admin-markup.js';
import { acfSerializeJson, muraJsonEncode } from '../../src/legacy/cfjson.js';
import { computeDiff } from '../../src/legacy/diff-match-patch.js';
import { IDS, commentRow, contentRow } from '../helpers/seed.js';

const HOME = LEGACY_ADMIN_SENTINEL_ID;
const SITE_TREE = IDS.modules.content;
const SITE_ID = IDS.sites.tenantA;
const ADMIN_ID = 'AF1841AB-0ED4-34A5-AF2596AB342BA3E6';
const OTHER_USER_ID = 'AF1841AB-0ED4-34A5-AF2596AB342BA3E7';

// en.properties values of the keys these views print.
const labels = createAdminLabels(
  {
    'sitemanager.content.codediffnodifference': 'There are no differences between the content versions',
    'sitemanager.paginationmeta': 'Showing {1} of {2} Results',
    'sitemanager.draftprompt.title': 'Select Version to Edit',
    'sitemanager.content.deletecontentrecursiveconfirm': "Deleting '{1}' will also delete all content nested beneath it",
    'sitemanager.content.relatedcontent.relatedcontentsets': 'Related Content Sets',
    'sitemanager.content.fields.norelatedcontent': 'Add Related Content by dragging items here',
    'approvalchains.action': 'Action',
    'approvalchains.approve': 'Approve',
    'approvalchains.reject': 'Reject',
    'approvalchains.cancel': 'Cancel',
    'approvalchains.waitingforgroup': 'Waiting for Group',
    'comments.approve': 'Approve',
    'comments.unapprove': 'Unapprove',
    'comments.delete': 'Delete',
  },
  { 'sitemanager.inherit': 'Inherit Cascade' },
);

const SITE: AdminRenderContext['site'] = {
  siteId: SITE_ID,
  scheme: 'http',
  domain: 'localhost',
  requestDomain: 'localhost',
  previewDomain: '',
  serverPort: ':8080',
  context: '',
  siteIdInUrls: false,
  indexFileInUrls: false,
  hashUrls: false,
  useSSL: false,
  filePoolId: SITE_ID,
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

const SESSION: AdminSession = {
  userId: ADMIN_ID,
  siteId: SITE_ID,
  memberships: `S2IsPrivate;${SITE_ID},S2`,
  nextN: 2,
  dateKeyFormat: 'MM/DD/YYYY',
  rb: 'en',
  locale: 'en_US',
  openSectionList: '',
  flatViewArgs: {},
  copyContentId: '',
  copySiteId: '',
  copyAll: false,
};

/** Tokens that name their CSRF context, so assertions can tell which context a view asked for. */
const csrf = (context: string): { token: string; expires: string } => ({ token: `T-${context}`, expires: 'E' });

function context(session: Partial<AdminSession> = {}): AdminRenderContext {
  return {
    labels,
    session: { ...SESSION, ...session },
    site: SITE,
    siteSettings: { locking: 'none', hasComments: false, hasLockableNodes: false, privateUserPoolId: SITE_ID, extranet: false },
    config: { sortPermission: '', adminDir: '/admin', context: '' },
    csrf,
  };
}

function bodyText(result: Pick<AdminRenderResult, 'body'>): string {
  if (typeof result.body !== 'string') throw new TypeError('Expected a text body');
  return result.body;
}

/** mura.json output read as the JavaScript literal it is: json.cfc escapes `'` as `\'`, which JSON.parse rejects. */
function parseMuraJson(body: string): unknown {
  return JSON.parse(body.replace(/\\([\s\S])/g, (escape, ch: string) => (ch === "'" ? "'" : escape)));
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;
const js = (s: string): string => esapiEncode('javascript', s);

type ContentOverrides = Parameters<typeof contentRow>[0];

function managerRow(overrides: ContentOverrides): SiteManagerRow {
  return { ...contentRow(overrides), fileext: null, assocfilename: null, lockid: null };
}

function nestNode(overrides: ContentOverrides): NestNode {
  return { ...contentRow(overrides), fileext: null, assocfilename: null, lockid: null, verdict: 'editor', kidsCount: 0 };
}

function siteManagerModel(overrides: Partial<SiteManagerModel> = {}): SiteManagerModel {
  return {
    siteId: SITE_ID,
    topId: HOME,
    moduleId: SITE_TREE,
    type: 'Page',
    ptype: 'Page',
    sortBy: '',
    sortDirection: '',
    startRow: 1,
    rsTop: managerRow({ contentid: HOME, contenthistid: IDS.hist.rootActive, parentid: IDS.rootParent, title: 'Home' }),
    crumbs: [contentRow({ contentid: HOME, parentid: IDS.rootParent, title: 'Home' })],
    perm: 'editor',
    restricted: false,
    hasKids: 2,
    tabAssignments: '',
    extendAttributes: [],
    hasMarketingManager: false,
    nest: [
      nestNode({ contentid: IDS.content.pageOne, contenthistid: IDS.hist.pageOneActive, title: "Tom & Jerry's <News>" }),
      nestNode({ contentid: IDS.content.pageTwo, contenthistid: IDS.hist.pageTwoActive, title: 'Page Two' }),
    ],
    ...overrides,
  };
}

describe('esapiEncode', () => {
  it.each<[EsapiContext, string, string]>([
    ['html', `<script>&"'`, '&lt;script&gt;&amp;&quot;&#x27;'],
    ['html', 'Café € 中 a,b.c-d_e', 'Caf&eacute; &euro; &#x4e2d; a,b.c-d_e'],
    ['html_attr', `<script>&"' x`, '&lt;script&gt;&amp;&quot;&#x27;&#x20;x'],
    ['html_attr', 'é,.-_', '&eacute;,.-_'],
    ['javascript', `<script>&"'`, '\\x3Cscript\\x3E\\x26\\x22\\x27'],
    ['javascript', 'é 中😀,._', '\\xE9\\x20\\u4E2D😀,._'],
    ['url', `<script>&"' é`, '%3Cscript%3E%26%22%27+%C3%A9'],
  ])('encodes for %s: %j → %j', (kind, input, expected) => {
    expect(esapiEncode(kind, input)).toBe(expected);
  });

  it.each([`<script>&"'`, 'Café € 中 /?=&', ''])('delegates url encoding to esapiUrlEncode for %j', (input) => {
    expect(esapiEncode('url', input)).toBe(esapiUrlEncode(input));
  });

  it.each<EsapiContext>(['html', 'html_attr', 'javascript', 'url'])('prints a NULL column as empty and a number as CFML does (%s)', (kind) => {
    expect(esapiEncode(kind, null)).toBe('');
    expect(esapiEncode(kind, 25)).toBe('25');
  });
});

describe('createAdminLabels', () => {
  const bundle = createAdminLabels(
    { 'Sitemanager.Edit': 'Edit', 'sitemanager.quote': "Don''t touch", 'sitemanager.paginationmeta': 'Showing {1} of {2} Results' },
    { 'sitemanager.edit': 'Bearbeiten', 'sitemanager.enusonly': 'From en_US' },
  );

  it('finds a key case-insensitively, the locale bundle before the en_US fallback', () => {
    expect(bundle.key('sitemanager.edit')).toBe('Edit');
    expect(bundle.key('SITEMANAGER.EDIT')).toBe('Edit');
  });

  it("un-doubles '' to a single quote on every read", () => {
    expect(bundle.key('sitemanager.quote')).toBe("Don't touch");
  });

  it('falls back to the en_US bundle', () => {
    expect(bundle.key('sitemanager.enusonly')).toBe('From en_US');
  });

  it('prints <key>_missing for a key in neither bundle', () => {
    expect(bundle.key('sitemanager.nosuchkey')).toBe('sitemanager.nosuchkey_missing');
  });

  it('messageFormat fills {1}… from the arguments and {0} from the dummy element legacy prepends', () => {
    expect(bundle.messageFormat(bundle.key('sitemanager.paginationmeta'), ['1-10', 25])).toBe('Showing 1-10 of 25 Results');
    expect(bundle.messageFormat('[{0}]{1}', 'first,second')).toBe('[]first');
    expect(bundle.messageFormat("Deleting '{1}' now", 'Page One')).toBe("Deleting 'Page One' now");
    expect(bundle.messageFormat('{1} rows {2}', [1234567])).toBe('1,234,567 rows {2}');
  });
});

describe('getNextN', () => {
  it.each([
    ['first', 1, { currentPageNumber: 1, firstPage: 1, lastPage: 5, next: 11, previous: 1, through: 10 }],
    ['middle', 51, { currentPageNumber: 6, firstPage: 4, lastPage: 8, next: 61, previous: 41, through: 60 }],
    ['last', 91, { currentPageNumber: 10, firstPage: 6, lastPage: 10, next: 1, previous: 81, through: 95 }],
  ])('pages 95 rows of 10 with a buffer of 2 from the %s page', (_page, startRow, expected) => {
    expect(getNextN(95, 10, startRow, 2)).toEqual({ totalRecords: 95, recordsPerPage: 10, numberOfPages: 10, startRow, ...expected });
  });

  it('fails as CFML does for zero rows per page', () => {
    expect(() => getNextN(95, 0, 1, 2)).toThrow(RangeError);
  });
});

describe('renderSiteManagerJson (carch.loadsitemanager)', () => {
  const model = siteManagerModel();
  const result = renderSiteManagerJson(model, context());
  const body = bodyText(result);
  const data = parseMuraJson(body) as Record<string, unknown>;
  const html = String(data['html']);

  it('answers 200 with the cfcontent JSON type', () => {
    expect(result.status).toBe(200);
    expect(result.contentType).toBe(ADMIN_JSON_CONTENT_TYPE);
    // The wire form: ACF drops the space the view's cfcontent type="application/json; charset=utf-8" carries.
    expect(result.contentType).toBe('application/json;charset=utf-8');
  });

  it('encodes exactly html, perm and sortby, in ACF struct order, as mura.json does', () => {
    expect(Object.keys(data).sort()).toEqual(['html', 'perm', 'sortby']);
    expect(Object.keys(data)).toEqual(acfStructKeyOrder(['html', 'perm', 'sortBy']).map((k) => k.toLowerCase()));
    expect(data).toMatchObject({ perm: 'editor', sortby: 'orderno' });
    expect(body).toBe(muraJsonEncode({ perm: 'editor', sortBy: 'orderno', html }));
  });

  it('prints the ajax breadcrumb of the crumbs', () => {
    expect(html).toContain(renderZoom(model.crumbs, { ajax: true, class: 'breadcrumb' }));
  });

  it('prints the top node and one row per nest node, titles HTML-encoded', () => {
    expect(count(html, '<li data-siteid="')).toBe(1 + model.nest.length);
    for (const node of model.nest) expect(html).toContain(`data-contentid="${String(node.contentid)}"`);
    expect(html).toContain('Tom &amp; Jerry&#x27;s &lt;News&gt;');
    expect(html).not.toContain('<News>');
  });

  it('prints the quick-edit and delete CSRF tokens the rows carry', () => {
    expect(html).toContain(`data-csrf="${renderCsrfTokensUrl(csrf(`${HOME}quickedit`))}"`);
    expect(html).toContain(renderCsrfTokensUrl(csrf(`${IDS.content.pageOne}deleteall`)));
  });

  it('prints no pager while every kid fits on one page', () => {
    expect(html).not.toContain('class="pagination"');
  });

  it('prints the pager when the top node has more kids than a page holds', () => {
    const paged = parseMuraJson(bodyText(renderSiteManagerJson(siteManagerModel({ hasKids: 5 }), context()))) as Record<string, unknown>;
    const pagedHtml = String(paged['html']);
    expect(pagedHtml).toContain('<ul class="pagination">');
    expect(pagedHtml).toContain('Showing 1-2 of 5 Results');
    expect(pagedHtml).toContain('<li class="active"><a href="#">1</a></li>');
    expect(pagedHtml).toContain(`return siteManager.loadSiteManager('${js(SITE_ID)}','${js(HOME)}','${js(SITE_TREE)}','','','Page',5);`);
  });

  it('resets the site tab of the session flat view', () => {
    expect(result.sessionEffects).toEqual({ flatViewArgs: { [SITE_ID]: { tab: 0 } } });
  });
});

describe('renderSiteManagerTab (carch.siteManagerTab)', () => {
  it('answers 200 with an empty body and records the tab for the session site', () => {
    expect(renderSiteManagerTab('1', { session: SESSION })).toEqual({
      status: 200,
      contentType: ADMIN_VIEW_CONTENT_TYPE,
      body: '',
      sessionEffects: { flatViewArgs: { [SITE_ID]: { tab: '1' } } },
    });
  });

  it('keeps the spelling of an existing site entry and tab key', () => {
    const session = { ...SESSION, flatViewArgs: { 'TENANT-A': { Tab: 0, page: 2 } } };
    expect(renderSiteManagerTab('1', { session }).sessionEffects).toEqual({ flatViewArgs: { 'TENANT-A': { Tab: '1', page: 2 } } });
  });
});

describe('renderLoadDiff (carch.loaddiff)', () => {
  const older: DiffVersion = {
    lastUpdate: new Date(2026, 5, 29, 10, 0, 0),
    values: [
      ['contentID', IDS.content.pageOne],
      ['title', 'Annual report'],
      ['body', '<p>Draft of the report</p>'],
      ['menuTitle', 'Report'],
      ['lastUpdate', new Date(2026, 5, 29, 10, 0, 0)],
      ['approved', 0],
      ['changesetID', ''],
    ],
  };
  const newer: DiffVersion = {
    lastUpdate: new Date(2026, 5, 29, 15, 30, 0),
    values: [
      ['contentID', IDS.content.pageTwo],
      ['title', 'Annual report 2026'],
      ['body', '<p>Final report</p>'],
      ['menuTitle', 'Report'],
      ['lastUpdate', new Date(2026, 5, 29, 15, 30, 0)],
      ['approved', 1],
      ['changesetID', IDS.changesets.published],
    ],
  };
  const changed: Readonly<Record<string, readonly [string, string]>> = {
    title: ['Annual report', 'Annual report 2026'],
    body: ['<p>Draft of the report</p>', '<p>Final report</p>'],
  };

  it('prints one <h3> section per differing property with the diff-match-patch pretty HTML, older to newer', () => {
    const result = renderLoadDiff(older, newer, { labels });
    const expected = acfStructKeyOrder(Object.keys(changed))
      .map((property) => {
        const [from, to] = changed[property] as readonly [string, string];
        return `<h3>${property.toUpperCase()}</h3>${computeDiff(from, to).html}`;
      })
      .join('');
    expect(result).toEqual({ status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, body: expected });
    expect(result.contentType).toMatch(/^text\/html/);
    const body = bodyText(result);
    expect(body).toContain('<h3>TITLE</h3>');
    expect(body).toContain('<h3>BODY</h3>');
    expect(body).toContain('&lt;p&gt;');
    expect(body).toContain('<ins style="background:#e6ffe6;">');
  });

  it('orders the versions by lastUpdate whichever is passed first', () => {
    expect(renderLoadDiff(newer, older, { labels })).toEqual(renderLoadDiff(older, newer, { labels }));
  });

  it('never compares the comparable="false" properties', () => {
    const body = bodyText(renderLoadDiff(older, newer, { labels }));
    for (const property of CONTENT_COMPARABLE_EXCLUDED) expect(body).not.toContain(`<h3>${property.toUpperCase()}</h3>`);
  });

  it('prints the no-difference label for versions differing only in excluded properties', () => {
    const same: DiffVersion = {
      lastUpdate: newer.lastUpdate,
      values: older.values.map(([name, value]): readonly [string, unknown] => [name, name === 'approved' ? 1 : value]),
    };
    expect(bodyText(renderLoadDiff(older, same, { labels }))).toBe('There are no differences between the content versions');
  });
});

describe('renderLockCheck (carch.lockcheck)', () => {
  const lock: LockCheckModel = {
    lockId: ADMIN_ID,
    queryString: `muraAction=carch.lockcheck&destAction=carch.edit&contentid=${IDS.content.pageOne}&siteid=${SITE_ID}`,
    destAction: 'carch.edit',
    contentId: IDS.content.pageOne,
    siteId: SITE_ID,
    contentHistId: IDS.hist.pageOneDraft,
    homeId: HOME,
    coreVersion: '7.6.1',
  };

  it('redirects the lock holder to the destination action', () => {
    expect(renderLockCheck(lock, context())).toEqual({
      status: 302,
      contentType: ADMIN_VIEW_CONTENT_TYPE,
      body: '',
      redirect: `./?muraAction=carch.edit&destAction=carch.edit&contentid=${IDS.content.pageOne}&siteid=${SITE_ID}`,
    });
  });

  it('prints the draft prompt in the layout for anyone else', () => {
    const result = renderLockCheck({ ...lock, lockId: OTHER_USER_ID }, context());
    expect(result).toMatchObject({ status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, layout: true });
    expect(result.redirect).toBeUndefined();
    const body = bodyText(result);
    expect(body).toContain('<h1 id="configuratorHeader">Select Version to Edit</h1>');
    expect(body).toContain(`muraAction=carch.draftpromptdata&contentid=${js(IDS.content.pageOne)}&siteid=${js(SITE_ID)}`);
    expect(body).toContain("href = href.replace('carch.lockcheck','carch.edit&locknode=' + locknode );");
    expect(result.ajax).toContain('/admin/assets/js/architecture.min.js?coreversion=7.6.1');
  });
});

describe('carch JSON and status panels', () => {
  it('renderApprovalActionJson prints {contenthistid, previewurl} through mura.json and the space before cfabort', () => {
    const histId = IDS.hist.pageOneDraft;
    const previewUrl = `http://localhost:8080/page-one/?previewid=${histId}`;
    expect(renderApprovalActionJson({ contenthistid: histId, previewUrl })).toEqual({
      status: 200,
      contentType: 'application/json; charset=UTF-8',
      body: `{"contenthistid":"${histId}","previewurl":"${previewUrl}"} `,
    });
  });

  it('renderTagArray prints a JavaScript literal, not JSON, as loadtagarray.cfm does', () => {
    const result = renderTagArray(['News', "O'Brien"]);
    expect(result).toEqual({
      status: 200,
      contentType: ADMIN_JSON_CONTENT_TYPE,
      body:
        "[{id: 'News', toString: function() { return 'News'; } }," +
        "{id: 'O\\x27Brien', toString: function() { return 'O\\x27Brien'; } }]",
    });
    expect(() => JSON.parse(bodyText(result))).toThrow(SyntaxError);
    expect(renderTagArray([], 'cchangesets')).toEqual({ status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE, body: '[]' });
  });

  const pendingModal = (requester: string): StatusModalModel => ({
    mode: '',
    content: { active: 0, approved: 0, lastupdate: new Date(2026, 5, 29, 15, 30, 0), changesetid: null, approvalStatus: 'Pending' },
    user: { isNew: false, fullName: 'Ann Editor' },
    requiresApproval: true,
    showApprovalStatus: true,
    approval: {
      request: { status: 'Pending', groupid: IDS.groups.approvers, userid: requester, requestid: IDS.approval.request, siteid: SITE_ID },
      group: { type: 1, groupName: 'Approvers & Editors', fullName: '' },
      actions: [],
    },
    lockType: '',
    hasChangesets: false,
    changesetName: undefined,
    membershipIds: '',
    resourcePath: '',
  });

  it('renderStatusModal offers approve, reject and cancel to an S2 approver who made the request', () => {
    const result = renderStatusModal(pendingModal(ADMIN_ID), context());
    expect(result).toMatchObject({ status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE });
    const { body } = result;
    expect(body).toContain('<dl class="approval-action-form">');
    expect(body).toContain('id="approval-approve" name="approval-action"type="radio" value="Approve" checked/> Approve');
    expect(body).toContain('id="approval-reject" name="approval-action" type="radio" value="Reject" checked/> Reject');
    expect(body).toContain('id="approval-cancel" name="approval-action"type="radio" value="Cancel" checked/> Cancel');
    expect(body).toContain(`onclick="applyApprovalAction('${IDS.approval.request}',`);
    expect(body).toContain('<p>Approvers &amp; Editors</p>');
  });

  it('renderStatusModal shows no action form to a user who neither approves nor requested', () => {
    const body = renderStatusModal(pendingModal(OTHER_USER_ID), context({ memberships: '' })).body;
    expect(body).toContain('<em>Waiting for Group:</em>');
    expect(body).not.toContain('approval-action-form');
  });

  it('renderUpdateResponse returns the failed ajax save with fresh CSRF fields for the version', () => {
    const errors = { title: 'The Title field is required.' };
    const model: UpdateResponseModel = {
      qqfile: false,
      ajaxRequest: true,
      action: 'add',
      content: { filename: 'page-one', contenthistid: IDS.hist.pageOneDraft, active: 0, isOnDisplay: false },
      errors,
    };
    expect(renderUpdateResponse(model, context())).toEqual({
      status: 200,
      contentType: ADMIN_VIEW_CONTENT_TYPE,
      body:
        `{success:false,\n\t\terrors:${acfSerializeJson(errors, { preserveKeyCase: true })},` +
        `\n\t\tcsrf_token: 'T-${IDS.hist.pageOneDraft}add',\n\t\tcsrf_token_expires: 'E'\n}`,
    });
  });
});

describe('ccomments and cnav builders', () => {
  const approved = commentRow({ commentid: IDS.comments.approved, contentid: IDS.content.pageOne, name: 'Ann <Admin>', isapproved: 1 });
  const spam = commentRow({ commentid: IDS.comments.spam, contentid: IDS.content.pageTwo, isspam: 1 });
  const commentsModel = (overrides: Partial<LoadCommentsModel> = {}): LoadCommentsModel => ({
    keywords: '',
    commentStatus: '',
    startDate: '',
    endDate: '',
    categoryId: '',
    categories: [],
    sortBy: 'entered',
    sortDirection: 'desc',
    sortDirLink: 'asc',
    nextN: 25,
    pageNo: 1,
    totalPages: 1,
    startPage: 1,
    endPage: 1,
    recordCount: 2,
    rows: [
      { comment: approved, content: { menutitle: 'Page One', filename: 'page-one' } },
      { comment: spam, content: null },
    ],
    now: new Date(2026, 5, 30, 12, 0, 0),
    ...overrides,
  });

  it('renderLoadComments prints one grid row per comment with its single-edit actions', () => {
    const result = renderLoadComments(commentsModel(), context());
    expect(result).toMatchObject({ status: 200, contentType: COMMENTS_FRAGMENT_CONTENT_TYPE });
    const { body } = result;
    expect(count(body, '<input type="checkbox" name="ckUpdate" class="checkall" value="')).toBe(2);
    expect(body).toContain(`class="checkall" value="${IDS.comments.approved}" />`);
    expect(body).toContain(`class="checkall" value="${IDS.comments.spam}" />`);
    expect(body).toContain(`data-commentid="${IDS.comments.approved}" data-action="unapprove"`);
    expect(body).toContain(`data-commentid="${IDS.comments.spam}" data-action="unspam"`);
    expect(body).toContain('Ann &lt;Admin&gt;');
    expect(body).toContain('<h1><i class="mi-external-link"></i> Content Missing</h1>');
  });

  it('renderLoadComments prints the bulk controls above and below the grid', () => {
    const { body } = renderLoadComments(commentsModel(), context());
    expect(body).toContain('<input type="hidden" name="bulkedit" id="bulkedit" value="" />');
    expect(count(body, 'class="bulkEdit" data-alertmessage=')).toBe(6);
    const bulkLinks = [
      'data-action="approve"><i class="mi-check"></i> Approved</a></li>',
      'data-action="spam"><i class="mi-flag"></i> Spam</a></li>',
      'data-action="delete"><i class="mi-trash"></i> Deleted</a></li>',
    ];
    for (const link of bulkLinks) expect(count(body, link)).toBe(2);
    expect(body).not.toContain('class="pagination"');
    expect(count(renderLoadComments(commentsModel({ totalPages: 3, endPage: 3 }), context()).body, '<ul class="pagination">')).toBe(2);
  });

  it('renderLoadComments prints the empty-status notice without rows', () => {
    const { body } = renderLoadComments(commentsModel({ rows: [], recordCount: 0, commentStatus: 'Unapproved' }), context());
    expect(body).toContain('<div class="help-block-empty">No Unapproved comments found.</div>');
    expect(body).not.toContain('name="ckUpdate"');
  });

  it('renderCommentsAjax answers the reset buffer: an empty text/html body', () => {
    expect(renderCommentsAjax()).toEqual({ status: 200, contentType: COMMENTS_AJAX_CONTENT_TYPE, body: '' });
    expect(COMMENTS_AJAX_CONTENT_TYPE).toBe('text/html;charset=utf-8');
  });

  it('renderSearchSiteDataJson prints [{id, value}] through mura.json with the application/json type', () => {
    const result = renderSearchSiteDataJson([
      { siteid: SITE_ID, site: 'Tenant A' },
      { siteid: IDS.sites.tenantB, site: null },
    ]);
    expect(result).toEqual({
      status: 200,
      contentType: SEARCH_SITE_DATA_CONTENT_TYPE,
      body: `[{"id":"${SITE_ID}","value":"Tenant A"},{"id":"${IDS.sites.tenantB}","value":""}] `,
    });
    expect(result.contentType).toMatch(/^application\/json/);
    expect(JSON.parse(result.body)).toEqual([
      { id: SITE_ID, value: 'Tenant A' },
      { id: IDS.sites.tenantB, value: '' },
    ]);
  });
});

describe('renderCformResponse (cform json.cfm and html.cfm)', () => {
  it.each([
    ['json', '{"formid":"x"}', ADMIN_JSON_CONTENT_TYPE],
    ['html', '<div class="mura-form-dialog">x</div>', ADMIN_VIEW_CONTENT_TYPE],
  ] as const)('%s prints rc.return unchanged under its content type', (kind, body, contentType) => {
    expect(renderCformResponse(kind, body)).toEqual({ status: 200, contentType, body });
  });
});

describe('fragment builders of the Site Manager, edit and panel views', () => {
  it('renderLoadSiteFlat (sitemanager) prints the row delete link with its deleteall CSRF tokens', () => {
    const row: SiteFlatRow = {
      ...contentRow({ contentid: IDS.content.pageOne, contenthistid: IDS.hist.pageOneActive, parentid: IDS.content.section, title: 'Page One' }),
      fileext: null,
      filesize: null,
      lockid: null,
      locktype: null,
      crumbs: [],
      verdict: 'editor',
      categories: [],
    };
    const model: LoadSiteFlatModel = {
      event: { siteid: SITE_ID, moduleid: SITE_TREE, startrow: 1, page: 1, sortby: 'lastupdate', sortdirection: 'desc', report: '' },
      powerUser: true,
      customTagGroups: '',
      subtypes: [],
      totalRecords: 1,
      rows: [row],
      reportCounts: { mydrafts: 0, mysubmissions: 0, myapprovals: 0, myexpires: 0, mylockedcontent: 0 },
      categoryCount: 0,
      categories: [],
    };
    const result = renderLoadSiteFlat(model, context());
    expect(result).toMatchObject({ status: 200, contentType: SITE_MANAGER_FRAGMENT_CONTENT_TYPE });
    expect(result.contentType).toBe(ADMIN_VIEW_CONTENT_TYPE);
    const deleteLink = adminUrl({
      circuit: 'cArch',
      action: 'update',
      params: [
        ['contentid', IDS.content.pageOne, 'raw'],
        ['type', 'Page', 'raw'],
        ['action', 'deleteall', 'raw'],
        ['topid', IDS.content.section],
        ['siteid', SITE_ID],
        ['moduleid', SITE_TREE, 'raw'],
        ['parentid', IDS.content.section],
        ['startrow', '1'],
      ],
      adminDir: '.',
      context: '',
    });
    expect(result.body).toContain(`href="${deleteLink}${renderCsrfTokensUrl(csrf(`${IDS.content.pageOne}deleteall`))}"`);
    expect(result.sessionEffects?.flatViewArgs?.[SITE_ID]).toMatchObject({ tab: 1, page: 1, sortBy: 'lastupdate' });
  });

  it('renderLoadSelectedRelatedContent (edit) prints the selected items and no CSRF fields, as the view prints none', () => {
    const item = {
      contentid: IDS.content.pageTwo,
      siteid: SITE_ID,
      type: 'Page',
      subtype: 'Default',
      crumbs: [contentRow({ contentid: IDS.content.pageTwo, title: 'Page Two' }), contentRow({ contentid: HOME, title: 'Home' })],
    };
    const result = renderLoadSelectedRelatedContent(
      {
        relatedContentSetId: '',
        relatedContentSets: [DEFAULT_RELATED_CONTENT_SET],
        contentId: IDS.content.pageOne,
        relatedContent: { [DEFAULT_RELATED_CONTENT_SET.relatedcontentsetid]: [item] },
        relatedItems: [],
        relatedEntities: {},
        subTypes: [],
        customIcons: () => '',
      },
      context(),
    );
    expect(result).toMatchObject({ status: 200, contentType: ADMIN_VIEW_CONTENT_TYPE });
    expect(result.body).toContain('<h3>Related Content Sets</h3>');
    expect(result.body).toContain(`<li class="item" data-contentid="${IDS.content.pageTwo}" data-content-type="Page/Default">`);
    expect(result.body).toContain('<li class="item empty noShow">');
    expect(result.body).not.toContain('csrf_token');
  });
});
