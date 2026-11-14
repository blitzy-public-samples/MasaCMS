/** Offline suite of identity's user tokens: claims from the login-time snapshot and the site registry, JWKS verification, the gateway-only mint route and Identity Platform issuance. */
import { rm } from 'node:fs/promises';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthDenial,
  INVOCATION_HEADER,
  LOCAL_USER_TOKEN,
  Roles,
  cloudUserTokenSettings,
  createUserTokenVerifier,
  moduleRole,
  userClaimsSchema,
  type UserClaims,
} from '@opt2/platform/auth';
import { SYSTEM_TENANT_ID, tenantIdForSite, withTenant, type QueryResultRow } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, mintServiceToken, registryPayloads } from '@opt2/platform/testing';
import { buildLoginSnapshot } from '../../src/domain/roles.js';
import { applyLogin, ensureSession } from '../../src/domain/sessions.js';
import { createLocalTokenSigner, createTokenService, type TokenService, type TokenServiceOptions } from '../../src/domain/tokens.js';
import {
  TEST_CLOCK,
  buildTestApp,
  createFakeIdentityPlatform,
  createTestStateDir,
  fixedClock,
  headersFor,
  testEnv,
  type FakeIdentityPlatform,
  type TestApp,
} from '../helpers/app.js';
import { createMemoryIdentityRepo, createRecordingDb, type IdentitySeed, type MemoryIdentityRepo, type RecordingDb } from '../helpers/memory-repo.js';
import {
  ADMIN_S2,
  POOLED_MEMBER,
  SITE_ADMIN_A,
  SYNTHETIC_MEMBERS,
  actorSeed,
  groupRow,
  loginSnapshotFixture,
  membershipGroupOf,
  membershipRow,
  permissionRow,
  sessionRow,
} from '../helpers/rows.js';

type LoginSnapshot = ReturnType<typeof buildLoginSnapshot>;
type MintedToken = Awaited<ReturnType<TokenService['mint']>>;

const SITE = TENANT_A.siteId;
/** A session id of the CF UUID width target-primary sessions carry. */
const SESSION = 'S0000000-0000-0000-0000000000000001';
const IAT = Math.floor(TEST_CLOCK.now().getTime() / 1000);
const PROJECT = 'opt2-tokens-test';
const TOKENS_PATH = '/internal/v1/tokens';
const JWKS_PATH = '/.well-known/jwks.json';
/** Identity Platform's limit on the JSON of a custom-claims object. */
const CUSTOM_CLAIMS_LIMIT_BYTES = 1000;
const CLAIM_KEYS = ['aud', 'epoch', 'exp', 'iat', 'iss', 'roles', 's2', 'sid', 'site', 'sub', 'tid'];
const CUSTOM_CLAIM_KEYS = ['epoch', 'roles', 's2', 'sid', 'site', 'tid'];
const REGISTRY_READ = /FROM identity\.tenant_registry\b/;
const SESSION_READ = /^SELECT \* FROM "identity"\."session" WHERE "tenant_id" = \$1 AND "session_id" = \$2$/;

/** `value`, failing the suite when a shared fixture lacks it. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new TypeError(`The identity fixtures hold no ${what}`);
  return value;
}

const ADMIN_GROUP = required(SITE_ADMIN_A.groups[0], 'tenant-a Admin group');
const PREPARER = required(SYNTHETIC_MEMBERS[Roles.financePreparer], 'finance.preparer member');
const SYNTHETIC_ACTORS = Object.values(SYNTHETIC_MEMBERS);
const SYNTHETIC_GROUPS = SYNTHETIC_ACTORS.flatMap((actor) => actor.groups);

/** Core modules granted on tenant-a, in role order. */
const GRANTED_MODULES = [
  '00000000000000000000000000000000000',
  '00000000000000000000000000000000003',
  '00000000000000000000000000000000004',
  '00000000000000000000000000000000008',
];
/** One tenant-a group per granted module, held only by the most-roles user. */
const GRANT_GROUPS = GRANTED_MODULES.map((moduleId) => groupRow({ groupname: `Module ${moduleId.slice(-3)} Grantees` }));
const MODULE_GRANTS = GRANTED_MODULES.map((contentid, index) =>
  permissionRow({ contentid, groupid: required(GRANT_GROUPS[index], 'module grantee group').userid, type: 'module' }),
);

