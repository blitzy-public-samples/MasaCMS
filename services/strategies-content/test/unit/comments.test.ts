/** ccomments moderation (GS-CO-11): listing filters and paging, flag writes, bulk and single edits, purge, JSON API save and the admin routes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyApiError, cfDateAdd, cfLsDateFormat, isCfUuid } from '@opt2/platform/legacy-compat';
import { BUSINESS_DATE, TENANT_A, TENANT_B } from '@opt2/platform/testing';
import {
  COMMENTS_DEFAULT_REDIRECT,
  approveComment,
  approveCommentAction,
  bulkEdit,
  deleteComment,
  deleteCommentAction,
  loadComments,
  markAsSpam,
  markAsSpamAction,
  purgeDeletedComments,
  purgeDeletedCommentsAction,
  saveComment,
  singleEdit,
  unapproveComment,
  unapproveCommentAction,
  undeleteComment,
  unmarkAsSpam,
  type ActiveContent,
  type CommentRedirectResult,
  type CommentSite,
  type LoadCommentsPage,
} from '../../src/domain/comments.js';
import { CONTENT_CONFIG_DEFAULTS } from '../../src/domain/context.js';
import { setCommentStat } from '../../src/domain/stats.js';
import { takeOut } from '../../src/domain/trash.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, buildTestApp, createRecordingDb, userHeaders, type RecordingDb, type TestApp } from '../helpers/app.js';
import { IDS, at, commentRow, contentRow, seedRecordingDb } from '../helpers/seed.js';
import { contentHeaders } from '../helpers/tokens.js';

// Pass-through spies: the stat recount and the trash takeOut keep their behaviour and record their calls.
vi.mock('../../src/domain/stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/domain/stats.js')>();
  return { ...actual, setCommentStat: vi.fn(actual.setCommentStat) };
});
vi.mock('../../src/domain/trash.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/domain/trash.js')>();
  return { ...actual, takeOut: vi.fn(actual.takeOut) };
});

type Deps = Parameters<typeof loadComments>[0];
type Actor = Parameters<typeof loadComments>[1];
type Repository = Deps['repository'];
type CommentRow = ReturnType<typeof commentRow>;
type FeedArgs = NonNullable<Parameters<Repository['comments']['commentFeedCount']>[1]>;
type Commenter = Awaited<ReturnType<Repository['comments']['upsertCommenter']>>;
type Status = 'approved' | 'unapproved' | 'spam' | 'deleted';

const SITE = TENANT_A.siteId;
const OTHER_SITE = 'other-site';
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const PAGE_ONE = cfId('P', 1);
const PAGE_TWO = cfId('P', 2);
const THREAD_PAGE = cfId('P', 3);
const BROKEN = cfId('X', 1);
const MORNING = at(`${BUSINESS_DATE}T09:00:00`);
const FEED_SIZE = 30;
const STATUSES: readonly Status[] = ['approved', 'unapproved', 'spam', 'deleted'];
const NAMES = ['Ada', 'bob', 'Cleo', 'dan', 'Eve', 'finn', 'Gus'] as const;
const FLAGS: Readonly<Record<Status, Pick<CommentRow, 'isapproved' | 'isspam' | 'isdeleted'>>> = {
  approved: { isapproved: 1, isspam: 0, isdeleted: 0 },
  unapproved: { isapproved: 0, isspam: 0, isdeleted: 0 },
  spam: { isapproved: 1, isspam: 1, isdeleted: 0 },
  deleted: { isapproved: 1, isspam: 0, isdeleted: 1 },
};
// Empty bounds pass no date filter, so every feed comment of the site matches.
const NO_DATES = { startdate: '', enddate: '' };
const SESSION = { sessionSiteId: SITE, dateKeyFormat: 'MM/DD/YYYY' };

const ADMIN: Actor = { userId: cfId('U', 1), fullName: 'Admin User', isLoggedIn: true, s2: true, roles: ['s2'], siteId: SITE, tenantId: TENANT_A.tenantId };
const MODERATOR: Actor = { ...ADMIN, userId: cfId('U', 2), fullName: 'Comment Moderator', s2: false, roles: ['system-user', 'm:015', 'm:000'] };
const VISITOR: Actor = { userId: '', fullName: '', isLoggedIn: false, s2: false, roles: [], siteId: SITE, tenantId: TENANT_A.tenantId };

const URLS: CommentSite['urls'] = {
  siteId: SITE,
  scheme: 'http',
  domain: 'tenant-a.test',
  requestDomain: 'tenant-a.test',
  previewDomain: '',
  serverPort: '',
  context: '',
  siteIdInUrls: false,
  indexFileInUrls: false,
  hashUrls: false,
  useSSL: false,
  filePoolId: SITE,
  configFileAssetPath: '',
  assetPath: '/sites',
  siteAssetPath: '/sites',
  fileStore: 'fileDir',
  legacyIndexFileLocation: false,
  urlTitleDelim: '-',
  allowUnicodeInFilenames: false,
  placeholderImgId: '',
  placeholderImgExt: '',
  directImages: true,
};
const COMMENT_SITE: CommentSite = {
  siteId: SITE,
  site: 'Tenant A',
  contactEmail: 'editors@tenant-a.test',
  urls: URLS,
  commentApprovalDefault: 0,
  contentUrl: (content, querystring) => `http://tenant-a.test/${content?.filename ?? ''}/${querystring === '' ? '' : `?${querystring}`}`,
};

/** The feed's status of comment `n`: approved, unapproved, spam and deleted in turn. */
const statusOf = (n: number): Status => STATUSES[n % STATUSES.length] ?? 'approved';

