// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { ServiceClient } from '@opt2/platform/service-kit';
import {
  registryEntryForTenant,
  tenantForRegisteredSite,
  withMetadata,
  type MetadataTx,
  type TenantDb,
} from '@opt2/platform/tenancy';

/** Site settingsManager.cfc getSite returns for an empty or unregistered site id. */
export const DEFAULT_SITE_ID = 'default';

/** Domain of Masa's bootstrap default site, used when the registry holds no domain. */
export const FALLBACK_DOMAIN = 'localhost';

// Start-anchored only: REFindNoCase(...) neq 0 accepts any value with a matching prefix.
const EMAIL_FORMAT = /^[^@%*<>' ]+@[^@%*<>' ]{1,255}\.[^@%*<>' ]{2,5}/i;

// The expression of ColdFusion 2023's IsValid('email') validator (CFTypeValidatorFactory$CFEmailValidator).
const VALID_EMAIL = /^[\w'+~-]+(?:\.[\w'+~-]+)*@(?:[\w-]+\.)+[a-z]{2,7}$/i;

// CFML trim() is Java String.trim(): it strips every leading and trailing code unit up to U+0020.
function cfTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end);
}

/** Port of mailer.cfc isValidEmailFormat: a prefix match on the trimmed value. */
export function isValidEmailFormat(email: string): boolean {
  return EMAIL_FORMAT.test(cfTrim(email));
}

/** Port of mailer.cfc filterEmails: the comma-separated items passing isValidEmailFormat, kept untrimmed. */
export function filterEmails(list: string): string {
  return list
    .split(',')
    .filter((item) => isValidEmailFormat(item))
    .join(',');
}

/** CFML IsValid('email'), as mailer.cfc getFromEmail applies it: one whole address and nothing around it. */
export function isValidEmail(email: string): boolean {
  return VALID_EMAIL.test(email);
}

/** Resolves the From address mailer.cfc getFromEmail gives a site. */
export interface SenderAddressSource {
  /** `no-reply@` plus the site's first domain; an empty or unregistered site id reads the default site. */
  fromEmail(siteId: string): Promise<string>;
}

/** Construction options of {@link createSenderAddressSource}. */
export interface SenderAddressOptions {
  /** Communications database; only its tenant_registry is read. */
  db: TenantDb;
  /** Not called: programs-sites' contract declares no operation communications may call for a site's mail settings. */
  client?: ServiceClient;
}

// Mirrors getSite's fallback: the requested site, then `default`; an entry without a domain falls through.
async function senderDomain(tx: MetadataTx, siteId: string): Promise<string> {
  const sites = siteId === '' || siteId.toLowerCase() === DEFAULT_SITE_ID ? [DEFAULT_SITE_ID] : [siteId, DEFAULT_SITE_ID];
  for (const site of sites) {
    const tenantId = await tenantForRegisteredSite(tx, site);
    const entry = tenantId === null ? null : await registryEntryForTenant(tx, tenantId);
    const domain = entry?.domains[0];
    if (domain) return domain;
  }
  return FALLBACK_DOMAIN;
}

/** Sender address source over communications' own tenant_registry, read afresh on every call. */
export function createSenderAddressSource(options: SenderAddressOptions): SenderAddressSource {
  const { db } = options;
  return {
    fromEmail: (siteId) => withMetadata(db, async (tx) => `no-reply@${await senderDomain(tx, siteId)}`),
  };
}
