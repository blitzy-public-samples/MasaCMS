// carch edit_panels.cfm: the content editor's settings sidebar around the real panel renderers, against legacy captures
import { readFileSync } from 'node:fs';
import { cfToBoolean } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSafeHtml, raw, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { renderEditPanels, type EditPanelsResult } from '@/screens/carch/edit-panels';
import type { EditFormInput, EditFormState, PanelResult } from '@/screens/carch/form/custom-tags';
import { renderPanelAssocFile } from '@/screens/carch/form/panel-assocfile';
import { renderPanelBasic } from '@/screens/carch/form/panel-basic';
import { renderCategoriesPanel } from '@/screens/carch/form/panel-categories';
import { renderPanelExtendedAttributes } from '@/screens/carch/form/panel-extended-attributes';
import { renderPanelFormBuilder } from '@/screens/carch/form/panel-formbuilder';
import { renderLayoutObjectsPanel } from '@/screens/carch/form/panel-layoutobjects';
import { renderPublishingPanel } from '@/screens/carch/form/panel-publishing';
import { renderPanelRelatedContent } from '@/screens/carch/form/panel-related-content';
import { renderPanelRemote } from '@/screens/carch/form/panel-remote';
import { renderSchedulingPanel } from '@/screens/carch/form/panel-scheduling';
import { renderPanelSummary } from '@/screens/carch/form/panel-summary';
import { renderTagsPanel } from '@/screens/carch/form/panel-tags';
import { renderPanelUsage } from '@/screens/carch/form/panel-usage';
import {
  COMPONENT_MODULE_ID,
  CONTENT_MODULE_ID,
  FORM_MODULE_ID,
  ROOT_CONTENT_ID,
  VARIATION_MODULE_ID,
} from '@/screens/carch/model';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request, editorRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

/** Legacy captures of the include on the default site (no categories, no class extensions, no plugins). */
interface Captures {
  /** From the include's first newline through the panel group's opening, full and compact layout. */
  readonly prefix: Readonly<Record<'full' | 'compact', string>>;
  /** From the panel group's closing through the filter script, for a new and a stored node. */
  readonly suffix: Readonly<Record<'new' | 'stored', string>>;
  /** The `heading-<id>` panel ids in page order, per `<user>-<case>` capture. */
  readonly headings: Readonly<Record<string, readonly string[]>>;
  /** A new builder Form's id and the body its form builder printed. */
  readonly jsonForms: readonly { readonly contentId: string; readonly body: string }[];
  /** `ADMINCONTROLWIDTH` as sent and as the width style printed it. */
  readonly cookies: readonly (readonly [string, string])[];
  /** `compactDisplay` values and the layout legacy chose, `error` where it answered 500. */
  readonly compactDisplay: readonly (readonly [string, 'compact' | 'full' | 'error'])[];
}

// `cArch.edit` on the legacy ACF 2023 server as admin (S2) and qa_editor (Editor group, no tab list, so every tab of
// `contentManager.getTabList()`): Home as installed, opened plainly and with compactDisplay 1 and no, and new Page,
// Folder, Calendar, Gallery, Link, File, Component, builder and editor Form and Variation nodes, the new Page also
// compact; the `ADMINCONTROLWIDTH` and `compactDisplay` cases resent a new Page with each cookie or parameter value.
const CAPTURES = JSON.parse(
  readFileSync(new URL('../../fixtures/strategies-content/edit-panels.json', import.meta.url), 'utf8'),
) as Captures;

const END_ID = '00000000000000000000000000000000END';
const HOME_HIST_ID = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const NEW_ID = 'D1000000-0000-0000-0000000000000001';
const NEW_HIST_ID = 'D2000000-0000-0000-0000000000000001';
const STORED_ID = 'D1000000-0000-0000-0000000000000002';
const STORED_HIST_ID = 'D2000000-0000-0000-0000000000000002';

/** Every tab `contentManager.getTabList()` names, which a user whose groups assign none receives. */
const FULL_TAB_LIST =
  'Basic,SEO,Summary,Image,Publishing,Scheduling,Layout & Objects,Categorization,Tags,Related Content,' +
  'Extended Attributes,Remote';

const OMIT_RELATED_CONTENT =
  '\n\t\t\t\t\t\t\t\t\t<input type="hidden" name="ommitRelatedContentTab" value="true">\n\t\t\t\t\t\t\t\t';
