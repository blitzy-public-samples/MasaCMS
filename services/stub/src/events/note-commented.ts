/** Producer of `stub.note.commented.v1`, the process event of an accepted note comment. */
import type { EventEnvelope } from '@opt2/platform/events';
import { writeOutbox } from '@opt2/platform/outbox';
import type { TenantTx } from '@opt2/platform/tenancy';
import { noteCommentedPayload, type NoteComment, type NoteCommentedPayload } from '../domain/comment.js';
import { NOTE_COMMENTED_TOPIC } from './topics.js';

/** Writes the stub.note.commented.v1 outbox row of `comment` at the note's `aggregateVersion` in the caller's transaction; the envelope tenant is the transaction tenant. */
export function writeNoteCommented(
  tx: TenantTx,
  comment: NoteComment,
  aggregateVersion: number,
): Promise<EventEnvelope<NoteCommentedPayload> | null> {
  return writeOutbox(tx, {
    topic: NOTE_COMMENTED_TOPIC,
    kind: 'process',
    aggregateType: 'note',
    aggregateId: comment.noteId,
    aggregateVersion,
    payload: noteCommentedPayload(comment),
  });
}
