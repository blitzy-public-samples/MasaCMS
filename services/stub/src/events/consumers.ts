/** Push consumers of the platform-proof stub: its own note and comment topics into `stub.note_projection` and `stub.note_activity`, and the site registry topic. */
import type { ConsumerDefinition, ConsumerRegistration } from '@opt2/platform/events';
import { localTimestamp } from '@opt2/platform/outbox';
import type { Clock } from '@opt2/platform/service-kit';
import { registryEntryForTenant, tenantRegistryConsumer } from '@opt2/platform/tenancy';
import type { NoteCommentedPayload } from '../domain/comment.js';
import type { StubNoteCreatedV1Payload } from '../generated/events/stub.note.created.v1.js';
import type { StubRepository } from '../repo/repository.js';
import { NOTE_COMMENTED_TOPIC, NOTE_CREATED_TOPIC, noteCommentedSchema, noteCreatedSchema, siteChangedSchema } from './topics.js';

/**
 * Projects each applied `stub.note.created.v1` into `stub.note_projection`, counting applications per note: in the note's own
 * tenant, and through the `userPool` fan-out in every registered site whose public or private user pool that tenant is.
 */
export function noteProjectionConsumer(
  repository: StubRepository,
  clock: Clock,
): ConsumerDefinition<StubNoteCreatedV1Payload> {
  return {
    topic: NOTE_CREATED_TOPIC,
    kind: 'state',
    fanout: 'userPool',
    // Ordering is kept per envelope aggregate, so it must be the payload's note, stored under the envelope tenant.
    async checkTenant(tx, { tenantId, aggregateType, aggregateId, aggregateVersion, payload }) {
      if (aggregateType !== 'note' || aggregateId !== payload.noteId || aggregateVersion !== payload.rowVersion) {
        return 'schema-invalid';
      }
      const entry = await registryEntryForTenant(tx, tx.tenantId);
      if (entry === null) {
        return 'invalid-tenant';
      }
      // A fan-out destination stores no copy of the note; its registry entry must pool its users in the note's tenant.
      const origin = tenantId.toLowerCase();
      if (tx.tenantId !== origin) {
        return entry.publicUserPoolTenant === origin || entry.privateUserPoolTenant === origin ? true : 'tenant-mismatch';
      }
      return (await repository.findNote(tx, payload.noteId)) === null ? 'tenant-mismatch' : true;
    },
    async apply(tx, envelope) {
      const { payload } = envelope;
      const previous = await repository.findProjection(tx, payload.noteId);
      await repository.upsertProjection(tx, {
        note_id: payload.noteId,
        title: payload.title,
        body: payload.body,
        created: payload.created,
        aggregate_version: envelope.aggregateVersion,
        apply_count: (previous?.apply_count ?? 0) + 1,
        last_event_id: envelope.eventId,
        projected_at: localTimestamp(clock.now()),
      });
    },
  };
}

/** Records each applied `stub.note.commented.v1` of a note stored under the destination tenant as one `stub.note_activity` row. */
export function noteActivityConsumer(repository: StubRepository, clock: Clock): ConsumerDefinition<NoteCommentedPayload> {
  return {
    topic: NOTE_COMMENTED_TOPIC,
    kind: 'process',
    async checkTenant(tx, { aggregateType, aggregateId, payload }) {
      if (aggregateType !== 'note' || aggregateId !== payload.noteId) {
        return 'schema-invalid';
      }
      if ((await registryEntryForTenant(tx, tx.tenantId)) === null) {
        return 'invalid-tenant';
      }
      return (await repository.findNote(tx, payload.noteId)) === null ? 'tenant-mismatch' : true;
    },
    async apply(tx, envelope) {
      await repository.insertActivity(tx, {
        event_id: envelope.eventId,
        note_id: envelope.payload.noteId,
        comment_id: envelope.payload.commentId,
        aggregate_version: envelope.aggregateVersion,
        applied_at: localTimestamp(clock.now()),
      });
    },
  };
}

/** The stub's `registerConsumers` list; subscriptions are `stub.<topic>`. */
export function stubConsumers(repository: StubRepository, clock: Clock): ConsumerRegistration[] {
  return [
    { consumer: noteProjectionConsumer(repository, clock), payloadSchema: noteCreatedSchema },
    { consumer: tenantRegistryConsumer, payloadSchema: siteChangedSchema },
    { consumer: noteActivityConsumer(repository, clock), payloadSchema: noteCommentedSchema },
  ];
}
