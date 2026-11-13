// cArch.hist of carch/hist.cfm and cArch.audit of carch/audit.cfm: the strategies-content read and its outcomes, each
// version's status, dates, preview, delete, file version, notes and change set cells, and the node lock state.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServicePath } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { auditScreen } from '@/screens/carch/audit';
import { histScreen } from '@/screens/carch/hist';
import type { PageScreen, ScreenContext } from '@/screens/registry';
import {
  adminS2Request,
  editorRequest,
  unservedEditorRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

const SITE = 'default';
const ROOT = '00000000000000000000000000000000001';
const END = '00000000000000000000000000000000END';
const SITE_MANAGER = '00000000000000000000000000000000000';
const ACTIVE = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const OLDER = '6300ED69-1320-5CC3-F922E3012E2C0002';
const OTHER_USER = 'B0000000-0000-0000-0000000000000002';

type Struct = Record<string, unknown>;

/** Home's active version bean; `overrides` replace values. */
const homeBean = (overrides: Struct = {}): Struct => ({
  isNew: 0,
  contentID: ROOT,
  siteID: SITE,
  contentHistID: ACTIVE,
  parentID: END,
  type: 'Page',
  subType: 'Default',
  active: 1,
  filename: '',
  menuTitle: 'Home',
  remoteURL: 'https://remote.example/home',
  fileID: '',
  approvalStatus: '',
  display: 1,
  isLocked: 0,
  stats: {},
  ...overrides,
});

/** One of Home's versions; `overrides` replace values. */
const version = (contentHistId: string, overrides: Struct = {}): Struct => ({
  contentHistID: contentHistId,
  contentID: ROOT,
  siteID: SITE,
  type: 'Page',
  parentID: END,
  moduleID: SITE_MANAGER,
  menuTitle: 'Home',
  active: 0,
  approved: 1,
  approvalStatus: '',
  changesetID: '',
  changesetName: '',
  changesetPublishDate: '',
  notes: '',
  majorVersion: '0',
  minorVersion: '0',
  lastUpdate: '2026-11-13 10:30:00',
  lastUpdateBy: 'Admin User',
  previewURL: `http://localhost/?previewid=${contentHistId}`,
  ...overrides,
});

const ACTIVE_VERSION = version(ACTIVE, { active: 1 });

const CRUMBS = [
  { contentid: ROOT, siteid: SITE, moduleid: SITE_MANAGER, type: 'Page', menutitle: 'Home', restricted: 0 },
];

/** A history page, the route of its screen model, that model's `rc` and the messages its own reads fail with. */
interface HistoryPage {
  readonly screen: PageScreen<unknown>;
  readonly path: ServicePath;
  readonly model: (rc?: Struct) => Struct;
  readonly badDate: string;
  readonly noPreview: string;
  readonly rejected: string;
  readonly deniedLoad: string;
}

const PAGES: ReadonlyArray<readonly [string, HistoryPage]> = [
  [
    'cArch.hist',
    {
      screen: histScreen as PageScreen<unknown>,
      path: `/v1/sites/${SITE}/content/${ROOT}/history`,
      model: (rc = {}) => ({
        contentBean: homeBean(),
        items: [ACTIVE_VERSION],
        crumbdata: CRUMBS,
        perm: 'editor',
        deletable: 0,
        hasLockableNodes: 0,
        ...rc,
      }),
      badDate: "returned lastUpdate 'soon', which is not a date",
      noPreview: 'returned no items.previewURL',
      rejected: 'rejected carch.hist with HTTP 404',
      deniedLoad: 'was denied; the controller step redirects first',
    },
  ],
  [
    'cArch.audit',
    {
      screen: auditScreen as PageScreen<unknown>,
      path: `/v1/sites/${SITE}/content/${ROOT}/versions/${ACTIVE}/audit`,
      model: (rc = {}) => ({
        contentBean: homeBean(),
        items: [ACTIVE_VERSION],
        crumbdata: CRUMBS,
        perm: 'editor',
        hasLockableNodes: 0,
        hasChangesets: 0,
        purgeDrafts: 1,
        siteLocking: 'none',
        ...rc,
      }),
      badDate: 'The value soon cannot be converted to a date.',
      noPreview: `has no previewURL for version ${ACTIVE}`,
      rejected: 'answered the carch.audit read with HTTP 404',
      deniedLoad: 'answered the carch.audit read with a redirect to ./',
    },
  ],
];

/** Home's request on `item` for the S2 admin, or for `make`; `hasChangesets` is the session site's. */
function homeRequest(
  item: string,
  partial: AdminRequestPartial = {},
  make: (partial: AdminRequestPartial) => AdminRequest = adminS2Request,
): AdminRequest {
  return make({
    ...partial,
    circuit: 'cArch',
    item,
    site: { hasChangesets: false, ...partial.site },
    rc: {
      contentid: ROOT,
      contenthistid: ACTIVE,
      siteid: SITE,
      moduleid: SITE_MANAGER,
      parentid: END,
      topid: ROOT,
      type: 'Page',
      ...partial.rc,
    },
  });
}

/** A screen context for `req` whose model read answers `reply`. */
function pageContext(page: HistoryPage, req: AdminRequest, reply: FakeReply) {
  return makeScreenContext({
    req,
    gateway: fakeGatewayClient({ [routeKey('GET', 'strategies-content', page.path)]: reply }),
  });
}

const ok = (rc: Struct): FakeReply => ({ status: 200, body: { rc } });

/** The page's view body after the controller step. */
async function renderPage(page: HistoryPage, ctx: ScreenContext): Promise<string> {
  const { screen } = page;
  if (screen.load === undefined) throw new TypeError(`${screen.action} loads no data`);
  expect(await screen.redirect?.(ctx)).toBeUndefined();
  return toString((await screen.render(ctx, await screen.load(ctx))).body);
}

/** The view of `page` over the model `rc` for `req`, as a cheerio document. */
async function renderModel(page: HistoryPage, rc: Struct, req: AdminRequest = homeRequest(page.screen.action)) {
  const ctx = pageContext(page, req, ok(page.model(rc)));
  const body = await renderPage(page, ctx);
  return { ctx, body, $: cheerio.load(body, null, false) };
}

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe.each(PAGES)('%s', (_name, page) => {
  const item = page.screen.action;

  it('answers a strategies-content denial with the secure() redirect from the redirect step only', async () => {
    const ctx = pageContext(page, homeRequest(item), { status: 403 });

    expect(await page.screen.redirect?.(ctx)).toEqual({ kind: 'location', location: './' });
    await expect(page.screen.load?.(ctx)).rejects.toThrow(page.deniedLoad);
    expect(ctx.gateway.calls.filter((call) => call.service === 'strategies-content')).toHaveLength(1);
  });

  it('throws when strategies-content rejects the read with another 4xx', async () => {
    await expect(page.screen.load?.(pageContext(page, homeRequest(item), { status: 404 }))).rejects.toThrow(
      page.rejected,
    );
  });

  it.each<[string, Struct, string]>([
    ['Published', { active: 1, approved: 1 }, 'Published'],
    ['Pending', { approved: 0, approvalStatus: 'Pending' }, 'Pending Approval'],
    ['Rejected', { approved: 0, approvalStatus: 'Rejected' }, 'Rejected'],
    ['Queued', { approved: 0, changesetID: 'CS-1', changesetName: 'Launch' }, 'Queued'],
    ['Canceled', { approved: 0, approvalStatus: 'Cancelled' }, 'Canceled'],
    ['Draft', { approved: 0 }, 'Draft'],
    ['Archived', { approved: 1 }, 'Archived'],
  ])('labels a %s version', async (_status, overrides, label) => {
    const { $ } = await renderModel(page, { items: [version(OLDER, overrides)] });

    expect($('td.status').text()).toBe(label);
  });

  it('prints the last update with the session date mask and the short time', async () => {
    const { $ } = await renderModel(page, {});

    expect($('td.last-updated').text()).toBe('11/317/2026');
    expect($('td.time').text()).toBe('10:30 AM');
    expect($('td.user').text()).toBe('Admin User');
  });

  it('prints blank date cells for a version without a last update', async () => {
    const { $ } = await renderModel(page, { items: [version(ACTIVE, { active: 1, lastUpdate: '' })] });

    expect($('td.last-updated').text()).toBe('');
    expect($('td.time').text()).toBe('');
  });

  it('fails as legacy does on a last update that is not a date', async () => {
    const ctx = pageContext(
      page,
      homeRequest(item),
      ok(page.model({ items: [version(OLDER, { lastUpdate: 'soon' })] })),
    );

    await expect(renderPage(page, ctx)).rejects.toThrow(page.badDate);
  });

  it('links Delete with its CSRF token on an inactive version only', async () => {
    const { $ } = await renderModel(page, { items: [ACTIVE_VERSION, version(OLDER)] });
    const deletes = $('tr li.delete a');

    expect(deletes).toHaveLength(1);
    expect(deletes.closest('tr').find('td.status').text()).toBe('Archived');
    const href = new URLSearchParams((deletes.attr('href') ?? '').slice(2));
    expect([href.get('muraAction'), href.get('contenthistid'), href.get('action')]).toEqual([
      'cArch.update',
      OLDER,
      'delete',
    ]);
    expect(href.get('csrf_token')).toBe(FIXED_CSRF.token);
    expect(deletes.attr('onclick')).toBe("return confirmDialog('Delete\\x20Version\\x3F',this.href)");
  });

  it("previews a Variation at the bean's remote URL", async () => {
    const items = [version(ACTIVE, { active: 1, type: 'Variation', previewURL: undefined })];
    const { $ } = await renderModel(page, { items });

    expect($('li.preview a').attr('href')).toBe(`https://remote.example/home?previewid=${ACTIVE}`);
  });

  it('fails when the model omits the preview URL of a Page version', async () => {
    const items = [version(ACTIVE, { active: 1, previewURL: undefined })];
    const ctx = pageContext(page, homeRequest(item), ok(page.model({ items })));

    await expect(renderPage(page, ctx)).rejects.toThrow(page.noPreview);
  });

  it('adds the file version column for a File whose stats carry a major version', async () => {
    const contentBean = homeBean({ type: 'File', stats: { majorVersion: 2 } });
    const items = [
      version(ACTIVE, { active: 1, type: 'File', majorVersion: '2', minorVersion: '1' }),
      version(OLDER, { type: 'File' }),
    ];
    const { $ } = await renderModel(page, { contentBean, items });
    const cells = $('tbody tr')
      .toArray()
      .map((tr) => ($(tr).find('td.title').next().html() ?? '').replace(/\s+/g, ''));

    expect(
      $('thead th')
        .toArray()
        .map((th) => $(th).text()),
    ).toContain('File Version');
    expect(cells).toEqual(['2.1', '&nbsp;']);
  });

  it('shows the notes popover of a version with notes', async () => {
    const { $ } = await renderModel(page, { items: [version(ACTIVE, { active: 1, notes: 'Fixed "typo" & link' })] });

    expect($('td.notes span').attr('data-content')).toBe('Fixed "typo" & link');
    expect($('td.notes span').text()).toBe('View\u00a0Notes');
  });

  it('shows the change set publish date and links the change set for the S2 admin', async () => {
    const items = [
      version(ACTIVE, {
        active: 1,
        changesetID: 'CS-1',
        changesetName: 'Launch',
        changesetPublishDate: '2026-12-01 09:00:00',
      }),
    ];
    const req = homeRequest(item, { site: { hasChangesets: true } });
    const { $ } = await renderModel(page, { items, hasChangesets: 1 }, req);

    expect($('td.changeset span').attr('data-content')).toBe('12/1/26');
    expect($('td.changeset a').attr('href')).toBe(
      `./?muraAction=cChangesets.assignments&siteID=${SITE}&changesetID=CS-1`,
    );
    expect($('td.changeset a').text().trim()).toBe('Launch');
  });

  it('adds the draft prompt script when the site has lockable nodes', async () => {
    const { body } = await renderModel(page, { hasLockableNodes: 1 });

    expect(body).toContain('initDraftPrompt();');
  });

  it.each<[string, (partial: AdminRequestPartial) => AdminRequest, boolean]>([
    ['the S2 admin, who may override it', adminS2Request, true],
    ['qa_editor', editorRequest, false],
  ])('shows the lock holder to %s, with edit links only for a power user', async (_who, make, editable) => {
    const contentBean = homeBean({ stats: { lockID: OTHER_USER, lockType: 'node' } });
    const rc = {
      contentBean,
      items: [ACTIVE_VERSION, version(OLDER)],
      hasLockableNodes: 1,
      lockedBy: { fname: 'Jane', lname: 'Doe', email: 'jane@example.com' },
    };
    const { $ } = await renderModel(page, rc, homeRequest(item, {}, make));

    expect($('#msg-node-locked-else').text()).toContain('Jane Doe');
    expect($('#msg-node-locked-else a[href^="mailto:"]').attr('href')).toContain('mailto:jane@example.com');
    expect($('tbody li.edit')).toHaveLength(editable ? 2 : 0);
    expect($('tbody td.title a')).toHaveLength(editable ? 2 : 0);
    expect($('tbody li.delete')).toHaveLength(0);
  });

  it('fails as legacy does when an ajax request carries no rc.startrow', async () => {
    const req = homeRequest(item, { rc: { ajaxrequest: 'true', compactDisplay: 'true' } });
    const ctx = pageContext(page, req, ok(page.model()));

    await expect(renderPage(page, ctx)).rejects.toThrow('Element STARTROW is undefined in RC.');
  });
});

describe('cArch.hist model', () => {
  const [, page] = PAGES[0] ?? [];
  if (page === undefined) throw new TypeError('cArch.hist page is not defined');

  it.each<[string, Struct, string]>([
    ['contentBean', { contentBean: undefined }, 'getContentHistory returned no contentBean struct'],
    ['items rows', { items: 'none' }, 'getContentHistory returned no items rows'],
    ['rc.deletable', { deletable: undefined }, 'getContentHistory returned no rc.deletable'],
    ['a lockedBy struct', { lockedBy: 'Jane' }, 'getContentHistory returned lockedBy that is not a struct'],
  ])('throws when the model has no %s', async (_case, rc, message) => {
    await expect(page.screen.load?.(pageContext(page, homeRequest('hist'), ok(page.model(rc))))).rejects.toThrow(
      message,
    );
  });

  it('throws when programs-sites served the user no session site', async () => {
    const ctx = pageContext(page, homeRequest('hist', {}, unservedEditorRequest), ok(page.model()));
    ctx.req = { ...ctx.req, site: undefined };

    await expect(page.screen.load?.(ctx)).rejects.toThrow(`programs-sites served no site ${SITE} for carch.hist`);
  });

  it("reads the File stats from rc.stats before the bean's", async () => {
    const contentBean = homeBean({ type: 'File', stats: { majorVersion: 0 } });
    const { $ } = await renderModel(page, { contentBean, stats: { majorVersion: 3 }, purgeDrafts: 0, lockedBy: null });

    expect(
      $('thead th')
        .toArray()
        .map((th) => $(th).text()),
    ).toContain('File Version');
  });
});

describe('cArch.audit model', () => {
  const [, page] = PAGES[1] ?? [];
  if (page === undefined) throw new TypeError('cArch.audit page is not defined');

  it.each<[string, Struct, string]>([
    ['siteLocking', { siteLocking: undefined }, 'strategies-content carch.audit model has no siteLocking'],
    ['items rows', { items: ['v1'] }, 'strategies-content carch.audit model items is not an array of structs'],
  ])('throws when the model has no %s', async (_case, rc, message) => {
    await expect(page.screen.load?.(pageContext(page, homeRequest('audit'), ok(page.model(rc))))).rejects.toThrow(
      message,
    );
  });

  it.each<[string, (partial: AdminRequestPartial) => AdminRequest, number]>([
    ['qa_editor', editorRequest, 0],
    ['the S2 admin', adminS2Request, 1],
  ])('offers %s Delete without purgeDrafts only as a site admin or S2', async (_who, make, deletes) => {
    const rc = { items: [ACTIVE_VERSION, version(OLDER)], purgeDrafts: 0 };
    const { $ } = await renderModel(page, rc, homeRequest('audit', {}, make));

    expect($('tbody li.delete')).toHaveLength(deletes);
  });
});
