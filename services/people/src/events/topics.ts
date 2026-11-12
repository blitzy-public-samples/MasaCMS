/** Topic names, payload schemas and payload validators of the topics people produces and consumes. */
import { compileTopicSchema, readTopicSchema, type TopicValidator } from '@opt2/platform/events';

export { SITE_CHANGED_TOPIC } from '@opt2/platform/tenancy';
export type { PersonArchivedPayload } from '../generated/events/people.person.archived.v1.js';
export type { PersonChangedPayload } from '../generated/events/people.person.changed.v1.js';
export type { IdentityGroupChangedV1 as GroupChangedPayload } from '../generated/events/identity.group.changed.v1.js';

/** Full-state topic of one person's people-owned columns. */
export const PERSON_CHANGED_TOPIC = 'people.person.changed.v1' as const;
/** Process topic of one person archive. */
export const PERSON_ARCHIVED_TOPIC = 'people.person.archived.v1' as const;
/** Identity's full-state group topic, consumed into the group-name projection. */
export const GROUP_CHANGED_TOPIC = 'identity.group.changed.v1' as const;

/** Every topic people produces. */
export const PEOPLE_TOPICS = [PERSON_CHANGED_TOPIC, PERSON_ARCHIVED_TOPIC] as const;

/** One topic people produces. */
export type PeopleTopic = (typeof PEOPLE_TOPICS)[number];

/** Payload schema of `people.person.changed.v1`, read once from the service contracts. */
export const personChangedSchema = readTopicSchema(
  new URL('../../contracts/events/people.person.changed.v1.json', import.meta.url),
);

/** Payload schema of `people.person.archived.v1`, read once from the service contracts. */
export const personArchivedSchema = readTopicSchema(
  new URL('../../contracts/events/people.person.archived.v1.json', import.meta.url),
);

/** Payload schema of `identity.group.changed.v1`, read once from the producer's contracts. */
export const groupChangedSchema = readTopicSchema(
  new URL('../../../identity/contracts/events/identity.group.changed.v1.json', import.meta.url),
);

/** Payload schema of `programs-sites.site.changed.v1`, read once from the producer's contracts. */
export const siteChangedSchema = readTopicSchema(
  new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
);

/** Compiled payload schemas of the produced topics, by topic, for the outbox runtime's write-time check. */
export const peoplePayloadValidators: Record<string, TopicValidator> = Object.freeze({
  [PERSON_CHANGED_TOPIC]: compileTopicSchema(personChangedSchema),
  [PERSON_ARCHIVED_TOPIC]: compileTopicSchema(personArchivedSchema),
});
