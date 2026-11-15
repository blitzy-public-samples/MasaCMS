// cArch.hist page suite (carch/hist.cfm) over the recorded strategies-content history of About Us on tenant-a.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secure } from '@/lib/access-gate';
import { dateKeyFor, formatDateField } from '@/lib/dates';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { histScreen } from '@/screens/carch/hist';
import { carchJs } from '@/screens/carch/partials/js';
import { anonymousRequest, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { domModel } from '../../helpers/dom-model';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';
import { CARCH_PATHS, CONTENT_HIST_IDS, CONTENT_IDS, carchHistData } from '../../fixtures/strategies-content/carch';

type Struct = Record<string, unknown>;

const SITE = 'tenant-a';
const CONTENT_ID = CONTENT_IDS.aboutUs;
const ROOT_ID = '00000000000000000000000000000000001';
const SITE_MANAGER = '00000000000000000000000000000000000';
const DRAFT = CONTENT_HIST_IDS.aboutUsDraft;
const ACTIVE = CONTENT_HIST_IDS.aboutUs;
const ARCHIVED = CONTENT_HIST_IDS.aboutUsArchived;
const OTHER_USER = 'B0000000-0000-0000-0000000000000002';
const HISTORY_ROUTE = routeKey('GET', 'strategies-content', CARCH_PATHS.hist);
const CSRF_QUERY = `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;

const fixtureRc = (): Struct => structuredClone(carchHistData.rc);
const fixtureVersions = (): Struct[] => fixtureRc()['items'] as Struct[];
const previewUrlOf = (contentHistId: string): unknown =>
  fixtureVersions().find((item) => item['contentHistID'] === contentHistId)?.['previewURL'];

function lockedRc(stats: Struct, rc: Struct = {}): Struct {
  const base = fixtureRc();
  const bean = base['contentBean'] as Struct;
  return { ...base, contentBean: { ...bean, stats: { ...(bean['stats'] as Struct), ...stats } }, ...rc };
}

const histRequest = (): AdminRequest =>
  siteAdminRequest(SITE, { circuit: 'cArch', item: 'hist', rc: { contentid: CONTENT_ID } });

function histContext(req: AdminRequest, reply: FakeReply) {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [HISTORY_ROUTE]: reply }) });
}

const csrfContexts = (gateway: FakeGatewayClient): string[] =>
  gateway.calls
    .filter((call) => call.service === 'identity' && call.path === '/v1/csrf/tokens')
    .flatMap((call) => (call.json as { readonly contexts: readonly string[] }).contexts);

async function renderView(rc: Struct = fixtureRc(), req: AdminRequest = histRequest()) {
  const ctx = histContext(req, { status: 200, body: { rc } });
  if (histScreen.load === undefined) throw new TypeError('cArch.hist loads no data');
  expect(await histScreen.redirect?.(ctx)).toBeUndefined();
  const view = await histScreen.render(ctx, await histScreen.load(ctx));
  const body = toString(view.body);
  return { ctx, view, body, $: cheerio.load(body, null, false), model: domModel(body) };
}

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe('cArch.hist', () => {
  it('reads the node history of rc.contentid on the session site', async () => {
    const { ctx } = await renderView();

    expect(ctx.gateway.calls.filter((call) => call.service === 'strategies-content')).toMatchObject([
      { method: 'GET', path: CARCH_PATHS.hist },
    ]);
  });

  it('prints the header, the history secondary menu and the breadcrumb', async () => {
    const { $ } = await renderView();
    const header = $('div.mura-header');
    const menuLinks = header
      .find('div.nav-module-specific a[href]')
      .toArray()
      .map((a) => $(a).attr('href') ?? '');
    const crumbs = header.find('ul.breadcrumb > li');

    expect(header.children('h1').text()).toBe('Version History');
    expect(header.find('div.nav-module-specific')).toHaveLength(1);
    expect(menuLinks[0]).toBe(`./?muraAction=cArch.list&siteid=${SITE}&moduleid=${SITE_MANAGER}`);
    expect(menuLinks.find((href) => href.includes('action=deletehistall'))).toContain(
      `contentid=${CONTENT_ID}&type=Page&parentid=&topid=${ROOT_ID}&siteid=${SITE}&startrow=1&moduleid=${SITE_MANAGER}&compactDisplay=false${CSRF_QUERY}`,
    );
    expect(menuLinks.find((href) => href.includes('action=deleteall'))).toContain(CSRF_QUERY);
    expect(menuLinks.some((href) => href.startsWith(`./?muraAction=cPerm.main&contentid=${CONTENT_ID}`))).toBe(true);
    expect(crumbs.toArray().map((li) => $(li).text().trim())).toEqual(['Home', 'About Us']);
    expect(crumbs.last().find('strong a').text()).toBe('About Us');
    expect(crumbs.find('a').toArray().map((a) => $(a).attr('href'))).toEqual([
      `/admin/?muraAction=cArch.list&siteid=${SITE}&topid=${ROOT_ID}&moduleid=${SITE_MANAGER}&activeTab=0`,
      `/admin/?muraAction=cArch.list&siteid=${SITE}&topid=${CONTENT_ID}&moduleid=${SITE_MANAGER}&activeTab=0`,
    ]);
  });

  it('prints no status notice for an unlocked node, and no approval block', async () => {
    const { $, ctx } = await renderView();

    expect($('#msg-node-locked, #msg-node-locked-else, #approvalModalContainer')).toHaveLength(0);
    expect(csrfContexts(ctx.gateway)).not.toContain(`${CONTENT_ID}unlocknode`);
  });

  it("shows the session user's node lock with the carch.unlockNode script", async () => {
    const req = histRequest();
    const { $, body, ctx } = await renderView(lockedRc({ lockID: req.session.mura.userID, lockType: 'node' }), req);

    expect($('#msg-node-locked').attr('style')).toBeUndefined();
    expect($('#msg-node-locked a.mura-node-unlock').text().trim()).toBe('Unlock');
    expect(body).toContain(`muraAction:"carch.unlockNode",\n\t\t\t\t\t\t\t\t\tcontentid:"${CONTENT_ID}"`);
    expect(csrfContexts(ctx.gateway)).toContain(`${CONTENT_ID}unlocknode`);
    expect($('tbody li.delete')).toHaveLength(2);
  });

  it("shows another holder's lock, keeping Edit for the site admin and withholding Delete", async () => {
    const rc = lockedRc(
      { lockID: OTHER_USER, lockType: 'node' },
      { lockedBy: { fname: 'Jane', lname: 'Doe', email: 'jane@example.com' } },
    );
    const { $, ctx } = await renderView(rc);

    expect($('#msg-node-locked-else').text()).toContain('Jane Doe');
    expect($('#msg-node-locked-else a[href^="mailto:jane@example.com"]')).toHaveLength(1);
    expect($('tbody li.edit')).toHaveLength(3);
    expect($('tbody li.delete')).toHaveLength(0);
    expect(csrfContexts(ctx.gateway)).not.toContain(`${DRAFT}delete`);
    expect(csrfContexts(ctx.gateway)).not.toContain(`${ARCHIVED}delete`);
  });

  it('lists one row per version with its status, last update, time and author', async () => {
    const { model } = await renderView();
    const [table] = model.tables;

    expect(model.tables).toHaveLength(1);
    expect(table?.headers).toEqual(['', 'Compare', 'Title', 'Notes', 'Status', 'Update', 'Time', 'Author/Editor']);
    expect(table?.rows).toEqual([
      ['Edit Preview Audit Trail Delete', '', '', 'About Us', 'View Notes', 'Draft', '10/302/2026', '2:05 PM', 'Quinn Editor'],
      ['Edit Preview Audit Trail', '', '', 'About Us', 'View Notes', 'Published', '06/181/2026', '9:15 AM', 'Admin User'],
      ['Edit Preview Audit Trail Delete', '', '', 'About Us', 'View Notes', 'Archived', '05/132/2026', '10:00 AM', 'Tessa Admin'],
    ]);
  });

  it('prints a 2026-10-29 update as 10/302/2026', async () => {
    const { $ } = await renderView();

    // Reproduced legacy date-mask issue: session.dateKeyFormat prints the day of the year.
    expect($(`tr[data-contenthistid="${DRAFT}"] td.last-updated`).text()).toBe('10/302/2026');
    expect(formatDateField('2026-10-29 14:05:00', dateKeyFor('en_US').dateKeyFormat)).toBe('10/302/2026');
  });

  it.each([
    ['draft', DRAFT],
    ['published', ACTIVE],
    ['archived', ARCHIVED],
  ])('links the %s version to Edit, Preview and its Audit Trail', async (_status, contentHistId) => {
    const { $, model } = await renderView();
    const row = $(`tr[data-contenthistid="${contentHistId}"]`);
    const edit = row.find('li.edit a');
    const editHref =
      `./?muraAction=cArch.edit&contenthistid=${contentHistId}&contentid=${CONTENT_ID}&type=Page&parentid=` +
      `&topid=${ROOT_ID}&siteid=${SITE}&startrow=1&moduleid=${SITE_MANAGER}&return=hist&compactDisplay=false`;

    expect(row.attr('data-siteid')).toBe(SITE);
    expect(edit.attr('href')).toBe(editHref);
    expect([edit.attr('class'), edit.attr('data-targetversion'), edit.attr('data-contenthistid')]).toEqual([
      'draftprompt',
      'true',
      contentHistId,
    ]);
    expect(row.find('td.title a').attr('href')).toBe(editHref);
    expect(row.find('li.preview a').attr('href')).toBe(previewUrlOf(contentHistId));
    expect(row.find('li.audit-trail a').attr('href')).toBe(
      `./?muraAction=cArch.audit&contentid=${CONTENT_ID}&contenthistid=${contentHistId}&type=Page` +
        `&parentid=${ROOT_ID}&topid=${ROOT_ID}&siteid=${SITE}&moduleid=${SITE_MANAGER}&compactDisplay=false`,
    );
    expect(model.links.filter((link) => link.href.includes(`contenthistid=${contentHistId}`))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Edit', href: expect.stringContaining('muraAction=carch.edit') }),
        expect.objectContaining({ text: 'Audit Trail', href: expect.stringContaining('muraAction=carch.audit') }),
      ]),
    );
  });

  it('compares two versions through the Compare button and radios', async () => {
    const { $, body, model } = await renderView();
    const radios = (name: string) =>
      model.controls.filter((control) => control.name === name).map(({ value, checked }) => ({ value, checked }));
    const expected = [
      { value: DRAFT, checked: true },
      { value: ACTIVE, checked: false },
      { value: ARCHIVED, checked: false },
    ];

    expect($('thead a#viewDiff').text().trim()).toBe('Compare');
    expect(radios('compare1')).toEqual(expected);
    expect(radios('compare2')).toEqual(expected);
    expect(body).toContain(
      `siteManager.openContentDiff($('input[name="compare1"]:checked').val(),$('input[name="compare2"]:checked').val(),siteid);`,
    );
  });

  it('links Delete on the inactive versions only, each with tokens for its own context', async () => {
    const { $, body, ctx } = await renderView();
    const deleteHref = (contentHistId: string) =>
      $(`tr[data-contenthistid="${contentHistId}"] li.delete a`).attr('href');

    for (const contentHistId of [DRAFT, ARCHIVED]) {
      expect(deleteHref(contentHistId)).toBe(
        `./?muraAction=cArch.update&contenthistid=${contentHistId}&action=delete&contentid=${CONTENT_ID}&type=Page` +
          `&parentid=&topid=${ROOT_ID}&siteid=${SITE}&startrow=1&moduleid=${SITE_MANAGER}&compactDisplay=false${CSRF_QUERY}`,
      );
      expect(body).toContain(
        `href="./?muraAction=cArch.update&amp;contenthistid=${contentHistId}&amp;action=delete&amp;contentid=${CONTENT_ID}&amp;`,
      );
    }
    expect(deleteHref(ACTIVE)).toBeUndefined();
    expect($('li.delete a').first().attr('onclick')).toBe("return confirmDialog('Delete\\x20Version\\x3F',this.href)");
    expect(csrfContexts(ctx.gateway)).toEqual(expect.arrayContaining([`${DRAFT}delete`, `${ARCHIVED}delete`]));
    expect(csrfContexts(ctx.gateway)).not.toContain(`${ACTIVE}delete`);
  });

  it('highlights the audit trail of a hovered version through carch.getaudittrail', async () => {
    const { body } = await renderView();

    expect(body).toContain("$('.audit-trail').on('mouseover',function(){");
    expect(body).toContain("muraAction: 'carch.getaudittrail',");
    expect(body).toContain("contenthistid:$(this).parents('tr').attr('data-contenthistid'),");
  });

  it('adds the draft prompt with lockable nodes and the Site Manager script as request.ajax', async () => {
    const { body, view, ctx } = await renderView();
    const { body: unlockable } = await renderView({ ...fixtureRc(), hasLockableNodes: 0 });

    expect(body).toContain('$(function(){\n\tinitDraftPrompt();\n});');
    expect(body).toContain("function initDraftPrompt(){\n\t$('a.draftprompt').click(draftprompt);\n}");
    expect(unlockable).not.toContain('initDraftPrompt');
    if (view.ajax === undefined) throw new Error('cArch.hist sets no request.ajax');
    expect(toString(view.ajax)).toBe(toString(carchJs(ctx, 'hist')));
  });

  it('drops the menu and breadcrumb in the compact display and previews through the front-end proxy', async () => {
    const req = siteAdminRequest(SITE, {
      circuit: 'cArch',
      item: 'hist',
      rc: { contentid: CONTENT_ID, compactDisplay: 'true' },
    });
    const { $, body, ctx } = await renderView(fixtureRc(), req);
    const preview = $(`tr[data-contenthistid="${DRAFT}"] li.preview a`);

    expect($('div.mura-header h1').text()).toBe('Version History');
    expect($('div.nav-module-specific, ul.breadcrumb')).toHaveLength(0);
    expect(preview.attr('href')).toBe('#');
    expect(preview.attr('onclick')).toContain("frontEndProxy.post({cmd:'setLocation',location:encodeURIComponent('");
    expect($(`tr[data-contenthistid="${DRAFT}"] li.edit a`).attr('href')).toMatch(/&return=hist&compactDisplay=true$/);
    expect(body).toContain("frontEndProxy.post({cmd:'setWidth',width:'standard'});");
    expect(csrfContexts(ctx.gateway)).toEqual([`${DRAFT}delete`, `${ARCHIVED}delete`]);
  });

  it('renders inside the admin shell with the Site Manager script', async () => {
    const ctx = histContext(histRequest(), { status: 200, body: carchHistData });
    const page = await renderScreenPage(histScreen, ctx);

    if (page.kind !== 'document') throw new Error(`cArch.hist redirected to ${page.location}`);
    expect(domModel(page.html).headings).toContain('Version History');
    expect(page.html).toContain(toString(carchJs(ctx, 'hist')));
    expect(page.html.match(/class="nav-module-specific btn-group"/g)).toHaveLength(1);
  });

  it('sends an anonymous user through secure() without reading the history', async () => {
    const req = anonymousRequest({ circuit: 'cArch', item: 'hist', rc: { contentid: CONTENT_ID } });
    const ctx = histContext(req, { status: 200, body: carchHistData });
    const page = await renderScreenPage(histScreen, ctx);

    expect(page).toEqual(secure(req));
    expect(page.kind === 'redirect' ? page.location : '').toMatch(/^\.\/\?muraAction=cLogin\.main&returnURL=/);
    expect(ctx.gateway.calls.filter((call) => call.service === 'strategies-content')).toHaveLength(0);
  });

  it.each<[string, (gateway: FakeGatewayClient) => void]>([
    ['answers 503', (gateway) => gateway.setRoute(HISTORY_ROUTE, { status: 503, body: { error: 'unavailable' } })],
    ['refuses the connection', (gateway) => gateway.failWith()],
  ])('fails closed with GatewayUnavailableError when the gateway %s', async (_case, breakGateway) => {
    const ctx = histContext(histRequest(), { status: 200, body: carchHistData });
    breakGateway(ctx.gateway);

    await expect(renderScreenPage(histScreen, ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
