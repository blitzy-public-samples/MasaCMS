// Unit tests for the Edit Profile Interests tree of `ceditprofile/dsp_categories_nest.cfm`.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import {
  renderProfileCategoriesNest,
  type ProfileCategoriesNestOptions,
  type ProfileInterestCategoryLoader,
  type ProfileInterestCategoryRow,
} from '@/screens/ceditprofile/dsp_categories_nest';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient } from '../../helpers/fake-gateway';

// Tag output of `cEditProfile.edit` (admin, siteid=default, categoryID=<Zed>,<lower-cased Alpha Child>, profile
// interest Alpha Second) captured from the legacy ACF 2023 server, from the tag's first byte to its last.
const LEGACY_TREE = readFileSync(
  new URL('../../fixtures/strategies-content/profile-interest-categories-nest.html', import.meta.url),
  'utf8',
);
const LEGACY_EMPTY = '<div class="help-block-empty">There are currently no interest groups.</div> ';

const EMPTY_OPEN = '33860000-0000-0000-0000000000000002';
const EMPTY_CLOSED = '33860000-0000-0000-0000000000000003';
const ALPHA = '33864A61-F588-1E6F-59E5477F931D5DFD';
const ALPHA_CHILD = '33867784-0B17-0369-E960F1DFD9EE7013';
const ALPHA_SECOND = '3386985A-EAC3-165A-B6F87532826BDA0D';
const GRANDCHILD = '338680B1-F16F-F110-5C288A0BA6EA990E';
const BETA = '3386A905-D077-22E5-9E3CE1C25EB0F47B';
const TRAILING = '33860000-0000-0000-0000000000000001';
const ZED = '3386D65B-FF49-5253-B59B6D2EDFB4FF16';

const row = (categoryID: string, name: string, isOpen: number | boolean, hasKids: number): ProfileInterestCategoryRow => ({
  categoryID,
  name,
  site: 'Default',
  isOpen,
  hasKids,
});

// The capture's getPrivateInterestGroups levels by parent id ('' = root); Beta's only child is not an interest group.
const LEVELS: Readonly<Record<string, readonly ProfileInterestCategoryRow[]>> = {
  '': [
    row(EMPTY_OPEN, '', 1, 0),
    row(EMPTY_CLOSED, '', 0, 0),
    row(ALPHA, 'Alpha', 1, 2),
    row(BETA, 'Beta & "Co" <x>', 0, 1),
    row(TRAILING, 'Trailing ', 1, 0),
    row(ZED, 'Zed', 1, 0),
  ],
  [ALPHA]: [row(ALPHA_CHILD, 'Alpha Child', 1, 1), row(ALPHA_SECOND, 'Alpha Second', 1, 0)],
  [ALPHA_CHILD]: [row(GRANDCHILD, 'Closed Grandchild', 0, 0)],
};

/** A loader answering `levels`, recording each call; the first level answers last, so order comes from the rows. */
function levelLoader(levels: Readonly<Record<string, readonly ProfileInterestCategoryRow[]>> = LEVELS) {
  const calls: Array<[string, string]> = [];
  const loadRows: ProfileInterestCategoryLoader = async (siteId, parentId) => {
    calls.push([siteId, parentId]);
    await new Promise((resolve) => setTimeout(resolve, parentId === ALPHA ? 10 : 0));
    return levels[parentId] ?? [];
  };
  return { calls, loadRows };
}

let restoreEnv: () => void;
let ctx: ScreenContext;

