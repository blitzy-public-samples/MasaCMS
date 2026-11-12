// carch quick-edit and related-content fragments against legacy responses captured from Masa 7.6.1 on ACF 2023.0.26
// (site `default` with seeded pages, a calendar event, a drafted page and a Page/Rich subtype with two related sets).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RELATED_CONTENT_SET,
  displayIntervalValues,
  relatedItemsOf,
  renderLoadQuickEdit,
  renderLoadRelatedContent,
  renderLoadSelectedRelatedContent,
  type CategoryNode,
  type LoadRelatedContentModel,
  type LoadSelectedRelatedContentModel,
  type QuickEditModel,
  type RelatedContentItem,
  type RelatedContentSetView,
  type RelatedSearchItem,
  type SubTypeView,
} from '../../src/legacy/admin-render-edit.js';
import {
  buildCustomIconLookup,
  createAdminLabels,
  type AdminRenderContext,
  type ZoomCrumb,
} from '../../src/legacy/admin-markup.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/legacy-admin-edit/${name}.html`, import.meta.url), 'utf8');

/** java.util.Properties for the resource bundle lines the views use: `key=value`, `#` comments, `\uXXXX` escapes. */
function readProperties(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(new URL(path, import.meta.url), 'utf8').split(/\r?\n/)) {
    if (line.trim() === '' || /^\s*[#!]/.test(line)) continue;
    const at = line.indexOf('=');
    if (at < 0) continue;
    out[line.slice(0, at).trim()] = line
      .slice(at + 1)
      .trimStart()
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return out;
}

const ctx: AdminRenderContext = {
  labels: createAdminLabels(readProperties('../../../../core/mura/resourceBundle/resources/en.properties')),
  session: {
    userId: 'ADMIN',
    siteId: 'default',
    memberships: 'S2IsPrivate;default,S2',
    nextN: 20,
    dateKeyFormat: 'MM/DD/YYYY',
    rb: 'en_US',
    locale: 'en_US',
    openSectionList: '',
    flatViewArgs: {},
    copyContentId: '',
    copySiteId: '',
    copyAll: false,
  },
  site: { siteId: 'default' } as LegacySiteUrlConfig,
  siteSettings: { locking: 'none', hasComments: true, hasLockableNodes: false, privateUserPoolId: 'default', extranet: false },
  config: { sortPermission: '', adminDir: '/admin', context: '' },
  csrf: () => ({ token: 'T', expires: 'E' }),
};

const HOME = '00000000000000000000000000000000001';
const ID = {
  alpha: '215F25F6-B164-9E83-F9C54A337B16F8EE',
  folder: '215F33CB-C6E8-1314-7F7582003A5E6D30',
  gamma: '215F37C0-E138-DCD8-6EAF3DDABC2233D8',
  events: '215F3BA0-9E36-1C28-892F0454A97FFF90',
  launch: '215F3F3F-9C03-D914-162831E91AD1034B',
  scheduled: '215F4313-CE64-5D7F-7D141D12F553C0E5',
  delta: '215F4677-F395-109A-9FD729056D011CFC',
  rich: '215F4EBC-AE36-8E7E-0E926262B6AE3F51',
  featured: '215F1EAE-05C5-6F01-27E0521C0FF006FD',
  others: '215F242D-C6FC-5030-8EBE08E61AAC0DD6',
  news: '215F1A1E-C4F2-7C20-016C6115B380F65C',
  local: '215F1B7F-A5EA-5884-F7A93044DDED9312',
  archive: '215F1D95-FA1F-5D94-608E00445934B45C',
};
const TEMPLATES = ['blank.cfm', 'default.cfm', 'home.cfm', 'one_column.cfm', 'three_column.cfm', 'two_column_SL.cfm', 'two_column_SR.cfm'];
const NOW = new Date(2026, 10, 12, 14, 30, 0);
const LAUNCH_INTERVAL =
  '{"DAYSOFWEEK":"2,4","ALLDAY":0,"END":"on","ENDON":"September, 30 2026 00:00:00","TIMEZONE":"Etc/UTC","REPEATS":1,' +
  '"TYPE":"weekly","DETECTCONFLICTS":0,"DETECTSPAN":12,"EVERY":2}';

const crumb = (contentid: string, type: string, menutitle: string): ZoomCrumb => ({
  siteid: 'default',
  contentid,
  type,
  subtype: 'Default',
  menutitle,
  restricted: 0,
});
const HOME_CRUMB = crumb(HOME, 'Page', 'Home');
const CRUMBS: Readonly<Record<string, readonly ZoomCrumb[]>> = {
  [ID.alpha]: [crumb(ID.alpha, 'Page', 'Alpha Page'), HOME_CRUMB],
  [ID.folder]: [crumb(ID.folder, 'Folder', 'Beta Folder'), HOME_CRUMB],
  [ID.gamma]: [crumb(ID.gamma, 'Page', 'Gamma alpha child'), crumb(ID.folder, 'Folder', 'Beta Folder'), HOME_CRUMB],
  [ID.events]: [crumb(ID.events, 'Calendar', 'Events'), HOME_CRUMB],
  [ID.launch]: [crumb(ID.launch, 'Page', 'Launch Event'), crumb(ID.events, 'Calendar', 'Events'), HOME_CRUMB],
  [ID.scheduled]: [crumb(ID.scheduled, 'Page', 'Scheduled Page'), HOME_CRUMB],
  [ID.delta]: [crumb(ID.delta, 'Page', 'Delta Drafted'), HOME_CRUMB],
};
const SUBTYPES: readonly SubTypeView[] = [{ type: 'Page', subtype: 'Rich', iconclass: 'mi-star', adminonly: 0 }];
const customIcons = buildCustomIconLookup(SUBTYPES.map((r) => ({ ...r, siteid: 'default' })));

const item = (contentid: string, type: string): RelatedContentItem => ({
  contentid,
  siteid: 'default',
  type,
  subtype: 'Default',
  crumbs: CRUMBS[contentid] ?? [],
});
const searchItem = (contentid: string, type: string): RelatedSearchItem => ({ ...item(contentid, type), verdict: 'editor' });

interface Node {
  display: number;
  isnav: number;
  inheritobjects: string;
  template: string | null;
  childtemplate: string | null;
  displayinterval: string | null;
  start: Date | null;
  stop: Date | null;
  parentType: string;
}
const NODES: Readonly<Record<string, Node>> = {
  home: { display: 1, isnav: 1, inheritobjects: 'Cascade', template: 'default.cfm', childtemplate: null, displayinterval: null, start: null, stop: null, parentType: '' },
  alpha: { display: 1, isnav: 1, inheritobjects: 'Inherit', template: null, childtemplate: null, displayinterval: 'Daily', start: null, stop: null, parentType: 'Page' },
  gamma: { display: 0, isnav: 0, inheritobjects: 'Reject', template: 'one_column.cfm', childtemplate: 'blank.cfm', displayinterval: 'Daily', start: null, stop: null, parentType: 'Folder' },
  ev: {
    display: 2,
    isnav: 1,
    inheritobjects: 'Inherit',
    template: null,
    childtemplate: null,
    displayinterval: LAUNCH_INTERVAL,
    start: new Date(2026, 6, 4, 9, 30, 0),
    stop: new Date(2026, 8, 30, 17, 45, 0),
    parentType: 'Calendar',
  },
  sched: {
    display: 2,
    isnav: 1,
    inheritobjects: 'Inherit',
    template: null,
    childtemplate: null,
    displayinterval: 'Daily',
    start: new Date(2026, 2, 1, 13, 5, 0),
    stop: new Date(2127, 0, 1, 23, 59, 0),
    parentType: 'Page',
  },
};
const NODE_IDS: Readonly<Record<string, string>> = { home: HOME, alpha: ID.alpha, gamma: ID.gamma, ev: ID.launch, sched: ID.scheduled };

function quickEdit(node: string, attribute: string, over: Partial<QuickEditModel> = {}): QuickEditModel {
  const n = NODES[node] as Node;
  return {
    attribute,
    contentId: NODE_IDS[node] as string,
    hasDrafts: false,
    content: {
      isnav: n.isnav,
      inheritobjects: n.inheritobjects,
      template: n.template,
      childtemplate: n.childtemplate,
      display: n.display,
      displayinterval: n.displayinterval,
    },
    displayStart: n.start,
    displayStop: n.stop,
    displayInterval: displayIntervalValues(n.displayinterval, n.start, n.stop, 'Etc/UTC', 'en_US'),
    parentType: n.parentType,
    requestPtype: 'Page',
    templates: TEMPLATES,
    localeHasDayParts: true,
    tzRegex: '',
    defaultTimeZone: 'Etc/UTC',
    availableTimeZones: [],
    now: NOW,
    ...over,
  };
}

describe('renderLoadQuickEdit', () => {
  it.each([
    ['qe-home-isnav', 'home', 'isnav'],
    ['qe-home-inheritObjects', 'home', 'inheritObjects'],
    ['qe-home-template', 'home', 'template'],
    ['qe-home-target', 'home', 'target'],
    ['qe-alpha-template', 'alpha', 'template'],
    ['qe-gamma-isnav', 'gamma', 'isnav'],
    ['qe-gamma-inheritObjects', 'gamma', 'inheritObjects'],
    ['qe-gamma-template', 'gamma', 'template'],
    ['qe-alpha-display', 'alpha', 'display'],
    ['qe-ev-display', 'ev', 'display'],
    ['qe-sched-display', 'sched', 'display'],
  ])('reproduces %s', (name, node, attribute) => {
    const out = renderLoadQuickEdit(quickEdit(node, attribute), ctx);
    expect(out.status).toBe(200);
    expect(out.contentType).toBe('text/html;charset=UTF-8');
    expect(out.body).toBe(fixture(name));
  });

  it('keeps the request ptype for the home node (rs.ptype quirk)', () => {
    expect(renderLoadQuickEdit(quickEdit('home', 'display', { requestPtype: 'Calendar' }), ctx).body).toBe(
      fixture('qe-home-display-ptype'),
    );
  });

  // ACF 2023 LSDateFormat(date, session.dateKeyFormat) after setLocale(locale); the recording is en_US's.
  it.each([
    { locale: 'de_DE', dateKeyFormat: 'DD.MM.YYYY', start: '185.07.2026', stop: '273.09.2026' },
    { locale: 'en_GB', dateKeyFormat: 'DD/MM/YYYY', start: '185/07/2026', stop: '273/09/2026' },
  ])('prints the schedule dates under the $locale session', ({ locale, dateKeyFormat, start, stop }) => {
    const body = renderLoadQuickEdit(quickEdit('ev', 'display'), { ...ctx, session: { ...ctx.session, locale, dateKeyFormat } }).body;
    expect(body).toBe(fixture('qe-ev-display').replace('07/185/2026', start).replaceAll('09/273/2026', stop));
  });

  it('answers the drafts notice for a node with drafts', () => {
    expect(renderLoadQuickEdit(quickEdit('alpha', 'display', { hasDrafts: true }), ctx).body).toBe(fixture('qe-delta-display'));
  });

  it('lists the time zones matching tzRegex and the 24-hour selects of locales without day parts', () => {
    const body = renderLoadQuickEdit(
      quickEdit('ev', 'display', {
        tzRegex: '^America/',
        availableTimeZones: ['Europe/Paris', 'America/New_York', 'Etc/UTC', 'America/Chicago'],
        localeHasDayParts: false,
        quickEditScheduler: true,
        displayInterval: { ...displayIntervalValues(LAUNCH_INTERVAL, null, null, 'Etc/UTC', 'en_US'), timezone: 'America/New_York' },
      }),
      ctx,
    ).body;
    expect(body).toContain(
      '<div id="mura-tz-container" class="mura-control-group" style="display:none">\n\t\t\t\t<label>Timezone</label>\n\t\t\t\t\n' +
        '\t\t\t\t<select name="displayIntervalTZ" id="displayIntervalTZ" class="mura-repeat-option">\n\t\t\t\t\t<option value="Etc/UTC">' +
        '\n\t\t\t\t\t\tDefault (Etc/UTC)\n\t\t\t\t\t</option>\n\t\t\t\t\t\n\t\t\t\t\t\t\t<option value="America/Chicago">America/Chicago</option>' +
        '\n\t\t\t\t\t\t\n\t\t\t\t\t\t\t<option value="America/New_York" selected >America/New_York</option>\n\t\t\t\t\t\t\n\t\t\t\t</select>',
    );
    expect(body).toContain('<select  id="mura-displayStartHour" class="time mura-datepickerdisplayStart" name=""><option value="0" >0</option>');
    expect(body).toContain('<option value="9" selected>9</option>');
    expect(body).not.toContain('<select id="mura-displayStartDayPart"');
    expect(body).toContain("onchange=\"javascript: this.selectedIndex==2?toggleDisplay2('editDates',true):toggleDisplay2");
    expect(body).toContain('<div id="editDates" style="display: none;">');
    expect(body).toContain("\t\t\t\t\t$('.mura-quickEdit').addClass(\"large\");");
    expect(body).toContain("\t\t\t\t\t$('#mura-displayStartHour').val('0');");
  });
});

describe('displayIntervalValues', () => {
  it('reads the stored JSON with CFML key case and parses the end date', () => {
    const v = displayIntervalValues(LAUNCH_INTERVAL, null, null, 'Etc/UTC', 'en_US');
    expect(v).toMatchObject({ type: 'weekly', every: 2, repeats: 1, allday: 0, end: 'on', endafter: '1', daysofweek: '2,4', timezone: 'Etc/UTC' });
    expect(v.endon).toEqual(new Date(2026, 8, 30));
  });

  it.each([
    [null, null, null, { type: 'daily', end: 'never', endon: '', repeats: 1, every: 1, daysofweek: '' }],
    ['Weekly', new Date(2026, 6, 4), new Date(2026, 6, 5), { type: 'Weekly', end: 'on', endon: new Date(2026, 6, 5), daysofweek: '7' }],
    ['{"type":"daily","every":0,"allday":1,"timezone":"Europe/Paris"}', null, null, { repeats: 0, every: 1, timezone: 'Etc/UTC' }],
    ['{"type":"monthly","daysofweek":"3","endon":"2026-01-02T10:00:00","end":"on"}', null, null, { daysofweek: '3', endon: new Date(2026, 0, 2, 10) }],
    ['{"type":"weekly","endon":"soon","end":"on"}', null, null, { endon: '', daysofweek: '' }],
  ])('deserializes %j', (raw, start, stop, expected) => {
    expect(displayIntervalValues(raw, start, stop, 'Etc/UTC', 'en_US')).toMatchObject(expected);
  });

  // ACF 2023 cfobject.parseDateArg(endon) after setLocale(locale); '' where it reads no date.
  const OCT_29 = new Date(2026, 9, 29);
  const ENDON_ACF: readonly (readonly [text: string, de_DE: Date | '', en_GB: Date | '', en_US: Date | ''])[] = [
    ['29.10.2026', OCT_29, OCT_29, OCT_29],
    ['10/29/2026', OCT_29, OCT_29, OCT_29],
    ['29/10/2026', OCT_29, OCT_29, OCT_29],
    ['2026-10-29T00:00:00', OCT_29, OCT_29, OCT_29],
    ['2026-10-29', OCT_29, OCT_29, OCT_29],
    ['x', '', '', ''],
    ['05/06/2026', new Date(2026, 5, 5), new Date(2026, 5, 5), new Date(2026, 4, 6)],
    ['29. Oktober 2026', OCT_29, '', ''],
    ['10/29/2026 2:30 PM', new Date(2026, 9, 29, 14, 30), new Date(2026, 9, 29, 14, 30), new Date(2026, 9, 29, 14, 30)],
  ];
  it.each(
    ENDON_ACF.flatMap(([text, ...byLocale]) =>
      (['de_DE', 'en_GB', 'en_US'] as const).map((locale, i) => ({ text, locale, expected: byLocale[i] })),
    ),
  )('reads endon $text under the $locale session as ACF does', ({ text, locale, expected }) => {
    const interval = JSON.stringify({ type: 'daily', end: 'on', endon: text });
    expect(displayIntervalValues(interval, null, null, 'Etc/UTC', locale).endon).toEqual(expected);
  });

  it('fails where CFML cannot read the interval as a struct', () => {
    expect(() => displayIntervalValues('[1]', null, null, 'Etc/UTC', 'en_US')).toThrow(TypeError);
  });
});

const RICH_SETS: readonly RelatedContentSetView[] = [
  { relatedcontentsetid: ID.featured, name: 'Featured <Picks>', entitytype: 'content', availablesubtypes: 'Page/Default,Folder/Default', displayName: 'Content' },
  { relatedcontentsetid: ID.others, name: 'Others', entitytype: 'content', availablesubtypes: '', displayName: 'Content' },
  DEFAULT_RELATED_CONTENT_SET,
];
const CATEGORIES: readonly CategoryNode[] = [
  { categoryid: ID.archive, name: 'Archive', isopen: 0, children: [] },
  { categoryid: ID.news, name: 'News & Views', isopen: 1, children: [{ categoryid: ID.local, name: 'Local', isopen: 1, children: [] }] },
];
const ALL_RESULTS: readonly RelatedSearchItem[] = [
  searchItem(ID.delta, 'Page'),
  searchItem(ID.scheduled, 'Page'),
  searchItem(ID.launch, 'Page'),
  searchItem(ID.events, 'Calendar'),
  searchItem(ID.gamma, 'Page'),
  searchItem(ID.folder, 'Folder'),
  searchItem(ID.alpha, 'Page'),
];

function related(over: Partial<LoadRelatedContentModel> = {}): LoadRelatedContentModel {
  return {
    siteId: 'default',
    isNew: true,
    keywords: '',
    searchTypeSelector: '',
    relatedContentSetId: '',
    rcStartDate: '',
    rcEndDate: '',
    rcCategoryId: '',
    external: true,
    entityType: 'content',
    relatedContentSets: [DEFAULT_RELATED_CONTENT_SET],
    subTypes: SUBTYPES,
    categories: CATEGORIES,
    contentPoolId: 'default',
    siteNames: { default: 'Default', b: 'Site B' },
    customIcons,
    ...over,
  };
}

describe('renderLoadRelatedContent', () => {
  it.each([
    ['rc-new', related()],
    ['rc-new-rich', related({ relatedContentSets: RICH_SETS })],
    [
      'rc-new-cal',
      related({
        external: false,
        relatedContentSetId: 'calendar',
        rcCategoryId: ID.local,
        keywords: 'a"b',
        searchTypeSelector: 'Page^Default',
        rcStartDate: '01/02/2026',
      }),
    ],
    ['rc-alpha', related({ isNew: false, keywords: 'alpha', results: [searchItem(ID.gamma, 'Page'), searchItem(ID.alpha, 'Page')] })],
    ['rc-all', related({ isNew: false, results: ALL_RESULTS })],
    ['rc-type', related({ isNew: false, searchTypeSelector: 'Folder^Default', results: [searchItem(ID.folder, 'Folder')] })],
    ['rc-calset', related({ isNew: false, relatedContentSetId: 'calendar', results: [searchItem(ID.events, 'Calendar')] })],
  ])('reproduces %s', (name, model) => {
    const out = renderLoadRelatedContent(model, ctx);
    expect(out.contentType).toBe('text/html;charset=UTF-8');
    expect(out.body).toBe(fixture(name));
  });

  it('prints content-pool results, hidden rows and the no-results item', () => {
    const body = renderLoadRelatedContent(
      related({
        isNew: false,
        keywords: 'alpha',
        contentPoolId: 'default,b',
        results: [{ ...searchItem(ID.alpha, 'Page'), verdict: 'none' }],
        poolResults: { B: [searchItem(ID.folder, 'Folder')] },
      }),
      ctx,
    ).body;
    expect(body).toContain('<div class="list-table-content-set">\n\t\t\t\t\t\tDefault: Search Results (1-1 of 1)\n\t\t\t\t\t</div>');
    expect(body).toContain('\n\t\t\t\t\t\t\t\t<li class="item">Your search returned no results.</li>\n\t\t\t\t\t\t\t\n\t\t\t\t\t</ul>');
    expect(body).toContain('\t\t\t\t\t\t\tSite B:\n\t\t\t\t\t\t\tSearch Results (1-1 of 1)\n\t\t\t\t\t\t</div>');
    expect(body).toContain('\t\t\t\t\t\t\t\t\t<li class="item" data-content-type="Folder&#x2f;Default" data-contentid="' + ID.folder);
    expect(() => renderLoadRelatedContent(related({ isNew: false, keywords: 'x', contentPoolId: 'c,default' }), ctx)).toThrow(
      RangeError,
    );
  });

  it('prints the entity type choice and the custom entity search', () => {
    const sets: RelatedContentSetView[] = [
      { relatedcontentsetid: 'S1', name: 'Widgets', entitytype: 'widget', availablesubtypes: '', displayName: 'Widget & Co' },
      { relatedcontentsetid: 'S2', name: 'More widgets', entitytype: 'Widget', availablesubtypes: '', displayName: 'Widget' },
      DEFAULT_RELATED_CONTENT_SET,
    ];
    const body = renderLoadRelatedContent(
      related({
        isNew: false,
        entityType: 'widget',
        keywords: 'w',
        relatedContentSets: sets,
        entityResults: { recordCount: 2, items: [{ id: 'W1', entityName: 'widget', listViewValues: ['One', '<b>'] }] },
      }),
      ctx,
    ).body;
    expect(body).toContain('value="content"/>Site Content</label>\n\t\t\t\n\t\t\t\t<label class="radio inline"><input type="radio" name="entitytype" value="widget" checked="true"/>Widget &amp; Co</label>');
    expect(body.match(/mura-related-ui__widget" style/g)).toHaveLength(1);
    expect(body).toContain('placeholder="Keywords"/>');
    expect(body).toContain('\n\n\t\t<div class="mura-control-group mura-related-ui mura-related-ui__widget">\n\t\t\t\n\t\t\t\t<div');
    expect(body).toContain('\t\t\t\t\t\t\tSearch Results (1-2 of 2)\n');
    expect(body).toContain(
      '<li class="item" data-content-type="custom/widget" data-contentid="W1">\n\t\t\t\t\t\t\t\t\t<button class="btn mura-rc-quickoption" ' +
        'type="button" value="W1"><i class="mi-plus"></i></button>\n\t\t\t\t\t\t\t\t\t<i class="mi-cog"></i> One, &lt;b&gt;\n\t\t\t\t\t\t\t\t</li>',
    );
    const none = renderLoadRelatedContent(related({ isNew: false, entityType: 'widget', relatedContentSets: sets }), ctx).body;
    expect(none).toContain('\n\t\t\t\t\t\t\t\t<li class="item">Your search returned no results.</li>\n\t\t\t\t\t\t\n\t\t\t\t\t</ul>');
  });

  it('fails as ACF does when no set qualifies for the hidden entity type', () => {
    expect(() => renderLoadRelatedContent(related({ relatedContentSets: [] }), ctx)).toThrow(RangeError);
  });
});

function selected(over: Partial<LoadSelectedRelatedContentModel> = {}): LoadSelectedRelatedContentModel {
  return {
    relatedContentSetId: '',
    relatedContentSets: RICH_SETS,
    contentId: ID.rich,
    relatedContent: {
      [ID.featured]: [item(ID.alpha, 'Page'), item(ID.gamma, 'Page')],
      [DEFAULT_RELATED_CONTENT_SET.relatedcontentsetid]: [item(ID.folder, 'Folder')],
    },
    relatedItems: [],
    relatedEntities: {},
    subTypes: SUBTYPES,
    customIcons,
    ...over,
  };
}

describe('renderLoadSelectedRelatedContent', () => {
  it.each([
    ['rs-rich', selected()],
    ['rs-rich-one', selected({ relatedContentSetId: ID.featured.toLowerCase() })],
    [
      'rs-list',
      selected({
        relatedContentSetId: 'calendar',
        relatedContentSets: [DEFAULT_RELATED_CONTENT_SET],
        relatedItems: [item(ID.alpha, 'Page'), item(ID.folder, 'Folder'), item(ID.rich, 'Page')],
      }),
    ],
    ['rs-default', selected({ relatedContentSets: [DEFAULT_RELATED_CONTENT_SET], contentId: ID.alpha, relatedContent: {} })],
  ])('reproduces %s', (name, model) => {
    const out = renderLoadSelectedRelatedContent(model, ctx);
    expect(out.contentType).toBe('text/html;charset=UTF-8');
    expect(out.body).toBe(fixture(name));
  });

  it('prints custom entity sets with their list view values', () => {
    const body = renderLoadSelectedRelatedContent(
      selected({
        relatedContentSets: [{ relatedcontentsetid: 'S1', name: 'Widgets', entitytype: 'widget', availablesubtypes: null, displayName: 'Widget "W"' }],
        relatedEntities: { s1: [{ id: 'W1', entityName: 'widget', listViewValues: ['One', 'Two'] }] },
      }),
      ctx,
    ).body;
    expect(body).toContain(
      '<div id="rcGroup-S1" class="list-table">\n\t\t\t\t\t\t<div class="list-table-content-set">Widgets\n\t\t\t\t\t\t\t<span class="content-type">' +
        'Limited to:\n\t\t\t\t\t\t\t\t\t<a href="#" rel="tooltip" data-original-title="Widget&#x20;&quot;W&quot;"><i class="mi-cog"></i></a>',
    );
    expect(body).toContain('data-accept="custom/widget" data-relatedcontentsetid="S1">\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t<li class="item" data-contentid="W1"');
    expect(body).toContain('<i class="mi-cog"></i> One, Two\n\t\t\t\t\t\t\t\t\t\t<a class="delete"></a>');
    expect(body).toContain('<li class="item empty noShow">');
    const empty = renderLoadSelectedRelatedContent(
      selected({ relatedContentSets: [{ relatedcontentsetid: 'S1', name: 'W', entitytype: 'widget', availablesubtypes: '', displayName: '' }] }),
      ctx,
    ).body;
    expect(empty).toContain('data-relatedcontentsetid="S1">\n\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t<li class="item empty">');
  });

  it('marks restricted ancestors, file icons and custom subtype icons in the breadcrumbs', () => {
    const file: RelatedContentItem = {
      contentid: 'F1',
      siteid: 'default',
      type: 'File',
      subtype: 'Default',
      crumbs: [
        { siteid: 'default', contentid: 'F1', type: 'File', subtype: 'Default', menutitle: 'Doc.pdf', restricted: 0 },
        { siteid: 'default', contentid: 'P1', type: 'Page', subtype: 'Rich', menutitle: 'Private', restricted: 1 },
        HOME_CRUMB,
      ],
    };
    const icons = (siteId: string, type: string): string => (type === 'File' ? 'pdf' : customIcons(siteId, type, 'Rich'));
    const body = renderLoadSelectedRelatedContent(
      selected({
        relatedContentSets: [{ ...DEFAULT_RELATED_CONTENT_SET, availablesubtypes: 'Page/Rich,Link/Default,Gallery' }],
        relatedContent: { [DEFAULT_RELATED_CONTENT_SET.relatedcontentsetid]: [file] },
        customIcons: icons,
        subTypes: [...SUBTYPES, { type: 'Link', subtype: 'Default', iconclass: ' icon-globe ', adminonly: null }],
      }),
      ctx,
    ).body;
    expect(body).toContain('<li class="mi-star locked"> Private</li>');
    expect(body).toContain('<li class="pdf locked file" data-filetype="pdf"> <strong>Doc.pdf</strong></li>');
    expect(body).toContain('data-original-title="Page/Rich"><i class="mi-star"></i>');
    expect(body).toContain('data-original-title="Link/Default"><i class="mi-globe"></i>');
    expect(body).toContain('data-original-title="Gallery"><i class="mi-th"></i>');
    expect(() =>
      renderLoadSelectedRelatedContent(selected({ relatedContent: { [ID.featured]: [{ ...item(ID.alpha, 'Page'), crumbs: [] }] } }), ctx),
    ).toThrow(RangeError);
  });

  it('keeps every set when the requested set id matches none', () => {
    const body = renderLoadSelectedRelatedContent(selected({ relatedContentSetId: 'unknown' }), ctx).body;
    expect(body).toBe(fixture('rs-rich'));
  });
});

describe('relatedItemsOf', () => {
  it.each([
    ['', []],
    ['A,,B', [{ contentId: 'A' }, { contentId: 'B' }]],
    ['["A",{"ContentID":"X","Title":"T"}]', [{ contentId: 'A' }, { row: { contentid: 'X', title: 'T' } }]],
    ['"A,B"', [{ contentId: 'A' }, { contentId: 'B' }]],
  ])('reads %j', (raw, expected) => {
    expect(relatedItemsOf(raw)).toEqual(expected);
  });

  it('fails for a JSON struct, which CFML cannot convert to a list', () => {
    expect(() => relatedItemsOf('{"a":1}')).toThrow(TypeError);
  });
});
