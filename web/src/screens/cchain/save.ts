import { LegacyFaultError } from '@opt2/platform/legacy-compat';
import { okBody } from '@/lib/gateway-client';
import { relayContext } from '@/lib/request-context';
import type { ScreenContext, SubmitResult } from '../registry';

const OPERATION = 'saveApprovalChain';

/** `fw.redirect(action="cchain.list", append="siteid", path="./")`. */
const LIST_REDIRECT: SubmitResult = Object.freeze({
  kind: 'redirect',
  action: 'cchain.list',
  append: 'siteid',
  path: './',
});

/**
 * FW/1's `viewNotFound()` for a save whose bean errors take no redirect, as cchain has no save view; its detail names
 * the view under the framework base `/muraWRM/admin/` (framework.cfc:1242-1243; admin/Application.cfc:153,171-173).
 */
function missingViewFault(): LegacyFaultError {
  return new LegacyFaultError("Unable to find a view for 'core:cchain.save' action.", 'FW1.viewNotFound', {
    detail: "'/muraWRM/admin/core/views/cchain/save.cfm' does not exist.",
  });
}

/**
 * Relays the approval-chain save with every rc field unchanged; answers legacy's list redirect.
 * @throws LegacyFaultError For bean errors, which legacy answers with onError's page.
 */
export async function submitCchainSave({ req, gateway }: ScreenContext): Promise<SubmitResult> {
  const service = gateway.strategiesContent;
  // `set(rc)` reads the whole context: the CSRF pair goes to the owner, and an empty groupID removes every membership.
  const response = await service.call('post', '/v1/sites/{siteid}/approval-chains', {
    params: { siteid: req.rc.siteid ?? '' },
    form: Object.entries(relayContext(req)),
  });
  if (response.location !== undefined) return { kind: 'location', location: response.location };
  // A rejected token skips the write but still names the redirect, so only bean errors leave it null.
  const { redirect } = okBody(response, service.service, OPERATION);
  if (redirect === null) throw missingViewFault();
  return LIST_REDIRECT;
}
