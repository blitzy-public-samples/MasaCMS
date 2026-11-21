/** Push consumers of programs-sites: its own site registry topic, applied by the platform registry consumer. */
import { compileTopicSchema, readTopicSchema, subscriptionName, type ConsumerRegistration } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer } from '@opt2/platform/tenancy';

/** Payload schema of `programs-sites.site.changed.v1`, read once from the service contracts. */
export const siteChangedSchema = readTopicSchema(
  new URL('../../contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
);

/** Compiled payload validator of `programs-sites.site.changed.v1`, shared with the outbox and publisher. */
export const siteChangedValidator = compileTopicSchema(siteChangedSchema);

/** Push subscription of programs-sites on its own site topic. */
export const SITE_CHANGED_SUBSCRIPTION = subscriptionName('programs-sites', SITE_CHANGED_TOPIC);

/** Registration that fills `programs_sites.tenant_registry` from `programs-sites.site.changed.v1`. */
export const siteRegistryConsumerRegistration: ConsumerRegistration = {
  consumer: tenantRegistryConsumer,
  payloadSchema: siteChangedSchema,
};