/** Thirty tenant-a comments over two pages: four statuses, entered over the ten days before BUSINESS_DATE, varied names and flag counts. */
function feedComments(): CommentRow[] {
  return Array.from({ length: FEED_SIZE }, (_, index) => {
    const n = index + 1;
    return commentRow({
      commentid: cfId('M', n),
      contentid: n % 2 === 0 ? PAGE_ONE : PAGE_TWO,
      name: NAMES[n % NAMES.length] ?? 'Ada',
      email: `reader${n}@x.test`,
      comments: `Comment ${n}`,
      entered: cfDateAdd('n', n, cfDateAdd('d', -(n % 11), MORNING)),
      flagcount: n % 5,
      ...FLAGS[statusOf(n)],
    });
  });
}

/** The status the feed seeds for `commentId`. */
const seededStatus = (commentId: string): Status => statusOf(Number(commentId.slice(1, 8)));

/** Comments of THREAD_PAGE (T1 awaits approval) and two of another site in the same tenant. */
function threadComments(): CommentRow[] {
  const thread = (n: number, email: string, overrides: Partial<CommentRow>): CommentRow =>
    commentRow({ commentid: cfId('T', n), contentid: THREAD_PAGE, email, name: email.split('@')[0] ?? '', comments: `Thread ${n}`, ...overrides });
  return [
    thread(1, 'zed@x.test', { ...FLAGS.unapproved, subscribe: 1 }),
    thread(2, 'amy@x.test', { ...FLAGS.approved, subscribe: 1 }),
    thread(3, 'spam@x.test', { ...FLAGS.spam, subscribe: 1 }),
    thread(4, 'quiet@x.test', { ...FLAGS.approved, subscribe: 0 }),
    thread(5, 'gone@x.test', { ...FLAGS.deleted, subscribe: 1 }),
    commentRow({ commentid: cfId('O', 1), contentid: PAGE_ONE, siteid: OTHER_SITE, ...FLAGS.deleted }),
    commentRow({ commentid: cfId('O', 2), contentid: PAGE_ONE, siteid: OTHER_SITE, ...FLAGS.approved }),
  ];
}

/** The rows and recordings behind the memory repository. */
interface Store {
  comments: CommentRow[];
  commenters: Commenter[];
  /** Stored comment stat by `<contentId>|<siteId>`. */
  stats: Map<string, number>;
  /** Arguments of every feed count and page read. */
  feedArgs: FeedArgs[];
}

const sameId = (a: string | null, b: string): boolean => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const endOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime();
const SORT_KEYS: Readonly<Record<string, (row: CommentRow) => number | string>> = {
  entered: (row) => row.entered?.getTime() ?? 0,
  name: (row) => (row.name ?? '').toLowerCase(),
  flagcount: (row) => row.flagcount ?? 0,
};
const compare = (x: number | string, y: number | string): number => (x < y ? -1 : x > y ? 1 : 0);
const signOf = (direction: string): number => (direction.toLowerCase() === 'desc' ? -1 : 1);

/** The sort key of a whitelisted `sortBy`, matched ignoring case as SQL Server's ORDER BY column is. */
function sortKeyOf(sortBy: string): (row: CommentRow) => number | string {
  const key = SORT_KEYS[sortBy.toLowerCase()];
  if (key === undefined) throw new Error(`Invalid column name ${sortBy}`);
  return key;
}

/** contentCommentManager.getComments over the store: the site, flag and date filters, the sort with its commentid tie-break, then the row cap. */
function feedRows(store: Store, args: FeedArgs): CommentRow[] {
  const flag = (value: number | null, wanted: boolean | undefined): boolean => wanted === undefined || value === (wanted ? 1 : 0);
  const key = sortKeyOf(args.sortBy ?? 'entered');
  const direction = signOf(args.sortDirection ?? 'asc');
  const matched = store.comments.filter((row) => {
    const entered = row.entered?.getTime() ?? 0;
    return (
      row.siteid === (args.siteId ?? 'default') &&
      flag(row.isapproved, args.isApproved) &&
      flag(row.isspam, args.isSpam) &&
      flag(row.isdeleted, args.isDeleted) &&
      (args.startDate === undefined || entered >= startOfDay(args.startDate)) &&
      (args.endDate === undefined || entered <= endOfDay(args.endDate))
    );
  });
  matched.sort((a, b) => compare(key(a), key(b)) * direction || a.commentid.localeCompare(b.commentid));
  const cap = args.maxItems ?? 1000;
  return cap > 0 ? matched.slice(0, Math.trunc(cap)) : matched;
}

/** The active version of a store page, titled after its id. */
function activeContent(contentId: string): ActiveContent {
  return {
    ...contentRow({ contentid: contentId, contenthistid: cfId('H', Number(contentId.slice(1, 8))), title: `Page ${contentId.slice(7, 8)}`, filename: `page-${contentId.slice(7, 8)}` }),
    filesize: null,
    contenttype: null,
    contentsubtype: null,
    fileext: null,
    assocfilename: null,
    approvalstatus: null,
    requestid: null,
    approvalgroupid: null,
  };
}

