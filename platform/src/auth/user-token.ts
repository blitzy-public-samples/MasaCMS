// User-token verification (identity's local signer and Identity Platform) and the token-site check of @opt2/platform/auth.
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AuthDenial, userClaimsSchema, type UserClaims } from './claims.js';

/** Issuer, audience, lifetime and algorithm of the user tokens identity's local signer mints. */
export const LOCAL_USER_TOKEN = {
  issuer: 'opt2-local-identity',
  audience: 'opt2-local',
  lifetimeSeconds: 300,
  algorithm: 'RS256',
} as const;

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

/** Verifies a bearer user token and returns its claims; a rejected token throws `AuthDenial`. */
export interface UserTokenVerifier {
  verify(token: string): Promise<UserClaims>;
}

// jose wraps JWKS endpoint failures (timeout, non-200 or unparsable response, malformed set) as JOSE errors;
// they are not faults of the presented token, so they propagate like a refused connection instead of a 401.
const KEY_SOURCE_FAILURES: ReadonlySet<string> = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC', 'ERR_JWKS_INVALID']);

/** Creates a verifier checking the RS256 signature, `iss`, `aud`, `exp` and the claim shape. */
export function createUserTokenVerifier(opts: UserTokenVerifierOptions): UserTokenVerifier {
  const keys: JWTVerifyGetKey = 'keySet' in opts ? opts.keySet : createRemoteJWKSet(new URL(opts.jwksUrl));
  const verifyOptions = { issuer: opts.issuer, audience: opts.audience, algorithms: ['RS256'] };

  return {
    async verify(token: string): Promise<UserClaims> {
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, keys, verifyOptions));
      } catch (err) {
        if (err instanceof errors.JOSEError && !KEY_SOURCE_FAILURES.has(err.code)) {
          throw err.code === 'ERR_JWT_EXPIRED' ? AuthDenial.expiredToken() : AuthDenial.invalidToken();
        }
        throw err;
      }
      const parsed = userClaimsSchema.safeParse(payload);
      if (!parsed.success) {
        throw AuthDenial.invalidToken();
      }
      return parsed.data;
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
