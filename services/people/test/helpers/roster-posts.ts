/** cUsers roster form posts shared by the offline and PostgreSQL admin-roster suites. */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, adminUrl, cfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_A, assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { TEST_CLOCK, userHeaders, type TestApp } from './app.js';
import { createIdentityDouble, type IdentityDouble } from './identity-double.js';
import { DEFAULT_PEOPLE_SEED, SYSTEM_USER_A_PERSON, accountFor, accountsForSeed, personRow, type TestActor } from './fixtures.js';

export const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };

/** The contract path declaring `operationId`, which `app.inject` addresses. */
function pathOf(operationId: string): string {
  const found = Object.entries(OPENAPI.paths).find(([, item]) =>
    Object.values(item).some((operation) => (operation as { operationId?: unknown } | null)?.operationId === operationId),
  );
  if (found === undefined) throw new Error(`The people contract declares no ${operationId}`);
  return found[0];
}

export const UPDATE_USER = pathOf('updateUser');
export const UPDATE_ADDRESS = pathOf('updateAddress');
export const SITE = TENANT_A.siteId;
const TOKEN = 'ROSTER-TOKEN';
const EXPIRES = '260630130000000';
const SEED_ACCOUNTS = accountsForSeed(DEFAULT_PEOPLE_SEED);
export const STORED_USER = SYSTEM_USER_A_PERSON.userid;
export const [CATEGORY_1, CATEGORY_2] = [cfUuid(), cfUuid()] as const;
export const GROUP = cfUuid();
/** A tenant-a super user, stored in tenant-a's private pool. */
export const S2_TARGET = personRow({ siteid: SITE, fname: 'Root', lname: 'Super', email: 'root.super@tenant-a.opt2.test' });
const S2_TARGET_ACCOUNT = accountFor(S2_TARGET, { s2: 1, username: 'root.super' });
/** The legacy-shaped 503 body: a withheld branch, or a save people cannot place. */
export const LEGACY_503 = { apiversion: 'v1', error: { message: 'Unhandled Exception', code: 'server_error' } };
/** The account-operation steps people asks identity for, by contract operation id. */
const ACCOUNT_STEPS: ReadonlyMap<string, string> = new Map([
  ['prepareAccountOperation', 'prepare'],
  ['commitAccountOperation', 'commit'],
  ['abortAccountOperation', 'abort'],
  ['finishAccountOperation', 'finish'],
  ['revertAccountOperation', 'revert'],
]);

export type Redirect = { action: string; params: Record<string, string> } | { url: string };
export interface RouteResult {
  written?: boolean;
  redirect: Redirect;
}

/** A file part of a multipart post. */
interface FilePart {
  field: string;
  filename: string;
}

/** What one post sends: form fields as web relays them, the form action's query, and file parts for a multipart body. */
export interface Post {
  fields: Record<string, string>;
  query?: Record<string, string>;
  files?: readonly FilePart[];
  /** Sends the fields as a JSON object body. */
  json?: boolean;
  /** Leaves out the CSRF pair the form renders. */
  withoutToken?: boolean;
}