/** The content repository with its comment, active-content and comment-stat calls answered from `store`. */
function memoryRepository(store: Store): Repository {
  const base = createContentRepository({ clock: TEST_CLOCK });
  const byId = (commentId: string): CommentRow | undefined => store.comments.find((row) => sameId(row.commentid, commentId));
  const patch = (commentId: string, changes: Partial<CommentRow>): CommentRow | null => {
    const row = byId(commentId);
    if (row === undefined) return null;
    Object.assign(row, changes);
    return { ...row };
  };
  const comments: Repository['comments'] = {
    ...base.comments,
    async findComment(_tx, lookup) {
      if ('commentId' in lookup && sameId(BROKEN, lookup.commentId)) throw new Error('comment read failed');
      const row = 'commentId' in lookup ? byId(lookup.commentId) : store.comments.find((candidate) => sameId(candidate.remoteid, lookup.remoteId));
      return row === undefined ? null : { ...row, kids: null };
    },
    async commentSubscribers(_tx, args) {
      const subscribed = store.comments.filter(
        (row) => sameId(row.contentid, args.contentId) && row.siteid === args.siteId && row.email !== null && row.subscribe === 1 && row.isapproved === 1 && row.isspam === 0 && row.isdeleted === 0,
      );
      return [...new Set(subscribed.map((row) => row.email ?? ''))].sort();
    },
    async findCommenter(_tx, lookup) {
      const found = store.commenters.find((row) => ('commenterId' in lookup ? sameId(row.commenterid, lookup.commenterId) : sameId(row.remoteid, lookup.remoteId)));
      return found === undefined ? null : { ...found };
    },
    async upsertCommenter(_tx, row) {
      const commenterid = row.commenterid ?? cfId('K', store.commenters.length + 1);
      let stored = store.commenters.find((candidate) => sameId(candidate.commenterid, commenterid));
      if (stored === undefined) {
        stored = { tenant_id: TENANT_A.tenantId, commenterid, remoteid: null, email: null, name: null };
        store.commenters.push(stored);
      }
      Object.assign(stored, Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)));
      return { ...stored };
    },
    async insertComment(_tx, row) {
      const stored = commentRow({ ...row, commentid: row.commentid ?? cfId('N', store.comments.length + 1) });
      store.comments.push(stored);
      return { ...stored };
    },
    async updateComment(_tx, commentId, changes) {
      return patch(commentId, changes);
    },
    async setSubscribe(_tx, args) {
      const matched = store.comments.filter((row) => sameId(row.contentid, args.contentId) && row.siteid === args.siteId && sameId(row.email, args.email));
      return matched.map((row) => ({ ...Object.assign(row, { subscribe: args.subscribe }) }));
    },
    async setDeleted(_tx, args) {
      return patch(args.commentId, { isdeleted: args.isDeleted });
    },
    async setSpam(_tx, args) {
      return patch(args.commentId, { isspam: args.isSpam });
    },
    async purgeDeleted(_tx, args = {}) {
      const removed = store.comments.filter((row) => row.isdeleted === 1 && (args.siteId === undefined || row.siteid === args.siteId));
      store.comments = store.comments.filter((row) => !removed.includes(row));
      return removed;
    },
    async commentFeedCount(_tx, args = {}) {
      store.feedArgs.push(args);
      return feedRows(store, args).length;
    },
    async commentFeedPage(_tx, args, page) {
      store.feedArgs.push(args);
      const offset = page.offset ?? 0;
      return feedRows(store, args).slice(offset, offset + page.limit);
    },
  };
  const isPage = (contentId: string): boolean => [PAGE_ONE, PAGE_TWO, THREAD_PAGE].some((id) => sameId(id, contentId));
  return {
    ...base,
    comments,
    content: {
      ...base.content,
      async readActive(_tx, args) {
        return isPage(args.contentId) ? [activeContent(args.contentId)] : [];
      },
      async readActiveIn(_tx, args) {
        return new Map(args.contentIds.filter(isPage).map((id) => [id, activeContent(id)]));
      },
    },
    stats: {
      ...base.stats,
      async setCommentCount(_tx, args) {
        const count = store.comments.filter(
          (row) => sameId(row.contentid, args.contentId) && row.siteid === args.siteId && row.isapproved === 1 && row.isspam === 0 && row.isdeleted === 0,
        ).length;
        store.stats.set(`${args.contentId}|${args.siteId}`, count);
        return {
          tenant_id: TENANT_A.tenantId,
          contentid: args.contentId,
          siteid: args.siteId,
          views: 0,
          rating: 0,
          totalvotes: 0,
          upvotes: 0,
          downvotes: 0,
          comments: count,
          majorversion: 0,
          minorversion: 0,
          lockid: null,
          locktype: null,
          disablecomments: 0,
        };
      },
    },
  };
}

/** A store over `rows` and the domain dependencies reading it inside recording-pool transactions. */
function memoryDeps(rows: CommentRow[]): { store: Store; deps: Deps } {
  const store: Store = { comments: rows, commenters: [], stats: new Map(), feedArgs: [] };
  return { store, deps: { db: createRecordingDb(), repository: memoryRepository(store), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS } };
}

const ids = (page: LoadCommentsPage): string[] => page.rows.map((row) => row.comment.commentid);
const lastFeedArgs = (store: Store): FeedArgs => store.feedArgs.at(-1) ?? {};
const flagsOf = (store: Store, commentId: string): Pick<CommentRow, 'isapproved' | 'isspam' | 'isdeleted'> | undefined => {
  const row = store.comments.find((candidate) => candidate.commentid === commentId);
  return row === undefined ? undefined : { isapproved: row.isapproved, isspam: row.isspam, isdeleted: row.isdeleted };
};

beforeEach(() => {
  vi.clearAllMocks();
});


