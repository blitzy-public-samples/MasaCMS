// cArch.audit of carch/audit.cfm over the recorded tenant-a model: header includes, status block, source chain rows,
// the line-192 Delete rule with its CSRF tokens, the draft prompt, the Site Manager script and the module gate.
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { TENANT_A } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditScreen, type AuditData } from '@/screens/carch/audit';
import { draftPromptJs } from '@/screens/carch/partials/draft-prompt-js';
import { carchJs } from '@/screens/carch/partials/js';
import { dspZoom } from '@/screens/carch/partials/zoom';
import { renderCarchSecondaryMenu } from '@/screens/carch/secondary-menu';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type RecordedRequest } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';
import { CARCH_PATHS, CONTENT_HIST_IDS, CONTENT_IDS, carchAuditData } from '../../fixtures/strategies-content/carch';

type Struct = Record<string, unknown>;
type Req = ReturnType<typeof editorRequest>;
type Ctx = ReturnType<typeof makeScreenContext>;

const SITE = TENANT_A.siteId;
const ROOT = '00000000000000000000000000000000001';
const SITE_MANAGER = '00000000000000000000000000000000000';
const CONTENT_ID = CONTENT_IDS.aboutUs;
const DRAFT = CONTENT_HIST_IDS.aboutUsDraft;
const ACTIVE = CONTENT_HIST_IDS.aboutUs;
const ARCHIVED = CONTENT_HIST_IDS.aboutUsArchived;
const LOCK_HOLDER = '5A000000-0000-0000-00000000000000FF';
const CSRF_PATH = '/v1/csrf/tokens';

/** The secondary menu's url-token contexts for the audited version. */
const MENU_CONTEXTS = [`${CONTENT_ID}deleteall`, `${DRAFT}delete`, `${CONTENT_ID}deletehistall`];

const ITEMS = carchAuditData.rc.items as readonly Struct[];

/** Status labels of the fixture's draft, published and archived versions. */
const STATUSES = ['Draft', 'Published', 'Archived'];

const AUDIT_RC = Object.freeze({
  contentid: CONTENT_ID,
  contenthistid: DRAFT,
  siteid: SITE,
  moduleid: SITE_MANAGER,
  parentid: ROOT,
  topid: ROOT,
  type: 'Page',
});

/** `partial` on cArch.audit of the fixture's draft in tenant-a's session. */
const onAudit = (partial: AdminRequestPartial = {}): AdminRequestPartial => ({
  ...partial,
  circuit: 'cArch',
  item: 'audit',
  session: { ...partial.session, siteid: SITE },
  rc: { ...AUDIT_RC, ...partial.rc },
});

/** `partial` on a token the gateway minted for tenant-a. */
const onTenantA = (partial?: AdminRequestPartial): AdminRequestPartial => ({
  ...onAudit(partial),
  user: { site: SITE, tid: TENANT_A.tenantId },
});

/** qa_editor: Site Manager access without site admin or S2. */
const editor = (partial?: AdminRequestPartial): Req => editorRequest(onTenantA(partial));

const siteAdmin = (partial?: AdminRequestPartial): Req => siteAdminRequest(SITE, onAudit(partial));

const s2Admin = (partial?: AdminRequestPartial): Req => adminS2Request(onTenantA(partial));

/** Per-context token: the uppercase MD5 of the context, so a link's token names the context it was issued for. */
const tokenFor = (context: string): string => createHash('md5').update(context).digest('hex').toUpperCase();

function issueTokens(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => ({
    context,
    csrf_token: tokenFor(context),
    csrf_token_expires: FIXED_CSRF.expires,
  }));
  return { status: 200, body: { tokens } };
}

/** The fixture model with `values` laid over a deep copy of its rc. */
const withRc = (values: Struct): Struct => ({ ...structuredClone(carchAuditData.rc), ...values });

/** The fixture model with the node locked by another user. */
function lockedRc(): Struct {
  const rc = structuredClone(carchAuditData.rc);
  const bean = rc.contentBean as { stats: Struct };
  bean.stats.lockID = LOCK_HOLDER;
  bean.stats.lockType = 'node';
  rc.lockedBy = { fname: 'Jane', lname: 'Doe', email: 'jane.doe@example.com' };
  return rc;
}

function contextFor(req: Req, rc: Struct = carchAuditData.rc): Ctx {
  const gateway = fakeGatewayClient({
    [routeKey('GET', 'strategies-content', CARCH_PATHS.audit)]: { status: 200, body: { rc } },
    [routeKey('POST', 'identity', CSRF_PATH)]: issueTokens,
  });
  return makeScreenContext({ req, gateway });
}

