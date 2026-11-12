// The `clogin.logout` post action: identity ends the session, then FW/1 redirects to the admin home (server-only).
import { okBody } from '@/lib/gateway-client';
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';

/** clogin `logout()`: ends the session through identity, then `redirect(action="home.redirect", path="./")`. */
async function submitLogout(ctx: ScreenContext): Promise<SubmitResult> {
  const response = await ctx.gateway.identity.call('post', '/v1/sessions/logout');
  // A rejected user token leaves no session to end, and legacy logout redirects whatever state the session is in.
  if (!response.ok && response.status !== 401) okBody(response, 'identity', 'logout');
  // The target is the controller's own; identity's `redirect` body is not used, its `Set-Cookie` values are relayed.
  return { kind: 'redirect', action: 'home.redirect', path: './', setCookies: response.setCookies };
}

/** The `admin:clogin.logout` screen; clogin's `before()` only defaults rc values, so it declares no gate. */
export const cloginLogoutScreen: RedirectScreen = Object.freeze({
  circuit: 'clogin',
  action: 'logout',
  owner: 'identity',
  mode: 'redirect',
  submit: submitLogout,
});
