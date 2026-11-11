/** Topic, subscription and payload-schema constants of the platform-proof stub. */
import {
  compileTopicSchema,
  dlqTopicName,
  readTopicSchema,
  subscriptionName,
  topicName,
  type TopicValidator,
} from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC } from '@opt2/platform/tenancy';

export { SITE_CHANGED_TOPIC };

/** Topic the stub produces and consumes itself. */
export const NOTE_CREATED_TOPIC = topicName('stub', 'note', 'created', 1);

/** Push subscription of the stub on its own note topic. */
export const NOTE_CREATED_SUBSCRIPTION = subscriptionName('stub', NOTE_CREATED_TOPIC);

/** Dead-letter topic of the note subscription. */
export const NOTE_CREATED_DLQ = dlqTopicName(NOTE_CREATED_SUBSCRIPTION);

/** Push subscription that fills `stub.tenant_registry` from the site registry topic. */
export const SITE_CHANGED_SUBSCRIPTION = subscriptionName('stub', SITE_CHANGED_TOPIC);

/** Location of the stub's own note payload schema. */
export const NOTE_CREATED_SCHEMA_URL = new URL('../../contracts/events/stub.note.created.v1.json', import.meta.url);

/** Location of the producer-owned site payload schema in programs-sites. */
export const SITE_CHANGED_SCHEMA_URL = new URL(
  '../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json',
  import.meta.url,
);

/** Payload schema of `stub.note.created.v1`, read once at module load. */
export const noteCreatedSchema = readTopicSchema(NOTE_CREATED_SCHEMA_URL);

/** Payload schema of `programs-sites.site.changed.v1`, read once at module load. */
export const siteChangedSchema = readTopicSchema(SITE_CHANGED_SCHEMA_URL);

/** Compiled note payload validator shared by the outbox and the publisher. */
export const noteCreatedValidator: TopicValidator = compileTopicSchema(noteCreatedSchema);
