/** Site-scoped user tokens: the local RS256 signer and its JWKS, the Identity Platform adapter, and the token service. */
import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { SignJWT, exportJWK, type JWK } from 'jose';
import {
  LOCAL_USER_TOKEN,
  Roles,
  cloudUserTokenSettings,
  loadLocalSigningKeys,
  signLocalServiceToken,
  userClaimsSchema,
  type LocalSigningKeys,
  type UserClaims,
} from '@opt2/platform/auth';
import type { BaseEnv, Clock } from '@opt2/platform/service-kit';
import {
  registryEntryForTenant,
  tenantForRegisteredSite,
  tenantIdForSite,
  withTenant,
  type TenantDb,
  type TenantRegistryEntry,
} from '@opt2/platform/tenancy';
import { createIdentityRepository, type IdentityRepository } from '../repo/repository.js';
import type { GroupAccountRow, LoginSnapshot } from '../repo/tables.js';
import { loadRoleMap, tokenRolesFor, type ModuleGroupGrant } from './roles.js';
import { locateSession } from './sessions.js';

/** A JSON Web Key Set, as `/.well-known/jwks.json` publishes it. */
export interface Jwks {
  keys: JWK[];
}

/** Signs user-token claims and publishes the keys that verify them. */
export interface TokenSigner {
  /** A compact JWS carrying exactly `claims`. */
  sign(claims: UserClaims): Promise<string>;
  jwks(): Promise<Jwks>;
}

/** Options of {@link createLocalTokenSigner}; the key pair lives under `${stateDir}/secrets/`. */
export interface LocalTokenSignerOptions {
  stateDir: string;
}

/** Mints Identity Platform ID tokens for a user of one user-pool site. */
export interface IdentityPlatformAdapter {
  /** Custom-token sign-in of `uid` in the Identity Platform tenant of `poolSiteId`; `expiresIn` is in seconds. */
  mintIdToken(poolSiteId: string, uid: string, customClaims: Record<string, unknown>): Promise<{ idToken: string; expiresIn: number }>;
}

/** Options of {@link createFirebaseIdentityPlatformAdapter}; `app` defaults to the default Firebase app with application-default credentials. */
export interface FirebaseIdentityPlatformOptions {
  projectId: string;
  /** Identity Platform tenant id of a user-pool site id. */
  tenantIdForPool: (poolSiteId: string) => string;
  fetchImpl?: typeof fetch;
  app?: App;
}

/** Body of `POST /internal/v1/tokens`, the contract's `TokenRequest`. */
export interface TokenRequest {
  sessionId: string;
  /** Legacy site id the token is scoped to. */
  siteId: string;
}

/** The contract's `UserTokenResponse`; `expiresAt` is in epoch seconds. */
export interface UserTokenResponse {
  token: string;
  expiresAt: number;
  epoch: number;
  claims: UserClaims;
}

/** Dependencies of {@link createTokenService}; `repo` defaults to a repository on the same clock. */
export interface TokenServiceOptions {
  env: Pick<BaseEnv, 'OPT2_ENV' | 'OPT2_STATE_DIR' | 'GOOGLE_CLOUD_PROJECT'>;
  clock: Clock;
  db: TenantDb;
  repo?: IdentityRepository;
  /** Local signer; defaults to the key pair in `OPT2_STATE_DIR`. */
  signer?: TokenSigner;
  /** Required in the cloud. */
  identityPlatform?: IdentityPlatformAdapter;
}

/** User tokens, the JWKS that verifies them, and local service tokens. */
export interface TokenService {
  /** The session's user token for one site; a site the user may not use yields a token without roles. */
  mint(request: TokenRequest): Promise<UserTokenResponse>;
  /** The local signer's key set; empty in the cloud, where tokens verify against Google's securetoken keys. */
  jwks(): Promise<Jwks>;
  /** A local invocation credential of service `name` for the callee `audience`; the cloud has none, since Google mints them. */
  mintServiceToken(request: { name: string; audience: string }): Promise<string>;
}

/** Largest JSON size of an Identity Platform custom-claims object. */
export const MAX_CUSTOM_CLAIMS_BYTES = 1000;

/** Identity Toolkit endpoint exchanging a custom token for an ID token. */
export const SIGN_IN_WITH_CUSTOM_TOKEN_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken';

/** Lifetime of an Identity Platform ID token. */
const CLOUD_USER_TOKEN_LIFETIME_SECONDS = 3600;

/** Issuance of one mode: the claims' issuer, audience and lifetime, and how a token for them is obtained. */
interface Issuer {
  issuer: string;
  audience: string;
  lifetimeSeconds: number;
  issue(claims: UserClaims, snapshot: LoginSnapshot | undefined): Promise<{ token: string; exp: number }>;
}

/** Loads the local key pair with its private key once; a failed load is retried at the next call. */
function localKeyLoader(stateDir: string): () => Promise<Required<LocalSigningKeys>> {
  let loaded: Promise<Required<LocalSigningKeys>> | undefined;
  return () =>
    (loaded ??= loadLocalSigningKeys(stateDir, { requirePrivate: true }).then(
      (keys) => {
        if (keys.privateKey === undefined) throw new Error(`No private signing key under ${stateDir}`);
        return { ...keys, privateKey: keys.privateKey };
      },
      (err: unknown) => {
        loaded = undefined;
        throw err;
      },
    ));
}

