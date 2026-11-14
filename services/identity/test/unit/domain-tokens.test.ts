/** Site-scoped user tokens: the local signer and JWKS, the Identity Platform adapter, and minting against a throwaway `identity` schema. */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { SignJWT, createLocalJWKSet, decodeJwt, decodeProtectedHeader } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANONYMOUS_PRINCIPAL_UID,
  LOCAL_USER_TOKEN,
  cloudUserTokenSettings,
  createUserTokenVerifier,
  loadLocalSigningKeys,
  verifyLocalServiceToken,
  type UserClaims,
} from '@opt2/platform/auth';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type Clock } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, testJwks, testSigningKeys, writeTestSecrets, type ThrowawaySchema } from '@opt2/platform/testing';
import { applyLogin, endSession, ensureSession } from '../../src/domain/sessions.js';
import {
  MAX_CUSTOM_CLAIMS_BYTES,
  SIGN_IN_WITH_CUSTOM_TOKEN_URL,
  createCloudIdentityPlatformAdapter,
  createFirebaseIdentityPlatformAdapter,
  createLocalTokenSigner,
  createTokenService,
  type IdentityPlatformAdapter,
  type TokenService,
  type TokenServiceOptions,
} from '../../src/domain/tokens.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS, type LoginSnapshot } from '../../src/repo/tables.js';
import { recordTenantListing, testFirebaseApp, type RecordedTenantPage } from '../helpers/firebase.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0);
const CLOCK = fixedClock(NOW);
const IAT = Math.floor(NOW.getTime() / 1000);
const USERS_MODULE = '00000000000000000000000000000000008';
const CONTENT_MODULE = '00000000000000000000000000000000007';
const PLUGIN_MODULE = 'P0000000-0000-0000-0000000000000001';
const TENANT_A = tenantIdForSite('tenant-a');

function userId(n: number): string {
  return `U0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

/** A login snapshot whose role list and membership ids are given directly. */
function snapshotOf(userid: string, siteid: string, roleList: string, groupIds: readonly string[]): LoginSnapshot {
  return {
    userid,
    username: userid,
    siteid,
    subtype: 'Default',
    password: 'stored-hash',
    fname: '',
    lname: '',
    email: '',
    remoteid: '',
    company: '',
    lastlogin: null,
    passwordcreated: null,
    roleList,
    membershipIds: [...groupIds, userid].join(','),
  };
}

function groupInput(groupname: string, siteid: string, ispublic: 0 | 1): GroupInput {
  return {
    groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic, siteid,
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '',
  };
}

/** A fetch answering every call with `status` and `body`, recording the calls. */
function recordedFetch(status: number, body: string): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(body, { status }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** An HTTP server on 127.0.0.1 answering through `handle`; `close` is idempotent and drops held connections. */
async function localServer(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; received: number; close: () => Promise<void> }> {
  const state = { url: '', received: 0, close: (): Promise<void> => Promise.resolve() };
  const server = createServer((req, res) => {
    state.received += 1;
    handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/accounts:signInWithCustomToken`;
  let closed: Promise<void> | undefined;
  state.close = () =>
    (closed ??= new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err === undefined ? resolve() : reject(err)));
    }));
  return state;
}

let stateDir: string;

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'identity-tokens-'));
  await writeTestSecrets(stateDir);
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function localEnv(): TokenServiceOptions['env'] {
  return { OPT2_ENV: 'local', OPT2_STATE_DIR: stateDir, GOOGLE_CLOUD_PROJECT: undefined };
}

