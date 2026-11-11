// Per-transport authentication schemes of @opt2/platform/auth and their assembly from the environment.
import { createHash, timingSafeEqual, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import type { CryptoKey } from 'jose';
import { AuthDenial, TRANSPORTS, type ServiceIdentity, type Transport, type UserClaims } from './claims.js';
import { createGoogleIdTokenClient, verifyGoogleIdToken } from './deadline.js';
import { PUBSUB_INVOKER_ROLE, TASKS_INVOKER_ROLE } from './roles.js';
import {
  LOCAL_USER_TOKEN,
  cloudUserTokenSettings,
  createUserTokenVerifier,
  type UserTokenVerifier,
} from './user-token.js';
import {
  INVOCATION_HEADER,
  LOCAL_SECRET_FILES,
  MANAGED_INVOKER_NAMES,
  createCloudInvocationMinter,
  createCloudInvocationVerifier,
  createCloudRunInvocationReader,
  createLocalInvocationMinter,
  createLocalInvocationVerifier,
  loadLocalSigningKeys,
  localSecretPath,
  serviceAccountEmail,
  verifyLocalServiceToken,
  type InvocationMinter,
  type InvocationVerifier,
  type LocalSigningKeys,
} from './invocation.js';

/** Framework-neutral view of an inbound request; header names are lower-case. */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  /** Request path; a query string on it is ignored. */
  path: string;
}

/** Identities one transport verified for a request. */
export interface AuthResult {
  user?: UserClaims;
  /** Raw bearer user token, present exactly when `user` is. */
  userToken?: string;
  service?: ServiceIdentity;
}

/** Authentication scheme of one transport; every refusal rejects with an `AuthDenial`. */
export interface TransportAuthenticator {
  readonly transport: Transport;
  authenticate(req: AuthRequest, opts: { optional: boolean }): Promise<AuthResult>;
}

/** One authenticator per transport. */
export type TransportSet = Readonly<Record<Transport, TransportAuthenticator>>;

/** Transports reserved for managed Google deliveries. */
export type ManagedTransport = Exclude<Transport, 'service'>;

/** Paths of each managed transport; every other path uses the `service` transport. */
export const MANAGED_PATH_PATTERNS: Readonly<Record<ManagedTransport, readonly RegExp[]>> = Object.freeze({
  'pubsub-push': Object.freeze([/^\/internal\/v1\/events\/[^/]+$/]),
  'cloud-tasks': Object.freeze([
    /^\/internal\/v1\/tasks\//,
    /^\/internal\/v1\/outbox\/sweep$/,
    /^\/internal\/v1\/jobs\//,
  ]),
});

const MANAGED_TRANSPORTS = TRANSPORTS.filter((transport): transport is ManagedTransport => transport !== 'service');

const [PUBSUB_INVOKER, TASKS_INVOKER] = MANAGED_INVOKER_NAMES;

function withoutQuery(path: string): string {
  const query = path.indexOf('?');
  return query === -1 ? path : path.slice(0, query);
}

/** Transport a route at `path` must declare: the managed transport whose pattern matches, otherwise `service`. */
export function transportForPath(path: string): Transport {
  const pathname = withoutQuery(path);
  const matches = (transport: ManagedTransport): boolean =>
    MANAGED_PATH_PATTERNS[transport].some((pattern) => pattern.test(pathname));
  return MANAGED_TRANSPORTS.find(matches) ?? 'service';
}

/** OIDC audience of a managed delivery to `path`: the service URL's origin plus the path, without its query. */
export function managedAudience(selfUrl: string, path: string): string {
  return new URL(selfUrl).origin + withoutQuery(path);
}

function headerValue(req: AuthRequest, name: string): string | undefined {
  const value = req.headers[name];
  // A repeated credential header is ambiguous, so it is refused rather than one copy picked.
  if (Array.isArray(value)) {
    throw AuthDenial.unauthenticated('invalid-credential');
  }
  return value;
}

/** Lower-cased scheme and the credentials after it, for an `Authorization`-style value. */
function splitAuthorization(value: string): { scheme: string; credentials: string } {
  const [scheme = '', ...credentials] = value.trim().split(/\s+/);
  return { scheme: scheme.toLowerCase(), credentials: credentials.join(' ') };
}

