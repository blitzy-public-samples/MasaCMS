// The `cUsers.download` action: the users CSV of `cusers/inc/dsp_download.cfm`, built by its owning service (server-only).
import { cfToBoolean } from '@opt2/platform/legacy-compat';
import { assertNotDenied, type GatewayClient, type GatewayResponse, type WebServiceName } from '@/lib/gateway-client';
import type { DownloadScreen, RawBody, ScreenContext } from '../registry';
import { cusersGate, normaliseCusersRc, type CusersRc } from './gate';
import { relayUsersCsv, type UsersCsvSource } from './inc/dsp_download';

/** One service call answering with a users CSV, named by its operation id for denial reporting. */
interface UsersCsvCall {
  readonly service: WebServiceName;
  readonly operation: string;
  send(gateway: GatewayClient): Promise<GatewayResponse<Buffer>>;
}

/**
 * The source a preserved `rc.records` names, as `cUsers.downloadGroupMembers` and `cUsers.advancedSearchToCSV` store it.
 * @throws SyntaxError When the value is not JSON.
 * @throws TypeError When it names no users CSV source; legacy fails alike on a `records` that is no query.
 */
function sourceOf(records: string): UsersCsvSource {
  const parsed = JSON.parse(records) as { readonly source?: unknown } | null;
  if (parsed?.source === 'group-members' || parsed?.source === 'advanced-search') return parsed as UsersCsvSource;
  throw new TypeError('cUsers.download: rc.records names no users CSV source');
}

/** The call legacy's list comes from: the preserved source's, else the site's users, or its unassigned users. */
function usersCsvCall(rc: CusersRc): UsersCsvCall {
  if (rc.records === undefined) {
    const query = { siteid: rc.siteid, ispublic: rc.ispublic, unassigned: cfToBoolean(rc.unassigned) ? '1' : '0' };
    return {
      service: 'people',
      operation: 'downloadUsersCsv',
      send: (gateway) => gateway.people.raw('get', '/v1/users/download', { query }),
    };
  }
  const source = sourceOf(String(rc.records));
  if (source.source === 'group-members') {
    const params = { groupId: source.groupId };
    return {
      service: 'identity',
      operation: 'downloadGroupMembers',
      send: (gateway) => gateway.identity.raw('get', '/v1/groups/{groupId}/members.csv', { params }),
    };
  }
  // The search ran with the site and pool of the action that stored it, not this request's.
  const query = { siteid: source.siteid, ispublic: String(source.ispublic) };
  return {
    service: 'people',
    operation: 'downloadAdvancedSearchCsv',
    send: (gateway) => gateway.people.raw('get', '/v1/users/advanced-search.csv', { query }),
  };
}

/**
 * The controller step: the owning service's users CSV answer for the request's context.
 * @throws GatewayDenialError When the service answers 401 or 403.
 * @throws GatewayUnavailableError When the service is unavailable.
 */
async function loadUsersCsv({ req, gateway }: ScreenContext): Promise<GatewayResponse<Buffer>> {
  const call = usersCsvCall(normaliseCusersRc(req));
  const response = await call.send(gateway);
  // Legacy answers a denied caller with its access gate's redirect, never a service error body, so only a denial
  // is not relayed.
  assertNotDenied(response, call.service, call.operation);
  return response;
}

/** `cUsers.download` behind the cUsers `before()` gate; the view relays the loaded answer unchanged. */
export const downloadScreen: DownloadScreen<GatewayResponse<Buffer>> = Object.freeze({
  circuit: 'cusers',
  action: 'download',
  mode: 'download',
  owner: 'people',
  gate: cusersGate,
  load: loadUsersCsv,
  download: (_ctx: ScreenContext, response: GatewayResponse<Buffer>): RawBody => relayUsersCsv(response),
});
