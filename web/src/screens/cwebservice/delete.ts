// cwebservice.delete: deletes an OAuth client through identity, then redirects to the client list (server-only).
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { relayField } from '@/lib/request-context';
import type { ScreenContext, SubmitResult } from '../registry';

const CSRF_FIELDS = [CSRF_FIELD_TOKEN, CSRF_FIELD_EXPIRES] as const;

/** Asks identity to delete `rc.clientid` under the request's CSRF token, then redirects to `cwebservice.list`. */
export async function submitDelete({ req, gateway }: ScreenContext): Promise<SubmitResult> {
  const { rc } = req;
  // Form fields rather than headers, so identity validates the values exactly as the request carried them.
  const form = CSRF_FIELDS.flatMap((name) => Object.entries(relayField(req, name)));
  // Bytes, since no answer but unavailability (thrown) changes the outcome: legacy redirects whatever the delete did.
  await gateway.identity.raw('delete', '/v1/oauth-clients/{clientId}', {
    params: { clientId: rc.clientid ?? '' },
    // An empty siteid names no site; omitted, identity takes the token's site, and legacy ignores it here.
    query: rc.siteid ? relayField(req, 'siteid') : {},
    form,
  });
  return { kind: 'redirect', action: 'cwebservice.list', append: 'siteid', path: './' };
}
