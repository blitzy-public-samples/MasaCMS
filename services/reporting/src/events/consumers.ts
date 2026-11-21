// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Push consumers of reporting: the programs-sites site topic, applied by the platform registry consumer. */
import { readTopicSchema, subscriptionName, type ConsumerRegistration } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer } from '@opt2/platform/tenancy';

/** Payload schema of `programs-sites.site.changed.v1`, read once from the producer's contracts. */
export const siteChangedSchema = readTopicSchema(
  new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
);

/** Push subscription of reporting on `programs-sites.site.changed.v1`. */
export const SITE_CHANGED_SUBSCRIPTION = subscriptionName('reporting', SITE_CHANGED_TOPIC);

/** Consumers registered by `registerConsumers`; the registry consumer fills `reporting.tenant_registry`. */
export const consumers: readonly ConsumerRegistration[] = [
  { consumer: tenantRegistryConsumer, payloadSchema: siteChangedSchema },
];
