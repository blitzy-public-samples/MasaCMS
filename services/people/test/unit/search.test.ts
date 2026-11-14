/** search.ts reads over the shared people seed, identity's contract double and per-tenant transactions. */
// Constants, nextN, criteria and queryParam parsing are held to legacy in search-criteria.test.ts, LIKE in search-like.test.ts,
// column matching and the 2100-row cap in search-queries.test.ts and search-pushdown.test.ts; this suite does not repeat them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError, cfUuid, type LegacyQuery } from '@opt2/platform/legacy-compat';
import { tenantIdForSite, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA } from '@opt2/platform/testing';
import {
  DENIED_FEED_JOIN_TABLES,
  getAdvancedSearch,
  getAllSitesUsers,
  getSearch,
  getUnassignedUsers,
  getUsers,
  newAdvancedSearchCriteria,
  viewerScope,
  type AdvancedSearchCriteria,
  type SearchDeps,
  type SearchParamEntry,
  type SearchQueryArgs,
  type UsersQueryArgs,
  type ViewerScope,
} from '../../src/domain/search.js';
import type { AccountWhere } from '../../src/legacy/identity-client.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import { PG_AVAILABLE, TEST_CLOCK, createRecordingDb, withPgApp, type PgTestApp } from '../helpers/app.js';
import { createIdentityDouble } from '../helpers/identity-double.js';
import {
  ADMIN_S2,
  DEFAULT_PEOPLE_SEED,
  MODULE_008_ONLY_PERSON,
  MODULE_USER_A_PERSON,
  OTHER_TENANT,
  OTHER_TENANT_PERSON,
  POOLED_MEMBER_PERSON,
  SITE_ADMIN_A,
  SITE_ADMIN_A_PERSON,
  SYSTEM_USER_A_PERSON,
  USER_EXTENSION,
  accountFor,
  accountsForSeed,
  extendDataRow,
  personRow,
  seedPeople,
  type PeopleSeed,
  type TenantPeopleSeed,
  type TestActor,
} from '../helpers/fixtures.js';

/** The viewer of an actor's verified claims; its tenant is the one its site resolves to. */
function viewerOf(actor: TestActor, s2: boolean = actor.s2): ViewerScope {
  return viewerScope({ tid: tenantIdForSite(actor.site), site: actor.site, s2 });
}

/** Admin criteria holding `paramArray`, as admin request start-up stores them. */
function criteriaOf(paramArray: SearchParamEntry[]): AdvancedSearchCriteria {
  return { ...newAdvancedSearchCriteria(), paramArray, paramCount: paramArray.length };
}

const lnames = (query: LegacyQuery): unknown[] => query.rows.map((row) => row.Lname);
const userIds = (query: LegacyQuery): unknown[] => query.rows.map((row) => row.userID ?? row.UserID);

describe('denied feed join tables', () => {
  const viewer = viewerOf(SITE_ADMIN_A);

  /** Search deps over a database and identity that record every call and answer nothing. */
  function recordingDeps() {
    const db = createRecordingDb();
    const identity = createIdentityDouble({ clock: TEST_CLOCK });
    const deps: SearchDeps = { db, repo: createPeopleRepository({ clock: TEST_CLOCK }), identity: identity.identityClient };
    return { db, identity, deps };
  }

  // The list starts with tusers, which isDeniedFeedTable exempts as the user feed's own table.
  it.each(DENIED_FEED_JOIN_TABLES.split(',').filter((table) => table !== 'tusers'))(
    'refuses a criterion on %s as authorization before any database or identity read',
    async (table) => {
      const { db, identity, deps } = recordingDeps();
      const criteria = criteriaOf([{ field: `${table}.userid^varchar`, relationship: 'and', criteria: 'x', condition: 'Equals' }]);
      const read = getAdvancedSearch(deps, viewer, criteria, { isPublic: 0 });
      await expect(read).rejects.toBeInstanceOf(LegacyApiError);
      await expect(read).rejects.toMatchObject({ type: 'authorization' });
      expect(db.statements()).toEqual([]);
      expect(identity.requests).toEqual([]);
    },
  );

  it("lets the feed's own tusers through to the site registry read", async () => {
    const { db, identity, deps } = recordingDeps();
    const criteria = criteriaOf([{ field: 'tusers.lname^varchar', relationship: 'and', criteria: 'x', condition: 'Equals' }]);
    // The recording database holds no registry row, so the read stops at the unregistered tenant's 503.
    await expect(getAdvancedSearch(deps, viewer, criteria, { isPublic: 0 })).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    expect(db.statements().some((statement) => /tenant_registry/.test(statement.text))).toBe(true);
    expect(identity.requests).toEqual([]);
  });
});

