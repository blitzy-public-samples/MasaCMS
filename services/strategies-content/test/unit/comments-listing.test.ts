/** ccomments.loadComments and loadCommentsPage over a throwaway content schema: paged feed reads and batched lookups equal the full-fetch, per-row results. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { javaTrim } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates, qualified } from '@opt2/platform/migration-kit';
import { withTenant, type QueryResultRow, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { loadComments, loadCommentsPage, type CommentsPageRow, type LoadCommentsRow } from '../../src/domain/comments.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type DomainDeps } from '../../src/domain/context.js';
import { createContentRepository, type CommentFeedArgs, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const SITE = TENANT_A.siteId;
const PAGE_SITE = 'page-site';
const TREE = '00000000000000000000000000000000000';
const FEED_SIZE = 30;
const C1 = cfId('K', 1);
const C2 = cfId('K', 2);
const MISSING = cfId('K', 3);
const P1 = cfId('P', 1);
const U1 = cfId('U', 1);
const R = (n: number): string => cfId('R', n);

const CLAIMS: UserClaims = {
  iss: 'opt2-local-identity',
  aud: 'opt2-local',
  sub: U1,
  sid: 'session-1',
  tid: TENANT_A.tenantId,
  site: SITE,
  roles: ['s2'],
  s2: true,
  epoch: 1,
  iat: 0,
  exp: 0,
};
const ACTOR = actorFromClaims(CLAIMS, 'Comment Tester');
const SESSION = { sessionSiteId: SITE, dateKeyFormat: 'MM/DD/YYYY' };
// Empty date bounds remove the default seven-day range, so every seeded comment matches.
const NO_DATES = { startdate: '', enddate: '' };

interface Statement {
  sql: string;
  values: readonly unknown[];
}

let handle: ThrowawaySchema;
let repo: ContentRepository;
let deps: DomainDeps;
const statements: Statement[] = [];

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);
const table = (name: string): string => qualified(handle.schema, name);

/** `db` with every statement its tenant transactions run appended to `log`. */
function recordingDb(db: TenantDb, log: Statement[]): TenantDb {
  return {
    schema: db.schema,
    withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
      return db.withTenant(tenantId, (tx) =>
        fn({
          ...tx,
          query<R extends QueryResultRow = QueryResultRow>(text: Parameters<TenantTx['query']>[0], values?: unknown[]) {
            log.push({ sql: typeof text === 'string' ? text : text.text, values: values ?? [] });
            return tx.query<R>(text, values);
          },
        }),
      );
    },
    withMetadata<T>(fn: Parameters<TenantDb['withMetadata']>[0], options?: Parameters<TenantDb['withMetadata']>[1]): Promise<T> {
      return db.withMetadata(fn, options) as Promise<T>;
    },
    end: () => db.end(),
  };
}

/** The content id of feed comment `n`: missing, lower-case C1, C1, C2 or empty. */
function feedContentId(n: number): string {
  return [MISSING, C1.toLowerCase(), C1, C2, ''][n % 5] as string;
}

/** The previous loadComments read: the whole feed, sliced, with one readActive per comment. */
function fullFetch(args: CommentFeedArgs, start: number, end: number): Promise<{ recordCount: number; rows: LoadCommentsRow[] }> {
  return inA(async (tx) => {
    const all = await repo.comments.commentFeed(tx, { siteId: SITE, ...args });
    const rows: LoadCommentsRow[] = [];
    for (const comment of all.slice(start, end)) {
      const [content] = await repo.content.readActive(tx, { contentId: javaTrim(comment.contentid ?? ''), siteId: javaTrim(comment.siteid ?? '') });
      rows.push({ comment, content: content ?? null });
    }
    return { recordCount: all.length, rows };
  });
}

/** The previous loadCommentsPage enrichment: one findCommenter and one findComment per shown row. */
function perRowEnrichment(rows: readonly CommentsPageRow[], startRow: number, endRow: number): Promise<CommentsPageRow[]> {
  return inA(async (tx) => {
    const expected: CommentsPageRow[] = [];
    for (const [index, { comment }] of rows.entries()) {
      if (index + 1 < startRow || index + 1 > endRow) {
        expected.push({ comment, commenterRemoteId: '', parentName: null });
        continue;
      }
      const commenter = await repo.comments.findCommenter(tx, { commenterId: javaTrim(comment.userid ?? '') });
      const parentId = javaTrim(comment.parentid ?? '');
      const parent = parentId === '' ? null : await repo.comments.findComment(tx, { commentId: parentId });
      expected.push({ comment, commenterRemoteId: javaTrim(commenter?.remoteid ?? ''), parentName: parent === null ? null : javaTrim(parent.name ?? '') });
    }
    return expected;
  });
}