/** The page inside the shell; a redirect fails the test. */
async function renderAudit(req: Req, rc?: Struct): Promise<{ ctx: Ctx; html: string; $: CheerioAPI }> {
  const ctx = contextFor(req, rc);
  const page = await renderScreenPage(auditScreen, ctx);
  if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
  return { ctx, html: page.html, $: cheerio.load(page.html) };
}

async function loadData(ctx: Ctx): Promise<AuditData> {
  if (auditScreen.load === undefined) throw new TypeError('cArch.audit loads no data');
  return auditScreen.load(ctx);
}

/** Contexts of each identity token request in call order; the first is the view's own prefetch. */
const tokenRequests = (ctx: Ctx): unknown[] =>
  ctx.gateway.calls
    .filter((call) => call.service === 'identity' && call.path === CSRF_PATH)
    .map((call) => (call.json as { readonly contexts: unknown }).contexts);

const rowOf = ($: CheerioAPI, contentHistId: string) =>
  $(`tbody td.title a[data-contenthistid="${contentHistId}"]`).closest('tr');

/** The Delete href of version `contentHistId`, in legacy parameter order, with its `<id>delete` tokens. */
const deleteHref = (contentHistId: string): string =>
  `./?muraAction=cArch.update&contenthistid=${contentHistId}&action=delete&contentid=${CONTENT_ID}` +
  `&type=Page&parentid=${ROOT}&topid=${ROOT}&siteid=${SITE}&startrow=1&moduleid=${SITE_MANAGER}` +
  `&compactDisplay=false&csrf_token=${tokenFor(`${contentHistId}delete`)}&csrf_token_expires=${FIXED_CSRF.expires}`;

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe('cArch.audit', () => {
  it('prints the title, then the secondary menu and breadcrumb includes, in the header', async () => {
    const { ctx, html, $ } = await renderAudit(editor());
    const data = await loadData(ctx);
    const menu = renderCarchSecondaryMenu(ctx, {
      content: data.content,
      perm: data.view.perm,
      deletable: data.view.deletable,
      hasLockableNodes: data.hasLockableNodes,
      purgeDrafts: data.purgeDrafts,
    });

    expect($('.mura-header h1').text()).toBe('Audit Trail');
    expect(
      $('.mura-header')
        .children()
        .toArray()
        .map((el) => $(el).attr('class') ?? el.tagName),
    ).toEqual(['h1', 'nav-module-specific btn-group', 'breadcrumb']);
    expect(html).toContain(`${String(menu)}${String(dspZoom(ctx, { crumbdata: data.crumbs, class: 'breadcrumb' }))}`);
    expect(
      $('.mura-header ul.breadcrumb li')
        .toArray()
        .map((li) => $(li).text().trim()),
    ).toEqual(['Home', 'About Us']);
    expect($('.mura-header ul.breadcrumb strong').text().trim()).toBe('About Us');
  });

  it('omits the secondary menu and breadcrumb in compact display', async () => {
    const { ctx, html, $ } = await renderAudit(editor({ rc: { compactDisplay: 'true' } }));

    expect($('.mura-header h1').text()).toBe('Audit Trail');
    expect($('.mura-header .nav-module-specific, .mura-header ul.breadcrumb')).toHaveLength(0);
    expect(tokenRequests(ctx)[0]).toEqual([`${DRAFT}delete`, `${ARCHIVED}delete`]);
    expect(html).toContain("frontEndProxy.post({cmd:'setWidth',width:'standard'});");
  });

  it('prints no lock notice or approval status for an unlocked node', async () => {
    const { $ } = await renderAudit(editor());

    expect($('#msg-node-locked, #msg-node-locked-else, #approvalModalContainer')).toHaveLength(0);
  });

  it.each<[string, () => Req, boolean]>([
    ['the site admin, with the unlock link and edit links', () => siteAdmin(), true],
    ['a non-admin editor, without either', () => editor(), false],
  ])('shows the lock holder to %s', async (_who, req, poweruser) => {
    const { ctx, $ } = await renderAudit(req(), lockedRc());

    expect($('#msg-node-locked-else').text()).toContain('Jane Doe');
    expect($('#msg-node-locked-else a[href^="mailto:jane.doe@example.com"]')).toHaveLength(1);
    expect($('#msg-node-locked-else a.mura-node-unlock')).toHaveLength(poweruser ? 1 : 0);
    expect($('tbody td.title a')).toHaveLength(poweruser ? ITEMS.length : 0);
    expect(tokenRequests(ctx).flat()).toContain(`${CONTENT_ID}unlocknode`);
  });

  it('lists the source chain from the audited version', async () => {
    const { $ } = await renderAudit(editor());
    const rows = $('tbody tr')
      .toArray()
      .map((tr) => {
        const row = $(tr);
        return {
          contentHistId: row.find('td.title a').attr('data-contenthistid'),
          title: row.find('td.title').text().trim(),
          notes: row.find('td.notes span').attr('data-content'),
          status: row.find('td.status').text(),
          user: row.find('td.user').text(),
        };
      });

    expect(rows).toEqual(
      ITEMS.map((item, index) => ({
        contentHistId: item.contentHistID,
        title: item.menuTitle,
        notes: item.notes,
        status: STATUSES[index],
        user: item.lastUpdateBy,
      })),
    );
  });

  const inactive = [DRAFT, ARCHIVED];
  const noPurge = withRc({ purgeDrafts: 0 });
  const activeOnly = withRc({ items: ITEMS.filter((item) => item.contentHistID === ACTIVE) });

  it.each<[string, () => Req, Struct, readonly string[]]>([
    ['each inactive version for an editor when drafts may be purged', () => editor(), carchAuditData.rc, inactive],
    [
      'no version for a non-admin editor without purgeDrafts, whatever rc claims',
      () => editor({ rc: { s2: '1', isS2: 'true', isSiteAdmin: 'true', memberships: 'S2' } }),
      noPurge,
      [],
    ],
    ['no version on a node verdict of none', () => editor(), withRc({ perm: 'none' }), []],
    ['each inactive version for the site admin without purgeDrafts', () => siteAdmin(), noPurge, inactive],
    ['each inactive version for the S2 admin without purgeDrafts', () => s2Admin(), noPurge, inactive],
    ['no version of a node someone else locked', () => siteAdmin(), lockedRc(), []],
    ['no active version', () => s2Admin(), activeOnly, []],
  ])('offers Delete on %s', async (_case, req, rc, linked) => {
    const { ctx, $ } = await renderAudit(req(), rc);
    const links = $('tbody li.delete a').toArray();

    expect(links.map((a) => $(a).attr('href'))).toEqual(linked.map(deleteHref));
    expect(links.map((a) => $(a).attr('onclick'))).toEqual(
      linked.map(() => "return confirmDialog('Delete\\x20Version\\x3F',this.href)"),
    );
    expect(tokenRequests(ctx)[0]).toEqual([...new Set([...MENU_CONTEXTS, ...linked.map((id) => `${id}delete`)])]);
  });

  // Known issue: legacy's en_US `DD` mask is the day of the year.
  it('prints the draft last update as 10/302/2026', async () => {
    const { $ } = await renderAudit(editor());
    const draft = rowOf($, DRAFT);

    expect(draft.find('td.last-updated').text()).toBe('10/302/2026');
    expect(draft.find('td.time').text()).toBe('2:05 PM');
  });

  it.each<[number, boolean]>([
    [1, true],
    [0, false],
  ])('prints the draft prompt script when hasLockableNodes is %s: %s', async (hasLockableNodes, present) => {
    const { ctx, html } = await renderAudit(editor(), withRc({ hasLockableNodes }));

    expect(html.includes(String(draftPromptJs(ctx)))).toBe(present);
    expect(html.includes('initDraftPrompt();')).toBe(present);
  });

  it('hands the Site Manager script to the shell as request.ajax', async () => {
    const ctx = contextFor(editor());
    expect(await auditScreen.redirect?.(ctx)).toBeUndefined();

    const view = await auditScreen.render(ctx, await loadData(ctx));

    expect(String(view.ajax)).toBe(String(carchJs(ctx, 'audit')));
  });

  it("answers an anonymous request with the controller's secure() redirect before any read", async () => {
    const req = anonymousRequest(onAudit());
    const ctx = contextFor(req);
    const sentinel = { kind: 'redirect', location: './?secure' } as const;

    expect(auditScreen.gate?.(req, { secure: () => sentinel })).toBe(sentinel);
    expect(await renderScreenPage(auditScreen, ctx)).toEqual({
      kind: 'redirect',
      location: expect.stringMatching(/^\.\/\?muraAction=cLogin\.main&returnURL=/),
    });
    expect(ctx.gateway.calls.filter((call) => call.service === 'strategies-content')).toEqual([]);
  });
});
