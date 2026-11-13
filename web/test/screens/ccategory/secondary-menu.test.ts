// The category manager secondary menu against ccategory/dsp_secondary_menu.cfm.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeUrl, isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { ccategorySecondaryMenu, originalFuseactionOf } from '@/screens/ccategory/secondary-menu';
import type { ShellHooks } from '@/shell/document';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl, type DomLink } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

const CATEGORY_MODULE_ID = '00000000000000000000000000000000010';
const CIRCUIT = 'cCategory';

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
