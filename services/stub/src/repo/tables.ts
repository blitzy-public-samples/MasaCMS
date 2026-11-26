/** Owned tables of schema `stub`, as the platform repository declares them. */
import type { CanonicalColumn, TableDefinition } from '@opt2/platform/migration-kit';

/** Units of write authority of schema `stub`, as `0001_stub.sql` and `0004_note_comments.sql` seed their gates. */
export const STUB_UNITS = ['stub.note', 'stub.note_projection', 'stub.note_comment', 'stub.note_activity'] as const;

/** A keyed stub table definition gated by the stub unit `U`. */
interface StubTableDefinition<U extends (typeof STUB_UNITS)[number]> extends TableDefinition {
  key: string[];
  unit: U;
}

// Listed because the platform repository rejects a table without tenant_id; it fills the value from the transaction tenant.
const TENANT_ID: CanonicalColumn = { name: 'tenant_id', type: 's' };

/** Definition of `stub.note` for the platform repository. */
export const NOTE_TABLE: StubTableDefinition<'stub.note'> = {
  table: 'note',
  columns: [
    TENANT_ID,
    { name: 'note_id', type: 's' },
    { name: 'title', type: 's' },
    { name: 'body', type: 's' },
    { name: 'created', type: 't' },
    { name: 'row_version', type: 'i' },
  ],
  key: ['note_id'],
  unit: 'stub.note',
};

/** Definition of `stub.note_projection` for the platform repository. */
export const NOTE_PROJECTION_TABLE: StubTableDefinition<'stub.note_projection'> = {
  table: 'note_projection',
  columns: [
    TENANT_ID,
    { name: 'note_id', type: 's' },
    { name: 'title', type: 's' },
    { name: 'body', type: 's' },
    { name: 'created', type: 't' },
    { name: 'aggregate_version', type: 'i' },
    { name: 'apply_count', type: 'i' },
    { name: 'last_event_id', type: 's' },
    { name: 'projected_at', type: 't' },
  ],
  key: ['note_id'],
  unit: 'stub.note_projection',
};

/** Definition of `stub.note_comment` for the platform repository. */
export const NOTE_COMMENT_TABLE: StubTableDefinition<'stub.note_comment'> = {
  table: 'note_comment',
  columns: [
    TENANT_ID,
    { name: 'comment_id', type: 's' },
    { name: 'note_id', type: 's' },
    { name: 'author_site_id', type: 's' },
    { name: 'body', type: 's' },
    { name: 'created', type: 't' },
  ],
  key: ['comment_id'],
  unit: 'stub.note_comment',
};

/** Definition of `stub.note_activity` for the platform repository. */
export const NOTE_ACTIVITY_TABLE: StubTableDefinition<'stub.note_activity'> = {
  table: 'note_activity',
  columns: [
    TENANT_ID,
    { name: 'event_id', type: 's' },
    { name: 'note_id', type: 's' },
    { name: 'comment_id', type: 's' },
    { name: 'aggregate_version', type: 'i' },
    { name: 'applied_at', type: 't' },
  ],
  key: ['event_id'],
  unit: 'stub.note_activity',
};

/** Every stub table, in `STUB_UNITS` order; the `tables` of the stub repository. */
export const STUB_TABLES: readonly TableDefinition[] = [NOTE_TABLE, NOTE_PROJECTION_TABLE, NOTE_COMMENT_TABLE, NOTE_ACTIVITY_TABLE];
