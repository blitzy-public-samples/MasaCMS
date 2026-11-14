/** People's Masa JSON API `user` and `address` routes through `buildTestApp` and `app.inject`: wire format, route ownership, denials, reads and roster-protocol saves. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN, LEGACY_ERROR_MAP, WWW_AUTHENTICATE, etag, isCfUuid, legacyHeaders } from '@opt2/platform/legacy-compat';
import { ROLE_SET, TENANT_A, TENANT_B, TENANT_UMBRELLA, fixtureForSite, registryPayloads, type RoleSubject } from '@opt2/platform/testing';
import {
  PG_AVAILABLE,
  buildTestApp,
  headersFor,
  userHeaders,
  withPgApp,
  type PgTestApp,
  type RecordingDb,
  type TestApp,
} from '../helpers/app.js';
import type { IdentityDouble, RecordedIdentityRequest } from '../helpers/identity-double.js';
import {
  ADMIN_S2,
  CSV_QUIRK_PERSONS,
  DEFAULT_PEOPLE_SEED,
  MEMBER_POOLED,
  MODULE_USER_A,
  OTHER_TENANT,
  SITE_ADMIN_A,
  SYSTEM_USER_A,
  accountFor,
  accountsForSeed,
  seedPeople,
  type TestActor,
} from '../helpers/fixtures.js';

type Family = 'json' | 'ajax' | 'rest';
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type LegacyErrorType = keyof typeof LEGACY_ERROR_MAP;

/** A response as `app.inject` answers it. */
interface InjectedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
}

/** The legacy JSON API envelope. */
interface Envelope {
  apiversion: string;
  method: string;
  params?: Record<string, unknown>;
  data?: Record<string, unknown>;
  error?: { message: string; code: string };
}

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

const FAMILIES = ['json', 'ajax'] as const;
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['apiversion', 'method', 'params', 'data', 'error']);
const FORM = Object.freeze({ 'content-type': 'application/x-www-form-urlencoded' });
const TOKEN = 'TEST-CSRF-TOKEN';
const TOKEN_EXPIRES = '260630130000000';
const CSRF = csrfHeaders(TOKEN);
const GROUP_ID = '6A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';

/** CSRF headers carrying `token`; identity consumes each token once per session. */
function csrfHeaders(token: string): Readonly<Record<string, string>> {
  return Object.freeze({ [CSRF_HEADER_TOKEN]: token, [CSRF_HEADER_EXPIRES]: TOKEN_EXPIRES });
}

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

/** `/_api/<family>/v1/tenant-a<rest>`. */
function apiPath(family: Family, rest: string): string {
  return `/_api/${family}/v1/${TENANT_A.siteId}${rest}`;
}

/** The session id an actor's token carries. */
function sessionOf(actor: Pick<TestActor, 'sub'>): string {
  return `SESSION-${actor.sub}`;
}

/** `actor`'s user token and the gateway's invocation credential, with the actor's session. */
function actorHeaders(actor: TestActor): Promise<Record<string, string>> {
  return userHeaders({ ...actor, sid: sessionOf(actor) });
}

/** The gateway's invocation credential alone: an anonymous browser request. */
function anonymousHeaders(): Promise<Record<string, string>> {
  const gateway: RoleSubject | undefined = ROLE_SET.find((subject) => subject.kind === 'service' && subject.caller === 'gateway');
  if (gateway === undefined) throw new Error('ROLE_SET has no gateway subject');
  return headersFor(gateway);
}

/** One injected request; a form is sent url-encoded. */
async function send(app: TestApp['app'], method: Method, url: string, headers: Record<string, string>, form?: Record<string, string>): Promise<InjectedResponse> {
  return app.inject({
    method,
    url,
    headers: { ...headers, ...(form === undefined ? {} : FORM) },
    ...(form === undefined ? {} : { payload: new URLSearchParams(form).toString() }),
  });
}

