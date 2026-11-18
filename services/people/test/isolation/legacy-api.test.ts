/** People's JSON API `user` and `address` reads and withheld saves through `app.inject` over a throwaway `people` schema. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_UMBRELLA } from '@opt2/platform/testing';
import {
  ADMIN_S2,
  DEFAULT_PEOPLE_SEED,
  MEMBER_POOLED,
  MODULE_USER_A,
  SITE_ADMIN_A,
  SYSTEM_USER_A,
  accountFor,
  accountsForSeed,
  addressRow,
  personRow,
  seedPeople,
  type TestActor,
} from '../helpers/fixtures.js';
import {
  CSRF,
  FAMILIES,
  RELOAD_KEY,
  actorHeaders,
  apiPath,
  dataOf,
  legacyEnvelope,
  legacyError,
  operationIds,
  send,
  type Family,
  type LegacyErrorType,
  type Method,
} from '../helpers/legacy-api-wire.js';
import type { DoubleGroup } from '../helpers/identity-double.js';
import { PG_AVAILABLE, withPgApp, type PgTestApp } from '../helpers/pg-app.js';
import type { AddressRow, PersonRow } from '../../src/repo/tables.js';

/** A packaged iterator page, its keys lower-cased as the serializer writes them. */
interface Collection {
  entityname: string;
  totalitems: number;
  totalpages: number;
  pageindex: number;
  itemsperpage: number;
  items: Array<Record<string, unknown>>;
  links: Record<string, string>;
}

const GROUP_ID = '6A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
/** Tenant-a groups whose name order is the reverse of their id order; a membership of GROUP_ID, which names no group, dangles. */
const ZULU_GROUP: DoubleGroup = { UserID: '1A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9', GroupName: 'Zulu', SiteID: TENANT_A.siteId, isPublic: 0, Perm: 0 };
const ALPHA_GROUP: DoubleGroup = { UserID: '9A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9', GroupName: 'alpha', SiteID: TENANT_A.siteId, isPublic: 0, Perm: 0 };

/** A seeded person of `DEFAULT_PEOPLE_SEED`. */
function seededPerson(userId: string) {
  const person = Object.values(DEFAULT_PEOPLE_SEED)
    .flatMap((tenant) => tenant.persons ?? [])
    .find((row) => row.userid === userId);
  if (person === undefined) throw new Error(`no seeded person ${userId}`);
  return person;
}

/** The seeded addresses of `userId`, primary first. */
function seededAddresses(userId: string) {
  return Object.values(DEFAULT_PEOPLE_SEED)
    .flatMap((tenant) => tenant.addresses ?? [])
    .filter((row) => row.userid === userId)
    .sort((a, b) => (b.isprimary ?? 0) - (a.isprimary ?? 0));
}

