// The `cUsers.updateAddress` action: relays the address write to people, then redirects as FW/1 does (server-only).
import { cfEq } from '@opt2/platform/legacy-compat';
import { okBody, type GatewayResponse } from '@/lib/gateway-client';
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { cusersGate } from './gate';

const OPERATION = 'updateAddress';
const UPDATE_ADDRESS_PATH = '/v1/users/addresses:update';

/** The fields the edit form's action URL carries, which its multipart body does not repeat. */
const ACTION_URL_FIELDS = ['userid', 'routeid', 'siteid'] as const;

/** `fw.redirect(action='cEditProfile.edit', path='./')`. */
const EDIT_PROFILE_REDIRECT: SubmitResult = Object.freeze({ kind: 'redirect', action: 'cEditProfile.edit', path: './' });

/** `fw.redirect(action='cUsers.edituser', preserve='siteid,userid,routeid', path='./')`. */
const EDIT_USER_REDIRECT: SubmitResult = Object.freeze({
  kind: 'redirect',
  action: 'cUsers.edituser',
  preserve: 'siteid,userid,routeid',
  path: './',
});

/** Posts to people a multipart body as received with the action URL's fields, else every rc field URL-encoded. */
function relayToPeople({ req: { rc }, gateway, body }: ScreenContext): Promise<GatewayResponse> {
  if (body?.form instanceof FormData) {
    const query = Object.fromEntries(ACTION_URL_FIELDS.map((name) => [name, rc[name]]));
    return gateway.postMultipart('people', UPDATE_ADDRESS_PATH, body, { query });
  }
  // A GET (the Edit User delete link) or a URL-encoded post: rc holds the URL fields, the CSRF pair included.
  return gateway.postForm('people', UPDATE_ADDRESS_PATH, Object.entries(rc));
}

/** `cUsers.updateAddress`, posted by the Edit Address form or followed as a link. */
export const updateAddressAction: RedirectScreen = Object.freeze({
  circuit: 'cusers',
  action: 'updateaddress',
  mode: 'redirect',
  owner: 'people',
  gate: cusersGate,
  /**
   * People validates the token under `'updateaddress' & userid` and writes only when it holds; legacy redirects either way.
   * @throws GatewayUnavailableError When people is unavailable; the handler answers the legacy 503.
   * @throws GatewayDenialError When people answers 401 or 403; any other non-2xx answer throws `Error`.
   */
  async submit(ctx: ScreenContext): Promise<SubmitResult> {
    // Only the status matters: people's `redirect` restates the controller's without FW/1's preserve, so it is not read.
    okBody(await relayToPeople(ctx), 'people', OPERATION);
    // `before()` params `routeid` to '' and CFML `==` ignores case.
    return cfEq(ctx.req.rc.routeid ?? '', 'editprofile') ? EDIT_PROFILE_REDIRECT : EDIT_USER_REDIRECT;
  },
});
