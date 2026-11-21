// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Push consumers of timesheets: the programs-sites site registry and people's person archives. */
import { readTopicSchema, subscriptionName, type ConsumerRegistration } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer } from '@opt2/platform/tenancy';
import { createTimesheetsRepository, type TimesheetsRepository } from '../repo/repository.js';
import { createPersonArchivedConsumer, PERSON_ARCHIVED_TOPIC } from './person-archived.js';

/** Payload schema of `people.person.archived.v1`, read once from the producer's contracts. */
export const personArchivedSchema = readTopicSchema(
  new URL('../../../people/contracts/events/people.person.archived.v1.json', import.meta.url),
);

/** Payload schema of `programs-sites.site.changed.v1`, read once from the producer's contracts. */
export const siteChangedSchema = readTopicSchema(
  new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
);

/** Push subscription of timesheets on `people.person.archived.v1`. */
export const PERSON_ARCHIVED_SUBSCRIPTION = subscriptionName('timesheets', PERSON_ARCHIVED_TOPIC);

/** Push subscription of timesheets on `programs-sites.site.changed.v1`. */
export const SITE_CHANGED_SUBSCRIPTION = subscriptionName('timesheets', SITE_CHANGED_TOPIC);

/** What the timesheets consumers write through. */
export interface ConsumerDeps {
  repository: TimesheetsRepository;
}

/** The `registerConsumers` entries of timesheets: the site registry, then person archives. */
export function createConsumers(deps: ConsumerDeps): ConsumerRegistration[] {
  return [
    { consumer: tenantRegistryConsumer, payloadSchema: siteChangedSchema },
    { consumer: createPersonArchivedConsumer(deps), payloadSchema: personArchivedSchema },
  ];
}

/** The consumers over a default timesheets repository, for tests and contract checks. */
export const consumers: readonly ConsumerRegistration[] = createConsumers({ repository: createTimesheetsRepository() });
