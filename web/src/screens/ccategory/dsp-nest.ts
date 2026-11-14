// The category tree of the `rc.categories` screen model, and its `ccategory/dsp_nest.cfm` list table (server-only).
import { cfToBoolean } from '@opt2/platform/legacy-compat';
import { cfEq } from '@/lib/cfml';
import type { CsrfRenderer } from '@/lib/csrf';
import { encodeJs, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { structText, structValue, type CarchPageData, type CarchStruct } from '../carch/model';

/** A query flag as the contract carries it: a number, a boolean or its text; SQL NULL as null. */
export type CategoryFlag = number | string | boolean | null;

/** One `categoryManager.getCategories(siteID, parentID)` row, with the level below it. */
export interface CategoryNode {
  readonly categoryID: string;
  /** `''` at the top of the tree. */
  readonly parentID: string;
  readonly name: string;
  /** The child count; the number of `children` when the row carries none. */
  readonly hasKids: CategoryFlag;
  readonly isOpen: CategoryFlag;
  readonly isInterestGroup: CategoryFlag;
  readonly isActive: CategoryFlag;
  readonly restrictGroups: string;
  /** `getCategories(siteID, categoryID)`, in its name order. */
  readonly children: readonly CategoryNode[];
  /** The other `getCategories` columns, present only when the row carries them. */
  readonly siteID?: string;
  readonly filename?: string;
  readonly urltitle?: string;
  readonly isFeatureable?: CategoryFlag;
}

/** A category tree node; the same shape as {@link CategoryNode}. */
export type CategoryTreeNode = CategoryNode;

/** Whether `value` is a struct: an object that is neither null nor an array. */
export const isStruct = (value: unknown): value is CarchStruct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A flag of `struct`; absent reads as SQL NULL, a complex value throws. */
export function flagOf(struct: CarchStruct, key: string): CategoryFlag {
  const value = structValue(struct, key) ?? null;
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  throw new TypeError(`${key} is not a simple value`);
}

/** The rows of one tree level. */
function rowsOf(value: unknown): CarchStruct[] {
  if (!Array.isArray(value)) throw new TypeError('rc.categories holds a level that is not an array');
  return value.map((row: unknown): CarchStruct => {
    if (!isStruct(row)) throw new TypeError('rc.categories holds a row that is not a struct');
    return row;
  });
}

/** Whether `row` carries `key`, in any case. */
const has = (row: CarchStruct, key: string): boolean => structValue(row, key) !== undefined;

/** The node of `row` over `children`. */
function nodeOf(row: CarchStruct, children: CategoryNode[]): CategoryNode {
  return {
    categoryID: structText(row, 'categoryID'),
    parentID: structText(row, 'parentID'),
    name: structText(row, 'name'),
    hasKids: has(row, 'hasKids') ? flagOf(row, 'hasKids') : children.length,
    isOpen: flagOf(row, 'isOpen'),
    isInterestGroup: flagOf(row, 'isInterestGroup'),
    isActive: flagOf(row, 'isActive'),
    restrictGroups: structText(row, 'restrictGroups'),
    children,
    ...(has(row, 'siteID') ? { siteID: structText(row, 'siteID') } : {}),
    ...(has(row, 'filename') ? { filename: structText(row, 'filename') } : {}),
    ...(has(row, 'urltitle') ? { urltitle: structText(row, 'urltitle') } : {}),
    ...(has(row, 'isFeatureable') ? { isFeatureable: flagOf(row, 'isFeatureable') } : {}),
  };
}

/** The nodes of one nested tree level, each row carrying its `children` level. */
function levelOf(value: unknown): CategoryNode[] {
  return rowsOf(value).map((row) => nodeOf(row, levelOf(structValue(row, 'children'))));
}

/**
 * The tree of flat rows: each row under the row its `parentID` names (ignoring case, as SQL Server compares the ids),
 * the rows with an empty `parentID` at the top, each level in the order received.
 */
function nestFlat(rows: readonly CarchStruct[]): CategoryNode[] {
  const byParent = new Map<string, CarchStruct[]>();
  for (const row of rows) {
    const parentId = structText(row, 'parentID').toUpperCase();
    const level = byParent.get(parentId);
    if (level === undefined) byParent.set(parentId, [row]);
    else level.push(row);
  }
  const levelUnder = (parentId: string, ancestors: ReadonlySet<string>): CategoryNode[] =>
    (byParent.get(parentId) ?? []).map((row) => {
      const id = structText(row, 'categoryID').toUpperCase();
      if (ancestors.has(id)) throw new TypeError(`rc.categories holds category ${id} under itself`);
      return nodeOf(row, levelUnder(id, new Set([...ancestors, id])));
    });
  return levelUnder('', new Set());
}

/** The category tree `rc.categories` of a strategies-content screen model; throws when it is malformed. */
export function categoryTreeOf(rc: CarchStruct): CategoryNode[] {
  return levelOf(structValue(rc, 'categories'));
}

/**
 * The category tree of a `listCategories` or `getCategory` screen model, whose `rc.categories` rows either carry their
 * `children` level or are flat rows nested here by `parentID`; throws when it is malformed.
 */
export function toCategoryTree(data: CarchPageData): CategoryNode[] {
  const value = structValue(data.rc, 'categories');
  const rows = rowsOf(value);
  return rows.some((row) => has(row, 'children')) ? levelOf(value) : nestFlat(rows);
}

/** Every category id of `nodes` and their descendants, in tree order. */
export function categoryIdsOf(nodes: readonly CategoryNode[]): string[] {
  return nodes.flatMap((node) => [node.categoryID, ...categoryIdsOf(node.children)]);
}

/** Every category id of `nodes` depth-first, the contexts to prefetch before {@link renderCategoryNest}. */
export const collectCategoryIds = categoryIdsOf;

/**
 * Inputs of {@link renderCategoryNest}. The tag's `siteID` attribute, `rc.siteID`, is accepted as `siteid` or
 * `siteId`, so callers written to either name render the same table.
 */
export type CategoryNestInput = {
  readonly nodes: readonly CategoryNode[];
  readonly rb: RbLookup;
  /** Holds the delete tokens of every category in `nodes`, prefetched with {@link collectCategoryIds}. */
  readonly csrf: CsrfRenderer;
} & ({ readonly siteid: string } | { readonly siteId: string });

/** The values every row repeats. */
interface RowParts {
  readonly label: (key: string) => SafeHtml;
  readonly jsSiteId: SafeHtml;
  readonly urlSiteId: SafeHtml;
  readonly deleteConfirm: SafeHtml;
  readonly csrf: CsrfRenderer;
}

/** The `categorymanager.yes`/`no` label of a CFML boolean, as `yesnoformat` keys it. */
const yesNoLabel = (parts: RowParts, on: boolean): SafeHtml => parts.label(on ? 'yes' : 'no');

/** The Assignable cell: the icon on the `<td>` line, its line break only on the `<cfif>` branch. */
function assignableCell(parts: RowParts, flag: CategoryFlag): SafeHtml {
  const on = cfToBoolean(flag);
  const icon = on
    ? html`<i class="mi-check" title="${yesNoLabel(parts, on)}"></i>\n`
    : html`<i class="mi-ban" title="${yesNoLabel(parts, on)}"></i>`;
  return html`<td>${icon}\n<span>${yesNoLabel(parts, on)}</span></td>`;
}

/** The Interest Group and Active cells, each icon on its own indented line. */
function flagCell(parts: RowParts, flag: CategoryFlag): SafeHtml {
  const on = cfToBoolean(flag);
  const icon = on
    ? html`\n\t\t<i class="mi-check" title="${yesNoLabel(parts, on)}"></i>\n\t`
    : html`\n\t<i class="mi-ban" title="${yesNoLabel(parts, on)}"></i>\n\t`;
  return html`<td>\n\t${icon}\n\t<span>${yesNoLabel(parts, on)}</span>\n</td>`;
}

/** One `<cfloop>` row; `level` is the tag's nest level, printed empty at the top. */
function categoryRow(parts: RowParts, node: CategoryNode, level: number): SafeHtml {
  const { label, jsSiteId, urlSiteId } = parts;
  // Legacy writes the ids unencoded.
  const id = raw(node.categoryID);
  const parentID = raw(node.parentID);
  const editHref = html`./?muraAction=cCategory.edit&categoryID=${id}&parentID=${parentID}&siteid=${urlSiteId}`;
  const nest = raw(`nest${level === 0 ? '' : String(level)}${cfToBoolean(node.hasKids) ? 'on' : 'off'}`);
  const locked = cfEq(node.restrictGroups, '') ? '' : 'Locked';
  // The CFML comment between the menu link's attributes leaves both of its spaces.
  return html`
<tr>
<td class="add">
 <a href="javascript:;"  onclick="categoryManager.showMenu('newContentMenu',this,'${id}','${jsSiteId}');"><i class="mi-ellipsis-v"></i></a></td>
<td class="var-width"><ul class="${nest}"><li class="Category${locked}"><a title="Edit" href="${editHref}">${node.name}</a></li></ul></td>
${assignableCell(parts, node.isOpen)}

${flagCell(parts, node.isInterestGroup)}

${flagCell(parts, node.isActive)}
<td class="actions hide"><ul><li class="edit"><a title="${label('edit')}" href="${editHref}"><i class="mi-pencil"></i></a></li><li class="delete"><a title="${label('delete')}" href="./?muraAction=cCategory.update&action=delete&categoryID=${id}&siteid=${urlSiteId}${parts.csrf.render(node.categoryID, 'url')}" onClick="return confirmDialog('${parts.deleteConfirm}',this.href)"><i class="mi-trash"></i></a></li></ul></td>
</tr>
`;
}

/** Each node's row followed by the rows of its descendants, as the recursive tag emits them. */
function levelRows(parts: RowParts, nodes: readonly CategoryNode[], level: number): SafeHtml[] {
  return nodes.flatMap((node) => [categoryRow(parts, node, level), ...levelRows(parts, node.children, level + 1)]);
}

/**
 * `<cf_dsp_nest parentID="" nestLevel="0">`: the categories table over the whole tree, or the no-categories notice.
 * ACF whitespace management prints the tag's other whitespace as nothing, and the one space after the notice.
 * Synchronous: the caller prefetches the delete tokens in its load step, so `csrf.render` needs no identity call here.
 */
export function renderCategoryNest(input: CategoryNestInput): SafeHtml {
  const { nodes, rb } = input;
  const siteid = 'siteid' in input ? input.siteid : input.siteId;
  const label = (key: string): SafeHtml => raw(rb.rbKey(`categorymanager.${key}`));
  if (nodes.length === 0) return html`<div class="help-block-empty">${label('nocategories')}</div> `;
  const parts: RowParts = {
    label,
    jsSiteId: raw(encodeJs(siteid)),
    urlSiteId: raw(encodeUrl(siteid)),
    deleteConfirm: raw(encodeJs(rb.rbKey('categorymanager.deleteconfirm'))),
    csrf: input.csrf,
  };
  // The view's second `<thead>` is legacy's own unclosed tag.
  return html`
\t<table class="mura-table-grid">
\t<thead>
\t<tr>
\t<th class="add"></th>
\t<th class="var-width">${label('category')}</th>
\t<th>${label('assignable')}</th>
\t<th>${label('interestgroup')}</th>
\t<th>${label('active')}</th>
\t<th class="actions hide"></th>
\t</tr>
\t<thead>
\t<tbody class="nest">
\t${levelRows(parts, nodes, 0)}
\t</tbody>
\t</table>
`;
}
