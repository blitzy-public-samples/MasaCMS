// `cperm.main`: the content-node permission grid of `admin/core/views/cperm/main.cfm` (server-only).
import { cfEq, cfListToArray, cfUuid } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/identity';
import { okBody } from '@/lib/gateway-client';
import { encodeHtmlAttr, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { RequestContext } from '@/lib/request-context';
import type { PageScreen, ScreenContext } from '../registry';
import {
  CONTENT_MODULE_ID,
  TOP_NODE_ID,
  cpermDefaults,
  cpermGate,
  renderBackNav,
  renderIcon,
  renderNoGroups,
  renderZoom,
  type ZoomCrumb,
} from './partials';

/** A group's node verdict as identity's `getGroupPerm` port returns it. */
export type CpermVerdict = components['schemas']['PermissionVerdict'];

/** One row of `permUtility.getGroupList` with its `getGroupPerm` verdict on the node. */
export interface CpermMainGroup {
  readonly userid: string;
  readonly groupname: string;
  readonly perm: CpermVerdict;
}

/** One approval chain of the site's `getChainFeed`. */
export interface CpermMainChain {
  readonly id: string;
  readonly name: string;
}

/** The node's `approvalChainAssignment`; both values `''` when the node has none. */
export interface CpermMainAssignment {
  readonly chainID: string;
  readonly exemptID: string;
}

/** What `cperm.main` renders for `rc.contentid` in `rc.siteid`. */
export interface CpermMainModel {
  /** The active node's title; `''` when the node has no active row. */
  readonly title: string;
  /** `getCrumbList(contentid)`, node first; empty unless `rc.moduleid` is the Site Manager module. */
  readonly crumbs: readonly ZoomCrumb[];
  /** System groups but `Admin`, in identity's group-name order. */
  readonly privateGroups: readonly CpermMainGroup[];
  /** Member groups, in identity's group-name order. */
  readonly publicGroups: readonly CpermMainGroup[];
  readonly chains: readonly CpermMainChain[];
  readonly assignment: CpermMainAssignment;
  /** The private-pool `Admin` group id; `''` when the site has no chains. */
  readonly adminGroupId: string;
}

/** The context the pure renderer reads. */
export type CpermMainRenderContext = Pick<ScreenContext, 'req' | 'rb' | 'csrf'>;

// ShellView is not re-exported by the registry, so the view type comes from the page screen's render.
type CpermMainView = Awaited<ReturnType<PageScreen<CpermMainModel>['render']>>;

/** An open CFML struct from a strategies-content screen model. */
type Struct = Readonly<Record<string, unknown>>;

const STRATEGIES_CONTENT = 'strategies-content';
const HISTORY_OPERATION = 'getContentHistory';
const CHAINS_OPERATION = 'listApprovalChains';

/** `rc[name]` after the cperm defaults; `''` for a name neither rc nor the defaults hold. */
const param = (rc: RequestContext, name: string): string => rc[name] ?? '';

/** A struct value by case-insensitive key, as CFML reads struct keys; undefined when absent. */
function structValue(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A simple struct value as CFML text; absent and SQL NULL read as `''`, complex values throw. */
function structText(struct: Struct, key: string, operation: string): string {
  const value = structValue(struct, key);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${operation} returned a struct whose ${key} is not a simple value`);
}

/** The array of structs a screen model holds under `rc[key]`. */
function structArray(rc: Struct, key: string, operation: string): readonly Struct[] {
  const entries = structValue(rc, key);
  if (!Array.isArray(entries)) throw new TypeError(`${operation} returned no rc.${key} array`);
  return entries.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError(`${operation} returned an rc.${key} entry that is not a struct`);
    }
    return entry as Struct;
  });
}

/** A `getCrumbList` struct as `dspZoom` reads it. */
function zoomCrumbOf(crumb: Struct): ZoomCrumb {
  const text = (key: string): string => structText(crumb, key, HISTORY_OPERATION);
  const type = text('type');
  return {
    menutitle: text('menutitle'),
    siteid: text('siteid'),
    contentid: text('contentid'),
    ...(structValue(crumb, 'moduleid') === undefined ? {} : { moduleid: text('moduleid') }),
    type,
    restricted: cfEq(text('restricted'), '1') ? 1 : 0,
    icon: renderIcon({
      iconClass: text('iconclass'),
      type,
      ...(structValue(crumb, 'fileext') === undefined ? {} : { fileExt: text('fileext') }),
    }),
  };
}

/**
 * The node's crumbs, node first; none when the node has no active row (the history read answers 404).
 * @throws GatewayDenialError When strategies-content answers 401 or 403.
 */
async function loadCrumbData(ctx: ScreenContext, siteid: string, contentid: string): Promise<readonly Struct[]> {
  // strategies-content declares no cperm read; carch.hist's model carries the same getCrumbList(contentid, siteid)
  // under the view's name `crumbdata`, and its active-row crumb holds the title and the node's chain assignment.
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/content/{contentid}/history', {
    params: { siteid, contentid },
  });
  if (response.status === 404) return [];
  return structArray(okBody(response, STRATEGIES_CONTENT, HISTORY_OPERATION).rc, 'crumbdata', HISTORY_OPERATION);
}

/**
 * The site's approval chains in the order strategies-content lists them.
 * @throws GatewayDenialError When strategies-content answers 401 or 403.
 */
async function loadChains(ctx: ScreenContext, siteid: string): Promise<readonly CpermMainChain[]> {
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/approval-chains', {
    params: { siteid },
  });
  return structArray(okBody(response, STRATEGIES_CONTENT, CHAINS_OPERATION).rc, 'chains', CHAINS_OPERATION).map(
    (chain) => ({
      id: structText(chain, 'chainID', CHAINS_OPERATION),
      name: structText(chain, 'name', CHAINS_OPERATION),
    }),
  );
}

/** SQL Server `groupname = 'Admin'`: case-insensitive, trailing spaces ignored. */
const isAdminGroupName = (name: string | null | undefined): boolean =>
  name !== null && name !== undefined && name.replace(/ +$/, '').toLowerCase() === 'admin';

/**
 * `getBean('group').loadBy(groupname='Admin', isPublic=0).getUserID()`.
 * @throws GatewayDenialError When identity answers 401 or 403.
 */
async function loadAdminGroupId(ctx: ScreenContext, siteid: string): Promise<string> {
  // Legacy resolves the bean's empty site id to `default`'s private pool; identity lists only the token site's pool,
  // which is the same pool on `default`. The id fills a disabled checkbox only.
  for (let offset: number | null = 0; offset !== null; ) {
    const response = await ctx.gateway.identity.call('get', '/v1/groups', { query: { siteid, ispublic: '0', offset } });
    const page: components['schemas']['GroupList'] = okBody(response, 'identity', 'listGroups');
    const admin = page.items.find((group) => isAdminGroupName(group.GroupName));
    if (admin !== undefined) return admin.UserID;
    offset = page.nextOffset;
  }
  // A group bean that loads no row answers getUserID() with a fresh createUUID().
  return cfUuid();
}

/**
 * The `cperm.main` model: identity's group verdicts, strategies-content's crumbs and chains, and the form's CSRF pair.
 * Gateway unavailability propagates as `GatewayUnavailableError`.
 * @throws GatewayDenialError When identity or strategies-content answers 401 or 403.
 */
export async function loadCpermMain(ctx: ScreenContext): Promise<CpermMainModel> {
  const rc = cpermDefaults(ctx.req.rc);
  const siteid = param(rc, 'siteid');
  const contentid = param(rc, 'contentid');
  const [permissions, crumbData, chains] = await Promise.all([
    ctx.gateway.identity.call('get', '/v1/permissions/content/{contentId}', {
      params: { contentId: contentid },
      query: { siteid },
    }),
    loadCrumbData(ctx, siteid, contentid),
    loadChains(ctx, siteid),
    ctx.csrf.prefetch([contentid]),
  ]);
  const { groups, publicGroups } = okBody(permissions, 'identity', 'getContentPermissions');
  const toGroup = ({ groupId, groupName, perm }: components['schemas']['ContentGroupVerdict']): CpermMainGroup => ({
    userid: groupId,
    groupname: groupName,
    perm,
  });
  const node = crumbData[0];
  const nodeText = (key: string): string => (node === undefined ? '' : structText(node, key, HISTORY_OPERATION));
  return {
    title: nodeText('title'),
    crumbs: cfEq(param(rc, 'moduleid'), CONTENT_MODULE_ID) ? crumbData.map(zoomCrumbOf) : [],
    privateGroups: groups.map(toGroup),
    publicGroups: publicGroups.map(toGroup),
    chains,
    assignment: { chainID: nodeText('chainid'), exemptID: nodeText('exemptid') },
    adminGroupId: chains.length > 0 ? await loadAdminGroupId(ctx, siteid) : '',
  };
}

/** The view's `isModule`, Site Manager module and chain flags. */
interface ViewFlags {
  /** `rc.moduleid eq rc.contentid or rc.contentid eq TOP_NODE_ID`. */
  readonly isModule: boolean;
  readonly isContentModule: boolean;
  readonly hasChains: boolean;
}

/** The column labels both tables repeat, unencoded as legacy writes `getKeyValue` output. */
interface TableLabels {
  readonly exempt: SafeHtml;
  readonly editor: SafeHtml;
  readonly author: SafeHtml;
  readonly inherit: SafeHtml;
  readonly readonly: SafeHtml;
  readonly deny: SafeHtml;
  readonly group: SafeHtml;
}

/** The view's inline radio-click handler, verbatim. */
const EXEMPT_TOGGLE_SCRIPT = raw(`<script>
  $(function(){
      $("input[type='radio']").click(function(){
        var e=$(this).closest('tr').find("input[name='exemptID']")

        if($("input[name='" + $(this).attr('name') + "']:checked").val() != 'editor'){
          e.attr('checked',false)
          e.attr('disabled',true)
        } else {
          e.attr('disabled',false)
        }
      })
    }
  )
</script>`);

// The Admin row's unset radios keep legacy's missing space before `disabled`.
const ADMIN_UNSET_CELL = raw('<td><input type="radio" class="checkbox"disabled></td>');
const ADMIN_READ_CELL = raw('<td><input type="radio" class="checkbox" disabled></td>');

/** ` no-stripe` for a table of fewer than two groups. */
const stripe = (count: number): SafeHtml => raw(count < 2 ? ' no-stripe' : '');

/** The verdict a row shows: on a module root, `inherit` and `none` read as `read` (Site Manager) or `deny`. */
function shownPerm(perm: string, flags: ViewFlags): string {
  if (!flags.isModule || !['inherit', 'none'].some((unset) => cfEq(perm, unset))) return perm;
  return flags.isContentModule ? 'read' : 'deny';
}

/** One verdict radio; legacy always writes the space before its `checked` condition. */
function radioCell(name: SafeHtml, value: string, perm: string): SafeHtml {
  return html`<td><input name="${name}" type="radio" class="checkbox" value="${raw(value)}" ${raw(cfEq(perm, value) ? 'checked' : '')}></td>`;
}

/** The Inherit and Read Only cells on one line, as ACF prints them. */
function optionalCells(flags: ViewFlags, inherit: SafeHtml, read: SafeHtml): SafeHtml {
  // ACF writes the whitespace-only text between the two `cfif`s as one space after output, and as nothing after
  // whitespace.
  return html`${flags.isModule ? '' : html`${inherit} `}${flags.isContentModule ? read : ''}`;
}

/** The radio `name` of a group: `p` plus its id without dashes. */
const radioName = (userid: string): SafeHtml => raw(`p${userid.replaceAll('-', '')}`);

/** The Admin row the system table opens with when the site has chains. */
function adminRow(adminGroupId: string, flags: ViewFlags): SafeHtml {
  return html`
\t\t        <tr>
\t\t          <td><input name="exemptID" type="checkbox" class="checkbox" value="${raw(adminGroupId)}" checked disabled></td>
\t\t          <td><input type="radio" class="checkbox" disabled checked></td>
\t\t          ${ADMIN_UNSET_CELL}
\t\t          ${ADMIN_UNSET_CELL}
\t\t          ${optionalCells(flags, ADMIN_UNSET_CELL, ADMIN_READ_CELL)}
\t\t          <td nowrap class="var-width">Admin</td>
\t\t        </tr>
\t\t    `;
}

/** Whether `exemptID` lists `userid` (`listFindNoCase`). */
const isExempt = (exemptID: string, userid: string): boolean =>
  cfListToArray(exemptID).some((item) => item.toLowerCase() === userid.toLowerCase());

/** One system group row. */
function privateRow(group: CpermMainGroup, assignment: CpermMainAssignment, flags: ViewFlags): SafeHtml {
  const perm = shownPerm(group.perm, flags);
  const name = radioName(group.userid);
  const editor = cfEq(perm, 'editor');
  const exempt = html`<td><input name="exemptID" type="checkbox" class="checkbox" value="${raw(group.userid)}"${raw(
    editor && isExempt(assignment.exemptID, group.userid) ? ' checked' : '',
  )}${raw(editor ? '' : ' disabled')}></td>`;
  return html`
\t\t            <tr>
\t\t            ${flags.hasChains ? exempt : ''}
\t\t            ${radioCell(name, 'editor', perm)}
\t\t            ${radioCell(name, 'author', perm)}
\t\t            ${optionalCells(flags, radioCell(name, 'none', perm), radioCell(name, 'read', perm))}
\t\t            ${radioCell(name, 'deny', perm)}
\t\t            <td nowrap class="var-width">${group.groupname}</td>
\t\t            </tr>
\t\t        `;
}

/** One member group row. */
function publicRow(group: CpermMainGroup, flags: ViewFlags): SafeHtml {
  const perm = shownPerm(group.perm, flags);
  const name = radioName(group.userid);
  // Legacy compares the verdict with 'editior', so the member exempt box is never checked and always disabled.
  const exempt = html`<td><input name="exemptID" type="checkbox" class="checkbox" value="${raw(group.userid)}" disabled></td>`;
  return html`
\t\t\t        <tr>
\t\t\t         ${flags.hasChains ? exempt : ''}
\t\t\t          ${radioCell(name, 'editor', perm)}
\t\t\t    \t\t\t${radioCell(name, 'author', perm)}
\t\t\t   \t\t\t\t${optionalCells(flags, radioCell(name, 'none', perm), radioCell(name, 'read', perm))}
\t\t\t    \t\t\t${radioCell(name, 'deny', perm)}
\t\t\t\t\t\t\t\t<td nowrap class="var-width">${group.groupname}</td>
\t\t\t        </tr>
\t\t\t\t\t\t`;
}

/** The System Groups block: the grid when there are chains or groups, else the empty notice. */
function systemGroups(model: CpermMainModel, flags: ViewFlags, labels: TableLabels, ctx: CpermMainRenderContext): SafeHtml {
  const groups = model.privateGroups;
  if (!flags.hasChains && groups.length === 0) {
    return html`
\t\t        ${renderNoGroups(ctx.rb, { leadingSpace: false })}
\t\t    `;
  }
  const exemptHeader = flags.hasChains
    ? html`
\t\t          <th>${labels.exempt}</th>
\t\t        `
    : '';
  const inherit = html`<th>${labels.inherit}</th>`;
  const read = html`<th>${labels.readonly}</th>`;
  return html`
\t\t    <table class="mura-table-grid${stripe(groups.length)}">
\t\t      <tr>
\t\t        ${exemptHeader}
\t\t        <th>${labels.editor}</th>
\t\t        <th>${labels.author}</th>
\t\t        ${optionalCells(flags, inherit, read)}
\t\t        <th>${labels.deny}</th>
\t\t        <th class="var-width">${labels.group}</th>
\t\t      </tr>

\t\t      ${flags.hasChains ? adminRow(model.adminGroupId, flags) : ''}${groups.map((group) =>
    privateRow(group, model.assignment, flags),
  )}
\t\t    </table>
\t\t    `;
}

/** The Member Groups block: the grid when there are member groups, else the empty notice with its leading space. */
function memberGroups(model: CpermMainModel, flags: ViewFlags, labels: TableLabels, ctx: CpermMainRenderContext): SafeHtml {
  const groups = model.publicGroups;
  if (groups.length === 0) {
    return html`
\t\t        ${renderNoGroups(ctx.rb, { leadingSpace: true })}
\t\t    `;
  }
  const inherit = html`<th>${labels.inherit}</th>`;
  const read = html`<th>${labels.readonly}</th>`;
  return html`
\t\t      <table class="mura-table-grid${stripe(groups.length)}">
\t\t        <tr>
\t\t        ${flags.hasChains ? html`<th>${labels.exempt}</th>` : ''}
\t\t        <th>${labels.editor}</th>
\t\t        <th>${labels.author}</th>
\t\t        ${optionalCells(flags, inherit, read)}
\t\t        <th>${labels.deny}</th>
\t\t        <th class="var-width">${labels.group}</th>
\t\t        </tr>
\t\t      \t${groups.map((group) => publicRow(group, flags))}
\t\t    \t</table>
\t\t    `;
}

/** The Approval Chain select, with the node's assigned chain selected. */
function chainSelect(model: CpermMainModel, ctx: CpermMainRenderContext): SafeHtml {
  const { rb } = ctx;
  const select = raw(rb.rbKey('permissions.selectapprovalchain'));
  const options = model.chains.map(
    (chain) => html`
\t\t\t            <option value="${raw(chain.id)}"${raw(cfEq(model.assignment.chainID, chain.id) ? ' selected' : '')}>${chain.name}</option>
\t\t\t          `,
  );
  return html`
\t\t\t  <h2>${raw(rb.rbKey('permissions.approvalchain'))}</h2>
\t\t\t  <div class="mura-control-group">
\t\t\t    <label>
\t\t\t      <span data-toggle="popover"
\t\t\t        title=""
\t\t\t        data-placement="right"
\t\t\t        data-content="${raw(encodeHtmlAttr(rb.rbKey('tooltip.approvalchain')))}"
\t\t\t        data-original-title="${select}">${select} <i class="mi-question-circle"></i></span>
\t\t\t      </label>
\t\t\t      <div>
\t\t\t        <select name="chainID" class="dropdown">
\t\t\t          <option value="">${raw(rb.rbKey('permissions.none'))}</option>
\t\t\t          ${options}
\t\t\t        </select>
\t\t\t      </div>
\t\t\t    </div>
\t\t\t    `;
}

/**
 * The `cperm.main` view body, whitespace as ACF serves it.
 * @throws Error When the CSRF pair of `rc.contentid` was not prefetched.
 * @throws RangeError For the Site Manager module with no crumbs, where legacy's dspZoom also fails.
 */
export function renderCpermMain(model: CpermMainModel, ctx: CpermMainRenderContext): CpermMainView {
  const { rb } = ctx;
  const rc = cpermDefaults(ctx.req.rc);
  const contentid = param(rc, 'contentid');
  const moduleid = param(rc, 'moduleid');
  const type = param(rc, 'type');
  const flags: ViewFlags = {
    isModule: cfEq(moduleid, contentid) || cfEq(contentid, TOP_NODE_ID),
    isContentModule: cfEq(moduleid, CONTENT_MODULE_ID),
    hasChains: model.chains.length > 0,
  };
  const label = (key: string): SafeHtml => raw(rb.rbKey(key));
  const labels: TableLabels = {
    exempt: label('permissions.approvalchainexempt'),
    editor: label('permissions.editor'),
    author: label('permissions.author'),
    inherit: label('permissions.inherit'),
    readonly: label('permissions.readonly'),
    deny: label('permissions.deny'),
    group: label('permissions.group'),
  };
  const heading = ['component', 'form'].includes(type.toLowerCase()) ? type : label('layout.contentmanager');
  // Legacy passes the title as a string, which messageFormat splits as a comma list.
  const nodeText = raw(rb.messageFormat(rb.rbKey('permissions.nodetext'), model.title));
  const hidden = (name: string, value: string): SafeHtml =>
    html`<input type="hidden" name="${raw(name)}" value="${raw(encodeHtmlAttr(value))}">`;
  // The `</td>`, `</tr>` and `</table>` before `</form>` close nothing; legacy prints them, so they stay.
  const body = html`

<div class="mura-header">
  <h1>${heading} ${label('permissions')}</h1>
  ${renderBackNav(rb)}

  ${flags.isContentModule ? renderZoom(model.crumbs, { className: 'breadcrumb' }) : ''}

</div> <!-- /.mura-header -->

<div class="block block-constrain">
  <div class="block block-bordered">
    <div class="block-content">
\t\t  <form novalidate="novalidate" method="post" name="form1" action="./?muraAction=cPerm.update&contentid=${raw(encodeUrl(contentid))}&parentid=${raw(encodeUrl(param(rc, 'parentid')))}">
\t\t    <h2>${label('user.adminusergroups')}</h2>
\t\t    <p>${nodeText}</p>

\t\t    ${systemGroups(model, flags, labels, ctx)}
\t\t    <h2>${label('user.membergroups')}</h2>
\t\t    <p>${label('permissions.memberpermscript')}<br>${label('permissions.memberpermnodescript')}</p>
\t\t    ${memberGroups(model, flags, labels, ctx)}${flags.hasChains ? chainSelect(model, ctx) : ''}
\t\t\t    <div class="mura-actions">
\t\t\t      <div class="form-actions no-offset">
\t\t\t         <button class="btn mura-primary" onclick="submitForm(document.forms.form1);"><i class="mi-check-circle"></i>${label('permissions.update')}</button>
\t\t\t      </div>
\t\t\t    </div>
\t\t\t\t\t${hidden('router', ctx.req.headers.get('referer') ?? '')}
\t\t\t\t\t${hidden('siteid', param(rc, 'siteid'))}
\t\t\t\t\t${hidden('startrow', param(rc, 'startrow'))}
\t\t\t\t\t${hidden('topid', param(rc, 'topid'))}
\t\t\t\t\t${hidden('moduleid', moduleid)}
\t\t\t\t\t ${ctx.csrf.render(contentid, 'form')}
\t\t\t  </td>
\t\t\t  </tr>
\t\t\t</table>
\t\t</form>
    </div> <!-- /.block-content -->
  </div> <!-- /.block-bordered -->
</div> <!-- /.block-constrain -->

${EXEMPT_TOGGLE_SCRIPT}
`;
  return { body };
}

/** `cperm.main`: identity-owned page behind the cperm `before()` gate. */
export const cpermMain: PageScreen<CpermMainModel> = Object.freeze({
  circuit: 'cperm',
  action: 'main',
  owner: 'identity',
  mode: 'page',
  gate: cpermGate,
  load: loadCpermMain,
  render: (ctx: ScreenContext, model: CpermMainModel) => renderCpermMain(model, ctx),
});
