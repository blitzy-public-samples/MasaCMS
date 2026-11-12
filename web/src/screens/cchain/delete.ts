// The `cchain.delete` post action: the strategies-content chain delete, then FW/1's redirect to the list (server-only).
import { esapiUrlEncode } from '@opt2/platform/legacy-compat';
import { okBody } from '@/lib/gateway-client';
import type { ScreenContext, SubmitResult } from '../registry';

const SERVICE = 'strategies-content';
const OPERATION = 'deleteApprovalChain';
const DELETE_PATH = '/v1/sites/{siteid}/approval-chains/{chainid}/delete';

/** `fw.redirect(action="cchain.list", append="siteid", path="./")`, taken whatever the CSRF outcome. */
const LIST_REDIRECT = Object.freeze({
  kind: 'redirect',
  action: 'cchain.list',
  append: 'siteid',
  path: './',
} as const satisfies SubmitResult);

// Legacy redirects whether or not the token validated and the chain existed, so a 400 or 404 takes the same path;
// only a denial or a service failure leaves it.
const takesRedirect = (status: number): boolean => status !== 401 && status !== 403 && status < 500;

/** Relays `rc` to the owner's chain delete, which deletes only on a valid token, then redirects to `cchain.list`. */
export async function submitCchainDelete({ req: { rc }, gateway }: ScreenContext): Promise<SubmitResult> {
  // Every rc field travels as received (siteid untrimmed, the CSRF pair included); the service consumes the token.
  const response = await gateway.strategiesContent.call('post', DELETE_PATH, {
    params: { siteid: rc.siteid ?? '', chainid: rc.chainid ?? '' },
    form: Object.entries(rc),
  });
  if (!takesRedirect(response.status)) okBody(response, SERVICE, OPERATION);
  if (response.location !== undefined) return { kind: 'location', location: response.location };
  const redirect = response.ok ? response.body.redirect : null;
  if (redirect === null) return LIST_REDIRECT;
  // The service names its target for `adminUrl`; legacy's redirect goes to `./`, so the declared path is kept.
  return {
    kind: 'redirect',
    action: `${redirect.circuit}.${redirect.action}`,
    path: LIST_REDIRECT.path,
    queryString: redirect.params.map(([name, value]) => `${name}=${esapiUrlEncode(value)}`).join('&'),
  };
}
