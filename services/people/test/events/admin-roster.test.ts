/** The cUsers roster writes over a throwaway `people` schema: `cUsers.update` Type=2 Add and Update and `cUsers.updateAddress` through `app.inject` with the identity double. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminUrl, cfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import type { PeopleEnv } from '../../src/app.js';
import { TEST_CLOCK, testEnv, userHeaders } from '../helpers/app.js';
import { PG_AVAILABLE, withPgApp, type PgTestApp } from '../helpers/pg-app.js';
import type { IdentityDouble } from '../helpers/identity-double.js';
import { ADMIN_S2, DEFAULT_PEOPLE_SEED, OTHER_TENANT_PERSON, S2_USER, SITE_ADMIN_A, SYSTEM_USER_A_PERSON, accountFor, seedPeople, type TestActor } from '../helpers/fixtures.js';
import {
  CATEGORY_1,
  CATEGORY_2,
  GROUP,
  LEGACY_503,
  OPENAPI,
  S2_TARGET,
  SITE,
  STORED_USER,
  UPDATE_ADDRESS,
  UPDATE_USER,
  accountSteps,
  addressForm,
  addressQuery,
  csrfContexts,
  editUserUrl,
  newIdentity,
  rendered,
  send,
  userForm,
  userQuery,
  without,
  type Post,
  type Redirect,
  type RouteResult,
} from '../helpers/roster-posts.js';

const CATEGORY_3 = cfUuid();
/** The legacy database and datasource names the query faults print. */
const LEGACY_DATABASE = 'muradb_t';
const LEGACY_DATASOURCE = 'muradb';
const DRIVER = '[Macromedia][SQLServer JDBC Driver][SQLServer]';
const USERNAME_TAKEN = "The username 'robin.roster' that you entered is being used by another user.";
/** The installed super-user working in tenant-a's admin. */
const S2_ON_A: TestActor = Object.freeze({ ...ADMIN_S2, site: SITE });

/** A legacy `server_error` envelope naming a failed cfquery, its keys lower-cased as the API serializer writes them. */
interface QueryFaultBody {
  error: { code: string; stacktrace: { message: string; type: string; datasource: string; sql: string; errorcode: string; detail: string } };
}

/** The truncation detail SQL Server raises for `column` of `table`, quoting `value`. */
function truncation(table: string, column: string, value: string): string {
  return `${DRIVER}String or binary data would be truncated in table '${LEGACY_DATABASE}.dbo.${table}', column '${column}'. Truncated value: '${value}'.`;
}

interface UpdateResult {
  written: boolean;
  redirect?: Redirect;
  errors: Record<string, string>;
  userBean?: Record<string, unknown>;
  passwordExpired?: boolean;
}

