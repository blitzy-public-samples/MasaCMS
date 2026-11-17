/** Paged and batched comment, change-set, form-response, chain, collection, draft, assignment and category-walk reads against their unpaged legacy reads over a throwaway `content` schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnitReadBlockedError, closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { ContentQueryError, rowsById } from '../../src/repo/content-queries.js';
import type { FeedListArgs } from '../../src/repo/feed-queries.js';
import {
  DEFAULT_ROW_BATCH_SIZE,
  createContentRepository,
  type CategoryDescent,
  type CategoryTreeRow,
  type CategoryWalkRow,
  type ChangesetAssignmentsArgs,
  type ChangesetQueryArgs,
  type ContentRepository,
  type DraftListArgs,
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

const chainCase = (label: string, args: { siteId: string }): ReadCase => ({
  label: `approvals.listChains ${label}`,
  unit: 'content.approval_chain',
  all: (tx) => repo.approvals.listChains(tx, args),
  page: (tx, page) => repo.approvals.listChainsPage(tx, args, page),
  batches: (tx, batchSize) => repo.approvals.listChainBatches(tx, args, batchSize),
});

const feedCase = (label: string, args: FeedListArgs): ReadCase => ({
  label: `feeds.listFeeds ${label}`,
  unit: 'content.feed',
  all: (tx) => repo.feeds.listFeeds(tx, args),
  page: (tx, page) => repo.feeds.listFeedsPage(tx, args, page),
  batches: (tx, batchSize) => repo.feeds.listFeedBatches(tx, args, batchSize),
});

const draftCase = (label: string, args: DraftListArgs, unit: string): ReadCase => ({
  label: `content.draftList ${label}`,
  unit,
  all: (tx) => repo.content.draftList(tx, args),
  page: (tx, page) => repo.content.draftListPage(tx, args, page),
  batches: (tx, batchSize) => repo.content.draftListBatches(tx, args, batchSize),
});

const assignmentCase = (label: string, args: ChangesetAssignmentsArgs): ReadCase => ({
  label: `changesets.assignmentsQuery ${label}`,
  unit: 'content.approval_request',
  all: (tx) => repo.changesets.assignmentsQuery(tx, args),
  page: (tx, page) => repo.changesets.assignmentsPage(tx, args, page),
  batches: (tx, batchSize) => repo.changesets.assignmentBatches(tx, args, batchSize),
});

/** The in-memory walk of the pool's tree rows the admin routes printed before the cursor walk, as its oracle. */
function walkOf(rows: readonly CategoryTreeRow[], descend: CategoryDescent): CategoryWalkRow[] {
  const childrenOf = rowsById(rows, (row) => row.parentid);
  const out: CategoryWalkRow[] = [];
  const visit = (level: readonly CategoryTreeRow[], depth: number): void => {
    for (const row of level) {
      out.push({ ...row, depth, cycle: null });
      if (descend === 'every' || row.haskids > 0) visit(childrenOf([row.categoryid]), depth + 1);
    }
  };
  visit(rows.filter((row) => row.parentid === null), 0);
  return out;
}

const walkCase = (label: string, descend: CategoryDescent): ReadCase => ({
  label: `categories.categoryWalk ${label}`,
  unit: 'content.category',
  all: async (tx) => walkOf(await repo.categories.categoryTreeRows(tx, { siteId: SITE }), descend),
  page: (tx, page) => repo.categories.categoryWalkPage(tx, { siteId: SITE, descend }, page),
  batches: (tx, batchSize) => repo.categories.categoryWalkBatches(tx, { siteId: SITE, descend }, batchSize),
});

const FIELDS = ['name', 'color'];
const USER = cfId('U', 1);
const CHANGESET = cfId('S', 9);
const SITE_TREE = '00000000000000000000000000000000000';
const COMPONENTS = '00000000000000000000000000000000003';

