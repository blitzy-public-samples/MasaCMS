// The category manager secondary menu against ccategory/dsp_secondary_menu.cfm.
import { moduleRole, Roles } from '@opt2/platform/auth';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeUrl, isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { ccategorySecondaryMenu, originalFuseactionOf } from '@/screens/ccategory/secondary-menu';
import type { ShellHooks } from '@/shell/document';
import { adminS2Request, editorRequest, makeAdminRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl, type DomLink } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';
import { TENANT_UMBRELLA } from '../../helpers/tokens';

// The registry imports every circuit barrel; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const CATEGORY_MODULE_ID = '00000000000000000000000000000000010';
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';
const CIRCUIT = 'cCategory';

/** Claims of a site-admin token minted for the umbrella pool site. */
const UMBRELLA_TOKEN = { site: TENANT_UMBRELLA.siteId, tid: TENANT_UMBRELLA.tenantId };
/** Claims of a site-admin token minted for `default`. */
const DEFAULT_TOKEN = { site: 'default', tid: tenantIdForSite('default') };

const menu: NonNullable<ShellHooks['secondaryMenus']['ccategory']> = ccategorySecondaryMenu;

const addHref = (site: string): string =>
  `./?muraAction=cCategory.edit&categoryID=&parentID=&siteid=${encodeUrl(site)}`;
const permissionsHref = (site: string): string =>
  `./?muraAction=cPerm.module&contentid=${CATEGORY_MODULE_ID}&siteid=${encodeUrl(site)}&moduleid=${CATEGORY_MODULE_ID}`;
const backHref = (site: string): string =>
  `./?muraAction=cCategory.list&categoryID=&parentID=&siteid=${encodeUrl(site)}`;

/** One menu button as the markup holds it: tag, raw href, class list, title and its children as `tag.class` selectors. */
interface MenuButton {
  readonly tag: string;
  readonly href: string | undefined;
  readonly classes: string[];
  readonly title: string | undefined;
  readonly children: string[];
}

/** The menu's single root element and its buttons. */
interface MenuShape {
  readonly tag: string;
  readonly classes: string[];
  readonly buttons: MenuButton[];
}

const addButton = (site: string): MenuButton => ({
  tag: 'a',
  href: addHref(site),
  classes: ['btn'],
  title: 'Add Category',
  children: ['i.mi-plus-circle'],
});
const permissionsButton = (site: string): MenuButton => ({
  tag: 'a',
  href: permissionsHref(site),
  classes: ['btn'],
  title: undefined,
  children: ['i.mi-group'],
});
const backButton = (site: string): MenuButton => ({
  tag: 'a',
  href: backHref(site),
  classes: ['btn'],
  title: 'Add Category',
  children: ['i.mi-arrow-circle-left'],
});

const addLink = (site: string): DomLink => ({ href: normaliseAdminUrl(addHref(site)), text: 'Add Category' });
const permissionsLink = (site: string): DomLink => ({
  href: normaliseAdminUrl(permissionsHref(site)),
  text: 'Permissions',
});
const backLink = (site: string): DomLink => ({ href: normaliseAdminUrl(backHref(site)), text: 'Back to Categories' });

const classList = (value: string | undefined): string[] => (value ?? '').split(/\s+/).filter((name) => name !== '');

/** The menu markup for `req`, rendered through a screen context whose gateway it must not call. */
function render(req: AdminRequest): string {
  const ctx = makeScreenContext({ req, gateway: fakeGatewayClient({}) });
  const markup = menu(ctx.req);
  expect(isSafeHtml(markup)).toBe(true);
  expect(ctx.gateway.calls).toEqual([]);
  return toString(markup);
}

function shapeOf(markup: string): MenuShape {
  const $ = cheerio.load(markup, null, false);
  const roots = $.root().children().toArray();
  expect(roots).toHaveLength(1);
  const [root] = roots;
  if (root === undefined) throw new Error('The menu has no root element');
  return {
    tag: root.tagName,
    classes: classList($(root).attr('class')),
    buttons: $(root)
      .children()
      .toArray()
      .map((el) => ({
        tag: el.tagName,
        href: $(el).attr('href'),
        classes: classList($(el).attr('class')),
        title: $(el).attr('title'),
        children: $(el)
          .children()
          .toArray()
          .map((child) => [child.tagName, ...classList($(child).attr('class'))].join('.')),
      })),
  };
}

const ROOT = { tag: 'div', classes: ['nav-module-specific', 'btn-group'] } as const;

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('originalFuseactionOf', () => {
  it.each([
    ['core:ccategory.list', 'list'],
    ['core:ccategory.edit', 'edit'],
    ['ccategory.update', 'update'],
    ['list', 'list'],
    ['core:ccategory.list.', 'list'],
    ['', ''],
  ])('reads %j as %j', (action, expected) => {
    expect(originalFuseactionOf(action)).toBe(expected);
  });
});

