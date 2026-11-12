// The `cChangesets.delete` post action: the strategies-content delete, then FW/1's redirect to the list (server-only).
import { okBody } from '@/lib/gateway-client';
import type { ScreenContext, ScreenDefinition, SubmitResult } from '../registry';

type RedirectDefinition = Extract<ScreenDefinition, { mode: 'redirect' }>;

/** `fw.redirect(action="cChangesets.list", append="changesetID,siteID", path="./")`, taken whatever the CSRF outcome. */
const LIST_REDIRECT: SubmitResult = {
  kind: 'redirect',
  action: 'cChangesets.list',
  append: 'changesetID,siteID',
  path: './',
};

/** `cChangesets.delete` without its circuit gate, which `./index.ts` adds; the service deletes only on a valid token. */
export const changesetDeleteScreen: Omit<RedirectDefinition, 'gate'> = {
  circuit: 'cchangesets',
  action: 'delete',
  mode: 'redirect',
  owner: 'strategies-content',
  async submit({ req, gateway }: ScreenContext): Promise<SubmitResult> {
    const { siteid = '', changesetid } = req.rc;
    // Legacy reads `rc.changesetid` unguarded, so a request without it errors before any write.
    if (changesetid === undefined) throw new TypeError('Element CHANGESETID is undefined in a CFML structure.');
    const service = gateway.strategiesContent;
    // Every rc field travels unchanged, the CSRF pair included; the service consumes the token, web never does.
    const response = await service.call('post', '/v1/sites/{siteid}/changesets/{changesetid}/delete', {
      params: { siteid, changesetid },
      form: Object.entries(req.rc),
    });
    if (response.location !== undefined) return { kind: 'location', location: response.location };
    okBody(response, service.service, 'deleteChangeset');
    // The declaration, not the body's `adminUrl` redirect, keeps FW/1's relative `./` path.
    return LIST_REDIRECT;
  },
};
