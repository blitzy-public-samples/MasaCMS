// carch.edit against edit.cfm: the controller step and its missing-version redirect, then the legacy-captured view
// bodies around the real edit panels.
import { readFileSync } from 'node:fs';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, cfUuid } from '@opt2/platform/legacy-compat';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secure } from '@/lib/access-gate';
import { createCsrfRenderer } from '@/lib/csrf';
import { formatDateTimeShort } from '@/lib/dates';
import { isSafeHtml, raw, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { fw1RedirectTarget } from '@/lib/urls';
import { applyCarchDefaults } from '@/screens/carch/controller';
import { editScreen, renderEditView } from '@/screens/carch/edit';
import { renderEditPanels, urlFormType } from '@/screens/carch/edit-panels';
import type { EditFormInput, EditFormState, SubTypeRow } from '@/screens/carch/form/custom-tags';
import { renderChangesetsDialog } from '@/screens/carch/form/changesets';
import { headFormBuilder } from '@/screens/carch/form/head-formbuilder';
import {
  COMPONENT_MODULE_ID,
  CONTENT_MODULE_ID,
  FORM_MODULE_ID,
  ROOT_CONTENT_ID,
  VARIATION_MODULE_ID,
  structOf,
  structText,
} from '@/screens/carch/model';
import { displayErrors } from '@/screens/carch/partials/display-errors';
import { carchJs } from '@/screens/carch/partials/js';
import { status } from '@/screens/carch/partials/status';
import type { CarchPageModel } from '@/screens/carch/service';
import type { PageControllerRedirect, ScreenContext } from '@/screens/registry';
import type { ShellView } from '@/shell/document';
import { USER_IDS } from '../../fixtures/session';
import { APPROVAL_GROUP_IDS } from '../../fixtures/strategies-content/approval-chains';
import {
  CARCH_PATHS,
  CONTENT_HIST_IDS,
  CONTENT_IDS,
  carchEditExistingPage,
  carchEditFile,
  carchEditNewPage,
} from '../../fixtures/strategies-content/carch';
import { CATEGORY_IDS } from '../../fixtures/strategies-content/categories';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type RecordedRequest,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenModel, renderScreenPage } from '../../helpers/screen-context';

vi.mock('@opt2/platform/legacy-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/legacy-compat')>();
  return { ...actual, cfUuid: vi.fn(actual.cfUuid) };
});

// `cArch.edit` view bodies captured from the legacy ACF 2023 server between the layout's `<div id="mura-content">` and
// its close, as admin (S2) and qa_editor, for Home as installed (plainly and compact) and new Page, Link, File,
// Gallery, Component, Form and Variation nodes, the new Page also compact and with `bigui=schedule`, and a Variation
// whose requested version does not exist. The edit panels' include is `@@PANELS@@`, CSRF values are `<token>` and
// `<expires>`, and the ids legacy minted for each new node are NEW_ID and NEW_HIST_ID.
const CAPTURES = JSON.parse(
  readFileSync(new URL('../../fixtures/strategies-content/edit-view.json', import.meta.url), 'utf8'),
) as Readonly<Record<string, string>>;

const SITE = 'default';
const HOME = ROOT_CONTENT_ID;
const HOME_HIST_ID = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const END_ID = '00000000000000000000000000000000END';
const NEW_ID = 'D1000000-0000-0000-0000000000000001';
const NEW_HIST_ID = 'D2000000-0000-0000-0000000000000001';
const MISSING_HIST_ID = 'D2000000-0000-0000-0000000000000009';
const MINTED_ID = 'D1000000-0000-0000-0000000000000077';
const NOW = new Date('2026-11-13T04:22:00Z');
const TOKENS = Object.freeze({ token: 'TESTCSRFTOKEN0000000000000000000', expires: '260630150000000' });
const PAGE_LEVEL = 'Page,Folder,Calendar';

/** Every tab `contentManager.getTabList()` names, which a user whose groups assign none receives. */
const FULL_TAB_LIST =
  'Basic,SEO,Summary,Image,Publishing,Scheduling,Layout & Objects,Categorization,Tags,Related Content,' +
  'Extended Attributes,Remote';

type Struct = Readonly<Record<string, unknown>>;

/** A `getCrumbList` row of a module root or Home. */
const crumb = (contentid: string, moduleid: string, type: string, menutitle: string, iconclass: string): Struct => ({
  siteid: SITE,
  contentid,
  moduleid,
  type,
  menutitle,
  restricted: 0,
  iconclass,
});

const HOME_CRUMBS = [crumb(HOME, CONTENT_MODULE_ID, 'Page', 'Home', 'mi-file')];
const COMPONENT_CRUMBS = [crumb(COMPONENT_MODULE_ID, COMPONENT_MODULE_ID, 'Module', 'Components', 'mi-cog')];
const FORM_CRUMBS = [crumb(FORM_MODULE_ID, FORM_MODULE_ID, 'Module', 'Forms', 'mi-cog')];
const VARIATION_CRUMBS = [crumb(VARIATION_MODULE_ID, VARIATION_MODULE_ID, 'Module', 'Remote Variations', 'mi-cog')];

/** The display interval Masa stores for a new node: daily, all day, never ending. */
const NEW_INTERVAL: Struct = {
  type: 'Daily',
  every: 1,
  repeats: 1,
  allday: '1',
  end: 'never',
  endon: '',
  endafter: '1',
  daysofweek: '',
  detectconflicts: '0',
  detectspan: '12',
  timezone: 'Etc/UTC',
};

/**
 * The edit model's content bean: Home as installed, or what `getcontentVersion` loads for a version that does not
 * exist (a new Page bean, active, with legacy's minted ids), whose `getParent()` is of `parentType`; `values` replace
 * members.
 */
function servedBean(home: boolean, parentType: string, values: Struct = {}): Struct {
  return {
    contentID: home ? HOME : NEW_ID,
    contentHistID: home ? HOME_HIST_ID : NEW_HIST_ID,
    parentID: home ? END_ID : '',
    siteID: SITE,
    moduleID: CONTENT_MODULE_ID,
    type: 'Page',
    subType: 'Default',
    isNew: home ? 0 : 1,
    isLocked: 0,
    active: 1,
    approved: home ? 1 : 0,
    approvalStatus: '',
    changesetID: '',
    title: home ? 'Home' : '',
    menuTitle: home ? 'Home' : '',
    urlTitle: '',
    htmlTitle: '',
    filename: '',
    moduleAssign: '',
    body: '',
    summary: '',
    credits: '',
    metaDesc: '',
    metaKeywords: '',
    notes: '',
    tags: '',
    responseChart: 0,
    responseMessage: '',
    responseSendTo: '',
    responseDisplayFields: '',
    fileID: '',
    fileExt: '',
    majorVersion: 0,
    minorVersion: 0,
    lastUpdate: '2026-11-13T04:22:00.000',
    display: 1,
    displayStart: '',
    displayStop: '',
    displayInterval: 'Daily',
    displayIntervalValues: NEW_INTERVAL,
    displayStartInTimezone: '',
    displayStopInTimezone: '',
    parent: { type: parentType },
    isFeature: 0,
    featureStart: '',
    featureStop: '',
    releaseDate: '',
    isNav: 1,
    target: '_self',
    searchExclude: 0,
    restricted: 0,
    restrictGroups: '',
    forceSSL: 0,
    doCache: 1,
    template: '',
    childTemplate: '',
    inheritObjects: 'Inherit',
    targetParams: '',
    nextN: 10,
    imageSize: 'small',
    imageWidth: 'AUTO',
    imageHeight: 'AUTO',
    displayList: 'Date,Title,Image,Summary,Credits',
    availableDisplayList: 'Date,Title,Image,Summary,Body,ReadMore,Credits,Comments,Tags,Rating',
    urlStem: '/',
    mobileExclude: 0,
    expires: '',
    remoteID: '',
    remoteURL: '',
    remotePubDate: '',
    remoteSource: '',
    remoteSourceURL: '',
    orderNo: 1,
    errors: {},
    stats: { lockID: '', lockType: '' },
    ...(home ? { previewURL: `http://localhost:8080/?previewid=${HOME_HIST_ID}` } : {}),
    ...values,
  };
}

/** One captured request and what its model holds. */
interface ViewCase {
  /** The request's URL scope as the capture sent it. */
  readonly rc: Readonly<Record<string, string>>;
  /** Home as installed, else a version that does not exist. */
  readonly home?: boolean;
  /** qa_editor, whose Editor group assigns no tabs, instead of the S2 admin. */
  readonly editor?: boolean;
  /** `rc.perm`; editor unless given. */
  readonly perm?: string;
  readonly parentType: string;
  readonly crumbs: readonly Struct[];
  /** The module root setType files a new Form, Component or Variation under, as its module and parent. */
  readonly filedUnder?: string;
  /** The type selector's `baseTypeList` the view computes. */
  readonly baseTypeList: string;
  /** Edit model members replacing the defaults. */
  readonly model?: Struct;
  /** Served bean members replacing the defaults. */
  readonly bean?: Struct;
  /** The request's headers, laid over the browser's. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The posted fields; none, as on a GET, unless given. */
  readonly formScope?: Readonly<Record<string, string>>;
  /** The FW/1 item; `edit` unless given. */
  readonly item?: string;
}

/** The S2 admin's or qa_editor's request for `c.rc` on `cArch.<c.item>`, carch's `before()` defaults applied. */
function requestOf(c: ViewCase): AdminRequest {
  const partial: AdminRequestPartial = {
    circuit: 'cArch',
    item: c.item ?? 'edit',
    site: { hasChangesets: true, record: { theme: 'default' } },
    rc: c.rc,
    formScope: c.formScope ?? {},
    ...(c.headers === undefined ? {} : { headers: new Headers(c.headers) }),
  };
  return applyCarchDefaults(c.editor === true ? editorRequest(partial) : adminS2Request(partial));
}

/** The edit model `rc` of `c` around `bean`. */
function modelRc(c: ViewCase, bean: Struct): Struct {
  return {
    contentBean: bean,
    parentBean: { type: c.parentType },
    crumbData: c.crumbs,
    perm: c.perm ?? 'editor',
    site: {
      locking: 'none',
      dataCollection: 1,
      emailBroadcaster: 0,
      columnCount: 3,
      columnNames: 'Left Column^Main Content^Right Column',
      hasFeedManager: 1,
      webPath: 'http://localhost:8080',
      templateList: '',
      customTagGroups: '',
      assetPath: '/sites/default',
      customImageSizes: [],
      displayObjectLookup: [],
    },
    siteConfig: { customTagGroups: '' },
    rsTemplates: [{ name: 'default.cfm' }],
    useLayoutManager: true,
    templateArray: [],
    notifyCount: 0,
    rsUsage: [],
    categories: [],
    rsCategoryAssign: [],
    categoryCount: 0,
    extendSets: [],
    hasLockableNodes: 0,
    purgeDrafts: 1,
    confirmSaveAsDraft: 1,
    showExtensionsInDefault: 0,
    enforceChangesets: 0,
    pageLimit: 50000,
    rsPageCount: [{ counter: 7 }],
    hasDrafts: 0,
    requiresApproval: 0,
    showApprovalStatus: 0,
    currentChangeset: { isNew: 1, name: '' },
    pendingChangesets: [],
    draftcheck: { showdialog: 'false', historyid: '' },
    hasSummary: 1,
    hasBody: 1,
    tabAssignments: c.editor === true ? FULL_TAB_LIST : '',
    subtypeFilter: '',
    rsSubTypes: [],
    ...c.model,
  };
}

