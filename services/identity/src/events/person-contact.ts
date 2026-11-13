/** Identity's consumer of `people.person.changed.v1`, which keeps the `identity.person_contact` projection used for mail, lookup by email and group member listings. */
import {
  readTopicSchema,
  subscriptionName,
  type ConsumerDefinition,
  type ConsumerRegistration,
} from '@opt2/platform/events';
import { registryEntryForTenant, tenantForRegisteredSite } from '@opt2/platform/tenancy';
import type { PersonChangedPayload } from '../generated/events/people.person.changed.v1.js';
import { charKey, type IdentityRepository } from '../repo/repository.js';
import { PERSON_CONTACT } from '../repo/tables.js';

export type { PersonChangedPayload };

/** Topic of people's full-state person event. */
export const PERSON_CHANGED_TOPIC = 'people.person.changed.v1';

/** Aggregate type of people's person events, whose aggregate id is the person's user id. */
export const PERSON_AGGREGATE_TYPE = 'person';

/** Push subscription of identity on the person topic. */
export const PERSON_CONTACT_SUBSCRIPTION = subscriptionName('identity', PERSON_CHANGED_TOPIC);

/** Payload schema of `people.person.changed.v1`, read once from the producer's contracts. */
export const personChangedSchema = readTopicSchema(
  new URL('../../../people/contracts/events/people.person.changed.v1.json', import.meta.url),
);

/** A payload `yyyy-mm-dd HH:nn:ss.lll` wall-clock text as the Date pg stores back as that same `timestamp(3)` in the process zone. */
function localTimestampDate(text: string | null): Date | null {
  // ISO date-time text without an offset parses as local time.
  return text === null ? null : new Date(text.replace(' ', 'T'));
}

/**
 * Stores or removes the contact of each applied person state in the envelope tenant, through the repository so the changelog row commits with it.
 * A state whose site the registry does not give that tenant, or whose user is not the envelope's person aggregate, is dead-lettered unapplied.
 */
export function personContactConsumer(repository: IdentityRepository): ConsumerDefinition<PersonChangedPayload> {
  return {
    topic: PERSON_CHANGED_TOPIC,
    kind: 'state',
    async checkTenant(tx, envelope) {
      const { payload } = envelope;
      // The site in SQL Server equality form: trailing spaces are insignificant, leading ones are not.
      if ((await tenantForRegisteredSite(tx, charKey(payload.siteId))) !== tx.tenantId) {
        // An unregistered destination keeps the platform default's classification.
        return (await registryEntryForTenant(tx, tx.tenantId)) === null ? 'invalid-tenant' : false;
      }
      return envelope.aggregateType === PERSON_AGGREGATE_TYPE && charKey(payload.userId) === charKey(envelope.aggregateId);
    },
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
        groupname: payload.groupName,
        jobtitle: payload.jobTitle,
        mobilephone: payload.mobilePhone,
        website: payload.website,
        ext: payload.ext,
        contactform: payload.contactForm,
        subscribe: payload.subscribe,
        notes: payload.notes,
        description: payload.description,
        interests: payload.interests,
        keepprivate: payload.keepPrivate,
        photofileid: payload.photoFileId,
        imname: payload.imName,
        imservice: payload.imService,
        tags: payload.tags,
        created: localTimestampDate(payload.created),
        lastupdate: localTimestampDate(payload.lastUpdate),
        lastupdateby: payload.lastUpdateBy,
        lastupdatebyid: payload.lastUpdateById,
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
