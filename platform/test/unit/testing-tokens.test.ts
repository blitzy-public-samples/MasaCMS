import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthDenial,
  INVOCATION_HEADER,
  LOCAL_SECRET_FILES,
  LOCAL_USER_TOKEN,
  PUBSUB_INVOKER_ROLE,
  Roles,
  SYNTHETIC_ROLES,
  TASKS_INVOKER_ROLE,
  loadLocalSigningKeys,
  localSecretPath,
  rolesForService,
  userClaimsSchema,
  verifyLocalServiceToken,
  type AuthRequest,
} from '../../src/auth/index.js';
import { createLogger } from '../../src/logging/index.js';
import { createService } from '../../src/service-kit/create-service.js';
import { loadEnv, type BaseEnv } from '../../src/service-kit/env.js';
import { tenantIdForSite } from '../../src/tenancy/index.js';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, type TenantFixture } from '../../src/testing/fixtures.js';
import {
  ROLE_SET,
  SERVICE_CALLERS,
  TEST_PUSH_KEY,
  authHeadersFor,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushKeyQuery,
  subjectQueryFor,
  subjectSiteFor,
  testInvocationMinter,
  testJwks,
  testSigningKeys,
  testVerifier,
  writeTestSecrets,
  type RoleSubject,
} from '../../src/testing/tokens.js';

const NOW = Math.floor(Date.now() / 1000);
const CALLEE = 'people';
const TASK_PATH = '/internal/v1/tasks/run';

function request(headers: Record<string, string>, query: Record<string, unknown> = {}, reqPath = '/v1/x'): AuthRequest {
  return { headers, query, path: reqPath };
}

async function denialOf(promise: Promise<unknown>): Promise<AuthDenial> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AuthDenial);
  return err as AuthDenial;
}

describe('test key material', () => {
  let stateDir: string;

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-testing-tokens-'));
  });

  afterAll(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('generates one key pair per process', async () => {
    const [first, second] = await Promise.all([testSigningKeys(), testSigningKeys()]);
    expect(second).toBe(first);
    expect(first.privateKey.type).toBe('private');
    expect(first.publicKey.type).toBe('public');
  });

  it('publishes the public key under its kid in the test JWKS', async () => {
    const { kid } = await testSigningKeys();
    const { keys } = await testJwks();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kid, alg: 'RS256', use: 'sig', kty: 'RSA' });
    expect(keys[0]).not.toHaveProperty('d');
  });

  it('writes secret files that loadLocalSigningKeys reads back to the same kid', async () => {
    await writeTestSecrets(stateDir);
    const loaded = await loadLocalSigningKeys(stateDir, { requirePrivate: true });
    expect(loaded.kid).toBe((await testSigningKeys()).kid);
    expect(await readFile(localSecretPath(stateDir, LOCAL_SECRET_FILES.pubsubPushKey), 'utf8')).toBe(TEST_PUSH_KEY);
    for (const file of Object.values(LOCAL_SECRET_FILES)) {
      expect((await stat(localSecretPath(stateDir, file))).mode & 0o777).toBe(0o600);
    }
    const token = await mintServiceToken({ caller: 'gateway', audience: CALLEE });
    await expect(verifyLocalServiceToken(token, { publicKey: loaded.publicKey, audience: CALLEE })).resolves.toEqual({
      name: 'gateway',
      roles: ['service:gateway'],
    });
  });

  it('encodes the push key query', () => {
    expect(pushKeyQuery()).toBe(`key=${TEST_PUSH_KEY}`);
    expect(pushKeyQuery('a b&c')).toBe('key=a%20b%26c');
  });
});