/** An S2 user of tenant-a's private pool in its Admin group, every role-map group and every module-grant group. */
const MOST_ROLES_SNAPSHOT = loginSnapshotFixture({
  actor: ADMIN_S2,
  groups: [ADMIN_GROUP, ...SYNTHETIC_GROUPS, ...GRANT_GROUPS],
  overrides: { account: { ...ADMIN_S2.account, siteid: SITE } },
});
const MOST_ROLES = [Roles.s2, Roles.siteAdmin, ...GRANTED_MODULES.map(moduleRole), Roles.systemUser, ...Object.keys(SYNTHETIC_MEMBERS)];

const ACTOR_SEED = actorSeed(ADMIN_S2, SITE_ADMIN_A, POOLED_MEMBER, ...SYNTHETIC_ACTORS);
const SEED: IdentitySeed = { ...ACTOR_SEED, groups: [...(ACTOR_SEED.groups ?? []), ...GRANT_GROUPS], permissions: MODULE_GRANTS };

/** `tenant_registry` rows of the platform fixture sites; an unset pool is the site's own, as settingsBean defaults it. */
const REGISTRY_ROWS: readonly QueryResultRow[] = registryPayloads().map((payload) => {
  const pool = (site: string | null | undefined): string => site ?? payload.siteId;
  const pools = {
    public_user_pool: pool(payload.publicUserPoolId),
    private_user_pool: pool(payload.privateUserPoolId),
    category_pool: pool(payload.categoryPoolId),
    file_pool: pool(payload.filePoolId),
    display_pool: pool(payload.displayPoolId),
  };
  const content = [payload.contentPoolIds ?? []].flat();
  return {
    site_id: payload.siteId,
    tenant_id: tenantIdForSite(payload.siteId),
    ...Object.fromEntries(Object.entries(pools).flatMap(([column, site]) => [[`${column}_id`, site], [`${column}_tenant`, tenantIdForSite(site)]])),
    content_pool_ids: content,
    content_pool_tenants: content.map((site) => tenantIdForSite(site)),
    domains: payload.domains ?? [],
    aggregate_version: '1',
    updated_at: TEST_CLOCK.now(),
  };
});

/** Rows of a registry read of `@opt2/platform/tenancy`, selected as its WHERE clause selects them. */
function registryAnswer(sql: string, values: readonly unknown[]): QueryResultRow[] {
  const [first] = values;
  if (/WHERE lower\(site_id\) = lower\(\$1\)/.test(sql)) {
    return REGISTRY_ROWS.filter((row) => String(row.site_id).toLowerCase() === String(first).toLowerCase());
  }
  if (/WHERE tenant_id = \$1/.test(sql)) return REGISTRY_ROWS.filter((row) => row.tenant_id === first);
  return [...REGISTRY_ROWS];
}

/** UTF-8 size of the JSON of a token's custom claims, the part Identity Platform limits. */
function customClaimsBytes(claims: Pick<UserClaims, 'sid' | 'tid' | 'site' | 'roles' | 's2' | 'epoch'>): number {
  const { sid, tid, site, roles, s2, epoch } = claims;
  return Buffer.byteLength(JSON.stringify({ sid, tid, site, roles, s2, epoch }), 'utf8');
}

let stateDir: string;

