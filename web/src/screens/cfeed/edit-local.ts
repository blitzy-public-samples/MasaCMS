// Local (index) branch of `admin/core/views/cfeed/edit.cfm`: the collection edit form (server-only).
import { cfEq, cfListAppend, cfListToArray, javaTrim } from '@opt2/platform/legacy-compat';
import { encodeHtml, encodeHtmlAttr, encodeJs, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { selectLayout, type ShellView } from '@/shell/document';
import type { ScreenContext } from '../registry';
import { renderFeedCategoriesNest } from './categories-nest';
import { displayErrors, feedApiEndpoint } from './common';
import type { FeedAdvancedParam, FeedContentFilter, FeedEditModel, FeedExtendedAttribute, FeedView } from './edit-model';
import { renderCfeedSecondaryMenu } from './secondary-menu';
import { renderFeedUsageTab } from './tab-usage';

/** What a branch of `edit.cfm` adds to the page: its body and, in compact display, its `cfhtmlhead` text. */
export type FeedEditBranchView = Pick<ShellView, 'body' | 'htmlHead'>;

/** Options of {@link renderFeedEditLocal}. */
export interface FeedEditLocalOptions {
  /** `listLast(request.action, '.')`, which picks the secondary menu's case. */
  readonly fuseaction: string;
}

/** An advanced-filter field or condition choice: option value and label text, both written unencoded. */
type Choice = readonly [value: string, label: string];

/** A `session.rb` label, unencoded as legacy writes it. */
type Label = (key: string) => SafeHtml;

/** What every part of the form reads. */
interface Parts {
  readonly req: AdminRequest;
  readonly model: FeedEditModel;
  readonly feed: FeedView;
  readonly rb: RbLookup;
  readonly label: Label;
  /** Legacy `displaNamePrefix`: `instance` for a display object instance, else ''. */
  readonly prefix: string;
}

/** The labelled fields of the advanced filters (edit.cfm 84-115), before the literal ones. */
const LABELLED_FIELDS: ReadonlyArray<readonly [value: string, key: string]> = [
  ['tcontent.lastupdate^date', 'params.lastupdate'],
  ['tcontent.releaseDate^date', 'params.releasedate'],
  ['tcontent.created^date', 'params.created'],
  ['tcontent.menuTitle^varchar', 'params.menutitle'],
  ['tcontent.title^varchar', 'params.title'],
  ['tcontent.Credits^varchar', 'params.credits'],
  ['tcontent.summary^varchar', 'params.summary'],
  ['tcontent.body^varchar', 'params.body'],
  ['tcontent.metaDesc^varchar', 'params.metadesc'],
  ['tcontent.metaKeywords^varchar', 'params.metakeywords'],
  ['tcontent.type^varchar', 'params.type'],
  ['tcontent.subType^varchar', 'params.subtype'],
  ['tcontenttags.tag^varchar', 'params.tag'],
  ['tcontent.displayStart^timestamp', 'sitemanager.content.fields.startdatetime'],
  ['tcontent.displayStop^timestamp', 'sitemanager.content.fields.stopdatetime'],
  ['tcontent.expires^timestamp', 'sitemanager.content.fields.expires'],
];

/** The advanced-filter fields legacy labels with literal text (edit.cfm 116-127). */
const LITERAL_FIELDS: readonly Choice[] = [
  ['tcontent.contentID^varchar', 'Content ID'],
  ['tcontent.parentID^varchar', 'Parent ID'],
  ['tcontent.path^varchar', 'Path'],
  ['tcontentcategoryassign.categoryID^varchar', 'Category ID'],
  ['tcontentcategories.name^varchar', 'Category Name'],
  ['tcontent.filename^varchar', 'Filename'],
];

/** The advanced-filter conditions and their label keys (edit.cfm 136-155). */
const CRITERIAS: ReadonlyArray<readonly [value: string, key: string]> = [
  ['Equals', 'params.equals'],
  ['GT', 'params.gt'],
  ['GTE', 'params.gte'],
  ['LT', 'params.lt'],
  ['LTE', 'params.lte'],
  ['NEQ', 'params.neq'],
  ['Begins', 'params.beginswith'],
  ['Contains', 'params.contains'],
  ['IN', 'params.in'],
  ['NOT IN', 'params.notin'],
];

/** The fixed sort fields before the optional comments entry, then those after it (edit.cfm 365-376). */
const SORTS_BEFORE_COMMENTS: ReadonlyArray<readonly [value: string, key: string]> = [
  ['lastUpdate', 'params.lastupdate'],
  ['releaseDate', 'params.releasedate'],
  ['displayStart', 'params.displaystart'],
  ['menuTitle', 'params.menutitle'],
  ['title', 'params.longtitle'],
  ['rating', 'params.rating'],
];
const SORTS_AFTER_COMMENTS: ReadonlyArray<readonly [value: string, key: string]> = [
  ['created', 'params.created'],
  ['orderno', 'params.orderno'],
  ['random', 'params.random'],
];

/** The maxItems and itemsperpage choices before `All` (100000). */
const COUNTS: readonly string[] = cfListToArray('1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,25,50,100');
const ALL_COUNT = '100000';

const IMAGE_SIZES: readonly string[] = ['Small', 'Medium', 'Large'];
const RSS_VERSIONS: readonly string[] = ['RSS 2.0', 'RSS 0.920'];

/** `rc[name]`, matched case-insensitively; '' when absent. */
function rcText(req: AdminRequest, name: string): string {
  return req.rc[name] ?? '';
}

/** CFML `listFind(list, value) > 0`: a case-sensitive match of a non-empty list item. */
function listFind(list: string, value: string): boolean {
  return cfListToArray(list).includes(value);
}

/** `<type>/<subType> - <attribute>`, the label legacy gives an extended attribute. */
function attributeLabel(attribute: FeedExtendedAttribute): string {
  return `${attribute.type}/${attribute.subType} - ${attribute.attribute}`;
}

/** The view's `options`: the labelled and literal fields, then one `varchar` field per extended attribute. */
function fieldOptions(rb: RbLookup, attributes: readonly FeedExtendedAttribute[]): Choice[] {
  return [
    ...LABELLED_FIELDS.map(([value, key]): Choice => [value, rb.rbKey(key)]),
    ...LITERAL_FIELDS,
    ...attributes.map((attribute): Choice => [`${attribute.attributeID}^varchar`, attributeLabel(attribute)]),
  ];
}

/** The view's `criterias`. */
function criteriaOptions(rb: RbLookup): Choice[] {
  return CRITERIAS.map(([value, key]): Choice => [value, rb.rbKey(key)]);
}

/** The `tablist` ids and `tabLabellist` label keys of edit.cfm 188-213, before the usage tab. */
function tabKeys(model: FeedEditModel): ReadonlyArray<readonly [id: string, key: string]> {
  const display = model.isObjectInstance ? 'collections.displayinstance' : 'collections.displaydefaults';
  return [
    ['tabBasic', 'collections.basic'],
    ...(model.hasCategories ? [['tabCategorization', 'collections.categorization'] as const] : []),
    ['tabAdvancedfilters', 'collections.advancedfilters'],
    ...(model.useLayoutManager ? [] : [['tabDisplay', display] as const]),
    ['tabRss', 'collections.rss'],
  ];
}

/** `<option … selected>` text for a choice; legacy writes value and label unencoded. */
function choiceOption([value, text]: Choice, selected: boolean, indent: string): SafeHtml {
  return html`${raw(indent)}<option value="${raw(value)}" ${selected && raw('selected')}>${raw(text)}</option>
`;
}

/** A `1/0` radio pair with Yes and No labels, `class="radio"` on the inputs when `classed`. */
function radioPair(parts: Parts, name: string, on: boolean, classed: boolean, indent: string): SafeHtml {
  const cls = classed ? raw(' class="radio"') : '';
  const input = (value: '1' | '0', checked: boolean, key: string): SafeHtml => html`${raw(indent)}<label class="radio inline">
${raw(indent)}\t<input name="${raw(name)}" type="radio" value="${value}"${cls} ${checked && raw('checked')}>${parts.label(key)}
${raw(indent)}</label>
`;
  return html`${input('1', on, 'collections.yes')}${input('0', !on, 'collections.no')}`;
}

/** A labelled Yes/No radio group of the Basic tab. */
function basicRadioGroup(parts: Parts, labelKey: string, name: string, on: boolean): SafeHtml {
  return html`\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${parts.label(labelKey)}</label>
${radioPair(parts, name, on, true, '\t\t\t\t\t\t')}\t\t\t\t\t</div>
`;
}

/** The maxItems or nextN select: the counts, then `All`, selected by CFML `eq` against `current`. */
function countSelect(parts: Parts, labelKey: string, param: 'maxItems' | 'nextN', current: string): SafeHtml {
  const option = (value: string, text: string): SafeHtml =>
    html`\t\t\t\t\t\t<option value="${value}" ${cfEq(current, value) && raw('selected')}>${text}</option>
`;
  return html`\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>${parts.label(labelKey)}</label>
\t\t\t\t\t<select name="${raw(parts.prefix)}${param}" data-displayobjectparam="${param}">
${COUNTS.map((count) => option(count, count))}${option(ALL_COUNT, 'All')}\t\t\t\t\t</select>
\t\t\t\t</div>
`;
}

// ---- Basic tab (edit.cfm 287-462) ----

/** The content pool multiselect when the site pools content from other sites, else its hidden input. */
function contentPoolControl(parts: Parts): SafeHtml {
  const { req, model, feed } = parts;
  if (model.contentPool.length <= 1) {
    return html`\t\t\t\t<input type="hidden" id="contentPoolID" name="contentPoolID" value="${raw(encodeHtmlAttr(feed.contentPoolID))}"/>
`;
  }
  const siteid = rcText(req, 'siteid');
  const others = model.contentPool
    .filter((pool) => !cfEq(pool.siteID, feed.siteID))
    .map(
      (pool) => html`\t\t\t\t\t\t\t\t\t\t\t\t<option value="${raw(encodeHtmlAttr(pool.siteID))}" ${listFind(feed.contentPoolID, pool.siteID) && raw('selected')}>${raw(encodeHtml(pool.site))}</option>
`,
    );
  return html`\t\t\t<div class="mura-control-group">
\t\t\t\t<label>
\t\t\t\t\t${parts.label('collections.contentpool')}
\t\t\t\t</label>
\t\t\t\t\t<select id="contentPoolID" name="contentPoolID" multiple>
\t\t\t\t\t\t\t\t\t<option value="${raw(siteid)}" ${listFind(feed.contentPoolID, siteid) && raw('selected')}>This site</option>
${others}\t\t\t\t\t\t\t\t\t</select>
\t\t\t\t</div>
`;
}

/** One section filter row: the hidden content id, its delete link, the crumb markup and the content type. */
function contentFilterRow(filter: FeedContentFilter): SafeHtml {
  const id = raw(filter.contentID);
  return html`\t\t\t\t\t\t\t\t\t\t<tr id="c${id}">
\t\t\t\t\t\t\t\t\t\t\t<td class="actions"><input type="hidden" name="contentID" value="${id}" /><ul class="clearfix"><li class="delete"><a title="Delete" href="#" onclick="feedManager.removeFilter('c${id}'); return false;"><i class="mi-trash"></i></a></li></ul></td>
\t\t\t\t\t\t\t\t\t\t\t<td class="var-width">${raw(filter.zoom)}</td>
\t\t\t\t\t\t\t\t\t\t\t<td>${raw(filter.type)}</td>
\t\t\t\t\t\t\t\t\t\t</tr>
`;
}

/** The section filters label, its select button and the filters table. */
function sectionFilters(parts: Parts): SafeHtml {
  const { req, model, label } = parts;
  const rows =
    model.contentFilters.length > 0
      ? html`${model.contentFilters.map(contentFilterRow)}`
      : html`\t\t\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t\t\t<td class="noResults" colspan="3" id="noFilters">${label('collections.nocontentfilters')}</td>
\t\t\t\t\t\t\t\t</tr>
`;
  return html`\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label('collections.basicfromsection')}: <span id="selectFilter"><a class="btn" href="javascript:;" onclick="javascript: feedManager.loadSiteFilters('${raw(rcText(req, 'siteid'))}','',1,$('#contentPoolID').val());return false;">${label('collections.selectnewsection')}</a></span></label>
\t\t\t\t<div class="mura-control justify">
\t\t\t\t\t<table id="contentFilters" class="mura-table-grid">
\t\t\t\t\t\t<thead>
\t\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t\t<th class="actions"></th>
\t\t\t\t\t\t\t\t<th class="var-width">${label('collections.section')}</th>
\t\t\t\t\t\t\t\t<th>${label('collections.type')}</th>
\t\t\t\t\t\t\t</tr>
\t\t\t\t\t\t</thead>
\t\t\t\t\t\t<tbody id="ContentFilters">
${rows}\t\t\t\t\t\t</tbody>
\t\t\t\t\t</table>
\t\t\t\t</div>
\t\t\t</div>
`;
}

/** The sort-by select: the fixed fields, comments and relevance where the site has them, then extended attributes. */
function sortBySelect(parts: Parts): SafeHtml {
  const { model, feed, rb } = parts;
  const indent = '\t\t\t\t\t\t\t';
  const fixed = (sorts: ReadonlyArray<readonly [string, string]>): SafeHtml[] =>
    sorts.map(([value, key]) => choiceOption([value, rb.rbKey(key)], cfEq(feed.sortBy, value), indent));
  const optional = (shown: boolean, value: string, key: string): SafeHtml[] =>
    shown ? fixed([[value, key]]) : [];
  const attributes = model.extendedAttributes.map(
    (attribute) => html`${raw(indent)}<option value="${raw(encodeHtmlAttr(attribute.attribute))}" ${cfEq(feed.sortBy, attribute.attribute) && raw('selected')}>${raw(attributeLabel(attribute))}</option>
`,
  );
  return html`\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${parts.label('collections.sortby')}</label>
\t\t\t\t\t\t<select name="sortBy">
${fixed(SORTS_BEFORE_COMMENTS)}${optional(model.siteHasComments, 'comments', 'params.comments')}${fixed(SORTS_AFTER_COMMENTS)}${optional(model.hasMarketingManager, 'mxpRelevance', 'params.mxpRelevance')}${fixed([['', 'params.donotapplysort']])}${attributes}\t\t\t\t\t\t</select>
\t\t\t\t\t</div>
`;
}

/** The Basic tab pane. */
function basicTab(parts: Parts): SafeHtml {
  const { req, model, feed, label } = parts;
  const direction = (value: string, key: string): SafeHtml =>
    choiceOption([value, parts.rb.rbKey(key)], cfEq(feed.sortDirection, value), '\t\t\t\t\t');
  const counts = model.useLayoutManager
    ? html`${countSelect(parts, 'collections.maxitems', 'maxItems', feed.maxItems)}${countSelect(parts, 'collections.itemsperpage', 'nextN', feed.nextN)}`
    : '';
  return html`\t<div id="tabBasic" class="tab-pane active">

\t\t<div class="block block-bordered">
\t\t\t<!-- block header -->
\t\t\t<div class="block-header">
\t\t\t\t<h3 class="block-title">${label('collections.basic')}</h3>
\t\t\t</div> <!-- /.block header -->
\t\t\t<div class="block-content">
\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label('collections.name')}</label>
\t\t\t\t<input type="text" name="name" required="true" message="${label('collections.namerequired')}" value="${raw(encodeHtmlAttr(feed.name))}" maxlength="250"${feed.isLocked && raw(' disabled="disabled"')} onchange="removePunctuation(this);">
\t\t\t</div>


${contentPoolControl(parts)}
${sectionFilters(parts)}
${sortBySelect(parts)}\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label('collections.sortdirection')}</label>
\t\t\t\t<select name="sortDirection">
${direction('asc', 'collections.ascending')}${direction('desc', 'collections.descending')}\t\t\t\t</select>
\t\t\t</div>
${counts}${basicRadioGroup(parts, 'collections.includefeaturesonly', 'isFeaturesOnly', feed.isFeaturesOnly)}${basicRadioGroup(parts, 'collections.shownavonly', 'showNavOnly', feed.showNavOnly)}
${basicRadioGroup(parts, 'collections.showexcludesearch', 'showExcludeSearch', feed.showExcludeSearch)}
${req.isS2 ? basicRadioGroup(parts, 'collections.isLocked', 'islocked', feed.isLocked) : ''}
\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.tab-pane -->
`;
}

// ---- Categorization and Advanced Filters tabs (edit.cfm 464-562) ----

/** The Categorization tab pane: the category checkbox tree and the intersection radios. */
function categorizationTab(parts: Parts): SafeHtml {
  const { model, feed, rb, label } = parts;
  const nest = renderFeedCategoriesNest({
    nodes: model.categories,
    nestLevel: 0,
    feedCategoryIds: feed.categoryID,
    categoryIds: '',
  });
  return html`<div id="tabCategorization" class="tab-pane">
\t<div class="block block-bordered">
\t\t\t<!-- block header -->
\t\t\t<div class="block-header">
\t\t\t\t<h3 class="block-title">${label('collections.categorization')}</h3>
\t\t\t</div> <!-- /.block header -->
\t\t\t<div class="block-content">

\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>${label('collections.categoryfilters')}</label>
\t\t\t\t\t<div id="mura-list-tree" class="mura-control">
\t\t\t\t\t\t${nest}
\t\t\t\t\t</div>
\t\t\t\t</div>
\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>
\t\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right"
\t\t\t\t\t\t\tdata-content="${raw(encodeHtmlAttr(rb.rbKey('collections.categoryintersectiontip')))}"
\t\t\t\t\t\t\tdata-original-title="${raw(encodeHtmlAttr(rb.rbKey('collections.categoryintersection')))}">
\t\t\t\t\t\t\t${label('collections.categoryintersection')}
\t\t\t\t\t\t\t<i class="mi-question-circle"></i>
\t\t\t\t\t\t</span>
\t\t\t\t\t</label>
${radioPair(parts, 'useCategoryIntersect', feed.useCategoryIntersect, false, '\t\t\t\t\t\t')}\t\t\t\t\t</div>

\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.tab-pane -->
`;
}

/** The remove and add links of a filter row; the remove link starts hidden on the default row. */
function filterLinks(hideRemove: boolean): SafeHtml {
  return html`\t\t\t\t\t\t<a class="criteria remove" href="javascript:;" onclick="$searchParams.removeSeachParam(this.parentNode);$searchParams.setSearchButtons();return false;"${hideRemove && raw(' style="display:none;"')}><i class="mi-minus-circle"></i></a>
\t\t\t\t\t\t<a class="criteria add" href="javascript:;" onclick="$searchParams.addSearchParam();$searchParams.setSearchButtons();return false;"${!hideRemove && raw(' ')}><i class="mi-plus-circle"></i></a>
`;
}

/** The single empty filter row shown when the collection has no advanced filters. */
function defaultFilterRow(parts: Parts, fields: readonly Choice[], conditions: readonly Choice[]): SafeHtml {
  const { label } = parts;
  const indent = '\t\t\t\t\t\t';
  const choice = ([value, text]: Choice): SafeHtml => html`${raw(indent)}<option value="${raw(value)}">${raw(text)}</option>
`;
  return html`\t\t\t\t<div class="mura-control justify">
\t\t\t\t\t<select name="paramRelationship1" style="display:none;" >
\t\t\t\t\t\t<option value="and">${label('params.and')}</option>
\t\t\t\t\t\t<option value="or">${label('params.or')}</option>
\t\t\t\t\t</select>
\t\t\t\t\t<input type="hidden" name="param" value="1" />
\t\t\t\t\t<select name="paramField1">
\t\t\t\t\t\t<option value="">${label('params.selectfield')}</option>
${fields.map(choice)}\t\t\t\t\t</select>
\t\t\t\t\t<select name="paramCondition1">
${conditions.map(choice)}\t\t\t\t\t</select>
\t\t\t\t\t<input type="text" name="paramCriteria1">
${filterLinks(true)}\t\t\t\t</div>
`;
}

/** One stored filter row; a filter without criteria selects `And` and no field or condition, as legacy does. */
function paramFilterRow(
  parts: Parts,
  param: FeedAdvancedParam,
  row: number,
  fields: readonly Choice[],
  conditions: readonly Choice[],
): SafeHtml {
  const hasCriteria = !cfEq(param.criteria, '');
  const indent = '\t\t\t\t\t\t';
  const fieldKey = `${param.field}^${param.dataType}`;
  return html`\t\t\t\t\t<div class="mura-control justify">
\t\t\t\t\t\t<select name="paramRelationship${row}">
\t\t\t\t\t\t\t<option value="and" ${(!hasCriteria || cfEq(param.relationship, 'and')) && raw('selected')} >And</option>
\t\t\t\t\t\t\t<option value="or" ${(hasCriteria && cfEq(param.relationship, 'or')) && raw('selected')} >Or</option>
\t\t\t\t\t\t</select>
\t\t\t\t\t\t<input type="hidden" name="param" value="${row}" />
\t\t\t\t\t\t<select name="paramField${row}">
\t\t\t\t\t\t<option value="">${parts.label('params.selectfield')}</option>
${fields.map((field) => choiceOption(field, hasCriteria && cfEq(fieldKey, field[0]), indent))}\t\t\t\t\t\t</select>
\t\t\t\t\t\t<select name="paramCondition${row}">
${conditions.map((condition) => choiceOption(condition, hasCriteria && cfEq(param.condition, condition[0]), indent))}\t\t\t\t\t\t</select>
\t\t\t\t\t\t<input type="text" name="paramCriteria${row}" value="${raw(encodeHtmlAttr(param.criteria))}" >
${filterLinks(false)}\t\t\t\t\t</div>
`;
}

/** The Advanced Filters tab pane: the default row, or one row per stored filter. */
function advancedFiltersTab(parts: Parts): SafeHtml {
  const { model, rb, label } = parts;
  const fields = fieldOptions(rb, model.extendedAttributes);
  const conditions = criteriaOptions(rb);
  const rows =
    model.advancedParams.length === 0
      ? defaultFilterRow(parts, fields, conditions)
      : html`${model.advancedParams.map((param, index) => paramFilterRow(parts, param, index + 1, fields, conditions))}`;
  return html`
<div id="tabAdvancedfilters" class="tab-pane">
\t<div class="block block-bordered">
\t\t<!-- block header -->
\t\t<div class="block-header">
\t\t\t<h3 class="block-title">${label('collections.advancedfilters')}</h3>
\t\t</div> <!-- /.block header -->
\t\t<div class="block-content">
\t\t\t<div class="mura-control-group" id="searchParams">
\t\t\t\t<label>${label('collections.chooseadvancedfilters')}</label>
${rows}\t\t</div>
\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.tab-pane -->
`;
}

// ---- Display tab (edit.cfm 565-696) ----

/** The image size select: the core sizes, the site's custom sizes, then `custom`. */
function imageSizeSelect(parts: Parts): SafeHtml {
  const { model, feed, prefix } = parts;
  const core = IMAGE_SIZES.map(
    (size) => html`\t\t\t\t\t\t<option value="${raw(size.toLowerCase())}"${cfEq(size, feed.imageSize) && raw(' selected')}>${raw(size)}</option>
`,
  );
  const custom = model.customImageSizes.map(
    (name) => html`\t\t\t\t\t\t<option value="${raw(name.toLowerCase())}"${cfEq(name, feed.imageSize) && raw(' selected')}>${raw(encodeHtml(name))}</option>
`,
  );
  return html`\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${parts.label('collections.imagesize')}</label>
\t\t\t\t<select name="${raw(prefix)}imageSize" data-displayobjectparam="imageSize" onchange="if(this.value=='custom'){jQuery('#feedCustomImageOptions').fadeIn('fast')}else{jQuery('#feedCustomImageOptions').hide();jQuery('#feedCustomImageOptions').find(':input').val('AUTO');}">
${core}
${custom}\t\t\t\t\t<option value="custom"${cfEq('custom', feed.imageSize) && raw(' selected')}>Custom</option>
\t\t\t\t</select>
\t\t</div>
`;
}

/** The custom width and height inputs, hidden unless the image size is `custom`. */
function customImageOptions(parts: Parts): SafeHtml {
  const { feed, prefix, label } = parts;
  return html`\t\t<div id="feedCustomImageOptions" class="mura-control-group"${!cfEq(feed.imageSize, 'custom') && raw(' style="display:none"')}>
\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label('collections.imagewidth')}</label>
\t\t\t\t<input class="mura-constrain numeric" name="${raw(prefix)}imageWidth" data-displayobjectparam="imageWidth" type="text" value="${raw(feed.imageWidth)}" />
\t\t\t</div>

\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label('collections.imageheight')}</label>
\t\t\t\t<input class="mura-constrain numeric" name="${raw(prefix)}imageHeight" data-displayobjectparam="imageHeight" type="text" value="${raw(feed.imageHeight)}" />
\t\t\t</div>
\t\t</div>
`;
}

/** The display-name radios, whose Yes input legacy writes with no space before `checked`, and the alternate name. */
function displayNameControls(parts: Parts): SafeHtml {
  const { feed, prefix, label } = parts;
  const p = raw(prefix);
  return html`\t<div class="mura-control-group">
\t\t<label>${label('collections.displayname')}</label>
\t\t<label class="radio inline">
\t\t\t<input name="${p}displayName" data-displayobjectparam="displayName" type="radio" value="1" class="radio" onchange="jQuery('#altNameContainer').toggle();"${feed.displayName && raw('checked')}>
\t\t\t${label('collections.yes')}
\t\t</label>
\t\t<label class="radio inline">
\t\t\t<input name="${p}displayName" data-displayobjectparam="displayName" type="radio" value="0" class="radio" onchange="jQuery('#altNameContainer').toggle();" ${!feed.displayName && raw('checked')}>
\t\t\t${label('collections.no')}
\t\t</label>
\t</div>

\t<div class="mura-control-group" id="altNameContainer" ${!feed.displayName && raw(' style="display:none;"')}>
\t\t<label>${label('collections.altname')}</label>
\t\t<input name="${p}altName" data-displayobjectparam="altName" type="text" value="${raw(encodeHtmlAttr(feed.altName))}" maxlength="250">
\t</div>
`;
}

/** The class, view-all link and view-all label inputs; the link's display-object param keeps legacy's `viewallink`. */
function linkControls(parts: Parts): SafeHtml {
  const { feed, label } = parts;
  return html`\t<div class="mura-control-group">
\t\t<label>
\t\t\t${label('collections.cssclass')}
\t\t</label>
\t\t<input name="cssclass"  data-displayobjectparam="cssclass" type="text" value="${raw(encodeHtmlAttr(feed.cssClass))}" maxlength="255">
\t</div>

\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>
\t\t\t${label('collections.viewalllink')}
\t\t</label>
\t\t\t\t\t\t<input name="viewalllink" data-displayobjectparam="viewallink" type="text" value="${raw(encodeHtmlAttr(feed.viewAllLink))}" maxlength="255">
\t</div>

\t\t\t\t<div class="mura-control-group">
\t\t\t\t\t<label>
\t\t\t${label('collections.viewalllabel')}
\t\t</label>
\t\t\t\t\t<input name="viewalllabel" data-displayobjectparam="viewalllabel" type="text" value="${raw(encodeHtmlAttr(feed.viewAllLabel))}" maxlength="100">
\t</div>
`;
}

/** The available and selected display-field lists, their hidden list input and the sortable set-up script. */
function displayListControls(parts: Parts): SafeHtml {
  const { feed, prefix } = parts;
  const items = (list: string, cls: string): SafeHtml[] =>
    cfListToArray(list).map(
      (field) => html`\t\t\t\t\t\t\t<li class="${cls}">${raw(javaTrim(field))}</li>
`,
    );
  return html`\t\t\t\t<div class="mura-control-group" id="availableFields">
\t\t\t\t\t\t<label>
\t\t\t\t\t<span class="half">Available Fields</span> <span class="half">Selected Fields</span>
\t\t\t\t</label>
\t\t\t\t<div id="sortableFields">
\t\t\t\t\t<p class="dragMsg">
\t\t\t\t\t\t\t\t\t\t<span class="dragFrom half">Drag Fields from Here&hellip;</span><span class="half">&hellip;and Drop Them Here.</span>
\t\t\t\t\t</p>

\t\t\t\t\t<ul id="availableListSort" class="displayListSortOptions">
${items(feed.availableDisplayList, 'ui-state-default')}\t\t\t\t\t</ul>

\t\t\t\t\t<ul id="displayListSort" class="displayListSortOptions">
${items(feed.displayList, 'ui-state-highlight')}\t\t\t\t\t</ul>
\t\t\t\t\t<input type="hidden" id="displayList" value="${raw(feed.displayList)}" name="${raw(prefix)}displayList"  data-displayobjectparam="displayList"/>
\t\t\t\t</div>
\t\t\t\t<script>
\t\t\t\t\tjQuery(document).ready(
\t\t\t\t\t\tfunction(){
\t\t\t\t\t\t\tfeedManager.setDisplayListSort();
\t\t\t\t\t\t}
\t\t\t\t\t);
\t\t\t\t</script>
\t\t\t</div>
`;
}

/** The Display tab pane; its block title is the defaults label even for an instance, which adds the feed name. */
function displayTab(parts: Parts): SafeHtml {
  const { model, feed, label } = parts;
  return html`<div id="tabDisplay" class="tab-pane">

\t<div class="block block-bordered">
\t\t<!-- block header -->
\t\t<div class="block-header">
\t\t\t<h3 class="block-title">${label('collections.displaydefaults')}</h3>
\t\t</div> <!-- /.block header -->
\t\t<div class="block-content">
\t\t${model.isObjectInstance && html`<h2>${raw(encodeHtml(feed.name))}</h2>`}
${imageSizeSelect(parts)}
${customImageOptions(parts)}
${displayNameControls(parts)}
${linkControls(parts)}
${countSelect(parts, 'collections.maxitems', 'maxItems', feed.maxItems)}
${countSelect(parts, 'collections.itemsperpage', 'nextN', feed.nextN)}
${displayListControls(parts)}\t\t\t</div> <!-- /.block-content -->
\t\t</div> <!-- /.block-bordered -->
\t</div> <!-- /.tab-pane -->
`;
}

// ---- RSS tab (edit.cfm 699-790) ----

/** The member (`isPublic` 1) or admin (`isPublic` 0) groups' optgroup; nothing when there are none. */
function restrictGroupOptgroup(parts: Parts, isPublic: boolean, labelKey: string): SafeHtml {
  const { model, feed, rb } = parts;
  const groups = model.restrictGroups.filter((group) => group.isPublic === isPublic);
  if (groups.length === 0) return html``;
  return html`\t\t\t\t\t<optgroup label="${raw(encodeHtmlAttr(rb.rbKey(labelKey)))}">
${groups.map(
  (group) => html`\t\t\t\t\t<option value="${raw(group.userID)}" ${listFind(feed.restrictGroups, group.userID) && raw('Selected')}>${raw(group.groupName)}</option>
`,
)}\t\t\t\t\t</optgroup>
`;
}

/** The restrict-access checkbox and group multiselect of an extranet site. */
function restrictAccess(parts: Parts): SafeHtml {
  const { feed, rb, label } = parts;
  return html`\t\t\t<div class="mura-control-group">
\t\t\t\t<label>${label('collections.access')}</label>
\t\t\t\t<label class="checkbox">
\t\t\t\t\t<input name="restricted" type="checkbox" value="1"   onclick="javascript: this.checked?toggleDisplay2('rg',true):toggleDisplay2('rg',false);" ${feed.restricted && raw('checked ')} class="checkbox">
\t\t\t\t\t\t${label('collections.restrictaccess')}
\t\t\t\t</label>
\t\t\t\t<div id="rg" class="mura-control" ${!feed.restricted && raw('style="display:none;"')}>
\t\t\t\t\t<select name="restrictgroups" size="8" multiple="multiple" class="multiSelect" id="restrictGroups">
\t\t\t\t\t<optgroup label="${raw(encodeHtmlAttr(rb.rbKey('sitemanager.content.fields.globalsettings')))}">
\t\t\t\t\t<option value="RestrictAll" ${cfEq(feed.restrictGroups, 'RestrictAll') && raw('selected')}>${label('sitemanager.content.fields.restrictall')}</option>
\t\t\t\t\t<option value="" ${cfEq(feed.restrictGroups, '') && raw('selected')}>${label('sitemanager.content.fields.allowall')}</option>
\t\t\t\t\t</optgroup>
${restrictGroupOptgroup(parts, true, 'user.membergroups')}${restrictGroupOptgroup(parts, false, 'user.adminusergroups')}\t\t\t\t\t</select>
\t\t\t\t</div> <!-- /#rg.mura-control -->
\t\t\t</div> <!-- mura-control-group -->
`;
}

/** The RSS tab pane; the feed URL row appears once the collection has an id. */
function rssTab(parts: Parts): SafeHtml {
  const { req, model, feed, label } = parts;
  const urlRow = (): SafeHtml => {
    const url = raw(`${feedApiEndpoint(req, model.endpoint)}/?feedID=${feed.feedID}`);
    return html`\t\t\t<div class="mura-control-group">
\t\t\t <label>${label('collections.url')}</label>
\t\t\t <a title="${label('collections.view')}" href="${url}" target="_blank">${url}</a>
\t\t\t</div>
`;
  };
  const radios = (labelKey: string, name: string, on: boolean): SafeHtml => html`\t\t<div class="mura-control-group">
\t\t\t<label>${label(labelKey)}</label>
${radioPair(parts, name, on, false, '\t\t\t')}\t\t</div>
`;
  const versions = RSS_VERSIONS.map((version) => choiceOption([version, version], cfEq(feed.version, version), '\t\t\t'));
  return html`<div id="tabRss" class="tab-pane">

\t<div class="block block-bordered">
\t\t<!-- block header -->
\t\t<div class="block-header">
\t\t\t<h3 class="block-title">${label('collections.rss')}</h3>
\t\t</div> <!-- /.block header -->
\t\t<div class="block-content">

${rcText(req, 'feedID') !== '' && urlRow()}
\t\t<div class="mura-control-group">
\t\t\t<label>${label('collections.description')}</label>
\t\t\t<textarea rows="6" name="description">${raw(encodeHtmlAttr(feed.description))}</textarea>
\t\t</div>

${radios('collections.allowhtml', 'allowHTML', feed.allowHTML)}
${radios('collections.isPublic', 'isPublic', feed.isPublic)}
\t\t<div class="mura-control-group">
\t\t\t<label>${label('collections.version')}</label>
\t\t\t<select name="version" class="dropdown">
${versions}\t\t\t</select>
\t\t</div>

\t\t<div class="mura-control-group">
\t\t\t<label>${label('collections.language')}</label>
\t\t\t<input name="lang" type="text" value="${raw(encodeHtmlAttr(feed.lang))}" maxlength="50">
\t\t</div>

${model.siteExtranet && restrictAccess(parts)}
\t\t</div> <!-- /.block-content -->
\t</div> <!-- /.block-bordered -->
</div> <!-- /.tab-pane -->
`;
}

// ---- Form assembly (edit.cfm 218-281, 798-881) ----

/** The `mura-header`: the create or edit title and, outside compact display, the secondary menu. */
function header(parts: Parts, compact: boolean, fuseaction: string): SafeHtml {
  const { req, model, feed, rb, label } = parts;
  const title = feed.isNew
    ? 'collections.createlocalindex'
    : rcText(req, 'assignmentID') !== ''
      ? 'collections.editlocalindexinstance'
      : 'collections.editlocalindex';
  const menuFeed = { feedId: feed.feedID, type: feed.type, isNew: feed.isNew, channelLink: feed.channelLink };
  const menu = compact
    ? ''
    : html`\t\t${renderCfeedSecondaryMenu(req, rb, { fuseaction, feed: menuFeed, endpoint: model.endpoint })}
`;
  return html`<div class="mura-header">

\t\t<h1>${label(title)}</h1>

${menu}</div> <!-- /.mura-header -->


`;
}

/** The validation errors, then the globally-applied notice of a saved collection in compact display. */
function alerts(parts: Parts, compact: boolean): SafeHtml {
  const { model, feed, label } = parts;
  const errors =
    Object.keys(model.errors).length > 0
      ? html`\t<div class="alert alert-error"><span>${displayErrors(model.errors)}</span></div>
`
      : '';
  const notice =
    feed.exists && compact && !model.isObjectInstance
      ? html`\t<div class="alert alert-info"><span>${label('sitemanager.content.globallyappliednotice')}</span></div>
`
      : '';
  return html`${errors}
${notice}
`;
}

/** The instance edit's link to the collection's default settings, values written unencoded. */
function defaultSettingsNav(parts: Parts): SafeHtml {
  const { req, feed, label } = parts;
  const editLink = raw(
    `?muraAction=cFeed.edit&amp;siteid=${feed.siteID}&amp;feedid=${feed.feedID}&amp;type=${feed.type}` +
      `&amp;homeID=${rcText(req, 'homeID')}&amp;compactDisplay=true`,
  );
  return html`\t<ul class="navTask nav nav-pills">
\t\t<li><a href="${editLink}">${label('collections.editdefaultsettings')}</a></li>
\t</ul>
`;
}

/** The submit buttons and hidden fields: Add for a new collection, else Delete (outside compact) and Update. */
function actionButtons(parts: Parts, compact: boolean, csrf: SafeHtml): SafeHtml {
  const { req, model, feed, rb, label } = parts;
  const rcAttr = (name: string): SafeHtml => raw(encodeHtmlAttr(rcText(req, name)));
  const update = model.isObjectInstance
    ? html`\t\t\t<button class="btn" onclick="updateInstanceObject();submitForm(document.forms.form1,'update');return false;"><i class="mi-check-circle"></i>${label('collections.update')}</button>
`
    : html`\t\t\t<button class="btn mura-primary" onclick="submitForm(document.forms.form1,'update');return false;"><i class="mi-check-circle"></i>${label('collections.update')}</button>
`;
  const deleteButton = html`\t\t\t<button class="btn" onclick="submitForm(document.forms.form1,'delete','${raw(encodeJs(rb.rbKey('collections.deletelocalconfirm')))}');return false;"><i class="mi-trash"></i>${label('collections.delete')}</button>
`;
  const submit =
    rcText(req, 'feedID') === ''
      ? html`\t\t<button class="btn mura-primary" onclick="submitForm(document.forms.form1,'add');"><i class="mi-check-circle"></i>${label('collections.add')}</button>
\t\t<input type="hidden" name="feedID" value="">
\t\t<input type="hidden" name="action" value="add">
`
      : html`${!compact && deleteButton}${update}${compact && html`\t\t\t<input type="hidden" name="homeID" value="${rcAttr('homeID')}" />
`}\t\t<input type=hidden name="feedID" value="${raw(feed.feedID)}">
\t\t<input type="hidden" name="action" value="update">
`;
  return html`<div class="mura-actions">
\t<div class="clearfix form-actions">
${submit}\t<input type="hidden" name="type" value="Local"><input name="isActive" type="hidden" value="1" />
\t<input type="hidden" id="instanceParams" value='${raw(feed.instanceParams)}' name="instanceParams" />
\t<input type="hidden" name="assignmentID" value="${rcAttr('assignmentID')}" />
\t<input type="hidden" name="orderno" value="${rcAttr('orderno')}" />
\t<input type="hidden" name="regionid" value="${rcAttr('regionID')}" />
\t<input type=hidden name="instanceid" value="${rcAttr('instanceid')}">
\t<input type="hidden" name="closeCompactDisplay" value="${rcAttr('compactDisplay')}" />
\t${csrf}
\t</div>
</div>
`;
}

/** CFML `listGetAt(list, index)` over a list already split into items; throws past the end as CFML does. */
function listGetAt(items: readonly string[], index: number): string {
  const item = items[index - 1];
  if (item === undefined) throw new RangeError(`Invalid list index ${index}: the list has ${items.length} elements`);
  return item;
}

/** The tab strip; legacy joins the labels into a comma list and splits it again, so each tab takes that item. */
function tabNav(tabList: string, tabLabelList: string): SafeHtml {
  const labels = cfListToArray(tabLabelList);
  const items = cfListToArray(tabList).map(
    (id, index) => html`\t\t<li${index === 0 && raw(' class="active"')}><a href="#${raw(id)}" onclick="return false;"><span>${raw(listGetAt(labels, index + 1))}</span></a></li>
`,
  );
  return html`\t\t<ul class="mura-tabs nav-tabs" data-toggle="tabs">
${items}\t\t</ul>
`;
}

/** The compact display's `cfhtmlhead` script, which sizes the front-end modal for the instance or standard form. */
function compactHtmlHead(assigned: boolean): SafeHtml {
  const post = raw(`frontEndProxy.post({cmd:'setWidth',width:'${assigned ? 'configurator' : 'standard'}'});`);
  return html`
<script type="text/javascript">
jQuery(document).ready(function(){
\tif (top.location != self.location) {
\t\tif(jQuery("#ProxyIFrame").length){
\t\t\tjQuery("#ProxyIFrame").load(
\t\t\t\tfunction(){
\t\t\t\t\t${post}
\t\t\t\t}
\t\t\t);
\t\t} else {
\t\t\t${post}
\t\t}
\t}
});
</script>

`;
}

/**
 * Renders the Local branch of `cfeed/edit.cfm`: the index edit form, or the display options of a display object
 * instance (`rc.assignmentID` set), with the compact display's `cfhtmlhead` script.
 * @param req The request whose `rc` the view reads, the cfeed `before()` defaults applied.
 * @throws GatewayDenialError When identity refuses the CSRF tokens of the collection (401 or 403).
 */
export async function renderFeedEditLocal(
  req: AdminRequest,
  ctx: ScreenContext,
  model: FeedEditModel,
  { fuseaction }: FeedEditLocalOptions,
): Promise<FeedEditBranchView> {
  const { feed } = model;
  await ctx.csrf.prefetch([feed.feedID]);
  const parts: Parts = {
    req,
    model,
    feed,
    rb: ctx.rb,
    label: (key) => raw(ctx.rb.rbKey(key)),
    prefix: model.isObjectInstance ? 'instance' : '',
  };
  // The compact layout is chosen by the same `rc.compactDisplay eq 'true'` test the view makes.
  const compact = selectLayout(req.rc) === 'compact';
  const assigned = rcText(req, 'assignmentID') !== '';
  const instance = model.isObjectInstance;
  const usage =
    !instance && model.showUsageTabs && rcText(req, 'feedID') !== ''
      ? renderFeedUsageTab(req, ctx.rb, { feedType: feed.type, rows: model.usage })
      : undefined;

  const tabs = tabKeys(model);
  let tabList = tabs.map(([id]) => id).join(',');
  let tabLabelList = tabs.map(([, key]) => ctx.rb.rbKey(key)).join(',');
  if (usage !== undefined) {
    tabLabelList = cfListAppend(tabLabelList, usage.label);
    tabList = cfListAppend(tabList, usage.tabId);
  }

  const indexTabs = html`${basicTab(parts)}
${model.hasCategories && categorizationTab(parts)}${advancedFiltersTab(parts)}`;
  const tabContent = html`
${!instance && indexTabs}${!model.useLayoutManager && displayTab(parts)}${!instance && html`${rssTab(parts)}
${usage?.html}`}
`;
  const content = instance
    ? html`\t${tabContent}
`
    : html`${tabNav(tabList, tabLabelList)}\t\t<div class="block-content tab-content">
\t\t\t${tabContent}
\t\t\t<div class="load-inline tab-preloader"></div>
\t\t\t<script>$('.tab-preloader').spin(spinnerArgs2);</script>
\t\t</div>
`;
  const formAction = raw(`./?muraAction=cFeed.update&siteid=${encodeUrl(rcText(req, 'siteid'))}`);

  const body = html`${header(parts, compact, fuseaction)}${alerts(parts, compact)}<span id="msg">
${raw(model.pluginMessage)}
</span>

<form novalidate="novalidate" action="${formAction}" method="post" name="form1" id="feedFrm" onsubmit="return validate(this);"${assigned && raw(' style="width: 412px"')}>

<div class="block block-constrain">

${instance && defaultSettingsNav(parts)}
<!-- Content Filters -->
${content}

\t\t\t${actionButtons(parts, compact, ctx.csrf.render(feed.feedID, 'form'))}
</div> <!-- /.block-constrain -->
</form>

<script type="text/javascript">
$searchParams.setSearchButtons();
</script>
`;
  return compact ? { body, htmlHead: compactHtmlHead(assigned) } : { body };
}
