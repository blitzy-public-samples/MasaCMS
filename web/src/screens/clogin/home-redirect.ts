// The `home.redirect` action, the admin's FW/1 home: sends each user to their landing screen (server-only).
import type { components } from '@/generated/clients/programs-sites';
import { okBody } from '@/lib/gateway-client';
import { encodeUrl } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { buildUrl } from '@/lib/urls';
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';

type UserSite = components['schemas']['UserSite'];

/** Site Manager module and its root node, which the content landing page opens. */
const CONTENT_MODULE_ID = '00000000000000000000000000000000000';
const HOME_TOP_ID = '00000000000000000000000000000000001';

/** QoQ `SELECT siteid FROM rsList order by orderno`, NULL first; equal values keep their site-name order. */
function compareOrderno(a: UserSite, b: UserSite): number {
  if (a.orderno === b.orderno) return 0;
  if (a.orderno === null) return -1;
  if (b.orderno === null) return 1;
  return a.orderno - b.orderno;
}

/** utility `getRequestHost()`: a non-empty `X-Forwarded-Host`, else `cgi.http_host`, else `cgi.server_name`. */
const requestHostOf = (req: AdminRequest): string =>
  req.headers.get('x-forwarded-host') || req.httpHost || req.serverName;

// A `redirect` result's `append` names rc keys, and rc cannot hold the chosen site, so the target is built here.
/** FW/1 `redirect(action, append, path="./")`: each appended value `esapiEncode('url')`-encoded, in order. */
function redirectTo(
  req: AdminRequest,
  action: string,
  append: ReadonlyArray<readonly [key: string, value: string]> = [],
): SubmitResult {
  const queryString = append.map(([key, value]) => `${key}=${encodeUrl(value)}`).join('&');
  return { kind: 'location', location: buildUrl(action, './', queryString, { ses: req.ses }) };
}

/**
 * home `redirect()`: the bound or first administered site's dashboard or Site Manager, else login or no-access.
 * @throws GatewayDenialError When programs-sites refuses the user's sites (401 or 403).
 */
async function redirectHome({ req, gateway }: ScreenContext): Promise<SubmitResult> {
  if (!req.isLoggedIn) return redirectTo(req, 'clogin.main');
  const response = await gateway.programsSites.userSites(requestHostOf(req));
  const { sites: rsList, boundSiteId } = okBody(response, 'programs-sites', 'listUserSites');
  // The QoQ `WHERE siteid = :siteid` match is case-sensitive; a null `boundSiteId` (`--none--`) matches no site.
  const bound = rsList.find((site) => site.siteid === boundSiteId);
  const chosen = bound ?? rsList.toSorted(compareOrderno)[0];
  if (chosen !== undefined) {
    if (chosen.showDashboard === 1 && req.session.s2IsPrivate) {
      return redirectTo(req, 'cDashboard.main', [['siteid', chosen.siteid]]);
    }
    return redirectTo(req, 'cArch.list', [
      ['siteid', chosen.siteid],
      ['moduleid', CONTENT_MODULE_ID],
      ['topid', HOME_TOP_ID],
    ]);
  }
  return redirectTo(req, req.session.s2IsPrivate ? 'cMessage.noAccess' : 'clogin.main');
}

// The home controller defines no `before()`, so only the application gate guards it.
const NO_SCREEN_GATE: RedirectScreen['gate'] = () => ({ kind: 'allow' });

/** The `home.redirect` admin action. */
export const homeRedirectScreen: RedirectScreen = Object.freeze({
  circuit: 'home',
  action: 'redirect',
  owner: 'identity',
  mode: 'redirect',
  gate: NO_SCREEN_GATE,
  submit: redirectHome,
});