beforeAll(async () => {
  stateDir = await createTestStateDir();
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** A token service over a memory repository and a database answering the fixture registry. */
interface Harness {
  db: RecordingDb;
  repo: MemoryIdentityRepo;
  deps: { db: RecordingDb; repo: MemoryIdentityRepo; clock: TokenServiceOptions['clock'] };
  tokens: TokenService;
  /** Logs `snapshot` into {@link SESSION} at tenant-a; resolves to the session epoch. */
  login(snapshot: LoginSnapshot): Promise<number>;
  mint(siteId?: string): Promise<MintedToken>;
}

function harness(seed: IdentitySeed, opts: Partial<Pick<TokenServiceOptions, 'env' | 'clock' | 'identityPlatform'>> = {}): Harness {
  const clock = opts.clock ?? TEST_CLOCK;
  const db = createRecordingDb({ responses: [[REGISTRY_READ, registryAnswer]] });
  const repo = createMemoryIdentityRepo(seed, { clock });
  const deps = { db, repo, clock };
  const tokens = createTokenService({
    env: opts.env ?? testEnv({}, stateDir),
    clock,
    db,
    repo,
    signer: createLocalTokenSigner({ stateDir }),
    identityPlatform: opts.identityPlatform,
  });
  return {
    db,
    repo,
    deps,
    tokens,
    async login(snapshot) {
      return (await applyLogin(deps, { sessionId: SESSION, snapshot, mode: 'target-primary', siteId: SITE })).epoch;
    },
    mint: (siteId = SITE) => tokens.mint({ sessionId: SESSION, siteId }),
  };
}

describe('local user-token claims', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness(SEED);
  });

  it('signs exactly the declared claims of a signed-in site admin under the local issuer', async () => {
    const epoch = await h.login(loginSnapshotFixture({ actor: SITE_ADMIN_A }));
    const minted = await h.mint();
    const payload = decodeJwt(minted.token);

    expect(Object.keys(payload).sort()).toEqual(CLAIM_KEYS);
    expect(userClaimsSchema.parse(payload)).toEqual(payload);
    expect(payload).toEqual({
      iss: LOCAL_USER_TOKEN.issuer,
      aud: LOCAL_USER_TOKEN.audience,
      sub: SITE_ADMIN_A.account.userid,
      sid: SESSION,
      tid: TENANT_A.tenantId,
      site: SITE,
      roles: [Roles.siteAdmin, Roles.systemUser],
      s2: false,
      epoch,
      iat: IAT,
      exp: IAT + 300,
    });
    expect(epoch).toBe(1);
    expect(minted).toEqual({ token: minted.token, expiresAt: IAT + 300, epoch, claims: payload });
    expect(decodeProtectedHeader(minted.token)).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: expect.any(String) });
  });

  it('takes tid from the registry entry the requested legacy site resolves to', async () => {
    await h.login(loginSnapshotFixture({ actor: SITE_ADMIN_A }));
    const before = h.db.statements().length;

    const { claims } = await h.mint();

    const lookups = h.db
      .statements()
      .slice(before)
      .filter((statement) => REGISTRY_READ.test(statement.sql))
      .map((statement) => statement.values);
    expect(lookups).toEqual([[SITE], [TENANT_A.tenantId]]);
    expect(claims).toMatchObject({ site: SITE, tid: TENANT_A.tenantId });
  });

  it.each<[string, LoginSnapshot, readonly string[]]>([
    ['an S2 site admin in every role-map group with module grants', MOST_ROLES_SNAPSHOT, MOST_ROLES],
    ['a tenant-a site admin', loginSnapshotFixture({ actor: SITE_ADMIN_A }), [Roles.siteAdmin, Roles.systemUser]],
    ['a pooled public member', loginSnapshotFixture({ actor: POOLED_MEMBER }), [Roles.member]],
    ...Object.entries(SYNTHETIC_MEMBERS).map(([role, actor]): [string, LoginSnapshot, readonly string[]] => [
      `the ${role} group member`,
      loginSnapshotFixture({ actor }),
      [Roles.systemUser, role],
    ]),
  ])('keeps the custom claims of %s under 1,000 UTF-8 bytes', async (_label, snapshot, roles) => {
    await h.login(snapshot);

    const { claims } = await h.mint();

    expect(claims.roles).toEqual(roles);
    expect(claims.s2).toBe(roles.includes(Roles.s2));
    expect(customClaimsBytes(claims)).toBeLessThan(CUSTOM_CLAIMS_LIMIT_BYTES);
  });

  it.each([
    ['registered site tenant-a', SITE, { roles: [Roles.s2], s2: true, tid: TENANT_A.tenantId }],
    ['an unregistered site', 'unregistered-site', { roles: [], s2: false, tid: tenantIdForSite('unregistered-site') }],
  ])('gives the S2 admin on %s the roles its registration allows', async (_label, siteId, expected) => {
    await h.login(loginSnapshotFixture({ actor: ADMIN_S2 }));

    const { claims } = await h.mint(siteId);

    expect(claims).toMatchObject({ sub: ADMIN_S2.account.userid, site: siteId, ...expected });
  });

  it.each<[string, (deps: Harness['deps']) => Promise<number>]>([
    ['an anonymous session', async (deps) => (await ensureSession(deps, { sessionId: SESSION, mode: 'target-primary' })).epoch],
    ['an unknown session', async () => 0],
  ])('mints %s a token without a user or roles', async (_label, prepare) => {
    const epoch = await prepare(h.deps);

    const { claims } = await h.mint();

    expect(claims).toMatchObject({ sub: '', sid: SESSION, site: SITE, tid: TENANT_A.tenantId, roles: [], s2: false, epoch });
  });
});

