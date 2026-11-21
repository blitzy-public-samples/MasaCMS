/** Authorisation subjects of the strategies-content suites and the request headers presenting them to `app.inject`. */
import { INVOCATION_HEADER, Roles, moduleRole, rolesForService, transportForPath } from '@opt2/platform/auth';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  authHeadersFor,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushKeyQuery,
  type RoleSubject,
  type TenantFixture,
} from '@opt2/platform/testing';

/** Callee name every credential sent to the service under test is addressed to. */
const AUDIENCE = 'strategies-content';

/** Caller of the invocation credential that accompanies every relayed user call. */
const GATEWAY = 'gateway';

const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';

/** A subject of the strategies-content authorisation matrix. */
export type ContentSubject =
  | 'anonymous'
  | 'member'
  | 'system-user'
  | 'editor'
  | 'site-admin'
  | 's2'
  | 'other-tenant'
  | 'approver';

/** A subject that presents a user token. */
export type TokenSubject = Exclude<ContentSubject, 'anonymous'>;

/** Every subject, in the order the security matrix iterates them. */
export const CONTENT_SUBJECTS: readonly ContentSubject[] = Object.freeze([
  'anonymous',
  'member',
  'system-user',
  'editor',
  'site-admin',
  's2',
  'other-tenant',
  'approver',
] as const);

/** Fixed Masa `UserID` of each token subject; seeded membership projections key on the editor and approver ids. */
export const SUBJECT_USER_IDS: Readonly<Record<TokenSubject, string>> = Object.freeze({
  member: 'C0000000-0000-0000-0000000000000001',
  'system-user': 'C0000000-0000-0000-0000000000000002',
  editor: 'C0000000-0000-0000-0000000000000003',
  'site-admin': 'C0000000-0000-0000-0000000000000004',
  s2: 'C0000000-0000-0000-0000000000000005',
  'other-tenant': 'C0000000-0000-0000-0000000000000006',
  approver: 'C0000000-0000-0000-0000000000000007',
});

/** Verified claims a subject's user token carries. */
export interface SubjectClaims {
  readonly site: string;
  readonly tid: string;
  readonly roles: readonly string[];
  readonly s2: boolean;
}

function claims(roles: readonly string[], s2: boolean, tenant: TenantFixture = TENANT_A): SubjectClaims {
  return Object.freeze({ site: tenant.siteId, tid: tenant.tenantId, roles: Object.freeze([...roles]), s2 });
}

/** Claims of the `ROLE_SET` subject `name`, with `extraRoles` appended, so this matrix stays aligned with the shared one. */
function roleSetClaims(name: string, extraRoles: readonly string[] = [], tenant?: TenantFixture): SubjectClaims {
  const subject: RoleSubject | undefined = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return claims([...subject.roles, ...extraRoles], subject.s2 === true, tenant);
}

/** Claims of each token subject; all are minted for `tenant-a` except `other-tenant`, fully privileged in `tenant-b`. */
export const SUBJECT_CLAIMS: Readonly<Record<TokenSubject, SubjectClaims>> = Object.freeze({
  member: roleSetClaims('member'),
  'system-user': roleSetClaims('system-user'),
  editor: roleSetClaims('editor', [moduleRole(SITE_MANAGER_MODULE_ID)]),
  'site-admin': roleSetClaims('site-admin'),
  s2: roleSetClaims('s2'),
  'other-tenant': roleSetClaims('other-tenant', [], TENANT_B),
  // The approver holds no role of its own: its verdicts come from its projected approval-chain group membership.
  approver: claims([Roles.systemUser], false),
});

/** Identity session id of a subject's token, fixed so recorded CSRF consume calls can be matched to it. */
export function subjectSessionId(subject: TokenSubject): string {
  return `test-session-${subject}`;
}

/** Options of contentHeaders. */
export interface ContentHeadersOptions {
  /** Site of the user token, `tenant-a` by default; `other-tenant` always keeps its own. */
  site?: string;
  /** Callee of the gateway's invocation credential; `strategies-content` by default. */
  audience?: string;
}

function claimsFor(subject: TokenSubject, site: string | undefined): SubjectClaims {
  const base = SUBJECT_CLAIMS[subject];
  return site === undefined || subject === 'other-tenant' ? base : { ...base, site, tid: tenantIdForSite(site) };
}

/** Headers of a user call relayed by the gateway: its invocation credential, plus the subject's user token unless anonymous. */
export async function contentHeaders(
  subject: ContentSubject,
  opts: ContentHeadersOptions = {},
): Promise<Record<string, string>> {
  const gatewayToken = (): Promise<string> => mintServiceToken({ caller: GATEWAY, audience: opts.audience ?? AUDIENCE });
  if (subject === 'anonymous') {
    return { [INVOCATION_HEADER]: `Bearer ${await gatewayToken()}` };
  }
  const { site, tid, roles, s2 } = claimsFor(subject, opts.site);
  const [userToken, invocation] = await Promise.all([
    mintUserToken({ sub: SUBJECT_USER_IDS[subject], sid: subjectSessionId(subject), site, tid, roles, s2 }),
    gatewayToken(),
  ]);
  return { authorization: `Bearer ${userToken}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
}

/** Workload identities that call strategies-content on their own behalf. */
export type ContentServiceCaller = 'platform.migration' | 'platform.operator' | 'service:programs-sites';

const SERVICE_NAMES: Readonly<Record<ContentServiceCaller, string>> = Object.freeze({
  'platform.migration': 'migration',
  'platform.operator': 'operator',
  'service:programs-sites': 'programs-sites',
});

/** `caller`'s invocation credential alone, addressed to strategies-content. */
export async function serviceHeaders(caller: ContentServiceCaller): Promise<Record<string, string>> {
  const name = SERVICE_NAMES[caller];
  const subject = ROLE_SET.find((candidate) => candidate.kind === 'service' && candidate.caller === name);
  if (subject !== undefined) return authHeadersFor(subject, { audience: AUDIENCE });
  const token = await mintServiceToken({ caller: name, audience: AUDIENCE, roles: rolesForService(name) });
  return { [INVOCATION_HEADER]: `Bearer ${token}` };
}

/** `tasks-invoker` credential of a managed Cloud Tasks delivery to `path`; throws TypeError for any other transport's path. */
export async function tasksHeaders(path: string): Promise<Record<string, string>> {
  if (transportForPath(path) !== 'cloud-tasks') throw new TypeError(`${path} is not a Cloud Tasks route`);
  return { authorization: `Bearer ${await mintTasksInvokerToken({ audience: AUDIENCE })}` };
}

/** Query string (without `?`) carrying the local push key, for `/internal/v1/events/<subscription>` injections. */
export function pushQuery(): string {
  return pushKeyQuery();
}