beforeEach(() => {
  restoreEnv = useTestEnv();
  const gateway = fakeGatewayClient({});
  ctx = {
    req: adminS2Request({ circuit: 'ceditprofile', item: 'edit', rc: {} }),
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
});

afterEach(() => {
  restoreEnv();
});

async function render(opts: Partial<ProfileCategoriesNestOptions> = {}): Promise<string> {
  const markup = await renderProfileCategoriesNest(ctx, {
    siteId: 'default',
    parentId: '',
    categoryId: `${ZED},${ALPHA_CHILD.toLowerCase()}`,
    nestLevel: 0,
    userCategoryIds: ALPHA_SECOND,
    loadRows: levelLoader().loadRows,
    ...opts,
  });
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** The `categoryID` checkboxes as `[value, checked]`, in document order. */
const checkboxes = (markup: string): Array<[string, boolean]> =>
  fragmentModel(markup).controls.map((c) => [c.value, c.checked]);

describe('renderProfileCategoriesNest', () => {
  it('matches the legacy tree byte for byte and by DOM model', async () => {
    const markup = await render();
    expect(markup).toBe(LEGACY_TREE);
    expect(fragmentModel(markup)).toEqual(fragmentModel(LEGACY_TREE));
    expect(fragmentModel(markup).labels).toEqual([]);
  });

  it('shows user.nointerestcategories for an empty root, as legacy does', async () => {
    expect(await render({ loadRows: levelLoader({}).loadRows })).toBe(LEGACY_EMPTY);
  });

  it('renders nothing for an empty lower level, so a category with only non-interest kids has no list', async () => {
    expect(await render({ parentId: BETA, nestLevel: 1 })).toBe('');
    expect(LEGACY_TREE).toContain('\n<li>\nBeta &amp; &quot;Co&quot; &lt;x&gt; \n</li>\n');
  });

  it('adds checkboxTree only at nest level 0 and renders a lower start as its legacy subtree', async () => {
    const subtree = await render({ parentId: ALPHA, nestLevel: 1 });
    expect(subtree.startsWith('\n<ul>\n')).toBe(true);
    expect(subtree).not.toContain('checkboxTree');
    expect(LEGACY_TREE).toContain(subtree);
    expect(LEGACY_TREE.match(/<ul class="checkboxTree">/g)).toHaveLength(1);
  });

  it('loads each level with the site and the parent id, and keeps row order', async () => {
    const { calls, loadRows } = levelLoader();
    expect(await render({ siteId: 'tenant-a', loadRows })).toBe(LEGACY_TREE);
    expect([...calls].sort()).toEqual([
      ['tenant-a', ''],
      ['tenant-a', ALPHA],
      ['tenant-a', ALPHA_CHILD],
      ['tenant-a', BETA],
    ]);
  });

  it.each<[string, Partial<ProfileCategoriesNestOptions>, boolean]>([
    ['the profile ids', { userCategoryIds: `x,${ZED},y`, categoryId: '' }, true],
    ['rc.categoryID', { userCategoryIds: '', categoryId: ZED }, true],
    ['neither list', { userCategoryIds: ALPHA, categoryId: ALPHA_SECOND }, false],
    ['a case-different id', { userCategoryIds: ZED.toLowerCase(), categoryId: '' }, false],
    ['a padded id', { userCategoryIds: '', categoryId: ` ${ZED} ` }, false],
    ['empty lists', { userCategoryIds: ',', categoryId: ',,' }, false],
  ])('checks a category found in %s: %s', async (_case, opts, checked) => {
    expect(checkboxes(await render(opts)).find(([value]) => value === ZED)).toEqual([ZED, checked]);
  });

  it.each<[number | boolean, boolean]>([
    [1, true],
    [true, true],
    [0, false],
    [false, false],
    [2, false],
  ])('renders the checkbox only when isOpen is 1 (isOpen %j)', async (isOpen, shown) => {
    const markup = await render({ loadRows: levelLoader({ '': [row(ZED, 'Zed', isOpen, 0)] }).loadRows });
    expect(checkboxes(markup)).toEqual(shown ? [[ZED, true]] : []);
    expect(markup).toContain('Zed \n</li>');
  });

  it.each<[string, ProfileInterestCategoryLoader]>([
    [
      'the root level',
      async () => {
        throw new GatewayUnavailableError('strategies-content', 503);
      },
    ],
    [
      'a lower level',
      async (_siteId, parentId) => {
        if (parentId === ALPHA_CHILD) throw new GatewayUnavailableError('strategies-content');
        return LEVELS[parentId] ?? [];
      },
    ],
  ])('propagates a load failure of %s', async (_case, loadRows) => {
    await expect(render({ loadRows })).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
