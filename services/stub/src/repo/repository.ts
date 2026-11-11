/** The only data-access path of schema `stub`: the platform repository plus typed note and projection helpers. */
import { createRepository, qualified, type Repository } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import type { NoteProjectionRow, NoteRow } from '../domain/note.js';
import { NOTE_PROJECTION_TABLE, NOTE_TABLE, STUB_TABLES } from './tables.js';

/** Service name the stub write positions carry, as `stub=<xid>`. */
export const STUB_OWNER = 'stub';

/** Schema the stub service owns. */
export const STUB_SCHEMA = 'stub';

/** The platform repository of schema `stub` plus typed helpers; every helper runs in the caller's open tenant transaction. */
export type StubRepository = Repository & {
  /** The note with `noteId`; null when absent or another tenant's. */
  findNote(tx: TenantTx, noteId: string): Promise<NoteRow | null>;
  /** Notes of the transaction tenant, ordered by `created` then `note_id`. */
  listNotes(tx: TenantTx): Promise<NoteRow[]>;
  /** Deletes the note with `noteId`; false when none matched. */
  deleteNote(tx: TenantTx, noteId: string): Promise<boolean>;
  /** The projection of note `noteId`; null when it is not projected. */
  findProjection(tx: TenantTx, noteId: string): Promise<NoteProjectionRow | null>;
  /** Inserts `row`, or sets its columns on the stored projection with the same `note_id`. */
  upsertProjection(tx: TenantTx, row: NoteProjectionRow): Promise<void>;
};

/** Builds the stub repository over the platform repository of `STUB_TABLES`; `schema` differs from `stub` only for throwaway test schemas. */
export function createStubRepository({ clock, schema = STUB_SCHEMA }: { clock: Clock; schema?: string }): StubRepository {
  const base = createRepository({ owner: STUB_OWNER, schema, tables: STUB_TABLES, clock });
  // The platform repository has no list read, so listNotes runs this one SELECT inside base.read, behind the unit's window phase.
  // COLLATE "C" keeps note_id in plain code-unit order whatever the database collation.
  const listNotesSql = `SELECT * FROM ${qualified(schema, NOTE_TABLE.table)} WHERE tenant_id = $1 ORDER BY created, note_id COLLATE "C"`;

  function findNote(tx: TenantTx, noteId: string): Promise<NoteRow | null> {
    return base.findByKey<NoteRow>(tx, NOTE_TABLE.table, { note_id: noteId });
  }

  function listNotes(tx: TenantTx): Promise<NoteRow[]> {
    return base.read(tx, NOTE_TABLE.unit, async () => (await tx.query<NoteRow>(listNotesSql, [tx.tenantId])).rows);
  }

  async function deleteNote(tx: TenantTx, noteId: string): Promise<boolean> {
    return (await base.delete(tx, NOTE_TABLE.table, { note_id: noteId })) !== null;
  }

  function findProjection(tx: TenantTx, noteId: string): Promise<NoteProjectionRow | null> {
    return base.findByKey<NoteProjectionRow>(tx, NOTE_PROJECTION_TABLE.table, { note_id: noteId });
  }

  async function upsertProjection(tx: TenantTx, row: NoteProjectionRow): Promise<void> {
    await base.upsert(tx, NOTE_PROJECTION_TABLE.table, row);
  }

  return Object.freeze({ ...base, findNote, listNotes, deleteNote, findProjection, upsertProjection });
}
