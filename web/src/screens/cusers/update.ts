// The carried `cUsers.update` saves: the posted form relayed to its owner, then the controller's routing (server-only).
import { cfEq } from '@opt2/platform/legacy-compat';
import type { components as IdentityComponents } from '@/generated/clients/identity';
import type { components as PeopleComponents } from '@/generated/clients/people';
import { multipartRelay, okBody, type GatewayRequest, type ServicePath } from '@/lib/gateway-client';
import { setSessionMuraValue } from '@/lib/request-context';
import type { Rc, RedirectScreen, ScreenContext, ScreenVariant, SubmitResult } from '../registry';
import { cusersGate, normaliseCusersRc, type CusersRc } from './gate';
import { cusersRoute } from './route';

/** identity's answer to a group save: the group after the request and its validation errors. */
export type GroupWriteResult = IdentityComponents['schemas']['GroupWriteResult'];

/** people's answer to a person save: its validation errors and, when any, the bean holding the posted values. */
export type UserUpdateResult = PeopleComponents['schemas']['UpdateResult'];

/** `session.mura.editBean` after a failed person save: the bean of posted values and its errors. */
export interface RetainedUserBean {
  readonly userBean?: UserUpdateResult['userBean'];
  readonly errors: UserUpdateResult['errors'];
}

/** rc key under which a failed save preserves its owner's write result as JSON for the re-opened form. */
export const USER_BEAN_RC_KEY = 'userBean';

/** `session.mura` key of the retained bean of a failed person save. */
export const EDIT_BEAN_SESSION_KEY = 'editBean';

/** The fields the edit forms' action URLs carry, which their multipart bodies do not repeat. */
const ACTION_URL_FIELDS = ['userid', 'routeid'] as const;

/** One owner write: the service and route that run `userManager.create` or `update` for the posted form. */
interface OwnerWrite {
  readonly service: 'identity' | 'people';
  readonly method: 'POST' | 'PUT';
  readonly path: ServicePath;
  readonly operation: string;
}

/** people's `updateUser`, which creates or updates by the posted `action` under the roster write protocol. */
const USER_WRITE: OwnerWrite = Object.freeze({
  service: 'people',
  method: 'POST',
  path: '/v1/users:update',
  operation: 'updateUser',
});

/** `rc[name]` by case-insensitive name, as a CFML scope reads it. */
function rcValue(rc: Rc, name: string): string | undefined {
  if (Object.hasOwn(rc, name)) return rc[name];
  const lower = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : rc[key];
}

/** The variant `key` whose every `name=value` pair holds under CFML `==`, as the gateway's declaration compares. */
function variantOf(key: string, pairs: ReadonlyArray<readonly [name: string, value: string]>): ScreenVariant {
  return Object.freeze({
    key,
    matches: (rc: Rc): boolean =>
      pairs.every(([name, value]) => {
        const received = rcValue(rc, name);
        return received !== undefined && cfEq(received, value);
      }),
  });
}

/** `rc.action` as text; '' when absent. */
function actionOf(rc: CusersRc): string {
  const { action } = rc;
  return typeof action === 'string' ? action : '';
}

// The registry withholds `type=1,action=delete` (its closure reaches strategies-content's files), and identity defines
// no group delete, so a delete never reaches this action.
/**
 * identity's create or update of the group `rc.userid` for the posted `action`, as the controller's `switch` matches.
 * @throws Error For any other action, which writes nothing and fails on the unset `rc.userBean` in legacy.
 */
function groupWrite(rc: CusersRc): OwnerWrite {
  const action = actionOf(rc);
  if (cfEq(action, 'Add')) return { service: 'identity', method: 'POST', path: '/v1/groups', operation: 'createGroup' };
  if (cfEq(action, 'Update')) {
    return {
      service: 'identity',
      method: 'PUT',
      path: `/v1/groups/${encodeURIComponent(rc.userid)}`,
      operation: 'updateGroup',
    };
  }
  throw new Error(`cUsers.update: no group write for action '${action}'; legacy fails on the unset user bean`);
}

