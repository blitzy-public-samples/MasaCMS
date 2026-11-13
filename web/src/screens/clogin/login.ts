// The `clogin.login` admin action: identity logs the session in, then legacy's redirect or login view (server-only).
import { okBody } from '@/lib/gateway-client';
import type { AdminRequest, RequestContext } from '@/lib/request-context';
import type { PageControllerRedirect, PageScreen, ScreenContext } from '../registry';
import { loadLoginViewState, renderLoginView, type LoginViewState } from './main';

/** Lower-cased rc values clogin `login()` and loginManager read, the `$.event` CSRF pair included. */
const LOGIN_FIELDS: ReadonlySet<string> = new Set([
  'csrf_token',
  'csrf_token_expires',
  'attemptchallenge',
  'authcode',
  'rememberdevice',
  'rememberme',
  'returnurl',
  'contentid',
  'linkservid',
  'isadminlogin',
  'compactdisplay',
  'status',
  'failedchallenge',
  'siteid',
]);

/** Credentials the controller logs in with only when the form scope holds both. */
const CREDENTIAL_FIELDS: ReadonlySet<string> = new Set(['username', 'password']);

/** `isDefined('form.<name>')` for a lower-case `name`. */
const formHas = (form: RequestContext, name: string): boolean =>
  Object.keys(form).some((key) => key.toLowerCase() === name);

// Identity tells `form.username` from `url.username` by what its body holds, so credentials travel only when posted.
/** The login body: each login value of `rc` under its rc name and in rc order. */
function loginFields(req: AdminRequest): Array<[string, string]> {
  return Object.entries(req.rc).filter(([name]) => {
    const key = name.toLowerCase();
    return CREDENTIAL_FIELDS.has(key) ? formHas(req.formScope, key) : LOGIN_FIELDS.has(key);
  });
}

/**
 * clogin `login()` through identity's `login`: its redirect unchanged with its cookies, the FW/1 redirect to
 * `clogin.main` for a rejected token, or undefined when no login ran so `login.cfm` renders.
 * @throws GatewayDenialError When identity answers 401 or 403.
 */
async function loginStep(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const response = await ctx.gateway.identity.call('post', '/v1/sessions/login', { form: loginFields(ctx.req) });
  const { outcome, location } = okBody(response, 'identity', 'login');
  const { setCookies } = response;
  // A challenge attempt fails inside identity without a pending MFA login, so no rc value changes before the view.
  if (outcome === 'unattempted') return undefined;
  // Built by FW/1 rather than taken from identity's location, so a path-info request keeps its SES target.
  if (outcome === 'csrf-invalid') return { kind: 'redirect', action: 'clogin.main', path: './', setCookies };
  return { kind: 'location', location, setCookies };
}

/** `clogin.login`: the login redirect, else `login.cfm`, the `clogin.main` view without its controller step. */
export const cloginLoginScreen: PageScreen<LoginViewState> = Object.freeze({
  circuit: 'clogin',
  action: 'login',
  owner: 'identity',
  // The gateway sends this action to web in its inventoried mode, page, so the login is the page's controller step.
  mode: 'page',
  redirect: loginStep,
  load: (ctx: ScreenContext) => loadLoginViewState(ctx),
  render: (ctx: ScreenContext, state: LoginViewState) => ({ body: renderLoginView(ctx, state) }),
});
