// Unit tests for the Edit User Interests tree of `cusers/dsp_categories_nest.cfm`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import {
  renderUserCategoriesNest,
  type InterestCategoryLoader,
  type InterestCategoryRow,
  type UserCategoriesNestArgs,
} from '@/screens/cusers/dsp_categories_nest';
import { fragmentModel } from '../../helpers/dom-model';

// Tag output of `cUsers.edituser` (qa_editor, siteid=default) captured from the legacy ACF 2023 server, cut from the
// tag's first byte to its last; rows below are that capture's `getPrivateInterestGroups` levels as one forest, ordered
// by site then name.
const LEGACY_TREE = readFileSync(new URL('../../fixtures/strategies-content/interest-categories-nest.html', import.meta.url), 'utf8');
const LEGACY_EMPTY = '\n<div class="help-block-empty">There are currently no interest groups.</div>\n\t';

const id = (n: string): string => `C1000000-0000-0000-00000000000000${n}`;
const OWN = 'Default';
const POOL = 'Other <Site>';

/** A forest row; `parent` is the parent's id suffix, or null at the root. */
function row(
  parent: string | null,
  site: string | null,
  n: string,
  name: string | null,
  isOpen: number,
  hasKids: number,
): InterestCategoryRow {
  return { site, categoryID: id(n), parentID: parent === null ? null : id(parent), name, isOpen, hasKids };
}

const FOREST: readonly InterestCategoryRow[] = [
  row(null, OWN, '0D', null, 0, 0),
  row(null, OWN, '0B', '', 1, 0),
  row(null, OWN, '01', 'Alpha', 1, 2),
  row('01', OWN, '02', 'Alpha Child', 1, 1),
  row('01', OWN, '08', 'Alpha Second', 1, 0),
  row(null, OWN, '04', 'beta & "Co"', 0, 1),
  row('02', OWN, '03', 'Closed Grandchild', 0, 0),
  row(null, OWN, '0A', 'Trailing ', 1, 0),
  row(null, OWN, '0C', 'Zed', 2, 0),
  row(null, POOL, '06', 'Gamma', 1, 1),
  row('06', POOL, '07', 'Gamma Kid', 1, 0),
];

/** A loader answering `forest`, recording each call's site id. */
function fixtureLoader(forest: readonly InterestCategoryRow[]) {
  const calls: string[] = [];
  const loadForest: InterestCategoryLoader = async (siteId) => {
    calls.push(siteId);
    return forest;
  };
  return { calls, loadForest };
}

