// Edit Profile Interests tree of `ceditprofile/dsp_categories_nest.cfm`, one level per load (server-only).
import { encodeHtml, html, raw, type SafeHtml } from '@/lib/html';
import type { ScreenContext } from '../registry';

/** One `categoryGateway.getPrivateInterestGroups` row: an interest category of a site sharing the user pool. */
export interface ProfileInterestCategoryRow {
  readonly categoryID: string;
  readonly name: string;
  /** `tsettings.Site`, the category's site name. */
  readonly site: string;
  /** The checkbox renders only when it equals 1. */
  readonly isOpen: number | boolean;
  /** Child count over every category, so a level holding only non-interest children renders nothing. */
  readonly hasKids: number;
}

// The strategies-content contract defines no interest-group listing, so the caller binds this query to the
// gateway; web passes only the site and parent ids, and the service resolves the user pool from its registry.
/** `getPrivateInterestGroups(siteId, parentId)`: one level, ordered by site then name; `''` selects the root. */
export type ProfileInterestCategoryLoader = (
  siteId: string,
  parentId: string,
) => Promise<readonly ProfileInterestCategoryRow[]>;

/** Attributes of `<cf_dsp_categories_nest>` on Edit Profile, with the level loader. */
export interface ProfileCategoriesNestOptions {
  readonly siteId: string;
  /** `''` at the root. */
  readonly parentId: string;
  /** The `rc.categoryID` comma list. */
  readonly categoryId: string;
  /** 0 at the root, which adds the `checkboxTree` class. */
  readonly nestLevel: number;
  /** The profile's `getCategoryID()` comma list. */
  readonly userCategoryIds: string;
  readonly loadRows: ProfileInterestCategoryLoader;
}

/** CFML `listFind(list, value)`: an exact, case-sensitive match of a `,` element; empty elements never match. */
function listFind(list: string, value: string): boolean {
  return value !== '' && list.split(',').includes(value);
}

/** One `<li>`: checkbox when open, encoded name, then the next level when the category has kids. */
async function categoryItem(
  ctx: ScreenContext,
  row: ProfileInterestCategoryRow,
  opts: ProfileCategoriesNestOptions,
): Promise<SafeHtml> {
  const checked = listFind(opts.userCategoryIds, row.categoryID) || listFind(opts.categoryId, row.categoryID);
  // Legacy writes the id unencoded; category ids are CF UUIDs.
  const checkbox =
    Number(row.isOpen) === 1
      ? html`<input type="checkbox" name="categoryID" class="checkbox" ${checked ? raw('checked') : ''} value="${raw(row.categoryID)}"> `
      : '';
  const nested = row.hasKids
    ? await renderProfileCategoriesNest(ctx, { ...opts, parentId: row.categoryID, nestLevel: opts.nestLevel + 1 })
    : '';
  const name = encodeHtml(row.name);
  // ACF whitespace management writes the whitespace after the name as one space, or nothing after whitespace.
  const gap = name === '' || name.endsWith(' ') ? '' : ' ';
  return html`\n<li>\n${checkbox}${raw(name)}${gap}${nested}\n</li>\n`;
}

/**
 * `<cf_dsp_categories_nest>` output of one level and its descendants, as ACF 2023 writes it after edit.cfm's preceding
 * whitespace (so no leading run). An empty root shows `user.nointerestcategories`; an empty lower level renders nothing.
 */
export async function renderProfileCategoriesNest(
  ctx: ScreenContext,
  opts: ProfileCategoriesNestOptions,
): Promise<SafeHtml> {
  const rows = await opts.loadRows(opts.siteId, opts.parentId);
  if (rows.length === 0) {
    return opts.parentId === ''
      ? html`<div class="help-block-empty">${raw(ctx.rb.rbKey('user.nointerestcategories'))}</div> `
      : html``;
  }
  const items = await Promise.all(rows.map((row) => categoryItem(ctx, row, opts)));
  return html`\n<ul${opts.nestLevel === 0 ? raw(' class="checkboxTree"') : ''}>\n${items}\n</ul>\n`;
}
