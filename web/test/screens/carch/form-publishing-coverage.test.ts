// carch.edit Publishing panel (dsp_panel_publishing.cfm): the site-, type-, bean- and permission-dependent blocks.
import { describe, expect, it } from 'vitest';
import { encodeHtmlAttr, isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { EditFormInput, EditFormState } from '@/screens/carch/form/custom-tags';
import { renderPublishingPanel } from '@/screens/carch/form/panel-publishing';
import { COMPONENT_MODULE_ID, CONTENT_MODULE_ID, FORM_MODULE_ID, ROOT_CONTENT_ID } from '@/screens/carch/model';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request, editorRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel, type DomControl } from '../../helpers/dom-model';

type Struct = Readonly<Record<string, unknown>>;

const NEW_ID = 'D1000000-0000-0000-0000000000000001';
const NEW_HIST_ID = 'D2000000-0000-0000-0000000000000001';
const STORED_ID = 'D1000000-0000-0000-0000000000000002';
const STORED_HIST_ID = 'D2000000-0000-0000-0000000000000002';
/** The stored ids as `esapiEncode('javascript', …)` prints them: ESAPI's JavaScript codec escapes `-`. */
const JS_STORED_ID = String.raw`D1000000\x2D0000\x2D0000\x2D0000000000000002`;
const JS_STORED_HIST_ID = String.raw`D2000000\x2D0000\x2D0000\x2D0000000000000002`;
const MEMBERS_ID = 'A1000000-0000-0000-0000000000000001';
const PRESS_ID = 'A1000000-0000-0000-0000000000000002';
const EDITORS_ID = 'A1000000-0000-0000-0000000000000003';

/** Module and parent each content type is added under. */
const PLACES: Readonly<Record<string, readonly [moduleId: string, parentId: string]>> = {
  Component: [COMPONENT_MODULE_ID, COMPONENT_MODULE_ID],
  Form: [FORM_MODULE_ID, FORM_MODULE_ID],
};

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
  readonly type?: string;
  /** Default true: a new version under the type's module root. */
  readonly isNew?: boolean;
  readonly bean?: Struct;
  readonly model?: Struct;
  readonly rc?: Readonly<Record<string, string>>;
  readonly site?: AdminRequestPartial['site'];
  /** qa_editor instead of the S2 admin. */
  readonly editor?: boolean;
}

/** The publishing values of a content bean as Masa creates or stores one; `values` replace members. */
function contentBean(type: string, isNew: boolean, values: Struct = {}): Struct {
  const [, parentId] = PLACES[type] ?? [CONTENT_MODULE_ID, ROOT_CONTENT_ID];
  return {
    contentID: isNew ? NEW_ID : STORED_ID,
    contentHistID: isNew ? NEW_HIST_ID : STORED_HIST_ID,
    parentID: isNew ? '' : parentId,
    siteID: 'default',
    type,
    isNew: isNew ? 1 : 0,
    isFeature: 0,
    featureStart: '',
    featureStop: '',
    releaseDate: '',
    isNav: 1,
    target: '_self',
    searchExclude: 0,
    isLocked: 0,
    restricted: 0,
    restrictGroups: '',
    forceSSL: 0,
    doCache: 1,
    template: '',
    displayTitle: 1,
    expires: '',
    mobileExclude: 0,
    ...values,
  };
}

/** The request edit.cfm leaves for `c`: S2 admin (or qa_editor) on `default`, rc as the Site Manager sends it. */
function requestOf(c: Case): AdminRequest {
  const type = c.type ?? 'Page';
  const isNew = c.isNew ?? true;
  const [moduleId, parentId] = PLACES[type] ?? [CONTENT_MODULE_ID, ROOT_CONTENT_ID];
  const partial: AdminRequestPartial = {
    circuit: 'cArch',
    item: 'edit',
    site: { record: { theme: 'default', useSSL: 0 }, ...c.site },
    rc: {
      siteid: 'default',
      type,
      moduleid: moduleId,
      contentid: isNew ? '' : STORED_ID,
      contenthistid: isNew ? '' : STORED_HIST_ID,
      parentid: isNew ? parentId : '',
      ...c.rc,
    },
    formScope: {},
  };
  return c.editor === true ? editorRequest(partial) : adminS2Request(partial);
}

