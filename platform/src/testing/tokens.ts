// Test credentials of @opt2/platform/testing: one RS256 key pair, minted user and service tokens, verifier overrides and matrix subjects.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  type LocalJWKSet,
} from 'jose';
import {
  INVOCATION_HEADER,
  LOCAL_SECRET_FILES,
  LOCAL_USER_TOKEN,
  MANAGED_INVOKER_NAMES,
  Roles,
  SYNTHETIC_ROLES,
  createLocalCloudTasksTransport,
  createLocalInvocationMinter,
  createLocalInvocationVerifier,
  createLocalPubSubPushTransport,
  createServiceTransport,
  createUserTokenVerifier,
  localSecretPath,
  rolesForService,
  serviceRole,
  signLocalServiceToken,
  type AuthOverrides,
  type InvocationMinter,
  type InvocationVerifier,
  type LocalSigningKeys,
  type Transport,
  type TransportAuthenticator,
  type UserTokenVerifier,
} from '../auth/index.js';
import type { CreateServiceOptions } from '../service-kit/index.js';
import { tenantIdForSite } from '../tenancy/index.js';
import { TENANT_A, TENANT_B, fixtureForTenant } from './fixtures.js';

type VerifierOverride = NonNullable<CreateServiceOptions['verifierOverride']>;

const [PUBSUB_INVOKER, TASKS_INVOKER] = MANAGED_INVOKER_NAMES;

/** Caller whose invocation credential accompanies every user request, since user calls arrive through the gateway. */
const GATEWAY_CALLER = 'gateway';

/** Fixed local Pub/Sub push key of tests; not a secret. */
export const TEST_PUSH_KEY = 'opt2-test-push-key';

/** The test key pair; unlike a loaded pair, the private key is always present. */
export type TestSigningKeys = Required<LocalSigningKeys>;

/** Memoises an async factory so it runs on first use only. */
function lazy<T>(make: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= make());
}

/** The process-wide RS256 test key pair, generated on first use; `kid` is the RFC 7638 thumbprint, as loadLocalSigningKeys derives it. */
export const testSigningKeys: () => Promise<TestSigningKeys> = lazy(async () => {
  const { privateKey, publicKey } = await generateKeyPair(LOCAL_USER_TOKEN.algorithm, { extractable: true });
  const kid = await calculateJwkThumbprint(await exportJWK(publicKey));
  return { privateKey, publicKey, kid };
});

/** JWKS document publishing the test public key, as identity's JWKS route publishes the local one. */
export async function testJwks(): Promise<JSONWebKeySet> {
  const { publicKey, kid } = await testSigningKeys();
  return { keys: [{ ...(await exportJWK(publicKey)), kid, alg: LOCAL_USER_TOKEN.algorithm, use: 'sig' }] };
}

const testJwkSet: () => Promise<LocalJWKSet> = lazy(async () => createLocalJWKSet(await testJwks()));

/** Key resolver over the test JWKS, selecting by `kid` and `alg` like a remote JWKS. */
const testKeySet: JWTVerifyGetKey = async (protectedHeader, token) => (await testJwkSet())(protectedHeader, token);

/** Query string (without `?`) carrying the local push key, as the emulator's push endpoint URL does. */
export function pushKeyQuery(key: string = TEST_PUSH_KEY): string {
  return `key=${encodeURIComponent(key)}`;
}

/** Writes the test key pair and push key as the `${OPT2_STATE_DIR}/secrets/` files the local adapters load. */
export async function writeTestSecrets(stateDir: string): Promise<void> {
  const { privateKey, publicKey } = await testSigningKeys();
  const contents: Record<string, string> = {
    [LOCAL_SECRET_FILES.tokenSigningPrivateKey]: await exportPKCS8(privateKey),
    [LOCAL_SECRET_FILES.tokenSigningPublicKey]: await exportSPKI(publicKey),
    [LOCAL_SECRET_FILES.pubsubPushKey]: TEST_PUSH_KEY,
  };
  for (const [file, content] of Object.entries(contents)) {
    const target = localSecretPath(stateDir, file);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
  }
}

interface UserTokenClaimsInput {
  /** Masa `UserID`. */
  sub: string;
  /** Defaults to a random UUID. */
  sid?: string;
  roles: readonly string[];
  /** Defaults to whether `roles` holds `s2`. */
  s2?: boolean;
  /** Defaults to 0. */
  epoch?: number;
  /** Seconds since the epoch; defaults to now. */
  iat?: number;
  /** Seconds since the epoch; defaults to `iat` plus the local lifetime, and may lie in the past. */
  exp?: number;
  /** Defaults to the local identity issuer. */
  iss?: string;
  /** Defaults to the local audience. */
  aud?: string | string[];
}

