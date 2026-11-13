/** `processRequest`'s CORS Origin echo over a request's headers and identity's site registry [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:382-394]. */
import { accessControlOriginDomains, corsHeaders } from '@opt2/platform/legacy-compat';
import { registryEntries, type TenantDb } from '@opt2/platform/tenancy';

/** Request headers by name; a repeated field is a list. */
export type RequestHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/** A registry site as the allow-list reads it; `domains` is absent where the read skipped them. */
export type OriginSite = { readonly domains?: readonly string[] };

/** Header `name` matched ignoring case; a repeated field reads as one `, `-joined value, as Node and the servlet container join it. */
function headerText(headers: RequestHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || key.toLowerCase() !== wanted) continue;
    return typeof value === 'string' ? value : value.join(', ');
  }
  return undefined;
}

/** The client's host as the gateway forwards it, `X-Forwarded-Host` before the hop's own `Host`. */
export function clientHost(headers: RequestHeaders): { name: string; port: string } {
  const forwarded = headerText(headers, 'x-forwarded-host') || headerText(headers, 'host') || '';
  const host = forwarded.split(',')[0]?.trim() ?? '';
  const match = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(host);
  return { name: match?.[1] ?? host, port: match?.[2] ?? '' };
}

/** configBean.getCurrentAdminDomain() (configBean.cfc:517-525): the host's name on an admin domain, else the host. */
export function currentAdminDomain(headers: RequestHeaders, adminDomain: string): string {
  const { name, port } = clientHost(headers);
  const onAdminDomain = adminDomain.split(',').some((domain) => domain.toLowerCase() === name.toLowerCase());
  return onAdminDomain || port === '' ? name : `${name}:${port}`;
}

/** The request's Origin, echoed with credentials when its domain is on the allow-list of `sites`; empty otherwise. */
export function originEcho(headers: RequestHeaders, sites: readonly OriginSite[], adminDomain: string): Record<string, string> {
  const allowList = sites.map((entry) => ({ domain: entry.domains?.join(',') ?? '' }));
  const cfg = { adminDomain, currentAdminDomain: currentAdminDomain(headers, adminDomain) };
  return corsHeaders(headerText(headers, 'origin'), accessControlOriginDomains(allowList, cfg));
}

/** The request's Origin echo over the registry, which is read only for a request carrying an Origin. */
export async function legacyOriginEcho(db: TenantDb, headers: RequestHeaders, adminDomain: string): Promise<Record<string, string>> {
  if (headerText(headers, 'origin') === undefined) return {};
  return originEcho(headers, await registryEntries(db), adminDomain);
}
