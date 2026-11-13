/** The cUsers CSV download routes over a throwaway `people` schema: exact streamed bytes and headers, filters and the `before()` gate. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, moduleRole } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  fixedClock,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  assertResponseMatchesOpenApi,
  seedRegistry,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { legacyUsersCsvStream, type LegacyQuery } from '@opt2/platform/legacy-compat';
import {
  getAdvancedSearch,
  getUnassignedUsers,
  getUsers,
  newAdvancedSearchCriteria,
  type AdvancedSearchCriteria,
  type SearchDeps,
  type ViewerScope,
} from '../../src/domain/search.js';
import type { AccountCountRequest, AccountView, AccountWhere, UsernameCandidateRequest, UsernameCandidates } from '../../src/legacy/identity-client.js';
import { createPeopleRepository, type PersonInput } from '../../src/repo/repository.js';
import { PEOPLE_UNITS } from '../../src/repo/tables.js';
import { registerAdminDownloadRoutes, type SearchCriteriaSession } from '../../src/routes/admin-downloads.js';
import { accountListed, ilikeC } from '../helpers/search-doubles.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const ADMIN = 'A0000000-0000-0000-0000000000000001';
const USERS_MODULE = moduleRole('00000000000000000000000000000000008');
const SITE_ADMIN = [Roles.siteAdmin, Roles.systemUser];
const CSV_HEADERS = { 'content-disposition': 'attachment;filename=users.csv', 'content-type': 'text/csv; charset=UTF-8' };
const USERS_HEADER =
  '"ADMIN","EMAIL","FNAME","GROUPNAME","ISPUBLIC","LASTUPDATE","LASTUPDATEBY","LNAME","S2","SITEID","SUBTYPE","TYPE","USERID","USERNAME"\n';
const ADA_USERS_LINE =
  '0 ,"ada@csv.test "," Ada "," ",0 ,"2026-01-10 08:30:15.37 ","Admin, Ada ","Lovelace ",0 ,"tenant-a ","Default ",2 ,' +
  '"A1000000-0000-0000-0000000000000000 ","ada "\n';
const QUINN_USERS_LINE =
  '0 ," ","Quinn "Q" "," ",0 ,"2026-02-03 04:05:06.0 ","Admin, Ada ","Quote ",0 ,"tenant-a ","Default ",2 ,' +
  '"A2000000-0000-0000-0000000000000000 ",007 \n';
const SEARCH_HEADER =
  '"COMPANY","CONTACTFORM","CREATED","DESCRIPTION","EMAIL","FNAME","GROUPNAME","IMNAME","IMSERVICE","INACTIVE","INTERESTS",' +
  '"ISPUBLIC","JOBTITLE","KEEPPRIVATE","LASTLOGIN","LASTUPDATE","LASTUPDATEBY","LASTUPDATEBYID","LNAME","MOBILEPHONE","NOTES",' +
  '"PASSWORDCREATED","PERM","PHOTOFILEEXT","PHOTOFILEID","REMOTEID","S2","SITEID","SUBSCRIBE","SUBTYPE","TABLIST","TAGS","TYPE",' +
  '"USERID","USERNAME","WEBSITE"\n';
const ADA_SEARCH_LINE =
  '"Engines, Ltd. "," ","2026-01-10 08:30:15.37 "," ","ada@csv.test "," Ada "," "," "," ",0 ," ",0 ,"Countess ",0 ,' +
  '"2026-06-29 08:15:00.0 ","2026-01-10 08:30:15.37 ","Admin, Ada ","ACTOR ","Lovelace "," "," ","2026-01-02 09:00:00.5 ",0 ," ",' +
  '" ","R-1 ",0 ,"tenant-a ",1 ,"Default ","basic "," ",2 ,"A1000000-0000-0000-0000000000000000 ","ada "," "\n';

/** A 35-character legacy id whose first block is `tag` padded with zeros. */
function id(tag: string): string {
  return `${tag.padEnd(8, '0')}-0000-0000-0000000000000000`;
}

/** Identity's account columns of one user, legacy defaults for a member of the private pool. */
function account(tag: string, siteId: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    userId: id(tag), siteId, username: tag.toLowerCase(), s2: 0, isPublic: 0, inactive: 0, type: 2, perm: 0, admin: 0,
    remoteId: null, lastLogin: null, passwordCreated: null, tablist: null, ...overrides,
  };
}

