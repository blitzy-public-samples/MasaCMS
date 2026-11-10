import { createSecretKey, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoogleAuth, IdTokenClient, OAuth2Client } from 'google-auth-library';
import { CertificateFormat } from 'google-auth-library/build/src/auth/oauth2client.js';
import {
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  errors,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  jwtVerify,
  type CryptoKey,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthDenial, TRANSPORTS, type AuthDenialReason, type AuthDenialType } from '../../src/auth/claims.js';
import {
  INVOCATION_HEADER,
  LOCAL_SECRET_FILES,
  LOCAL_SERVICE_ISSUER,
  LOCAL_SERVICE_TOKEN_TTL_SECONDS,
  MANAGED_INVOKER_NAMES,
  SIGNATURE_REMOVED_MARKER,
  createCloudInvocationMinter,
  createCloudInvocationVerifier,
  createCloudRunInvocationReader,
  createLocalInvocationMinter,
  createLocalInvocationVerifier,
  invocationAudience,
  loadLocalSigningKeys,
  localSecretPath,
  serviceAccountEmail,
  serviceIdentityFromEmail,
  signLocalServiceToken,
  verifyLocalServiceToken,
  type LocalSigningKeys,
} from '../../src/auth/invocation.js';
import { rolesForService } from '../../src/auth/roles.js';
import {
  GOOGLE_SECURETOKEN_JWKS_URL,
  LOCAL_USER_TOKEN,
  assertSiteMatches,
  cloudUserTokenSettings,
  createUserTokenVerifier,
  type UserTokenVerifier,
} from '../../src/auth/user-token.js';
import { LegacyApiError } from '../../src/legacy-compat/index.js';

const NOW = Math.floor(Date.now() / 1000);
const PROJECT = 'proj';
const TENANT_ID = '3d5c8a1e-7f2b-5c4d-9e6a-0b1c2d3e4f5a';
const PEOPLE_URL = 'https://opt2-people-abc123-uc.a.run.app';
const FINANCE_URL = 'https://opt2-finance-abc123-uc.a.run.app';
const PUSH_ENDPOINT = `${PEOPLE_URL}/internal/v1/events/timesheets-people-archived`;
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GATEWAY_EMAIL = 'opt2-gateway@proj.iam.gserviceaccount.com';
const PUBSUB_INVOKER_EMAIL = 'opt2-pubsub-invoker@proj.iam.gserviceaccount.com';
const TASKS_INVOKER_EMAIL = 'opt2-tasks-invoker@proj.iam.gserviceaccount.com';
const BASIC_HEADER = 'Basic dXNlcg==';
const BEARER_CHALLENGE = 'Bearer error="invalid_access_token"';

interface DenialShape {
  statusCode: 401 | 403;
  type: AuthDenialType;
  reason: AuthDenialReason;
  wwwAuthenticate: string | undefined;
}

const INVALID_ACCESS_TOKEN: DenialShape = {
  statusCode: 401,
  type: 'invalidAccessToken',
  reason: 'invalid-credential',
  wwwAuthenticate: BEARER_CHALLENGE,
};
const ACCESS_TOKEN_EXPIRED: DenialShape = {
  statusCode: 401,
  type: 'accessTokenExpired',
  reason: 'expired-credential',
  wwwAuthenticate: BEARER_CHALLENGE,
};
const INVALID_CREDENTIAL: DenialShape = {
  statusCode: 401,
  type: 'authorization',
  reason: 'invalid-credential',
  wwwAuthenticate: undefined,
};
const WRONG_SCHEME: DenialShape = { ...INVALID_CREDENTIAL, reason: 'wrong-scheme' };

interface SigningKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: string;
}

/** Generates an extractable RS256 key pair with its RFC 7638 thumbprint as kid. */
async function newSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return { privateKey, publicKey, kid: await calculateJwkThumbprint(await exportJWK(publicKey)) };
}

/** Signs `payload` as an RS256 JWT with `key`, announcing `kid` in the header. */
function signToken(payload: JWTPayload, key: SigningKey, kid = key.kid): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).sign(key.privateKey);
}

/** Site-scoped user token claims as identity's local signer mints them; an `undefined` override drops the claim. */
function userClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: LOCAL_USER_TOKEN.issuer,
    aud: LOCAL_USER_TOKEN.audience,
    sub: 'A1B2C3D4-E5F6-7A8B-9C0D1E2F3A4B5C6D',
    sid: 'b7e6d5c4-session',
    tid: TENANT_ID,
    site: 'tenant-a',
    roles: ['site-admin', 'm:008'],
    s2: false,
    epoch: 3,
    iat: NOW,
    exp: NOW + LOCAL_USER_TOKEN.lifetimeSeconds,
    ...overrides,
  };
}

