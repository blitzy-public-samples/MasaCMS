// The `cMessage.noaccess` screen: the cmessage controller's `before()` gate and the view's markup (server-only).
import type { ScreenGate } from '@/lib/access-gate';
import { legacySettings } from '@/lib/env';
import { encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';

/**
 * cmessage `before()`: anyone not logged in as a private-pool user goes to the site root.
 * `session.s2IsPrivate` is the exact `listFind(session.mura.memberships, 'S2IsPrivate')` of legacy, which the
 * role-derived `isPrivateUser` only approximates.
 */
export const noaccessGate: ScreenGate = (req) =>
  !req.isLoggedIn || !req.session.s2IsPrivate
    ? { kind: 'redirect', location: `${legacySettings().context}/` }
    : { kind: 'allow' };

/** configBean `getAdminEmail()`: `MURA_ADMINEMAIL`, else the settings template's empty `adminemail`. */
export function noaccessAdminEmail(): string {
  return process.env.MURA_ADMINEMAIL ?? '';
}

/**
 * The view's bytes as the ACF 2023 oracle serves them: whitespace management drops the whitespace-only text around
 * the license comment and `<cfoutput>` tags, so no newline precedes the markup and only the two inside `cfoutput`
 * follow it.
 */
export function renderNoaccessBody(adminEmail: string): SafeHtml {
  // The URL-encoded address is attribute-safe as it stands; HTML-encoding it again would turn `%40` into `&#x25;40`.
  return html`<div class="mura-header"><h1>Access Denied</h1></div>
<div class="block block-constrain">
\t\t<div class="block block-bordered">
\t\t  <div class="block-content">
\t\t\t\t<p>You have successfully logged in. However, your user account has not been granted permission to access any sites. <br/> If you believe this is an error, contact the system <a href="mailto:${raw(encodeUrl(adminEmail))}">administrator</a> for assistance.</p>
\t\t\t</div>
\t\t</div>
</div>\n\n`;
}

/** The `cMessage.noaccess` page view; the shell derives body id, module title and layout from the request. */
export function renderNoaccess(adminEmail: string = noaccessAdminEmail()): ShellView {
  return { body: renderNoaccessBody(adminEmail) };
}
