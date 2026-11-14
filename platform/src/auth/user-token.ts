// User-token verification (identity's local signer and Identity Platform) and the token-site check of @opt2/platform/auth.
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { LegacyServiceUnavailableError } from '../legacy-compat/index.js';
import { AuthDenial, userClaimsSchema, type UserClaims } from './claims.js';

/** Issuer, audience, lifetime and algorithm of the user tokens identity's local signer mints. */
export const LOCAL_USER_TOKEN = {
  issuer: 'opt2-local-identity',
  audience: 'opt2-local',
  lifetimeSeconds: 300,
  algorithm: 'RS256',
} as const;

/** Identity Platform uid of the anonymous principal, verified as `sub` ''; 36 characters, longer than any char(35) Masa `UserID` and within the uid limit. */
export const ANONYMOUS_PRINCIPAL_UID = 'opt2.identity.anonymous-principal.v1';

/** Google's JWKS for Identity Platform (securetoken) ID tokens. */
export const GOOGLE_SECURETOKEN_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/** Verifier settings for Identity Platform ID tokens of the given Google Cloud project. */
export function cloudUserTokenSettings(project: string): { issuer: string; audience: string; jwksUrl: string } {
  return {
    issuer: `https://securetoken.google.com/${project}`,
    audience: project,
    jwksUrl: GOOGLE_SECURETOKEN_JWKS_URL,
  };
}

/** Expected issuer and audience, plus either a JWKS URL or an injected key set (tests). */
export type UserTokenVerifierOptions = { issuer: string; audience: string } & (
  | { jwksUrl: string }
  | { keySet: JWTVerifyGetKey }
);

/** Verifies a bearer user token and returns its claims; a rejected token throws `AuthDenial`, an unreadable key source `KeySourceUnavailableError`. */
export interface UserTokenVerifier {
  verify(token: string): Promise<UserClaims>;
}

/** The user-token key source could not be read; renders as the legacy 503. */
export class KeySourceUnavailableError extends LegacyServiceUnavailableError {
  override readonly name: string = 'KeySourceUnavailableError';

  constructor(override readonly cause: unknown) {
    super('User-token key source unavailable', 'auto', 'key-source-unavailable');
  }
}

// JOSE codes of JWKS endpoint failures (timeout, non-200 or unparsable response, malformed set), not of the token.
const KEY_SOURCE_FAILURES: ReadonlySet<string> = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC', 'ERR_JWKS_INVALID']);

/** `keys` raising its own failures, a refused connection included, as KeySourceUnavailableError; token faults pass unchanged. */
function failClosedKeys(keys: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (protectedHeader, token) => {
    try {
      return await keys(protectedHeader, token);
    } catch (err) {
      if (err instanceof errors.JOSEError && !KEY_SOURCE_FAILURES.has(err.code)) {
        throw err;
      }
      throw new KeySourceUnavailableError(err);
    }
  };
}

/** Creates a verifier checking the RS256 signature, `iss`, `aud`, `exp` and the claim shape; the anonymous principal yields `sub` ''. */
export function createUserTokenVerifier(opts: UserTokenVerifierOptions): UserTokenVerifier {
  const keys = failClosedKeys('keySet' in opts ? opts.keySet : createRemoteJWKSet(new URL(opts.jwksUrl)));
  const verifyOptions = { issuer: opts.issuer, audience: opts.audience, algorithms: ['RS256'] };

  return {
    async verify(token: string): Promise<UserClaims> {
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, keys, verifyOptions));
      } catch (err) {
        if (err instanceof errors.JOSEError) {
          throw err.code === 'ERR_JWT_EXPIRED' ? AuthDenial.expiredToken() : AuthDenial.invalidToken();
        }
        throw err;
      }
      const parsed = userClaimsSchema.safeParse(payload);
      if (!parsed.success) {
        throw AuthDenial.invalidToken();
      }
      return parsed.data.sub === ANONYMOUS_PRINCIPAL_UID ? { ...parsed.data, sub: '' } : parsed.data;
    },
  };
}

/** Throws a 403 `AuthDenial.siteMismatch()` when a supplied `siteid` is not the token's `site` (case-insensitive). */
export function assertSiteMatches(siteid: string | undefined | null, claims: Pick<UserClaims, 'site'>): void {
  if (!siteid) {
    return;
  }
  // A legacy site id is not a tenant id, so the check uses `site`, never `tid`.
  if (siteid.toLowerCase() !== claims.site.toLowerCase()) {
    throw AuthDenial.siteMismatch();
  }
}
