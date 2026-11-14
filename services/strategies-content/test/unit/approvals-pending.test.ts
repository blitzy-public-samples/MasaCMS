/** domain/approvals `pendingApprovals` and its batched reads over a throwaway `content` schema: membership and request order, skipped versions, change sets and crumbs. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '@opt2/platform/tenancy';
import { pgAvailable } from '@opt2/platform/testing';
import { pendingApprovals } from '../../src/domain/approvals.js';
import { crumbPath, crumbPathsIn, readVersion, readVersionsIn, rowsById } from '../../src/repo/content-queries.js';
import { ADMIN, END, HOME, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

type Row = Record<string, unknown>;

const CHAIN = cfId('K', 1);
const OTHER_CHAIN = cfId('K', 2);
const GROUP_A = cfId('GA', 1);
const GROUP_B = cfId('GB', 1);
const COMPONENTS = '00000000000000000000000000000000003';
const FORMS = '00000000000000000000000000000000004';
const PAGE = cfId('P', 1);
const COMPONENT = cfId('C', 1);
const FORM = cfId('F', 1);
const PAGE_H = cfId('HP', 1);
const COMPONENT_H = cfId('HC', 1);
const FORM_H = cfId('HF', 1);
const MISSING_H = cfId('HX', 1);
const CHANGESET = cfId('S', 1);
const PUBLISH_DATE = new Date(2026, 6, 15, 9, 0, 0, 0);
const at = (hour: number, minute = 0): Date => new Date(2026, 5, 30, hour, minute, 0, 0);

let fx: ContentFixture;

async function insert(tx: TenantTx, table: string, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    const names = Object.keys(row);
    await tx.query(
      `INSERT INTO ${fx.handle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})`,
      [tx.tenantId, ...Object.values(row)],
    );
  }
}

/** A content row of the site, active unless overridden. */
const node = (row: Row): Row => ({ siteid: SITE_ID, subtype: 'Default', active: 1, approved: 1, display: 1, ...row });

/** A pending request of the chain. */
const request = (requestid: string, groupid: string | null, contenthistid: string, created: Date | null, extra: Row = {}): Row => ({
  requestid,
  groupid,
  contenthistid,
  created,
  chainid: CHAIN,
  siteid: SITE_ID,
  status: 'Pending',
  ...extra,
});