/** The whole-list reads of the admin chain, collection, draft, change-set assignment and category tree screens. */
const LIST_CASES: readonly ReadCase[] = [
  chainCase('of a site by name', { siteId: SITE }),
  feedCase('Local by name', { siteId: SITE, type: 'local' }),
  feedCase('Local and public', { siteId: SITE, type: 'LOCAL', publicOnly: true }),
  feedCase('Remote and active', { siteId: SITE, type: 'Remote', activeOnly: true }),
  draftCase('by last update', { siteId: SITE, userId: USER }, 'content.content'),
  draftCase('by menu title ascending', { siteId: SITE, userId: USER.toLowerCase(), sortBy: 'menutitle', sortDirection: 'asc' }, 'content.content_assignment'),
  draftCase('from a start date', { siteId: SITE, userId: USER, startDate: new Date(2026, 5, 3) }, 'content.approval_request'),
  assignmentCase('of the components', { changesetId: CHANGESET, moduleId: COMPONENTS }),
  assignmentCase('matching a keyword', { changesetId: CHANGESET.toLowerCase(), keywords: 'WIDGET' }),
  assignmentCase('of every module', { changesetId: CHANGESET }),
  walkCase('into every row', 'every'),
  walkCase('into rows with stored children', 'withKids'),
];

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