describe.skipIf(!PG_AVAILABLE)('cUsers roster writes over PostgreSQL', () => {
  type PeopleDb = PgTestApp['db'];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Names the legacy database and datasource as the people process reads them. */
  function stubLegacyNames(): void {
    vi.stubEnv('MURA_DATABASE', LEGACY_DATABASE);
    vi.stubEnv('MURA_DATASOURCE', LEGACY_DATASOURCE);
  }
  type PersonTable = 'person' | 'user_address' | 'user_interest' | 'user_tag';

  /** Runs `fn` against people, built with `env` when given, over a fresh throwaway schema holding the fixture seed and the S2 target. */
  async function onPeople(fn: (pg: PgTestApp) => Promise<void>, env?: PeopleEnv): Promise<void> {
    const outcome = await withPgApp(
      async (pg) => {
        await seedPeople(pg.db, DEFAULT_PEOPLE_SEED, { clock: TEST_CLOCK });
        await seedPeople(pg.db, { [TENANT_A.tenantId]: { persons: [S2_TARGET] } }, { clock: TEST_CLOCK });
        await fn(pg);
      },
      { identity: newIdentity(), ...(env === undefined ? {} : { env }) },
    );
    if (outcome !== undefined) throw new Error(outcome.reason);
  }

  /** The rows of `table` that belong to `userId` in `tenantId`, tenant-a by default. */
  async function rowsOf(db: PeopleDb, table: PersonTable, userId: string, tenantId = TENANT_A.tenantId): Promise<Record<string, unknown>[]> {
    return db.withTenant(tenantId, async (tx) => (await tx.query(`SELECT * FROM ${tx.schema}.${table} WHERE userid = $1`, [userId])).rows);
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

  it.each<[string, Record<string, string>, number, string]>([
    ['answers the query fault of its INSERT', {}, 500, 'legacy-storage'],
    ['answers the validation errors of another field, as legacy validates before its insert', { email: '' }, 200, 'validation'],
  ])("adds a user posting a username of 256, beyond identity's legacy column, and %s, writing nothing on either side", (_label, extra, expected, error) =>
    onPeople(async ({ app, identity, db }) => {
      stubLegacyNames();
      const userId = cfUuid();
      const fields = userForm('Add', { usernameNoCache: 'u'.repeat(256), ...extra });

      const { status, body } = await send<UpdateResult & QueryFaultBody>(app, UPDATE_USER, SITE_ADMIN_A, { fields, query: userQuery(userId) });

      expect(status).toBe(expected);
      if (expected === 200) expect(body).toMatchObject({ written: false, errors: { email: expect.any(String) } });
      else expect(body.error.stacktrace).toMatchObject({ errorcode: 'HY000', detail: truncation('tusers', 'UserName', 'u'.repeat(100)) });
      expect(accountSteps(identity).map(([step]) => step)).toEqual(['prepare']);
      expect(identity.account(userId)).toBeUndefined();
      expect(await rowsOf(db, 'person', userId)).toEqual([]);
      const operations = await db.withTenant(TENANT_A.tenantId, async (tx) => (await tx.query(`SELECT state, error FROM ${tx.schema}.roster_operation WHERE user_id = $1`, [userId])).rows);
      expect(operations).toEqual([{ state: 'rolled-back', error }]);
    }));

  it("adds a user posting a 60-character lname, answering the query fault legacy's INSERT raises, writing nothing on either side", () =>
    onPeople(async ({ app, identity, db }) => {
      stubLegacyNames();
      const userId = cfUuid();

      const { status, body } = await send<QueryFaultBody>(app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm('Add', { lname: 'L'.repeat(60) }), query: userQuery(userId) });

      expect(status).toBe(500);
      expect(body.error).toMatchObject({
        code: 'server_error',
        stacktrace: {
          message: 'Error Executing Database Query.',
          type: 'Database',
          datasource: LEGACY_DATASOURCE,
          errorcode: 'HY000',
          detail: truncation('tusers', 'Lname', 'L'.repeat(50)),
          sql: expect.stringContaining(`VALUES(\n         '${userId}',\n\t\t  (param 1) ,\n\t\t 0,`),
        },
      });
      expect(accountSteps(identity).map(([step]) => step)).toEqual(['prepare', 'abort']);
      expect(identity.account(userId)).toBeUndefined();
      expect(await rowsOf(db, 'person', userId)).toEqual([]);
      const operations = await db.withTenant(TENANT_A.tenantId, async (tx) => (await tx.query(`SELECT state, error FROM ${tx.schema}.roster_operation WHERE user_id = $1`, [userId])).rows);
      expect(operations).toEqual([{ state: 'rolled-back', error: 'legacy-storage' }]);
    }));

  it.each<[string, Record<string, string>, string, string[], number]>([
    ['its second tag beyond its column, keeping the tag before it and no address', { tags: `ok1,${'T'.repeat(101)},ok3` }, truncation('tuserstags', 'tag', 'T'.repeat(100)), ['ok1'], 0],
    ['an address1 beyond its column, keeping its tags and no address', { address1: 'A'.repeat(51) }, truncation('tuseraddresses', 'address1', 'A'.repeat(50)), ['alpha', 'gamma'], 0],
  ])('adds a user posting %s, as each legacy statement commits on its own, and answers the query fault', (_label, extra, detail, tags, addresses) =>
    onPeople(async ({ app, identity, db }) => {
      stubLegacyNames();
      const userId = cfUuid();

      const { status, body } = await send<QueryFaultBody>(app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm('Add', extra), query: userQuery(userId) });

      expect(status).toBe(500);
      expect(body.error.stacktrace).toMatchObject({ errorcode: 'HY000', detail });
      expect(accountSteps(identity).map(([step]) => step)).toEqual(['prepare', 'commit', 'finish']);
      expect(identity.account(userId)).toMatchObject({ username: 'robin.roster' });
      expect(await columnOf(db, 'person', 'lname', userId)).toEqual(['Roster']);
      expect(await columnOf(db, 'user_interest', 'categoryid', userId)).toEqual([CATEGORY_1, CATEGORY_2].sort());
      expect(await columnOf(db, 'user_tag', 'tag', userId)).toEqual(tags);
      expect(await rowsOf(db, 'user_address', userId)).toHaveLength(addresses);
    }));

  it("answers a super user's add posting an s2 CFML cannot read as a boolean with the fault legacy's S2 rule raises, writing nothing", () =>
    onPeople(async ({ app, identity, db }) => {
      const userId = cfUuid();

      const { status, body } = await send<QueryFaultBody>(app, UPDATE_USER, S2_ON_A, { fields: userForm('Add', { s2: 'abc' }), query: userQuery(userId) });

      expect(status).toBe(500);
      expect(body.error.stacktrace).toEqual({ message: 'cannot convert the value "abc" to a boolean', type: 'Expression' });
      expect(accountSteps(identity)).toEqual([]);
      expect(await rowsOf(db, 'person', userId)).toEqual([]);
    }));

  // Oracle: the legacy user adds of f3/leg-user-{perm-abc,subscribe-x,inactive-abc,ispublic-true,s2-yes,multi}.
  it.each<[string, TestActor, Record<string, string>, string[], Record<string, unknown>]>([
    ['a perm', SITE_ADMIN_A, { perm: 'abc' }, ['perm'], { Perm: 'abc', isPublic: 0 }],
    ['a subscribe', SITE_ADMIN_A, { subscribe: 'x' }, ['subscribe'], { Subscribe: 'x' }],
    ['an InActive', SITE_ADMIN_A, { InActive: 'abc' }, ['inActive'], { InActive: 'abc' }],
    ["an admin's isPublic boolean word", SITE_ADMIN_A, { isPublic: 'true' }, ['isPublic'], { isPublic: 'true' }],
    ["a super user's s2 boolean word, which also makes the user private,", S2_ON_A, { s2: 'yes', isPublic: '1' }, ['s2'], { S2: 'yes', isPublic: 0 }],
    [
      'text in every flag',
      S2_ON_A,
      { perm: 'true', subscribe: 'x', InActive: 'y', isPublic: 'yes', s2: 'no' },
      ['perm', 'inActive', 'isPublic', 'subscribe', 's2'],
      { Perm: 'true', Subscribe: 'x', InActive: 'y', isPublic: 'yes', S2: 'no' },
    ],
  ])("adds a user posting %s the bean's numeric dataType rejects, answering legacy's errors with the posted text and writing nothing", (_label, actor, extra, errorKeys, flags) =>
    onPeople(async ({ app, identity, db }) => {
      const userId = cfUuid();

      const { status, body } = await send<UpdateResult>(app, UPDATE_USER, actor, { fields: userForm('Add', extra), query: userQuery(userId) });

      expect(status).toBe(200);
      expect(body).toMatchObject({ written: false, userBean: { UserID: userId, ...flags } });
      expect(Object.keys(body.errors)).toEqual(errorKeys);
      for (const key of errorKeys) expect(body.errors[key]).toBe(`The property named '${key}' is not valid`);
      expect(accountSteps(identity).map(([step]) => step)).toEqual(['prepare', 'abort']);
      expect(identity.account(userId)).toBeUndefined();
      for (const table of ['person', 'user_address', 'user_interest', 'user_tag'] as const) expect(await rowsOf(db, table, userId)).toEqual([]);
    }));

  it.each<[string, Record<string, string>]>([
    ['a non-numeric keepPrivate, which its setter drops', { keepPrivate: 'abc' }],
    ['a non-boolean isPublic, which the scrub reads as Member', { isPublic: 'abc' }],
    ['a signed perm, which CFML reads as a number', { perm: '+1' }],
  ])('adds a user posting %s, saving it', (_label, extra) =>
    onPeople(async ({ app, identity }) => {
      const { body } = await send<UpdateResult>(app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm('Add', extra), query: userQuery('') });
      expect(body.written).toBe(true);
      expect(soleOperation(identity).steps).toEqual(['prepare', 'commit', 'finish']);
    }));

  // Oracle: f3/leg-user-sql-*, the legacy debug pages of these adds.
  it.each<[string, TestActor, Record<string, string>, string, string, string]>([
    ['perm Infinity', SITE_ADMIN_A, { perm: 'Infinity' }, '42S22', "Invalid column name 'Infinity'.", '\t\t  Infinity,\n'],
    ['subscribe NaN', SITE_ADMIN_A, { subscribe: 'NaN' }, '42S22', "Invalid column name 'NaN'.", '\t\t  NaN,\n'],
    ['a hex float perm', SITE_ADMIN_A, { perm: '0x1p3' }, 'HY000', "Incorrect syntax near 'p3'.", '\t\t  0x1p3,\n'],
    ['a negative hex float InActive', SITE_ADMIN_A, { InActive: '-0x1p3' }, 'HY000', 'Invalid operator for data type. Operator equals minus, type equals varbinary.', '\t\t -0x1p3,\n'],
    ['a hex float keepPrivate', SITE_ADMIN_A, { keepPrivate: '0x1p3' }, 'HY000', "Incorrect syntax near 'p3'.", '\t\t0x1p3,\n'],
    ["a super user's hex float s2 (the user made private)", S2_ON_A, { s2: '0x1p3', isPublic: '1' }, 'HY000', "Incorrect syntax near 'p3'.", '\t\t 0x1p3,\n'],
    ['an empty perm', SITE_ADMIN_A, { perm: '' }, 'HY000', "Incorrect syntax near ','.", '\t\t  ,\n'],
  ])("adds a user posting %s, which passes validation, answering the query fault legacy's INSERT raises and writing nothing", (_label, actor, extra, errorcode, message, inlined) =>
    onPeople(async ({ app, identity, db }) => {
      stubLegacyNames();
      const userId = cfUuid();

      const { status, body } = await send<QueryFaultBody>(app, UPDATE_USER, actor, { fields: userForm('Add', extra), query: userQuery(userId) });

      expect(status).toBe(500);
      expect(body.error.stacktrace).toMatchObject({ errorcode: errorcode, detail: `${DRIVER}${message}`, sql: expect.stringContaining(inlined) });
      expect(accountSteps(identity).map(([step]) => step)).toEqual(['prepare', 'abort']);
      expect(identity.account(userId)).toBeUndefined();
      expect(await rowsOf(db, 'person', userId)).toEqual([]);
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

  // Without its script the add form posts its URL text input and its file input both as newFile.
  it('adds a user posted as multipart with an empty newFile text field and an empty newFile file part', () =>
    onPeople(async ({ app, identity, db }) => {
      const returnurl = './?muraAction=cUsers.listUsers&ispublic=0';
      const fields = userForm('Add', { returnurl, newFile: '' });
      const { status, body } = await send<UpdateResult>(app, UPDATE_USER, SITE_ADMIN_A, { fields, query: userQuery(''), files: [{ field: 'newFile', filename: '' }] });
      expect(status).toBe(200);
      expect(body).toEqual({ written: true, redirect: { url: returnurl }, errors: {} });
      expect(await columnOf(db, 'person', 'fname', soleOperation(identity).operation.userId)).toEqual(['Robin']);
    }));

  it.each<[string, Record<string, string>, string]>([
    ['a filled newFile text field', { newFile: 'x' }, ''],
    ['a chosen newFile file', { newFile: '' }, 'me.png'],
  ])('answers an Add posted as multipart with %s with the legacy 503, writing nothing', (_name, extra, filename) =>
    onPeople(async ({ app, identity }) => {
      const { status, body } = await send(app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm('Add', extra), query: userQuery(''), files: [{ field: 'newFile', filename }] });
      expect(status).toBe(503);
      expect(body).toMatchObject(LEGACY_503);
      expect(accountSteps(identity)).toEqual([]);
      expect(csrfContexts(identity)).toEqual([]);
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
      expect(Object.keys(body.userBean ?? {})).not.toContain('PasswordCreated');
      expect(body.passwordExpired).toBe(false);
      expect(accountSteps(identity).map(([step]) => step)).toEqual(steps);
      expect(identity.account(userId)).toBeUndefined();
      expect(identity.isUserClosed(userId)).toBe(false);
      for (const table of ['person', 'user_address', 'user_interest', 'user_tag'] as const) expect(await rowsOf(db, table, userId)).toEqual([]);
    }));

  it("answers an Add posting the userid of another tenant's user with the legacy 503, writing nothing on either side and leaving that user as stored", () =>
    onPeople(async ({ app, identity, db }) => {
      const victim = OTHER_TENANT_PERSON.userid;
      const account = identity.account(victim);
      const tables = ['person', 'user_address', 'user_interest', 'user_tag'] as const;
      const stored = await Promise.all(tables.map((table) => rowsOf(db, table, victim, TENANT_B.tenantId)));
      expect(account).toMatchObject({ siteId: TENANT_B.siteId });
      expect(stored[0]).toHaveLength(1);

      const { status, body } = await send(app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm('Add'), query: userQuery(victim) });

      expect(status).toBe(503);
      expect(body).toMatchObject(LEGACY_503);
      expect(accountSteps(identity).map(([step]) => step)).toEqual(['prepare']);
      expect(identity.account(victim)).toEqual(account);
      for (const table of tables) expect(await rowsOf(db, table, victim)).toEqual([]);
      expect(await Promise.all(tables.map((table) => rowsOf(db, table, victim, TENANT_B.tenantId)))).toEqual(stored);
    }));

  // The routes take MURA_EXPIREPASSWORDS from the people environment buildApp parsed.
  it.each<[string, string | undefined, boolean]>([
    ['passwords never expire', undefined, false],
    ['they expire after 30 days', '30', true],
  ])("answers a stored user's failed update with its password expiry when %s", (_name, setting, expired) =>
    onPeople(async ({ app, identity }) => {
      identity.seedAccounts(accountFor(SYSTEM_USER_A_PERSON, { passwordCreated: '2026-01-02T09:00:00.000' }));
      const fields = userForm('Update', { email: '', usernameNoCache: 'system_user_a', passwordNoCache: '', password2: '' });
      const { status, body } = await send<UpdateResult>(app, UPDATE_USER, SITE_ADMIN_A, { fields, query: userQuery(STORED_USER) });
      expect(status).toBe(200);
      expect(body).toMatchObject({ written: false, userBean: { UserID: STORED_USER }, passwordExpired: expired });
      expect(Object.keys(body.errors)).toEqual(['email']);
    }, testEnv({ MURA_EXPIREPASSWORDS: setting })));

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

  it.each<[string, Record<string, string>, string | undefined]>([
    ['the form posts', {}, undefined],
    ['an address1 beyond its column, which SQL Server checks only on a row the UPDATE matches', { address1: 'A'.repeat(255) }, undefined],
    ['an address1 beyond its column for a stored user, whose UPDATE also matches no row', { address1: 'A'.repeat(255) }, STORED_USER],
  ])('writes nothing for an Update of an address no row holds, posting %s, and still redirects', (_label, extra, owner) =>
    onPeople(async ({ app, db }) => {
      stubLegacyNames();
      const userid = owner ?? cfUuid();
      const before = await rowsOf(db, 'user_address', userid);
      const { body } = await send<RouteResult>(app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields: addressForm('Update', { addressID: cfUuid(), ...extra }), query: addressQuery(userid) });
      expect(body).toEqual({ written: false, redirect: { action: 'cUsers.edituser', params: { siteid: SITE, userid, routeid: '' } } });
      expect(await rowsOf(db, 'user_address', userid)).toEqual(before);
    }));

  it.each<[string, 'Add' | 'Update']>([
    ['a new address', 'Add'],
    ['the stored address', 'Update'],
  ])("answers %s posting a 255-character address1 with the query fault legacy's statement raises, writing nothing", (_label, action) =>
    onPeople(async ({ app, db }) => {
      stubLegacyNames();
      const before = await rowsOf(db, 'user_address', STORED_USER);
      const work = before.find((row) => row.addressname === 'Work');
      if (work === undefined) throw new Error('the seed holds no Work address');
      const addressID = action === 'Update' ? String(work.addressid) : '';

      const { status, body } = await send<QueryFaultBody>(app, UPDATE_ADDRESS, SITE_ADMIN_A, {
        fields: addressForm(action, { addressID, address1: 'A'.repeat(255) }),
        query: addressQuery(STORED_USER),
      });

      expect(status).toBe(500);
      expect(body.error.stacktrace).toMatchObject({
        message: 'Error Executing Database Query.',
        datasource: LEGACY_DATASOURCE,
        errorcode: 'HY000',
        detail: truncation('tuseraddresses', 'address1', 'A'.repeat(50)),
        sql: expect.stringMatching(action === 'Add' ? /^INSERT INTO tuseraddresses / : /^UPDATE tuseraddresses SET/),
      });
      expect(await rowsOf(db, 'user_address', STORED_USER)).toEqual(before);
    }));

  // Oracle: the legacy address adds of f3/leg-addr-add-* and the debug page f3/leg-addr-add-lon-hex.html.
  it.each<[string, Record<string, string>, Record<string, unknown>]>([
    ['an isPrimary, longitude and latitude CFML reads as no number', { isPrimary: 'abc', longitude: 'Infinity', latitude: 'true' }, { isprimary: 0, longitude: 0, latitude: 0 }],
    ['a NaN isPrimary', { isPrimary: 'NaN' }, { isprimary: 0 }],
    ['a signed-exponent latitude', { latitude: '1e+3' }, { latitude: 1000, longitude: 0 }],
    // Oracle: cUsers.updateAddress Add of a hex float isNumeric refuses stores the setter's init value.
    ['a hex float longitude and isPrimary ACF reads as no number', { longitude: '0xAp0', isPrimary: '0xAp0' }, { isprimary: 0, longitude: 0 }],
  ])('adds an address posting %s, which the setters keep only when numeric', (_label, extra, stored) =>
    onPeople(async ({ app, db }) => {
      const before = await rowsOf(db, 'user_address', STORED_USER);
      const { body } = await send<RouteResult>(app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields: addressForm('Add', extra), query: addressQuery(STORED_USER) });
      expect(body.written).toBe(true);
      const added = (await rowsOf(db, 'user_address', STORED_USER)).filter((row) => !before.some((old) => old.addressid === row.addressid));
      expect(added).toEqual([expect.objectContaining({ addressname: 'Cabin', ...stored })]);
    }));

  it.each<[string, 'Add' | 'Update', Record<string, string>, string]>([
    ['a new address', 'Add', { longitude: '0x1p3' }, "Incorrect syntax near 'p3'."],
    ['a new address', 'Add', { latitude: '0x1.8p1' }, "Incorrect syntax near '.8'."],
    ['a new address', 'Add', { longitude: '0x1p1024' }, "Incorrect syntax near 'p1024'."],
    ['the stored address', 'Update', { longitude: '-0x1p3' }, 'Invalid operator for data type. Operator equals minus, type equals varbinary.'],
  ])("answers %s posting a hex float coordinate with the query fault legacy's statement raises, writing nothing", (_label, action, extra, message) =>
    onPeople(async ({ app, db }) => {
      stubLegacyNames();
      const before = await rowsOf(db, 'user_address', STORED_USER);
      const work = before.find((row) => row.addressname === 'Work');
      if (work === undefined) throw new Error('the seed holds no Work address');
      const addressID = action === 'Update' ? String(work.addressid) : '';

      const { status, body } = await send<QueryFaultBody>(app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields: addressForm(action, { addressID, ...extra }), query: addressQuery(STORED_USER) });

      expect(status).toBe(500);
      expect(body.error.stacktrace).toMatchObject({ errorcode: 'HY000', detail: `${DRIVER}${message}` });
      expect(await rowsOf(db, 'user_address', STORED_USER)).toEqual(before);
    }));

  // Oracle: f3/leg-user-sql-lon-hex, whose tusers row legacy keeps without an address.
  it("adds a user posting a hex float longitude, keeping the user as legacy's committed INSERT does and answering the address INSERT's fault", () =>
    onPeople(async ({ app, identity, db }) => {
      stubLegacyNames();
      const userId = cfUuid();

      const { status, body } = await send<QueryFaultBody>(app, UPDATE_USER, SITE_ADMIN_A, { fields: userForm('Add', { longitude: '0x1p3' }), query: userQuery(userId) });

      expect(status).toBe(500);
      expect(body.error.stacktrace).toMatchObject({ errorcode: 'HY000', detail: `${DRIVER}Incorrect syntax near 'p3'.`, sql: expect.stringMatching(/^INSERT INTO tuseraddresses /) });
      expect(accountSteps(identity).map(([step]) => step)).toEqual(['prepare', 'commit', 'finish']);
      expect(await columnOf(db, 'person', 'lname', userId)).toEqual(['Roster']);
      expect(await rowsOf(db, 'user_address', userId)).toEqual([]);
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

  // Oracle: admin start-up's Portcullis scan of the form [legacy: admin/Application.cfc:246-265]; a JSON body is not scanned.
  const MARKUP = { fname: '<script>alert(1)</script>Aaliyah', lname: 'Frami<img src=x onerror=alert(1)>', company: 'javascript:alert(1)', remoteID: 'javascript:alert(1)' };
  const SCANNED = { fname: '[INVALID]Aaliyah', lname: 'Frami<img src=x [INVALID]=alert(1)>', company: '[INVALID]alert(1)', remoteID: '[INVALID]alert(1)' };
  it.each<[string, Pick<Post, 'files' | 'json'>, typeof MARKUP]>([
    ['a urlencoded form', {}, SCANNED],
    ['a multipart form', { files: [{ field: 'newFile', filename: '' }] }, SCANNED],
    ['a JSON body', { json: true }, MARKUP],
  ])('saves the person and account values of a roster edit posted as %s as request start-up leaves them', (_name, encoding, expected) =>
    onPeople(async ({ app, identity, db }) => {
      const fields = userForm('Update', { email: SYSTEM_USER_A_PERSON.email ?? '', usernameNoCache: 'system_user_a', passwordNoCache: '', password2: '', ...MARKUP });
      const { body } = await send<UpdateResult>(app, UPDATE_USER, SITE_ADMIN_A, { fields, query: userQuery(STORED_USER), ...encoding });
      expect(body.written).toBe(true);
      const { remoteID, ...person } = expected;
      expect(await rowsOf(db, 'person', STORED_USER)).toEqual([expect.objectContaining(person)]);
      expect(soleOperation(identity).operation.request.account).toMatchObject({ UserName: 'system_user_a', remoteID });
    }));

  it('stores address notes as the start-up scan leaves them, and the address screen reads them back', () =>
    onPeople(async ({ app, db }) => {
      const before = new Set((await rowsOf(db, 'user_address', STORED_USER)).map((row) => row.addressid));
      const fields = addressForm('Add', { addressNotes: 'note <b>bold</b> <script>alert(1)</script>' });
      const { body } = await send<RouteResult>(app, UPDATE_ADDRESS, SITE_ADMIN_A, { fields, query: addressQuery(STORED_USER) });
      expect(body.written).toBe(true);
      const added = (await rowsOf(db, 'user_address', STORED_USER)).filter((row) => !before.has(row.addressid));
      expect(added).toEqual([expect.objectContaining({ addressnotes: 'note <b>bold</b> [INVALID]' })]);
      const url = `/v1/users/address?siteid=${SITE}&userid=${STORED_USER}&addressid=${String(added[0]?.addressid)}`;
      const res = await app.inject({ method: 'GET', url, headers: await userHeaders(SITE_ADMIN_A) });
      const read = assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
      expect(read).toMatchObject({ isNew: false, address: { addressNotes: 'note <b>bold</b> [INVALID]' } });
    }));
});
