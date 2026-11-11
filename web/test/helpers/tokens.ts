// Test subjects of the web suites, with their platform-minted user tokens and invocation credentials.
import { createHash } from 'node:crypto';
import { Roles, SYNTHETIC_ROLES, moduleRole, type Role } from '@opt2/platform/auth';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  mintServiceToken,
  mintUserToken,
  type MintUserTokenInput,
} from '@opt2/platform/testing';
import { GATEWAY_CALLER } from '@/lib/auth';

export { TENANT_A, TENANT_B, TENANT_UMBRELLA };

/** Service name web's invocation verifier expects as audience: its fixed `OPT2_SERVICE_NAME`. */
const WEB_AUDIENCE = 'web';

/** Masa's installed site, which holds the installed admin and qa_editor accounts. */
const DEFAULT_SITE = 'default';

/** Masa's Site Manager (content) module. */
const CONTENT_MODULE_ID = '00000000000000000000000000000000000';

type RoleValue = (typeof Roles)[keyof typeof Roles];

/** A synthetic-module role; it is also the key of that role's subject. */
export type SyntheticRoleKey = Exclude<Extract<RoleValue, `${string}.${string}`>, `platform.${string}`>;

type BaseSubjectKey = 'admin' | 'qaEditor' | 'siteAdmin' | 'systemUser' | 'member' | 'otherTenant' | 'anonymous';

/** Key of a SUBJECTS entry. */
export type WebTestSubjectKey = BaseSubjectKey | SyntheticRoleKey;

/** A user the gateway may forward to web, described by the claims of its token. */
export interface WebTestSubject {
  readonly key: WebTestSubjectKey;
  /** Masa `UserID`: a fixed CF-format UUID, empty for `anonymous`. */
  readonly sub: string;
  /** Identity session id, empty for `anonymous`. */
  readonly sid: string;
  /** Legacy site id. */
  readonly site: string;
  /** Tenant UUID of `site`. */
  readonly tid: string;
  readonly roles: readonly Role[];
  readonly s2: boolean;
  /** Set on the subject no token is ever minted for. */
  readonly anonymous?: boolean;
}

/** Whether `role` is one of the platform's synthetic-module roles. */
function isSyntheticRole(role: string): role is SyntheticRoleKey {
  return SYNTHETIC_ROLES.includes(role);
}

// The admin gets one too: Masa's installed admin UserID is a createUUID() value, while legacy-compat's
// LEGACY_ADMIN_SENTINEL_ID is the home ContentID, not a user id.
/** Fixed CF `createUUID()`-format id (uppercase, 8-4-4-16) derived from `seed`, stable across runs and subject order. */
function fixedCfUuid(seed: string): string {
  const hex = createHash('sha256').update(`opt2-web-test:${seed}`).digest('hex').slice(0, 32).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16)}`;
}

/** Frozen subject on `site`; `s2` follows `roles`, as the minted token derives it. */
function defineSubject(
  key: WebTestSubjectKey,
  site: string,
  tid: string,
  roles: readonly Role[],
  anonymous = false,
): WebTestSubject {
  return Object.freeze({
    key,
    sub: anonymous ? '' : fixedCfUuid(key),
    sid: anonymous ? '' : `web-test-session-${key}`,
    site,
    tid,
    roles: Object.freeze([...roles]),
    s2: roles.includes(Roles.s2),
    ...(anonymous ? { anonymous: true } : {}),
  });
}

// The testing fixtures cover tenant-a, tenant-b and umbrella only, so `default` takes the tenancy rule itself.
const DEFAULT_TENANT_ID = tenantIdForSite(DEFAULT_SITE);

/** One subject per synthetic role on `tenant-a`, holding that role beside `system-user`. */
function syntheticSubjects(): Record<SyntheticRoleKey, WebTestSubject> {
  const entries = SYNTHETIC_ROLES.filter(isSyntheticRole).map(
    (role) => [role, defineSubject(role, TENANT_A.siteId, TENANT_A.tenantId, [Roles.systemUser, role])] as const,
  );
  // Object.fromEntries widens keys to string; the entries cover every synthetic role, so the record is complete.
  return Object.fromEntries(entries) as Record<SyntheticRoleKey, WebTestSubject>;
}

/** Every test subject by key: the installed admin and editor, tenant-a and tenant-b users, anonymous, and the synthetic roles. */
export const SUBJECTS: Readonly<Record<WebTestSubjectKey, WebTestSubject>> = Object.freeze({
  admin: defineSubject('admin', DEFAULT_SITE, DEFAULT_TENANT_ID, [Roles.s2, Roles.systemUser]),
  qaEditor: defineSubject('qaEditor', DEFAULT_SITE, DEFAULT_TENANT_ID, [
    Roles.systemUser,
    moduleRole(CONTENT_MODULE_ID),
  ]),
  siteAdmin: defineSubject('siteAdmin', TENANT_A.siteId, TENANT_A.tenantId, [Roles.siteAdmin, Roles.systemUser]),
  systemUser: defineSubject('systemUser', TENANT_A.siteId, TENANT_A.tenantId, [Roles.systemUser]),
  member: defineSubject('member', TENANT_A.siteId, TENANT_A.tenantId, [Roles.member]),
  otherTenant: defineSubject('otherTenant', TENANT_B.siteId, TENANT_B.tenantId, [Roles.siteAdmin, Roles.systemUser]),
  anonymous: defineSubject('anonymous', DEFAULT_SITE, DEFAULT_TENANT_ID, [], true),
  ...syntheticSubjects(),
});

/** The subject of a synthetic-module role; throws `TypeError` for any other role. */
export function syntheticSubject(role: Role): WebTestSubject {
  if (!isSyntheticRole(role)) {
    throw new TypeError(`Not a synthetic role: ${role}`);
  }
  return SUBJECTS[role];
}

/** The subject itself, or the SUBJECTS entry of a key. */
function resolveSubject(subject: WebTestSubject | WebTestSubjectKey): WebTestSubject {
  return typeof subject === 'string' ? SUBJECTS[subject] : subject;
}

/**
 * Raw user token of `subject`, or undefined for `anonymous`. `overrides` replace claims; overriding only `site`
 * or only `tid` lets the platform derive the other, and `s2` follows the roles unless overridden.
 */
export async function userTokenFor(
  subject: WebTestSubject | WebTestSubjectKey,
  overrides: Partial<MintUserTokenInput> = {},
): Promise<string | undefined> {
  const resolved = resolveSubject(subject);
  if (resolved.anonymous === true) {
    return undefined;
  }
  const { site, tid, ...claims } = overrides;
  const tenant =
    site !== undefined ? { site, tid } : tid !== undefined ? { tid } : { site: resolved.site, tid: resolved.tid };
  return mintUserToken({ sub: resolved.sub, sid: resolved.sid, roles: resolved.roles, ...claims, ...tenant });
}

/** Raw invocation token of the gateway addressed to web; the `X-Serverless-Authorization` value is `Bearer <token>`. */
export async function gatewayInvocation(): Promise<string> {
  return mintServiceToken({ caller: GATEWAY_CALLER, audience: WEB_AUDIENCE });
}

/** Raw invocation token of another workload, which web must refuse since only the gateway may call it. */
export async function serviceInvocation(caller: string, audience: string = WEB_AUDIENCE): Promise<string> {
  return mintServiceToken({ caller, audience });
}
