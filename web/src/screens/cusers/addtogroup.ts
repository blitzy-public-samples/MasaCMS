// The `cUsers.addToGroup` action: identity adds the membership under its CSRF check, then `route()` (server-only).
import { okBody } from '@/lib/gateway-client';
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { cusersGate, normaliseCusersRc } from './gate';
import { cusersRoute } from './route';

const SERVICE = 'identity';
const OPERATION = 'addGroupMember';

/** Fields legacy `validateCSRFTokens` reads; identity validates them for context `<userid><groupid>addtogroup`. */
const CSRF_FIELDS = ['csrf_token', 'csrf_token_expires'] as const;

// Legacy routes whether or not the token validated, so only a denial or a service failure skips the redirect.
const takesRedirect = (status: number): boolean => status !== 401 && status !== 403 && status < 500;

/** Adds `rc.userid` to `rc.groupid` through identity, which writes nothing on a bad token, then routes. */
async function submitAddToGroup(ctx: ScreenContext): Promise<SubmitResult> {
  const rc = normaliseCusersRc(ctx.req);
  const { userid, groupid, siteid } = rc;
  // An empty id, `before()`'s default, addresses no membership identity can hold and no path segment.
  if (userid !== '' && groupid !== '') {
    const form: Array<readonly [string, string]> = [['siteid', siteid]];
    for (const name of CSRF_FIELDS) {
      const value = ctx.req.rc[name];
      if (value !== undefined) form.push([name, value]);
    }
    const response = await ctx.gateway.identity.raw('post', '/v1/groups/{groupId}/members/{userId}', {
      params: { groupId: groupid, userId: userid },
      form,
    });
    if (!takesRedirect(response.status)) okBody(response, SERVICE, OPERATION);
  }
  // route() lays its redirect values over ctx.req, which the handler reads after submit, so ctx is passed whole.
  return cusersRoute(ctx, rc);
}

/** `cUsers.addToGroup`, reached by GET or POST (no pinned view links it), behind the cUsers `before()` gate. */
export const addToGroupAction: RedirectScreen = Object.freeze({
  circuit: 'cusers',
  action: 'addtogroup',
  mode: 'redirect',
  owner: 'identity',
  gate: cusersGate,
  submit: submitAddToGroup,
});
