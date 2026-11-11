// Verification of the gateway's invocation credential and the user token on web's inbound requests (server-only).
import {
  AuthDenial,
  INVOCATION_HEADER,
  createAuthFromEnv,
  type AuthDenialReason,
  type AuthOverrides,
  type AuthRequest,
  type AuthResult,
  type AuthSetup,
  type ManagedTransport,
  type ServiceIdentity,
  type TransportAuthenticator,
  type UserClaims,
} from '@opt2/platform/auth';
import { webEnv } from './env';

/** The only workload allowed to invoke web. */
export const GATEWAY_CALLER = 'gateway';

/** Identities verified for one web request; `user` and `userToken` are absent for anonymous requests. */
export interface WebAuth {
  readonly caller: ServiceIdentity;
  readonly user?: UserClaims;
  /** Raw bearer user token, forwarded unchanged on service calls. */
  readonly userToken?: string;
}

/** Refusal web answers with a bare 401 (user token) or 403 (invocation credential or caller). */
export class WebAuthError extends Error {
  override readonly name: string = 'WebAuthError';

  constructor(
    readonly status: 401 | 403,
    readonly reason: AuthDenialReason,
    options?: ErrorOptions,
  ) {
    super(`Web refused the request (${status}): ${reason}`, options);
  }
}

/** Authenticator for a managed-delivery scheme web never serves; it refuses every request. */
function refusingTransport(transport: ManagedTransport): TransportAuthenticator {
  return {
    transport,
    async authenticate() {
      throw AuthDenial.unauthenticated('wrong-scheme');
    },
  };
}

// Web has no Pub/Sub push or Cloud Tasks route; injecting refusing schemes keeps createAuthFromEnv from needing
// the local push key file or, in the cloud, web's own entry in OPT2_SERVICE_URLS, which web is not given.
const WEB_AUTH_OVERRIDES: AuthOverrides = {
  transports: {
    'pubsub-push': refusingTransport('pubsub-push'),
    'cloud-tasks': refusingTransport('cloud-tasks'),
  },
};

let runtime: Promise<AuthSetup> | undefined;

/** Web's verifiers, invocation minter and transports, built from `webEnv()` on first use. */
export function webAuthRuntime(): Promise<AuthSetup> {
  if (runtime === undefined) {
    const created = (async () => createAuthFromEnv(webEnv(), WEB_AUTH_OVERRIDES))();
    runtime = created;
    // A failed build is not kept, so the next request builds again instead of failing for the process lifetime.
    created.catch(() => {
      if (runtime === created) {
        runtime = undefined;
      }
    });
  }
  return runtime;
}

/** Installs `setup` (`undefined` rebuilds from the environment on next use); returns a restore function. */
export function setWebAuthRuntimeForTests(setup: AuthSetup | undefined): () => void {
  const previous = runtime;
  runtime = setup === undefined ? undefined : Promise.resolve(setup);
  return () => {
    runtime = previous;
  };
}

/** Lower-cased header record holding only `name`, empty when the request lacks it. */
function onlyHeader(headers: Headers, name: string): AuthRequest['headers'] {
  const value = headers.get(name);
  return value === null ? {} : { [name]: value };
}

/** Runs `authenticate`, turning an `AuthDenial` into a `WebAuthError` with `status`; other errors propagate. */
async function refusingAs(status: 401 | 403, authenticate: () => Promise<AuthResult>): Promise<AuthResult> {
  try {
    return await authenticate();
  } catch (error) {
    if (error instanceof AuthDenial) {
      throw new WebAuthError(status, error.reason, { cause: error });
    }
    throw error;
  }
}

/**
 * Verifies the gateway's invocation credential and, when present, the bearer user token.
 * @throws WebAuthError 403 for a missing or invalid invocation credential or a caller other than the gateway,
 *   401 for an invalid or expired user token.
 */
export async function authenticateRequest(headers: Headers, path: string): Promise<WebAuth> {
  const { service } = (await webAuthRuntime()).transports;
  // Both credentials fail as a 401 AuthDenial, so each is verified in its own call to attribute the denial; the
  // invocation credential goes first, so a non-gateway caller's user token is never verified.
  const { service: caller } = await refusingAs(403, () =>
    service.authenticate({ headers: onlyHeader(headers, INVOCATION_HEADER), path }, { optional: false }),
  );
  if (caller?.name !== GATEWAY_CALLER) {
    throw new WebAuthError(403, 'forbidden');
  }
  const { user, userToken } = await refusingAs(401, () =>
    service.authenticate({ headers: onlyHeader(headers, 'authorization'), path }, { optional: true }),
  );
  return { caller, user, userToken };
}

/** Whether the request carries a verified user. */
export function isAuthenticated(
  auth: WebAuth,
): auth is WebAuth & { readonly user: UserClaims; readonly userToken: string } {
  return auth.user !== undefined && auth.userToken !== undefined;
}
