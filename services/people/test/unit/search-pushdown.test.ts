/** search.ts reads over a throwaway `people` schema held to a brute-force reference of legacy's predicates, order and paging, and to bounded person and identity reads. */
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyApiError, legacyUsersCsvStream } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { RequestAbortedError, newRequestContext, runWithRequestContext } from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  SEARCH_MAX_ROWS,
  getAdvancedSearch,
  getAdvancedSearchPage,
  getAdvancedSearchStream,
  getAllSitesUsers,
  getAllSitesUsersPage,
  getSearch,
  getSearchPage,
  getUnassignedUsers,
  getUnassignedUsersStream,
  getUsers,
  getUsersPage,
  getUsersStream,
  likeMatcher,
  newAdvancedSearchCriteria,
  pageHold,
  pageRows,
  type AdvancedSearchCriteria,
  type AdvancedSearchOptions,
  type SearchDeps,
  type SearchParamEntry,
  type StreamedQuery,
  type UserFeedKeys,
  type UsersPage,
  type UsersPaging,
  type UsersQueryArgs,
  type ViewerScope,
} from '../../src/domain/search.js';
import type { AccountView } from '../../src/legacy/identity-client.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';
import { PEOPLE_UNITS } from '../../src/repo/tables.js';
import { IdentityDouble, charKey } from '../helpers/search-doubles.js';

/** The person columns the corpus stores. */
interface Person {
  tenant: string;
  userid: string;
  siteid: string;
  lname: string | null;
  fname: string | null;
  company: string | null;
  email: string | null;
  jobtitle: string | null;
  created: Date | null;
  lastupdate: Date | null;
}

/** One user of the corpus: the person row, its account when identity holds one, and its stored group ids. */
interface User {
  person: Person;
  account: AccountView | undefined;
  groups: string[];
}

/** A seeded generator of uniform numbers in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

const A = TENANT_A.tenantId;
const B = TENANT_B.tenantId;
const U = TENANT_UMBRELLA.tenantId;
/** The seeded registry's user pools per tenant: tenant-a keeps its private pool and shares umbrella's public one. */
const POOLS: Readonly<Record<string, { private: { siteId: string; tenant: string }; public: { siteId: string; tenant: string } }>> = {
  [A]: { private: { siteId: TENANT_A.siteId, tenant: A }, public: { siteId: TENANT_UMBRELLA.siteId, tenant: U } },
  [B]: { private: { siteId: TENANT_B.siteId, tenant: B }, public: { siteId: TENANT_B.siteId, tenant: B } },
  [U]: { private: { siteId: TENANT_UMBRELLA.siteId, tenant: U }, public: { siteId: TENANT_UMBRELLA.siteId, tenant: U } },
};

const ADMIN_A: ViewerScope = { tid: A, site: TENANT_A.siteId, isS2: true };
const VIEWER_A: ViewerScope = { tid: A, site: TENANT_A.siteId, isS2: false };
const ADMIN_B: ViewerScope = { tid: B, site: TENANT_B.siteId, isS2: true };

// Replicates text, compareText, compareSql and compareCandidates of src/domain/search.ts.
const COLLATOR = new Intl.Collator('en-US', { sensitivity: 'accent' });

function compareSql(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return COLLATOR.compare(String(a).replace(/ +$/, ''), String(b).replace(/ +$/, ''));
}

/** One reference sort key over users. */
interface RefKey {
  read: (user: User) => unknown;
  descending: boolean;
}

/** `users` by `keys`, then userid, as the legacy query orders them. */
function sorted(users: readonly User[], keys: readonly RefKey[]): User[] {
  return [...users].sort((a, b) => {
    for (const key of keys) {
      const order = compareSql(key.read(a), key.read(b));
      if (order !== 0) return key.descending ? -order : order;
    }
    return compareSql(a.person.userid, b.person.userid);
  });
}

const BY_NAME: RefKey[] = [
  { read: (user) => user.person.lname, descending: false },
  { read: (user) => user.person.fname, descending: false },
];

/** Whether `account` is a Type=2 account identity lists. */
const listed = (user: User): user is User & { account: AccountView } => user.account !== undefined && user.account.type === 2;

/** Whether a nullable numeric column equals `expected`, NULL matching nothing. */
const equals = (value: number | null, expected: number): boolean => value !== null && value === expected;

/** The userids of `users`. */
const ids = (users: readonly User[]): string[] => users.map((user) => user.person.userid);

/** A read's page as ids, page index and nextN, comparable with `pageRows` over reference ids. */
function pageIds(page: UsersPage<Record<string, unknown>>): UsersPage<string> {
  return { ...page, rows: page.rows.map((row) => String(row.UserID ?? row.userID)) };
}

/** Every row of a streamed query, in order. */
async function streamedRows(query: StreamedQuery): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for await (const row of query.rows) rows.push(row);
  return rows;
}

const PAGINGS: UsersPaging[] = [
  {},
  { startRow: 2, recordsPerPage: 7 },
  { startRow: 3, recordsPerPage: 1 },
  { startRow: 1, recordsPerPage: 1 },
  { startRow: 0, recordsPerPage: 0 },
  { startRow: 9, recordsPerPage: 25 },
  { startRow: 5000 },
  { startRow: 2.5, recordsPerPage: 10 },
  { startRow: 4, recordsPerPage: 40 },
];

