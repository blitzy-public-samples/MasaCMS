// The `cUsers.removeFromGroup` action: identity removes the membership, then FW/1 returns to the group's members (server-only).
import { okBody } from '@/lib/gateway-client';
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { cusersGate, normaliseCusersRc } from './gate';

const SERVICE = 'identity';
const OPERATION = 'removeGroupMember';

/** `fw.redirect(action='cUsers.editGroupMembers', preserve='groupid,siteid')`, with FW/1's default path. */
const MEMBERS_REDIRECT = Object.freeze({
  kind: 'redirect',
  action: 'cUsers.editGroupMembers',
  preserve: 'groupid,siteid',
} as const satisfies SubmitResult);

// An id identity rejects (400) matches no legacy row either, so only a denial or a service failure skips the redirect.
const takesRedirect = (status: number): boolean => status !== 401 && status !== 403 && status < 500;

/** Removes `rc.userid` from `rc.groupid` through identity, which checks no CSRF token, then redirects to the members. */
async function submitRemoveFromGroup({ req, gateway }: ScreenContext): Promise<SubmitResult> {
  const { userid, groupid } = normaliseCusersRc(req);
  // An empty id, `before()`'s default, addresses no membership and no path segment, so legacy's delete removes nothing.
  if (userid !== '' && groupid !== '') {
    const response = await gateway.identity.raw('delete', '/v1/groups/{groupId}/members/{userId}', {
      params: { groupId: groupid, userId: userid },
    });
    if (!takesRedirect(response.status)) okBody(response, SERVICE, OPERATION);
  }
  return MEMBERS_REDIRECT;
}

/** `cUsers.removeFromGroup`, reached by GET from the members list or by POST, behind the cUsers `before()` gate. */
export const removeFromGroupAction: RedirectScreen = Object.freeze({
  circuit: 'cusers',
  action: 'removefromgroup',
  mode: 'redirect',
  owner: 'identity',
  gate: cusersGate,
  submit: submitRemoveFromGroup,
});