/** Input of mintUserToken: `site` alone derives `tid`, `tid` alone takes the fixture's site, both are used as given. */
export type MintUserTokenInput = UserTokenClaimsInput &
  ({ site: string; tid?: string } | { tid: string; site?: string });

function tenantAndSite(input: MintUserTokenInput): { tid: string; site: string } {
  const { tid, site } = input;
  if (site !== undefined) {
    return { tid: tid ?? tenantIdForSite(site), site };
  }
  if (tid === undefined) {
    throw new TypeError('mintUserToken needs site or tid');
  }
  const fixture = fixtureForTenant(tid);
  if (fixture === undefined) {
    throw new TypeError(`No tenant fixture for tid ${tid}; pass site as well`);
  }
  return { tid, site: fixture.siteId };
}

/** Signs a user token with the test key, in the shape identity's local signer mints. */
export async function mintUserToken(input: MintUserTokenInput): Promise<string> {
  const { tid, site } = tenantAndSite(input);
  const { privateKey, kid } = await testSigningKeys();
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  return new SignJWT({
    sid: input.sid ?? randomUUID(),
    tid,
    site,
    roles: [...input.roles],
    s2: input.s2 ?? input.roles.includes(Roles.s2),
    epoch: input.epoch ?? 0,
  })
    .setProtectedHeader({ alg: LOCAL_USER_TOKEN.algorithm, kid })
    .setIssuer(input.iss ?? LOCAL_USER_TOKEN.issuer)
    .setAudience(input.aud ?? LOCAL_USER_TOKEN.audience)
    .setSubject(input.sub)
    .setIssuedAt(iat)
    .setExpirationTime(input.exp ?? iat + LOCAL_USER_TOKEN.lifetimeSeconds)
    .sign(privateKey);
}

/** Local service token of `caller` addressed to the callee's service name, for `X-Serverless-Authorization`. */
export async function mintServiceToken(opts: { caller: string; audience: string; roles?: string[] }): Promise<string> {
  return signLocalServiceToken({ keys: await testSigningKeys(), ...opts });
}

/** Local `tasks-invoker` token, sent in `Authorization` on the managed Cloud Tasks routes. */
export async function mintTasksInvokerToken(opts: { audience: string }): Promise<string> {
  return mintServiceToken({ caller: TASKS_INVOKER, audience: opts.audience });
}

/** Invocation minter signing with the test key as `caller`. */
export function testInvocationMinter(opts: { caller: string; roles?: string[] }): InvocationMinter {
  return {
    async headersFor(target) {
      const minter = createLocalInvocationMinter({ keys: await testSigningKeys(), ...opts });
      return minter.headersFor(target);
    },
  };
}

/** Test overrides whose user verifier and Pub/Sub push scheme are always set. */
export interface TestAuthOverrides extends AuthOverrides {
  userVerifier: UserTokenVerifier;
  transports: Partial<Record<Transport, TransportAuthenticator>>;
}

/** Test overrides bound to a callee: every key-backed piece is set, so no secret file is read. */
export interface CalleeTestAuthOverrides extends TestAuthOverrides {
  invocationVerifier: InvocationVerifier;
  invocationMinter: InvocationMinter;
  transports: Record<Transport, TransportAuthenticator>;
}

function testInvocationVerifier(callee: string): InvocationVerifier {
  const verifier = lazy(async () =>
    createLocalInvocationVerifier({ publicKey: (await testSigningKeys()).publicKey, callee }),
  );
  return { verify: async (headerValue) => (await verifier()).verify(headerValue) };
}

function testCloudTasksTransport(callee: string): TransportAuthenticator {
  const transport = lazy(async () =>
    createLocalCloudTasksTransport({ publicKey: (await testSigningKeys()).publicKey, callee }),
  );
  return { transport: 'cloud-tasks', authenticate: async (req, opts) => (await transport()).authenticate(req, opts) };
}

/**
 * `verifierOverride` built from auth's own factories over the test keys. Without `callee`, createAuthFromEnv's local
 * defaults supply the invocation verifier, minter and Cloud Tasks scheme from writeTestSecrets' files and `OPT2_SERVICE_NAME`.
 */
