// The `cChangesets.removeItem` action: detaches a content version from a change set, then returns to its assignments (server-only).
import { LegacyFaultError, esapiUrlEncode } from '@opt2/platform/legacy-compat';
import { okBody } from '@/lib/gateway-client';
import { relayContext } from '@/lib/request-context';
import type { ScreenContext, ScreenDefinition, SubmitResult } from '../registry';
import { UNSET_CHANGESET_ID } from './delete';

/** The controller's redirect, taken whether or not the token validated. */
const ASSIGNMENTS_REDIRECT = Object.freeze({
  kind: 'redirect',
  action: 'cChangesets.assignments',
  append: 'changesetID,siteID,keywords',
  path: './',
} as const satisfies SubmitResult);

/** `cChangesets.removeItem` without the circuit gate, which `./index.ts` adds. */
export const changesetRemoveItemScreen: Omit<Extract<ScreenDefinition, { mode: 'redirect' }>, 'gate'> = Object.freeze({
  circuit: 'cchangesets',
  action: 'removeitem',
  mode: 'redirect',
  owner: 'strategies-content',
  /**
   * Forwards every rc field to the owner's write; the owner validates the token, skips the write on rejection and
   * raises legacy's fault for a valid token without `rc.contenthistid`.
   * @throws LegacyFaultError {@link UNSET_CHANGESET_ID} without `rc.changesetid`, before any call.
   */
  async submit({ req, gateway }: ScreenContext): Promise<SubmitResult> {
    const { rc } = req;
    const changesetid = rc.changesetid;
    // Legacy reads `arguments.rc.changesetid` as the CSRF context, so a request without it fails before any token or write.
    if (changesetid === undefined) throw new LegacyFaultError(UNSET_CHANGESET_ID);
    const response = await gateway.strategiesContent.call(
      'post',
      '/v1/sites/{siteid}/changesets/{changesetid}/items/{contenthistid}/remove',
      {
        params: { siteid: rc.siteid ?? '', changesetid, contenthistid: rc.contentHistID ?? '' },
        form: Object.entries(relayContext(req)),
      },
    );
    if (response.location !== undefined) return { kind: 'location', location: response.location };
    const { redirect } = okBody(response, 'strategies-content', 'removeChangesetItem');
    if (redirect === null) return ASSIGNMENTS_REDIRECT;
    // The service names its target for `adminUrl`; legacy's redirect goes to `./`, so the declared path is kept.
    return {
      kind: 'redirect',
      action: `${redirect.circuit}.${redirect.action}`,
      path: ASSIGNMENTS_REDIRECT.path,
      queryString: redirect.params.map(([name, value]) => `${name}=${esapiUrlEncode(value)}`).join('&'),
    };
  },
});
