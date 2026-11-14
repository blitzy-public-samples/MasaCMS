// Invocation credentials of @opt2/platform/auth: the calling workload's identity in X-Serverless-Authorization.
import type { KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GoogleAuth, IdTokenClient, Impersonated, OAuth2Client } from 'google-auth-library';
import {
  SignJWT,
  calculateJwkThumbprint,
  decodeJwt,
  errors,
  exportJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  type CryptoKey,
} from 'jose';
import { AuthDenial, type ServiceIdentity } from './claims.js';
import { createGoogleIdTokenClient, untilAborted, verifyGoogleIdToken } from './deadline.js';
import { rolesForService, serviceRole } from './roles.js';

/** Header carrying the caller's invocation credential; header names are compared lower-cased. */
export const INVOCATION_HEADER = 'x-serverless-authorization';

/** Signature segment Cloud Run substitutes after verifying a forwarded ID token. */
export const SIGNATURE_REMOVED_MARKER = 'SIGNATURE_REMOVED_BY_GOOGLE';

/** Issuer of local service tokens; user tokens use the local identity issuer instead. */
export const LOCAL_SERVICE_ISSUER = 'opt2-local-service';

/** Lifetime of a local service token. */
export const LOCAL_SERVICE_TOKEN_TTL_SECONDS = 300;

/** File names under `${OPT2_STATE_DIR}/secrets/` written by `harness/repro/up.sh`. */
export const LOCAL_SECRET_FILES = {
  tokenSigningPrivateKey: 'token-signing-private.pem',
  tokenSigningPublicKey: 'token-signing-public.pem',
  pubsubPushKey: 'pubsub-push-key',
} as const;

/** Service account id prefix shared with `infra/terraform` `modules/service_account`. */
export const SERVICE_ACCOUNT_PREFIX = 'opt2-';

/** Managed-delivery identities, which never act as service callers. */
export const MANAGED_INVOKER_NAMES = ['pubsub-invoker', 'tasks-invoker'] as const;

const SERVICE_SUBJECT_PREFIX = 'service:';

/** Path of a local secret file in the state directory. */
export function localSecretPath(stateDir: string, file: string): string {
  return path.join(stateDir, 'secrets', file);
}

/** Local RS256 key pair shared by identity's user-token signer and the service-token signer. */
export interface LocalSigningKeys {
  privateKey?: CryptoKey;
  publicKey: CryptoKey;
  /** RFC 7638 SHA-256 thumbprint of the public key, published in identity's JWKS. */
  kid: string;
}

const localKeyIds = new WeakMap<CryptoKey | KeyObject, Promise<string>>();

/** RFC 7638 SHA-256 thumbprint of `publicKey`, memoised per key object. */
function localKeyId(publicKey: CryptoKey | KeyObject): Promise<string> {
  let kid = localKeyIds.get(publicKey);
  if (kid === undefined) {
    kid = exportJWK(publicKey).then((jwk) => calculateJwkThumbprint(jwk));
    localKeyIds.set(publicKey, kid);
  }
  return kid;
}

/** Loads the local key pair; a missing private key file is tolerated unless `requirePrivate` is set. */
export async function loadLocalSigningKeys(
  stateDir: string,
  opts: { requirePrivate?: boolean } = {},
): Promise<LocalSigningKeys> {
  const publicPem = await readFile(localSecretPath(stateDir, LOCAL_SECRET_FILES.tokenSigningPublicKey), 'utf8');
  const privatePem = await readFile(localSecretPath(stateDir, LOCAL_SECRET_FILES.tokenSigningPrivateKey), 'utf8').catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' && opts.requirePrivate !== true) {
        return undefined;
      }
      throw err;
    },
  );
  const publicKey = await importSPKI(publicPem, 'RS256');
  const privateKey = privatePem === undefined ? undefined : await importPKCS8(privatePem, 'RS256');
  const kid = await localKeyId(publicKey);
  return { privateKey, publicKey, kid };
}

/** Signs a local service token for `caller`, addressed to the callee's service name. */
export async function signLocalServiceToken(opts: {
  keys: LocalSigningKeys;
  caller: string;
  audience: string;
  roles?: string[];
  ttlSeconds?: number;
}): Promise<string> {
  const { privateKey, kid } = opts.keys;
  if (privateKey === undefined) {
    throw new Error(`Local service token for ${opts.caller} needs ${LOCAL_SECRET_FILES.tokenSigningPrivateKey}`);
  }
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ roles: opts.roles ?? rolesForService(opts.caller) })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(LOCAL_SERVICE_ISSUER)
    .setAudience(opts.audience)
    .setSubject(serviceRole(opts.caller))
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.ttlSeconds ?? LOCAL_SERVICE_TOKEN_TTL_SECONDS))
    .sign(privateKey);
}

