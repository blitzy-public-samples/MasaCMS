// Category checkbox tree of `carch/dsp_categories_nest.cfm`: the Site Manager flat-view category filter (server-only).
import { html, raw, type SafeHtml } from '@/lib/html';
import type { ScreenContext } from '../../registry';

/** One category of the site's tree as strategies-content returns it, siblings in `getCategories` order. */
export interface CategoryNestNode {
  readonly categoryID: string;
  readonly name: string;
  /** The checkbox renders only when it equals 1. */
  readonly isOpen: number | boolean;
  /** The child count; the nested list renders only when it is non-zero. */
  readonly hasKids: number | boolean;
  readonly children?: readonly CategoryNestNode[];
}

/** Attributes of `<cf_dsp_categories_nest>`, with the site's whole tree in place of the per-level query. */
export interface CategoriesNestOptions {
  readonly siteId: string;
  /** Level to render; `''` (the default) is the top level. */
  readonly parentId?: string;
  /** Comma list of the ids to check; defaults to `''`. */
  readonly categoryId?: string;
  /** Defaults to 1; 0 adds the `checkboxTree` class and, with `useId`, the `mura-nodes` id. */
  readonly nestLevel?: number;
  /** Defaults to 1. */
  readonly useId?: number | boolean;
  /** Checkbox name; defaults to `categoryID`. */
  readonly elementName?: string;
  /** The top-level categories. */
  readonly tree: readonly CategoryNestNode[];
}

/** The attributes every level of the recursion receives. */
type LevelArgs = Required<Omit<CategoriesNestOptions, 'parentId' | 'tree'>>;

/** CFML `listFind(list, value)`: an exact, case-sensitive match of a comma-list element; empty elements never match. */
function listFind(list: string, value: string): boolean {
  return value !== '' && list.split(',').includes(value);
}

/** The node of `nodes` or their descendants with id `categoryId`, depth first. */
function findNode(nodes: readonly CategoryNestNode[], categoryId: string): CategoryNestNode | undefined {
  for (const node of nodes) {
    if (node.categoryID === categoryId) return node;
    const found = findNode(node.children ?? [], categoryId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The checkbox of an open category; name and value are written unencoded, as legacy interpolates them. */
function checkbox(node: CategoryNestNode, args: LevelArgs): SafeHtml {
  const checked = listFind(args.categoryId, node.categoryID);
  return html`<input type="checkbox" name="${raw(args.elementName)}" class="checkbox" ${checked && raw('checked')} value="${raw(node.categoryID)}"/> `;
}

/** One `<li>`: checkbox when open, encoded name, then the children's list when the category has kids. */
function categoryItem(node: CategoryNestNode, args: LevelArgs): SafeHtml {
  const nested = node.hasKids ? renderLevel(node.children ?? [], { ...args, nestLevel: args.nestLevel + 1 }) : '';
  // The space after the name and the newlines are the bytes ACF 2023 whitespace management emits for this tag body,
  // not the template's literal newlines.
  return html`
<li>
${Number(node.isOpen) === 1 && checkbox(node, args)}${node.name} ${nested}
</li>
`;
}

/** One level's `<ul>` and its descendants; empty when `rows` is empty. */
function renderLevel(rows: readonly CategoryNestNode[], args: LevelArgs): SafeHtml {
  if (rows.length === 0) return html``;
  const top = !args.nestLevel;
  const id = top && Boolean(args.useId) ? raw(' id="mura-nodes"') : '';
  return html`
<ul${id} class="categories${top && raw(' checkboxTree')}">
${rows.map((node) => categoryItem(node, args))}
</ul>
`;
}

/** `<cf_dsp_categories_nest>` output for the level below `opts.parentId` and its descendants. */
export function categoriesNest(_ctx: Partial<ScreenContext>, opts: CategoriesNestOptions): SafeHtml {
  const { tree, parentId = '', siteId, categoryId = '', nestLevel = 1, useId = 1, elementName = 'categoryID' } = opts;
  const rows = parentId === '' ? tree : (findNode(tree, parentId)?.children ?? []);
  return renderLevel(rows, { siteId, categoryId, nestLevel, useId, elementName });
}