describe('loadComments', () => {
  let store: Store;
  let deps: Deps;

  beforeEach(() => {
    ({ store, deps } = memoryDeps(feedComments()));
  });

  const flagArgs = (args: FeedArgs): Pick<FeedArgs, 'isApproved' | 'isSpam' | 'isDeleted'> => ({
    isApproved: args.isApproved,
    isSpam: args.isSpam,
    isDeleted: args.isDeleted,
  });

  it.each<[string, Pick<FeedArgs, 'isApproved' | 'isSpam' | 'isDeleted'>, readonly Status[]]>([
    ['approved', { isApproved: true, isDeleted: false, isSpam: false }, ['approved']],
    ['unapproved', { isApproved: false, isDeleted: false, isSpam: false }, ['unapproved']],
    ['spam', { isSpam: true, isDeleted: false }, ['spam']],
    ['deleted', { isDeleted: true }, ['deleted']],
    ['Deleted', { isDeleted: true }, ['deleted']],
    ['', {}, STATUSES],
  ])('commentStatus %j sets the legacy flags and returns only that set', async (commentStatus, flags, statuses) => {
    const page = await loadComments(deps, ADMIN, { ...NO_DATES, commentStatus, nextn: FEED_SIZE }, SESSION);
    const expected = feedComments().filter((row) => statuses.includes(seededStatus(row.commentid)));
    expect(flagArgs(lastFeedArgs(store))).toEqual(flags);
    expect(page.commentStatus).toBe(commentStatus);
    expect(page.recordCount).toBe(expected.length);
    expect(ids(page).sort()).toEqual(expected.map((row) => row.commentid).sort());
  });

  it.each<[string, string, string, string]>([
    ['entered', 'asc', 'entered', 'asc'],
    ['entered', 'desc', 'entered', 'desc'],
    ['name', 'asc', 'name', 'asc'],
    ['name', 'DESC', 'name', 'DESC'],
    ['flagCount', 'desc', 'flagCount', 'desc'],
    ['ip', 'desc', 'entered', 'desc'],
    ['comments', 'sideways', 'entered', 'asc'],
    ['name', 'sideways', 'name', 'asc'],
  ])('sortby %s %s reads as %s %s', async (sortby, sortdirection, sortBy, sortDirection) => {
    const page = await loadComments(deps, ADMIN, { ...NO_DATES, sortby, sortdirection, nextn: FEED_SIZE }, SESSION);
    expect(page).toMatchObject({ sortBy, sortDirection, sortDirLink: signOf(sortDirection) > 0 ? 'desc' : 'asc' });
    expect(lastFeedArgs(store)).toMatchObject({ sortBy, sortDirection });
    const keys = page.rows.map((row) => sortKeyOf(sortBy)(row.comment));
    expect(keys.every((key, index) => index === 0 || compare(keys[index - 1] ?? key, key) * signOf(sortDirection) <= 0)).toBe(true);
    expect(page.rows).toHaveLength(FEED_SIZE);
  });

  // ACF's LSDateFormat reads `DD` as the day of the year, so the admin mask's default range is no date and bounds nothing.
  it.each<[string, boolean]>([
    ['mm/dd/yyyy', true],
    ['MM/DD/YYYY', false],
  ])('defaults the range to the clock date minus 7 days through today in session mask %s', async (dateKeyFormat, bounded) => {
    const now = TEST_CLOCK.now();
    const weekAgo = cfDateAdd('d', -7, now);
    const page = await loadComments(deps, ADMIN, { nextn: FEED_SIZE }, { sessionSiteId: SITE, dateKeyFormat });
    expect(page).toMatchObject({ startDate: cfLsDateFormat(weekAgo, dateKeyFormat), endDate: cfLsDateFormat(now, dateKeyFormat) });
    const { startDate, endDate } = lastFeedArgs(store);
    expect([startDate?.getTime(), endDate?.getTime()]).toEqual(bounded ? [startOfDay(weekAgo), startOfDay(now)] : [undefined, undefined]);
    const inWeek = feedComments().filter((row) => (row.entered?.getTime() ?? 0) >= startOfDay(weekAgo));
    expect(page.recordCount).toBe(bounded ? inWeek.length : FEED_SIZE);
  });

  it('honours an explicit range through the whole end day', async () => {
    const page = await loadComments(deps, ADMIN, { startdate: '06/25/2026', enddate: '06/27/2026', nextn: FEED_SIZE }, SESSION);
    expect(page).toMatchObject({ startDate: '06/25/2026', endDate: '06/27/2026' });
    const days = [25, 26, 27];
    expect(new Set(page.rows.map((row) => row.comment.entered?.getDate()))).toEqual(new Set(days));
    expect(page.recordCount).toBe(feedComments().filter((row) => days.includes(row.entered?.getDate() ?? 0)).length);
  });

  it.each<[string, Record<string, unknown>, { nextN: number; pageNo: number; totalPages: number; startPage: number; endPage: number; first: number; size: number }]>([
    ['the defaults', {}, { nextN: 25, pageNo: 1, totalPages: 2, startPage: 1, endPage: 2, first: 0, size: 25 }],
    ['the second default page', { pageno: 2 }, { nextN: 25, pageNo: 2, totalPages: 2, startPage: 1, endPage: 2, first: 25, size: 5 }],
    ['a nextn below 1', { nextn: 0, pageno: 2 }, { nextN: 25, pageNo: 2, totalPages: 2, startPage: 1, endPage: 2, first: 25, size: 5 }],
    ['the buffer at the first page', { nextn: 2, pageno: 1 }, { nextN: 2, pageNo: 1, totalPages: 15, startPage: 1, endPage: 7, first: 0, size: 2 }],
    ['the buffer mid-range', { nextn: 2, pageno: 8 }, { nextN: 2, pageNo: 8, totalPages: 15, startPage: 5, endPage: 11, first: 14, size: 2 }],
    ['the buffer at the last page', { nextn: 2, pageno: 15 }, { nextN: 2, pageNo: 15, totalPages: 15, startPage: 9, endPage: 15, first: 28, size: 2 }],
    // Legacy resets a page outside 1..pageCount to page 1 (ccomments.cfc:253-255) rather than to the last page.
    ['a page beyond the last', { nextn: 10, pageno: 99 }, { nextN: 10, pageNo: 1, totalPages: 3, startPage: 1, endPage: 3, first: 0, size: 10 }],
    ['page 0', { nextn: 10, pageno: 0 }, { nextN: 10, pageNo: 1, totalPages: 3, startPage: 1, endPage: 3, first: 0, size: 10 }],
    ['a negative page', { nextn: 10, pageno: -2 }, { nextN: 10, pageNo: 1, totalPages: 3, startPage: 1, endPage: 3, first: 0, size: 10 }],
  ])('pages %s with nextN, the buffer of 3 and the page clamp', async (_label, rc, expected) => {
    const all = ids(await loadComments(deps, ADMIN, { ...NO_DATES, nextn: FEED_SIZE }, SESSION));
    const page = await loadComments(deps, ADMIN, { ...NO_DATES, ...rc }, SESSION);
    const { first, size, ...window } = expected;
    expect(page).toMatchObject({ ...window, recordCount: FEED_SIZE });
    expect(ids(page)).toEqual(all.slice(first, first + size));
  });

  it('caps the feed at maxItems, 1000 by default', async () => {
    await loadComments(deps, ADMIN, NO_DATES, SESSION);
    expect(lastFeedArgs(store).maxItems).toBe(1000);
    const capped = await loadComments(deps, ADMIN, { ...NO_DATES, maxItems: 12 }, SESSION);
    expect(capped).toMatchObject({ recordCount: 12, totalPages: 1 });
    expect(capped.rows).toHaveLength(12);
  });

  it('lists the session site whatever rc.siteid says, `default` without one, with each row\'s active content', async () => {
    const page = await loadComments(deps, ADMIN, { ...NO_DATES, siteid: TENANT_B.siteId, nextn: FEED_SIZE }, SESSION);
    expect(page).toMatchObject({ siteId: SITE, recordCount: FEED_SIZE });
    expect(lastFeedArgs(store).siteId).toBe(SITE);
    expect(page.rows.every((row) => row.content?.contentid === row.comment.contentid)).toBe(true);
    const unset = await loadComments(deps, ADMIN, NO_DATES, { dateKeyFormat: SESSION.dateKeyFormat });
    expect(unset).toMatchObject({ siteId: 'default', recordCount: 0, rows: [] });
  });
});


