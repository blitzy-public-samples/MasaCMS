/** Identity's consumer of `people.person.changed.v1`, which keeps the `identity.person_contact` projection used for mail and lookup by email. */
import {
  readTopicSchema,
  subscriptionName,
  type ConsumerDefinition,
  type ConsumerRegistration,
} from '@opt2/platform/events';
import type { PersonChangedPayload } from '../generated/events/people.person.changed.v1.js';
import type { IdentityRepository } from '../repo/repository.js';
import { PERSON_CONTACT } from '../repo/tables.js';

export type { PersonChangedPayload };

/** Topic of people's full-state person event. */
export const PERSON_CHANGED_TOPIC = 'people.person.changed.v1';

/** Push subscription of identity on the person topic. */
export const PERSON_CONTACT_SUBSCRIPTION = subscriptionName('identity', PERSON_CHANGED_TOPIC);

/** Payload schema of `people.person.changed.v1`, read once from the producer's contracts. */
export const personChangedSchema = readTopicSchema(
  new URL('../../../people/contracts/events/people.person.changed.v1.json', import.meta.url),
);

/** Stores or removes the contact of each applied person state in the envelope tenant, through the repository so the changelog row commits with it. */
export function personContactConsumer(repository: IdentityRepository): ConsumerDefinition<PersonChangedPayload> {
  return {
    topic: PERSON_CHANGED_TOPIC,
    kind: 'state',
    async apply(tx, envelope) {
      const { payload } = envelope;
      if (payload.deleted) {
        await repository.delete(tx, PERSON_CONTACT.table, { user_id: payload.userId });
        return;
      }
      // Stored verbatim: lookups apply legacy's own trim and email comparison.
      await repository.upsertPersonContact(tx, {
        user_id: payload.userId,
        site_id: payload.siteId,
        email: payload.email,
        fname: payload.fname,
        lname: payload.lname,
        company: payload.company,
        subtype: payload.subType,
        aggregate_version: envelope.aggregateVersion,
      });
    },
  };
}

/**
 * The `registerConsumers` entry for the person topic.
 * The platform entry is only consumer and schema; `registerConsumers` derives the subscription, which equals PERSON_CONTACT_SUBSCRIPTION.
 */
export function personContactRegistration(repository: IdentityRepository): ConsumerRegistration {
  return { consumer: personContactConsumer(repository), payloadSchema: personChangedSchema };
}