/** A stored advanced-search row. */
const param = (field: string, condition: string, criteria: string): SearchParamEntry => ({ field, relationship: 'and', criteria, condition });

/** Inserts `persons` straight into the throwaway person table, NULLs kept. */
async function insertPersons(handle: ThrowawaySchema, persons: readonly Person[]): Promise<void> {
  const columns = ['userid', 'siteid', 'lname', 'fname', 'company', 'email', 'jobtitle', 'created', 'lastupdate'] as const;
  const types = ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamp', 'timestamp'];
  const unnest = columns.map((_, index) => `$${index + 2}::${types[index]}[]`).join(', ');
  for (const tenant of [...new Set(persons.map((person) => person.tenant))]) {
    const own = persons.filter((person) => person.tenant === tenant);
    for (let start = 0; start < own.length; start += 2000) {
      const chunk = own.slice(start, start + 2000);
      await handle.app.withTenant(tenant, (tx) =>
        tx.query(`INSERT INTO "${handle.schema}".person (tenant_id, ${columns.join(', ')}) SELECT $1::uuid, u.* FROM unnest(${unnest}) AS u`, [
          tenant,
          ...columns.map((column) => chunk.map((person) => person[column])),
        ]),
      );
    }
  }
}

/** A migrated, registry-seeded throwaway schema with every people unit open. */
async function openSchema(holderId: string): Promise<ThrowawaySchema> {
  const handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
  await seedRegistry(handle.app);
  await ensureUnitGates(handle.app, PEOPLE_UNITS);
  await closeGates(handle.app, { units: PEOPLE_UNITS, holderId, allowLegacy: true });
  await openGates(handle.app, { units: PEOPLE_UNITS, holderId, state: 'open' });
  return handle;
}

/** A repository that counts its ordered person pages. */
function countingRepo(repo: PeopleRepository): { repo: PeopleRepository; pages: () => number } {
  let pages = 0;
  return {
    repo: {
      ...repo,
      pagePersonsInOrder: (tx, scope, opts) => {
        pages += 1;
        return repo.pagePersonsInOrder(tx, scope, opts);
      },
    },
    pages: () => pages,
  };
}

/** An account of `person`, with legacy defaults overridden by `values`. */
function accountOf(person: Person, values: Partial<AccountView> = {}): AccountView {
  return {
    userId: person.userid,
    siteId: person.siteid,
    username: null,
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
    ...values,
  };
}

const available = await pgAvailable();