/** The panel input of `c` over `req`. */
function inputOf(c: Case, req: AdminRequest = requestOf(c)): EditFormInput {
  const bean = contentBean(c.type ?? 'Page', c.isNew ?? true, c.bean);
  const ctx = { req, rb: rbFor(req.session.rb), now: new Date('2026-11-13T04:22:00Z') } as unknown as ScreenContext;
  const rc = {
    contentBean: bean,
    rsRestrictGroups: [],
    rsTemplates: [{ name: 'default.cfm' }],
    notifyCount: 0,
    useLayoutManager: true,
    ...c.model,
  };
  return { ctx, req, data: { rc }, state: STATE };
}

/** The panel markup of `c`, after checking the result's shape. */
function render(c: Case = {}): string {
  const result = renderPublishingPanel(inputOf(c));
  expect(isSafeHtml(result.html)).toBe(true);
  expect(result).toMatchObject({ tabId: 'tabPublishing', tabLabel: 'Publishing' });
  return toString(result.html);
}

/** The form control named `name` in `html`; fails when there is none. */
function controlOf(html: string, name: string): DomControl {
  const control = fragmentModel(html).controls.find((c) => c.name === name);
  if (control === undefined) throw new Error(`no control named ${name}`);
  return control;
}

/** The names of every control in `html`. */
const controlNames = (html: string): string[] => fragmentModel(html).controls.map((c) => c.name);

const EXTRANET: AdminRequestPartial['site'] = { extranet: true };
const CACHED: AdminRequestPartial['site'] = { cache: true };

const GROUP_ROWS: readonly Struct[] = [
  { userid: MEMBERS_ID, groupname: 'Members', isPublic: 1 },
  { userid: EDITORS_ID, groupname: 'Editors', isPublic: 0 },
  { userid: PRESS_ID, groupname: 'Press', isPublic: 1 },
];

const RESTRICT_CHECKBOX =
  `<input name="restricted" id="Restricted" type="checkbox" value="1"  onclick="javascript: this.checked?toggleDisplay2('rg',true):toggleDisplay2('rg',false);" `;

