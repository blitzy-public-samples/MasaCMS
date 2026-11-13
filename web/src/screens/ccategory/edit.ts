// `cCategory.edit`, also the view of `cCategory.update`: the category form of `ccategory/edit.cfm` (server-only).
import { cfListToArray, cfToBoolean, cfUuid } from '@opt2/platform/legacy-compat';
import { cfEq } from '@/lib/cfml';
import { okBody } from '@/lib/gateway-client';
import { encodeHtmlAttr, encodeJs, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import { structOf, structText, structValue, type CarchStruct } from '../carch/model';
import { displayErrors } from '../carch/partials/display-errors';
import type { ScreenContext } from '../registry';
import { categoryTreeOf, flagOf, isStruct, type CategoryFlag, type CategoryNode } from './dsp-nest';
import { renderCategoryParents } from './dsp-parents';
import { renderCategoryAjax } from './js';
import { ccategorySecondaryMenu } from './secondary-menu';

const SERVICE = 'strategies-content';
const OPERATION = 'getCategory';

/** Longest `tcontentcategories.categoryID`; a longer id names no category. */
const MAX_CATEGORY_ID_LENGTH = 35;

/** The `categoryBean` getters the form reads. */
export interface CategoryBeanView {
  /** `''` for a new bean. */
  readonly categoryID: string;
  readonly name: string;
  readonly urlTitle: string;
  readonly isInterestGroup: CategoryFlag;
  readonly isOpen: CategoryFlag;
  readonly isFeatureable: CategoryFlag;
  readonly isActive: CategoryFlag;
  readonly restrictGroups: string;
  readonly notes: string;
}

/** One `contentUtility.getRestrictGroups` row. */
export interface CategoryRestrictGroup {
  readonly groupName: string;
  /** 1 for a member group, 0 for a system group. */
  readonly isPublic: CategoryFlag;
}

/** What the controller leaves in `rc` for the form. */
export interface CcategoryEditData {
  readonly bean: CategoryBeanView;
  /** `categoryBean.getErrors()`, in struct order. */
  readonly errors: ReadonlyArray<readonly [string, string]>;
  readonly restrictGroups: readonly CategoryRestrictGroup[];
  readonly categories: readonly CategoryNode[];
}

/** A bean error struct as `[key, message]` pairs in struct order; absent reads as no errors. */
export function errorEntriesOf(errors: unknown): Array<[string, string]> {
  if (errors === undefined || errors === null) return [];
  if (!isStruct(errors)) throw new TypeError('errors is not a struct');
  return Object.entries(errors).map(([key, message]): [string, string] => [key, String(message)]);
}

/**
 * The form model of a `getCategory` screen model, or of a rejected save's `data.rc`.
 * @throws TypeError When the model lacks a value the view reads.
 */
export function categoryEditDataOf(rc: CarchStruct): CcategoryEditData {
  const bean = structOf(rc, 'categoryBean');
  const groups = structValue(rc, 'rsRestrictGroups');
  if (!Array.isArray(groups)) throw new TypeError('rc.rsRestrictGroups is not an array');
  return {
    bean: {
      categoryID: structText(bean, 'categoryID'),
      name: structText(bean, 'name'),
      urlTitle: structText(bean, 'urlTitle'),
      isInterestGroup: flagOf(bean, 'isInterestGroup'),
      isOpen: flagOf(bean, 'isOpen'),
      isFeatureable: flagOf(bean, 'isFeatureable'),
      isActive: flagOf(bean, 'isActive'),
      restrictGroups: structText(bean, 'restrictGroups'),
      notes: structText(bean, 'notes'),
    },
    errors: errorEntriesOf(structValue(bean, 'errors')),
    restrictGroups: groups.map((row: unknown) => {
      if (!isStruct(row)) throw new TypeError('rc.rsRestrictGroups holds a row that is not a struct');
      return { groupName: structText(row, 'groupName'), isPublic: flagOf(row, 'isPublic') };
    }),
    categories: categoryTreeOf(rc),
  };
}

/**
 * `edit()`: the category of `rc.categoryID` with the restrict groups and the category tree, its tokens prefetched.
 * @throws GatewayDenialError When strategies-content answers 401 or 403; any other non-2xx answer throws `Error`.
 */
export async function loadCcategoryEdit(ctx: ScreenContext): Promise<CcategoryEditData> {
  const requested = ctx.req.rc.categoryID ?? '';
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/categories/{categoryid}', {
    // The path needs an id: a fresh one matches no category, so the service reads the new bean `read('')` returns.
    params: {
      siteid: ctx.req.rc.siteid ?? '',
      categoryid: requested === '' || requested.length > MAX_CATEGORY_ID_LENGTH ? cfUuid() : requested,
    },
  });
  const data = categoryEditDataOf(okBody(response, SERVICE, OPERATION).rc);
  await ctx.csrf.prefetch([data.bean.categoryID]);
  return data;
}

