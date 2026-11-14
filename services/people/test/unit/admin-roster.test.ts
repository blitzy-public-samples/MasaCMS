/** The cUsers roster writes through `app.inject` with the identity double: `cUsers.update` Type=2 Add and Update, `cUsers.updateAddress`, and the withheld branches. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, adminUrl, cfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_A, assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { PG_AVAILABLE, TEST_CLOCK, buildTestApp, userHeaders, withPgApp, type PgTestApp, type TestApp } from '../helpers/app.js';
import { createIdentityDouble, type IdentityDouble } from '../helpers/identity-double.js';
import {
  ADMIN_S2,
  DEFAULT_PEOPLE_SEED,
  MODULE_008_ONLY,
  MODULE_USER_A,
  S2_USER,
  SITE_ADMIN_A,
  SYSTEM_USER_A_PERSON,
  accountFor,
  accountsForSeed,
  personRow,
  seedPeople,
  type TestActor,
} from '../helpers/fixtures.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };

/** The contract path declaring `operationId`, which `app.inject` addresses. */
function pathOf(operationId: string): string {
  const found = Object.entries(OPENAPI.paths).find(([, item]) =>
    Object.values(item).some((operation) => (operation as { operationId?: unknown } | null)?.operationId === operationId),
  );
  if (found === undefined) throw new Error(`The people contract declares no ${operationId}`);
  return found[0];
}

const UPDATE_USER = pathOf('updateUser');
const UPDATE_ADDRESS = pathOf('updateAddress');
const SITE = TENANT_A.siteId;
const TOKEN = 'ROSTER-TOKEN';
const EXPIRES = '260630130000000';
const SEED_ACCOUNTS = accountsForSeed(DEFAULT_PEOPLE_SEED);
const STORED_USER = SYSTEM_USER_A_PERSON.userid;
const [CATEGORY_1, CATEGORY_2, CATEGORY_3] = [cfUuid(), cfUuid(), cfUuid()] as const;
const GROUP = cfUuid();
const USERNAME_TAKEN = "The username 'robin.roster' that you entered is being used by another user.";
/** The installed super-user working in tenant-a's admin. */
const S2_ON_A: TestActor = Object.freeze({ ...ADMIN_S2, site: SITE });
/** A tenant-a super user, stored in tenant-a's private pool. */
const S2_TARGET = personRow({ siteid: SITE, fname: 'Root', lname: 'Super', email: 'root.super@tenant-a.opt2.test' });
const S2_TARGET_ACCOUNT = accountFor(S2_TARGET, { s2: 1, username: 'root.super' });
/** The legacy-shaped 503 body: a withheld branch, or a save people cannot place. */
const LEGACY_503 = { apiversion: 'v1', error: { message: 'Unhandled Exception', code: 'server_error' } };
const EDIT_PROFILE_URL = adminUrl({ circuit: 'cEditProfile', action: 'edit' });
/** The account-operation steps people asks identity for, by contract operation id. */
const ACCOUNT_STEPS: ReadonlyMap<string, string> = new Map([
  ['prepareAccountOperation', 'prepare'],
  ['commitAccountOperation', 'commit'],
  ['abortAccountOperation', 'abort'],
  ['finishAccountOperation', 'finish'],
  ['revertAccountOperation', 'revert'],
]);

type Redirect = { action: string; params: Record<string, string> } | { url: string };
interface UpdateResult {
  written: boolean;
  redirect?: Redirect;
  errors: Record<string, string>;
  userBean?: Record<string, unknown>;
}
interface RouteResult {
  written?: boolean;
  redirect: Redirect;
}

/** A file part of a multipart post. */
interface FilePart {
  field: string;
  filename: string;
}

/** What one post sends: form fields as web relays them, the form action's query, and file parts for a multipart body. */
interface Post {
  fields: Record<string, string>;
  query?: Record<string, string>;
  files?: readonly FilePart[];
  /** Leaves out the CSRF pair the form renders. */
  withoutToken?: boolean;
}