const OMIT_REMOTE =
  '\n\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t<input type="hidden" name="ommitRemoteTab" value="true">\n\t\t\t\t\t\t\t\t';

type Struct = Readonly<Record<string, unknown>>;

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

/** Module and parent each content type is added under. */
const PLACES: Readonly<Record<string, readonly [moduleId: string, parentId: string]>> = {
  Page: [CONTENT_MODULE_ID, ROOT_CONTENT_ID],
  Folder: [CONTENT_MODULE_ID, ROOT_CONTENT_ID],
  Calendar: [CONTENT_MODULE_ID, ROOT_CONTENT_ID],
  Gallery: [CONTENT_MODULE_ID, ROOT_CONTENT_ID],
  Link: [CONTENT_MODULE_ID, ROOT_CONTENT_ID],
  File: [CONTENT_MODULE_ID, ROOT_CONTENT_ID],
  Component: [COMPONENT_MODULE_ID, COMPONENT_MODULE_ID],
  Form: [FORM_MODULE_ID, FORM_MODULE_ID],
  Variation: [VARIATION_MODULE_ID, VARIATION_MODULE_ID],
};

/** The edit model's content bean: a node of `type` as Masa creates it, new or stored under its module root. */
function contentBean(type: string, isNew: boolean, values: Struct = {}): Struct {
  const [moduleId, parentId] = PLACES[type] ?? [CONTENT_MODULE_ID, ROOT_CONTENT_ID];
  return {
    contentID: isNew ? NEW_ID : STORED_ID,
    contentHistID: isNew ? NEW_HIST_ID : STORED_HIST_ID,
    parentID: isNew ? '' : parentId,
    siteID: 'default',
    moduleID: moduleId,
    type,
    subType: 'Default',
    isNew: isNew ? 1 : 0,
    isLocked: 0,
    active: isNew ? 0 : 1,
    approved: isNew ? 0 : 1,
    approvalStatus: '',
    changesetID: '',
    title: isNew ? '' : `Stored ${type}`,
    menuTitle: isNew ? '' : `Stored ${type}`,
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
    parent: { type: 'Page' },
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
    stats: { lockID: '', lockType: '' },
    ...values,
  };
}

/** The edit model `rc` every panel reads for `bean`; `values` replace members. */
function editModel(bean: Struct, values: Struct = {}): Struct {
  return {
    contentBean: bean,
    parentBean: { type: 'Page' },
    crumbData: [{ menutitle: 'Home' }],
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
    ...values,
  };
}

const STATE: EditFormState = Object.freeze({
  tabAssignments: '',
  pageLevelList: 'Page,Folder,Calendar',
  baseTypeList: 'Page,Folder,Calendar',
  subTypes: [],
  subtypeFilter: '',
  isExtended: false,
  requiresApproval: false,
  showApprovalStatus: false,
  hasChangesets: false,
  ptype: 'Page',
  compactDisplay: 'false',
  preview: '0',
});

interface Case {
  readonly type: string;
  readonly isNew?: boolean;
  /** Content bean members replacing the defaults. */
  readonly bean?: Struct;
  /** Edit model members replacing the defaults. */
  readonly model?: Struct;
  readonly state?: Partial<EditFormState>;
  /** Request rc members replacing the defaults. */
  readonly rc?: Readonly<Record<string, string>>;
  /** The request's form scope; default empty, so `rc` came from the URL. */
  readonly formScope?: Readonly<Record<string, string>>;
  /** qa_editor instead of the S2 admin. */
  readonly editor?: boolean;
  readonly request?: AdminRequestPartial;
  /** The body legacy gives the content bean before the panels read it, for the expected panels. */
  readonly expectedBody?: string;
}