/** Bearer token a managed delivery carries in `Authorization`. */
function managedBearerToken(req: AuthRequest): string {
  const authorization = headerValue(req, 'authorization');
  if (authorization === undefined) {
    throw AuthDenial.unauthenticated('missing-credential');
  }
  const { scheme, credentials } = splitAuthorization(authorization);
  if (scheme !== 'bearer') {
    throw AuthDenial.unauthenticated('wrong-scheme');
  }
  if (credentials === '' || credentials.includes(' ')) {
    throw AuthDenial.unauthenticated('invalid-credential');
  }
  return credentials;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Scheme of user-facing and `/internal/v1/*` service routes: invocation credential plus optional bearer user token. */
export function createServiceTransport(opts: {
  userVerifier: UserTokenVerifier;
  invocationVerifier: InvocationVerifier;
}): TransportAuthenticator {
  return {
    transport: 'service',
    async authenticate(req, { optional }) {
      const invocation = headerValue(req, INVOCATION_HEADER);
      if (invocation === undefined && !optional) {
        throw AuthDenial.unauthenticated('missing-credential');
      }
      const service = invocation === undefined ? undefined : await opts.invocationVerifier.verify(invocation);
      const authorization = headerValue(req, 'authorization');
      if (authorization === undefined) {
        return { service };
      }
      const { scheme, credentials } = splitAuthorization(authorization);
      // Legacy Basic and other client credentials are exchanged at the gateway and never reach a service.
      if (scheme !== 'bearer') {
        throw AuthDenial.unauthenticated('wrong-scheme');
      }
      const user = await opts.userVerifier.verify(credentials);
      return { user, userToken: credentials, service };
    },
  };
}

/** Local emulator push scheme: the push key in the `key` query parameter, compared in constant time. */
export function createLocalPubSubPushTransport(opts: { pushKey: string }): TransportAuthenticator {
  // An empty key would admit any request carrying `?key=`.
  if (opts.pushKey === '') {
    throw new TypeError('Local Pub/Sub push key is empty');
  }
  const expected = sha256(opts.pushKey);
  return {
    transport: 'pubsub-push',
    async authenticate(req) {
      if (req.headers.authorization !== undefined) {
        throw AuthDenial.unauthenticated('wrong-scheme');
      }
      const key = req.query?.key;
      if (key === undefined) {
        throw AuthDenial.unauthenticated('missing-credential');
      }
      // Equal-length digests keep timingSafeEqual from throwing on, or leaking, a length difference.
      if (typeof key !== 'string' || !timingSafeEqual(sha256(key), expected)) {
        throw AuthDenial.unauthenticated('invalid-credential');
      }
      return { service: { name: PUBSUB_INVOKER, roles: [PUBSUB_INVOKER_ROLE] } };
    },
  };
}

function createCloudManagedTransport(
  transport: ManagedTransport,
  invoker: (typeof MANAGED_INVOKER_NAMES)[number],
  role: string,
  opts: { project: string; selfUrl: string; client?: OAuth2Client },
): TransportAuthenticator {
  const client = opts.client ?? createGoogleIdTokenClient();
  const email = serviceAccountEmail(invoker, opts.project);
  return {
    transport,
    async authenticate(req) {
      const idToken = managedBearerToken(req);
      const audience = managedAudience(opts.selfUrl, req.path);
      let payload: TokenPayload | undefined;
      try {
        payload = await verifyGoogleIdToken(client, idToken, audience);
      } catch {
        throw AuthDenial.unauthenticated('invalid-credential');
      }
      if (payload?.email !== email || payload.email_verified !== true) {
        throw AuthDenial.unauthenticated('invalid-credential');
      }
      return { service: { name: invoker, roles: [role], email } };
    },
  };
}

/** Managed Pub/Sub push scheme: the `pubsub-invoker` Google OIDC token addressed to this push endpoint. */
export function createCloudPubSubPushTransport(opts: {
  project: string;
  selfUrl: string;
  client?: OAuth2Client;
}): TransportAuthenticator {
  return createCloudManagedTransport('pubsub-push', PUBSUB_INVOKER, PUBSUB_INVOKER_ROLE, opts);
}

/** Local Cloud Tasks scheme: a local `tasks-invoker` service token addressed to this service. */
export function createLocalCloudTasksTransport(opts: {
  publicKey: CryptoKey | KeyObject;
  callee: string;
}): TransportAuthenticator {
  return {
    transport: 'cloud-tasks',
    async authenticate(req) {
      const identity = await verifyLocalServiceToken(managedBearerToken(req), {
        publicKey: opts.publicKey,
        audience: opts.callee,
      });
      if (identity.name !== TASKS_INVOKER) {
        throw AuthDenial.unauthenticated('wrong-scheme');
      }
      return { service: { name: TASKS_INVOKER, roles: [TASKS_INVOKER_ROLE] } };
    },
  };
}

/** Managed Cloud Tasks scheme: the `tasks-invoker` Google OIDC token addressed to this task URL. */
export function createCloudCloudTasksTransport(opts: {
  project: string;
  selfUrl: string;
  client?: OAuth2Client;
}): TransportAuthenticator {
  return createCloudManagedTransport('cloud-tasks', TASKS_INVOKER, TASKS_INVOKER_ROLE, opts);
}

/** Variables `createAuthFromEnv` reads; service-kit's parsed environment satisfies it. */
export interface AuthEnv {
  OPT2_ENV: 'local' | 'cloud';
  OPT2_SERVICE_NAME: string;
  OPT2_STATE_DIR?: string;
  OPT2_JWKS_URL?: string;
  OPT2_TOKEN_ISSUER?: string;
  OPT2_TOKEN_AUDIENCE?: string;
  /** Service name to URL map, parsed or as JSON text. */
  OPT2_SERVICE_URLS?: Record<string, string> | string;
  GOOGLE_CLOUD_PROJECT?: string;
}

/** Pieces that replace what `createAuthFromEnv` would build, such as a test signer's verifiers. */
export interface AuthOverrides {
  userVerifier?: UserTokenVerifier;
  invocationVerifier?: InvocationVerifier;
  invocationMinter?: InvocationMinter;
  transports?: Partial<Record<Transport, TransportAuthenticator>>;
  /** Cloud only: `cloud-run` trusts Cloud Run's verification; `verify` checks the ID token here (public ingress). */
  invocationTrust?: 'cloud-run' | 'verify';
  /** Roles the local minter signs instead of the caller's service roles. */
  minterRoles?: string[];
}

/** Verifiers, invocation minter and per-transport schemes of one process. */
export interface AuthSetup {
  userVerifier: UserTokenVerifier;
  invocationVerifier: InvocationVerifier;
  invocationMinter: InvocationMinter;
  transports: TransportSet;
}

/** Builders of the pieces an override did not supply; each runs only when its piece is needed. */
interface AuthDefaults {
  userVerifier(): UserTokenVerifier;
  invocationVerifier(): InvocationVerifier | Promise<InvocationVerifier>;
  invocationMinter(): InvocationMinter;
  pubsubPush(): TransportAuthenticator | Promise<TransportAuthenticator>;
  cloudTasks(): TransportAuthenticator | Promise<TransportAuthenticator>;
}

type AuthSetting = Exclude<keyof AuthEnv, 'OPT2_ENV' | 'OPT2_SERVICE_URLS'>;

function setting(env: AuthEnv, key: AuthSetting): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value;
}