/** A multipart body of `fields` and `files`; a part with a file name carries a few stand-in bytes, one without none. */
function multipart(fields: Record<string, string>, files: readonly FilePart[]): { payload: string; contentType: string } {
  const boundary = 'opt2-roster-boundary';
  const parts = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  for (const { field, filename } of files) {
    const content = filename === '' ? '' : 'PNG';
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n${content}\r\n`);
  }
  return { payload: `${parts.join('')}--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Posts `post` to `path` as `actor` through the gateway, checks the answer against the contract and returns status and body. */
async function send<B>(app: TestApp['app'], path: string, actor: TestActor, post: Post): Promise<{ status: number; body: B }> {
  const fields = post.withoutToken === true ? post.fields : { ...post.fields, [CSRF_FIELD_TOKEN]: TOKEN, [CSRF_FIELD_EXPIRES]: EXPIRES };
  const search = new URLSearchParams(post.query ?? {}).toString();
  const url = search === '' ? path : `${path}?${search}`;
  const body = post.files === undefined ? { payload: new URLSearchParams(fields).toString(), contentType: 'application/x-www-form-urlencoded' } : multipart(fields, post.files);
  const res = await app.inject({ method: 'POST', url, headers: { ...(await userHeaders(actor)), 'content-type': body.contentType }, payload: body.payload });
  const validated = assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return { status: res.statusCode, body: validated as B };
}

/** The admin URL web renders for `redirect`, its parameters in the order the route gives them. */
function rendered(redirect: Redirect | undefined): string | undefined {
  if (redirect === undefined) return undefined;
  if ('url' in redirect) return redirect.url;
  const [circuit = '', action = ''] = redirect.action.split('.');
  return adminUrl({ circuit, action, params: Object.entries(redirect.params) });
}

/** The account-operation steps identity received, each with the operation id of its path. */
function accountSteps(identity: IdentityDouble): Array<[step: string, operationId: string]> {
  return identity.requests.flatMap((request): Array<[string, string]> => {
    const step = request.operationId === undefined ? undefined : ACCOUNT_STEPS.get(request.operationId);
    if (step === undefined) return [];
    return [[step, decodeURIComponent(/\/operations\/([^/:]+):/.exec(request.path)?.[1] ?? '')]];
  });
}

/** The CSRF contexts identity was asked to consume, with its verdicts. */
function csrfContexts(identity: IdentityDouble): Array<[context: string, valid: boolean]> {
  return identity.csrf.consumed().map(({ request, valid }) => [request.context, valid]);
}

/** `fields` without `names`, as a form posts when those inputs are disabled or absent. */
function without(fields: Record<string, string>, ...names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([name]) => !names.includes(name)));
}

/** The edit-user form of a Type=2 save as `edituser.cfm` posts it once its script has run. */
function userForm(action: 'Add' | 'Update' | 'Delete', fields: Record<string, string> = {}): Record<string, string> {
  return {
    type: '2',
    action,
    contact: '0',
    groupid: '',
    ContactForm: '',
    returnurl: '',
    subtype: 'Default',
    siteid: SITE,
    isPublic: '0',
    InActive: '0',
    fname: 'Robin',
    lname: 'Roster',
    email: 'robin.roster@tenant-a.opt2.test',
    company: 'Acme',
    jobtitle: 'Analyst',
    mobilePhone: '555-0177',
    usernameNoCache: 'robin.roster',
    passwordNoCache: 'Roster#2026',
    password2: 'Roster#2026',
    tags: 'alpha,gamma',
    categoryid: `${CATEGORY_1},${CATEGORY_2}`,
    address1: '9 Harbour Road',
    address2: '',
    city: 'Bergen',
    state: '',
    zip: '5003',
    country: 'Norway',
    phone: '555-0199',
    fax: '',
    addressEmail: 'robin@home.opt2.test',
    addressURL: '',
    hours: '',
    ...fields,
  };
}