describe('carch.edit Publishing panel restrict access', () => {
  it('offers member then system groups on an extranet site, selecting groups listed by name or id', () => {
    const html = render({
      isNew: false,
      site: EXTRANET,
      bean: { restricted: 1, restrictGroups: `Members,${EDITORS_ID}` },
      model: { rsRestrictGroups: GROUP_ROWS },
    });
    expect(html).toContain(`${RESTRICT_CHECKBOX}checked  class="checkbox">`);
    expect(html).toContain('<div class="mura-control=group" id="rg">');
    expect(html).toContain(`<optgroup label="${encodeHtmlAttr('Global Settings')}">`);
    const member = html.indexOf(`<optgroup label="${encodeHtmlAttr('Member Groups')}">`);
    const system = html.indexOf(`<optgroup label="${encodeHtmlAttr('System Groups')}">`);
    expect(member).toBeGreaterThan(0);
    expect(system).toBeGreaterThan(member);
    const select = controlOf(html, 'restrictgroups');
    expect(select.type).toBe('select-multiple');
    expect(select.options).toEqual([
      { value: '', label: 'Allow All Groups', selected: false },
      { value: 'RestrictAll', label: 'Restrict All Groups', selected: false },
      { value: MEMBERS_ID, label: 'Members', selected: true },
      { value: PRESS_ID, label: 'Press', selected: false },
      { value: EDITORS_ID, label: 'Editors', selected: true },
    ]);
  });

  it.each<[string, Struct, string, readonly string[]]>([
    ['unrestricted and open to all', { restricted: 0, restrictGroups: '' }, ' style="display:none;"', ['']],
    ['restricted to every group', { restricted: 'true', restrictGroups: 'RestrictAll' }, '', ['RestrictAll']],
    ['restricted by a differently cased name', { restricted: 'yes', restrictGroups: 'members' }, '', []],
  ])('shows the group select of a node %s as legacy does', (_case, bean, hidden, selected) => {
    const html = render({ isNew: false, site: EXTRANET, bean, model: { rsRestrictGroups: GROUP_ROWS } });
    expect(html).toContain(`<div class="mura-control=group" id="rg"${hidden}>`);
    expect(html).toContain(`${RESTRICT_CHECKBOX}${hidden === '' ? 'checked ' : ''} class="checkbox">`);
    expect(controlOf(html, 'restrictgroups').selected).toEqual(selected);
  });

  it('prints only the optgroups that have groups, with ids and names unencoded', () => {
    const html = render({
      site: EXTRANET,
      model: { rsRestrictGroups: [{ userid: 'x&y', groupname: 'R&D <Team>', isPublic: 0 }] },
    });
    expect(html).not.toContain(encodeHtmlAttr('Member Groups'));
    expect(html).toContain(`<optgroup label="${encodeHtmlAttr('System Groups')}">`);
    expect(html).toContain('<option value="x&y" >R&D <Team></option>');
  });

  it.each<[string, Case]>([
    ['a site without extranet', { site: { extranet: false } }],
    ['a Component', { type: 'Component', site: EXTRANET }],
    ['a Form', { type: 'Form', site: EXTRANET }],
  ])('leaves restrict access out for %s', (_case, c) => {
    const html = render({ ...c, model: { rsRestrictGroups: GROUP_ROWS } });
    expect(html).not.toContain('id="Restricted"');
    expect(controlNames(html)).not.toContain('restrictgroups');
  });

  it('throws when an extranet site has no restrict group rows', () => {
    expect(() => render({ site: EXTRANET, model: { rsRestrictGroups: undefined } })).toThrow(
      new TypeError('strategies-content getContentEditModel returned no rc.rsRestrictGroups rows'),
    );
    expect(() => render({ site: EXTRANET, model: { rsRestrictGroups: [1] } })).toThrow(TypeError);
  });
});

describe('carch.edit Publishing panel checkboxes', () => {
  // `<cfif v eq "">checked <cfelseif v eq 1>checked</cfif>`, between `value="1" ` and ` class="checkbox">`.
  it.each<[string, unknown, string]>([
    ['blank', '', 'checked  '],
    ['1', 1, 'checked '],
    ['"true"', 'true', 'checked '],
    ['0', 0, ' '],
  ])('checks search exclusion and node lock for a %s value as legacy does', (_case, value, between) => {
    const html = render({ isNew: false, bean: { searchExclude: value, isLocked: value } });
    expect(html).toContain(`<input name="searchExclude" id="searchExclude" type="checkbox" value="1" ${between}class="checkbox">`);
    expect(html).toContain(`<input name="isLocked" id="islocked" type="checkbox" value="1" ${between}class="checkbox">`);
  });

  it.each<[string, string]>([
    ['_blank', 'checked '],
    ['_BLANK', 'checked '],
    ['_self', ' '],
  ])('checks the new window box for target %s', (target, between) => {
    const html = render({ isNew: false, bean: { target } });
    expect(html).toContain(`<input  name="target" id="Target" type="checkbox" value="_blank" ${between}class="checkbox" >`);
  });

  it.each<[string, Case, boolean]>([
    ['the S2 admin', { isNew: false }, true],
    ['qa_editor, who is not S2', { isNew: false, editor: true }, false],
    ['the S2 admin on Home', { isNew: false, rc: { contentid: ROOT_CONTENT_ID } }, false],
  ])('offers the node lock to %s as listFind(memberships, S2) decides', (_case, c, shown) => {
    expect(controlNames(render(c)).includes('isLocked')).toBe(shown);
  });
});

