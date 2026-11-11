/** Stub repository helpers against a throwaway `stub` schema: audited writes, write positions, gates, ordering, keyset pages and tenant isolation. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GateClosedError,
  UnitNotAuthoritativeError,
  UnitReadBlockedError,
  ensureUnitGates,
  withGatedTenant,
  type GatePhase,
  type GateState,
} from '@opt2/platform/migration-kit';
import { newRequestContext, runWithRequestContext } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { NOTE_PAGE_MAX, type NoteCursor, type NoteProjectionRow, type NoteRow } from '../../src/domain/note.js';
import { STUB_OWNER, STUB_SCHEMA, createStubRepository, type NotePageRequest, type StubRepository } from '../../src/repo/repository.js';
import { NOTE_PROJECTION_TABLE, NOTE_TABLE, STUB_UNITS } from '../../src/repo/tables.js';

const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const BUDGET_MS = 300;
const AT = '2026-06-30 12:00:00.000';
const JUST_AFTER = '2026-06-30 12:00:00.001';
const LATER = '2026-06-30 12:00:01.000';
const EVENT_1 = '11111111-1111-4111-8111-111111111111';
const EVENT_2 = '22222222-2222-4222-8222-222222222222';
const LETTER_ID = 'A0000000-0000-0000-0000000000000000';
const FIRST_PAGE: NotePageRequest = { after: null, limit: NOTE_PAGE_MAX };

/** A CF-format note id whose first group is `n`, zero-padded. */
function noteId(n: number): string {
  return `${String(n).padStart(8, '0')}-0000-0000-0000000000000000`;
}

function noteRow(id: string, created = AT): NoteRow {
  return { note_id: id, title: `Title ${id}`, body: 'b', created, row_version: 1 };
}

function projectionRow(id: string, overrides: Partial<NoteProjectionRow> = {}): NoteProjectionRow {
  return {
    note_id: id,
    title: 'T1',
    body: 'B',
    created: AT,
    aggregate_version: 1,
    apply_count: 1,
    last_event_id: EVENT_1,
    projected_at: AT,
    ...overrides,
  };
}