/** The address form as `editaddress.cfm` posts it, the action set by its buttons. */
function addressForm(action: string, fields: Record<string, string> = {}): Record<string, string> {
  return {
    action,
    addressID: '',
    addressName: 'Cabin',
    address1: '1 Fjord Lane',
    address2: '',
    city: 'Voss',
    state: '',
    zip: '5700',
    country: 'Norway',
    phone: '',
    fax: '',
    addressURL: '',
    addressEmail: '',
    hours: '',
    isPrimary: '0',
    ...fields,
  };
}

/** The query `edituser.cfm` puts on its form action. */
function userQuery(userid: string, routeid = ''): Record<string, string> {
  return { userid, routeid };
}

/** The query `editaddress.cfm` puts on its form action. */
function addressQuery(userid: string, routeid = ''): Record<string, string> {
  return { userid, routeid, siteid: SITE };
}

/** `cUsers.edituser` preserving `siteid`, `userid` and `routeid`, as `updateAddress()` redirects. */
function editUserUrl(userid: string, routeid: string): string {
  return adminUrl({ circuit: 'cUsers', action: 'edituser', params: [['siteid', SITE], ['userid', userid], ['routeid', routeid]] });
}

/** A fresh identity double holding every seeded account and the S2 target's. */
function newIdentity(): IdentityDouble {
  return createIdentityDouble({ clock: TEST_CLOCK, accounts: [...SEED_ACCOUNTS, S2_TARGET_ACCOUNT] });
}