/** RS256 signer over `${stateDir}/secrets/`'s token-signing pair; `kid` is the thumbprint the platform loader computes. */
export function createLocalTokenSigner(opts: LocalTokenSignerOptions): TokenSigner {
  const keys = localKeyLoader(opts.stateDir);
  return {
    async sign(claims) {
      const { privateKey, kid } = await keys();
      return new SignJWT({ ...claims }).setProtectedHeader({ alg: LOCAL_USER_TOKEN.algorithm, kid, typ: 'JWT' }).sign(privateKey);
    },
    async jwks() {
      const { publicKey, kid } = await keys();
      const { kty, n, e } = await exportJWK(publicKey);
      return { keys: [{ kty, n, e, kid, alg: LOCAL_USER_TOKEN.algorithm, use: 'sig' }] };
    },
  };
}

/** The default Firebase app, initialised for `projectId` with application-default credentials when absent. */
function defaultFirebaseApp(projectId: string): App {
  return getApps().find((app) => app.name === '[DEFAULT]') ?? initializeApp({ projectId, credential: applicationDefault() });
}

/** Identity Platform adapter: a tenant-scoped `createCustomToken`, then `accounts:signInWithCustomToken` as the app's service account. */
export function createFirebaseIdentityPlatformAdapter(opts: FirebaseIdentityPlatformOptions): IdentityPlatformAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let app = opts.app;
  return {
    async mintIdToken(poolSiteId, uid, customClaims) {
      const size = Buffer.byteLength(JSON.stringify(customClaims), 'utf8');
      if (size > MAX_CUSTOM_CLAIMS_BYTES) {
        throw new RangeError(`Custom claims of ${uid} are ${String(size)} bytes; Identity Platform allows ${String(MAX_CUSTOM_CLAIMS_BYTES)}`);
      }
      app ??= defaultFirebaseApp(opts.projectId);
      const tenantId = opts.tenantIdForPool(poolSiteId);
      const customToken = await getAuth(app).tenantManager().authForTenant(tenantId).createCustomToken(uid, customClaims);
      const credential = app.options.credential;
      if (credential === undefined) throw new Error(`Firebase app ${app.name} has no credential for signInWithCustomToken`);
      const { access_token: accessToken } = await credential.getAccessToken();
      const response = await fetchImpl(SIGN_IN_WITH_CUSTOM_TOKEN_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ token: customToken, tenantId, returnSecureToken: true }),
      });
      const body = (await response.json().catch(() => ({}))) as { idToken?: unknown; expiresIn?: unknown; error?: { message?: unknown } };
      const expiresIn = Number(body.expiresIn);
      if (!response.ok || typeof body.idToken !== 'string' || !Number.isInteger(expiresIn) || expiresIn <= 0) {
        const reason = typeof body.error?.message === 'string' ? ` ${body.error.message}` : '';
        throw new Error(`signInWithCustomToken failed for tenant ${tenantId}: HTTP ${String(response.status)}${reason}`);
      }
      return { idToken: body.idToken, expiresIn };
    },
  };
}

/** CFML list items of a comma list, empty items skipped. */
function listItems(list: string): string[] {
  return list.split(',').filter((item) => item !== '');
}

/** The session's epoch (0 when unknown) and its user's login-time snapshot, absent for a missing, ended or anonymous session. */
async function signedInSnapshot(db: TenantDb, repo: IdentityRepository, sessionId: string): Promise<{ snapshot?: LoginSnapshot; epoch: number }> {
  // A missing or ended session mints an anonymous token rather than an error, as legacy serves a request without a live session anonymously.
  const located = await locateSession({ db, repo }, sessionId);
  if (located === undefined) return { epoch: 0 };
  const { row } = located;
  const epoch = Number(row.epoch);
  if (row.state !== 'active' || row.user_id === null || row.login_snapshot === null) return { epoch };
  return { snapshot: JSON.parse(row.login_snapshot) as LoginSnapshot, epoch };
}

/** The site's module grants to the snapshot's login-time groups, each joined to its group's current name and visibility. */
async function moduleGrantsFor(
  db: TenantDb,
  repo: IdentityRepository,
  snapshot: LoginSnapshot,
  entry: TenantRegistryEntry,
): Promise<ModuleGroupGrant[]> {
  // getModulePerm matches granted groups' current names against the login-time role list, so the login-time memberships bound the candidates.
  const groupIds = listItems(snapshot.membershipIds);
  const grants = await withTenant(db, entry.tenantId, (tx) => repo.moduleGrants(tx, groupIds, entry.siteId));
  if (grants.length === 0) return [];
  const grantedIds = [...new Set(grants.map((grant) => grant.groupId))];
  const poolTenants = new Set([entry.privateUserPoolTenant ?? entry.tenantId, entry.publicUserPoolTenant ?? entry.tenantId]);
  // Keys drop trailing spaces, as the repository's bpchar id comparison does.
  const groups = new Map<string, GroupAccountRow>();
  for (const poolTenant of poolTenants) {
    for (const group of await withTenant(db, poolTenant, (tx) => repo.findGroupsByIds(tx, grantedIds))) {
      const key = group.userid.trimEnd();
      if (!groups.has(key)) groups.set(key, group);
    }
  }
  return grants.flatMap((grant) => {
    const group = groups.get(grant.groupId.trimEnd());
    return group === undefined ? [] : [{ moduleId: grant.contentId, groupName: group.groupname, isPublic: group.ispublic }];
  });
}