describe('comment moderation', () => {
  const [T1, T2, T3, T4, T5] = [1, 2, 3, 4, 5].map((n) => cfId('T', n)) as [string, string, string, string, string];
  const [O1, O2] = [cfId('O', 1), cfId('O', 2)];
  let store: Store;
  let deps: Deps;

  beforeEach(() => {
    ({ store, deps } = memoryDeps(threadComments()));
  });

  const statOfThread = (): number | undefined => store.stats.get(`${THREAD_PAGE}|${SITE}`);
  const expectThreadRecount = (): void => {
    expect(setCommentStat).toHaveBeenCalledWith(expect.anything(), deps.repository, THREAD_PAGE, SITE, expect.objectContaining({ actorService: 'strategies-content' }));
  };

  it('approveComment approves, recounts the comment stat and returns the subscriber mails as notices, twice as legacy sends them, sending none', async () => {
    const result = await approveComment(deps, ADMIN, T1, COMMENT_SITE);
    expect(result).toMatchObject({ value: true, errors: {} });
    expect(flagsOf(store, T1)).toEqual(FLAGS.approved);
    expectThreadRecount();
    expect(statOfThread()).toBe(3);
    // The save's notification, then the manager's own notifySubscribers; spam, deleted and unsubscribed commenters get none.
    const round = ['amy@x.test', 'zed@x.test', 'editors@tenant-a.test'];
    expect(result.notices.map((notice) => notice.to)).toEqual([...round, ...round]);
    expect(result.notices[0]).toMatchObject({ kind: 'comment-subscriber', from: 'Tenant A', subject: "New Comment on 'Page 3'", siteId: SITE });
    expect(result.notices[0]?.body).toContain('commentUnsubscribe=amy%40x%2Etest');
    expect(result.notices[2]?.body).toContain('commentUnsubscribe=amy%40x%2Etest');
  });

  it.each<[string, (id: string) => Promise<boolean>, string, Pick<CommentRow, 'isapproved' | 'isspam' | 'isdeleted'>, number]>([
    ['unapproveComment', (id) => unapproveComment(deps, ADMIN, id, COMMENT_SITE), T2, FLAGS.unapproved, 1],
    ['deleteComment', (id) => deleteComment(deps, ADMIN, id), T2, FLAGS.deleted, 1],
    ['undeleteComment', (id) => undeleteComment(deps, ADMIN, id), T5, FLAGS.approved, 3],
    ['markAsSpam', (id) => markAsSpam(deps, ADMIN, id), T2, FLAGS.spam, 1],
    ['unmarkAsSpam', (id) => unmarkAsSpam(deps, ADMIN, id), T3, FLAGS.approved, 3],
  ])('%s writes the legacy flags in place, recounts the stat and answers true', async (_name, change, commentId, flags, stat) => {
    expect(await change(commentId)).toBe(true);
    expect(flagsOf(store, commentId)).toEqual(flags);
    expect(store.comments).toHaveLength(threadComments().length);
    expectThreadRecount();
    expect(statOfThread()).toBe(stat);
  });

  it.each<[string, (id: string) => Promise<boolean>, string]>([
    ['deleteComment', (id) => deleteComment(deps, VISITOR, id, { apiRequest: true }), T2],
    ['undeleteComment', (id) => undeleteComment(deps, VISITOR, id, { apiRequest: true }), T5],
    ['markAsSpam', (id) => markAsSpam(deps, VISITOR, id, { apiRequest: true }), T2],
    ['unmarkAsSpam', (id) => unmarkAsSpam(deps, VISITOR, id, { apiRequest: true }), T3],
  ])('%s on an API request without comment module access changes nothing and still answers true', async (_name, change, commentId) => {
    const before = flagsOf(store, commentId);
    expect(await change(commentId)).toBe(true);
    expect(flagsOf(store, commentId)).toEqual(before);
    expect(setCommentStat).not.toHaveBeenCalled();
  });

  it.each<[string, string | string[], Readonly<Record<string, Pick<CommentRow, 'isapproved' | 'isspam' | 'isdeleted'>>>]>([
    ['delete', `${T2},${T4}`, { [T2]: FLAGS.deleted, [T4]: FLAGS.deleted }],
    ['spam', [T5, T2], { [T5]: FLAGS.spam, [T2]: FLAGS.spam }],
    ['approve', `${T1},${T3},${T5}`, { [T1]: FLAGS.approved, [T3]: FLAGS.approved, [T5]: FLAGS.approved }],
    ['archive', T2, { [T2]: FLAGS.approved }],
  ])('bulkEdit %s applies the action to every id of ckupdate and reports processed', async (bulkedit, ckupdate, expected) => {
    const result = await bulkEdit(deps, ADMIN, { ckupdate, bulkedit, siteid: SITE }, COMMENT_SITE);
    expect(result.processed).toBe(true);
    for (const [commentId, flags] of Object.entries(expected)) {
      expect(flagsOf(store, commentId)).toEqual(flags);
    }
  });

  it('bulkEdit reports processed without ids, and false when bulkedit is missing or an id fails, ending the loop there', async () => {
    const swallowed = vi.fn();
    expect((await bulkEdit(deps, ADMIN, { ckupdate: '' }, COMMENT_SITE)).processed).toBe(true);
    expect((await bulkEdit(deps, ADMIN, { ckupdate: T2 }, COMMENT_SITE, { onSwallowedError: swallowed })).processed).toBe(false);
    const failed = await bulkEdit(deps, ADMIN, { ckupdate: `${T2},${BROKEN},${T4}`, bulkedit: 'spam' }, COMMENT_SITE, { onSwallowedError: swallowed });
    expect(failed.processed).toBe(false);
    expect([flagsOf(store, T2), flagsOf(store, T4)]).toEqual([FLAGS.spam, FLAGS.approved]);
    expect(swallowed.mock.calls.map(([, operation]: unknown[]) => operation)).toEqual(['bulkEdit', 'bulkEdit']);
  });

  it.each<[string, string, Pick<CommentRow, 'isapproved' | 'isspam' | 'isdeleted'>]>([
    ['approve', T1, FLAGS.approved],
    ['unapprove', T2, FLAGS.unapproved],
    ['delete', T2, FLAGS.deleted],
    ['spam', T2, FLAGS.spam],
    ['undelete', T5, FLAGS.approved],
    ['UnSpam', T3, FLAGS.approved],
  ])('singleEdit %s writes the legacy flags and leaves processed unset', async (updateAction, commentid, flags) => {
    const result = await singleEdit(deps, ADMIN, { commentid, updateAction }, COMMENT_SITE);
    expect(result).not.toHaveProperty('processed');
    expect(flagsOf(store, commentid)).toEqual(flags);
  });

  it('singleEdit reports processed false when the comment cannot be read, and ignores an unknown action', async () => {
    expect(await singleEdit(deps, ADMIN, { commentid: BROKEN, updateAction: 'spam' }, COMMENT_SITE)).toEqual({ processed: false, notices: [] });
    expect(await singleEdit(deps, ADMIN, { commentid: T2, updateAction: 'archive' }, COMMENT_SITE)).toEqual({ notices: [] });
    expect(flagsOf(store, T2)).toEqual(FLAGS.approved);
  });

  it.each<[string, (rc: Record<string, unknown>) => Promise<CommentRedirectResult>, string, Pick<CommentRow, 'isapproved' | 'isspam' | 'isdeleted'>]>([
    ['approve', (rc) => approveCommentAction(deps, ADMIN, rc, COMMENT_SITE), T1, FLAGS.approved],
    ['unapprove', (rc) => unapproveCommentAction(deps, ADMIN, rc, COMMENT_SITE), T2, FLAGS.unapproved],
    ['delete', (rc) => deleteCommentAction(deps, ADMIN, rc), T2, FLAGS.deleted],
    ['markAsSpam', (rc) => markAsSpamAction(deps, ADMIN, rc), T2, FLAGS.spam],
  ])('%s redirects to cComments.default preserving processed, isapproved and siteid', async (_name, action, commentid, flags) => {
    const done = await action({ commentid, siteid: SITE });
    expect(done.processed).toBe(true);
    expect(done.redirect).toEqual({ action: 'cComments.default', preserve: ['processed', 'isapproved', 'siteid'], path: './' });
    expect(flagsOf(store, commentid)).toEqual(flags);
    expect(await action({ siteid: SITE })).toEqual({ processed: false, notices: [], redirect: COMMENTS_DEFAULT_REDIRECT });
  });

  it('purgeDeletedComments removes only the deleted comments of the given site, or of every site without one', async () => {
    expect(await purgeDeletedComments(deps, ADMIN, SITE)).toBe(true);
    expect(store.comments.map((row) => row.commentid)).toEqual([T1, T2, T3, T4, O1, O2]);
    expect(await purgeDeletedComments(deps, ADMIN)).toBe(true);
    expect(store.comments.map((row) => row.commentid)).toEqual([T1, T2, T3, T4, O2]);
  });

  it('purgeDeletedCommentsAction purges rc.siteid and redirects; a failed purge answers false', async () => {
    const done = await purgeDeletedCommentsAction(deps, ADMIN, { siteid: OTHER_SITE });
    expect(done).toEqual({ processed: true, notices: [], redirect: COMMENTS_DEFAULT_REDIRECT });
    expect(store.comments.map((row) => row.commentid)).toEqual([T1, T2, T3, T4, T5, O2]);
    const swallowed = vi.fn();
    const failing: Deps = {
      ...deps,
      repository: { ...deps.repository, comments: { ...deps.repository.comments, purgeDeleted: () => Promise.reject(new Error('DELETE denied')) } },
    };
    expect(await purgeDeletedComments(failing, ADMIN, SITE, { onSwallowedError: swallowed })).toBe(false);
    expect(swallowed).toHaveBeenCalledWith(expect.any(Error), 'purgeDeletedComments');
  });
});


