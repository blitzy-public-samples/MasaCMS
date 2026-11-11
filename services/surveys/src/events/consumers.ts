// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Push consumers of surveys: the programs-sites site topic, applied by the platform registry consumer. */
import { readTopicSchema, subscriptionName, type ConsumerRegistration } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer } from '@opt2/platform/tenancy';

/** Push subscription of surveys on `programs-sites.site.changed.v1`. */
export const SITE_CHANGED_SUBSCRIPTION = subscriptionName('surveys', SITE_CHANGED_TOPIC);

/** Payload schema of `programs-sites.site.changed.v1`, read once from the producer's contracts. */
export const siteChangedSchema = readTopicSchema(
  new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
);

/** Registration that fills `surveys.tenant_registry` from `programs-sites.site.changed.v1`. */
export const siteRegistryConsumerRegistration: ConsumerRegistration = {
  consumer: tenantRegistryConsumer,
  payloadSchema: siteChangedSchema,
};
