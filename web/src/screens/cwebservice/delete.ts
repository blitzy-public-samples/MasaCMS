// cwebservice.delete: deletes an OAuth client through identity, then redirects to the client list (server-only).
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import type { ScreenContext, SubmitResult } from '../registry';

const CSRF_FIELDS = [CSRF_FIELD_TOKEN, CSRF_FIELD_EXPIRES] as const;

/** Asks identity to delete `rc.clientid` under the request's CSRF token, then redirects to `cwebservice.list`. */
export async function submitDelete({ req: { rc }, gateway }: ScreenContext): Promise<SubmitResult> {
  // Form fields rather than headers, so identity validates the values exactly as the request carried them.
  const form = CSRF_FIELDS.flatMap((name): Array<[string, string]> => {
    const value = rc[name];
    return value === undefined ? [] : [[name, value]];
  });
  // Bytes, since no answer but unavailability (thrown) changes the outcome: legacy redirects whatever the delete did.
  await gateway.identity.raw('delete', '/v1/oauth-clients/{clientId}', {
    params: { clientId: rc.clientid ?? '' },
    // An empty siteid names no site; omitted, identity takes the token's site, and legacy ignores it here.
    query: { siteid: rc.siteid || undefined },
    form,
  });
  return { kind: 'redirect', action: 'cwebservice.list', append: 'siteid', path: './' };
}