describe('the login-time snapshot', () => {
  const NEW_ADMIN_GROUP = groupRow({ groupname: 'Admin' });
  let h: Harness;
  let atLogin: UserClaims;

  beforeEach(async () => {
    h = harness({ ...actorSeed(PREPARER), groups: [...PREPARER.groups, NEW_ADMIN_GROUP] });
    await h.login(loginSnapshotFixture({ actor: PREPARER }));
    atLogin = (await h.mint()).claims;
    await withTenant(h.db, TENANT_A.tenantId, (tx) => h.repo.addMembership(tx, PREPARER.account.userid, NEW_ADMIN_GROUP.userid));
  });

  it('keeps minting the login-time roles after an Admin membership is added', async () => {
    expect(h.repo.rows('membership', TENANT_A.tenantId)).toContainEqual(
      expect.objectContaining(membershipRow({ userid: PREPARER.account.userid, groupid: NEW_ADMIN_GROUP.userid })),
    );

    const { claims } = await h.mint();

    expect(atLogin.roles).toEqual([Roles.systemUser, Roles.financePreparer]);
    expect(claims).toEqual(atLogin);
  });

  it('mints the rebuilt roles and the next epoch after a re-login', async () => {
    const relogin = buildLoginSnapshot({
      account: PREPARER.account,
      credential: PREPARER.credential,
      loginState: PREPARER.loginState,
      contact: PREPARER.contact,
      groups: [...PREPARER.groups, NEW_ADMIN_GROUP].map(membershipGroupOf),
    });

    const epoch = await h.login(relogin);
    const { claims } = await h.mint();

    expect(epoch).toBe(atLogin.epoch + 1);
    expect(claims).toEqual({ ...atLogin, roles: [Roles.siteAdmin, Roles.systemUser, Roles.financePreparer], epoch });
  });
});

