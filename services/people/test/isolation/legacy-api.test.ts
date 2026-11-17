/** People's JSON API `user` and `address` reads and roster-protocol saves through `app.inject` over a throwaway `people` schema. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
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
  TOKEN,
  TOKEN_EXPIRES,
  actorHeaders,
  apiPath,
  csrfHeaders,
  dataOf,
  legacyEnvelope,
  legacyError,
  operationIds,
  rosterSteps,
  send,
  sessionOf,
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

describe.skipIf(!PG_AVAILABLE)('JSON API reads and saves over PostgreSQL', () => {
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

  /** A tenant-a person row of the throwaway schema. */
  async function storedPerson(userId: string): Promise<Record<string, unknown> | undefined> {
    const { rows } = await ctx.db.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query<Record<string, unknown>>(`SELECT userid, fname, lname, email FROM ${ctx.schema.schema}.person WHERE userid = $1`, [userId]),
    );
    return rows[0];
  }

  /** People's recorded roster operations of `userId` in tenant-a. */
  async function rosterOperations(userId: string): Promise<Array<{ kind: string; state: string }>> {
    const { rows } = await ctx.db.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query<{ kind: string; state: string }>(`SELECT kind, state FROM ${ctx.schema.schema}.roster_operation WHERE user_id = $1`, [userId]),
    );
    return rows;
  }

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

  describe('user saves', () => {
    it('creates a user as a site administrator under the roster protocol', async () => {
      const form = { fname: 'New', lname: 'Person', email: 'new_person@tenant-a.opt2.test', username: 'new_person', isPublic: '0', groupname: 'admin' };
      const res = await send(ctx.app, 'POST', apiPath('json', '/user'), { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF }, form);
      const data = dataOf(res);
      const userId = String(data.userid);
      expect(isCfUuid(userId)).toBe(true);
      // A posted `admin` group name is dropped, as legacy drops it.
      expect(data).toMatchObject({ fname: 'New', lname: 'Person', email: form.email, username: 'new_person', groupname: '', errors: {} });
      expect(data.saveerrors).toBeFalsy();
      expect(rosterSteps(ctx.identity)).toEqual(['prepareAccountOperation', 'commitAccountOperation', 'finishAccountOperation']);
      const [operation] = [...ctx.identity.operations.values()];
      expect(operation).toMatchObject({ userId, kind: 'create', state: 'finished' });
      expect(operation?.commitRequest?.sessionEffects).toBeUndefined();
      expect(await rosterOperations(userId)).toEqual([{ kind: 'json-save', state: 'done' }]);
      expect(await storedPerson(userId)).toMatchObject({ fname: 'New', lname: 'Person', email: form.email });
      expect(ctx.identity.csrf.consumed().map(({ request }) => request.context)).toEqual(['new']);
    });

    it('updates a user addressed by the id path value, consuming the token for that id', async () => {
      const person = await ownPerson();
      const form = { fname: 'Cassidy', lname: person.lname ?? '', email: person.email ?? '', company: 'Updated Co' };
      const res = await send(ctx.app, 'POST', apiPath('json', `/user/${person.userid}`), { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF }, form);
      expect(dataOf(res)).toMatchObject({ userid: person.userid, fname: 'Cassidy', company: 'Updated Co', isnew: 0, errors: {} });
      expect(rosterSteps(ctx.identity)).toEqual(['prepareAccountOperation', 'commitAccountOperation', 'finishAccountOperation']);
      const [operation] = [...ctx.identity.operations.values()];
      expect(operation).toMatchObject({ userId: person.userid, kind: 'update', state: 'finished' });
      // An administrator saving another user is not logged in again.
      expect(operation?.commitRequest?.sessionEffects).toBeUndefined();
      expect(await rosterOperations(person.userid)).toEqual([{ kind: 'json-save', state: 'done' }]);
      expect(await storedPerson(person.userid)).toMatchObject({ fname: 'Cassidy' });
      expect(ctx.identity.csrf.consumed()).toEqual([
        { request: { sessionId: sessionOf(SITE_ADMIN_A), token: TOKEN, expires: TOKEN_EXPIRES, context: person.userid }, valid: true },
      ]);
    });

    it('answers 403 with the email error when a save carries no email, committing nothing', async () => {
      const form = { fname: 'No', lname: 'Email', username: 'no_email', isPublic: '0' };
      const res = await send(ctx.app, 'POST', apiPath('json', '/user'), { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF }, form);
      const data = dataOf(res, 403);
      expect(data.errors).toHaveProperty('email');
      expect(rosterSteps(ctx.identity)).not.toContain('commitAccountOperation');
      expect([...ctx.identity.operations.values()].filter((operation) => operation.state === 'committed' || operation.state === 'finished')).toEqual([]);
      expect(await storedPerson(String(data.userid))).toBeUndefined();
    });

    it('lets a system user without the Users module save their own record, keeping its groups in group-name order, and logs it in again at commit', async () => {
      const person = await ownPerson();
      // SYSTEM_USER_A's claims, as the case's own person.
      const self: TestActor = { ...SYSTEM_USER_A, sub: person.userid };
      ctx.identity.seedGroups(ZULU_GROUP, ALPHA_GROUP);
      ctx.identity.seedMemberships(person.userid, [ZULU_GROUP.UserID, ALPHA_GROUP.UserID]);
      const form = { fname: 'Sid', lname: person.lname ?? '', email: person.email ?? '' };
      const res = await send(ctx.app, 'POST', apiPath('json', `/user/${person.userid}`), { ...(await actorHeaders(self)), ...CSRF }, form);
      expect(dataOf(res)).toMatchObject({ userid: person.userid, fname: 'Sid', groupid: `${ALPHA_GROUP.UserID},${ZULU_GROUP.UserID}`, errors: {} });
      expect(await storedPerson(person.userid)).toMatchObject({ fname: 'Sid' });
      expect(operationIds(ctx.identity)).not.toContain('listUserMemberships');
      const [operation] = [...ctx.identity.operations.values()];
      expect(operation?.state).toBe('finished');
      expect(operation?.commitRequest?.sessionEffects).toMatchObject({ reloginSessionId: sessionOf(self), person: { fname: 'Sid', lname: person.lname } });
      expect(ctx.identity.csrf.consumed().map(({ request }) => request.context)).toEqual([person.userid]);
    });
  });

  describe('address saves', () => {
    it('adds and updates an address, consuming the token for the id path value', async () => {
      const person = await ownPerson();
      const user = await actorHeaders(SITE_ADMIN_A);
      const created = dataOf(
        await send(ctx.app, 'POST', apiPath('json', '/address'), { ...user, ...CSRF }, { userid: person.userid, addressname: 'Cabin', city: 'Bergen' }),
      );
      const addressId = String(created.addressid);
      expect(isCfUuid(addressId)).toBe(true);
      expect(created).toMatchObject({ entityname: 'address', userid: person.userid, addressname: 'Cabin', city: 'Bergen', errors: {} });
      const updated = await send(ctx.app, 'PUT', apiPath('json', `/address/${addressId}`), { ...user, ...csrfHeaders(`${TOKEN}-2`) }, {
        userid: person.userid,
        addressname: 'Cabin',
        city: 'Tromso',
      });
      expect(dataOf(updated)).toMatchObject({ addressid: addressId, city: 'Tromso' });
      expect(ctx.identity.csrf.consumed().map(({ request }) => request.context)).toEqual(['new', addressId]);
      const read = dataOf(await send(ctx.app, 'GET', apiPath('json', `/address/${addressId}`), await actorHeaders(SITE_ADMIN_A)));
      expect(read).toMatchObject({ addressid: addressId, city: 'Tromso', isnew: 0 });
      expect(rosterSteps(ctx.identity)).toEqual([]);
    });

    it("refuses an address of a user people holds no person for, such as a group's, with the legacy 503", async () => {
      const res = await send(ctx.app, 'POST', apiPath('json', '/address'), { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF }, { userid: GROUP_ID, addressname: 'Depot' });
      legacyError(res, 'server_error', 503);
      expect(rosterSteps(ctx.identity)).toEqual([]);
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