function requiredSetting(env: AuthEnv, key: AuthSetting): string {
  const value = setting(env, key);
  if (value === undefined) {
    throw new Error(`${key} is required for OPT2_ENV=${env.OPT2_ENV} authentication`);
  }
  return value;
}

/** This service's own URL from `OPT2_SERVICE_URLS`. */
function selfUrlOf(env: AuthEnv): string {
  const name = requiredSetting(env, 'OPT2_SERVICE_NAME');
  let urls: unknown = env.OPT2_SERVICE_URLS ?? {};
  if (typeof urls === 'string') {
    try {
      urls = JSON.parse(urls);
    } catch {
      throw new Error('OPT2_SERVICE_URLS must be a JSON object');
    }
  }
  const url =
    typeof urls === 'object' && urls !== null && Object.hasOwn(urls, name)
      ? (urls as Record<string, unknown>)[name]
      : undefined;
  if (typeof url !== 'string' || !URL.canParse(url)) {
    throw new Error(`OPT2_SERVICE_URLS has no valid URL for ${name}`);
  }
  return url;
}

function localDefaults(env: AuthEnv, minterRoles: string[] | undefined): AuthDefaults {
  const service = requiredSetting(env, 'OPT2_SERVICE_NAME');
  let keys: Promise<LocalSigningKeys> | undefined;
  // Read on first need, so a process whose key-backed pieces are all injected needs no key files.
  const signingKeys = (): Promise<LocalSigningKeys> =>
    (keys ??= loadLocalSigningKeys(requiredSetting(env, 'OPT2_STATE_DIR')));
  return {
    userVerifier: () =>
      createUserTokenVerifier({
        issuer: setting(env, 'OPT2_TOKEN_ISSUER') ?? LOCAL_USER_TOKEN.issuer,
        audience: setting(env, 'OPT2_TOKEN_AUDIENCE') ?? LOCAL_USER_TOKEN.audience,
        jwksUrl: requiredSetting(env, 'OPT2_JWKS_URL'),
      }),
    invocationVerifier: async () =>
      createLocalInvocationVerifier({ publicKey: (await signingKeys()).publicKey, callee: service }),
    // A process without the private key file still starts; minting then fails on use.
    invocationMinter: () => ({
      async headersFor(target) {
        const minter = createLocalInvocationMinter({ keys: await signingKeys(), caller: service, roles: minterRoles });
        return minter.headersFor(target);
      },
    }),
    pubsubPush: async () => {
      const keyFile = localSecretPath(requiredSetting(env, 'OPT2_STATE_DIR'), LOCAL_SECRET_FILES.pubsubPushKey);
      return createLocalPubSubPushTransport({ pushKey: (await readFile(keyFile, 'utf8')).trim() });
    },
    cloudTasks: async () =>
      createLocalCloudTasksTransport({ publicKey: (await signingKeys()).publicKey, callee: service }),
  };
}