/** A Yes/No radio pair's `checked` markers for a CFML boolean. */
function checkedPair(flag: CategoryFlag): { readonly yes: SafeHtml | false; readonly no: SafeHtml | false } {
  const on = cfToBoolean(flag);
  return { yes: on && raw('checked'), no: !on && raw('checked') };
}

/** CFML `listFindNoCase(list, value) > 0`. */
const listHasNoCase = (list: string, value: string): boolean =>
  cfListToArray(list).some((item) => item.toLowerCase() === value.toLowerCase());

/** A restrict-groups optgroup of the groups whose `isPublic` equals `isPublic`; nothing when there are none. */
function groupOptions(ctx: ScreenContext, data: CcategoryEditData, isPublic: 0 | 1, labelKey: string): SafeHtml {
  const groups = data.restrictGroups.filter((group) => cfEq(group.isPublic, isPublic));
  if (groups.length === 0) return html``;
  const options = groups.map(
    // Legacy writes the group names unencoded.
    ({ groupName }) => html`
      \t<option value="${raw(groupName)}" ${listHasNoCase(data.bean.restrictGroups, groupName) && raw('Selected')}>${raw(groupName)}</option>
      \t`,
  );
  return html`
      \t<optgroup label="${raw(encodeHtmlAttr(ctx.rb.rbKey(labelKey)))}">
      \t${options}
      \t</optgroup>
      \t`;
}

/** Add for a new category; Delete and Update for a saved one. */
function actionButtons(ctx: ScreenContext, data: CcategoryEditData, isNew: boolean): SafeHtml {
  const label = (key: string): SafeHtml => raw(ctx.rb.rbKey(`categorymanager.${key}`));
  const categoryID = raw(data.bean.categoryID);
  if (isNew) {
    return html`
          <button type="button" class="btn mura-primary" onclick="submitForm(document.forms.form1,'add');"><i class="mi-check-circle"></i>${label('add')}</button>
          <input type=hidden name="categoryID" value="${categoryID}">
          <input type="hidden" name="action" value="add">
        `;
  }
  const confirm = raw(encodeJs(ctx.rb.rbKey('categorymanager.deleteconfirm')));
  return html`
          <button type="button" class="btn" onclick="submitForm(document.forms.form1,'delete','${confirm}');"><i class="mi-trash"></i>${label('delete')}</button>
          <button class="btn mura-primary" onclick="submitForm(document.forms.form1,'update');"><i class="mi-check-circle"></i>${label('update')}</button>
          <input type=hidden name="categoryID" value="${categoryID}">
          <input type="hidden" name="action" value="update">
        `;
}

/**
 * The form view body and the `js.cfm` script block. `rc.categoryID` picks the heading and buttons, `rc.parentID` the
 * selected parent; the bean supplies the values.
 * @throws TypeError When `rc.parentID` is undefined, where legacy's view fails.
 */
