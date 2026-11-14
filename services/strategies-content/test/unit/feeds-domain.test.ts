/** Collections through `domain/feeds` over a throwaway `content` schema: the feed bean, cfeed gate and update action, CRUD and local feed content. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, fixedClock, pgAvailable } from '@opt2/platform/testing';
import type { TenantDb } from '@opt2/platform/tenancy';
import { saveContent, type ContentSaveSite } from '../../src/domain/content.js';
import type { Actor } from '../../src/domain/context.js';
import {
  FEED_RC_DEFAULTS,
  FeedAllowReturnTypeError,
  FeedBean,
  FeedContentUnsupportedError,
  FeedElementUndefinedError,
  FeedMemberLookupRequiredError,
  FeedParamLookupUnsupportedError,
  allowFeed,
  createFeed,
  deleteFeed,
  feedAccess,
  feedContent,
  feedEditModel,
  feedStruct,
  listFeeds,
  readFeed,
  saveFeed,
  updateFeed,
  updateFeedAction,
  validateFeed,
  withFeedRcDefaults,
} from '../../src/domain/feeds.js';
import { setRestriction } from '../../src/domain/permissions.js';
import type { FeedContentRow } from '../../src/repo/feed-queries.js';
import { ADMIN, END, HOME, NOBODY, NOW, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';
import { roundTripCounter, type RoundTripCounter } from '../helpers/round-trips.js';

const clock = fixedClock(NOW);
const ANONYMOUS: Actor = { ...NOBODY, userId: '', fullName: '', isLoggedIn: false, roles: [] };
const SITE_B: ContentSaveSite = { ...SITE, siteId: TENANT_B.siteId, urls: { ...SITE.urls, siteId: TENANT_B.siteId, filePoolId: TENANT_B.siteId } };
const ADMIN_B: Actor = { ...ADMIN, siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId };
const LIST_REDIRECT = { kind: 'redirect', action: 'cFeed.list', append: ['siteid'] };

describe('feed bean', () => {
  it('starts from the beanFeed and feedBean init defaults', () => {
    const bean = FeedBean.init(clock);
    expect(bean.isNew).toBe(1);
    expect([bean.text('type'), bean.text('version'), bean.text('authtype'), bean.text('maxitems'), bean.text('sortby')]).toEqual([
      'local',
      'RSS 2.0',
      'DEFAULT',
      '20',
      'lastUpdate',
    ]);
    expect(validateFeed(bean)).toEqual({});
  });

  it.each([
    ['maxItems', 'abc', 'maxitems', '20'],
    ['maxItems', 5, 'maxitems', '5'],
    ['itemsPerPage', 7, 'nextn', '7'],
    ['sortDirection', 'sideways', 'sortdirection', 'desc'],
    ['sortDirection', 'asc', 'sortdirection', 'asc'],
    ['displayName', 'yes', 'displayname', '1'],
    ['displayName', 'maybe', 'displayname', '0'],
    ['isActive', 'yes', 'isactive', 'yes'],
    ['contentID', '  A,B  ', 'contentid', 'A,B'],
    ['imageSize', '', 'imagesize', 'small'],
    ['altTable', 'tplugins', 'alttable', ''],
    ['altTable', 'dbo.tcontent', 'alttable', 'dbo.tcontent'],
    ['fields', 'title, nosuch,menuTitle', 'fields', 'tcontent.title,tcontent.menuTitle'],
    ['sort', 'title asc', 'orderby', 'title asc'],
    ['name', '  News  ', 'name', 'News'],
  ])('setter for %s given %j stores %s as %j', (key, value, stored, expected) => {
    const bean = FeedBean.init(clock);
    bean.setValue(key, value);
    expect(bean.text(stored)).toBe(expected);
  });

  it('keeps the last 50 characters of a trimmed lastUpdateBy and parses date arguments', () => {
    const bean = FeedBean.init(clock);
    bean.setValue('lastUpdateBy', `  ${'n'.repeat(60)}  `);
    bean.setValue('lastUpdate', '2026-01-02 03:04:05');
    expect(bean.text('lastupdateby')).toBe('n'.repeat(50));
    expect(bean.get('lastupdate')).toEqual(new Date(2026, 0, 2, 3, 4, 5));
  });

  it('rebuilds the posted advanced params through addParam, routing explicit setters and category ids', () => {
    const bean = FeedBean.init(clock).set({
      param: '1,2,3',
      paramField1: 'title^varchar',
      paramRelationship1: 'and',
      paramCriteria1: 'News',
      paramCondition1: 'contains',
      paramField2: 'categoryid^varchar',
      paramRelationship2: 'or',
      paramCriteria2: '11111111-2222-3333-4444555566667777',
      paramCondition2: 'eq',
      paramField3: 'maxItems',
      paramRelationship3: 'and',
      paramCriteria3: '4',
      paramCondition3: 'eq',
    });
    expect(bean.text('maxitems')).toBe('4');
    expect(bean.params.rows.map((row) => [row.param, row.field, row.criteria, row.dataType])).toEqual([
      [1, 'tcontent.title', 'News', 'varchar'],
      [2, 'tcontentcategoryassign.categoryid', '11111111-2222-3333-4444555566667777', 'varchar'],
    ]);
    expect(() => FeedBean.init(clock).set({ param: '1', paramField1: 'title' })).toThrow(FeedElementUndefinedError);
    expect(() => bean.addParam({ field: 'categorypathid', relationship: 'and', criteria: 'Sports', condition: 'eq', datatype: '' })).toThrow(
      FeedParamLookupUnsupportedError,
    );
  });

  it('reports each invalid property with the beanValidator message', () => {
    const bean = FeedBean.init(clock);
    bean.setValue('lang', '');
    bean.setValue('feedID', 'x'.repeat(36));
    expect(validateFeed(bean)).toEqual({
      feedID: "The property named 'feedID' is not valid",
      lang: "The property named 'lang' is not valid",
    });
  });

  it('serialises the bean into the ACF-ordered struct the trash packet holds', () => {
    const struct = feedStruct(FeedBean.init(clock));
    const keys = struct.entries.map(([key]) => key);
    expect(keys).toContain('FEEDID');
    expect(keys).toContain('PARAMS');
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('cfeed gate', () => {
  it.each([
    ['s2', ADMIN, true, true],
    ['site-admin', { ...NOBODY, roles: ['site-admin'] }, true, true],
    ['m:011 with m:000', { ...NOBODY, roles: ['m:011', 'm:000'] }, true, true],
    ['m:011 alone', { ...NOBODY, roles: ['m:011'] }, true, false],
    ['s2 without a feed manager', ADMIN, false, false],
  ])('%s → %s', (_label, actor, hasFeedManager, allowed) => {
    expect(feedAccess(actor, { hasFeedManager })).toBe(allowed);
  });

  it('defaults the rc as before() params it, keeping posted values', () => {
    expect(withFeedRcDefaults({ action: 'add', startrow: 3 })).toEqual({ ...FEED_RC_DEFAULTS, action: 'add', startrow: 3 });
  });
});

describe.skipIf(!(await pgAvailable()))('feeds over the content schema', () => {
  let fx: ContentFixture;
  let feedId = '';
  const feedRow = async (id: string) => (await fx.rows('feed', 'feedid = $1', [id]))[0];
  const page = async (actor: Actor, site: ContentSaveSite, data: Record<string, unknown>): Promise<string> => {
    const saved = await saveContent(fx.deps, actor, site, { siteid: site.siteId, type: 'Page', approved: 1, ...data });
    expect(saved.errors).toEqual({});
    return saved.bean.contentId();
  };
  const titles = (rows: ReadonlyArray<{ title: string | null }>) => rows.map((row) => row.title);

  beforeAll(async () => {
    fx = await createContentFixture('feeds-domain-test');
    await page(ADMIN, SITE, { contentid: HOME, parentid: END, title: 'Home' });
    for (const title of ['Delta', 'alpha', 'Echo']) await page(ADMIN, SITE, { parentid: HOME, title });
    await page(ADMIN_B, SITE_B, { contentid: HOME, parentid: END, title: 'Home B' });
    for (const title of ['Bravo', 'charlie']) await page(ADMIN_B, SITE_B, { parentid: HOME, title });
  });

  afterAll(async () => {
    await fx?.drop();
  });

  describe('feedManager writes', () => {
    it('creates a feed with lastUpdate at the clock and the actor name as lastUpdateBy', async () => {
      const bean = await createFeed(fx.deps, ADMIN, { siteid: SITE_ID, name: 'News', type: 'Local', contentid: HOME, sortby: 'title', sortdirection: 'asc' });
      expect(bean.errors).toEqual({});
      expect(bean.isNew).toBe(0);
      feedId = bean.text('feedid');
      expect(await feedRow(feedId)).toMatchObject({
        name: 'News',
        type: 'Local',
        siteid: SITE_ID,
        contentpoolid: SITE_ID,
        lastupdateby: 'Admin User',
        lastupdate: new Date(2026, 5, 30, 10, 15, 42),
      });
      expect(await fx.rows('feed_item', 'feedid = $1', [feedId])).toHaveLength(1);
    });

    it('updates the stored feed, cutting lastUpdateBy to 50 characters, and writes nothing when validation fails', async () => {
      const updated = await updateFeed(fx.deps, { ...ADMIN, fullName: 'y'.repeat(70) }, { feedid: feedId, name: 'News 2' });
      expect(updated.errors).toEqual({});
      expect(await feedRow(feedId)).toMatchObject({ name: 'News 2', lastupdateby: 'y'.repeat(50) });
      const invalid = await updateFeed(fx.deps, ADMIN, { feedid: feedId, name: 'Not saved', lang: '' });
      expect(invalid.errors).toEqual({ lang: "The property named 'lang' is not valid" });
      expect(await feedRow(feedId)).toMatchObject({ name: 'News 2' });
      await expect(updateFeed(fx.deps, ADMIN, { name: 'x' })).rejects.toBeInstanceOf(FeedElementUndefinedError);
    });

    it('saves by feedID: an update when the feed exists, else a create keeping the given id', async () => {
      await expect(saveFeed(fx.deps, ADMIN, { name: 'x' })).rejects.toThrow("The attribute 'FEEDID' is required when saving a feed.");
      expect((await saveFeed(fx.deps, ADMIN, { feedid: feedId, name: 'News' })).text('name')).toBe('News');
      const bean = FeedBean.init(clock);
      bean.setValue('FeedID', '22222222-3333-4444-5555666677778888');
      bean.setValue('SiteID', SITE_ID);
      bean.setValue('name', 'From bean');
      await saveFeed(fx.deps, ADMIN, bean);
      expect(await feedRow('22222222-3333-4444-5555666677778888')).toMatchObject({ name: 'From bean' });
    });

    it('reads a missing feed as a new bean and lists local and remote feeds apart', async () => {
      expect((await readFeed(fx.deps, ADMIN, { feedId: 'nope' })).isNew).toBe(1);
      expect((await readFeed(fx.deps, ADMIN, { siteId: SITE_ID, name: 'News' })).text('feedid')).toBe(feedId);
      await createFeed(fx.deps, ADMIN, { siteid: SITE_ID, name: 'Remote', type: 'Remote', channellink: 'http://feeds.example/rss' });
      const lists = await listFeeds(fx.deps, ADMIN, SITE_ID);
      expect(lists.rsLocal.map((row) => row.feedid)).toContain(feedId);
      expect(lists.rsRemote.map((row) => row.name)).toEqual(['Remote']);
    });

    it('builds the edit model with the feed content items', async () => {
      const model = await feedEditModel(fx.deps, ADMIN, { feedId });
      expect(model.feedBean.text('name')).toBe('News');
      expect(model.rslist.map((row) => row.contentid)).toEqual([HOME]);
      expect(Array.isArray(model.rsRestrictGroups)).toBe(true);
    });

    it('moves an unlocked feed to the trash with one row, then deletes it; a locked feed is left alone', async () => {
      const locked = await createFeed(fx.deps, ADMIN, { siteid: SITE_ID, name: 'Locked', type: 'Local', islocked: 1 });
      expect((await deleteFeed(fx.deps, ADMIN, locked.text('feedid'))).deleted).toBe(false);
      expect(await feedRow(locked.text('feedid'))).toBeDefined();
      const doomed = await createFeed(fx.deps, ADMIN, { siteid: SITE_ID, name: 'Doomed', type: 'Local' });
      const deletion = await deleteFeed(fx.deps, ADMIN, doomed.text('feedid'));
      expect(deletion.deleted).toBe(true);
      expect(await feedRow(doomed.text('feedid'))).toBeUndefined();
      const trash = await fx.rows('trash', 'objectid = $1', [doomed.text('feedid')]);
      expect(trash).toHaveLength(1);
      expect(trash[0]).toMatchObject({ objectclass: 'feed', objectlabel: 'Doomed', objecttype: 'Local', siteid: SITE_ID, deletedby: 'Admin User' });
    });
  });

  describe('cfeed.update', () => {
    it.each([
      ['an invalid CSRF token', { action: 'add', name: 'X' }, { csrfValid: false }, LIST_REDIRECT],
      ['a successful add', { action: 'add', name: 'Added', type: 'Local' }, {}, LIST_REDIRECT],
    ])('redirects to the list on %s', async (_label, rc, opts, expected) => {
      expect(await updateFeedAction(fx.deps, ADMIN, { siteid: SITE_ID, ...rc }, opts)).toEqual(expected);
    });

    it('closes the compact display after a successful add', async () => {
      const outcome = await updateFeedAction(fx.deps, ADMIN, { siteid: SITE_ID, action: 'add', name: 'Closed', type: 'Local', closeCompactDisplay: 'true' });
      expect(outcome.kind).toBe('close');
    });

    it('re-renders the edit model when an update fails validation', async () => {
      const outcome = await updateFeedAction(fx.deps, ADMIN, { siteid: SITE_ID, action: 'update', feedid: feedId, contentid: HOME, lang: '' });
      expect(outcome).toMatchObject({ kind: 'rerender' });
      expect(outcome.kind === 'rerender' ? outcome.rslist.map((row) => row.contentid) : []).toEqual([HOME]);
    });

    it('updates the display object params instead of the feed when an assignment and JSON instance params are posted', async () => {
      const outcome = await updateFeedAction(fx.deps, ADMIN, {
        siteid: SITE_ID,
        action: 'update',
        feedid: feedId,
        name: 'Ignored',
        assignmentID: '99999999-0000-0000-0000000000000000',
        regionID: 2,
        orderno: 1,
        instanceParams: '{"displaylist":"Title"}',
      });
      expect(outcome).toEqual(LIST_REDIRECT);
      expect(await feedRow(feedId)).toMatchObject({ name: 'News' });
    });

    it('deletes through the trash and fails on an unknown action as legacy dereferences the missing bean', async () => {
      const doomed = await createFeed(fx.deps, ADMIN, { siteid: SITE_ID, name: 'Gone', type: 'Local' });
      expect(await updateFeedAction(fx.deps, ADMIN, { siteid: SITE_ID, action: 'delete', feedid: doomed.text('feedid') })).toEqual(LIST_REDIRECT);
      expect(await feedRow(doomed.text('feedid'))).toBeUndefined();
      await expect(updateFeedAction(fx.deps, ADMIN, { siteid: SITE_ID, action: 'other' })).rejects.toBeInstanceOf(FeedElementUndefinedError);
    });
  });

  describe('feedContent', () => {
    const news = () => readFeed(fx.deps, ADMIN, { feedId });

    it('lists the own site in the feed sort, applies maxItems and counts', async () => {
      const bean = await news();
      expect(titles(await feedContent(fx.deps, ADMIN, bean))).toEqual(['alpha', 'Delta', 'Echo']);
      bean.setValue('maxItems', 2);
      expect(titles(await feedContent(fx.deps, ADMIN, bean))).toEqual(['alpha', 'Delta']);
      expect(await feedContent(fx.deps, ADMIN, bean, { countOnly: true })).toEqual({ count: 3 });
      expect(titles(await feedContent(fx.deps, ADMIN, bean, { applyPermFilter: true }))).toEqual(['alpha', 'Delta']);
    });

    it('reads each content-pool site in its own tenant and merges them in the sort before maxItems', async () => {
      await fx.handle.app.withMetadata((tx) =>
        tx.query(`UPDATE ${fx.handle.schema}.tenant_registry SET content_pool_ids = $1, content_pool_tenants = $2 WHERE tenant_id = $3`, [
          [TENANT_A.siteId, TENANT_B.siteId],
          [TENANT_A.tenantId, TENANT_B.tenantId],
          TENANT_A.tenantId,
        ]),
      );
      const bean = await news();
      bean.setValue('contentpoolid', '*');
      expect(titles(await feedContent(fx.deps, ADMIN, bean))).toEqual(['alpha', 'Bravo', 'charlie', 'Delta', 'Echo']);
      expect(bean.text('contentpoolid')).toBe(`${TENANT_A.siteId},${TENANT_B.siteId}`);
      bean.setValue('maxItems', 3);
      expect(titles(await feedContent(fx.deps, ADMIN, bean))).toEqual(['alpha', 'Bravo', 'charlie']);
      bean.setValue('sortDirection', 'desc');
      expect(titles(await feedContent(fx.deps, ADMIN, bean))).toEqual(['Echo', 'Delta', 'charlie']);
      expect(await feedContent(fx.deps, ADMIN, bean, { countOnly: true })).toEqual({ count: 5 });
      bean.setValue('sort', 'menutitle asc');
      expect(titles(await feedContent(fx.deps, ADMIN, bean))).toEqual(['alpha', 'Bravo', 'charlie']);
      bean.setValue('sort', '');
      bean.setValue('sortBy', 'displayStart');
      expect(await feedContent(fx.deps, ADMIN, bean)).toHaveLength(3);
      await expect(feedContent(fx.deps, ADMIN, bean, { countOnly: true })).rejects.toBeInstanceOf(FeedContentUnsupportedError);
      bean.setValue('sortBy', 'someExtendedAttribute');
      await expect(feedContent(fx.deps, ADMIN, bean)).rejects.toThrow(/multi-site feed/);
    });

    it('refuses beanFeed fields and live rows contentIntervalManager.apply would expand', async () => {
      const fielded = await news();
      fielded.setValue('fields', 'title');
      await expect(feedContent(fx.deps, ADMIN, fielded)).rejects.toBeInstanceOf(FeedContentUnsupportedError);
      const events = await page(ADMIN, SITE, { parentid: HOME, type: 'Folder', title: 'Events' });
      const once = { parentid: events, display: 2, displaystart: new Date(2026, 0, 1) };
      await page(ADMIN, SITE, { ...once, title: 'Once', displayinterval: '{"repeats":0,"type":"daily","every":1}' });
      const feed = await createFeed(fx.deps, ADMIN, { siteid: SITE_ID, name: 'Events', type: 'Local', contentid: events });
      expect(titles(await feedContent(fx.deps, ADMIN, await readFeed(fx.deps, ADMIN, { feedId: feed.text('feedid') })))).toEqual(['Once']);
      await page(ADMIN, SITE, { ...once, title: 'Daily', displayinterval: '{"type":"daily","every":1}' });
      const bean = await readFeed(fx.deps, ADMIN, { feedId: feed.text('feedid') });
      await expect(feedContent(fx.deps, ADMIN, bean)).rejects.toThrow('contentIntervalManager.apply');
      expect(await feedContent(fx.deps, ADMIN, bean, { applyIntervals: false })).toHaveLength(2);
    });
  });

  describe('batched collection reads', () => {
    const MEMBERS = cfId('G', 71);
    const member = (roles: string[]): Actor => ({ ...NOBODY, userId: cfId('U', 71), fullName: 'Mem Ber', roles });
    const category = (n: number): string => cfId('K', n);
    let counter: RoundTripCounter;
    let membersFeedId = '';
    const membersFeed = () => readFeed(fx.deps, ADMIN, { feedId: membersFeedId });

    /** permUtility.queryPermFilter row by row: a crumb read and a setRestriction for each row. */
    const perRowFilter = async (actor: Actor, rows: readonly FeedContentRow[]): Promise<FeedContentRow[]> => {
      const kept: FeedContentRow[] = [];
      for (const row of rows) {
        const crumbs = await fx.inTenant((tx) => fx.repo.content.crumbPath(tx, { contentId: row.contentid ?? '', siteId: SITE_ID, path: row.path ?? '' }), actor.tenantId);
        const restriction = await setRestriction(fx.deps, actor, crumbs);
        if (!restriction.restrict || restriction.allow) kept.push(row);
      }
      return kept;
    };

    beforeAll(async () => {
      counter = roundTripCounter(fx.handle);
      const folder = await page(ADMIN, SITE, { parentid: HOME, type: 'Folder', title: 'Members Area' });
      const pages: Array<[string, Record<string, unknown>]> = [
        ['P1 open', {}],
        ['P2 by name', { restricted: 1, restrictgroups: 'Members' }],
        ['P3 by id', { restricted: 1, restrictgroups: MEMBERS }],
        ['P4 open', {}],
        ['P5 other group', { restricted: 1, restrictgroups: 'Nope' }],
      ];
      const ids: string[] = [];
      for (const [title, extra] of pages) ids.push(await page(ADMIN, SITE, { parentid: folder, title, ...extra }));
      // Without a stored path the crumbs of P3 and P4 are walked parent by parent.
      await fx.inTenant((tx) => tx.query(`UPDATE ${fx.handle.schema}.content SET path = NULL WHERE contentid = ANY($1::bpchar[])`, [[ids[2], ids[3]]]));
      await fx.inTenant(async (tx) => {
        await fx.repo.projections.upsertGroupProjection(tx, { groupId: MEMBERS, siteId: SITE_ID, groupName: 'Members', isPublic: 0, deleted: false });
        await fx.repo.projections.replaceUserMemberships(tx, cfId('U', 71), SITE_ID, [MEMBERS]);
        await fx.repo.projections.replaceGroupPermissions(tx, MEMBERS, SITE_ID, [{ contentId: folder, siteId: SITE_ID, type: 'read' }]);
      });
      await fx.inTenant(async (tx) => {
        // K1 holds K2 and K3; K4 lists K2 again; K5 stands alone.
        const paths: Array<[number, string]> = [[1, `'${category(1)}'`], [2, `'${category(1)}','${category(2)}'`], [3, `'${category(1)}','${category(3)}'`], [4, `'${category(4)}','${category(2)}'`], [5, `'${category(5)}'`]];
        for (const [n, path] of paths) await fx.repo.categories.insertCategory(tx, { categoryid: category(n), siteid: TENANT_UMBRELLA.siteId, name: `K${n}`, path });
      }, TENANT_UMBRELLA.tenantId);
      for (const [at, n] of [[0, 2], [3, 5], [4, 3]] as Array<[number, number]>) {
        const [active] = await fx.rows('content', 'contentid = $1 AND active = 1', [ids[at]]);
        await fx.inTenant((tx) =>
          fx.repo.categories.setAssignment(tx, { categoryId: category(n), contentId: ids[at] ?? '', contentHistId: String(active?.contenthistid), isFeature: 0, orderNo: 1, siteId: SITE_ID }),
        );
      }
      const feed = await createFeed(fx.deps, ADMIN, { siteid: SITE_ID, name: 'Members', type: 'Local', contentid: folder, sortby: 'title', sortdirection: 'asc' });
      membersFeedId = feed.text('feedid');
    });

    it.each([
      ['anonymous', ANONYMOUS, ['P1 open', 'P4 open']],
      ['a non-member', NOBODY, ['P1 open', 'P4 open']],
      ['a member', member(['system-user']), ['P1 open', 'P2 by name', 'P3 by id', 'P4 open']],
      ['a member with Site Manager access', member(['system-user', 'm:000']), ['P1 open', 'P2 by name', 'P3 by id', 'P4 open', 'P5 other group']],
      ['a non-member with Site Manager access', { ...NOBODY, roles: ['system-user', 'm:000'] }, ['P1 open', 'P4 open']],
      ['an S2 administrator', ADMIN, ['P1 open', 'P2 by name', 'P3 by id', 'P4 open', 'P5 other group']],
    ] as Array<[string, Actor, string[]]>)('the permission filter keeps for %s the rows the per-row filter keeps', async (_label, actor, expected) => {
      const bean = await membersFeed();
      const kept = await feedContent(fx.deps, actor, bean, { applyPermFilter: true });
      expect(titles(kept)).toEqual(expected);
      expect(kept).toEqual(await perRowFilter(actor, await feedContent(fx.deps, actor, bean)));
    });

    it.each([
      ['a member with Site Manager access', member(['system-user', 'm:000'])],
      ['a member', member(['system-user'])],
    ] as Array<[string, Actor]>)('filters five rows for %s with the round trips of three', async (_label, actor) => {
      const deps = { ...fx.deps, db: counter.db };
      const counts = [];
      // Both row sets hold a restricted row with a path and one walked from its parent, so only their number differs.
      for (const maxItems of [3, 5]) {
        const bean = await membersFeed();
        bean.setValue('maxItems', maxItems);
        counts.push(await counter.measure(() => feedContent(deps, actor, bean, { applyPermFilter: true })));
      }
      expect(counts[1]).toEqual(counts[0]);
    });

    it.each([
      [[1], ['P1 open', 'P5 other group']],
      [[2], ['P1 open']],
      [[4, 5], ['P4 open']],
      [[3, 2, 1, 2], ['P1 open', 'P5 other group']],
    ])('expands listed categories %j through their paths in the category pool', async (listed, expected) => {
      const bean = await membersFeed();
      bean.setValue('categoryID', listed.map(category).join(','));
      expect(titles(await feedContent(fx.deps, ADMIN, bean))).toEqual(expected);
    });

    it('expands four listed categories with the round trips of one', async () => {
      const deps = { ...fx.deps, db: counter.db };
      const counts = [];
      for (const listed of [[1], [1, 4, 5, 2]]) {
        const bean = await membersFeed();
        bean.setValue('categoryID', listed.map(category).join(','));
        counts.push(await counter.measure(() => feedContent(deps, ADMIN, bean)));
      }
      expect(counts[1]).toEqual(counts[0]);
    });
  });

  describe('allowFeed', () => {
    it('opens an unrestricted feed, refuses a new bean and lets a private-pool user of the site read any feed', async () => {
      const bean = await readFeed(fx.deps, ADMIN, { feedId });
      expect(await allowFeed(fx.deps, ANONYMOUS, bean)).toBe(true);
      expect(await allowFeed(fx.deps, ANONYMOUS, FeedBean.init(clock))).toBe(false);
      expect(await allowFeed(fx.deps, NOBODY, FeedBean.init(clock))).toBe(false);
      bean.setValue('restricted', 1);
      expect(await allowFeed(fx.deps, NOBODY, bean)).toBe(true);
    });

    it('asks identity for a member of a restricted feed and fails as legacy when one is found', async () => {
      const bean = await readFeed(fx.deps, ADMIN, { feedId });
      bean.setValue('restricted', 1);
      bean.setValue('restrictGroups', 'G1,G2');
      await expect(allowFeed(fx.deps, ANONYMOUS, bean)).rejects.toBeInstanceOf(FeedMemberLookupRequiredError);
      const queries: unknown[] = [];
      const none = async (query: unknown) => {
        queries.push(query);
        return false;
      };
      expect(await allowFeed(fx.deps, ANONYMOUS, bean, { username: 'u', password: 'p' }, none)).toBe(false);
      expect(queries).toEqual([{ username: 'u', password: 'p', publicUserPoolId: 'umbrella', restrictGroups: ['G1', 'G2'] }]);
      await expect(allowFeed(fx.deps, ANONYMOUS, bean, {}, async () => true)).rejects.toBeInstanceOf(FeedAllowReturnTypeError);
    });
  });

  describe('content pool resolution', () => {
    it('resolves * on the update transaction, so pool-size-many concurrent updates finish with no metadata connection', async () => {
      const contentPool = `${TENANT_A.siteId},${TENANT_B.siteId}`;
      await fx.handle.app.withMetadata((tx) =>
        tx.query(`UPDATE ${fx.handle.schema}.tenant_registry SET content_pool_ids = $1, content_pool_tenants = $2 WHERE tenant_id = $3`, [
          [TENANT_A.siteId, TENANT_B.siteId],
          [TENANT_A.tenantId, TENANT_B.tenantId],
          TENANT_A.tenantId,
        ]),
      );
      // Every transaction carries the signal, so a deadlocked pool is released when the bound expires.
      const abort = new AbortController();
      let metadataTxs = 0;
      const db: TenantDb = {
        ...fx.handle.app,
        withTenant: (tenantId, fn) => fx.handle.app.withTenant(tenantId, fn, { signal: abort.signal }),
        withMetadata: (fn) => {
          metadataTxs += 1;
          return fx.handle.app.withMetadata(fn, { signal: abort.signal });
        },
      };
      const deps = { ...fx.deps, db };
      const created = await createFeed(deps, ADMIN, { siteid: SITE_ID, name: 'Pooled', type: 'Local', contentpoolid: '*' });
      expect(created.errors).toEqual({});
      expect(created.text('contentpoolid')).toBe(contentPool);
      expect(metadataTxs).toBe(2);
      metadataTxs = 0;
      const timer = setTimeout(() => abort.abort(new Error('concurrent * updates did not finish within 15 s')), 15_000);
      const updates = Array.from({ length: 6 }, (_, n) => updateFeed(deps, ADMIN, { feedid: created.text('feedid'), name: `Pooled ${n}`, contentpoolid: '*' }));
      const updated = await Promise.all(updates).finally(() => clearTimeout(timer));
      expect(updated.map((bean) => [bean.errors, bean.text('contentpoolid')])).toEqual(Array(6).fill([{}, contentPool]));
      expect(metadataTxs).toBe(0);
      expect(await feedRow(created.text('feedid'))).toMatchObject({ contentpoolid: contentPool });
    });
  });
});
