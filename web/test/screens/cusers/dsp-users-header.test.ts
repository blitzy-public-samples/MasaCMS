// Unit tests for the Users & Groups header of `cusers/inc/dsp_users_header.cfm`.
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { normaliseCusersRc } from '@/screens/cusers/gate';
import { renderUsersHeader } from '@/screens/cusers/inc/dsp_users_header';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request, editorRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl, normaliseIds } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient } from '../../helpers/fake-gateway';

// The include's output as admin on site `default`, cut from the legacy ACF 2023 server's `cUsers.list` and
// `cUsers.listusers` pages between the include's first and last byte.
const legacy = (path: string): string =>
  readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), 'utf8');

/** A lookup answering `[key]` with markup in it, to show labels are emitted unencoded. */
const STUB_RB: RbLookup = {
  locale: 'en',
  rbKey: (key) => `<b>[${key}]</b>`,
  messageFormat: () => {
    throw new Error('unused');
  },
};

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

/** The page context of `req`, without the shell, which the header never reads. */
function contextFor(req: AdminRequest, rb: RbLookup = rbFor(req.session.rb)): ScreenContext {
  const gateway = fakeGatewayClient();
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb,
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

function render(req: AdminRequest, rb?: RbLookup): string {
  const markup = renderUsersHeader(contextFor(req, rb), normaliseCusersRc(req));
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

const listRequest = (item: string, rc: Record<string, string>, partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ circuit: 'cUsers', item, rc, ...partial });

describe('renderUsersHeader', () => {
  it.each<[string, string, Record<string, string>, AdminRequestPartial?]>([
    ['identity/cusers-users-header-list.html', 'list', { siteid: 'default' }],
    ['identity/cusers-users-header-list-ispublic0.html', 'list', { siteid: 'default', ispublic: '0' }],
    ['people/cusers-users-header-listusers.html', 'listusers', { siteid: 'default', ispublic: '0' }],
    ['people/cusers-users-header-listusers-ispublic1.html', 'listUsers', { siteid: 'default', ispublic: '1' }],
    ['people/cusers-users-header-listusers-ses.html', 'listusers', { siteid: 'default', ispublic: '0' }, { ses: true }],
  ])('reproduces the legacy capture %s byte for byte', (fixture, item, rc, partial) => {
    const out = render(listRequest(item, rc, partial));
    expect(out).toBe(legacy(fixture));
    expect(normaliseIds(fragmentModel(out))).toEqual(normaliseIds(fragmentModel(legacy(fixture))));
  });

  it.each<[string, string, string, string, string]>([
    ['the user list', 'listusers', 'mi-group', '[user.viewgroups]', 'cusers'],
    ['the group list', 'list', 'mi-user', '[user.viewusers]', 'cusers.listusers'],
  ])('links %s to the other list', (_name, item, icon, label, action) => {
    const $ = cheerio.load(render(listRequest(item, { siteid: 'default', ispublic: '0' }), STUB_RB), null, false);
    const links = $('div.nav-module-specific > a.btn');
    expect(links.length).toBe(3);
    const switchLink = links.eq(2);
    expect(switchLink.find('i').attr('class')).toBe(icon);
    expect(switchLink.find('b').text()).toBe(label);
    expect(normaliseAdminUrl(switchLink.attr('href') ?? '')).toBe(`/admin/index.cfm?muraAction=${action}&siteid=default`);
  });

  it.each<[string, AdminRequest, boolean]>([
    ['an admin on member groups', listRequest('list', { siteid: 'default', ispublic: 'yes' }), true],
    ['an admin on system groups', listRequest('list', { siteid: 'default', ispublic: '0' }), false],
    ['a non-admin, whose ispublic is forced to 1', editorRequest({ circuit: 'cUsers', item: 'list', rc: { ispublic: '1' } }), false],
  ])('shows the Permissions link only to %s when it applies', (_name, req, shown) => {
    const $ = cheerio.load(render(req, STUB_RB), null, false);
    const link = $('a.btn[href^="./?muraAction=cPerm.module"]');
    expect(link.length).toBe(shown ? 1 : 0);
  });

  it('encodes the site id into every link and keeps labels raw', () => {
    const out = render(listRequest('list', { siteid: "tenant a&b'c" }), STUB_RB);
    const $ = cheerio.load(out, null, false);

    expect($('div.mura-header > h1').html()).toBe('<b>[user.groupsandusers]</b>');
    const hrefs = $('div.nav-module-specific > a.btn')
      .toArray()
      .map((el) => [el.attribs.href, el.attribs.onclick, $(el).find('b').text()]);
    expect(hrefs).toEqual([
      ['/admin/index.cfm?muraAction=cusers.edituser&siteid=tenant+a%26b%27c&userid=', 'actionModal();', '[user.adduser]'],
      ['/admin/index.cfm?muraAction=cusers.editgroup&siteid=tenant+a%26b%27c&userid=', 'actionModal();', '[user.addgroup]'],
      ['/admin/index.cfm?muraAction=cusers.listUsers&siteid=tenant+a%26b%27c', 'actionModal();', '[user.viewusers]'],
      [
        './?muraAction=cPerm.module&contentid=00000000000000000000000000000000008&siteid=tenant+a%26b%27c&moduleid=00000000000000000000000000000000008',
        'actionModal();',
        '[user.permissions]',
      ],
    ]);
    expect(out).toContain('&amp;siteid=tenant+a%26b%27c&amp;moduleid=');

    const form = $('div.mura-header > div.mura-item-metadata > form#siteSearch');
    expect(form.length).toBe(1);
    expect(form.find('input[name="siteid"]').attr('value')).toBe("tenant a&b'c");
  });
});