describe('stub repository identity', () => {
  it('extends the frozen platform repository of the stub tables', () => {
    const repository = createStubRepository({ clock: CLOCK });

    expect([STUB_OWNER, STUB_SCHEMA]).toEqual(['stub', 'stub']);
    expect(Object.isFrozen(repository)).toBe(true);
    expect(repository).toMatchObject({ owner: STUB_OWNER, schema: STUB_SCHEMA });
    expect(repository.units()).toEqual([...STUB_UNITS]);
    expect(repository.definition(NOTE_TABLE.table)).toEqual(NOTE_TABLE);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('stub repository against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repository: StubRepository;
  let run = 0;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'stub',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    repository = createStubRepository({ clock: CLOCK, schema: handle.schema });
    await ensureUnitGates(handle.app, STUB_UNITS);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    run += 1;
    tenantA = tenantIdForSite(`stub-repository-${run}-a`);
    tenantB = tenantIdForSite(`stub-repository-${run}-b`);
  });

  async function setGates(state: GateState, phase: GatePhase = 'quiet'): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = $1, holder_id = $2, phase = $3`, [
        state,
        state === 'closed' ? 'test-holder' : null,
        phase,
      ]),
    );
  }

  function inTenant<T>(tenant: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  function gated<T>(tenant: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withGatedTenant(handle.app, tenant, fn, { budgetMs: BUDGET_MS });
  }

  async function changelog(tenant: string): Promise<{ table: string; op: string; origin: string; xid: string; request_id: string | null }[]> {
    return inTenant(tenant, async (tx) =>
      (
        await tx.query<{ table: string; op: string; origin: string; xid: string; request_id: string | null }>(
          `SELECT "table", op, origin, xid::text AS xid, request_id FROM ${handle.schema}.changelog ORDER BY seq`,
        )
      ).rows,
    );
  }

  it('finds an inserted note and logs one target insert', async () => {
    await gated(tenantA, (tx) => repository.insert(tx, NOTE_TABLE.table, noteRow(noteId(1))));

    expect(await inTenant(tenantA, (tx) => repository.findNote(tx, noteId(1)))).toMatchObject({
      tenant_id: tenantA,
      note_id: noteId(1),
      title: `Title ${noteId(1)}`,
      row_version: '1',
    });
    expect(await inTenant(tenantA, (tx) => repository.findNote(tx, noteId(2)))).toBeNull();
    expect((await changelog(tenantA)).map(({ table, op, origin }) => ({ table, op, origin }))).toEqual([
      { table: 'note', op: 'insert', origin: 'target' },
    ]);
  });

  it('records the stub write position and request id of a write inside a request', async () => {
    const store = newRequestContext({ requestId: 'stub-repository-request' });
    await runWithRequestContext(store, () => gated(tenantA, (tx) => repository.insert(tx, NOTE_TABLE.table, noteRow(noteId(1)))));

    const [logged] = await changelog(tenantA);
    expect(logged?.request_id).toBe('stub-repository-request');
    expect([...store.writePositions]).toEqual([[STUB_OWNER, logged?.xid]]);
  });

  it('lists only the transaction tenant notes, by created then note_id in code-unit order', async () => {
    await gated(tenantA, async (tx) => {
      for (const row of [noteRow(noteId(3)), noteRow(noteId(1), LATER), noteRow(LETTER_ID), noteRow(noteId(2))]) {
        await repository.insert(tx, NOTE_TABLE.table, row);
      }
    });
    await gated(tenantB, (tx) => repository.insert(tx, NOTE_TABLE.table, noteRow(noteId(9))));
    const ids = (page: { rows: NoteRow[]; next: NoteCursor | null }) => ({ ids: page.rows.map((row) => row.note_id), next: page.next });

    expect(ids(await inTenant(tenantA, (tx) => repository.listNotes(tx, FIRST_PAGE)))).toEqual({
      ids: [noteId(2), noteId(3), LETTER_ID, noteId(1)],
      next: null,
    });
    expect(ids(await inTenant(tenantB, (tx) => repository.listNotes(tx, FIRST_PAGE)))).toEqual({ ids: [noteId(9)], next: null });
    expect(
      ids(await inTenant(tenantB, (tx) => repository.listNotes(tx, { after: { created: AT, noteId: noteId(2) }, limit: 1 }))),
    ).toEqual({ ids: [noteId(9)], next: null });
    expect(await inTenant(tenantB, (tx) => repository.findNote(tx, noteId(1)))).toBeNull();
    expect(await gated(tenantB, (tx) => repository.deleteNote(tx, noteId(1)))).toBe(false);
  });

  describe('note pages', () => {
    const CREATED_OF = new Map([
      [noteId(2), AT],
      [noteId(3), AT],
      [LETTER_ID, AT],
      [noteId(1), JUST_AFTER],
      [noteId(4), JUST_AFTER],
      [noteId(5), LATER],
    ]);
    const ORDER = [...CREATED_OF.keys()];

    beforeEach(async () => {
      await gated(tenantA, async (tx) => {
        for (const id of [noteId(3), noteId(1), LETTER_ID, noteId(5), noteId(2), noteId(4)]) {
          await repository.insert(tx, NOTE_TABLE.table, noteRow(id, CREATED_OF.get(id)));
        }
      });
    });

    /** Every page of tenant A's notes at `limit`, following each `next` until it is null. */
    async function walk(limit: number): Promise<{ ids: string[]; next: NoteCursor | null }[]> {
      const pages: { ids: string[]; next: NoteCursor | null }[] = [];
      let after: NoteCursor | null = null;
      do {
        const page = await inTenant(tenantA, (tx) => repository.listNotes(tx, { after, limit }));
        pages.push({ ids: page.rows.map((row) => row.note_id), next: page.next });
        after = page.next;
      } while (after !== null && pages.length <= ORDER.length);
      return pages;
    }

    it.each([
      { label: 'pages ending on an exact multiple', limit: 2, sizes: [2, 2, 2] },
      { label: 'a short last page', limit: 4, sizes: [4, 2] },
      { label: 'one exactly full page', limit: 6, sizes: [6] },
      { label: 'single-note pages', limit: 1, sizes: [1, 1, 1, 1, 1, 1] },
    ])('walks $label once each, in created then note_id code-unit order', async ({ limit, sizes }) => {
      const pages = await walk(limit);

      expect(pages.map((page) => page.ids.length)).toEqual(sizes);
      expect(pages.flatMap((page) => page.ids)).toEqual(ORDER);
      expect(pages.map((page) => page.next)).toEqual(
        pages.map((page, index) => {
          const last = page.ids.at(-1) as string;
          return index === pages.length - 1 ? null : { created: CREATED_OF.get(last), noteId: last };
        }),
      );
    });

    it.each([
      { label: 'smallest', created: '0001-01-01 00:00:00.000', ids: ORDER },
      { label: 'largest', created: '9999-12-31 23:59:59.999', ids: [] },
    ])('casts a keyset created in the $label accepted cursor year', async ({ created, ids }) => {
      const page = await inTenant(tenantA, (tx) => repository.listNotes(tx, { after: { created, noteId: noteId(0) }, limit: NOTE_PAGE_MAX }));

      expect({ ids: page.rows.map((row) => row.note_id), next: page.next }).toEqual({ ids, next: null });
    });

    it.each([0, NOTE_PAGE_MAX + 1, 1.5])('rejects a page limit of %s', async (limit) => {
      await expect(inTenant(tenantA, (tx) => repository.listNotes(tx, { after: null, limit }))).rejects.toBeInstanceOf(RangeError);
    });

    it.each([
      { label: 'first', after: null },
      { label: 'keyset', after: { created: AT, noteId: noteId(3) } },
    ])('reads the $label page through note_created_idx without sorting', async ({ after }) => {
      const plan = await inTenant(tenantA, async (tx) => {
        const statements: { text: string; values: unknown[] }[] = [];
        const recording: TenantTx = {
          ...tx,
          query: ((text: string, values: unknown[] = []) => {
            statements.push({ text, values });
            return tx.query(text, values);
          }) as TenantTx['query'],
        };
        await tx.query('SET LOCAL enable_seqscan = off');
        await repository.listNotes(recording, { after, limit: 2 });
        const list = statements.find((statement) => statement.text.includes('ORDER BY created')) as { text: string; values: unknown[] };
        return (await tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${list.text}`, list.values)).rows
          .map((row) => row['QUERY PLAN'])
          .join('\n');
      });

      expect(plan).toContain(`Index Scan using note_created_idx on note`);
      expect(plan).not.toMatch(/Sort/);
    });
  });

  it('deletes a note once, then reports no match, logging one delete', async () => {
    await gated(tenantA, (tx) => repository.insert(tx, NOTE_TABLE.table, noteRow(noteId(4))));

    expect(await gated(tenantA, (tx) => repository.deleteNote(tx, noteId(4)))).toBe(true);
    expect(await gated(tenantA, (tx) => repository.deleteNote(tx, noteId(4)))).toBe(false);
    expect(await inTenant(tenantA, (tx) => repository.findNote(tx, noteId(4)))).toBeNull();
    expect((await changelog(tenantA)).map((row) => row.op)).toEqual(['insert', 'delete']);
  });

  it('keeps one projection row per note_id with the latest values', async () => {
    expect(await gated(tenantA, (tx) => repository.upsertProjection(tx, projectionRow(noteId(5))))).toBeUndefined();
    await gated(tenantA, (tx) =>
      repository.upsertProjection(tx, projectionRow(noteId(5), { title: 'T2', aggregate_version: 2, apply_count: 2, last_event_id: EVENT_2 })),
    );

    expect(await inTenant(tenantA, (tx) => repository.findProjection(tx, noteId(5)))).toMatchObject({
      note_id: noteId(5),
      title: 'T2',
      aggregate_version: '2',
      apply_count: 2,
      last_event_id: EVENT_2,
    });
    expect(await inTenant(tenantB, (tx) => repository.findProjection(tx, noteId(5)))).toBeNull();
    const rows = await inTenant(tenantA, async (tx) =>
      (await tx.query(`SELECT note_id FROM ${handle.schema}.${NOTE_PROJECTION_TABLE.table}`)).rows,
    );
    expect(rows).toHaveLength(1);
    expect((await changelog(tenantA)).map(({ table, op }) => `${table}:${op}`)).toEqual(['note_projection:insert', 'note_projection:update']);
  });

  it('waits on a closed gate then fails with the legacy 503, and rejects writes of a legacy unit', async () => {
    await setGates('closed');
    const started = Date.now();
    await expect(gated(tenantA, (tx) => repository.insert(tx, NOTE_TABLE.table, noteRow(noteId(6))))).rejects.toBeInstanceOf(GateClosedError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(BUDGET_MS - 50);

    await setGates('legacy');
    await expect(gated(tenantA, (tx) => repository.upsertProjection(tx, projectionRow(noteId(6))))).rejects.toBeInstanceOf(
      UnitNotAuthoritativeError,
    );
  });

  it.each(['executing', 'importing', 'import-pending'] as const)('blocks reads while a window is %s', async (phase) => {
    await setGates('closed', phase);

    await expect(gated(tenantA, (tx) => repository.findNote(tx, noteId(1)))).rejects.toBeInstanceOf(UnitReadBlockedError);
    await expect(gated(tenantA, (tx) => repository.listNotes(tx, FIRST_PAGE))).rejects.toBeInstanceOf(UnitReadBlockedError);
    await expect(gated(tenantA, (tx) => repository.findProjection(tx, noteId(1)))).rejects.toBeInstanceOf(UnitReadBlockedError);
  });
});