const ALL_CASES: readonly ReadCase[] = [...CASES, ...LIST_CASES];

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
    for (const [n, name] of ['beta', 'Alpha', null, 'alpha', 'Gamma'].entries()) {
      await repo.approvals.insertChain(tx, { chainid: cfId('C', n + 1), siteid: SITE, name, description: `chain ${n}` });
    }
    await repo.approvals.insertChain(tx, { chainid: cfId('C', 9), siteid: 'other-site', name: 'Elsewhere' });
    const feeds: [string, string | null, string, number, number][] = [
      ['L1', 'News', 'Local', 1, 1], ['L2', 'archive', 'local', 0, 0], ['L3', null, 'LOCAL', 1, 1], ['L4', 'news', 'Local', 0, 1],
      ['R1', 'Wire', 'Remote', 1, 1], ['R2', 'agency', 'remote', 1, 0], ['R3', 'Paused', 'Remote', 0, 1], ['O1', 'Other', 'Other', 1, 1],
    ];
    for (const [id, name, type, isactive, ispublic] of feeds) {
      await tx.query(
        `INSERT INTO ${handle.schema}.feed (tenant_id, feedid, siteid, name, type, isactive, ispublic, lastupdate) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [TENANT_A.tenantId, cfId(id.charAt(0), Number(id.slice(1))), SITE, name, type, isactive, ispublic, NOW],
      );
    }
    const content = (row: Record<string, unknown>) =>
      tx.query(
        `INSERT INTO ${handle.schema}.content (tenant_id, siteid, moduleid, parentid, contentid, contenthistid, type, active, approved, title, menutitle, summary,` +
          ' lastupdate, lastupdatebyid, changesetid) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
        [TENANT_A.tenantId, SITE, row.moduleid ?? SITE_TREE, row.parentid ?? SITE_TREE, row.contentid, row.contenthistid, row.type ?? 'Page', row.active ?? 1,
          row.approved ?? 0, row.title, row.title, row.summary ?? null, row.lastupdate ?? NOW, row.lastupdatebyid ?? USER, row.changesetid ?? null],
      );
    await content({ contentid: SITE_TREE, contenthistid: cfId('H', 0), type: 'Module', approved: 1, title: 'Site Manager', lastupdatebyid: null });
    const drafts: [string, number][] = [['delta', 1], ['Alpha', 4], ['charlie', 2], ['Bravo', 5], ['echo', 3]];
    for (const [n, [title, day]] of drafts.entries()) {
      await content({ contentid: cfId('D', n + 1), contenthistid: cfId('E', n + 1), title, lastupdate: new Date(2026, 5, day, 9, n) });
    }
    await content({ contentid: cfId('D', 8), contenthistid: cfId('E', 8), title: 'Someone else', lastupdatebyid: cfId('U', 2) });
    await content({ contentid: cfId('D', 9), contenthistid: cfId('E', 9), title: 'Requested' });
    await repo.approvals.insertRequest(tx, { requestid: cfId('Q', 1), contenthistid: cfId('E', 9), siteid: SITE, userid: USER, status: 'Pending' });
    const assigned: [string, string, string, string | null][] = [
      ['K', 'gadget', COMPONENTS, null], ['K', 'Widget two', COMPONENTS, null], ['K', 'Anchor', COMPONENTS, 'a widget inside'], ['K', 'widget one', COMPONENTS, null],
      ['P', 'Landing', SITE_TREE, null], ['P', 'Basics', SITE_TREE, null],
    ];
    for (const [n, [prefix, title, moduleid, summary]] of assigned.entries()) {
      await content({ contentid: cfId(prefix, n + 1), contenthistid: cfId('V', n + 1), title, moduleid, summary, active: 0, changesetid: CHANGESET });
    }
    await repo.approvals.insertRequest(tx, { requestid: cfId('Q', 2), contenthistid: cfId('V', 2), siteid: SITE, userid: USER, status: 'Approved' });
    // Children named by their parent's lower-case id are walked but not counted; another site's child is counted, never walked.
    // 'SS' under 'ß' is no repeat: their padded ids upper-case to texts of different lengths.
    const categories: [string, string | null, string | null, string][] = [
      [cfId('T', 1), 'beta', null, SITE], [cfId('T', 2), 'Alpha', null, SITE], [cfId('T', 3), null, null, SITE], [cfId('T', 4), 'Delta', cfId('T', 2), SITE],
      [cfId('T', 5), 'echo', cfId('T', 2).toLowerCase(), SITE], [cfId('T', 6), 'Foxtrot', cfId('T', 4), SITE], [cfId('T', 7), 'Away', cfId('T', 3), 'other-site'],
      [cfId('T', 8), 'golf', cfId('T', 5).toLowerCase(), SITE], ['ß', 'Eszett', null, SITE], ['SS', 'Double s', 'ß', SITE],
    ];
    for (const [categoryid, name, parentid, siteid] of categories) {
      await tx.query(`INSERT INTO ${handle.schema}.category (tenant_id, categoryid, siteid, parentid, name, isopen, isactive, isinterestgroup) VALUES ($1, $2, $3, $4, $5, 1, 1, 1)`, [
        TENANT_A.tenantId, categoryid, siteid, parentid, name,
      ]);
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

  it('seeds every whole-list case with more rows than one small page', async () => {
    const counts = await inA(async (tx) => {
      const lengths: number[] = [];
      for (const read of LIST_CASES) {
        lengths.push((await read.all(tx)).length);
      }
      return lengths;
    });
    expect(counts).toEqual([5, 4, 3, 2, 5, 5, 3, 4, 3, 6, 9, 8]);
  });

  it.each(ALL_CASES)('$label: each page is the slice of the unpaged rows, with their count as total', async (read) => {
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

  it.each(ALL_CASES)('$label: an offset at or past the end returns no rows and the total', async (read) => {
    await inA(async (tx) => {
      const total = (await read.all(tx)).length;
      expect(await read.page(tx, { limit: 2, offset: total })).toEqual({ rows: [], total });
      expect(await read.page(tx, { limit: 2, offset: total + 5 })).toEqual({ rows: [], total });
    });
  });

  it.each(ALL_CASES)('$label: batches concatenate to the unpaged rows in order and close their cursor', async (read) => {
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

  it.each(ALL_CASES)('$label: leaving a batch loop early closes the cursor and keeps the transaction usable', async (read) => {
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

  it.each(ALL_CASES)('$label: an invalid batch size rejects before any SQL', async (read) => {
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

  it.each(ALL_CASES)('$label: page and batch reads wait out an importing window, then fail as unit reads do', async (read) => {
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
