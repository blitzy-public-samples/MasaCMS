// Admin shell entry point: layout choice of `admin/common/layouts/default.cfm`, shell data and document output (server-only).
import {
  cfDateAdd,
  cfIsDateText,
  cfListToArray,
  cfParseDateTimeText,
  cfToBoolean,
} from '@opt2/platform/legacy-compat';
import { isCompactDisplay } from '@/lib/cfml';
import type { CsrfRenderer } from '@/lib/csrf';
import { legacySettings } from '@/lib/env';
import { okBody, type GatewayClient } from '@/lib/gateway-client';
import { encodeJs, raw, type SafeHtml } from '@/lib/html';
import { tokenServesSite, type AdminRequest, type RequestContext } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { renderCompact } from './compact';
import { resolveModuleTitle } from './module-title';
import { renderTemplate } from './template';
import type {
  AdminDocument,
  ShellContext,
  ShellData,
  ShellHooks,
  ShellLayout,
  ShellSite,
  ShellUser,
  ShellView,
  UserPrompts,
} from './types';

export type {
  AdminDocument,
  LegacyServerInfo,
  SecondaryMenuCircuit,
  ShellContext,
  ShellData,
  ShellHooks,
  ShellLayout,
  ShellPlugin,
  ShellSite,
  ShellUser,
  ShellView,
  UserPrompts,
} from './types';
export { OPT2_NAV_MODULES } from './nav';

/** CSRF context of the nav's Update Core links (`nav.cfm` 331-335, 377-381). */
const UPDATE_CORE_CONTEXT = 'updatecore';

/** Module ids of the change-set prompt's `getModulePerm` checks (`header.cfm` 222-223). */
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';
const CHANGESETS_MODULE_ID = '00000000000000000000000000000000014';

/** The counts of a page whose header strategies-content cannot serve: none renders a prompt. */
const NO_PROMPTS: UserPrompts = Object.freeze({
  drafts: 0,
  submissions: 0,
  approvals: 0,
  expires: 0,
  pendingChangesets: 0,
});

const listFirst = (list: string, delimiter: string): string => cfListToArray(list, delimiter)[0] ?? '';
const listLast = (list: string, delimiter: string): string => cfListToArray(list, delimiter).at(-1) ?? '';

/** The layout legacy `default.cfm` includes: `compact` when {@link isCompactDisplay}, else `template`. */
export function selectLayout(rc: RequestContext): ShellLayout {
  return isCompactDisplay(rc.compactDisplay) ? 'compact' : 'template';
}

/** Services and request values {@link loadShellData} reads through. */
export interface ShellDataDeps {
  readonly gateway: GatewayClient;
  readonly csrf: CsrfRenderer;
  readonly rb: RbLookup;
  /** The request's clock; the current time when absent. */
  readonly now?: Date;
}

/**
 * userBean `getPasswordExpired()` as `currentUser().get('passwordExpired')` reads it, the value the session struct
 * cached first; false while passwords never expire, as the layout then never asks.
 */
function passwordExpired(ctx: AdminRequest, now: Date): boolean {
  const expireIn = legacySettings().expirePasswords;
  if (expireIn === 0 || !ctx.isLoggedIn) return false;
  const { mura } = ctx.session;
  const cached = Object.entries(mura).find(([key]) => key.toLowerCase() === 'passwordexpired')?.[1];
  if (cached !== undefined) return cfToBoolean(cached);
  const created = mura.passwordCreated ?? '';
  return !cfIsDateText(created) || cfDateAdd('d', expireIn, cfParseDateTimeText(created)) < now;
}

/** The current user as the header and alerts read it; empty for an anonymous session. */
function shellUser(ctx: AdminRequest, now: Date): ShellUser {
  const { mura } = ctx.session;
  return {
    fname: mura.fname ?? '',
    lname: mura.lname ?? '',
    passwordExpired: passwordExpired(ctx, now),
    hasDefaultPassword: ctx.session.hasDefaultPassword,
  };
}

/**
 * settingsManager `getUserSites(session.siteArray, isS2)` in site-name order, each with its settingsBean
 * `getValue('showDashboard', 0)`.
 * @throws GatewayDenialError When programs-sites refuses the site list (401 or 403).
 */
async function loadUserSites(gateway: GatewayClient): Promise<ShellSite[]> {
  const { sites } = okBody(await gateway.programsSites.userSites(), 'programs-sites', 'listUserSites');
  return sites.map((item) => ({ siteId: item.siteid, site: item.site ?? '', showDashboard: item.showDashboard === 1 }));
}

/** `renderCSRFTokens(context='updatecore', format='url')`, e.g. `&csrf_token=…&csrf_token_expires=…`. */
async function updateCoreCsrfQuery(csrf: CsrfRenderer): Promise<string> {
  await csrf.tokens(UPDATE_CORE_CONTEXT);
  return String(csrf.render(UPDATE_CORE_CONTEXT, 'url'));
}

/**
 * The session site's prompt counts of `header.cfm` 176-246; the change-set count only when the site has change sets
 * and the user holds the Change Sets and Site Manager modules.
 * @throws GatewayDenialError When strategies-content refuses the read (401 or 403).
 */
