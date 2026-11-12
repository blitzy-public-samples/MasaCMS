// Interests tab category tree of `cusers/dsp_categories_nest.cfm` (Edit User), rendered from one load of the pool's forest.
import { encodeHtml, html, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';

/** One `categoryGateway.getPrivateInterestGroups` row: an interest category of a site sharing the user pool. */
export interface InterestCategoryRow {
  /** `tsettings.Site`, the category's site name; consecutive equal values form one group. */
  readonly site: string | null;
  readonly categoryID: string;
  /** `tcontentcategories.parentID`; null at the root. */
  readonly parentID: string | null;
  readonly name: string | null;
  /** The checkbox renders only when it equals 1. */
  readonly isOpen: number | boolean | null;
  /** Child count over every category, so a level of only non-interest children renders nothing. */
  readonly hasKids: number | boolean;
}

// The strategies-content contract defines no interest-group read, so callers supply the forest query.
/** `getPrivateInterestGroups` for every level of `siteId`'s pool at once, each parent's rows ordered by site then name. */
export type InterestCategoryLoader = (siteId: string) => Promise<readonly InterestCategoryRow[]>;

/** Attributes of `<cf_dsp_categories_nest>`, with the user bean's ids and the forest loader. */
export interface UserCategoriesNestArgs {
  readonly siteId: string;
  /** `''` at the root. */
  readonly parentId: string;
  /** The `rc.categoryid` comma list. */
  readonly categoryId: string;
  /** 0 at the root, which adds the site labels and the `checkboxTree` class. */
  readonly nestLevel: number;
  /** The user's `getCategoryID()`: a comma list or the person's category ids. */
  readonly userCategoryIds: string | readonly string[];
  readonly loadForest: InterestCategoryLoader;
  /** Admin bundle of `session.rb`. */
  readonly rb: RbLookup;
}

/** Forest rows by parent key: `null` for the root, else the parent's {@link idKey}; each list in loader order. */
type ForestIndex = ReadonlyMap<string | null, readonly InterestCategoryRow[]>;

/** Key of a category id as SQL Server compares the `char(35)` CI_AS columns: case and trailing spaces ignored. */
function idKey(id: string): string {
  return id.replace(/ +$/, '').toLowerCase();
}

/** Groups `rows` by parent key, keeping the loader's order within each parent. */
function indexByParent(rows: readonly InterestCategoryRow[]): ForestIndex {
  const byParent = new Map<string | null, InterestCategoryRow[]>();
  for (const row of rows) {
    const key = row.parentID === null ? null : idKey(row.parentID);
    const siblings = byParent.get(key);
    if (siblings === undefined) byParent.set(key, [row]);
    else siblings.push(row);
  }
  return byParent;
}

/** CFML `listFind(list, value)`: an exact, case-sensitive match of an element; empty elements never match. */
function listFind(list: string | readonly string[], value: string): boolean {
  const items = typeof list === 'string' ? list.split(',') : list;
  return value !== '' && items.includes(value);
}

/** The `categoryID` checkbox of an open category, checked by the user's ids or `rc.categoryid`. */
function checkbox(row: InterestCategoryRow, args: UserCategoriesNestArgs): SafeHtml {
  const checked = listFind(args.userCategoryIds, row.categoryID) || listFind(args.categoryId, row.categoryID);
  // Legacy writes the id unencoded; category ids are CF UUIDs, which encode to themselves.
  return html`\n\t\t\t\t\t\t<input type="checkbox" name="categoryID" class="checkbox" ${checked && raw('checked')} value="${row.categoryID}"> \n\t\t\t\t\t`;
}

/** One `<li>`: checkbox when open, encoded name, then the next level when the category has kids. */
function categoryItem(row: InterestCategoryRow, args: UserCategoriesNestArgs, forest: ForestIndex): SafeHtml {
  const name = encodeHtml(row.name);
  const nested = row.hasKids
    ? renderLevel({ ...args, parentId: row.categoryID, nestLevel: args.nestLevel + 1 }, forest)
    : '';
  // ACF whitespace management writes the whitespace after the name as one space, or nothing after whitespace.
  const gap = name === '' || name.endsWith(' ') ? '' : ' ';
  return html`\n\t\t\t\t<li>\n\n\t\t\t\t\t${Number(row.isOpen) === 1 && checkbox(row, args)}${raw(name)}${gap}${nested}\n\t\t\t\t</li>\n\t\t\t`;
}

/** One `cfoutput group="site"` block: the site label at the root, then the list of its rows. */
function siteGroup(site: string, items: readonly SafeHtml[], nestLevel: number): SafeHtml {
  const label = nestLevel === 0 ? html`\n\t\t\t<label>\n\t\t\t\t${site}\n\t\t\t</label>\n\t\t` : '';
  return html`${label}\n\n\t\t<ul${nestLevel === 0 && raw(' class="checkboxTree"')}>\n\t\t\t${items}\n\t\t</ul>\n\n\t`;
}

/** The level below `args.parentId` and its descendants, from `forest`; `''` selects the root, as `is null`. */
function renderLevel(args: UserCategoriesNestArgs, forest: ForestIndex): SafeHtml {
  const rows = forest.get(args.parentId === '' ? null : idKey(args.parentId)) ?? [];
  if (rows.length === 0) {
    return args.parentId === ''
      ? html`\n<div class="help-block-empty">${raw(args.rb.rbKey('user.nointerestcategories'))}</div>\n\t`
      : html``;
  }
  const items = rows.map((row) => categoryItem(row, args, forest));
  const groups: SafeHtml[] = [];
  let start = 0;
  for (let i = 1; i <= rows.length; i += 1) {
    const site = rows[start]?.site ?? '';
    // A query null reads as '', and cfoutput groups case-sensitively by default.
    if (i < rows.length && (rows[i]?.site ?? '') === site) continue;
    groups.push(siteGroup(site, items.slice(start, i), args.nestLevel));
    start = i;
  }
  return html`${groups}`;
}

/**
 * `<cf_dsp_categories_nest>` output for one level and its descendants, byte-shaped as ACF 2023 emits it, from a single
 * forest load. An empty root shows `user.nointerestcategories`; an empty lower level renders nothing.
 */
export async function renderUserCategoriesNest(args: UserCategoriesNestArgs): Promise<SafeHtml> {
  return renderLevel(args, indexByParent(await args.loadForest(args.siteId)));
}
