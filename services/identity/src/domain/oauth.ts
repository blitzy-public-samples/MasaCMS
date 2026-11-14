/** OAuth clients and tokens over `identity.oauth_client` and `identity.oauth_token`, ported from Masa `oauthClientBean.cfc` and `oauthTokenBean.cfc`. */
import { randomBytes } from 'node:crypto';
import { cfEq, cfHash, cfUuid } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import { registeredTenants, tenantIdForSite, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { tokenInfoFromSessionJson, type AcfStruct } from '../legacy/session-json.js';
import {
  charKey,
  type IdentityRepository,
  type ListPage,
  type ListedPage,
  type OAuthClientValues,
  type OAuthTokenInput,
} from '../repo/repository.js';
import { OAUTH_TOKEN, type OAuthClientRow, type OAuthTokenRow } from '../repo/tables.js';

/** Database, repository and clock of the OAuth operations. */
export interface OAuthDeps {
  db: TenantDb;
  repo: IdentityRepository;
  clock: Clock;
}

/** ORM validation failures by property, as `bean.getErrors()` holds them. */
export type OAuthErrors = Record<string, string>;

/** A client as the ORM bean holds it: NULL columns read as ''; `created`/`lastupdate` are null only when the stored row has none. */
export interface OAuthClient {
  clientid: string;
  clientsecret: string;
  siteid: string;
  userid: string;
  name: string;
  description: string;
  granttype: string;
  redirecturl: string;
  created: Date | null;
  lastupdate: Date | null;
  lastupdateby: string;
  lastupdatebidy: string;
}

/** The `cwebservice.save` request values; an absent field takes the controller's `param` default [legacy: admin/core/controllers/cwebservice.cfc:90-96]. */
export interface OAuthClientForm {
  siteid: string;
  clientid?: string;
  clientsecret?: string;
  name?: string;
  description?: string;
  granttype?: string;
  redirecturl?: string;
  userid?: string;
}

/** The session user a save acts for, from its login snapshot; null when nobody is logged in. */
export type OAuthActor = { fname: string | null; lname: string | null } | null;

/** A merged and validated client; `located` is the stored row the save started from, null for a new client. */
export interface ClientValidation {
  client: OAuthClient;
  errors: OAuthErrors;
  located: OAuthClientRow | null;
}

/** Outcome of `saveClient`; `stored` is the written row, null when validation kept the client unsaved. */
export interface ClientSaveResult {
  client: OAuthClient;
  errors: OAuthErrors;
  stored: OAuthClientRow | null;
}

/** A token as the ORM bean holds it; non-empty `errors` mean validation kept it unsaved. */
export type OAuthToken = OAuthTokenRow & { errors: OAuthErrors };

/** Options of `generateToken` [legacy: core/mura/client/api/oauth/oauthClientBean.cfc:24]. */
export interface GenerateTokenOptions {
  grantType?: string;
  userId?: string;
}

/** The `tusers` row a client's or token's `user` relation loads: its id and stored site id ('' for NULL). */
export interface OAuthUser {
  userId: string;
  siteId: string;
}

/** Width of the ORM `fieldtype="id"` and relation key properties [legacy: core/mura/bean/bean.cfc:1096-1116]. */
const ID_LENGTH = 35;
/** Width the ORM gives the `site` relation [legacy: core/mura/bean/bean.cfc:1107-1110]. */
const SITE_ID_LENGTH = 25;
/** `clientsecret length=100` [legacy: core/mura/client/api/oauth/oauthClientBean.cfc:3]. */
const CLIENT_SECRET_LENGTH = 100;
/** `left(fname & " " & lname, 50)` [legacy: core/mura/bean/beanORM.cfc:407-413]. */
const AUDIT_NAME_LENGTH = 50;
const SECRET_SOURCE_BYTES = 32;
const TOKEN_PREFIX = '000';
const MINUTE_MS = 60_000;
const SHORT_LIVED_MINUTES = 60;
const LONG_LIVED_YEARS = 100;
/** Grant types whose tokens live an hour and whose day-old tokens a new one purges, matched case-sensitively as `listFind` does. */
const SHORT_LIVED_GRANTS: ReadonlySet<string> = new Set(['client_credentials', 'authorization_code']);
const DEFAULT_TOKEN_GRANT = 'client_credentials';
const AUTHORIZATION_CODE_GRANT = 'authorization_code';
const CRLF = '\r\n';
const LIST_DELIMITER = '|';

/** `cwebservice` `param` defaults [legacy: admin/core/controllers/cwebservice.cfc:90-96]. */
const FORM_DEFAULTS = Object.freeze({
  clientid: '',
  clientsecret: '',
  name: '',
  description: '',
  granttype: 'basic',
  redirecturl: '',
  userid: '',
});

/** The beanValidator message for a property without a `message` or `rbkey` [legacy: core/mura/bean/beanValidator.cfc:249]. */
function invalid(property: string): string {
  return `The property named '${property}' is not valid`;
}

function hasErrors(errors: OAuthErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** `left(session.mura.fname & " " & session.mura.lname, 50)`, or '' when nobody is logged in [legacy: core/mura/bean/beanORM.cfc:407-413]. */
function auditName(actor: OAuthActor): string {
  return actor === null ? '' : `${actor.fname ?? ''} ${actor.lname ?? ''}`.slice(0, AUDIT_NAME_LENGTH);
}

/** Uppercase hex of ColdFusion `hash()` over unpredictable input, standing in for `hash(encrypt(id, generateSecretKey('AES')))`. */
function unpredictableHash(): string {
  return cfHash(randomBytes(SECRET_SOURCE_BYTES).toString('hex'));
}

/** Each tenant once, `first` ahead of every registered tenant. */
async function candidateTenants(db: TenantDb, first: readonly string[]): Promise<string[]> {
  return [...new Set([...first, ...(await registeredTenants(db)).map((entry) => entry.tenantId)])];
}

/** The first non-null `read`, one tenant transaction per candidate tenant, as a site-less `loadBy` finds a row by key alone. */
async function firstInTenants<T>(deps: OAuthDeps, first: readonly string[], read: (tx: TenantTx) => Promise<T | null>): Promise<T | null> {
  for (const tenantId of await candidateTenants(deps.db, first)) {
    const found = await withTenant(deps.db, tenantId, read);
    if (found !== null) return found;
  }
  return null;
}

/** The bean view of a stored client. */
function clientOf(row: OAuthClientRow): OAuthClient {
  return {
    clientid: row.clientid,
    clientsecret: row.clientsecret ?? '',
    siteid: row.siteid,
    userid: row.userid ?? '',
    name: row.name,
    description: row.description ?? '',
    granttype: row.granttype ?? '',
    redirecturl: row.redirecturl ?? '',
    created: row.created,
    lastupdate: row.lastupdate,
    lastupdateby: row.lastupdateby ?? '',
    lastupdatebidy: row.lastupdatebidy ?? '',
  };
}

/** Every non-key column of `client`; the repository applies the ORM NULL rule. */
function storedValues(client: OAuthClient): OAuthClientValues {
  return {
    clientsecret: client.clientsecret,
    siteid: client.siteid,
    granttype: client.granttype,
    userid: client.userid,
    name: client.name,
    created: client.created,
    lastupdate: client.lastupdate,
    description: client.description,
    redirecturl: client.redirecturl,
    lastupdatebidy: client.lastupdatebidy,
    lastupdateby: client.lastupdateby,
  };
}

/** The oauthClient required, length and primary-key rules [legacy: core/mura/bean/beanValidator.cfc:183-260; core/mura/bean/beanORM.cfc:368-377]. */
function clientErrors(client: OAuthClient): OAuthErrors {
  const errors: OAuthErrors = {};
  if (client.clientid === '' || client.clientid.length > ID_LENGTH) errors.clientid = invalid('clientid');
  if (client.clientsecret.length > CLIENT_SECRET_LENGTH) errors.clientsecret = invalid('clientsecret');
  if (client.siteid === '' || client.siteid.length > SITE_ID_LENGTH) errors.siteid = invalid('siteid');
  if (client.userid.length > ID_LENGTH) errors.userid = invalid('userid');
  if (client.name === '') errors.name = invalid('name');
  if (client.clientid === '') errors.primarykey = "The primary key 'clientid' is required.";
  return errors;
}

/** The oauthToken required, length and primary-key rules; a SHA-256 token id never fits the 35-character id [legacy: core/mura/client/api/oauth/oauthTokenBean.cfc:2-8]. */
function tokenErrors(token: OAuthTokenRow): OAuthErrors {
  const errors: OAuthErrors = {};
  if (token.token === '' || token.token.length > ID_LENGTH) errors.token = invalid('token');
  if (token.clientid === '' || token.clientid.length > ID_LENGTH) errors.clientid = invalid('clientid');
  if ((token.userid ?? '').length > ID_LENGTH) errors.userid = invalid('userid');
  if (token.token === '') errors.primarykey = "The primary key 'token' is required.";
  return errors;
}

/** The repository row of a token; the ORM NULL rule maps '' to NULL. */
function tokenInput(token: OAuthTokenRow): OAuthTokenInput {
  const { tenant_id: _tenant, ...row } = token;
  return row;
}

/** CFML `dateAdd('yyyy', years, at)`: the local calendar year moves and a missing Feb 29 becomes Feb 28. */
function addYears(at: Date, years: number): Date {
  const moved = new Date(at.getTime());
  moved.setFullYear(at.getFullYear() + years);
  if (moved.getMonth() !== at.getMonth()) moved.setDate(0);
  return moved;
}

/** The `page` window of the OAuth clients of `siteId` by clientid and their total, read in the site's tenant [legacy: admin/core/views/cwebservice/list.cfm:78]. */
export async function listClients(deps: OAuthDeps, siteId: string, page: ListPage): Promise<ListedPage<OAuthClientRow>> {
  if (siteId === '') return { items: [], total: 0 };
  return withTenant(deps.db, tenantIdForSite(siteId), (tx) => deps.repo.listOAuthClients(tx, siteId, page));
}

/** The client `clientId` in any tenant, the tenant of `siteId` first, as `loadBy(clientid=…)` finds it; null when absent [legacy: core/mura/bean/beanORM.cfc:750-925]. */
export async function loadClient(deps: OAuthDeps, clientId: string, siteId = ''): Promise<OAuthClientRow | null> {
  if (clientId === '') return null;
  return firstInTenants(deps, siteId === '' ? [] : [tenantIdForSite(siteId)], (tx) => deps.repo.findOAuthClient(tx, clientId));
}

/** The client `clientId` of the API site `siteId`, read in that site's tenant alone, as the site-scoped `loadBy(clientid=…)` finds it; an empty site loads unscoped; null when absent [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:558; core/mura/cfobject.cfc:138-149; core/mura/bean/beanORM.cfc:766-767]. */
export async function loadSiteClient(deps: OAuthDeps, clientId: string, siteId: string): Promise<OAuthClientRow | null> {
  if (siteId === '') return loadClient(deps, clientId);
  if (clientId === '') return null;
  return withTenant(deps.db, tenantIdForSite(siteId), (tx) => deps.repo.findOAuthClient(tx, clientId));
}

/** A new bean as init leaves it: created, lastupdate and lastupdateby set, granttype at its `basic` default [legacy: core/mura/bean/beanORM.cfc:101-123]. */
function newClient(clientid: string, siteid: string, now: Date, actor: OAuthActor): OAuthClient {
  return {
    clientid,
    clientsecret: '',
    siteid,
    userid: '',
    name: '',
    description: '',
    granttype: FORM_DEFAULTS.granttype,
    redirecturl: '',
    created: now,
    lastupdate: now,
    lastupdateby: auditName(actor),
    lastupdatebidy: '',
  };
}

/** The posted fields that are present, so absent ones keep their `param` defaults. */
function postedValues(form: OAuthClientForm): Record<keyof typeof FORM_DEFAULTS, string> {
  const values: Record<keyof typeof FORM_DEFAULTS, string> = { ...FORM_DEFAULTS };
  for (const field of Object.keys(FORM_DEFAULTS) as (keyof typeof FORM_DEFAULTS)[]) {
    const value = form[field];
    if (value !== undefined) values[field] = value;
  }
  return values;
}

/** `loadBy(clientid).set(rc).validate()`: the stored or new client with the posted values laid over it, and its errors [legacy: admin/core/controllers/cwebservice.cfc:106]. */
export async function validateClient(deps: OAuthDeps, form: OAuthClientForm, actor: OAuthActor): Promise<ClientValidation> {
  const posted = { ...postedValues(form), siteid: form.siteid };
  const located = await loadClient(deps, posted.clientid, posted.siteid);
  const base = located === null ? newClient(posted.clientid, posted.siteid, deps.clock.now(), actor) : clientOf(located);
  const client: OAuthClient = { ...base, ...posted };
  return { client, errors: clientErrors(client), located };
}

/** `oauthClient.save()` after the controller's merge: generates an empty secret, then writes a valid client in one gated transaction of its site's tenant [legacy: core/mura/client/api/oauth/oauthClientBean.cfc:16-22; core/mura/bean/beanORM.cfc:379-560]. */
export async function saveClient(deps: OAuthDeps, form: OAuthClientForm, actor: OAuthActor): Promise<ClientSaveResult> {
  const { client: merged, located } = await validateClient(deps, form, actor);
  // The secret is set before the save's own validation, so a failed save still returns it.
  const client: OAuthClient = merged.clientsecret === '' ? { ...merged, clientsecret: unpredictableHash() } : merged;
  const errors = clientErrors(client);
  if (hasErrors(errors)) return { client, errors, stored: null };
  const saving: OAuthClient = { ...client, lastupdate: deps.clock.now(), lastupdateby: auditName(actor) };
  const tenantId = tenantIdForSite(saving.siteid);
  const values = storedValues(saving);
  const stored = await withGatedTenant(
    deps.db,
    tenantId,
    async (tx) =>
      (await deps.repo.updateOAuthClient(tx, saving.clientid, values)) ?? deps.repo.insertOAuthClient(tx, { ...values, clientid: saving.clientid }),
  );
  // Legacy updates siteid in place. Here a client lives in its site's tenant and its tokens in the client's, so a re-sited
  // client is removed from the old tenant with its tokens, which legacy keeps; legacy on ACF 2023 never stores a token.
  if (located !== null && located.tenant_id !== tenantId) {
    await withGatedTenant(deps.db, located.tenant_id, (tx) => deps.repo.deleteOAuthClient(tx, located.clientid));
  }
  return { client: clientOf(stored), errors: {}, stored };
}

/** Deletes the client and its tokens in one gated transaction of its tenant (`cascade="delete"`); false when no tenant holds it [legacy: core/mura/bean/beanORM.cfc:698-747]. */
export async function deleteClient(deps: OAuthDeps, clientId: string): Promise<boolean> {
  const located = await loadClient(deps, clientId);
  if (located === null) return false;
  return withGatedTenant(deps.db, located.tenant_id, (tx) => deps.repo.deleteOAuthClient(tx, located.clientid));
}

/** The stored grant type, `client_credentials` when empty [legacy: core/mura/client/api/oauth/oauthClientBean.cfc:73-79]. */
export function effectiveGrantType(client: { granttype: string | null }): string {
  return client.granttype === null || client.granttype === '' ? DEFAULT_TOKEN_GRANT : client.granttype;
}

/** True when no redirect URL is stored, else when `uri` equals one of its items by CFML `==` [legacy: core/mura/client/api/oauth/oauthClientBean.cfc:81-93]. */
export function isValidRedirectURI(client: { redirecturl: string | null }, uri: string): boolean {
  const stored = client.redirecturl ?? '';
  if (stored === '') return true;
  // replace() without scope "all" changes only the first CRLF; listToArray drops empty items.
  const items = stored.replace(CRLF, LIST_DELIMITER).split(LIST_DELIMITER).filter((item) => item !== '');
  return items.some((item) => cfEq(item, uri));
}

/** The client's unexpired token of the grant type and user, else a new token saved as `oauthToken.save()` saves it, in one gated transaction of the client's tenant [legacy: core/mura/client/api/oauth/oauthClientBean.cfc:24-71; core/mura/client/api/oauth/oauthTokenBean.cfc:10-25]. */
export async function generateToken(
  deps: OAuthDeps,
  client: Pick<OAuthClientRow, 'tenant_id' | 'clientid' | 'userid'>,
  { grantType = DEFAULT_TOKEN_GRANT, userId = '' }: GenerateTokenOptions = {},
): Promise<OAuthToken> {
  const owner = userId === '' ? (client.userid ?? '') : userId;
  return withGatedTenant(deps.db, client.tenant_id, async (tx) => {
    const now = deps.clock.now();
    const reusable = await deps.repo.findReusableToken(tx, { clientId: client.clientid, grantType, userId: owner, now });
    if (reusable !== null) return { ...reusable, errors: {} };
    const token: OAuthTokenRow = {
      tenant_id: client.tenant_id,
      // Kept at 67 characters, not an MD5-length 35: legacy's hash() defaults to SHA-256 on ACF 2023, so its token id fails
      // the 35-character id rule and is never stored, and a storable id here would keep tokens legacy never keeps.
      token: `${TOKEN_PREFIX}${unpredictableHash()}`,
      granttype: grantType,
      clientid: client.clientid,
      userid: owner === '' ? null : owner,
      // The unscoped `granttype==` test is CFML `==`, which ignores case.
      accesscode: cfEq(grantType, AUTHORIZATION_CODE_GRANT) ? cfUuid() : null,
      data: null,
      expires: SHORT_LIVED_GRANTS.has(grantType) ? new Date(now.getTime() + SHORT_LIVED_MINUTES * MINUTE_MS) : addYears(now, LONG_LIVED_YEARS),
    };
    const errors = tokenErrors(token);
    if (!hasErrors(errors)) await deps.repo.insertToken(tx, tokenInput(token));
    // The purge follows the save whether or not the save wrote the token.
    if (SHORT_LIVED_GRANTS.has(grantType)) await deps.repo.purgeExpiredTokens(tx, { clientId: client.clientid, grantType, now });
    return { ...token, errors };
  });
}

/** `token.setData(serializeJSON(getSession())).save()`: stores `sessionJson` byte-exact; a token failing validation keeps the data unsaved [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:518-519]. */
export async function attachSessionData(deps: OAuthDeps, token: OAuthToken, sessionJson: string): Promise<OAuthToken> {
  const { errors: _previous, ...row } = token;
  const attached: OAuthTokenRow = { ...row, data: sessionJson };
  const errors = tokenErrors(attached);
  if (hasErrors(errors)) return { ...attached, errors };
  const stored = await withGatedTenant(deps.db, attached.tenant_id, async (tx) => {
    // The ORM NULL rule, which the repository's insert applies, stores '' as NULL.
    const updated = await deps.repo.update<OAuthTokenRow>(tx, OAUTH_TOKEN.table, { token: attached.token }, { data: sessionJson === '' ? null : sessionJson });
    return updated ?? deps.repo.insertToken(tx, tokenInput(attached));
  });
  return { ...stored, errors: {} };
}

/** The token `token` in any tenant, of `grantType` when given (SQL Server equality); null when absent [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:488,750]. */
export async function findToken(deps: OAuthDeps, lookup: { token: string; grantType?: string }): Promise<OAuthToken | null> {
  if (lookup.token === '') return null;
  const row = await firstInTenants(deps, [], (tx) => deps.repo.findToken(tx, lookup.token));
  if (row === null) return null;
  // An empty grant type is bound as NULL by the ORM, which no stored value equals.
  if (lookup.grantType !== undefined && (row.granttype === null || lookup.grantType === '' || charKey(row.granttype) !== charKey(lookup.grantType))) return null;
  return { ...row, errors: {} };
}

/** `oauthToken.delete()` in one gated transaction of the token's tenant; false when no row was removed [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:755-757]. */
export async function deleteToken(deps: OAuthDeps, token: Pick<OAuthTokenRow, 'tenant_id' | 'token'>): Promise<boolean> {
  return withGatedTenant(deps.db, token.tenant_id, (tx) => deps.repo.deleteToken(tx, token.token));
}

/** The user `userId` of a `user` relation, an account or a group as `getBean('user').loadBy(userid=…)` finds either; null for '' or no row [legacy: core/mura/client/api/oauth/oauthTokenBean.cfc:5]. */
export async function findOAuthUser(deps: OAuthDeps, userId: string | null): Promise<OAuthUser | null> {
  if (userId === null || userId === '') return null;
  return firstInTenants(deps, [], async (tx) => {
    const account = await deps.repo.findAccountById(tx, userId);
    if (account !== null) return { userId: account.userid, siteId: account.siteid ?? '' };
    const group = await deps.repo.findGroup(tx, userId);
    return group === null ? null : { userId: group.userid, siteId: group.siteid ?? '' };
  });
}

/** The token holding access code `code`, of `clientId` when given (SQL Server equality); null when none [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:601]. */
export async function findTokenByAccessCode(deps: OAuthDeps, code: string, clientId?: string): Promise<OAuthToken | null> {
  if (code === '') return null;
  const row = await firstInTenants(deps, [], (tx) => deps.repo.findTokenByAccessCode(tx, code));
  if (row === null || (clientId !== undefined && charKey(row.clientid) !== charKey(clientId))) return null;
  return { ...row, errors: {} };
}

/** Whole seconds from now to `expires`, as `dateDiff('s', now(), expires)` [legacy: core/mura/client/api/oauth/oauthTokenBean.cfc:27-29]. */
export function expiresIn(token: Pick<OAuthTokenRow, 'expires'>, clock: Clock): number {
  return Math.trunc((token.expires.getTime() - clock.now().getTime()) / 1000) || 0;
}

/** True once `expiresIn` is 0 or less [legacy: core/mura/client/api/oauth/oauthTokenBean.cfc:35-37]. */
export function isExpired(token: Pick<OAuthTokenRow, 'expires'>, clock: Clock): boolean {
  return expiresIn(token, clock) <= 0;
}

/** `utility.getEpochTime(expires)`: whole seconds since 1970-01-01 00:00 local time [legacy: core/mura/utility.cfc:1564-1577]. */
export function expiresAt(token: Pick<OAuthTokenRow, 'expires'>): number {
  return Math.trunc((token.expires.getTime() - new Date(1970, 0, 1).getTime()) / 1000) || 0;
}

/** The stored session's `mura` struct without its secret and login-state keys, `{}` when the data is not JSON [legacy: core/mura/client/api/oauth/oauthTokenBean.cfc:39-57]. */
export function tokenInfo(token: Pick<OAuthTokenRow, 'data'>): AcfStruct {
  return tokenInfoFromSessionJson(token.data);
}
