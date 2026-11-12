import { LEGACY_ERROR_PAGE_HTML, LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import { okBody } from '@/lib/gateway-client';
import type { ScreenContext, SubmitResult } from '../registry';

const OPERATION = 'saveApprovalChain';

/** `fw.redirect(action="cchain.list", append="siteid", path="./")`. */
const LIST_REDIRECT: SubmitResult = Object.freeze({
  kind: 'redirect',
  action: 'cchain.list',
  append: 'siteid',
  path: './',
});

// Bean errors take no redirect and cchain has no save view, so legacy answers its 500 page, not an edit re-render.
// It is error.html, as the admin error surface sends; legacy's debuggingEnabled stack-trace page is not reproducible.
const MISSING_VIEW_ERROR: SubmitResult = Object.freeze({
  kind: 'raw',
  response: Object.freeze({ status: 500, contentType: LEGACY_HTML_CONTENT_TYPE, body: LEGACY_ERROR_PAGE_HTML }),
});

/** Relays the approval-chain save with every rc field unchanged; answers legacy's list redirect or its 500 page. */
export async function submitCchainSave({ req: { rc }, gateway }: ScreenContext): Promise<SubmitResult> {
  const service = gateway.strategiesContent;
  // `set(rc)` reads the whole context: the CSRF pair goes to the owner, and an empty groupID removes every membership.
  const response = await service.call('post', '/v1/sites/{siteid}/approval-chains', {
    params: { siteid: rc.siteid ?? '' },
    form: Object.entries(rc),
  });
  if (response.location !== undefined) return { kind: 'location', location: response.location };
  // A rejected token skips the write but still names the redirect, so only bean errors leave it null.
  const { redirect } = okBody(response, service.service, OPERATION);
  return redirect === null ? MISSING_VIEW_ERROR : LIST_REDIRECT;
}