/** The edit model strategies-content serves for `c`. */
const modelOf = (c: ViewCase): CarchPageModel => ({
  rc: modelRc(c, servedBean(c.home === true, c.parentType, c.bean)),
});

/** The bean after the view's setters: a new node takes the requested type and, for a module type, its module root. */
function viewBean(c: ViewCase): Struct {
  const served = servedBean(c.home === true, c.parentType, c.bean);
  if (c.home === true) return served;
  const type = c.rc.type ?? 'Page';
  return c.filedUnder === undefined
    ? { ...served, type }
    : { ...served, type, moduleID: c.filedUnder, parentID: c.filedUnder };
}

/** The panel state edit.cfm leaves for `c`. */
function stateOf(c: ViewCase, req: AdminRequest, values: Partial<EditFormState> = {}): EditFormState {
  return {
    tabAssignments: c.editor === true ? FULL_TAB_LIST : '',
    pageLevelList: PAGE_LEVEL,
    baseTypeList: c.baseTypeList,
    subTypes: [],
    subtypeFilter: '',
    isExtended: false,
    requiresApproval: false,
    showApprovalStatus: false,
    hasChangesets: true,
    ptype: req.rc.ptype ?? '',
    compactDisplay: req.rc.compactDisplay ?? '',
    preview: req.rc.preview ?? '',
    ...values,
  };
}

/** identity `issueCsrfTokens`: the {@link TOKENS} pair for every requested context. */
function issueTokens(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => ({
    context,
    [CSRF_FIELD_TOKEN]: TOKENS.token,
    [CSRF_FIELD_EXPIRES]: TOKENS.expires,
  }));
  return { status: 200, body: { tokens } };
}

