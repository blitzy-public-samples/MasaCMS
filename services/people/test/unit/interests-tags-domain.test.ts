/** Interest and tag writes of a user save: the legacy comma-list rules and the interest delete scope, against a throwaway `people` schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { interestRowsFor, tagRowsFor, writeInterests, writeTags, type InterestWriteOptions } from '../../src/domain/interests-tags.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';
import { PEOPLE_UNITS } from '../../src/repo/tables.js';

describe('interestRowsFor', () => {
  it.each<[string, string, string[]]>([
    ['an empty list', '', []],
    ['empty items skipped', ',a,,b,', ['a', 'b']],
    ['exact repeats collapsed to the first', 'a,b,a,b', ['a', 'b']],
    ['items kept untrimmed and case-sensitive', 'a, a,A', ['a', ' a', 'A']],
  ])('inserts %s', (_label, list, expected) => {
    expect(interestRowsFor('U-1', list)).toStrictEqual(expected.map((categoryid) => ({ userid: 'U-1', categoryid })));
  });
});

describe('tagRowsFor', () => {
  it.each<[string, string, string[]]>([
    ['an empty list', '', []],
    ['each item trimmed of spaces and control characters', ' red ,\tblue\n', ['red', 'blue']],
    ['blank items dropped', 'a,, ,\t,b', ['a', 'b']],
    ['duplicates kept in list order', 'red,blue,red', ['red', 'blue', 'red']],
    ['a non-breaking space kept, as CFML trim keeps it', '\u00a0x\u00a0', ['\u00a0x\u00a0']],
  ])('inserts %s', (_label, list, expected) => {
    expect(tagRowsFor('U-1', 'site-1', list)).toStrictEqual(expected.map((tag) => ({ userid: 'U-1', siteid: 'site-1', tag })));
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('interest and tag writes against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: PeopleRepository;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, PEOPLE_UNITS);
    await closeGates(handle.app, { units: PEOPLE_UNITS, holderId: 'interests-tags-test', allowLegacy: true });
    await openGates(handle.app, { units: PEOPLE_UNITS, holderId: 'interests-tags-test', state: 'open' });
    repo = createPeopleRepository({ clock: fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0)), schema: handle.schema });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return handle.app.withTenant(TENANT_A.tenantId, fn);
  }

  async function storedInterests(userId: string): Promise<string[]> {
    const { rows } = await inTenant((tx) => tx.query<{ categoryid: string }>(`SELECT categoryid FROM ${handle.schema}.user_interest WHERE userid = $1`, [userId]));
    return rows.map((row) => row.categoryid.trim()).sort();
  }

  async function storedTags(userId: string): Promise<Array<[string, string | null]>> {
    const { rows } = await inTenant((tx) =>
      tx.query<{ tag: string; siteid: string | null }>(`SELECT tag, siteid FROM ${handle.schema}.user_tag WHERE userid = $1 ORDER BY tagid`, [userId]),
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
