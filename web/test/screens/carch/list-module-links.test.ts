// carch/list.cfm 664-704,757: the Custom Entities tab and module buttons, gated by getModulePerm(id, session.siteid).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { listScreen } from '@/screens/carch/list';
import {
  COMPONENT_MODULE_ID,
  CONTENT_MODULE_ID,
  FORM_MODULE_ID,
  ROOT_CONTENT_ID,
  VARIATION_MODULE_ID,
} from '@/screens/carch/model';
import { makeAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { SESSION_SITE_CASES } from '../../helpers/requested-site';
import { makeScreenContext } from '../../helpers/screen-context';

const screen = listScreen as Required<typeof listScreen>;
const SCAFFOLD_MODULE_ID = '00000000000000000000000000000000016';
const LIST = { circuit: 'cArch', item: 'list' } as const;
const FLAT_VIEW_ARGS = {
  tab: '0',
  sortby: 'lastupdate',
  sortdirection: 'desc',
  page: '1',
  tags: '',
  categoryid: '',
  lockid: '',
  type: '',
  subtype: '',
  report: '',
  keywords: '',
  filtered: 'false',
};

/** The getSiteManagerTree model of the site tree on `siteId`: scaffolding, forms and variations on, editor verdicts. */
const treeModel = (siteId: string) => ({
  rc: {
    topid: ROOT_CONTENT_ID,
    rsTop: [],
    siteConfig: { customTagGroups: '', scaffolding: true, dataCollection: true, hasLockableNodes: false },
    sortBy: 'orderno',
    sortDirection: 'asc',
    crumbdata: [{ siteid: siteId, contentid: ROOT_CONTENT_ID }],
    copyContentID: '',
    copySiteID: '',
    copyAll: 'false',
    flatViewArgs: FLAT_VIEW_ARGS,
    modulePerms: { [COMPONENT_MODULE_ID]: 'editor', [FORM_MODULE_ID]: 'editor' },
    variations: true,
  },
});

/** Which session-site module links the content body of `req` renders. */
async function moduleLinks(req: AdminRequest): Promise<Record<string, boolean>> {
  const siteId = req.rc.siteid ?? '';
  const tree = routeKey('GET', 'strategies-content', `/v1/sites/${siteId}/content/tree`);
  const gateway = fakeGatewayClient({ [tree]: { status: 200, body: treeModel(siteId) } });
  const ctx = makeScreenContext({ req, gateway });
  const view = await screen.render(ctx, await screen.load(ctx));
  const body = toString(view.body);
  const button = (moduleId: string): boolean => body.includes(`data-moduleid="${moduleId}"`);
  return {
    customTab: body.includes('<a href="#tabEntities">'),
    entitiesPane: body.includes('<div id="tabEntities" class="tab-pane">'),
    moduleBar: body.includes('<div id="arch-mod" class="mura-input-set">'),
    siteTree: button(CONTENT_MODULE_ID),
    components: button(COMPONENT_MODULE_ID),
    forms: button(FORM_MODULE_ID),
    variations: button(VARIATION_MODULE_ID),
  };
}

const ALL = {
  customTab: true,
  entitiesPane: true,
  moduleBar: true,
  siteTree: true,
  components: true,
  forms: true,
  variations: true,
};
const NONE = {
  customTab: false,
  entitiesPane: false,
  moduleBar: false,
  siteTree: false,
  components: false,
  forms: false,
  variations: false,
};

/** qa_editor holding the Site Manager, scaffolder, components, forms and variations grants. */
const editorWithModules = (partial: AdminRequestPartial): AdminRequest => {
  const modules = [CONTENT_MODULE_ID, SCAFFOLD_MODULE_ID, COMPONENT_MODULE_ID, FORM_MODULE_ID, VARIATION_MODULE_ID];
  const roles = [Roles.systemUser, ...modules.map(moduleRole)];
  return makeAdminRequest({ ...LIST, ...partial, user: { ...partial.user, roles } }, 'qaEditor');
};

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('carch.list module links', () => {
  it.each(SESSION_SITE_CASES)('renders them for $who only when it administers that site', async (testCase) => {
    expect(await moduleLinks(testCase.request(LIST))).toEqual(testCase.administers ? ALL : NONE);
  });

  it.each<[string, AdminRequestPartial, Record<string, boolean>]>([
    ['on its token site', {}, ALL],
    ['on Default, its token site in another case', { session: { siteid: 'Default' } }, ALL],
    ['on default from a tenant-b session', { session: { siteid: 'tenant-b' }, rc: { siteid: 'default' } }, NONE],
    ['in a default session under a tenant-a token', { user: { site: 'tenant-a' } }, NONE],
  ])('checks the module grants of qa_editor %s against session.siteid', async (_case, partial, expected) => {
    expect(await moduleLinks(editorWithModules(partial))).toEqual(expected);
  });

  it('shows the module bar for the variations grant alone, without the Custom Entities tab', async () => {
    const roles = [Roles.systemUser, moduleRole(CONTENT_MODULE_ID), moduleRole(VARIATION_MODULE_ID)];
    const req = makeAdminRequest({ ...LIST, user: { roles } }, 'qaEditor');
    expect(await moduleLinks(req)).toEqual({ ...ALL, customTab: false, entitiesPane: false });
  });
});
