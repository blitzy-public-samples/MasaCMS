// Category checkbox tree of `cchangesets/dsp_categories_nest.cfm`: change-set list filter and edit Categorization tab.
import { html, raw, type SafeHtml } from '@/lib/html';

/** One category of the site's tree, in the order and with the category permission strategies-content computed. */
export interface ChangesetCategoryNode {
  readonly categoryId: string;
  readonly name: string;
  /** The `isOpen` flag; only open categories render a checkbox. */
  readonly isOpen: boolean;
  /** `permUtility.getCategoryPerm(restrictGroups, siteid)`; false renders the checkbox `disabled`. */
  readonly permitted: boolean;
  readonly children: readonly ChangesetCategoryNode[];
}

/** Arguments of `<cf_dsp_categories_nest>`. */
export interface ChangesetCategoriesNestArgs {
  readonly nodes: readonly ChangesetCategoryNode[];
  /** The `categoryID` attribute: the comma list of ids to check. */
  readonly categoryIds: string;
  /** Defaults to 1, as the tag's `cfparam`; 0 at the top adds the `checkboxTree` class. */
  readonly nestLevel?: number;
}

/** CFML `listFind(list, value)`: an exact, case-sensitive match of a comma-list element; empty elements never match. */
function listFind(list: string, value: string): boolean {
  return value !== '' && list.split(',').includes(value);
}

/** The `categoryID` checkbox of an open category. */
function checkbox(node: ChangesetCategoryNode, categoryIds: string): SafeHtml {
  const checked = listFind(categoryIds, node.categoryId);
  // Legacy writes the id unencoded; category ids are CF UUIDs, which HTML-encode to themselves, so the bytes match.
  return html`<input type="checkbox" name="categoryID" class="checkbox" ${checked && raw('checked')} value="${node.categoryId}" ${!node.permitted && raw('disabled')} > `;
}

/** One `<li>`: checkbox when open, encoded name, then the children's list when the category has kids. */
function categoryItem(node: ChangesetCategoryNode, categoryIds: string, nestLevel: number): SafeHtml {
  const nested =
    node.children.length > 0
      ? renderCategoriesNest({ nodes: node.children, categoryIds, nestLevel: nestLevel + 1 })
      : '';
  // The space after the name and the newlines are the bytes ACF 2023 emits for the tag.
  return html`
<li>
${node.isOpen && checkbox(node, categoryIds)}${node.name} ${nested}
</li>
`;
}

/** `<cf_dsp_categories_nest>` output for one level and its descendants; empty when `nodes` is empty. */
export function renderCategoriesNest({ nodes, categoryIds, nestLevel = 1 }: ChangesetCategoriesNestArgs): SafeHtml {
  if (nodes.length === 0) return html``;
  return html`
<ul class="categories${nestLevel === 0 && raw(' checkboxTree')}">
${nodes.map((node) => categoryItem(node, categoryIds, nestLevel))}
</ul>
`;
}
