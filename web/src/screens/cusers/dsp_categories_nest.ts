// Interests tab category tree of `cusers/dsp_categories_nest.cfm` (Edit User), one loader call per level as legacy queries.
import { encodeHtml, html, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';

/** One `categoryGateway.getPrivateInterestGroups` row: an interest category of a site sharing the user pool. */
export interface InterestCategoryRow {
  /** `tsettings.Site`, the category's site name; consecutive equal values form one group. */
  readonly site: string | null;
  readonly categoryID: string;
  readonly name: string | null;
  /** The checkbox renders only when it equals 1. */
  readonly isOpen: number | boolean | null;
  /** Child count over every category, so a level of only non-interest children renders nothing. */
  readonly hasKids: number | boolean;
}

// The strategies-content contract defines no interest-group read, so callers supply the per-level query.
/** `getPrivateInterestGroups(siteId, parentId)`: one level, rows ordered by site then name as legacy orders them. */
export type InterestCategoryLoader = (siteId: string, parentId: string) => Promise<readonly InterestCategoryRow[]>;

/** Attributes of `<cf_dsp_categories_nest>`, with the user bean's ids and the level loader. */
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
  readonly loadLevel: InterestCategoryLoader;
  /** Admin bundle of `session.rb`. */
  readonly rb: RbLookup;
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
async function categoryItem(row: InterestCategoryRow, args: UserCategoriesNestArgs): Promise<SafeHtml> {
  const name = encodeHtml(row.name);
  const nested = row.hasKids
    ? await renderUserCategoriesNest({ ...args, parentId: row.categoryID, nestLevel: args.nestLevel + 1 })
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

/**
 * `<cf_dsp_categories_nest>` output for one level and its descendants, byte-shaped as ACF 2023 emits it.
 * An empty root shows `user.nointerestcategories`; an empty lower level renders nothing.
 */
export async function renderUserCategoriesNest(args: UserCategoriesNestArgs): Promise<SafeHtml> {
  const rows = await args.loadLevel(args.siteId, args.parentId);
  if (rows.length === 0) {
    return args.parentId === ''
      ? html`\n<div class="help-block-empty">${raw(args.rb.rbKey('user.nointerestcategories'))}</div>\n\t`
      : html``;
  }
  const items = await Promise.all(rows.map((row) => categoryItem(row, args)));
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
