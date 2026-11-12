// Secondary menu dispatcher of admin/common/layouts/includes/dsp_secondary_menu.cfm: selection and hook rendering.
import { describe, expect, it, vi, type Mock } from 'vitest';
import { html, isSafeHtml, toString, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { carchSecondaryMenu } from '@/screens/carch/secondary-menu';
import { ccategorySecondaryMenu } from '@/screens/ccategory/secondary-menu';
import { cchangesetsSecondaryMenu } from '@/screens/cchangesets/secondary-menu';
import { cfeedSecondaryMenu } from '@/screens/cfeed/secondary-menu';
import { renderSecondaryMenu, selectSecondaryMenus, type SecondaryMenuKey } from '@/shell/secondary-menu';
import type { SecondaryMenuCircuit, ShellHooks } from '@/shell/types';
import { adminS2Request } from '../helpers/admin-request';
import { fragmentModel, normaliseIds } from '../helpers/dom-model';

const Z = '00000000000000000000000000000000';

/** The 35-character core module id ending in `suffix`, or `''` for no module. */
const moduleOf = (suffix: string): string => (suffix === '' ? '' : `${Z}${suffix}`);

const select = (originalCircuit: string, suffix: string, sessionSiteId = 'default'): SecondaryMenuKey[] =>
  selectSecondaryMenus({ originalCircuit, moduleId: moduleOf(suffix), sessionSiteId });

type SelectionCase = readonly [circuit: string, moduleSuffix: string, expected: readonly SecondaryMenuKey[]];

// The carch branches match exclusive module ids, so no input repeats a key; exact arrays pin one entry per branch.

const SELECTIONS: readonly SelectionCase[] = [
  ['cdashboard', '000', ['cdashboard']],
  ['cdashboard', '003', ['cdashboard', 'carch']],
  ['cdashboard', '004', ['cdashboard', 'carch']],
  ['carch', '000', ['carch']],
  ['carch', '004', ['carch']],
  ['carch', '', []],
  ['cchangesets', '000', ['carch', 'cchangesets']],
  ['cchangesets', '', ['cchangesets']],
  ['cchangesets', '003', ['cchangesets', 'carch']],
  ['ccategory', '', ['ccategory']],
  ['ccategory', '003', ['carch', 'ccategory']],
  ['cfeed', '', ['cfeed']],
  ['cfeed', '004', ['cfeed', 'carch']],
  ['cpublicusers', '', ['cpublicusers']],
  ['cemail', '', ['cemail']],
  ['cmailinglist', '', ['cmailinglist']],
  ['cperm', '000', ['carch']],
  ['cperm', '003', ['carch']],
  ['cperm', '004', ['carch']],
  ['cperm', '014', ['cchangesets']],
  ['cperm', '010', ['ccategory']],
  ['cperm', '011', ['cfeed']],
  ['cperm', '008', ['cpublicusers']],
  ['cperm', '005', ['cemail']],
  ['cperm', '009', ['cmailinglist']],
  ['cperm', '', []],
  ['cusers', '010', []],
  ['cusers', '014', []],
];

describe('selectSecondaryMenus', () => {
  it.each(SELECTIONS)('selects for %s on module %j: %j', (circuit, suffix, expected) => {
    expect(select(circuit, suffix)).toEqual(expected);
  });

  it.each([
    ['cArch', 'carch', '000', ['carch']],
    ['CARCH', 'carch', '000', ['carch']],
    ['cChangesets', 'cchangesets', '000', ['carch', 'cchangesets']],
    ['cPerm', 'cperm', '014', ['cchangesets']],
    ['CPERM', 'cperm', '011', ['cfeed']],
    ['cDashboard', 'cdashboard', '000', ['cdashboard']],
  ] as const)('matches %s as %s on module %s', (legacyCase, lowerCase, suffix, expected) => {
    expect(select(legacyCase, suffix)).toEqual(expected);
    expect(select(lowerCase, suffix)).toEqual(expected);
  });

  it.each([
    ['cfeed', '4', ['cfeed', 'carch']],
    ['cperm', '14', ['cchangesets']],
    ['cdashboard', '0', ['cdashboard']],
    ['ccategory', '3', ['carch', 'ccategory']],
  ] as const)('compares %s module id %s numerically', (originalCircuit, moduleId, expected) => {
    expect(selectSecondaryMenus({ originalCircuit, moduleId, sessionSiteId: 'default' })).toEqual(expected);
  });

  it.each(SELECTIONS)('selects nothing for %s on module %j without a session site', (circuit, suffix) => {
    expect(select(circuit, suffix, '')).toEqual([]);
  });
});

type MenuRenderer = (ctx: AdminRequest) => SafeHtml;

const MARKERS = {
  carch: html`<div id="sm-carch"></div>`,
  cchangesets: html`<div id="sm-cchangesets"></div>`,
  ccategory: html`<div id="sm-ccategory"></div>`,
  cfeed: html`<div id="sm-cfeed"></div>`,
} as const satisfies Record<SecondaryMenuCircuit, SafeHtml>;

const HOOKED: readonly SecondaryMenuCircuit[] = ['carch', 'cchangesets', 'ccategory', 'cfeed'];

/** Spy renderers returning each circuit's marker, and the hooks holding them. */
function menuHooks(): { hooks: ShellHooks; renderers: Record<SecondaryMenuCircuit, Mock<MenuRenderer>> } {
  const renderers = {
    carch: vi.fn<MenuRenderer>(() => MARKERS.carch),
    cchangesets: vi.fn<MenuRenderer>(() => MARKERS.cchangesets),
    ccategory: vi.fn<MenuRenderer>(() => MARKERS.ccategory),
    cfeed: vi.fn<MenuRenderer>(() => MARKERS.cfeed),
  };
  return { hooks: { secondaryMenus: renderers }, renderers };
}

/** An S2 admin request on `<circuit>.list` whose `rc.moduleid` ends in `suffix`. */
const request = (circuit: string, suffix: string): AdminRequest =>
  adminS2Request({ circuit, item: 'list', rc: { moduleid: moduleOf(suffix) } });

/** The rendered menus, asserted to be module-made markup. */
function render(ctx: AdminRequest, hooks: ShellHooks, originalCircuit?: string): string {
  const markup = renderSecondaryMenu(ctx, hooks, originalCircuit);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** The hooked circuits whose renderer ran, in hook order. */
const called = (renderers: Record<SecondaryMenuCircuit, Mock<MenuRenderer>>): SecondaryMenuCircuit[] =>
  HOOKED.filter((circuit) => renderers[circuit].mock.calls.length > 0);

describe('renderSecondaryMenu', () => {
  it('renders carch then cchangesets for cChangesets on module 000', () => {
    const { hooks, renderers } = menuHooks();
    const ctx = request('cChangesets', '000');
    expect(render(ctx, hooks)).toEqual('<div id="sm-carch"></div><div id="sm-cchangesets"></div>');
    for (const circuit of ['carch', 'cchangesets'] as const) {
      expect(renderers[circuit]).toHaveBeenCalledTimes(1);
      expect(renderers[circuit]).toHaveBeenCalledWith(ctx);
    }
    expect(called(renderers)).toEqual(['carch', 'cchangesets']);
  });

  it('keeps cfeed before module 004 carch', () => {
    const { hooks, renderers } = menuHooks();
    const ctx = request('cFeed', '004');
    expect(render(ctx, hooks)).toEqual('<div id="sm-cfeed"></div><div id="sm-carch"></div>');
    expect(renderers.cfeed).toHaveBeenCalledWith(ctx);
    expect(renderers.carch).toHaveBeenCalledWith(ctx);
    expect(called(renderers)).toEqual(['carch', 'cfeed']);
  });

  it.each([
    ['cDashboard', '000', 'cdashboard'],
    ['cPublicUsers', '', 'cpublicusers'],
    ['cPerm', '008', 'cpublicusers'],
    ['cEmail', '', 'cemail'],
    ['cPerm', '005', 'cemail'],
    ['cMailingList', '', 'cmailinglist'],
    ['cPerm', '009', 'cmailinglist'],
  ] as const)('renders nothing for %s on module %j, which selects only %s', (circuit, suffix, key) => {
    const { hooks, renderers } = menuHooks();
    const ctx = request(circuit, suffix);
    expect(select(circuit, suffix)).toEqual([key]);
    expect(render(ctx, hooks)).toEqual('');
    expect(called(renderers)).toEqual([]);
  });

  it('skips a selected circuit without a renderer', () => {
    const { renderers } = menuHooks();
    const hooks: ShellHooks = { secondaryMenus: { cchangesets: renderers.cchangesets } };
    expect(render(request('cChangesets', '000'), hooks)).toEqual('<div id="sm-cchangesets"></div>');
    expect(called(renderers)).toEqual(['cchangesets']);
  });

  it('lets the originalCircuit argument override the action circuit', () => {
    const { hooks, renderers } = menuHooks();
    const ctx = request('cUsers', '011');
    expect(render(ctx, hooks)).toEqual('');
    expect(render(ctx, hooks, 'cPerm')).toEqual('<div id="sm-cfeed"></div>');
    expect(render(request('cDashboard', '000'), hooks, 'cArch')).toEqual('<div id="sm-carch"></div>');
    expect(called(renderers)).toEqual(['carch', 'cfeed']);
  });

  it('reads an empty circuit from an empty action', () => {
    const { hooks } = menuHooks();
    const ctx: AdminRequest = { ...request('cDashboard', '000'), action: '' };
    expect(render(request('cDashboard', '000'), hooks)).toEqual('');
    expect(render(ctx, hooks)).toEqual('<div id="sm-carch"></div>');
  });

  it('treats a missing rc.moduleid as no module', () => {
    const { hooks, renderers } = menuHooks();
    const ctx: AdminRequest = { ...request('cChangesets', '000'), rc: {} };
    expect(render(ctx, hooks)).toEqual('<div id="sm-cchangesets"></div>');
    expect(called(renderers)).toEqual(['cchangesets']);
  });

  it('renders nothing without a session site', () => {
    const { hooks, renderers } = menuHooks();
    const base = request('cChangesets', '000');
    const ctx: AdminRequest = { ...base, session: { ...base.session, siteid: '' } };
    expect(render(ctx, hooks)).toEqual('');
    expect(called(renderers)).toEqual([]);
  });
});

const REAL_HOOKS: ShellHooks = {
  secondaryMenus: {
    carch: carchSecondaryMenu,
    cchangesets: cchangesetsSecondaryMenu,
    ccategory: ccategorySecondaryMenu,
    cfeed: cfeedSecondaryMenu,
  },
};

const CHANGESETS = moduleOf('014');
const CATEGORIES = moduleOf('010');
const COLLECTIONS = moduleOf('011');

// Each view's include as the ACF 2023 oracle served it to the admin on `default`. No legacy layout includes the
// dispatcher, so its reference is these includes concatenated in include order.

// Oracle captures of cArch.datamanager on module 000 and cArch.multiFileUpload on module 004: no case for the action.
const LEGACY_CARCH_NO_CASE = '\n<div class="nav-module-specific btn-group">\n\t\n</div>\n';
// Oracle capture of cChangesets.list.
const LEGACY_CCHANGESETS_LIST =
  '<div class="nav-module-specific btn-group">\n\t\t\n\t\t\t\t' +
  '<a class="btn" title="Add Change Set" href="./?muraAction=cChangesets.edit&changesetID=&siteid=default">' +
  '<i class="mi-plus-circle"></i> Add Change Set</a>\n\t\t\t\t\n\t\t\t\t' +
  `<a class="btn " href="./?muraAction=cPerm.module&contentid=${CHANGESETS}&siteid=default&moduleid=${CHANGESETS}">` +
  '<i class="mi-group"></i> Permissions</a>\n\t\t\t\t\n\t</div>';
// cchangesets/dsp_secondary_menu.cfm:79-80,105-106 with no case for the action, under ACF whitespace management.
const LEGACY_CCHANGESETS_NO_CASE = '<div class="nav-module-specific btn-group">\n\t\t\n\t</div>';
// Oracle capture of cFeed.list.
const LEGACY_CFEED_LIST =
  '<div class="nav-module-specific btn-group">\n\t\n\t\t\t' +
  '<a class="btn" title="Add Local Index" href="./?muraAction=cFeed.edit&feedID=&siteid=default&type=Local">' +
  '<i class="mi-plus-circle"></i> Add Local Index</a>\n\t\t\t' +
  '<a class="btn" title="Add Remote Feed" href="./?muraAction=cFeed.edit&feedID=&siteid=default&type=Remote">' +
  '<i class="mi-plus-circle"></i> Add Remote Feed</a>\n\t\t\t\n\t\t\t' +
  `<a class="btn " href="./?muraAction=cPerm.module&contentid=${COLLECTIONS}&siteid=default&moduleid=${COLLECTIONS}">` +
  '<i class="mi-group"></i> Permissions</a>\n\t\t\t\n\t</div>';
// Oracle capture of cFeed.edit for a new collection; cfeed/dsp_secondary_menu.cfm:91 skips the feed link as it does
// without rc.feedBean.
const LEGACY_CFEED_BACK =
  '<div class="nav-module-specific btn-group">\n\t\n\t\t\t' +
  '<a class="btn" href="./?muraAction=cFeed.list&siteid=default">' +
  '<i class="mi-arrow-circle-left"></i> Back to Collections</a>\n\t\t\t\n\t</div>';
// Oracle capture of cCategory.list.
const LEGACY_CCATEGORY_LIST =
  '<div class="nav-module-specific btn-group">\n\t\n\t\t\t\t' +
  '<a class="btn" title="Add Category" href="./?muraAction=cCategory.edit&categoryID=&parentID=&siteid=default">' +
  '<i class="mi-plus-circle"></i> Add Category</a>\n\t\t\t\n\t\t\t\t' +
  `<a class="btn " href="./?muraAction=cPerm.module&contentid=${CATEGORIES}&siteid=default&moduleid=${CATEGORIES}">` +
  '<i class="mi-group"></i> Permissions</a>\n\t\t\t\n</div>';
// Oracle capture of cCategory.edit for a new category.
const LEGACY_CCATEGORY_BACK =
  '<div class="nav-module-specific btn-group">\n\t\n\t\t\t' +
  '<a class="btn" title="Add Category" href="./?muraAction=cCategory.list&categoryID=&parentID=&siteid=default">' +
  '<i class="mi-arrow-circle-left"></i> Back to Categories</a>\n\t\t\n</div>';

/** An S2 admin request on `<circuit>.<item>` whose `rc.moduleid` ends in `suffix`. */
const actionRequest = (circuit: string, item: string, suffix: string): AdminRequest =>
  adminS2Request({ circuit, item, rc: { moduleid: moduleOf(suffix) } });

type ReferenceCase = readonly [circuit: string, item: string, moduleSuffix: string, legacy: readonly string[]];

const REFERENCES: readonly ReferenceCase[] = [
  ['cChangesets', 'list', '000', [LEGACY_CARCH_NO_CASE, LEGACY_CCHANGESETS_LIST]],
  ['cFeed', 'import1', '004', [LEGACY_CFEED_BACK, LEGACY_CARCH_NO_CASE]],
  ['cFeed', 'list', '', [LEGACY_CFEED_LIST]],
  ['cCategory', 'list', '', [LEGACY_CCATEGORY_LIST]],
  ['cCategory', 'edit', '', [LEGACY_CCATEGORY_BACK]],
  ['cPerm', 'module', '014', [LEGACY_CCHANGESETS_NO_CASE]],
  ['cPerm', 'module', '011', [LEGACY_CFEED_BACK]],
  ['cPerm', 'module', '010', [LEGACY_CCATEGORY_BACK]],
  ['cPerm', 'main', '003', [LEGACY_CARCH_NO_CASE]],
];

describe('renderSecondaryMenu with the screen hooks', () => {
  it.each(REFERENCES)('renders %s %s on module %j as the legacy includes', (circuit, item, suffix, legacy) => {
    const markup = render(actionRequest(circuit, item, suffix), REAL_HOOKS);
    const reference = legacy.join('');

    expect(markup).toBe(reference);
    expect(normaliseIds(fragmentModel(markup))).toEqual(normaliseIds(fragmentModel(reference)));
  });

  // carch/dsp_secondary_menu.cfm:94 reads rc.perm, which only the carch controller sets.
  it.each([
    ['cFeed', '004'],
    ['cCategory', '003'],
  ])('fails as CFML does for %s.list on module %s, whose carch list reads rc.perm', (circuit, suffix) => {
    expect(() => renderSecondaryMenu(actionRequest(circuit, 'list', suffix), REAL_HOOKS)).toThrow(
      expect.objectContaining({ name: 'TypeError', message: 'Element PERM is undefined in RC.' }),
    );
  });
});
