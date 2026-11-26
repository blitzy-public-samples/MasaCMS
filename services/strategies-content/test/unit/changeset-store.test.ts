/** Change-set row primitives over a throwaway `content` schema: bean defaults, validation, read, insert and update saves with assignments, row deletes and removeItem. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  deleteChangesetRowsInTx,
  newChangesetBean,
  readChangesetInTx,
  removeItemInTx,
  saveChangesetInTx,
  validateChangeset,
  type ChangesetBean,
  type ChangesetReadKey,
} from '../../src/domain/changeset-store.js';
import type { Actor } from '../../src/domain/context.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const EARLIER = new Date(2026, 4, 1, 8, 0, 0, 0);
const SITE_ID = TENANT_A.siteId;
const TREE = '00000000000000000000000000000000000';
const LONG_NAME = `  ${'N'.repeat(60)}`;

const ACTOR: Actor = {
  userId: cfId('U', 1),
  fullName: 'Ada Lovelace',
  isLoggedIn: true,
  s2: false,
  roles: ['system-user'],
  siteId: SITE_ID,
  tenantId: TENANT_A.tenantId,
};
const ANONYMOUS: Actor = { userId: '', fullName: '', isLoggedIn: false, s2: false, roles: [], siteId: '', tenantId: '' };

/** Thrown inside a test transaction so its writes are rolled back. */
class Rollback extends Error {}

describe('newChangesetBean', () => {
  it.each([
    ['a logged-in actor', ACTOR, 'Ada Lovelace', ACTOR.userId],
    ['a long untrimmed name', { ...ACTOR, fullName: LONG_NAME }, LONG_NAME.slice(0, 50), ACTOR.userId],
    ['no session user', ANONYMOUS, '', ''],
  ])('applies the init defaults for %s', (_label, actor, lastupdateby, lastupdatebyid) => {
    const bean = newChangesetBean(actor, fixedClock(NOW));
    expect(bean).toEqual({
      changesetid: expect.stringMatching(CF_UUID),
      siteid: '',
      name: '',
      created: NOW,
      description: '',
      publishdate: null,
      published: 0,
      remoteid: '',
      remotesourceurl: '',
      remotepubdate: null,
      lastupdate: NOW,
      lastupdateby,
      lastupdatebyid,
      closedate: null,
      categoryid: '',
      tags: '',
      isnew: 1,
      errors: {},
    });
  });

  it('applies supplied values, keeps a supplied id and ignores undefined ones', () => {
    const bean = newChangesetBean(ACTOR, fixedClock(NOW), { changesetid: cfId('S', 1), name: 'Spring', siteid: undefined });
    expect(bean).toMatchObject({ changesetid: cfId('S', 1), name: 'Spring', siteid: '' });
  });
});

describe('validateChangeset', () => {
  it.each([
    ['site and name missing', { siteid: '', name: '' }, { siteID: "The property named 'siteID' is not valid", name: "The property named 'name' is not valid" }],
    ['name missing', { siteid: SITE_ID, name: '' }, { name: "The property named 'name' is not valid" }],
    ['nothing missing', { siteid: SITE_ID, name: 'Spring' }, {}],
  ])('reports the required properties when %s', (_label, values, expected) => {
    const errors = validateChangeset(newChangesetBean(ACTOR, fixedClock(NOW), values));
    expect(errors).toEqual(expected);
    expect(Object.keys(errors)).toEqual(Object.keys(expected));
  });
});

