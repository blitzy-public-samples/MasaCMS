/** User list, search and advanced-search queries of search.ts over a throwaway `people` schema, held to legacy userGateway results. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError, legacyQuery, type LegacyQuery } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { tenantIdForSite, tenantRegistryConsumer, type TenantTx } from '@opt2/platform/tenancy';
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
import * as reads from '../../src/domain/search.js';
import {
  SEARCH_FIELD_LIST,
  SEARCH_MAX_ROWS,
  USERS_LIST_COLUMNS,
  newAdvancedSearchCriteria,
  pageRows,
  type AdvancedSearchCriteria,
  type AdvancedSearchOptions,
  type SearchDeps,
  type SearchParamEntry,
  type UserFeedKeys,
  type UsersPage,
  type UsersPaging,
  type ViewerScope,
} from '../../src/domain/search.js';
import type { AccountView } from '../../src/legacy/identity-client.js';
import { createPeopleRepository, type PeopleRepository, type PersonInput } from '../../src/repo/repository.js';
import { PEOPLE_UNITS } from '../../src/repo/tables.js';
import { IdentityDouble } from '../helpers/search-doubles.js';

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

/** `read` with the identity double answering for its viewer's token, as the forwarded user token makes identity answer. */
function asViewer<A extends unknown[], R>(read: (deps: SearchDeps, viewer: ViewerScope, ...args: A) => Promise<R>) {
  return (deps: SearchDeps, viewer: ViewerScope, ...args: A): Promise<R> => {
    const identity = deps.identity instanceof IdentityDouble ? deps.identity.withToken({ db: deps.db, tid: viewer.tid, s2: viewer.isS2 }) : deps.identity;
    return read({ ...deps, identity }, viewer, ...args);
  };
}