/** Google-signed OIDC ID token claims of the gateway's service account, addressed to the people service. */
function googleOidcClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: GOOGLE_ISSUER,
    aud: PEOPLE_URL,
    azp: '104729384756102938475',
    sub: '104729384756102938475',
    email: GATEWAY_EMAIL,
    email_verified: true,
    iat: NOW,
    exp: NOW + 3600,
    ...overrides,
  };
}

/** Local service token claims of the gateway addressed to the people service. */
function serviceClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: LOCAL_SERVICE_ISSUER,
    aud: 'people',
    sub: 'service:gateway',
    roles: ['service:gateway'],
    iat: NOW,
    exp: NOW + LOCAL_SERVICE_TOKEN_TTL_SECONDS,
    ...overrides,
  };
}

/** Builds the token Cloud Run forwards after verifying it: the signature segment replaced by the marker. */
function cloudRunForwarded(payload: JWTPayload): string {
  const encode = (part: object): string => Buffer.from(JSON.stringify(part)).toString('base64url');
  return `${encode({ alg: 'RS256', kid: 'google-key-1', typ: 'JWT' })}.${encode(payload)}.${SIGNATURE_REMOVED_MARKER}`;
}

/** Runs `action` and returns the status, legacy type, reason and challenge of the AuthDenial it throws. */
async function denialOf(action: () => unknown): Promise<DenialShape> {
  let outcome: unknown;
  try {
    await action();
  } catch (err) {
    outcome = err;
  }
  if (!(outcome instanceof AuthDenial)) {
    throw new Error(`Expected an AuthDenial, got ${String(outcome)}`);
  }
  return {
    statusCode: outcome.statusCode,
    type: outcome.type,
    reason: outcome.reason,
    wwwAuthenticate: outcome.wwwAuthenticate,
  };
}

type FederatedCerts = Awaited<ReturnType<OAuth2Client['getFederatedSignonCertsAsync']>>;

/** OAuth2Client whose Google signing certificates come from an in-memory PEM map instead of the federated endpoint. */
class InMemoryCertsClient extends OAuth2Client {
  constructor(private readonly pems: Record<string, string>) {
    super();
  }

  override getFederatedSignonCertsAsync(): Promise<FederatedCerts> {
    return Promise.resolve({ certs: this.pems, format: CertificateFormat.PEM });
  }
}

/** GoogleAuth handing out the given ID-token clients instead of discovering credentials. */
class InMemoryGoogleAuth extends GoogleAuth {
  readonly requestedAudiences: string[] = [];

  constructor(private readonly clientFor: (audience: string) => IdTokenClient) {
    super();
  }

  override getIdTokenClient(targetAudience: string): Promise<IdTokenClient> {
    this.requestedAudiences.push(targetAudience);
    return Promise.resolve(this.clientFor(targetAudience));
  }
}

/** ID-token client whose request headers carry no Authorization entry. */
class HeaderlessIdTokenClient extends IdTokenClient {
  override getRequestHeaders(): Promise<Headers> {
    return Promise.resolve(new Headers());
  }
}

let issuerKey: SigningKey;
let foreignKey: SigningKey;
let keySet: JWTVerifyGetKey;
let localKeys: LocalSigningKeys;
let googleClient: InMemoryCertsClient;

beforeAll(async () => {
  issuerKey = await newSigningKey();
  foreignKey = await newSigningKey();
  keySet = createLocalJWKSet({
    keys: [{ ...(await exportJWK(issuerKey.publicKey)), kid: issuerKey.kid, alg: 'RS256', use: 'sig' }],
  });
  localKeys = { privateKey: issuerKey.privateKey, publicKey: issuerKey.publicKey, kid: issuerKey.kid };
  googleClient = new InMemoryCertsClient({ [issuerKey.kid]: await exportSPKI(issuerKey.publicKey) });
});

describe('AuthDenial', () => {
  it.each([
    {
      factory: "unauthenticated('missing-credential')",
      create: () => AuthDenial.unauthenticated('missing-credential'),
      expected: { ...INVALID_CREDENTIAL, reason: 'missing-credential' },
    },
    { factory: 'invalidToken()', create: () => AuthDenial.invalidToken(), expected: INVALID_ACCESS_TOKEN },
    { factory: 'expiredToken()', create: () => AuthDenial.expiredToken(), expected: ACCESS_TOKEN_EXPIRED },
    {
      factory: 'forbidden()',
      create: () => AuthDenial.forbidden(),
      expected: { statusCode: 403, type: 'authorization', reason: 'forbidden', wwwAuthenticate: undefined },
    },
    {
      factory: "forbidden('undeclared-route')",
      create: () => AuthDenial.forbidden('undeclared-route'),
      expected: { statusCode: 403, type: 'authorization', reason: 'undeclared-route', wwwAuthenticate: undefined },
    },
    {
      factory: 'siteMismatch()',
      create: () => AuthDenial.siteMismatch(),
      expected: { statusCode: 403, type: 'authorization', reason: 'site-mismatch', wwwAuthenticate: undefined },
    },
  ])('$factory carries its status, legacy error type, reason and challenge', async ({ create, expected }) => {
    expect(
      await denialOf(() => {
        throw create();
      }),
    ).toEqual(expected);
  });

  it('is a LegacyApiError named AuthDenial whose message is the legacy error message', () => {
    expect(AuthDenial.unauthenticated('wrong-scheme')).toBeInstanceOf(LegacyApiError);
    expect(AuthDenial.forbidden().name).toBe('AuthDenial');
    expect(AuthDenial.unauthenticated('wrong-scheme').message).toBe('authorization: Insufficient Account Permissions');
    expect(AuthDenial.invalidToken().message).toBe('invalidAccessToken: Invalid Access Token');
    expect(AuthDenial.expiredToken().message).toBe('accessTokenExpired: Access Token Expired');
  });
});

