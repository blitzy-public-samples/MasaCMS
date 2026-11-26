// Categorization panel of the content edit form (`admin/core/views/carch/form/dsp_panel_categories.cfm`), server-only.
import { cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import { encodeHtmlAttr, raw } from '@/lib/html';
import type { ScreenContext } from '../../registry';
import {
  renderEditCategoriesNest,
  type EditCategoriesNestInput,
  type EditCategoryAssignment,
  type EditCategoryNode,
} from './categories-nest';
import type { EditPageData, PanelResult } from './custom-tags';

// The strings are the include's bytes as ACF 2023 emits them, from the newline after `<cfoutput>` through `</script>`
// and the file's final newline: CFML comments are dropped and the text around them joins, `##` prints `#`, and trailing
// whitespace is written as escapes. Of the whitespace-only text between the CFML tags, only the run after each ancestor
// trigger line prints, as one space, because that line ends in non-whitespace output.

const PANEL_HEADING = `
<div class="mura-panel panel">
	<div class="mura-panel-heading" role="tab" id="heading-categories">
		<h4 class="mura-panel-title">
			<a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" href="#panel-categories" aria-expanded="false" aria-controls="panel-categories">`;

const FLYOUT_OPEN = `</a>
		</h4>
	</div>
		<div id="panel-categories" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-categories" aria-expanded="false" style="height: 0px;">
			<div class="mura-panel-body">

				<span id="extendset-container-tabcategorizationtop" class="extendset-container"></span>

				<div class="mura-control-group">
					<div id="categories__selected"></div>

\t\t\t\t\t
\t\t\t\t\t
					<div class="bigui" id="bigui__categories" data-label="Manage Categories">
						<div class="bigui__title">`;

const GRID_HEADER_OPEN = `</div>
						<div class="bigui__controls">

								<div class="mura-control-group">
									<div class="mura-grid stripe" id="mura-grid-categories">
										<dl class="mura-grid-hdr">
											<dt class="categorytitle">
													`;

const FEATURE_CELL_OPEN = `
											</dt>
											<dd class="categoryassignmentwrapper">
\t\t\t\t\t\t\t\t\t\t\t\t
															`;

const GRID_HEADER_CLOSE = `
											</dd>
										</dl>
											`;

const PANEL_CLOSE_SCRIPT_OPEN = `

									</div>
								</div>

						</div>
					</div>\x20
				</div>\x20\t

				<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-categorization">
					<div class="bigui" id="bigui__categorization" data-label="Manage Extended Attributes">
						<div class="bigui__title">Manage Extended Attributes</div>
						<div class="bigui__controls">
							<span id="extendset-container-tabextendedattributestop"></span>
							<span id="extendset-container-categorization" class="extendset-container extendedattributes-body" data-controlparent="extendedattributes-container-categorization"></span>
							<span id="extendset-container-tabextendedattributesbottom"></span>
						</div>
					</div>
\t\t\t\t\t
				</div>

				<span id="extendset-container-tabcategorizationbottom" class="extendset-container"></span>
		</div>
	</div>
</div>\x20


<script>
	siteManager.initCategoryAssignments();

	var stripeCategories=function() {
			var counter=0;
			//alert($('#bigui__categories dl').length)
			$('#bigui__categories dl').each(
				function(index) {
					//alert(index)
					if(index && !$(this).parents('ul.categorylist:hidden').length)
					{
						//alert($(this).parents('ul.categorylist').length);
						counter++;
						//alert(counter)
						if(counter % 2) {
							$(this).addClass('alt');
						} else {
							$(this).removeClass('alt');
						}
					}
			});
			//alert(counter)
		}

	$(document).ready(function(){

		var catsInited=false;

		$('.hasChildren').click(function(){
			if(catsInited){
				$(this).closest('li').find('ul.categorylist:first').toggle();
				$(this).toggleClass('open');
				$(this).toggleClass('closed');
				stripeCategories();
			} else {
				$(this).closest('li').find('ul.categorylist:first').show();
				if(!$(this).hasClass('open')){
					$(this).toggleClass('open').toggleClass('closed');
				}
			}
		});

		`;

const SCRIPT_CLOSE = `

		catsInited=true;

		stripe('stripe');

		// display selected categories in text format
		var showSelectedCats = function(){\t
			var catList = '';
			var delim = '&nbsp;&raquo;&nbsp;';
			// create list of selected categories
			$('#mura-grid-categories #mura-nodes li .categorytitle label').each(function(){
				if($(this).find('input[type=checkbox]').prop('checked')){
					var appendStr = '';
					$(this).parentsUntil($('#mura-nodes'), 'li').each(function(){
						var labelText = $(this).find('> dl > dt > label').text();
						if(labelText.trim().length > 0){
							var curStr = appendStr;
							appendStr = labelText.trim();
							if (curStr.trim().length > 0){
							 appendStr = appendStr + delim + curStr;
							}
						}
					});
					catList = catList + '<li>' + appendStr + '</li>';
				}
			})
\t\t\t
			if (catList.trim().length > 0){
				$('#categories__selected').html('<label>Selected</label><ul>' + catList + '</ul>');
			} else {
				$('#categories__selected').html('<label>Selected</label><div>No categories selected</div>');
			}

		}
		// run on page load
		showSelectedCats();
		// run on change of selection
		$('#mura-grid-categories #mura-nodes li .categorytitle input[type=checkbox]').on('click',function(){
			showSelectedCats();
		})

	});
</script>
`;

/** What the panel reads; an `EditFormInput` satisfies it. */
export interface CategoriesPanelInput {
  /** Labels, the session date settings and the request's `rc.siteID`. */
  readonly ctx: EditCategoriesNestInput['ctx'] & { readonly req: Pick<ScreenContext['req'], 'rc'> };
  /** The edit model; see {@link renderCategoriesPanel} for the `rc` values it must hold. */
  readonly data: EditPageData;
}

type Struct = Readonly<Record<string, unknown>>;

/** A category of `rc.categories`, with the columns the ancestor-open script reads. */
interface CategoryTreeNode extends EditCategoryNode {
  /** `tcontentcategories.siteID`, the site's category pool. */
  readonly siteId: string;
  /** Comma list of the (possibly quoted) ids from the root down to the category itself. */
  readonly path: string;
  readonly children: readonly CategoryTreeNode[];
}

/** What `rsIsMember` is computed from: the content bean and `rc.rsCategoryAssign`. */
interface AssignmentSource {
  readonly bean: Struct;
  readonly contentHistId: string;
  readonly rows: readonly Struct[];
}

/** `categoryFeed` iterates its first page only (`nextN` 1000). */
const FEED_PAGE_SIZE = 1000;

/** `order by tcontentcategories.name`: SQL Server's case-insensitive, accent-sensitive collation, approximated. */
const NAME_ORDER = new Intl.Collator('en', { sensitivity: 'accent' });

const NOT_ASSIGNED: EditCategoryAssignment = { recordcount: 0, isFeature: '', featureStart: '', featureStop: '' };

// The edit model's CFML values are read by these local helpers rather than `../model`, which this panel does not import.
const isStruct = (value: unknown): value is Struct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A struct value by case-insensitive key, as CFML reads it; undefined when absent. */
function fieldOf(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A simple value as CFML text: SQL NULL reads `''`, an absent key `undefined`; complex values throw. */
function simpleText(struct: Struct, key: string): string | undefined {
  const value = fieldOf(struct, key);
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${key} is not a simple value`);
}

/** A bean's `getValue(key)`: absent and NULL read `''`. */
const beanValue = (bean: Struct, key: string): string => simpleText(bean, key) ?? '';

/** A column the edit model must supply; throws when `where` lacks it. */
function column(row: Struct, key: string, where: string): string {
  const text = simpleText(row, key);
  if (text === undefined) throw new TypeError(`${where} has no ${key}`);
  return text;
}

/** The struct array under `key`; throws unless `where` holds one. */
function rowsAt(struct: Struct, key: string, where: string): readonly Struct[] {
  const value = fieldOf(struct, key);
  if (!Array.isArray(value) || !value.every(isStruct)) throw new TypeError(`${where} holds no ${key} rows`);
  return value;
}

/** The struct under `key`; throws unless `where` holds one. */
function structAt(struct: Struct, key: string, where: string): Struct {
  const value = fieldOf(struct, key);
  if (!isStruct(value)) throw new TypeError(`${where} holds no ${key} struct`);
  return value;
}

/**
 * `rsIsMember` of one category: the version's `rsCategoryAssign` rows (a case-sensitive query of queries) unless the
 * bean holds a posted `categoryAssign<trim>`, whose re-render reads the bean's own values.
 */
function assignmentOf(source: AssignmentSource, categoryId: string): EditCategoryAssignment {
  const trim = categoryId.replaceAll('-', '');
  const posted = beanValue(source.bean, `categoryAssign${trim}`);
  if (posted === '') {
    const where = 'rc.rsCategoryAssign';
    const rows = source.rows.filter(
      (row) =>
        column(row, 'categoryID', where) === categoryId && column(row, 'contentHistID', where) === source.contentHistId,
    );
    const first = rows[0];
    if (first === undefined) return NOT_ASSIGNED;
    return {
      recordcount: rows.length,
      isFeature: column(first, 'isFeature', where),
      featureStart: column(first, 'featureStart', where),
      featureStop: column(first, 'featureStop', where),
    };
  }
  return {
    recordcount: cfListToArray(beanValue(source.bean, 'categoryID')).indexOf(categoryId) + 1,
    isFeature: posted,
    featureStart: beanValue(source.bean, `featureStart${trim}`),
    featureStop: beanValue(source.bean, `featureStop${trim}`),
  };
}

/** One `rc.categories` node and its descendants, each with its assignment. */
function treeNode(source: AssignmentSource, row: Struct): CategoryTreeNode {
  const where = 'A category of rc.categories';
  const categoryId = column(row, 'categoryID', where);
  const isFeatureable = column(row, 'isFeatureable', where);
  const hasKids = Number(column(row, 'hasKids', where));
  if (!Number.isFinite(hasKids)) throw new TypeError(`${where} has a non-numeric hasKids`);
  const permitted = fieldOf(row, 'permitted');
  if (typeof permitted !== 'boolean') throw new TypeError(`${where} has no permitted flag`);
  const children = fieldOf(row, 'children') == null ? [] : rowsAt(row, 'children', where);
  return {
    categoryId,
    siteId: column(row, 'siteID', where),
    name: column(row, 'name', where),
    isOpen: cfEq(column(row, 'isOpen', where), '1') ? 1 : 0,
    isFeatureable: isFeatureable === '' ? '' : cfEq(isFeatureable, '1') ? 1 : 0,
    hasKids,
    permitted,
    path: column(row, 'path', where),
    children: children.map((child) => treeNode(source, child)),
    assignment: assignmentOf(source, categoryId),
  };
}

/** `nodes` and their descendants, depth first in render order. */
function flatten(nodes: readonly CategoryTreeNode[]): CategoryTreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/**
 * The `categoryFeed` of `request.opencategorylist`: the assigned categories whose `siteID` is the request's site (the
 * feed's site filter, case-insensitive as SQL Server compares it, so a pooled tree yields none), by name.
 */
function openCategoryFeed(
  nodes: readonly CategoryTreeNode[],
  openIds: readonly string[],
  siteId: string,
): CategoryTreeNode[] {
  const open = new Set(openIds);
  const site = siteId.toLowerCase();
  return flatten(nodes)
    .filter((node) => open.has(node.categoryId) && node.siteId.toLowerCase() === site)
    .sort((a, b) => NAME_ORDER.compare(a.name, b.name))
    .slice(0, FEED_PAGE_SIZE);
}

/** One click on the toggle of each not yet opened ancestor of the feed's categories, each followed by a space. */
function ancestorTriggers(categories: readonly CategoryTreeNode[]): string {
  const opened = new Set<string>();
  let out = '';
  for (const category of categories) {
    for (const element of cfListToArray(category.path).slice(0, -1)) {
      const item = element.replaceAll("'", '');
      // `listFind(itemList, '')` is always 0, so an empty element emits every time, as legacy's does.
      if (item !== '' && opened.has(item)) continue;
      out += `$('#bigui__categories li[data-categoryid="${item}"]').find('span.hasChildren:first').trigger('click'); `;
      opened.add(item);
    }
  }
  return out;
}

/**
 * The Categorization panel include. Reads, of the edit model's `rc`: `contentBean` (`siteID`, `contentHistID`,
 * `categoryID` and, on a re-render, `categoryAssign<trim>`, `featureStart<trim>` and `featureStop<trim>`);
 * `categories`, the root level of `categoryManager.getCategories(rc.siteID)` with each level in that order, every node
 * holding `categoryID`, `siteID`, `name`, `isOpen`, `isFeatureable`, `hasKids`, `path`, `permitted`
 * (`permUtility.getCategoryPerm` for the session user) and `children`; and `rsCategoryAssign`, the
 * `getCategoriesByHistID(contentHistID)` rows with `categoryID`, `contentHistID`, `isFeature`, `featureStart` and
 * `featureStop`. Labels print unencoded except the flyout title, as legacy prints them.
 * @throws TypeError When the edit model lacks one of those values.
 */
export function renderCategoriesPanel(input: CategoriesPanelInput): PanelResult {
  const { rb, req } = input.ctx;
  const { rc } = input.data;
  const bean = structAt(rc, 'contentBean', 'rc');
  const source: AssignmentSource = {
    bean,
    contentHistId: beanValue(bean, 'contentHistID'),
    rows: rowsAt(rc, 'rsCategoryAssign', 'rc'),
  };
  const nodes = rowsAt(rc, 'categories', 'rc').map((row) => treeNode(source, row));
  const siteId = req.rc.siteid ?? '';
  const nest = renderEditCategoriesNest(input, { nodes, parentId: '', nestLevel: 0, disabled: false, siteId });
  const tabLabel = rb.rbKey('sitemanager.content.tabs.categorization');
  const available = rb.rbKey('sitemanager.content.fields.availablecategories');
  const triggers = ancestorTriggers(openCategoryFeed(nodes, nest.openCategoryIds, siteId));
  const markup = [
    PANEL_HEADING, tabLabel, FLYOUT_OPEN, encodeHtmlAttr(available), GRID_HEADER_OPEN, available, FEATURE_CELL_OPEN,
    rb.rbKey('sitemanager.content.fields.feature'), GRID_HEADER_CLOSE, nest.html.value, PANEL_CLOSE_SCRIPT_OPEN,
    triggers, SCRIPT_CLOSE,
  ];
  return { html: raw(markup.join('')), tabId: 'tabCategorization', tabLabel };
}
