/** Migration-kit mappings of Masa `tcontentcomments` and the ORM table `tcontentcommentcommenters` into schema `content`. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { COMMENT, COMMENTER } from '../../repo/tables.js';
import type { ContentUnitTableDefinition } from '../../repo/tables.js';

/** Mapped columns for legacy column names, each taking the name and canonical type of its lower-cased target column. */
function columnsOf(legacyTable: string, definition: ContentUnitTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} has no column ${name.toLowerCase()}`);
    const { name: target, ...type } = column;
    return { legacy: name, target, ...type };
  });
}

/** Masa `tcontentcomments` ↔ `content.comment`, keyed by `commentid`; tenant from `siteid`, umbrella orphan when null. */
export const tcontentcommentsMapping: Mapping = defineMapping({
  legacyTable: 'tcontentcomments',
  targetTable: COMMENT.unit,
  unit: COMMENT.unit,
  // Live-catalog order: core/setup/db/mssql.sql:118-130, then 5.0.746.cfm:11, 5.2.0.cfm:56, 5.2.1990.cfm:16-19, 5.6.cfm:289 and 6.1.cfm:164-166.
  columns: columnsOf('tcontentcomments', COMMENT, [
    'commentid', 'contentid', 'contenthistid', 'url', 'name', 'comments', 'entered', 'email', 'siteid', 'ip',
    'isApproved', 'subscribe', 'userID', 'parentID', 'path', 'remoteID', 'flagCount', 'isSpam', 'isDeleted',
  ]),
  key: COMMENT.key,
  tenant: { kind: 'site', column: 'siteid' },
});

/** Masa ORM `tcontentcommentcommenters` ↔ `content.commenter`, keyed by `commenterID`; tenant from the comments it authored. */
export const tcontentcommentcommentersMapping: Mapping = defineMapping({
  legacyTable: 'tcontentcommentcommenters',
  targetTable: COMMENTER.unit,
  unit: COMMENTER.unit,
  // Live-catalog order of the ORM schema generated from core/mura/content/contentCommenterBean.cfc:79-82.
  columns: columnsOf('tcontentcommentcommenters', COMMENTER, ['remoteID', 'commenterID', 'email', 'name']),
  key: COMMENTER.key,
  // The table has no siteID: the tenant is that of the tcontentcomments rows whose userID is this commenterID. A
  // commenter with no such comment, or with comments in several tenants, loads under the umbrella as an orphan.
  tenant: { kind: 'parent', parentLegacyTable: 'tcontentcomments', columns: { commenterID: 'userID' } },
});