export function testVerifier(): TestAuthOverrides;
export function testVerifier(callee: string): CalleeTestAuthOverrides;
export function testVerifier(callee?: string): TestAuthOverrides {
  const userVerifier = createUserTokenVerifier({
    issuer: LOCAL_USER_TOKEN.issuer,
    audience: LOCAL_USER_TOKEN.audience,
    keySet: testKeySet,
  });
  const pubsubPush = createLocalPubSubPushTransport({ pushKey: TEST_PUSH_KEY });
  if (callee === undefined) {
    return { userVerifier, transports: { 'pubsub-push': pubsubPush } } satisfies VerifierOverride;
  }
  const invocationVerifier = testInvocationVerifier(callee);
  const overrides: CalleeTestAuthOverrides = {
    userVerifier,
    invocationVerifier,
    invocationMinter: testInvocationMinter({ caller: callee }),
    transports: {
      service: createServiceTransport({ userVerifier, invocationVerifier }),
      'pubsub-push': pubsubPush,
      'cloud-tasks': testCloudTasksTransport(callee),
    },
  };
  return overrides satisfies VerifierOverride;
}

/** One identity of the authorisation matrix. */
export interface RoleSubject {
  name: string;
  kind: 'anonymous' | 'user' | 'service';
  roles: readonly string[];
  s2?: boolean;
  /** Site the subject's token is minted for, instead of the one under test. */
  siteOverride?: string;
  /** Service name of a `service` subject. */
  caller?: string;
}

/** Workloads of the matrix: every service, the gateway, web, migration, operator and the two managed invokers. */
export const SERVICE_CALLERS: readonly string[] = Object.freeze([
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
  'stub',
  GATEWAY_CALLER,
  'web',
  'migration',
  'operator',
  PUBSUB_INVOKER,
  TASKS_INVOKER,
]);

function userSubject(name: string, roles: readonly string[], extra: Partial<RoleSubject> = {}): RoleSubject {
  return Object.freeze({ name, kind: 'user', roles: Object.freeze([...roles]), ...extra });
}

function serviceSubject(caller: string): RoleSubject {
  return Object.freeze({
    name: serviceRole(caller),
    kind: 'service',
    roles: Object.freeze(rolesForService(caller)),
    caller,
  });
}

/** Every identity a route is checked against; the editor carries only token roles, since node verdicts come from projections. */
export const ROLE_SET: readonly RoleSubject[] = Object.freeze([
  Object.freeze({ name: 'anonymous', kind: 'anonymous', roles: Object.freeze([]) }),
  userSubject(Roles.member, [Roles.member]),
  userSubject(Roles.systemUser, [Roles.systemUser]),
  userSubject('editor', [Roles.systemUser]),
  userSubject(Roles.siteAdmin, [Roles.systemUser, Roles.siteAdmin]),
  userSubject(Roles.s2, [Roles.systemUser, Roles.s2], { s2: true }),
  userSubject('other-tenant', [Roles.systemUser, Roles.siteAdmin], { siteOverride: TENANT_B.siteId }),
  ...SYNTHETIC_ROLES.map((role) => userSubject(role, [Roles.systemUser, role])),
  ...SERVICE_CALLERS.map(serviceSubject),
] satisfies RoleSubject[]);

/** Options of authHeadersFor. */
export interface AuthHeadersOptions {
  /** Service name of the app under test. */
  audience: string;
  /** Site of user tokens; defaults to `tenant-a`. */
  site?: string;
  /** Masa `UserID` of user tokens; defaults to one per subject. */
  sub?: string;
}

/** Request headers presenting `subject`'s credentials to `app.inject`; a push subject also needs subjectQueryFor. */
export async function authHeadersFor(subject: RoleSubject, opts: AuthHeadersOptions): Promise<Record<string, string>> {
  const { audience } = opts;
  if (subject.kind === 'anonymous') {
    return {};
  }
  if (subject.kind === 'user') {
    const [userToken, gatewayToken] = await Promise.all([
      mintUserToken({
        sub: opts.sub ?? `test-${subject.name}`,
        site: subject.siteOverride ?? opts.site ?? TENANT_A.siteId,
        roles: subject.roles,
        s2: subject.s2,
      }),
      mintServiceToken({ caller: GATEWAY_CALLER, audience }),
    ]);
    return { authorization: `Bearer ${userToken}`, [INVOCATION_HEADER]: `Bearer ${gatewayToken}` };
  }
  const { caller } = subject;
  if (caller === undefined) {
    throw new TypeError(`Service subject ${subject.name} has no caller`);
  }
  if (caller === PUBSUB_INVOKER) {
    return {};
  }
  if (caller === TASKS_INVOKER) {
    return { authorization: `Bearer ${await mintTasksInvokerToken({ audience })}` };
  }
  const token = await mintServiceToken({ caller, audience, roles: [...subject.roles] });
  return { [INVOCATION_HEADER]: `Bearer ${token}` };
}

/** `app.inject` query presenting `subject`'s credential: the push key for `pubsub-invoker`, otherwise empty. */
export function subjectQueryFor(subject: RoleSubject): Record<string, string> {
  return subject.kind === 'service' && subject.caller === PUBSUB_INVOKER ? { key: TEST_PUSH_KEY } : {};
}