/** The panel input of `c`, built as edit.cfm leaves it for the include. */
function input(c: Case): EditFormInput {
  const isNew = c.isNew ?? true;
  const bean = contentBean(c.type, isNew, c.bean);
  const [moduleId, parentId] = PLACES[c.type] ?? [CONTENT_MODULE_ID, ROOT_CONTENT_ID];
  const partial: AdminRequestPartial = {
    circuit: 'cArch',
    item: 'edit',
    site: { record: { theme: 'default' } },
    ...c.request,
    rc: {
      siteid: 'default',
      type: c.type,
      moduleid: moduleId,
      topid: moduleId === CONTENT_MODULE_ID ? ROOT_CONTENT_ID : moduleId,
      contentid: isNew ? '' : String(bean.contentID),
      contenthistid: isNew ? '' : String(bean.contentHistID),
      parentid: isNew ? parentId : '',
      ...c.rc,
    },
    formScope: c.formScope ?? {},
  };
  const req: AdminRequest = c.editor === true ? editorRequest(partial) : adminS2Request(partial);
  const ctx = { req, rb: rbFor(req.session.rb), now: new Date('2026-11-13T04:22:00Z') } as Pick<
    ScreenContext,
    'req' | 'rb' | 'now'
  > as ScreenContext;
  return { ctx, req, data: { rc: editModel(bean, c.model) }, state: { ...STATE, ...c.state } };
}

/** The `heading-<id>` panel ids of `html` in page order. */
const headings = (html: string): string[] => [...html.matchAll(/ id="heading-([a-z]+)"/g)].map((m) => m[1] ?? '');

type Renderer = (i: EditFormInput) => PanelResult | null | Promise<PanelResult | null>;

/** Each panel include by its heading id, the builder Form's Basic panel as `formbuilder`, with the tab it appends. */
const PANELS: Readonly<Record<string, readonly [render: Renderer, tabId: string, heading: string]>> = {
  basic: [renderPanelBasic, 'tabBasic', 'basic'],
  formbuilder: [renderPanelFormBuilder, 'tabBasic', 'basic'],
  summary: [renderPanelSummary, 'tabSummary', 'summary'],
  assoc: [renderPanelAssocFile, 'tabAssoc', 'assoc'],
  publishing: [renderPublishingPanel, 'tabPublishing', 'publishing'],
  schedule: [renderSchedulingPanel, 'tabSchedule', 'schedule'],
  layout: [renderLayoutObjectsPanel, 'tabLayoutObjects', 'layout'],
  categories: [renderCategoriesPanel, 'tabCategorization', 'categories'],
  tags: [renderTagsPanel, 'tabTags', 'tags'],
  relatedcontent: [renderPanelRelatedContent, 'tabRelatedcontent', 'relatedcontent'],
  usagereport: [renderPanelUsage, 'tabUsagereport', 'usagereport'],
  extendedattributes: [renderPanelExtendedAttributes, 'tabExtendedAttributes', 'extendedattributes'],
  remote: [renderPanelRemote, 'tabRemote', 'remote'],
};

/** One expected piece between the panel group's opening and closing: a panel by key, or a hidden field. */
type Part = string | { readonly hidden: string };

const panelOf = (key: string): readonly [Renderer, string, string] => {
  const panel = PANELS[key];
  if (panel === undefined) throw new Error(`no panel ${key}`);
  return panel;
};

/** The include legacy prints for `c`: its captured edges around each part, the panels rendered on their own. */
async function expected(c: Case, parts: readonly Part[]): Promise<string> {
  const own = input(c.expectedBody === undefined ? c : { ...c, bean: { ...c.bean, body: c.expectedBody } });
  let body = '';
  for (const part of parts) {
    if (typeof part !== 'string') {
      body += part.hidden;
      continue;
    }
    const panel = await panelOf(part)[0](own);
    if (panel === null) throw new Error(`panel ${part} renders nothing for ${c.type}`);
    body += toString(panel.html);
  }
  const compact = cfToBoolean(own.state.compactDisplay);
  const isNew = c.isNew ?? true;
  return CAPTURES.prefix[compact ? 'compact' : 'full'] + body + CAPTURES.suffix[isNew ? 'new' : 'stored'];
}

/** The panel keys of `parts`. */
const panelKeys = (parts: readonly Part[]): string[] => parts.filter((p): p is string => typeof p === 'string');

const HIDDEN: Readonly<Record<string, string>> = { '-related': OMIT_RELATED_CONTENT, '-remote': OMIT_REMOTE };

/** Parts from space-separated panel keys, where `-related` and `-remote` stand for the hidden omission fields. */
const seq = (keys: string): Part[] =>
  keys.split(' ').map((key) => {
    const hidden = HIDDEN[key];
    return hidden === undefined ? key : { hidden };
  });