async function render(args: Partial<UserCategoriesNestArgs> = {}): Promise<string> {
  const markup = await renderUserCategoriesNest({
    siteId: 'default',
    parentId: '',
    categoryId: `${id('07')},${id('0A')}`,
    nestLevel: 0,
    userCategoryIds: [id('02')],
    loadForest: fixtureLoader(FOREST).loadForest,
    rb: rbFor('en'),
    ...args,
  });
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** The `categoryID` checkboxes as `[value, checked]`, in document order. */
const checkboxes = (markup: string): Array<[string, boolean]> =>
  fragmentModel(markup).controls.map((c) => [c.value, c.checked]);

describe('renderUserCategoriesNest', () => {
  it.each<[string, string | readonly string[]]>([
    ['the person category ids', [id('02')]],
    ['a getCategoryID() comma list', id('02')],
  ])('matches the legacy tree byte for byte with %s', async (_case, userCategoryIds) => {
    expect(await render({ userCategoryIds })).toBe(LEGACY_TREE);
  });

  it('labels each site group at the root and checks by user ids and rc.categoryid, open categories only', async () => {
    const markup = await render();
    const model = fragmentModel(markup);
    expect(model.labels).toEqual([OWN, POOL]);
    expect(model).toEqual(fragmentModel(LEGACY_TREE));
    expect(checkboxes(markup)).toEqual([
      [id('0B'), false],
      [id('01'), false],
      [id('02'), true],
      [id('08'), false],
      [id('0A'), true],
      [id('06'), false],
      [id('07'), true],
    ]);
  });

  it('loads the forest once, with the site id, for a multi-level, multi-branch tree', async () => {
    const { calls, loadForest } = fixtureLoader(FOREST);
    expect(await render({ siteId: 'tenant-a', loadForest })).toBe(LEGACY_TREE);
    expect(calls).toEqual(['tenant-a']);
  });

  it.each<[string, (parentID: string) => string]>([
    ['lower case', (parentID) => parentID.toLowerCase()],
    ['trailing spaces', (parentID) => `${parentID}   `],
    ['lower case and a trailing space', (parentID) => `${parentID.toLowerCase()} `],
  ])('matches row parent ids as SQL Server char columns compare them: %s', async (_case, toParentID) => {
    const forest = FOREST.map((r) => (r.parentID === null ? r : { ...r, parentID: toParentID(r.parentID) }));
    expect(await render({ loadForest: fixtureLoader(forest).loadForest })).toBe(LEGACY_TREE);
  });

  it.each<[string, string]>([
    ['an exact id', id('01')],
    ['a lower-case id', id('01').toLowerCase()],
    ['an id with trailing spaces', `${id('01')}  `],
  ])('renders the subtree below a non-root start given %s', async (_case, parentId) => {
    const subtree = await render({ parentId, nestLevel: 1 });
    expect(LEGACY_TREE).toContain(subtree);
    expect(subtree).toContain('Closed Grandchild');
    expect(checkboxes(subtree)).toEqual([
      [id('02'), true],
      [id('08'), false],
    ]);
  });

  it.each(['', '   '])('reaches a row whose parentID is %j from no level', async (parentID) => {
    const orphan: InterestCategoryRow = { ...row(null, OWN, '0E', 'Orphan', 1, 0), parentID };
    expect(await render({ loadForest: fixtureLoader([...FOREST, orphan]).loadForest })).toBe(LEGACY_TREE);
    expect(await render({ loadForest: fixtureLoader([orphan]).loadForest })).toBe(LEGACY_EMPTY);
  });

  it.each<[string, string, readonly string[]]>([
    ['a case-different id', id('07').toLowerCase(), []],
    ['an id with surrounding spaces', ` ${id('07')} `, []],
    ['empty elements only', ',,', []],
    ['a prefix of an id', id('07').slice(0, 20), []],
  ])('checks only exact list elements: %s', async (_case, categoryId, userCategoryIds) => {
    const markup = await render({ categoryId, userCategoryIds });
    expect(checkboxes(markup).filter(([, checked]) => checked)).toEqual([]);
  });

  it('shows the user.nointerestcategories message for an empty root', async () => {
    expect(await render({ loadForest: fixtureLoader([]).loadForest })).toBe(LEGACY_EMPTY);
  });

  it('renders nothing for an empty lower level', async () => {
    expect(await render({ parentId: id('04'), nestLevel: 1 })).toBe('');
  });

  it('groups consecutive equal sites only, without labels or the checkboxTree class below the root', async () => {
    const level = (parent: string | null): InterestCategoryRow[] => [
      row(parent, 'A', '11', 'One', 0, 0),
      row(parent, 'a', '12', 'Two', 0, 0),
      row(parent, 'a', '13', 'Three', 0, 0),
      row(parent, null, '14', 'Four', 0, 0),
      row(parent, '', '15', 'Five', 0, 0),
    ];
    const nested = await render({ parentId: id('99'), nestLevel: 2, loadForest: fixtureLoader(level('99')).loadForest });
    expect(nested.match(/<ul>/g)).toHaveLength(3);
    expect(nested).not.toContain('<label>');
    expect(nested).not.toContain('checkboxTree');
    const root = await render({ loadForest: fixtureLoader(level(null)).loadForest });
    expect(fragmentModel(root).labels).toEqual(['A', 'a', '']);
    expect(root.match(/<ul class="checkboxTree">/g)).toHaveLength(3);
  });

  it('propagates a loader failure', async () => {
    const failure = new Error('strategies-content unavailable');
    const loadForest: InterestCategoryLoader = async () => {
      throw failure;
    };
    await expect(render({ loadForest })).rejects.toBe(failure);
  });
});