/** The screen context of `req` over a gateway that issues tokens and answers `reply` for the edit model of `path`. */
function contextOf(req: AdminRequest, edit?: { readonly contentId: string; readonly reply: FakeReply }) {
  const gateway = fakeGatewayClient({
    [routeKey('POST', 'identity', '/v1/csrf/tokens')]: issueTokens,
    ...(edit === undefined
      ? {}
      : { [routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/content/${edit.contentId}`)]: edit.reply }),
  });
  const ctx: ScreenContext = {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor(req.session.rb),
    hooks: { secondaryMenus: {} },
    now: NOW,
  };
  return { ctx, gateway };
}

/** The panels' own input for `c`, as edit.cfm leaves it for the include. */
function panelInput(c: ViewCase, req: AdminRequest, state: EditFormState): EditFormInput {
  const panelCtx: Pick<ScreenContext, 'req' | 'rb' | 'now'> = { req, rb: rbFor(req.session.rb), now: NOW };
  const ctx = panelCtx as ScreenContext;
  return { ctx, req, data: { rc: modelRc(c, viewBean(c)) }, state };
}

/** The hidden `url.formType` field of the captured new builder form. */
const BUILDER_FIELD = '\n\t\t\n\t\t<input type="hidden" name="formType" value="builder">\n\t';
const BODY_RENDER_OPEN = '<div id="mura-content-body-render" style="display:none;">';
const BODY_RENDER_CLOSE = '</div>\n\t\t\t\t\n\t\t\t</div>\n\n\n\t\t\t<div class="load-inline tab-preloader">';

/**
 * The captured body of `capture` with the real panels of `input` and the test tokens in place; with `ownBody`, the
 * panels' own `bodyContent` replaces the captured one inside the body render area.
 */
async function expectedBody(
  capture: string,
  input: EditFormInput,
  ownBody = false,
): Promise<{ body: string; htmlHead?: string }> {
  const template = CAPTURES[capture];
  if (template === undefined) throw new Error(`no capture ${capture}`);
  const panels = await renderEditPanels(input);
  let body = template
    .replace('@@PANELS@@', () => toString(panels.html))
    .replaceAll('<token>', TOKENS.token)
    .replaceAll('<expires>', TOKENS.expires);
  if (ownBody) {
    const start = body.indexOf(BODY_RENDER_OPEN) + BODY_RENDER_OPEN.length;
    body = body.slice(0, start) + toString(panels.bodyContent) + body.slice(body.indexOf(BODY_RENDER_CLOSE, start));
  }
  return { body, ...(panels.htmlHead === undefined ? {} : { htmlHead: toString(panels.htmlHead) }) };
}

const HOME_RC = {
  contenthistid: HOME_HIST_ID,
  contentid: HOME,
  type: 'Page',
  parentid: END_ID,
  topid: HOME,
  siteid: SITE,
  moduleid: CONTENT_MODULE_ID,
};

/** A new node of `type` under Home, as the Site Manager's add menu opens it. */
const newUnderHome = (type: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
  contentid: '',
  parentid: HOME,
  type,
  topid: HOME,
  siteid: SITE,
  moduleid: CONTENT_MODULE_ID,
  ...extra,
});

/** A new node of `type` under the module root `moduleId`. */
const newInModule = (type: string, moduleId: string, extra: Readonly<Record<string, string>> = {}) => ({
  type,
  contentid: '',
  topid: moduleId,
  parentid: moduleId,
  siteid: SITE,
  moduleid: moduleId,
  ...extra,
});

const HOME_CASE: ViewCase = {
  rc: HOME_RC,
  home: true,
  parentType: 'Page',
  crumbs: HOME_CRUMBS,
  baseTypeList: PAGE_LEVEL,
};
const NEW_PAGE_RC = newUnderHome('Page', { parenthistid: HOME_HIST_ID, ptype: 'Page', frontend: 'false' });
const NEW_PAGE: ViewCase = { rc: NEW_PAGE_RC, parentType: 'Page', crumbs: HOME_CRUMBS, baseTypeList: PAGE_LEVEL };
const NEW_COMPONENT: ViewCase = {
  rc: newInModule('Component', COMPONENT_MODULE_ID),
  parentType: 'Module',
  crumbs: COMPONENT_CRUMBS,
  filedUnder: COMPONENT_MODULE_ID,
  baseTypeList: 'Component',
};
const NEW_FORM: ViewCase = {
  rc: newInModule('Form', FORM_MODULE_ID, { formType: 'builder' }),
  parentType: 'Module',
  crumbs: FORM_CRUMBS,
  filedUnder: FORM_MODULE_ID,
  baseTypeList: 'Form',
};

/** Each capture and the request and model that reproduce it. */
const LEGACY_CASES: ReadonlyArray<readonly [capture: string, c: ViewCase]> = [
  ['admin-home', HOME_CASE],
  ['admin-homecompact', { ...HOME_CASE, rc: { ...HOME_RC, compactDisplay: 'true' } }],
  ['editor-home', { ...HOME_CASE, editor: true }],
  ['admin-newpage', NEW_PAGE],
  ['editor-newpage', { ...NEW_PAGE, editor: true }],
  ['admin-newpagecompact', { ...NEW_PAGE, rc: newUnderHome('Page', { compactDisplay: 'true' }) }],
  ['admin-bigui', { ...NEW_PAGE, rc: newUnderHome('Page', { bigui: 'schedule' }) }],
  ['admin-newlink', { ...NEW_PAGE, rc: newUnderHome('Link'), baseTypeList: 'Link' }],
  ['admin-newfile', { ...NEW_PAGE, rc: newUnderHome('File'), baseTypeList: 'File' }],
  // The served bean is still a Page when the view picks its page-level list, so a new Gallery takes no subtypes.
  ['admin-newgallery', { ...NEW_PAGE, rc: newUnderHome('Gallery'), baseTypeList: '' }],
  ['admin-newcomponent', NEW_COMPONENT],
  [
    'admin-newcomponentcompact',
    { ...NEW_COMPONENT, rc: newInModule('Component', COMPONENT_MODULE_ID, { compactDisplay: 'true' }) },
  ],
  // A verdict other than editor, which the capture shows by its missing change set and publish buttons.
  ['editor-newcomponent', { ...NEW_COMPONENT, editor: true, perm: 'read' }],
  ['admin-newformbuilder', NEW_FORM],
  ['admin-newformeditor', { ...NEW_FORM, rc: newInModule('Form', FORM_MODULE_ID, { formType: 'editor' }) }],
  [
    'admin-newvariation',
    {
      rc: newInModule('Variation', VARIATION_MODULE_ID),
      parentType: 'Module',
      crumbs: VARIATION_CRUMBS,
      filedUnder: VARIATION_MODULE_ID,
      baseTypeList: '',
    },
  ],
  [
    'admin-missingversionvariation',
    {
      rc: { ...HOME_RC, contenthistid: MISSING_HIST_ID, type: 'Variation' },
      parentType: 'Page',
      crumbs: HOME_CRUMBS,
      filedUnder: VARIATION_MODULE_ID,
      baseTypeList: '',
    },
  ],
];

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  vi.mocked(cfUuid).mockReset();
  restoreEnv();
});

/** The view of `c` rendered over `model`, with the request it leaves on the context. */
async function renderCase(
  c: ViewCase,
  model: CarchPageModel = modelOf(c),
): Promise<{ view: ShellView; req: AdminRequest }> {
  const { ctx } = contextOf(requestOf(c));
  const view = await renderEditView(ctx, model);
  return { view, req: ctx.req };
}

describe('carch.edit view', () => {
  it.each(LEGACY_CASES)('reproduces %s around the real panels', async (capture, c) => {
    // The request's defaulted `contentHistID` is a fresh CF UUID, which the panels print, so both sides share it.
    const { view, req } = await renderCase(c);
    expect(isSafeHtml(view.body)).toBe(true);
    const expected = await expectedBody(capture, panelInput(c, req, stateOf(c, req)));
    expect(toString(view.body)).toBe(expected.body);
    expect(view.htmlHead === undefined ? undefined : toString(view.htmlHead)).toBe(expected.htmlHead);
    expect(toString(view.ajax ?? raw(''))).toBe(toString(carchJs({ req }, 'edit')));
  });
});

/** `text` with each `[from, to]` pair applied; each `from` must occur exactly once. */
function replacedOnce(text: string, replacements: ReadonlyArray<readonly [string, string]>): string {
  let out = text;
  for (const [from, to] of replacements) {
    const at = out.indexOf(from);
    if (at < 0 || out.includes(from, at + 1)) throw new Error(`expected exactly one ${JSON.stringify(from)}`);
    out = out.slice(0, at) + to + out.slice(at + from.length);
  }
  return out;
}

/** How a branch's expected body departs from its capture. */
interface Variant {
  /** Edits of the capture that edit.cfm makes on the branch. */
  readonly replacements?: ReadonlyArray<readonly [string, string]>;
  /** Panel state members edit.cfm leaves differently on the branch. */
  readonly state?: Partial<EditFormState>;
  /** The case whose model the expected panels read, where the view's setters change the bean; `c` unless given. */
  readonly panels?: ViewCase;
  /** Whether the panels' own `bodyContent` replaces the captured body render content. */
  readonly ownBody?: boolean;
}

/** Renders `c` and expects `capture` around the real panels with the branch's edits; returns the render. */
async function expectVariant(capture: string, c: ViewCase, variant: Variant = {}) {
  const { view, req } = await renderCase(c);
  const input = panelInput(variant.panels ?? c, req, stateOf(c, req, variant.state));
  const expected = await expectedBody(capture, input, variant.ownBody);
  expect(toString(view.body)).toBe(replacedOnce(expected.body, variant.replacements ?? []));
  return { view, req };
}

/** The captured action buttons Home shows to an editor on a site with change sets. */
const CHANGESET_BUTTON =
  '<button type="button" class="btn" onclick="document.contentForm.approved.value=0;' +
  "saveToChangeset('','default','');return false;\">";
const PUBLISH_BUTTON =
  '\n\t\t\t\t<button type="button" class="btn mura-primary" onclick="document.contentForm.approved.value=1;' +
  "if(siteManager.ckContent(draftremovalnotice)){submitForm(document.contentForm,'add');}\">\n\t\t\t\t\t\n" +
  '\t\t\t\t\t\t<i class="mi-check"></i> Publish \n\t\t\t\t</button>\n\t\t\t';
const DEFAULT_APPROVAL_SCRIPT = '\n\n<script>\n\t\n\t\tvar pendingApproval=false;\n\t\n</script>\n\n';
/** Where the status container's notices go: after the status include, before the plugin message span. */
const MSG_SPAN = '\n\n\t\n\t<span id="msg">';
const CONTAINER_CLOSE = '\n\t</span>\n\n\t\t\n\n\t</div> \n\t';
const NO_DRAFT_REMOVAL = 'var draftremovalnotice="";';
const DRAFT_REMOVAL_NOTICE =
  String.raw`var draftremovalnotice='IMPORTANT\x3A\x20By\x20publishing\x20this\x20content\x20all\x20un\x2Dpublished` +
  String.raw`\x20drafts\x20will\x20be\x20removed.';`;

// Oracle: cArch.edit of Home with each raw value answered the compact page, its two hidden fields holding the scan.
describe('carch.edit view of a raw compactDisplay', () => {
  const hidden = (name: string, value: string): string => `<input type="hidden" name="${name}" value="${value}" />`;

  it.each([
    [' TRUE', 'TRUE'],
    ['TRUE\u0001', 'TRUE'],
    ['tr\u0000ue', 'true'],
    ['\u0001yes', 'yes'],
    [' 1.0 ', '1.0'],
  ])('reproduces admin-homecompact for %j, echoing %j', async (value, scanned) => {
    await expectVariant('admin-homecompact', { ...HOME_CASE, rc: { ...HOME_RC, compactDisplay: value } }, {
      replacements: [
        [hidden('closeCompactDisplay', 'true'), hidden('closeCompactDisplay', scanned)],
        [hidden('compactDisplay', 'true'), hidden('compactDisplay', scanned)],
      ],
    });
  });

  it.each([' true', '\u000btrue', ' false', '  '])('fails on %j, where legacy answers 500', async (value) => {
    await expect(renderCase({ ...HOME_CASE, rc: { ...HOME_RC, compactDisplay: value } })).rejects.toThrow(TypeError);
  });
});


describe('carch.edit view branches', () => {
  it('offers the draft removal notice when publishing purges drafts the node has', async () => {
    await expectVariant(
      'admin-home',
      { ...HOME_CASE, model: { hasDrafts: 1 } },
      { replacements: [[NO_DRAFT_REMOVAL, DRAFT_REMOVAL_NOTICE]] },
    );
  });

  it.each([
    ['the request suppresses it', { suppressDraftNotice: 'true' }, { hasDrafts: 1 }],
    ['drafts are kept', {}, { hasDrafts: 1, purgeDrafts: 0 }],
  ])('leaves the draft removal notice empty when %s', async (_label, rc, model) => {
    await expectVariant('admin-home', { ...HOME_CASE, rc: { ...HOME_RC, ...rc }, model });
  });

  it('flags a node lock the version holds', async () => {
    const bean = { stats: { lockID: 'U-2', lockType: 'node' } };
    await expectVariant('admin-home', { ...HOME_CASE, bean }, {
      replacements: [['siteManager.hasNodeLock=false;', 'siteManager.hasNodeLock=true;']],
    });
  });

  it('shows who holds the lock on a site with lockable nodes', async () => {
    const stats = { lockID: 'U-2', lockType: 'node' };
    const lockedBy = { fname: 'Ada', lname: 'Lovelace', email: 'ada@example.com' };
    const c: ViewCase = { ...HOME_CASE, bean: { stats }, model: { hasLockableNodes: 1, lockedBy } };
    const { view, req } = await renderCase(c);
    const lockNotice = await status(contextOf(req).ctx, {
      hasLockableNodes: true,
      stats,
      lockedBy,
      content: {
        contentId: HOME,
        siteId: SITE,
        contentHistId: HOME_HIST_ID,
        approvalStatus: '',
        display: 1,
        displayIntervalDesc: '',
        conflicts: [],
      },
      showApprovalStatus: false,
      parentType: 'Page',
    });
    expect(toString(view.body)).toContain('siteManager.hasNodeLock=true;');
    expect(toString(view.body)).toContain(`<div id="dspStatusContainer">\n\n\t${toString(lockNotice)}`);
  });

  const CANCEL_PENDING =
    String.raw`'The\x20content\x20version\x20that\x20you\x20just\x20edited\x20has\x20previously\x20been\x20sent` +
    String.raw`\x20for\x20approval.\x20Would\x20you\x20like\x20to\x20cancel\x20the\x20pending` +
    String.raw`\x20approval\x20request\x3F'`;

  it.each([
    [
      'a pending request',
      { isNew: 0, status: 'Pending' },
      '\n\n<script>\n\t\n\t\t\tvar pendingApproval=true;\n\t\t\t' +
        `var cancelPendingApproval=${CANCEL_PENDING};\n\t\t\n</script>\n\n`,
    ],
    ['no request', { isNew: 1, status: '' }, '\n\n<script>\n\t\n\t\t\tvar pendingApproval=false;\n\t\t\n</script>\n\n'],
  ])('sends a version that requires approval for it, with %s', async (_label, approvalRequest, script) => {
    // Publishing waits on the approval, so it removes no drafts yet.
    const model = { requiresApproval: 1, approvalRequest, hasDrafts: 1 };
    await expectVariant('admin-home', { ...HOME_CASE, model }, {
      state: { requiresApproval: true },
      replacements: [
        [DEFAULT_APPROVAL_SCRIPT, script],
        [
          '<i class="mi-list-alt"></i> Save to Change Set \n',
          '<i class="mi-list-alt"></i> Save to Change Set &amp; Send for Approval \n',
        ],
        ['<i class="mi-check"></i> Publish \n', '<i class="mi-share-alt"></i> Send for Approval \n'],
      ],
    });
  });

  it('reads the approval request where only the approval status shows', async () => {
    const model = { showApprovalStatus: 1, approvalRequest: { isNew: 0, status: 'Approved' } };
    const { view } = await renderCase({ ...HOME_CASE, model });
    expect(toString(view.body)).toContain('\n\n<script>\n\t\n\t\t\tvar pendingApproval=false;\n\t\t\n</script>\n\n');
    expect(toString(view.body)).toContain('<i class="mi-check"></i> Publish \n');
  });

  it('marks the change set the version and node belong to', async () => {
    const model = {
      currentChangeset: { isNew: 0, name: 'Launch <1>' },
      pendingChangesets: [{ contentHistID: 'H-1', changesetName: 'Spring & Summer' }],
    };
    const c: ViewCase = { ...HOME_CASE, model, bean: { changesetID: 'CS-1' } };
    const { ctx } = contextOf(requestOf(c));
    const capturedDialog = renderChangesetsDialog(ctx, {
      currentChangesetIsNew: true,
      approved: true,
      changesetId: '',
    });
    const dialog = renderChangesetsDialog(ctx, { currentChangesetIsNew: false, approved: true, changesetId: 'CS-1' });
    const link =
      `?muraAction=cArch.edit&moduleID=${CONTENT_MODULE_ID}&siteID=${SITE}&topID=${HOME}&contentID=${HOME}&return=` +
      `&contentHistID=H-1&parentID=${END_ID}&startrow=1&type=Page&compactDisplay=false`;
    const notice =
      '\n\t\t<div class="alert alert-info">\n\t\t\t<span>\n\t\t\t\t' +
      '<strong>This node has been assigned to the following Change Set(s)</strong>:<br>\n' +
      `\t\t\t\t<ul class="alert-list">\n\t\t\t\t<li><a href="${link}">Spring &amp; Summer</a></li>\n\t\t\t\t</ul>\n` +
      '\t\t\t\t<strong>This specific version has been assigned to the Change Set</strong>: ' +
      '<strong>Launch &lt;1&gt;</strong>' +
      '\n\t\t\t</span>\n\t\t</div>\n\t';
    await expectVariant('admin-home', c, {
      replacements: [
        [
          CHANGESET_BUTTON,
          CHANGESET_BUTTON.replace('class="btn"', 'class="btn mura-primary"').replace("('',", "('CS-1',"),
        ],
        [PUBLISH_BUTTON, PUBLISH_BUTTON.replace('class="btn mura-primary"', 'class="btn"')],
        [MSG_SPAN, notice + MSG_SPAN],
        [toString(capturedDialog), toString(dialog)],
      ],
    });
  });

  it.each([
    ['primary', '', PUBLISH_BUTTON],
    // `len(changesetID)` still counts on a site without change sets.
    [
      'secondary for a version in a change set',
      'CS-1',
      PUBLISH_BUTTON.replace('class="btn mura-primary"', 'class="btn"'),
    ],
  ])('keeps publishing %s on a site without change sets, offering none', async (_label, changesetID, publish) => {
    const c: ViewCase = { ...HOME_CASE, bean: { changesetID } };
    const base = requestOf(c);
    if (base.site === undefined) throw new Error('no session site');
    const { ctx } = contextOf({ ...base, site: { ...base.site, hasChangesets: false } });
    const body = toString((await renderEditView(ctx, modelOf(c))).body);
    expect(body).toContain(publish);
    expect(body).not.toContain('saveToChangeset(');
    expect(body).not.toContain('id="changesetContainer"');
    expect(body).not.toContain('<ul class="alert-list">');
  });

  it('hides Publish where the site enforces change sets', async () => {
    await expectVariant('admin-home', { ...HOME_CASE, model: { enforceChangesets: 1 } }, {
      replacements: [[PUBLISH_BUTTON, '']],
    });
  });

  it('shows the version notes, encoded', async () => {
    await expectVariant('admin-home', { ...HOME_CASE, bean: { notes: 'Check <b>' } }, {
      replacements: [
        [
          MSG_SPAN,
          '\n\t\t<div class="alert alert-info">\n\t\t\t<span>Notes: Check &lt;b&gt;</span>\n\t\t</div>\n\t' + MSG_SPAN,
        ],
      ],
    });
  });

  it('lists the validation errors of a bean the update action re-renders', async () => {
    const errors = { title: 'The Title is required.', siteid: 'ignored', body: 'Body <b>' };
    const c: ViewCase = { ...HOME_CASE, item: 'update', bean: { errors } };
    const { view, req } = await expectVariant('admin-home', c, {
      replacements: [
        [
          CONTAINER_CLOSE,
          '\n\t</span>\n\n\t\t\n\t\t\t<div class="alert alert-error">' +
            '<span>The Title is required. <br> Body <b> </span></div>' +
            '\n\t\t\n\n\t</div> \n\t',
        ],
      ],
    });
    expect(req.rc.muraAction).toBe('core:carch.update');
    expect(toString(view.ajax ?? raw(''))).toBe(toString(carchJs({ req }, 'update')));
  });

  const DRAFT_TARGET =
    `/admin/?muraAction=cArch.edit&contenthistid=${HOME_HIST_ID}&contentid=${HOME}&type=Page&parentid=${END_ID}` +
    `&topid=${HOME}&siteid=${SITE}&moduleid=${CONTENT_MODULE_ID}`;
  const draftAlert = (query: string): string =>
    '\n\t\t\t<div class="alert alert-info">\n\t\t\t\t<span>This content has a draft newer than the current published ' +
    `version: <strong><a href="./?${query}">Go to Latest Draft</a></strong></span>\n\t\t\t</div>\n\t\t`;

  it.each([
    ['the forwarded request target', { headers: { 'X-Opt2-Original-Url': DRAFT_TARGET } }, DRAFT_TARGET.slice(8)],
    // Without the gateway's header, the URL scope the request carries stands in.
    ['the URL scope', {}, 'muraAction=cArch.edit'],
  ])('links a newer draft through the query of %s', async (_label, extra, query) => {
    const model = { draftcheck: { showdialog: 'true', historyid: 'H-2' } };
    await expectVariant('admin-home', { ...HOME_CASE, model, ...extra }, {
      replacements: [[MSG_SPAN, draftAlert(query.replace(HOME_HIST_ID, 'H-2')) + MSG_SPAN]],
    });
  });

  it.each([
    ['the dialog is off', { showdialog: 'false', historyid: 'H-2' }],
    ['the draft is this version', { showdialog: 'true', historyid: HOME_HIST_ID }],
    ['no draft exists', { showdialog: 'true', historyid: '' }],
  ])('offers no draft when %s', async (_label, draftcheck) => {
    await expectVariant('admin-home', { ...HOME_CASE, model: { draftcheck } });
  });

  it('shows the extended attributes in the default panel where the site says so', async () => {
    const extensions =
      '\n\t\t\t\t\t<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-basic">' +
      '\n\t\t\t\t\t\t<div id="bigui__basic" data-label="Manage Extended Attributes">' +
      '\n\t\t\t\t\t\t\t<div class="bigui__controls">' +
      '\n\t\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributestop"></span>' +
      '\n\t\t\t\t\t\t\t\t<span id="extendset-container-basic" class="extendset-container extendedattributes-body"' +
      ' data-controlparent="extendedattributes-container-basic"></span>' +
      '\n\t\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributesbottom"></span>' +
      '\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\n\t\t\t\t\t</div>\n\t\t\t\t';
    await expectVariant('admin-home', { ...HOME_CASE, model: { showExtensionsInDefault: 'true' } }, {
      ownBody: true,
      replacements: [
        ['<div id="mura-editbox-none">', '<div id="mura-editbox">'],
        [
          BODY_RENDER_CLOSE,
          `</div>\n\t\t\t\t${extensions}\n\t\t\t</div>\n\n\n\t\t\t<div class="load-inline tab-preloader">`,
        ],
      ],
    });
  });

  it("prints the panels' saved body content in the body render area", async () => {
    const bean = { body: '<p>Welcome &amp; hello</p>' };
    await expectVariant('admin-home', { ...HOME_CASE, bean }, { ownBody: true });
  });

  it("applies a new node's requested title, remote id and subtype before the panels read it", async () => {
    const rc = { ...NEW_PAGE_RC, title: '  Spring News  ', remoteid: ' R-1 ', subtype: ' Article ' };
    const panels: ViewCase = { ...NEW_PAGE, bean: { title: 'Spring News', remoteID: 'R-1', subType: 'Article' } };
    await expectVariant('admin-newpage', { ...NEW_PAGE, rc }, {
      panels,
      replacements: [
        // ESAPI's attribute encoder encodes the space.
        ['data-placeholder="Page Title"></div>', 'data-placeholder="Page Title">Spring&#x20;News</div>'],
        [`'Page','Default','default'`, `'Page','Article','default'`],
        ['name="subtype" value="Default"', 'name="subtype" value="Article"'],
      ],
    });
  });

  it("defaults a stored node's missing parent id from the version", async () => {
    const { req } = await expectVariant('admin-home', { ...HOME_CASE, rc: { ...HOME_RC, parentid: '' } });
    expect(req.rc.parentid).toBe(END_ID);
  });

  it('shows the page limit notice instead of the editor for a new node on a full site', async () => {
    const c: ViewCase = { ...NEW_PAGE, model: { rsPageCount: [{ counter: 50000 }] } };
    const { ctx, gateway } = contextOf(requestOf(c));
    const view = await renderEditView(ctx, modelOf(c));
    const captured = CAPTURES['admin-newpage'] ?? '';
    const full =
      '\n\t<div>\n\t\t\n<div class="mura-header">\n<h1>Edit Content</h1>\n</div>\n<div class="alert alert-error">\n' +
      "This site has reached it's maximum number of pages allowed. If you are a Super Admin, this can be changed " +
      'in Site Settings.</div> \n\n\t</div>\n';
    expect(toString(view.body)).toBe(captured.slice(0, captured.indexOf('\n\t\n\t<div class="mura-header">')) + full);
    expect(view.htmlHead).toBeUndefined();
    expect(gateway.calls).toEqual([]);
  });

  it('edits a stored node on a full site', async () => {
    await expectVariant('admin-home', { ...HOME_CASE, model: { rsPageCount: [{ counter: 50000 }] } });
  });

  it.each([
    ['honours the forwarded formType, whatever its case', true, 'admin-newformeditor', []],
    ['ignores a posted formType', false, 'admin-newformbuilder', [[BUILDER_FIELD, '']]],
  ] as const)('%s', async (_label, forwarded, capture, replacements) => {
    const rc = newInModule('Form', FORM_MODULE_ID, { formType: 'editor' });
    const query = new URLSearchParams(forwarded ? { ...rc, FORMTYPE: 'editor' } : rc);
    query.delete('formType');
    const c: ViewCase = {
      ...NEW_FORM,
      rc,
      headers: { 'X-Opt2-Original-Url': `/admin/?muraAction=cArch.edit&${query.toString()}` },
      formScope: forwarded ? {} : { formType: 'editor' },
    };
    await expectVariant(capture, c, { replacements });
  });

  it('ignores the formType a re-rendered update posted without the gateway header', async () => {
    const rc = newInModule('Form', FORM_MODULE_ID, { formType: 'editor' });
    const c: ViewCase = { ...NEW_FORM, rc, item: 'update', formScope: { formType: 'editor' } };
    await expectVariant('admin-newformbuilder', c, { replacements: [[BUILDER_FIELD, '']] });
  });

  const STORED_ID = 'C1000000-0000-0000-0000000000000001';
  const STORED_HIST_ID = 'C2000000-0000-0000-0000000000000001';
  const GLOBAL_NOTICE =
    '\n\t</span>\n\n\t\t\n\t\t\t<div class="alert alert-info">\n\t\t\t\t<span>IMPORTANT: Edits will be globally ' +
    'reflected on all pages that use this item.</span>\n\t\t\t</div>\n\t\t\n\n\t</div> \n\t';

  it.each([
    {
      type: 'Component',
      moduleId: COMPONENT_MODULE_ID,
      crumbs: COMPONENT_CRUMBS,
      heading: 'Edit Component',
      warns: true,
    },
    {
      type: 'Variation',
      moduleId: VARIATION_MODULE_ID,
      crumbs: VARIATION_CRUMBS,
      heading: 'Edit Remote Variation',
      warns: false,
    },
  ])('warns on compact edits of a stored $type that they apply everywhere: $warns', async (row) => {
    const { type, moduleId, crumbs, heading, warns } = row;
    const rc = {
      ...newInModule(type, moduleId, { compactDisplay: 'true' }),
      contentid: STORED_ID,
      contenthistid: STORED_HIST_ID,
    };
    const bean = {
      contentID: STORED_ID,
      contentHistID: STORED_HIST_ID,
      parentID: moduleId,
      moduleID: moduleId,
      type,
      title: 'Footer',
      menuTitle: 'Footer',
    };
    const { view } = await renderCase({ rc, home: true, parentType: 'Module', crumbs, baseTypeList: '', bean });
    const body = toString(view.body);
    expect(body).toContain(`<h1>${heading}</h1>`);
    expect(body).toContain(warns ? GLOBAL_NOTICE : CONTAINER_CLOSE);
    expect(body.includes(GLOBAL_NOTICE)).toBe(warns);
  });

  const SUBTYPES = [
    { type: 'Page', subtype: 'Article', adminonly: 0 },
    { type: 'Base', subtype: 'Default', adminonly: 0 },
    { type: 'Component', subtype: 'Promo', adminonly: 1 },
    { type: 'Folder', subtype: 'Blog', adminonly: 0 },
    { type: 'Gallery', subtype: 'Photos', adminonly: 0 },
    { type: 'page', subtype: 'Article', adminonly: 0 },
  ];
  const subTypesOf = (...indexes: number[]): SubTypeRow[] => indexes.map((i) => SUBTYPES[i] as SubTypeRow);

  it.each([
    // Query of queries compares with case, and a Page bean's extended list leaves out Gallery.
    ['every extendable subtype without a parent filter', NEW_PAGE, '', subTypesOf(0, 1, 2, 3)],
    ['the parent filter for a node-level type', NEW_PAGE, 'Page/Article,Folder/Blog', subTypesOf(0, 3)],
    [
      'every extendable subtype for a module type, whatever the filter',
      NEW_COMPONENT,
      'Page/Article',
      subTypesOf(0, 1, 2, 3),
    ],
  ] as const)('offers %s', async (_label, base, subtypeFilter, subTypes) => {
    const c: ViewCase = { ...base, model: { subtypeFilter, rsSubTypes: SUBTYPES } };
    const capture = base === NEW_PAGE ? 'admin-newpage' : 'admin-newcomponent';
    await expectVariant(capture, c, { state: { subtypeFilter, subTypes, isExtended: true }, ownBody: true });
  });

  it('fails as the query of queries does on a parent filter that repeats its first subtype', async () => {
    const model = { subtypeFilter: 'Page/Article,page/article', rsSubTypes: SUBTYPES };
    await expect(renderCase({ ...NEW_PAGE, model })).rejects.toThrow(
      "Query Of Queries syntax error: the subtype filter 'Page/Article,page/article' leaves the WHERE clause malformed",
    );
  });

  const INTERVAL_DESC = 'Daily, all day';
  const CONFLICT_DETAILS = [{ href: './?d=1', displayStart: '11/13/2026' }];
  const CONFLICTS = [{ editURL: './?muraAction=cArch.edit&contentid=E1', title: 'Clash', details: CONFLICT_DETAILS }];

  it('passes a Calendar child its interval and conflicts for the status notices', async () => {
    const c: ViewCase = {
      ...NEW_PAGE,
      parentType: 'Calendar',
      bean: { display: 2, displayIntervalDesc: INTERVAL_DESC, displayConflicts: CONFLICTS },
    };
    const { view, req } = await renderCase(c);
    const notices = await status(contextOf(req).ctx, {
      hasLockableNodes: false,
      stats: { lockID: '', lockType: '' },
      content: {
        contentId: NEW_ID,
        siteId: SITE,
        contentHistId: NEW_HIST_ID,
        approvalStatus: '',
        display: 2,
        displayIntervalDesc: INTERVAL_DESC,
        conflicts: [
          { editUrl: './?muraAction=cArch.edit&contentid=E1', title: 'Clash', details: CONFLICT_DETAILS },
        ],
      },
      showApprovalStatus: false,
      parentType: 'Calendar',
    });
    expect(toString(view.body)).toContain(`<div id="dspStatusContainer">\n\n\t${toString(notices)}`);
  });

  it.each([
    ['displayIntervalDesc', { display: 2, displayConflicts: [] }],
    ['displayConflicts', { display: 1 }],
  ])('fails when a Calendar child lacks contentBean.%s', async (key, bean) => {
    await expect(renderCase({ ...NEW_PAGE, parentType: 'Calendar', bean })).rejects.toThrow(
      `strategies-content getContentEditModel returned no contentBean.${key}`,
    );
  });

  it.each([
    'purgeDrafts',
    'hasDrafts',
    'confirmSaveAsDraft',
    'hasSummary',
    'hasBody',
    'enforceChangesets',
    'rsPageCount',
    'pageLimit',
    'tabAssignments',
    'subtypeFilter',
    'requiresApproval',
    'showApprovalStatus',
    'hasLockableNodes',
    'parentBean',
    'currentChangeset',
    'pendingChangesets',
    'draftcheck',
  ])('fails as CFML does when the edit model lacks rc.%s', async (key) => {
    const rc = Object.fromEntries(Object.entries(modelOf(HOME_CASE).rc).filter(([name]) => name !== key));
    await expect(renderCase(HOME_CASE, { rc })).rejects.toThrow(
      `strategies-content getContentEditModel returned no rc.${key}`,
    );
  });

  it('fails when the edit model lacks contentBean.isNew', async () => {
    const served = Object.entries(servedBean(true, 'Page'));
    const contentBean = Object.fromEntries(served.filter(([name]) => name !== 'isNew'));
    await expect(renderCase(HOME_CASE, { rc: { ...modelOf(HOME_CASE).rc, contentBean } })).rejects.toThrow(
      'strategies-content getContentEditModel returned no contentBean.isNew',
    );
  });

  it('fails without the session site programs-sites serves', async () => {
    const req = { ...requestOf(HOME_CASE), site: undefined } as AdminRequest;
    await expect(renderEditView(contextOf(req).ctx, modelOf(HOME_CASE))).rejects.toThrow(
      'programs-sites served no site default for carch.edit',
    );
  });
});

describe('url.formType', () => {
  it.each([
    ['joins repeated names as the URL scope does', '/admin/?formType=builder&FormType=editor', {}, 'builder,editor'],
    ['is undefined for a target without a query', '/admin/', { formType: 'editor' }, undefined],
    ['keeps an empty value', '/admin/?muraAction=cArch.edit&formtype=', {}, ''],
    ['trims a padded value as the start-up scan does', '/admin/?formType=%20editor%20', {}, 'editor'],
    ['filters markup as the start-up scan does', '/admin/?formType=%3Cscript%3Ex%3C%2Fscript%3E', {}, '[INVALID]'],
    ['is the request value without the header, unless posted', null, {}, 'editor'],
    ['is undefined without the header for a posted value', null, { formType: 'editor' }, undefined],
  ])('%s', (_label, target, formScope, expected) => {
    const headers = new Headers(target === null ? {} : { 'X-Opt2-Original-Url': target });
    expect(urlFormType({ headers, formScope, rc: { formType: 'editor' } })).toBe(expected);
  });
});

/** The redirect step, then load and render when it does not redirect, as the page handler runs them. */
async function run(ctx: ScreenContext): Promise<{ redirect?: PageControllerRedirect; view?: ShellView }> {
  const redirect = await editScreen.redirect?.(ctx);
  if (redirect !== undefined) return { redirect };
  if (editScreen.load === undefined) throw new Error('carch.edit has no load step');
  return { view: await editScreen.render(ctx, await editScreen.load(ctx)) };
}

/** The S2 admin's request for the URL scope `rc`, before carch's defaults, which the redirect step applies. */
const rawRequest = (rc: Readonly<Record<string, string>>): AdminRequest =>
  adminS2Request({
    circuit: 'cArch',
    item: 'edit',
    site: { hasChangesets: true, record: { theme: 'default' } },
    rc,
    formScope: {},
  });

describe('carch.edit controller step', () => {
  it('reads the version through strategies-content and renders the captured Home', async () => {
    const { ctx, gateway } = contextOf(rawRequest(HOME_RC), {
      contentId: HOME,
      reply: { status: 200, body: modelOf(HOME_CASE) },
    });
    const { redirect, view } = await run(ctx);
    expect(redirect).toBeUndefined();
    const reads = gateway.calls.filter((call) => call.service === 'strategies-content');
    expect(reads).toEqual([
      {
        service: 'strategies-content',
        method: 'GET',
        path: `/v1/sites/${SITE}/content/${HOME}`,
        query: {
          contenthistid: HOME_HIST_ID,
          parentid: END_ID,
          type: 'Page',
          moduleid: CONTENT_MODULE_ID,
          compactDisplay: 'false',
        },
      },
    ]);
    const req = requestOf(HOME_CASE);
    const expected = await expectedBody('admin-home', panelInput(HOME_CASE, req, stateOf(HOME_CASE, req)));
    expect(toString(view?.body ?? raw(''))).toBe(expected.body);
    expect(editScreen).toMatchObject({ circuit: 'carch', action: 'edit', owner: 'strategies-content', mode: 'page' });
    expect(editScreen.secondaryMenu).toBe('carch');
  });

  it('reads a new node under a fresh CF UUID, as getContentID() mints one', async () => {
    vi.mocked(cfUuid).mockReturnValue(MINTED_ID);
    const { ctx, gateway } = contextOf(rawRequest(NEW_PAGE_RC), {
      contentId: MINTED_ID,
      reply: { status: 200, body: modelOf(NEW_PAGE) },
    });
    const { redirect, view } = await run(ctx);
    expect(redirect).toBeUndefined();
    expect(gateway.calls.filter((call) => call.service === 'strategies-content')).toEqual([
      {
        service: 'strategies-content',
        method: 'GET',
        path: `/v1/sites/${SITE}/content/${MINTED_ID}`,
        query: {
          contenthistid: MINTED_ID,
          parentid: HOME,
          type: 'Page',
          moduleid: CONTENT_MODULE_ID,
          compactDisplay: 'false',
        },
      },
    ]);
    // The view keeps the request's empty id, so the default case of the menu stays empty.
    expect(ctx.req.rc.contentid).toBe('');
    expect(toString(view?.body ?? raw(''))).toContain('<div class="nav-module-specific btn-group">\n\t\n</div>\n');
  });

  // Captured: the legacy server answered 302 with this location for a stored node's missing version.
  const MISSING_LOCATION =
    `./?muraAction=cArch.hist&contentid=${HOME}&siteid=${SITE}&startrow=1&moduleid=${CONTENT_MODULE_ID}` +
    `&parentid=${END_ID}&type=Page`;

  it('redirects a stored node whose version does not exist to its history, as the legacy server does', async () => {
    const rc = { ...HOME_RC, contenthistid: MISSING_HIST_ID, startrow: '1' };
    const { ctx } = contextOf(rawRequest(rc), {
      contentId: HOME,
      reply: { status: 200, body: modelOf({ ...HOME_CASE, home: false }) },
    });
    const { redirect } = await run(ctx);
    expect(redirect).toEqual({
      kind: 'redirect',
      action: 'cArch.hist',
      append: 'contentid,siteid,startrow,moduleid,parentid,type',
      path: './',
    });
    if (redirect?.kind !== 'redirect') throw new Error('no FW/1 redirect');
    const append = (redirect.append ?? '').split(',').map((name) => [name, ctx.req.rc[name] ?? ''] as const);
    expect(fw1RedirectTarget({ action: redirect.action, append, path: redirect.path })).toBe(MISSING_LOCATION);
  });

  it.each([
    ['a Variation', { type: 'Variation' }],
    ['an object instance', { instanceid: 'I1' }],
  ])('renders the missing version of %s instead of redirecting', async (_label, extra) => {
    const rc = { ...HOME_RC, contenthistid: MISSING_HIST_ID, ...extra };
    // The menu links a Page version on Home to its preview.
    const bean = { previewURL: `http://localhost:8080/?previewid=${NEW_HIST_ID}` };
    const { ctx } = contextOf(rawRequest(rc), {
      contentId: HOME,
      reply: { status: 200, body: modelOf({ ...HOME_CASE, home: false, bean }) },
    });
    const { redirect, view } = await run(ctx);
    expect(redirect).toBeUndefined();
    expect(view).toBeDefined();
  });

  it('answers a strategies-content denial with the controller secure() redirect', async () => {
    const { ctx } = contextOf(rawRequest(HOME_RC), { contentId: HOME, reply: { status: 403, body: {} } });
    const { redirect } = await run(ctx);
    // secure() sends a logged-in user without a referer back to the admin root.
    expect(redirect).toEqual({ kind: 'location', location: './' });
  });

  it('fails as legacy does when strategies-content rejects the read', async () => {
    const { ctx } = contextOf(rawRequest(HOME_RC), { contentId: HOME, reply: { status: 404, body: {} } });
    await expect(run(ctx)).rejects.toThrow('strategies-content getContentEditModel rejected carch.edit with HTTP 404');
  });

  it('refuses to load before its controller step', async () => {
    const { ctx } = contextOf(rawRequest(HOME_RC));
    await expect(editScreen.load?.(ctx)).rejects.toThrow('carch.edit loaded before its controller step ran');
  });
});

// ---- The page in the shell over the recorded strategies-content edit models ----

const TENANT = 'tenant-a';
const LOCK_HOLDER = Object.freeze({ fname: 'Quinn', lname: 'Editor', email: 'quinn@example.com' });

type ScreenCtx = ScreenContext & { gateway: FakeGatewayClient };

/** `fixture` deep-copied, with `rc` members and then `rc.contentBean` members replaced. */
function editModel(fixture: CarchPageModel, rc: Struct = {}, bean: Struct = {}): CarchPageModel {
  const copy = structuredClone(fixture);
  return { ...copy, rc: { ...copy.rc, ...rc, contentBean: { ...structOf(copy.rc, 'contentBean'), ...bean } } };
}

/** The URL scope the Site Manager opens `model`'s version with; a new node's `contentid` is empty. */
function editRc(model: CarchPageModel, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const bean = structOf(model.rc, 'contentBean');
  return {
    contentid: structText(bean, 'isNew') === '1' ? '' : structText(bean, 'contentID'),
    contenthistid: structText(bean, 'contentHistID'),
    parentid: structText(bean, 'parentID') || ROOT_CONTENT_ID,
    type: structText(bean, 'type'),
    moduleid: structText(bean, 'moduleID'),
    siteid: TENANT,
    ...extra,
  };
}

/** The tenant-a site admin opening `model`; `site` members replace the served site's. */
const tenantRequest = (
  model: CarchPageModel,
  extra: Readonly<Record<string, string>> = {},
  site: AdminRequestPartial['site'] = {},
): AdminRequest => siteAdminRequest(TENANT, { circuit: 'cArch', item: 'edit', rc: editRc(model, extra), site });

/** The screen context of `req` over a gateway serving `model` at the request's content (the bean's id when new). */
function modelContext(model: CarchPageModel, req: AdminRequest): ScreenCtx {
  const contentId = structText(structOf(model.rc, 'contentBean'), 'contentID');
  const path: `/v1/${string}` = `/v1/sites/${req.rc.siteid ?? ''}/content/${contentId}`;
  if (req.rc.contentid === '') vi.mocked(cfUuid).mockReturnValue(contentId);
  const gateway = fakeGatewayClient({ [routeKey('GET', 'strategies-content', path)]: { status: 200, body: model } });
  return makeScreenContext({ req, gateway });
}

/** cArch.edit of `model` in the legacy shell, parsed, with the context it ran in. */
async function editPage(
  model: CarchPageModel,
  req: AdminRequest,
): Promise<{ $: cheerio.CheerioAPI; html: string; ctx: ScreenCtx }> {
  const ctx = modelContext(model, req);
  const page = await renderScreenPage(editScreen, ctx);
  if (page.kind !== 'document') throw new Error(`carch.edit redirected to ${page.location}`);
  return { $: cheerio.load(page.html), html: page.html, ctx };
}

/** The parity model of the first element `selector` matches. */
function sectionModel($: cheerio.CheerioAPI, selector: string) {
  const section = $(selector).first();
  if (section.length === 0) throw new Error(`no ${selector}`);
  return fragmentModel($.html(section));
}

/** The settings panels' heading ids in document order. */
const panelIds = ($: cheerio.CheerioAPI): string[] =>
  $('#content-panels > .mura-panel > .mura-panel-heading')
    .toArray()
    .map((el) => $(el).attr('id') ?? '');

/** `siteManager.tablist` as the closing script sets it. */
function tablistOf(html: string): string {
  const match = /siteManager\.tablist='([^']*)'/.exec(html);
  if (match?.[1] === undefined) throw new Error('no siteManager.tablist');
  return match[1];
}

/** `[name, type, value]` of each control named in `names`, in document order. */
const controlsNamed = (model: ReturnType<typeof fragmentModel>, ...names: string[]) =>
  model.controls.filter((c) => names.includes(c.name)).map((c) => [c.name, c.type, c.value] as const);

/** The contexts identity was asked to issue CSRF tokens for. */
const csrfContexts = (gateway: FakeGatewayClient): string[] =>
  gateway.calls
    .filter((call) => call.service === 'identity' && call.path === '/v1/csrf/tokens')
    .flatMap((call) => (call.json as { readonly contexts: readonly string[] }).contexts);

const NEW_HIST_ID_OF_FIXTURE = structText(structOf(carchEditNewPage.rc, 'contentBean'), 'contentHistID');

describe('carch.edit page of a new Page', () => {
  it('reads the new node and signs #contentForm for <contentHistID>add', async () => {
    const ctx = modelContext(editModel(carchEditNewPage), tenantRequest(carchEditNewPage));
    const page = await renderScreenModel(editScreen, ctx);
    expect(page.headings).toContain(ctx.rb.rbKey('sitemanager.content.createcontent'));
    expect(page.controls.filter((c) => c.name.startsWith('csrf_token')).map((c) => [c.name, c.type, c.value])).toEqual([
      [CSRF_FIELD_TOKEN, 'hidden', '<token>'],
      [CSRF_FIELD_EXPIRES, 'hidden', '<token>'],
    ]);
    expect(ctx.gateway.calls.find((call) => call.service === 'strategies-content')?.path).toBe(CARCH_PATHS.editNewPage);
    expect(csrfContexts(ctx.gateway)).toContain(`${NEW_HIST_ID_OF_FIXTURE}add`);
    // The same fields close #contentForm.
    const { $ } = await editPage(editModel(carchEditNewPage), tenantRequest(carchEditNewPage));
    expect($('form#contentForm[name="contentForm"]')).toHaveLength(1);
    expect(controlsNamed(sectionModel($, '#contentForm'), CSRF_FIELD_TOKEN, CSRF_FIELD_EXPIRES)).toEqual([
      [CSRF_FIELD_TOKEN, 'hidden', FIXED_CSRF.token],
      [CSRF_FIELD_EXPIRES, 'hidden', FIXED_CSRF.expires],
    ]);
  });

  it('offers the page-level types, resetting the extended attributes on change', async () => {
    const { $, html } = await editPage(editModel(carchEditNewPage), tenantRequest(carchEditNewPage));
    const [selector] = sectionModel($, '#contentForm').controls.filter((c) => c.name === 'typeSelector');
    expect(selector?.type).toBe('select-one');
    expect(selector?.options.map((o) => o.value)).toEqual(['Page^Default', 'Folder^Default', 'Calendar^Default']);
    expect(html).toContain('<select name="typeSelector" onchange="siteManager.resetExtendedAttributes(');
  });

  it('prints the Basic panel body in the CKEditor render area', async () => {
    const { $ } = await editPage(editModel(carchEditNewPage), tenantRequest(carchEditNewPage));
    expect($('#mura-content-body-render > #bodyContainer > textarea#body[name="body"]')).toHaveLength(1);
    expect(controlsNamed(sectionModel($, '#mura-content-body-render'), 'body')).toEqual([
      ['body', 'textarea', '<p></p>'],
    ]);
  });

  it('schedules the display with the display select and both datetime selectors', async () => {
    const { $ } = await editPage(editModel(carchEditNewPage), tenantRequest(carchEditNewPage));
    const panel = sectionModel($, '#panel-schedule');
    const [display] = panel.controls.filter((c) => c.name === 'display');
    expect($('#panel-schedule select#mura-display')).toHaveLength(1);
    expect(display?.options.map((o) => [o.value, o.selected])).toEqual([
      ['1', true],
      ['0', false],
      ['2', false],
    ]);
    expect(controlsNamed(panel, 'displayStart', 'displayStop')).toEqual([
      ['displayStart', 'hidden', ''],
      ['displayStop', 'hidden', ''],
    ]);
  });

  it('publishes with the feature select, the restrict groups and the expiry selector', async () => {
    const groups = [
      { userid: APPROVAL_GROUP_IDS.contentEditors, groupname: 'Content Editors', isPublic: 0 },
      { userid: APPROVAL_GROUP_IDS.marketing, groupname: 'Marketing', isPublic: 1 },
    ];
    const model = editModel(carchEditNewPage, { rsRestrictGroups: groups }, { restrictGroups: 'Marketing' });
    const { $ } = await editPage(model, tenantRequest(model, {}, { extranet: true }));
    const panel = sectionModel($, '#panel-publishing');
    const select = (name: string) => panel.controls.find((c) => c.name === name);
    expect(select('isFeature')?.options.map((o) => o.value)).toEqual(['0', '1', '2']);
    expect(select('restrictgroups')?.type).toBe('select-multiple');
    // Member groups are listed before the system groups.
    expect(select('restrictgroups')?.options.map((o) => o.value)).toEqual([
      '',
      'RestrictAll',
      APPROVAL_GROUP_IDS.marketing,
      APPROVAL_GROUP_IDS.contentEditors,
    ]);
    expect(select('restrictgroups')?.selected).toEqual([APPROVAL_GROUP_IDS.marketing]);
    expect(controlsNamed(panel, 'expires')).toEqual([['expires', 'hidden', '']]);
  });

  it('closes with the carch edit scripts, CKEditor summary loader included', async () => {
    const ctx = modelContext(editModel(carchEditNewPage), tenantRequest(carchEditNewPage));
    const { view } = await run(ctx);
    const ajax = toString(view?.ajax ?? raw(''));
    expect(ajax).toBe(toString(carchJs(ctx, 'edit')));
    expect(ajax).toContain('editSummary = function(){');
  });

  it('sends an anonymous request to the controller secure() redirect before any read', async () => {
    const req = anonymousRequest({ circuit: 'cArch', item: 'edit', rc: editRc(carchEditNewPage) });
    const ctx = modelContext(editModel(carchEditNewPage), req);
    const denied = secure(req);
    await expect(renderScreenPage(editScreen, ctx)).resolves.toEqual({
      kind: 'redirect',
      location: denied.kind === 'redirect' ? denied.location : '',
    });
    expect(ctx.gateway.calls.filter((call) => call.service === 'strategies-content')).toEqual([]);
  });
});

/** Each panel's accordion heading id by its `tabList` id. */
const TAB_HEADINGS: Readonly<Record<string, string>> = Object.freeze({
  tabbasic: 'heading-basic',
  tabsummary: 'heading-summary',
  tabassoc: 'heading-assoc',
  tabpublishing: 'heading-publishing',
  tabschedule: 'heading-schedule',
  tablayoutobjects: 'heading-layout',
  tabcategorization: 'heading-categories',
  tabtags: 'heading-tags',
  tabrelatedcontent: 'heading-relatedcontent',
  tabusagereport: 'heading-usagereport',
  tabextendedattributes: 'heading-extendedattributes',
  tabremote: 'heading-remote',
});

const HOME_MODEL = editModel(
  carchEditExistingPage,
  {},
  { contentID: ROOT_CONTENT_ID, parentID: END_ID, title: 'Home', menuTitle: 'Home', filename: '' },
);

/** qa_editor outside the private pool opening About Us on `default`; the posted role fields grant nothing. */
function publicEditorRequest(): AdminRequest {
  const rc = { ...editRc(carchEditExistingPage), siteid: 'default', S2IsPrivate: 'true', s2: '1', isS2: 'true' };
  const req = editorRequest({ circuit: 'cArch', item: 'edit', rc });
  return { ...req, session: { ...req.session, s2IsPrivate: false } };
}

const FORMS_PAGE = editModel(carchEditNewPage, {}, { moduleID: FORM_MODULE_ID });

/** A stored module node of `type` filed under `moduleId`, over the About Us model's site data. */
function storedModuleNode(
  type: string,
  moduleId: string,
  contentId: string,
  contentHistId: string,
  bean: Struct = {},
): CarchPageModel {
  const filed = { contentID: contentId, contentHistID: contentHistId, parentID: moduleId, moduleID: moduleId };
  return editModel(carchEditExistingPage, {}, { ...filed, type, filename: '', ...bean });
}

const COMPONENT_MODEL = storedModuleNode(
  'Component',
  COMPONENT_MODULE_ID,
  CONTENT_IDS.homeBanner,
  CONTENT_HIST_IDS.homeBanner,
  { title: 'Home Banner', menuTitle: 'Home Banner' },
);

/** A builder form body holding the entity legacy stores for a double quote. */
const FORM_BODY = '{"form":{"name":"Contact &quot;Us&quot;","fields":{}},"datasets":{}}';

const FORM_MODEL = storedModuleNode('Form', FORM_MODULE_ID, CONTENT_IDS.contactForm, CONTENT_HIST_IDS.contactForm, {
  title: 'Contact Us',
  menuTitle: 'Contact Us',
  body: FORM_BODY,
});

describe('carch.edit settings panels', () => {
  it.each([
    [
      'a new Page',
      editModel(carchEditNewPage),
      () => tenantRequest(carchEditNewPage),
      'tabbasic,tabsummary,tabassoc,tabpublishing,tabschedule,tablayoutobjects,tabtags,tabrelatedcontent,tabremote',
      [],
    ],
    [
      'a stored Page with categories and extend sets',
      editModel(carchEditExistingPage),
      () => tenantRequest(carchEditExistingPage),
      'tabbasic,tabsummary,tabassoc,tabpublishing,tabschedule,tablayoutobjects,tabcategorization,tabtags,' +
        'tabrelatedcontent,tabextendedattributes,tabremote',
      [],
    ],
    [
      'Home, without Scheduling and Remote',
      HOME_MODEL,
      () => tenantRequest(HOME_MODEL),
      'tabbasic,tabsummary,tabassoc,tabpublishing,tablayoutobjects,tabcategorization,tabtags,tabrelatedcontent,' +
        'tabextendedattributes',
      [],
    ],
    [
      'a new Link',
      editModel(carchEditNewPage),
      () => tenantRequest(carchEditNewPage, { type: 'Link' }),
      'tabbasic,tabsummary,tabassoc,tabpublishing,tabschedule,tabtags,tabrelatedcontent,tabremote',
      [],
    ],
    [
      'a stored File, which takes no associated image',
      editModel(carchEditFile),
      () => tenantRequest(carchEditFile),
      'tabbasic,tabsummary,tabpublishing,tabschedule,tabtags,tabrelatedcontent,tabremote',
      [],
    ],
    [
      'a stored Component',
      COMPONENT_MODEL,
      () => tenantRequest(COMPONENT_MODEL),
      'tabbasic,tabsummary,tabpublishing,tabschedule,tabcategorization,tabtags,tabusagereport,tabextendedattributes',
      [],
    ],
    [
      'a stored builder Form',
      FORM_MODEL,
      () => tenantRequest(FORM_MODEL),
      'tabbasic,tabpublishing,tabschedule,tabcategorization,tabtags,tabusagereport,tabextendedattributes',
      [],
    ],
    [
      'a Page filed outside the Site Manager module',
      FORMS_PAGE,
      () => tenantRequest(FORMS_PAGE),
      'tabbasic,tabsummary,tabassoc,tabpublishing,tabschedule,tabtags,tabremote',
      ['ommitRelatedContentTab'],
    ],
    [
      'qa_editor outside the private pool',
      editModel(carchEditExistingPage),
      publicEditorRequest,
      'tabbasic,tabsummary,tabassoc,tabpublishing,tabschedule,tabcategorization,tabtags,tabrelatedcontent,' +
        'tabextendedattributes',
      ['ommitRemoteTab'],
    ],
  ] as const)('renders the panels of %s in legacy order', async (_label, model, request, tablist, omitted) => {
    const { $, html } = await editPage(model, request());
    expect(tablistOf(html)).toBe(tablist);
    expect(panelIds($)).toEqual(tablist.split(',').map((tab) => TAB_HEADINGS[tab]));
    const hidden = sectionModel($, '#content-panels').controls.filter((c) => c.name.startsWith('ommit'));
    expect(hidden.map((c) => [c.name, c.type, c.value])).toEqual(omitted.map((name) => [name, 'hidden', 'true']));
  });

  it('labels the panels from the admin bundle', async () => {
    const { $, ctx } = await editPage(editModel(carchEditExistingPage), tenantRequest(carchEditExistingPage));
    const tab = (key: string): string => ctx.rb.rbKey(`sitemanager.content.tabs.${key}`);
    const image = ctx.rb.rbKey('sitemanager.content.fields.selectimage').split(' ').at(-1);
    const titles = $('#content-panels > .mura-panel > .mura-panel-heading .mura-panel-title a').toArray();
    expect(titles.map((el) => $(el).text().trim())).toEqual([
      tab('basic'),
      ctx.rb.rbKey('sitemanager.content.fields.summary'),
      image,
      tab('publishing'),
      'Scheduling',
      tab('layoutobjects'),
      tab('categorization'),
      tab('tags'),
      tab('relatedcontent'),
      tab('extendedattributes'),
      'Remote',
    ]);
  });

  it('nests the site categories, checking the assigned ones', async () => {
    const { $, html } = await editPage(editModel(carchEditExistingPage), tenantRequest(carchEditExistingPage));
    expect($('#panel-categories ul.categorylist#mura-nodes')).toHaveLength(1);
    const items = $('#mura-nodes li[data-categoryid]').toArray();
    expect(items.map((el) => $(el).attr('data-categoryid'))).toEqual([
      CATEGORY_IDS.topics,
      CATEGORY_IDS.topicsNews,
      CATEGORY_IDS.topicsEvents,
      CATEGORY_IDS.topicsEventsLocal,
      CATEGORY_IDS.restricted,
    ]);
    const checked = sectionModel($, '#mura-nodes').controls.filter((c) => c.name === 'categoryid' && c.checked);
    expect(checked.map((c) => c.value)).toEqual([CATEGORY_IDS.topicsNews, CATEGORY_IDS.topicsEvents]);
    // The pooled categories belong to the umbrella site, so the open-category feed of tenant-a finds none.
    expect(html).not.toContain(".find('span.hasChildren:first').trigger('click');");
  });

  it("opens the assigned site categories' ancestors once each", async () => {
    const resited = (nodes: unknown): unknown =>
      (nodes as Struct[]).map((node) => ({ ...node, siteID: TENANT, children: resited(node.children) }));
    const model = editModel(carchEditExistingPage, { categories: resited(carchEditExistingPage.rc.categories) });
    const { html } = await editPage(model, tenantRequest(model));
    const trigger =
      `$('#bigui__categories li[data-categoryid="${CATEGORY_IDS.topics}"]')` +
      ".find('span.hasChildren:first').trigger('click'); ";
    expect(html.split(trigger)).toHaveLength(2);
    expect(html).toContain(`${trigger}\n\n\t\tcatsInited=true;`);
  });

  it.each([
    ['the default selector', '', {}, ['tags']],
    [
      'one selector per custom tag group',
      'Audience^ Region',
      { Audiencetags: 'staff' },
      ['tags', 'Audiencetags', 'Regiontags'],
    ],
  ] as const)('tags with %s', async (_label, customTagGroups, bean, selectors) => {
    const model = editModel(carchEditExistingPage, { siteConfig: { customTagGroups } }, bean);
    const { $, html } = await editPage(model, tenantRequest(model));
    expect($('#panel-tags .tagSelector').toArray().map((el) => $(el).attr('id'))).toEqual(selectors);
    expect(html).toContain("url: '?muraAction=carch.loadtagarray&siteid=' + siteid,");
    const panel = sectionModel($, '#panel-tags');
    const tags = controlsNamed(panel, 'tags', 'Audiencetags').filter(([, type]) => type === 'hidden');
    expect(tags).toEqual([
      ['tags', 'hidden', 'about'],
      ['tags', 'hidden', 'program'],
      ...(customTagGroups === '' ? [] : [['Audiencetags', 'hidden', 'staff'] as const]),
    ]);
    for (const group of selectors.slice(1)) {
      const taggroup = group.slice(0, -'tags'.length);
      expect(html).toContain(`url:'?muraAction=carch.loadtagarray&siteid=' + siteid + '&taggroup=${taggroup}',`);
    }
  });

  it('selects the templates and configures the layout objects', async () => {
    const site = { ...structOf(carchEditExistingPage.rc, 'site'), customTagGroups: 'Audience,Region' };
    const model = editModel(carchEditExistingPage, { site });
    const { $, html } = await editPage(model, tenantRequest(model));
    const panel = sectionModel($, '#panel-layout');
    const select = (name: string) => panel.controls.find((c) => c.name === name);
    expect(select('template')?.options.map((o) => o.value)).toEqual(['', 'default.cfm', 'two-column.cfm']);
    expect(select('template')?.selected).toEqual(['default.cfm']);
    expect(select('childTemplate')?.selected).toEqual(['two-column.cfm']);
    expect(html).toContain('\n<script>\nsiteManager.customtaggroups=["Audience","Region"];\n\n');
    expect(html).toContain('\nvar pluginConfigurators=new Array();\n');
  });

  it('keeps the remote identifiers', async () => {
    const { $ } = await editPage(editModel(carchEditExistingPage), tenantRequest(carchEditExistingPage));
    const fields = ['remoteID', 'remoteURL', 'remotePubDate', 'remoteSource', 'remoteSourceURL'];
    expect(controlsNamed(sectionModel($, '#panel-remote'), ...fields)).toEqual([
      ['remoteID', 'text', 'PA-ABOUT-001'],
      ['remoteURL', 'text', ''],
      ['remotePubDate', 'hidden', ''],
      ['remoteSource', 'text', ''],
      ['remoteSourceURL', 'text', ''],
    ]);
  });

  it('loads the extended attributes into their own panel', async () => {
    const { $ } = await editPage(editModel(carchEditExistingPage), tenantRequest(carchEditExistingPage));
    expect($('#panel-extendedattributes #extendset-container-default.extendedattributes-body')).toHaveLength(1);
  });
});

/** `model` with its version's stats locked by `lockId` with `lockType`, and `lockedBy` as the holder. */
function lockedModel(model: CarchPageModel, lockId: string, lockType: string): CarchPageModel {
  const stats = { ...structOf(structOf(model.rc, 'contentBean'), 'stats'), lockID: lockId, lockType };
  return editModel(model, { lockedBy: { ...LOCK_HOLDER } }, { stats });
}

describe('carch.edit page of a stored Page', () => {
  it('opens with the secondary menu and the crumbs', async () => {
    const { $ } = await editPage(editModel(carchEditExistingPage), tenantRequest(carchEditExistingPage));
    expect($('.mura-header div.nav-module-specific')).toHaveLength(1);
    expect(sectionModel($, '.mura-header ul.breadcrumb').links.map((link) => link.text)).toEqual(['Home', 'About Us']);
  });

  it.each([
    ['the session user', true],
    ['someone else', false],
  ] as const)('flags a node lock held by %s', async (_label, own) => {
    const req = tenantRequest(carchEditExistingPage);
    const holder = own ? req.session.mura.userID : USER_IDS.qaEditor;
    const { $, html } = await editPage(lockedModel(carchEditExistingPage, holder, 'node'), req);
    expect(html).toContain('siteManager.hasNodeLock=true;');
    const notices = ['#msg-node-locked', '#msg-node-locked-else'] as const;
    const [shown, absent] = own ? notices : [notices[1], notices[0]];
    expect($(`#dspStatusContainer ${shown}`)).toHaveLength(1);
    expect($(`#dspStatusContainer ${shown}`).attr('style')).toBeUndefined();
    expect($(`#dspStatusContainer ${absent}`)).toHaveLength(0);
    if (!own) {
      const [notice] = sectionModel($, '#msg-node-locked-else').alerts;
      expect(notice?.text).toContain(`${LOCK_HOLDER.fname} ${LOCK_HOLDER.lname}`);
      expect(sectionModel($, '#msg-node-locked-else').links[0]?.href).toMatch(/^mailto:quinn@example\.com\?subject=/);
      expect(html).toContain("$('.form-actions').hide();");
    }
  });

  it('summarises the version: last update and copyable ids', async () => {
    const req = tenantRequest(carchEditExistingPage);
    const { $, ctx } = await editPage(editModel(carchEditExistingPage), req);
    const lastUpdate = structText(structOf(carchEditExistingPage.rc, 'contentBean'), 'lastUpdate');
    const updated = formatDateTimeShort(lastUpdate, req.session.dateKeyFormat, req.session.locale);
    expect($('#mura-content-metadata').text().replace(/\s+/g, ' ')).toContain(
      `${ctx.rb.rbKey('sitemanager.content.update')}: ${updated}`,
    );
    expect($('#mura-content-metadata .clicktocopy').toArray().map((el) => $(el).text())).toEqual([
      'about-us',
      CONTENT_IDS.aboutUs,
    ]);
  });

  it.each([
    ['assigns change sets on a site that has them', true],
    ['offers no change set on a site without them', false],
  ] as const)('%s', async (_label, hasChangesets) => {
    const req = tenantRequest(carchEditExistingPage, {}, { hasChangesets });
    const { $, html } = await editPage(editModel(carchEditExistingPage), req);
    expect($('div#changesetContainer')).toHaveLength(hasChangesets ? 1 : 0);
    expect(html.includes("saveToChangeset('','tenant-a','');return false;")).toBe(hasChangesets);
  });

  it.each([
    ['the newer draft and the version notes', {}, {}, false, ['draft', 'notes']],
    [
      'the pending change sets',
      { draftcheck: { showdialog: 'false', historyid: '' } },
      { notes: '' },
      true,
      ['changesets'],
    ],
    [
      'nothing without drafts, change sets or notes',
      { draftcheck: { showdialog: 'false', historyid: '' } },
      { notes: '' },
      false,
      [],
    ],
  ] as const)('alerts %s', async (_label, rc, bean, hasChangesets, kinds) => {
    const pendingChangesets = [{ contentHistID: CONTENT_HIST_IDS.aboutUsDraft, changesetName: 'Q3 Review' }];
    const model = editModel(carchEditExistingPage, { ...rc, ...(hasChangesets ? { pendingChangesets } : {}) }, bean);
    const { $, ctx } = await editPage(model, tenantRequest(model, {}, { hasChangesets }));
    const rb = (key: string): string => ctx.rb.rbKey(key);
    const texts: Readonly<Record<string, string>> = {
      draft: `${rb('sitemanager.draftprompt.inline')}: ${rb('sitemanager.draftprompt.gotolatest')}`,
      notes: `${rb('sitemanager.content.notes')}: Annual review copy.`,
      // The label carries its own markup, which the alert text drops.
      changesets: `${rb('sitemanager.content.changesetnodenotify').replace(/<[^>]+>/g, '')}: Q3 Review`,
    };
    expect(sectionModel($, '#dspStatusContainer').alerts).toEqual(
      kinds.map((kind) => ({ text: texts[kind], className: 'alert alert-info' })),
    );
  });

  it('lists the validation errors, leaving out siteID', async () => {
    const errors = { title: "The 'Title' field is required", siteID: 'x' };
    const model = editModel(carchEditExistingPage, {}, { errors });
    const { $, html } = await editPage(model, tenantRequest(model));
    const { alerts } = sectionModel($, '#dspStatusContainer');
    const errorAlerts = alerts.filter((a) => a.className === 'alert alert-error');
    expect(errorAlerts).toEqual([{ text: "The 'Title' field is required", className: 'alert alert-error' }]);
    expect(html).toContain(
      `<div class="alert alert-error"><span>${toString(displayErrors(Object.entries(errors)))}</span></div>`,
    );
  });
});

describe('carch.edit page of a stored File', () => {
  it('prints the file selector, not an editor, in the body render area', async () => {
    const { $ } = await editPage(editModel(carchEditFile), tenantRequest(carchEditFile));
    const body = '#mura-content-body-render > #mura-content-body-inner';
    expect($(`${body} > #assocFileContainer #assocFileSelectorContainer [data-name="newfile"]`)).toHaveLength(1);
    expect($('#mura-content-body-render textarea[name="body"]')).toHaveLength(0);
    expect(controlsNamed(sectionModel($, body), 'newfile').map(([, type]) => type)).toEqual(['file', 'text']);
  });

  it.each([
    ['no lock', '', 'hidden', false],
    ["the session user's file lock", 'own', 'shown', true],
    ["someone else's file lock", 'other', 'else', false],
  ] as const)('notes %s', async (_label, holder, notice, hasFileLock) => {
    const req = tenantRequest(carchEditFile);
    const lockId = holder === '' ? '' : holder === 'own' ? req.session.mura.userID : USER_IDS.qaEditor;
    const { $, html } = await editPage(lockedModel(carchEditFile, lockId, 'file'), req);
    expect(html).toContain(`siteManager.hasFileLock=${String(hasFileLock)};`);
    const youLocked = $('#assocFileContainer #msg-file-locked');
    expect(youLocked).toHaveLength(1);
    expect(youLocked.attr('style')).toBe(notice === 'shown' ? undefined : 'display:none;');
    expect($('#assocFileContainer #msg-file-locked-else')).toHaveLength(notice === 'else' ? 1 : 0);
    expect($('#assocFileContainer > .mura-file-selector')).toHaveLength(notice === 'else' ? 1 : 0);
    expect($('#assocFileContainer #assocFileSelectorContainer')).toHaveLength(notice === 'else' ? 0 : 1);
    if (notice === 'else') {
      expect($('#msg-file-locked-else').text()).toContain(`${LOCK_HOLDER.fname} ${LOCK_HOLDER.lname}`);
    }
  });
});

describe('carch.edit page variants', () => {
  it("prints a new Link's URL field in the body render area", async () => {
    const { $ } = await editPage(editModel(carchEditNewPage), tenantRequest(carchEditNewPage, { type: 'Link' }));
    const body = sectionModel($, '#mura-content-body-render > #mura-content-body-inner');
    expect(body.controls.filter((c) => c.name === 'body').map((c) => [c.tag, c.type, c.value])).toEqual([
      ['input', 'text', ''],
    ]);
    expect($('#mura-content-body-render input#url[name="body"][required="true"]')).toHaveLength(1);
    expect(sectionModel($, '#contentForm').controls.some((c) => c.name === 'filename')).toBe(false);
  });

  it('replaces the Basic panel of a builder Form with the form builder', async () => {
    const { $ } = await editPage(FORM_MODEL, tenantRequest(FORM_MODEL));
    expect($('#mura-content-body-render #mura-templatebuilder')).toHaveLength(1);
    expect(controlsNamed(sectionModel($, '#mura-content-body-render'), 'body')).toEqual([
      ['body', 'textarea', '{"form":{"name":"Contact \\"Us\\"","fields":{}},"datasets":{}}'],
    ]);
    expect($('textarea#mura-formdata[name="body"]')).toHaveLength(1);
    expect($('#panel-summary, #panel-assoc')).toHaveLength(0);
    const { view } = await run(modelContext(FORM_MODEL, tenantRequest(FORM_MODEL)));
    const head = toString(view?.htmlHead ?? raw(''));
    expect(head).toBe(toString(headFormBuilder()));
    for (const script of ['jquery.jsonform.js', 'jquery.templatebuilder.0.7.js', 'jquery-ui-minigrid-0.7.js']) {
      expect(head).toContain(`/${script}" type="text/javascript"></script>`);
    }
  });

  it.each([
    ['its usage rows', true],
    ['the not-used notice', false],
  ] as const)('reports the usage of a stored Component with %s', async (_label, used) => {
    const usage = {
      contentid: CONTENT_IDS.aboutUs,
      contenthistid: CONTENT_HIST_IDS.aboutUs,
      type: 'Page',
      parentid: ROOT_CONTENT_ID,
      siteid: TENANT,
      moduleid: CONTENT_MODULE_ID,
      display: 1,
      approved: 1,
      displaystart: '',
      displaystop: '',
      lastupdate: '2026-06-30 09:15:00',
      verdict: 'editor',
      crumbdata: structuredClone(carchEditExistingPage.rc.crumbData),
    };
    const model = editModel(COMPONENT_MODEL, { rsUsage: used ? [usage] : [] });
    const { $, ctx } = await editPage(model, tenantRequest(model));
    const panel = sectionModel($, '#panel-usagereport');
    expect($('#panel-usagereport #table__usage__report')).toHaveLength(used ? 1 : 0);
    if (used) {
      const [table] = panel.tables;
      expect(table?.rows).toHaveLength(1);
      expect(table?.rows[0]?.[1]).toBe(ctx.rb.rbKey('sitemanager.yes'));
      expect(panel.links.map((link) => link.href)).toEqual(
        expect.arrayContaining([expect.stringContaining('muraAction=carch.edit')]),
      );
    } else {
      const typeLabel = ctx.rb.rbKey('sitemanager.content.type.Component').toLowerCase();
      expect($('#panel-usagereport .help-block-empty').text()).toBe(
        ctx.rb.messageFormat(ctx.rb.rbKey('sitemanager.content.fields.nousage'), typeLabel),
      );
    }
  });
});