/** One injected multipart request: text fields, then a file part. */
async function sendMultipart(
  app: TestApp['app'],
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
  file: { field: string; filename: string; type: string; content: string },
): Promise<InjectedResponse> {
  const boundary = 'opt2-legacy-api-boundary';
  const parts = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n${file.content}\r\n`);
  return app.inject({
    method: 'POST',
    url,
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `${parts.join('')}--${boundary}--\r\n`,
  });
}

/** Asserts the legacy wire form of `res` at `status` and returns its envelope. */
function legacyEnvelope(res: InjectedResponse, status: number): Envelope {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers.etag).toBe(etag(res.body));
  for (const [name, value] of Object.entries(legacyHeaders())) expect(res.headers[name.toLowerCase()]).toBe(value);
  const envelope = JSON.parse(res.body) as Envelope;
  expect(envelope.apiversion).toBe('v1');
  expect(typeof envelope.method).toBe('string');
  expect(Object.keys(envelope).filter((key) => !ENVELOPE_KEYS.has(key))).toEqual([]);
  expect('data' in envelope).not.toBe('error' in envelope);
  return envelope;
}

/** Asserts the legacy error envelope of `type`, at its mapped status unless another is given. */
function legacyError(res: InjectedResponse, type: LegacyErrorType, status: number = LEGACY_ERROR_MAP[type].status): Envelope {
  const envelope = legacyEnvelope(res, status);
  const { message, code } = LEGACY_ERROR_MAP[type];
  expect(envelope.error).toEqual({ message, code });
  return envelope;
}

/** The `data` of a successful envelope. */
function dataOf(res: InjectedResponse, status = 200): Record<string, unknown> {
  const { data } = legacyEnvelope(res, status);
  if (data === undefined) throw new Error('envelope without data');
  return data;
}

/** The identity operations people called, by contract operation id. */
function operationIds(identity: IdentityDouble): string[] {
  return identity.requests.flatMap((request: RecordedIdentityRequest) => (request.operationId === undefined ? [] : [request.operationId]));
}

/** The roster steps people called on identity, in order. */
function rosterSteps(identity: IdentityDouble): string[] {
  const steps = new Set(['prepareAccountOperation', 'commitAccountOperation', 'abortAccountOperation', 'finishAccountOperation', 'revertAccountOperation']);
  return operationIds(identity).filter((id) => steps.has(id));
}

/** The fixture registry as `tenant_registry` rows, ordered by site id. */
function registryRows(): Array<Record<string, unknown>> {
  const tenantOf = (siteId: string | null | undefined): string | null =>
    siteId === null || siteId === undefined || siteId === '' ? null : (fixtureForSite(siteId)?.tenantId ?? null);
  return registryPayloads()
    .map((site) => {
      const content = Array.isArray(site.contentPoolIds) ? site.contentPoolIds : [];
      return {
        site_id: site.siteId,
        tenant_id: tenantOf(site.siteId),
        public_user_pool_id: site.publicUserPoolId ?? null,
        private_user_pool_id: site.privateUserPoolId ?? null,
        category_pool_id: site.categoryPoolId ?? null,
        file_pool_id: site.filePoolId ?? null,
        display_pool_id: site.displayPoolId ?? null,
        content_pool_ids: content,
        public_user_pool_tenant: tenantOf(site.publicUserPoolId),
        private_user_pool_tenant: tenantOf(site.privateUserPoolId),
        category_pool_tenant: tenantOf(site.categoryPoolId),
        file_pool_tenant: tenantOf(site.filePoolId),
        display_pool_tenant: tenantOf(site.displayPoolId),
        content_pool_tenants: content.map(tenantOf),
        domains: site.domains ?? [],
        aggregate_version: '1',
        updated_at: new Date(2026, 5, 30, 12),
      };
    })
    .sort((a, b) => (a.site_id < b.site_id ? -1 : a.site_id > b.site_id ? 1 : 0));
}

/** Answers registry reads of a recording database from the fixture registry. */
function respondWithRegistry(db: RecordingDb): void {
  const rows = registryRows();
  db.respond(/\bFROM \S*tenant_registry\b/i, (text, values) => {
    if (/WHERE tenant_id = \$1/i.test(text)) return rows.filter((row) => row.tenant_id === values[0]);
    if (/WHERE lower\(site_id\) = lower\(\$1\)/i.test(text)) return rows.filter((row) => String(row.site_id).toLowerCase() === String(values[0]).toLowerCase());
    return rows;
  });
}

describe('JSON API wire format, ownership and denials over the recording database', () => {
  let testApp: TestApp;
  const seededAccounts = accountsForSeed(DEFAULT_PEOPLE_SEED);
  const target = SYSTEM_USER_A.sub;

  beforeAll(async () => {
    testApp = await buildTestApp();
    respondWithRegistry(testApp.db);
  });

  afterAll(async () => {
    await testApp?.close();
  });

  beforeEach(() => {
    testApp.identity.clear();
    testApp.identity.seedAccounts(...seededAccounts);
    testApp.db.clear();
  });

  /** Asserts that nothing reached identity and no row was written. */
  function expectUntouched(): void {
    expect(testApp.identity.requests).toEqual([]);
    expect(testApp.identity.operations.size).toBe(0);
    expect(testApp.db.writes()).toEqual([]);
  }

  describe.each(FAMILIES)('%s mode', (family) => {
    it('answers findNew of a user with new-bean defaults and a fresh CF UUID', async () => {
      const res = await send(testApp.app, 'GET', apiPath(family, '/user/new'), await actorHeaders(SITE_ADMIN_A));
      const envelope = legacyEnvelope(res, 200);
      expect(envelope.method).toBe('findNew');
      const data = envelope.data ?? {};
      expect(data).toMatchObject({ entityname: 'user', isnew: 1, siteid: TENANT_A.siteId, ispublic: 1, s2: 0 });
      expect(isCfUuid(String(data.id))).toBe(true);
      expect(data.userid).toBe(data.id);
      expect(data).not.toHaveProperty('password');
      expect((data.links as Record<string, string>).self).toContain(`/_api/json/v1/${TENANT_A.siteId}/user/${String(data.id)}`);
    });

    it('answers findNew of an address with its bean defaults', async () => {
      const data = dataOf(await send(testApp.app, 'GET', apiPath(family, '/address/new'), await actorHeaders(SITE_ADMIN_A)));
      expect(data).toMatchObject({ entityname: 'address', siteid: TENANT_A.siteId, userid: '' });
      expect(isCfUuid(String(data.addressid))).toBe(true);
      expect(data.id).toBe(data.addressid);
    });

    it('answers pollState anonymously', async () => {
      const envelope = legacyEnvelope(await send(testApp.app, 'GET', apiPath(family, '/user/pollState'), await anonymousHeaders()), 200);
      expect(envelope).toMatchObject({ method: 'pollState', data: { loggedin: false } });
    });

    it.each([
      ['anonymous', undefined],
      ['a system user without the Users module', SYSTEM_USER_A],
    ])('refuses findOne to %s with the authorization envelope', async (_name, actor) => {
      const headers = actor === undefined ? await anonymousHeaders() : await actorHeaders(actor);
      const envelope = legacyError(await send(testApp.app, 'GET', apiPath(family, `/user/${SITE_ADMIN_A.sub}`), headers), 'authorization');
      expect(envelope.method).toBe('findOne');
      expect(testApp.identity.requests).toEqual([]);
    });

    it.each([
      ['an administrator of another tenant', OTHER_TENANT],
      ['the super user of site default', ADMIN_S2],
    ])('refuses %s on a tenant-a path with 403', async (_name, actor) => {
      legacyError(await send(testApp.app, 'GET', apiPath(family, `/user/${target}`), await actorHeaders(actor)), 'authorization', 403);
      expectUntouched();
    });

    it.each([
      ['the API site', (path: string) => path.replace(`/${TENANT_A.siteId}/`, `/${TENANT_B.siteId}/`), undefined],
      ['a url siteid', (path: string) => `${path}?siteid=${TENANT_B.siteId}`, undefined],
      ['a form siteid', (path: string) => path, { siteid: TENANT_B.siteId, fname: 'Nobody' }],
    ])('refuses a siteid other than the token site named by %s with 403', async (_name, rewrite, form) => {
      const method: Method = form === undefined ? 'GET' : 'POST';
      const res = await send(testApp.app, method, rewrite(apiPath(family, `/user/${target}`)), { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF }, form);
      legacyError(res, 'authorization', 403);
      expectUntouched();
    });

    it.each([
      ['a content findOne', 'GET', `/content/${target}`],
      ['a site findOne', 'GET', `/site/${TENANT_A.siteId}`],
    ] as const)('answers %s, a key people does not own, with the legacy 404 envelope', async (_name, method, rest) => {
      legacyError(await send(testApp.app, method, apiPath(family, rest), await actorHeaders(SITE_ADMIN_A)), 'invalidMethodCall', 404);
      expectUntouched();
    });

    // Deletes and photo saves are withheld on the decision list and stay on legacy: people answers the legacy 503, never executes them.
    it.each([
      ['a user delete', 'DELETE', `/user/${target}`, undefined],
      ['an address delete', 'DELETE', `/address/${target}`, undefined],
      ['a user save setting a photo', 'POST', `/user/${target}`, { fname: 'Photo', newFile: 'portrait.jpg' }],
      ['a user save removing the photo', 'POST', `/user/${target}`, { fname: 'Photo', removePhotoFile: 'true' }],
    ] as const)('withholds %s with the legacy 503 before anything runs', async (_name, method, rest, form) => {
      const headers = { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF };
      legacyError(await send(testApp.app, method, apiPath(family, rest), headers, form === undefined ? undefined : { ...form }), 'server_error', 503);
      expectUntouched();
    });

    it('answers invalidTokens when identity rejects the token, consuming it for the id path value', async () => {
      testApp.identity.csrf.rejectAll();
      const res = await send(testApp.app, 'POST', apiPath(family, `/user/${target}`), { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF }, { fname: 'Nobody' });
      legacyError(res, 'invalidTokens');
      expect(testApp.identity.csrf.consumed()).toEqual([
        { request: { sessionId: sessionOf(SITE_ADMIN_A), token: TOKEN, expires: TOKEN_EXPIRES, context: target }, valid: false },
      ]);
      expect(rosterSteps(testApp.identity)).toEqual([]);
      expect(testApp.db.writes()).toEqual([]);
    });

    it('answers invalidTokens without asking identity when the request carries no token', async () => {
      legacyError(await send(testApp.app, 'POST', apiPath(family, '/address'), await actorHeaders(SITE_ADMIN_A), { userid: target }), 'invalidTokens');
      expectUntouched();
    });

    it('withholds a multipart save uploading a photo with the legacy 503', async () => {
      const headers = { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF };
      const file = { field: 'newFile', filename: 'portrait.jpg', type: 'image/jpeg', content: 'JPEG' };
      legacyError(await sendMultipart(testApp.app, apiPath(family, `/user/${target}`), headers, { fname: 'Photo' }, file), 'server_error', 503);
      expectUntouched();
    });
  });

  describe('json mode details', () => {
    it.each([
      ['X-Forwarded-Proto', { 'x-forwarded-proto': 'https' }],
      ['Front-End-Https', { 'front-end-https': 'true' }],
    ])('builds entity links from the forwarded host and the %s scheme', async (_name, scheme) => {
      const headers = { ...(await actorHeaders(SITE_ADMIN_A)), 'x-forwarded-host': 'www.tenant-a.opt2.test:8443', ...scheme };
      const data = dataOf(await send(testApp.app, 'GET', apiPath('json', '/user/new'), headers));
      const { self } = data.links as { self: string };
      expect(self.startsWith('https://www.tenant-a.opt2.test')).toBe(true);
      expect(self).toContain(`/index.cfm/_api/json/v1/${TENANT_A.siteId}/user/${String(data.id)}`);
    });

    it('reads a findOne without an id as a new bean', async () => {
      const envelope = legacyEnvelope(await send(testApp.app, 'GET', apiPath('json', '?method=findOne&entityname=user'), await actorHeaders(SITE_ADMIN_A)), 200);
      expect(envelope).toMatchObject({ method: 'findOne', data: { entityname: 'user', isnew: 1, siteid: TENANT_A.siteId } });
    });

    it('answers an unregistered url siteid with invalidParameters, as legacy resolves the site from it', async () => {
      legacyError(await send(testApp.app, 'GET', apiPath('json', '/user/new?siteid=no-such-site'), await actorHeaders(SITE_ADMIN_A)), 'invalidParameters');
      expectUntouched();
    });

    it('validates a bean without rules as having no errors', async () => {
      const url = apiPath('json', `?method=validate&entityname=user&data=${encodeURIComponent('{"bean":"user"}')}`);
      expect(legacyEnvelope(await send(testApp.app, 'GET', url, await actorHeaders(SITE_ADMIN_A)), 200)).toMatchObject({ method: 'validate', data: {} });
      expectUntouched();
    });

    it('answers findProperties through the method form, the table hidden from an anonymous caller', async () => {
      const url = apiPath('json', '?method=findProperties&entityname=address&properties=city,zip');
      const envelope = legacyEnvelope(await send(testApp.app, 'GET', url, await anonymousHeaders()), 200);
      expect(envelope.method).toBe('findProperties');
      expect(envelope.data).toMatchObject({ entityname: 'address', primarykey: 'addressid' });
      expect(envelope.data).not.toHaveProperty('table');
      expect((envelope.data?.properties as Array<{ name: string }>).map((property) => property.name)).toEqual(['city', 'zip']);
    });

    it('denies an anonymous caller every permission through the method form', async () => {
      const url = apiPath('json', `?method=findPermissions&entityname=user&id=${target}`);
      const envelope = legacyEnvelope(await send(testApp.app, 'GET', url, await anonymousHeaders()), 200);
      expect(envelope).toMatchObject({ method: 'findPermissions', data: { read: false, delete: false, save: false } });
    });

    it.each([
      ['ad-hoc validation rules, which build a generic bean', '{}', '{"email":{"required":true}}', 'server_error', 503],
      ['a loadby validation of a stored property', '{"bean":"user","loadby":"email"}', undefined, 'server_error', 503],
      ['a loadby of a reserved argument', '{"bean":"user","loadby":"orderby"}', undefined, 'invalidParameters', 400],
      ['a complex siteid', '{"siteid":{"site":"tenant-a"}}', undefined, 'server_error', 500],
    ] as const)('answers validate of %s as legacy does', async (_name, data, validations, type, status) => {
      const rules = validations === undefined ? '' : `&validations=${encodeURIComponent(validations)}`;
      const url = apiPath('json', `?method=validate&entityname=user&data=${encodeURIComponent(data)}${rules}`);
      legacyError(await send(testApp.app, 'GET', url, await actorHeaders(SITE_ADMIN_A)), type, status);
      expectUntouched();
    });
  });

  describe('rest mode', () => {
    it('asks an anonymous caller for Basic credentials', async () => {
      const res = await send(testApp.app, 'GET', apiPath('rest', `/user/${target}`), await anonymousHeaders());
      legacyError(res, 'authorization');
      expect(res.headers['www-authenticate']).toBe(WWW_AUTHENTICATE.basic);
    });

    it('never consumes a CSRF token or runs the roster protocol: the sessionless save of a registered site fails as legacy fails it', async () => {
      const res = await send(testApp.app, 'POST', apiPath('rest', `/user/${target}`), { ...(await actorHeaders(SYSTEM_USER_A)), ...CSRF }, { fname: 'Rested' });
      legacyError(res, 'server_error');
      expect(testApp.identity.csrf.consumed()).toEqual([]);
      expectUntouched();
    });
  });
});

// Reads and saves need stored rows, which the recording database never holds.
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
      running.then((outcome) => reject(new Error(`withPgApp ended before the suite: ${JSON.stringify(outcome)}`)), reject);
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
      ['a super user, through the ordered membership list', s2OnTenantA],
      ['a Users module user, through the membership lookup', MODULE_USER_A],
    ])('reads the memberships of a user for %s', async (_name, actor) => {
      ctx.identity.seedMemberships(owner.userid, [GROUP_ID]);
      const data = dataOf(await send(ctx.app, 'GET', apiPath(family, `/user/${owner.userid}`), await actorHeaders(actor)));
      expect(data).toMatchObject({ userid: owner.userid, groupid: GROUP_ID });
      expect((data.links as Record<string, string>).edit).toContain('muraAction=cusers.edituser');
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
      const person = CSV_QUIRK_PERSONS[0];
      if (person === undefined) throw new Error('no CSV quirk person');
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

    it('logs a json-mode self-save in again at commit', async () => {
      const form = { fname: 'Sid', lname: owner.lname ?? '', email: owner.email ?? '' };
      const res = await send(ctx.app, 'POST', apiPath('json', `/user/${owner.userid}`), { ...(await actorHeaders(SYSTEM_USER_A)), ...CSRF }, form);
      expect(dataOf(res)).toMatchObject({ userid: owner.userid, fname: 'Sid', errors: {} });
      const [operation] = [...ctx.identity.operations.values()];
      expect(operation?.state).toBe('finished');
      expect(operation?.commitRequest?.sessionEffects).toMatchObject({ reloginSessionId: sessionOf(SYSTEM_USER_A), person: { fname: 'Sid', lname: owner.lname } });
      expect(ctx.identity.csrf.consumed().map(({ request }) => request.context)).toEqual([owner.userid]);
    });
  });

  describe('address saves', () => {
    it('adds and updates an address, consuming the token for the id path value', async () => {
      const user = await actorHeaders(SITE_ADMIN_A);
      const created = dataOf(
        await send(ctx.app, 'POST', apiPath('json', '/address'), { ...user, ...CSRF }, { userid: owner.userid, addressname: 'Cabin', city: 'Bergen' }),
      );
      const addressId = String(created.addressid);
      expect(isCfUuid(addressId)).toBe(true);
      expect(created).toMatchObject({ entityname: 'address', userid: owner.userid, addressname: 'Cabin', city: 'Bergen', errors: {} });
      const updated = await send(ctx.app, 'PUT', apiPath('json', `/address/${addressId}`), { ...user, ...csrfHeaders(`${TOKEN}-2`) }, {
        userid: owner.userid,
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
      const addressId = ownerWork?.addressid ?? '';
      const res = await send(ctx.app, 'DELETE', apiPath('json', `/address/${addressId}`), { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF });
      legacyError(res, 'server_error', 503);
      expect(ctx.identity.csrf.consumed()).toEqual([]);
      const read = dataOf(await send(ctx.app, 'GET', apiPath('json', `/address/${addressId}`), await actorHeaders(SITE_ADMIN_A)));
      expect(read).toMatchObject({ addressid: addressId, isnew: 0 });
    });
  });
});
