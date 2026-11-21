/** Push consumers of the platform-proof stub: its own note topic into `stub.note_projection`, and the site registry topic. */
import type { ConsumerDefinition, ConsumerRegistration } from '@opt2/platform/events';
import { localTimestamp } from '@opt2/platform/outbox';
import type { Clock } from '@opt2/platform/service-kit';
import { registryEntryForTenant, tenantRegistryConsumer } from '@opt2/platform/tenancy';
import type { StubNoteCreatedV1Payload } from '../generated/events/stub.note.created.v1.js';
import type { StubRepository } from '../repo/repository.js';
import { NOTE_CREATED_TOPIC, noteCreatedSchema, siteChangedSchema } from './topics.js';

/** Projects each applied `stub.note.created.v1` of a note stored under the destination tenant into `stub.note_projection`, counting applications per note. */
export function noteProjectionConsumer(
  repository: StubRepository,
  clock: Clock,
): ConsumerDefinition<StubNoteCreatedV1Payload> {
  return {
    topic: NOTE_CREATED_TOPIC,
    kind: 'state',
    // Ordering is kept per envelope aggregate, so it must be the payload's note, stored under the destination tenant.
    async checkTenant(tx, { aggregateType, aggregateId, aggregateVersion, payload }) {
      if (aggregateType !== 'note' || aggregateId !== payload.noteId || aggregateVersion !== payload.rowVersion) {
        return 'schema-invalid';
      }
      if ((await registryEntryForTenant(tx, tx.tenantId)) === null) {
        return 'invalid-tenant';
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

/** The stub's `registerConsumers` list; subscriptions are `stub.<topic>`. */
export function stubConsumers(repository: StubRepository, clock: Clock): ConsumerRegistration[] {
  return [
    { consumer: noteProjectionConsumer(repository, clock), payloadSchema: noteCreatedSchema },
    { consumer: tenantRegistryConsumer, payloadSchema: siteChangedSchema },
  ];
}
