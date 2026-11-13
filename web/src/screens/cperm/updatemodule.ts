// cperm.updatemodule: replaces a module's group grants through identity, then redirects by module (server-only).
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, cfEq } from '@opt2/platform/legacy-compat';
import { okBody } from '@/lib/gateway-client';
import type { Rc, RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { CONTENT_MODULE_ID, TOP_NODE_ID, cpermDefaults, cpermGate } from './partials';

/** The FW/1 `redirect()` this action ends with. */
export type ModuleRedirect = Extract<SubmitResult, { kind: 'redirect' }>;

/** One `updatemodule` redirect test: the module id it matches, its action and the rc values it assigns first. */
interface ModuleRedirectRow {
  readonly moduleId: string;
  readonly action: string;
  readonly queryString?: string;
}

const PLUGINS_ACTION = 'cPlugins.list';

/** The module permissions form's fields, `contentid` coming from its action URL. */
const FORM_FIELDS = Object.freeze([
  'groupid',
  'contentid',
  'siteid',
  'topid',
  'moduleid',
  'router',
  CSRF_FIELD_TOKEN,
  CSRF_FIELD_EXPIRES,
] as const);

// The handler appends from the request's own rc, so rc values legacy assigns before appending travel in `queryString`.
/** The redirect tests in source order. */
const MODULE_REDIRECTS: readonly ModuleRedirectRow[] = Object.freeze([
  { moduleId: '00000000000000000000000000000000004', action: 'cUsers.list' },
  { moduleId: '00000000000000000000000000000000005', action: 'cEmail.list' },
  { moduleId: '00000000000000000000000000000000007', action: 'cForm.list' },
  { moduleId: '00000000000000000000000000000000008', action: 'cUsers.list' },
  { moduleId: '00000000000000000000000000000000009', action: 'cMailingList.list' },
  {
    moduleId: CONTENT_MODULE_ID,
    action: 'cArch.list',
    queryString: `topid=${TOP_NODE_ID}&moduleid=${CONTENT_MODULE_ID}`,
  },
  { moduleId: '00000000000000000000000000000000010', action: 'cCategory.list' },
  { moduleId: '00000000000000000000000000000000011', action: 'cFeed.list' },
  { moduleId: '00000000000000000000000000000000014', action: 'cChangesets.list' },
  { moduleId: '00000000000000000000000000000000015', action: 'cComments.default' },
  { moduleId: '00000000000000000000000000000000016', action: 'cArch.list', queryString: 'activeTab=2' },
]);

/** The redirect for `rc.moduleid`: the first row it equals under CFML `==`, else the plugin list; `siteid` appended. */
export function moduleRedirect(rc: Rc): ModuleRedirect {
  const moduleId = rc.moduleid ?? '';
  const row = MODULE_REDIRECTS.find((candidate) => cfEq(moduleId, candidate.moduleId));
  const action = row?.action ?? PLUGINS_ACTION;
  const redirect: ModuleRedirect = { kind: 'redirect', action, append: 'siteid', path: './' };
  return row?.queryString === undefined ? redirect : { ...redirect, queryString: row.queryString };
}

/** Relays the form to identity, which writes only under a valid token for `rc.moduleid`; redirects either way. */
async function submitUpdateModule({ req, gateway }: ScreenContext): Promise<SubmitResult> {
  const rc = cpermDefaults(req.rc);
  // Values as received: the checked `groupid`s arrive comma-joined, and an empty list clears the module's grants.
  const form = FORM_FIELDS.flatMap((name): Array<[string, string]> => {
    const value = rc[name];
    return value === undefined ? [] : [[name, value]];
  });
  const response = await gateway.identity.call('put', '/v1/permissions/modules/{moduleId}', {
    params: { moduleId: rc.contentid ?? '' },
    form,
  });
  // A rejected token is a 2xx that wrote nothing; legacy redirects the same way, so only the status is read.
  okBody(response, gateway.identity.service, 'updateModulePermissions');
  return moduleRedirect(rc);
}

/** `cperm.updatemodule`: the module grant save behind the cperm `before()` gate. */
export const cpermUpdateModule: RedirectScreen = {
  circuit: 'cperm',
  action: 'updatemodule',
  mode: 'redirect',
  owner: 'identity',
  gate: cpermGate,
  submit: submitUpdateModule,
};