describe.skipIf(!(await pgAvailable()))('domain/changeset-store', () => {
  let handle: ThrowawaySchema;
  let repo: ContentRepository;
  let earlierRepo: ContentRepository;

  const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);

  /** Runs `fn` in a transaction that is rolled back afterwards. */
  async function rolledBack<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    let result: T | undefined;
    await expect(
      inA(async (tx) => {
        result = await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    return result as T;
  }

  /** A new bean of the site with `values`. */
  const bean = (values: Partial<ChangesetBean> = {}): ChangesetBean =>
    newChangesetBean(ACTOR, fixedClock(NOW), { siteid: SITE_ID, name: 'Spring', ...values });

  /** The assignment rows of a change set, by kind. */
  async function assignmentRows(tx: TenantTx, changesetId: string): Promise<{ categories: string[]; tags: string[] }> {
    const categories = await tx.query<{ categoryid: string }>(
      `SELECT categoryid FROM ${handle.schema}.changeset_category_assign WHERE changesetid = $1 ORDER BY categoryid`,
      [changesetId],
    );
    const tags = await tx.query<{ tag: string }>(`SELECT tag FROM ${handle.schema}.changeset_tag_assign WHERE changesetid = $1 ORDER BY tag`, [changesetId]);
    return { categories: categories.rows.map((row) => row.categoryid), tags: tags.rows.map((row) => row.tag) };
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'changeset-store-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'changeset-store-test', state: 'open' });
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
    earlierRepo = createContentRepository({ clock: fixedClock(EARLIER), schema: handle.schema });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('inserts a new change set stamped now, its dates to the minute, then one assignment per distinct list item', async () => {
    const input = bean({
      description: 'Seasonal',
      publishdate: new Date(2026, 6, 1, 9, 30, 59, 999),
      remotepubdate: new Date(2026, 6, 2, 9, 31, 1, 5),
      closedate: new Date(2026, 6, 3, 23, 59, 30, 0),
      published: 0,
      remoteid: 'R-1',
      remotesourceurl: 'http://example.test/feed',
      categoryid: `${cfId('K', 2)},${cfId('K', 1)},,${cfId('K', 2).toLowerCase()}`,
      tags: 'news, Events,news',
    });
    const { saved, row, assignments } = await rolledBack(async (tx) => {
      const saved = await saveChangesetInTx(tx, repo, input, { ...ACTOR, fullName: LONG_NAME });
      return {
        saved,
        row: await repo.changesets.findChangeset(tx, { changesetId: saved.changesetid }),
        assignments: await assignmentRows(tx, saved.changesetid),
      };
    });
    expect(saved).toEqual({ ...input, lastupdateby: 'N'.repeat(48), lastupdatebyid: ACTOR.userId, errors: {} });
    expect(row).toMatchObject({
      changesetid: input.changesetid,
      siteid: SITE_ID,
      name: 'Spring',
      description: 'Seasonal',
      created: NOW,
      lastupdate: NOW,
      publishdate: new Date(2026, 6, 1, 9, 30, 0, 0),
      remotepubdate: new Date(2026, 6, 2, 9, 31, 0, 0),
      closedate: new Date(2026, 6, 3, 23, 59, 0, 0),
      published: 0,
      lastupdateby: 'N'.repeat(48),
      remoteid: 'R-1',
      remotesourceurl: 'http://example.test/feed',
    });
    expect(row?.lastupdatebyid?.trim()).toBe(ACTOR.userId);
    expect(assignments).toEqual({ categories: [cfId('K', 1), cfId('K', 2)], tags: ['Events', 'news'] });
  });

  it('updates a stored change set, keeping `created`, stamping `lastupdate` and replacing its assignments', async () => {
    const { first, loaded, saved, row, count, assignments } = await rolledBack(async (tx) => {
      const first = await saveChangesetInTx(
        tx,
        earlierRepo,
        bean({ categoryid: cfId('K', 1), tags: 'old,keep', closedate: new Date(2026, 6, 9, 12, 0, 0, 0) }),
        ACTOR,
      );
      const loaded = await readChangesetInTx(tx, repo, { changesetId: first.changesetid }, ACTOR, fixedClock(NOW));
      const saved = await saveChangesetInTx(
        tx,
        repo,
        { ...loaded, name: 'Summer', published: 1, publishdate: new Date(2026, 6, 4, 8, 45, 12, 0), closedate: null, categoryid: cfId('K', 3), tags: 'keep,new' },
        { ...ACTOR, userId: cfId('U', 2), fullName: 'Grace Hopper' },
      );
      const counted = await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${handle.schema}.changeset`);
      return {
        first,
        loaded,
        saved,
        row: await repo.changesets.findChangeset(tx, { changesetId: first.changesetid }),
        count: counted.rows[0]?.n,
        assignments: await assignmentRows(tx, first.changesetid),
      };
    });
    expect(loaded).toMatchObject({ changesetid: first.changesetid, isnew: 0, created: EARLIER, lastupdate: EARLIER, categoryid: cfId('K', 1), tags: 'keep,old' });
    expect(saved).toMatchObject({ name: 'Summer', isnew: 0, lastupdateby: 'Grace Hopper', lastupdatebyid: cfId('U', 2), errors: {} });
    expect(row).toMatchObject({
      name: 'Summer',
      published: 1,
      publishdate: new Date(2026, 6, 4, 8, 45, 0, 0),
      closedate: null,
      created: EARLIER,
      lastupdate: NOW,
      lastupdateby: 'Grace Hopper',
    });
    expect(row?.lastupdatebyid?.trim()).toBe(cfId('U', 2));
    expect(count).toBe(1);
    expect(assignments).toEqual({ categories: [cfId('K', 3)], tags: ['keep', 'new'] });
  });

  it('keeps the bean audit values when no session user saves (the scheduler path)', async () => {
    const row = await rolledBack(async (tx) => {
      const first = await saveChangesetInTx(tx, repo, bean(), ACTOR);
      const loaded = await readChangesetInTx(tx, repo, { changesetId: first.changesetid }, ANONYMOUS, fixedClock(NOW));
      await saveChangesetInTx(tx, repo, { ...loaded, published: 1 }, ANONYMOUS);
      return repo.changesets.findChangeset(tx, { changesetId: first.changesetid });
    });
    expect(row).toMatchObject({ published: 1, lastupdateby: 'Ada Lovelace' });
    expect(row?.lastupdatebyid?.trim()).toBe(ACTOR.userId);
  });

  it('writes nothing when validation fails and returns the errors', async () => {
    const { saved, row, assignments } = await rolledBack(async (tx) => {
      const saved = await saveChangesetInTx(tx, repo, bean({ name: '', categoryid: cfId('K', 1), tags: 'news' }), ACTOR);
      return {
        saved,
        row: await repo.changesets.findChangeset(tx, { changesetId: saved.changesetid }),
        assignments: await assignmentRows(tx, saved.changesetid),
      };
    });
    expect(saved.errors).toEqual({ name: "The property named 'name' is not valid" });
    expect(row).toBeNull();
    expect(assignments).toEqual({ categories: [], tags: [] });
  });

  it('creates the id of a bean saved without one', async () => {
    const saved = await rolledBack((tx) => saveChangesetInTx(tx, repo, bean({ changesetid: '' }), ACTOR));
    expect(saved.changesetid).toMatch(CF_UUID);
  });

  describe('readChangesetInTx', () => {
    const stored = cfId('S', 50);
    const lookups: Array<[string, ChangesetReadKey, boolean]> = [
      ['the id alone', { changesetId: stored }, true],
      ['the id within its site', { changesetId: stored, siteId: SITE_ID.toUpperCase() }, true],
      ['the name within the site', { name: 'Autumn', siteId: SITE_ID, changesetId: cfId('S', 99) }, true],
      ['the remote id within the site', { remoteId: 'R-50', siteId: SITE_ID }, true],
      ['the id within another site', { changesetId: stored, siteId: 'other' }, false],
      ['the name alone, which needs a site', { name: 'Autumn' }, false],
      ['an unknown id', { changesetId: cfId('S', 98), siteId: SITE_ID }, false],
    ];

    it.each(lookups)('finds by %s, else returns a new bean of the site', async (_label, key, found) => {
      const read = await rolledBack(async (tx) => {
        await saveChangesetInTx(
          tx,
          repo,
          bean({ changesetid: stored, name: 'Autumn', remoteid: 'R-50', categoryid: `${cfId('K', 2)},${cfId('K', 1)}`, tags: 'b,a' }),
          ACTOR,
        );
        return readChangesetInTx(tx, repo, key, ACTOR, fixedClock(NOW));
      });
      if (found) {
        expect(read).toMatchObject({ changesetid: stored, siteid: SITE_ID, name: 'Autumn', remoteid: 'R-50', isnew: 0, lastupdatebyid: ACTOR.userId });
        expect(read.categoryid).toBe(`${cfId('K', 1)},${cfId('K', 2)}`);
        expect(read.tags).toBe('a,b');
      } else {
        expect(read).toMatchObject({ siteid: key.siteId ?? '', name: '', isnew: 1, categoryid: '', tags: '' });
        expect(read.changesetid).not.toBe(stored);
        expect(read.changesetid).toMatch(CF_UUID);
      }
    });
  });

  it('deletes the change set and its assignments, leaving other change sets', async () => {
    const { removed, row, other, assignments } = await rolledBack(async (tx) => {
      const target = await saveChangesetInTx(tx, repo, bean({ categoryid: cfId('K', 1), tags: 'news' }), ACTOR);
      const kept = await saveChangesetInTx(tx, repo, bean({ name: 'Kept', categoryid: cfId('K', 1), tags: 'news' }), ACTOR);
      const removed = await deleteChangesetRowsInTx(tx, repo, target.changesetid);
      return {
        removed,
        row: await repo.changesets.findChangeset(tx, { changesetId: target.changesetid }),
        other: await assignmentRows(tx, kept.changesetid),
        assignments: await assignmentRows(tx, target.changesetid),
      };
    });
    expect(removed).toMatchObject({ name: 'Spring' });
    expect(row).toBeNull();
    expect(assignments).toEqual({ categories: [], tags: [] });
    expect(other).toEqual({ categories: [cfId('K', 1)], tags: ['news'] });
  });

  it('removeItemInTx detaches only the given version of the given change set', async () => {
    const changesetId = cfId('S', 60);
    const otherSet = cfId('S', 61);
    const versions = await rolledBack(async (tx) => {
      const version = (hist: string, changeset: string) =>
        repo.content.insertVersion(tx, {
          contentid: cfId('C', 1),
          contenthistid: hist,
          siteid: SITE_ID,
          type: 'Page',
          subtype: 'Default',
          moduleid: TREE,
          active: 0,
          approved: 0,
          display: 1,
          changesetid: changeset,
        });
      await version(cfId('H', 1), changesetId);
      await version(cfId('H', 2), changesetId);
      await version(cfId('H', 3), otherSet);
      const changed = await removeItemInTx(tx, repo, changesetId, cfId('H', 1));
      const mismatched = await removeItemInTx(tx, repo, changesetId, cfId('H', 3));
      const rows = await tx.query<{ contenthistid: string; changesetid: string | null }>(
        `SELECT contenthistid, changesetid FROM ${handle.schema}.content ORDER BY contenthistid`,
      );
      return { changed: changed.map((row) => row.contenthistid), mismatched, rows: rows.rows };
    });
    expect(versions.changed).toEqual([cfId('H', 1)]);
    expect(versions.mismatched).toEqual([]);
    expect(versions.rows).toEqual([
      { contenthistid: cfId('H', 1), changesetid: null },
      { contenthistid: cfId('H', 2), changesetid: changesetId },
      { contenthistid: cfId('H', 3), changesetid: otherSet },
    ]);
  });
});