describe('mintUserToken', () => {
  const { userVerifier } = testVerifier();

  it('derives tid from site and verifies through the test user verifier', async () => {
    const token = await mintUserToken({ sub: 'U1', site: TENANT_A.siteId, roles: [Roles.siteAdmin] });
    const claims = await userVerifier.verify(token);
    expect(userClaimsSchema.parse(decodeJwt(token))).toEqual(claims);
    expect(claims).toMatchObject({
      iss: LOCAL_USER_TOKEN.issuer,
      aud: LOCAL_USER_TOKEN.audience,
      sub: 'U1',
      tid: TENANT_A.tenantId,
      site: TENANT_A.siteId,
      roles: [Roles.siteAdmin],
      s2: false,
      epoch: 0,
    });
    expect(claims.exp - claims.iat).toBe(LOCAL_USER_TOKEN.lifetimeSeconds);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'RS256', kid: (await testSigningKeys()).kid });
  });

  it('takes the site of a fixture tid and keeps an explicit mismatched pair', async () => {
    const fromTid = await userVerifier.verify(await mintUserToken({ sub: 'U2', tid: TENANT_B.tenantId, roles: [] }));
    expect(fromTid).toMatchObject({ tid: TENANT_B.tenantId, site: TENANT_B.siteId });
    const mismatched = await userVerifier.verify(
      await mintUserToken({ sub: 'U3', tid: TENANT_B.tenantId, site: TENANT_A.siteId, roles: [] }),
    );
    expect(mismatched).toMatchObject({ tid: TENANT_B.tenantId, site: TENANT_A.siteId });
  });

  it('refuses a tid with no fixture', async () => {
    await expect(mintUserToken({ sub: 'U4', tid: tenantIdForSite('elsewhere'), roles: [] })).rejects.toThrow(
      /No tenant fixture/,
    );
  });

  it('defaults s2 from the roles and keeps explicit claim values', async () => {
    const claims = await userVerifier.verify(
      await mintUserToken({ sub: 'U5', site: 'default', roles: [Roles.s2], sid: 'session-9', epoch: 4, iat: NOW, exp: NOW + 60 }),
    );
    expect(claims).toMatchObject({ s2: true, sid: 'session-9', epoch: 4, iat: NOW, exp: NOW + 60 });
    expect(claims.tid).toBe(tenantIdForSite('default'));
  });

  it('rejects an expired token as accessTokenExpired', async () => {
    const token = await mintUserToken({ sub: 'U6', site: TENANT_A.siteId, roles: [], iat: NOW - 600, exp: NOW - 300 });
    const denial = await denialOf(userVerifier.verify(token));
    expect(denial).toMatchObject({ type: 'accessTokenExpired', statusCode: 401 });
  });

  it.each([
    ['issuer', { iss: 'someone-else' }],
    ['audience', { aud: 'other-audience' }],
  ])('rejects a wrong %s as invalidAccessToken', async (_field, override) => {
    const token = await mintUserToken({ sub: 'U7', site: TENANT_A.siteId, roles: [], ...override });
    const denial = await denialOf(userVerifier.verify(token));
    expect(denial).toMatchObject({ type: 'invalidAccessToken', statusCode: 401 });
  });
});

describe('service and task tokens', () => {
  const overrides = testVerifier(CALLEE);

  it('mints a service token the local service verifier accepts for its audience only', async () => {
    const token = await mintServiceToken({ caller: 'gateway', audience: CALLEE });
    const { publicKey } = await testSigningKeys();
    await expect(verifyLocalServiceToken(token, { publicKey, audience: CALLEE })).resolves.toEqual({
      name: 'gateway',
      roles: rolesForService('gateway'),
    });
    await expect(overrides.invocationVerifier.verify(`Bearer ${token}`)).resolves.toMatchObject({ name: 'gateway' });
    const other = await mintServiceToken({ caller: 'gateway', audience: 'finance' });
    expect((await denialOf(overrides.invocationVerifier.verify(`Bearer ${other}`))).reason).toBe('invalid-credential');
  });

  it('accepts a tasks-invoker token on the cloud-tasks transport and refuses it on a service route', async () => {
    const token = await mintTasksInvokerToken({ audience: CALLEE });
    await expect(
      overrides.transports['cloud-tasks'].authenticate(request({ authorization: `Bearer ${token}` }, {}, TASK_PATH), {
        optional: false,
      }),
    ).resolves.toEqual({ service: { name: 'tasks-invoker', roles: [TASKS_INVOKER_ROLE] } });
    const denial = await denialOf(
      overrides.transports.service.authenticate(request({ [INVOCATION_HEADER]: `Bearer ${token}` }), { optional: false }),
    );
    expect(denial.reason).toBe('wrong-scheme');
  });

  it('accepts the push key on the pubsub-push transport', async () => {
    await expect(
      overrides.transports['pubsub-push'].authenticate(request({}, { key: TEST_PUSH_KEY }), { optional: false }),
    ).resolves.toEqual({ service: { name: 'pubsub-invoker', roles: [PUBSUB_INVOKER_ROLE] } });
  });

  it('mints invocation headers the callee verifies', async () => {
    const headers = await testInvocationMinter({ caller: 'migration' }).headersFor({ name: CALLEE });
    const header = headers[INVOCATION_HEADER];
    expect(header).toBeDefined();
    await expect(overrides.invocationVerifier.verify(header ?? '')).resolves.toEqual({
      name: 'migration',
      roles: rolesForService('migration'),
    });
  });
});

