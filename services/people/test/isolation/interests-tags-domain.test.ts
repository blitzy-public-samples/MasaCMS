/** Interest and tag writes of a user save: the interest delete scope and the tag replacement, against a throwaway `people` schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { writeInterests, writeTags, type InterestWriteOptions } from '../../src/domain/interests-tags.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';
import { PEOPLE_UNITS } from '../../src/repo/tables.js';

const available = await pgAvailable();

describe.skipIf(!available)('interest and tag writes against PostgreSQL', () => {
  let handle: ThrowawaySchema | undefined;
  let db: TenantDb;
  let schema: string;
  let repo: PeopleRepository;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    db = handle.app;
    schema = handle.schema;
    await ensureUnitGates(db, PEOPLE_UNITS);
    await closeGates(db, { units: PEOPLE_UNITS, holderId: 'interests-tags-test', allowLegacy: true });
    await openGates(db, { units: PEOPLE_UNITS, holderId: 'interests-tags-test', state: 'open' });
    repo = createPeopleRepository({ clock: fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0)), schema });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return db.withTenant(TENANT_A.tenantId, fn);
  }

  async function storedInterests(userId: string): Promise<string[]> {
    const { rows } = await inTenant((tx) => tx.query<{ categoryid: string }>(`SELECT categoryid FROM ${schema}.user_interest WHERE userid = $1`, [userId]));
    return rows.map((row) => row.categoryid.trim()).sort();
  }

  async function storedTags(userId: string): Promise<Array<[string, string | null]>> {
    const { rows } = await inTenant((tx) =>
      tx.query<{ tag: string; siteid: string | null }>(`SELECT tag, siteid FROM ${schema}.user_tag WHERE userid = $1 ORDER BY tagid`, [userId]),
    );
    return rows.map((row) => [row.tag, row.siteid]);
  }

  it.each<[string, InterestWriteOptions, string, string[], string[]]>([
    ['leaves every interest when updateInterests is off', { updateInterests: false, originId: 'tenant-a', originCategoryIds: ['OLD'] }, 'NEW', [], ['KEPT', 'OLD']],
    ['replaces every interest without an origin site', { updateInterests: true }, 'NEW,NEW,,OTHER', ['NEW', 'OTHER'], ['NEW', 'OTHER']],
    ['deletes only the origin site categories', { updateInterests: true, originId: 'tenant-a', originCategoryIds: ['OLD'] }, 'NEW', ['NEW'], ['KEPT', 'NEW']],
    ['deletes nothing for an origin site without categories', { updateInterests: true, originId: 'tenant-a' }, 'NEW', ['NEW'], ['KEPT', 'NEW', 'OLD']],
  ])('%s', async (_label, opts, list, inserted, stored) => {
    const userId = cfUuid();
    await inTenant((tx) => repo.replaceInterests(tx, userId, ['KEPT', 'OLD']));

    const rows = await inTenant((tx) => writeInterests(repo, tx, userId, list, opts, {}));

    expect(rows.map((row) => row.categoryid.trim())).toStrictEqual(inserted);
    expect(await storedInterests(userId)).toStrictEqual(stored);
  });

  it('replaces the tags under the user site id with the trimmed items of the list', async () => {
    const userid = cfUuid();
    await inTenant((tx) => writeTags(repo, tx, { userid, siteid: 'umbrella', tags: 'old' }, {}));

    const rows = await inTenant((tx) => writeTags(repo, tx, { userid, siteid: TENANT_A.siteId, tags: ' red ,, blue,red' }, {}));

    expect(rows.map((row) => row.tag)).toStrictEqual(['red', 'blue', 'red']);
    expect(await storedTags(userid)).toStrictEqual([
      ['red', TENANT_A.siteId],
      ['blue', TENANT_A.siteId],
      ['red', TENANT_A.siteId],
    ]);
  });
});