describe('the token routes', () => {
  const STORED_SESSION = sessionRow({
    tenant_id: SYSTEM_TENANT_ID,
    session_id: SESSION,
    user_id: SITE_ADMIN_A.account.userid,
    site_id: SITE,
    login_snapshot: JSON.stringify(loginSnapshotFixture({ actor: SITE_ADMIN_A })),
    epoch: '3',
  });
  let t: TestApp;

  beforeAll(async () => {
    // Route-minted tokens are verified against the current time, so this app's clock is the suite's start.
    t = await buildTestApp({ clock: fixedClock(new Date()) });
    t.db.respond(REGISTRY_READ, registryAnswer);
    t.db.respond((sql, values) => SESSION_READ.test(sql) && values[0] === SYSTEM_TENANT_ID && values[1] === SESSION, [STORED_SESSION]);
    await t.app.ready();
  });

  afterAll(async () => {
    await t?.app.close();
  });

  async function publishedKeys(): Promise<JSONWebKeySet> {
    return (await t.app.inject({ method: 'GET', url: JWKS_PATH })).json<JSONWebKeySet>();
  }

  function verifierOver(jwks: JSONWebKeySet) {
    return createUserTokenVerifier({ issuer: LOCAL_USER_TOKEN.issuer, audience: LOCAL_USER_TOKEN.audience, keySet: createLocalJWKSet(jwks) });
  }

  function postToken(headers: Record<string, string>, body: Record<string, unknown>) {
    return t.app.inject({ method: 'POST', url: TOKENS_PATH, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  }

  it('publishes the local RS256 key without credentials', async () => {
    const res = await t.app.inject({ method: 'GET', url: JWKS_PATH });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const { keys } = res.json<JSONWebKeySet>();
    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0] ?? {}).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
    expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
  });

  it('mints the stored session token for the gateway under the published kid, ignoring claims the body names', async () => {
    const res = await postToken(await headersFor('service:gateway'), {
      sessionId: SESSION,
      siteId: SITE,
      tid: TENANT_B.tenantId,
      roles: [Roles.s2],
      sub: ADMIN_S2.account.userid,
    });

    expect(res.statusCode).toBe(200);
    const minted = res.json<MintedToken>();
    expect(minted.claims).toMatchObject({
      sub: SITE_ADMIN_A.account.userid,
      sid: SESSION,
      site: SITE,
      tid: TENANT_A.tenantId,
      roles: [Roles.siteAdmin, Roles.systemUser],
      s2: false,
      epoch: 3,
    });
    expect(minted).toMatchObject({ epoch: 3, expiresAt: minted.claims.exp });
    const jwks = await publishedKeys();
    expect(decodeProtectedHeader(minted.token).kid).toBe(jwks.keys[0]?.kid);
    expect(await verifierOver(jwks).verify(minted.token)).toEqual(minted.claims);
  });

  it('has a token whose exp lies before the verifier clock rejected as accessTokenExpired', async () => {
    const lapsed = harness(SEED, { clock: fixedClock(Date.now() - 2 * LOCAL_USER_TOKEN.lifetimeSeconds * 1000) });
    await lapsed.login(loginSnapshotFixture({ actor: SITE_ADMIN_A }));
    const { token } = await lapsed.mint();

    const verified = verifierOver(await publishedKeys()).verify(token);

    await expect(verified).rejects.toBeInstanceOf(AuthDenial);
    await expect(verified).rejects.toMatchObject({ type: 'accessTokenExpired', statusCode: 401 });
  });

  it.each(['people', 'web', 'migration', 'identity', 'reporting', 'operator'])(
    'refuses %s a token with 403 before the session or registry is read',
    async (caller) => {
      const before = t.db.statements().length;

      const res = await postToken(
        { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: 'identity' })}` },
        { sessionId: SESSION, siteId: SITE },
      );

      expect(res.statusCode).toBe(403);
      expect(res.json()).not.toHaveProperty('token');
      const reads = t.db
        .statements()
        .slice(before)
        .filter((statement) => SESSION_READ.test(statement.sql) || REGISTRY_READ.test(statement.sql));
      expect(reads).toEqual([]);
    },
  );
});

describe('Identity Platform issuance', () => {
  const { issuer, audience } = cloudUserTokenSettings(PROJECT);
  let platform: FakeIdentityPlatform;
  let h: Harness;

  beforeEach(() => {
    platform = createFakeIdentityPlatform();
    const env = testEnv(
      {
        OPT2_ENV: 'cloud',
        OPT2_DB_AUTH: undefined,
        OPT2_TASKS_ADAPTER: 'cloud',
        OPT2_STORAGE_ADAPTER: 'cloud',
        GOOGLE_CLOUD_PROJECT: PROJECT,
        OPT2_TOKEN_ISSUER: issuer,
        OPT2_TOKEN_AUDIENCE: audience,
      },
      stateDir,
    );
    h = harness(SEED, { env, identityPlatform: platform });
  });

  it.each<[string, LoginSnapshot, string, readonly string[]]>([
    ['a pooled public member', loginSnapshotFixture({ actor: POOLED_MEMBER }), TENANT_UMBRELLA.siteId, [Roles.member]],
    ['a tenant-a site admin', loginSnapshotFixture({ actor: SITE_ADMIN_A }), TENANT_A.siteId, [Roles.siteAdmin, Roles.systemUser]],
    ['the most-roles S2 user', MOST_ROLES_SNAPSHOT, TENANT_A.siteId, MOST_ROLES],
  ])('signs %s in to the tenant of its user-pool site with compact custom claims', async (_label, snapshot, poolSiteId, roles) => {
    const epoch = await h.login(snapshot);

    const minted = await h.mint();

    const s2 = roles.includes(Roles.s2);
    expect(platform.calls).toEqual([
      { poolSiteId, uid: snapshot.userid, customClaims: { sid: SESSION, tid: TENANT_A.tenantId, site: SITE, roles, s2, epoch } },
    ]);
    const { customClaims } = required(platform.calls[0], 'Identity Platform call');
    expect(Object.keys(customClaims).sort()).toEqual(CUSTOM_CLAIM_KEYS);
    expect(customClaims).not.toHaveProperty('aud');
    expect(customClaims).not.toHaveProperty('iss');
    expect(Buffer.byteLength(JSON.stringify(customClaims), 'utf8')).toBeLessThan(CUSTOM_CLAIMS_LIMIT_BYTES);
    expect(minted).toEqual({
      token: 'fake-identity-platform-id-token.1',
      expiresAt: IAT + 3600,
      epoch,
      claims: { iss: issuer, aud: audience, sub: snapshot.userid, sid: SESSION, tid: TENANT_A.tenantId, site: SITE, roles, s2, epoch, iat: IAT, exp: IAT + 3600 },
    });
  });
});