/** Local issuance: claims signed by `signer` under the local issuer, audience and lifetime. */
function localIssuer(signer: TokenSigner): Issuer {
  return {
    issuer: LOCAL_USER_TOKEN.issuer,
    audience: LOCAL_USER_TOKEN.audience,
    lifetimeSeconds: LOCAL_USER_TOKEN.lifetimeSeconds,
    async issue(claims) {
      return { token: await signer.sign(claims), exp: claims.exp };
    },
  };
}

/** Cloud issuance: an Identity Platform ID token for the user in the tenant of their user-pool site. */
function cloudIssuer(project: string, platform: IdentityPlatformAdapter): Issuer {
  const { issuer, audience } = cloudUserTokenSettings(project);
  return {
    issuer,
    audience,
    lifetimeSeconds: CLOUD_USER_TOKEN_LIFETIME_SECONDS,
    async issue(claims, snapshot) {
      const poolSiteId = snapshot?.siteid ?? '';
      // Identity Platform needs a non-empty uid while an anonymous token's sub is ''; a stand-in uid would read as a signed-in user.
      if (claims.sub === '' || poolSiteId === '') {
        throw new Error('Identity Platform ID tokens need a signed-in user of a user-pool site');
      }
      const { sid, tid, site, roles, s2, epoch } = claims;
      const minted = await platform.mintIdToken(poolSiteId, claims.sub, { sid, tid, site, roles, s2, epoch });
      return { token: minted.idToken, exp: claims.iat + minted.expiresIn };
    },
  };
}

/** The token service of `options.env.OPT2_ENV`; throws when the cloud lacks `GOOGLE_CLOUD_PROJECT` or an Identity Platform adapter. */
export function createTokenService(options: TokenServiceOptions): TokenService {
  const { env, clock, db } = options;
  const repo = options.repo ?? createIdentityRepository({ clock });
  const local = env.OPT2_ENV === 'local';
  let issuer: Issuer;
  let signer: TokenSigner | undefined;
  if (local) {
    signer = options.signer ?? createLocalTokenSigner({ stateDir: env.OPT2_STATE_DIR });
    issuer = localIssuer(signer);
  } else {
    if (env.GOOGLE_CLOUD_PROJECT === undefined) throw new Error('GOOGLE_CLOUD_PROJECT is required to mint Identity Platform tokens');
    if (options.identityPlatform === undefined) throw new Error('An Identity Platform adapter is required to mint tokens in the cloud');
    issuer = cloudIssuer(env.GOOGLE_CLOUD_PROJECT, options.identityPlatform);
  }
  const serviceKeys = localKeyLoader(env.OPT2_STATE_DIR);

  /** Token roles of the snapshot on the registered site `entry`. */
  async function rolesOn(snapshot: LoginSnapshot, entry: TenantRegistryEntry): Promise<string[]> {
    const moduleGrants = await moduleGrantsFor(db, repo, snapshot, entry);
    return tokenRolesFor(snapshot, entry, { moduleGrants, roleMap: await loadRoleMap() }).roles;
  }

  return {
    async mint({ sessionId, siteId }) {
      const { snapshot, epoch } = await signedInSnapshot(db, repo, sessionId);
      const entry = await db.withMetadata(async (tx) => {
        const tenantId = await tenantForRegisteredSite(tx, siteId);
        return tenantId === null ? null : registryEntryForTenant(tx, tenantId);
      });
      const roles = snapshot === undefined || entry === null ? [] : await rolesOn(snapshot, entry);
      const iat = Math.floor(clock.now().getTime() / 1000);
      const claims = userClaimsSchema.parse({
        iss: issuer.issuer,
        aud: issuer.audience,
        sub: snapshot?.userid ?? '',
        sid: sessionId,
        tid: entry?.tenantId ?? tenantIdForSite(siteId),
        site: siteId,
        roles,
        // S2 follows the granted roles, so a token for a site without access carries no S2 authority either.
        s2: roles.includes(Roles.s2),
        epoch,
        iat,
        exp: iat + issuer.lifetimeSeconds,
      });
      const { token, exp } = await issuer.issue(claims, snapshot);
      return { token, expiresAt: exp, epoch, claims: { ...claims, exp } };
    },

    async jwks() {
      return signer === undefined ? { keys: [] } : signer.jwks();
    },

    async mintServiceToken({ name, audience }) {
      if (!local) throw new Error('Cloud invocation credentials are minted by Google, not by identity');
      return signLocalServiceToken({ keys: await serviceKeys(), caller: name, audience });
    },
  };
}