describe('carch.edit Publishing panel cache and layout template', () => {
  it.each<[string, Case, string | null]>([
    ['a Component excluded on a cached site', { type: 'Component', site: CACHED, bean: { doCache: 0 } }, ' checked'],
    ['a cached Component on a cached site', { type: 'Component', site: CACHED, bean: { doCache: 1 } }, ''],
    ['a Form on a site without cache', { type: 'Form', bean: { doCache: 0 } }, ' checked'],
    ['a Component on a site without cache', { type: 'Component', bean: { doCache: 0 } }, null],
    ['a Page on a cached site', { type: 'Page', site: CACHED, bean: { doCache: 0 } }, null],
  ])('prints the exclude-from-cache box for %s as legacy does', (_case, c, checked) => {
    const html = render(c);
    const box = `<input name="doCache" id="doCache" type="checkbox" value="0"${checked ?? ''} class="checkbox"> Exclude from Site Cache`;
    if (checked === null) expect(html).not.toContain('id="doCache"');
    else expect(html).toContain(box);
  });

  it('lists the .cfm templates of a Component, in any case, selecting the bean template, names unencoded', () => {
    const html = render({
      type: 'Component',
      bean: { template: 'TWO.cfm' },
      model: {
        rsTemplates: [{ name: 'default.cfm' }, { name: 'two.cfm' }, { name: 'notes.txt' }, { name: 'Wide.CFM' }, { name: 'a&b.cfm' }],
      },
    });
    expect(controlOf(html, 'template').options).toEqual([
      { value: '', label: 'none', selected: false },
      { value: 'default.cfm', label: 'default.cfm', selected: false },
      { value: 'two.cfm', label: 'two.cfm', selected: true },
      { value: 'Wide.CFM', label: 'Wide.CFM', selected: false },
      { value: 'a&b.cfm', label: 'a&b.cfm', selected: false },
    ]);
    expect(html).toContain('<option value="two.cfm" selected>two.cfm</option>');
    expect(html).toContain('<option value="a&b.cfm" >a&b.cfm</option>');
    expect(html).toContain(`data-content="${encodeHtmlAttr('Select the layout file for the page that you are working on.')}"`);
  });

  it('throws when a Component model has no template rows', () => {
    expect(() => render({ type: 'Component', model: { rsTemplates: 'default.cfm' } })).toThrow(
      new TypeError('strategies-content getContentEditModel returned no rc.rsTemplates rows'),
    );
  });
});

