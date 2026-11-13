// `cperm.module`: the module permission grid of `admin/core/views/cperm/module.cfm` over identity grants (server-only).
import type { components as IdentitySchemas } from '@/generated/clients/identity';
import type { components as ContentSchemas } from '@/generated/clients/strategies-content';
import { okBody } from '@/lib/gateway-client';
import { encodeHtmlAttr, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { RequestContext } from '@/lib/request-context';
import type { PageScreen, ScreenContext } from '../registry';
import { cpermDefaults, cpermGate, renderBackNav, renderNoGroups } from './partials';

/** One `permUtility.getGroupList` row with its `getGroupPermVerdict(contentid, userid, 'module', siteid)` result. */
export interface CpermModuleGroup {
  readonly userid: string;
  readonly groupname: string;
  readonly allowed: boolean;
}

/** What the module view renders: the module node's active title and the site's system and member groups. */
export interface CpermModuleModel {
  /** `rc.rsContent.title` of `permUtility.getModule`; `''` when the node has no active row. */
  readonly title: string;
  readonly privateGroups: readonly CpermModuleGroup[];
  readonly publicGroups: readonly CpermModuleGroup[];
}

type ModulePermissions = IdentitySchemas['schemas']['ModulePermissions'];
type ModuleGrant = IdentitySchemas['schemas']['ModuleGroupGrant'];
type Struct = Readonly<ContentSchemas['schemas']['AdminViewModel']['rc']>;

/** `rc[name]` for a service path segment; an empty segment would address another operation, so it throws. */
function segment(rc: RequestContext, name: string): string {
  const value = rc[name] ?? '';
  if (value === '') throw new TypeError(`rc.${name} is empty; the cperm.module reads need a value`);
  return value;
}

/** A struct member by case-insensitive key, as CFML reads it; undefined when absent. */
function member(struct: Struct, key: string): unknown {
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** The `title` of the history model's `rc.contentBean` (`contentManager.getActiveContent`), NULL as `''`. */
function beanTitle(rc: Struct): string {
  const bean = member(rc, 'contentBean');
  if (typeof bean !== 'object' || bean === null || Array.isArray(bean)) {
    throw new TypeError('rc.contentBean is not a struct');
  }
  const title = member(bean as Struct, 'title');
  if (title === undefined || title === null) return '';
  if (typeof title === 'string' || typeof title === 'number' || typeof title === 'boolean') return String(title);
  throw new TypeError('rc.contentBean.title is not a simple value');
}

/** The active `tcontent` title of `contentid`, read from strategies-content; `''` when the node does not exist. */
async function activeTitle(ctx: ScreenContext, siteid: string, contentid: string): Promise<string> {
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/content/{contentid}/history', {
    params: { siteid, contentid },
  });
  // getModule then selects no row, and CFML reads an empty query's title as ''.
  if (response.status === 404) return '';
  return beanTitle(okBody(response, 'strategies-content', 'getContentHistory').rc);
}

/** Identity's system and member groups of the token site with their `module` grant on `contentid`. */
async function moduleGrants(ctx: ScreenContext, siteid: string, contentid: string): Promise<ModulePermissions> {
  const response = await ctx.gateway.identity.call('get', '/v1/permissions/modules/{moduleId}', {
    params: { moduleId: contentid },
    query: { siteid },
  });
  return okBody(response, 'identity', 'getModulePermissions');
}

const groupRow = ({ groupId, groupName, granted }: ModuleGrant): CpermModuleGroup => ({
  userid: groupId,
  groupname: groupName,
  allowed: granted,
});

/**
 * `cperm.module()`: groups and grants keyed by `rc.contentid` (not `rc.moduleid`), the node title, and the CSRF pair
 * of context `rc.moduleid`; gateway unavailability propagates.
 * @throws GatewayDenialError When identity or strategies-content answers 401 or 403.
 */
export async function loadCpermModule(ctx: ScreenContext): Promise<CpermModuleModel> {
  const rc = cpermDefaults(ctx.req.rc);
  const siteid = segment(rc, 'siteid');
  // Every legacy link carries the module id here; identity's grant read takes no other, so legacy's empty grid for a
  // hand-made URL without one fails instead.
  const contentid = segment(rc, 'contentid');
  const [grants, title] = await Promise.all([
    moduleGrants(ctx, siteid, contentid),
    activeTitle(ctx, siteid, contentid),
    ctx.csrf.prefetch([rc.moduleid ?? '']),
  ]);
  return { title, privateGroups: grants.privateGroups.map(groupRow), publicGroups: grants.publicGroups.map(groupRow) };
}

/** The checkbox's `checked` flag, written straight after the closing quote of `value` as legacy writes it. */
const checkedFlag = (group: CpermModuleGroup): SafeHtml => raw(group.allowed ? 'checked' : '');

