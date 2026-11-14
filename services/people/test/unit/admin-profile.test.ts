/** The Edit Profile routes through `app.inject` over a throwaway `people` schema and an identity double. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import {
  CSRF_CONSUME_PATH,
  createService,
  fixedClock,
  loadEnv,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type ServiceRequest,
} from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  createCapturingPublisher,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { EXTEND_CONFIG_DEFAULTS, saveExtendedData } from '../../src/domain/extended-data.js';
import { createFaultHooks } from '../../src/domain/faults.js';
import { normaliseParams } from '../../src/domain/person.js';
import type { RosterDeps } from '../../src/domain/roster-protocol.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { peoplePayloadValidators } from '../../src/events/topics.js';
import type { AccountPrepareRequest, AccountView, IdentityClient, LegacyErrors } from '../../src/legacy/identity-client.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';
import { EXTEND_ATTRIBUTE, EXTEND_SET, EXTEND_SUBTYPE, PEOPLE_UNITS } from '../../src/repo/tables.js';
import { registerAdminProfileRoutes } from '../../src/routes/admin-profile.js';

const SERVICE = 'people';
const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const CLOCK = fixedClock(NOW);
const OPENAPI = parse(readFileSync(fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url)), 'utf8')) as object;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const CATEGORY = cfUuid();
const instant = (): Promise<void> => Promise.resolve();

/** A stored user, its primary address and identity's account of it. */
interface SeededUser {
  userId: string;
  addressId: string;
  account: AccountView;
}

