/** Paged and batched comment, change-set and form-response reads against their unpaged legacy reads over a throwaway `content` schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnitReadBlockedError, closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { ContentQueryError } from '../../src/repo/content-queries.js';
import {
  DEFAULT_ROW_BATCH_SIZE,
  createContentRepository,
  type ChangesetQueryArgs,
  type ContentRepository,
  type FormResponsesArgs,
  type ListCommentsArgs,
  type PagedRows,
  type RowPage,
} from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const SITE = TENANT_A.siteId;
const CONTENT_ID = cfId('O', 1);
const FORM_ID = cfId('F', 1);
const ROOT = cfId('M', 1);

let handle: ThrowawaySchema;
let repo: ContentRepository;

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);

type Row = object;

/** One list read in its three forms, with the unit whose window phase blocks it. */
interface ReadCase {
  label: string;
  unit: string;
  all: (tx: TenantTx) => Promise<Row[]>;
  page: (tx: TenantTx, page: RowPage) => Promise<PagedRows<Row>>;
  batches: (tx: TenantTx, batchSize?: number) => AsyncGenerator<Row[], void, undefined>;
}

const commentCase = (label: string, args: ListCommentsArgs): ReadCase => ({
  label: `listComments ${label}`,
  unit: 'content.comment',
  all: (tx) => repo.comments.listComments(tx, args),
  page: (tx, page) => repo.comments.listCommentsPage(tx, args, page),
  batches: (tx, batchSize) => repo.comments.listCommentBatches(tx, args, batchSize),
});

const changesetCase = (label: string, args: ChangesetQueryArgs): ReadCase => ({
  label: `changesetQuery ${label}`,
  unit: 'content.changeset',
  all: (tx) => repo.changesets.changesetQuery(tx, args),
  page: (tx, page) => repo.changesets.changesetQueryPage(tx, args, page),
  batches: (tx, batchSize) => repo.changesets.changesetQueryBatches(tx, args, batchSize),
});

const responseCase = (label: string, args: FormResponsesArgs): ReadCase => ({
  label: `forms.responses ${label}`,
  unit: 'content.form_response_packet',
  all: (tx) => repo.forms.responses(tx, args),
  page: (tx, page) => repo.forms.responsesPage(tx, args, page),
  batches: (tx, batchSize) => repo.forms.responseBatches(tx, args, batchSize),
});

const FIELDS = ['name', 'color'];

const CASES: readonly ReadCase[] = [
  commentCase('editor roots with reply counts', { contentId: CONTENT_ID, siteId: SITE, isEditor: true, includeKids: true }),
  commentCase('every comment with spam, newest first', { contentId: CONTENT_ID, siteId: SITE, isEditor: true, includeSpam: true, filterByParentId: false, sortOrder: 'desc' }),
  commentCase('replies of one comment', { contentId: CONTENT_ID, siteId: SITE, parentId: ROOT.toLowerCase() }),
  changesetCase('by published then name', { siteId: SITE }),
  changesetCase('unpublished by publish date', { siteId: SITE, sortBy: 'PublishDate', published: 0 }),
  changesetCase('keyword', { siteId: SITE, keywords: 'BATCH' }),
  responseCase('by entered', { formId: FORM_ID, siteId: SITE }),
  responseCase('by field descending', { formId: FORM_ID, siteId: SITE, fieldNames: FIELDS, sortBy: 'name', sortDirection: 'desc' }),
  responseCase('keyword in one field', { formId: FORM_ID, siteId: SITE, fieldNames: FIELDS, keywords: 'RED', filterBy: 'color' }),
];

async function collect(batches: AsyncGenerator<Row[], void, undefined>): Promise<Row[][]> {
  const out: Row[][] = [];
  for await (const batch of batches) {
    out.push(batch);
  }
  return out;
}

