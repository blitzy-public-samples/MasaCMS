// Token claims, workload identities, the per-request auth context and the denial error of @opt2/platform/auth.
import { z } from 'zod';
import { LegacyApiError, WWW_AUTHENTICATE, type LegacyApiErrorType } from '../legacy-compat/index.js';

/** Authentication scheme a route accepts: service calls, managed Pub/Sub push or managed Cloud Tasks. */
export type Transport = 'service' | 'pubsub-push' | 'cloud-tasks';

/** Every transport, in declaration order. */
export const TRANSPORTS: readonly Transport[] = Object.freeze(['service', 'pubsub-push', 'cloud-tasks']);

/** Verified claims of a site-scoped user token; tenant, site and roles are read only from here. */
export interface UserClaims {
  iss: string;
  aud: string | string[];
  /** Masa `UserID`. */
  sub: string;
  /** Identity session id. */
  sid: string;
  /** Tenant UUID. */
  tid: string;
  /** Legacy site id, e.g. `default` or `tenant-a`. */
  site: string;
  roles: string[];
  s2: boolean;
  /** Session epoch. */
  epoch: number;
  iat: number;
  exp: number;
}

const nonNegativeInt = z.int().nonnegative();

// z.object strips unknown keys rather than rejecting them, so Identity Platform ID tokens' extra claims
// (auth_time, user_id, firebase) pass validation and the parsed result holds only the declared fields.
/** Shape of a user-token payload, applied once by the verifier after signature, issuer and audience checks. */
export const userClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string(),
  sid: z.string(),
  tid: z.uuid(),
  site: z.string(),
  roles: z.array(z.string()),
  s2: z.boolean(),
  epoch: nonNegativeInt,
  iat: nonNegativeInt,
  exp: nonNegativeInt,
}) satisfies z.ZodType<UserClaims>;

/** Calling workload verified from an invocation or managed-delivery credential. */
export interface ServiceIdentity {
  name: string;
  roles: string[];
  /** Service account email, when the credential carried one. */
  email?: string;
}

/** Identities a request was verified for, attached to every request by the auth hooks. */
export interface Opt2AuthContext {
  user?: UserClaims;
  /** Raw verified bearer token, forwarded on service calls made for the user. */
  userToken?: string;
  service?: ServiceIdentity;
  /** Union of user and service roles, deduplicated, user roles first. */
  roles: readonly string[];
  transport: Transport;
}

/** Why a request was refused. */
export type AuthDenialReason =
  | 'missing-credential'
  | 'invalid-credential'
  | 'expired-credential'
  | 'wrong-scheme'
  | 'forbidden'
  | 'site-mismatch'
  | 'undeclared-route';

/** Legacy JSON API error types an auth denial answers with. */
export type AuthDenialType = Extract<LegacyApiErrorType, 'authorization' | 'invalidAccessToken' | 'accessTokenExpired'>;

/** Authentication or authorisation refusal; the auth hooks render it as the matching legacy JSON API error. */
export class AuthDenial extends LegacyApiError {
  override readonly name: string = 'AuthDenial';
  declare readonly type: AuthDenialType;

  private constructor(
    type: AuthDenialType,
    readonly statusCode: 401 | 403,
    readonly reason: AuthDenialReason,
    wwwAuthenticate?: string,
  ) {
    super(type, { wwwAuthenticate });
  }

  /** 401 `authorization`: no acceptable credential was presented. */
  static unauthenticated(reason: AuthDenialReason): AuthDenial {
    return new AuthDenial('authorization', 401, reason);
  }

  /** 401 `invalidAccessToken` with the legacy bearer challenge. */
  static invalidToken(): AuthDenial {
    return new AuthDenial('invalidAccessToken', 401, 'invalid-credential', WWW_AUTHENTICATE.bearerInvalidAccessToken);
  }

  /** 401 `accessTokenExpired` with the legacy bearer challenge. */
  static expiredToken(): AuthDenial {
    return new AuthDenial('accessTokenExpired', 401, 'expired-credential', WWW_AUTHENTICATE.bearerInvalidAccessToken);
  }

  /** 403 `authorization`: the verified identities lack every required role. */
  static forbidden(reason: AuthDenialReason = 'forbidden'): AuthDenial {
    return new AuthDenial('authorization', 403, reason);
  }

  /** 403 `authorization`: the request's `siteid` is not the token's site. */
  static siteMismatch(): AuthDenial {
    return AuthDenial.forbidden('site-mismatch');
  }
}