describe.skipIf(!available)('search reads against a seeded random corpus', () => {
  const LAST_NAMES = [
    'Smith', 'smith', 'SMITH', 'Smith ', 'Smith  ', 'Smíth', 'Smyth', null, '', 'Müller', 'Muller', 'MÜLLER', "O'Brien", 'OBrien', 'Brown', 'browne',
    'Zoë', 'Zoe', 'Ångström', 'Angstrom', 'de la Cruz', 'Lee-Smith', 'Øre', 'Straße', 'Strasse', 'ß', '中文', 'Ελλάδα', 'a_b', '50%', '[x]', 'back\\slash',
  ];
  const FIRST_NAMES = ['Ann', 'ann', 'ANN ', 'Ánn', null, '', 'Bob', 'bob', 'Zoë', 'Élodie', 'elodie', 'Kai', 'Kelvin\u212a', 'ſam', 'Sam'];
  const COMPANIES = [null, 'Acme', 'ACME Corp', 'Beta_Co', 'BetaXCo', 'Müller GmbH', 'smith & sons', '100% Pure', '[brackets]'];
  const JOBS = [null, 'Engineer', 'engineer ', 'Mathématicien', 'Kai-ser'];
  const USERNAMES = [null, 'asmith', 'ASMITH2', 'bob_b', 'élodie', 'kai', 'mü', 'zz', 'sam%', 'brown'];
  const HOMES: readonly [string, string][] = [
    [A, TENANT_A.siteId],
    [A, TENANT_A.siteId],
    [U, TENANT_UMBRELLA.siteId],
    [U, TENANT_UMBRELLA.siteId],
    [B, TENANT_B.siteId],
  ];
  const next = seeded(4711);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const flagValue = (): number | null => pick([0, 0, 0, 1, 1, null]);
  const users: User[] = Array.from({ length: 450 }, (_, index) => {
    const [tenant, siteid] = pick(HOMES);
    const lname = pick(LAST_NAMES);
    const person: Person = {
      tenant,
      userid: `${(index * 7919 + 13).toString(16).toUpperCase().padStart(8, '0')}-0000-0000-${String(index).padStart(16, '0')}`,
      siteid,
      lname,
      fname: pick(FIRST_NAMES),
      company: pick(COMPANIES),
      email: next() < 0.2 ? null : `${(lname ?? 'none').replace(/\W/g, '').toLowerCase() || 'x'}${index}@${pick(['acme.test', 'byron.test', 'mü.test'])}`,
      jobtitle: pick(JOBS),
      created: next() < 0.1 ? null : new Date(2026, 0, 1 + (index % 40), index % 24),
      lastupdate: new Date(2026, 5, 1 + (index % 17)),
    };
    const kind = next();
    const account =
      kind < 0.1
        ? undefined
        : accountOf(person, { username: pick(USERNAMES), s2: flagValue(), isPublic: flagValue(), inactive: flagValue(), type: kind < 0.13 ? 1 : 2 });
    // A membership may be stored in another tenant than the user's own.
    return { person, account, groups: next() < 0.3 ? [pick(['G1', 'g1 ', 'G2'])] : [] };
  });

  let handle: ThrowawaySchema;
  let repo: PeopleRepository;
  const accounts = new Map(users.flatMap((user) => (user.account === undefined ? [] : [[charKey(user.person.userid), user.account] as const])));
  const memberships = new Map(users.map((user) => [charKey(user.person.userid), user.groups]));

  /** Search deps whose identity answers `viewer`'s token. */
  function depsFor(viewer: ViewerScope): { deps: SearchDeps; identity: IdentityDouble } {
    const identity = new IdentityDouble(accounts, memberships, { db: handle.app, tid: viewer.tid, s2: viewer.isS2 });
    return { deps: { db: handle.app, repo, identity }, identity };
  }

  /** The tenants whose accounts identity's lookup reads for `viewer`'s token. */
  const tokenTenants = (viewer: ViewerScope): string[] => [POOLS[viewer.tid]?.private.tenant ?? '', POOLS[viewer.tid]?.public.tenant ?? ''];

  beforeAll(async () => {
    handle = await openSchema('search-pushdown-oracle');
    repo = createPeopleRepository({ schema: handle.schema });
    await insertPersons(handle, users.map((user) => user.person));
  });

  afterAll(async () => {
    await handle?.drop();
  });

  /** getUsers as legacy filters and orders it, over every corpus user. */
  function referenceUsers(viewer: ViewerScope, { siteid = '', ispublic = 1, isunassigned = 0, showsuperusers = 0 }: UsersQueryArgs, allSites = false): User[] {
    const pool = POOLS[viewer.tid]?.[String(ispublic) === '0' ? 'private' : 'public'];
    const visible = tokenTenants(viewer);
    return sorted(
      users.filter((user) => {
        const { person } = user;
        const inScope = allSites ? true : siteid === '' ? person.tenant === viewer.tid : person.tenant === pool?.tenant && charKey(person.siteid) === charKey(pool.siteId);
        if (!inScope || !listed(user) || (!allSites && !visible.includes(user.person.tenant))) return false;
        return (
          (String(ispublic) === '' || equals(user.account.isPublic, Number(ispublic))) &&
          (showsuperusers !== 1 || (user.account.s2 !== null && user.account.s2 !== 1)) &&
          (isunassigned !== 1 || user.groups.length === 0)
        );
      }),
      BY_NAME,
    );
  }

  const LIST_CASES: [string, ViewerScope, UsersQueryArgs][] = [ADMIN_A, VIEWER_A, ADMIN_B].flatMap((viewer) =>
    ['', viewer.site].flatMap((siteid) =>
      [0, 1, ''].flatMap((ispublic) =>
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ].map(([showsuperusers, isunassigned]): [string, ViewerScope, UsersQueryArgs] => [
          `${viewer.site}${viewer.isS2 ? ' S2' : ''} siteid=${JSON.stringify(siteid)} ispublic=${JSON.stringify(ispublic)} showsuperusers=${showsuperusers} isunassigned=${isunassigned}`,
          viewer,
          { siteid, ispublic, showsuperusers, isunassigned },
        ]),
      ),
    ),
  );

  it.each(LIST_CASES)('lists %s as the reference does, page by page', async (_label, viewer, args) => {
    const expected = ids(referenceUsers(viewer, args));
    const { deps } = depsFor(viewer);
    expect((await getUsers(deps, viewer, args)).rows.map((row) => row.UserID)).toEqual(expected);
    for (const paging of PAGINGS) expect(pageIds(await getUsersPage(deps, viewer, args, paging)), JSON.stringify(paging)).toEqual(pageRows(expected, paging));
  });

  it.each(LIST_CASES)('streams the CSV rows of %s as getUsers and getUnassignedUsers read them', async (_label, viewer, args) => {
    const { deps } = depsFor(viewer);
    const full = await getUsers(deps, viewer, args);
    const streamed = await getUsersStream(deps, viewer, args);
    expect(streamed.columnList).toEqual(full.columnList);
    expect(await streamedRows(streamed)).toEqual(full.rows);
    const unassigned = { siteid: args.siteid, ispublic: args.ispublic, showsuperusers: args.showsuperusers };
    expect(await streamedRows(await getUnassignedUsersStream(deps, viewer, unassigned))).toEqual((await getUnassignedUsers(deps, viewer, unassigned)).rows);
  });

  it.each<[string, Omit<UsersQueryArgs, 'siteid'>]>([
    ['system users', { ispublic: 0 }],
    ['members', { ispublic: 1 }],
    ['every user', { ispublic: '' }],
    ['users without S2 accounts', { ispublic: '', showsuperusers: 1 }],
    ['unassigned users', { ispublic: 0, isunassigned: 1 }],
  ])('merges the %s of every tenant for siteid=all, each once, page by page', async (_label, args) => {
    const expected = ids(referenceUsers(ADMIN_A, args, true));
    const { deps, identity } = depsFor(ADMIN_A);
    const full = (await getAllSitesUsers(deps, ADMIN_A, args)).rows.map((row) => String(row.UserID));
    expect(full).toEqual(expected);
    expect(new Set(full).size).toBe(full.length);
    // Each of tenant-a, tenant-b and umbrella holds people, so each is read with identity's all-sites lookup.
    expect(identity.count('readAccountsAllSites')).toBe(3);
    expect(identity.count('readAccounts')).toBe(0);
    for (const paging of PAGINGS) expect(pageIds(await getAllSitesUsersPage(deps, ADMIN_A, args, paging)), JSON.stringify(paging)).toEqual(pageRows(expected, paging));
  });

  /** getSearch as legacy filters and orders it: six columns LIKE `%term%`, by last name, at most 2100. */
  function referenceSearch(viewer: ViewerScope, term: string, isPublic: number): User[] {
    if (term === '') return [];
    const pool = POOLS[viewer.tid]?.[isPublic === 0 ? 'private' : 'public'];
    const like = likeMatcher(`%${term}%`);
    const visible = tokenTenants(viewer);
    return sorted(
      users.filter((user) => {
        if (user.person.tenant !== pool?.tenant || charKey(user.person.siteid) !== charKey(pool.siteId) || !listed(user)) return false;
        if (!visible.includes(user.person.tenant) || !equals(user.account.isPublic, isPublic) || (!viewer.isS2 && !equals(user.account.s2, 0))) return false;
        const { lname, fname, company, email, jobtitle } = user.person;
        return [lname, fname, company, user.account.username, email, jobtitle].some((value) => value !== null && like.test(value));
      }),
      BY_NAME.slice(0, 1),
    ).slice(0, SEARCH_MAX_ROWS);
  }

  const TERMS = [
    'smith', 'SMITH ', 'Smí', 'mu', 'ü', 'ß', 's_ith', 'Sm[iy]th', '[^s]mith', '%', '_', 'acme', 'é', 'ann', '50%', 'a_b', '[x', 'back\\', 'zz',
    'kelvin', 'k', 'ſ', '中', 'sam%', 'nobody-matches-this',
  ];
  const SEARCH_CASES: [string, ViewerScope, string, number][] = [ADMIN_A, VIEWER_A, ADMIN_B].flatMap((viewer) =>
    TERMS.flatMap((term) => [0, 1].map((isPublic): [string, ViewerScope, string, number] => [`${JSON.stringify(term)} for ${viewer.site}${viewer.isS2 ? ' S2' : ''} isPublic=${isPublic}`, viewer, term, isPublic])),
  );

  it.each(SEARCH_CASES)('searches %s as the reference does, page by page', async (_label, viewer, search, isPublic) => {
    const expected = ids(referenceSearch(viewer, search, isPublic));
    const { deps } = depsFor(viewer);
    expect((await getSearch(deps, viewer, { search, isPublic })).rows.map((row) => row.userID)).toEqual(expected);
    for (const paging of PAGINGS.slice(0, 5)) {
      expect(pageIds(await getSearchPage(deps, viewer, { search, isPublic }, paging)), JSON.stringify(paging)).toEqual(pageRows(expected, paging));
    }
  });

  /** One advanced-search case: its options, the session criteria it adds and its params. */
  type AdvancedCase = [string, AdvancedSearchOptions, Partial<AdvancedSearchCriteria & UserFeedKeys>, SearchParamEntry[]];
  const ADVANCED_CASES: AdvancedCase[] = [
    ['the private pool by last name', { isPublic: 0 }, {}, []],
    ['the public pool by first name descending', { isPublic: 1, sortBy: 'fname', sortDirection: 'desc' }, {}, []],
    ['both pools by email', { sortBy: 'email' }, { ispublic: '' }, []],
    ['both pools by creation time descending, then last name', { sortBy: 'created', sortDirection: 'desc, lname asc' }, { ispublic: '' }, []],
    ['active system users by company', { isPublic: 0, sortBy: 'company' }, { inActive: '0' }, []],
    ['inactive system users', { isPublic: 0 }, { inActive: '1' }, []],
    ['members of g1 by update time', { isPublic: 0, sortBy: 'lastupdate' }, { groupID: 'g1' }, []],
    ['last names beginning sm', { isPublic: 0 }, {}, [param('tusers.lname^varchar', 'Begins', 'sm')]],
    ['both pools by the account username', { sortBy: 'username' }, { ispublic: '' }, []],
    ['the public pool for a numeric isPublic over both', { isPublic: 1 }, { ispublic: '' }, []],
  ];
  const SORT_READS: Readonly<Record<string, (user: User) => unknown>> = {
    lname: (user) => user.person.lname,
    fname: (user) => user.person.fname,
    email: (user) => user.person.email,
    company: (user) => user.person.company,
    created: (user) => user.person.created,
    lastupdate: (user) => user.person.lastupdate,
    username: (user) => user.account?.username ?? null,
  };

  /** getAdvancedSearch as legacy filters and orders these cases' criteria. */
  function referenceAdvanced(viewer: ViewerScope, [, options, extra, params]: AdvancedCase): User[] {
    const feedIsPublic = typeof options.isPublic === 'number' ? options.isPublic : extra.ispublic !== undefined ? extra.ispublic : 1;
    const pools = POOLS[viewer.tid];
    const chosen = String(feedIsPublic) === '0' ? [pools?.private] : String(feedIsPublic) === '1' ? [pools?.public] : [pools?.public, pools?.private];
    const sites = chosen.map((pool) => pool?.siteId ?? '');
    const inactive = extra.inActive === undefined || extra.inActive === '' ? undefined : Number(extra.inActive);
    const visible = tokenTenants(viewer);
    const begins = params.map((entry) => likeMatcher(`${entry.criteria}%`));
    const keys = `${options.sortBy ?? 'lname'} ${options.sortDirection ?? 'asc'}`.split(',').map((item): RefKey => {
      const [column = '', direction = 'asc'] = item.trim().split(/\s+/);
      return { read: SORT_READS[column.toLowerCase()] ?? (() => null), descending: direction.toLowerCase() === 'desc' };
    });
    return sorted(
      users.filter((user) => {
        if (!chosen.some((pool) => pool?.tenant === user.person.tenant) || !sites.some((site) => charKey(site) === charKey(user.person.siteid))) return false;
        if (!listed(user) || !visible.includes(user.person.tenant) || !sites.some((site) => charKey(site) === charKey(user.account.siteId))) return false;
        if (typeof feedIsPublic === 'number' && !equals(user.account.isPublic, feedIsPublic)) return false;
        if (inactive !== undefined && !equals(user.account.inactive, inactive)) return false;
        if (!viewer.isS2 && !equals(user.account.s2, 0)) return false;
        if (extra.groupID !== undefined && !user.groups.some((group) => compareSql(group, extra.groupID) === 0)) return false;
        return begins.every((like) => user.person.lname !== null && like.test(user.person.lname));
      }),
      keys,
    );
  }

  it.each(ADVANCED_CASES.flatMap((entry) => [ADMIN_A, VIEWER_A].map((viewer): [string, ViewerScope, AdvancedCase] => [`${entry[0]} for ${viewer.isS2 ? 'S2' : 'a site admin'}`, viewer, entry])))(
    'finds %s as the reference does, page by page and counted',
    async (_label, viewer, entry) => {
      const [, options, extra, paramArray] = entry;
      const criteria = { ...newAdvancedSearchCriteria(), paramArray, paramCount: paramArray.length, ...extra };
      const expected = ids(referenceAdvanced(viewer, entry));
      const { deps } = depsFor(viewer);
      expect((await getAdvancedSearch(deps, viewer, criteria, options)).rows.map((row) => row.userID)).toEqual(expected);
      expect((await getAdvancedSearch(deps, viewer, criteria, { ...options, countOnly: true })).rows).toEqual([{ count: expected.length }]);
      for (const paging of PAGINGS.slice(0, 5)) {
        expect(pageIds(await getAdvancedSearchPage(deps, viewer, criteria, options, paging)), JSON.stringify(paging)).toEqual(pageRows(expected, paging));
      }
    },
  );

  it('reads no account for a feed type other than a user', async () => {
    const { deps, identity } = depsFor(ADMIN_A);
    const criteria = { ...newAdvancedSearchCriteria(), type: 'group' };
    expect((await getAdvancedSearch(deps, ADMIN_A, criteria, { isPublic: 0 })).rows).toEqual([]);
    expect(identity.calls).toEqual([]);
  });

  /** Params whose stray `)` lets an `or` escape their group: `type and isPublic and pool and (lname sm%) or (fname a%) and inactive and s2`. */
  const ESCAPED: SearchParamEntry[] = [
    param('tusers.lname^varchar', 'Begins', 'sm'),
    { field: '', relationship: ')', criteria: '', condition: 'Equals' },
    { ...param('tusers.fname^varchar', 'Begins', 'a'), relationship: 'or (' },
  ];

  it.each<[string, ViewerScope, number, AdvancedSearchOptions, Partial<AdvancedSearchCriteria & UserFeedKeys>]>([
    ['active private-pool users for a site admin', VIEWER_A, 2, { isPublic: 0 }, { inActive: '0' }],
    ['active private-pool users for S2', ADMIN_A, 2, { isPublic: 0 }, { inActive: '0' }],
    ['a group feed', VIEWER_A, 1, { isPublic: 0 }, { inActive: '0' }],
    ['both pools', VIEWER_A, 2, {}, { ispublic: '' }],
  ])('binds an escaped or as SQL does, the base terms holding only beside the type term: %s', async (_label, viewer, type, options, extra) => {
    const feedIsPublic = typeof options.isPublic === 'number' ? options.isPublic : extra.ispublic !== undefined ? extra.ispublic : 1;
    const pools = POOLS[A];
    const chosen = String(feedIsPublic) === '0' ? [pools?.private] : String(feedIsPublic) === '1' ? [pools?.public] : [pools?.public, pools?.private];
    const inPool = (tenant: string | undefined, siteId: string): boolean => chosen.some((pool) => (tenant === undefined || pool?.tenant === tenant) && charKey(pool?.siteId ?? '') === charKey(siteId));
    const inactive = extra.inActive === undefined || extra.inActive === '' ? undefined : Number(extra.inActive);
    const sm = likeMatcher('sm%');
    const a = likeMatcher('a%');
    const expected = ids(
      sorted(
        users.filter((user) => {
          if (!inPool(user.person.tenant, user.person.siteid) || !listed(user)) return false;
          const first =
            user.account.type === type &&
            (typeof feedIsPublic !== 'number' || equals(user.account.isPublic, feedIsPublic)) &&
            inPool(undefined, user.account.siteId) &&
            user.person.lname !== null &&
            sm.test(user.person.lname);
          const second =
            user.person.fname !== null &&
            a.test(user.person.fname) &&
            (inactive === undefined || equals(user.account.inactive, inactive)) &&
            (viewer.isS2 || equals(user.account.s2, 0));
          return first || second;
        }),
        [{ read: (user) => user.person.lname, descending: false }],
      ),
    );
    const criteria = { ...newAdvancedSearchCriteria(), paramArray: ESCAPED, paramCount: ESCAPED.length, ...extra, type: String(type) };
    const { deps } = depsFor(viewer);
    expect(expected.length).toBeGreaterThan(0);
    expect((await getAdvancedSearch(deps, viewer, criteria, options)).rows.map((row) => row.userID)).toEqual(expected);
    expect((await getAdvancedSearch(deps, viewer, criteria, { ...options, countOnly: true })).rows).toEqual([{ count: expected.length }]);
    for (const paging of PAGINGS.slice(0, 5)) {
      expect(pageIds(await getAdvancedSearchPage(deps, viewer, criteria, options, paging)), JSON.stringify(paging)).toEqual(pageRows(expected, paging));
    }
  });

  // advancedSearchToCSV runs the session criteria with the feed's default sort, so only default-sort cases stream.
  const STREAMED_ADVANCED_CASES: AdvancedCase[] = [
    ...ADVANCED_CASES.filter(([, options]) => options.sortBy === undefined),
    ['members of g1', { isPublic: 0 }, { groupID: 'g1' }, []],
    ['an escaped or over both pools', {}, { ispublic: '' }, ESCAPED],
  ];

  it.each(
    STREAMED_ADVANCED_CASES.flatMap((entry) =>
      [ADMIN_A, VIEWER_A].map((viewer): [string, ViewerScope, AdvancedCase] => [`${entry[0]} for ${viewer.isS2 ? 'S2' : 'a site admin'}`, viewer, entry]),
    ),
  )('streams the advanced-search CSV rows of %s as getAdvancedSearch reads them', async (_label, viewer, [, options, extra, paramArray]) => {
    const criteria = { ...newAdvancedSearchCriteria(), paramArray, paramCount: paramArray.length, ...extra };
    const { deps } = depsFor(viewer);
    const full = await getAdvancedSearch(deps, viewer, criteria, options);
    const streamed = await getAdvancedSearchStream(deps, viewer, criteria, options);
    expect(streamed.columnList).toEqual(full.columnList);
    expect(await streamedRows(streamed)).toEqual(full.rows);
  });
});

