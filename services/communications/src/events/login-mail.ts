// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Communications' consumer of `identity.login-mail.requested.v1`, the forgot-password and send-login mail identity requests. */
import { readTopicSchema, type ConsumerDefinition } from '@opt2/platform/events';
import { registryEntryForTenant, tenantForRegisteredSite, type TenantRegistryEntry, type TenantTx } from '@opt2/platform/tenancy';
import type { MailDeps } from '../domain/delivery.js';
import { applyLoginMail } from '../domain/login-mail.js';
import { DEFAULT_SITE_ID } from '../domain/sender-address.js';
import type { IdentityLoginMailRequestedV1Payload as LoginMailRequestedPayload } from '../generated/events/identity.login-mail.requested.v1.js';

/** Payload of `identity.login-mail.requested.v1`, generated from identity's contract. */
export type { LoginMailRequestedPayload };

/** Topic of identity's login-mail request. */
export const LOGIN_MAIL_TOPIC = 'identity.login-mail.requested.v1' as const;

/** Payload schema of `identity.login-mail.requested.v1`, read once from the producer's contracts. */
export const loginMailSchema = readTopicSchema(
  new URL('../../../identity/contracts/events/identity.login-mail.requested.v1.json', import.meta.url),
);

/** The registry entry of the request site, or of the default site for an unregistered one, as identity resolves it. */
async function requestSiteEntry(tx: TenantTx, siteId: string): Promise<TenantRegistryEntry | null> {
  const tenant = (await tenantForRegisteredSite(tx, siteId)) ?? (await tenantForRegisteredSite(tx, DEFAULT_SITE_ID));
  return tenant === null ? null : registryEntryForTenant(tx, tenant);
}

/** Consumer that stores each requested login mail in the envelope tenant, for forgot-password a user pool of the request site, and sends it after commit. */
export function loginMailConsumer(deps: MailDeps): ConsumerDefinition<LoginMailRequestedPayload> {
  return {
    topic: LOGIN_MAIL_TOPIC,
    kind: 'process',
    async checkTenant(tx, { aggregateType, aggregateId, payload }) {
      if (aggregateType !== 'user' || aggregateId !== payload.userId) {
        return false;
      }
      if ((await registryEntryForTenant(tx, tx.tenantId)) === null) {
        return 'invalid-tenant';
      }
      // Send-login's site only picks mail settings; forgot-password without a site searches every registered tenant.
      if (payload.kind !== 'forgot-password' || payload.siteId === '') {
        return true;
      }
      const entry = await requestSiteEntry(tx, payload.siteId);
      return entry !== null && (entry.publicUserPoolTenant === tx.tenantId || entry.privateUserPoolTenant === tx.tenantId);
    },
    apply: applyLoginMail(deps),
  };
}