/** Renders `c` and checks the markup, panel order and `tabList` against `keys`. */
async function expectPanels(c: Case, keys: string): Promise<EditPanelsResult> {
  const parts = seq(keys);
  const result = await renderEditPanels(input(c));
  expect(isSafeHtml(result.html)).toBe(true);
  const html = toString(result.html);
  const panels = panelKeys(parts);
  expect(headings(html)).toEqual(panels.map((key) => panelOf(key)[2]));
  expect(html).toBe(await expected(c, parts));
  expect(result.tabList).toBe(panels.map((key) => panelOf(key)[1]).join(','));
  expect(result.tabLabelList).toBe('');
  return result;
}

/** Home as installed, opened from the Site Manager. */
const HOME: Case = {
  type: 'Page',
  isNew: false,
  bean: { contentID: ROOT_CONTENT_ID, contentHistID: HOME_HIST_ID, parentID: END_ID, title: 'Home', menuTitle: 'Home' },
  rc: { contentid: ROOT_CONTENT_ID, contenthistid: HOME_HIST_ID, parentid: END_ID },
};

type JsonForm = Captures['jsonForms'][number];
const [BUILDER_FORM, SECOND_BUILDER_FORM] = CAPTURES.jsonForms as readonly [JsonForm, JsonForm];

/** A new builder Form with the captured id, expected to carry the captured form builder body. */
const NEW_BUILDER_FORM: Case = {
  type: 'Form',
  bean: { contentID: BUILDER_FORM.contentId },
  rc: { formType: 'builder' },
  expectedBody: BUILDER_FORM.body,
};

/** qa_editor, whose Editor group assigns no tabs. */
const EDITOR: Partial<Case> = { editor: true, state: { tabAssignments: FULL_TAB_LIST } };

const HOME_PANELS = 'basic summary assoc publishing layout tags relatedcontent';
const NODE_PANELS = 'basic summary assoc publishing schedule layout tags relatedcontent remote';
const LINK_PANELS = 'basic summary assoc publishing schedule tags relatedcontent remote';
const FILE_PANELS = 'basic summary publishing schedule tags relatedcontent remote';
const COMPONENT_PANELS = 'basic summary publishing schedule tags';
const BUILDER_PANELS = 'formbuilder publishing schedule tags';
const VARIATION_PANELS = 'basic summary publishing schedule tags remote';

/** The legacy captures and the request each reproduces, with the panels the capture shows. */
const LEGACY_CASES: ReadonlyArray<readonly [capture: string, c: Case, keys: string]> = [
  ['admin-home', HOME, HOME_PANELS],
  ['admin-homecompact1', { ...HOME, state: { compactDisplay: '1' } }, HOME_PANELS],
  ['admin-homecompactno', { ...HOME, state: { compactDisplay: 'no' } }, HOME_PANELS],
  ['admin-newpage', { type: 'Page' }, NODE_PANELS],
  ['admin-newpagecompact', { type: 'Page', state: { compactDisplay: 'true' } }, NODE_PANELS],
  ['admin-newfolder', { type: 'Folder' }, NODE_PANELS],
  ['admin-newcalendar', { type: 'Calendar' }, NODE_PANELS],
  ['admin-newgallery', { type: 'Gallery', state: { pageLevelList: 'Page,Folder,Calendar,Gallery' } }, NODE_PANELS],
  ['admin-newlink', { type: 'Link' }, LINK_PANELS],
  ['admin-newfile', { type: 'File' }, FILE_PANELS],
  ['admin-newcomponent', { type: 'Component' }, COMPONENT_PANELS],
  ['admin-newform', NEW_BUILDER_FORM, BUILDER_PANELS],
  ['admin-newformeditor', { type: 'Form', rc: { formType: 'editor' } }, COMPONENT_PANELS],
  ['admin-newvariation', { type: 'Variation' }, VARIATION_PANELS],
  ['editor-home', { ...HOME, ...EDITOR }, HOME_PANELS],
  ['editor-newpage', { type: 'Page', ...EDITOR }, NODE_PANELS],
  ['editor-newlink', { type: 'Link', ...EDITOR }, LINK_PANELS],
  ['editor-newfile', { type: 'File', ...EDITOR }, FILE_PANELS],
  ['editor-newcomponent', { type: 'Component', ...EDITOR }, COMPONENT_PANELS],
  ['editor-newform', { ...NEW_BUILDER_FORM, ...EDITOR }, BUILDER_PANELS],
  ['editor-newvariation', { type: 'Variation', ...EDITOR }, VARIATION_PANELS],
];

