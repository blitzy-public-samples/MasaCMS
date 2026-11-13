/** The JSON API `user` and `address` routes through `app.inject` over a throwaway `people` schema and an identity double. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, moduleRole } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { CSRF_CONSUME_PATH, createService, loadEnv, type CsrfConsumeRequest, type FastifyInstance, type ServiceRequest } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  businessClock,
  createCapturingPublisher,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { createFaultHooks } from '../../src/domain/faults.js';
import { personFence, type RosterDeps } from '../../src/domain/roster-protocol.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { peoplePayloadValidators } from '../../src/events/topics.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';
import { PEOPLE_UNITS } from '../../src/repo/tables.js';
import { legacyApiSettings, registerLegacyApiRoutes, type LegacyApiSettings } from '../../src/routes/legacy-api.js';
import {
  CSV_QUIRK_PERSONS,
  DEFAULT_PEOPLE_SEED,
  SITE_ADMIN_A,
  SITE_ADMIN_A_PERSON,
  SYSTEM_USER_A,
  SYSTEM_USER_A_PERSON,
  accountFor,
  accountsForSeed,
  seedPeople,
  type TestActor,
} from '../helpers/fixtures.js';
import { createIdentityDouble, silentLogger, type IdentityDouble } from '../helpers/route-app.js';

const SERVICE = 'people';
const OPENAPI = parse(readFileSync(fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url)), 'utf8')) as object;
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const SETTINGS: LegacyApiSettings = Object.freeze({ adminSSL: false, serverPort: '', context: '', appReloadKey: 'appreload', adminDomain: '' });
const FORM = Object.freeze({ 'content-type': 'application/x-www-form-urlencoded' });
const CSRF = Object.freeze({ csrf_token: 'TOKEN', csrf_token_expires: '260630110000000' });
const API = '/_api/json/v1/tenant-a';
const ENDPOINT = `http://localhost${API.replace('/_api', '/index.cfm/_api')}`;
const ETAG = /^[0-9A-F]{64}$/;
/** A tenant-a system user without the Users module, saving only its own record. */
const SELF_SAVER: TestActor = Object.freeze({ sub: CSV_QUIRK_PERSONS[0]?.userid ?? '', site: TENANT_A.siteId, roles: [Roles.systemUser], s2: false });
/** A tenant-a session without a signed-in user, as identity mints its token. */
const ANONYMOUS: TestActor = Object.freeze({ sub: '', site: TENANT_A.siteId, roles: [], s2: false });
/** A tenant-a user holding only the Users module grant. */
const USERS_MODULE_ONLY: TestActor = Object.freeze({ ...SYSTEM_USER_A, roles: [Roles.systemUser, moduleRole('00000000000000000000000000000000008')] });

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

