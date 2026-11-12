/** Masa content statistics and ratings ↔ `content.content_stats` and `content.content_rating`. */
import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { CONTENT_RATING, CONTENT_STATS } from '../../repo/tables.js';

/** Masa `tcontentstats` ↔ `content.content_stats` [mssql.sql:67-76, 5.6.cfm:94-196, 6.1.cfm:159-161]; tenant from `siteID`. */
export const tcontentstatsMapping: Mapping = defineMapping({
  legacyTable: 'tcontentstats',
  targetTable: CONTENT_STATS.unit,
  unit: CONTENT_STATS.unit,
  columns: [
    { legacy: 'contentID', target: 'contentid', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'views', target: 'views', type: 'i' },
    // SQL Server float: compared as its shortest round-trip decimal.
    { legacy: 'rating', target: 'rating', type: 'f' },
    { legacy: 'totalVotes', target: 'totalvotes', type: 'i' },
    { legacy: 'upVotes', target: 'upvotes', type: 'i' },
    { legacy: 'downVotes', target: 'downvotes', type: 'i' },
    { legacy: 'comments', target: 'comments', type: 'i' },
    { legacy: 'majorVersion', target: 'majorversion', type: 'i' },
    { legacy: 'minorVersion', target: 'minorversion', type: 'i' },
    { legacy: 'lockID', target: 'lockid', type: 's' },
    { legacy: 'lockType', target: 'locktype', type: 's' },
    { legacy: 'disableComments', target: 'disablecomments', type: 'i' },
  ],
  key: ['contentID', 'siteID'],
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tcontentratings` ↔ `content.content_rating` [mssql.sql:214-220]; tenant from `siteID`. */
export const tcontentratingsMapping: Mapping = defineMapping({
  legacyTable: 'tcontentratings',
  targetTable: CONTENT_RATING.unit,
  unit: CONTENT_RATING.unit,
  columns: [
    { legacy: 'contentID', target: 'contentid', type: 's' },
    { legacy: 'userID', target: 'userid', type: 's' },
    // char(25) on both sides: the value keeps its space padding, which resolveTenant trims before deriving the tenant.
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'rate', target: 'rate', type: 'i' },
    { legacy: 'entered', target: 'entered', type: 't' },
  ],
  key: ['contentID', 'userID', 'siteID'],
  tenant: { kind: 'site', column: 'siteID' },
});
