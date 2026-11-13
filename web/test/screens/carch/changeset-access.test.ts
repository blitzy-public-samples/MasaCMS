// carch/hist.cfm and carch/audit.cfm 83: a version's change set links to its assignments only with
// getModulePerm('…014', session.siteid).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import type { ServicePath } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { auditScreen } from '@/screens/carch/audit';
import { histScreen } from '@/screens/carch/hist';
import type { PageScreen, ScreenContext } from '@/screens/registry';
import { makeAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { SESSION_SITE_CASES } from '../../helpers/requested-site';
import { makeScreenContext } from '../../helpers/screen-context';

const ROOT = '00000000000000000000000000000000001';
const END = '00000000000000000000000000000000END';
const SITE_MANAGER = '00000000000000000000000000000000000';
const CHANGESETS = '00000000000000000000000000000000014';
const HOME_HIST = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const CHANGESET_ID = 'A1B2C3D4-0000-0000-0000000000000014';
const ASSIGNMENTS_LINK = 'muraAction=cChangesets.assignments&siteID=';

/** Home's active version of `siteId`, as both models carry it. */
const homeBean = (siteId: string) => ({
  isNew: 0,
  contentID: ROOT,
  siteID: siteId,
  contentHistID: HOME_HIST,
  parentID: END,
  type: 'Page',
  subType: 'Default',
  active: 1,
  filename: '',
  menuTitle: 'Home',
  remoteURL: '',
  fileID: '',
  approvalStatus: '',
  display: 1,
  isLocked: 0,
  stats: {},
});

/** Home's only version, assigned to an unscheduled change set. */
const homeVersion = (siteId: string) => ({
  contentHistID: HOME_HIST,
  contentID: ROOT,
  siteID: siteId,
  type: 'Page',
  parentID: END,
  moduleID: SITE_MANAGER,
  menuTitle: 'Home',
  active: 1,
  approved: 1,
  approvalStatus: '',
  changesetID: CHANGESET_ID,
  changesetName: 'Spring Launch',
  changesetPublishDate: '',
  notes: '',
  majorVersion: '',
  minorVersion: '',
  lastUpdate: '',
  lastUpdateBy: 'Admin User',
  previewURL: `http://localhost:8080/?previewid=${HOME_HIST}`,
});

const crumbs = (siteId: string) => [
  { contentid: ROOT, siteid: siteId, moduleid: SITE_MANAGER, type: 'Page', menutitle: 'Home', restricted: 0 },
];

/** The view body `screen` loads and renders for `ctx`. */
async function bodyOf<D>(screen: PageScreen<D>, ctx: ScreenContext): Promise<string> {
  if (screen.load === undefined) throw new TypeError(`${screen.action} loads no data`);
  return toString((await screen.render(ctx, await screen.load(ctx))).body);
}

/** A carch page: its action, view body, strategies-content route on `siteId`, and that model's `rc`. */
interface CarchPage {
  readonly item: string;
  readonly body: (ctx: ScreenContext) => Promise<string>;
  readonly path: (siteId: string) => ServicePath;
  readonly model: (siteId: string) => Readonly<Record<string, unknown>>;
}

/** Each page with change sets on. */
const PAGES: ReadonlyArray<readonly [string, CarchPage]> = [
  [
    'cArch.hist',
    {
      item: histScreen.action,
      body: (ctx) => bodyOf(histScreen, ctx),
      path: (siteId) => `/v1/sites/${siteId}/content/${ROOT}/history`,
      model: (siteId) => ({
        contentBean: homeBean(siteId),
        items: [homeVersion(siteId)],
        crumbdata: crumbs(siteId),
        perm: 'editor',
        deletable: 0,
        hasLockableNodes: 0,
      }),
    },
  ],
  [
    'cArch.audit',
    {
      item: auditScreen.action,
      body: (ctx) => bodyOf(auditScreen, ctx),
      path: (siteId) => `/v1/sites/${siteId}/content/${ROOT}/versions/${HOME_HIST}/audit`,
      model: (siteId) => ({
        contentBean: homeBean(siteId),
        items: [homeVersion(siteId)],
        crumbdata: crumbs(siteId),
        perm: 'editor',
        hasLockableNodes: 0,
        hasChangesets: 1,
        purgeDrafts: 1,
        siteLocking: 'none',
      }),
    },
  ],
];

/** The page `rc` for Home and, for hist, the session site's `hasChangesets`. */
const homePartial = (item: string, partial: AdminRequestPartial = {}): AdminRequestPartial => ({
  ...partial,
  circuit: 'cArch',
  item,
  site: { hasChangesets: true },
  rc: {
    contentid: ROOT,
    contenthistid: HOME_HIST,
    moduleid: SITE_MANAGER,
    parentid: END,
    topid: ROOT,
    type: 'Page',
    ...partial.rc,
  },
});

/** qa_editor holding the Site Manager and Change Sets grants of its token site. */
const editorWithChangesets = (partial: AdminRequestPartial): AdminRequest => {
  const roles = [Roles.systemUser, moduleRole(SITE_MANAGER), moduleRole(CHANGESETS)];
  return makeAdminRequest({ ...partial, user: { ...partial.user, roles } }, 'qaEditor');
};

/** Whether the page body of `req` links the version's change set, after checking it names the change set. */
async function linksChangeset(page: CarchPage, req: AdminRequest): Promise<boolean> {
  const siteId = req.rc.siteid ?? '';
  const gateway = fakeGatewayClient({
    [routeKey('GET', 'strategies-content', page.path(siteId))]: { status: 200, body: { rc: page.model(siteId) } },
  });
  const body = await page.body(makeScreenContext({ req, gateway }));
  expect(body).toContain('Spring Launch');
  return body.includes(ASSIGNMENTS_LINK);
}

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe.each(PAGES)('%s change set link', (_name, page) => {
  it.each(SESSION_SITE_CASES)('is shown for $who only when it administers that site', async (testCase) => {
    const req = testCase.request(homePartial(page.item));
    expect(await linksChangeset(page, req)).toBe(testCase.administers);
  });

  it.each<[string, AdminRequestPartial, boolean]>([
    ['on its token site', {}, true],
    ['in a Default session, its token site in another case', { session: { siteid: 'Default' } }, true],
    ['in a tenant-b session on default', { session: { siteid: 'tenant-b' }, rc: { siteid: 'default' } }, false],
    ['in a default session under a tenant-a token', { user: { site: 'tenant-a' } }, false],
  ])('checks the Change Sets grant of qa_editor %s against session.siteid', async (_case, partial, expected) => {
    const req = editorWithChangesets(homePartial(page.item, partial));
    expect(await linksChangeset(page, req)).toBe(expected);
  });
});