describe.skipIf(!PG_AVAILABLE)('JSON API reads and withheld saves over PostgreSQL', () => {
  let ctx: PgTestApp;
  let release: () => void = () => undefined;
  let running: Promise<unknown> | undefined;
  const seededAccounts = accountsForSeed(DEFAULT_PEOPLE_SEED);
  const owner = seededPerson(SYSTEM_USER_A.sub);
  const [ownerHome, ownerWork] = seededAddresses(owner.userid);
  const pooled = seededPerson(MEMBER_POOLED.sub);
  const [pooledHome] = seededAddresses(pooled.userid);
  /** tenant-a's public members, stored in umbrella, which a user feed lists by default. */
  const umbrellaPersons = DEFAULT_PEOPLE_SEED[TENANT_UMBRELLA.tenantId]?.persons ?? [];
  const publicUsers = umbrellaPersons.length;
  const publicMembers = umbrellaPersons.slice(0, 2);
  /** tenant-a's private-pool users: its site administrator, module users, system user and CSV quirk users. */
  const privateUsers = (DEFAULT_PEOPLE_SEED[TENANT_A.tenantId]?.persons ?? []).length;
  const s2OnTenantA: TestActor = { ...ADMIN_S2, site: TENANT_A.siteId };

  beforeAll(async () => {
    const opened = new Promise<PgTestApp>((resolve, reject) => {
      running = withPgApp(async (pg) => {
        resolve(pg);
        await new Promise<void>((done) => {
          release = done;
        });
      });
      running.then((outcome) => {
        reject(new Error(`withPgApp ended before the suite: ${JSON.stringify(outcome)}`));
      }, reject);
    });
    ctx = await opened;
    await seedPeople(ctx.db, DEFAULT_PEOPLE_SEED, { clock: ctx.clock });
  });

  afterAll(async () => {
    release();
    await running;
  });

  beforeEach(() => {
    ctx.identity.clear();
    ctx.identity.seedAccounts(...seededAccounts);
  });

  /** A tenant-a person stored for one case, with an identity account until the next `clear()`. */
  async function ownPerson(): Promise<PersonRow> {
    const person = personRow({ siteid: TENANT_A.siteId });
    await seedPeople(ctx.db, { [TENANT_A.tenantId]: { persons: [person] } }, { clock: ctx.clock });
    ctx.identity.seedAccounts(accountFor(person));
    return person;
  }

  /** A non-primary address of a person stored for one case. */
  async function ownAddress(): Promise<AddressRow> {
    const person = await ownPerson();
    const address = addressRow({ siteid: TENANT_A.siteId, userid: person.userid, addressname: 'Work' });
    await seedPeople(ctx.db, { [TENANT_A.tenantId]: { addresses: [address] } }, { clock: ctx.clock });
    return address;
  }

  describe.each(FAMILIES)('%s reads', (family) => {
    it('reads a user as the filtered entity, combining people columns with identity account columns', async () => {
      ctx.identity.seedAccounts(accountFor(owner, { username: 'sydney.system', remoteId: 'REMOTE-1' }));
      const data = dataOf(await send(ctx.app, 'GET', apiPath(family, `/user/${owner.userid}`), await actorHeaders(SITE_ADMIN_A)));
      expect(data).toMatchObject({
        entityname: 'user',
        id: owner.userid,
        userid: owner.userid,
        isnew: 0,
        fname: owner.fname,
        lname: owner.lname,
        email: owner.email,
        company: owner.company,
        username: 'sydney.system',
        remoteid: 'REMOTE-1',
        ispublic: 0,
        s2: 0,
        siteid: TENANT_A.siteId,
      });
      expect(data).not.toHaveProperty('password');
      expect((data.links as Record<string, string>).self).toContain(`/_api/json/v1/${TENANT_A.siteId}/user/${owner.userid}`);
    });

    it.each([
      ['a super user', s2OnTenantA],
      ['a Users module user', MODULE_USER_A],
    ])("reads the memberships of a user for %s in readMembershipIDs' group-name order, without a dangling id", async (_name, actor) => {
      ctx.identity.seedGroups(ZULU_GROUP, ALPHA_GROUP);
      ctx.identity.seedMemberships(owner.userid, [GROUP_ID, ZULU_GROUP.UserID, ALPHA_GROUP.UserID]);
      const data = dataOf(await send(ctx.app, 'GET', apiPath(family, `/user/${owner.userid}`), await actorHeaders(actor)));
      expect(data).toMatchObject({ userid: owner.userid, groupid: `${ALPHA_GROUP.UserID},${ZULU_GROUP.UserID}` });
      expect((data.links as Record<string, string>).edit).toContain('muraAction=cusers.edituser');
      expect(operationIds(ctx.identity)).toContain('getAccountMemberships');
    });

    it('reads a user through the method form the contract lists', async () => {
      const url = apiPath(family, `?method=findOne&entityname=user&id=${owner.userid}`);
      const envelope = legacyEnvelope(await send(ctx.app, 'GET', url, await actorHeaders(SITE_ADMIN_A)), 200);
      expect(envelope).toMatchObject({ method: 'findOne', data: { userid: owner.userid } });
    });

    it('queries users with fields and paging', async () => {
      const url = apiPath(family, '/user?isPublic=0&fields=fname,lname&itemsPerPage=2&pageIndex=2');
      const envelope = legacyEnvelope(await send(ctx.app, 'GET', url, await actorHeaders(SITE_ADMIN_A)), 200);
      expect(envelope.method).toBe('findQuery');
      const page = envelope.data as unknown as Collection;
      expect(page).toMatchObject({ entityname: 'user', totalitems: privateUsers, totalpages: Math.ceil(privateUsers / 2), pageindex: 2, itemsperpage: 2 });
      expect(page.items).toHaveLength(2);
      for (const item of page.items) {
        expect(Object.keys(item)).toEqual(expect.arrayContaining(['fname', 'lname']));
        expect(item).not.toHaveProperty('email');
      }
      expect(page.links).toHaveProperty('previous');
      expect(page.links).toHaveProperty('next');
    });

    it('queries users by email', async () => {
      const page = dataOf(await send(ctx.app, 'GET', apiPath(family, `/user?email=${owner.email ?? ''}`), await actorHeaders(SITE_ADMIN_A))) as unknown as Collection;
      expect(page.totalitems).toBe(1);
      expect(page.items.map((item) => item.userid)).toEqual([owner.userid]);
    });

    it('finds many public users in the order of the ids', async () => {
      const ids = publicMembers.map((person) => person.userid).reverse();
      const url = apiPath(family, `?method=findMany&entityname=user&ids=${ids.join(',')}`);
      const envelope = legacyEnvelope(await send(ctx.app, 'GET', url, await actorHeaders(SITE_ADMIN_A)), 200);
      expect(envelope.method).toBe('findMany');
      expect((envelope.data as unknown as Collection).items.map((item) => item.userid)).toEqual(ids);
    });

    it('reads an address of a user', async () => {
      const data = dataOf(await send(ctx.app, 'GET', apiPath(family, `/address/${ownerHome?.addressid ?? ''}`), await actorHeaders(SITE_ADMIN_A)));
      expect(data).toMatchObject({ entityname: 'address', addressid: ownerHome?.addressid, userid: owner.userid, addressname: ownerHome?.addressname, city: ownerHome?.city });
      expect((data.links as Record<string, string>).user).toContain(`/user/${owner.userid}`);
    });

    it('finds the addresses of a user', async () => {
      const ids = [ownerHome?.addressid, ownerWork?.addressid].map(String);
      const url = apiPath(family, `?method=findMany&entityname=address&ids=${ids.join(',')}`);
      const page = dataOf(await send(ctx.app, 'GET', url, await actorHeaders(SITE_ADMIN_A))) as unknown as Collection;
      expect(page.entityname).toBe('address');
      expect(page.items.map((item) => item.addressid)).toEqual(ids);
      expect(page.items.every((item) => item.userid === owner.userid)).toBe(true);
    });

    it("finds a pooled member stored in umbrella through tenant-a's public pool", async () => {
      const user = dataOf(await send(ctx.app, 'GET', apiPath(family, `/user/${pooled.userid}`), await actorHeaders(SITE_ADMIN_A)));
      expect(user).toMatchObject({ userid: pooled.userid, isnew: 0, siteid: TENANT_UMBRELLA.siteId, fname: pooled.fname, ispublic: 1 });
      const page = dataOf(await send(ctx.app, 'GET', apiPath(family, `/user?isPublic=1&email=${pooled.email ?? ''}`), await actorHeaders(SITE_ADMIN_A))) as unknown as Collection;
      expect(page.items.map((item) => item.userid)).toEqual([pooled.userid]);
      const address = dataOf(await send(ctx.app, 'GET', apiPath(family, `/address/${pooledHome?.addressid ?? ''}`), await actorHeaders(SITE_ADMIN_A)));
      expect(address).toMatchObject({ addressid: pooledHome?.addressid, userid: pooled.userid, isnew: 0 });
    });
  });

  describe('feeds', () => {
    const headers = (): Promise<Record<string, string>> => actorHeaders(SITE_ADMIN_A);
    const userIdsOf = (page: Collection): string[] => page.items.map((item) => String(item.userid));

    it("lists the site's public users through findAll and refuses an address feed", async () => {
      const envelope = legacyEnvelope(await send(ctx.app, 'GET', apiPath('json', '?method=findAll&entityname=user'), await headers()), 200);
      expect(envelope.method).toBe('findAll');
      const umbrella = umbrellaPersons.map((person) => person.userid);
      expect(userIdsOf(envelope.data as unknown as Collection).sort()).toEqual([...umbrella].sort());
      legacyError(await send(ctx.app, 'GET', apiPath('json', '?method=findAll&entityname=address'), await headers()), 'server_error', 503);
    });

    it.each([
      ['an or relationship', `lname=${owner.lname ?? ''}&or&fname=${seededPerson(SITE_ADMIN_A.sub).fname ?? ''}`, [owner.userid, SITE_ADMIN_A.sub]],
      ['a condition prefix', `lname=eq^${owner.lname ?? ''}`, [owner.userid]],
      ['a url-encoded param name', `%6Cname=${owner.lname ?? ''}`, [owner.userid]],
      ['an inert feed setter', `errors=x&email=${owner.email ?? ''}`, [owner.userid]],
      ['names CFML cannot hold, which the scan drops', `1lname=x&url.lname=x&lname=${owner.lname ?? ''}`, [owner.userid]],
    ])('queries users with %s', async (_name, query, expected) => {
      const page = dataOf(await send(ctx.app, 'GET', apiPath('json', `/user?${query}`), await headers())) as unknown as Collection;
      expect(userIdsOf(page).sort()).toEqual([...expected].sort());
    });

    it.each([
      ['every row on one page', 'itemsPerPage=*', { pageindex: 1, itemsperpage: privateUsers }, privateUsers],
      ['a zero page size as every row', 'itemsPerPage=0', { pageindex: 1, itemsperpage: privateUsers }, privateUsers],
      ['an out-of-range page as the first', 'itemsPerPage=2&pageIndex=99', { pageindex: 1, itemsperpage: 2 }, 2],
      ['the nextN setter', 'nextN=3', { pageindex: 1, itemsperpage: 3 }, 3],
    ])('pages a user query by %s', async (_name, query, expected, items) => {
      const page = dataOf(await send(ctx.app, 'GET', apiPath('json', `/user?isPublic=0&${query}`), await headers())) as unknown as Collection;
      expect(page).toMatchObject({ totalitems: privateUsers, ...expected });
      expect(page.items).toHaveLength(items);
    });

    it.each([
      // findQuery reads startIndex and limit as column criteria; the feed methods read them as iterator and feed properties.
      ['the page of a start index', 'itemsPerPage=2&startIndex=3', { totalitems: publicUsers, pageindex: 2, itemsperpage: 2 }, 1],
      ['a limit', 'limit=2', { totalitems: 2 }, 2],
    ])('pages findAll by %s', async (_name, query, expected, items) => {
      const page = dataOf(await send(ctx.app, 'GET', apiPath('json', `?method=findAll&entityname=user&${query}`), await headers())) as unknown as Collection;
      expect(page).toMatchObject(expected);
      expect(page.items).toHaveLength(items);
    });

    it.each([
      ['a failing feed setter', 'user', 'params=x', 500],
      ['a fractional limit', 'user', 'limit=1.5', 500],
      ['an orderby setter, which has no target ordering', 'user', 'orderBy=lname', 503],
      ['an address query, which includes group addresses', 'address', 'city=Springfield', 503],
    ] as const)('answers a query with %s as server_error', async (_name, entity, query, status) => {
      legacyError(await send(ctx.app, 'GET', apiPath('json', `/${entity}?isPublic=0&${query}`), await headers()), 'server_error', status);
    });

    it("lists each user's groups as findOne reads them, in readMembershipIDs' group-name order without a dangling id", async () => {
      const mike: DoubleGroup = { ...ZULU_GROUP, UserID: '5A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9', GroupName: 'Mike' };
      ctx.identity.seedGroups(ZULU_GROUP, ALPHA_GROUP, mike);
      const held: Array<[string, string[], string]> = [
        [owner.userid, [ZULU_GROUP.UserID, GROUP_ID, ALPHA_GROUP.UserID, mike.UserID], `${ALPHA_GROUP.UserID},${mike.UserID},${ZULU_GROUP.UserID}`],
        [SITE_ADMIN_A.sub, [mike.UserID, ZULU_GROUP.UserID], `${mike.UserID},${ZULU_GROUP.UserID}`],
        [MODULE_USER_A.sub, [GROUP_ID], ''],
      ];
      for (const [userId, groupIds] of held) ctx.identity.seedMemberships(userId, groupIds);
      const page = dataOf(await send(ctx.app, 'GET', apiPath('json', '/user?isPublic=0&itemsPerPage=*'), await headers())) as unknown as Collection;

      expect(operationIds(ctx.identity)).toContain('lookupMemberships');
      for (const [userId, , groupId] of held) {
        expect(page.items.find((item) => item.userid === userId)?.groupid).toBe(groupId);
        expect(dataOf(await send(ctx.app, 'GET', apiPath('json', `/user/${userId}`), await headers())).groupid).toBe(groupId);
      }
    });

    it("queries the members of a group through identity's memberships", async () => {
      ctx.identity.seedMemberships(owner.userid, [GROUP_ID]);
      const page = dataOf(await send(ctx.app, 'GET', apiPath('json', `/user?isPublic=0&groupid=${GROUP_ID}`), await headers())) as unknown as Collection;
      expect(userIdsOf(page)).toEqual([owner.userid]);
    });

    it('includes the addresses query when a field names it', async () => {
      const page = dataOf(await send(ctx.app, 'GET', apiPath('json', `/user?fields=userid,addresses&email=${owner.email ?? ''}`), await headers())) as unknown as Collection;
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toHaveProperty('addresses');
    });

    it('keeps every request param in the self link of a findMany page', async () => {
      const extra = Array.from({ length: 14 }, (_, index) => `p${String(index).padStart(2, '0')}=v${String(index)}`);
      const url = apiPath('json', `?method=findMany&entityname=user&ids=${pooled.userid}&${extra.join('&')}`);
      const page = dataOf(await send(ctx.app, 'GET', url, await headers())) as unknown as Collection;
      expect(userIdsOf(page)).toEqual([pooled.userid]);
      for (const pair of extra) expect(page.links.self).toContain(`&${pair}`);
    });

    // Root start-up's Portcullis scan trims and filters url and form before processRequest reads them [legacy: core/appcfc/scriptProtect_include.cfm:4-20].
    it.each([
      ['the url', 'GET', true],
      ['a form', 'POST', false],
    ] as const)('reads padded and script-bearing findMany params %s carries as the start-up scan leaves them', async (_name, method, inUrl) => {
      const sent = { ids: ` ${pooled.userid} `, note: '  <script>alert(1)</script>kept  ' };
      const query = `?method=findMany&entityname=user${inUrl ? `&${new URLSearchParams(sent).toString()}` : ''}`;
      const page = dataOf(await send(ctx.app, method, apiPath('json', query), await headers(), inUrl ? undefined : sent)) as unknown as Collection;
      expect(userIdsOf(page)).toEqual([pooled.userid]);
      expect(page.links.self).toContain(`&ids=${pooled.userid}&`);
      expect(page.links.self).toContain('&note=[INVALID]kept&');
    });

    // Start-up decides a reload on the url as sent; its scan then copies the name onto the reload key, which processRequest deletes
    // [legacy: core/appcfc/onRequestStart_include.cfm:114-138, core/mura/client/api/json/v1/jsonApiUtility.cfc:403].
    it.each([
      ['a name the scan strips to it', `${RELOAD_KEY.slice(0, 1)}-${RELOAD_KEY.slice(1)}`],
      ['a name the scan renames to it', `amp;${RELOAD_KEY}`],
    ])('serves findMany, never a reload, for the reload key %s', async (_name, sent) => {
      const url = apiPath('json', `?${encodeURIComponent(sent)}=1&method=findMany&entityname=user&ids=${pooled.userid}`);
      const page = dataOf(await send(ctx.app, 'GET', url, await headers())) as unknown as Collection;
      expect(userIdsOf(page)).toEqual([pooled.userid]);
      expect(page.links.self?.toLowerCase()).not.toContain(`&${RELOAD_KEY.toLowerCase()}=`);
    });

    // Oracle: ColdFusion joins url names differing only in case, in sent order (`q=1&Q=2` reads `q` as `1,2`).
    it('finds many by ids spelled in several cases, joined in sent order', async () => {
      const [first, second, third] = umbrellaPersons.map((person) => person.userid);
      const url = apiPath('json', `?method=findMany&entityname=user&ids=${first ?? ''}&IDS=${second ?? ''}&ids=${third ?? ''}`);
      const page = dataOf(await send(ctx.app, 'GET', url, await headers())) as unknown as Collection;
      expect(userIdsOf(page)).toEqual([first, second, third]);
    });

    it('answers findMany without ids with server_error', async () => {
      legacyError(await send(ctx.app, 'GET', apiPath('json', '?method=findMany&entityname=user'), await headers()), 'server_error');
    });

    it("finds only the site's addresses, and refuses an id people holds no address for", async () => {
      const ids = [ownerHome?.addressid, pooledHome?.addressid].map(String);
      const page = dataOf(await send(ctx.app, 'GET', apiPath('json', `?method=findMany&entityname=address&ids=${ids.join(',')}`), await headers())) as unknown as Collection;
      expect(page.items.map((item) => item.addressid)).toEqual([ownerHome?.addressid]);
      const unknown = apiPath('json', `?method=findMany&entityname=address&ids=${GROUP_ID}`);
      legacyError(await send(ctx.app, 'GET', unknown, await headers()), 'server_error', 503);
    });
  });

  describe('read refusals', () => {
    it.each([
      ['the site relation of an address, which is programs-sites data', `/address/${ownerHome?.addressid ?? ''}?expand=site`],
      ['the ishuman field, which renders a CFML display object', `/user/${owner.userid}?ishuman=1`],
    ])('answers %s with the legacy 503', async (_name, rest) => {
      legacyError(await send(ctx.app, 'GET', apiPath('json', rest), await actorHeaders(SITE_ADMIN_A)), 'server_error', 503);
    });

    it('reads a person identity holds no account for as a new bean', async () => {
      ctx.identity.clear();
      const data = dataOf(await send(ctx.app, 'GET', apiPath('json', `/user/${owner.userid}`), await actorHeaders(SITE_ADMIN_A)));
      expect(data).toMatchObject({ isnew: 1, fname: '' });
      expect(data.userid).not.toBe(owner.userid);
    });

    it('fails closed with the legacy 503 while identity is unreachable', async () => {
      ctx.identity.setUnreachable(true);
      legacyError(await send(ctx.app, 'GET', apiPath('json', `/user/${owner.userid}`), await actorHeaders(SITE_ADMIN_A)), 'server_error', 503);
    });
  });

  describe('withheld saves and deletes', () => {
    const tenants = [TENANT_A.tenantId, TENANT_UMBRELLA.tenantId];

    /** The person, address and roster operation rows of the user tenants a tenant-a save reaches, which a withheld branch leaves as they are. */
    async function userRows(): Promise<Record<string, unknown>[][]> {
      const { schema } = ctx.schema;
      const reads = tenants.map((tenantId) =>
        ctx.db.withTenant(tenantId, async (tx) => [
          ...(await tx.query<Record<string, unknown>>(`SELECT userid, fname, lname, email, row_version FROM ${schema}.person ORDER BY userid`)).rows,
          ...(await tx.query<Record<string, unknown>>(`SELECT addressid, userid, addressname, city FROM ${schema}.user_address ORDER BY addressid`)).rows,
          ...(await tx.query<Record<string, unknown>>(`SELECT operation_id, user_id, state FROM ${schema}.roster_operation ORDER BY operation_id`)).rows,
        ]),
      );
      return Promise.all(reads);
    }

    type Ids = { userId: string; addressId: string };
    const userForm = ({ userId }: Ids, extra: Record<string, string> = {}): Record<string, string> => ({ userid: userId, fname: 'Withheld', lname: 'Save', email: 'withheld@tenant-a.opt2.test', ...extra });
    const addressForm = ({ userId, addressId }: Ids, extra: Record<string, string> = {}): Record<string, string> => ({ addressid: addressId, userid: userId, addressname: 'Withheld', city: 'Nowhere', ...extra });

    it.each<[string, LegacyErrorType, number, Family, Method, (ids: Ids) => string, (ids: Ids) => Record<string, string>]>([
      ['a user save on the entity route by POST', 'server_error', 503, 'json', 'POST', ({ userId }) => `/user/${userId}`, (ids) => userForm(ids)],
      ['a user save on the entity route by PUT', 'server_error', 503, 'ajax', 'PUT', ({ userId }) => `/user/${userId}`, (ids) => userForm(ids)],
      ['a user create on the entity route', 'server_error', 503, 'json', 'POST', () => '/user', () => ({ fname: 'New', lname: 'Person', email: 'new_person@tenant-a.opt2.test', username: 'new_person', isPublic: '0' })],
      ['a direct method=save of a user', 'server_error', 503, 'json', 'POST', () => '?method=save&entityname=user', (ids) => userForm(ids)],
      ['a dotted user.save, which legacy resolves to no save', 'invalidMethodCall', 400, 'ajax', 'POST', () => '?method=user.save', (ids) => userForm(ids)],
      ['a user save setting a photo', 'server_error', 503, 'json', 'POST', ({ userId }) => `/user/${userId}`, (ids) => userForm(ids, { newFile: 'portrait.jpg' })],
      ['a user save removing the photo', 'server_error', 503, 'json', 'POST', ({ userId }) => `/user/${userId}`, (ids) => userForm(ids, { removePhotoFile: 'true' })],
      ['a user save posting an extendSetID', 'server_error', 503, 'json', 'POST', ({ userId }) => `/user/${userId}`, (ids) => userForm(ids, { extendSetID: 'SET-1' })],
      ['a REST user save on the entity route by PUT', 'server_error', 503, 'rest', 'PUT', ({ userId }) => `/user/${userId}`, (ids) => userForm(ids)],
      ['a REST user save carrying a siteid', 'server_error', 503, 'rest', 'POST', ({ userId }) => `/user/${userId}`, (ids) => userForm(ids, { siteid: TENANT_A.siteId })],
      ['an address save on the entity route by POST', 'server_error', 503, 'json', 'POST', () => '/address', (ids) => addressForm(ids)],
      ['an address save on the entity route by PUT', 'server_error', 503, 'ajax', 'PUT', ({ addressId }) => `/address/${addressId}`, (ids) => addressForm(ids)],
      ['a direct method=save of an address', 'server_error', 503, 'json', 'POST', () => '?method=save&entityname=address', (ids) => addressForm(ids)],
      ['a dotted address.save, which legacy resolves to no save', 'invalidMethodCall', 400, 'json', 'POST', () => '?method=address.save', (ids) => addressForm(ids)],
      ['an address save posting an empty extendSetID', 'server_error', 503, 'json', 'POST', ({ addressId }) => `/address/${addressId}`, (ids) => addressForm(ids, { extendSetID: '' })],
      ['a REST address save on the entity route by POST', 'server_error', 503, 'rest', 'POST', () => '/address', (ids) => addressForm(ids)],
    ])('answers %s with the legacy %s %i, consuming no CSRF token, calling no identity operation and writing no row', async (_label, type, status, family, method, rest, form) => {
      const address = await ownAddress();
      const ids = { userId: address.userid ?? '', addressId: address.addressid };
      const before = await userRows();
      const calls = ctx.identity.requests.length;
      const res = await send(ctx.app, method, apiPath(family, rest(ids)), { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF }, form(ids));
      legacyError(res, type, status);
      expect(ctx.identity.csrf.consumed()).toEqual([]);
      expect(ctx.identity.requests.slice(calls)).toEqual([]);
      expect(ctx.identity.operations.size).toBe(0);
      expect(await userRows()).toEqual(before);
    });

    it('withholds an address delete, leaving the address stored', async () => {
      const addressId = (await ownAddress()).addressid;
      const res = await send(ctx.app, 'DELETE', apiPath('json', `/address/${addressId}`), { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF });
      legacyError(res, 'server_error', 503);
      expect(ctx.identity.csrf.consumed()).toEqual([]);
      const read = dataOf(await send(ctx.app, 'GET', apiPath('json', `/address/${addressId}`), await actorHeaders(SITE_ADMIN_A)));
      expect(read).toMatchObject({ addressid: addressId, isnew: 0 });
    });
  });
});
