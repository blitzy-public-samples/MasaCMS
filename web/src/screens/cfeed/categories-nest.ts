// Category checkbox tree of `cfeed/dsp_categories_nest.cfm`, the Categories pane of the collection edit screen.
import { html, raw, type SafeHtml } from '@/lib/html';

/** One category of the site's category pool, with the user's category permission computed by strategies-content. */
export interface FeedCategoryNode {
  readonly categoryID: string;
  readonly name: string;
  /** The `isOpen` column; the checkbox renders only when it equals 1. */
  readonly isOpen: number | boolean;
  /** `permUtility.getCategoryPerm(restrictGroups, siteid)`; false renders the checkbox `disabled`. */
  readonly permitted: boolean;
  /** The `hasKids` count; the nested list renders only when it is non-zero. */
  readonly hasKids: number | boolean;
  readonly children: readonly FeedCategoryNode[];
}

/** A category query row; `parentID` is null or empty at the top of the tree. */
export interface FeedCategoryRow {
  readonly categoryID: string;
  readonly parentID: string | null;
  readonly name: string;
  readonly isOpen: number | boolean;
  readonly permitted: boolean;
}

/** Nests `rows` by `parentID`, siblings in the given order; rows unreachable from the top are left out, as in legacy. */
export function feedCategoryTree(rows: readonly FeedCategoryRow[]): FeedCategoryNode[] {
  const byParent = new Map<string, FeedCategoryRow[]>();
  for (const row of rows) {
    const parentID = row.parentID ?? '';
    const siblings = byParent.get(parentID);
    if (siblings === undefined) byParent.set(parentID, [row]);
    else siblings.push(row);
  }
  const nest = (parentID: string): FeedCategoryNode[] =>
    (byParent.get(parentID) ?? []).map((row) => {
      const children = nest(row.categoryID);
      const { categoryID, name, isOpen, permitted } = row;
      return { categoryID, name, isOpen, permitted, hasKids: children.length, children };
    });
  return nest('');
}

/** CFML `listFind(list, value)`: an exact, case-sensitive match of a comma-list element; empty elements never match. */
function listFind(list: string, value: string): boolean {
  return value !== '' && list.split(',').includes(value);
}

/** Arguments of `<cf_dsp_categories_nest>`: the level's categories, its nest level and the comma lists to check. */
export interface FeedCategoriesNestInput {
  readonly nodes: readonly FeedCategoryNode[];
  /** 0 at the top, which adds the `checkboxTree` class. */
  readonly nestLevel: number;
  /** The feed bean's `getCategoryID()` comma list. */
  readonly feedCategoryIds: string;
  /** The tag's `categoryID` attribute; the cfeed edit screen passes none, so `''`. */
  readonly categoryIds: string;
}

/** The `categoryID` checkbox of an open category. */
function checkbox(node: FeedCategoryNode, input: FeedCategoriesNestInput): SafeHtml {
  const checked = listFind(input.feedCategoryIds, node.categoryID) || listFind(input.categoryIds, node.categoryID);
  // Legacy writes the id unencoded; category ids are CF UUIDs, which encode to themselves.
  return html`<input type="checkbox" name="categoryID" class="checkbox" ${checked && raw('checked')} value="${node.categoryID}" ${!node.permitted && raw('disabled')} > `;
}

/** One `<li>`: checkbox when open, encoded name, then the children's list when the category has kids. */
function categoryItem(node: FeedCategoryNode, input: FeedCategoriesNestInput): SafeHtml {
  const nested = node.hasKids
    ? renderFeedCategoriesNest({ ...input, nodes: node.children, nestLevel: input.nestLevel + 1 })
    : '';
  // The space after the name and the newlines are the bytes ACF 2023 whitespace management emits for the tag.
  return html`
<li>
${Number(node.isOpen) === 1 && checkbox(node, input)}${node.name} ${nested}
</li>
`;
}

/** `<cf_dsp_categories_nest>` output for one level and its descendants; empty when `nodes` is empty. */
export function renderFeedCategoriesNest(input: FeedCategoriesNestInput): SafeHtml {
  if (input.nodes.length === 0) return html``;
  return html`
<ul class="categories${input.nestLevel === 0 && raw(' checkboxTree')}">
${input.nodes.map((node) => categoryItem(node, input))}
</ul>
`;
}