describe('ROLE_SET', () => {
  const names = ROLE_SET.map((subject) => subject.name);

  it('has unique names in the matrix order', () => {
    expect(new Set(names).size).toBe(names.length);
    expect(names.slice(0, 7)).toEqual([
      'anonymous',
      'member',
      'system-user',
      'editor',
      'site-admin',
      's2',
      'other-tenant',
    ]);
    expect(names).toEqual(expect.arrayContaining([...SYNTHETIC_ROLES]));
    expect(names).toEqual(expect.arrayContaining(SERVICE_CALLERS.map((caller) => `service:${caller}`)));
    expect(names).toHaveLength(7 + SYNTHETIC_ROLES.length + SERVICE_CALLERS.length);
  });

  it('builds user and service roles from the auth role constants', () => {
    const byName = new Map(ROLE_SET.map((subject) => [subject.name, subject]));
    expect(byName.get('s2')).toMatchObject({ kind: 'user', roles: [Roles.systemUser, Roles.s2], s2: true });
    expect(byName.get('other-tenant')).toMatchObject({ crossTenant: true });
    expect(byName.get('other-tenant')).not.toHaveProperty('siteOverride');
    expect(byName.get(Roles.financeApprover)?.roles).toEqual([Roles.systemUser, Roles.financeApprover]);
    expect(byName.get('service:migration')).toMatchObject({
      kind: 'service',
      caller: 'migration',
      roles: ['service:migration', Roles.platformMigration],
    });
    expect(byName.get('service:operator')?.roles).toContain(Roles.platformOperator);
    expect(Object.isFrozen(ROLE_SET)).toBe(true);
  });
});

describe('subjectSiteFor', () => {
  const otherTenant = ROLE_SET.find((subject) => subject.name === 'other-tenant') as RoleSubject;
  const siteAdmin = ROLE_SET.find((subject) => subject.name === Roles.siteAdmin) as RoleSubject;

  it.each<[string, RoleSubject, string | undefined, string]>([
    ['a cross-tenant subject relative to the site', otherTenant, TENANT_B.siteId, TENANT_A.siteId],
    [
      'a cross-tenant subject ahead of its override',
      { ...otherTenant, siteOverride: TENANT_B.siteId },
      TENANT_A.siteId,
      TENANT_B.siteId,
    ],
    [
      'the override of a subject',
      { ...siteAdmin, siteOverride: TENANT_UMBRELLA.siteId },
      TENANT_B.siteId,
      TENANT_UMBRELLA.siteId,
    ],
    ['the site for a plain subject', siteAdmin, TENANT_B.siteId, TENANT_B.siteId],
    ['tenant-a for a plain subject by default', siteAdmin, undefined, TENANT_A.siteId],
  ])('returns %s', (_label, subject, site, expected) => {
    expect(subjectSiteFor(subject, site)).toBe(expected);
  });
});

const MIGRATION_ROUTE = '/internal/v1/migration/apply';
const EVENT_ROUTE = '/internal/v1/events/people.stub.note.created.v1';

function siteRoute(site: string): string {
  return `/v1/sites/${site}/admin`;
}

/** The one route each subject may reach in the app below when `site` is under test. */
function allowedRoutes(site: string): Readonly<Record<string, string>> {
  return {
    [Roles.siteAdmin]: siteRoute(site),
    'service:migration': MIGRATION_ROUTE,
    'service:tasks-invoker': TASK_PATH,
    'service:pubsub-invoker': EVENT_ROUTE,
  };
}

function envFor(stateDir: string): BaseEnv {
  return loadEnv(undefined, {
    PORT: '24111',
    OPT2_SERVICE_NAME: CALLEE,
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    OPT2_STATE_DIR: stateDir,
    TZ: 'UTC',
  });
}

