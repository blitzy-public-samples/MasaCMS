// Admin alerts and Masa notices of the full layout (`template.cfm` 260-311), emitted inside `div.content`.
import { cfEq, cfToBoolean } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { html, join, raw, type SafeHtml } from '@/lib/html';
import type { AdminAlert } from '@/lib/request-context';
import type { ShellContext } from './types';

type SiteAlerts = Readonly<Record<string, AdminAlert>>;

const LOGIN_ACTION = 'core:cLogin.main';

/** Ids the session-alert loop leaves to the notices (`listFindNoCase`). */
const LOOP_SKIPPED: ReadonlySet<string> = new Set(['defaultpasswordnotice', 'cachenotice']);

const NO_ALERTS: SiteAlerts = {};

/** The key a CFML struct lookup of `name` finds in `record`: the exact key, else the first case-insensitive match. */
function structKey(record: Readonly<Record<string, unknown>>, name: string): string | undefined {
  if (Object.hasOwn(record, name)) return name;
  const lower = name.toLowerCase();
  return Object.keys(record).find((key) => key.toLowerCase() === lower);
}

/** One session alert: `type` HTML-encoded (`error` when empty), id and text unencoded, the text after the span. */
function sessionAlert(id: string, alert: AdminAlert): SafeHtml {
  return html`<div class="alert alert-${alert.type === '' ? 'error' : alert.type}">
	<span>
		<a data-alertid="${raw(id)}" class="close alert-dismiss" data-dismiss="alert"><i class="mi-close"></i></a>
	</span>
	${raw(alert.text)}
</div>
`;
}

/** One Masa notice: the unencoded label inside the span. */
function notice(level: 'error' | 'warning', id: string, label: string): SafeHtml {
  return html`<div class="alert alert-${level}">
	<span>
		<a data-alertid="${id}" class="close alert-dismiss" data-dismiss="alert"><i class="mi-close"></i></a>
			${raw(label)}
	</span>
</div>
`;
}

/** `rc.renderMuraAlerts` as `<cfif>` reads it; the global setting when the request does not carry it. */
function renderMuraAlerts(sc: ShellContext): boolean {
  const requested = sc.ctx.rc.renderMuraAlerts;
  return requested === undefined ? legacySettings().renderMuraAlerts : cfToBoolean(requested);
}

/** The password-expired, default-password and cache notices not yet dismissed in `alerts`. */
function masaNotices(sc: ShellContext, alerts: SiteAlerts): SafeHtml[] {
  const { rb, user } = sc.data;
  const dismissed = (id: string): boolean => structKey(alerts, id) !== undefined;
  const notices: SafeHtml[] = [];
  if (legacySettings().expirePasswords !== 0 && user.passwordExpired && !dismissed('passwordexpirednotice')) {
    notices.push(notice('error', 'passwordexpirednotice', rb.rbKey('layout.passwordexpirednotice')));
  }
  if (user.hasDefaultPassword && !dismissed('defaultpasswordnotice')) {
    notices.push(notice('error', 'defaultpasswordnotice', rb.rbKey('layout.defaultpasswordnotice')));
  }
  // Without site data (programs-sites refused the read) the cache flags are unknown, so the cache notice is omitted.
  const { site } = sc.ctx;
  if (site !== undefined && site.enableLockdown === '' && !site.cache && !dismissed('cachenotice')) {
    notices.push(notice('warning', 'cachenotice', rb.rbKey('layout.cachenotice')));
  }
  return notices;
}

/** The layout's alert block for site admins and S2 users off the login page; empty markup for everyone else. */
export function renderAlerts(sc: ShellContext): SafeHtml {
  if (cfEq(sc.ctx.action, LOGIN_ACTION) || !(sc.ctx.isSiteAdmin || sc.ctx.isS2)) return raw('');
  const all = sc.ctx.session.alerts;
  const siteKey = structKey(all, sc.ctx.session.siteid);
  const alerts = (siteKey === undefined ? undefined : all[siteKey]) ?? NO_ALERTS;
  const loop = Object.entries(alerts)
    .filter(([id]) => !LOOP_SKIPPED.has(id.toLowerCase()))
    .map(([id, alert]) => sessionAlert(id, alert));
  return join(renderMuraAlerts(sc) ? [...loop, ...masaNotices(sc, alerts)] : loop);
}
