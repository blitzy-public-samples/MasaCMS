/** search.ts refusals of denied feed join tables and getSearchPage's bounded reads over recording doubles; the seeded reads are in test/isolation/search.test.ts. */
// Constants, nextN, criteria and queryParam parsing are held to legacy in search-criteria.test.ts, LIKE in search-like.test.ts,
// column matching and the 2100-row cap in search-queries.test.ts and search-pushdown.test.ts; this suite does not repeat them.
import { beforeAll, describe, expect, it } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { TENANT_A } from '@opt2/platform/testing';
import type { MetadataTx, QueryResult, QueryResultRow, TenantDb, TenantTx } from '@opt2/platform/tenancy';
import {
  DENIED_FEED_JOIN_TABLES,
  SEARCH_MAX_ROWS,
  getAdvancedSearch,
  getSearch,
  getSearchPage,
  pageRows,
  type SearchDeps,
  type UsersPage,
  type UsersPaging,
  type ViewerScope,
} from '../../src/domain/search.js';
import type { AccountView } from '../../src/legacy/identity-client.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';
import type { PersonRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, createRecordingDb } from '../helpers/app.js';
import { createIdentityDouble } from '../helpers/identity-double.js';
import { SITE_ADMIN_A } from '../helpers/fixtures.js';
import { criteriaOf, viewerOf } from '../helpers/search-args.js';
import { IdentityDouble, charKey, personSearchKeys, personsById, personsInOrder } from '../helpers/search-doubles.js';

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

