/** The `tusersinterests` and `tuserstags` writes of a Type=2 user save [legacy: core/mura/user/userDAO.cfc:583-616,895-922]. */
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { PeopleRepository } from '../repo/repository.js';
import type { InterestRow, TagRow } from '../repo/tables.js';
import type { UserValues } from './person.js';

// Same semantics as legacy-compat's cfListToArray and javaTrim, kept local so this module imports only people and tenancy types.
/** The non-empty items of a CFML comma list, as `cfloop list` visits them. */
function listItems(list: string): string[] {
  return list.split(',').filter((item) => item !== '');
}

/** CFML `trim`: strips characters up to U+0020 from both ends. */
function cfTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end);
}

/** Rows `createUserInterests` inserts: each untrimmed non-empty item, first occurrence only. */
export function interestRowsFor(userId: string, categoryIdList: string): Array<Pick<InterestRow, 'userid' | 'categoryid'>> {
  // Exact repeats collapse here; the repository also drops ids its char(35) key cannot hold or already holds under the legacy collation.
  const seen = new Set<string>();
  const rows: Array<Pick<InterestRow, 'userid' | 'categoryid'>> = [];
  for (const categoryId of listItems(categoryIdList)) {
    if (seen.has(categoryId)) continue;
    seen.add(categoryId);
    rows.push({ userid: userId, categoryid: categoryId });
  }
  return rows;
}

/** Rows `createTags` inserts: each trimmed non-empty item in list order, duplicates kept. */
export function tagRowsFor(userId: string, siteId: string, tagList: string): Array<Pick<TagRow, 'userid' | 'siteid' | 'tag'>> {
  return listItems(tagList)
    .map(cfTrim)
    .filter((tag) => tag !== '')
    .map((tag) => ({ userid: userId, siteid: siteId, tag }));
}

/** Options of `writeInterests`; `originCategoryIds` are the categories of site `originId`. */
export interface InterestWriteOptions {
  updateInterests: boolean;
  originId?: string;
  originCategoryIds?: readonly string[];
}

/** Replaces the user's interests as `userDAO.update` does when `updateInterests` is set; returns the inserted rows. */
export async function writeInterests(
  repo: PeopleRepository,
  tx: TenantTx,
  userId: string,
  categoryIdList: string,
  opts: InterestWriteOptions,
  ctx: WriteContext,
): Promise<InterestRow[]> {
  if (!opts.updateInterests) return [];
  const categoryIds = interestRowsFor(userId, categoryIdList).map((row) => row.categoryid);
  // An origin site limits the delete to its categories; with none supplied nothing is deleted, as legacy's subquery then matches no row.
  const scope = opts.originId ? { scopeCategoryIds: opts.originCategoryIds ?? [] } : {};
  return repo.replaceInterests(tx, userId, categoryIds, scope, ctx);
}

/** Replaces the user's tags as `deleteTags` then `createTags` do, under the user's (pool) site id; returns the inserted rows. */
export async function writeTags(
  repo: PeopleRepository,
  tx: TenantTx,
  user: Pick<UserValues, 'userid' | 'siteid' | 'tags'>,
  ctx: WriteContext,
): Promise<TagRow[]> {
  return repo.replaceTags(tx, { userId: user.userid, siteId: user.siteid, tags: user.tags }, ctx);
}
