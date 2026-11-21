// cUsers.search results tabs and block title per `rc.ispublic`, as search.cfm's `rc.ispublic eq 1` / `eq 0` read it on ACF 2023.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { resetLegacySettingsForTests } from '@/lib/env';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { normaliseCusersRc } from '@/screens/cusers/gate';
import { getNextN } from '@/screens/cusers/inc/dsp_nextn';
import { renderSearch } from '@/screens/cusers/search';
import { editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fakeGatewayClient } from '../../helpers/fake-gateway';

type Ctx = Parameters<typeof renderSearch>[0];

const SITE = 'tenant-a';
const MEMBERS = 'Site Members';
const SYSTEM = 'System Users';

/** The results view for `req` with no matching rows, so the users list fetches no CSRF tokens. */
async function renderFor(req: AdminRequest): Promise<cheerio.CheerioAPI> {
  const gateway = fakeGatewayClient();
  const ctx: Ctx = {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
  const view = await renderSearch(ctx, {
    rc: normaliseCusersRc(req),
    rows: [],
    nextn: getNextN(0, 25, 1),
    pageIndex: 1,
    listUnassignedUsers: '',
    noUsersMessage: '',
  });
  return cheerio.load(toString(view.body), null, false);
}

const searchRequest = (rc: Readonly<Record<string, string>>): AdminRequest =>
  siteAdminRequest(SITE, { circuit: 'cusers', item: 'search', rc });

beforeEach(() => {
  vi.stubEnv('MURA_CONTEXT', undefined);
  vi.stubEnv('MURA_ADMINDIR', undefined);
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('renderSearch tabs', () => {
  it.each<[string, string | null, string]>([
    ['1', MEMBERS, MEMBERS],
    ['1.0', MEMBERS, MEMBERS],
    ['1e0', MEMBERS, MEMBERS],
    ['+1', MEMBERS, MEMBERS],
    ['true', MEMBERS, MEMBERS],
    ['TRUE', MEMBERS, MEMBERS],
    ['yes', MEMBERS, MEMBERS],
    ['0', SYSTEM, SYSTEM],
    ['0.0', SYSTEM, SYSTEM],
    ['.0', SYSTEM, SYSTEM],
    ['false', SYSTEM, SYSTEM],
    ['no', SYSTEM, SYSTEM],
    ['1.', null, SYSTEM],
    ['2', null, SYSTEM],
    ['-1', null, SYSTEM],
  ])('ispublic=%j: active tab %j, block title %j', async (ispublic, active, title) => {
    const $ = await renderFor(searchRequest({ siteid: SITE, ispublic }));
    const tabs = $('ul.mura-tab-links > li').toArray();
    expect(tabs.map((li) => $(li).text().trim())).toEqual([MEMBERS, SYSTEM]);
    const activeTabs = tabs.filter((li) => $(li).attr('class') === 'active').map((li) => $(li).text().trim());
    expect(activeTabs).toEqual(active === null ? [] : [active]);
    expect($('h3.block-title').text()).toBe(title);
  });

  it('renders no tabs for a non-admin, under the Site Members heading', async () => {
    const $ = await renderFor(editorRequest({ circuit: 'cusers', item: 'search', rc: { ispublic: '0' } }));
    expect($('ul.mura-tab-links')).toHaveLength(0);
    expect($('h3.block-title')).toHaveLength(0);
    expect($('.block-bordered > .block-content > h3').text()).toBe(MEMBERS);
  });
});
