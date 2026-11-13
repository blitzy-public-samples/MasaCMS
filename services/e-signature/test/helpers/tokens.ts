// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Credentials of the e-signature suites: matrix subjects, custom user tokens, the migration identity and the push key. */
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { ROLE_SET, TENANT_A, authHeadersFor, mintServiceToken, pushKeyQuery, type RoleSubject } from '@opt2/platform/testing';

/** Service name e-signature verifies invocation credentials against. */
const AUDIENCE = 'e-signature';

/** Masa `UserID` the suites sign as. */
export const SIGNER_USER_ID = 'A1B2C3D4-0000-0000-0000000000000001';

/** Masa `UserID` the suites read audit chains as. */
export const AUDITOR_USER_ID = 'A1B2C3D4-0000-0000-0000000000000002';

/** Masa `UserID` of a user unrelated to the request under test. */
export const OTHER_USER_ID = 'A1B2C3D4-0000-0000-0000000000000003';

/** Every subject of the authorisation matrix, as the platform defines it. */
export const SUBJECTS: readonly RoleSubject[] = ROLE_SET;

/** Options of {@link headersFor}; `site` defaults to tenant-a and `audience` to e-signature. */
export interface HeadersOptions {
  site?: string;
  audience?: string;
}

/** Options of {@link userHeaders}: the Masa `UserID`, its roles and the site its token is minted for (tenant-a by default). */
export interface UserHeadersOptions {
  sub: string;
  site?: string;
  roles: readonly string[];
}

/** The ROLE_SET subject named `name`, else the one service subject carrying role `name` (`platform.migration`, `platform.operator`). */
function subjectNamed(name: string): RoleSubject {
  const named = ROLE_SET.find((candidate) => candidate.name === name);
  if (named !== undefined) return named;
  const [carrier, ...others] = ROLE_SET.filter((candidate) => candidate.kind === 'service' && candidate.roles.includes(name));
  if (carrier === undefined || others.length > 0) {
    throw new TypeError(`ROLE_SET has no subject named ${name} and no single service subject with that role`);
  }
  return carrier;
}

/** `app.inject` headers presenting `subject`, or the ROLE_SET subject a name resolves to; push credentials come from {@link pushQuery}. */
export async function headersFor(
  subject: RoleSubject | string,
  { site = TENANT_A.siteId, audience = AUDIENCE }: HeadersOptions = {},
): Promise<Record<string, string>> {
  const resolved = typeof subject === 'string' ? subjectNamed(subject) : subject;
  return authHeadersFor(resolved, { site, audience });
}

/** User token of a custom subject plus the gateway invocation credential, addressed to e-signature. */
export function userHeaders({ sub, site = TENANT_A.siteId, roles }: UserHeadersOptions): Promise<Record<string, string>> {
  return authHeadersFor({ name: 'e-signature-test-user', kind: 'user', roles }, { site, audience: AUDIENCE, sub });
}

/** The migration service's invocation credential alone, with no user token. */
export async function migrationHeaders(): Promise<Record<string, string>> {
  const token = await mintServiceToken({ caller: 'migration', audience: AUDIENCE, roles: [Roles.platformMigration] });
  return { [INVOCATION_HEADER]: `Bearer ${token}` };
}

/** Query string (without `?`) carrying the test push key the `/internal/v1/events/*` routes authenticate. */
export function pushQuery(): string {
  return pushKeyQuery();
}
