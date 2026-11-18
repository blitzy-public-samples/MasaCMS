// ccomments.default against admin/core/views/ccomments/default.cfm: definition, loader and Comments Manager markup.
import { load, type CheerioAPI } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moduleRole } from '@opt2/platform/auth';
import { deniedGate } from '@/lib/access-gate';
import { CORE_VERSION } from '@/lib/env';
import { encodeUrl, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { ccommentsDefault, renderCommentsManager, type CommentsManagerModel } from '@/screens/ccomments/default';
import { COMMENTS_MODULE_ID, ccommentsGate, commentsSiteId } from '@/screens/ccomments/shared';
import type { ScreenContext } from '@/screens/registry';
import { ccommentsDefaultData } from '../../fixtures/strategies-content/comments';
import {
  adminS2Request,
  anonymousRequest,
  makeAdminRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';
import { SUBJECTS } from '../../helpers/tokens';

const MANAGER = { circuit: 'ccomments', item: 'default' } as const;
const WRAPPER = '#commentsManagerWrapper';
const COMMENT_SCRIPT = 'assets/js/comment.js?coreversion=7.6.1';

type Ctx = ScreenContext & { gateway: FakeGatewayClient };

/** strategies-content `listComments` path of `siteid`; the contract has no `/ccomments/default` path. */
const commentsPath = (siteid: string): `/${string}` => `/v1/sites/${siteid}/comments`;

/** Legacy Permissions href of the comments module on `encodedSiteId`. */
const permissionsHref = (encodedSiteId: string): string =>
  `./?muraAction=cPerm.module&contentid=${COMMENTS_MODULE_ID}&siteid=${encodedSiteId}&moduleid=${COMMENTS_MODULE_ID}`;

/** A context for `req` whose strategies-content answers the requested site's comments page with `reply`. */
function contextFor(req: AdminRequest, reply: FakeReply = { status: 200, body: ccommentsDefaultData }): Ctx {
  const gateway = fakeGatewayClient({
    [routeKey('GET', 'strategies-content', commentsPath(commentsSiteId(req)))]: reply,
  });
  return makeScreenContext({ req, gateway });
}

/** The in-shell document of `req`, parsed, with the context that rendered it. */
async function renderPage(req: AdminRequest): Promise<{ $: CheerioAPI; ctx: Ctx }> {
  const ctx = contextFor(req);
  const page = await renderScreenPage(ccommentsDefault, ctx);
  if (page.kind !== 'document') throw new Error(`The page redirected to ${page.location}`);
  return { $: load(page.html), ctx };
}

/** qa_editor holding the comments and Site Manager module grants only. */
const modulePermRequest = (partial: AdminRequestPartial = {}): AdminRequest =>
  makeAdminRequest(
    { ...MANAGER, ...partial, user: { roles: [...SUBJECTS.qaEditor.roles, moduleRole(COMMENTS_MODULE_ID)] } },
    'qaEditor',
  );

/** The renderer's markup for `model`, parsed as a fragment, with the session bundle the handlers use. */
function renderFragment(model: CommentsManagerModel): CheerioAPI {
  const rb = rbFor(adminS2Request(MANAGER).session.rb);
  return load(toString(renderCommentsManager(model, rb)), null, false);
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('ccommentsDefault definition', () => {
  it('declares the strategies-content page under the ccomments gate', () => {
    expect(ccommentsDefault).toMatchObject({
      circuit: 'ccomments',
      action: 'default',
      mode: 'page',
      owner: 'strategies-content',
    });
    expect(ccommentsDefault.gate).toBe(ccommentsGate);
  });

  it.each([
    ['the session site', {}, 'default'],
    ['rc.siteid', { rc: { siteid: 'tenant-a' } }, 'tenant-a'],
  ] as const)('loads the comments page of %s', async (_source, partial, siteid) => {
    const ctx = contextFor(adminS2Request({ ...MANAGER, ...partial }));
    await ccommentsDefault.load!(ctx);
    expect(ctx.gateway.calls.map(({ service, method, path }) => ({ service, method, path }))).toEqual([
      { service: 'strategies-content', method: 'GET', path: commentsPath(siteid) },
    ]);
  });

  it('builds the S2 model', async () => {
    const ctx = contextFor(adminS2Request(MANAGER));
    expect(await ccommentsDefault.load!(ctx)).toEqual({ siteid: 'default', canManage: true, canPurge: true });
  });

  it('answers a service denial with the logged-in secure() redirect', async () => {
    const ctx = contextFor(adminS2Request(MANAGER), { status: 403 });
    expect(await renderScreenPage(ccommentsDefault, ctx)).toEqual(deniedGate(403, ctx.req));
    expect(await renderScreenPage(ccommentsDefault, ctx)).toEqual({ kind: 'redirect', location: './' });
  });
});

describe('ccommentsDefault page for S2', () => {
  let $: CheerioAPI;
  let rb: (key: string) => string;

  beforeEach(async () => {
    const rendered = await renderPage(adminS2Request(MANAGER));
    $ = rendered.$;
    rb = (key) => rendered.ctx.rb.rbKey(key);
  });

  it('references comment.js and starts the search', () => {
    const script = $('script[src^="assets/js/comment.js"]');
    expect(script.toArray().map((el) => ({ src: $(el).attr('src'), type: $(el).attr('type') }))).toEqual([
      { src: COMMENT_SCRIPT, type: 'text/javascript' },
    ]);
    expect(`assets/js/comment.js?coreversion=${CORE_VERSION}`).toEqual(COMMENT_SCRIPT);
    const inline = $('script:not([src])')
      .toArray()
      .map((el) => $(el).html() ?? '');
    expect(inline.filter((body) => body.includes("commentManager.loadSearch('')"))).toHaveLength(1);
  });

  it('renders the manager heading', () => {
    expect($(`${WRAPPER} > .mura-header > h1`).text()).toEqual(rb('comments.commentsmanager'));
  });

  it('renders the header toolbar', () => {
    expect($(`${WRAPPER} .mura-header .nav-module-specific.btn-group`)).toHaveLength(1);
  });

  it('renders permissions link for S2', () => {
    const link = $(`${WRAPPER} .nav-module-specific a.btn[href*="cPerm.module"]`);
    expect(link).toHaveLength(1);
    expect(link.attr('href')).toEqual(permissionsHref('default'));
    expect(link.find('i.mi-group')).toHaveLength(1);
    expect(link.text()).toContain(rb('sitemanager.permissions'));
  });

  it('renders the purge button for S2', () => {
    const purge = $('a#purge-comments');
    expect(purge).toHaveLength(1);
    expect(purge.attr('class')).toEqual('btn btn-default');
    expect(purge.attr('data-alertmessage')).toEqual(rb('comments.message.confirm.purge'));
    expect(purge.text()).toContain(rb('comments.purgedeletedcomments'));
  });

  it('renders the empty search target', () => {
    const form = $('form#frmSearch');
    expect(form.attr('action')).toEqual('index.cfm');
    const target = form.find('div#commentSearch');
    expect(target).toHaveLength(1);
    expect(target.html()).toEqual('');
  });
});

describe('ccommentsDefault toolbar visibility', () => {
  it('renders the toolbar without purge for the tenant-a site admin', async () => {
    const { $ } = await renderPage(siteAdminRequest('tenant-a', MANAGER));
    expect($(`${WRAPPER} .nav-module-specific.btn-group`)).toHaveLength(1);
    expect($(`${WRAPPER} a.btn[href*="cPerm.module"]`).attr('href')).toEqual(permissionsHref('tenant-a'));
    expect($('#purge-comments')).toHaveLength(0);
  });

  it('omits the toolbar for a module-permission user', async () => {
    const { $, ctx } = await renderPage(modulePermRequest());
    expect($(`${WRAPPER} .nav-module-specific`)).toHaveLength(0);
    expect($('#purge-comments')).toHaveLength(0);
    expect($(`${WRAPPER} a[href*="cPerm.module"]`)).toHaveLength(0);
    expect($(`${WRAPPER} > .mura-header > h1`).text()).toEqual(ctx.rb.rbKey('comments.commentsmanager'));
    expect($('form#frmSearch')).toHaveLength(1);
  });

  it('renders permissions without purge when purge is off', () => {
    const $ = renderFragment({ siteid: 'default', canManage: true, canPurge: false });
    expect($('a.btn[href*="cPerm.module"]').attr('href')).toEqual(permissionsHref('default'));
    expect($('#purge-comments')).toHaveLength(0);
  });

  it('url-encodes the siteid of the permissions link', () => {
    const $ = renderFragment({ siteid: 'a&b c', canManage: true, canPurge: false });
    const href = $('a.btn[href*="cPerm.module"]').attr('href') ?? '';
    expect(href).toEqual(permissionsHref(encodeUrl('a&b c')));
    expect(href).not.toContain('&b');
  });
});

describe('ccommentsDefault rc.processed feedback', () => {
  it.each([
    ['true', 'success', 'comments.message.confirmation'],
    ['false', 'error', 'comments.message.error'],
    ['yes', 'success', 'comments.message.confirmation'],
  ] as const)('renders processed=%s as alert-%s', async (processed, outcome, key) => {
    const { $, ctx } = await renderPage(adminS2Request({ ...MANAGER, rc: { processed } }));
    const feedback = $('div#feedback');
    expect(feedback.attr('class')).toEqual(`alert alert-${outcome}`);
    expect(feedback.find('button.close[data-dismiss="alert"]')).toHaveLength(1);
    expect(feedback.text().trim()).toEqual(ctx.rb.rbKey(key));
  });

  it.each([
    ['absent', {}],
    ['not boolean', { processed: 'abc' }],
  ] as const)('renders no feedback when processed is %s', async (_state, rc) => {
    const { $ } = await renderPage(adminS2Request({ ...MANAGER, rc }));
    expect($('#feedback')).toHaveLength(0);
  });
});

describe('ccommentsDefault gate', () => {
  it('redirects anonymous users without loading comments', async () => {
    const req = anonymousRequest(MANAGER);
    const ctx = contextFor(req);
    expect(await renderScreenPage(ccommentsDefault, ctx)).toMatchObject({ kind: 'redirect' });
    expect(ctx.gateway.calls.filter(({ path }) => path === commentsPath(commentsSiteId(req)))).toEqual([]);
  });
});