describe('carch.edit Publishing panel SSL and Form options', () => {
  const FORCE_SSL_BOX = '<input name="forceSSL" id="forceSSL" type="checkbox" value="1" checked class="checkbox">';

  it.each<[string, string]>([
    ['Page', 'Make this Page secure via SSL?'],
    ['Link', 'Make this Link secure via SSL?'],
  ])('offers force SSL for a %s that sets it on a site without SSL', (type, text) => {
    const html = render({ type, isNew: false, bean: { forceSSL: 'yes' } });
    expect(html).toContain(`<label>SSL</label>\n\t\t\t      \t<label for="forceSSL" class="checkbox">\n\t\t\t      \t${FORCE_SSL_BOX}`);
    expect(html).toContain(`data-original-title="${encodeHtmlAttr('SSL')}">\n\t\t\t\t\t\t\t\t  \t${text}\n`);
    expect(html).toContain(`data-content="${encodeHtmlAttr(rbFor('en_US').rbKey('tooltip.makePageSecure'))}"`);
  });

  it.each<[string, Case]>([
    ['the bean does not force SSL', { bean: { forceSSL: 0 } }],
    ['the site uses SSL', { bean: { forceSSL: 1 }, site: { record: { useSSL: 1 } } }],
    ['a NULL useSSL reads extranet SSL', { bean: { forceSSL: 1 }, site: { record: { useSSL: null, ExtranetSSL: 1 } } }],
    ['the node is a Component', { type: 'Component', bean: { forceSSL: 1 } }],
    ['the node is a Variation', { type: 'Variation', bean: { forceSSL: 1 } }],
  ])('leaves force SSL out when %s', (_case, c) => {
    expect(controlNames(render({ isNew: false, ...c }))).not.toContain('forceSSL');
  });

  it('offers force SSL when the site has neither useSSL nor extranet SSL', () => {
    const html = render({ isNew: false, bean: { forceSSL: 1 }, site: { record: { useSSL: null, ExtranetSSL: null } } });
    expect(controlOf(html, 'forceSSL').checked).toBe(true);
  });

  it('prints a Form its force-SSL and display-title boxes when the site renders without the layout manager', () => {
    const html = render({ type: 'Form', bean: { forceSSL: 1, displayTitle: '' }, model: { useLayoutManager: 0 } });
    expect(html).toContain(`${FORCE_SSL_BOX} Force SSL\n`);
    expect(html).toContain(
      '<input name="displayTitle" id="displayTitle" type="checkbox" value="1" checked  class="checkbox"> Show Title Above Form\n',
    );
    expect(controlNames(html).filter((name) => name === 'forceSSL')).toHaveLength(1);
  });

  it.each<[string, Struct, Case['site'], boolean, string]>([
    ['a Form that does not force SSL', { forceSSL: 0, displayTitle: 1 }, undefined, false, 'checked '],
    ['a Form on an SSL site', { forceSSL: 1, displayTitle: 0 }, { record: { useSSL: 1 } }, false, ' '],
  ])('prints only the display-title box for %s', (_case, bean, site, forced, between) => {
    const html = render({ type: 'Form', bean, site, model: { useLayoutManager: 'false' } });
    expect(controlNames(html).includes('forceSSL')).toBe(forced);
    expect(html).toContain(`<input name="displayTitle" id="displayTitle" type="checkbox" value="1" ${between}class="checkbox">`);
  });

  it('prints no Form options when the site uses the layout manager', () => {
    expect(controlNames(render({ type: 'Form', bean: { forceSSL: 1 }, model: { useLayoutManager: 'yes' } }))).not.toContain(
      'displayTitle',
    );
  });

  it.each([undefined, null])('throws for a Form whose model carries useLayoutManager %s', (useLayoutManager) => {
    expect(() => render({ type: 'Form', model: { useLayoutManager } })).toThrow(
      new TypeError('strategies-content getContentEditModel returned no rc.useLayoutManager'),
    );
  });

  it('renders a Page whose model carries no useLayoutManager', () => {
    expect(render({ model: { useLayoutManager: undefined } })).toContain('id="heading-publishing"');
  });
});