describe('pageHold', () => {
  const values = Array.from({ length: 100_000 }, (_, index) => index);

  it.each<UsersPaging>([
    { startRow: 1000, recordsPerPage: 7 },
    { startRow: 14_286, recordsPerPage: 7 },
    { startRow: 14_287, recordsPerPage: 7 },
    { startRow: 90_000, recordsPerPage: 1 },
    { startRow: 200_000, recordsPerPage: 3 },
    { startRow: 0, recordsPerPage: 0 },
    { startRow: 2.5, recordsPerPage: 10 },
    { startRow: 1.5, recordsPerPage: 4.5 },
    {},
  ])('holds at most two pages of a long stream and shows the page pageRows shows for %o', (paging) => {
    const hold = pageHold<number>(paging);
    const perPage = paging.recordsPerPage !== undefined && paging.recordsPerPage >= 1 ? paging.recordsPerPage : 25;
    let most = 0;
    for (const value of values) {
      hold.offer(value);
      most = Math.max(most, hold.held);
    }
    expect(most).toBeLessThanOrEqual(2 * Math.ceil(perPage));
    expect(hold.count).toBe(values.length);
    expect(hold.page()).toEqual(pageRows(values, paging));
  });
});

describe.skipIf(!available)('search reads over large pools', () => {
  const POOL_SIZE = 2001;
  const BROAD = 2600;
  const bulkId = (lead: string, n: number): string => `${lead}${String(n).padStart(7, '0')}-0000-0000-0000000000000000`;
  const pooled: Person[] = Array.from({ length: POOL_SIZE }, (_, n) => ({
    tenant: B,
    userid: bulkId('P', n),
    siteid: TENANT_B.siteId,
    lname: `Pool${String((n * 37) % POOL_SIZE).padStart(5, '0')}`,
    fname: 'Bulk',
    company: null,
    email: null,
    jobtitle: null,
    created: null,
    lastupdate: null,
  }));
  const broad: Person[] = Array.from({ length: BROAD }, (_, n) => ({
    tenant: A,
    userid: bulkId('Q', n),
    siteid: TENANT_A.siteId,
    lname: `Broad${String(n).padStart(5, '0')}`,
    fname: 'Wide',
    company: null,
    email: null,
    jobtitle: null,
    created: null,
    lastupdate: null,
  }));
  const accounts = new Map([...pooled, ...broad].map((person) => [charKey(person.userid), accountOf(person, { username: `u${person.userid.slice(1, 8)}` })]));
  const memberships = new Map<string, string[]>();
  let handle: ThrowawaySchema;
  let repo: PeopleRepository;

  /** Search deps over a person-page counter and a fresh identity double answering `viewer`'s token. */
  function counted(viewer: ViewerScope): { deps: SearchDeps; identity: IdentityDouble; pages: () => number } {
    const counting = countingRepo(repo);
    const identity = new IdentityDouble(accounts, memberships, { db: handle.app, tid: viewer.tid, s2: viewer.isS2 });
    return { deps: { db: handle.app, repo: counting.repo, identity }, identity, pages: counting.pages };
  }

  beforeAll(async () => {
    handle = await openSchema('search-pushdown-bounds');
    repo = createPeopleRepository({ schema: handle.schema });
    await insertPersons(handle, [...pooled, ...broad]);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  const POOL_ARGS = { siteid: TENANT_B.siteId, ispublic: 0 };

  it('reads one person page and one account batch for the first row of a 2001-person pool', async () => {
    const { deps, identity, pages } = counted(ADMIN_B);
    const page = await getUsersPage(deps, ADMIN_B, POOL_ARGS, { startRow: 1, recordsPerPage: 1 });
    expect(page.rows.map((row) => row.Lname)).toEqual(['Pool00000']);
    expect(page.nextn.TotalRecords).toBe(POOL_SIZE);
    expect(identity.calls).toEqual([
      { op: 'countAccounts', ids: 0 },
      { op: 'readAccounts', ids: 500 },
    ]);
    expect(pages()).toBe(1);
  });

  it('reads persons only up to the last row of a deep list page, holding that page alone', async () => {
    const paging = { startRow: 40, recordsPerPage: 50 };
    const { deps, identity, pages } = counted(ADMIN_B);
    const page = await getUsersPage(deps, ADMIN_B, POOL_ARGS, paging);
    const full = await getUsers(counted(ADMIN_B).deps, ADMIN_B, POOL_ARGS);
    expect(page).toEqual(pageRows(full.rows, paging));
    // Rows 1951..2000 end in the fourth batch of 500, so the 2001st person is never read.
    expect(pages()).toBe(4);
    expect(identity.ids('readAccounts')).toBe(2000);
    expect(identity.count('countAccounts')).toBe(1);
  });

  it('asks identity for username candidates once and reads no account for a search nobody matches', async () => {
    const { deps, identity, pages } = counted(ADMIN_B);
    const page = await getSearchPage(deps, ADMIN_B, { search: 'qqqzzz' }, {});
    expect(page.rows).toEqual([]);
    expect(page.nextn.TotalRecords).toBe(0);
    expect(identity.calls).toEqual([{ op: 'usernameCandidates', ids: 0 }]);
    expect(pages()).toBe(1);
  });

  it(`stops a search of ${BROAD} matches at ${SEARCH_MAX_ROWS}`, async () => {
    const { deps, identity, pages } = counted(ADMIN_A);
    const result = await getSearch(deps, ADMIN_A, { search: 'broad' });
    expect(result.rows).toHaveLength(SEARCH_MAX_ROWS);
    expect(result.rows.at(-1)?.Lname).toBe(`Broad${String(SEARCH_MAX_ROWS - 1).padStart(5, '0')}`);
    expect(pages()).toBeLessThanOrEqual(Math.ceil(SEARCH_MAX_ROWS / 500) + 1);
    expect(identity.count('usernameCandidates')).toBe(1);
    expect(identity.ids('readAccounts')).toBeLessThan(BROAD);
  });

  it('pages a deep search page as pageRows pages the full search, extending only the page rows', async () => {
    const paging = { startRow: 40, recordsPerPage: 50 };
    const asked: number[] = [];
    const photoFileExts = async (fileIds: readonly (string | null | undefined)[]): Promise<ReadonlyMap<string, string>> => {
      asked.push(fileIds.length);
      return new Map();
    };
    const { deps, pages } = counted(ADMIN_A);
    const page = await getSearchPage({ ...deps, photoFileExts }, ADMIN_A, { search: 'broad' }, paging);
    const full = await getSearch(counted(ADMIN_A).deps, ADMIN_A, { search: 'broad' });
    expect(page).toEqual(pageRows(full.rows, paging));
    expect(page.nextn.TotalRecords).toBe(SEARCH_MAX_ROWS);
    expect(asked).toEqual([50]);
    expect(pages()).toBeLessThanOrEqual(Math.ceil(SEARCH_MAX_ROWS / 500) + 1);
  });

  it('merges every tenant for siteid=all with one count and one all-sites lookup per batch', async () => {
    const { deps, identity } = counted(ADMIN_A);
    const page = await getAllSitesUsersPage(deps, ADMIN_A, { ispublic: 0 }, { startRow: 2, recordsPerPage: 3 });
    expect(page.nextn.TotalRecords).toBe(POOL_SIZE + BROAD);
    // By name, Broad00000.. of tenant-a lead Pool00000.. of tenant-b.
    expect(page.rows.map((row) => row.Lname)).toEqual(['Broad00003', 'Broad00004', 'Broad00005']);
    expect(identity.calls).toEqual([
      { op: 'countAccounts', ids: 0 },
      { op: 'readAccountsAllSites', ids: 500 },
      { op: 'readAccountsAllSites', ids: 500 },
    ]);
  });

  it.each<[string, ViewerScope, (deps: SearchDeps) => Promise<unknown>]>([
    ['getUsers', ADMIN_B, (deps) => getUsers(deps, ADMIN_B, POOL_ARGS)],
    ['getSearch', ADMIN_A, (deps) => getSearch(deps, ADMIN_A, { search: 'broad' })],
  ])('stops %s with its RequestAbortedError when the request is abandoned during the first page, reading no later page or account batch', async (_label, viewer, read) => {
    const { deps, identity, pages } = counted(viewer);
    const disconnect = new AbortController();
    const reason = new RequestAbortedError();
    const abandoning: PeopleRepository = {
      ...deps.repo,
      pagePersonsInOrder: async (tx, scope, opts) => {
        const page = await deps.repo.pagePersonsInOrder(tx, scope, opts);
        disconnect.abort(reason);
        return page;
      },
    };
    const store = { ...newRequestContext(), signal: disconnect.signal };
    await expect(runWithRequestContext(store, () => read({ ...deps, repo: abandoning }))).rejects.toBe(reason);
    expect(pages()).toBe(1);
    expect(identity.calls.filter(({ op }) => op === 'readAccounts')).toEqual([{ op: 'readAccounts', ids: 500 }]);
    expect(handle.appPool.totalCount - handle.appPool.idleCount).toBe(0);
  });

  /** The private-pool advanced search of tenant-b with admin start-up's default criteria. */
  const POOL_ADVANCED = { isPublic: 0 };

  it('streams the users CSV rows of a 2001-person pool one person page per 500 rows pulled, as getUsers reads them', async () => {
    const { deps, identity, pages } = counted(ADMIN_B);
    const stream = await getUsersStream(deps, ADMIN_B, POOL_ARGS);
    expect(pages()).toBe(0);
    const rows = stream.rows[Symbol.asyncIterator]();
    const pulled: Record<string, unknown>[] = [];
    while (pulled.length < 501) {
      const next = await rows.next();
      if (next.done === true) break;
      pulled.push(next.value);
    }
    expect(pages()).toBe(2);
    expect(identity.calls).toEqual([
      { op: 'readAccounts', ids: 500 },
      { op: 'readAccounts', ids: 500 },
    ]);
    for (let next = await rows.next(); next.done !== true; next = await rows.next()) pulled.push(next.value);
    expect(pages()).toBe(5);
    expect(identity.count('countAccounts')).toBe(0);
    expect(pulled).toEqual((await getUsers(counted(ADMIN_B).deps, ADMIN_B, POOL_ARGS)).rows);
  });

  it('streams the advanced-search CSV rows of a 2001-person pool with one photo lookup per 500 rows, as getAdvancedSearch reads them', async () => {
    const asked: number[] = [];
    const photoFileExts = (fileIds: readonly (string | null | undefined)[]): Promise<ReadonlyMap<string, string>> => {
      asked.push(fileIds.length);
      return Promise.resolve(new Map());
    };
    const { deps, pages } = counted(ADMIN_B);
    const stream = await getAdvancedSearchStream({ ...deps, photoFileExts }, ADMIN_B, newAdvancedSearchCriteria(), POOL_ADVANCED);
    const rows = stream.rows[Symbol.asyncIterator]();
    const first = await rows.next();
    expect(first.done).toBe(false);
    expect(pages()).toBe(1);
    expect(asked).toEqual([500]);
    const pulled = first.done === true ? [] : [first.value];
    for (let next = await rows.next(); next.done !== true; next = await rows.next()) pulled.push(next.value);
    expect(asked).toEqual([500, 500, 500, 500, 1]);
    expect(pages()).toBe(5);
    expect(pulled).toEqual((await getAdvancedSearch(counted(ADMIN_B).deps, ADMIN_B, newAdvancedSearchCriteria(), POOL_ADVANCED)).rows);
  });

  it.each<[string, (deps: SearchDeps) => Promise<StreamedQuery>]>([
    ['users download', (deps) => getUsersStream(deps, ADMIN_B, POOL_ARGS)],
    ['advanced-search download', (deps) => getAdvancedSearchStream(deps, ADMIN_B, newAdvancedSearchCriteria(), POOL_ADVANCED)],
  ])('reads the %s only as its CSV body is read, and no further once the body is destroyed', async (_label, open) => {
    const { deps, pages } = counted(ADMIN_B);
    const query = await open(deps);
    const { body } = await legacyUsersCsvStream(query.columnList, query.rows);
    // The header and first batch are rendered before the body is answered.
    expect(pages()).toBe(1);
    await once(body, 'readable');
    expect(String(body.read()).split('\n')).toHaveLength(502);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // An unread body holds at most one further chunk.
    expect(pages()).toBeLessThanOrEqual(2);
    body.destroy();
    await once(body, 'close');
    const released = pages();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pages()).toBe(released);
    expect(released).toBeLessThan(5);
    expect(await query.rows[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
    expect(handle.appPool.totalCount - handle.appPool.idleCount).toBe(0);
  });

  it.each<[string, (deps: SearchDeps) => Promise<StreamedQuery>]>([
    ['an ispublic neither numeric nor boolean', (deps) => getUsersStream(deps, ADMIN_B, { siteid: TENANT_B.siteId, ispublic: 'maybe' })],
    [
      'a criterion no integer binds',
      (deps) =>
        getAdvancedSearchStream(deps, ADMIN_B, { ...newAdvancedSearchCriteria(), paramArray: [param('tusers.perm^integer', 'Equals', 'abc')], paramCount: 1 }, POOL_ADVANCED),
    ],
  ])('rejects a CSV stream for %s before reading any person or account', async (_label, open) => {
    const { deps, identity, pages } = counted(ADMIN_B);
    await expect(open(deps)).rejects.toBeInstanceOf(LegacyApiError);
    expect(pages()).toBe(0);
    expect(identity.calls).toEqual([]);
  });
});
