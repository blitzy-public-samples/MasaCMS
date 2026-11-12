// Carried carch and cchangesets panel responses against Masa 7.6.1 on ACF 2023 (test/fixtures/legacy-admin-panels-recorded.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAdminLabels, type AdminRenderContext, type AdminSession } from '../../src/legacy/admin-markup.js';
import {
  DEFAULT_EXTENDED_ATTRIBUTE_TABLIST,
  renderApprovalActionJson,
  renderAssocFiles,
  renderAuditTrailJson,
  renderAvailableChangesets,
  renderDraftPromptData,
  renderImageSizeUrlJson,
  renderLoadCategoryAssignment,
  renderLoadCategoryFeatureStartStop,
  renderLoadClass,
  renderLoadClassConfigurator,
  renderLoadExtendedAttributes,
  renderLoadFileMetadata,
  renderStatusModal,
  renderTagArray,
  renderUpdateResponse,
  type AssocFileRow,
  type CategoryAssignmentModel,
  type DraftPromptModel,
  type DraftPromptVersion,
  type ExtendAttributeModel,
  type ExtendSetModel,
  type ExtendedAttributesModel,
  type FileMetadataModel,
  type LoadClassConfiguratorModel,
  type LoadClassModel,
  type ObjectClassData,
  type PanelDelegation,
  type PanelLayoutBody,
  type PanelRenderResult,
  type StatusModalModel,
  type UpdateResponseModel,
} from '../../src/legacy/admin-render-panels.js';
import { cfJsStringFormat } from '../../src/legacy/cfjson.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';

interface Recorded {
  request: string;
  status: number;
  contentType: string;
  body: string;
  scenario?: unknown;
  note?: string;
}

const RECORDED = (
  JSON.parse(readFileSync(new URL('../fixtures/legacy-admin-panels-recorded.json', import.meta.url), 'utf8')) as {
    responses: Record<string, Recorded>;
  }
).responses;

function recorded(name: string): Recorded {
  const entry = RECORDED[name];
  if (entry === undefined) throw new Error(`no recording ${name}`);
  return entry;
}

/** The recording's scenario, typed by the caller. */
function scenario<T>(name: string): T {
  return recorded(name).scenario as T;
}

/** The query parameters of a recorded admin request. */
function params(name: string): Record<string, string> {
  return Object.fromEntries(new URL(recorded(name).request, 'http://localhost').searchParams);
}