describe('TRANSPORTS', () => {
  it('lists the service, Pub/Sub push and Cloud Tasks schemes in a frozen array', () => {
    expect(TRANSPORTS).toEqual(['service', 'pubsub-push', 'cloud-tasks']);
    expect(Object.isFrozen(TRANSPORTS)).toBe(true);
  });
});

describe('user token settings', () => {
  it('fixes the local signer to opt2-local-identity, audience opt2-local, five minutes, RS256', () => {
    expect(LOCAL_USER_TOKEN).toEqual({
      issuer: 'opt2-local-identity',
      audience: 'opt2-local',
      lifetimeSeconds: 300,
      algorithm: 'RS256',
    });
  });

  it('derives the Identity Platform issuer and audience from the project and uses the securetoken JWKS', () => {
    expect(cloudUserTokenSettings(PROJECT)).toEqual({
      issuer: 'https://securetoken.google.com/proj',
      audience: 'proj',
      jwksUrl: 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
    });
    expect(GOOGLE_SECURETOKEN_JWKS_URL).toBe(cloudUserTokenSettings(PROJECT).jwksUrl);
  });
});

describe('createUserTokenVerifier', () => {
  /** Verifier for identity's local signer over the in-memory key set. */
  function localVerifier(): UserTokenVerifier {
    return createUserTokenVerifier({ issuer: LOCAL_USER_TOKEN.issuer, audience: LOCAL_USER_TOKEN.audience, keySet });
  }

  it('returns the declared claims of a valid local user token and drops undeclared ones', async () => {
    const token = await signToken({ ...userClaims(), nonce: 'n-1', jti: 'j-1' }, issuerKey);
    await expect(localVerifier().verify(token)).resolves.toEqual(userClaims());
  });

  it('accepts an audience list that contains the expected audience', async () => {
    const claims = userClaims({ aud: [LOCAL_USER_TOKEN.audience, 'opt2-local-admin'] });
    await expect(localVerifier().verify(await signToken(claims, issuerKey))).resolves.toEqual(claims);
  });

  it('maps an Identity Platform ID token to its declared claims', async () => {
    const settings = cloudUserTokenSettings(PROJECT);
    const claims = userClaims({ iss: settings.issuer, aud: settings.audience, exp: NOW + 3600 });
    const token = await signToken(
      {
        ...claims,
        auth_time: NOW,
        user_id: claims.sub,
        firebase: { identities: {}, sign_in_provider: 'custom', tenant: 'tenant-a-k3j2h' },
      },
      issuerKey,
    );
    const verifier = createUserTokenVerifier({ issuer: settings.issuer, audience: settings.audience, keySet });
    await expect(verifier.verify(token)).resolves.toEqual(claims);
  });

  it.each([
    { problem: 'the wrong issuer', overrides: { iss: 'https://securetoken.google.com/proj' } },
    { problem: 'the wrong audience', overrides: { aud: 'people' } },
    { problem: 'a tenant id that is not a UUID', overrides: { tid: 'tenant-a' } },
    { problem: 'no site', overrides: { site: undefined } },
    { problem: 'a numeric session id', overrides: { sid: 42 } },
    { problem: 'no roles', overrides: { roles: undefined } },
    { problem: 'a non-string role', overrides: { roles: ['member', 7] } },
    { problem: 'a non-boolean s2 flag', overrides: { s2: 'false' } },
    { problem: 'a negative epoch', overrides: { epoch: -1 } },
    { problem: 'a fractional epoch', overrides: { epoch: 1.5 } },
    { problem: 'no expiry', overrides: { exp: undefined } },
  ])('answers a token with $problem as invalidAccessToken', async ({ overrides }) => {
    const token = await signToken(userClaims(overrides), issuerKey);
    expect(await denialOf(() => localVerifier().verify(token))).toEqual(INVALID_ACCESS_TOKEN);
  });

  it.each([
    { problem: 'is signed by a key outside the key set', token: () => signToken(userClaims(), foreignKey) },
    {
      problem: 'carries a known kid over a foreign signature',
      token: () => signToken(userClaims(), foreignKey, issuerKey.kid),
    },
    {
      problem: 'is signed with HS256',
      token: () =>
        new SignJWT(userClaims()).setProtectedHeader({ alg: 'HS256' }).sign(createSecretKey(randomBytes(32))),
    },
    { problem: 'is not a JWT', token: () => Promise.resolve('not-a-jwt') },
  ])('answers a token that $problem as invalidAccessToken', async ({ token }) => {
    const presented = await token();
    expect(await denialOf(() => localVerifier().verify(presented))).toEqual(INVALID_ACCESS_TOKEN);
  });

  it('answers an expired token as accessTokenExpired', async () => {
    const token = await signToken(userClaims({ iat: NOW - 600, exp: NOW - 300 }), issuerKey);
    expect(await denialOf(() => localVerifier().verify(token))).toEqual(ACCESS_TOKEN_EXPIRED);
  });

  it.each([
    { kind: 'a Pub/Sub push OIDC token', claims: googleOidcClaims({ aud: PUSH_ENDPOINT, email: PUBSUB_INVOKER_EMAIL }) },
    { kind: 'a Cloud Tasks OIDC token', claims: googleOidcClaims({ email: TASKS_INVOKER_EMAIL }) },
    {
      kind: 'a local tasks-invoker service token',
      claims: serviceClaims({ sub: 'service:tasks-invoker', roles: ['service:tasks-invoker'] }),
    },
  ])('answers $kind presented as a user token with invalidAccessToken', async ({ claims }) => {
    const token = await signToken(claims, issuerKey);
    expect(await denialOf(() => localVerifier().verify(token))).toEqual(INVALID_ACCESS_TOKEN);
  });

  it.each([
    { failure: 'a JWKS timeout', error: new errors.JWKSTimeout() },
    { failure: 'an invalid JWKS response', error: new errors.JWKSInvalid() },
    { failure: 'a generic JOSE failure', error: new errors.JOSEError() },
    { failure: 'a non-JOSE failure', error: new Error('connect ECONNREFUSED 127.0.0.1:443') },
  ])('propagates $failure of the key source unchanged', async ({ error }) => {
    const verifier = createUserTokenVerifier({
      issuer: LOCAL_USER_TOKEN.issuer,
      audience: LOCAL_USER_TOKEN.audience,
      keySet: () => Promise.reject(error),
    });
    const token = await signToken(userClaims(), issuerKey);
    await expect(verifier.verify(token)).rejects.toBe(error);
  });

  it('rejects a malformed token without fetching the remote key set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const verifier = createUserTokenVerifier(cloudUserTokenSettings(PROJECT));
      expect(await denialOf(() => verifier.verify('header.payload'))).toEqual(INVALID_ACCESS_TOKEN);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('assertSiteMatches', () => {
  it.each([undefined, null, ''])('accepts a request whose siteid is %j', (siteid) => {
    expect(() => {
      assertSiteMatches(siteid, { site: 'tenant-a' });
    }).not.toThrow();
  });

  it('accepts a siteid equal to the token site in any letter case', () => {
    expect(() => {
      assertSiteMatches('Tenant-A', { site: 'tenant-a' });
    }).not.toThrow();
  });

  it('refuses a siteid naming another site with a 403 site-mismatch', async () => {
    const denial = await denialOf(() => {
      assertSiteMatches('default', { site: 'tenant-a' });
    });
    expect(denial).toEqual({
      statusCode: 403,
      type: 'authorization',
      reason: 'site-mismatch',
      wwwAuthenticate: undefined,
    });
  });
});

describe('local signing keys', () => {
  let stateRoot: string;

  /** Creates `<stateRoot>/<name>/secrets` holding the public PEM and, per `privateKey`, the private PEM or a directory. */
  async function stateDirWith(name: string, privateKey: 'pem' | 'absent' | 'directory'): Promise<string> {
    const stateDir = path.join(stateRoot, name);
    await mkdir(path.join(stateDir, 'secrets'), { recursive: true });
    await writeFile(
      localSecretPath(stateDir, LOCAL_SECRET_FILES.tokenSigningPublicKey),
      await exportSPKI(issuerKey.publicKey),
    );
    const privatePath = localSecretPath(stateDir, LOCAL_SECRET_FILES.tokenSigningPrivateKey);
    if (privateKey === 'pem') {
      await writeFile(privatePath, await exportPKCS8(issuerKey.privateKey));
    } else if (privateKey === 'directory') {
      await mkdir(privatePath);
    }
    return stateDir;
  }

  beforeAll(async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), 'opt2-auth-transports-'));
  });

  afterAll(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('places the secret files under <stateDir>/secrets with the up.sh file names', () => {
    expect(LOCAL_SECRET_FILES).toEqual({
      tokenSigningPrivateKey: 'token-signing-private.pem',
      tokenSigningPublicKey: 'token-signing-public.pem',
      pubsubPushKey: 'pubsub-push-key',
    });
    expect(localSecretPath('/state', LOCAL_SECRET_FILES.pubsubPushKey)).toBe('/state/secrets/pubsub-push-key');
  });

  it('loads both PEM keys and derives the kid from the public key thumbprint', async () => {
    const keys = await loadLocalSigningKeys(await stateDirWith('full', 'pem'));
    expect(keys.kid).toBe(issuerKey.kid);
    const token = await signLocalServiceToken({ keys, caller: 'gateway', audience: 'people' });
    await expect(verifyLocalServiceToken(token, { publicKey: keys.publicKey, audience: 'people' })).resolves.toEqual({
      name: 'gateway',
      roles: ['service:gateway'],
    });
  });

  it('loads only the public key when the private key file is absent, so signing fails', async () => {
    const keys = await loadLocalSigningKeys(await stateDirWith('verify-only', 'absent'));
    expect(keys.privateKey).toBeUndefined();
    expect(keys.kid).toBe(issuerKey.kid);
    await expect(signLocalServiceToken({ keys, caller: 'gateway', audience: 'people' })).rejects.toThrow(
      'Local service token for gateway needs token-signing-private.pem',
    );
  });

  it.each([
    { setup: 'absent' as const, requirePrivate: true, code: 'ENOENT' },
    { setup: 'directory' as const, requirePrivate: false, code: 'EISDIR' },
  ])('fails with $code when the private key is $setup and requirePrivate is $requirePrivate', async ({
    setup,
    requirePrivate,
    code,
  }) => {
    const stateDir = await stateDirWith(`private-${setup}`, setup);
    await expect(loadLocalSigningKeys(stateDir, { requirePrivate })).rejects.toMatchObject({ code });
  });
});