/** The posted fields as received: a multipart body with the action URL's fields, else every rc field URL-encoded. */
function relayedRequest({ req: { rc }, body }: ScreenContext, { method, path }: OwnerWrite): GatewayRequest {
  if (body?.form instanceof FormData) {
    const relay = multipartRelay(body);
    const query = Object.fromEntries(ACTION_URL_FIELDS.map((name) => [name, rc[name]]));
    return { method, path, query, body: relay.body, headers: relay.headers };
  }
  // A URL-encoded post or a GET: rc holds the URL and form fields, the CSRF pair included.
  return { method, path, form: Object.entries(rc) };
}

/**
 * The owner's 2xx write result; the owner applies the controller's super-user stripping and validates the CSRF token
 * under `rc.userid`.
 * @throws GatewayUnavailableError When the owner is unavailable or answers 502, 503 or 504.
 * @throws GatewayDenialError When the owner answers 401 or 403; any other non-2xx answer throws `Error`.
 */
async function ownerResult<T>(ctx: ScreenContext, write: OwnerWrite): Promise<T> {
  const response = await ctx.gateway.call<T>(write.service, relayedRequest(ctx, write));
  return okBody(response, write.service, write.operation);
}

const saved = (result: { readonly errors: Readonly<Record<string, string>> }): boolean =>
  Object.keys(result.errors).length === 0;

/** `fw.redirect(action, preserve='all', path='./')` with `rc.siteID` restored and the failed save as `rc.userBean`. */
function reopenForm(action: string, rc: CusersRc, result: GroupWriteResult | UserUpdateResult): SubmitResult {
  return {
    kind: 'redirect',
    action,
    preserve: 'all',
    path: './',
    rc: { siteid: rc.siteid, [USER_BEAN_RC_KEY]: JSON.stringify(result) },
  };
}

// route() reads no `userid`, so the id an Add creates is not carried to it.
/** `cUsers.update{type=1}`: identity's group save, then `route()`, or the group form with identity's errors. */
async function submitGroup(ctx: ScreenContext): Promise<SubmitResult> {
  const rc = normaliseCusersRc(ctx.req);
  const result = await ownerResult<GroupWriteResult>(ctx, groupWrite(rc));
  return saved(result) ? cusersRoute(ctx, rc) : reopenForm('cUsers.editgroup', rc, result);
}

/** `cUsers.update{type=2}`: people's person save, then `route()`, or the user form with the retained bean. */
async function submitUser(ctx: ScreenContext): Promise<SubmitResult> {
  const rc = normaliseCusersRc(ctx.req);
  const result = await ownerResult<UserUpdateResult>(ctx, USER_WRITE);
  if (saved(result)) return cusersRoute(ctx, rc);
  const retained: RetainedUserBean = { userBean: result.userBean, errors: result.errors };
  setSessionMuraValue(ctx.req, EDIT_BEAN_SESSION_KEY, retained);
  return reopenForm('cUsers.edituser', rc, result);
}

/** `cUsers.update` with `type=1`: a group add or update, which identity owns. */
export const updateGroupAction: RedirectScreen = Object.freeze({
  circuit: 'cusers',
  action: 'update',
  variant: variantOf('type=1', [['type', '1']]),
  mode: 'redirect',
  owner: 'identity',
  gate: cusersGate,
  submit: submitGroup,
});

/** `cUsers.update` with `type=2` and `action=Add`: the people roster create. */
export const addUserAction: RedirectScreen = Object.freeze({
  circuit: 'cusers',
  action: 'update',
  variant: variantOf('type=2,action=add', [
    ['type', '2'],
    ['action', 'Add'],
  ]),
  mode: 'redirect',
  owner: 'people',
  gate: cusersGate,
  submit: submitUser,
});

/** `cUsers.update` with `type=2` and `action=Update`: the people roster edit. */
export const updateUserAction: RedirectScreen = Object.freeze({
  circuit: 'cusers',
  action: 'update',
  variant: variantOf('type=2,action=update', [
    ['type', '2'],
    ['action', 'Update'],
  ]),
  mode: 'redirect',
  owner: 'people',
  gate: cusersGate,
  submit: submitUser,
});

/** The carried `cUsers.update` variants. */
export const updateActions: readonly RedirectScreen[] = Object.freeze([
  updateGroupAction,
  addUserAction,
  updateUserAction,
]);
