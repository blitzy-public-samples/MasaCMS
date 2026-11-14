/** The cUsers download paths, legacy CSV header lines and contract-checked calls shared by the offline and PostgreSQL CSV suites. */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { userHeaders, type TestApp, type UserHeadersInput } from './app.js';

type Operation = { operationId?: string };
const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};

/** The contract path declaring `operationId`. */
function pathOf(operationId: string): string {
  const found = Object.entries(OPENAPI.paths).find(([, item]) => Object.values(item).some((op) => op.operationId === operationId));
  if (found === undefined) throw new TypeError(`contracts/openapi.yaml declares no ${operationId}`);
  return found[0];
}

export const DOWNLOAD_USERS = pathOf('downloadUsersCsv');
export const DOWNLOAD_SEARCH = pathOf('downloadAdvancedSearchCsv');
export const SET_SEARCH = pathOf('setAdvancedSearch');
export const GET_SEARCH = pathOf('getAdvancedSearch');

export const USERS_HEADER =
  '"ADMIN","EMAIL","FNAME","GROUPNAME","ISPUBLIC","LASTUPDATE","LASTUPDATEBY","LNAME","S2","SITEID","SUBTYPE","TYPE","USERID","USERNAME"\n';
export const SEARCH_HEADER =
  '"COMPANY","CONTACTFORM","CREATED","DESCRIPTION","EMAIL","FNAME","GROUPNAME","IMNAME","IMSERVICE","INACTIVE","INTERESTS",' +
  '"ISPUBLIC","JOBTITLE","KEEPPRIVATE","LASTLOGIN","LASTUPDATE","LASTUPDATEBY","LASTUPDATEBYID","LNAME","MOBILEPHONE","NOTES",' +
  '"PASSWORDCREATED","PERM","PHOTOFILEEXT","PHOTOFILEID","REMOTEID","S2","SITEID","SUBSCRIBE","SUBTYPE","TABLIST","TAGS","TYPE",' +
  '"USERID","USERNAME","WEBSITE"\n';

type App = TestApp['app'];

/** Calls `url` as `actor`, checks the answer against the people contract, and returns its status, headers and raw body. */
export async function call(app: App, method: 'GET' | 'POST', url: string, actor: UserHeadersInput, form?: Record<string, string>) {
  const headers = await userHeaders(actor);
  const res = await app.inject({
    method,
    url,
    headers: form === undefined ? headers : { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    ...(form === undefined ? {} : { payload: new URLSearchParams(form).toString() }),
  });
  const path = url.split('?')[0] ?? url;
  assertResponseMatchesOpenApi(OPENAPI, { method, path, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return { status: res.statusCode, headers: res.headers, body: res.rawPayload.toString('utf8') };
}
