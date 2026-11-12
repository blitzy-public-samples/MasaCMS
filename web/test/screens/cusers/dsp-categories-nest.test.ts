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
// tag's first byte to its last; rows below are what `getPrivateInterestGroups` returned per level for that capture.
const LEGACY_TREE = readFileSync(new URL('../../fixtures/strategies-content/interest-categories-nest.html', import.meta.url), 'utf8');
const LEGACY_EMPTY = '\n<div class="help-block-empty">There are currently no interest groups.</div>\n\t';

const id = (n: string): string => `C1000000-0000-0000-00000000000000${n}`;
const OWN = 'Default';
const POOL = 'Other <Site>';

function row(site: string | null, n: string, name: string | null, isOpen: number, hasKids: number): InterestCategoryRow {
  return { site, categoryID: id(n), name, isOpen, hasKids };
}

const LEVELS: Readonly<Record<string, readonly InterestCategoryRow[]>> = {
  '': [
    row(OWN, '0D', null, 0, 0),
    row(OWN, '0B', '', 1, 0),
    row(OWN, '01', 'Alpha', 1, 2),
    row(OWN, '04', 'beta & "Co"', 0, 1),
    row(OWN, '0A', 'Trailing ', 1, 0),
    row(OWN, '0C', 'Zed', 2, 0),
    row(POOL, '06', 'Gamma', 1, 1),
  ],
  [id('01')]: [row(OWN, '02', 'Alpha Child', 1, 1), row(OWN, '08', 'Alpha Second', 1, 0)],
  [id('02')]: [row(OWN, '03', 'Closed Grandchild', 0, 0)],
  [id('06')]: [row(POOL, '07', 'Gamma Kid', 1, 0)],
};

/** A loader answering from `levels`, recording each `(siteId, parentId)` call. */
function fixtureLoader(levels: Readonly<Record<string, readonly InterestCategoryRow[]>>) {
  const calls: Array<[string, string]> = [];
  const loadLevel: InterestCategoryLoader = async (siteId, parentId) => {
    calls.push([siteId, parentId]);
    return levels[parentId] ?? [];
  };
  return { calls, loadLevel };
}

async function render(args: Partial<UserCategoriesNestArgs> = {}): Promise<string> {
  const markup = await renderUserCategoriesNest({
    siteId: 'default',
    parentId: '',
    categoryId: `${id('07')},${id('0A')}`,
    nestLevel: 0,
    userCategoryIds: [id('02')],
    loadLevel: fixtureLoader(LEVELS).loadLevel,
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

  it('loads the root and every category with kids, including one whose children are not interest groups', async () => {
    const { calls, loadLevel } = fixtureLoader(LEVELS);
    await render({ siteId: 'tenant-a', loadLevel });
    expect(calls.map(([, parentId]) => parentId).sort()).toEqual(['', id('01'), id('02'), id('04'), id('06')].sort());
    expect(new Set(calls.map(([siteId]) => siteId))).toEqual(new Set(['tenant-a']));
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
    expect(await render({ loadLevel: fixtureLoader({}).loadLevel })).toBe(LEGACY_EMPTY);
  });

  it('renders nothing for an empty lower level', async () => {
    expect(await render({ parentId: id('04'), nestLevel: 1 })).toBe('');
  });

  it('groups consecutive equal sites only, without labels or the checkboxTree class below the root', async () => {
    const rows = [row('A', '11', 'One', 0, 0), row('a', '12', 'Two', 0, 0), row('a', '13', 'Three', 0, 0), row(null, '14', 'Four', 0, 0), row('', '15', 'Five', 0, 0)];
    const { loadLevel } = fixtureLoader({ [id('99')]: rows });
    const nested = await render({ parentId: id('99'), nestLevel: 2, loadLevel });
    expect(nested.match(/<ul>/g)).toHaveLength(3);
    expect(nested).not.toContain('<label>');
    expect(nested).not.toContain('checkboxTree');
    const root = await render({ loadLevel: fixtureLoader({ '': rows }).loadLevel });
    expect(fragmentModel(root).labels).toEqual(['A', 'a', '']);
    expect(root.match(/<ul class="checkboxTree">/g)).toHaveLength(3);
  });

  it('propagates a loader failure', async () => {
    const failure = new Error('strategies-content unavailable');
    const loadLevel: InterestCategoryLoader = async (_siteId, parentId) => {
      if (parentId === id('01')) throw failure;
      return LEVELS[parentId] ?? [];
    };
    await expect(render({ loadLevel })).rejects.toBe(failure);
  });
});