describe('local token signer', () => {
  it('signs exactly the claims under the platform kid, and its JWKS verifies the token', async () => {
    const signer = createLocalTokenSigner({ stateDir });
    const { kid } = await loadLocalSigningKeys(stateDir);
    const iat = Math.floor(Date.now() / 1000);
    const claims: UserClaims = {
      iss: LOCAL_USER_TOKEN.issuer, aud: LOCAL_USER_TOKEN.audience, sub: '', sid: 'S1', tid: TENANT_A, site: 'tenant-a',
      roles: [], s2: false, epoch: 0, iat, exp: iat + LOCAL_USER_TOKEN.lifetimeSeconds,
    };
    const token = await signer.sign(claims);
    const jwks = await signer.jwks();

    expect(decodeProtectedHeader(token)).toEqual({ alg: 'RS256', kid, typ: 'JWT' });
    expect(jwks.keys).toHaveLength(1);
    expect(Object.keys(jwks.keys[0] ?? {}).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
    expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', kid, alg: 'RS256', use: 'sig' });
    const verifier = createUserTokenVerifier({ issuer: LOCAL_USER_TOKEN.issuer, audience: LOCAL_USER_TOKEN.audience, keySet: createLocalJWKSet(jwks) });
    expect(await verifier.verify(token)).toEqual(claims);
  });

  it('fails while the key files are absent and loads them once written', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'identity-nokeys-'));
    try {
      const signer = createLocalTokenSigner({ stateDir: empty });
      await expect(signer.jwks()).rejects.toThrow(/ENOENT/);
      await writeTestSecrets(empty);
      expect((await signer.jwks()).keys).toHaveLength(1);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('token service construction', () => {
  const db = { schema: 'identity' } as unknown as TenantDb;
  const unusedPlatform: IdentityPlatformAdapter = { mintIdToken: () => Promise.reject(new Error('not called')) };

  it.each([
    ['GOOGLE_CLOUD_PROJECT', undefined, unusedPlatform, /GOOGLE_CLOUD_PROJECT/],
    ['the Identity Platform adapter', 'proj', undefined, /Identity Platform adapter/],
  ])('refuses a cloud service without %s', (_label, project, identityPlatform, message) => {
    const env = { OPT2_ENV: 'cloud' as const, OPT2_STATE_DIR: '/state', GOOGLE_CLOUD_PROJECT: project };
    expect(() => createTokenService({ env, clock: CLOCK, db, identityPlatform })).toThrow(message);
  });

  it('publishes no keys and mints no service tokens in the cloud', async () => {
    const env = { OPT2_ENV: 'cloud' as const, OPT2_STATE_DIR: '/state', GOOGLE_CLOUD_PROJECT: 'proj' };
    const service = createTokenService({ env, clock: CLOCK, db, identityPlatform: unusedPlatform });
    expect(await service.jwks()).toEqual({ keys: [] });
    await expect(service.mintServiceToken({ name: 'identity', audience: 'people' })).rejects.toThrow(/Google/);
  });

  it('mints local service tokens that verify against the local public key', async () => {
    const service = createTokenService({ env: localEnv(), clock: CLOCK, db });
    const token = await service.mintServiceToken({ name: 'identity', audience: 'people' });
    const { publicKey } = await loadLocalSigningKeys(stateDir);
    expect(await verifyLocalServiceToken(token, { publicKey, audience: 'people' })).toEqual({ name: 'identity', roles: ['service:identity'] });
  });
});

describe('Firebase Identity Platform adapter', () => {
  const custom = { sid: 'S1', tid: TENANT_A, site: 'tenant-a', roles: ['member'], s2: false, epoch: 3 };

  const tenantIdForPool = (pool: string): string => `ip-${pool}`;

  it('signs a tenant custom token and exchanges it as the app service account', async () => {
    const app = await testFirebaseApp('identity-tokens-test');
    try {
      const ok = recordedFetch(200, JSON.stringify({ idToken: 'id-token', expiresIn: '3600', refreshToken: 'refresh' }));
      const adapter = createFirebaseIdentityPlatformAdapter({ projectId: 'proj', tenantIdForPool, fetchImpl: ok.fetchImpl, app });

      expect(await adapter.mintIdToken('umbrella', userId(1), custom)).toEqual({ idToken: 'id-token', expiresIn: 3600 });
      expect(ok.calls).toHaveLength(1);
      expect(ok.calls[0]?.url).toBe(SIGN_IN_WITH_CUSTOM_TOKEN_URL);
      expect(ok.calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer access-1' });
      const body = JSON.parse(String(ok.calls[0]?.init.body)) as { token: string; tenantId: string; returnSecureToken: boolean };
      expect(body).toMatchObject({ tenantId: 'ip-umbrella', returnSecureToken: true });
      expect(decodeJwt(body.token)).toMatchObject({ uid: userId(1), tenant_id: 'ip-umbrella', claims: custom, iss: 'sa@proj.iam.gserviceaccount.com' });

      for (const [status, answer, message] of [
        [400, JSON.stringify({ error: { message: 'INVALID_CUSTOM_TOKEN' } }), /HTTP 400 INVALID_CUSTOM_TOKEN$/],
        [502, '<html>bad gateway</html>', /HTTP 502$/],
        [200, JSON.stringify({ idToken: 'id-token' }), /HTTP 200$/],
      ] as const) {
        const failing = createFirebaseIdentityPlatformAdapter({ projectId: 'proj', tenantIdForPool, fetchImpl: recordedFetch(status, answer).fetchImpl, app });
        await expect(failing.mintIdToken('umbrella', userId(1), custom)).rejects.toThrow(message);
      }
    } finally {
      await deleteApp(app);
    }
  });

  it('signs the anonymous principal project-level and exchanges it without a tenant', async () => {
    const app = await testFirebaseApp('identity-tokens-project-level');
    const anonymous = { ...custom, roles: [] };
    let poolLookups = 0;
    const countingTenantIdForPool = (pool: string): string => {
      poolLookups += 1;
      return tenantIdForPool(pool);
    };
    try {
      const ok = recordedFetch(200, JSON.stringify({ idToken: 'anon-id-token', expiresIn: '3600', refreshToken: 'refresh' }));
      const adapter = createFirebaseIdentityPlatformAdapter({ projectId: 'proj', tenantIdForPool: countingTenantIdForPool, fetchImpl: ok.fetchImpl, app });

      expect(await adapter.mintIdToken(null, ANONYMOUS_PRINCIPAL_UID, anonymous)).toEqual({ idToken: 'anon-id-token', expiresIn: 3600 });
      expect(poolLookups).toBe(0);
      expect(ok.calls).toHaveLength(1);
      expect(ok.calls[0]?.url).toBe(SIGN_IN_WITH_CUSTOM_TOKEN_URL);
      expect(ok.calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer access-1' });
      const body = JSON.parse(String(ok.calls[0]?.init.body)) as { token: string; returnSecureToken: boolean };
      expect(Object.keys(body).sort()).toEqual(['returnSecureToken', 'token']);
      const customToken = decodeJwt(body.token);
      expect(customToken).toMatchObject({ uid: ANONYMOUS_PRINCIPAL_UID, claims: anonymous, iss: 'sa@proj.iam.gserviceaccount.com' });
      expect(customToken).not.toHaveProperty('tenant_id');

      const refused = recordedFetch(400, JSON.stringify({ error: { message: 'INVALID_CUSTOM_TOKEN' } }));
      const failing = createFirebaseIdentityPlatformAdapter({ projectId: 'proj', tenantIdForPool, fetchImpl: refused.fetchImpl, app });
      await expect(failing.mintIdToken(null, ANONYMOUS_PRINCIPAL_UID, anonymous)).rejects.toThrow(/for the project: HTTP 400 INVALID_CUSTOM_TOKEN$/);
    } finally {
      await deleteApp(app);
    }
  });

  it('refuses custom claims over 1,000 bytes before calling Google', async () => {
    let called = false;
    const adapter = createFirebaseIdentityPlatformAdapter({
      projectId: 'proj',
      tenantIdForPool: () => {
        called = true;
        return 'ip';
      },
      fetchImpl: recordedFetch(200, '{}').fetchImpl,
    });
    await expect(adapter.mintIdToken('tenant-a', userId(1), { roles: ['x'.repeat(MAX_CUSTOM_CLAIMS_BYTES)] })).rejects.toBeInstanceOf(RangeError);
    expect(called).toBe(false);
  });

  it.each([
    { exchange: 'is never answered', handle: () => undefined, refuse: false, received: 1, cause: 'TimeoutError' },
    {
      exchange: 'sends headers, then stalls its body',
      handle: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"idToken":');
      },
      refuse: false,
      received: 1,
      cause: 'TimeoutError',
    },
    {
      exchange: 'drops the connection mid-body',
      handle: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
        res.write('{"idToken":', () => setTimeout(() => res.destroy(), 20));
      },
      refuse: false,
      received: 1,
      cause: 'TypeError',
    },
    { exchange: 'is refused', handle: () => undefined, refuse: true, received: 0, cause: 'TypeError' },
  ])('answers an exchange that $exchange with ServiceUnavailableError', async ({ exchange, handle, refuse, received, cause }) => {
    const app = await testFirebaseApp(`identity-tokens-exchange-${exchange.replace(/\W/g, '-')}`);
    const server = await localServer(handle);
    try {
      if (refuse) await server.close();
      const fetchImpl = ((_url: string, init: RequestInit) => fetch(server.url, init)) as unknown as typeof fetch;
      const adapter = createFirebaseIdentityPlatformAdapter({ projectId: 'proj', tenantIdForPool, fetchImpl, app, timeoutMs: 200 });
      const failure: unknown = await adapter.mintIdToken('umbrella', userId(1), custom).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(ServiceUnavailableError);
      expect(failure).toMatchObject({ service: 'identity-platform', cause: { name: cause } });
      expect(server.received).toBe(received);
    } finally {
      await server.close();
      await deleteApp(app);
    }
  });

  it.each([
    {
      step: 'credential acquisition',
      stall: (app: App) => {
        const credential = app.options.credential;
        if (credential !== undefined) credential.getAccessToken = () => new Promise(() => undefined);
      },
    },
    {
      step: 'custom-token signing',
      stall: (app: App) => {
        getAuth(app).tenantManager().authForTenant('ip-umbrella').createCustomToken = () => new Promise(() => undefined);
      },
    },
  ])('answers stalled $step with ServiceUnavailableError before any exchange', async ({ step, stall }) => {
    const app = await testFirebaseApp(`identity-tokens-stalled-${step.replace(/\W/g, '-')}`);
    try {
      stall(app);
      const ok = recordedFetch(200, JSON.stringify({ idToken: 'id-token', expiresIn: '3600' }));
      const adapter = createFirebaseIdentityPlatformAdapter({ projectId: 'proj', tenantIdForPool, fetchImpl: ok.fetchImpl, app, timeoutMs: 100 });
      const failure = adapter.mintIdToken('umbrella', userId(1), custom);
      await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
      await expect(failure).rejects.toMatchObject({ service: 'identity-platform', cause: { name: 'TimeoutError' } });
      expect(ok.calls).toHaveLength(0);
    } finally {
      await deleteApp(app);
    }
  });

  it('propagates a credential acquisition failure within the budget unchanged', async () => {
    const app = await testFirebaseApp('identity-tokens-credential-failure');
    const denied = new Error('invalid_grant');
    try {
      const credential = app.options.credential;
      if (credential !== undefined) credential.getAccessToken = () => Promise.reject(denied);
      const ok = recordedFetch(200, JSON.stringify({ idToken: 'id-token', expiresIn: '3600' }));
      const adapter = createFirebaseIdentityPlatformAdapter({ projectId: 'proj', tenantIdForPool, fetchImpl: ok.fetchImpl, app });
      await expect(adapter.mintIdToken('umbrella', userId(1), custom)).rejects.toBe(denied);
      expect(ok.calls).toHaveLength(0);
    } finally {
      await deleteApp(app);
    }
  });

  const LISTED_PAGES: readonly RecordedTenantPage[] = [
    {
      tenants: [{ tenantId: 'default-k3j2h', displayName: 'default' }, { tenantId: 'unnamed-1' }, { tenantId: 'umbrella-9x8y7', displayName: 'umbrella' }],
      pageToken: 'page-2',
    },
    { tenants: [{ tenantId: 'unnamed-2' }, { tenantId: 'tenant-a-4f5g6', displayName: 'tenant-a' }] },
  ];

  it.each([
    { pool: 'umbrella', tenantId: 'umbrella-9x8y7' },
    { pool: 'tenant-a', tenantId: 'tenant-a-4f5g6' },
  ])('signs user-pool site $pool in to tenant $tenantId, listed across every tenant page', async ({ pool, tenantId }) => {
    const app = await testFirebaseApp(`identity-tokens-cloud-${pool}`);
    try {
      const pageTokens = recordTenantListing(app, LISTED_PAGES);
      const ok = recordedFetch(200, JSON.stringify({ idToken: 'id-token', expiresIn: '3600' }));
      const adapter = await createCloudIdentityPlatformAdapter({ projectId: 'proj', fetchImpl: ok.fetchImpl, app });

      expect(await adapter.mintIdToken(pool, userId(1), custom)).toEqual({ idToken: 'id-token', expiresIn: 3600 });
      expect(pageTokens).toEqual([undefined, 'page-2']);
      const body = JSON.parse(String(ok.calls[0]?.init.body)) as { token: string; tenantId: string };
      expect(body.tenantId).toBe(tenantId);
      expect(decodeJwt(body.token)).toMatchObject({ uid: userId(1), tenant_id: tenantId });
    } finally {
      await deleteApp(app);
    }
  });

  it.each([
    {
      refusal: 'two tenants sharing a display name',
      pages: [{ tenants: [{ tenantId: 'tenant-a-1', displayName: 'tenant-a' }], pageToken: 'page-2' }, { tenants: [{ tenantId: 'tenant-a-2', displayName: 'tenant-a' }] }],
      pool: 'tenant-a',
      message: /^Identity Platform tenants tenant-a-1 and tenant-a-2 share the display name tenant-a$/,
    },
    {
      refusal: 'a user-pool site no tenant is named after',
      pages: [{ tenants: [{ tenantId: 'tenant-a-1', displayName: 'tenant-a' }] }],
      pool: 'tenant-b',
      message: /^No Identity Platform tenant has the display name of user-pool site tenant-b$/,
    },
  ])('refuses $refusal before any exchange', async ({ refusal, pages, pool, message }) => {
    const app = await testFirebaseApp(`identity-tokens-cloud-${refusal.replace(/\W/g, '-')}`);
    try {
      recordTenantListing(app, pages);
      const ok = recordedFetch(200, JSON.stringify({ idToken: 'id-token', expiresIn: '3600' }));
      const minted = createCloudIdentityPlatformAdapter({ projectId: 'proj', fetchImpl: ok.fetchImpl, app }).then((adapter) =>
        adapter.mintIdToken(pool, userId(1), custom),
      );

      await expect(minted).rejects.toThrow(message);
      expect(ok.calls).toHaveLength(0);
    } finally {
      await deleteApp(app);
    }
  });

  it('answers a tenant listing that outlasts its budget with ServiceUnavailableError', async () => {
    const app = await testFirebaseApp('identity-tokens-cloud-stalled-listing');
    try {
      getAuth(app).tenantManager().listTenants = () => new Promise(() => undefined);
      const built = createCloudIdentityPlatformAdapter({ projectId: 'proj', app, timeoutMs: 100 });

      await expect(built).rejects.toBeInstanceOf(ServiceUnavailableError);
      await expect(built).rejects.toMatchObject({ service: 'identity-platform', cause: { name: 'TimeoutError' } });
    } finally {
      await deleteApp(app);
    }
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('token minting against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let service: TokenService;
  let editors = '';
  let admins = '';
  let subscribers = '';
  /** Epochs of the sessions without a signed-in user, set by the local anonymous-minting case. */
  const anonymousEpochs = new Map<string, number>();

  async function registerSite(site: string, privatePool: string, publicPool: string): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
        [site, tenantIdForSite(site), privatePool, publicPool, tenantIdForSite(privatePool), tenantIdForSite(publicPool), NOW],
      ),
    );
  }

  function gated<T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withGatedTenant(handle.app, tenantIdForSite(site), fn);
  }

  function sessionDeps(): { db: TenantDb; repo: IdentityRepository; clock: Clock } {
    return { db: handle.app, repo, clock: CLOCK };
  }

  async function login(sessionId: string, snapshot: LoginSnapshot): Promise<void> {
    await applyLogin(sessionDeps(), { sessionId, snapshot, mode: 'target-primary', siteId: snapshot.siteid });
  }

  function verifierFor(jwks: Awaited<ReturnType<TokenService['jwks']>>) {
    return createUserTokenVerifier({ issuer: LOCAL_USER_TOKEN.issuer, audience: LOCAL_USER_TOKEN.audience, keySet: createLocalJWKSet(jwks) });
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    await registerSite('tenant-a', 'tenant-a', 'umbrella');
    await registerSite('umbrella', 'umbrella', 'umbrella');
    await registerSite('default', 'default', 'default');
    editors = (await gated('tenant-a', (tx) => repo.insertGroup(tx, groupInput('Editors', 'tenant-a', 0), null))).userid;
    admins = (await gated('tenant-a', (tx) => repo.insertGroup(tx, groupInput('Admin', 'tenant-a', 0), null))).userid;
    subscribers = (await gated('umbrella', (tx) => repo.insertGroup(tx, groupInput('Subscribers', 'umbrella', 1), null))).userid;
    await gated('tenant-a', async (tx) => {
      await repo.replaceModulePermissions(tx, { moduleId: USERS_MODULE, siteId: 'tenant-a', groupIds: [editors] });
      await repo.replaceModulePermissions(tx, { moduleId: CONTENT_MODULE, siteId: 'tenant-a', groupIds: [subscribers] });
      await repo.replaceModulePermissions(tx, { moduleId: PLUGIN_MODULE, siteId: 'tenant-a', groupIds: [editors] });
    });
    service = createTokenService({ env: localEnv(), clock: CLOCK, db: handle.app, repo });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('mints the login-time module and system-user roles of a private-pool editor, skipping plugin grants', async () => {
    const roleList = `Editors;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,${userId(1)};username;tenant-a`;
    await login('S-EDITOR', snapshotOf(userId(1), 'tenant-a', roleList, [editors]));
    const minted = await service.mint({ sessionId: 'S-EDITOR', siteId: 'tenant-a' });

    expect(minted.claims).toEqual({
      iss: 'opt2-local-identity', aud: 'opt2-local', sub: userId(1), sid: 'S-EDITOR', tid: TENANT_A, site: 'tenant-a',
      roles: ['m:008', 'system-user'], s2: false, epoch: 1, iat: IAT, exp: IAT + 300,
    });
    expect(minted).toMatchObject({ expiresAt: IAT + 300, epoch: 1 });
    expect(decodeJwt(minted.token)).toEqual(minted.claims);

    const live = createTokenService({ env: localEnv(), clock: { now: () => new Date() }, db: handle.app, repo });
    const current = await live.mint({ sessionId: 'S-EDITOR', siteId: 'tenant-a' });
    expect(await verifierFor(await live.jwks()).verify(current.token)).toEqual(current.claims);
  });

  it('keeps login-time roles after membership changes and matches the site case-insensitively', async () => {
    const roleList = `Editors;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,${userId(5)};username;tenant-a`;
    await login('S-CHANGED', snapshotOf(userId(5), 'tenant-a', roleList, [editors]));
    await gated('tenant-a', (tx) => repo.addMembership(tx, userId(5), admins));
    await gated('tenant-a', (tx) => repo.removeMembership(tx, userId(5), editors));

    const minted = await service.mint({ sessionId: 'S-CHANGED', siteId: 'TENANT-A' });
    expect(minted.claims).toMatchObject({ roles: ['m:008', 'system-user'], site: 'TENANT-A', tid: TENANT_A });
  });

  it('gives an S2 user s2 on a registered site and no roles, s2 or registry tenant on an unknown one', async () => {
    await login('S-S2', snapshotOf(userId(3), 'default', 'S2IsPrivate;default,S2IsPrivate,S2,admin;username;default', []));

    expect((await service.mint({ sessionId: 'S-S2', siteId: 'tenant-a' })).claims).toMatchObject({ roles: ['s2'], s2: true });
    expect((await service.mint({ sessionId: 'S-S2', siteId: 'nowhere' })).claims).toMatchObject({
      roles: [], s2: false, sub: userId(3), tid: tenantIdForSite('nowhere'),
    });
  });

  it('gives a pooled public member its member role and public-pool module grant on the member site', async () => {
    const roleList = `Subscribers;umbrella;1,S2IsPublic;umbrella,S2IsPublic,${userId(2)};username;umbrella`;
    await login('S-MEMBER', snapshotOf(userId(2), 'umbrella', roleList, [subscribers]));

    expect((await service.mint({ sessionId: 'S-MEMBER', siteId: 'tenant-a' })).claims).toMatchObject({
      roles: ['m:007', 'member'], tid: TENANT_A, sub: userId(2),
    });
  });

  it('mints anonymous tokens for anonymous, ended and unknown sessions', async () => {
    const anonymous = await ensureSession(sessionDeps(), { sessionId: 'S-ANON', mode: 'target-primary' });
    await login('S-ENDED', snapshotOf(userId(4), 'tenant-a', `S2IsPrivate;tenant-a,S2IsPrivate,${userId(4)};username;tenant-a`, []));
    const ended = await endSession(sessionDeps(), 'S-ENDED');
    anonymousEpochs.set('S-ANON', anonymous.epoch).set('S-ENDED', ended.epoch).set('S-UNKNOWN', 0);

    for (const [sessionId, epoch] of anonymousEpochs) {
      expect((await service.mint({ sessionId, siteId: 'tenant-a' })).claims).toMatchObject({ sub: '', sid: sessionId, roles: [], s2: false, epoch, tid: TENANT_A });
    }
  });

  /** A cloud token service whose Identity Platform adapter records its calls and answers `id-token`, valid 3,500 s. */
  function cloudService(): { cloud: TokenService; calls: Array<[string | null, string, Record<string, unknown>]> } {
    const calls: Array<[string | null, string, Record<string, unknown>]> = [];
    const identityPlatform: IdentityPlatformAdapter = {
      mintIdToken(poolSiteId, uid, customClaims) {
        calls.push([poolSiteId, uid, customClaims]);
        return Promise.resolve({ idToken: 'id-token', expiresIn: 3500 });
      },
    };
    const env = { OPT2_ENV: 'cloud' as const, OPT2_STATE_DIR: stateDir, GOOGLE_CLOUD_PROJECT: 'proj' };
    return { cloud: createTokenService({ env, clock: CLOCK, db: handle.app, repo, identityPlatform }), calls };
  }

  it('issues cloud tokens from the custom claims and the user-pool site', async () => {
    const { cloud, calls } = cloudService();
    const minted = await cloud.mint({ sessionId: 'S-MEMBER', siteId: 'tenant-a' });

    expect(minted).toMatchObject({
      token: 'id-token', expiresAt: IAT + 3500, claims: { iss: cloudUserTokenSettings('proj').issuer, aud: 'proj', exp: IAT + 3500 },
    });
    expect(calls).toEqual([['umbrella', userId(2), { sid: 'S-MEMBER', tid: TENANT_A, site: 'tenant-a', roles: ['m:007', 'member'], s2: false, epoch: 1 }]]);
    expect(Buffer.byteLength(JSON.stringify(calls[0]?.[2]), 'utf8')).toBeLessThanOrEqual(MAX_CUSTOM_CLAIMS_BYTES);
  });

  it.each(['S-ANON', 'S-ENDED', 'S-UNKNOWN'])('issues a cloud token for session %s as the project-level anonymous principal', async (sessionId) => {
    const { cloud, calls } = cloudService();
    const epoch = anonymousEpochs.get(sessionId);
    const minted = await cloud.mint({ sessionId, siteId: 'tenant-a' });

    expect(calls).toEqual([[null, ANONYMOUS_PRINCIPAL_UID, { sid: sessionId, tid: TENANT_A, site: 'tenant-a', roles: [], s2: false, epoch }]]);
    expect(minted).toEqual({
      token: 'id-token',
      expiresAt: IAT + 3500,
      epoch,
      claims: {
        iss: cloudUserTokenSettings('proj').issuer, aud: 'proj', sub: '', sid: sessionId, tid: TENANT_A, site: 'tenant-a',
        roles: [], s2: false, epoch, iat: IAT, exp: IAT + 3500,
      },
    });
  });

  it.each([
    { sessionId: 'S-ANON', uid: ANONYMOUS_PRINCIPAL_UID, sub: '', firebase: { identities: {}, sign_in_provider: 'custom' } },
    { sessionId: 'S-MEMBER', uid: userId(2), sub: userId(2), firebase: { identities: {}, sign_in_provider: 'custom', tenant: 'ip-umbrella' } },
  ])('verifies the Identity Platform ID token of session $sessionId to the claims identity answers', async ({ sessionId, uid, sub, firebase }) => {
    const { privateKey, kid } = await testSigningKeys();
    const { issuer, audience } = cloudUserTokenSettings('proj');
    const clock = fixedClock(new Date());
    const identityPlatform: IdentityPlatformAdapter = {
      async mintIdToken(poolSiteId, signInUid, customClaims) {
        const iat = Math.floor(clock.now().getTime() / 1000);
        const tenant = poolSiteId === null ? {} : { tenant: `ip-${poolSiteId}` };
        const payload = {
          ...customClaims, iss: issuer, aud: audience, auth_time: iat, user_id: signInUid, sub: signInUid, iat, exp: iat + 3600,
          firebase: { identities: {}, sign_in_provider: 'custom', ...tenant },
        };
        return { idToken: await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).sign(privateKey), expiresIn: 3600 };
      },
    };
    const env = { OPT2_ENV: 'cloud' as const, OPT2_STATE_DIR: stateDir, GOOGLE_CLOUD_PROJECT: 'proj' };
    const minted = await createTokenService({ env, clock, db: handle.app, repo, identityPlatform }).mint({ sessionId, siteId: 'tenant-a' });
    const verifier = createUserTokenVerifier({ issuer, audience: 'proj', keySet: createLocalJWKSet(await testJwks()) });

    const idToken = decodeJwt(minted.token);
    expect(idToken).toMatchObject({ sub: uid, user_id: uid });
    expect(idToken.firebase).toEqual(firebase);
    expect(minted.claims).toMatchObject({ iss: issuer, aud: 'proj', sub, sid: sessionId, site: 'tenant-a', exp: minted.expiresAt });
    expect(await verifier.verify(minted.token)).toEqual(minted.claims);
  });

  it('refuses a cloud token for a signed-in user without a user-pool site before calling Identity Platform', async () => {
    const roleList = `S2IsPrivate;tenant-a,S2IsPrivate,${userId(6)};username;tenant-a`;
    const snapshot = { ...snapshotOf(userId(6), 'tenant-a', roleList, []), siteid: null };
    await applyLogin(sessionDeps(), { sessionId: 'S-NOPOOL', snapshot, mode: 'target-primary', siteId: 'tenant-a' });
    const { cloud, calls } = cloudService();

    await expect(cloud.mint({ sessionId: 'S-NOPOOL', siteId: 'tenant-a' })).rejects.toThrow(/no user-pool site/);
    expect(calls).toEqual([]);
  });
});