async function loadUserPrompts(ctx: AdminRequest, gateway: GatewayClient): Promise<UserPrompts> {
  const response = await gateway.strategiesContent.call('get', '/v1/sites/{siteid}/header-prompts', {
    params: { siteid: ctx.session.siteid },
  });
  const { drafts, submissions, approvals, expires, pendingChangesets } = okBody(
    response,
    'strategies-content',
    'getHeaderPrompts',
  );
  const changesets =
    ctx.site?.hasChangesets === true && ctx.modulePerm(CHANGESETS_MODULE_ID) && ctx.modulePerm(SITE_MANAGER_MODULE_ID);
  return { drafts, submissions, approvals, expires, pendingChangesets: changesets ? pendingChangesets : 0 };
}

/**
 * The data the shell renders beyond `ctx`; site list, prompt counts and Update Core tokens are loaded only when the
 * full layout shows its nav and header, the counts only for a session site the token serves. Gateway unavailability
 * propagates.
 * @throws GatewayDenialError When a service refuses a read (401 or 403).
 */
export async function loadShellData(ctx: AdminRequest, deps: ShellDataDeps): Promise<ShellData> {
  const now = deps.now ?? new Date();
  const chrome =
    selectLayout(ctx.rc) === 'template' && ctx.session.siteid !== '' && ctx.isLoggedIn && ctx.isPrivateUser;
  const [userSites, coreCsrfQuery, prompts] = await Promise.all([
    chrome ? loadUserSites(deps.gateway) : [],
    chrome && ctx.isS2 && legacySettings().allowAutoUpdates ? updateCoreCsrfQuery(deps.csrf) : '',
    chrome && ctx.user !== undefined && tokenServesSite(ctx.user, ctx.session.siteid)
      ? loadUserPrompts(ctx, deps.gateway)
      : NO_PROMPTS,
  ]);
  return {
    rb: deps.rb,
    user: shellUser(ctx, now),
    userSites,
    prompts,
    // Plugins run only on legacy; the target holds no plugin data.
    sitePlugins: [],
    // No target store holds the legacy server's runtime facts.
    server: null,
    updateCoreCsrfQuery: coreCsrfQuery,
    // Legacy checks the export directory on its own file system, which programs-sites does not report.
    exportLocationExists: false,
    now,
  };
}

/** The admin page legacy's layout renders around `view`, from data {@link loadShellData} loaded. */
export function renderAdminDocument(
  ctx: AdminRequest,
  view: ShellView,
  hooks: ShellHooks,
  data: ShellData,
): AdminDocument {
  const layout = selectLayout(ctx.rc);
  const qualifiedAction = listLast(ctx.action, ':');
  // Request-supplied `originalcircuit`/`originalfuseaction` are not read: the body id is emitted unencoded.
  const originalCircuit = view.originalCircuit ?? listFirst(qualifiedAction, '.');
  const originalFuseaction = view.originalFuseaction ?? listLast(qualifiedAction, '.');
  const { moduleTitle, bodyclass } = resolveModuleTitle({
    originalCircuit,
    originalFuseaction,
    moduleId: ctx.rc.moduleid ?? '',
    action: ctx.action,
    override: view.moduleTitle,
    bodyclass: view.bodyclass ?? ctx.rc.bodyclass ?? '',
  });
  // `cfparam rc.siteid default=session.siteID` applies only when rc holds no siteid; an empty one becomes `default`.
  const siteId = ctx.rc.siteid ?? ctx.session.siteid;
  const sc: ShellContext = {
    ctx,
    view,
    hooks,
    data,
    layout,
    originalCircuit,
    originalFuseaction,
    moduleTitle,
    bodyclass,
    siteId: siteId === '' ? 'default' : siteId,
  };
  return layout === 'compact' ? renderCompact(sc) : renderTemplate(sc);
}

/** ` name="value"` per record entry, in order; values are attribute text as the layouts recorded it. */
function attributeText(attrs: Readonly<Record<string, string>>): string {
  return Object.entries(attrs)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');
}

/** The complete page markup, as raw responses and validation re-renders send it. */
export function serializeAdminDocument(doc: AdminDocument): string {
  return (
    `${String(doc.preamble)}\n<head>\n${String(doc.head)}\n</head>\n` +
    `<body${attributeText(doc.bodyAttrs)}>\n${String(doc.body)}\n</body>\n</html>`
  );
}

/**
 * Inline script, placed first in `<body>`, that applies the document's `<html>` and `<body>` attributes where the page
 * layout cannot; body attribute text is parsed by the browser in an inert template, as the serialized page would be.
 */
export function attributeBootstrapScript(doc: AdminDocument): SafeHtml {
  const literal = (text: string): string => `"${encodeJs(text)}"`;
  const htmlSets = Object.entries(doc.htmlAttrs)
    .map(([name, value]) => `h.setAttribute(${literal(name)},${literal(value)});`)
    .join('');
  const bodyText = attributeText(doc.bodyAttrs);
  const bodySets =
    bodyText === ''
      ? ''
      : `var t=d.createElement("template");t.innerHTML=${literal(`<i${bodyText}></i>`)};` +
        'var a=t.content.firstChild.attributes;for(var i=0;i<a.length;i++)d.body.setAttribute(a[i].name,a[i].value);';
  return raw(`<script>(function(d){var h=d.documentElement;${htmlSets}${bodySets}})(document);</script>`);
}
