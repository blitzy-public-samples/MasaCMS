// `cUsers.advancedSearchToCSV`: people stores the search criteria, then FW/1 redirects to the users CSV (server-only).
import { cfListToArray } from '@opt2/platform/legacy-compat';
import type { components, operations } from '@/generated/clients/people';
import { okBody } from '@/lib/gateway-client';
import type { Rc, RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { cusersGate, normaliseCusersRc } from './gate';
import type { UsersCsvSource } from './inc/dsp_download';

/** Query of people `setAdvancedSearch`. */
export type AdvancedSearchQuery = NonNullable<operations['setAdvancedSearch']['parameters']['query']>;

/** The result page people answers for stored criteria. */
export type AdvancedSearchPage = components['schemas']['AdvancedSearchPage'];

/** Fields admin/Application.cfc reads beside the rows; `muraAction` gives the circuit `paramCircuit` records. */
const CRITERIA_FIELDS = ['muraAction', 'param', 'inActive', 'categoryID', 'groupID', 'membersOnly', 'visitorStatus'];

/** Row field prefixes, each suffixed with a row number of the `param` list. */
const ROW_FIELDS = ['paramField', 'paramRelationship', 'paramCriteria', 'paramCondition'];

/** The rc fields the Application.cfc capture reads, each once; undefined for an empty `param`, which captures none. */
function criteriaForm(rc: Rc): Array<readonly [string, string]> | undefined {
  const param = rc.param ?? '';
  if (param === '') return undefined;
  const rows = cfListToArray(param, ',').flatMap((row) => ROW_FIELDS.map((prefix) => `${prefix}${row}`));
  // A skipped row (no field or no criteria) may lack its other fields, as legacy never reads them.
  return [...new Set([...CRITERIA_FIELDS, ...rows])].flatMap((name) => {
    const value = rc[name];
    return value === undefined ? [] : [[name, value] as const];
  });
}

/**
 * Has people capture the request's advanced-search criteria as admin/Application.cfc does, and returns the page it runs
 * for `query`; undefined, with no call, when `rc.param` is empty and the stored criteria stand.
 * @throws GatewayUnavailableError When people is unavailable; the handler answers the legacy 503.
 * @throws GatewayDenialError When people answers 401 or 403; any other non-2xx answer throws `Error`.
 */
export async function storeAdvancedSearchCriteria(
  { req, gateway }: Pick<ScreenContext, 'req' | 'gateway'>,
  query: AdvancedSearchQuery,
): Promise<AdvancedSearchPage | undefined> {
  // The request context keeps its capture in web's session state, which people never reads; people searches its own.
  const form = criteriaForm(req.rc);
  if (form === undefined) return undefined;
  const response = await gateway.people.call('post', '/v1/users/advanced-search', { query, form });
  return okBody(response, 'people', 'setAdvancedSearch');
}

/** Stores the criteria, then `fw.redirect(action='cUsers.download', preserve='records')` with FW/1's default path. */
async function submitAdvancedSearchToCsv(ctx: ScreenContext): Promise<SubmitResult> {
  const { siteid, ispublic } = normaliseCusersRc(ctx.req);
  await storeAdvancedSearchCriteria(ctx, { siteid, ispublic });
  // Legacy preserves the result rows; this descriptor has the download ask people for the stored criteria's CSV.
  const records = { source: 'advanced-search', siteid, ispublic } satisfies UsersCsvSource;
  return { kind: 'redirect', action: 'cUsers.download', preserve: 'records', rc: { records: JSON.stringify(records) } };
}

/** `cUsers.advancedSearchToCSV`, submitted by GET from the advanced search form, which validates no CSRF token. */
export const advancedSearchToCsvAction: RedirectScreen = Object.freeze({
  circuit: 'cusers',
  action: 'advancedsearchtocsv',
  mode: 'redirect',
  owner: 'people',
  gate: cusersGate,
  submit: submitAdvancedSearchToCsv,
});