async function matrixApp(stateDir: string, bindCallee: boolean): Promise<FastifyInstance> {
  const app = await createService({
    name: CALLEE,
    version: '1.0.0',
    env: envFor(stateDir),
    verifierOverride: bindCallee ? testVerifier(CALLEE) : testVerifier(),
    logger: createLogger({ service: CALLEE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  const ok = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });
  app.get('/v1/sites/:siteid/admin', { config: { opt2: { requires: [Roles.siteAdmin] } } }, ok);
  app.post(MIGRATION_ROUTE, { config: { opt2: { requires: [Roles.platformMigration] } } }, ok);
  app.post(TASK_PATH, { config: { opt2: { requires: [TASKS_INVOKER_ROLE], transport: 'cloud-tasks' } } }, ok);
  app.post(EVENT_ROUTE, { config: { opt2: { requires: [PUBSUB_INVOKER_ROLE], transport: 'pubsub-push' } } }, ok);
  await app.ready();
  return app;
}

describe.each([
  ['bound to the callee', true],
  ['with env-loaded key files', false],
])('authHeadersFor through createService (%s)', (_label, bindCallee) => {
  let stateDir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-testing-matrix-'));
    if (!bindCallee) {
      await writeTestSecrets(stateDir);
    }
    app = await matrixApp(stateDir, bindCallee);
  });

  afterAll(async () => {
    await app.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  describe.each([TENANT_A.siteId, TENANT_B.siteId])('on site %s', (site) => {
    const route = siteRoute(site);
    const allowed = allowedRoutes(site);

    it.each(ROLE_SET.map((subject): [string, RoleSubject] => [subject.name, subject]))(
      '%s reaches only its own route',
      async (name, subject) => {
        const headers = await authHeadersFor(subject, { audience: CALLEE, site });
        for (const url of [route, MIGRATION_ROUTE, TASK_PATH, EVENT_ROUTE]) {
          const method = url === route ? 'GET' : 'POST';
          const res = await app.inject({ method, url, headers, query: subjectQueryFor(subject) });
          expect(allowed[name] === url ? [200] : [401, 403], url).toContain(res.statusCode);
        }
      },
    );
  });
});

describe('authHeadersFor header shapes', () => {
  it.each<[string | undefined, TenantFixture]>([
    [TENANT_A.siteId, TENANT_B],
    [TENANT_B.siteId, TENANT_A],
    [undefined, TENANT_B],
    ['TENANT-B', TENANT_A],
    [TENANT_UMBRELLA.siteId, TENANT_B],
  ])('sends other-tenant tokens for site %s with the gateway invocation credential', async (site, expected) => {
    const otherTenant = ROLE_SET.find((subject) => subject.name === 'other-tenant');
    expect(otherTenant).toBeDefined();
    const headers = await authHeadersFor(otherTenant as RoleSubject, { audience: CALLEE, sub: 'U8', site });
    expect(Object.keys(headers).sort()).toEqual(['authorization', INVOCATION_HEADER]);
    const claims = decodeJwt((headers.authorization ?? '').replace(/^Bearer /, ''));
    expect(claims).toMatchObject({ sub: 'U8', site: expected.siteId, tid: expected.tenantId });
    expect(claims.tid).not.toBe(tenantIdForSite(site ?? TENANT_A.siteId));
    expect(decodeJwt((headers[INVOCATION_HEADER] ?? '').replace(/^Bearer /, ''))).toMatchObject({
      sub: 'service:gateway',
      aud: CALLEE,
    });
  });

  it('gives anonymous and push subjects no headers and only the push subject a query', async () => {
    const anonymous = ROLE_SET[0] as RoleSubject;
    const push = ROLE_SET.find((subject) => subject.caller === 'pubsub-invoker') as RoleSubject;
    expect(await authHeadersFor(anonymous, { audience: CALLEE })).toEqual({});
    expect(await authHeadersFor(push, { audience: CALLEE })).toEqual({});
    expect(subjectQueryFor(push)).toEqual({ key: TEST_PUSH_KEY });
    expect(subjectQueryFor(anonymous)).toEqual({});
  });

  it('refuses a service subject without a caller', async () => {
    await expect(authHeadersFor({ name: 'broken', kind: 'service', roles: [] }, { audience: CALLEE })).rejects.toThrow(
      TypeError,
    );
  });
});