type IdentityReads = SearchDeps['identity'];

/** In-file identity double of the reads search.ts makes, listing as identity's contract does; `complexUser` answers a username ACF cannot render. */
class FakeIdentity implements IdentityReads {
  readonly accounts = new Map<string, AccountView>();
  readonly memberships = new Map<string, string[]>();
  complexUser: string | undefined;

  async readAccounts(userIds: readonly string[], where?: AccountWhere): Promise<Map<string, AccountView>> {
    const found = new Map<string, AccountView>();
    for (const userId of userIds) {
      const view = this.accounts.get(userId);
      if (view === undefined || !accountListed(view, where, this.memberships)) continue;
      found.set(userId, userId === this.complexUser ? { ...view, username: {} as unknown as string } : view);
    }
    return found;
  }

  readAccountsAllSites(userIds: readonly string[], where?: AccountWhere): Promise<Map<string, AccountView>> {
    return this.readAccounts(userIds, where);
  }

  async lookupMemberships(userIds: readonly string[]): Promise<Map<string, string[]>> {
    return new Map(userIds.map((userId) => [userId, [...(this.memberships.get(userId) ?? [])]]));
  }

  async countAccounts(request: AccountCountRequest): Promise<number> {
    return [...this.accounts.values()].filter((view) => accountListed(view, request.where, this.memberships)).length;
  }