async function openCursors(tx: TenantTx): Promise<number> {
  const { rows } = await tx.query<{ open: number }>(`SELECT count(*)::integer AS open FROM pg_cursors WHERE name LIKE 'content\\_rows\\_%'`);
  return rows[0]?.open ?? -1;
}

/** A transaction handle that records its statements and runs none. */
function recordingTx(): { tx: TenantTx; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(() => Promise.reject(new Error('no SQL expected')));
  const tx = { kind: 'tenant', tenantId: TENANT_A.tenantId, schema: handle.schema, query, onCommit: () => undefined } as unknown as TenantTx;
  return { tx, query };
}

async function seed(): Promise<void> {
  await inA(async (tx) => {
    const comment = (n: number, day: number, extra: Record<string, unknown> = {}) =>
      repo.comments.insertComment(tx, {
        commentid: cfId('M', n), contentid: CONTENT_ID, siteid: SITE, name: `c${n}`, entered: new Date(2026, 5, day),
        isapproved: 1, isspam: 0, isdeleted: 0, ...extra,
      });
    await comment(1, 1);
    await comment(2, 2);
    await comment(3, 3, { isapproved: 0 });
    await comment(4, 4, { isspam: 1 });
    await comment(5, 5, { parentid: ROOT });
    await comment(6, 5, { parentid: ROOT });
    await comment(7, 6, { parentid: cfId('M', 2) });
    const changesets: [string, number, Date | undefined, string][] = [
      ['Alpha', 0, new Date(2026, 6, 1), 'batch one'],
      ['bravo', 0, new Date(2026, 6, 3), 'other'],
      ['Charlie', 1, new Date(2026, 4, 1), 'Batch two'],
      ['delta', 0, undefined, 'batch three'],
      ['Echo', 1, new Date(2026, 3, 1), 'none'],
      ['foxtrot', 0, new Date(2026, 6, 2), 'BATCH four'],
    ];
    for (const [n, [label, published, publishdate, description]] of changesets.entries()) {
      await repo.changesets.insertChangeset(tx, { changesetid: cfId('S', n + 1), siteid: SITE, name: label, published, publishdate: publishdate ?? null, description });
    }
    const responses: [number, string, string][] = [
      [3, 'beta', 'red'],
      [1, 'Alpha', 'blue'],
      [5, 'echo', 'RED'],
      [2, 'delta', 'green'],
      [2, 'Charlie', 'red'],
    ];
    for (const [n, [day, label, color]] of responses.entries()) {
      await repo.forms.insertResponse(tx, {
        responseid: cfId('R', n + 1), formid: FORM_ID, siteid: SITE, entered: new Date(2026, 5, day), data: `<wddxPacket>${label}</wddxPacket>`,
        fieldlist: 'name,color', questions: [{ formfield: 'name', formvalue: label }, { formfield: 'color', formvalue: color }],
      });
    }
  });
}