function cloudDefaults(env: AuthEnv, trust: 'cloud-run' | 'verify'): AuthDefaults {
  const project = requiredSetting(env, 'GOOGLE_CLOUD_PROJECT');
  const tokenDefaults = cloudUserTokenSettings(project);
  let client: OAuth2Client | undefined;
  // One client for every Google ID-token check, so the library's certificate cache is shared.
  const googleClient = (): OAuth2Client => (client ??= createGoogleIdTokenClient());
  const managed = () => ({ project, selfUrl: selfUrlOf(env), client: googleClient() });
  return {
    userVerifier: () =>
      createUserTokenVerifier({
        issuer: setting(env, 'OPT2_TOKEN_ISSUER') ?? tokenDefaults.issuer,
        audience: setting(env, 'OPT2_TOKEN_AUDIENCE') ?? tokenDefaults.audience,
        jwksUrl: setting(env, 'OPT2_JWKS_URL') ?? tokenDefaults.jwksUrl,
      }),
    invocationVerifier: () =>
      trust === 'verify'
        ? createCloudInvocationVerifier({ project, audience: selfUrlOf(env), client: googleClient() })
        : createCloudRunInvocationReader({ project }),
    invocationMinter: () => createCloudInvocationMinter(),
    pubsubPush: () => createCloudPubSubPushTransport(managed()),
    cloudTasks: () => createCloudCloudTasksTransport(managed()),
  };
}

/** Builds this process's verifiers, minter and transport schemes from the environment; overrides replace pieces. */
export async function createAuthFromEnv(env: AuthEnv, overrides: AuthOverrides = {}): Promise<AuthSetup> {
  const defaults =
    env.OPT2_ENV === 'local'
      ? localDefaults(env, overrides.minterRoles)
      : cloudDefaults(env, overrides.invocationTrust ?? 'cloud-run');
  const userVerifier = overrides.userVerifier ?? defaults.userVerifier();
  const invocationVerifier = overrides.invocationVerifier ?? (await defaults.invocationVerifier());
  const invocationMinter = overrides.invocationMinter ?? defaults.invocationMinter();
  const transports: TransportSet = Object.freeze({
    service: overrides.transports?.service ?? createServiceTransport({ userVerifier, invocationVerifier }),
    'pubsub-push': overrides.transports?.['pubsub-push'] ?? (await defaults.pubsubPush()),
    'cloud-tasks': overrides.transports?.['cloud-tasks'] ?? (await defaults.cloudTasks()),
  });
  for (const transport of TRANSPORTS) {
    if (transports[transport].transport !== transport) {
      throw new TypeError(`The ${transport} authenticator implements ${transports[transport].transport}`);
    }
  }
  return { userVerifier, invocationVerifier, invocationMinter, transports };
}