describe('saveComment (JSON API)', () => {
  const T2 = cfId('T', 2);
  const VALUES = { contentid: THREAD_PAGE, siteid: SITE, name: 'New Reader', email: 'new.reader@x.test', comments: 'Hello there', url: 'reader.example', subscribe: 1 };
  let store: Store;
  let deps: Deps;

  beforeEach(() => {
    ({ store, deps } = memoryDeps(threadComments()));
  });

  const input = (overrides: Partial<Parameters<typeof saveComment>[2]> = {}): Parameters<typeof saveComment>[2] => ({
    commentId: '',
    values: VALUES,
    site: COMMENT_SITE,
    remoteAddr: '203.0.113.7',
    ...overrides,
  });

  it('stores a new visitor comment under a fresh CF UUID with its commenter row, the approval default and the trash takeOut', async () => {
    const saved = await saveComment(deps, VISITOR, input());
    const commentId = saved.value.commentID;
    expect(isCfUuid(commentId)).toBe(true);
    expect(saved.errors).toEqual({});
    expect(saved.value).toMatchObject({ isNew: 0, isApproved: 0, url: 'http://reader.example' });
    expect(store.comments.find((row) => row.commentid === commentId)).toMatchObject({
      contentid: THREAD_PAGE,
      siteid: SITE,
      isapproved: 0,
      ip: '203.0.113.7',
      path: commentId,
      userid: saved.value.userID,
    });
    expect(store.commenters).toEqual([
      expect.objectContaining({ commenterid: saved.value.userID, remoteid: 'new.reader@x.test', name: 'New Reader', email: 'new.reader@x.test' }),
    ]);
    expect(takeOut).toHaveBeenCalledTimes(1);
    expect(takeOut).toHaveBeenCalledWith(expect.objectContaining({ commentID: commentId, contentID: THREAD_PAGE, isNew: 0 }));
    expect(setCommentStat).toHaveBeenCalledWith(expect.anything(), deps.repository, THREAD_PAGE, SITE, expect.anything());
  });

  it('reuses the commenter of a visitor e-mail, and approves and keys by user id the comment of a module user', async () => {
    const first = await saveComment(deps, VISITOR, input());
    const second = await saveComment(deps, VISITOR, input({ values: { ...VALUES, comments: 'Again' } }));
    expect(second.value.userID).toBe(first.value.userID);
    expect(store.commenters).toHaveLength(1);
    const moderated = await saveComment(deps, MODERATOR, input());
    expect(moderated.value.isApproved).toBe(1);
    expect(store.commenters.find((row) => row.commenterid === moderated.value.userID)?.remoteid).toBe(MODERATOR.userId);
  });

  it('returns the validation errors struct and writes nothing when comments and email are empty', async () => {
    const saved = await saveComment(deps, VISITOR, input({ values: { contentid: THREAD_PAGE, siteid: SITE, name: 'Nobody' } }));
    expect(saved.errors).toEqual({
      comments: "The property named 'comments' is not valid",
      email: "The property named 'email' is not valid",
    });
    expect(Object.keys(saved.errors)).toEqual(['comments', 'email']);
    expect(saved.notices).toEqual([]);
    expect(store.comments).toHaveLength(threadComments().length);
    expect(store.commenters).toEqual([]);
    expect(takeOut).not.toHaveBeenCalled();
    expect(setCommentStat).not.toHaveBeenCalled();
  });

  it('updates a stored comment without takeOut, and refuses a visitor without comment module access', async () => {
    const updated = await saveComment(deps, MODERATOR, input({ commentId: T2, values: { comments: 'Edited' } }));
    expect(updated.value).toMatchObject({ commentID: T2, isNew: 0, comments: 'Edited', isApproved: 1 });
    expect(takeOut).not.toHaveBeenCalled();
    const refused = saveComment(deps, VISITOR, input({ commentId: T2, values: { comments: 'Hijacked' } }));
    await expect(refused).rejects.toBeInstanceOf(LegacyApiError);
    await expect(refused).rejects.toMatchObject({ type: 'authorization' });
    expect(store.comments.find((row) => row.commentid === T2)?.comments).toBe('Edited');
  });
});