describe.skipIf(!(await pgAvailable()))('domain/approvals pendingApprovals', () => {
  beforeAll(async () => {
    fx = await createContentFixture('approvals-pending-test');
    await fx.inTenant(async (tx) => {
      await insert(tx, 'content', [
        node({ contentid: HOME, contenthistid: cfId('H', 1), type: 'Page', moduleid: '00000000000000000000000000000000000', parentid: END, path: HOME, title: 'Home', menutitle: 'Home' }),
        node({ contentid: PAGE, contenthistid: cfId('H', 2), type: 'Page', moduleid: '00000000000000000000000000000000000', parentid: HOME, path: `${HOME},${PAGE}`, title: 'About', menutitle: 'About' }),
        node({ contentid: COMPONENTS, contenthistid: cfId('H', 3), type: 'Module', moduleid: COMPONENTS, parentid: END, path: COMPONENTS, title: 'Components', menutitle: null }),
        node({ contentid: COMPONENT, contenthistid: cfId('H', 4), type: 'Component', moduleid: COMPONENTS, parentid: COMPONENTS, path: `${COMPONENTS},${COMPONENT}`, title: 'Footer', menutitle: 'Footer' }),
        node({ contentid: FORMS, contenthistid: cfId('H', 5), type: 'Module', moduleid: FORMS, parentid: END, path: FORMS, title: 'Forms', menutitle: '' }),
        node({ contentid: FORM, contenthistid: cfId('H', 6), type: 'Form', moduleid: FORMS, parentid: FORMS, path: `${FORMS},${FORM}`, title: 'Contact', menutitle: 'Contact' }),
        // The pending versions: the component's names its change set in another case; the form's has no stored path.
        node({ contentid: PAGE, contenthistid: PAGE_H, type: 'Page', moduleid: '00000000000000000000000000000000000', parentid: HOME, path: `${HOME},${PAGE}`, title: 'About v2', active: 0, approved: 0 }),
        node({ contentid: COMPONENT, contenthistid: COMPONENT_H, type: 'Component', moduleid: COMPONENTS, parentid: COMPONENTS, path: `${COMPONENTS},${COMPONENT}`, title: 'Footer v2', changesetid: CHANGESET.toLowerCase(), active: 0, approved: 0 }),
        node({ contentid: FORM, contenthistid: FORM_H, type: 'Form', moduleid: FORMS, parentid: FORMS, path: null, title: 'Contact v2', active: 0, approved: 0 }),
      ]);
      await insert(tx, 'changeset', [{ changesetid: CHANGESET, siteid: SITE_ID, name: 'Summer', publishdate: PUBLISH_DATE, published: 0 }]);
      await insert(tx, 'approval_chain', [{ chainid: CHAIN, siteid: SITE_ID, name: 'Chain' }]);
      await insert(tx, 'approval_membership', [
        { membershipid: cfId('M', 2), chainid: CHAIN, groupid: GROUP_B, orderno: 2 },
        { membershipid: cfId('M', 1), chainid: CHAIN, groupid: GROUP_A, orderno: 1 },
        { membershipid: cfId('M', 3), chainid: CHAIN, groupid: GROUP_A, orderno: 3 },
        { membershipid: cfId('M', 4), chainid: CHAIN, groupid: null, orderno: 4 },
      ]);
      await insert(tx, 'approval_request', [
        request(cfId('R', 1), GROUP_A, COMPONENT_H, at(8)),
        request(cfId('R', 2), GROUP_A.toLowerCase(), FORM_H, at(9), { status: 'pending' }),
        request(cfId('R', 3), GROUP_A, MISSING_H, at(8, 30)),
        request(cfId('R', 5), GROUP_B, COMPONENT_H, at(8)),
        request(cfId('R', 4), GROUP_B, PAGE_H, at(8)),
        request(cfId('R', 6), GROUP_A, PAGE_H, at(7), { status: 'Approved' }),
        request(cfId('R', 7), null, PAGE_H, at(7)),
        request(cfId('R', 8), GROUP_A, PAGE_H, at(7), { chainid: OTHER_CHAIN }),
        request(cfId('R', 9), GROUP_A, PAGE_H, null),
      ]);
    });
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('lists each membership in chain order with its pending versions oldest request first, each with its change set and crumbs', async () => {
    const { chain, groups } = await pendingApprovals(fx.deps, ADMIN, CHAIN);
    expect(chain.memberships.map((membership) => membership.orderno)).toEqual([1, 2, 3, 4]);
    const listed = groups.map(({ membership, items }) => [membership.groupid, items.map((item) => [item.requestid, item.contenthistid])]);
    const groupA = [
      [cfId('R', 9), PAGE_H],
      [cfId('R', 1), COMPONENT_H],
      [cfId('R', 2), FORM_H],
    ];
    expect(listed).toEqual([
      [GROUP_A, groupA],
      [
        GROUP_B,
        [
          [cfId('R', 4), PAGE_H],
          [cfId('R', 5), COMPONENT_H],
        ],
      ],
      [GROUP_A, groupA],
      ['', []],
    ]);
    const items = new Map(groups.flatMap(({ items: rows }) => rows).map((item) => [item.contenthistid, item]));
    expect(items.get(COMPONENT_H)).toMatchObject({ type: 'Component', title: 'Footer v2', changesetid: CHANGESET.toLowerCase(), changesetname: 'Summer', changesetpublishdate: PUBLISH_DATE, created: at(8) });
    expect(items.get(PAGE_H)).toMatchObject({ changesetid: '', changesetname: '', changesetpublishdate: null, created: null });
    const crumbs = Object.fromEntries([...items].map(([histId, item]) => [histId, item.crumbs.map((crumb) => [crumb.contentid, crumb.menutitle])]));
    expect(crumbs).toEqual({
      [PAGE_H]: [
        [PAGE, 'About'],
        [HOME, 'Home'],
      ],
      // A stored path keeps the module's NULL menu title.
      [COMPONENT_H]: [
        [COMPONENT, 'Footer'],
        [COMPONENTS, null],
      ],
      // Without a stored path the walk falls back to the title.
      [FORM_H]: [
        [FORM, 'Contact'],
        [FORMS, 'Forms'],
      ],
    });
    for (const item of items.values()) {
      const [version] = await fx.inTenant((tx) => readVersion(tx, { contentHistId: item.contenthistid }));
      const single = await fx.inTenant((tx) => crumbPath(tx, { contentId: item.contentid, siteId: item.siteid, path: version?.path ?? '' }));
      expect(item.crumbs).toEqual(single);
    }
  });

  it('lists no members for a chain without memberships', async () => {
    expect(await pendingApprovals(fx.deps, ADMIN, OTHER_CHAIN)).toMatchObject({ chain: { isNew: true }, groups: [] });
  });

  const paths = [`${HOME},${PAGE}`, `${COMPONENTS},${COMPONENT}`.toLowerCase(), `${HOME},,${PAGE},`, `${FORMS},${cfId('X', 9)}`, ',', HOME];
  it.each(paths)('crumbPathsIn reads %s, batched with the other paths, as crumbPath reads it alone', async (path) => {
    const batched = await fx.inTenant((tx) => crumbPathsIn(tx, { siteId: SITE_ID, paths }));
    const single = await fx.inTenant((tx) => crumbPath(tx, { contentId: '', siteId: SITE_ID, path }));
    expect(batched.get(path)).toEqual(single);
  });

  it('readVersionsIn keys each requested id to one of the rows readVersion reads, skipping empty and missing ids', async () => {
    const ids = [PAGE_H, COMPONENT_H.toLowerCase(), MISSING_H, ''];
    const versions = await fx.inTenant((tx) => readVersionsIn(tx, { contentHistIds: ids }));
    expect([...versions.keys()]).toEqual([PAGE_H, COMPONENT_H.toLowerCase()]);
    for (const id of [PAGE_H, COMPONENT_H.toLowerCase()]) {
      // A version joins one row per approval request, in no stated order.
      expect(await fx.inTenant((tx) => readVersion(tx, { contentHistId: id }))).toContainEqual(versions.get(id));
    }
  });

  it('findChangesetsIn keys each requested id to the change set findChangeset reads', async () => {
    const ids = [CHANGESET.toLowerCase(), `${CHANGESET} `, cfId('S', 9)];
    const changesets = await fx.inTenant((tx) => fx.repo.changesets.findChangesetsIn(tx, ids));
    expect([...changesets.keys()]).toEqual([CHANGESET.toLowerCase(), `${CHANGESET} `]);
    for (const changesetId of ids) {
      expect(changesets.get(changesetId) ?? null).toEqual(await fx.inTenant((tx) => fx.repo.changesets.findChangeset(tx, { changesetId })));
    }
  });
});

describe('rowsById', () => {
  const rows = [{ id: 'AB-1' }, { id: null }, { id: 'ab-1  ' }, { id: 'Ab-1' }, { id: 'CD-2' }];
  it.each<[string[], number[]]>([
    [['ab-1'], [0, 2]],
    [['Ab-1 '], [0, 2, 3]],
    [['CD-2', 'AB-1'], [0, 2, 4]],
    [[''], []],
    [[], []],
  ])('matches %j as idIn does: the listed, upper- and lower-case forms, trailing spaces ignored, NULL never, in row order', (ids, expected) => {
    expect(rowsById(rows, (row) => row.id)(ids)).toEqual(expected.map((index) => rows[index]));
  });
});
