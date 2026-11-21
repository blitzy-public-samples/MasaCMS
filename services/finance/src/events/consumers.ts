// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Push consumers of finance: the programs-sites site topic, applied by the platform registry consumer. */
import { readTopicSchema, subscriptionName, type ConsumerRegistration } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer } from '@opt2/platform/tenancy';

/** Payload schema of `programs-sites.site.changed.v1`, read once from the producer's contracts. */
export const siteChangedSchema = readTopicSchema(
  new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
);

/** Push subscription of finance on `programs-sites.site.changed.v1`. */
export const SITE_CHANGED_SUBSCRIPTION = subscriptionName('finance', SITE_CHANGED_TOPIC);

/** Consumers registered by `registerConsumers`; the registry consumer fills `finance.tenant_registry`. */
export const consumers: readonly ConsumerRegistration[] = [
  { consumer: tenantRegistryConsumer, payloadSchema: siteChangedSchema },
];
