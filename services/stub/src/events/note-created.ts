/** Producer of `stub.note.created.v1`, the full-state event of a newly created stub note. */
import type { EventEnvelope } from '@opt2/platform/events';
import { writeOutbox } from '@opt2/platform/outbox';
import type { TenantTx } from '@opt2/platform/tenancy';
import { noteCreatedPayload, type Note } from '../domain/note.js';
import { NOTE_CREATED_TOPIC } from './topics.js';

/** Writes the stub.note.created.v1 outbox row in the caller's transaction; the envelope tenant is the transaction tenant. */
export function writeNoteCreated(
  tx: TenantTx,
  note: Note,
): Promise<EventEnvelope<ReturnType<typeof noteCreatedPayload>> | null> {
  return writeOutbox(tx, {
    topic: NOTE_CREATED_TOPIC,
    kind: 'state',
    aggregateType: 'note',
    aggregateId: note.noteId,
    aggregateVersion: note.rowVersion,
    payload: noteCreatedPayload(note),
  });
}