const getAdvancedSearch = asViewer(reads.getAdvancedSearch);
const getAdvancedSearchPage = asViewer(reads.getAdvancedSearchPage);
const getAllSitesUsers = asViewer(reads.getAllSitesUsers);
const getAllSitesUsersPage = asViewer(reads.getAllSitesUsersPage);
const getSearch = asViewer(reads.getSearch);
const getSearchPage = asViewer(reads.getSearchPage);
const getUnassignedUsers = asViewer(reads.getUnassignedUsers);
const getUsers = asViewer(reads.getUsers);
const getUsersPage = asViewer(reads.getUsersPage);

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
  let identity: IdentityDouble;

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
    identity = new IdentityDouble(new Map(), new Map(), { db: handle.app, tid: TENANT_A.tenantId, s2: true });
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

    type WordCase = [ispublic: string, bound: string, pool: string[], viewerTenant: string[]];
    const privateUsers = ['A4', 'A2', 'A3', 'A1'];

    // Oracle: cUsers.listUsers lists the ispublic=0 users for every casing of no and false, and for ' no', 'no\u0001' and ' FALSE '.
    it.each<WordCase>([
      ...['yes', 'Yes', 'YES', 'true', 'True', 'TRUE', ' yes', 'TRUE\t'].map((word): WordCase => [word, '1', ['U2', 'U1'], ['A7']]),
      ...['no', 'No', 'NO', 'false', 'False', 'FALSE', ' no', 'no\u0001', ' FALSE '].map((word): WordCase => [word, '0', privateUsers, privateUsers]),
    ])('binds ispublic %j as %s, reading its pool and the viewer tenant as legacy does', async (ispublic, bound, pool, tenant) => {
      expect(tags(await getUsers(deps, viewerA, { siteid: 'tenant-a', ispublic }))).toEqual(pool);
      expect(tags(await getUsers(deps, viewerA, { ispublic }))).toEqual(tenant);
      expect(tags(await getUsers(deps, viewerA, { siteid: 'tenant-a', ispublic: bound }))).toEqual(pool);
    });

    it.each(['x', 'n', 'off', 'yes!', 'no no'])('rejects a non-numeric ispublic %j as the integer binding does', async (ispublic) => {
      expect(await rejection(getUsers(deps, viewerA, { siteid: 'tenant-a', ispublic }))).toEqual({
        name: 'LegacyApiError',
        type: 'server_error',
        detail: `Invalid data ${ispublic} for CFSQLTYPE CF_SQL_INTEGER.`,
      });
    });
  });

  describe('getUnassignedUsers', () => {
    it.each<[string, Parameters<typeof getUnassignedUsers>[2], string[]]>([
      ['public pool users without a membership by default', { siteid: 'tenant-a' }, ['U1']],
      ['private pool users without a membership', { siteid: 'tenant-a', ispublic: 0 }, ['A4', 'A2']],
      ['private pool users without a membership for ispublic False', { siteid: 'tenant-a', ispublic: 'False' }, ['A4', 'A2']],
      ['public pool users without a membership for ispublic YES', { siteid: 'tenant-a', ispublic: 'YES' }, ['U1']],
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
      const calls = identity.calls.length;
      const result = await getSearch(deps, adminA, { search: '' });
      expect(result).toEqual(legacyQuery([...SEARCH_FIELD_LIST], []));
      expect(identity.calls).toHaveLength(calls);
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

    it.each<[string, string]>([
      ['yes', 'a'],
      ['Yes', 'a'],
      ['true', 'a'],
      ['TRUE', 'a'],
      ['no', 'a'],
      ['NO', 'a'],
      ['false', 'a'],
      ['FALSE', ''],
      ['abc', 'a'],
    ])('rejects isPublic %j with the getSearch argument-type error (search %j)', async (isPublic, search) => {
      const calls = identity.calls.length;
      expect(await rejection(getSearch(deps, viewerA, { search, isPublic }))).toEqual({
        name: 'LegacyApiError',
        type: 'server_error',
        detail: 'The ISPUBLIC argument passed to the getSearch function is not of type numeric.',
      });
      expect(identity.calls).toHaveLength(calls);
    });

    it.each<[string | number, string[]]>([
      ['1', ['U1']],
      ['1.0', ['U1']],
      ['1e0', ['U1']],
      ['+1', ['U1']],
      ['1.', ['U1']],
      ['0', ['A1']],
      ['0.0', ['A1']],
      ['.0', ['A1']],
      [0, ['A1']],
      ['2', []],
      ['-1', []],
    ])('searches by the numeric isPublic %j', async (isPublic, expected) => {
      expect(tags(await getSearch(deps, viewerA, { search: 'u', isPublic }))).toEqual(expected);
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
      // A6's Type=1 account is a group row, which identity never lists to people.
      ['no rows for type group', { isPublic: 0 }, { type: 'group' }, adminA, []],
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

  describe('with wildcard chains against legacy-width a-heavy values', () => {
    const nineRuns = 'a%a%a%a%a%a%a%a%a%b';

    beforeAll(async () => {
      await addPerson(TENANT_B.tenantId, 'R1', { fname: 'Redos', lname: 'a'.repeat(50), email: 'a'.repeat(255), siteid: TENANT_B.siteId });
      identity.accounts.set(id('R1'), account('R1', TENANT_B.siteId));
    });

    afterAll(async () => {
      identity.accounts.delete(id('R1'));
      await inTenant(TENANT_B.tenantId, (tx) => tx.query(`DELETE FROM "${handle.schema}".person WHERE tenant_id = $1 AND userid = $2`, [tx.tenantId, id('R1')]));
    });

    it.each<[string, () => Promise<LegacyQuery>, string[]]>([
      ['getSearch with no b in any column', () => getSearch(deps, adminB, { search: nineRuns }), []],
      ['getSearch with nine a in the last name', () => getSearch(deps, adminB, { search: 'a%a%a%a%a%a%a%a%a' }), ['R1']],
      ['getAdvancedSearch Contains on the email', () => advanced([param('tusers.email^varchar', 'Contains', nineRuns)], { isPublic: 0 }, {}, adminB), []],
      ['getAdvancedSearch Like on the last name', () => advanced([param('tusers.lname^varchar', 'Like', `${'A%'.repeat(9)}a`)], { isPublic: 0 }, {}, adminB), ['R1']],
    ])('answers %s within 2 s', async (_label, read, expected) => {
      const started = performance.now();
      expect(tags(await read())).toEqual(expected);
      expect(performance.now() - started).toBeLessThan(2_000);
    });
  });

  describe('getAllSitesUsersPage', () => {
    it('lists every site of the registry for siteid all', async () => {
      const page = await getAllSitesUsersPage(deps, adminA, { ispublic: 0 }, { recordsPerPage: 100 });
      expect(Object.keys(page.rows[0] ?? {})).toEqual([...USERS_LIST_COLUMNS]);
      expect(tags(legacyQuery([...USERS_LIST_COLUMNS], page.rows))).toEqual(['A4', 'B2', 'B1', 'A2', 'A3', 'A1']);
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

    it.each<[string, () => Promise<unknown>]>([
      ['getUsersPage of a site', () => getUsersPage(deps, stranger, { siteid: 'nowhere' }, {})],
      ['getSearchPage', () => getSearchPage(deps, stranger, { search: 'a' }, {})],
      ['getAdvancedSearchPage', () => getAdvancedSearchPage(deps, stranger, newAdvancedSearchCriteria(), {}, {})],
    ])('answers 503 to %s', async (_label, read) => {
      await expect(read()).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    });
  });

  describe('with a pool larger than one scan batch', () => {
    const bulk = 1200;
    const bulkId = (n: number): string => `Y${String(n).padStart(7, '0')}-0000-0000-0000000000000000`;
    const FIRST_NAMES = ['Cy', 'al', 'Bo'];
    /** The bulk persons and B1, B2 as [userid, lname, fname], the rows tenant-b's private pool holds. */
    const people: [string, string, string][] = [
      [id('B1'), 'Bravo', 'Bea'],
      [id('B2'), 'Bravo', 'Al'],
      // Two persons share each last name, so name ties fall across batch boundaries.
      ...Array.from({ length: bulk }, (_, i): [string, string, string] => [bulkId(i + 1), `Ybatch${String((i + 1) % 600).padStart(4, '0')}`, FIRST_NAMES[(i + 1) % 3] as string]),
    ];
    const isMember = (userId: string): boolean => userId.startsWith('Y') && Number(userId.slice(1, 8)) % 5 === 0;
    /** The ids of `people` by the text keys `keys` reads, then userid; all keys are ASCII, so lower-cased code-unit order is the collation's. */
    const ordered = (keys: (row: [string, string, string]) => string[], rows = people): string[] =>
      [...rows]
        .sort((a, b) => {
          const [ka, kb] = [[...keys(a), a[0]], [...keys(b), b[0]]];
          for (let i = 0; i < ka.length; i += 1) {
            const [x, y] = [(ka[i] ?? '').toLowerCase(), (kb[i] ?? '').toLowerCase()];
            if (x !== y) return x < y ? -1 : 1;
          }
          return 0;
        })
        .map(([userId]) => userId);
    const byName = ordered(([, lname, fname]) => [lname, fname]);
    const byLastName = ordered(([, lname]) => [lname]);
    const ids = (rows: readonly Record<string, unknown>[]): unknown[] => rows.map((row) => row.userID ?? row.UserID);
    const PAGINGS: UsersPaging[] = [
      {},
      { startRow: 2 },
      { startRow: 49 },
      { startRow: 50 },
      { startRow: 5000 },
      { startRow: 0, recordsPerPage: 0 },
      { startRow: 2, recordsPerPage: 1000 },
      { startRow: 13, recordsPerPage: 100 },
      { startRow: 3, recordsPerPage: 7 },
    ];

    /** Search deps over a fresh identity double that records only this read's calls. */
    function counted(): { deps: SearchDeps; identity: IdentityDouble } {
      const fake = new IdentityDouble(identity.accounts, identity.memberships, identity.token);
      return { deps: { ...deps, identity: fake }, identity: fake };
    }

    beforeAll(async () => {
      await inTenant(TENANT_B.tenantId, (tx) =>
        tx.query(
          `INSERT INTO "${handle.schema}".person (tenant_id, userid, fname, lname, siteid)` +
            " SELECT $1, 'Y' || lpad(g::text, 7, '0') || '-0000-0000-0000000000000000', ($3::text[])[g % 3 + 1]," +
            " 'Ybatch' || lpad((g % 600)::text, 4, '0'), 'tenant-b' FROM generate_series(1, $2::int) AS g",
          [tx.tenantId, bulk, FIRST_NAMES],
        ),
      );
      for (let n = 1; n <= bulk; n += 1) {
        identity.accounts.set(bulkId(n), { ...account('Y', 'tenant-b'), userId: bulkId(n), username: `y${n}` });
        if (isMember(bulkId(n))) identity.memberships.set(bulkId(n), ['GY']);
      }
    });

    afterAll(async () => {
      for (let n = 1; n <= bulk; n += 1) {
        identity.accounts.delete(bulkId(n));
        identity.memberships.delete(bulkId(n));
      }
      await inTenant(TENANT_B.tenantId, (tx) => tx.query(`DELETE FROM "${handle.schema}".person WHERE tenant_id = $1 AND lname LIKE 'Ybatch%'`, [tx.tenantId]));
    });

    it('lists every person in name order with one account lookup per batch of at most 500', async () => {
      const { deps: read, identity: fake } = counted();
      const result = await getUsers(read, adminB, { siteid: 'tenant-b', ispublic: 0 });
      expect(ids(result.rows)).toEqual(byName);
      expect(fake.calls).toEqual([
        { op: 'readAccounts', ids: 500 },
        { op: 'readAccounts', ids: 500 },
        { op: 'readAccounts', ids: 202 },
      ]);
    });

    it('filters unassigned users in identity, with one account lookup per batch and no membership lookup', async () => {
      const { deps: read, identity: fake } = counted();
      const result = await getUnassignedUsers(read, adminB, { siteid: 'tenant-b', ispublic: 0 });
      expect(ids(result.rows)).toEqual(byName.filter((userId) => !isMember(userId)));
      expect(fake.calls).toEqual([
        { op: 'readAccounts', ids: 500 },
        { op: 'readAccounts', ids: 500 },
        { op: 'readAccounts', ids: 202 },
      ]);
    });

    it('searches every batch by last name', async () => {
      const { deps: read, identity: fake } = counted();
      expect(ids((await getSearch(read, adminB, { search: 'ybatch' })).rows)).toEqual(byLastName.filter((userId) => userId.startsWith('Y')));
      expect(fake.count('readAccounts')).toBe(3);
    });

    it.each<[string, Partial<AdvancedSearchCriteria & UserFeedKeys>, (userId: string) => boolean, number]>([
      ['every pool person', {}, () => true, 0],
      ['the members of a group', { groupID: 'GY' }, isMember, 3],
    ])('finds %s across batches by last name', async (_label, extra, kept, membershipCalls) => {
      const { deps: read, identity: fake } = counted();
      const result = await advanced([], { isPublic: 0 }, extra, adminB, read);
      expect(ids(result.rows)).toEqual(byLastName.filter(kept));
      expect(fake.count('readAccounts')).toBe(3);
      expect(fake.count('lookupMemberships')).toBe(membershipCalls);
    });

    it.each(PAGINGS)('pages each read as pageRows pages its full result for %o', async (paging) => {
      const page = <R>(rows: readonly R[]): UsersPage<R> => pageRows(rows, paging);
      const criteria = { ...newAdvancedSearchCriteria(), groupID: 'GY' };
      expect(await getUsersPage(deps, adminB, { siteid: 'tenant-b', ispublic: 0 }, paging)).toEqual(
        page((await getUsers(deps, adminB, { siteid: 'tenant-b', ispublic: 0 })).rows),
      );
      expect(await getSearchPage(deps, adminB, { search: 'ybatch' }, paging)).toEqual(page((await getSearch(deps, adminB, { search: 'ybatch' })).rows));
      expect(await getAdvancedSearchPage(deps, adminB, criteria, { isPublic: 0 }, paging)).toEqual(
        page((await getAdvancedSearch(deps, adminB, criteria, { isPublic: 0 })).rows),
      );
    });

    it('counts a search beyond 2100 matches as 2100 and pages within them', async () => {
      const more = Array.from({ length: SEARCH_MAX_ROWS }, (_, i) => `X${String(i + 1).padStart(7, '0')}-0000-0000-0000000000000000`);
      await inTenant(TENANT_B.tenantId, (tx) =>
        tx.query(
          `INSERT INTO "${handle.schema}".person (tenant_id, userid, fname, lname, siteid) SELECT $1, u, 'Extra', 'Ybatch9999', 'tenant-b' FROM unnest($2::text[]) AS u`,
          [tx.tenantId, more],
        ),
      );
      for (const userId of more) identity.accounts.set(userId, { ...account('X', 'tenant-b'), userId });
      try {
        const full = await getSearch(deps, adminB, { search: 'ybatch' });
        expect(full.rows).toHaveLength(SEARCH_MAX_ROWS);
        for (const paging of [{ startRow: 84 }, { startRow: 85 }, { startRow: 3, recordsPerPage: 1000 }]) {
          const page = await getSearchPage(deps, adminB, { search: 'ybatch' }, paging);
          expect(page).toEqual(pageRows(full.rows, paging));
          expect(page.nextn.TotalRecords).toBe(SEARCH_MAX_ROWS);
        }
      } finally {
        for (const userId of more) identity.accounts.delete(userId);
      }
    });
  });

  describe('siteid=all over every registered site', () => {
    const DEFAULT_SITE = 'default';
    const DEFAULT_TENANT = tenantIdForSite(DEFAULT_SITE);
    /** Identity as a tenant-a token reads it: `lookupAccounts` sees tenant-a's user pools (its own and umbrella) only. */
    const tokenOfA = (): IdentityDouble =>
      new IdentityDouble(identity.accounts, identity.memberships, { db: handle.app, tid: TENANT_A.tenantId, s2: true });
    const pageTags = (page: UsersPage<Record<string, unknown>>): string[] => tags(legacyQuery([...USERS_LIST_COLUMNS], page.rows));

    beforeAll(async () => {
      const payload = { siteId: DEFAULT_SITE, domains: ['default.opt2.test'] };
      await inTenant(DEFAULT_TENANT, (tx) => tenantRegistryConsumer.apply(tx, { tenantId: DEFAULT_TENANT, aggregateVersion: 1, payload }));
      await addPerson(DEFAULT_TENANT, 'D1', { fname: 'Dot', lname: 'Default', siteid: DEFAULT_SITE });
      identity.accounts.set(id('D1'), account('D1', DEFAULT_SITE));
    });

    it.each<[string, string, string[]]>([
      ['system users', '0', ['A4', 'B2', 'B1', 'A2', 'A3', 'D1', 'A1']],
      ['site members', '1', ['U2', 'A7', 'U1']],
    ])('lists the %s of default, tenant-a, tenant-b and umbrella once each for an S2 viewer', async (_label, ispublic, expected) => {
      const fake = tokenOfA();
      const read: SearchDeps = { ...deps, identity: fake };
      const page = await getAllSitesUsersPage(read, adminA, { ispublic }, { recordsPerPage: 100 });
      expect(pageTags(page)).toEqual(expected);
      expect(page.nextn.TotalRecords).toBe(expected.length);
      // The token's own lookup would drop tenant-b's and default's people; only identity's S2 all-sites read is used.
      expect(fake.count('readAccounts')).toBe(0);
      expect(fake.count('readAccountsAllSites')).toBeGreaterThan(0);
    });

    it.each<UsersPaging>([{}, { startRow: 2, recordsPerPage: 3 }, { startRow: 3, recordsPerPage: 3 }, { startRow: 4, recordsPerPage: 3 }, { startRow: 0, recordsPerPage: 0 }])(
      'pages the merged list as pageRows pages the full list for %o',
      async (paging) => {
        const read: SearchDeps = { ...deps, identity: tokenOfA() };
        // A page reaching past every match holds the whole merged list.
        const full = await getAllSitesUsersPage(read, adminA, { ispublic: 0 }, { recordsPerPage: 100 });
        expect(pageTags(full)).toEqual(['A4', 'B2', 'B1', 'A2', 'A3', 'D1', 'A1']);
        expect(await getAllSitesUsersPage(read, adminA, { ispublic: 0 }, paging)).toEqual(pageRows(full.rows, paging));
      },
    );

    it('lists only its own site for a viewer without S2, through its own token', async () => {
      const fake = tokenOfA();
      const page = await getAllSitesUsersPage({ ...deps, identity: fake }, viewerA, { ispublic: 0 }, {});
      expect(pageTags(page)).toEqual(['A4', 'A2', 'A3', 'A1']);
      expect(fake.count('readAccountsAllSites')).toBe(0);
    });

    it('lists every user of its own site for a viewer without S2, through its own token', async () => {
      const fake = tokenOfA();
      expect(tags(await getAllSitesUsers({ ...deps, identity: fake }, viewerA, { ispublic: 0 }))).toEqual(['A4', 'A2', 'A3', 'A1']);
      expect(fake.calls.map((call) => call.op)).toEqual(['readAccounts']);
    });
  });
});