/** Verifies a local service token for `audience` under the key's thumbprint `kid`; token, kid and claim-shape failures are a 401 `invalid-credential`. */
export async function verifyLocalServiceToken(
  token: string,
  opts: { publicKey: CryptoKey | KeyObject; audience: string },
): Promise<ServiceIdentity> {
  const { payload, protectedHeader } = await jwtVerify(token, opts.publicKey, {
    issuer: LOCAL_SERVICE_ISSUER,
    audience: opts.audience,
    algorithms: ['RS256'],
  }).catch((err: unknown) => {
    if (err instanceof errors.JOSEError) {
      throw AuthDenial.unauthenticated('invalid-credential');
    }
    throw err;
  });
  const kid = await localKeyId(opts.publicKey);
  const { sub, roles } = payload;
  if (
    protectedHeader.kid !== kid ||
    typeof sub !== 'string' ||
    !sub.startsWith(SERVICE_SUBJECT_PREFIX) ||
    sub.length === SERVICE_SUBJECT_PREFIX.length ||
    !Array.isArray(roles) ||
    !roles.every((role): role is string => typeof role === 'string')
  ) {
    throw AuthDenial.unauthenticated('invalid-credential');
  }
  return { name: sub.slice(SERVICE_SUBJECT_PREFIX.length), roles };
}

/** Google service account email of an OPT-2 workload. */
export function serviceAccountEmail(name: string, project: string): string {
  return `${SERVICE_ACCOUNT_PREFIX}${name}@${project}.iam.gserviceaccount.com`;
}

/** Workload identity of an OPT-2 service account email in `project`, or null for any other email. */
export function serviceIdentityFromEmail(email: string, project: string): ServiceIdentity | null {
  const domain = `@${project}.iam.gserviceaccount.com`;
  if (!email.endsWith(domain)) {
    return null;
  }
  const localPart = email.slice(0, -domain.length);
  if (!localPart.startsWith(SERVICE_ACCOUNT_PREFIX) || localPart.length === SERVICE_ACCOUNT_PREFIX.length) {
    return null;
  }
  const name = localPart.slice(SERVICE_ACCOUNT_PREFIX.length);
  return { name, roles: rolesForService(name), email };
}

/** Audience of a cloud invocation credential: the callee URL's origin. */
export function invocationAudience(url: string): string {
  return new URL(url).origin;
}

/** Callee of a service call: its service name and, in the cloud, its URL from `OPT2_SERVICE_URLS`. */
export interface InvocationTarget {
  name: string;
  url?: string;
}

/** Produces the invocation-credential header for a call to `target`. */
export interface InvocationMinter {
  /** Rejects with the signal's reason once `opts.signal` aborts. */
  headersFor(target: InvocationTarget, opts?: { signal?: AbortSignal }): Promise<Record<string, string>>;
}

/** Minter signing a fresh local service token per call, addressed to the callee's service name. */
export function createLocalInvocationMinter(opts: {
  keys: LocalSigningKeys;
  caller: string;
  roles?: string[];
}): InvocationMinter {
  return {
    async headersFor(target) {
      const token = await signLocalServiceToken({
        keys: opts.keys,
        caller: opts.caller,
        audience: target.name,
        roles: opts.roles,
      });
      return { [INVOCATION_HEADER]: `Bearer ${token}` };
    },
  };
}

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** ID-token provider impersonating `serviceAccount` through IAM Credentials, or undefined when ADC's own principal is that account. */
async function impersonatingProvider(auth: GoogleAuth, serviceAccount: string): Promise<Impersonated | undefined> {
  const { client_email: principal } = await auth.getCredentials();
  if (principal === serviceAccount) {
    return undefined;
  }
  return new Impersonated({
    sourceClient: await auth.getClient(),
    targetPrincipal: serviceAccount,
    targetScopes: [CLOUD_PLATFORM_SCOPE],
    delegates: [],
  });
}

