/** Site-scoped user tokens: the local signer and JWKS, the Identity Platform adapter, and minting against a throwaway `identity` schema. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, exportPKCS8 } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LOCAL_USER_TOKEN,
  cloudUserTokenSettings,
  createUserTokenVerifier,
  loadLocalSigningKeys,
  verifyLocalServiceToken,
  type UserClaims,
} from '@opt2/platform/auth';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, testSigningKeys, writeTestSecrets, type ThrowawaySchema } from '@opt2/platform/testing';
import { applyLogin, endSession, ensureSession } from '../../src/domain/sessions.js';
import {
  MAX_CUSTOM_CLAIMS_BYTES,
  SIGN_IN_WITH_CUSTOM_TOKEN_URL,
  createFirebaseIdentityPlatformAdapter,
  createLocalTokenSigner,
  createTokenService,
  type IdentityPlatformAdapter,
  type TokenService,
  type TokenServiceOptions,
} from '../../src/domain/tokens.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS, type LoginSnapshot } from '../../src/repo/tables.js';

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

  it('signs a tenant custom token and exchanges it as the app service account', async () => {
    const keys = await testSigningKeys();
    const credential = cert({ projectId: 'proj', clientEmail: 'sa@proj.iam.gserviceaccount.com', privateKey: await exportPKCS8(keys.privateKey) });
    credential.getAccessToken = () => Promise.resolve({ access_token: 'access-1', expires_in: 3600 });
    const app = initializeApp({ projectId: 'proj', credential }, 'identity-tokens-test');
    const tenantIdForPool = (pool: string): string => `ip-${pool}`;
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
});

const available = await pgAvailable();

describe.skipIf(!available)('token minting against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let service: TokenService;
  let editors = '';
  let admins = '';
  let subscribers = '';

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
    const tenantId = tenantIdForSite(snapshot.siteid ?? '');
    await applyLogin(sessionDeps(), { sessionId, tenantId, snapshot, mode: 'target-primary', siteId: snapshot.siteid });
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

    for (const [sessionId, epoch] of [['S-ANON', anonymous.epoch], ['S-ENDED', ended.epoch], ['S-UNKNOWN', 0]] as const) {
      expect((await service.mint({ sessionId, siteId: 'tenant-a' })).claims).toMatchObject({ sub: '', sid: sessionId, roles: [], s2: false, epoch, tid: TENANT_A });
    }
  });

  it('issues cloud tokens from the custom claims and the user-pool site, refusing anonymous sessions', async () => {
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    const identityPlatform: IdentityPlatformAdapter = {
      mintIdToken(poolSiteId, uid, customClaims) {
        calls.push([poolSiteId, uid, customClaims]);
        return Promise.resolve({ idToken: 'id-token', expiresIn: 3500 });
      },
    };
    const env = { OPT2_ENV: 'cloud' as const, OPT2_STATE_DIR: stateDir, GOOGLE_CLOUD_PROJECT: 'proj' };
    const cloud = createTokenService({ env, clock: CLOCK, db: handle.app, repo, identityPlatform });
    const minted = await cloud.mint({ sessionId: 'S-MEMBER', siteId: 'tenant-a' });

    expect(minted).toMatchObject({
      token: 'id-token', expiresAt: IAT + 3500, claims: { iss: cloudUserTokenSettings('proj').issuer, aud: 'proj', exp: IAT + 3500 },
    });
    expect(calls).toEqual([['umbrella', userId(2), { sid: 'S-MEMBER', tid: TENANT_A, site: 'tenant-a', roles: ['m:007', 'member'], s2: false, epoch: 1 }]]);
    expect(Buffer.byteLength(JSON.stringify(calls[0]?.[2]), 'utf8')).toBeLessThanOrEqual(MAX_CUSTOM_CLAIMS_BYTES);
    await expect(cloud.mint({ sessionId: 'S-ANON', siteId: 'tenant-a' })).rejects.toThrow(/signed-in user/);
  });
});