/** One withPgApp context, open from beforeAll until afterAll. */
function pgAppForSuite(): () => PgTestApp {
  let ctx: PgTestApp | undefined;
  let release: () => void = () => undefined;
  let run: Promise<unknown> = Promise.resolve();
  beforeAll(async () => {
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await new Promise<void>((ready, fail) => {
      run = withPgApp(async (pg) => {
        ctx = pg;
        ready();
        await held;
      });
      run.then(() => ready(), fail);
    });
  });
  afterAll(async () => {
    release();
    await run;
  });
  return () => {
    if (ctx === undefined) throw new Error('withPgApp skipped: PostgreSQL became unreachable after PG_AVAILABLE was decided');
    return ctx;
  };
}

/** `db` noting the tenant of every transaction it opens. */
function tenantNoting(db: TenantDb): { db: TenantDb; tenants: () => string[] } {
  const opened: string[] = [];
  return {
    db: {
      schema: db.schema,
      withTenant: (tenantId, fn, options) => {
        opened.push(tenantId);
        return db.withTenant(tenantId, fn, options);
      },
      withMetadata: (fn, options) => db.withMetadata(fn, options),
      end: () => db.end(),
    },
    tenants: () => [...new Set(opened)].sort(),
  };
}

const A = TENANT_A.tenantId;
/** A tenant-a super-user; identity keeps S2 accounts in the private pool. */
const SUPER_A = personRow({ siteid: TENANT_A.siteId, fname: 'Sam', lname: 'Super', email: 'super@tenant-a.opt2.test' });
/** A second badgeCode value, so the extended sort has two values to order. */
const ADMIN_BADGE = extendDataRow({
  siteid: TENANT_A.siteId,
  baseid: SITE_ADMIN_A_PERSON.userid,
  attributeid: USER_EXTENSION.attributes.regex.attributeid,
  attributevalue: 'ZZ9999',
});
const SEED_A: TenantPeopleSeed = DEFAULT_PEOPLE_SEED[A] ?? {};
const SEED: PeopleSeed = {
  ...DEFAULT_PEOPLE_SEED,
  [A]: { ...SEED_A, persons: [...(SEED_A.persons ?? []), SUPER_A], extendData: [...(SEED_A.extendData ?? []), ADMIN_BADGE] },
};
const GROUP_ID = cfUuid();
/** A username no person column contains. */
const USERNAME_ONLY = 'maxwell';

/** tenant-a's private pool by last then first name. */
const TENANT_A_PRIVATE = ['Admin', 'Comma', 'Module', 'Noemail', 'Quote', 'Spaces   ', 'Super', 'System', 'Usersonly'];