/** java.util.Properties for the ASCII bundles Masa ships: `key=value` lines, `#` comments, leading value spaces dropped. */
function readBundle(path: string): Record<string, string> {
  const bundle: Record<string, string> = {};
  for (const line of readFileSync(new URL(path, import.meta.url), 'utf8').split(/\r?\n/)) {
    if (line.trim() === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const at = line.indexOf('=');
    if (at > 0) bundle[line.slice(0, at).trim()] = line.slice(at + 1).replace(/^[ \t\f]+/, '');
  }
  return bundle;
}

const LABELS = createAdminLabels(readBundle('../../../../core/mura/resourceBundle/resources/en.properties'));
const HOME_ID = '00000000000000000000000000000000001';
const HOME_HIST = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const ADMIN_MEMBERSHIPS = 'S2IsPrivate;default,S2,Admin;default;0';

const SITE: LegacySiteUrlConfig = {
  siteId: 'default',
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

const SESSION: AdminSession = {
  userId: '7A3EC5B2-1B6E-4C2D-8F11D2C3B4A59687',
  siteId: 'default',
  memberships: ADMIN_MEMBERSHIPS,
  nextN: 20,
  dateKeyFormat: 'MM/DD/YYYY',
  rb: 'en',
  locale: 'en_US',
  openSectionList: '',
  flatViewArgs: {},
  copyContentId: '',
  copySiteId: '',
  copyAll: false,
};

interface ContextOverrides {
  session?: Partial<AdminSession>;
  hasLockableNodes?: boolean;
  csrf?: AdminRenderContext['csrf'];
}

/** The installed admin on the default site. */
function context(overrides: ContextOverrides = {}): AdminRenderContext {
  return {
    labels: LABELS,
    session: { ...SESSION, ...overrides.session },
    site: SITE,
    siteSettings: {
      locking: 'none',
      hasComments: true,
      hasLockableNodes: overrides.hasLockableNodes ?? false,
      privateUserPoolId: 'default',
      extranet: false,
    },
    config: { sortPermission: '', adminDir: '/admin', context: '' },
    csrf: overrides.csrf ?? ((ctx) => ({ token: `TEST-TOKEN-${ctx}`, expires: '260630120000000' })),
  };
}

/** `session.mura.memberships` of a scenario user. */
function memberships(isAdmin: boolean, isSuper: boolean): string {
  return [isAdmin ? 'Admin;default;0' : '', isSuper ? 'S2' : ''].filter((m) => m !== '').join(',');
}

/** A `yyyy-mm-dd HH:nn:ss` scenario time in the process time zone. */
function localTime(text: string): Date {
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = text.split(/[- :]/).map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}

/** A bare response, failing on a delegation or a layout body. */
function bare(result: PanelRenderResult | PanelDelegation | PanelLayoutBody): PanelRenderResult {
  if ('delegate' in result || 'layout' in result) throw new Error(`expected a bare response, got ${JSON.stringify(result)}`);
  return result;
}

/** The recorded status, content type and body, byte for byte. */
function expectRecorded(result: PanelRenderResult, name: string): void {
  const { status, contentType, body } = recorded(name);
  expect({ status: result.status, contentType: result.contentType, body: result.body }).toEqual({ status, contentType, body });
}

/** Ids in the order the recording's `createUUID()` calls produced them. */
function recordedIds(name: string): () => string {
  const ids = [...recorded(name).body.matchAll(/(?:"objectid":"|data-objectid="|'objectid':')([0-9A-F-]{35})/g)].map((m) => m[1] ?? '');
  return () => {
    const id = ids.shift();
    if (id === undefined) throw new Error('more ids requested than recorded');
    return id;
  };
}

describe('category assignment panels', () => {
  const model = (name: string): CategoryAssignmentModel => {
    const p = params(name);
    return {
      categoryAssignment: p.categoryAssignment ?? '',
      catTrim: p.catTrim ?? '',
      featureStart: p.featurestart ?? '',
      featureStop: p.featurestop ?? '',
      startHour: p.startHour ?? '',
      startMinute: p.startMinute ?? '',
      startDayPart: p.startDayPart ?? '',
      stopHour: p.stopHour ?? '',
      stopMinute: p.stopMinute ?? '',
      stopDayPart: p.stopDayPart ?? '',
      localeHasDayParts: true,
    };
  };

  it.each([
    'fss0',
    'fss1',
    'fss2',
    'fss2_blank',
    'fss2_startonly',
    'fss01',
    'fss1_0',
    'fss1e0',
    'fss1_5',
    'fss1dot',
    'fssneg0',
    'fss02',
  ])('renders loadcategoryfeaturestartstop as recorded in %s', (name) => {
    expectRecorded(renderLoadCategoryFeatureStartStop(model(name), context()), name);
  });

  it.each(['fss02_de_DE', 'fss2_ts_de_DE', 'fss02_en_GB', 'fss2_ts_en_GB'])(
    'renders loadcategoryfeaturestartstop as recorded under the session locale of %s',
    (name) => {
      const { sessionLocale, dateKeyFormat } = scenario<{ sessionLocale: string; dateKeyFormat: string }>(name);
      expectRecorded(renderLoadCategoryFeatureStartStop(model(name), context({ session: { locale: sessionLocale, dateKeyFormat } })), name);
    },
  );

  it.each(['catassign0', 'catassign1', 'catassign2', 'catassign2_12'])('renders loadcategoryassignment as recorded in %s', (name) => {
    expectRecorded(renderLoadCategoryAssignment(model(name), context()), name);
  });

  it('fails where legacy answers 500 for a feature start that is not a date', () => {
    expect(recorded('catassign2_bad').status).toBe(500);
    expect(() => renderLoadCategoryAssignment(model('catassign2_bad'), context())).toThrow('notadate');
  });

  it('offers 24 hours when the locale has no day parts', () => {
    const body = renderLoadCategoryAssignment({ ...model('catassign1'), localeHasDayParts: false }, context()).body;
    expect(body).toContain('<option value="23"');
    expect(body).not.toContain('startDayPart');
  });
});

const SYSTEM_OBJECTS = [
  ['category_nav', 'Category Navigation'],
  ['comments', 'Comment Form'],
  ['rater', 'Content Rater'],
  ['event_reminder_form', 'Event Reminder Form'],
  ['folder_nav', 'Folder Navigation'],
  ['forward_email', 'Forward Email'],
  ['goToFirstChild', 'Go To First Child'],
  ['multilevel_nav', 'Multi-Level Navigation'],
  ['peer_nav', 'Peer Navigation'],
  ['primary_nav', 'Primary Navigation'],
  ['related_content', 'Related Content'],
  ['seq_nav', 'Sequential Nav'],
  ['site_map', 'Site Map'],
  ['standard_nav', 'Standard Navigation'],
  ['sub_nav', 'Sub Navigation'],
  ['tag_cloud', 'Tag Cloud'],
  ['favorites', 'User Favorites'],
  ['user_tools', 'User Tools'],
].map(([object = '', name = '']) => ({ object, name }));

/** The rows seeded for the lc_* recordings; sections carry their raw `dspZoomText`. */
const SEEDED: ObjectClassData = {
  systemObjects: SYSTEM_OBJECTS,
  components: [{ contentid: 'B1A00001-0000-0000-0000000000000004', menutitle: 'Footer "Links"', title: 'Footer <Title>' }],
  forms: [{ contentid: 'B1A00001-0000-0000-0000000000000005', menutitle: 'Contact Us', responsechart: 1 }],
  mailingLists: [
    { mlid: 'B1A00003-0000-0000-0000000000000001', name: 'Newsletter <Weekly>' },
    { mlid: 'AF184253-F102-2CC8-4C535346AFB0D93C', name: 'Please Remove Me from All Lists' },
  ],
  localFeeds: [{ feedid: 'B1A00002-0000-0000-0000000000000001', name: 'Latest & Greatest' }],
  remoteFeeds: [{ feedid: 'B1A00002-0000-0000-0000000000000002', name: 'Masa "Blog"' }],
};
const SECTIONS: Record<string, ObjectClassData['sections']> = {
  folder: [{ contentid: 'B1A00001-0000-0000-0000000000000001', pathString: 'Home  > News & Events' }],
  calendar: [{ contentid: 'B1A00001-0000-0000-0000000000000002', pathString: 'Home  > Events <2026>' }],
  gallery: [{ contentid: 'B1A00001-0000-0000-0000000000000003', pathString: "Home  > Photo's" }],
};

function loadClassModel(name: string, data: ObjectClassData): LoadClassModel {
  const p = params(name);
  return {
    classid: p.classid ?? '',
    subclassid: p.subclassid ?? '',
    layoutManager: p.layoutmanager === 'true',
    siteId: p.siteid ?? '',
    contentId: p.contentid ?? '',
    parentId: p.parentid ?? '',
    contentHistId: p.contenthistid ?? '21252708-0B4C-AF86-FA00B580B269AB92',
    columnCount: 3,
    customObjectClassInclude: false,
    data,
    newId: recordedIds(name),
  };
}

describe('renderLoadClass', () => {
  it.each(['class_system', 'class_system_lm', 'class_component', 'class_none', 'class_folder'])(
    'renders %s of the installed site as recorded',
    (name) => {
      expectRecorded(bare(renderLoadClass(loadClassModel(name, { systemObjects: SYSTEM_OBJECTS, components: [], sections: [] }), context())), name);
    },
  );

  const seeded = Object.keys(RECORDED).filter((name) => name.startsWith('lc_'));
  it.each(seeded)('renders %s over the seeded rows as recorded', (name) => {
    const classid = (params(name).classid ?? '').toLowerCase();
    expectRecorded(bare(renderLoadClass(loadClassModel(name, { ...SEEDED, sections: SECTIONS[classid] ?? [] }), context())), name);
  });

  it.each(['collector_form_false', 'collector_form_true'])('renders %s, a data collector with its responses object, as recorded', (name) => {
    const forms = [{ contentid: 'B1A00001-0000-0000-0000000000000005', menutitle: 'Contact <Us>', responsechart: 0 }];
    expectRecorded(bare(renderLoadClass(loadClassModel(name, { ...SEEDED, forms }), context())), name);
  });

  it('leaves plugin classes and custom object-class includes to legacy', () => {
    const model = loadClassModel('class_system', SEEDED);
    expect(renderLoadClass({ ...model, classid: 'plugins' }, context())).toMatchObject({ delegate: 'legacy' });
    expect(renderLoadClass({ ...model, customObjectClassInclude: true }, context())).toMatchObject({ delegate: 'legacy' });
  });

  it('fails fast when the class list it needs was not loaded', () => {
    expect(() => renderLoadClass({ ...loadClassModel('class_component', {}) }, context())).toThrow('components');
  });
});

describe('renderLoadClassConfigurator', () => {
  const model = (overrides: Partial<LoadClassConfiguratorModel>): LoadClassConfiguratorModel => ({
    classid: 'login',
    container: '',
    allowOpenFeeds: false,
    useLayoutManager: false,
    displayObject: () => ({}),
    lookupDisplayObjectFile: () => '',
    ...overrides,
  });

  it.each([
    ['cfgnotice_login', model({})],
    ['cfgnotice_layout', model({ classid: 'search', container: 'layout' })],
  ])('renders the not-configurable notice as recorded in %s', (name, input) => {
    expectRecorded(bare(renderLoadClassConfigurator(input)), name);
  });

  it.each([
    ['an unregistered class, which legacy answers with a 500', model({ displayObject: () => undefined })],
    ['a configurator template', model({ lookupDisplayObjectFile: (suffix) => `/core/modules/v1/${suffix}` })],
    ['an external object', model({ displayObject: () => ({ external: true }), lookupDisplayObjectFile: (s) => (s === 'external/configurator.cfm' ? s : '') })],
    ['the legacy feed configurator', model({ classid: 'feed' })],
    ['the layout manager configurator', model({ useLayoutManager: true })],
  ])('delegates %s to legacy', (_, input) => {
    expect(renderLoadClassConfigurator(input)).toMatchObject({ delegate: 'legacy' });
  });

  it('maps aliased classes before the configurator lookup', () => {
    const seen: string[] = [];
    const lookup = (suffix: string): string => {
      seen.push(suffix);
      return '';
    };
    for (const classid of ['category_summary', 'form_responses', 'mailing_list_master', 'comments', 'sub_nav', 'a\\b/text']) {
      renderLoadClassConfigurator(model({ classid, lookupDisplayObjectFile: lookup }));
    }
    expect(seen).toEqual([
      'nav/configurator.cfm',
      'form/configurator.cfm',
      'mailing_list/configurator.cfm',
      'system/configurator.cfm',
      'nav/configurator.cfm',
      'text/configurator.cfm',
    ]);
  });
});

const attribute = (attributeid: number, name: string, label: string, type: string, o: Partial<ExtendAttributeModel> = {}): ExtendAttributeModel => ({
  attributeid,
  name,
  label,
  hint: '',
  type,
  required: 'false',
  validation: '',
  regex: '',
  message: '',
  defaultvalue: '',
  optionlist: '',
  optionlabellist: '',
  adminonly: 0,
  ...o,
});

/** The extend definitions seeded for the ext_* recordings (subtype Page/Default). */
const EXTEND_SETS: Record<string, readonly ExtendSetModel[]> = {
  Default: [
    {
      extendsetid: 'B1A00005-0000-0000-0000000000000011',
      categoryid: '',
      name: 'Details & <More>',
      attributes: [
        attribute(1, 'subtitle', 'Sub "title"', 'TextBox', { hint: 'Shown <below> & title', required: 'true', message: 'Please enter it', defaultvalue: 'Default & co' }),
        attribute(2, 'eventdate', 'Event Date', 'TextBox', { validation: 'Date' }),
        attribute(3, 'brandcolor', 'Brand Color', 'TextBox', { validation: 'Color', message: 'Pick one', defaultvalue: '#ff0000' }),
        attribute(4, 'zip', 'ZIP', 'TextBox', { validation: 'Regex', regex: '^[0-9]{5}$', message: 'Five digits' }),
        attribute(5, 'website', 'Website', 'TextBox', { validation: 'URL' }),
        attribute(6, 'notes', 'Notes', 'TextArea', { validation: 'Numeric', message: 'Numbers only', defaultvalue: 'line1\nline2 <b>' }),
        attribute(7, 'bodyextra', 'Body Extra', 'HTMLEditor', { defaultvalue: '<p>Hi</p>' }),
        attribute(8, 'sizex', 'Size', 'SelectBox', { message: 'Choose', defaultvalue: 'M', optionlist: 'S^M^L', optionlabellist: 'Small^Medium^Large' }),
        attribute(9, 'tagsx', 'Tags X', 'MultiSelectBox', { defaultvalue: 'a^c', optionlist: 'a^b^c' }),
        attribute(10, 'flag', 'Flag', 'RadioGroup', { defaultvalue: 'no', optionlist: 'yes^no' }),
        attribute(11, 'secretx', 'Secret', 'Hidden', { defaultvalue: 'hid' }),
        attribute(12, 'internal', 'Internal', 'TextBox', { defaultvalue: 'internal value', adminonly: 1 }),
      ],
    },
  ],
  Basic: [
    {
      extendsetid: 'B1A00005-0000-0000-0000000000000012',
      categoryid: 'CAT-1,CAT-2',
      name: 'Basic "Extras"',
      attributes: [attribute(13, 'teaser', 'Teaser', 'TextArea', { hint: 'Short' })],
    },
  ],
};

function extendedModel(overrides: Partial<ExtendedAttributesModel> = {}): ExtendedAttributesModel {
  return {
    setsByContainer: EXTEND_SETS,
    // `notes` is also a contentBean property, so the bean returns its empty value instead of useMuraDefault.
    values: { subtitle: 'Stored <value> & "q"', notes: '' },
    subtype: { hassummary: 0, hasbody: 1, hasassocfile: 0, hasconfigurator: 0 },
    razunaEnabled: false,
    ...overrides,
  };
}

/** JSON members as legacy holds them; ACF's struct iteration order is not part of the compared contract. */
function expectRecordedJson(result: PanelRenderResult, name: string): void {
  const rec = recorded(name);
  expect(result.contentType).toBe(rec.contentType);
  expect(JSON.parse(result.body)).toEqual(JSON.parse(rec.body));
}

describe('renderLoadExtendedAttributes', () => {
  it('renders a subtype without extend sets as recorded', () => {
    const model = extendedModel({ setsByContainer: {}, values: {}, subtype: { hassummary: 1, hasbody: 1, hasassocfile: 1, hasconfigurator: 0 }, tablist: 'tabBasic' });
    expectRecordedJson(bare(renderLoadExtendedAttributes(model, context())), 'extattr');
  });

  it.each([
    ['ext_default_tabs', ADMIN_MEMBERSHIPS],
    ['ext_tabbasic', ADMIN_MEMBERSHIPS],
    ['ext_custom_tabs', ADMIN_MEMBERSHIPS],
    ['editor_ext_default_tabs', 'Editor;default;0'],
    ['editor_ext_tabbasic', 'Editor;default;0'],
    ['editor_ext_custom_tabs', 'Editor;default;0'],
  ])('renders every attribute type as recorded in %s', (name, sessionMemberships) => {
    const tablist = params(name).tablist;
    const result = bare(renderLoadExtendedAttributes(extendedModel(tablist === undefined ? {} : { tablist }), context({ session: { memberships: sessionMemberships } })));
    expectRecordedJson(result, name);
    expect(result.muraSessionEffects).toEqual({ clearEditBean: true });
  });

  it('uses the default tab list when the request names none', () => {
    const keys = Object.keys(JSON.parse(bare(renderLoadExtendedAttributes(extendedModel(), context())).body) as object);
    for (const tab of DEFAULT_EXTENDED_ATTRIBUTE_TABLIST.split(',')) expect(keys).toContain(`${tab.toLowerCase()}top`);
  });

  it('offers the Razuna picker on URL attributes, quoted as mura.json escapes it (not valid JSON, as legacy)', () => {
    const body = bare(renderLoadExtendedAttributes(extendedModel({ razunaEnabled: true }), context())).body;
    expect(body).toContain("renderRazunaWindow(\\'website\\')");
    expect(() => JSON.parse(body) as unknown).toThrow(SyntaxError);
  });

  const only = (attr: ExtendAttributeModel): ExtendedAttributesModel =>
    extendedModel({ setsByContainer: { Default: [{ extendsetid: 'S', categoryid: '', name: 'S', attributes: [attr] }] }, values: {} });

  it.each([
    ['a datetime selector', attribute(1, 'when', 'When', 'TextBox', { validation: 'datetime' })],
    ['a file selector', attribute(1, 'doc', 'Doc', 'File')],
    ['a [mura] tag default', attribute(1, 'dyn', 'Dyn', 'TextBox', { defaultvalue: '[mura]now()[/mura]' })],
    ['[m] tags in an option list', attribute(1, 'opts', 'Opts', 'SelectBox', { optionlist: '[m]x[/m]^b' })],
  ])('leaves %s to legacy', (_, attr) => {
    expect(renderLoadExtendedAttributes(only(attr), context())).toMatchObject({ delegate: 'legacy' });
  });

  it('prints the stored value of an admin-only attribute as text for non-admins, even a datetime one', () => {
    const attr = attribute(1, 'when', 'When', 'TextBox', { validation: 'datetime', adminonly: 1 });
    const result = bare(renderLoadExtendedAttributes({ ...only(attr), values: { when: '2026-06-30' } }, context({ session: { memberships: '' } })));
    expect(JSON.parse(result.body).default).toContain('</label>\n\n\t\t\t\t\t\t\t\t2026-06-30');
  });

  it.each([
    ['a&b<c>d"e\'f\t\n\u0001\u001f\u007f\u0080\u00a0\u00e9\u00ff\u0100\u20ac/\\=;', 'a&amp;b&lt;c&gt;d&quot;e&apos;f\t\n\u0001\u001f\u007f\u0080&#xa0;&#xe9;&#xff;\u0100\u20ac/\\=;'],
    ['x\ry\r\nz', 'xy\nz'],
  ])('XML-formats attribute messages as ACF XMLFormat does (%#)', (message, expected) => {
    const attr = attribute(1, 'm', 'M', 'TextBox', { message });
    const body = bare(renderLoadExtendedAttributes(only(attr), context())).body;
    // The view strips [[:cntrl:]] from the encoded JSON; ACF's class is the ASCII controls only (captured).
    expect(body).toContain(cfJsStringFormat(`data-message="${expected}"`).replace(/[\u0000-\u001f\u007f]/g, ''));
  });

  it('fails as legacy does when a label list is shorter than its option list', () => {
    const attr = attribute(1, 'opts', 'Opts', 'RadioGroup', { optionlist: 'a^b', optionlabellist: 'A' });
    expect(() => renderLoadExtendedAttributes(only(attr), context())).toThrow('Invalid list index 2 of A');
  });
});

const LOGO: AssocFileRow = {
  fileid: 'B1A00007-0000-0000-0000000000000001',
  contentid: 'B1A00006-0000-0000-0000000000000001',
  fileext: 'png',
  assocfilename: 'logo <1>.png',
  perm: 'editor',
};
const GUIDE: AssocFileRow = {
  fileid: 'B1A00007-0000-0000-0000000000000002',
  contentid: 'B1A00006-0000-0000-0000000000000002',
  fileext: 'pdf',
  assocfilename: 'guide.pdf',
  perm: 'editor',
};
const PHOTO: AssocFileRow = {
  fileid: 'B1A00007-0000-0000-0000000000000003',
  contentid: 'B1A00006-0000-0000-0000000000000003',
  fileext: 'JPG',
  assocfilename: 'photo.JPG',
  perm: 'editor',
};
const HOME_ROW: AssocFileRow = { fileid: null, contentid: HOME_ID, fileext: null, assocfilename: null, perm: 'editor' };

describe('renderAssocFiles', () => {
  it.each([
    ['assoc', [HOME_ROW]],
    ['assoc_nokw', []],
    ['assoc_file_home', [HOME_ROW, LOGO, GUIDE, PHOTO]],
    ['assoc_image_home', [LOGO, PHOTO]],
    ['assoc_file_logo', [LOGO]],
  ])('renders %s as recorded', (name, rows) => {
    const p = params(name);
    expectRecorded(renderAssocFiles({ keywords: p.keywords ?? '', type: p.type ?? '', property: p.property ?? '', rows }, context()), name);
  });

  it('skips rows the user cannot read and lists a file once', () => {
    const rows: AssocFileRow[] = [{ ...LOGO, perm: 'none' }, GUIDE, { ...GUIDE, contentid: 'OTHER' }];
    const body = renderAssocFiles({ keywords: 'x', type: 'file', property: 'fileid', rows }, context()).body;
    expect(body).not.toContain(LOGO.fileid);
    expect(body.split(`value="${GUIDE.fileid ?? ''}"`)).toHaveLength(2);
  });
});

describe('renderLoadFileMetadata', () => {
  const blank = { caption: '', credits: '', alttext: '', remoteid: '', remoteurl: '', remotesource: '', remotesourceurl: '', exif: '' };
  it.each<[string, FileMetadataModel]>([
    ['filemeta', { meta: { fileid: '', ...blank }, fileExt: '' }],
    [
      'filemeta_img',
      {
        meta: {
          fileid: LOGO.fileid,
          caption: 'Logo "caption" & more',
          credits: 'Credit <me>',
          alttext: 'Alt & text',
          remoteid: 'R-1',
          remoteurl: 'https://example.com/r?a=1&b=2',
          remotesource: 'Src',
          remotesourceurl: 'https://example.com/s',
          exif: '{"GPS Latitude":"52.5 N","GPS Altitude":120.5,"Make":"Cam"}',
        },
        fileExt: 'png',
      },
    ],
    ['filemeta_pdf', { meta: { fileid: GUIDE.fileid, ...blank }, fileExt: 'pdf' }],
    ['filemeta_jpg', { meta: { fileid: PHOTO.fileid, ...blank }, fileExt: 'JPG' }],
    ['filemeta_stored', { meta: { fileid: PHOTO.fileid, ...blank, caption: 'Stored caption', remoteid: 'R-2', exif: '{"GPS Longitude":"13.4 E"}' }, fileExt: 'JPG' }],
  ])('renders %s as recorded', (name, model) => {
    expectRecorded(renderLoadFileMetadata(model, context()), name);
  });

  it('fails on EXIF data that is not a JSON object of simple values', () => {
    const meta = { fileid: 'F', ...blank };
    expect(() => renderLoadFileMetadata({ meta: { ...meta, exif: '[1]' }, fileExt: 'pdf' }, context())).toThrow('JSON object');
    expect(() => renderLoadFileMetadata({ meta: { ...meta, exif: '{"GPS Altitude":{}}' }, fileExt: 'pdf' }, context())).toThrow('simple value');
  });
});

describe('renderAvailableChangesets', () => {
  const rows = [
    { changesetid: 'B1A00008-0000-0000-0000000000000002', name: 'Fall & "Sale"' },
    { changesetid: 'B1A00008-0000-0000-0000000000000001', name: 'Spring <Launch>' },
  ];
  it.each([
    ['changesets', '', '', []],
    ['changesets_rows', '', '', rows],
    ['changesets_current', 'B1A00008-0000-0000-0000000000000002', 'Fall & "Sale"', rows],
    ['changesets_unknown', 'NOPE', '', rows],
  ])('renders %s as recorded', (name, changesetId, currentChangesetName, changesets) => {
    expectRecorded(renderAvailableChangesets({ changesetId, currentChangesetName, changesets, hasChangesetModulePerm: true }, context()), name);
  });

  it('omits the picker without open change sets or the change-set module permission', () => {
    const body = renderAvailableChangesets({ changesetId: '', currentChangesetName: '', changesets: [], hasChangesetModulePerm: false }, context()).body;
    expect(body).not.toContain('_changesetID');
  });
});

interface StatusScenario {
  mode: string;
  content: { active: number; approved: number; lastupdate: string; approvalStatus: string; changesetid: string };
  lockType: string;
  requiresApproval: boolean;
  showApprovalStatus: boolean;
  user: { isNew: boolean; fullName: string };
  approval: { status: string; groupid: string; userid: string; requestid: string; siteid: string };
  group: { type: number; groupName: string; fullName: string };
  actions: Array<{ actionType: string; comments: string; created: string; userFullName: string }>;
  hasLockableNodes: boolean;
  hasChangesets: boolean;
  changeset: { isNew: boolean; name: string };
  lockedBy: { fname: string; lname: string; email: string };
  membershipids: string;
  isAdmin: boolean;
  isSuper: boolean;
  userid: string;
  resourcePath: string;
}

function statusModel(s: StatusScenario): StatusModalModel {
  return {
    mode: s.mode,
    content: { ...s.content, lastupdate: localTime(s.content.lastupdate) },
    user: s.user,
    requiresApproval: s.requiresApproval,
    showApprovalStatus: s.showApprovalStatus,
    approval: {
      request: s.approval,
      group: s.group,
      actions: s.actions.map((a) => ({ actiontype: a.actionType, comments: a.comments, created: localTime(a.created), userFullName: a.userFullName })),
    },
    lockType: s.lockType,
    lockedBy: s.lockedBy,
    hasChangesets: s.hasChangesets,
    changesetName: s.changeset.isNew ? undefined : s.changeset.name,
    membershipIds: s.membershipids,
    resourcePath: s.resourcePath,
  };
}

describe('renderStatusModal', () => {
  const home: StatusModalModel = {
    mode: '',
    content: { active: 1, approved: 1, lastupdate: new Date(2026, 10, 10, 9, 6, 12), changesetid: null, approvalStatus: '' },
    user: { isNew: true, fullName: '' },
    requiresApproval: false,
    showApprovalStatus: false,
    lockType: '',
    hasChangesets: true,
    changesetName: undefined,
    membershipIds: '',
    resourcePath: '',
  };

  it('renders the published home version as recorded', () => {
    expectRecorded(bare(renderStatusModal(home, context())), 'status');
  });

  // ACF 2023 LSDateFormat(date, dateKeyFormat) and LSTimeFormat(date, 'short') after setLocale(locale).
  it.each([
    { locale: 'de_DE', dateKeyFormat: 'DD.MM.YYYY', created: '314.11.2026<br />\n\t\t\t09:06' },
    { locale: 'en_GB', dateKeyFormat: 'DD/MM/YYYY', created: '314/11/2026<br />\n\t\t\t09:06' },
  ])('prints the created-on date and time under the $locale session', ({ locale, dateKeyFormat, created }) => {
    const body = bare(renderStatusModal(home, context({ session: { locale, dateKeyFormat } }))).body;
    expect(body).toBe(recorded('status').body.replace('11/314/2026<br />\n\t\t\t9:06 AM', created));
  });

  const names = Object.keys(RECORDED).filter((name) => name.startsWith('sm_'));
  it.each(names)('renders %s as recorded', (name) => {
    const s = scenario<StatusScenario>(name);
    const ctx = context({ session: { userId: s.userid, memberships: memberships(s.isAdmin, s.isSuper) }, hasLockableNodes: s.hasLockableNodes });
    const result = renderStatusModal(statusModel(s), ctx);
    if (s.mode === 'frontend') {
      expect(result).toEqual({ layout: true, body: recorded(name).body });
    } else {
      expectRecorded(bare(result), name);
    }
  });

  it('requires the approval request wherever approval applies', () => {
    const s = scenario<StatusScenario>('sm_pending_group_approver');
    const { approval: _, ...model } = statusModel(s);
    expect(() => renderStatusModal(model, context())).toThrow('approval');
  });
});

interface DraftScenario {
  verdict: string;
  hasdraft: boolean;
  hasdraftpending: boolean;
  historyid: string;
  publishedhistoryid: string;
  lockid: string;
  locktype: string;
  pending: Array<{ contenthistid: string; changesetName: string; lastupdate: string; lastupdateby: string }>;
  approvals: Array<{ contenthistid: string; menutitle: string; lastupdate: string; lastupdateby: string }>;
  lockable: boolean;
  userid: string;
  isSuper: boolean;
  isAdmin: boolean;
  targetversion?: string;
  pub: { approved: number; menutitle: string; lastupdate: string; lastupdateby: string };
  draft: { approved: number; menutitle: string; lastupdate: string; lastupdateby: string };
  lockedBy: { fname: string; lname: string; email: string };
}

const version = (v: DraftScenario['pub']): DraftPromptVersion => ({ ...v, lastupdate: localTime(v.lastupdate) });

function draftModel(s: DraftScenario): DraftPromptModel {
  return {
    data: {
      verdict: s.verdict,
      publishedHistoryId: s.publishedhistoryid,
      hasDraft: s.hasdraft,
      hasDraftPending: s.hasdraftpending,
      historyId: s.hasdraft ? s.historyid : '',
      lockId: s.lockid,
      lockType: s.locktype,
      pendingChangesets: s.pending.map((r) => ({ contenthistid: r.contenthistid, title: r.changesetName, lastupdate: localTime(r.lastupdate), lastupdateby: r.lastupdateby })),
      yourApprovals: s.approvals.map((r) => ({ contenthistid: r.contenthistid, title: r.menutitle, lastupdate: localTime(r.lastupdate), lastupdateby: r.lastupdateby })),
    },
    targetVersion: s.targetversion ?? 'false',
    publishedVersion: version(s.pub),
    draftVersion: version(s.draft),
    lockedBy: s.lockedBy,
    content: { filename: '' },
  };
}

describe('renderDraftPromptData', () => {
  it('renders a published version without drafts as recorded', () => {
    const model: DraftPromptModel = {
      data: {
        verdict: 'editor',
        publishedHistoryId: HOME_HIST,
        hasDraft: false,
        hasDraftPending: false,
        historyId: '',
        lockId: '',
        lockType: '',
        pendingChangesets: [],
        yourApprovals: [],
      },
      targetVersion: 'false',
      publishedVersion: { approved: 1, menutitle: 'Home', lastupdate: new Date(2026, 10, 10, 9, 6, 12), lastupdateby: 'Admin' },
      content: { filename: '' },
    };
    expectRecorded(renderDraftPromptData(model, context()), 'draft');
  });

  const names = Object.keys(RECORDED).filter((name) => name.startsWith('dp_'));
  it.each(names)('renders %s as recorded', (name) => {
    const s = scenario<DraftScenario>(name);
    const ctx = context({ session: { userId: s.userid, memberships: memberships(s.isAdmin, s.isSuper) }, hasLockableNodes: s.lockable });
    expectRecorded(renderDraftPromptData(draftModel(s), ctx), name);
  });

  it('requires the draft version whenever a draft exists', () => {
    const { draftVersion: _, ...model } = draftModel(scenario<DraftScenario>('dp_hasdraft_editor'));
    expect(() => renderDraftPromptData(model, context())).toThrow('draftVersion');
  });
});

interface UpdateScenario {
  errors: { titleconflict?: string; filename?: string };
  active: number;
  onDisplay: boolean;
  contenthistid: string;
  contentid: string;
  type: string;
  ajax: boolean;
  action: string;
  href: string;
  proxyLoc: string;
  lm: boolean;
  instanceId?: string;
}

describe('renderUpdateResponse', () => {
  it('renders the ajax success location as recorded', () => {
    const model: UpdateResponseModel = {
      qqfile: false,
      ajaxRequest: true,
      action: 'update',
      content: { filename: 'about', contenthistid: HOME_HIST, active: 1, isOnDisplay: true },
      errors: {},
    };
    const ctx = { ...context(), site: { ...SITE, siteIdInUrls: true } };
    expectRecorded(bare(renderUpdateResponse(model, ctx)), 'updateAjaxSuccess');
  });

  const names = Object.keys(RECORDED).filter((name) => name.startsWith('up_'));
  it.each(names)('renders %s as recorded', (name) => {
    const s = scenario<UpdateScenario>(name);
    const errors: Record<string, string> = {};
    // update.cfm serializes getErrors(): keys legacy set by dot notation print upper-cased.
    if (s.errors.titleconflict !== undefined) errors.TITLECONFLICT = s.errors.titleconflict;
    if (s.errors.filename !== undefined) errors.filename = s.errors.filename;
    const model: UpdateResponseModel = {
      qqfile: name === 'up_qqfile',
      ajaxRequest: s.ajax,
      action: s.action,
      content: { filename: '', contenthistid: s.contenthistid, active: s.active, isOnDisplay: s.onDisplay },
      errors,
      close: {
        href: s.href,
        type: s.type,
        contentId: s.contentid,
        coreVersion: '7.6.1',
        frontEndProxyLoc: s.proxyLoc,
        objectInstanceId: s.instanceId ?? '',
        useLayoutManager: s.lm,
      },
    };
    const expires = /csrf_token_expires: '(\d+)'/.exec(recorded(name).body)?.[1] ?? '';
    const csrf = (ctx: string) => {
      expect(ctx).toBe(`${s.contenthistid}add`);
      return { token: 'REDACTED_CSRF_TOKEN', expires };
    };
    const result = bare(renderUpdateResponse(model, context({ csrf })));
    expectRecorded(result, name);
    if (name.startsWith('up_close')) expect(result.muraSessionEffects).toEqual({ clearEditBean: true, objectInstanceId: '' });
  });

  const failed = { qqfile: false, ajaxRequest: false, action: 'update', content: { filename: '', contenthistid: 'H', active: 0, isOnDisplay: false } };
  it('hands a failed non-ajax save to the edit page', () => {
    expect(renderUpdateResponse({ ...failed, errors: { TITLECONFLICT: 'x' } }, context())).toMatchObject({ delegate: 'edit-page' });
  });

  it('requires the close-page inputs after a successful non-ajax save', () => {
    expect(() => renderUpdateResponse({ ...failed, errors: {} }, context())).toThrow('close');
  });
});

describe('JSON and literal responses', () => {
  it.each([
    ['tags', []],
    ['tags_one', ['solo']],
    ['tags_carch', scenario<string[]>('tags_carch')],
  ])('renders the carch tag array %s as recorded', (name, tags) => {
    expectRecorded(renderTagArray(tags), name);
  });

  it.each([
    ['cstags', []],
    ['tags_cs', scenario<string[]>('tags_cs')],
  ])('renders the change-set tag array %s as recorded', (name, tags) => {
    expectRecorded(renderTagArray(tags, 'cchangesets'), name);
  });

  it('renders the audit trail and image size URL as recorded', () => {
    expectRecorded(renderAuditTrailJson([HOME_HIST]), 'audit');
    expectRecorded(renderImageSizeUrlJson(''), 'imgsize');
  });

  it('renders the approval action JSON as recorded', () => {
    expectRecorded(renderApprovalActionJson({ contenthistid: HOME_HIST, previewUrl: `/index.cfm/default/?previewid=${HOME_HIST}` }), 'approvalAction');
  });
});