describe.skipIf(!(await pgAvailable()))('comment listings over a throwaway content schema', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'comments-listing-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'comments-listing-test', state: 'open' });
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
    deps = { db: recordingDb(handle.app, statements), repository: repo, clock: fixedClock(NOW), config: CONTENT_CONFIG_DEFAULTS };
    await inA(async (tx) => {
      const version = { siteid: SITE, type: 'Page', subtype: 'Default', moduleid: TREE, approved: 1, display: 1 };
      await repo.content.insertVersion(tx, { ...version, contentid: C1, contenthistid: cfId('H', 1), active: 1, title: 'One' });
      await repo.content.insertVersion(tx, { ...version, contentid: C1, contenthistid: cfId('H', 9), active: 0, title: 'One draft' });
      await repo.content.insertVersion(tx, { ...version, contentid: C2, contenthistid: cfId('H', 2), active: 1, title: 'Two' });
      for (let n = 1; n <= FEED_SIZE; n += 1) {
        await repo.comments.insertComment(tx, {
          commentid: cfId('M', n),
          contentid: feedContentId(n),
          siteid: SITE,
          name: `Name ${String.fromCharCode(65 + ((n * 7) % 26))}`,
          email: `m${n}@x.test`,
          comments: `comment ${n}`,
          entered: new Date(2026, 5, 1 + (n % 10), 9, 0, 0),
          isapproved: 1,
          isspam: 0,
          isdeleted: 0,
          flagcount: n % 3,
          subscribe: 0,
        });
      }
      await repo.comments.upsertCommenter(tx, { commenterid: U1, remoteid: ' rem-1 ', name: 'Ann' });
      await repo.comments.upsertCommenter(tx, { commenterid: '', remoteid: 'blank-remote', name: 'Nobody' });
      const thread: [number, string, string, string][] = [
        [1, U1, '', ' Root '],
        [2, U1.toLowerCase(), R(1).toLowerCase(), 'Second'],
        [3, '', R(99), 'Orphan'],
        [4, cfId('U', 9), R(2), 'Fourth'],
        [5, U1, '', 'Fifth'],
      ];
      for (const [n, userid, parentid, name] of thread) {
        await repo.comments.insertComment(tx, {
          commentid: R(n),
          contentid: P1,
          siteid: PAGE_SITE,
          name,
          userid,
          parentid,
          entered: new Date(2026, 5, n, 8, 0, 0),
          isapproved: 1,
          isspam: 0,
          isdeleted: 0,
        });
      }
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(() => {
    statements.length = 0;
  });

  it.each<[string, Record<string, unknown>, CommentFeedArgs, { recordCount: number; nextN: number; pageNo: number; totalPages: number; start: number; end: number }]>([
    ['the default maxItems and nextn', { pageno: 2 }, {}, { recordCount: 30, nextN: 25, pageNo: 2, totalPages: 2, start: 25, end: 30 }],
    ['maxItems 0 past the first page', { maxItems: 0, nextn: 10, pageno: 3 }, { maxItems: 0 }, { recordCount: 30, nextN: 10, pageNo: 3, totalPages: 3, start: 20, end: 30 }],
    ['maxItems below the match count', { maxItems: 12, nextn: 5, pageno: 3 }, { maxItems: 12 }, { recordCount: 12, nextN: 5, pageNo: 3, totalPages: 3, start: 10, end: 12 }],
    ['a fractional maxItems', { maxItems: '12.9', nextn: 5, pageno: 3 }, { maxItems: 12.9 }, { recordCount: 12, nextN: 5, pageNo: 3, totalPages: 3, start: 10, end: 12 }],
    ['a negative maxItems', { maxItems: -1, nextn: 10, pageno: 2 }, { maxItems: -1 }, { recordCount: 30, nextN: 10, pageNo: 2, totalPages: 3, start: 10, end: 20 }],
    ['a maxItems below one row', { maxItems: '0.5' }, { maxItems: 0.5 }, { recordCount: 0, nextN: 25, pageNo: 1, totalPages: 0, start: 0, end: 0 }],
    ['a pageno past the last page', { nextn: 10, pageno: 9 }, {}, { recordCount: 30, nextN: 10, pageNo: 1, totalPages: 3, start: 0, end: 10 }],
    ['a pageno below 1', { nextn: 10, pageno: 0 }, {}, { recordCount: 30, nextN: 10, pageNo: 1, totalPages: 3, start: 0, end: 10 }],
    ['a fractional nextn', { nextn: '2.5', pageno: 2 }, {}, { recordCount: 30, nextN: 2.5, pageNo: 2, totalPages: 12, start: 2, end: 5 }],
    ['a fractional pageno', { nextn: 10, pageno: '2.5' }, {}, { recordCount: 30, nextN: 10, pageNo: 2.5, totalPages: 3, start: 15, end: 25 }],
    ['a descending name sort', { sortby: 'name', sortdirection: 'desc', nextn: 7, pageno: 2 }, { sortBy: 'name', sortDirection: 'desc' }, { recordCount: 30, nextN: 7, pageNo: 2, totalPages: 5, start: 7, end: 14 }],
    ['the last partial page by flagcount', { sortby: 'flagcount', nextn: 8, pageno: 4 }, { sortBy: 'flagcount' }, { recordCount: 30, nextN: 8, pageNo: 4, totalPages: 4, start: 24, end: 30 }],
  ])('loadComments with %s returns the full-fetch page', async (_label, rc, args, expected) => {
    const page = await loadComments(deps, ACTOR, { ...NO_DATES, ...rc }, SESSION);
    const previous = await fullFetch(args, expected.start, expected.end);
    expect(previous.recordCount).toBe(expected.recordCount);
    expect(previous.rows).toHaveLength(expected.end - expected.start);
    expect(page).toMatchObject({ recordCount: expected.recordCount, nextN: expected.nextN, pageNo: expected.pageNo, totalPages: expected.totalPages });
    expect(page.rows).toEqual(previous.rows);
  });

  it('loadComments maps each comment to its active content case-insensitively, and empty or missing content to null', async () => {
    const page = await loadComments(deps, ACTOR, { ...NO_DATES, nextn: FEED_SIZE }, SESSION);
    expect(page.rows).toHaveLength(FEED_SIZE);
    const expected = new Map([[C1, cfId('H', 1)], [C2, cfId('H', 2)]]);
    for (const { comment, content } of page.rows) {
      expect(content?.contenthistid ?? null).toBe(expected.get(javaTrim(comment.contentid ?? '').toUpperCase()) ?? null);
    }
    expect(page.rows.filter((row) => row.content === null)).toHaveLength(12);
  });

  it('loadComments with maxItems 0 reads a count and one LIMIT/OFFSET page, and one content query for the page', async () => {
    const page = await loadComments(deps, ACTOR, { ...NO_DATES, maxItems: 0, nextn: 10, pageno: 3 }, SESSION);
    expect(page.rows).toHaveLength(10);
    const feedReads = statements.filter((s) => s.sql.includes(`FROM ${table('comment')} WHERE`));
    expect(feedReads).toHaveLength(2);
    const [count, rows] = feedReads as [Statement, Statement];
    expect(count.sql.startsWith(`SELECT count(*)::integer AS total FROM (SELECT 1 FROM ${table('comment')} WHERE`)).toBe(true);
    expect(count.sql).not.toContain('LIMIT');
    expect(rows.sql).toMatch(/ ORDER BY .+, commentid LIMIT \$\d+ OFFSET \$\d+$/);
    expect(rows.values.slice(-2)).toEqual([10, 20]);
    const contentIds = new Set(page.rows.map((row) => javaTrim(row.comment.contentid ?? '')).filter((id) => id !== ''));
    expect(contentIds.size).toBeGreaterThan(1);
    expect(statements.filter((s) => s.sql.includes(`FROM ${table('content')} tcontent`))).toHaveLength(1);
  });

  it('readActiveIn answers each non-empty id as readActive does, with one query', async () => {
    const ids = ['', C1.toLowerCase(), C1, `${C2}  `, MISSING];
    const found = await withTenant(deps.db, TENANT_A.tenantId, (tx) => repo.content.readActiveIn(tx, { siteId: SITE, contentIds: ids }));
    expect(statements.filter((s) => s.sql.includes(`FROM ${table('content')} tcontent`))).toHaveLength(1);
    const perId = await inA(async (tx) => {
      const rows = new Map<string, unknown>();
      for (const id of ids) {
        const [row] = await repo.content.readActive(tx, { siteId: SITE, contentId: id });
        if (row !== undefined) rows.set(id, row);
      }
      return rows;
    });
    expect([...found.keys()]).toEqual([C1.toLowerCase(), C1, `${C2}  `]);
    expect(new Map(found)).toEqual(perId);
  });

  it.each<[string, Record<string, unknown>, number, number]>([
    ['the rows below lowerID', { lowerID: R(2) }, 2, 4],
    ['the rows above upperID in descending order', { upperID: R(4), sortDirection: 'desc' }, 1, 2],
    ['the requested comment', { commentID: R(3) }, 3, 3],
    ['the first row by default', {}, 1, 1],
  ])('loadCommentsPage resolves %s as the per-row lookups did', async (_label, rc, startRow, endRow) => {
    const page = await loadCommentsPage(deps, ACTOR, { contentID: P1, ...rc }, PAGE_SITE);
    expect(page).toMatchObject({ startRow, endRow });
    const feed = await inA((tx) => repo.comments.commentFeed(tx, { contentId: P1, siteId: PAGE_SITE, sortDirection: page.sort }));
    expect(page.rows.map((row) => row.comment)).toEqual(feed);
    expect(page.rows).toEqual(await perRowEnrichment(page.rows, startRow, endRow));
  });

  it('loadCommentsPage reads the shown rows commenters and parents with one query each', async () => {
    const page = await loadCommentsPage(deps, ACTOR, { contentID: P1, lowerID: R(2) }, PAGE_SITE);
    expect(page.rows.map((row) => [row.commenterRemoteId, row.parentName])).toEqual([
      ['', null],
      ['rem-1', 'Root'],
      ['blank-remote', null],
      ['', 'Second'],
      ['', null],
    ]);
    expect(statements.filter((s) => s.sql.includes(`FROM ${table('commenter')}`))).toHaveLength(1);
    expect(statements.filter((s) => s.sql.startsWith(`SELECT c.commentid, c.name FROM ${table('comment')}`))).toHaveLength(1);
    expect(statements.filter((s) => s.sql.includes('LIMIT 1'))).toHaveLength(0);
  });

  it.each<[string, CommentFeedArgs, { offset: number; limit: number }, number, number]>([
    ['inside the cap', { maxItems: 12 }, { offset: 5, limit: 4 }, 5, 9],
    ['clamped at the cap', { maxItems: 12 }, { offset: 10, limit: 5 }, 10, 12],
    ['past the cap', { maxItems: 12 }, { offset: 15, limit: 5 }, 15, 15],
    ['without a cap', { maxItems: 0 }, { offset: 25, limit: 10 }, 25, 30],
  ])('commentFeedPage %s equals the matching commentFeed slice', async (_label, args, page, start, end) => {
    const [rows, all, count] = await inA(async (tx) => [
      await repo.comments.commentFeedPage(tx, { siteId: SITE, ...args }, page),
      await repo.comments.commentFeed(tx, { siteId: SITE, ...args }),
      await repo.comments.commentFeedCount(tx, { siteId: SITE, ...args }),
    ] as const);
    expect(rows).toEqual(all.slice(start, end));
    expect(count).toBe(all.length);
  });

  it.each<[string, (tx: TenantTx, args: CommentFeedArgs) => Promise<unknown>]>([
    ['commentFeedCount', (tx, args) => repo.comments.commentFeedCount(tx, args)],
    ['commentFeedPage', (tx, args) => repo.comments.commentFeedPage(tx, args, { limit: 1 })],
  ])('%s rejects an unknown sort column before querying', async (_name, read) => {
    await expect(withTenant(deps.db, TENANT_A.tenantId, (tx) => read(tx, { siteId: SITE, sortBy: 'nope' }))).rejects.toThrow(/Invalid column/);
    expect(statements.filter((s) => s.sql.includes(table('comment')))).toHaveLength(0);
  });
});