describe.skipIf(!PG_AVAILABLE)('search reads over the shared people seed', () => {
  const pg = pgAppForSuite();
  const siteAdminA = viewerOf(SITE_ADMIN_A);
  const superA = viewerOf(SITE_ADMIN_A, true);
  const siteAdminB = viewerOf(OTHER_TENANT);

  /** Search deps over the suite's schema and identity double, on `db` when given. */
  function searchDeps(db: TenantDb = pg().db): SearchDeps {
    return { db, repo: createPeopleRepository({ clock: TEST_CLOCK, schema: pg().db.schema }), identity: pg().identity.identityClient };
  }

  /** `read`'s result and the identity calls it made, each one declared by identity's contract. */
  async function withIdentityCalls<T>(read: () => Promise<T>): Promise<{ result: T; calls: { operationId?: string; body: unknown }[] }> {
    const from = pg().identity.requests.length;
    const result = await read();
    return { result, calls: pg().identity.requests.slice(from).map(({ operationId, body }) => ({ operationId, body })) };
  }

  beforeAll(async () => {
    const { db, identity } = pg();
    await seedPeople(db, SEED, { clock: TEST_CLOCK });
    identity.seedAccounts(...accountsForSeed(SEED), accountFor(SUPER_A, { s2: 1 }), accountFor(MODULE_008_ONLY_PERSON, { username: USERNAME_ONLY }));
    identity.seedMemberships(SYSTEM_USER_A_PERSON.userid, [GROUP_ID]);
    identity.seedMemberships(MODULE_USER_A_PERSON.userid, [GROUP_ID]);
  });

  describe('getUsers', () => {
    it.each<[string, ViewerScope, UsersQueryArgs, string[]]>([
      ["tenant-a's public pool from umbrella", siteAdminA, { siteid: 'tenant-a' }, ['Archive', 'Member', 'Pooled']],
      ["tenant-a's private pool with its S2 user", siteAdminA, { siteid: 'tenant-a', ispublic: 0 }, TENANT_A_PRIVATE],
      ["tenant-b's own public pool", siteAdminB, { siteid: 'tenant-b' }, ['Member']],
      ["tenant-b's own private pool", siteAdminB, { siteid: 'tenant-b', ispublic: 0 }, ['Admin', 'Builder', 'Former']],
    ])('lists %s in name order with one account lookup', async (_label, viewer, args, expected) => {
      const { result, calls } = await withIdentityCalls(() => getUsers(searchDeps(), viewer, args));
      expect(lnames(result)).toEqual(expected);
      expect(calls.map((call) => call.operationId)).toEqual(['lookupAccounts']);
    });

    it.each<[string, (deps: SearchDeps) => Promise<LegacyQuery>, string[], AccountWhere]>([
      [
        'hides S2 users for showsuperusers true',
        (deps) => getUsers(deps, siteAdminA, { siteid: 'tenant-a', ispublic: 0, showsuperusers: true }),
        TENANT_A_PRIVATE.filter((lname) => lname !== 'Super'),
        { isPublic: 0, excludeS2Users: true },
      ],
      [
        'lists only users without a membership for getUnassignedUsers',
        (deps) => getUnassignedUsers(deps, siteAdminA, { siteid: 'tenant-a', ispublic: 0 }),
        TENANT_A_PRIVATE.filter((lname) => lname !== 'Module' && lname !== 'System'),
        { isPublic: 0, unassigned: true },
      ],
    ])('%s, identity applying the account filter', async (_label, read, expected, where) => {
      const { result, calls } = await withIdentityCalls(() => read(searchDeps()));
      expect(lnames(result)).toEqual(expected);
      expect(calls.map((call) => (call.body as { where?: unknown }).where)).toEqual([where]);
    });
  });

  describe('getSearch', () => {
    it.each<[string, ViewerScope, SearchQueryArgs, string[]]>([
      ['no S2 user for a viewer without S2', siteAdminA, { search: 'super' }, []],
      ['the S2 user for an S2 viewer', superA, { search: 'super' }, [SUPER_A.userid]],
      ['a user by identity username alone', siteAdminA, { search: USERNAME_ONLY }, [MODULE_008_ONLY_PERSON.userid]],
      ["tenant-a's public members in umbrella", siteAdminA, { search: 'pooled', isPublic: 1 }, [POOLED_MEMBER_PERSON.userid]],
      ["no umbrella member for tenant-b, whose public pool is its own", siteAdminB, { search: 'pooled', isPublic: 1 }, []],
      ["tenant-b's admin only, not tenant-a's", siteAdminB, { search: 'admin' }, [OTHER_TENANT_PERSON.userid]],
    ])('finds %s', async (_label, viewer, args, expected) => {
      expect(userIds(await getSearch(searchDeps(), viewer, args))).toEqual(expected);
    });
  });

  describe('getAdvancedSearch over the seeded user extension', () => {
    /** Last names of the users with a badgeCode value, highest value first. */
    const badgeHolders = ['Admin', 'System'];

    it('filters by an extended attribute criterion', async () => {
      const criteria = criteriaOf([{ field: 'employeeNumber^varchar', relationship: 'and', criteria: 'E1001', condition: 'Equals' }]);
      expect(userIds(await getAdvancedSearch(searchDeps(), siteAdminA, criteria, { isPublic: 0 }))).toEqual([SYSTEM_USER_A_PERSON.userid]);
    });

    it.each<[string, (rows: unknown[]) => unknown[], string[]]>([
      ['desc', (rows) => rows.slice(0, 2), badgeHolders],
      ['asc', (rows) => rows.slice(-2), [...badgeHolders].reverse()],
    ])('sorts by the extended attribute value %s, users without one as NULL', async (sortDirection, valued, expected) => {
      const result = await getAdvancedSearch(searchDeps(), siteAdminA, newAdvancedSearchCriteria(), { isPublic: 0, sortBy: 'badgeCode', sortDirection });
      // A viewer without S2 never sees Super, so the eight other private-pool users remain.
      expect(result.rows).toHaveLength(TENANT_A_PRIVATE.length - 1);
      expect(valued(lnames(result))).toEqual(expected);
    });
  });

  describe('getAllSitesUsers', () => {
    const REGISTERED = [TENANT_A.tenantId, TENANT_B.tenantId, TENANT_UMBRELLA.tenantId].sort();

    it.each<[string, UsersQueryArgs['ispublic'], string[], string[]]>([
      ['system users', 0, ['Admin', 'Admin', 'Builder', 'Comma', 'Former', ...TENANT_A_PRIVATE.slice(2)], ['Blake', 'Sasha']],
      ['site members', 1, ['Archive', 'Member', 'Member', 'Pooled'], ['Alex', 'Jordan', 'Robin', 'Pat']],
    ])(
      'reads the %s of every registered tenant in its own transactions for an S2 viewer, merged by last then first name',
      async (_label, ispublic, expectedLnames, leadingFnames) => {
        const noting = tenantNoting(pg().db);
        const { result, calls } = await withIdentityCalls(() => getAllSitesUsers(searchDeps(noting.db), viewerOf(ADMIN_S2), { ispublic }));
        expect(lnames(result)).toEqual(expectedLnames);
        expect(result.rows.slice(0, leadingFnames.length).map((row) => row.Fname)).toEqual(leadingFnames);
        // The installed `default` site is not in the registry, so its users are not listed.
        expect(noting.tenants()).toEqual(REGISTERED);
        expect(new Set(calls.map((call) => call.operationId))).toEqual(new Set(['lookupAccountsAllSites']));
      },
    );

    it("reads only its own site's pool tenant for a viewer without S2", async () => {
      const noting = tenantNoting(pg().db);
      const { result, calls } = await withIdentityCalls(() => getAllSitesUsers(searchDeps(noting.db), siteAdminA, { ispublic: 0 }));
      expect(lnames(result)).toEqual(TENANT_A_PRIVATE);
      expect(noting.tenants()).toEqual([TENANT_A.tenantId]);
      expect(calls.map((call) => call.operationId)).toEqual(['lookupAccounts']);
    });
  });
});