describe.skipIf(!(await pgAvailable()))('repo/repository paged and batched list reads', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'paging-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'paging-test' });
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
    await seed();
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('seeds every case with more rows than one small page', async () => {
    const counts = await inA(async (tx) => {
      const lengths: number[] = [];
      for (const read of CASES) {
        lengths.push((await read.all(tx)).length);
      }
      return lengths;
    });
    expect(counts).toEqual([3, 7, 2, 6, 4, 4, 5, 5, 3]);
  });

  it.each(CASES)('$label: each page is the slice of the unpaged rows, with their count as total', async (read) => {
    await inA(async (tx) => {
      const all = await read.all(tx);
      expect(await read.page(tx, { limit: 2 })).toEqual({ rows: all.slice(0, 2), total: all.length });
      for (const limit of [1, 2, 3]) {
        for (let offset = 0; offset < all.length; offset += 1) {
          expect(await read.page(tx, { limit, offset })).toEqual({ rows: all.slice(offset, offset + limit), total: all.length });
        }
      }
    });
  });

  it.each(CASES)('$label: an offset at or past the end returns no rows and the total', async (read) => {
    await inA(async (tx) => {
      const total = (await read.all(tx)).length;
      expect(await read.page(tx, { limit: 2, offset: total })).toEqual({ rows: [], total });
      expect(await read.page(tx, { limit: 2, offset: total + 5 })).toEqual({ rows: [], total });
    });
  });

  it.each(CASES)('$label: batches concatenate to the unpaged rows in order and close their cursor', async (read) => {
    await inA(async (tx) => {
      const all = await read.all(tx);
      for (const size of [2, 3, DEFAULT_ROW_BATCH_SIZE]) {
        const batches = await collect(read.batches(tx, size));
        expect(batches.flat()).toEqual(all);
        expect(batches.every((batch) => batch.length > 0 && batch.length <= size)).toBe(true);
        expect(batches.slice(0, -1).every((batch) => batch.length === size)).toBe(true);
      }
      expect((await collect(read.batches(tx))).flat()).toEqual(all);
      expect(await openCursors(tx)).toBe(0);
    });
  });

  it.each(CASES)('$label: leaving a batch loop early closes the cursor and keeps the transaction usable', async (read) => {
    await inA(async (tx) => {
      const all = await read.all(tx);
      const seen: Row[] = [];
      for await (const batch of read.batches(tx, 1)) {
        seen.push(...batch);
        expect(await openCursors(tx)).toBe(1);
        break;
      }
      expect(seen).toEqual(all.slice(0, 1));
      expect(await openCursors(tx)).toBe(0);
      expect(await read.all(tx)).toEqual(all);
    });
  });

  it.each(CASES)('$label: an invalid batch size rejects before any SQL', async (read) => {
    const { tx, query } = recordingTx();
    for (const size of [0, -1, 1.5, Number.NaN]) {
      await expect(read.batches(tx, size).next()).rejects.toThrow(new ContentQueryError(`Invalid batch size ${size}`));
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('a change-set tag filter rejects in the page and batch reads as changesetQuery does', async () => {
    const { tx, query } = recordingTx();
    const args = { siteId: SITE, tag: 't1' };
    const failure = new ContentQueryError("Incorrect syntax near 'tchangesettagassign'");
    await expect(repo.changesets.changesetQuery(tx, args)).rejects.toThrow(failure);
    await expect(repo.changesets.changesetQueryPage(tx, args, { limit: 2 })).rejects.toThrow(failure);
    await expect(repo.changesets.changesetQueryBatches(tx, args).next()).rejects.toThrow(failure);
    expect(query).not.toHaveBeenCalled();
  });

  it('a failed FETCH surfaces its own error rather than a CLOSE on the aborted transaction', async () => {
    const read = CASES[0] as ReadCase;
    const run = inA(async (tx) => {
      const failing: TenantTx = {
        ...tx,
        query: ((text: string, values?: unknown[]) => (text.startsWith('FETCH') ? tx.query('SELECT 1 / 0') : tx.query(text, values))) as TenantTx['query'],
      };
      await collect(read.batches(failing, 2));
    });
    await expect(run).rejects.toMatchObject({ code: '22012' });
  });

  it.each(CASES)('$label: page and batch reads wait out an importing window, then fail as unit reads do', async (read) => {
    await closeGates(handle.app, { units: [read.unit], holderId: 'paging-window', phase: 'importing' });
    try {
      await expect(withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => read.page(tx, { limit: 2 }), { budgetMs: 200 })).rejects.toBeInstanceOf(
        UnitReadBlockedError,
      );
      await expect(withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => read.batches(tx, 2).next(), { budgetMs: 200 })).rejects.toBeInstanceOf(
        UnitReadBlockedError,
      );
    } finally {
      await openGates(handle.app, { units: [read.unit], holderId: 'paging-window' });
    }
    expect((await inA((tx) => read.page(tx, { limit: 1 }))).rows).toHaveLength(1);
  });
});