  async usernameCandidates(request: UsernameCandidateRequest): Promise<UsernameCandidates> {
    const like = ilikeC(request.pattern);
    const items = [...this.accounts.values()]
      .filter((view) => accountListed(view, request.where, this.memberships) && view.username !== null && like(view.username))
      .map((view) => ({ userId: view.userId, username: view.username as string }))
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    return { items: items.slice(0, request.limit), complete: items.length <= request.limit };
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

describe.skipIf(!available)('cUsers CSV downloads against PostgreSQL', () => {
  const identity = new FakeIdentity();
  const stored = new Map<string, AdvancedSearchCriteria>();
  let handle: ThrowawaySchema;
  let stateDir: string;
  let app: FastifyInstance;

  /** Inserts a person of tenant-a's private pool through the repository, stamped at `at`. */
  async function addPerson(tag: string, input: Partial<PersonInput>, at: Date): Promise<void> {
    const writer = createPeopleRepository({ clock: fixedClock(at), schema: handle.schema });
    const row: PersonInput = {
      userid: id(tag), groupname: '', fname: '', lname: '', email: '', company: '', jobtitle: '', mobilephone: '', website: '',
      subtype: 'Default', contactform: '', lastupdateby: 'Admin, Ada', lastupdatebyid: 'ACTOR', siteid: TENANT_A.siteId, subscribe: 1,
      notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '', tags: '', ...input,
    };
    await handle.app.withTenant(TENANT_A.tenantId, (tx) => writer.insertPerson(tx, row));
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await seedRegistry(handle.app);
    await ensureUnitGates(handle.app, PEOPLE_UNITS);
    await closeGates(handle.app, { units: PEOPLE_UNITS, holderId: 'admin-downloads-test', allowLegacy: true });
    await openGates(handle.app, { units: PEOPLE_UNITS, holderId: 'admin-downloads-test', state: 'open' });
    await addPerson('A1', { fname: ' Ada', lname: 'Lovelace', email: 'ada@csv.test', company: 'Engines, Ltd.', jobtitle: 'Countess' }, new Date(2026, 0, 10, 8, 30, 15, 370));
    await addPerson('A2', { fname: 'Quinn "Q"', lname: 'Quote', email: null }, new Date(2026, 1, 3, 4, 5, 6, 0));
    for (const view of [
      account('A1', TENANT_A.siteId, { username: 'ada', remoteId: 'R-1', tablist: 'basic', lastLogin: '2026-06-29 08:15:00', passwordCreated: '2026-01-02T09:00:00.5' }),
      account('A2', TENANT_A.siteId, { username: '007' }),
    ]) {
      identity.accounts.set(view.userId, view);
    }
    identity.memberships.set(id('A1'), ['G1']);

    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-people-admin-downloads-'));
    await writeTestSecrets(stateDir);
    app = await createService({
      name: 'people',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8112',
        OPT2_SERVICE_NAME: 'people',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: stateDir,
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('people'),
      logger: createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    const searchCriteria = { read: async (session: SearchCriteriaSession) => stored.get(`${session.tid}:${session.sid}`) };
    await registerAdminDownloadRoutes(app, { search: { db: handle.app, repo: createPeopleRepository({ schema: handle.schema }), identity }, searchCriteria });
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    identity.complexUser = undefined;
    stored.clear();
  });

  /** Headers of web's call for a user of `site` holding `roles` in session `sid`. */
  async function headersFor(roles: readonly string[], site = TENANT_A.siteId, sid = 'S-1'): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await mintUserToken({ sub: ADMIN, sid, site, roles })}`,
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'web', audience: 'people' })}`,
    };
  }

  /** GETs `url`, checks a contract-declared answer against the contract, and returns its status, headers and raw body. */
  async function get(url: string, headers: Record<string, string>) {
    const res = await app.inject({ method: 'GET', url, headers });
    if (res.statusCode !== 500) {
      assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: url.split('?')[0] ?? url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    }
    return { status: res.statusCode, headers: res.headers, body: res.rawPayload.toString('utf8') };
  }

  /** Stores advanced-search criteria for session `sid` of tenant-a, as `setAdvancedSearch` would. */
  function storeCriteria(sid: string, lname: string): void {
    const paramArray = [{ field: 'tusers.lname^varchar', relationship: 'and', condition: 'Equals', criteria: lname }];
    stored.set(`${TENANT_A.tenantId}:${sid}`, { ...newAdvancedSearchCriteria(), paramArray, paramCount: 1 });
  }

  describe('GET /v1/users/download', () => {
    it.each([
      { filter: 'every private-pool user, by name', query: 'ispublic=0', body: USERS_HEADER + ADA_USERS_LINE + QUINN_USERS_LINE },
      { filter: 'users without a membership', query: 'ispublic=0&unassigned=1', body: USERS_HEADER + QUINN_USERS_LINE },
      { filter: 'an empty public pool', query: 'ispublic=1', body: USERS_HEADER },
    ])('streams $filter as the legacy users CSV', async ({ query, body }) => {
      const res = await get(`/v1/users/download?${query}`, await headersFor(SITE_ADMIN));
      expect(res.status).toBe(200);
      expect(res.headers).toMatchObject(CSV_HEADERS);
      expect(res.headers['content-length']).toBeUndefined();
      expect(res.body).toBe(body);
    });

    it('answers only the header for a tenant without users', async () => {
      const res = await get('/v1/users/download?ispublic=0', await headersFor(SITE_ADMIN, TENANT_B.siteId));
      expect(res).toMatchObject({ status: 200, body: USERS_HEADER });
    });

    it('answers the error response, not a CSV, when a first-batch cell cannot be rendered', async () => {
      identity.complexUser = id('A2');
      const res = await get('/v1/users/download?ispublic=0', await headersFor(SITE_ADMIN));
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).not.toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBeUndefined();
    });
  });

  describe('GET /v1/users/advanced-search.csv', () => {
    it("streams the session's stored criteria result", async () => {
      storeCriteria('S-1', 'Lovelace');
      const res = await get('/v1/users/advanced-search.csv?ispublic=0', await headersFor(SITE_ADMIN));
      expect(res.status).toBe(200);
      expect(res.headers).toMatchObject(CSV_HEADERS);
      expect(res.body).toBe(SEARCH_HEADER + ADA_SEARCH_LINE);
    });

    it('answers only the header when the stored criteria match nobody', async () => {
      storeCriteria('S-1', 'Nobody');
      const res = await get('/v1/users/advanced-search.csv?ispublic=0', await headersFor(SITE_ADMIN));
      expect(res).toMatchObject({ status: 200, body: SEARCH_HEADER });
    });

    it("runs admin start-up's default criteria for a session that stored none", async () => {
      storeCriteria('S-OTHER', 'Nobody');
      const res = await get('/v1/users/advanced-search.csv?ispublic=0', await headersFor(SITE_ADMIN));
      expect(res.body.startsWith(SEARCH_HEADER + ADA_SEARCH_LINE)).toBe(true);
      expect(res.body.split('\n')).toHaveLength(4);
      expect(res.body).toContain(`"${id('A2')} ",007 ," "\n`);
    });
  });

