// The `cChangesets.delete` post action: the strategies-content delete, then FW/1's redirect to the list (server-only).
import { LegacyFaultError } from '@opt2/platform/legacy-compat';
import { okBody } from '@/lib/gateway-client';
import { relayContext } from '@/lib/request-context';
import type { ScreenContext, ScreenDefinition, SubmitResult } from '../registry';

type RedirectDefinition = Extract<ScreenDefinition, { mode: 'redirect' }>;

/** The fault of cchangesets.cfc reading `arguments.rc.changesetid` where the request has none (lines 167, 188). */
export const UNSET_CHANGESET_ID = 'Element RC.changesetid is undefined in ARGUMENTS.';

/** `fw.redirect(action="cChangesets.list", append="changesetID,siteID", path="./")`, taken whatever the CSRF outcome. */
const LIST_REDIRECT: SubmitResult = {
  kind: 'redirect',
  action: 'cChangesets.list',
  append: 'changesetID,siteID',
  path: './',
};

/**
 * `cChangesets.delete` without its circuit gate, which `./index.ts` adds; the service deletes only on a valid token.
 * @throws LegacyFaultError {@link UNSET_CHANGESET_ID} without `rc.changesetid`, before any call.
 */
export const changesetDeleteScreen: Omit<RedirectDefinition, 'gate'> = {
  circuit: 'cchangesets',
  action: 'delete',
  mode: 'redirect',
  owner: 'strategies-content',
  async submit({ req, gateway }: ScreenContext): Promise<SubmitResult> {
    const { siteid = '', changesetid } = req.rc;
    // Legacy reads `arguments.rc.changesetid` as the CSRF context, so a request without it fails before any token or write.
    if (changesetid === undefined) throw new LegacyFaultError(UNSET_CHANGESET_ID);
    const service = gateway.strategiesContent;
    // Every rc field travels unchanged, the CSRF pair included; the service consumes the token, web never does.
    const response = await service.call('post', '/v1/sites/{siteid}/changesets/{changesetid}/delete', {
      params: { siteid, changesetid },
      form: Object.entries(relayContext(req)),
    });
    if (response.location !== undefined) return { kind: 'location', location: response.location };
    okBody(response, service.service, 'deleteChangeset');
    // The declaration, not the body's `adminUrl` redirect, keeps FW/1's relative `./` path.
    return LIST_REDIRECT;
  },
};
