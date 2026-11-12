/** Forgot-password and send-login mail: legacy userUtility's lookup, password reset, redirect and text, requested from communications as `identity.login-mail.requested.v1`. */
import { randomInt } from 'node:crypto';
import { cfUuid, javaTrim } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import {
  registeredTenants,
  registryEntryForTenant,
  tenantForRegisteredSite,
  tenantIdForSite,
  type TenantDb,
  type TenantRegistryEntry,
  type TenantTx,
} from '@opt2/platform/tenancy';
import type { IdentityEvents, LoginMailRequestedPayload } from '../events/publish.js';
import { hashNewPassword, type LegacyPasswordConfig } from '../legacy/hash.js';
import { charKey, type EmailAccountRow, type IdentityRepository } from '../repo/repository.js';
import { REDIRECT, type RedirectRow, type UserAccountRow } from '../repo/tables.js';
import { DEFAULT_ACCOUNT_SETTINGS, awaitAccountOpen } from './account-operations.js';

/** The forgot-password address check, applied to the trimmed address as a prefix match [legacy: core/mura/user/userUtility.cfc:421]. */
export const EMAIL_PATTERN = /^[^@%*<>' ]+@[^@%*<>' ]{1,255}\.[^@%*<>' ]{2,5}/i;

/** A site's mail settings as `settingsManager.getSite(siteid)` holds them; `serverPort` is its getter's value (`:<port>` or ''). */
export interface LoginMailSiteSettings {
  site: string;
  contact: string;
  sendLoginScript: string;
  editProfileURL: string;
  extranetSSL: boolean;
  useSSL: boolean;
  serverPort: string;
  context: string;
  extranetPublicRegNotify: string;
}

/** The `configBean` mail settings; `serverPort` is its getter's value (`:<port>` or '') [legacy: core/mura/configBean.cfc:742-750]. */
export interface LoginMailGlobalSettings {
  title: string;
  adminEmail: string;
  adminSSL: boolean;
  adminDir: string;
  serverPort: string;
  context: string;
  autoresetpasswords: boolean;
  sendLoginBcc: string;
}

/** Masa defaults, with `autoresetpasswords` as the generated settings file sets it [legacy: core/mura/configBean.cfc:82-228; core/templates/settings.template.cfm:16]. */
export const DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS: Readonly<LoginMailGlobalSettings> = Object.freeze({
  title: 'Masa CMS',
  adminEmail: '',
  adminSSL: false,
  adminDir: '/admin',
  serverPort: '',
  context: '',
  autoresetpasswords: false,
  sendLoginBcc: '',
});

type MaybePromise<T> = T | Promise<T>;

/**
 * Mail settings the caller resolves: `site` answers an unknown id with the default site, as `getSite` does, and
 * `urlStem` is `getSite(siteId).getContentRenderer().getURLStem(<stored site id>, filename)`.
 */
export interface LoginMailSettingsSource {
  global(): MaybePromise<LoginMailGlobalSettings>;
  site(siteId: string): MaybePromise<LoginMailSiteSettings>;
  urlStem(siteId: string, filename: string): MaybePromise<string>;
}

/** URL settings `getURLStem` reads; `siteAssetPath` is used only with `legacyIndexFileLocation`. */
export interface UrlStemOptions {
  siteIdInUrls: boolean;
  indexFileInUrls: boolean;
  hashUrls: boolean;
  legacyIndexFileLocation?: boolean;
  siteAssetPath?: string;
}

/** `contentServer.getURLStem` outside an HTML export [legacy: core/mura/content/contentServer.cfc:946-1001]. */
export function legacyUrlStem(siteId: string, filename: string, opts: UrlStemOptions): string {
  let name = filename;
  if (name !== '') {
    if (!name.startsWith('/')) name = `/${name}`;
    if (!opts.hashUrls && !name.endsWith('/')) name = `${name}/`;
  }
  const prefix = opts.hashUrls ? '/#' : '';
  if (!opts.siteIdInUrls) {
    if (name === '') return '/';
    return opts.indexFileInUrls ? `/index.cfm${prefix}${name}` : `${prefix}${name}`;
  }
  const assetIndex = opts.legacyIndexFileLocation === true;
  const assetRoot = `${opts.siteAssetPath ?? ''}/${siteId}`;
  if (name === '') {
    if (!opts.indexFileInUrls) return `/${siteId}/`;
    return assetIndex ? `${assetRoot}/` : `/index.cfm/${siteId}/`;
  }
  if (!opts.indexFileInUrls) return `/${siteId}${prefix}${name}`;
  return assetIndex ? `${assetRoot}/index.cfm${prefix}${name}` : `/index.cfm/${siteId}${prefix}${name}`;
}

/** Dependencies of the login-mail operations; `password` defaults to the Masa password settings, `sleep` to a timer. */
export interface LoginMailDeps {
  db: TenantDb;
  repo: Pick<IdentityRepository, 'findAccountsByEmail' | 'writeCredential' | 'removePrevRedirects' | 'insert'>;
  events: Pick<IdentityEvents, 'publishLoginMailRequested'>;
  clock: Clock;
  settings: LoginMailSettingsSource;
  password?: LegacyPasswordConfig;
  sleep?: (ms: number) => Promise<void>;
}

/** A `sendLoginByEmail` call; `httpHost` is the request's `Host` header, which legacy reads as `cgi.http_host`. */
export interface SendLoginByEmailInput {
  email: string;
  siteId: string;
  httpHost: string;
  subject?: string;
  message?: string;
}

/** The user bean values `sendLoginByUser` reads; `password` is the bean's in-memory value, '' unless the caller just set one. */
export interface LoginMailUser {
  userId: string;
  siteId: string;
  username: string;
  fname: string;
  lname: string;
  email: string;
  password?: string;
}

/** A `sendLoginByUser` call; `httpHost` is the request's `Host` header. */
export interface SendLoginByUserInput {
  user: LoginMailUser;
  siteId: string;
  httpHost: string;
  isPublicReg?: boolean;
  subject?: string;
  message?: string;
}

/** Entry point that requested a mail. */
export type LoginMailKind = LoginMailRequestedPayload['kind'];

/** One requested mail: its user, the tenant whose outbox holds the event, and the ids it carries. */
export interface LoginMailRequest {
  userId: string;
  tenantId: string;
  messageId: string;
  returnId: string;
}

/** Values sendLogin renders into the mail text [legacy: core/mura/user/userUtility.cfc:500-512]. */
export interface LoginMailTextValues {
  sendLoginScript: string;
  autoresetpasswords: boolean;
  firstName: string;
  lastName: string;
  username: string;
  password: string;
  contactEmail: string;
  contactName: string;
  returnURL: string;
}

const DEFAULT_SITE_ID = 'default';
// getRandomPassword(12, 'alphanumeric', 'yes') draws from the lower-case, numeric and upper-case lists in this order [legacy: core/mura/user/userUtility.cfc:700-722].
const ALPHA_LCASE = 'acegikmoqsuwybdfhjlnprtvxz';
const NUMERIC = '0246897531';
const RESET_CHARSET = `${ALPHA_LCASE}${NUMERIC}${ALPHA_LCASE.toUpperCase()}`;
const RESET_PASSWORD_LENGTH = 12;
const SCRIPT_PLACEHOLDERS = ['#firstName#', '#lastName#', '#username#', '#password#', '#contactEmail#', '#contactName#', '#returnURL#'] as const;

/** sendLogin's request-level inputs: settings read once per call, the request site (null without one) and the custom script. */
interface SendContext {
  global: LoginMailGlobalSettings;
  site: LoginMailSiteSettings | null;
  siteId: string;
  httpHost: string;
  message: string;
}

/** The addressing of one mail and the entry point that requested it. */
interface MailEnvelope {
  ctx: SendContext;
  to: string;
  from: string;
  subject: string;
  bcc: string;
  kind: LoginMailKind;
}

/** The user bean values sendLogin reads, `password` already resolved. */
type MailUser = Omit<LoginMailUser, 'email' | 'password'> & { password: string };

/** An autoreset password and the value stored for it. */
interface ResetCredential {
  plain: string;
  stored: string | null;
}

/** The tenant one pool lookup runs in and the accounts getUserByEmail admits there. */
interface PoolScope {
  tenantId: string;
  admits(account: UserAccountRow): boolean;
}

/** getRandomPassword(12, 'alphanumeric', 'yes') [legacy: core/mura/user/userUtility.cfc:696-747]. */
function randomResetPassword(): string {
  let password = '';
  for (let i = 0; i < RESET_PASSWORD_LENGTH; i += 1) {
    password += RESET_CHARSET[randomInt(RESET_CHARSET.length)];
  }
  return password;
}

/** CFML `listFirst(value, ':')`, which skips empty elements. */
function listFirstColon(value: string): string {
  return value.split(':').find((part) => part !== '') ?? '';
}

/**
 * `sanitizeHref` for the host-port-context base sendLogin builds [legacy: core/mura/utility.cfc:1364-1441].
 * Its absolute-URL branch is not ported: it needs a base whose first `:` element is `http` or `https`, which only a
 * `Host` header naming that word can produce.
 */
function sanitizeUrlBase(href: string): string {
  const clean = javaTrim(href);
  if (clean === '') return href;
  if (!clean.startsWith('//')) return clean;
  if (clean.length === 2) return '/';
  const rest = clean.slice(2);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/**
 * CFML `replaceList(script, placeholders, values, '^', '^', true)` as ACF 2023 runs it: each placeholder in list order
 * is replaced literally and case-sensitively across the whole text, and the values are re-split on `^`, so a `^` inside
 * one shifts the rest [legacy: core/mura/user/userUtility.cfc:583-588].
 */
function replaceScriptPlaceholders(script: string, values: readonly string[]): string {
  const replacements = values.join('^').split('^');
  return SCRIPT_PLACEHOLDERS.reduce((text, placeholder, i) => text.split(placeholder).join(replacements[i] ?? ''), script);
}

/**
 * The text sendLogin hands to `mailer.sendText` [legacy: core/mura/user/userUtility.cfc:583-636].
 * In its `output="false"` function `<cfsavecontent>` keeps only the `<cfoutput>` content, so no line break surrounds it.
 */
export function renderLoginMailText(v: LoginMailTextValues): string {
  if (v.sendLoginScript !== '') {
    return replaceScriptPlaceholders(v.sendLoginScript, [
      v.firstName,
      v.lastName,
      v.username,
      v.password,
      v.contactEmail,
      v.contactName,
      v.returnURL,
    ]);
  }
  if (v.autoresetpasswords) {
    return [
      `Dear ${v.firstName},`,
      '',
      'You have requested your login information be sent to you.',
      '',
      `Username: ${v.username}`,
      `Password: ${v.password}`,
      '',
      `Please contact ${v.contactEmail} if you`,
      'have any questions or comments on this process.',
      '',
      'Thank you,',
      '',
      `The ${v.contactName} staff`,
    ].join('\n');
  }
  return [
    `Dear ${v.firstName},`,
    '',
    'We received a request to reset the password associated with this',
    'email address. If you made this request, please follow the',
    'instructions below.',
    '',
    '(If you did not request to have your password reset you can safely',
    'ignore this email.)',
    '',
    'Please click the link below to access your account and reset your password:',
    '',
    v.returnURL,
    '',
    "If clicking the link doesn't seem to work, you can copy and paste the",
    "link into your browser's address window, or retype it there. Once you",
    `have returned to ${v.contactName}, you can then access your account and reset`,
    'your password.',
    '',
    `Thanks for using ${v.contactName}`,
  ].join('\n');
}

/** beanORM's NULL rule for a non-key value: '' or the text `null` in any case is stored as NULL [legacy: core/mura/bean/beanORM.cfc:338-341]. */
function ormValue(value: string): string | null {
  return value === '' || value.toLowerCase() === 'null' ? null : value;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The settings sendLogin reads for one call; `getSite` is consulted only with a site id. */
async function sendContext(settings: LoginMailSettingsSource, input: { siteId: string; httpHost: string; message?: string }): Promise<SendContext> {
  const global = await settings.global();
  const site = input.siteId === '' ? null : await settings.site(input.siteId);
  return { global, site, siteId: input.siteId, httpHost: input.httpHost, message: input.message ?? '' };
}

/** `struser.from`: the global title without a site id, else the site name [legacy: core/mura/user/userUtility.cfc:436-440,471-475]. */
function senderName(ctx: SendContext): string {
  return ctx.site === null ? ctx.global.title : ctx.site.site;
}

/** The given subject, or `'<from> Account Information'` when empty [legacy: core/mura/user/userUtility.cfc:442-444,481-483]. */
function subjectFor(subject: string | undefined, from: string): string {
  return subject === undefined || subject === '' ? `${from} Account Information` : subject;
}

/** A new random password and its stored form when `autoresetpasswords` is on; null otherwise. */
async function resetCredential(deps: LoginMailDeps, global: LoginMailGlobalSettings): Promise<ResetCredential | null> {
  if (!global.autoresetpasswords) return null;
  const plain = randomResetPassword();
  return { plain, stored: await hashNewPassword(plain, deps.password ?? DEFAULT_ACCOUNT_SETTINGS.password) };
}

/** sendLogin's contacts, script and the edit-profile and return URLs of one user [legacy: core/mura/user/userUtility.cfc:518-568]. */
async function loginLinks(
  settings: LoginMailSettingsSource,
  ctx: SendContext,
  user: Pick<MailUser, 'userId' | 'siteId'>,
  returnId: string,
): Promise<{ sendLoginScript: string; contactEmail: string; contactName: string; editProfileURL: string; returnURL: string }> {
  const host = listFirstColon(ctx.httpHost);
  let protocol = 'http://';
  let sendLoginScript = ctx.message;
  let urlBase: string;
  let contactEmail: string;
  let contactName: string;
  let editProfileURL: string;
  let stemSiteId: string;
  if (ctx.site !== null) {
    const { site } = ctx;
    urlBase = sanitizeUrlBase(`${host}${site.serverPort}${site.context}`);
    if (sendLoginScript === '') sendLoginScript = site.sendLoginScript;
    contactEmail = site.contact;
    contactName = site.site;
    if (site.extranetSSL || site.useSSL) protocol = 'https://';
    editProfileURL = site.editProfileURL.slice(0, 4).toLowerCase() === 'http' ? site.editProfileURL : `${protocol}${urlBase}${site.editProfileURL}`;
    stemSiteId = ctx.siteId;
  } else {
    const { global } = ctx;
    urlBase = sanitizeUrlBase(`${host}${global.serverPort}${global.context}`);
    contactEmail = global.adminEmail;
    contactName = global.title;
    if (global.adminSSL) protocol = 'https://';
    editProfileURL = `${protocol}${urlBase}${global.adminDir}/?muraAction=cEditProfile.edit`;
    stemSiteId = DEFAULT_SITE_ID;
  }
  const returnURL = `${protocol}${urlBase}${await settings.urlStem(stemSiteId, returnId)}?userID=${user.userId}`;
  if (!editProfileURL.includes('?')) editProfileURL += '?';
  if (ctx.siteId === '') editProfileURL += `&siteID=${user.siteId}`;
  editProfileURL += `&returnID=${returnId}&returnUserID=${user.userId}`;
  return { sendLoginScript, contactEmail, contactName, editProfileURL, returnURL };
}

/**
 * Writes one mail in the user's tenant transaction: the autoreset credential, the redirect that replaces the user's
 * earlier ones, and the outbox request [legacy: core/mura/user/userUtility.cfc:570-643,899-915].
 */
async function writeLoginMail(
  deps: LoginMailDeps,
  tx: TenantTx,
  mail: MailEnvelope,
  user: MailUser,
  storedPassword: string | null,
): Promise<LoginMailRequest> {
  const now = deps.clock.now();
  const returnId = cfUuid();
  const links = await loginLinks(deps.settings, mail.ctx, user, returnId);
  const text = renderLoginMailText({
    sendLoginScript: links.sendLoginScript,
    autoresetpasswords: mail.ctx.global.autoresetpasswords,
    firstName: user.fname,
    lastName: user.lname,
    username: user.username,
    password: user.password,
    contactEmail: links.contactEmail,
    contactName: links.contactName,
    returnURL: links.returnURL,
  });
  // Legacy's userBean.save() also rewrites the person's audit columns, which people owns; identity stores only the credential.
  if (storedPassword !== null) {
    await deps.repo.writeCredential(tx, user.userId, { password: storedPassword, passwordcreated: now });
  }
  await deps.repo.removePrevRedirects(tx, user.userId);
  // Inserted directly because the redirect id must equal the returnID the URLs already carry.
  const redirect: Omit<RedirectRow, 'tenant_id'> = {
    redirectid: returnId,
    url: links.editProfileURL,
    created: now,
    userid: user.userId,
    siteid: ormValue(user.siteId),
  };
  await deps.repo.insert(tx, REDIRECT.table, redirect);
  const payload: LoginMailRequestedPayload = {
    messageId: cfUuid(),
    userId: user.userId,
    returnId,
    siteId: mail.ctx.siteId,
    to: mail.to,
    from: mail.from,
    subject: mail.subject,
    text,
    bcc: mail.bcc,
    kind: mail.kind,
  };
  await deps.events.publishLoginMailRequested(tx, payload);
  return { userId: user.userId, tenantId: tx.tenantId, messageId: payload.messageId, returnId };
}

/** The registry entry of the request site, or of the default site for an unknown one, as `getSite` falls back. */
async function requestSiteEntry(db: TenantDb, siteId: string): Promise<TenantRegistryEntry | null> {
  const tenant = (await tenantForRegisteredSite(db, siteId)) ?? (await tenantForRegisteredSite(db, DEFAULT_SITE_ID));
  return tenant === null ? null : registryEntryForTenant(db, tenant);
}

/**
 * The tenants getUserByEmail searches and the pool predicate in each: with a site, its private pool at `isPublic=0`
 * and its public pool at `isPublic=1`; without one, `isPublic=0` in every registered tenant [legacy: core/mura/user/userUtility.cfc:390-409].
 */
async function poolScopes(db: TenantDb, siteId: string): Promise<PoolScope[]> {
  if (siteId === '') {
    const tenants = [...new Set((await registeredTenants(db)).map((entry) => entry.tenantId))];
    return tenants.map((tenantId) => ({ tenantId, admits: (account) => account.ispublic === 0 }));
  }
  const entry = await requestSiteEntry(db, siteId);
  if (entry === null) return [];
  const pools: Array<{ poolSiteId: string; tenantId: string; isPublic: 0 | 1 }> = [];
  if (entry.privateUserPoolId !== null && entry.privateUserPoolTenant !== null) {
    pools.push({ poolSiteId: entry.privateUserPoolId, tenantId: entry.privateUserPoolTenant, isPublic: 0 });
  }
  if (entry.publicUserPoolId !== null && entry.publicUserPoolTenant !== null) {
    pools.push({ poolSiteId: entry.publicUserPoolId, tenantId: entry.publicUserPoolTenant, isPublic: 1 });
  }
  const bySite = [...pools].sort((a, b) => compareText(charKey(a.poolSiteId), charKey(b.poolSiteId)));
  return [...new Set(bySite.map((pool) => pool.tenantId))].map((tenantId) => {
    const admitted = pools.filter((pool) => pool.tenantId === tenantId);
    return {
      tenantId,
      admits: (account) =>
        admitted.some((pool) => account.ispublic === pool.isPublic && account.siteid !== null && charKey(account.siteid) === charKey(pool.poolSiteId)),
    };
  });
}

/** The active `type=2`, `inactive=0` accounts of `scope` whose contact has `email`, by user id; only `userId` when given. */
async function emailMatches(repo: LoginMailDeps['repo'], tx: TenantTx, scope: PoolScope, email: string, userId?: string): Promise<EmailAccountRow[]> {
  return (await repo.findAccountsByEmail(tx, email, userId)).filter((account) => scope.admits(account));
}

/** sendLoginByEmail skips a user whose username is empty [legacy: core/mura/user/userUtility.cfc:428]. */
function hasUsername(account: Pick<UserAccountRow, 'username'>): boolean {
  return (account.username ?? '') !== '';
}

/**
 * Sends the login mail to every account getUserByEmail finds for the address; an address failing `EMAIL_PATTERN` or
 * matching no account sends nothing [legacy: core/mura/user/userUtility.cfc:411-451].
 * @returns one request per mailed user, in tenant site then user id order.
 */
export async function sendLoginByEmail(deps: LoginMailDeps, input: SendLoginByEmailInput): Promise<LoginMailRequest[]> {
  const email = javaTrim(input.email);
  if (!EMAIL_PATTERN.test(email)) return [];
  const candidates: Array<{ scope: PoolScope; userId: string }> = [];
  for (const scope of await poolScopes(deps.db, input.siteId)) {
    const matches = await withGatedTenant(deps.db, scope.tenantId, (tx) => emailMatches(deps.repo, tx, scope, email));
    candidates.push(...matches.filter(hasUsername).map((account) => ({ scope, userId: account.userid })));
  }
  if (candidates.length === 0) return [];
  const ctx = await sendContext(deps.settings, input);
  const from = senderName(ctx);
  // Legacy addresses the mail to the address as given, untrimmed.
  const mail: MailEnvelope = { ctx, to: input.email, from, subject: subjectFor(input.subject, from), bcc: ctx.global.sendLoginBcc, kind: 'forgot-password' };
  const requests: LoginMailRequest[] = [];
  for (const { scope, userId } of candidates) {
    await awaitAccountOpen(deps.db, scope.tenantId, userId, { sleep: deps.sleep });
    const credential = await resetCredential(deps, ctx.global);
    const request = await withGatedTenant(deps.db, scope.tenantId, async (tx) => {
      // Re-read after the wait, so an account operation that just finished is mailed with its outcome.
      const [account] = await emailMatches(deps.repo, tx, scope, email, userId);
      if (account === undefined || !hasUsername(account)) return null;
      const user: MailUser = {
        userId: account.userid,
        siteId: account.siteid ?? '',
        username: account.username ?? '',
        fname: account.fname ?? '',
        lname: account.lname ?? '',
        // userDAO.read never loads the stored password, so without a reset the placeholder is empty.
        password: credential?.plain ?? '',
      };
      return writeLoginMail(deps, tx, mail, user, credential?.stored ?? null);
    });
    if (request !== null) requests.push(request);
  }
  return requests;
}

/**
 * Sends the login mail of one user bean, with the site's public-registration notify list as bcc when `isPublicReg`
 * [legacy: core/mura/user/userUtility.cfc:453-488].
 */
export async function sendLoginByUser(deps: LoginMailDeps, input: SendLoginByUserInput): Promise<LoginMailRequest> {
  const { user } = input;
  const ctx = await sendContext(deps.settings, input);
  const tenantId = tenantIdForSite(user.siteId);
  await awaitAccountOpen(deps.db, tenantId, user.userId, { sleep: deps.sleep });
  const credential = await resetCredential(deps, ctx.global);
  let bcc = '';
  if (input.isPublicReg === true) {
    const notify = (ctx.site ?? (await deps.settings.site(DEFAULT_SITE_ID))).extranetPublicRegNotify;
    if (notify !== '') bcc = notify;
  }
  const from = senderName(ctx);
  const mail: MailEnvelope = { ctx, to: user.email, from, subject: subjectFor(input.subject, from), bcc, kind: 'send-login' };
  const mailUser: MailUser = {
    userId: user.userId,
    siteId: user.siteId,
    username: user.username,
    fname: user.fname,
    lname: user.lname,
    password: credential?.plain ?? user.password ?? '',
  };
  return withGatedTenant(deps.db, tenantId, (tx) => writeLoginMail(deps, tx, mail, mailUser, credential?.stored ?? null));
}
