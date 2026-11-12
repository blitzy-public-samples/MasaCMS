/** User list, search and advanced-search queries of search.ts over a throwaway `people` schema, held to legacy userGateway results. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError, legacyQuery, type LegacyQuery } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { tenantIdForSite, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  seedRegistry,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  SEARCH_FIELD_LIST,
  SEARCH_MAX_ROWS,
  USERS_LIST_COLUMNS,
  getAdvancedSearch,
  getSearch,
  getUnassignedUsers,
  getUsers,
  newAdvancedSearchCriteria,
  searchAllSites,
  type AdvancedSearchCriteria,
  type AdvancedSearchOptions,
  type SearchDeps,
  type SearchParamEntry,
  type UserFeedKeys,
  type ViewerScope,
} from '../../src/domain/search.js';
import type { AccountView } from '../../src/legacy/identity-client.js';
import { createPeopleRepository, type PeopleRepository, type PersonInput } from '../../src/repo/repository.js';
import { PEOPLE_UNITS } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const NOWHERE = tenantIdForSite('nowhere');

/** A 35-character legacy id whose first block is `tag` padded with zeros. */
function id(tag: string): string {
  return `${tag.padEnd(8, '0')}-0000-0000-0000000000000000`;
}

/** The tags of a query's user ids, in row order. */
function tags(query: LegacyQuery): string[] {
  return query.rows.map((row) => String(row.userID ?? row.UserID).slice(0, 8).replace(/0+$/, ''));
}

/** One stored advanced-search row. */
function param(field: string, condition: string, criteria: string, relationship = 'and'): SearchParamEntry {
  return { field, relationship, criteria, condition };
}

/** The error name, legacy type and query detail a read rejects with. */
async function rejection(read: Promise<unknown>): Promise<{ name: string; type: unknown; detail: unknown }> {
  try {
    await read;
  } catch (err) {
    const failure = err as { name: string; type?: unknown; cause?: { message?: unknown } };
    return { name: failure.name, type: failure.type, detail: failure.cause?.message };
  }
  throw new Error('the read resolved');
}

/** Identity's account columns of one user, legacy defaults for a member of the private pool. */
function account(tag: string, siteId: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    userId: id(tag),
    siteId,
    username: tag.toLowerCase(),
    s2: 0,
    isPublic: 0,
    inactive: 0,
    type: 2,
    perm: 0,
    admin: 0,
    remoteId: null,
    lastLogin: null,
    passwordCreated: null,
    tablist: null,
    ...overrides,
  };
}

type IdentityReads = SearchDeps['identity'];

/** In-file identity double: the two reads search.ts makes, with a call count. */
class FakeIdentity implements IdentityReads {
  readonly accounts = new Map<string, AccountView>();
  readonly memberships = new Map<string, string[]>();
  readAccountCalls = 0;

  async readAccounts(userIds: readonly string[]): Promise<Map<string, AccountView>> {
    this.readAccountCalls += 1;
    const found = new Map<string, AccountView>();
    for (const userId of userIds) {
      const view = this.accounts.get(userId.trim());
      if (view !== undefined) found.set(userId, view);
    }
    return found;
  }

  async membershipGroupIds(userId: string): Promise<string[]> {
    return [...(this.memberships.get(userId.trim()) ?? [])];
  }
}

/** pgAvailable asked up to three times, so one connect slower than its 2 s limit under host load does not skip the suite. */
async function pgReachable(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await pgAvailable()) return true;
  }
  return false;
}

const available = await pgReachable();

