// The category tree of the `rc.categories` screen model, and its `ccategory/dsp_nest.cfm` list table (server-only).
import { cfToBoolean } from '@opt2/platform/legacy-compat';
import { cfEq } from '@/lib/cfml';
import type { CsrfRenderer } from '@/lib/csrf';
import { encodeJs, encodeUrl, html, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { structText, structValue, type CarchStruct } from '../carch/model';

/** A query flag as the contract carries it: a number, a boolean or its text; SQL NULL as null. */
export type CategoryFlag = number | string | boolean | null;

/** One `categoryManager.getCategories(siteID, parentID)` row, with the level below it. */
export interface CategoryNode {
  readonly categoryID: string;
  /** `''` at the top of the tree. */
  readonly parentID: string;
  readonly name: string;
  /** The child count. */
  readonly hasKids: CategoryFlag;
  readonly isOpen: CategoryFlag;
  readonly isInterestGroup: CategoryFlag;
  readonly isActive: CategoryFlag;
  readonly restrictGroups: string;
  /** `getCategories(siteID, categoryID)`, in its name order. */
  readonly children: readonly CategoryNode[];
}

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

/** The nodes of one tree level. */
function levelOf(value: unknown): CategoryNode[] {
  if (!Array.isArray(value)) throw new TypeError('rc.categories holds a level that is not an array');
  return value.map((row: unknown): CategoryNode => {
    if (!isStruct(row)) throw new TypeError('rc.categories holds a row that is not a struct');
    return {
      categoryID: structText(row, 'categoryID'),
      parentID: structText(row, 'parentID'),
      name: structText(row, 'name'),
      hasKids: flagOf(row, 'hasKids'),
      isOpen: flagOf(row, 'isOpen'),
      isInterestGroup: flagOf(row, 'isInterestGroup'),
      isActive: flagOf(row, 'isActive'),
      restrictGroups: structText(row, 'restrictGroups'),
      children: levelOf(structValue(row, 'children')),
    };
  });
}

/** The category tree `rc.categories` of a strategies-content screen model; throws when it is malformed. */
export function categoryTreeOf(rc: CarchStruct): CategoryNode[] {
  return levelOf(structValue(rc, 'categories'));
}

/** Every category id of `nodes` and their descendants, in tree order. */
export function categoryIdsOf(nodes: readonly CategoryNode[]): string[] {
  return nodes.flatMap((node) => [node.categoryID, ...categoryIdsOf(node.children)]);
}

/** Inputs of {@link renderCategoryNest}. */
export interface CategoryNestInput {
  readonly nodes: readonly CategoryNode[];
  /** The tag's `siteID` attribute, `rc.siteID`. */
  readonly siteid: string;
  readonly rb: RbLookup;
  /** Holds the delete tokens of every category in `nodes`. */
  readonly csrf: CsrfRenderer;
}

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
 */
export function renderCategoryNest(input: CategoryNestInput): SafeHtml {
  const { nodes, rb } = input;
  const label = (key: string): SafeHtml => raw(rb.rbKey(`categorymanager.${key}`));
  if (nodes.length === 0) return html`<div class="help-block-empty">${label('nocategories')}</div> `;
  const parts: RowParts = {
    label,
    jsSiteId: raw(encodeJs(input.siteid)),
    urlSiteId: raw(encodeUrl(input.siteid)),
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