/** A user whose memberships hold no `S2IsPrivate`, whose layout and remote tabs legacy withholds. */
const PUBLIC_MEMBER: AdminRequestPartial = { session: { mura: { memberships: 'S2IsPublic;default,S2IsPublic' } } };

/** A site with categories, which offers the Categorization panel. */
const WITH_CATEGORIES: Struct = { categoryCount: 2 };

/** A subtype with an active extend set, which offers the Extended Attributes panel. */
const WITH_EXTEND_SETS: Struct = { extendSets: [{ extendSetID: 'E1000000-0000-0000-0000000000000001', name: 'Set' }] };

const STORED_FORM: Case = { type: 'Form', isNew: false, bean: { body: '<p>Contact us</p>' } };

const LAYOUTS = CAPTURES.compactDisplay.flatMap(([value, layout]) =>
  layout === 'error' ? [] : [[value, layout] as const],
);
const LAYOUT_ERRORS = CAPTURES.compactDisplay.flatMap(([value, layout]) => (layout === 'error' ? [value] : []));
// Oracle: cArch.edit of Home with each raw value, which `not $.event('compactDisplay')` reads as the admin scan leaves it.
const SCANNED_LAYOUTS: ReadonlyArray<readonly [string, 'compact' | 'full']> = [
  [' TRUE', 'compact'],
  ['TRUE\u0001', 'compact'],
  ['tr\u0000ue', 'compact'],
  ['\u0001yes', 'compact'],
  [' 1.0 ', 'compact'],
  [' 1e0', 'compact'],
  ['1.', 'compact'],
  [' 0 ', 'full'],
  [' FALSE', 'full'],
  ['\u0001no', 'full'],
  ['fa\u0000lse', 'full'],
];
const SCANNED_ERRORS = [' false', '\u000btrue', '  ', 'tr\nue'];

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('carch.edit settings panels', () => {
  it.each(LEGACY_CASES)('composes the %s capture', async (capture, c, keys) => {
    expect(panelKeys(seq(keys)).map((key) => panelOf(key)[2])).toEqual(CAPTURES.headings[capture]);
    await expectPanels(c, keys);
  });

  it.each<readonly [string, Case, string]>([
    ['a stored Component', { type: 'Component', isNew: false }, `${COMPONENT_PANELS} usagereport`],
    [
      'a stored builder Form',
      { type: 'Form', isNew: false, bean: { body: SECOND_BUILDER_FORM.body } },
      `${BUILDER_PANELS} usagereport`,
    ],
    ['a stored editor Form', STORED_FORM, `${COMPONENT_PANELS} usagereport`],
    [
      'a stored Component without usage tabs',
      { type: 'Component', isNew: false, model: { showUsageTabs: 'false' } },
      COMPONENT_PANELS,
    ],
    [
      'a stored Form with usage tabs on',
      { ...STORED_FORM, model: { showUsageTabs: 'yes' } },
      `${COMPONENT_PANELS} usagereport`,
    ],
    ['a stored Page', { type: 'Page', isNew: false }, NODE_PANELS],
    ['a stored File', { type: 'File', isNew: false }, FILE_PANELS],
    ['a stored Variation', { type: 'Variation', isNew: false }, VARIATION_PANELS],
    ['a lower-case type', { type: 'page', rc: { moduleid: CONTENT_MODULE_ID } }, NODE_PANELS],
  ])('renders the panels of %s', async (_case, c, keys) => {
    await expectPanels(c, keys);
  });

  it.each<readonly [string, Case, string]>([
    ['a Page', { type: 'Page' }, NODE_PANELS.replace('layout', 'layout categories')],
    ['a Link', { type: 'Link' }, LINK_PANELS.replace('tags', 'categories tags')],
    ['a Variation', { type: 'Variation' }, 'basic summary publishing schedule categories tags remote'],
    ['a Component', { type: 'Component' }, 'basic summary publishing schedule categories tags'],
    ['a Form', NEW_BUILDER_FORM, 'formbuilder publishing schedule categories tags'],
  ])('offers the Categorization panel for %s of a site with categories', async (_case, c, keys) => {
    await expectPanels({ ...c, model: WITH_CATEGORIES }, keys);
  });

  it.each<readonly [string, Case, string]>([
    ['a Page', { type: 'Page' }, NODE_PANELS.replace('remote', 'extendedattributes remote')],
    ['a File', { type: 'File' }, FILE_PANELS.replace('remote', 'extendedattributes remote')],
    ['a Component', { type: 'Component' }, `${COMPONENT_PANELS} extendedattributes`],
    ['a Form', { type: 'Form', rc: { formType: 'editor' } }, `${COMPONENT_PANELS} extendedattributes`],
    ['a Variation, which takes no extensions', { type: 'Variation' }, VARIATION_PANELS],
  ])('offers the Extended Attributes panel for %s with extend sets', async (_case, c, keys) => {
    await expectPanels({ ...c, model: WITH_EXTEND_SETS }, keys);
  });

  it.each<readonly [string, Case, string]>([
    ['Basic only', { type: 'Page', state: { tabAssignments: 'Basic' } }, 'basic summary assoc -related'],
    [
      'Publishing and Tags',
      { type: 'Page', state: { tabAssignments: 'publishing,TAGS' } },
      'basic summary assoc publishing schedule tags -related',
    ],
    [
      'Scheduling without Publishing',
      { type: 'Page', state: { tabAssignments: 'Scheduling,Remote' } },
      'basic summary assoc -related remote',
    ],
    [
      'Layout & Objects and Related Content',
      { type: 'Page', state: { tabAssignments: 'Layout & Objects,Related Content' } },
      'basic summary assoc layout relatedcontent',
    ],
    [
      'Categorization off on a site with categories',
      { type: 'Page', model: WITH_CATEGORIES, state: { tabAssignments: 'Tags,Related Content' } },
      'basic summary assoc tags relatedcontent',
    ],
    [
      'Extended Attributes off with extend sets',
      { type: 'Link', model: WITH_EXTEND_SETS, state: { tabAssignments: 'Publishing' } },
      'basic summary assoc publishing schedule -related',
    ],
    ['the editor tab list on a stored Component', { type: 'Component', isNew: false, ...EDITOR }, COMPONENT_PANELS],
    [
      'Usage Report on a stored Form',
      { ...STORED_FORM, state: { tabAssignments: 'Usage Report' } },
      'basic summary usagereport',
    ],
    ['Basic on a Variation', { type: 'Variation', state: { tabAssignments: 'Basic' } }, 'basic summary'],
  ])('restricts the tabs to %s', async (_case, c, keys) => {
    await expectPanels(c, keys);
  });

  it.each<readonly [string, Case, string]>([
    [
      'a Page outside the Site Manager module',
      { type: 'Page', rc: { moduleid: COMPONENT_MODULE_ID } },
      'basic summary assoc publishing schedule tags -related remote',
    ],
    [
      'a File outside the Site Manager module',
      { type: 'File', rc: { moduleid: FORM_MODULE_ID } },
      'basic summary publishing schedule tags -related remote',
    ],
    [
      'a member without S2IsPrivate',
      { type: 'Page', request: PUBLIC_MEMBER },
      'basic summary assoc publishing schedule tags relatedcontent -remote',
    ],
    [
      'a member without S2IsPrivate and the Remote tab',
      { type: 'Link', request: PUBLIC_MEMBER, state: { tabAssignments: 'Tags' } },
      'basic summary assoc tags -related',
    ],
    [
      'a member without S2IsPrivate on Home',
      { ...HOME, request: PUBLIC_MEMBER },
      'basic summary assoc publishing tags relatedcontent',
    ],
  ])('omits withheld tabs with hidden fields for %s', async (_case, c, keys) => {
    await expectPanels(c, keys);
  });

  it.each(CAPTURES.jsonForms)('gives the new builder Form $contentId an empty builder body', async (form) => {
    const { contentId, body } = form;
    const result = await renderEditPanels(input({ type: 'Form', bean: { contentID: contentId } }));
    expect(toString(result.bodyContent)).toContain(`<textarea id="mura-formdata" name="body">${body}</textarea>`);
  });

  it.each<readonly [string, Case, boolean]>([
    ['formType=editor in the URL', { type: 'Form', rc: { formType: 'EDITOR' } }, false],
    [
      'formType=editor posted only',
      { type: 'Form', rc: { formType: 'editor' }, formScope: { formType: 'editor' } },
      true,
    ],
    ['no formType', { type: 'Form' }, true],
    ['a stored Form with an HTML body', { ...STORED_FORM, rc: { formType: 'builder' } }, false],
  ])('chooses the form builder for a Form with %s: %s', async (_case, c, builder) => {
    const result = await renderEditPanels(input(c));
    expect(toString(result.bodyContent).includes('<div id="mura-templatebuilder"')).toBe(builder);
    expect(result.htmlHead === undefined).toBe(!builder);
  });

  it('leaves the Basic or form builder body, the form builder head and the scheduled ptype for edit.cfm', async () => {
    const page = await renderEditPanels(input({ type: 'Page' }));
    const basic = await renderPanelBasic(input({ type: 'Page' }));
    expect(toString(page.bodyContent)).toBe(toString(basic.bodyContent ?? raw('')));
    expect(page.htmlHead).toBeUndefined();
    expect(page.ptype).toBe(renderSchedulingPanel(input({ type: 'Page' })).ptype);

    const form = await renderEditPanels(input(NEW_BUILDER_FORM));
    const builder = renderPanelFormBuilder(input({ ...NEW_BUILDER_FORM, bean: { body: BUILDER_FORM.body } }));
    expect(toString(form.bodyContent)).toBe(toString(builder.bodyContent ?? raw('')));
    const head = form.htmlHead === undefined ? undefined : toString(form.htmlHead);
    expect(head).toBe(toString(builder.htmlHead ?? raw('')));

    const home = await renderEditPanels(input({ ...HOME, state: { ptype: 'Gallery' } }));
    expect(home.ptype).toBe('Gallery');
  });

  it.each(CAPTURES.cookies)('prints ADMINCONTROLWIDTH %j as legacy decodes it: %j', async (sent, printed) => {
    const result = await renderEditPanels(
      input({ type: 'Page', request: { cookies: new Map([['ADMINCONTROLWIDTH', sent]]) } }),
    );
    const start = `\n\t<div class="mura__edit__controls" style="width: ${printed}px">\n`;
    expect(toString(result.html).slice(0, start.length)).toBe(start);
  });

  it.each([...LAYOUTS, ...SCANNED_LAYOUTS])(
    'takes compactDisplay %j for the %s layout, as legacy does',
    async (compactDisplay, layout) => {
      const result = await renderEditPanels(input({ type: 'Page', state: { compactDisplay } }));
      const prefix = CAPTURES.prefix[layout];
      expect(toString(result.html).slice(0, prefix.length)).toBe(prefix);
    },
  );

  it.each([...LAYOUT_ERRORS, ...SCANNED_ERRORS])(
    'fails on compactDisplay %j, where legacy answers 500',
    async (compactDisplay) => {
      await expect(renderEditPanels(input({ type: 'Page', state: { compactDisplay } }))).rejects.toThrow(TypeError);
    },
  );

  it.each<readonly [string, Case, string]>([
    ['no ADMINCONTROLWIDTH cookie', { type: 'Page', request: { cookies: new Map() } }, 'ADMINCONTROLWIDTH'],
    ['no category count where Categorization shows', { type: 'Page', model: { categoryCount: null } }, 'categoryCount'],
    ['no extend sets where Extended Attributes shows', { type: 'Page', model: { extendSets: null } }, 'rc.extendSets'],
    ['extend sets that are no array', { type: 'Component', model: { extendSets: 1 } }, 'rc.extendSets'],
    ['no rc.type', { type: 'Page', rc: { type: undefined as unknown as string } }, 'Element TYPE is undefined'],
  ])('fails as legacy does with %s', async (_case, c, message) => {
    await expect(renderEditPanels(input(c))).rejects.toThrow(message);
  });

  it('reads neither count where the tabs are withheld', async () => {
    const model = { categoryCount: undefined, extendSets: undefined };
    await expectPanels({ type: 'Page', model, state: { tabAssignments: 'Basic' } }, 'basic summary assoc -related');
  });
});