describe.skipIf(!(await pgAvailable()))('Edit Profile routes', () => {
  let handle: ThrowawaySchema;
  let db: TenantDb;
  let repo: PeopleRepository;
  let app: FastifyInstance;
  const accounts = new Map<string, AccountView>();
  const identityCalls: string[] = [];
  const prepared: AccountPrepareRequest[] = [];
  const consumed: CsrfConsumeRequest[] = [];
  let csrfValid = true;
  let prepareErrors: LegacyErrors | undefined;
  const logger = createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } });

  /** An identity double that holds `accounts`, accepts every account step and refuses membership reads, which a profile makes none of. */
  const identity: IdentityClient = {
    async prepare(userId, operationId, change) {
      identityCalls.push('prepare');
      prepared.push(change);
      if (prepareErrors !== undefined) return { ok: false, errors: prepareErrors };
      return { ok: true, operationId, userId, kind: change.kind, state: 'prepared' };
    },
    async commit(userId, operationId) {
      identityCalls.push('commit');
      return { operationId, userId, state: 'committed', writePosition: '42' };
    },
    async abort() {
      identityCalls.push('abort');
    },
    async finish() {
      identityCalls.push('finish');
    },
    revert: () => Promise.reject(new Error('unexpected revert')),
    operationState: () => Promise.reject(new Error('unexpected operationState')),
    async readAccount(userId) {
      identityCalls.push('readAccount');
      return accounts.get(userId);
    },
    readAccounts: () => Promise.reject(new Error('unexpected readAccounts')),
    readAccountsAllSites: () => Promise.reject(new Error('unexpected readAccountsAllSites')),
    countAccounts: () => Promise.reject(new Error('unexpected countAccounts')),
    usernameCandidates: () => Promise.reject(new Error('unexpected usernameCandidates')),
    lookupMemberships: () => Promise.reject(new Error('identity lists memberships only to cUsers callers')),
    userMemberships: () => Promise.reject(new Error('identity lists memberships only to cUsers callers')),
    membershipGroupIds: () => Promise.reject(new Error('unexpected membershipGroupIds')),
    siteGroups: () => Promise.reject(new Error('unexpected siteGroups')),
    userGroups: () => Promise.reject(new Error('unexpected userGroups')),
    loginBlock: () => Promise.reject(new Error('unexpected loginBlock')),
    async actingUser() {
      identityCalls.push('actingUser');
      return undefined;
    },
    adminSessionState: () => Promise.resolve({}),
    saveAdminSessionState: (state) => Promise.resolve(state),
    sessionSites: () => Promise.resolve([]),
  };

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: SERVICE, migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    db = handle.app;
    await ensureUnitGates(db, PEOPLE_UNITS);
    await closeGates(db, { units: PEOPLE_UNITS, holderId: 'admin-profile-test', allowLegacy: true });
    await openGates(db, { units: PEOPLE_UNITS, holderId: 'admin-profile-test', state: 'open' });
    await seedRegistry(db);
    repo = createPeopleRepository({ clock: CLOCK, schema: handle.schema });
    createOutbox({ service: SERVICE, db, publisher: createCapturingPublisher(), logger, clock: CLOCK, payloadValidators: peoplePayloadValidators });
    const roster: RosterDeps = { db, repo, events: createPeopleEvents(repo), identity, clock: CLOCK, faults: createFaultHooks({}, {}), sleep: instant };
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
      pool: db,
      logger,
    });
    await registerAdminProfileRoutes(app, { roster });
    await app.ready();
    // Identity's CSRF consume, which the route's preHandler calls through the app's service client.
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
    identityCalls.length = 0;
    prepared.length = 0;
    consumed.length = 0;
    csrfValid = true;
    prepareErrors = undefined;
  });

  /** A Type=2 user of `site`'s user pool with a primary address and one interest. */
  async function seedUser(site: string, isPublic: 0 | 1): Promise<SeededUser> {
    const userId = cfUuid();
    const addressId = cfUuid();
    await db.withTenant(TENANT_A.siteId === site ? TENANT_A.tenantId : TENANT_UMBRELLA.tenantId, async (tx) => {
      await repo.insertPerson(tx, {
        userid: userId, groupname: '', fname: 'Pat', lname: 'Lee', email: 'pat@example.com', company: 'Acme', jobtitle: '',
        mobilephone: '', website: '', subtype: 'Default', contactform: '', lastupdateby: 'Pat Lee', lastupdatebyid: userId,
        siteid: site, subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '',
        imservice: '', tags: '',
      });
      await repo.insertAddress(tx, { userid: userId, addressid: addressId, siteid: site, addressname: 'Home', city: 'Oslo', isprimary: 1 });
      await repo.replaceInterests(tx, userId, [CATEGORY]);
    });
    const account: AccountView = {
      userId, siteId: site, username: 'pat', s2: 0, isPublic, inactive: 0, type: 2, perm: 0, admin: 0, remoteId: null,
      lastLogin: '2026-06-29T08:30:00.000', passwordCreated: null, tablist: null,
    };
    accounts.set(userId, account);
    return { userId, addressId, account };
  }

  /** The user token of `userId` on `site`'s admin, S2 when `roles` hold `s2`, with the gateway's invocation credential. */
  async function headersFor(userId: string, roles: string[] = [Roles.systemUser], site: string = TENANT_A.siteId): Promise<Record<string, string>> {
    const [user, gateway] = await Promise.all([
      mintUserToken({ sub: userId, sid: `SESSION-${userId}`, site, roles, s2: roles.includes(Roles.s2) }),
      mintServiceToken({ caller: 'gateway', audience: SERVICE }),
    ]);
    return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${gateway}` };
  }

  /** Sends one request and checks the answer against the contract. */
  async function send(method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: string) {
    const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  /** A profile form post with a CSRF pair. */
  function profileForm(fields: Record<string, string>): string {
    return new URLSearchParams({ csrf_token: 'TOKEN', csrf_token_expires: '260630110000000', ...fields }).toString();
  }

  /** The person's stored first name and job title in `tenantId`. */
  async function storedPerson(userId: string, tenantId = TENANT_A.tenantId) {
    const person = await db.withTenant(tenantId, (tx) => repo.findPerson(tx, userId));
    return { fname: person?.fname ?? null, jobtitle: person?.jobtitle ?? null };
  }

  it.each([
    ['a private-pool system user', TENANT_A, 0, [Roles.systemUser]],
    ['a public-pool member', TENANT_UMBRELLA, 1, [Roles.member]],
  ] as const)('reads %s as the stored bean with every tab', async (_name, fixture, isPublic, roles) => {
    const { userId, addressId } = await seedUser(fixture.siteId, isPublic);
    const res = await send('GET', '/v1/profile', await headersFor(userId, [...roles]));
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().user)).not.toContain('PasswordCreated');
    expect(res.json()).toMatchObject({
      user: { UserID: userId, Type: 2, SiteID: fixture.siteId, Fname: 'Pat', UserName: 'pat', isPublic, LastLogin: '2026-06-29T08:30:00.000' },
      addresses: [{ addressID: addressId, userID: userId, city: 'Oslo', isPrimary: 1 }],
      categoryIds: [CATEGORY],
      errors: {},
      retained: false,
    });
    // The first read locates the user's tenant; the second is the account observed with the person rows.
    expect(identityCalls).toEqual(['readAccount', 'readAccount']);
  });

  it('refuses an anonymous caller', async () => {
    const res = await send('GET', '/v1/profile', { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}` });
    expect(res.statusCode).toBe(401);
  });

  it('saves the session user under the empty CSRF context, ignoring a posted userid and siteid, then redirects home', async () => {
    const own = await seedUser(TENANT_UMBRELLA.siteId, 1);
    const other = await seedUser(TENANT_A.siteId, 0);
    const otherBefore = await storedPerson(other.userId);
    const headers = { ...(await headersFor(own.userId, [Roles.member])), ...FORM };
    const res = await send('POST', '/v1/profile:update', headers, profileForm({
      userid: other.userId, siteid: TENANT_UMBRELLA.siteId, type: '2', isPublic: '0', fname: 'Kai', lname: 'Lee', email: 'kai@example.com', jobtitle: 'Analyst',
    }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ written: true, redirect: { action: 'home.redirect', params: {} }, errors: {} });
    expect(consumed).toEqual([{ sessionId: `SESSION-${own.userId}`, token: 'TOKEN', expires: '260630110000000', context: '' }]);
    expect(await storedPerson(own.userId, TENANT_UMBRELLA.tenantId)).toEqual({ fname: 'Kai', jobtitle: 'Analyst' });
    expect(await storedPerson(other.userId)).toEqual(otherBefore);
  });

  it("reads and saves an S2 user's own profile under a token of a site whose user pools do not hold the account", async () => {
    const { userId } = await seedUser(TENANT_A.siteId, 0);
    const headers = await headersFor(userId, [Roles.systemUser, Roles.s2], TENANT_B.siteId);

    const read = await send('GET', `/v1/profile?siteid=${TENANT_B.siteId}`, headers);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ user: { UserID: userId, SiteID: TENANT_A.siteId, Fname: 'Pat' }, addresses: [{ city: 'Oslo' }] });

    const res = await send('POST', '/v1/profile:update', { ...headers, ...FORM }, profileForm({ fname: 'Kai', lname: 'Lee', email: 'kai@example.com', jobtitle: 'Analyst' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ written: true, redirect: { action: 'home.redirect', params: {} }, errors: {} });
    expect(prepared).toMatchObject([{ kind: 'update', siteId: TENANT_A.siteId, account: { isPublic: 0 }, updateGroups: false }]);
    expect(await storedPerson(userId)).toEqual({ fname: 'Kai', jobtitle: 'Analyst' });
  });

  it('re-renders the posted values with legacy\'s errors and writes nothing', async () => {
    const { userId } = await seedUser(TENANT_A.siteId, 0);
    const before = await storedPerson(userId);
    prepareErrors = { username: "The username 'robin' that you entered is being used by another user." };
    const res = await send('POST', '/v1/profile:update', { ...(await headersFor(userId)), ...FORM }, profileForm({ fname: 'Robin', usernameNoCache: 'robin' }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ written: false, userBean: { UserID: userId, Fname: 'Robin', Email: '' } });
    expect(Object.keys(body.userBean)).not.toContain('PasswordCreated');
    expect(body.redirect).toBeUndefined();
    expect(Object.keys(body.errors).sort()).toEqual(['email', 'username']);
    expect(await storedPerson(userId)).toEqual(before);
  });

  it.each([
    ['a photo upload', { newFile: 'me.png' }],
    ['a photo removal', { removePhotoFile: 'true' }],
    ['extended attributes', { extendSetID: cfUuid() }],
  ])('answers %s with the legacy 503 before consuming the token', async (_name, fields) => {
    const { userId } = await seedUser(TENANT_A.siteId, 0);
    const before = await storedPerson(userId);
    const res = await send('POST', '/v1/profile:update', { ...(await headersFor(userId)), ...FORM }, profileForm({ fname: 'Kai', email: 'kai@example.com', ...fields }));
    expect(res.statusCode).toBe(503);
    expect(consumed).toEqual([]);
    expect(await storedPerson(userId)).toEqual(before);
  });

  it('fails as legacy does on the unset user bean when the token is refused, writing nothing', async () => {
    const { userId } = await seedUser(TENANT_A.siteId, 0);
    const before = await storedPerson(userId);
    csrfValid = false;
    const res = await send('POST', '/v1/profile:update', { ...(await headersFor(userId)), ...FORM }, profileForm({ fname: 'Kai', email: 'kai@example.com' }));
    expect(res.statusCode).toBe(500);
    expect(identityCalls).toEqual([]);
    expect(await storedPerson(userId)).toEqual(before);
  });

  it('lists the active user subtypes of the site and the stored and default extended values', async () => {
    const { userId } = await seedUser(TENANT_A.siteId, 0);
    const [active, inactive, setId] = [cfUuid(), cfUuid(), cfUuid()];
    await db.withTenant(TENANT_A.tenantId, async (tx) => {
      await repo.insert(tx, EXTEND_SUBTYPE.table, { subtypeid: active, siteid: TENANT_A.siteId, basetable: 'tusers', type: '2', subtype: 'Default', isactive: 1 });
      await repo.insert(tx, EXTEND_SUBTYPE.table, { subtypeid: inactive, siteid: TENANT_A.siteId, basetable: 'tusers', type: '2', subtype: 'Staff', isactive: 0 });
      await repo.insert(tx, EXTEND_SET.table, { extendsetid: setId, subtypeid: active, siteid: TENANT_A.siteId, orderno: 1 });
      const attributes = [[9101, 'Nickname', null, null], [9102, 'Birthday', 'Date', null], [9103, 'Team', null, 'Blue']] as const;
      for (const [attributeid, name, validation, defaultvalue] of attributes) {
        await repo.insert(tx, EXTEND_ATTRIBUTE.table, { attributeid, extendsetid: setId, siteid: TENANT_A.siteId, name, type: 'TextBox', validation, orderno: attributeid, defaultvalue });
      }
      const input = normaliseParams({ extendSetID: setId, nickname: 'Pat', birthday: '06/30/2026' });
      await saveExtendedData(repo, tx, userId, input, { siteId: TENANT_A.siteId, config: EXTEND_CONFIG_DEFAULTS, write: {} });
    });
    const res = await send('GET', '/v1/profile', await headersFor(userId));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      subTypes: [{ subTypeID: active, type: '2', subType: 'Default' }],
      extendedAttributes: { Nickname: 'Pat', Birthday: '2026-06-30T00:00:00.000', Team: 'Blue' },
    });
  });

  it('saves a multipart form whose file input was left empty', async () => {
    const { userId } = await seedUser(TENANT_A.siteId, 0);
    const boundary = 'opt2-profile-boundary';
    const field = (name: string, value: string): string => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const payload =
      field('fname', 'Kai') + field('email', 'kai@example.com') + field('csrf_token', 'TOKEN') + field('csrf_token_expires', '260630110000000') +
      `--${boundary}\r\nContent-Disposition: form-data; name="newFile"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--${boundary}--\r\n`;
    const headers = { ...(await headersFor(userId)), 'content-type': `multipart/form-data; boundary=${boundary}` };
    const res = await send('POST', '/v1/profile:update', headers, payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ written: true, errors: {} });
    expect(await storedPerson(userId)).toMatchObject({ fname: 'Kai' });
  });

  it.each([
    ['a user identity does not hold', 'none'],
    ['an account whose site the registry does not list', 'unregistered'],
    ['an account without a person row', 'no-person'],
  ] as const)('answers %s with the legacy 503', async (_name, kind) => {
    const userId = cfUuid();
    if (kind !== 'none') {
      const { account } = await seedUser(TENANT_A.siteId, 0);
      accounts.set(userId, { ...account, userId, siteId: kind === 'unregistered' ? 'nowhere' : TENANT_A.siteId });
    }
    const res = await send('GET', '/v1/profile', await headersFor(userId));
    expect(res.statusCode).toBe(503);
  });
});
