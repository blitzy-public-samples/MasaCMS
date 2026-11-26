// cArch.draft of carch/draft.cfm and the carch draft() controller: the listDrafts read and its outcomes, the
// getDraftList rows as the view reads them, and the title cell and no-drafts row.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { draftScreen } from '@/screens/carch/draft';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request, editorRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

const screen = draftScreen as Required<typeof draftScreen>;
const SITE = 'default';
const DRAFTS = routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/content/drafts`);
const ROOT = '00000000000000000000000000000000001';
const SITE_MANAGER = '00000000000000000000000000000000000';
const COMPONENTS = '00000000000000000000000000000000003';
const PAGE_ID = 'D2000000-0000-0000-0000000000000001';
const COMPONENT_ID = 'D2000000-0000-0000-0000000000000002';
const DRAFT = { circuit: 'cArch', item: 'draft' } as const;

type Row = Record<string, unknown>;

/** A draft Page with its breadcrumb, columns cased as getDraftList returns them. */
const pageRow: Row = {
  ContentID: PAGE_ID,
  Type: 'Page',
  ParentID: ROOT,
  ModuleID: SITE_MANAGER,
  MenuTitle: 'About Us',
  Module: 'Site Manager',
  verdict: 'author',
  crumbdata: [
    { contentid: PAGE_ID, siteid: SITE, type: 'Page', menutitle: 'About Us', restricted: 0, iconclass: '' },
    { contentid: ROOT, siteid: SITE, type: 'Page', menutitle: 'Home', restricted: 0, iconclass: '' },
  ],
};

/** A draft Component, which the view links by title. */
const componentRow: Row = {
  contentID: COMPONENT_ID,
  type: 'component',
  parentID: COMPONENTS,
  moduleID: COMPONENTS,
  menuTitle: 'Footer',
  module: null,
  verdict: 'Editor',
};

const drafts = (rows: readonly unknown[]): FakeReply => ({ status: 200, body: { rc: { rslist: rows } } });

/** A screen context whose drafts read answers `reply`. */
function draftContext(
  req: AdminRequest,
  reply: FakeReply,
): ScreenContext & { gateway: ReturnType<typeof fakeGatewayClient> } {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [DRAFTS]: reply }) });
}

const adminDraft = (partial: AdminRequestPartial = {}): AdminRequest => adminS2Request({ ...DRAFT, ...partial });

/** The view body of `ctx` after the controller step. */
async function renderDrafts(ctx: ScreenContext) {
  expect(await screen.redirect(ctx)).toBeUndefined();
  const view = await screen.render(ctx, await screen.load(ctx));
  const body = toString(view.body);
  return { body, $: cheerio.load(body, null, false), view };
}

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe('carch.draft controller', () => {
  it('reads the drafts once for the redirect step and the load', async () => {
    const ctx = draftContext(adminDraft(), drafts([pageRow, componentRow]));
    const { view } = await renderDrafts(ctx);

    expect(ctx.gateway.calls).toEqual([
      expect.objectContaining({ method: 'GET', path: `/v1/sites/${SITE}/content/drafts` }),
    ]);
    expect(view.ajax).toBeDefined();
  });

  it('reads the getDraftList columns case-insensitively, NULL as empty text', async () => {
    const data = await screen.load(draftContext(adminDraft(), drafts([pageRow, { ...componentRow, orderno: 2 }])));

    expect(data.rows).toEqual([
      {
        contentId: PAGE_ID,
        type: 'Page',
        parentId: ROOT,
        moduleId: SITE_MANAGER,
        menuTitle: 'About Us',
        module: 'Site Manager',
        verdict: 'author',
        crumbdata: pageRow.crumbdata,
      },
      {
        contentId: COMPONENT_ID,
        type: 'component',
        parentId: COMPONENTS,
        moduleId: COMPONENTS,
        menuTitle: 'Footer',
        module: '',
        verdict: 'Editor',
      },
    ]);
  });

  it('answers a strategies-content denial with the secure() redirect from the redirect step only', async () => {
    const ctx = draftContext(adminDraft(), { status: 401 });

    expect(await screen.redirect(ctx)).toEqual({ kind: 'location', location: './' });
    await expect(screen.load(ctx)).rejects.toThrow(
      'strategies-content denied listDrafts; the redirect step answers it',
    );
  });

  it.each<[string, FakeReply, string]>([
    ['another 4xx', { status: 404 }, 'strategies-content rejected listDrafts with HTTP 404'],
    ['a model without rslist', { status: 200, body: { rc: {} } }, 'listDrafts returned no rslist'],
    ['rslist rows that are not structs', drafts(['row']), 'listDrafts returned rslist that is not an array of structs'],
    [
      'a row without its verdict',
      drafts([{ ...pageRow, verdict: undefined }]),
      'listDrafts returned a row without its verdict',
    ],
    [
      'a crumbdata that is not an array',
      drafts([{ ...pageRow, crumbdata: 'Home' }]),
      'returned crumbdata that is not an array',
    ],
    [
      'a menu title that is not a simple value',
      drafts([{ ...pageRow, MenuTitle: { text: 'x' } }]),
      'returned menuTitle that is not',
    ],
  ])('throws for %s', async (_case, reply, message) => {
    const ctx = draftContext(adminDraft(), reply);

    expect(await screen.redirect(ctx)).toBeUndefined();
    await expect(screen.load(ctx)).rejects.toThrow(message);
  });
});

describe('carch.draft view', () => {
  it('links a component by title and a page by its breadcrumb, each with its history link', async () => {
    const { $ } = await renderDrafts(draftContext(adminDraft(), drafts([pageRow, componentRow])));
    const history = (id: string, type: string, parent: string, module: string): string =>
      `./?muraAction=cArch.hist&contentid=${id}&type=${type}&parentid=${parent}` +
      `&topid=${ROOT}&siteid=${SITE}&moduleid=${module}`;

    expect($('h1').text()).toBe('Drafts');
    expect(
      $('li.version-history a')
        .toArray()
        .map((a) => $(a).attr('href')),
    ).toEqual([
      history(PAGE_ID, 'Page', ROOT, SITE_MANAGER),
      history(COMPONENT_ID, 'component', COMPONENTS, COMPONENTS),
    ]);
    const titles = $('td.var-width');
    expect(titles.eq(0).text()).toContain('About Us');
    expect(titles.eq(0).find('a[title="Version History"]')).toHaveLength(0);
    expect(titles.eq(1).find('a').attr('title')).toBe('Version History');
    expect(titles.eq(1).find('a').text()).toBe('Footer');
    expect($('tr').eq(1).find('td').last().text()).toBe('Site Manager');
  });

  it.each<[string, readonly Row[]]>([
    ['no draft exists', []],
    ['every draft is only readable', [{ ...pageRow, verdict: 'read' }]],
  ])('prints the no-drafts row for qa_editor when %s', async (_case, rows) => {
    const { $ } = await renderDrafts(draftContext(editorRequest(DRAFT), drafts(rows)));

    expect($('td.noResults').attr('colspan')).toBe('3');
    expect($('td.noResults').text().trim()).toBe('You currently have no drafts available for review.');
  });

  it('reads rc.topid by any casing for the history links', async () => {
    const req = adminDraft({ rc: { ajaxrequest: 'true', TopID: 'T-1', moduleid: SITE_MANAGER } });
    const { $ } = await renderDrafts(draftContext(req, drafts([componentRow])));

    expect($('li.version-history a').attr('href')).toContain('&topid=T-1&siteid=default&');
  });

  it.each<[string, AdminRequestPartial, readonly Row[], string]>([
    [
      'a breadcrumb row comes without crumbdata',
      {},
      [{ ...pageRow, crumbdata: undefined }],
      'a breadcrumb row without crumbdata',
    ],
    [
      'an ajax request lists a draft without rc.topid',
      { rc: { ajaxrequest: 'true' } },
      [componentRow],
      'Element TOPID is undefined in RC.',
    ],
  ])('fails as legacy does when %s', async (_case, partial, rows, message) => {
    const ctx = draftContext(adminDraft(partial), drafts(rows));
    const data = await screen.load(ctx);

    expect(() => screen.render(ctx, data)).toThrow(message);
  });
});
