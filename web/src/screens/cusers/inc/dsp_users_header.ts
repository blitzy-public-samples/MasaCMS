// Users & Groups header of `cusers/inc/dsp_users_header.cfm`, included by the group and user lists (server-only).
import { cfToBoolean } from '@opt2/platform/legacy-compat';
import { encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import { buildUrl } from '@/lib/urls';
import type { ScreenContext } from '../../registry';
import type { CusersRc } from '../gate';
import { renderSearchForm } from './dsp_search_form';

// The markup is the include's bytes as ACF 2023 prints them where both list views include it, after whitespace output,
// with no attribute added (parity with the legacy page): CFML comments are dropped and the text around them joins, and
// the whitespace-only text between the two `cfif` blocks prints nothing. `\x20` is a trailing space legacy leaves at a
// line end.

/** Users module, which the Permissions link opens as both content and module. */
const USERS_MODULE_ID = '00000000000000000000000000000000008';

/** `rc.muraaction` of the user list, whose header links back to the groups. */
const LIST_USERS_ACTION = 'core:cusers.listusers';

/** The include's output: title, add and list-switch buttons, Permissions for an admin on members, and the search form. */
export function renderUsersHeader(ctx: ScreenContext, rc: CusersRc): SafeHtml {
  const label = (key: string): SafeHtml => raw(ctx.rb.rbKey(key));
  // FW/1 emits buildURL results unencoded; only the site id is URL-encoded, as the view does.
  const url = (action: string, queryString: string): SafeHtml =>
    raw(buildUrl(action, undefined, queryString, { ses: ctx.req.ses }));
  const siteQuery = `siteid=${encodeUrl(rc.siteid)}`;

  const listSwitch =
    ctx.req.action === LIST_USERS_ACTION
      ? html`

\t\t\t
\t\t\t\t<a class="btn" href="${url('cusers.default', siteQuery)}" onclick="actionModal();">
\t\t\t\t\t<i class="mi-group"></i>
\t\t\t\t\t${label('user.viewgroups')}
\t\t\t\t</a>

\t  `
      : html`

\t\t\t
\t\t\t\t<a class="btn" href="${url('cusers.listUsers', siteQuery)}" onclick="actionModal();">
\t\t\t\t\t<i class="mi-user"></i>
\t\t\t\t\t${label('user.viewusers')}
\t\t\t\t</a>

\t\t`;

  const permissions =
    rc.isAdmin && cfToBoolean(rc.ispublic)
      ? html`
\t\t\t\t<a class="btn" href="./?muraAction=cPerm.module&amp;contentid=${USERS_MODULE_ID}&amp;${raw(siteQuery)}&amp;moduleid=${USERS_MODULE_ID}" onclick="actionModal();">
\t\t\t\t\t<i class="mi-group"></i>\x20
\t\t\t\t\t${label('user.permissions')}
\t\t\t\t</a>
\t\t\t`
      : '';

  return html`

\t\t\t
<div class="mura-header">
\t<h1>${label('user.groupsandusers')}</h1>

\t<div class="nav-module-specific btn-group">

\t\t
\t\t\t<a class="btn" href="${url('cusers.edituser', `${siteQuery}&userid=`)}" onclick="actionModal();">
\t\t\t\t<i class="mi-plus-circle"></i>\x20
\t\t\t\t${label('user.adduser')}
\t\t\t</a>

\t \x20
\t\t\t<a class="btn" href="${url('cusers.editgroup', `${siteQuery}&userid=`)}" onclick="actionModal();">
\t\t\t\t<i class="mi-plus-circle"></i>\x20
\t\t\t\t${label('user.addgroup')}
\t\t\t</a>

\t\t${listSwitch}${permissions}
\t\t</div>

\t<div class="mura-item-metadata">
\t\t${renderSearchForm({ rc, search: rc.search, rb: ctx.rb })}
\t</div><!-- /.mura-item-metadata -->
</div> <!-- /.mura-header -->

`;
}