export function renderCcategoryEdit(ctx: ScreenContext, data: CcategoryEditData): ShellView {
  const { rc } = ctx.req;
  const actualParentID = rc.parentID;
  if (actualParentID === undefined) throw new TypeError('Element PARENTID is undefined in RC.');
  const rcCategoryID = rc.categoryID ?? '';
  const isNew = cfEq(rcCategoryID, '');
  const { bean } = data;
  const label = (key: string): SafeHtml => raw(ctx.rb.rbKey(key));
  const errorAlert =
    data.errors.length > 0
      ? html`
  <div class="alert alert-error"><span>${displayErrors(data.errors)}</span></div>
`
      : '';
  const parents = renderCategoryParents({
    nodes: data.categories,
    categoryID: rcCategoryID,
    actualParentID,
    nestLevel: 1,
  });
  // ACF prints the id or the notice followed by one space, the whitespace before it as nothing.
  const categoryIdText =
    rcCategoryID !== '' && bean.categoryID !== ''
      ? bean.categoryID
      : ctx.rb.rbKey('sitemanager.content.fields.notavailable');
  const interest = checkedPair(bean.isInterestGroup);
  const open = checkedPair(bean.isOpen);
  const featureable = checkedPair(bean.isFeatureable);
  const active = checkedPair(bean.isActive);
  const body = html`
  <div class="mura-header">
  <h1>${label(isNew ? 'categorymanager.addcontentcategory' : 'categorymanager.editcontentcategory')}</h1>
  
${ccategorySecondaryMenu(ctx.req)}

</div> <!-- /.mura-header -->

${errorAlert}

<div class="block block-constrain">
    <div class="block block-bordered">
      <div class="block-content">

      

      <form novalidate="novalidate" action="./?muraAction=cCategory.update&siteid=${raw(encodeUrl(rc.siteid ?? ''))}" method="post" name="form1" onsubmit="return validate(this);">
      

      <div class="mura-control-group">
        <label>${label('categorymanager.name')}</label>
        <input type="text" name="name" required="true" message="${label('categorymanager.namerequired')}" value="${raw(encodeHtmlAttr(bean.name))}" maxlength="50">
      </div>

      <div class="mura-control-group">
        <label>${label('categorymanager.urltitle')}</label>
    <input type="text" name="urltitle" value="${raw(encodeHtmlAttr(bean.urlTitle))}" maxlength="255">
  </div>

      <div class="mura-control-group">
      <label>${label('categorymanager.parentcategory')}</label>
    <select name="parentID">
      <option value="">${label('categorymanager.primary')}</option>
     ${parents}
      </select>
    </div>

      <div class="mura-control-group">
        <label>CategoryID</label>
    ${raw(categoryIdText)} 
  </div>

      <div class="mura-control-group">
        <label>${label('categorymanager.isinterestgroup')}</label>
  \t<label class="radio inline" for="isInterestGroupYes">
      <input name="isInterestGroup" id="isInterestGroupYes" type="radio" value="1" ${interest.yes}>
      ${label('categorymanager.yes')}
    </label>
    <label class="radio inline" for="isInterestGroupNo">
      <input name="isInterestGroup" id="isInterestGroupNo" type="radio" value="0" ${interest.no}>
      ${label('categorymanager.no')}
    </label>
      </div>

      <div class="mura-control-group">
        <label>${label('categorymanager.allowcontentassignments')}</label>
  \t<label class="radio inline" for="isOpenYes">
      <input name="isOpen" id="isOpenYes" type="radio" value="1" ${open.yes}> ${label('categorymanager.yes')}
    </label>
    <label class="radio inline" for="isOpenNo">
     <input name="isOpen" id="isOpenNo" type="radio" value="0" ${open.no}> ${label('categorymanager.no')}
    </label>
      </div>

      <div class="mura-control-group">
        <label>${label('categorymanager.isfeatureable')}</label>
  \t<label class="radio inline" for="isfeatureableYes">
      <input name="isfeatureable" id="isfeatureableYes" type="radio" value="1" ${featureable.yes}>
      ${label('categorymanager.yes')}
    </label>
    <label class="radio inline" for="isfeatureableNo">
      <input name="isfeatureable" id="isfeatureableNo" type="radio" value="0" ${featureable.no}>
      ${label('categorymanager.no')}
    </label>
      </div>

      <div class="mura-control-group">
        <label>Active?</label>
    <label class="radio inline" for="isActiveYes">
      <input name="isActive" id="isActiveYes" type="radio" value="1" ${active.yes}>
      ${label('categorymanager.yes')}
    </label>
    <label class="radio inline" for="isActiveNo">
      <input name="isActive" id="isActiveNo" type="radio" value="0" ${active.no}>
      ${label('categorymanager.no')}
    </label>
      </div>

      <div class="mura-control-group">
        <label>${label('categorymanager.restrictaccess')}</label>
    \t<select name="restrictgroups" size="8" multiple="multiple" id="restrictGroups">
\t       <optgroup label="${raw(encodeHtmlAttr(ctx.rb.rbKey('sitemanager.content.fields.globalsettings')))}">
\t       <option value="" ${cfEq(bean.restrictGroups, '') && raw('selected')}>${label('sitemanager.content.fields.allowall')}</option>
\t       <option value="RestrictAll" ${cfEq(bean.restrictGroups, 'RestrictAll') && raw('selected')}>${label('sitemanager.content.fields.restrictall')}</option>
\t       </optgroup>
\t       ${groupOptions(ctx, data, 1, 'user.membergroups')}${groupOptions(ctx, data, 0, 'user.adminusergroups')}
\t   </select>
\t</div>

      \t<div class="mura-control-group">
      \t  <label>
\t    ${label('categorymanager.notes')}
\t  </label>
\t    <textarea name="notes" rows="8">${bean.notes}</textarea>
\t  </div>

   
    <div class="mura-actions">
      <div class="form-actions">
        ${actionButtons(ctx, data, isNew)}${ctx.csrf.render(bean.categoryID, 'form')}
      </div>
    </div>
      </form>
      

      </div> <!-- /.block-content -->
    </div> <!-- /.block-bordered -->
  </div> <!-- /.block-constrain -->
`;
  return { body, ajax: renderCategoryAjax(ctx.rb) };
}
