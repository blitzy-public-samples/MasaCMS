/** Content stats (contentStatsBean) and the read-only content rating queries (raterManager); rating writes stay on legacy. */
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { AvgRatingRow, ContentRepository, TopRatedArgs, TopRatedRow } from '../repo/repository.js';
import type { FileRow } from '../repo/tables.js';

/** A stats bean's values, keyed as `contentStatsBean.init()` keys them. */
export interface ContentStats {
  contentID: string;
  siteID: string;
  views: number;
  rating: number;
  totalVotes: number;
  upVotes: number;
  downVotes: number;
  comments: number;
  disableComments: number;
  majorVersion: number;
  minorVersion: number;
  lockID: string;
  lockType: string;
  /** 0 once `load()` found the item's row (bean.set of a non-empty query); absent otherwise. */
  isNew?: 0;
}

/** A rate bean's values: one user's rating of an item. */
export interface ContentRate {
  contentID: string;
  userID: string;
  siteID: string;
  entered: Date;
  rate: number;
  isNew: 0 | 1;
}

/** A `raterManager.getTopRated` row: the grouped content columns, `theavg`, `thecount` and the left-joined file columns. */
export type TopRated = Omit<TopRatedRow, 'fileid'> & Pick<FileRow, 'filesize' | 'fileext' | 'contenttype' | 'contentsubtype'>;

const NUMERIC_FIELDS = [
  'views',
  'rating',
  'totalVotes',
  'upVotes',
  'downVotes',
  'comments',
  'disableComments',
  'majorVersion',
  'minorVersion',
] as const;
const STRING_FIELDS = ['contentID', 'siteID', 'lockID', 'lockType'] as const;

// CFML struct keys are case-insensitive, so values are matched to fields by lower-cased key.
const NUMERIC_BY_KEY = new Map(NUMERIC_FIELDS.map((field) => [field.toLowerCase(), field]));
const STRING_BY_KEY = new Map(STRING_FIELDS.map((field) => [field.toLowerCase(), field]));

/** contentStatsBean `cfproperty` defaults and `init()` values, in `init()` order [contentStatsBean.cfc:79-112]. */
export const STATS_DEFAULTS: Readonly<ContentStats> = Object.freeze({
  contentID: '',
  siteID: '',
  views: 0,
  rating: 0,
  totalVotes: 0,
  upVotes: 0,
  downVotes: 0,
  comments: 0,
  disableComments: 0,
  majorVersion: 0,
  minorVersion: 0,
  lockID: '',
  lockType: '',
});

// ACF trim (Java String.trim) and isNumeric (decimal text whose double value is finite).
const EDGE_SPACE = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/gu;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;

function cfTrim(text: string): string {
  return text.replace(EDGE_SPACE, '');
}

function cfNumeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = cfTrim(value);
  const number = Number(text);
  return DECIMAL.test(text) && Number.isFinite(number) ? number : undefined;
}

/**
 * The stats bean setters applied to `values` [contentStatsBean.cfc:119-184]: numeric fields take numeric values only
 * (anything else leaves the field unchanged), string fields are trimmed as `setValue` trims them, and NULL reads as ''.
 * Keys match case-insensitively; keys that are not bean fields are ignored.
 */
export function setStatsValues(stats: Readonly<ContentStats>, values: object): ContentStats {
  const next: ContentStats = { ...stats };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const numericField = NUMERIC_BY_KEY.get(key.toLowerCase());
    if (numericField !== undefined) {
      const number = cfNumeric(value);
      if (number !== undefined) next[numericField] = number;
      continue;
    }
    const stringField = STRING_BY_KEY.get(key.toLowerCase());
    if (stringField !== undefined) next[stringField] = value === null ? '' : cfTrim(String(value));
  }
  return next;
}

/** contentStatsBean `load()`: the item's stored row over the defaults, or the defaults when it has none; never inserts. */
export async function loadStats(tx: TenantTx, repository: ContentRepository, contentId: string, siteId: string): Promise<ContentStats> {
  const stats = setStatsValues(STATS_DEFAULTS, { contentID: contentId, siteID: siteId });
  const row = await repository.stats.readStats(tx, { contentId: stats.contentID, siteId: stats.siteID });
  return row === null ? stats : { ...setStatsValues(stats, row), isNew: 0 };
}

/** contentStatsBean `getAllValues()`: the legacy-keyed struct, each field passed through its bean setter over the defaults. */
export function statsValues(stats: object): ContentStats {
  const values = setStatsValues(STATS_DEFAULTS, stats);
  return (stats as { isNew?: unknown }).isNew === 0 ? { ...values, isNew: 0 } : values;
}