describe('ccomments admin routes', () => {
  const USER = cfId('U', 9);
  const PENDING = IDS.comments.unapproved;
  const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
  const REDIRECT = { circuit: 'cComments', action: 'default', params: [] };
  let testApp: TestApp;
  let db: RecordingDb;

  beforeAll(async () => {
    db = createRecordingDb();
    seedRecordingDb(db);
    // The recording pool's INSERT … RETURNING * echoes only the bound columns; PostgreSQL returns the whole commenter row.
    db.respond(/^INSERT INTO "?content"?\."?commenter"? \(/, (params, sql) => {
      const columns = (/\(([^)]*)\)/.exec(sql)?.[1] ?? '').split(',').map((column) => column.trim().replaceAll('"', ''));
      return [{ remoteid: null, email: null, name: null, ...Object.fromEntries(columns.map((column, index) => [column, params[index] ?? null])) }];
    });
    testApp = await buildTestApp({ db });
  });

  afterAll(async () => {
    await testApp?.close();
  });

  beforeEach(() => {
    db.clear();
  });

  const headersFor = (roles: readonly string[], s2 = false): Promise<Record<string, string>> => userHeaders({ sub: USER, site: SITE, roles, s2 });
  const bound = (pattern: RegExp, value: string): boolean =>
    db.statements.some((statement) => pattern.test(statement.sql) && JSON.stringify(statement.params).toLowerCase().includes(value.toLowerCase()));

  it.each<[string, readonly string[], boolean, number]>([
    ['s2', ['s2'], true, 200],
    ['site-admin', ['site-admin'], false, 200],
    ['m:015 with m:000', ['system-user', 'm:015', 'm:000'], false, 200],
    ['m:015 alone', ['system-user', 'm:015'], false, 403],
    ['m:000 alone', ['system-user', 'm:000'], false, 403],
    ['a system user', ['system-user'], false, 403],
  ])('the s2 | site-admin | (m:015 AND m:000) gate answers %s with %i', async (_label, roles, s2, status) => {
    const res = await testApp.app.inject({ method: 'GET', url: `/v1/sites/${SITE}/comments`, headers: await headersFor(roles, s2) });
    expect(res.statusCode).toBe(status);
    if (status === 200) expect(res.json()).toEqual({ rc: { siteid: SITE } });
  });

  it('answers 401 without a user token and 403 for another site than the token\'s', async () => {
    const anonymous = await testApp.app.inject({ method: 'GET', url: `/v1/sites/${SITE}/comments`, headers: await contentHeaders('anonymous') });
    expect(anonymous.statusCode).toBe(401);
    const foreign = await testApp.app.inject({ method: 'GET', url: `/v1/sites/${TENANT_B.siteId}/comments`, headers: await headersFor(['site-admin']) });
    expect(foreign.statusCode).toBe(403);
  });

  it.each(['approve', 'unapprove', 'delete', 'spam'])('POST %s redirects to cComments.default as saved, with no CSRF token', async (suffix) => {
    const res = await testApp.app.inject({ method: 'POST', url: `/v1/sites/${SITE}/comments/${PENDING}/${suffix}`, headers: await headersFor(['site-admin']) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: true, errors: {}, redirect: REDIRECT });
    expect(bound(/"content"\."comment"/, PENDING)).toBe(true);
  });

  it('POST purge-deleted purges the path site and redirects to cComments.default', async () => {
    const res = await testApp.app.inject({ method: 'POST', url: `/v1/sites/${SITE}/comments/purge-deleted`, headers: await headersFor(['site-admin']) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: true, errors: {}, redirect: REDIRECT });
    expect(bound(/"content"\."comment" WHERE tenant_id = \$1 AND \(isdeleted = 1 AND siteid = \$2\)/, SITE)).toBe(true);
  });

  it('POST bulk reports processed and POST of one comment leaves it unset, neither redirecting', async () => {
    const headers = { ...FORM, ...(await headersFor(['site-admin'])) };
    const bulk = await testApp.app.inject({ method: 'POST', url: `/v1/sites/${SITE}/comments/bulk`, headers, payload: `ckupdate=${PENDING}&bulkedit=delete` });
    expect(bulk.json()).toEqual({ saved: true, errors: {}, redirect: null, data: { processed: true } });
    const single = await testApp.app.inject({ method: 'POST', url: `/v1/sites/${SITE}/comments/${PENDING}`, headers, payload: 'updateAction=delete' });
    expect(single.json()).toEqual({ saved: true, errors: {}, redirect: null });
  });

  it('defaults the raw loadcomments siteid to the token site and refuses another site', async () => {
    const own = await testApp.app.inject({ method: 'GET', url: '/v1/raw/ccomments/loadcomments?commentStatus=approved', headers: await headersFor(['site-admin']) });
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toContain('text/html');
    expect(bound(/count\(\*\)::integer AS total FROM \(SELECT 1 FROM "content"\."comment"/, SITE)).toBe(true);
    const foreign = await testApp.app.inject({
      method: 'GET',
      url: `/v1/raw/ccomments/loadcomments?siteid=${TENANT_B.siteId}`,
      headers: await headersFor(['site-admin']),
    });
    expect(foreign.statusCode).toBe(403);
  });
});