/** A system-group row; legacy writes the system group name unencoded (only member names are encoded). */
function privateRow(group: CpermModuleGroup): SafeHtml {
  return html`
                    <tr>
                      <td><input type="checkbox" name="groupid" value="${raw(group.userid)}"${checkedFlag(group)}></td>
                <td class="var-width" nowrap>${raw(group.groupname)}</td>
              </tr>
         `;
}

/** A member-group row, its name HTML-encoded. */
function publicRow(group: CpermModuleGroup): SafeHtml {
  return html`
            <tr>
                <td><input type="checkbox" name="groupid" value="${raw(group.userid)}"${checkedFlag(group)}></td>
            <td class="var-width" nowrap>${group.groupname}</td>
      </tr>
     `;
}

type Label = (key: string) => SafeHtml;

/** The System Groups grid, or the empty notice. */
function privateSection(groups: readonly CpermModuleGroup[], rbKey: Label, empty: SafeHtml): SafeHtml {
  if (groups.length === 0) {
    return html`
        ${empty}
   `;
  }
  return html`
          <table class="mura-table-grid">
            <tr>
              <th>${rbKey('permissions.allow')}</th>
              <th class="var-width">${rbKey('permissions.group')}</th>
            </tr>
              ${groups.map(privateRow)}
         </table>
    `;
}

/** The Member Groups grid, or the empty notice. */
function publicSection(groups: readonly CpermModuleGroup[], rbKey: Label, empty: SafeHtml): SafeHtml {
  if (groups.length === 0) {
    return html`
        ${empty}
  `;
  }
  return html`
      <table class="mura-table-grid">
         <tr>
             <th>${rbKey('permissions.allow')}</th>
             <th class="var-width">${rbKey('permissions.group')}</th>
         </tr>
        ${groups.map(publicRow)}
      </table>
  `;
}

/** The `cperm.module` view body as ACF emits it; labels and the title are written unencoded, as legacy writes them. */
export function renderCpermModule(model: CpermModuleModel, ctx: Pick<ScreenContext, 'req' | 'rb' | 'csrf'>): SafeHtml {
  const { rb, csrf, req } = ctx;
  const rc = cpermDefaults(req.rc);
  const rbKey: Label = (key) => raw(rb.rbKey(key));
  const attr = (value: string | undefined): SafeHtml => raw(encodeHtmlAttr(value ?? ''));
  const title = raw(model.title);
  const moduleText = raw(rb.messageFormat(rb.rbKey('permissions.moduletext'), model.title));
  const empty = renderNoGroups(rb, { leadingSpace: false });
  // `${''}` keeps the indent ACF leaves where the member-groups `<cfset>` stood, safe from whitespace trimming.
  return html`
<div class="mura-header">
  <h1>${title} ${rbKey('permissions')}</h1>
  ${renderBackNav(rb)}
</div> <!-- /.mura-header -->

<div class="block block-constrain">
    <div class="block block-bordered">
      <div class="block-content">

      <div class="help-block">${moduleText}</div>
      <form novalidate="novalidate"  method="post" name="form1" action="./?muraAction=cPerm.updatemodule&contentid=${raw(encodeUrl(rc.contentid ?? ''))}">
        <div class="block-content">
        <h2>${rbKey('user.adminusergroups')}</h2>

      ${privateSection(model.privateGroups, rbKey, empty)}

      </div><!-- /.block-content -->
      ${''}
      <div class="block-content">
 <h2>${rbKey('user.membergroups')}</h2>
  <div class="help-block">${rbKey('permissions.memberpermscript')}</div>

  ${publicSection(model.publicGroups, rbKey, empty)}


      <div class="mura-actions">
        <div class="form-actions no-offset">
        <button class="btn mura-primary" onclick="submitForm(document.forms.form1);"><i class="mi-check-circle"></i>${rbKey('permissions.update')}</button>
        </div>
      </div>

      <input type="hidden" name="router" value="${attr(req.headers.get('referer') ?? '')}">
      <input type="hidden" name="siteid" value="${attr(rc.siteid)}">
      <input type="hidden" name="topid" value="${attr(rc.topid)}">
      <input type="hidden" name="moduleid" value="${attr(rc.moduleid)}">
      ${csrf.render(rc.moduleid ?? '', 'form')}
      </form>

      </div> <!-- /.block-content -->
    </div> <!-- /.block-bordered -->
  </div> <!-- /.block-constrain -->

`;
}

/** `cperm.module`: the controller gate, the grant and title reads, then the view inside the shell. */
export const cpermModule: PageScreen<CpermModuleModel> = Object.freeze({
  circuit: 'cperm',
  action: 'module',
  owner: 'identity',
  mode: 'page',
  gate: cpermGate,
  load: loadCpermModule,
  render: (ctx: ScreenContext, model: CpermModuleModel) => ({ body: renderCpermModule(model, ctx) }),
});