/**
 * contentStatsBean `save()` in the caller's gated transaction: updates the item's row when it exists, else inserts it.
 * @returns the stats as stored, keeping the input's load state.
 */
export async function saveStatsInTx(
  tx: TenantTx,
  repository: ContentRepository,
  stats: Readonly<ContentStats>,
  ctx?: WriteContext,
): Promise<ContentStats> {
  const row = await repository.stats.upsertStats(
    tx,
    {
      contentId: stats.contentID,
      siteId: stats.siteID,
      views: stats.views,
      rating: stats.rating,
      totalvotes: stats.totalVotes,
      upvotes: stats.upVotes,
      downvotes: stats.downVotes,
      comments: stats.comments,
      disablecomments: stats.disableComments,
      majorversion: stats.majorVersion,
      minorversion: stats.minorVersion,
      lockid: stats.lockID,
      locktype: stats.lockType,
    },
    ctx,
  );
  return setStatsValues(stats, row);
}

/**
 * contentManager.setCommentStat [contentManager.cfc:2468-2480]: stores the item's count of approved, non-spam,
 * non-deleted comments (contentDAO.getCommentCount); the item lock, taken before counting and held until commit,
 * stands in for the legacy `cflock`.
 * @returns the item's stats as now stored.
 */
export async function setCommentStat(
  tx: TenantTx,
  repository: ContentRepository,
  contentId: string,
  siteId: string,
  ctx?: WriteContext,
): Promise<ContentStats> {
  const key = setStatsValues(STATS_DEFAULTS, { contentID: contentId, siteID: siteId });
  const row = await repository.stats.setCommentCount(tx, { contentId: key.contentID, siteId: key.siteID }, ctx);
  return { ...setStatsValues(key, row), isNew: 0 };
}

/**
 * raterManager.readRate [raterManager.cfc:153-166]: the user's rating of the item, or the rate bean defaults
 * (rate 0, `entered` = `now`) when there is none.
 */
export async function readRate(
  tx: TenantTx,
  repository: ContentRepository,
  args: { contentId: string; siteId: string; userId: string; now?: Date },
): Promise<ContentRate> {
  const key = { contentId: cfTrim(args.contentId), siteId: cfTrim(args.siteId), userId: cfTrim(args.userId) };
  const now = args.now ?? new Date();
  const row = await repository.stats.readRate(tx, key);
  if (row === null) {
    return { contentID: key.contentId, userID: key.userId, siteID: key.siteId, entered: now, rate: 0, isNew: 1 };
  }
  // Each column goes through setValue's trim (char(25) siteid is space-padded); a NULL entered fails setEntered's isDate
  // and a NULL rate fails getRate's isNumeric, so both keep their defaults.
  return {
    contentID: cfTrim(row.contentid),
    userID: cfTrim(row.userid),
    siteID: cfTrim(row.siteid),
    entered: row.entered ?? now,
    rate: row.rate ?? 0,
    isNew: 0,
  };
}

/**
 * raterManager.getAvgRating [raterManager.cfc:168-189]: SQL Server's integer `avg(rate)`, the vote count, up votes and
 * down votes (rate 1, null when there are none); null when the item has no ratings.
 */
export function getAvgRating(tx: TenantTx, repository: ContentRepository, contentId: string, siteId: string): Promise<AvgRatingRow | null> {
  return repository.stats.avgRating(tx, { contentId, siteId });
}

/**
 * raterManager.getTopRated [raterManager.cfc:191-266]: the site's active rated content by integer average then vote
 * count, with the columns of the version's file in the same site (null when it has none).
 */
export async function getTopRated(tx: TenantTx, repository: ContentRepository, args: TopRatedArgs): Promise<TopRated[]> {
  const rows = await repository.stats.topRated(tx, args);
  const fileIds = [...new Set(rows.flatMap((row) => (row.fileid === null ? [] : [row.fileid])))];
  const files = new Map((await repository.content.fileJoinColumns(tx, fileIds)).map((file) => [file.fileid.toLowerCase(), file]));
  return rows.map(({ fileid, ...row }) => {
    const file = fileid === null ? undefined : files.get(fileid.toLowerCase());
    return {
      ...row,
      filesize: file?.filesize ?? null,
      fileext: file?.fileext ?? null,
      contenttype: file?.contenttype ?? null,
      contentsubtype: file?.contentsubtype ?? null,
    };
  });
}
