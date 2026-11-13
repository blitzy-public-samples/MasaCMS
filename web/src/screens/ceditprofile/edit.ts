// `cEditProfile.edit`: the controller's `before()` and `edit()` and the view `admin/core/views/ceditprofile/edit.cfm` (server-only).
import {
  LegacyServiceUnavailableError,
  cfEq,
  cfIsBoolean,
  cfListToArray,
  cfToBoolean,
  cfUuid,
} from '@opt2/platform/legacy-compat';
import type { components as PeopleComponents } from '@/generated/clients/people';
import type { GateDecision, ScreenGate } from '@/lib/access-gate';
import { legacySettings } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { encodeHtmlAttr, encodeJs, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import { ORIGINAL_URL_HEADER, tokenServesSite, type AdminRequest, type SiteData } from '@/lib/request-context';
import type { ShellView } from '@/shell/document';
import { displayErrors, editGroupHtmlHead } from '../cusers/editgroup';
import { renderUsersJs } from '../cusers/inc/js';
import type { PageScreen, ScreenContext } from '../registry';
import { renderProfileCategoriesNest, type ProfileInterestCategoryLoader } from './dsp_categories_nest';

// The markup is the view's bytes as ACF 2023 emits them, matched against legacy captures: CFML comments are dropped,
// and whitespace-only text between two CFML constructs prints one space, or nothing after output ending in whitespace.

/** people `getProfile`: the session user and the data of every Edit Profile tab. */
export type ProfileData = PeopleComponents['schemas']['ProfileData'];

type ProfileAddress = ProfileData['addresses'][number];

type SiteRecord = SiteData['record'];

// ---- Request context and gate ----

/** A value of the defaulted context: FW/1 text, or the `{}` that `param error` adds. */
export type EditProfileRcValue = string | Readonly<Record<string, string>>;

/** The request context after cEditProfile `before()`; names resolve case-insensitively and keep their first casing. */
export interface EditProfileRc {
  readonly [name: string]: EditProfileRcValue | undefined;
  readonly siteid: string;
  readonly routeid: string;
  readonly categoryID: string;
  readonly returnurl: string;
  /** `{}` unless the request carried an `error` field. */
  readonly error: EditProfileRcValue;
}

/** The `param` defaults of `before()`, in its order and casing; no view reads `rsGrouplist.recordcount`. */
const RC_DEFAULTS: ReadonlyArray<readonly [string, EditProfileRcValue]> = Object.freeze([
  ['Type', '0'],
  ['ContactForm', '0'],
  ['isPublic', '0'],
  ['email', ''],
  ['jobtitle', ''],
  ['lastupdate', ''],
  ['lastupdateby', ''],
  ['lastupdatebyid', '0'],
  ['groupname', ''],
  ['fname', ''],
  ['lname', ''],
  ['address', ''],
  ['city', ''],
  ['state', ''],
  ['zip', ''],
  ['phone1', ''],
  ['phone2', ''],
  ['fax', ''],
  ['perm', '0'],
  ['groupid', ''],
  ['routeid', ''],
  ['InActive', '0'],
  ['startrow', '1'],
  ['categoryID', ''],
  ['error', Object.freeze({})],
  ['returnurl', ''],
]);

/** `req.rc` with each `before()` default added where no key of its name, in any case, exists. */
export function editProfileRc(req: Pick<AdminRequest, 'rc'>): EditProfileRc {
  const entries = new Map<string, readonly [name: string, value: EditProfileRcValue]>();
  const param = (name: string, value: EditProfileRcValue): void => {
    const key = name.toLowerCase();
    if (!entries.has(key)) entries.set(key, [name, value]);
  };
  for (const [name, value] of Object.entries(req.rc)) param(name, value);
  for (const [name, value] of RC_DEFAULTS) param(name, value);
  const valueOf = (name: string | symbol): EditProfileRcValue | undefined =>
    typeof name === 'string' ? entries.get(name.toLowerCase())?.[1] : undefined;
  return new Proxy(Object.create(null) as Record<string, EditProfileRcValue>, {
    get: (_target, name) => valueOf(name),
    has: (_target, name) => valueOf(name) !== undefined,
    ownKeys: () => [...entries.values()].map(([name]) => name),
    getOwnPropertyDescriptor: (_target, name) => {
      const value = valueOf(name);
      return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  }) as unknown as EditProfileRc;
}

const ALLOW: GateDecision = Object.freeze({ kind: 'allow' });

/** cEditProfile `before()` gate: any logged-in user passes; an anonymous one gets the controller's `secure()`. */
export const ceditprofileGate: ScreenGate = (req, { secure }) => (req.isLoggedIn ? ALLOW : secure());

// ---- View data ----

/** A site of the extra Interests tree: `getSites()` entry id and its `getSite()` name. */
export interface ProfilePoolSite {
  readonly siteId: string;
  readonly name: string;
}

/** Reads the view needs that no owner contract serves yet; a caller binds each once its operation exists. */
export interface EditProfileSources {
  /** `categoryManager.getPrivateInterestGroups(siteId, parentId)`, one tree level. */
  readonly interestRows?: ProfileInterestCategoryLoader;
  /** The `getSites()` entries, in iteration order, whose private user pool is `poolId` (matched ignoring case). */
  readonly privatePoolSites?: (poolId: string) => Promise<readonly ProfilePoolSite[]>;
}

// strategies-content serves no interest-group read and programs-sites no site list with pools, so the registered
// screen binds neither; buildEditProfileView renders what legacy shows without them and fails closed otherwise.
/** The sources of the registered screen. */
export const PROFILE_SOURCES: EditProfileSources = Object.freeze({});

/** `getSite()` settings the subtype select and the extended-attribute loader print. */
export interface ProfileSiteSettings {
  readonly publicUserPoolID: string;
  readonly privateUserPoolID: string;
  /** `getThemeAssetPath()`. */
  readonly themeAssetPath: string;
}

/** `settingsManager.getSite(<user's site>)` as the view reads it. */
export interface ProfileSiteFacts {
  readonly siteId: string;
  /** `getSite()`: the site name. */
  readonly name: string;
  /** Present whenever the user's site has an active user subtype, the only case that prints them. */
  readonly settings?: ProfileSiteSettings;
}

/** Everything the edit view reads. */
export interface EditProfileView {
  /** `rc.userBean`: the stored user, or a failed save's retained values and errors. */
  readonly profile: ProfileData;
  readonly rc: EditProfileRc;
  /** `rc.routeid`, or `editprofile` when empty. */
  readonly routeId: string;
  readonly userSite: ProfileSiteFacts;
  /** The site of the Interests tree added for `rc.siteid`'s private user pool; absent when none is added. */
  readonly poolSite?: ProfilePoolSite;
  /** `session.mura.userID`. */
  readonly sessionUserId: string;
  /** `cgi.query_string`. */
  readonly queryString: string;
  /** `isBoolean($.globalConfig('strongpasswords')) and $.globalConfig('strongpasswords')`. */
  readonly strongPasswords: boolean;
  readonly interestRows: ProfileInterestCategoryLoader;
}

/** Site ids as `settingsManager.getSite` and `listFindNoCase` compare them: ignoring case. */
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A record value as CFML prints it; SQL NULL and absent read as `''`. */
const text = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? '' : String(value);

const unserved = (what: string, reason: string): LegacyServiceUnavailableError =>
  new LegacyServiceUnavailableError(`cEditProfile.edit needs ${what}, which no owner contract serves`, 'admin', reason);

/** An interest-group level of a pool without interest groups. */
const NO_INTEREST_ROWS: ProfileInterestCategoryLoader = () => Promise.resolve([]);

/** `cgi.query_string`: the forwarded request target's query, byte for byte, else the pairs of `rc.currentURL`. */
function cgiQueryString(req: Pick<AdminRequest, 'headers' | 'currentUrl'>): string {
  const target = req.headers.get(ORIGINAL_URL_HEADER);
  if (target === null) return req.currentUrl.replace(/^\.\/\??&?/, '');
  const queryAt = target.indexOf('?');
  return queryAt < 0 ? '' : target.slice(queryAt + 1);
}

/** configBean `strongpasswords`: `MURA_STRONGPASSWORDS`, else the settings template's `false`, tested as CFML does. */
function strongPasswordsOn(): boolean {
  const value = process.env['MURA_STRONGPASSWORDS'] ?? 'false';
  return cfIsBoolean(value) && cfToBoolean(value);
}

const on = (value: number | null | undefined): boolean => (value ?? 0) !== 0;

// Mirrors cusers/editgroup.ts: web cannot read the legacy web root, so the theme is taken to be under
// `<webroot>/themes`, as the shell prints `themepath`.
/** `getThemeAssetPath()` of `record`: `getResourcePath(complete=0)` followed by `/themes/<theme>`. */
function themeAssetPath(record: SiteRecord, https: boolean): string {
  const { context, serverPort } = legacySettings();
  const remote = on(record.isremote);
  const resourceDomain = record.resourceDomain ?? '';
  if (remote && resourceDomain !== '') {
    const useSSL = record.useSSL === null || record.useSSL === undefined ? on(record.ExtranetSSL) : on(record.useSSL);
    const scheme = on(record.resourceSSL) || useSSL || https ? 'https' : 'http';
    return `${scheme}://${resourceDomain}${serverPort}${context}/themes/${record.theme ?? ''}`;
  }
  return `${remote ? (record.remotecontext ?? '') : context}/themes/${record.theme ?? ''}`;
}

/**
 * The settings programs-sites serves for `siteId`: the request's site, else a read the token admits; undefined when
 * neither serves it, as for a site other than the token's.
 * @throws GatewayDenialError When programs-sites refuses the read (401 or 403).
 */
async function siteRecordOf(ctx: ScreenContext, siteId: string): Promise<SiteRecord | undefined> {
  const { site, user } = ctx.req;
  if (site !== undefined && sameId(site.siteid, siteId)) return site.record;
  if (user === undefined || !tokenServesSite(user, siteId)) return undefined;
  const served = okBody(await ctx.gateway.programsSites.getShellSite(siteId), 'programs-sites', 'getShellSite');
  // An unknown id is the defaulted new site, where legacy getSite falls back to `default`.
  return served.isNew === 1 ? undefined : served.site;
}

/**
 * The user's site as the view prints it; the name falls back to identity's site list when programs-sites serves no
 * settings for the site, which is enough when no subtype prints them.
 */
function userSiteFacts(
  ctx: ScreenContext,
  siteId: string,
  record: SiteRecord | undefined,
  needsSettings: boolean,
): ProfileSiteFacts {
  if (record !== undefined) {
    const settings: ProfileSiteSettings = {
      publicUserPoolID: record.publicUserPoolID ?? record.SiteID,
      privateUserPoolID: record.privateUserPoolID ?? record.SiteID,
      themeAssetPath: themeAssetPath(record, ctx.req.https),
    };
    return { siteId, name: text(record.Site), settings };
  }
  const listed = ctx.req.adminSites.find((entry) => sameId(entry.siteID, siteId));
  if (needsSettings || listed === undefined) throw unserved(`the settings of the user's site ${siteId}`, 'profile-site');
  return { siteId, name: listed.site };
}

/**
 * The first site sharing `rc.siteid`'s private user pool, which edit.cfm 267-274 adds a tree for unless that pool is
 * the user's own site.
 */
async function poolSiteOf(
  poolId: string,
  userSiteId: string,
  sources: EditProfileSources,
): Promise<ProfilePoolSite | undefined> {
  if (sameId(poolId, userSiteId)) return undefined;
  if (sources.privatePoolSites === undefined) throw unserved(`the sites of private user pool ${poolId}`, 'profile-pool-sites');
  return (await sources.privatePoolSites(poolId))[0];
}

/**
 * The view of `profile` for a request whose `rc.siteid` is `rcSiteId`.
 * @throws LegacyServiceUnavailableError When the view needs site settings, pool sites or interest groups no source serves.
 * @throws GatewayDenialError When programs-sites refuses a site read (401 or 403).
 */
export async function buildEditProfileView(
  ctx: ScreenContext,
  profile: ProfileData,
  opts: { readonly rcSiteId: string; readonly rc: EditProfileRc; readonly sources?: EditProfileSources },
): Promise<EditProfileView> {
  const { rcSiteId, rc, sources = PROFILE_SOURCES } = opts;
  const userSiteId = profile.user.SiteID;
  const userRecord = await siteRecordOf(ctx, userSiteId);
  const userSite = userSiteFacts(ctx, userSiteId, userRecord, profile.subTypes.length > 0);
  const rcRecord = sameId(rcSiteId, userSiteId) ? userRecord : await siteRecordOf(ctx, rcSiteId);
  if (rcRecord === undefined) throw unserved(`the private user pool of site ${rcSiteId}`, 'profile-site');
  const poolSite = await poolSiteOf(rcRecord.privateUserPoolID ?? rcRecord.SiteID, userSiteId, sources);
  // Without an interest-group read the tree shows the empty pool; a form naming interests would then post none, and
  // saving it clears them (before() defaults categoryID to ''), so that case fails closed instead.
  const namesInterests = profile.categoryIds.length > 0 || rc.categoryID !== '';
  if (sources.interestRows === undefined && namesInterests) throw unserved('the interest groups', 'profile-interests');
  return {
    profile,
    rc,
    routeId: rc.routeid === '' ? 'editprofile' : rc.routeid,
    userSite,
    ...(poolSite === undefined ? {} : { poolSite }),
    sessionUserId: ctx.req.session.mura.userID,
    queryString: cgiQueryString(ctx.req),
    strongPasswords: strongPasswordsOn(),
    interestRows: sources.interestRows ?? NO_INTEREST_ROWS,
  };
}

/**
 * `edit()`: the session user as people reads it from the token, then the view data for `rc.siteid`.
 * @throws GatewayDenialError When people or programs-sites refuses a read (401 or 403).
 */
export async function loadEditProfileView(
  ctx: ScreenContext,
  sources: EditProfileSources = PROFILE_SOURCES,
): Promise<EditProfileView> {
  const rc = editProfileRc(ctx.req);
  const profile = okBody(await ctx.gateway.people.call('get', '/v1/profile'), 'people', 'getProfile');
  return buildEditProfileView(ctx, profile, { rcSiteId: rc.siteid, rc, sources });
}

// ---- Markup ----

/** CFML output of a run of constructs; `gap` is a whitespace-only static text between two of them. */
function cfmlRun(afterWhitespace: boolean): { write(markup: string): void; gap(): void; readonly out: () => string } {
  let out = '';
  const endsInWhitespace = (): boolean => (out === '' ? afterWhitespace : out.charCodeAt(out.length - 1) <= 0x20);
  return {
    write: (markup) => {
      out += markup;
    },
    gap: () => {
      if (!endsInWhitespace()) out += ' ';
    },
    out: () => out,
  };
}

/** What the markup reads besides the view: labels, the context path and the user bean's printed values. */
interface ViewParts {
  readonly view: EditProfileView;
  /** `rbKey(key)`, unencoded as the view writes it. */
  readonly label: (key: string) => string;
  readonly context: string;
  /** `rc.userBean.get<name>()` by bootstrap column name. */
  readonly bean: (column: keyof ProfileData['user']) => string;
}

/** The pane opener shared by every tab: bordered block, header with `label`, then the content block. */
const paneOpen = (label: string): SafeHtml => html`\t\t\t\t\t\t<div class="block block-bordered">
\t\t\t\t\t\t\t<!-- block header -->
\t\t\t\t\t\t\t<div class="block-header">
\t\t\t\t\t\t\t\t<h3 class="block-title">${raw(label)}</h3>
\t\t\t\t\t\t\t</div> <!-- /.block header -->
\t\t\t\t\t\t\t<div class="block-content">`;

const PANE_CLOSE = raw(`\t\t\t\t\t\t\t</div> <!-- /.block-content -->
\t\t\t\t\t\t</div> <!-- /.block-bordered -->
\t\t\t\t\t</div> <!-- /.tab-pane -->
\t\t\t\t\t<!-- /end tab -->`);

/** `rsNonDefault`: the subtypes the query of queries keeps by its case-sensitive `subType <> 'Default'`. */
const nonDefaultSubTypes = (view: EditProfileView): readonly string[] =>
  view.profile.subTypes.map(({ subType }) => subType).filter((subType) => subType !== 'Default');

/** The tab ids and labels: Extended Attributes only when the user's site has an active user subtype. */
function renderTabs({ view, label }: ViewParts): SafeHtml {
  const hasSubTypes = view.profile.subTypes.length > 0;
  const ids = ['tabBasic', 'tabAddressinformation', 'tabInterests', ...(hasSubTypes ? ['tabExtendedattributes'] : []), 'tabAdvanced'];
  const keys = ['user.basic', 'user.addressinformation', 'user.interests', ...(hasSubTypes ? ['user.extendedattributes'] : []), 'user.advanced'];
  // The view keeps the labels in a comma list and reads them back with listGetAt.
  const labels = cfListToArray(keys.map(label).join(','));
  return html`${ids.map((id, index) => {
    const tabLabel = labels[index];
    if (tabLabel === undefined) throw new RangeError(`listGetAt: no tab label at position ${index + 1}`);
    return html`\n\t<li${raw(index === 0 ? ' class="active"' : '')}><a href="#${raw(id)}" onclick="return false;"><span>${raw(tabLabel)}</span></a></li>\n\t`;
  })}`;
}

/** The required-fields note and the subtype select, or the hidden `Default` subtype when no other subtype is active. */
function renderSubTypeField({ view, label, context, bean }: ViewParts): SafeHtml {
  const options = nonDefaultSubTypes(view);
  if (options.length === 0) {
    return html`\n\t\t\t\t\t\t\t\t\t<input type="hidden" name="subtype" value="Default"/>
\t\t\t\t\t\t\t\t\t<div class="help-block-inline">${raw(label('user.requiredtext'))}</div>\n\t\t\t\t\t\t\t\t`;
  }
  const { settings } = view.userSite;
  if (settings === undefined) throw new TypeError("The subtype select needs the user's site settings");
  const subType = bean('subType');
  const selected = (value: string): SafeHtml => raw(cfEq(subType, value) ? 'selected' : '');
  // Subtype names and the call arguments are written unencoded, as legacy writes them.
  const choices = options.map(
    (option) => html`\n\t\t\t\t\t\t\t\t\t\t\t<option value="${raw(option)}" ${selected(option)}>${raw(option)}</option>\n\t\t\t\t\t\t\t\t\t\t`,
  );
  return html`\n\t\t\t\t\t\t\t\t<div class="help-block-inline">${raw(label('user.requiredtext'))}</div>
\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t      \t\t<label>${raw(label('user.type'))}</label>
\t\t\t\t\t\t\t     \t <select name="subtype"  onchange="resetExtendedAttributes('${raw(bean('UserID'))}','2',this.value,'${raw(settings.publicUserPoolID)}','${raw(context)}','${raw(settings.themeAssetPath)}');">
\t\t\t\t\t\t\t\t\t\t<option value="Default" ${selected('Default')}> ${raw(label('user.default'))}</option>
\t\t\t\t\t\t\t\t\t\t${choices}
\t\t\t\t\t\t\t\t\t</select>
\t\t\t\t\t\t    \t</div>

\t\t\t\t\t\t\t\t`;
}

/** The profile image link, its medium rendition and the remove box, when the user has a photo. */
function renderPhoto({ label, context, bean }: ViewParts): SafeHtml {
  const photoFileId = bean('photoFileID');
  if (photoFileId === '') return raw('');
  // The label follows the static `"> `, so an empty label leaves the output ending in whitespace.
  const run = cfmlRun(true);
  run.write(label('user.delete'));
  run.gap();
  return html`
\t\t\t\t\t\t\t        \t<a href="./index.cfm?muraAction=cArch.imagedetails&userid=${raw(bean('UserID'))}&siteid=${raw(bean('SiteID'))}&fileid=${raw(photoFileId)}"><img id="assocImage" src="${raw(context)}/index.cfm/_api/render/medium/?fileid=${raw(photoFileId)}&cacheID=${raw(cfUuid())}" /></a>

\t\t\t\t\t\t\t        \t<input type="checkbox" name="removePhotoFile" value="true"> ${raw(run.out())}`;
}

/** The Basic pane: subtype, name, contact and login fields, the password help and the profile image. */
function renderBasicPane(parts: ViewParts): SafeHtml {
  const { view, label, bean } = parts;
  const attr = (column: keyof ProfileData['user']): SafeHtml => raw(encodeHtmlAttr(bean(column)));
  const strongHelp = view.strongPasswords
    ? html`\n\t\t\t\t\t\t\t\t\t<div class="help-block-inline">${raw(label('user.passwordstrengthhelptext'))}</div>\n\t\t\t\t\t\t\t\t`
    : '';
  return html`\t\t\t\t\t<div id="tabBasic" class="tab-pane active">
${paneOpen(label('user.basic'))}

\t\t\t\t\t\t\t\t${renderSubTypeField(parts)}

\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t     \t\t<label>${raw(label('user.fname'))}*</label>
\t\t\t\t\t\t\t\t    <input id="fname" name="fname" type="text" value="${attr('Fname')}" required="true" message="${raw(label('user.fnamerequired'))}"/>
\t\t\t\t\t\t    </div>

\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t      \t<label>${raw(label('user.lname'))}*</label>
\t\t\t\t\t\t      \t<input id="lname" name="lname" type="text" value="${attr('Lname')}" required="true" message="${raw(label('user.lnamerequired'))}"/>
\t\t\t\t\t\t    </div>

\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t      \t<label>${raw(label('user.company'))}</label>
\t\t\t\t\t\t\t      \t<input id="organization" name="company" type="text" value="${attr('Company')}" />
\t\t\t\t\t\t\t\t</div>

\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t      <label>${raw(label('user.jobtitle'))}</label>
\t\t\t\t\t\t\t      <input id="jobtitle" name="jobtitle" type="text" value="${attr('JobTitle')}" />
\t\t\t\t\t\t\t\t</div>

\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t      <label>${raw(label('user.email'))}*</label>
\t\t\t\t\t\t\t      <input id="email" name="email" type="text" validate="email" message="${raw(label('user.emailvalidate'))}" value="${attr('Email')}"/>
\t\t\t\t\t\t\t\t</div>

\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t      \t<label>${raw(label('user.mobilephone'))}</label>
\t\t\t\t\t\t\t      \t<input id="mobilePhone" name="mobilePhone" type="text" value="${attr('mobilePhone')}"/>
\t\t\t\t\t\t\t\t</div>

\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t      \t\t<label>${raw(label('user.username'))}**</label>
\t\t\t\t\t\t      \t\t<input id="username" name="usernameNoCache" type="text" value="${attr('UserName')}" message="${raw(label('user.usernamerequired'))}" />
\t\t\t\t\t\t    </div>

\t\t\t\t\t\t\t\t${strongHelp}

\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t      \t<label>${raw(label('user.newpassword'))}**</label>
\t\t\t\t\t\t\t      \t<input name="passwordNoCache"  autocomplete="off" validate="match" matchfield="password2" type="password" value=""  message="${raw(label('user.passwordmatchvalidate'))}" autocomplete="off"/>
\t\t\t\t\t\t    </div>

\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t      \t<label>${raw(label('user.newpasswordconfirm'))}**</label>
\t\t\t\t\t\t\t      \t<input name="password2" autocomplete="off" type="password" value="" message="${raw(label('user.passwordconfirmvalidate'))}" autocomplete="off"/>
\t\t\t\t\t\t    </div>


\t\t\t\t\t\t    <div class="mura-control-group">
\t\t\t\t\t\t      \t<label>${raw(label('user.image'))}</label>
\t\t\t\t\t\t      \t<input type="file" name="newFile" validate="regex" regex="(.+)(\\.)(jpg|JPG|jpeg|JPEG|png|PNG)" message="Your logo must be a .JPG" value=""/>
\t\t\t\t\t\t        ${renderPhoto(parts)}
\t\t\t\t\t\t    </div>

\t\t\t\t\t\t\t<span id="extendSetsBasic"></span>
${PANE_CLOSE}`;
}

/** The `var-width` cell of one address: each non-empty part, unencoded, with the gaps ACF writes between its blocks. */
function addressCell(address: ProfileAddress, label: (key: string) => string): string {
  const name = text(address.addressName);
  const address1 = text(address.address1);
  const address2 = text(address.address2);
  const city = text(address.city);
  const state = text(address.state);
  const zip = text(address.zip);
  const phone = text(address.phone);
  const fax = text(address.fax);
  const url = text(address.addressURL);
  const email = text(address.addressEmail);
  // The cell's static text ends in whitespace before the first block.
  const run = cfmlRun(true);
  if (name !== '') run.write(`<strong>${name}</strong><br/>`);
  run.gap();
  if (address1 !== '') run.write(`${address1}<br/>`);
  run.gap();
  if (address2 !== '') run.write(`${address2}<br/>`);
  run.gap();
  if (city !== '') {
    run.write(city);
    run.gap();
  }
  if (state !== '') {
    if (city !== '') run.write(',');
    run.gap();
    run.write(state);
    run.gap();
  }
  if (zip !== '') {
    run.gap();
    run.write(zip);
  }
  if (city !== '' || state !== '' || zip !== '') run.write('<br/>');
  run.gap();
  if (phone !== '') run.write(`${label('user.phone')}: ${phone}<br/>`);
  run.gap();
  if (fax !== '') run.write(`${label('user.fax')}: ${fax}<br/>`);
  run.gap();
  if (url !== '') run.write(`${label('user.website')}: <a href="${url}" target="_blank">${url}</a><br/>`);
  run.gap();
  if (email !== '') run.write(`${label('user.email')}: <a href="mailto:${email}">${email}</a>`);
  return run.out();
}

/** The Address Information pane: the add link, then the address grid or the empty note, in people's order. */
function renderAddressPane({ view, label, bean }: ViewParts): SafeHtml {
  const { addresses } = view.profile;
  // Ids are written unencoded, as legacy writes them; the route id and the return query are URL-encoded.
  const owner = `userID=${view.sessionUserId}&siteid=${bean('SiteID')}&routeID=${encodeUrl(view.routeId)}`;
  const returnUrl = `returnURL=${encodeUrl(view.queryString)}`;
  const editHref = (addressId: string): SafeHtml =>
    raw(`./?muraAction=cusers.editAddress&${owner}&addressID=${addressId}&${returnUrl}`);
  const row = (address: ProfileAddress): SafeHtml => {
    const addressId = address.addressID;
    const primary = cfEq(text(address.isPrimary), '1');
    const remove = primary
      ? raw('<i class="mi-trash"></i>')
      : html`<li class="delete"><a title="Delete" href="./?muraAction=cusers.updateAddress&${raw(`userID=${view.sessionUserId}`)}&action=delete&${raw(`siteid=${bean('SiteID')}&routeID=${encodeUrl(view.routeId)}`)}&addressID=${raw(addressId)}&${raw(returnUrl)}" onclick="return confirmDialog('${raw(encodeJs(label('user.deleteaddressconfirm')))}',this.href);"><i class="mi-trash"></i></a></li>`;
    return html`\n\t\t\t\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t\t\t\t<td>
\t\t\t\t\t\t\t\t\t\t<input type="radio" name="primaryAddressID" value="${raw(addressId)}" ${raw(primary || addresses.length === 1 ? 'checked' : '')}>
\t\t\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t\t\t\t<td class="var-width">
\t\t\t\t\t\t\t\t\t\t${raw(addressCell(address, label))}
\t\t\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t\t\t\t<td nowrap class="actions"><ul><li class="edit"><a title="${raw(label('user.edit'))}" href="${editHref(addressId)}"><i class="mi-pencil"></i></a></li>
\t\t\t\t\t\t\t\t\t\t${remove}</ul></td>
\t\t\t\t\t\t\t\t\t</tr>\n\t\t\t\t\t\t\t\t\t`;
  };
  const list =
    addresses.length === 0
      ? html`\n\t\t\t\t\t\t\t\t\t<div class="help-block-empty">${raw(label('user.noaddressinformation'))}</div>\n\t\t\t\t\t\t\t\t\t`
      : html`\n\t\t\t\t\t\t\t\t\t<table class="table table-striped table-condensed table-bordered mura-table-grid">
\t\t\t\t\t\t\t\t\t<tr><th>${raw(label('user.primary'))}</th><th>${raw(label('user.address'))}</th><th class="adminstration"></th></tr>
\t\t\t\t\t\t\t\t\t${addresses.map(row)}
\t\t\t\t\t\t\t\t\t</table>\n\t\t\t\t\t\t\t\t\t`;
  return html`\t\t\t\t\t<div id="tabAddressinformation" class="tab-pane">
${paneOpen(label('user.addressinformation'))}

\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t\t\t<ul class="navTask nav nav-pills"><li><a href="${editHref('')}">${raw(label('user.addnewaddress'))}</a></li></ul>

\t\t\t\t\t\t\t      ${list}
\t\t\t\t\t\t\t    </div>

${PANE_CLOSE}`;
}

/** The Interests pane: the user's site tree, then the tree of the site sharing `rc.siteid`'s private pool, if any. */
async function renderInterestsPane(ctx: ScreenContext, { view, label }: ViewParts): Promise<SafeHtml> {
  const tree = (siteId: string): Promise<SafeHtml> =>
    renderProfileCategoriesNest(ctx, {
      siteId,
      parentId: '',
      categoryId: view.rc.categoryID,
      nestLevel: 0,
      userCategoryIds: view.profile.categoryIds.join(','),
      loadRows: view.interestRows,
    });
  const { poolSite } = view;
  const run = cfmlRun(false);
  // Site names are written unencoded, as legacy writes them.
  run.write(`<label>${view.userSite.name}</label>`);
  run.gap();
  run.write((await tree(view.userSite.siteId)).value);
  run.gap();
  if (poolSite !== undefined) {
    run.gap();
    run.write(`<label>${poolSite.name}</label>`);
    run.gap();
    run.write((await tree(poolSite.siteId)).value);
    run.gap();
  }
  return html`\t\t\t\t\t<div id="tabInterests" class="tab-pane">

${paneOpen(label('user.interests'))}

\t\t\t\t\t\t\t<div id="mura-list-tree" class="mura-control-group">
\t\t\t\t\t\t\t\t${raw(run.out())}
\t\t\t\t\t    \t</div>

${PANE_CLOSE}`;
}

/** The Extended Attributes pane and its loader call, when the user's site has an active user subtype. */
function renderExtendedPane({ view, label, context, bean }: ViewParts): SafeHtml {
  if (view.profile.subTypes.length === 0) return raw('');
  const { settings } = view.userSite;
  if (settings === undefined) throw new TypeError("The extended attribute loader needs the user's site settings");
  // The call arguments are written unencoded, as legacy writes them.
  const args = [bean('UserID'), bean('Type'), bean('subType'), settings.privateUserPoolID, context, settings.themeAssetPath];
  return html`
\t\t\t\t\t<div id="tabExtendedattributes" class="tab-pane">
${paneOpen(label('user.extendedattributes'))}
\t\t\t\t\t\t\t\t<span id="extendSetsDefault"></span>
\t\t\t\t\t\t\t\t<script type="text/javascript">
\t\t\t\t\t\t\t\tuserManager.loadExtendedAttributes(${raw(args.map((arg) => `'${arg}'`).join(','))});
\t\t\t\t\t\t\t\t</script>

${PANE_CLOSE}
\t\t\t\t\t`;
}

/** The Advanced pane: the email broadcaster radios, checked by CFML `eq`, and the tags field. */
function renderAdvancedPane({ label, bean }: ViewParts): SafeHtml {
  const subscribe = bean('Subscribe');
  const checked = (value: string): SafeHtml => raw(cfEq(subscribe, value) ? 'Checked' : '');
  return html`\t\t\t\t\t<div id="tabAdvanced" class="tab-pane">
${paneOpen(label('user.advanced'))}

\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t\t\t<label>${raw(label('user.emailbroadcaster'))}</label>
\t\t\t\t\t\t\t\t\t\t<label class="radio inline">
\t\t\t\t\t\t\t\t\t\t<input name="subscribe" type="radio" class="radio" value="1"${checked('1')}>
\t\t\t\t\t\t\t\t\t\t${raw(label('user.yes'))}
\t\t\t\t\t\t\t\t\t\t</label>
\t\t\t\t\t\t\t\t\t\t<label class="radio inline">
\t\t\t\t\t\t\t\t\t\t<input name="subscribe" type="radio" class="radio" value="0"${checked('0')}>${raw(label('user.no'))}
\t\t\t\t\t\t\t\t\t\t</label>
\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t\t\t\t\t<label>${raw(label('user.tags'))}</label>
\t\t\t\t\t\t\t\t\t\t<input id="tags" name="tags" type="text" value="${raw(encodeHtmlAttr(bean('tags')))}">
\t\t\t\t\t\t\t\t</div>
${PANE_CLOSE}`;
}

/** A user bean getter: the record value by column name as CFML prints it. */
function beanOf(user: ProfileData['user']): ViewParts['bean'] {
  return (column) => {
    const value: unknown = user[column];
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number') return text(value);
    throw new TypeError(`userBean.${String(column)} is not a simple value`);
  };
}

/** The view body inside `#mura-content`, `request.ajax` from cusers `inc/js.cfm`, and the two `cfhtmlhead` texts. */
export async function renderEditProfile(ctx: ScreenContext, view: EditProfileView): Promise<ShellView> {
  await ctx.csrf.prefetch(['']);
  const parts: ViewParts = {
    view,
    label: (key) => ctx.rb.rbKey(key),
    context: legacySettings().context,
    bean: beanOf(view.profile.user),
  };
  const { label, bean } = parts;
  const { errors } = view.profile;
  const alert =
    Object.keys(errors).length === 0
      ? ''
      : html`\n\t<div class="alert alert-error"><span>${displayErrors(errors)}</span></div>\n`;
  const tokens = cfmlRun(true);
  tokens.write(ctx.csrf.render('', 'form').value);
  tokens.gap();
  const body = html`
<div class="mura-header">
\t<h1>${raw(label('user.editprofile'))}</h1>
</div> <!-- /.mura-header -->

${alert}

<form novalidate="novalidate" action="./?muraAction=cEditProfile.update" method="post" enctype="multipart/form-data" name="form1" class="columns" onsubmit="return userManager.submitForm(this);">

<div class="block block-constrain">

\t<ul class="mura-tabs nav-tabs" data-toggle="tabs">
\t${renderTabs(parts)}
\t</ul> <!-- /.mura-tabs -->


\t\t  <div class="block-content tab-content">

${renderBasicPane(parts)}

${renderAddressPane(parts)}

${await renderInterestsPane(ctx, parts)}

\t\t\t\t\t${renderExtendedPane(parts)}

${renderAdvancedPane(parts)}

\t\t\t\t</div> <!-- /.block-content.tab-content -->

\t<div class="mura-actions">
\t\t<div class="form-actions">
\t\t\t<button type="button" class="btn mura-primary" onclick="userManager.submitForm(document.forms.form1,'update');"><i class="mi-check-circle"></i>${raw(label('user.update'))}</button>
\t\t</div>
\t</div>

</div> <!-- /.block-constrain -->

\t\t<input type="hidden" name="type" value="2">
\t\t<input type="hidden" name="action" value="">
\t\t<input type="hidden" name="contact" value="0">
\t\t<input type="hidden" name="userid" value="${raw(bean('UserID'))}">
\t\t<input type="hidden" name="siteid" value="${raw(bean('SiteID'))}">
\t\t${raw(tokens.out())}
</form>
`;
  return { body, ajax: renderUsersJs(ctx), htmlHead: editGroupHtmlHead(ctx) };
}

/** `cEditProfile.edit`, owned by identity, behind the cEditProfile `before()` gate. */
export const editProfileScreen: PageScreen<EditProfileView> = Object.freeze({
  circuit: 'ceditprofile',
  action: 'edit',
  owner: 'identity',
  mode: 'page',
  gate: ceditprofileGate,
  load: (ctx: ScreenContext) => loadEditProfileView(ctx),
  render: renderEditProfile,
});
