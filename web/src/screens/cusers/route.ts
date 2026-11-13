// The cUsers `route()` step and the `cUsers.route` action: clear the retained edit values, then redirect (server-only).
import { okBody } from '@/lib/gateway-client';
import { applyDefaults } from '@/lib/request-context';
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { cusersGate, normaliseCusersRc, type CusersRc } from './gate';

/** What `route()` needs of a screen call: the request its redirect reads, and the gateway. */
export type CusersRouteContext = Pick<ScreenContext, 'req' | 'gateway'>;

/** The `rc` values `route()` reads, as `before()` and the calling action leave them. */
export type CusersRouteRc = Pick<CusersRc, 'siteid' | 'ispublic' | 'routeid' | 'returnurl'>;

/** Lays `values` over `ctx.req.rc`, so the handler's FW/1 `append` reads them as legacy reads its mutated rc. */
function setRcValues(ctx: CusersRouteContext, values: Readonly<Record<string, string>>): void {
  // rc is a read-only view and the handler reads `ctx.req` after the screen ran, so the request is replaced.
  ctx.req = { ...ctx.req, rc: applyDefaults({ ...ctx.req.rc, ...values }) };
}

/**
 * cusers.cfc `route()`: people's `routeUser` clears `session.mura.editBean`, then the request goes to the sanitised
 * `returnurl`, else `cUsers.listusers`, or to `cUsers.editgroup` of `routeid` when one is given.
 * @throws GatewayDenialError When people refuses the call (401 or 403).
 * @throws TypeError When people answers an admin redirect for a non-empty `returnurl`.
 */
export async function cusersRoute(ctx: CusersRouteContext, rc: CusersRouteRc): Promise<SubmitResult> {
  const { siteid, ispublic, routeid, returnurl } = rc;
  // userid is not sent: route() never reads it, and the contract caps it at 35 characters that legacy never checks.
  const response = await ctx.gateway.people.call('get', '/v1/users/route', {
    query: { siteid: siteid === '' ? undefined : siteid, ispublic, routeid, returnurl },
  });
  const { redirect } = okBody(response, 'people', 'routeUser');
  if (routeid === '') {
    if (returnurl !== '') {
      // sanitizeHref checks absolute URLs against site-registry domains, which web holds only for anonymous requests,
      // so the target is the URL people cleaned with removeLeadingDoubleSlash and sanitizeHref.
      if (!('url' in redirect)) throw new TypeError(`routeUser answered ${redirect.action} for a return URL`);
      return { kind: 'location', location: redirect.url };
    }
    setRcValues(ctx, { siteid, ispublic });
    return { kind: 'redirect', action: 'cUsers.listusers', append: 'siteid,ispublic', path: './' };
  }
  setRcValues(ctx, { siteid, userid: routeid });
  return { kind: 'redirect', action: 'cUsers.editgroup', append: 'siteid,userid', path: './' };
}

/** `cUsers.route`, which validates no CSRF token, as legacy validates none. */
export const routeAction: RedirectScreen = Object.freeze({
  circuit: 'cusers',
  action: 'route',
  mode: 'redirect',
  owner: 'people',
  gate: cusersGate,
  submit: (ctx: ScreenContext): Promise<SubmitResult> => cusersRoute(ctx, normaliseCusersRc(ctx.req)),
});