  describe('the cUsers gate', () => {
    it.each([
      ['anonymous', async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'web', audience: 'people' })}` }), 401],
      ['Users module only', () => headersFor([USERS_MODULE, Roles.systemUser]), 403],
      ['a member', () => headersFor([Roles.member]), 403],
    ])('refuses %s on both downloads', async (_case, headers, status) => {
      for (const url of ['/v1/users/download?ispublic=0', '/v1/users/advanced-search.csv?ispublic=0']) {
        const res = await get(url, await headers());
        expect(res.status, url).toBe(status);
        expect(res.headers['content-type'], url).not.toMatch(/^text\/csv/);
      }
    });
  });

  describe('over a pool of more users than one batch', () => {
    const BULK = 1201;
    // A site admin of umbrella, whose private pool is umbrella's own; the earlier cases read no umbrella user of it.
    const VIEWER: ViewerScope = { tid: TENANT_UMBRELLA.tenantId, site: TENANT_UMBRELLA.siteId, isS2: false };
    const bulkId = (n: number): string => `B${String(n).padStart(7, '0')}-0000-0000-0000000000000000`;
    let searchDeps: SearchDeps;

    beforeAll(async () => {
      const writer = createPeopleRepository({ clock: fixedClock(new Date(2026, 2, 4, 5, 6, 7, 80)), schema: handle.schema });
      await handle.app.withTenant(TENANT_UMBRELLA.tenantId, async (tx) => {
        for (let n = 0; n < BULK; n += 1) {
          await writer.insertPerson(tx, {
            userid: bulkId(n), groupname: '', fname: `Bulk ${String(n % 7)}`, lname: `Pool${String((n * 37) % BULK).padStart(5, '0')}`,
            email: `bulk${String(n)}@csv.test`, company: n % 5 === 0 ? 'Batch, Inc.' : '', jobtitle: '', mobilephone: '', website: '',
            subtype: 'Default', contactform: '', lastupdateby: 'Admin, Ada', lastupdatebyid: 'ACTOR', siteid: TENANT_UMBRELLA.siteId,
            subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '', tags: '',
          });
        }
      });
      for (let n = 0; n < BULK; n += 1) {
        identity.accounts.set(bulkId(n), account(bulkId(n).slice(0, 8), TENANT_UMBRELLA.siteId, { userId: bulkId(n) }));
        if (n % 3 === 0) identity.memberships.set(bulkId(n), ['G2']);
      }
      searchDeps = { db: handle.app, repo: createPeopleRepository({ schema: handle.schema }), identity };
    });

    /** The bytes of a CSV body. */
    async function bodyText(query: LegacyQuery): Promise<string> {
      const { body } = await legacyUsersCsvStream(query.columnList, query.rows);
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    }

    it.each<[string, number, () => Promise<LegacyQuery>]>([
      ['/v1/users/download?ispublic=0', BULK, () => getUsers(searchDeps, VIEWER, { siteid: TENANT_UMBRELLA.siteId, ispublic: '0' })],
      ['/v1/users/download?ispublic=0&unassigned=1', 800, () => getUnassignedUsers(searchDeps, VIEWER, { siteid: TENANT_UMBRELLA.siteId, ispublic: '0' })],
      [
        '/v1/users/advanced-search.csv?ispublic=0',
        BULK,
        () => getAdvancedSearch(searchDeps, VIEWER, newAdvancedSearchCriteria(), { siteid: TENANT_UMBRELLA.siteId, isPublic: '0' }),
      ],
    ])('streams %s byte for byte as the CSV of the full read', async (url, rows, fullRead) => {
      const res = await get(url, await headersFor(SITE_ADMIN, TENANT_UMBRELLA.siteId));
      expect(res.status).toBe(200);
      expect(res.headers).toMatchObject(CSV_HEADERS);
      expect(res.headers['content-length']).toBeUndefined();
      const full = await fullRead();
      expect(full.rows).toHaveLength(rows);
      expect(res.body.split('\n')).toHaveLength(rows + 2);
      expect(res.body).toBe(await bodyText(full));
    });
  });
});