/** A multipart body of `fields` and `files`; a part with a file name carries a few stand-in bytes, one without none. */
function multipart(fields: Record<string, string>, files: readonly FilePart[]): { payload: string; contentType: string } {
  const boundary = 'opt2-roster-boundary';
  const parts = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  for (const { field, filename } of files) {
    const content = filename === '' ? '' : 'PNG';
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n${content}\r\n`);
  }
  return { payload: `${parts.join('')}--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Posts `post` to `path` as `actor` through the gateway, checks the answer against the contract and returns status and body. */
export async function send<B>(app: TestApp['app'], path: string, actor: TestActor, post: Post): Promise<{ status: number; body: B }> {
  const fields = post.withoutToken === true ? post.fields : { ...post.fields, [CSRF_FIELD_TOKEN]: TOKEN, [CSRF_FIELD_EXPIRES]: EXPIRES };
  const search = new URLSearchParams(post.query ?? {}).toString();
  const url = search === '' ? path : `${path}?${search}`;
  const form = post.files === undefined ? { payload: new URLSearchParams(fields).toString(), contentType: 'application/x-www-form-urlencoded' } : multipart(fields, post.files);
  const body = post.json === true ? { payload: JSON.stringify(fields), contentType: 'application/json' } : form;
  const res = await app.inject({ method: 'POST', url, headers: { ...(await userHeaders(actor)), 'content-type': body.contentType }, payload: body.payload });
  const validated = assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return { status: res.statusCode, body: validated as B };
}

/** The admin URL web renders for `redirect`, its parameters in the order the route gives them. */
export function rendered(redirect: Redirect | undefined): string | undefined {
  if (redirect === undefined) return undefined;
  if ('url' in redirect) return redirect.url;
  const [circuit = '', action = ''] = redirect.action.split('.');
  return adminUrl({ circuit, action, params: Object.entries(redirect.params) });
}

/** The account-operation steps identity received, each with the operation id of its path. */
export function accountSteps(identity: IdentityDouble): Array<[step: string, operationId: string]> {
  return identity.requests.flatMap((request): Array<[string, string]> => {
    const step = request.operationId === undefined ? undefined : ACCOUNT_STEPS.get(request.operationId);
    if (step === undefined) return [];
    return [[step, decodeURIComponent(/\/operations\/([^/:]+):/.exec(request.path)?.[1] ?? '')]];
  });
}

/** The CSRF contexts identity was asked to consume, with its verdicts. */
export function csrfContexts(identity: IdentityDouble): Array<[context: string, valid: boolean]> {
  return identity.csrf.consumed().map(({ request, valid }) => [request.context, valid]);
}

/** `fields` without `names`, as a form posts when those inputs are disabled or absent. */
export function without(fields: Record<string, string>, ...names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([name]) => !names.includes(name)));
}

/** The edit-user form of a Type=2 save as `edituser.cfm` posts it once its script has run. */
export function userForm(action: 'Add' | 'Update' | 'Delete', fields: Record<string, string> = {}): Record<string, string> {
  return {
    type: '2',
    action,
    contact: '0',
    groupid: '',
    ContactForm: '',
    returnurl: '',
    subtype: 'Default',
    siteid: SITE,
    isPublic: '0',
    InActive: '0',
    fname: 'Robin',
    lname: 'Roster',
    email: 'robin.roster@tenant-a.opt2.test',
    company: 'Acme',
    jobtitle: 'Analyst',
    mobilePhone: '555-0177',
    usernameNoCache: 'robin.roster',
    passwordNoCache: 'Roster#2026',
    password2: 'Roster#2026',
    tags: 'alpha,gamma',
    categoryid: `${CATEGORY_1},${CATEGORY_2}`,
    address1: '9 Harbour Road',
    address2: '',
    city: 'Bergen',
    state: '',
    zip: '5003',
    country: 'Norway',
    phone: '555-0199',
    fax: '',
    addressEmail: 'robin@home.opt2.test',
    addressURL: '',
    hours: '',
    ...fields,
  };
}

/** The address form as `editaddress.cfm` posts it, the action set by its buttons. */
export function addressForm(action: string, fields: Record<string, string> = {}): Record<string, string> {
  return {
    action,
    addressID: '',
    addressName: 'Cabin',
    address1: '1 Fjord Lane',
    address2: '',
    city: 'Voss',
    state: '',
    zip: '5700',
    country: 'Norway',
    phone: '',
    fax: '',
    addressURL: '',
    addressEmail: '',
    hours: '',
    isPrimary: '0',
    ...fields,
  };
}

/** The query `edituser.cfm` puts on its form action. */
export function userQuery(userid: string, routeid = ''): Record<string, string> {
  return { userid, routeid };
}

/** The query `editaddress.cfm` puts on its form action. */
export function addressQuery(userid: string, routeid = ''): Record<string, string> {
  return { userid, routeid, siteid: SITE };
}

/** `cUsers.edituser` preserving `siteid`, `userid` and `routeid`, as `updateAddress()` redirects. */
export function editUserUrl(userid: string, routeid: string): string {
  return adminUrl({ circuit: 'cUsers', action: 'edituser', params: [['siteid', SITE], ['userid', userid], ['routeid', routeid]] });
}

/** A fresh identity double holding every seeded account and the S2 target's. */
export function newIdentity(): IdentityDouble {
  return createIdentityDouble({ clock: TEST_CLOCK, accounts: [...SEED_ACCOUNTS, S2_TARGET_ACCOUNT] });
}