describe.skipIf(!(await pgAvailable()))('JSON API user and address routes', () => {
  let handle: ThrowawaySchema;
  let db: TenantDb;
  let repo: PeopleRepository;
  let identity: IdentityDouble;
  let app: FastifyInstance;
  const consumed: CsrfConsumeRequest[] = [];
  let csrfValid = true;

  beforeAll(async () => {
    const clock = businessClock();
    const logger = silentLogger();
    handle = await createThrowawaySchema({ service: SERVICE, migrationsDir: MIGRATIONS_DIR });
    db = handle.app;
    await ensureUnitGates(db, PEOPLE_UNITS);
    await closeGates(db, { units: PEOPLE_UNITS, holderId: 'legacy-api-test', allowLegacy: true });
    await openGates(db, { units: PEOPLE_UNITS, holderId: 'legacy-api-test', state: 'open' });
    await seedRegistry(db);
    await seedPeople(db, DEFAULT_PEOPLE_SEED, { clock });
    repo = createPeopleRepository({ clock, schema: handle.schema });
    identity = createIdentityDouble(db);
    identity.seedAccounts(accountsForSeed(DEFAULT_PEOPLE_SEED));
    createOutbox({ service: SERVICE, db, publisher: createCapturingPublisher(), logger, clock, payloadValidators: peoplePayloadValidators });
    const instant = (): Promise<void> => Promise.resolve();
    const roster: RosterDeps = { db, repo, events: createPeopleEvents(repo), identity, clock, faults: createFaultHooks({}, {}), sleep: instant };
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8112',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: process.env.TZ ?? 'UTC',
      }),
      verifierOverride: testVerifier(SERVICE),
      clock,
      pool: db,
      logger,
    });
    await registerLegacyApiRoutes(app, {
      db,
      repository: repo,
      identity,
      clock,
      roster,
      search: { db, repo, identity, clock, sleep: instant },
      addresses: { db, repo, clock, fence: personFence },
      legacy: SETTINGS,
    });
    await app.ready();
    // Identity's CSRF consume, the only service call the routes make through the app's client.
    const request = async (req: ServiceRequest) => {
      if (req.service !== 'identity' || req.path !== CSRF_CONSUME_PATH) throw new Error(`unexpected call ${req.service} ${req.path}`);
      consumed.push(req.json as CsrfConsumeRequest);
      return { status: 200, headers: {}, body: { valid: csrfValid } };
    };
    Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  beforeEach(() => {
    consumed.length = 0;
    identity.calls.length = 0;
    csrfValid = true;
  });

  /** The gateway's invocation credential, with `actor`'s user token when one acts. */
  async function headersFor(actor?: TestActor): Promise<Record<string, string>> {
    const gateway = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    if (actor === undefined) return { [INVOCATION_HEADER]: gateway };
    const user = await mintUserToken({ sub: actor.sub, sid: `SESSION-${actor.sub}`, site: actor.site, roles: actor.roles, s2: actor.s2 });
    return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: gateway };
  }

  /** Sends one request, checks the answer against the contract and the legacy wire headers, and returns its JSON body. */
  async function send(method: Method, url: string, actor?: TestActor, form?: Record<string, string>, extra: Record<string, string> = {}) {
    const headers = { ...(await headersFor(actor)), ...(form === undefined ? {} : FORM), ...extra };
    const res = await app.inject({ method, url, headers, ...(form === undefined ? {} : { payload: new URLSearchParams(form).toString() }) });
    assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    if (res.statusCode !== 503) expect(res.headers.etag).toMatch(ETAG);
    return { status: res.statusCode, headers: res.headers, body: res.json() as Record<string, unknown> };
  }

  /** The stored person `userId` of tenant-a. */
  async function storedPerson(userId: string) {
    return withTenant(db, TENANT_A.tenantId, (tx) => repo.findPerson(tx, userId));
  }

  /** tenant-a's stored addresses of `userId`. */
  async function storedAddresses(userId: string) {
    return withTenant(db, TENANT_A.tenantId, (tx) => repo.listAddresses(tx, userId));
  }

  describe('contract binding', () => {
    const SERVED = [
      ...['address', 'user'].flatMap((entity) =>
        ['findall', 'findmany', 'findnew', 'findone', 'findpermissions', 'findproperties', 'findquery', 'save', 'validate'].map((op) => `${entity}.${op}`),
      ),
      'user.~pollstate',
    ];

    /** Every operation the contract tags `legacy-api`, with its family and Fastify path. */
    function legacyOperations() {
      const paths = (OPENAPI as { paths: Record<string, Record<string, Record<string, unknown> | undefined>> }).paths;
      return Object.entries(paths).flatMap(([path, item]) =>
        (['get', 'post', 'put', 'delete'] as const).flatMap((verb) => {
          const op = item[verb];
          if (op === undefined || !(op.tags as string[] | undefined)?.includes('legacy-api')) return [];
          return [{ verb, path, family: path.split('/')[2] ?? '', url: (op['x-opt2-fastify-path'] as string | undefined) ?? path, op }];
        }),
      );
    }

    it('registers every legacy-api operation as a public service route serving the declared keys', () => {
      const operations = legacyOperations();
      expect(operations).toHaveLength(60);
      for (const { verb, family, url, op } of operations) {
        expect(app.hasRoute({ method: verb.toUpperCase() as Method, url })).toBe(true);
        expect(op).toMatchObject({ 'x-opt2-transport': 'service', 'x-opt2-public': true });
        const prefix = family === 'rest' ? 'rest' : 'api';
        expect([...(op['x-opt2-route-keys'] as string[])].sort()).toEqual(SERVED.map((key) => `${prefix}:${key}`).sort());
      }
    });
  });

  describe('route resolution', () => {
    it('answers a key of an entity people does not own with the legacy 404 envelope', async () => {
      const res = await send('GET', `${API}/content`, SITE_ADMIN_A);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid method call' } });
    });

    it.each([
      ['a user delete', 'DELETE', `${API}/user/${SYSTEM_USER_A_PERSON.userid}`, undefined],
      ['an address delete', 'DELETE', `${API}/address/${SYSTEM_USER_A_PERSON.userid}`, undefined],
      ['a user save that removes a photo', 'POST', `${API}/user`, { ...CSRF, userid: SYSTEM_USER_A_PERSON.userid, removePhotoFile: 'true' }],
      ['a user save with extended data', 'POST', `${API}/user`, { ...CSRF, userid: SYSTEM_USER_A_PERSON.userid, extendSetID: 'SET' }],
      ['an address save with extended data', 'POST', `${API}/address`, { ...CSRF, userid: SYSTEM_USER_A_PERSON.userid, extendSetID: '' }],
    ] as const)('withholds %s with the legacy 503 before executing', async (_name, method, url, form) => {
      const before = await storedPerson(SYSTEM_USER_A_PERSON.userid);
      const res = await send(method, url, SITE_ADMIN_A, form === undefined ? undefined : { ...form });
      expect(res.status).toBe(503);
      expect(consumed).toEqual([]);
      expect(await storedPerson(SYSTEM_USER_A_PERSON.userid)).toEqual(before);
    });

    it('answers pollState anonymously, reporting the method as the request spells it', async () => {
      const res = await send('GET', `${API}/user/pollstate`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ apiversion: 'v1', method: 'pollstate', data: { loggedin: false } });
      expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    });

    it('resolves an unregistered siteid against site default, as legacy does', async () => {
      const res = await send('GET', '/_api/json/v1/no-such-site/user/pollState', SITE_ADMIN_A);
      expect(res.status).toBe(403);
      const anonymous = await send('GET', '/_api/json/v1/no-such-site/user/pollState');
      expect(anonymous.status).toBe(400);
      expect(anonymous.body).toEqual({ apiversion: 'v1', method: 'invalid', error: { message: 'Invalid parameters', code: 'invalid_request' } });
    });

    it.each([
      ['the API site', '/_api/json/v1/tenant-b/user'],
      ['a supplied siteid', `${API}/user?siteid=${TENANT_B.siteId}`],
    ])('refuses another tenant named by %s with 403', async (_name, url) => {
      const res = await send('GET', url, SITE_ADMIN_A);
      expect(res.status).toBe(403);
    });

    it('echoes an Origin on a registered site domain', async () => {
      const allowed = await send('GET', `${API}/user/pollState`, undefined, undefined, { origin: 'https://tenant-a.opt2.test' });
      expect(allowed.headers['access-control-allow-origin']).toBe('https://tenant-a.opt2.test');
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      const foreign = await send('GET', `${API}/user/pollState`, undefined, undefined, { origin: 'https://elsewhere.example' });
      expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('answers a resolution failure in the legacy error map', async () => {
      const res = await send('GET', `${API}/user/${SYSTEM_USER_A_PERSON.userid},${SITE_ADMIN_A_PERSON.userid}`, SITE_ADMIN_A);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid method call' } });
    });
  });

  describe('REST mode', () => {
    it('asks an anonymous REST caller for Basic credentials', async () => {
      const res = await send('GET', '/_api/rest/v1/tenant-a/user/new');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Basic');
      expect(res.body).toEqual({ apiversion: 'v1', method: 'invalid', error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } });
    });

    it('answers server_error for a registered site, whose sessionless event legacy cannot build', async () => {
      const res = await send('GET', '/_api/rest/v1/tenant-a/user/new', SITE_ADMIN_A);
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: { code: 'server_error' } });
    });
  });

  describe('reads', () => {
    it.each([
      ['anonymous', undefined],
      ['a system user without the Users module', SYSTEM_USER_A],
    ])('refuses %s with the authorization error', async (_name, actor) => {
      const res = await send('GET', `${API}/user/${SITE_ADMIN_A_PERSON.userid}`, actor);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } });
    });

    it.each([
      ['a stored user', 'user', SYSTEM_USER_A_PERSON.userid],
      ['a stored address', 'address', ''],
    ])('denies an anonymous session every permission of %s, as its owner is not the caller', async (_name, entity, id) => {
      const [address] = await storedAddresses(SYSTEM_USER_A_PERSON.userid);
      const res = await send('GET', `${API}/${entity}/${id === '' ? address?.addressid : id}/permissions`, ANONYMOUS);
      expect(res.body).toEqual({ apiversion: 'v1', method: 'findPermissions', data: { read: false, delete: false, save: false } });
    });

    it.each([
      ['findNew', `${API}/address/new`],
      ['findOne', `${API}/user/${SYSTEM_USER_A_PERSON.userid}`],
      ['validate', `${API}?method=validate&entityname=user&data=${encodeURIComponent('{"entityname":"address"}')}`],
    ])('refuses %s to an anonymous session, reporting the method', async (method, url) => {
      const res = await send('GET', url, ANONYMOUS);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ apiversion: 'v1', method, error: { message: 'Insufficient Account Permissions', code: 'invalid_request' } });
    });

    it('reads a stored user with its addresses, memberships and links', async () => {
      const res = await send('GET', `${API}/user/${SYSTEM_USER_A_PERSON.userid}?fields=userid,fname,addresses,links`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      const data = res.body.data as Record<string, unknown>;
      expect(data).toMatchObject({ userid: SYSTEM_USER_A_PERSON.userid, fname: 'Sydney' });
      expect(data.links).toMatchObject({ self: `${ENDPOINT}/user/${SYSTEM_USER_A_PERSON.userid}` });
    });

    it('reads every field of a stored user with the Users module alone', async () => {
      const res = await send('GET', `${API}/user/${SYSTEM_USER_A_PERSON.userid}`, USERS_MODULE_ONLY);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ userid: SYSTEM_USER_A_PERSON.userid, lname: 'System', siteid: TENANT_A.siteId, isnew: 0 });
    });

    it('reads an unknown id as a new bean, not a 404', async () => {
      const res = await send('GET', `${API}/user/00000000-0000-0000-0000000000000000`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ isnew: 1, siteid: TENANT_A.siteId });
    });

    it.each([['user'], ['address']])('reads a new %s bean', async (entity) => {
      const res = await send('GET', `${API}/${entity}/new`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ method: 'findNew', data: { siteid: TENANT_A.siteId } });
    });

    it.each([['user'], ['address']])('lists the %s properties, the table only for an administrator', async (entity) => {
      const admin = await send('GET', `${API}/${entity}/properties`, SITE_ADMIN_A);
      expect(admin.status).toBe(200);
      expect(admin.body.data).toMatchObject({ entityname: entity, public: false, table: entity === 'user' ? 'tusers' : 'tuseraddresses' });
      const anonymous = await send('GET', `${API}/${entity}/properties?properties=siteid`);
      expect(anonymous.body.data).not.toHaveProperty('table');
      expect((anonymous.body.data as { properties: unknown[] }).properties).toHaveLength(1);
    });

    it('answers server_error for a property the bean does not define', async () => {
      const res = await send('GET', `${API}/user/properties?properties=nosuchproperty`);
      expect(res.status).toBe(500);
    });

    it('reports permissions of a stored user', async () => {
      const own = await send('GET', `${API}/user/${SELF_SAVER.sub}/permissions`, SELF_SAVER);
      expect(own.body).toMatchObject({ method: 'findPermissions', data: { read: false, delete: true, save: true } });
      const admin = await send('GET', `${API}/user/${SYSTEM_USER_A_PERSON.userid}/permissions`, SITE_ADMIN_A);
      expect(admin.body.data).toEqual({ read: true, delete: true, save: true });
      // An anonymous caller's empty user id equals a new address bean's, so AllowAction admits it.
      const anonymous = await send('GET', `${API}/address/${SYSTEM_USER_A_PERSON.userid}/permissions`);
      expect(anonymous.body.data).toEqual({ read: false, delete: true, save: true });
    });

    it('reads a stored address and expands its user', async () => {
      const [address] = await storedAddresses(SYSTEM_USER_A_PERSON.userid);
      const res = await send('GET', `${API}/address/${address?.addressid}?expand=user`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      const data = res.body.data as Record<string, unknown>;
      expect(data).toMatchObject({ addressid: address?.addressid, userid: SYSTEM_USER_A_PERSON.userid });
      expect(data.user).toMatchObject({ userid: SYSTEM_USER_A_PERSON.userid });
    });

    it('lists the site users as a paged collection', async () => {
      const res = await send('GET', `${API}/user?itemsPerPage=2&isPublic=0`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      const data = res.body.data as Record<string, unknown>;
      expect(data).toMatchObject({ entityname: 'user', itemsperpage: 2, pageindex: 1 });
      expect((data.items as unknown[]).length).toBeLessThanOrEqual(2);
      expect(data.links).toHaveProperty('self');
    });

    it('queries users by a url param', async () => {
      const res = await send('GET', `${API}/user?lname=System`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      const items = (res.body.data as { items: { userid: string }[] }).items;
      expect(items.map((item) => item.userid)).toEqual([SYSTEM_USER_A_PERSON.userid]);
    });

    it('queries users by a like pattern and a sort', async () => {
      const res = await send('GET', `${API}/user?email=*tenant-a.opt2.test&sort=-lname`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      const items = (res.body.data as { items: { lname: string }[] }).items;
      const names = items.map((item) => item.lname);
      expect(names).toEqual([...names].sort().reverse());
    });

    it('finds many users in the order of the ids', async () => {
      const ids = [SYSTEM_USER_A_PERSON.userid, SITE_ADMIN_A_PERSON.userid];
      const res = await send('GET', `${API}?method=findMany&entityname=user&ids=${ids.join(',')}&isPublic=0`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      expect(res.body.method).toBe('findMany');
    });

    it('finds many addresses of the site', async () => {
      const addresses = await storedAddresses(SYSTEM_USER_A_PERSON.userid);
      const ids = addresses.map((address) => address.addressid);
      const res = await send('GET', `${API}?method=findMany&entityname=address&ids=${ids.join(',')}`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      const items = (res.body.data as { items: { addressid: string }[] }).items;
      expect(items.map((item) => item.addressid).sort()).toEqual([...ids].sort());
    });

    it.each([
      ['an address feed', `${API}/address`],
      ['a grouped user query', `${API}/user?openGrouping=1`],
      ['a custom user ordering', `${API}/user?sort=jobtitle`],
    ])('refuses %s, which reads data people does not hold, with the legacy 503', async (_name, url) => {
      const res = await send('GET', url, SITE_ADMIN_A);
      expect(res.status).toBe(503);
    });

    it.each([
      ['a count-only feed', `${API}/user?countOnly=true`],
      ['an offset', `${API}/user?offset=2`],
      ['a negative limit', `${API}/user?limit=-1`],
    ])('answers %s with server_error, as legacy fails it', async (_name, url) => {
      const res = await send('GET', url, SITE_ADMIN_A);
      expect(res.status).toBe(500);
    });
  });

  describe('validate', () => {
    it('validates an address bean as data names it', async () => {
      const data = JSON.stringify({ entityname: 'address', addressid: 'new', addressname: 'Home' });
      const res = await send('GET', `${API}?method=validate&entityname=address&data=${encodeURIComponent(data)}`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      expect(res.body.method).toBe('validate');
    });

    it('reports an empty user name as legacy formats its message', async () => {
      const data = JSON.stringify({ entityname: 'user', userid: 'new', fname: 'Pat', lname: 'Lee', email: 'pat@example.com' });
      const res = await send('GET', `${API}?method=validate&entityname=user&data=${encodeURIComponent(data)}`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ username: "The username '{1}' that you entered is being used by another user." });
    });

    it.each([
      ['malformed JSON', 'not-json', 400],
      ['a non-struct argument', '[1]', 200],
      ['a stored user, whose user name is checked against identity accounts', JSON.stringify({ entityname: 'user', userid: SYSTEM_USER_A_PERSON.userid }), 503],
      ['an entity of another owner', JSON.stringify({ entityname: 'content' }), 503],
    ])('answers %s', async (_name, data, status) => {
      const res = await send('GET', `${API}?method=validate&entityname=user&data=${encodeURIComponent(data)}`, SITE_ADMIN_A);
      expect(res.status).toBe(status);
    });
  });

  describe('user save', () => {
    it('lets a user save their own record without the Users module, under the roster protocol', async () => {
      const userId = SELF_SAVER.sub;
      const before = await storedPerson(userId);
      const res = await send('POST', `${API}/user`, SELF_SAVER, {
        ...CSRF,
        userid: userId,
        siteid: TENANT_A.siteId,
        fname: 'Cassie',
        lname: before?.lname ?? '',
        email: before?.email ?? '',
        username: 'casey',
        isPublic: '1',
        s2: '1',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ userid: userId, fname: 'Cassie', saveerrors: '', errors: {} });
      expect((await storedPerson(userId))?.fname).toBe('Cassie');
      expect(consumed).toEqual([expect.objectContaining({ sessionId: `SESSION-${userId}`, context: 'new', token: 'TOKEN' })]);
      expect(identity.calls).toEqual(expect.arrayContaining(['prepare', 'commit', 'finish']));
    });

    it("refuses a save of another user's record without the Users module", async () => {
      const before = await storedPerson(SITE_ADMIN_A_PERSON.userid);
      const res = await send('POST', `${API}/user`, SYSTEM_USER_A, { ...CSRF, userid: SITE_ADMIN_A_PERSON.userid, fname: 'Mallory' });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: { code: 'invalid_request' } });
      expect(await storedPerson(SITE_ADMIN_A_PERSON.userid)).toEqual(before);
      expect(identity.calls).not.toContain('prepare');
    });

    it.each([
      ['anonymous, without a session token', undefined, true],
      ['a token legacy would not accept', SITE_ADMIN_A, false],
    ])('answers invalidTokens for %s', async (_name, actor, valid) => {
      csrfValid = valid;
      const res = await send('POST', `${API}/user`, actor, { ...CSRF, userid: SYSTEM_USER_A_PERSON.userid, fname: 'Nobody' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid CSRF tokens' } });
    });

    it("answers 403 with the request values when a save of another record loses its email", async () => {
      const userId = cfUuid();
      const res = await send('POST', `${API}/user`, SITE_ADMIN_A, { ...CSRF, userid: userId, fname: 'Pat', lname: 'Lee', email: 'pat@tenant-a.opt2.test', username: 'patlee' });
      expect(res.status).toBe(403);
      const data = res.body.data as Record<string, unknown>;
      expect(data).toMatchObject({ fname: 'Pat', lname: 'Lee', email: '', saveerrors: '' });
      expect(data.errors).toHaveProperty('email');
      expect(await storedPerson(userId)).toBeNull();
      expect(identity.calls).not.toContain('commit');
    });

    it('creates a user as a site administrator', async () => {
      const prepare = identity.prepare;
      // Identity's double lists the account its commit creates.
      identity.prepare = (userId, operationId, change) => {
        identity.seedAccounts([accountFor({ userid: userId, siteid: TENANT_A.siteId, email: 'new_person@tenant-a.opt2.test' })]);
        return prepare(userId, operationId, change);
      };
      try {
        const res = await send('POST', `${API}/user`, SITE_ADMIN_A, {
          ...CSRF,
          fname: 'New',
          lname: 'Person',
          email: 'new_person@tenant-a.opt2.test',
          username: 'new_person',
          isPublic: '0',
        });
        expect(res.status).toBe(200);
        const data = res.body.data as { userid: string };
        expect(res.body.data).toMatchObject({ fname: 'New', email: 'new_person@tenant-a.opt2.test', errors: {} });
        expect(await storedPerson(data.userid)).toMatchObject({ lname: 'Person', email: 'new_person@tenant-a.opt2.test' });
        expect(consumed.map((call) => call.context)).toEqual(['new']);
      } finally {
        identity.prepare = prepare;
      }
    });
  });

  describe('address save', () => {
    it('adds an address to a user as a site administrator', async () => {
      const res = await send('POST', `${API}/address`, SITE_ADMIN_A, { ...CSRF, userid: SYSTEM_USER_A_PERSON.userid, addressname: 'Cabin', city: 'Bergen' });
      expect(res.status).toBe(200);
      const data = res.body.data as { addressid: string };
      expect(res.body.data).toMatchObject({ addressname: 'Cabin', city: 'Bergen', userid: SYSTEM_USER_A_PERSON.userid });
      expect((await storedAddresses(SYSTEM_USER_A_PERSON.userid)).map((address) => address.addressid)).toContain(data.addressid);
    });

    it("updates the caller's own address without the Users module", async () => {
      const res = await send('POST', `${API}/address`, SELF_SAVER, { ...CSRF, userid: SELF_SAVER.sub, addressname: 'Flat', city: 'Oslo' });
      expect(res.status).toBe(200);
      const { addressid } = res.body.data as { addressid: string };
      const update = await send('PUT', `${API}/address/${addressid}`, SELF_SAVER, { ...CSRF, addressid, userid: SELF_SAVER.sub, addressname: 'Flat', city: 'Trondheim' });
      expect(update.status).toBe(200);
      expect(consumed.map((call) => call.context)).toEqual(['new', addressid]);
      expect((await storedAddresses(SELF_SAVER.sub)).find((address) => address.addressid === addressid)?.city).toBe('Trondheim');
    });

    it("refuses an address of another user's record without the Users module", async () => {
      const res = await send('POST', `${API}/address`, SELF_SAVER, { ...CSRF, userid: SITE_ADMIN_A_PERSON.userid, addressname: 'Intrusion' });
      expect(res.status).toBe(401);
    });
  });
});

describe('legacyApiSettings', () => {
  it('reads the MURA variables and defaults the rest', () => {
    expect(legacyApiSettings({})).toEqual({ adminSSL: false, context: '', appReloadKey: 'appreload', adminDomain: '' });
    expect(
      legacyApiSettings({ MURA_ADMINSSL: 'true', MURA_PORT: '8080', MURA_CONTEXT: '/masa/', MURA_APPRELOADKEY: 'reload', MURA_ADMINDOMAIN: 'admin.example' }),
    ).toEqual({ adminSSL: true, serverPort: ':8080', context: '/masa', appReloadKey: 'reload', adminDomain: 'admin.example' });
    expect(legacyApiSettings({ MURA_PORT: '443', MURA_CONTEXT: '${context}' })).toMatchObject({ serverPort: '', context: '' });
  });

  it('names each malformed variable', () => {
    expect(() => legacyApiSettings({ MURA_ADMINSSL: 'maybe', MURA_PORT: '99999' })).toThrow(/MURA_ADMINSSL[\s\S]*MURA_PORT|MURA_PORT[\s\S]*MURA_ADMINSSL/);
  });
});
