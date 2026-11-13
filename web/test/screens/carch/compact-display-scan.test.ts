// cArch.hist and cArch.audit pages for a raw `compactDisplay`, which the carch request set-up holds as the admin scan
// leaves it, against the ACF 2023 oracle: layout, echoed value, preview item, frame width call and secondary menu.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServicePath } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { auditScreen } from '@/screens/carch/audit';
import { histScreen } from '@/screens/carch/hist';
import type { ScreenDefinition } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

const SITE = 'default';
const ROOT = '00000000000000000000000000000000001';
const END = '00000000000000000000000000000000END';
const SITE_MANAGER = '00000000000000000000000000000000000';
const HOME_HIST = '6300ED69-1320-5CC3-F922E3012E2C6BAE';

const COMPACT_BODY = '<body id="carch" class="compact modal-wrapper">';
const FULL_BODY = '<body id="carch" class="mura-admin header-navbar-fixed no-constrain sidebar-tab">';

/** Home's active version, as both models carry it. */
const HOME_BEAN = {
  isNew: 0,
  contentID: ROOT,
  siteID: SITE,
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
};

/** Home's only version, a Page, whose actions menu links the preview. */
const HOME_VERSION = {
  contentHistID: HOME_HIST,
  contentID: ROOT,
  siteID: SITE,
  type: 'Page',
  parentID: END,
  moduleID: SITE_MANAGER,
  menuTitle: 'Home',
  active: 1,
  approved: 1,
  approvalStatus: '',
  changesetID: '',
  changesetName: '',
  changesetPublishDate: '',
  notes: '',
  majorVersion: '',
  minorVersion: '',
  lastUpdate: '',
  lastUpdateBy: 'Admin User',
  previewURL: `http://localhost:8080/?previewid=${HOME_HIST}`,
};

const CRUMBS = [{ contentid: ROOT, siteid: SITE, moduleid: SITE_MANAGER, type: 'Page', menutitle: 'Home', restricted: 0 }];

/** Each page, the strategies-content route its model is read at, and that model's `rc`. */
const PAGES: ReadonlyArray<readonly [string, ScreenDefinition, ServicePath, Readonly<Record<string, unknown>>]> = [
  [
    'cArch.hist',
    histScreen,
    `/v1/sites/${SITE}/content/${ROOT}/history`,
    { contentBean: HOME_BEAN, items: [HOME_VERSION], crumbdata: CRUMBS, perm: 'editor', deletable: 0, hasLockableNodes: 0 },
  ],
  [
    'cArch.audit',
    auditScreen,
    `/v1/sites/${SITE}/content/${ROOT}/versions/${HOME_HIST}/audit`,
    {
      contentBean: HOME_BEAN,
      items: [HOME_VERSION],
      crumbdata: CRUMBS,
      perm: 'editor',
      hasLockableNodes: 0,
      hasChangesets: 0,
      purgeDrafts: 1,
      siteLocking: 'none',
    },
  ],
];

/** The admin's request for Home on `cArch.<item>` with `compactDisplay`, before the carch set-up. */
const homeRequest = (item: string, compactDisplay: string): AdminRequest =>
  adminS2Request({
    circuit: 'cArch',
    item,
    site: { hasChangesets: false },
    rc: {
      contentid: ROOT,
      contenthistid: HOME_HIST,
      siteid: SITE,
      moduleid: SITE_MANAGER,
      parentid: END,
      topid: ROOT,
      type: 'Page',
      compactDisplay,
    },
  });

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

// Oracle: cArch.hist and cArch.audit of Home as admin, each value sent raw in the query string.
describe.each(PAGES)('%s for a raw compactDisplay', (_name, screen, path, model) => {
  it.each<[value: string, echoed: string, compact: boolean]>([
    [' TRUE', 'TRUE', true],
    ['tr\u0000ue', 'true', true],
    ['\u0001yes', 'yes', true],
    [' 1.0 ', '1.0', true],
    [' true', '%22YES%22', false],
    [' false', '%22NO%22', false],
    ['2', '2', false],
    ['tr\nue', 'tr%0Aue', false],
  ])('lays out %j as legacy does, echoing %s (compact: %s)', async (value, echoed, compact) => {
    const gateway = fakeGatewayClient({
      [routeKey('GET', 'strategies-content', path)]: { status: 200, body: { rc: model } },
    });
    const page = await renderScreenPage(screen, makeScreenContext({ req: homeRequest(screen.action, value), gateway }));
    if (page.kind !== 'document') throw new Error(`${screen.action} redirected to ${page.location}`);
    const { html } = page;

    expect(html).toContain(compact ? COMPACT_BODY : FULL_BODY);
    expect(new Set([...html.matchAll(/compactDisplay=([^&"#]*)/g)].map((match) => match[1]))).toEqual(new Set([echoed]));
    expect(html.includes("cmd:'setLocation'")).toBe(compact);
    expect(html.includes("cmd:'setWidth'")).toBe(compact);
    expect(html.includes('nav-module-specific')).toBe(!compact);
  });
});
