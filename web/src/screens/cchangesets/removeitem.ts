// The `cChangesets.removeItem` action: detaches a content version from a change set, then returns to its assignments (server-only).
import { esapiUrlEncode } from '@opt2/platform/legacy-compat';
import { okBody } from '@/lib/gateway-client';
import type { ScreenContext, ScreenDefinition, SubmitResult } from '../registry';

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
  /** Forwards every rc field to the owner's write; the owner validates the token and skips the write on rejection. */
  async submit({ req: { rc }, gateway }: ScreenContext): Promise<SubmitResult> {
    const changesetid = rc.changesetid;
    // Legacy reads `rc.changesetid` for the CSRF context unguarded, so a request without it errors before any write.
    if (changesetid === undefined) throw new TypeError('Element RC.changesetid is undefined in ARGUMENTS.');
    const response = await gateway.strategiesContent.call(
      'post',
      '/v1/sites/{siteid}/changesets/{changesetid}/items/{contenthistid}/remove',
      {
        params: { siteid: rc.siteid ?? '', changesetid, contenthistid: rc.contentHistID ?? '' },
        form: Object.entries(rc),
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
