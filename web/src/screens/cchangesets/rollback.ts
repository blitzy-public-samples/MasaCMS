// The `cChangesets.rollback` post-action: rolls back a published change set, then redirects to its edit screen.
import { okBody } from '@/lib/gateway-client';
import type { ScreenContext, ScreenDefinition, SubmitResult } from '../registry';

type RedirectDefinition = Extract<ScreenDefinition, { mode: 'redirect' }>;

const SERVICE = 'strategies-content';
const OPERATION = 'rollbackChangeset';
const ROLLBACK_PATH = '/v1/sites/{siteid}/changesets/{changesetid}/rollback';

/** FW/1 `redirect(action="cChangesets.edit", append="changesetID,siteID", path="./")`. */
const EDIT_REDIRECT: SubmitResult = Object.freeze({
  kind: 'redirect',
  action: 'cChangesets.edit',
  append: 'changesetID,siteID',
  path: './',
});

// Legacy redirects whether or not the token validated and the rollback ran, so a 400 or 404 takes the same path;
// only a denial or a service failure leaves it.
const takesRedirect = (status: number): boolean => status !== 401 && status !== 403 && status < 500;

/** `cChangesets.rollback` without the circuit gate, which the circuit index adds. */
export const changesetRollbackScreen: Omit<RedirectDefinition, 'gate'> = Object.freeze({
  circuit: 'cchangesets',
  action: 'rollback',
  mode: 'redirect',
  owner: SERVICE,
  async submit({ req, gateway }: ScreenContext): Promise<SubmitResult> {
    const { rc } = req;
    const changesetid = rc.changesetid;
    if (changesetid === undefined) throw new TypeError('Element CHANGESETID is undefined in RC.');
    const response = await gateway.strategiesContent.call('post', ROLLBACK_PATH, {
      params: { siteid: rc.siteid ?? '', changesetid },
      form: Object.entries(rc),
    });
    if (!takesRedirect(response.status)) okBody(response, SERVICE, OPERATION);
    return response.location === undefined ? EDIT_REDIRECT : { kind: 'location', location: response.location };
  },
});
