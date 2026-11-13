// Requests whose token does or does not serve the site `getSite(rc.siteid)` reads, for `Admin;<pool>;0` or S2 checks,
// and the same for `getSite(session.siteid)`, which the layout reads.
import { tenantIdForSite } from '@opt2/platform/tenancy';
import type { AdminRequest } from '@/lib/request-context';
import { adminS2Request, siteAdminRequest, type AdminRequestPartial } from './admin-request';
import { TENANT_UMBRELLA } from './tokens';

/** Claims of a site-admin token minted for the umbrella pool site. */
const UMBRELLA_TOKEN = { site: TENANT_UMBRELLA.siteId, tid: TENANT_UMBRELLA.tenantId };
/** Claims of a site-admin token minted for `default`. */
const DEFAULT_TOKEN = { site: 'default', tid: tenantIdForSite('default') };

/** A request built over `partial`, the `rc.siteid` its links carry, and whether legacy's membership check passes. */
export interface RequestedSiteCase {
  readonly who: string;
  readonly request: (partial: AdminRequestPartial) => AdminRequest;
  readonly siteid: string;
  readonly administers: boolean;
}

/** Each case's `partial` with `rc` laid over the caller's. */
const withRc = (partial: AdminRequestPartial, rc: Readonly<Record<string, string>>): AdminRequestPartial => ({
  ...partial,
  rc: { ...partial.rc, ...rc },
});

/** S2 and pool-admin requests on sites their token serves or does not serve. */
export const REQUESTED_SITE_CASES: readonly RequestedSiteCase[] = Object.freeze([
  {
    who: 'the tenant-a site admin on Tenant-A, the token site in another case',
    request: (partial) => siteAdminRequest('tenant-a', withRc(partial, { siteid: 'Tenant-A' })),
    siteid: 'Tenant-A',
    administers: true,
  },
  {
    who: 'the S2 admin on tenant-b, a site its token does not serve',
    request: (partial) => adminS2Request(withRc(partial, { siteid: 'tenant-b' })),
    siteid: 'tenant-b',
    administers: true,
  },
  {
    who: 'the umbrella pool admin on umbrella',
    request: (partial) => siteAdminRequest('umbrella', { ...partial, user: { ...partial.user, ...UMBRELLA_TOKEN } }),
    siteid: 'umbrella',
    administers: true,
  },
  {
    who: 'the default site admin on an empty siteid, which getSite reads as default',
    request: (partial) =>
      siteAdminRequest('default', { ...withRc(partial, { siteid: '' }), user: { ...partial.user, ...DEFAULT_TOKEN } }),
    siteid: '',
    administers: true,
  },
  {
    who: 'the tenant-a site admin on default',
    request: (partial) => siteAdminRequest('tenant-a', withRc(partial, { siteid: 'default' })),
    siteid: 'default',
    administers: false,
  },
  {
    who: 'the tenant-a site admin on tenant-b',
    request: (partial) => siteAdminRequest('tenant-a', withRc(partial, { siteid: 'tenant-b' })),
    siteid: 'tenant-b',
    administers: false,
  },
  {
    who: 'the umbrella pool admin on tenant-a, whose public user pool umbrella holds',
    request: (partial) =>
      siteAdminRequest('umbrella', {
        ...withRc(partial, { siteid: 'tenant-a' }),
        user: { ...partial.user, ...UMBRELLA_TOKEN },
      }),
    siteid: 'tenant-a',
    administers: false,
  },
]);


/** Each case's `partial` in a session on `siteid`. */
const inSession = (partial: AdminRequestPartial, siteid: string): AdminRequestPartial => ({
  ...partial,
  session: { ...partial.session, siteid },
});

/** S2 and pool-admin requests in sessions whose `session.siteid` their token does or does not serve. */
export const SESSION_SITE_CASES: readonly RequestedSiteCase[] = Object.freeze([
  {
    who: 'the tenant-a site admin in a tenant-a session',
    request: (partial) => siteAdminRequest('tenant-a', partial),
    siteid: 'tenant-a',
    administers: true,
  },
  {
    who: 'the S2 admin in a tenant-b session, a site its token does not serve',
    request: (partial) => adminS2Request(inSession(partial, 'tenant-b')),
    siteid: 'tenant-b',
    administers: true,
  },
  {
    who: 'the umbrella pool admin in an umbrella session',
    request: (partial) => siteAdminRequest('umbrella', { ...partial, user: { ...partial.user, ...UMBRELLA_TOKEN } }),
    siteid: 'umbrella',
    administers: true,
  },
  {
    who: 'the tenant-a site admin in a default session',
    request: (partial) => siteAdminRequest('default', partial),
    siteid: 'default',
    administers: false,
  },
  {
    who: 'the tenant-a site admin in a tenant-b session',
    request: (partial) => siteAdminRequest('tenant-b', partial),
    siteid: 'tenant-b',
    administers: false,
  },
  {
    who: 'the umbrella pool admin in a tenant-a session, whose public user pool umbrella holds',
    request: (partial) => siteAdminRequest('tenant-a', { ...partial, user: { ...partial.user, ...UMBRELLA_TOKEN } }),
    siteid: 'tenant-a',
    administers: false,
  },
]);
