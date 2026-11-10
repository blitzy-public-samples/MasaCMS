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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
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
  createAuthFromEnv,
  createCloudCloudTasksTransport,
  createCloudPubSubPushTransport,
  createLocalCloudTasksTransport,
  createLocalPubSubPushTransport,
  createServiceTransport,
  managedAudience,
  transportForPath,
  type AuthEnv,
  type AuthRequest,
  type AuthResult,
  type TransportAuthenticator,
  type TransportSet,
} from '../../src/auth/transports.js';
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

/** Verifier for identity's local signer over the in-memory key set. */
function localVerifier(): UserTokenVerifier {
  return createUserTokenVerifier({ issuer: LOCAL_USER_TOKEN.issuer, audience: LOCAL_USER_TOKEN.audience, keySet });
}

describe('createUserTokenVerifier', () => {
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

describe('local signing keys', () => {
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

const PUSH_PATH = '/internal/v1/events/timesheets-people-archived';
const TASK_PATH = '/internal/v1/tasks/site-monitor';
const PEOPLE_PATH = '/internal/v1/people';
const LOCAL_JWKS_URL = 'http://127.0.0.1:8111/.well-known/jwks.json';
const PUSH_KEY = randomBytes(24).toString('base64url');
const MISSING_CREDENTIAL: DenialShape = { ...INVALID_CREDENTIAL, reason: 'missing-credential' };
const PUBSUB_INVOKER_IDENTITY = { service: { name: 'pubsub-invoker', roles: ['service:pubsub-invoker'] } };
const TASKS_INVOKER_IDENTITY = { service: { name: 'tasks-invoker', roles: ['service:tasks-invoker'] } };

/** Authenticates a request to `route` carrying `headers` and `query` on a route that requires credentials. */
function authenticate(
  authenticator: TransportAuthenticator,
  route: string,
  headers: AuthRequest['headers'],
  query?: AuthRequest['query'],
): Promise<AuthResult> {
  return authenticator.authenticate({ path: route, headers, query }, { optional: false });
}

/** Bearer header of a local service token from `caller` addressed to `audience`. */
async function localServiceBearer(caller: string, audience = 'people'): Promise<string> {
  return `Bearer ${await signLocalServiceToken({ keys: localKeys, caller, audience })}`;
}

describe('transportForPath', () => {
  it.each([
    { path: '/internal/v1/events/sub-a', transport: 'pubsub-push' },
    { path: '/internal/v1/events/sub-a?key=abc', transport: 'pubsub-push' },
    { path: '/internal/v1/events/', transport: 'service' },
    { path: '/internal/v1/events/a/b', transport: 'service' },
    { path: TASK_PATH, transport: 'cloud-tasks' },
    { path: '/internal/v1/tasks', transport: 'service' },
    { path: '/internal/v1/outbox/sweep', transport: 'cloud-tasks' },
    { path: '/internal/v1/outbox/sweep/now', transport: 'service' },
    { path: '/internal/v1/jobs/exports/run', transport: 'cloud-tasks' },
    { path: '/internal/v1/tokens', transport: 'service' },
    { path: '/people?next=/internal/v1/tasks/x', transport: 'service' },
    { path: '/_api/json/v1/default/content', transport: 'service' },
  ])('assigns $path to the $transport transport', ({ path: route, transport }) => {
    expect(transportForPath(route)).toBe(transport);
  });
});

describe('managedAudience', () => {
  it.each([
    { given: 'a bare origin', selfUrl: PEOPLE_URL, route: PUSH_PATH, audience: PUSH_ENDPOINT },
    {
      given: 'a trailing slash and a route query',
      selfUrl: `${PEOPLE_URL}/`,
      route: `${PUSH_PATH}?attempt=2`,
      audience: PUSH_ENDPOINT,
    },
    {
      given: 'a service URL path and query',
      selfUrl: `${PEOPLE_URL}/base?region=us`,
      route: '/internal/v1/outbox/sweep',
      audience: `${PEOPLE_URL}/internal/v1/outbox/sweep`,
    },
  ])('keeps the service origin and the route path given $given', ({ selfUrl, route, audience }) => {
    expect(managedAudience(selfUrl, route)).toBe(audience);
  });
});

describe('createServiceTransport', () => {
  /** Service scheme of the people service over the in-memory user key set and the local invocation key. */
  function peopleService(): TransportAuthenticator {
    return createServiceTransport({
      userVerifier: localVerifier(),
      invocationVerifier: createLocalInvocationVerifier({ publicKey: issuerKey.publicKey, callee: 'people' }),
    });
  }

  it('accepts a user token with the caller invocation credential and returns the user, the raw token and the caller', async () => {
    const userToken = await signToken(userClaims(), issuerKey);
    const transport = peopleService();
    expect(transport.transport).toBe('service');
    await expect(
      authenticate(transport, PEOPLE_PATH, {
        authorization: `Bearer ${userToken}`,
        [INVOCATION_HEADER]: await localServiceBearer('gateway'),
      }),
    ).resolves.toEqual({ user: userClaims(), userToken, service: { name: 'gateway', roles: ['service:gateway'] } });
  });

  it('accepts an invocation credential without a user token as a call for no user', async () => {
    const result = await authenticate(peopleService(), PEOPLE_PATH, {
      [INVOCATION_HEADER]: await localServiceBearer('migration'),
    });
    expect(result).toStrictEqual({
      service: { name: 'migration', roles: ['service:migration', 'platform.migration'] },
    });
  });

  it('refuses a request without an invocation credential as missing-credential when the route requires one', async () => {
    const userToken = await signToken(userClaims(), issuerKey);
    expect(
      await denialOf(() => authenticate(peopleService(), PEOPLE_PATH, { authorization: `Bearer ${userToken}` })),
    ).toEqual(MISSING_CREDENTIAL);
  });

  it('passes a request without credentials on a route where they are optional', async () => {
    await expect(peopleService().authenticate({ path: PEOPLE_PATH, headers: {} }, { optional: true })).resolves.toEqual(
      {},
    );
  });

  it('verifies a user token without an invocation credential on a route where the credential is optional', async () => {
    const userToken = await signToken(userClaims(), issuerKey);
    await expect(
      peopleService().authenticate(
        { path: PEOPLE_PATH, headers: { authorization: `Bearer ${userToken}` } },
        { optional: true },
      ),
    ).resolves.toEqual({ user: userClaims(), userToken });
  });

  it('refuses a non-bearer Authorization as the wrong scheme', async () => {
    const headers = { authorization: BASIC_HEADER, [INVOCATION_HEADER]: await localServiceBearer('gateway') };
    expect(await denialOf(() => authenticate(peopleService(), PEOPLE_PATH, headers))).toEqual(WRONG_SCHEME);
  });

  it.each(['authorization', INVOCATION_HEADER])('refuses a repeated %s header as invalid-credential', async (name) => {
    const authorization = `Bearer ${await signToken(userClaims(), issuerKey)}`;
    const invocation = await localServiceBearer('gateway');
    const repeated = name === 'authorization' ? authorization : invocation;
    const headers = { authorization, [INVOCATION_HEADER]: invocation, [name]: [repeated, repeated] };
    expect(await denialOf(() => authenticate(peopleService(), PEOPLE_PATH, headers))).toEqual(INVALID_CREDENTIAL);
  });

  it.each([
    {
      kind: 'a local tasks-invoker service token',
      claims: serviceClaims({ sub: 'service:tasks-invoker', roles: ['service:tasks-invoker'] }),
    },
    {
      kind: 'a Pub/Sub push OIDC token',
      claims: googleOidcClaims({ aud: PUSH_ENDPOINT, email: PUBSUB_INVOKER_EMAIL }),
    },
    { kind: 'a Cloud Tasks OIDC token', claims: googleOidcClaims({ email: TASKS_INVOKER_EMAIL }) },
  ])('answers $kind presented as the user token with invalidAccessToken', async ({ claims }) => {
    const headers = {
      authorization: `Bearer ${await signToken(claims, issuerKey)}`,
      [INVOCATION_HEADER]: await localServiceBearer('gateway'),
    };
    expect(await denialOf(() => authenticate(peopleService(), PEOPLE_PATH, headers))).toEqual(INVALID_ACCESS_TOKEN);
  });

  it.each(MANAGED_INVOKER_NAMES)(
    'refuses a %s service token presented as the invocation credential as the wrong scheme',
    async (caller) => {
      const headers = { [INVOCATION_HEADER]: await localServiceBearer(caller) };
      expect(await denialOf(() => authenticate(peopleService(), PEOPLE_PATH, headers))).toEqual(WRONG_SCHEME);
    },
  );

  it.each([
    {
      problem: 'an invocation token for another service',
      headers: async () => ({ [INVOCATION_HEADER]: await localServiceBearer('gateway', 'finance') }),
      expected: INVALID_CREDENTIAL,
    },
    {
      problem: 'an invocation token from the user issuer',
      headers: async () => ({
        [INVOCATION_HEADER]: `Bearer ${await signToken(serviceClaims({ iss: LOCAL_USER_TOKEN.issuer }), issuerKey)}`,
      }),
      expected: INVALID_CREDENTIAL,
    },
    {
      problem: 'a user token for another audience',
      headers: async () => ({
        authorization: `Bearer ${await signToken(userClaims({ aud: 'people' }), issuerKey)}`,
        [INVOCATION_HEADER]: await localServiceBearer('gateway'),
      }),
      expected: INVALID_ACCESS_TOKEN,
    },
    {
      problem: 'a user token from another issuer',
      headers: async () => ({
        authorization: `Bearer ${await signToken(userClaims({ iss: GOOGLE_ISSUER }), issuerKey)}`,
        [INVOCATION_HEADER]: await localServiceBearer('gateway'),
      }),
      expected: INVALID_ACCESS_TOKEN,
    },
  ])('refuses $problem with the $expected.type error', async ({ headers, expected }) => {
    const presented = await headers();
    expect(await denialOf(() => authenticate(peopleService(), PEOPLE_PATH, presented))).toEqual(expected);
  });
});

describe('createLocalPubSubPushTransport', () => {
  /** Local push scheme holding the test push key. */
  function push(): TransportAuthenticator {
    return createLocalPubSubPushTransport({ pushKey: PUSH_KEY });
  }

  it('refuses to build on an empty push key', () => {
    expect(() => createLocalPubSubPushTransport({ pushKey: '' })).toThrow(
      new TypeError('Local Pub/Sub push key is empty'),
    );
  });

  it('accepts the push key in the key query parameter as the pubsub-invoker', async () => {
    expect(push().transport).toBe('pubsub-push');
    await expect(authenticate(push(), PUSH_PATH, {}, { key: PUSH_KEY })).resolves.toEqual(PUBSUB_INVOKER_IDENTITY);
  });

  it.each([
    { presented: 'another key of the same length', key: `${PUSH_KEY.startsWith('A') ? 'B' : 'A'}${PUSH_KEY.slice(1)}` },
    { presented: 'a prefix of the key', key: PUSH_KEY.slice(0, -1) },
    { presented: 'the key with a suffix', key: `${PUSH_KEY}x` },
    { presented: 'an empty key', key: '' },
    { presented: 'a numeric key', key: 42 },
    { presented: 'a repeated key parameter', key: [PUSH_KEY, PUSH_KEY] },
  ])('refuses $presented as invalid-credential', async ({ key }) => {
    expect(await denialOf(() => authenticate(push(), PUSH_PATH, {}, { key }))).toEqual(INVALID_CREDENTIAL);
  });

  it.each([
    { request: 'no query', query: undefined },
    { request: 'a query without a key', query: { attempt: '2' } },
  ])('refuses a delivery with $request as missing-credential', async ({ query }) => {
    expect(await denialOf(() => authenticate(push(), PUSH_PATH, {}, query))).toEqual(MISSING_CREDENTIAL);
  });

  it.each([
    { kind: 'a bearer user token', authorization: async () => `Bearer ${await signToken(userClaims(), issuerKey)}` },
    {
      kind: 'the pubsub-invoker OIDC token',
      authorization: async () =>
        `Bearer ${await signToken(googleOidcClaims({ aud: PUSH_ENDPOINT, email: PUBSUB_INVOKER_EMAIL }), issuerKey)}`,
    },
    { kind: 'Basic credentials', authorization: () => Promise.resolve(BASIC_HEADER) },
  ])('refuses $kind in Authorization as the wrong scheme even with the right key', async ({ authorization }) => {
    const headers = { authorization: await authorization() };
    expect(await denialOf(() => authenticate(push(), PUSH_PATH, headers, { key: PUSH_KEY }))).toEqual(WRONG_SCHEME);
  });
});

describe.each([
  {
    factory: 'createCloudPubSubPushTransport',
    create: createCloudPubSubPushTransport,
    transport: 'pubsub-push',
    route: PUSH_PATH,
    invoker: 'pubsub-invoker',
    email: PUBSUB_INVOKER_EMAIL,
    otherInvokerEmail: TASKS_INVOKER_EMAIL,
  },
  {
    factory: 'createCloudCloudTasksTransport',
    create: createCloudCloudTasksTransport,
    transport: 'cloud-tasks',
    route: TASK_PATH,
    invoker: 'tasks-invoker',
    email: TASKS_INVOKER_EMAIL,
    otherInvokerEmail: PUBSUB_INVOKER_EMAIL,
  },
] as const)('$factory', ({ create, transport, route, invoker, email, otherInvokerEmail }) => {
  const audience = managedAudience(PEOPLE_URL, route);
  const identity = { service: { name: invoker, roles: [`service:${invoker}`], email } };

  /** Managed scheme of the people service over the in-memory Google certificates. */
  function managed(): TransportAuthenticator {
    return create({ project: PROJECT, selfUrl: PEOPLE_URL, client: googleClient });
  }

  /** Bearer header of an OIDC token of this invoker addressed to the route, signed with `key`. */
  async function invokerBearer(overrides: Record<string, unknown> = {}, key: SigningKey = issuerKey): Promise<string> {
    return `Bearer ${await signToken(googleOidcClaims({ aud: audience, email, ...overrides }), key)}`;
  }

  it(`accepts the ${invoker} OIDC token addressed to the route`, async () => {
    const authenticator = managed();
    expect(authenticator.transport).toBe(transport);
    await expect(authenticate(authenticator, route, { authorization: await invokerBearer() })).resolves.toEqual(
      identity,
    );
  });

  it('checks the audience against the route path without its query string', async () => {
    await expect(
      authenticate(managed(), `${route}?attempt=2`, { authorization: await invokerBearer() }),
    ).resolves.toEqual(identity);
  });

  it.each([
    { problem: 'the service origin as audience', overrides: { aud: PEOPLE_URL } },
    { problem: "another service's route as audience", overrides: { aud: managedAudience(FINANCE_URL, route) } },
    { problem: 'the wrong issuer', overrides: { iss: 'https://securetoken.google.com/proj' } },
    { problem: "the other managed invoker's email", overrides: { email: otherInvokerEmail } },
    { problem: "a service caller's email", overrides: { email: GATEWAY_EMAIL } },
    { problem: 'an unverified email', overrides: { email_verified: false } },
    { problem: 'no email_verified flag', overrides: { email_verified: undefined } },
    { problem: 'an expiry an hour ago', overrides: { iat: NOW - 7200, exp: NOW - 3600 } },
  ])('refuses an OIDC token with $problem as invalid-credential', async ({ overrides }) => {
    const headers = { authorization: await invokerBearer(overrides) };
    expect(await denialOf(() => authenticate(managed(), route, headers))).toEqual(INVALID_CREDENTIAL);
  });

  it.each([
    { problem: 'is signed by an unknown Google key', token: () => invokerBearer({}, foreignKey) },
    { problem: 'is a local user token', token: async () => `Bearer ${await signToken(userClaims(), issuerKey)}` },
    { problem: `is a local ${invoker} service token`, token: () => localServiceBearer(invoker, audience) },
  ])('refuses a credential that $problem as invalid-credential', async ({ token }) => {
    const headers = { authorization: await token() };
    expect(await denialOf(() => authenticate(managed(), route, headers))).toEqual(INVALID_CREDENTIAL);
  });

  it.each([
    { header: undefined, expected: MISSING_CREDENTIAL },
    { header: BASIC_HEADER, expected: WRONG_SCHEME },
    { header: 'Bearer', expected: INVALID_CREDENTIAL },
    { header: 'Bearer   ', expected: INVALID_CREDENTIAL },
    { header: 'Bearer abc def', expected: INVALID_CREDENTIAL },
    { header: ['Bearer abc', 'Bearer abc'], expected: INVALID_CREDENTIAL },
  ])('answers the Authorization $header with reason $expected.reason before consulting Google', async ({
    header,
    expected,
  }) => {
    const authenticator = create({ project: PROJECT, selfUrl: PEOPLE_URL });
    expect(await denialOf(() => authenticate(authenticator, route, { authorization: header }))).toEqual(expected);
  });
});

describe('createLocalCloudTasksTransport', () => {
  const TASKS_INVOKER_SUBJECT = { sub: 'service:tasks-invoker', roles: ['service:tasks-invoker'] };

  /** Local Cloud Tasks scheme of the people service over the local signing key. */
  function tasks(): TransportAuthenticator {
    return createLocalCloudTasksTransport({ publicKey: issuerKey.publicKey, callee: 'people' });
  }

  it('accepts a local tasks-invoker service token addressed to the service', async () => {
    expect(tasks().transport).toBe('cloud-tasks');
    await expect(
      authenticate(tasks(), TASK_PATH, { authorization: await localServiceBearer('tasks-invoker') }),
    ).resolves.toEqual(TASKS_INVOKER_IDENTITY);
  });

  it('grants only the tasks-invoker role whatever roles the token carries', async () => {
    const token = await signLocalServiceToken({
      keys: localKeys,
      caller: 'tasks-invoker',
      audience: 'people',
      roles: ['service:tasks-invoker', 'platform.operator'],
    });
    await expect(authenticate(tasks(), TASK_PATH, { authorization: `Bearer ${token}` })).resolves.toEqual(
      TASKS_INVOKER_IDENTITY,
    );
  });

  it.each(['gateway', 'migration', 'pubsub-invoker'])('refuses a %s service token as the wrong scheme', async (caller) => {
    const headers = { authorization: await localServiceBearer(caller) };
    expect(await denialOf(() => authenticate(tasks(), TASK_PATH, headers))).toEqual(WRONG_SCHEME);
  });

  it.each([
    { problem: 'is addressed to another service', token: () => localServiceBearer('tasks-invoker', 'finance') },
    {
      problem: 'has the user-token issuer',
      token: async () =>
        `Bearer ${await signToken(serviceClaims({ ...TASKS_INVOKER_SUBJECT, iss: LOCAL_USER_TOKEN.issuer }), issuerKey)}`,
    },
    {
      problem: 'is signed by another key',
      token: async () => `Bearer ${await signToken(serviceClaims(TASKS_INVOKER_SUBJECT), foreignKey)}`,
    },
    { problem: 'is a local user token', token: async () => `Bearer ${await signToken(userClaims(), issuerKey)}` },
    {
      problem: 'is a Cloud Tasks OIDC token',
      token: async () =>
        `Bearer ${await signToken(googleOidcClaims({ aud: 'people', email: TASKS_INVOKER_EMAIL }), issuerKey)}`,
    },
  ])('refuses a credential that $problem as invalid-credential', async ({ token }) => {
    const headers = { authorization: await token() };
    expect(await denialOf(() => authenticate(tasks(), TASK_PATH, headers))).toEqual(INVALID_CREDENTIAL);
  });

  it.each([
    { header: undefined, expected: MISSING_CREDENTIAL },
    { header: BASIC_HEADER, expected: WRONG_SCHEME },
    { header: 'Bearer', expected: INVALID_CREDENTIAL },
  ])('answers the Authorization $header with reason $expected.reason', async ({ header, expected }) => {
    expect(await denialOf(() => authenticate(tasks(), TASK_PATH, { authorization: header }))).toEqual(expected);
  });
});

describe('createAuthFromEnv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Answers every fetch with the issuer key set, so remote JWKS verifiers run offline; returns the spy. */
  async function serveIssuerJwks(): Promise<MockInstance<typeof fetch>> {
    const jwk = { ...(await exportJWK(issuerKey.publicKey)), kid: issuerKey.kid, alg: 'RS256', use: 'sig' };
    const jwks = { keys: [jwk] };
    return vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(Response.json(jwks)));
  }

  /** Serves the issuer key as Google's OIDC signing certificate to every OAuth2Client. */
  async function serveGoogleCerts(): Promise<void> {
    const certs = { [issuerKey.kid]: await exportSPKI(issuerKey.publicKey) };
    vi.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
      certs,
      format: CertificateFormat.PEM,
    });
  }

  /** Writes `contents` as the push key file of `stateDir` and returns `stateDir`. */
  async function withPushKey(stateDir: string, contents = `${PUSH_KEY}\n`): Promise<string> {
    await writeFile(localSecretPath(stateDir, LOCAL_SECRET_FILES.pubsubPushKey), contents);
    return stateDir;
  }

  /** Verifiers, minter and managed schemes of the people service built from the in-memory keys. */
  function injectedPieces() {
    return {
      userVerifier: localVerifier(),
      invocationVerifier: createLocalInvocationVerifier({ publicKey: issuerKey.publicKey, callee: 'people' }),
      invocationMinter: createLocalInvocationMinter({ keys: localKeys, caller: 'people' }),
      transports: {
        'pubsub-push': createLocalPubSubPushTransport({ pushKey: PUSH_KEY }),
        'cloud-tasks': createLocalCloudTasksTransport({ publicKey: issuerKey.publicKey, callee: 'people' }),
      },
    };
  }

  describe('in local mode', () => {
    /** Local environment of the people service over `stateDir`; an `undefined` override drops the setting. */
    function localEnv(stateDir: string, overrides: Partial<AuthEnv> = {}): AuthEnv {
      return {
        OPT2_ENV: 'local',
        OPT2_SERVICE_NAME: 'people',
        OPT2_STATE_DIR: stateDir,
        OPT2_JWKS_URL: LOCAL_JWKS_URL,
        ...overrides,
      };
    }

    it.each([
      {
        settings: 'unset',
        env: {},
        iss: LOCAL_USER_TOKEN.issuer,
        aud: LOCAL_USER_TOKEN.audience,
        refusedIss: 'https://identity.example/opt2',
      },
      {
        settings: 'blank',
        env: { OPT2_TOKEN_ISSUER: '  ', OPT2_TOKEN_AUDIENCE: '' },
        iss: LOCAL_USER_TOKEN.issuer,
        aud: LOCAL_USER_TOKEN.audience,
        refusedIss: 'https://identity.example/opt2',
      },
      {
        settings: 'explicit',
        env: { OPT2_TOKEN_ISSUER: 'https://identity.example/opt2', OPT2_TOKEN_AUDIENCE: 'opt2-people' },
        iss: 'https://identity.example/opt2',
        aud: 'opt2-people',
        refusedIss: LOCAL_USER_TOKEN.issuer,
      },
    ])('verifies the service scheme with the OPT2_JWKS_URL key set and $settings token issuer and audience settings', async ({
      settings,
      env,
      iss,
      aud,
      refusedIss,
    }) => {
      const fetchSpy = await serveIssuerJwks();
      const stateDir = await withPushKey(await stateDirWith(`env-user-${settings}`, 'pem'));
      const auth = await createAuthFromEnv(localEnv(stateDir, env));
      const userToken = await signToken(userClaims({ iss, aud }), issuerKey);
      await expect(
        authenticate(auth.transports.service, PEOPLE_PATH, {
          authorization: `Bearer ${userToken}`,
          [INVOCATION_HEADER]: await localServiceBearer('gateway'),
        }),
      ).resolves.toEqual({
        user: userClaims({ iss, aud }),
        userToken,
        service: { name: 'gateway', roles: ['service:gateway'] },
      });
      expect(fetchSpy).toHaveBeenCalledWith(LOCAL_JWKS_URL, expect.anything());
      const refused = await signToken(userClaims({ iss: refusedIss, aud }), issuerKey);
      expect(await denialOf(() => auth.userVerifier.verify(refused))).toEqual(INVALID_ACCESS_TOKEN);
    });

    it('accepts the trimmed push key file on the Pub/Sub push scheme and a tasks-invoker token on the Cloud Tasks scheme', async () => {
      const auth = await createAuthFromEnv(localEnv(await withPushKey(await stateDirWith('env-managed', 'absent'))));
      expect(Object.isFrozen(auth.transports)).toBe(true);
      expect(auth.transports.service.transport).toBe('service');
      const push = auth.transports['pubsub-push'];
      await expect(authenticate(push, PUSH_PATH, {}, { key: PUSH_KEY })).resolves.toEqual(PUBSUB_INVOKER_IDENTITY);
      expect(await denialOf(() => authenticate(push, PUSH_PATH, {}, { key: `${PUSH_KEY}\n` }))).toEqual(
        INVALID_CREDENTIAL,
      );
      await expect(
        authenticate(auth.transports['cloud-tasks'], TASK_PATH, {
          authorization: await localServiceBearer('tasks-invoker'),
        }),
      ).resolves.toEqual(TASKS_INVOKER_IDENTITY);
    });

    it.each([
      { carrying: 'its service roles', minterRoles: undefined, roles: ['service:people'] },
      {
        carrying: 'the minterRoles',
        minterRoles: ['service:people', 'platform.operator'],
        roles: ['service:people', 'platform.operator'],
      },
    ])('mints invocation credentials for the service carrying $carrying', async ({ minterRoles, roles }) => {
      const stateDir = await withPushKey(await stateDirWith(`env-minter-${String(roles.length)}`, 'pem'));
      const auth = await createAuthFromEnv(localEnv(stateDir), { minterRoles });
      const headers = await auth.invocationMinter.headersFor({ name: 'finance' });
      const finance = createLocalInvocationVerifier({ publicKey: issuerKey.publicKey, callee: 'finance' });
      await expect(finance.verify(headers[INVOCATION_HEADER] ?? '')).resolves.toEqual({ name: 'people', roles });
    });

    it('starts without the private key file and fails only when minting', async () => {
      const stateDir = await withPushKey(await stateDirWith('env-verify-only', 'absent'));
      const auth = await createAuthFromEnv(localEnv(stateDir));
      await expect(auth.invocationMinter.headersFor({ name: 'finance' })).rejects.toThrow(
        'Local service token for people needs token-signing-private.pem',
      );
    });

    it('needs no state directory or JWKS URL when every key-backed piece is injected', async () => {
      const pieces = injectedPieces();
      const auth = await createAuthFromEnv({ OPT2_ENV: 'local', OPT2_SERVICE_NAME: 'people' }, pieces);
      expect(auth.userVerifier).toBe(pieces.userVerifier);
      expect(auth.invocationVerifier).toBe(pieces.invocationVerifier);
      expect(auth.invocationMinter).toBe(pieces.invocationMinter);
      expect(auth.transports['pubsub-push']).toBe(pieces.transports['pubsub-push']);
      expect(auth.transports['cloud-tasks']).toBe(pieces.transports['cloud-tasks']);
      const userToken = await signToken(userClaims(), issuerKey);
      await expect(
        authenticate(auth.transports.service, PEOPLE_PATH, {
          authorization: `Bearer ${userToken}`,
          [INVOCATION_HEADER]: await localServiceBearer('gateway'),
        }),
      ).resolves.toEqual({ user: userClaims(), userToken, service: { name: 'gateway', roles: ['service:gateway'] } });
    });

    it.each([
      { setting: 'OPT2_SERVICE_NAME', value: 'empty', env: { OPT2_SERVICE_NAME: '' } },
      { setting: 'OPT2_SERVICE_NAME', value: 'blank', env: { OPT2_SERVICE_NAME: '   ' } },
      { setting: 'OPT2_STATE_DIR', value: 'unset', env: { OPT2_STATE_DIR: undefined } },
      { setting: 'OPT2_STATE_DIR', value: 'blank', env: { OPT2_STATE_DIR: ' ' } },
      { setting: 'OPT2_JWKS_URL', value: 'unset', env: { OPT2_JWKS_URL: undefined } },
      { setting: 'OPT2_JWKS_URL', value: 'empty', env: { OPT2_JWKS_URL: '' } },
    ])('fails when $setting is $value', async ({ setting, env }) => {
      const stateDir = await withPushKey(await stateDirWith('env-required', 'pem'));
      await expect(createAuthFromEnv(localEnv(stateDir, env))).rejects.toThrow(
        `${setting} is required for OPT2_ENV=local authentication`,
      );
    });

    it('fails when the push key file is missing', async () => {
      const stateDir = await stateDirWith('env-no-push-key', 'pem');
      await expect(createAuthFromEnv(localEnv(stateDir))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses a push key file holding only whitespace', async () => {
      const stateDir = await withPushKey(await stateDirWith('env-blank-push-key', 'pem'), ' \n');
      await expect(createAuthFromEnv(localEnv(stateDir))).rejects.toThrow(
        new TypeError('Local Pub/Sub push key is empty'),
      );
    });
  });

  describe('in cloud mode', () => {
    const SERVICE_URLS = { people: PEOPLE_URL, finance: FINANCE_URL };
    const NO_SERVICE_URL = 'OPT2_SERVICE_URLS has no valid URL for people';

    /** Cloud environment of the people service; an `undefined` override drops the setting. */
    function cloudEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
      return {
        OPT2_ENV: 'cloud',
        OPT2_SERVICE_NAME: 'people',
        GOOGLE_CLOUD_PROJECT: PROJECT,
        OPT2_SERVICE_URLS: SERVICE_URLS,
        ...overrides,
      };
    }

    it.each([
      { form: 'a parsed map', urls: SERVICE_URLS },
      { form: 'JSON text', urls: JSON.stringify(SERVICE_URLS) },
    ])('verifies managed deliveries addressed to the service URL OPT2_SERVICE_URLS gives as $form', async ({ urls }) => {
      await serveGoogleCerts();
      const auth = await createAuthFromEnv(cloudEnv({ OPT2_SERVICE_URLS: urls }));
      const push = await signToken(googleOidcClaims({ aud: PUSH_ENDPOINT, email: PUBSUB_INVOKER_EMAIL }), issuerKey);
      const task = await signToken(
        googleOidcClaims({ aud: `${PEOPLE_URL}${TASK_PATH}`, email: TASKS_INVOKER_EMAIL }),
        issuerKey,
      );
      await expect(
        authenticate(auth.transports['pubsub-push'], PUSH_PATH, { authorization: `Bearer ${push}` }),
      ).resolves.toEqual({ service: { ...PUBSUB_INVOKER_IDENTITY.service, email: PUBSUB_INVOKER_EMAIL } });
      await expect(
        authenticate(auth.transports['cloud-tasks'], TASK_PATH, { authorization: `Bearer ${task}` }),
      ).resolves.toEqual({ service: { ...TASKS_INVOKER_IDENTITY.service, email: TASKS_INVOKER_EMAIL } });
    });

    it("trusts Cloud Run's verification of invocation credentials by default", async () => {
      const auth = await createAuthFromEnv(cloudEnv());
      await expect(auth.invocationVerifier.verify(`Bearer ${cloudRunForwarded(googleOidcClaims())}`)).resolves.toEqual({
        name: 'gateway',
        roles: ['service:gateway'],
        email: GATEWAY_EMAIL,
      });
      const signed = `Bearer ${await signToken(googleOidcClaims(), issuerKey)}`;
      expect(await denialOf(() => auth.invocationVerifier.verify(signed))).toEqual(INVALID_CREDENTIAL);
    });

    it('verifies the Google signature of invocation credentials for the service origin under invocationTrust verify', async () => {
      await serveGoogleCerts();
      const auth = await createAuthFromEnv(cloudEnv(), { invocationTrust: 'verify' });
      const signed = `Bearer ${await signToken(googleOidcClaims(), issuerKey)}`;
      await expect(auth.invocationVerifier.verify(signed)).resolves.toEqual({
        name: 'gateway',
        roles: ['service:gateway'],
        email: GATEWAY_EMAIL,
      });
      const forwarded = `Bearer ${cloudRunForwarded(googleOidcClaims())}`;
      expect(await denialOf(() => auth.invocationVerifier.verify(forwarded))).toEqual(INVALID_CREDENTIAL);
      const forFinance = `Bearer ${await signToken(googleOidcClaims({ aud: FINANCE_URL }), issuerKey)}`;
      expect(await denialOf(() => auth.invocationVerifier.verify(forFinance))).toEqual(INVALID_CREDENTIAL);
    });

    it.each([
      {
        settings: 'unset',
        env: {},
        iss: 'https://securetoken.google.com/proj',
        aud: PROJECT,
        jwksUrl: GOOGLE_SECURETOKEN_JWKS_URL,
        refusedIss: LOCAL_USER_TOKEN.issuer,
      },
      {
        settings: 'blank',
        env: { OPT2_TOKEN_ISSUER: '', OPT2_TOKEN_AUDIENCE: ' ', OPT2_JWKS_URL: '  ' },
        iss: 'https://securetoken.google.com/proj',
        aud: PROJECT,
        jwksUrl: GOOGLE_SECURETOKEN_JWKS_URL,
        refusedIss: LOCAL_USER_TOKEN.issuer,
      },
      {
        settings: 'explicit',
        env: {
          OPT2_TOKEN_ISSUER: 'https://identity.example/opt2',
          OPT2_TOKEN_AUDIENCE: 'opt2-people',
          OPT2_JWKS_URL: LOCAL_JWKS_URL,
        },
        iss: 'https://identity.example/opt2',
        aud: 'opt2-people',
        jwksUrl: LOCAL_JWKS_URL,
        refusedIss: 'https://securetoken.google.com/proj',
      },
    ])('verifies user tokens against the $settings issuer, audience and JWKS settings', async ({
      env,
      iss,
      aud,
      jwksUrl,
      refusedIss,
    }) => {
      const fetchSpy = await serveIssuerJwks();
      const auth = await createAuthFromEnv(cloudEnv(env));
      const claims = userClaims({ iss, aud, exp: NOW + 3600 });
      await expect(auth.userVerifier.verify(await signToken(claims, issuerKey))).resolves.toEqual(claims);
      expect(fetchSpy).toHaveBeenCalledWith(jwksUrl, expect.anything());
      const refused = await signToken(userClaims({ iss: refusedIss, aud }), issuerKey);
      expect(await denialOf(() => auth.userVerifier.verify(refused))).toEqual(INVALID_ACCESS_TOKEN);
    });

    it('mints with the Google ID-token minter, which needs the callee URL', async () => {
      const auth = await createAuthFromEnv(cloudEnv());
      await expect(auth.invocationMinter.headersFor({ name: 'finance' })).rejects.toThrow(
        new TypeError('No URL for invocation target finance'),
      );
    });

    it.each<{ problem: string; env: Partial<AuthEnv>; message: string }>([
      {
        problem: 'GOOGLE_CLOUD_PROJECT is unset',
        env: { GOOGLE_CLOUD_PROJECT: undefined },
        message: 'GOOGLE_CLOUD_PROJECT is required for OPT2_ENV=cloud authentication',
      },
      {
        problem: 'GOOGLE_CLOUD_PROJECT is blank',
        env: { GOOGLE_CLOUD_PROJECT: ' ' },
        message: 'GOOGLE_CLOUD_PROJECT is required for OPT2_ENV=cloud authentication',
      },
      {
        problem: 'OPT2_SERVICE_NAME is empty',
        env: { OPT2_SERVICE_NAME: '' },
        message: 'OPT2_SERVICE_NAME is required for OPT2_ENV=cloud authentication',
      },
      { problem: 'OPT2_SERVICE_URLS is unset', env: { OPT2_SERVICE_URLS: undefined }, message: NO_SERVICE_URL },
      {
        problem: 'OPT2_SERVICE_URLS is not JSON',
        env: { OPT2_SERVICE_URLS: '{people:' },
        message: 'OPT2_SERVICE_URLS must be a JSON object',
      },
      {
        problem: 'OPT2_SERVICE_URLS is a JSON string',
        env: { OPT2_SERVICE_URLS: JSON.stringify(PEOPLE_URL) },
        message: NO_SERVICE_URL,
      },
      { problem: 'OPT2_SERVICE_URLS is JSON null', env: { OPT2_SERVICE_URLS: 'null' }, message: NO_SERVICE_URL },
      {
        problem: 'OPT2_SERVICE_URLS lacks the service',
        env: { OPT2_SERVICE_URLS: { finance: FINANCE_URL } },
        message: NO_SERVICE_URL,
      },
      {
        problem: 'the service URL is not a URL',
        env: { OPT2_SERVICE_URLS: { people: 'opt2-people' } },
        message: NO_SERVICE_URL,
      },
      {
        problem: 'the service URL is not a string',
        env: { OPT2_SERVICE_URLS: '{"people":42}' },
        message: NO_SERVICE_URL,
      },
    ])('fails when $problem', async ({ env, message }) => {
      await expect(createAuthFromEnv(cloudEnv(env))).rejects.toThrow(message);
    });

    it('needs no OPT2_SERVICE_URLS when Cloud Run vouches for callers and both managed schemes are injected', async () => {
      const { transports } = injectedPieces();
      const env = cloudEnv({ OPT2_SERVICE_URLS: undefined });
      const auth = await createAuthFromEnv(env, { transports });
      expect(auth.transports['pubsub-push']).toBe(transports['pubsub-push']);
      expect(auth.transports['cloud-tasks']).toBe(transports['cloud-tasks']);
      await expect(createAuthFromEnv(env, { transports, invocationTrust: 'verify' })).rejects.toThrow(NO_SERVICE_URL);
    });
  });

  it.each([
    { key: 'service', registered: 'pubsub-push' },
    { key: 'pubsub-push', registered: 'cloud-tasks' },
    { key: 'cloud-tasks', registered: 'service' },
  ] as const)('refuses an authenticator implementing $registered registered as the $key transport', async ({
    key,
    registered,
  }) => {
    const pieces = injectedPieces();
    const byTransport: TransportSet = { ...pieces.transports, service: createServiceTransport(pieces) };
    const auth = createAuthFromEnv(
      { OPT2_ENV: 'local', OPT2_SERVICE_NAME: 'people' },
      { ...pieces, transports: { ...byTransport, [key]: byTransport[registered] } },
    );
    await expect(auth).rejects.toThrow(new TypeError(`The ${key} authenticator implements ${registered}`));
  });
});