describe('local service tokens', () => {
  it('signs an RS256 token from opt2-local-service for the caller, addressed to the callee, for five minutes', async () => {
    const token = await signLocalServiceToken({ keys: localKeys, caller: 'migration', audience: 'people' });
    const { payload, protectedHeader } = await jwtVerify(token, issuerKey.publicKey);
    expect(protectedHeader).toEqual({ alg: 'RS256', kid: issuerKey.kid });
    expect(payload).toMatchObject({
      iss: 'opt2-local-service',
      aud: 'people',
      sub: 'service:migration',
      roles: ['service:migration', 'platform.migration'],
    });
    expect(payload.iat).toBeGreaterThanOrEqual(NOW);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(LOCAL_SERVICE_TOKEN_TTL_SECONDS);
  });

  it('signs the given roles and lifetime', async () => {
    const roles = ['service:gateway', 'platform.operator'];
    const token = await signLocalServiceToken({
      keys: localKeys,
      caller: 'gateway',
      audience: 'finance',
      roles,
      ttlSeconds: 60,
    });
    const { payload } = await jwtVerify(token, issuerKey.publicKey);
    expect(payload.roles).toEqual(roles);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60);
  });

  it('verifies a service token to the calling workload and its roles', async () => {
    const token = await signLocalServiceToken({ keys: localKeys, caller: 'gateway', audience: 'people' });
    await expect(
      verifyLocalServiceToken(token, { publicKey: issuerKey.publicKey, audience: 'people' }),
    ).resolves.toEqual({ name: 'gateway', roles: ['service:gateway'] });
  });

  it.each([
    {
      problem: 'is addressed to another service',
      token: () => signLocalServiceToken({ keys: localKeys, caller: 'gateway', audience: 'finance' }),
    },
    {
      problem: 'has the user-token issuer',
      token: () => signToken(serviceClaims({ iss: LOCAL_USER_TOKEN.issuer }), issuerKey),
    },
    {
      problem: 'has expired',
      token: () => signLocalServiceToken({ keys: localKeys, caller: 'gateway', audience: 'people', ttlSeconds: -60 }),
    },
    { problem: 'is signed by another key', token: () => signToken(serviceClaims(), foreignKey) },
    { problem: 'is not a JWT', token: () => Promise.resolve('not-a-jwt') },
    { problem: 'has no subject', token: () => signToken(serviceClaims({ sub: undefined }), issuerKey) },
    {
      problem: 'has a subject without the service: prefix',
      token: () => signToken(serviceClaims({ sub: 'gateway' }), issuerKey),
    },
    { problem: 'has an empty service name', token: () => signToken(serviceClaims({ sub: 'service:' }), issuerKey) },
    { problem: 'has no roles', token: () => signToken(serviceClaims({ roles: undefined }), issuerKey) },
    { problem: 'has a roles string', token: () => signToken(serviceClaims({ roles: 'service:gateway' }), issuerKey) },
    {
      problem: 'has a non-string role',
      token: () => signToken(serviceClaims({ roles: ['service:gateway', 1] }), issuerKey),
    },
  ])('refuses a token that $problem as invalid-credential', async ({ token }) => {
    const presented = await token();
    expect(
      await denialOf(() => verifyLocalServiceToken(presented, { publicKey: issuerKey.publicKey, audience: 'people' })),
    ).toEqual(INVALID_CREDENTIAL);
  });

  it('propagates a key failure that is not a token fault', async () => {
    const token = await signLocalServiceToken({ keys: localKeys, caller: 'gateway', audience: 'people' });
    await expect(
      verifyLocalServiceToken(token, { publicKey: createSecretKey(randomBytes(32)), audience: 'people' }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('service account emails', () => {
  it('names managed invokers with the opt2- service account prefix', () => {
    expect(MANAGED_INVOKER_NAMES).toEqual(['pubsub-invoker', 'tasks-invoker']);
    expect(serviceAccountEmail('pubsub-invoker', PROJECT)).toBe(PUBSUB_INVOKER_EMAIL);
    expect(serviceAccountEmail('tasks-invoker', PROJECT)).toBe(TASKS_INVOKER_EMAIL);
  });

  it.each(['gateway', 'people', 'migration', 'operator', 'pubsub-invoker', 'tasks-invoker'])(
    'round-trips the %s service account email to its workload identity',
    (name) => {
      const email = serviceAccountEmail(name, PROJECT);
      expect(serviceIdentityFromEmail(email, PROJECT)).toEqual({ name, roles: rolesForService(name), email });
    },
  );

  it.each([
    'opt2-people@other.iam.gserviceaccount.com',
    'opt2-people@xproj.iam.gserviceaccount.com',
    'people@proj.iam.gserviceaccount.com',
    'opt2-@proj.iam.gserviceaccount.com',
    'opt2-people@proj.example.com',
  ])('maps %s to no workload identity', (email) => {
    expect(serviceIdentityFromEmail(email, PROJECT)).toBeNull();
  });

  it('uses the callee URL origin as the cloud invocation audience', () => {
    expect(invocationAudience(`${PEOPLE_URL}/internal/v1/people?siteid=default`)).toBe(PEOPLE_URL);
  });
});

describe('local invocation credentials', () => {
  it('mints a bearer service token in X-Serverless-Authorization that the callee verifier accepts', async () => {
    const headers = await createLocalInvocationMinter({ keys: localKeys, caller: 'gateway' }).headersFor({
      name: 'people',
    });
    expect(Object.keys(headers)).toEqual(['x-serverless-authorization']);
    expect(headers[INVOCATION_HEADER]).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const verifier = createLocalInvocationVerifier({ publicKey: issuerKey.publicKey, callee: 'people' });
    await expect(verifier.verify(headers[INVOCATION_HEADER] ?? '')).resolves.toEqual({
      name: 'gateway',
      roles: ['service:gateway'],
    });
  });

  it('carries the roles the minter declares', async () => {
    const roles = ['service:migration', 'platform.migration', 'platform.operator'];
    const headers = await createLocalInvocationMinter({ keys: localKeys, caller: 'migration', roles }).headersFor({
      name: 'people',
    });
    const verifier = createLocalInvocationVerifier({ publicKey: issuerKey.publicKey, callee: 'people' });
    await expect(verifier.verify(headers[INVOCATION_HEADER] ?? '')).resolves.toEqual({ name: 'migration', roles });
  });

  it('refuses a credential minted for another callee as invalid-credential', async () => {
    const headers = await createLocalInvocationMinter({ keys: localKeys, caller: 'gateway' }).headersFor({
      name: 'finance',
    });
    const verifier = createLocalInvocationVerifier({ publicKey: issuerKey.publicKey, callee: 'people' });
    expect(await denialOf(() => verifier.verify(headers[INVOCATION_HEADER] ?? ''))).toEqual(INVALID_CREDENTIAL);
  });

  it.each(MANAGED_INVOKER_NAMES)('refuses a %s service token on a service route as the wrong scheme', async (caller) => {
    const headers = await createLocalInvocationMinter({ keys: localKeys, caller }).headersFor({ name: 'people' });
    const verifier = createLocalInvocationVerifier({ publicKey: issuerKey.publicKey, callee: 'people' });
    expect(await denialOf(() => verifier.verify(headers[INVOCATION_HEADER] ?? ''))).toEqual(WRONG_SCHEME);
  });

  it('refuses a user token presented as the invocation credential as invalid-credential', async () => {
    const userToken = await signToken(userClaims({ aud: 'people' }), issuerKey);
    const verifier = createLocalInvocationVerifier({ publicKey: issuerKey.publicKey, callee: 'people' });
    expect(await denialOf(() => verifier.verify(`Bearer ${userToken}`))).toEqual(INVALID_CREDENTIAL);
  });

  it.each([
    { header: BASIC_HEADER, expected: WRONG_SCHEME },
    { header: '', expected: WRONG_SCHEME },
    { header: 'Bearer', expected: INVALID_CREDENTIAL },
    { header: 'Bearer abc def', expected: INVALID_CREDENTIAL },
  ])('answers the header $header with reason $expected.reason', async ({ header, expected }) => {
    const verifier = createLocalInvocationVerifier({ publicKey: issuerKey.publicKey, callee: 'people' });
    expect(await denialOf(() => verifier.verify(header))).toEqual(expected);
  });

  it('accepts a lower-case bearer scheme surrounded by whitespace', async () => {
    const token = await signLocalServiceToken({ keys: localKeys, caller: 'gateway', audience: 'people' });
    const verifier = createLocalInvocationVerifier({ publicKey: issuerKey.publicKey, callee: 'people' });
    await expect(verifier.verify(`  bearer ${token}  `)).resolves.toEqual({ name: 'gateway', roles: ['service:gateway'] });
  });
});

describe('createCloudRunInvocationReader', () => {
  const reader = createCloudRunInvocationReader({ project: PROJECT });

  it('reads the calling workload from a token whose signature Cloud Run removed', async () => {
    await expect(reader.verify(`Bearer ${cloudRunForwarded(googleOidcClaims())}`)).resolves.toEqual({
      name: 'gateway',
      roles: ['service:gateway'],
      email: GATEWAY_EMAIL,
    });
  });

  it.each([PUBSUB_INVOKER_EMAIL, TASKS_INVOKER_EMAIL])(
    'refuses the managed-delivery identity %s on a service route as the wrong scheme',
    async (email) => {
      const header = `Bearer ${cloudRunForwarded(googleOidcClaims({ email }))}`;
      expect(await denialOf(() => reader.verify(header))).toEqual(WRONG_SCHEME);
    },
  );

  it.each([
    { problem: 'still carries its signature', token: () => signToken(googleOidcClaims(), issuerKey) },
    { problem: 'has two segments', token: () => Promise.resolve('header.payload') },
    {
      problem: 'has an undecodable payload',
      token: () => Promise.resolve(cloudRunForwarded(googleOidcClaims()).replace(/\.[\w-]+\./, '.%%%.')),
    },
    { problem: 'has no email', token: () => Promise.resolve(cloudRunForwarded(googleOidcClaims({ email: undefined }))) },
    { problem: 'has a numeric email', token: () => Promise.resolve(cloudRunForwarded(googleOidcClaims({ email: 42 }))) },
    {
      problem: "names another project's service account",
      token: () =>
        Promise.resolve(cloudRunForwarded(googleOidcClaims({ email: 'opt2-gateway@other.iam.gserviceaccount.com' }))),
    },
    {
      problem: 'names a user account',
      token: () => Promise.resolve(cloudRunForwarded(googleOidcClaims({ email: 'admin@example.com' }))),
    },
  ])('refuses a token that $problem as invalid-credential', async ({ token }) => {
    const header = `Bearer ${await token()}`;
    expect(await denialOf(() => reader.verify(header))).toEqual(INVALID_CREDENTIAL);
  });

  it('refuses a non-bearer header as the wrong scheme', async () => {
    expect(await denialOf(() => reader.verify(BASIC_HEADER))).toEqual(WRONG_SCHEME);
  });
});

describe('createCloudInvocationVerifier', () => {
  /** Verifier for the people service over the in-memory Google certificates. */
  function peopleVerifier(): ReturnType<typeof createCloudInvocationVerifier> {
    return createCloudInvocationVerifier({
      project: PROJECT,
      audience: `${PEOPLE_URL}/internal/v1/people`,
      client: googleClient,
    });
  }

  it('accepts a Google-signed ID token for the callee origin and reads the caller email', async () => {
    const token = await signToken(googleOidcClaims(), issuerKey);
    await expect(peopleVerifier().verify(`Bearer ${token}`)).resolves.toEqual({
      name: 'gateway',
      roles: ['service:gateway'],
      email: GATEWAY_EMAIL,
    });
  });

  it.each([
    { kind: 'Pub/Sub push', claims: googleOidcClaims({ aud: PEOPLE_URL, email: PUBSUB_INVOKER_EMAIL }) },
    { kind: 'Cloud Tasks', claims: googleOidcClaims({ email: TASKS_INVOKER_EMAIL }) },
  ])('refuses a $kind OIDC token on a service route as the wrong scheme', async ({ claims }) => {
    const token = await signToken(claims, issuerKey);
    expect(await denialOf(() => peopleVerifier().verify(`Bearer ${token}`))).toEqual(WRONG_SCHEME);
  });

  it.each([
    { problem: 'the wrong audience', overrides: { aud: FINANCE_URL } },
    { problem: 'the push endpoint path as audience', overrides: { aud: PUSH_ENDPOINT } },
    { problem: 'the wrong issuer', overrides: { iss: 'https://securetoken.google.com/proj' } },
    { problem: 'an expiry an hour ago', overrides: { iat: NOW - 7200, exp: NOW - 3600 } },
    { problem: 'an unverified email', overrides: { email_verified: false } },
    { problem: 'a string email_verified flag', overrides: { email_verified: 'true' } },
    { problem: 'no email', overrides: { email: undefined } },
    { problem: "another project's service account", overrides: { email: 'opt2-gateway@other.iam.gserviceaccount.com' } },
  ])('refuses an ID token with $problem as invalid-credential', async ({ overrides }) => {
    const token = await signToken(googleOidcClaims(overrides), issuerKey);
    expect(await denialOf(() => peopleVerifier().verify(`Bearer ${token}`))).toEqual(INVALID_CREDENTIAL);
  });

  it.each([
    { problem: 'is signed by an unknown Google key', token: () => signToken(googleOidcClaims(), foreignKey) },
    {
      problem: 'carries a known kid over a foreign signature',
      token: () => signToken(googleOidcClaims(), foreignKey, issuerKey.kid),
    },
    { problem: 'is a local user token', token: () => signToken(userClaims({ aud: PEOPLE_URL }), issuerKey) },
  ])('refuses a credential that $problem as invalid-credential', async ({ token }) => {
    const header = `Bearer ${await token()}`;
    expect(await denialOf(() => peopleVerifier().verify(header))).toEqual(INVALID_CREDENTIAL);
  });

  it('refuses a non-bearer header as the wrong scheme before consulting Google', async () => {
    const verifier = createCloudInvocationVerifier({ project: PROJECT, audience: PEOPLE_URL });
    expect(await denialOf(() => verifier.verify(BASIC_HEADER))).toEqual(WRONG_SCHEME);
  });
});

describe('createCloudInvocationMinter', () => {
  it('attaches a Google-signed ID token for the callee origin that the cloud verifier accepts', async () => {
    const token = await signToken(googleOidcClaims(), issuerKey);
    const fetchedFor: string[] = [];
    const auth = new InMemoryGoogleAuth(
      (targetAudience) =>
        new IdTokenClient({
          targetAudience,
          idTokenProvider: {
            fetchIdToken: (audience) => {
              fetchedFor.push(audience);
              return Promise.resolve(token);
            },
          },
        }),
    );
    const headers = await createCloudInvocationMinter({ auth }).headersFor({
      name: 'people',
      url: `${PEOPLE_URL}/internal/v1/people`,
    });
    expect(headers).toEqual({ [INVOCATION_HEADER]: `Bearer ${token}` });
    expect(auth.requestedAudiences).toEqual([PEOPLE_URL]);
    expect(fetchedFor).toEqual([PEOPLE_URL]);
    const verifier = createCloudInvocationVerifier({ project: PROJECT, audience: PEOPLE_URL, client: googleClient });
    await expect(verifier.verify(headers[INVOCATION_HEADER] ?? '')).resolves.toEqual({
      name: 'gateway',
      roles: ['service:gateway'],
      email: GATEWAY_EMAIL,
    });
  });

  it('keeps one ID-token client per callee origin', async () => {
    const tokens = new Map([
      [PEOPLE_URL, await signToken(googleOidcClaims(), issuerKey)],
      [FINANCE_URL, await signToken(googleOidcClaims({ aud: FINANCE_URL }), issuerKey)],
    ]);
    const fetchedFor: string[] = [];
    const auth = new InMemoryGoogleAuth(
      (targetAudience) =>
        new IdTokenClient({
          targetAudience,
          idTokenProvider: {
            fetchIdToken: (audience) => {
              fetchedFor.push(audience);
              return Promise.resolve(tokens.get(audience) ?? '');
            },
          },
        }),
    );
    const minter = createCloudInvocationMinter({ auth });
    const people = await minter.headersFor({ name: 'people', url: `${PEOPLE_URL}/internal/v1/people` });
    const peopleAgain = await minter.headersFor({ name: 'people', url: `${PEOPLE_URL}/internal/v1/tokens` });
    const finance = await minter.headersFor({ name: 'finance', url: `${FINANCE_URL}/internal/v1/invoices` });
    expect(auth.requestedAudiences).toEqual([PEOPLE_URL, FINANCE_URL]);
    expect(fetchedFor).toEqual([PEOPLE_URL, FINANCE_URL]);
    expect(peopleAgain).toEqual(people);
    expect(finance).toEqual({ [INVOCATION_HEADER]: `Bearer ${tokens.get(FINANCE_URL) ?? ''}` });
  });

  it('rejects a target without a URL', async () => {
    await expect(createCloudInvocationMinter().headersFor({ name: 'people' })).rejects.toThrow(
      new TypeError('No URL for invocation target people'),
    );
  });

  it('fails when the ID-token client yields no Authorization header', async () => {
    const auth = new InMemoryGoogleAuth(
      (targetAudience) =>
        new HeaderlessIdTokenClient({
          targetAudience,
          idTokenProvider: { fetchIdToken: () => Promise.reject(new Error('not requested')) },
        }),
    );
    await expect(createCloudInvocationMinter({ auth }).headersFor({ name: 'people', url: PEOPLE_URL })).rejects.toThrow(
      `ID token client for ${PEOPLE_URL} returned no Authorization header`,
    );
  });
});