describe.skipIf(!available)('people search queries against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: PeopleRepository;
  let deps: SearchDeps;
  const identity = new FakeIdentity();

  const viewerA: ViewerScope = { tid: TENANT_A.tenantId, site: TENANT_A.siteId, isS2: false };
  const adminA: ViewerScope = { ...viewerA, isS2: true };
  const adminB: ViewerScope = { tid: TENANT_B.tenantId, site: TENANT_B.siteId, isS2: true };
  const stranger: ViewerScope = { tid: NOWHERE, site: 'nowhere', isS2: true };

  /** Runs `fn` in one transaction of `tenant`. */
  function inTenant<T>(tenant: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  /** Inserts a person through the repository, with `created` and `lastupdate` at `at`. */
  async function addPerson(tenant: string, tag: string, input: Partial<PersonInput>, at: Date = NOW): Promise<void> {
    const writer = createPeopleRepository({ clock: fixedClock(at), schema: handle.schema });
    const row: PersonInput = {
      userid: id(tag),
      groupname: '',
      fname: '',
      lname: '',
      email: '',
      company: '',
      jobtitle: '',
      mobilephone: '',
      website: '',
      subtype: 'Default',
      contactform: '',
      lastupdateby: 'Ada Admin',
      lastupdatebyid: 'ACTOR',
      siteid: '',
      subscribe: 1,
      notes: '',
      description: '',
      interests: '',
      keepprivate: 0,
      photofileid: '',
      imname: '',
      imservice: '',
      tags: '',
      ...input,
    };
    await inTenant(tenant, (tx) => writer.insertPerson(tx, row));
  }

  /** An advanced search of `paramArray` with admin session defaults plus `extra`. */
  function advanced(
    paramArray: SearchParamEntry[],
    options: AdvancedSearchOptions = { isPublic: 0 },
    extra: Partial<AdvancedSearchCriteria & UserFeedKeys> = {},
    viewer: ViewerScope = adminA,
    searchDeps: SearchDeps = deps,
  ): Promise<LegacyQuery> {
    return getAdvancedSearch(searchDeps, viewer, { ...newAdvancedSearchCriteria(), paramArray, paramCount: paramArray.length, ...extra }, options);
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await seedRegistry(handle.app);
    await ensureUnitGates(handle.app, PEOPLE_UNITS);
    await closeGates(handle.app, { units: PEOPLE_UNITS, holderId: 'search-queries-test', allowLegacy: true });
    await openGates(handle.app, { units: PEOPLE_UNITS, holderId: 'search-queries-test', state: 'open' });
    repo = createPeopleRepository({ clock: fixedClock(NOW), schema: handle.schema });
    deps = { db: handle.app, repo, identity };

    const a = TENANT_A.tenantId;
    const site = TENANT_A.siteId;
    await addPerson(a, 'A1', {
      fname: 'Augusta',
      lname: 'Lovelace',
      company: 'Analytical Engines',
      email: 'al@byron.test',
      jobtitle: 'Mathematician',
      photofileid: id('F1'),
      tags: 'math',
      siteid: site,
    }, new Date(2026, 0, 10, 0, 0, 0, 0));
    await addPerson(a, 'A2', { fname: 'Bob', lname: 'Brown', company: 'Acme', email: 'bob@acme.test', siteid: site }, new Date(2026, 1, 10, 0, 0, 0, 0));
    await addPerson(a, 'A3', { fname: 'Cy', lname: 'Browne', email: 'cy@acme.test', siteid: site }, new Date(2026, 2, 10, 0, 0, 0, 0));
    await addPerson(a, 'A4', { fname: 'Dee', company: 'Zeta', siteid: site }, new Date(2026, 3, 5, 9, 5, 0, 0));
    await addPerson(a, 'A5', { fname: 'Eve', lname: 'Ghost', siteid: site });
    await addPerson(a, 'A6', { fname: 'Gus', lname: 'Group', siteid: site });
    await addPerson(a, 'A7', { fname: 'Pia', lname: 'Open', siteid: site });
    await addPerson(TENANT_UMBRELLA.tenantId, 'U1', { fname: 'Uma', lname: 'Public', email: 'uma@pub.test', siteid: TENANT_UMBRELLA.siteId });
    await addPerson(TENANT_UMBRELLA.tenantId, 'U2', { fname: 'Ulf', lname: 'Admin', siteid: TENANT_UMBRELLA.siteId });
    await addPerson(TENANT_B.tenantId, 'B1', { fname: 'Bea', lname: 'Bravo', siteid: TENANT_B.siteId });
    await addPerson(TENANT_B.tenantId, 'B2', { fname: 'Al', lname: 'Bravo', siteid: TENANT_B.siteId });

    for (const view of [
      account('A1', site, {
        username: 'countess',
        remoteId: 'R-A1',
        tablist: 'basic',
        lastLogin: '2026-06-29 08:15:00',
        passwordCreated: '2026-01-02T09:00:00.5',
      }),
      account('A2', site, { username: 'bobb', s2: 1 }),
      account('A3', site, { username: 'cyb', inactive: 1 }),
      account('A4', site, { username: 'dee', s2: null }),
      account('A6', site, { type: 1 }),
      account('A7', site, { isPublic: 1 }),
      account('U1', TENANT_UMBRELLA.siteId, { isPublic: 1 }),
      account('U2', TENANT_UMBRELLA.siteId, { isPublic: 1, s2: 1 }),
      account('B1', TENANT_B.siteId),
      account('B2', TENANT_B.siteId),
    ]) {
      identity.accounts.set(view.userId, view);
    }
    identity.memberships.set(id('A1'), ['G1']);
    identity.memberships.set(id('A3'), ['G2']);
    identity.memberships.set(id('U2'), ['G9']);

    await inTenant(a, async (tx) => {
      await repo.insertAddress(tx, { userid: id('A1'), siteid: site, city: 'Paris', zip: '75001', longitude: 2.35 });
      await repo.insertAddress(tx, { userid: id('A1'), siteid: site, city: 'Paris', zip: '75002', longitude: 2.35 });
      await repo.insertAddress(tx, { userid: id('A2'), siteid: site, city: 'Lyon', longitude: 1234567, latitude: 0.00001 });
      await repo.replaceTags(tx, { userId: id('A1'), siteId: site, tags: 'math,poetry' });
      await repo.replaceTags(tx, { userId: id('A3'), siteId: site, tags: 'poetry' });
      await repo.replaceInterests(tx, id('A1'), ['C1']);
      await repo.replaceInterests(tx, id('A2'), ['C2']);
      await repo.insert(tx, 'user_favorite', {
        favoriteid: id('FAV1'),
        userid: id('A2'),
        favoritename: 'Home',
        favorite: 'content-1',
        type: 'Page',
        siteid: site,
        datecreated: NOW,
        columnnumber: null,
        rownumber: null,
        maxrssitems: null,
      });
      for (const [attributeid, name, validation] of [
        [101, 'favcolor', null],
        [102, 'shoesize', 'Numeric'],
        [103, 'joined', 'Date'],
      ] as const) {
        await repo.insert(tx, 'extend_attribute', {
          attributeid,
          extendsetid: id('SET1'),
          siteid: site,
          name,
          label: name,
          hint: null,
          type: 'TextBox',
          orderno: attributeid,
          isactive: 1,
          required: 'false',
          validation,
          regex: null,
          message: null,
          defaultvalue: null,
          optionlist: null,
          optionlabellist: null,
          adminonly: 0,
        });
      }
      const value = (text: string | null, typed: { numericvalue?: number; datetimevalue?: Date } = {}) => ({
        row: {
          siteid: site,
          attributevalue: text,
          remoteid: null,
          datetimevalue: typed.datetimevalue ?? null,
          numericvalue: typed.numericvalue ?? null,
          stringvalue: text,
        },
      });
      await repo.replaceExtendData(tx, id('A1'), [
        { attributeId: 101, ...value('blue') },
        { attributeId: 102, ...value('9', { numericvalue: 9 }) },
        { attributeId: 103, ...value('2020-05-01', { datetimevalue: new Date(2020, 4, 1) }) },
      ]);
      await repo.replaceExtendData(tx, id('A2'), [
        { attributeId: 101, ...value(null) },
        { attributeId: 102, ...value('10', { numericvalue: 10 }) },
      ]);
      await repo.replaceExtendData(tx, id('A3'), [
        { attributeId: 101, ...value('green') },
        { attributeId: 102, ...value('11', { numericvalue: 11 }) },
        { attributeId: 103, ...value('2024-01-01', { datetimevalue: new Date(2024, 0, 1) }) },
      ]);
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  describe('getUsers', () => {
    it.each<[string, Parameters<typeof getUsers>[2], string[]]>([
      ['the private pool by last then first name, NULL names first', { siteid: 'tenant-a', ispublic: 0 }, ['A4', 'A2', 'A3', 'A1']],
      ['the public pool by default', { siteid: 'tenant-a' }, ['U2', 'U1']],
      ['the viewer tenant without a site, public users by default', {}, ['A7']],
      ['every user of the viewer tenant for an empty ispublic', { ispublic: '' }, ['A4', 'A2', 'A3', 'A1', 'A7']],
      ['no S2 or NULL S2 users for showsuperusers true', { siteid: 'tenant-a', ispublic: 0, showsuperusers: 'true' }, ['A3', 'A1']],
      ['no S2 or NULL S2 users for showsuperusers 1', { siteid: 'tenant-a', ispublic: 0, showsuperusers: 1 }, ['A3', 'A1']],
      ['S2 users for showsuperusers no', { siteid: 'tenant-a', ispublic: 0, showsuperusers: 'no' }, ['A4', 'A2', 'A3', 'A1']],
      ['only users without a membership for isunassigned', { siteid: 'tenant-a', ispublic: '0', isunassigned: 'yes' }, ['A4', 'A2']],
      ['members too for a non-boolean isunassigned', { siteid: 'tenant-a', ispublic: 0, isunassigned: 'maybe' }, ['A4', 'A2', 'A3', 'A1']],
    ])('lists %s', async (_label, args, expected) => {
      expect(tags(await getUsers(deps, viewerA, args))).toEqual(expected);
    });

    it('orders equal last names by first name', async () => {
      expect(tags(await getUsers(deps, adminB, { siteid: 'tenant-b', ispublic: 0 }))).toEqual(['B2', 'B1']);
    });

    it('answers the getUsers columns from person and account', async () => {
      const result = await getUsers(deps, viewerA, { siteid: 'tenant-a', ispublic: 0 });
      expect(result.columnList).toEqual([...USERS_LIST_COLUMNS]);
      expect(result.rows.at(-1)).toEqual({
        UserID: id('A1'),
        GroupName: null,
        Fname: 'Augusta',
        Lname: 'Lovelace',
        UserName: 'countess',
        Email: 'al@byron.test',
        Type: 2,
        subType: 'Default',
        Admin: 0,
        S2: 0,
        LastUpdate: new Date(2026, 0, 10, 0, 0, 0, 0),
        LastUpdateBy: 'Ada Admin',
        isPublic: 0,
        SiteID: 'tenant-a',
      });
    });

    it('rejects a non-numeric ispublic as the integer binding does', async () => {
      expect(await rejection(getUsers(deps, viewerA, { siteid: 'tenant-a', ispublic: 'x' }))).toEqual({
        name: 'LegacyApiError',
        type: 'server_error',
        detail: 'Invalid data x for CFSQLTYPE CF_SQL_INTEGER.',
      });
    });
  });

  describe('getUnassignedUsers', () => {
    it.each<[string, Parameters<typeof getUnassignedUsers>[2], string[]]>([
      ['public pool users without a membership by default', { siteid: 'tenant-a' }, ['U1']],
      ['private pool users without a membership', { siteid: 'tenant-a', ispublic: 0 }, ['A4', 'A2']],
    ])('lists %s', async (_label, args, expected) => {
      expect(tags(await getUnassignedUsers(deps, viewerA, args))).toEqual(expected);
    });
  });

  describe('getSearch', () => {
    it.each<[string, string, ViewerScope, string[]]>([
      ['first name', 'gust', viewerA, ['A1']],
      ['last name, ignoring case', 'VELAC', viewerA, ['A1']],
      ['company', 'engines', viewerA, ['A1']],
      ['identity username', 'ountes', viewerA, ['A1']],
      ['email', 'byron', viewerA, ['A1']],
      ['job title', 'thematic', viewerA, ['A1']],
      ['any column, S2 users hidden from a non-S2 viewer', 'acme', viewerA, ['A3']],
      ['any column for an S2 viewer, by last name', 'acme', adminA, ['A2', 'A3']],
      ['% as any text', '%', adminA, ['A4', 'A2', 'A3', 'A1']],
      ['_ as one character', 'Brow_e', adminA, ['A3']],
      ['a [ ] class', 'Brow[n]', adminA, ['A2', 'A3']],
      ['a [^ ] class', 'Brow[^n]', adminA, []],
      ['a literal dot', 'byron.test', adminA, ['A1']],
      ['_ matching a dot', 'byron_test', adminA, ['A1']],
      ['no match for other text', 'byronxtest', adminA, []],
      ['an unclosed [ as text', '[abc', adminA, []],
    ])('matches %s', async (_label, search, viewer, expected) => {
      expect(tags(await getSearch(deps, viewer, { search }))).toEqual(expected);
    });

    it('searches the public pool for isPublic 1', async () => {
      expect(tags(await getSearch(deps, viewerA, { search: 'u', isPublic: 1 }))).toEqual(['U1']);
    });

    it('answers no rows for an empty term without reading identity', async () => {
      const calls = identity.readAccountCalls;
      const result = await getSearch(deps, adminA, { search: '' });
      expect(result).toEqual(legacyQuery([...SEARCH_FIELD_LIST], []));
      expect(identity.readAccountCalls).toBe(calls);
    });

    it('answers the fieldList columns with the photo extension', async () => {
      const asked: (string | null | undefined)[][] = [];
      const photoFileExts = async (fileIds: readonly (string | null | undefined)[]): Promise<ReadonlyMap<string, string>> => {
        asked.push([...fileIds]);
        return new Map([[id('F1'), 'jpg']]);
      };
      const result = await getSearch({ ...deps, photoFileExts }, adminA, { search: 'gust', isPublic: '0' });
      expect(asked).toEqual([[id('F1')]]);
      expect(result.columnList).toEqual([...SEARCH_FIELD_LIST]);
      expect(result.rows).toEqual([
        {
          userID: id('A1'),
          GroupName: null,
          Fname: 'Augusta',
          Lname: 'Lovelace',
          UserName: 'countess',
          PasswordCreated: new Date(2026, 0, 2, 9, 0, 0, 500),
          Email: 'al@byron.test',
          Company: 'Analytical Engines',
          JobTitle: 'Mathematician',
          MobilePhone: null,
          Website: null,
          Type: 2,
          subType: 'Default',
          ContactForm: null,
          S2: 0,
          LastLogin: new Date(2026, 5, 29, 8, 15, 0, 0),
          LastUpdate: new Date(2026, 0, 10, 0, 0, 0, 0),
          LastUpdateBy: 'Ada Admin',
          LastUpdateByID: 'ACTOR',
          Perm: 0,
          InActive: 0,
          IsPublic: 0,
          SiteID: 'tenant-a',
          Subscribe: 1,
          Notes: null,
          description: null,
          Interests: null,
          keepPrivate: 0,
          PhotoFileID: id('F1'),
          IMName: null,
          IMService: null,
          Created: new Date(2026, 0, 10, 0, 0, 0, 0),
          RemoteID: 'R-A1',
          Tags: 'math',
          tablist: 'basic',
          photoFileExt: 'jpg',
        },
      ]);
    });

    it('rejects a non-numeric isPublic as a server error', async () => {
      expect(await rejection(getSearch(deps, viewerA, { search: 'a', isPublic: 'abc' }))).toMatchObject({ name: 'LegacyApiError', type: 'server_error' });
    });

    describe('with more matches than maxrows', () => {
      const bulk = SEARCH_MAX_ROWS + 1;
      const bulkId = (n: number): string => `Z${String(n).padStart(7, '0')}-0000-0000-0000000000000000`;

      beforeAll(async () => {
        await inTenant(TENANT_B.tenantId, (tx) =>
          tx.query(
            `INSERT INTO "${handle.schema}".person (tenant_id, userid, fname, lname, siteid)` +
              " SELECT $1, 'Z' || lpad(g::text, 7, '0') || '-0000-0000-0000000000000000', 'Bulk', 'Zbulk' || lpad(g::text, 5, '0'), 'tenant-b'" +
              ' FROM generate_series(1, $2::int) AS g',
            [tx.tenantId, bulk],
          ),
        );
        for (let n = 1; n <= bulk; n += 1) identity.accounts.set(bulkId(n), { ...account('Z', 'tenant-b'), userId: bulkId(n) });
      });

      afterAll(async () => {
        for (let n = 1; n <= bulk; n += 1) identity.accounts.delete(bulkId(n));
        await inTenant(TENANT_B.tenantId, (tx) => tx.query(`DELETE FROM "${handle.schema}".person WHERE tenant_id = $1 AND lname LIKE 'Zbulk%'`, [tx.tenantId]));
      });

      it('stops at 2100 rows after ordering by last name', async () => {
        const result = await getSearch(deps, adminB, { search: 'zbulk' });
        expect(result.rows).toHaveLength(SEARCH_MAX_ROWS);
        expect(result.rows.at(0)?.Lname).toBe('Zbulk00001');
        expect(result.rows.at(-1)?.Lname).toBe('Zbulk02100');
      });
    });
  });

  describe('getAdvancedSearch', () => {
    it.each<[string, AdvancedSearchOptions, Partial<AdvancedSearchCriteria & UserFeedKeys>, ViewerScope, string[]]>([
      ['the private pool for isPublic 0', { isPublic: 0 }, {}, adminA, ['A4', 'A2', 'A3', 'A1']],
      ['only S2 0 users for a non-S2 viewer', { isPublic: 0 }, {}, viewerA, ['A3', 'A1']],
      ['the public pool by default', {}, {}, adminA, ['U2', 'U1']],
      ['both pools for an empty ispublic, without an isPublic filter', {}, { ispublic: '' }, adminA, ['A4', 'U2', 'A2', 'A3', 'A1', 'A7', 'U1']],
      ['one pool when both pools are the site', { sortBy: 'fname' }, { ispublic: '' }, adminB, ['B2', 'B1']],
      ['active users for inActive 0', { isPublic: 0 }, { inActive: '0' }, adminA, ['A4', 'A2', 'A1']],
      ['users interested in a listed category', { isPublic: 0 }, { categoryID: 'C1,C2' }, adminA, ['A2', 'A1']],
      ['members of a listed group', { isPublic: 0 }, { groupID: 'G1,G2' }, adminA, ['A3', 'A1']],
      ['members of a group named in another case', { isPublic: 0 }, { groupID: 'g1' }, adminA, ['A1']],
      ['type 1 rows for type group', { isPublic: 0 }, { type: 'group' }, adminA, ['A6']],
    ])('finds %s', async (_label, options, extra, viewer, expected) => {
      expect(tags(await advanced([], options, extra, viewer))).toEqual(expected);
    });

    it('counts the matches for countOnly', async () => {
      expect(await advanced([], { isPublic: 0, countOnly: true, sortBy: 'shoesize' })).toEqual(legacyQuery(['count'], [{ count: 4 }]));
    });

    it('answers the fieldList columns with the photo extension', async () => {
      const photoFileExts = async (): Promise<ReadonlyMap<string, string>> => new Map([[id('F1'), 'jpg']]);
      const result = await advanced([param('tusers.lname^varchar', 'Equals', 'Lovelace')], { isPublic: 0 }, {}, adminA, { ...deps, photoFileExts });
      expect(result.columnList).toEqual([...SEARCH_FIELD_LIST]);
      expect(result.rows.map((row) => [row.userID, row.photoFileExt])).toEqual([[id('A1'), 'jpg']]);
    });

    it.each<[string, SearchParamEntry[], string[]]>([
      ['equal text, ignoring case', [param('tusers.lname^varchar', 'Equals', 'lovelace')], ['A1']],
      ['unequal text, NULL never matching', [param('tusers.lname^varchar', 'NEQ', 'Brown')], ['A3', 'A1']],
      ['contained text', [param('tusers.email^varchar', 'Contains', 'acme')], ['A2', 'A3']],
      ['a prefix', [param('tusers.email^varchar', 'BeginsWith', 'cy')], ['A3']],
      ['a suffix, NULL never matching', [param('tusers.email^varchar', 'EndsWith', '.test')], ['A2', 'A3', 'A1']],
      ['a list', [param('tusers.fname^varchar', 'in', 'Augusta,Cy')], ['A3', 'A1']],
      ['outside a list', [param('tusers.fname^varchar', 'notin', 'Augusta,Cy')], ['A4', 'A2']],
      ['IS NULL for criteria null', [param('tusers.company^varchar', 'Equals', 'null')], ['A3']],
      ['IS NOT NULL for criteria null', [param('tusers.company^varchar', 'NEQ', 'null')], ['A4', 'A2', 'A1']],
      ['a numeric column', [param('tusers.inactive^numeric', 'Equals', '1')], ['A3']],
      ['a bit column', [param('tusers.inactive^bit', 'Equals', 'true')], ['A3']],
      ['an integer column against text it converts', [param('tusers.inactive^varchar', 'Equals', '1')], ['A3']],
      ['an integer column against a text list', [param('tusers.inactive^varchar', 'in', '0,1')], ['A4', 'A2', 'A3', 'A1']],
      ['an integer column as LIKE text', [param('tusers.inactive^varchar', 'Contains', '1')], ['A3']],
      ['a datetime column against date text', [param('tusers.created^varchar', 'GT', '2026-03-01')], ['A4', 'A3']],
      ['a date criterion', [param('tusers.created^date', 'Equals', '2026-01-10')], ['A1']],
      ['a later date criterion', [param('tusers.created^date', 'GTE', '2026-03-01')], ['A4', 'A3']],
      ['an earlier or equal date criterion', [param('tusers.created^date', 'LTE', '2026-02-10')], ['A2', 'A1']],
      ['a timestamp criterion', [param('tusers.created^timestamp', 'LT', '2026-02-10 00:00:01')], ['A2', 'A1']],
      ['a datetime as SQL Server style 0 text', [param('tusers.created^varchar', 'BeginsWith', 'Jan 10 2026 12:00AM')], ['A1']],
      ['a padded day and hour in style 0 text', [param('tusers.created^varchar', 'BeginsWith', 'Apr  5 2026  9:05AM')], ['A4']],
      ['a site id param, which legacy skips', [param('tusers.siteid^varchar', 'Equals', 'nowhere')], ['A4', 'A2', 'A3', 'A1']],
      ['an address column, once per joined row', [param('tuseraddresses.city^varchar', 'Equals', 'Paris')], ['A1', 'A1']],
      ['a float as six-digit text', [param('tuseraddresses.longitude^varchar', 'Contains', '2.35')], ['A1', 'A1']],
      ['a zero float as 0', [param('tuseraddresses.latitude^varchar', 'BeginsWith', '0')], ['A1', 'A1']],
      ['a large float in exponent form', [param('tuseraddresses.longitude^varchar', 'EndsWith', 'e+006')], ['A2']],
      ['a small float in exponent form', [param('tuseraddresses.latitude^varchar', 'Contains', 'e-005')], ['A2']],
      ['a tag through the tag alias', [param('tag', 'Equals', 'poetry')], ['A3', 'A1']],
      ['a tag row', [param('tuserstags.tag^varchar', 'Equals', 'math')], ['A1']],
      ['an interest row', [param('tusersinterests.categoryid^varchar', 'Equals', 'C2')], ['A2']],
      ['a favorite row', [param('tusersfavorites.favorite^varchar', 'Equals', 'content-1')], ['A2']],
      [
        'two joined tables, per matching combination',
        [param('tuseraddresses.city^varchar', 'Equals', 'Paris'), param('tuserstags.tag^varchar', 'Equals', 'poetry')],
        ['A1', 'A1'],
      ],
      ['either of two criteria', [param('tusers.lname^varchar', 'Equals', 'Lovelace'), param('tusers.lname^varchar', 'Equals', 'Brown', 'or')], ['A2', 'A1']],
      [
        'an and grouping',
        [
          param('tusers.inactive^numeric', 'Equals', '0'),
          param('tusers.fname^varchar', 'Equals', 'Bob', 'andOpenGrouping'),
          param('tusers.fname^varchar', 'Equals', 'Dee', 'or'),
          param('', 'Equals', '', 'closeGrouping'),
        ],
        ['A4', 'A2'],
      ],
      [
        'an or grouping',
        [
          param('tusers.lname^varchar', 'Equals', 'Lovelace'),
          param('tusers.fname^varchar', 'Equals', 'Bob', 'or ('),
          param('tusers.inactive^numeric', 'Equals', '0'),
          param('', 'Equals', '', ')'),
        ],
        ['A2', 'A1'],
      ],
      ['a plain grouping', [param('tusers.lname^varchar', 'Equals', 'Lovelace', 'openGrouping'), param('', 'Equals', '', ')')], ['A1']],
      ['and not, where NULL stays unknown', [param('tusers.company^varchar', 'Equals', 'Acme', 'and not ('), param('', 'Equals', '', ')')], ['A4', 'A1']],
      [
        'or not, where NULL stays unknown',
        [param('tusers.fname^varchar', 'Equals', 'Bob'), param('tusers.email^varchar', 'Contains', 'byron', 'or not ('), param('', 'Equals', '', ')')],
        ['A2', 'A3'],
      ],
    ])('filters by %s', async (_label, paramArray, expected) => {
      expect(tags(await advanced(paramArray))).toEqual(expected);
    });

    it.each<[string, SearchParamEntry[], AdvancedSearchOptions, Partial<AdvancedSearchCriteria & UserFeedKeys>, SearchDeps['extendConfig'], string[]]>([
      ['by attribute id', [param('101^varchar', 'Equals', 'blue')], { isPublic: 0 }, {}, undefined, ['A1']],
      ['by attribute name, ignoring case', [param('favcolor^varchar', 'Equals', 'BLUE')], { isPublic: 0 }, {}, undefined, ['A1']],
      ['by LIKE on the attribute value', [param('favcolor^varchar', 'Contains', 'ee')], { isPublic: 0 }, {}, undefined, ['A3']],
      ['IS NULL as no row or a NULL value', [param('favcolor^varchar', 'Equals', 'null')], { isPublic: 0 }, {}, undefined, ['A4', 'A2']],
      ['IS NULL by attribute id', [param('101^varchar', 'Equals', 'null')], { isPublic: 0 }, {}, undefined, ['A4', 'A2']],
      ['IS NOT NULL on the typed column', [param('favcolor^varchar', 'NEQ', 'null')], { isPublic: 0 }, {}, undefined, ['A3', 'A1']],
      ['a numeric attribute as a number', [param('shoesize^varchar', 'GT', '9')], { isPublic: 0 }, {}, undefined, ['A2', 'A3']],
      ['a numeric attribute in a list', [param('shoesize^varchar', 'in', '9,11')], { isPublic: 0 }, {}, undefined, ['A3', 'A1']],
      ['a date attribute as a datetime', [param('joined^varchar', 'LT', '2021-01-01')], { isPublic: 0 }, {}, undefined, ['A1']],
      ['the cast of the feed site', [param('shoesize^varchar', 'GT', '10')], { isPublic: 0 }, {}, undefined, ['A3']],
      ['text without an attribute of the feed site', [param('shoesize^varchar', 'GT', '10')], { isPublic: 0, siteid: 'tenant-b' }, {}, undefined, ['A3', 'A1']],
      ['text for a criteria site without the attribute', [param('shoesize^varchar', 'GT', '10')], { isPublic: 0 }, { siteid: 'tenant-b' }, undefined, ['A3', 'A1']],
      ['text when strictExtendedData is off', [param('shoesize^varchar', 'GT', '9')], { isPublic: 0 }, {}, { strictExtendedData: false }, []],
      ['no attribute by name for two pools', [param('favcolor^varchar', 'Equals', 'blue')], {}, { ispublic: '' }, undefined, []],
      ['an attribute id for two pools', [param('101^varchar', 'Equals', 'blue')], {}, { ispublic: '' }, undefined, ['A1']],
      ['IS NULL in a pool without the attribute', [param('favcolor^varchar', 'Equals', 'null')], {}, {}, undefined, ['U2', 'U1']],
    ])('filters an extended attribute %s', async (_label, paramArray, options, extra, extendConfig, expected) => {
      expect(tags(await advanced(paramArray, options, extra, adminA, extendConfig === undefined ? deps : { ...deps, extendConfig }))).toEqual(expected);
    });

    it.each<[string, string, string, string[]]>([
      ['fname', 'asc', 'first name ascending', ['A1', 'A2', 'A3', 'A4']],
      ['fname', 'desc', 'first name descending', ['A4', 'A3', 'A2', 'A1']],
      ['created', 'asc', 'creation time', ['A1', 'A2', 'A3', 'A4']],
      ['lastupdate', 'DESC', 'update time descending', ['A4', 'A3', 'A2', 'A1']],
      ['email', 'asc', 'email, NULL first', ['A4', 'A1', 'A2', 'A3']],
      ['username', 'asc', 'identity username', ['A2', 'A1', 'A3', 'A4']],
      ['company', 'asc', 'company, NULL first', ['A3', 'A2', 'A1', 'A4']],
      ['LNAME', 'asc', 'a built-in column in any case', ['A4', 'A2', 'A3', 'A1']],
      ['shoesize', 'asc', 'an extended attribute, NULL first', ['A4', 'A1', 'A2', 'A3']],
      ['shoesize', 'desc', 'an extended attribute descending, NULL last', ['A3', 'A2', 'A1', 'A4']],
    ])('sorts by %s %s: %s', async (sortBy, sortDirection, _label, expected) => {
      expect(tags(await advanced([], { isPublic: 0, sortBy, sortDirection }))).toEqual(expected);
    });

    it('sorts by further keys the direction lists', async () => {
      expect(tags(await advanced([], { isPublic: 0, sortBy: 'lname', sortDirection: 'asc, fname desc' }, {}, adminB))).toEqual(['B1', 'B2']);
    });

    it('sorts by isPublic as an extended attribute, legacy listing it as isPubic', async () => {
      expect(tags(await advanced([], { isPublic: 0, sortBy: 'isPublic' })).sort()).toEqual(['A1', 'A2', 'A3', 'A4']);
    });

    it.each<[string, () => Promise<LegacyQuery>, { type: string; detail?: string }]>([
      ['the isPubic sort column', () => advanced([], { isPublic: 0, sortBy: 'isPubic' }), { type: 'server_error', detail: "Invalid column name 'isPubic'." }],
      ['a sort direction other than asc or desc', () => advanced([], { isPublic: 0, sortDirection: 'sideways' }), { type: 'Masa.InvalidSortDirection' }],
      ['an extended sort direction other than asc or desc', () => advanced([], { isPublic: 0, sortBy: 'shoesize', sortDirection: 'up' }), { type: 'Masa.InvalidSortDirection' }],
      ['a sort field with a space', () => advanced([], { isPublic: 0, sortDirection: 'x asc' }), { type: 'Masa.InvalidSortBy' }],
      ['an unknown sort key the direction lists', () => advanced([], { isPublic: 0, sortDirection: 'asc,nosuch' }), { type: 'server_error', detail: "Invalid column name 'nosuch'." }],
      ['an unknown user column', () => advanced([param('tusers.nosuch^varchar', 'Equals', 'x')]), { type: 'server_error', detail: "Invalid column name 'nosuch'." }],
      ['an unknown joined column', () => advanced([param('tuseraddresses.nosuch^varchar', 'Equals', 'x')]), { type: 'server_error', detail: "Invalid column name 'nosuch'." }],
      ['the target-only tenant column', () => advanced([param('tuseraddresses.tenant_id^varchar', 'Equals', 'x')]), { type: 'server_error', detail: "Invalid column name 'tenant_id'." }],
      ['a table people does not own', () => advanced([param('tcontent.title^varchar', 'Equals', 'x')]), { type: 'server_error', detail: "Invalid object name 'tcontent'." }],
      [
        'one table spelled in two cases',
        () => advanced([param('TUSERADDRESSES.city^varchar', 'Equals', 'Paris'), param('tuseraddresses.zip^varchar', 'Equals', '75001')]),
        { type: 'server_error', detail: 'The objects "tuseraddresses" and "tuseraddresses" in the FROM clause have the same exposed names.' },
      ],
      ['a three-part field', () => advanced([param('a.b.c^varchar', 'Equals', 'x')]), { type: 'server_error', detail: 'The multi-part identifier "a.b.c" could not be bound.' }],
      ['an integer column against other text', () => advanced([param('tusers.inactive^varchar', 'Equals', 'abc')]), { type: 'server_error', detail: 'Conversion failed when converting the value abc to a number.' }],
      ['a text column against a number', () => advanced([param('tusers.fname^numeric', 'Equals', '5')]), { type: 'server_error' }],
      ['a datetime column against other text', () => advanced([param('tusers.created^varchar', 'GT', 'garbage')]), { type: 'server_error', detail: 'Conversion failed when converting garbage to datetime.' }],
      ['non-numeric integer criteria', () => advanced([param('tusers.inactive^integer', 'Equals', 'abc')]), { type: 'server_error', detail: 'Invalid data  for CFSQLTYPE CF_SQL_INTEGER.' }],
      ['non-boolean bit criteria', () => advanced([param('tusers.inactive^bit', 'Equals', 'maybe')]), { type: 'server_error', detail: 'Invalid data  for CFSQLTYPE CF_SQL_BIT.' }],
      ['a date criteria that is no date', () => advanced([param('tusers.created^date', 'Equals', 'notadate')]), { type: 'server_error' }],
      ['an unknown SQL type', () => advanced([param('tusers.fname^blob', 'Equals', 'x')]), { type: 'server_error', detail: 'Invalid CFSQLTYPE CF_SQL_BLOB.' }],
      ['a numeric list that is not numeric', () => advanced([param('tusers.inactive^numeric', 'in', '0,1')]), { type: 'server_error', detail: "Incorrect syntax near ')'." }],
      ['a numeric attribute against a date', () => advanced([param('shoesize^timestamp', 'Equals', '2026-01-01')]), { type: 'server_error' }],
      ['a comparison against null', () => advanced([param('tusers.lname^varchar', 'GT', 'null')]), { type: 'server_error', detail: "Incorrect syntax near 'NULL'." }],
      ['an extended comparison against null', () => advanced([param('101^varchar', 'GT', 'null')]), { type: 'server_error', detail: "Incorrect syntax near 'NULL'." }],
      ['an unclosed grouping', () => advanced([param('tusers.lname^varchar', 'Equals', 'x', 'openGrouping')]), { type: 'server_error' }],
      ['an empty grouping', () => advanced([param('', 'Equals', '', 'closeGrouping')]), { type: 'server_error', detail: "Incorrect syntax near ')'." }],
      ['an extra close', () => advanced([param('tusers.lname^varchar', 'Equals', 'x'), param('', 'Equals', '', ')'), param('', 'Equals', '', ')')]), { type: 'server_error', detail: "Incorrect syntax near ')'." }],
    ])('fails on %s as legacy does', async (_label, read, expected) => {
      const failure = await rejection(read());
      expect(failure.name).toBe('LegacyApiError');
      expect(failure).toMatchObject(expected);
    });

    it.each(['tusersmemb.groupid', 'tsettings.siteid', 'tpermissions.groupid', 'TUSERDEVICE.deviceid', 'toauthtokens.token'])(
      'refuses the restricted table of %s',
      async (field) => {
        await expect(advanced([param(`${field}^varchar`, 'Equals', 'x')])).rejects.toMatchObject({ type: 'authorization' });
      },
    );

    it('refuses a restricted table even after an allowed one', async () => {
      await expect(advanced([param('tusers.lname^varchar', 'Equals', 'x'), param('tusergroups.groupid^varchar', 'Equals', 'x')])).rejects.toBeInstanceOf(
        LegacyApiError,
      );
    });
  });

  describe('searchAllSites', () => {
    it('runs a non-S2 viewer once for its own site', async () => {
      const result = legacyQuery(['UserID'], [{ UserID: 'X' }]);
      const calls: [ViewerScope, string][] = [];
      const answer = await searchAllSites(deps, viewerA, async (scope, siteid) => {
        calls.push([scope, siteid]);
        return result;
      });
      expect(answer).toBe(result);
      expect(calls).toEqual([[viewerA, 'tenant-a']]);
    });

    it('runs an S2 viewer once per registered tenant and merges by name', async () => {
      const byTenant = new Map<string, Record<string, unknown>[]>([
        [TENANT_A.tenantId, [{ Lname: 'Lee', Fname: 'Ann', UserID: 'U3' }]],
        [TENANT_B.tenantId, [{ LNAME: 'Lee', FNAME: 'Ann', USERID: 'U1' }, { LNAME: null, FNAME: 'Zed', USERID: 'U9' }, { lname: 'Abbot', fname: 'Zoe', userid: 'U5' }]],
        [TENANT_UMBRELLA.tenantId, [{ lname: 'Abbot', fname: 'Zoe', userid: 'U5' }]],
      ]);
      const calls: [ViewerScope, string][] = [];
      const answer = await searchAllSites(deps, adminA, async (scope, siteid) => {
        calls.push([scope, siteid]);
        return legacyQuery(['UserID', 'Fname', 'Lname'], byTenant.get(scope.tid) ?? []);
      });
      expect(calls).toEqual([
        [{ ...adminA, tid: TENANT_A.tenantId, site: 'tenant-a' }, ''],
        [{ ...adminA, tid: TENANT_B.tenantId, site: 'tenant-b' }, ''],
        [{ ...adminA, tid: TENANT_UMBRELLA.tenantId, site: 'umbrella' }, ''],
      ]);
      expect(answer.columnList).toEqual(['UserID', 'Fname', 'Lname']);
      expect(answer.rows.map((row) => row.UserID ?? row.USERID ?? row.userid)).toEqual(['U9', 'U5', 'U5', 'U1', 'U3']);
    });

    it('lists every site of the registry for siteid all', async () => {
      const result = await searchAllSites(deps, adminA, (scope, siteid) => getUsers(deps, scope, { siteid, ispublic: 0 }));
      expect(result.columnList).toEqual([...USERS_LIST_COLUMNS]);
      expect(tags(result)).toEqual(['A4', 'B2', 'B1', 'A2', 'A3', 'A1']);
    });
  });

  describe('an unregistered tenant', () => {
    it.each<[string, () => Promise<LegacyQuery>]>([
      ['getUsers of a site', () => getUsers(deps, stranger, { siteid: 'nowhere' })],
      ['getSearch', () => getSearch(deps, stranger, { search: 'a' })],
      ['getAdvancedSearch', () => advanced([], {}, {}, stranger)],
    ])('answers 503 to %s', async (_label, read) => {
      await expect(read()).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    });
  });
});