/** Minter attaching a Google-signed ID token for the callee's origin, as ADC's principal or, when given, as `serviceAccount`. */
export function createCloudInvocationMinter(opts: { auth?: GoogleAuth; serviceAccount?: string } = {}): InvocationMinter {
  const auth = opts.auth ?? new GoogleAuth();
  const { serviceAccount } = opts;
  // One library client per audience; token caching and refresh stay inside IdTokenClient.
  const clients = new Map<string, IdTokenClient>();
  // ADC's principal is looked up at the first call and once only; a failed lookup is retried at the next.
  let impersonation: Promise<Impersonated | undefined> | undefined;
  const providerFor = (account: string): Promise<Impersonated | undefined> =>
    (impersonation ??= impersonatingProvider(auth, account).catch((error: unknown) => {
      impersonation = undefined;
      throw error;
    }));
  const clientFor = async (audience: string): Promise<IdTokenClient> => {
    const idTokenProvider = serviceAccount === undefined ? undefined : await providerFor(serviceAccount);
    return idTokenProvider === undefined
      ? auth.getIdTokenClient(audience)
      : new IdTokenClient({ targetAudience: audience, idTokenProvider });
  };
  return {
    async headersFor(target, opts) {
      if (target.url === undefined) {
        throw new TypeError(`No URL for invocation target ${target.name}`);
      }
      const audience = invocationAudience(target.url);
      const acquire = async (): Promise<Record<string, string>> => {
        let client = clients.get(audience);
        if (client === undefined) {
          client = await clientFor(audience);
          clients.set(audience, client);
        }
        const authorization = (await client.getRequestHeaders()).get('authorization');
        if (authorization === null) {
          throw new Error(`ID token client for ${audience} returned no Authorization header`);
        }
        return { [INVOCATION_HEADER]: authorization };
      };
      // Google's metadata and token requests take no signal: an abort abandons them, and they may still fill the cache.
      return untilAborted(acquire(), opts?.signal);
    },
  };
}

/** Verifies the raw invocation-credential header and returns the calling workload. */
export interface InvocationVerifier {
  verify(headerValue: string): Promise<ServiceIdentity>;
}

function bearerToken(headerValue: string): string {
  const [scheme, token, ...extra] = headerValue.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') {
    throw AuthDenial.unauthenticated('wrong-scheme');
  }
  if (token === undefined || extra.length > 0) {
    throw AuthDenial.unauthenticated('invalid-credential');
  }
  return token;
}

function refuseManagedInvoker(identity: ServiceIdentity): ServiceIdentity {
  if ((MANAGED_INVOKER_NAMES as readonly string[]).includes(identity.name)) {
    throw AuthDenial.unauthenticated('wrong-scheme');
  }
  return identity;
}

/** Verifier of local service tokens addressed to this process's service name. */
export function createLocalInvocationVerifier(opts: {
  publicKey: CryptoKey | KeyObject;
  callee: string;
}): InvocationVerifier {
  return {
    async verify(headerValue) {
      const identity = await verifyLocalServiceToken(bearerToken(headerValue), {
        publicKey: opts.publicKey,
        audience: opts.callee,
      });
      return refuseManagedInvoker(identity);
    },
  };
}

/** Reader for services behind invoker IAM: Cloud Run verified the token and stripped its signature. */
export function createCloudRunInvocationReader(opts: { project: string }): InvocationVerifier {
  return {
    async verify(headerValue) {
      const token = bearerToken(headerValue);
      const segments = token.split('.');
      if (segments.length !== 3 || segments[2] !== SIGNATURE_REMOVED_MARKER) {
        throw AuthDenial.unauthenticated('invalid-credential');
      }
      let email: unknown;
      try {
        ({ email } = decodeJwt(token));
      } catch {
        throw AuthDenial.unauthenticated('invalid-credential');
      }
      const identity = typeof email === 'string' ? serviceIdentityFromEmail(email, opts.project) : null;
      if (identity === null) {
        throw AuthDenial.unauthenticated('invalid-credential');
      }
      return refuseManagedInvoker(identity);
    },
  };
}

/** Verifier of Google-signed ID tokens, for the public-ingress gateway where Cloud Run does not vouch for the header. */
export function createCloudInvocationVerifier(opts: {
  project: string;
  audience: string;
  client?: OAuth2Client;
}): InvocationVerifier {
  const client = opts.client ?? createGoogleIdTokenClient();
  const audience = invocationAudience(opts.audience);
  return {
    async verify(headerValue) {
      const idToken = bearerToken(headerValue);
      let identity: ServiceIdentity | null = null;
      try {
        const payload = await verifyGoogleIdToken(client, idToken, audience);
        if (payload?.email_verified === true && typeof payload.email === 'string') {
          identity = serviceIdentityFromEmail(payload.email, opts.project);
        }
      } catch {
        throw AuthDenial.unauthenticated('invalid-credential');
      }
      if (identity === null) {
        throw AuthDenial.unauthenticated('invalid-credential');
      }
      return refuseManagedInvoker(identity);
    },
  };
}