describe('getSearchPage over a pool past the 2100-row cap', () => {
  const TID = TENANT_A.tenantId;
  const SITE = TENANT_A.siteId;
  const VIEWER: ViewerScope = { tid: TID, site: SITE, isS2: false };
  const uid = (n: number): string => `5EA2C400-0000-4000-8000${String(n).padStart(12, '0')}`;
  const LAST_UPDATE = new Date(2026, 5, 1, 9, 30, 0);

  /** Pool person `n`: by its last digit a username-only match, hidden by S2, without an account, a member, a company match, no match, or a last-name match. */
  function poolUser(n: number): { person: PersonRow; account: AccountView | undefined } {
    const kind = n % 10;
    const lname = kind === 0 ? 'Other' : kind === 4 ? 'Zed' : kind === 5 ? 'Plain' : `Match${n % 97}`;
    const person: PersonRow = {
      tenant_id: TID, userid: uid(n), groupname: null, fname: 'Pat', lname, email: null, company: kind === 4 ? 'Matchco' : null, jobtitle: null,
      mobilephone: null, website: null, subtype: 'Default', ext: null, contactform: null, lastupdate: LAST_UPDATE, lastupdateby: 'Admin User',
      lastupdatebyid: uid(0), siteid: SITE, subscribe: null, notes: null, description: null, interests: null, keepprivate: 0,
      photofileid: n % 7 === 0 ? `PHOTO-${n}` : null, imname: null, imservice: null, created: null, tags: null, row_version: '1',
    };
    const account: AccountView = {
      userId: person.userid, siteId: SITE, username: kind === 0 ? `match${n}` : kind === 5 ? 'plain' : `u${n}`, s2: kind === 1 ? 1 : 0,
      isPublic: kind === 3 ? 1 : 0, inactive: 0, type: 2, perm: 0, admin: 0, remoteId: null, lastLogin: null, passwordCreated: null, tablist: null,
    };
    return { person, account: kind === 2 ? undefined : account };
  }

  // 3600 persons the prefilter of `match` reads, 2400 of them matches: the first 2100 end at the 100th Zed.
  const USERS = Array.from({ length: 4000 }, (_, n) => poolUser(n));
  const PERSONS = USERS.map(({ person }) => person);
  const ACCOUNTS = new Map(USERS.flatMap(({ account }) => (account === undefined ? [] : [[charKey(account.userId), account] as const])));
  const REGISTRY: QueryResultRow = {
    site_id: SITE, tenant_id: TID, public_user_pool_id: null, private_user_pool_id: null, category_pool_id: null, file_pool_id: null,
    display_pool_id: null, content_pool_ids: [], public_user_pool_tenant: null, private_user_pool_tenant: null, category_pool_tenant: null,
    file_pool_tenant: null, display_pool_tenant: null, content_pool_tenants: [], domains: [], aggregate_version: '1', updated_at: LAST_UPDATE,
  };

  /** What the people side read: tenant transactions, ordered keyset pages, search-key lists and their rows, and the ids of each person lookup. */
  interface PeopleReads {
    transactions: number;
    keysetPages: number;
    keyLists: number;
    keyRows: number;
    personLookups: number[];
  }

  /** Search deps over the pool, recording the people reads, identity's calls and the photo lookups' sizes. */
  function world(): { deps: SearchDeps; identity: IdentityDouble; reads: PeopleReads; photoLookups: number[] } {
    const reads: PeopleReads = { transactions: 0, keysetPages: 0, keyLists: 0, keyRows: 0, personLookups: [] };
    const photoLookups: number[] = [];
    const empty = <R extends QueryResultRow>(rows: readonly QueryResultRow[] = []): Promise<QueryResult<R>> =>
      Promise.resolve({ command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows: rows as R[] });
    const tenantTx = (tenantId: string): TenantTx => ({ kind: 'tenant', tenantId, schema: 'people', onCommit: () => undefined, query: () => empty() });
    const metadataTx: MetadataTx = {
      kind: 'metadata',
      schema: 'people',
      onCommit: () => undefined,
      query: <R extends QueryResultRow>(_text: unknown, values?: unknown[]) => empty<R>([REGISTRY].filter((row) => row.tenant_id === values?.[0])),
    };
    const db: TenantDb = {
      schema: 'people',
      withTenant: (tenantId, fn) => {
        reads.transactions += 1;
        return fn(tenantTx(tenantId));
      },
      withMetadata: (fn) => fn(metadataTx),
      end: () => Promise.resolve(),
    };
    const ofTenant = (tx: TenantTx): PersonRow[] => PERSONS.filter((row) => row.tenant_id === tx.tenantId);
    type Reads = 'pagePersonsInOrder' | 'listPersonSearchKeys' | 'findPersons' | 'lockRosterUsers' | 'lockRosterTenant' | 'findOpenRosterOperations' | 'countRosterOperations';
    // No roster operation is ever open in this world; a keyset cursor holds the next row's offset.
    const repo: Pick<PeopleRepository, Reads> = {
      pagePersonsInOrder: (tx, scope, opts) => {
        reads.keysetPages += 1;
        const rows = personsInOrder(ofTenant(tx), scope, opts.orderBy);
        const from = Number(opts.after?.keys[0] ?? 0);
        const to = from + (opts.limit ?? 500);
        return Promise.resolve({ rows: rows.slice(from, to), next: to < rows.length ? { keys: [to], userid: '' } : null });
      },
      listPersonSearchKeys: (tx, scope, orderBy) => {
        const keys = personSearchKeys(ofTenant(tx), scope, orderBy);
        reads.keyLists += 1;
        reads.keyRows += keys.length;
        return Promise.resolve(keys);
      },
      findPersons: (tx, userIds) => {
        reads.personLookups.push(userIds.length);
        return Promise.resolve(personsById(ofTenant(tx), userIds));
      },
      lockRosterUsers: () => Promise.resolve(),
      lockRosterTenant: () => Promise.resolve(),
      findOpenRosterOperations: () => Promise.resolve([]),
      countRosterOperations: () => Promise.resolve(0),
    };
    const photoFileExts = (fileIds: readonly (string | null | undefined)[]): Promise<ReadonlyMap<string, string>> => {
      photoLookups.push(fileIds.length);
      return Promise.resolve(new Map(fileIds.flatMap((fileId) => (fileId === null || fileId === undefined ? [] : [[fileId, 'jpg'] as const]))));
    };
    const identity = new IdentityDouble(ACCOUNTS, new Map(), { db, tid: TID, s2: false });
    return { deps: { db, repo: repo as PeopleRepository, identity, photoFileExts, clock: TEST_CLOCK }, identity, reads, photoLookups };
  }

  // getSearch still reads its matches in keyset batches, as getSearchPage did, so pageRows of its rows is the earlier page.
  const TERMS = ['match', 'matchco', 'nobody'] as const;
  const full = new Map<string, Record<string, unknown>[]>();
  beforeAll(async () => {
    for (const search of TERMS) full.set(search, (await getSearch(world().deps, VIEWER, { search, isPublic: 0 })).rows);
  });

  it('counts 2100 of the 2400 matches of match, 400 of matchco and none of nobody', () => {
    expect(TERMS.map((term) => full.get(term)?.length)).toEqual([SEARCH_MAX_ROWS, 400, 0]);
  });

  it.each<[string, (typeof TERMS)[number], UsersPaging]>([
    ['the first page', 'match', { startRow: 1, recordsPerPage: 10 }],
    ['a middle page', 'match', { startRow: 105, recordsPerPage: 10 }],
    ['the last page', 'match', { startRow: 210, recordsPerPage: 10 }],
    ['a start row past the 2100 rows, which shows page 1', 'match', { startRow: 5000, recordsPerPage: 10 }],
    ['the default page', 'match', {}],
    ['a 1000-row page', 'match', { startRow: 2, recordsPerPage: 1000 }],
    ['the first page', 'matchco', { startRow: 1, recordsPerPage: 25 }],
    ['the last page', 'matchco', { startRow: 16, recordsPerPage: 25 }],
    ['a start row past the 400 rows, which shows page 1', 'matchco', { startRow: 401, recordsPerPage: 25 }],
    ['a page size below 1, which reads as 25', 'matchco', { startRow: 0, recordsPerPage: 0 }],
    ['the default page', 'nobody', {}],
  ])('shows %s of %s as pageRows pages the full getSearch', async (_label, search, paging) => {
    const page: UsersPage<Record<string, unknown>> = await getSearchPage(world().deps, VIEWER, { search, isPublic: 0 }, paging);
    expect(page).toEqual(pageRows(full.get(search) ?? [], paging));
  });

  it.each([10, 100, 1000])(
    'reads a %d-row page with one search-key list, three people transactions, one person lookup of the page and the same four account lookups',
    async (perPage) => {
      const { deps, identity, reads, photoLookups } = world();
      const page = await getSearchPage(deps, VIEWER, { search: 'match', isPublic: 0 }, { startRow: 2, recordsPerPage: perPage });
      expect(page.rows).toHaveLength(perPage);
      expect(page.nextn.TotalRecords).toBe(SEARCH_MAX_ROWS);
      // The 3600 candidates in chunks of 1000; the fourth holds the 2100th match.
      expect(identity.calls).toEqual([
        { op: 'usernameCandidates', ids: 0 },
        { op: 'readAccounts', ids: 1000 },
        { op: 'readAccounts', ids: 1000 },
        { op: 'readAccounts', ids: 1000 },
        { op: 'readAccounts', ids: 600 },
      ]);
      // The search-key read, the page's person lookup and the observer's check of both.
      expect(reads).toEqual({ transactions: 3, keysetPages: 0, keyLists: 1, keyRows: 3600, personLookups: [perPage] });
      expect(photoLookups).toEqual([perPage]);
    },
  );

  it('reads no person row, account or photo past the search keys when nothing matches', async () => {
    const { deps, identity, reads, photoLookups } = world();
    const page = await getSearchPage(deps, VIEWER, { search: 'nobody', isPublic: 0 }, {});
    expect(page.nextn.TotalRecords).toBe(0);
    expect(identity.calls).toEqual([{ op: 'usernameCandidates', ids: 0 }]);
    expect(reads).toEqual({ transactions: 1, keysetPages: 0, keyLists: 1, keyRows: 0, personLookups: [] });
    expect(photoLookups).toEqual([0]);
  });
});
