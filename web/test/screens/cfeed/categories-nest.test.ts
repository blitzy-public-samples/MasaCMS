// Unit tests for the cfeed `dsp_categories_nest` category tree and its checkbox markup.
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import {
  feedCategoryTree,
  renderFeedCategoriesNest,
  type FeedCategoryNode,
  type FeedCategoryRow,
} from '@/screens/cfeed/categories-nest';

const PARENT_UPPER = 'ABCDEF01-2345-6789-ABCDEF0123456789';
const PARENT_LOWER = 'abcdef01-2345-6789-abcdef0123456789';
const CHILD_ID = 'C3200000-0000-0000-0000000000000002';
const LOWER_CHILD_ID = 'c3200000-0000-0000-0000000000000003';
const OTHER_ID = 'C3200000-0000-0000-0000000000000004';

/** An open, permitted category row under `parentID`. */
function row(categoryID: string, parentID: string | null, name: string): FeedCategoryRow {
  return { categoryID, parentID, name, isOpen: 1, permitted: true };
}

/** Each node as `[categoryID, hasKids, children]`, recursively. */
type Shape = [string, number | boolean, Shape[]];
function shape(nodes: readonly FeedCategoryNode[]): Shape[] {
  return nodes.map((n) => [n.categoryID, n.hasKids, shape(n.children)]);
}

describe('feedCategoryTree', () => {
  it.each<[string, string, string]>([
    ['upper-case parent, lower-case child parentID', PARENT_UPPER, PARENT_LOWER],
    ['lower-case parent, upper-case child parentID', PARENT_LOWER, PARENT_UPPER],
    ['trailing-space padded child parentID', PARENT_UPPER, `${PARENT_UPPER}   `],
    ['trailing-space padded parent categoryID', `${PARENT_UPPER}  `, PARENT_LOWER],
  ])('joins a child to its parent as SQL Server equality does: %s', (_case, parentID, childParentID) => {
    const tree = feedCategoryTree([row(parentID, null, 'Parent'), row(CHILD_ID, childParentID, 'Child')]);
    expect(shape(tree)).toEqual([[parentID, 1, [[CHILD_ID, 0, []]]]]);
  });

  it.each<[string, string]>([
    ['an unknown parent', OTHER_ID],
    ['a leading space', ` ${PARENT_UPPER}`],
    ['a trailing tab', `${PARENT_UPPER}\t`],
  ])('drops rows unreachable from the top: %s', (_case, childParentID) => {
    const tree = feedCategoryTree([
      row(PARENT_UPPER, null, 'Parent'),
      row(CHILD_ID, childParentID, 'Orphan'),
      row(LOWER_CHILD_ID, CHILD_ID.toLowerCase(), 'Orphan child'),
    ]);
    expect(shape(tree)).toEqual([[PARENT_UPPER, 0, []]]);
  });

  it('keeps sibling order as given at every level, with null and empty parentID at the top', () => {
    const tree = feedCategoryTree([
      row(OTHER_ID, '', 'Zeta'),
      row(LOWER_CHILD_ID, PARENT_UPPER, 'Second child'),
      row(PARENT_LOWER, null, 'Alpha'),
      row(CHILD_ID, PARENT_LOWER, 'First child'),
    ]);
    expect(shape(tree)).toEqual([
      [OTHER_ID, 0, []],
      [PARENT_LOWER, 2, [[LOWER_CHILD_ID, 0, []], [CHILD_ID, 0, []]]],
    ]);
  });
});

describe('renderFeedCategoriesNest', () => {
  it('renders a mixed-case child in a nested list under its parent', () => {
    const nodes = feedCategoryTree([
      row(PARENT_UPPER, null, 'Parent'),
      row(CHILD_ID, PARENT_LOWER, 'Child'),
      row(LOWER_CHILD_ID, `${CHILD_ID.toLowerCase()} `, 'Grandchild'),
    ]);
    const markup = renderFeedCategoriesNest({ nodes, nestLevel: 0, feedCategoryIds: CHILD_ID, categoryIds: '' });
    expect(isSafeHtml(markup)).toBe(true);

    const $ = cheerio.load(toString(markup), null, false);
    /** Each `<ul>` from the top down as `[class, item count, item name, checkbox value, checked]`. */
    const levels: [string | undefined, number, string, string | undefined, boolean][] = [];
    for (let ul = $.root().children('ul'); ul.length > 0; ul = ul.children('li').children('ul')) {
      const li = ul.children('li');
      const name = li.contents().filter((_i, n) => n.type === 'text').text().trim();
      const box = li.children('input[name="categoryID"]');
      levels.push([ul.attr('class'), li.length, name, box.attr('value'), box.is('[checked]')]);
    }
    expect(levels).toEqual([
      ['categories checkboxTree', 1, 'Parent', PARENT_UPPER, false],
      ['categories', 1, 'Child', CHILD_ID, true],
      ['categories', 1, 'Grandchild', LOWER_CHILD_ID, false],
    ]);
  });
});