describe('carch.edit Publishing panel notification and expiration', () => {
  it('preloads the expiration recipients when the crumb trail has notify rows, with JS-encoded loader arguments', () => {
    const parentId = "P'1</script>";
    const html = render({ isNew: false, rc: { parentid: parentId }, model: { notifyCount: 2 } });
    const encodedParent = String.raw`P\x271\x3C\x2Fscript\x3E`;
    const args = `'default','${JS_STORED_HIST_ID}','${encodedParent}'`;
    expect(html).toContain(`onclick="siteManager.loadExpiresNotify(${args});"  class="checkbox" checked>`);
    expect(html).toContain('<div class="mura-control-group" id="selectExpiresNotify"></div>');
    expect(html).toContain(`\t\t\t\t\t\t\tsiteManager.loadExpiresNotify(${args});\t\t\t\t\t\t\n`);
    expect(html).toContain(`onclick="siteManager.loadNotify('default','${JS_STORED_ID}','${encodedParent}');"`);
  });

  it('reads a blank rc.parentid of a stored node from the bean', () => {
    const html = render({ isNew: false, bean: { parentID: 'B1000000-0000-0000-0000000000000009' } });
    expect(html).toContain(
      String.raw`siteManager.loadNotify('default','${JS_STORED_ID}','B1000000\x2D0000\x2D0000\x2D0000000000000009');`,
    );
  });

  it('leaves the expiration recipients hidden and unloaded without notify rows', () => {
    const html = render({ isNew: false });
    const args = `'default','${JS_STORED_HIST_ID}','${ROOT_CONTENT_ID}'`;
    expect(html).toContain(`onclick="siteManager.loadExpiresNotify(${args});"  class="checkbox">\n`);
    expect(html).toContain('<div class="mura-control-group" id="selectExpiresNotify" style="display: none;"></div>');
    expect(html.match(/siteManager\.loadExpiresNotify\(/g)).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ['negative', -1],
    ['fractional', 1.5],
    ['text', '2'],
    ['absent', undefined],
  ])('throws for a %s notify count', (_case, notifyCount) => {
    expect(() => render({ model: { notifyCount } })).toThrow(
      new TypeError('strategies-content getContentEditModel returned no rc.notifyCount record count'),
    );
  });

  it('prints no expiration controls for a Component', () => {
    expect(render({ type: 'Component', model: { notifyCount: 'none' } })).not.toContain('id="bigui__expireschedule"');
  });
});

describe('carch.edit Publishing panel mobile navigation', () => {
  it.each<[string, unknown, readonly boolean[]]>([
    ['2', 2, [true, true, false]],
    ['1', '1', [true, false, true]],
  ])('offers the deprecated radios for a stored node excluded with %s', (_case, mobileExclude, checked) => {
    const html = render({ isNew: false, bean: { mobileExclude } });
    const radios = fragmentModel(html).controls.filter((c) => c.name === 'mobileExclude');
    expect(radios.map((r) => [r.type, r.value, r.checked])).toEqual([
      ['radio', '0', checked[0]],
      ['radio', '2', checked[1]],
      ['radio', '1', checked[2]],
    ]);
    expect(html).toContain('<label>Mobile Navigation</label>');
    expect(html).toContain(
      `<label class="radio"><input type="radio" name="mobileExclude" value="2"${checked[1] ? ' checked' : ''}>Include for Mobile Only</label>`,
    );
  });

  it.each<[string, Case]>([
    ['a stored node not excluded', { isNew: false, bean: { mobileExclude: 0 } }],
    ['a new node', { isNew: true, bean: { mobileExclude: 2 } }],
  ])('posts a hidden mobileExclude of 0 for %s', (_case, c) => {
    const radios = fragmentModel(render(c)).controls.filter((r) => r.name === 'mobileExclude');
    expect(radios.map((r) => [r.type, r.value])).toEqual([['hidden', '0']]);
  });
});

describe('carch.edit Publishing panel request values', () => {
  it('reads rc names in any case from a plain request scope', () => {
    const c: Case = { isNew: false };
    const req = requestOf(c);
    const plain: Record<string, string> = {
      SiteID: 'default',
      Type: 'Page',
      ContentID: STORED_ID,
      ContentHistID: STORED_HIST_ID,
      ParentID: '',
    };
    const mixed = renderPublishingPanel(inputOf(c, { ...req, rc: plain }));
    expect(toString(mixed.html)).toBe(render(c));
  });

  it.each(['type', 'contentid', 'siteid', 'contenthistid', 'parentid'])('throws when rc.%s is undefined', (name) => {
    const c: Case = { isNew: false };
    const req = requestOf(c);
    const rc = Object.fromEntries(Object.entries(req.rc).filter(([key]) => key.toLowerCase() !== name));
    expect(() => renderPublishingPanel(inputOf(c, { ...req, rc }))).toThrow(
      new TypeError(`rc.${name} is undefined for carch.edit`),
    );
  });

  it('throws when programs-sites served no session site', () => {
    const c: Case = {};
    const req = requestOf(c);
    expect(() => renderPublishingPanel(inputOf(c, { ...req, site: undefined }))).toThrow(
      new TypeError('programs-sites served no site default for carch.edit'),
    );
  });
});