describe('cUsers roster writes people never executes', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp({ identity: newIdentity() });
  });

  afterAll(async () => {
    await testApp?.close();
  });

  beforeEach(() => {
    testApp.identity.clear();
    testApp.db.clear();
  });

  it.each<[string, Post]>([
    ['a photo upload', { fields: userForm('Update'), query: userQuery(STORED_USER), files: [{ field: 'newFile', filename: 'me.png' }] }],
    ['a new user with a photo', { fields: userForm('Add'), query: userQuery(''), files: [{ field: 'newFile', filename: 'me.jpg' }] }],
    ['a photo removal', { fields: userForm('Update', { removePhotoFile: 'true' }), query: userQuery(STORED_USER) }],
    ['a save naming neither a user nor a group', { fields: without(userForm('Update'), 'type'), query: userQuery(STORED_USER) }],
    ['a user delete', { fields: userForm('Delete'), query: userQuery(STORED_USER) }],
    ['the delete of an S2 user, which legacy voids for a caller without S2', { fields: userForm('Delete'), query: userQuery(S2_TARGET.userid) }],
    ['a group save', { fields: userForm('Update', { type: '1', groupname: 'Editors' }), query: userQuery(GROUP) }],
    ['a new group', { fields: userForm('Add', { type: '1', groupname: 'Editors' }), query: userQuery('') }],
    ['a group delete', { fields: userForm('Delete', { type: '1' }), query: userQuery(GROUP) }],
    ['extended attributes of a new user', { fields: userForm('Add', { extendSetID: cfUuid() }), query: userQuery('') }],
    ['extended attributes of an update', { fields: userForm('Update', { extendSetID: cfUuid() }), query: userQuery(STORED_USER) }],
  ])('answers %s with the legacy 503 before consuming the token', async (_name, post) => {
    const { status, body } = await send(testApp.app, UPDATE_USER, SITE_ADMIN_A, post);
    expect(status).toBe(503);
    expect(body).toMatchObject(LEGACY_503);
    expect(testApp.identity.requests).toEqual([]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it.each<[string, Record<string, string>]>([
    ['an address delete', addressForm('Delete', { addressID: cfUuid() })],
    ['extended attributes of an address', addressForm('Update', { addressID: cfUuid(), extendSetID: cfUuid() })],
    ['an address form holding an empty extended set', addressForm('Add', { extendSetID: '' })],
  ])('answers %s with the legacy 503 before consuming the token', async (_name, fields) => {
    const { status, body } = await send(testApp.app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields, query: addressQuery(STORED_USER) });
    expect(status).toBe(503);
    expect(body).toMatchObject(LEGACY_503);
    expect(testApp.identity.requests).toEqual([]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it.each<[string, string]>([
    ['a new user', ''],
    ['a new user under its generated id', cfUuid()],
    ['an update', STORED_USER],
  ])('fails %s whose token identity refuses as legacy fails on the unset user bean, writing nothing', async (_name, userid) => {
    testApp.identity.csrf.rejectAll();
    const { status } = await send(testApp.app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm(userid === STORED_USER ? 'Update' : 'Add'), query: userQuery(userid) });
    expect(status).toBe(500);
    expect(csrfContexts(testApp.identity)).toEqual([[userid, false]]);
    expect(accountSteps(testApp.identity)).toEqual([]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it('fails a user save without a token before asking identity', async () => {
    const { status } = await send(testApp.app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm('Update'), query: userQuery(STORED_USER), withoutToken: true });
    expect(status).toBe(500);
    expect(testApp.identity.requests).toEqual([]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it.each<[string, TestActor, string, string]>([
    ['the user edit screen', SITE_ADMIN_A, '', editUserUrl(STORED_USER, '')],
    ['the user edit screen of the group it came from', MODULE_USER_A, GROUP, editUserUrl(STORED_USER, GROUP)],
    ['the profile editor', SITE_ADMIN_A, 'editprofile', EDIT_PROFILE_URL],
    ['the profile editor, matched ignoring case', SITE_ADMIN_A, 'EditProfile', EDIT_PROFILE_URL],
  ])('writes no address under a refused token and still redirects to %s', async (_name, actor, routeid, expected) => {
    testApp.identity.csrf.rejectAll();
    const { status, body } = await send<RouteResult>(testApp.app, UPDATE_ADDRESS, actor, { fields: addressForm('Add'), query: addressQuery(STORED_USER, routeid) });
    expect(status).toBe(200);
    expect(body.written).toBe(false);
    expect(rendered(body.redirect)).toBe(expected);
    expect(csrfContexts(testApp.identity)).toEqual([[`updateaddress${STORED_USER}`, false]]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it.each<[string, string, Post]>([
    ['user', UPDATE_USER, { fields: userForm('Update'), query: userQuery(STORED_USER) }],
    ['address', UPDATE_ADDRESS, { fields: addressForm('Add'), query: addressQuery(STORED_USER) }],
  ])('refuses a %s save to a caller holding the Users module without Site Manager, before the token', async (_name, path, post) => {
    const { status } = await send(testApp.app, path, MODULE_008_ONLY, post);
    expect(status).toBe(403);
    expect(testApp.identity.requests).toEqual([]);
    expect(testApp.db.writes()).toEqual([]);
  });

  it.each<[string, Record<string, string>]>([
    ['an empty action', addressForm('')],
    ['no action', without(addressForm(''), 'action')],
  ])('writes nothing for an address save with %s and still redirects', async (_name, fields) => {
    const { body } = await send<RouteResult>(testApp.app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields, query: addressQuery(STORED_USER) });
    expect(body).toEqual({ written: false, redirect: { action: 'cUsers.edituser', params: { siteid: SITE, userid: STORED_USER, routeid: '' } } });
    expect(csrfContexts(testApp.identity)).toEqual([[`updateaddress${STORED_USER}`, true]]);
    expect(testApp.db.writes()).toEqual([]);
  });
});

describe.skipIf(!PG_AVAILABLE)('cUsers roster writes over PostgreSQL', () => {
  type PeopleDb = PgTestApp['db'];
  type PersonTable = 'person' | 'user_address' | 'user_interest' | 'user_tag';

  /** Runs `fn` against people over a fresh throwaway schema holding the fixture seed and the S2 target. */
  async function onPeople(fn: (pg: PgTestApp) => Promise<void>): Promise<void> {
    const outcome = await withPgApp(
      async (pg) => {
        await seedPeople(pg.db, DEFAULT_PEOPLE_SEED, { clock: TEST_CLOCK });
        await seedPeople(pg.db, { [TENANT_A.tenantId]: { persons: [S2_TARGET] } }, { clock: TEST_CLOCK });
        await fn(pg);
      },
      { identity: newIdentity() },
    );
    if (outcome !== undefined) throw new Error(outcome.reason);
  }

  /** The rows of `table` that belong to `userId` in tenant-a. */
  async function rowsOf(db: PeopleDb, table: PersonTable, userId: string): Promise<Record<string, unknown>[]> {
    return db.withTenant(TENANT_A.tenantId, async (tx) => (await tx.query(`SELECT * FROM ${tx.schema}.${table} WHERE userid = $1`, [userId])).rows);
  }

  /** The values of `column` over the rows of `table` that belong to `userId`, sorted. */
  async function columnOf(db: PeopleDb, table: PersonTable, column: string, userId: string): Promise<unknown[]> {
    return (await rowsOf(db, table, userId)).map((row) => row[column]).sort();
  }

  /** The payloads of the roster operations people recorded for `userId`. */
  async function rosterPayloads(db: PeopleDb, userId: string): Promise<string[]> {
    const rows = await db.withTenant(TENANT_A.tenantId, async (tx) => (await tx.query(`SELECT payload FROM ${tx.schema}.roster_operation WHERE user_id = $1`, [userId])).rows);
    return rows.map((row) => String(row.payload));
  }

  /** The one account operation of the request, with every step identity received. */
  function soleOperation(identity: IdentityDouble): { steps: string[]; operation: NonNullable<ReturnType<IdentityDouble['operation']>> } {
    const steps = accountSteps(identity);
    const ids = new Set(steps.map(([, operationId]) => operationId));
    expect(ids.size).toBe(1);
    const operation = identity.operation([...ids][0] ?? '');
    if (operation === undefined) throw new Error('identity recorded no account operation');
    return { steps: steps.map(([step]) => step), operation };
  }

  it('adds a user under the roster protocol with the primary address, interests and tags the form posts', () =>
    onPeople(async ({ app, identity, db }) => {
      const returnurl = './?muraAction=cUsers.listUsers&ispublic=0';
      const { status, body } = await send<UpdateResult>(app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm('Add', { returnurl }), query: userQuery('') });
      expect(status).toBe(200);
      expect(body).toEqual({ written: true, redirect: { url: returnurl }, errors: {} });
      const { steps, operation } = soleOperation(identity);
      expect(steps).toEqual(['prepare', 'commit', 'finish']);
      expect(operation.history).toEqual(['prepared', 'committed', 'finished']);
      expect(operation.request).toMatchObject({
        kind: 'create',
        siteId: SITE,
        groupIds: [],
        account: { UserName: 'robin.roster', Password: 'Roster#2026', S2: 0, isPublic: 0, InActive: 0, Type: 2 },
      });
      const { userId } = operation;
      expect(csrfContexts(identity)).toEqual([['', true]]);
      expect(identity.account(userId)).toMatchObject({ username: 'robin.roster', siteId: SITE, isPublic: 0, s2: 0 });
      expect(await rowsOf(db, 'person', userId)).toEqual([
        expect.objectContaining({ siteid: SITE, fname: 'Robin', lname: 'Roster', email: 'robin.roster@tenant-a.opt2.test', company: 'Acme', jobtitle: 'Analyst', tags: 'alpha,gamma' }),
      ]);
      expect(await rowsOf(db, 'user_address', userId)).toEqual([
        expect.objectContaining({
          addressname: 'Primary',
          isprimary: 1,
          address1: '9 Harbour Road',
          city: 'Bergen',
          zip: '5003',
          country: 'Norway',
          phone: '555-0199',
          addressemail: 'robin@home.opt2.test',
        }),
      ]);
      expect(await columnOf(db, 'user_interest', 'categoryid', userId)).toEqual([CATEGORY_1, CATEGORY_2].sort());
      expect(await columnOf(db, 'user_tag', 'tag', userId)).toEqual(['alpha', 'gamma']);
    }));

  it('adds the user under the id the form generated, its CSRF context, and routes back to the group it came from', () =>
    onPeople(async ({ app, identity, db }) => {
      const userId = cfUuid();
      const { body } = await send<UpdateResult>(app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm('Add', { returnurl: 'http://evil.example/x' }), query: userQuery(userId, GROUP) });
      expect(body.written).toBe(true);
      expect(rendered(body.redirect)).toBe(adminUrl({ circuit: 'cUsers', action: 'editgroup', params: [['siteid', SITE], ['userid', GROUP]] }));
      expect(csrfContexts(identity)).toEqual([[userId, true]]);
      expect(soleOperation(identity).operation.userId).toBe(userId);
      expect(await columnOf(db, 'person', 'fname', userId)).toEqual(['Robin']);
    }));

  it('updates a stored user, replacing its interests and tags, leaving its addresses, then lists the users', () =>
    onPeople(async ({ app, identity, db }) => {
      const addresses = await rowsOf(db, 'user_address', STORED_USER);
      const fields = userForm('Update', {
        fname: 'Sydney',
        lname: 'Updated',
        email: SYSTEM_USER_A_PERSON.email ?? '',
        usernameNoCache: 'system_user_a',
        passwordNoCache: '',
        password2: '',
        tags: 'delta',
        categoryid: CATEGORY_3,
      });
      const { status, body } = await send<UpdateResult>(app, UPDATE_USER, SITE_ADMIN_A, { fields, query: userQuery(STORED_USER) });
      expect(status).toBe(200);
      expect(body.written).toBe(true);
      expect(rendered(body.redirect)).toBe(adminUrl({ circuit: 'cUsers', action: 'listusers', params: [['siteid', SITE], ['ispublic', '0']] }));
      const { steps, operation } = soleOperation(identity);
      expect(steps).toEqual(['prepare', 'commit', 'finish']);
      expect(operation.request).toMatchObject({ kind: 'update', updateGroups: true, account: { UserName: 'system_user_a' } });
      expect(operation.request.account.Password).toBeUndefined();
      expect(csrfContexts(identity)).toEqual([[STORED_USER, true]]);
      expect(await columnOf(db, 'person', 'lname', STORED_USER)).toEqual(['Updated']);
      expect(await rowsOf(db, 'user_address', STORED_USER)).toEqual(expect.arrayContaining(addresses));
      expect(await rowsOf(db, 'user_address', STORED_USER)).toHaveLength(addresses.length);
      expect(await columnOf(db, 'user_interest', 'categoryid', STORED_USER)).toEqual([CATEGORY_3]);
      expect(await columnOf(db, 'user_tag', 'tag', STORED_USER)).toEqual(['delta']);
    }));

  it.each<[string, TestActor, number]>([
    ['a site administrator', SITE_ADMIN_A, 0],
    ['the super user', S2_ON_A, 1],
  ])('sends identity the S2 flag a new user gets from %s posting s2=1', (_name, actor, s2) =>
    onPeople(async ({ app, identity }) => {
      const { body } = await send<UpdateResult>(app, UPDATE_USER, actor, { fields: userForm('Add', { s2: '1' }), query: userQuery('') });
      expect(body.written).toBe(true);
      const { operation } = soleOperation(identity);
      expect(operation.request.account.S2).toBe(s2);
      expect(identity.account(operation.userId)?.s2).toBe(s2);
    }));

  it("keeps an S2 user's account fields that a caller without S2 posts out of both payloads, saving the rest", () =>
    onPeople(async ({ app, identity, db }) => {
      const fields = userForm('Update', {
        fname: 'Rooted',
        lname: 'Super',
        username: 'hijack',
        password: 'Hijack#2026',
        password2: 'Hijack#2026',
        passwordNoCache: 'Hijack#2026',
        email: 'hijack@evil.opt2.test',
        InActive: '1',
        isPublic: '1',
      });
      // edituser.cfm disables the username input of an S2 user for such a caller, so the browser posts none.
      const { status, body } = await send<UpdateResult>(app, UPDATE_USER, SITE_ADMIN_A, { fields: without(fields, 'usernameNoCache'), query: userQuery(S2_TARGET.userid) });
      expect(status).toBe(200);
      expect(body.written).toBe(true);
      expect(rendered(body.redirect)).toBe(adminUrl({ circuit: 'cUsers', action: 'listusers', params: [['siteid', SITE]] }));
      const { operation } = soleOperation(identity);
      expect(operation.request.account).toMatchObject({ UserName: 'root.super', InActive: 0, isPublic: 0 });
      expect(operation.request.account.Password).toBeUndefined();
      expect(JSON.stringify(operation.request)).not.toMatch(/hijack/i);
      expect(await rosterPayloads(db, S2_TARGET.userid)).toEqual([expect.not.stringMatching(/hijack/i)]);
      expect(identity.account(S2_TARGET.userid)).toMatchObject({ username: 'root.super', s2: 1, inactive: 0, isPublic: 0 });
      expect(await rowsOf(db, 'person', S2_TARGET.userid)).toEqual([expect.objectContaining({ fname: 'Rooted', email: S2_TARGET.email })]);
    }));

  it('saves an edit form posted as multipart with its photo input left empty', () =>
    onPeople(async ({ app, db }) => {
      const fields = userForm('Update', { email: SYSTEM_USER_A_PERSON.email ?? '', usernameNoCache: 'system_user_a', passwordNoCache: '', password2: '', lname: 'Multipart' });
      const { body } = await send<UpdateResult>(app, UPDATE_USER, SITE_ADMIN_A, { fields, query: userQuery(STORED_USER), files: [{ field: 'newFile', filename: '' }] });
      expect(body.written).toBe(true);
      expect(await columnOf(db, 'person', 'lname', STORED_USER)).toEqual(['Multipart']);
    }));

  it.each<[string, Record<string, string>, boolean, string[], string[]]>([
    ["people's missing email", { email: '' }, false, ['email'], ['prepare', 'abort']],
    ["identity's taken username", {}, true, ['username'], ['prepare']],
    ['both', { email: '' }, true, ['email', 'username'], ['prepare']],
  ])('re-renders the form with %s, committing nothing on either side', (_name, fields, taken, errorKeys, steps) =>
    onPeople(async ({ app, identity, db }) => {
      const userId = cfUuid();
      if (taken) identity.setPrepareErrors(userId, { username: USERNAME_TAKEN });
      const { status, body } = await send<UpdateResult>(app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm('Add', fields), query: userQuery(userId) });
      expect(status).toBe(200);
      expect(body.written).toBe(false);
      expect(body.redirect).toBeUndefined();
      expect(Object.keys(body.errors).sort()).toEqual(errorKeys);
      if (taken) expect(body.errors.username).toBe(USERNAME_TAKEN);
      expect(body.userBean).toMatchObject({ UserID: userId, Fname: 'Robin', UserName: 'robin.roster', SiteID: SITE, Type: 2, isPublic: 0, categoryid: `${CATEGORY_1},${CATEGORY_2}` });
      expect(accountSteps(identity).map(([step]) => step)).toEqual(steps);
      expect(identity.account(userId)).toBeUndefined();
      expect(identity.isUserClosed(userId)).toBe(false);
      for (const table of ['person', 'user_address', 'user_interest', 'user_tag'] as const) expect(await rowsOf(db, table, userId)).toEqual([]);
    }));

  it.each<[string, string]>([
    ['an Add', 'Add'],
    ['an Update without an address id', 'Update'],
  ])('saves %s as a new address of the stored user under CSRF context updateaddress<userid>', (_name, action) =>
    onPeople(async ({ app, identity, db }) => {
      const before = await rowsOf(db, 'user_address', STORED_USER);
      const { status, body } = await send<RouteResult>(app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields: addressForm(action), query: addressQuery(STORED_USER) });
      expect(status).toBe(200);
      expect(body.written).toBe(true);
      expect(rendered(body.redirect)).toBe(editUserUrl(STORED_USER, ''));
      expect(csrfContexts(identity)).toEqual([[`updateaddress${STORED_USER}`, true]]);
      expect(accountSteps(identity)).toEqual([]);
      const after = await rowsOf(db, 'user_address', STORED_USER);
      expect(after).toHaveLength(before.length + 1);
      expect(after).toEqual(expect.arrayContaining([expect.objectContaining({ addressname: 'Cabin', address1: '1 Fjord Lane', city: 'Voss', zip: '5700', isprimary: 0 })]));
    }));

  it('updates the posted address of the stored user in place', () =>
    onPeople(async ({ app, db }) => {
      const before = await rowsOf(db, 'user_address', STORED_USER);
      const work = before.find((row) => row.addressname === 'Work');
      if (work === undefined) throw new Error('the seed holds no Work address');
      const addressID = String(work.addressid);
      const { body } = await send<RouteResult>(app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields: addressForm('Update', { addressID }), query: addressQuery(STORED_USER, 'editprofile') });
      expect(body).toEqual({ written: true, redirect: { action: 'cEditProfile.edit', params: {} } });
      const after = await rowsOf(db, 'user_address', STORED_USER);
      expect(after).toHaveLength(before.length);
      expect(after.find((row) => row.addressid === work.addressid)).toMatchObject({ addressname: 'Cabin', address1: '1 Fjord Lane', city: 'Voss', zip: '5700' });
    }));

  it('writes nothing for an Update of an address no row holds, and still redirects', () =>
    onPeople(async ({ app, db }) => {
      const stranger = cfUuid();
      const { body } = await send<RouteResult>(app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields: addressForm('Update', { addressID: cfUuid() }), query: addressQuery(stranger) });
      expect(body).toEqual({ written: false, redirect: { action: 'cUsers.edituser', params: { siteid: SITE, userid: stranger, routeid: '' } } });
      expect(await rowsOf(db, 'user_address', stranger)).toEqual([]);
    }));

  it.each<[string, string]>([
    ['a user of a site the registry does not list', S2_USER.userid],
    ['an owner people holds no person of, such as a group', GROUP],
    ['an id that is no CF UUID', 'not-a-user'],
  ])('answers an address Add for %s with the legacy 503, writing nothing', (_name, userid) =>
    onPeople(async ({ app, db }) => {
      const { status, body } = await send(app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields: addressForm('Add'), query: addressQuery(userid) });
      expect(status).toBe(503);
      expect(body).toMatchObject(LEGACY_503);
      expect(await rowsOf(db, 'user_address', userid)).toEqual([]);
    }));

  // The URL helpers' own cases live in admin-users-routes.test.ts; these prove a save applies them over the site registry.
  it.each<[string, Record<string, string>, string]>([
    ['a foreign return URL onto the site domain', { returnurl: 'http://evil.example/x' }, 'http://tenant-a.opt2.test/x'],
    ['a scheme-relative return URL onto a root-relative one', { returnurl: '//evil.example/x' }, '/evil.example/x'],
    ['a return URL on another registered site unchanged', { returnurl: 'https://tenant-b.opt2.test/page' }, 'https://tenant-b.opt2.test/page'],
  ])('routes a saved update through %s', (_name, fields, expected) =>
    onPeople(async ({ app }) => {
      const update = userForm('Update', { email: SYSTEM_USER_A_PERSON.email ?? '', usernameNoCache: 'system_user_a', passwordNoCache: '', password2: '', ...fields });
      const { body } = await send<UpdateResult>(app, UPDATE_USER, SITE_ADMIN_A, { fields: update, query: userQuery(STORED_USER) });
      expect(body).toEqual({ written: true, redirect: { url: expected }, errors: {} });
    }));
});