describe('ccategorySecondaryMenu on list', () => {
  it.each<[string, () => AdminRequest, string]>([
    ['the S2 admin', () => adminS2Request({ circuit: CIRCUIT, item: 'list' }), 'default'],
    ['the tenant-a site admin', () => siteAdminRequest('tenant-a', { circuit: CIRCUIT, item: 'list' }), 'tenant-a'],
  ])('renders Add Category and Permissions for %s', (_, request, site) => {
    const req = request();
    expect(req.action).toBe('core:ccategory.list');
    const markup = render(req);

    expect(shapeOf(markup)).toEqual({ ...ROOT, buttons: [addButton(site), permissionsButton(site)] });
    expect(fragmentModel(markup).links).toEqual([addLink(site), permissionsLink(site)]);
  });

  it('renders only Add Category for a module user who is neither site admin nor S2', () => {
    const req = editorRequest({ circuit: CIRCUIT, item: 'list' });
    expect([req.isS2, req.isSiteAdmin]).toEqual([false, false]);
    const markup = render(req);

    expect(shapeOf(markup)).toEqual({ ...ROOT, buttons: [addButton('default')] });
    expect(fragmentModel(markup).links).toEqual([addLink('default')]);
    expect(markup).not.toContain('cPerm.module');
  });

  it('URL-encodes the site id in both hrefs', () => {
    const site = 'a b&c';
    const markup = render(adminS2Request({ circuit: CIRCUIT, item: 'list', rc: { siteid: site } }));
    const hrefs = shapeOf(markup).buttons.map((button) => button.href);

    expect(hrefs).toEqual([addHref(site), permissionsHref(site)]);
    expect(hrefs.every((href) => href?.includes('&siteid=a+b%26c'))).toBe(true);
  });
});

describe('ccategorySecondaryMenu Permissions on list, by the requested site', () => {
  it.each<[string, () => AdminRequest, string]>([
    [
      'the tenant-a site admin on Tenant-A, the token site in another case',
      () => siteAdminRequest('tenant-a', { circuit: CIRCUIT, item: 'list', rc: { siteid: 'Tenant-A' } }),
      'Tenant-A',
    ],
    [
      'the S2 admin on tenant-b, a site its token does not serve',
      () => adminS2Request({ circuit: CIRCUIT, item: 'list', rc: { siteid: 'tenant-b' } }),
      'tenant-b',
    ],
    [
      'the umbrella pool admin on umbrella',
      () => siteAdminRequest('umbrella', { circuit: CIRCUIT, item: 'list', user: UMBRELLA_TOKEN }),
      'umbrella',
    ],
    [
      'the default site admin on an empty siteid, which getSite reads as default',
      () => siteAdminRequest('default', { circuit: CIRCUIT, item: 'list', rc: { siteid: '' }, user: DEFAULT_TOKEN }),
      '',
    ],
  ])('renders Add Category and Permissions for %s', (_, request, site) => {
    const markup = render(request());

    expect(shapeOf(markup)).toEqual({ ...ROOT, buttons: [addButton(site), permissionsButton(site)] });
    expect(fragmentModel(markup).links).toEqual([addLink(site), permissionsLink(site)]);
  });

  it.each<[string, () => AdminRequest, string]>([
    [
      'the tenant-a site admin on default',
      () => siteAdminRequest('tenant-a', { circuit: CIRCUIT, item: 'list', rc: { siteid: 'default' } }),
      'default',
    ],
    [
      'the tenant-a site admin on tenant-b',
      () => siteAdminRequest('tenant-a', { circuit: CIRCUIT, item: 'list', rc: { siteid: 'tenant-b' } }),
      'tenant-b',
    ],
    [
      'the umbrella pool admin on tenant-a, whose category and public user pools umbrella holds',
      () =>
        siteAdminRequest('umbrella', {
          circuit: CIRCUIT,
          item: 'list',
          rc: { siteid: 'tenant-a' },
          user: UMBRELLA_TOKEN,
        }),
      'tenant-a',
    ],
    [
      'Categories plus Site Manager module access on its own site',
      () =>
        makeAdminRequest(
          {
            circuit: CIRCUIT,
            item: 'list',
            user: { roles: [Roles.systemUser, moduleRole(CATEGORY_MODULE_ID), moduleRole(SITE_MANAGER_MODULE_ID)] },
          },
          'qaEditor',
        ),
      'default',
    ],
  ])('renders only Add Category for %s', (_, request, site) => {
    const req = request();
    expect(req.isS2).toBe(false);
    const markup = render(req);

    expect(shapeOf(markup)).toEqual({ ...ROOT, buttons: [addButton(site)] });
    expect(fragmentModel(markup).links).toEqual([addLink(site)]);
    expect(markup).not.toContain('cPerm.module');
  });
});

describe('ccategorySecondaryMenu on other actions', () => {
  it.each<[string, string, () => AdminRequest, string]>([
    ['edit', 'the S2 admin', () => adminS2Request({ circuit: CIRCUIT, item: 'edit' }), 'default'],
    ['update', 'the S2 admin', () => adminS2Request({ circuit: CIRCUIT, item: 'update' }), 'default'],
    [
      'edit',
      'the tenant-a site admin',
      () => siteAdminRequest('tenant-a', { circuit: CIRCUIT, item: 'edit' }),
      'tenant-a',
    ],
  ])('renders only Back to Categories on %s for %s', (_, __, request, site) => {
    const markup = render(request());

    expect(shapeOf(markup)).toEqual({ ...ROOT, buttons: [backButton(site)] });
    expect(fragmentModel(markup).links).toEqual([backLink(site)]);
    expect(markup).not.toContain('cPerm.module');
  });
});
