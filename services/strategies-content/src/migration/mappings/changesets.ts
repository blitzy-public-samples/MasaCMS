/** Migration mappings of Masa `tchangesets` and its ORM child tables onto the `content` change-set tables. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { CHANGESET, CHANGESET_CATEGORY_ASSIGN, CHANGESET_ROLLBACK, CHANGESET_TAG_ASSIGN } from '../../repo/tables.js';
import type { ContentUnitTableDefinition } from '../../repo/tables.js';

/**
 * Mapping of `legacyTable` onto `table`, whose unit it gates.
 * @param legacyColumns live-catalog spelling and order; each maps to the `table` column of its lower-cased name and type.
 * @param siteColumn the row's own site column; a row whose site is empty or unknown loads under the umbrella tenant as an orphan.
 */
function changesetMapping(
  legacyTable: string,
  table: ContentUnitTableDefinition,
  legacyColumns: readonly string[],
  key: string[],
  siteColumn: string,
): Mapping {
  const columns = legacyColumns.map((legacy): MappingColumn => {
    const target = table.columns.find((column) => column.name === legacy.toLowerCase());
    if (target === undefined) throw new MappingError(legacyTable, `${table.unit} declares no column for ${legacy}`);
    return { legacy, target: target.name, type: target.type };
  });
  return defineMapping({
    legacyTable,
    // defineMapping needs a schema-qualified target: `table.unit` is that name, `table.table` the repository's unqualified one.
    targetTable: table.unit,
    unit: table.unit,
    columns,
    key,
    tenant: { kind: 'site', column: siteColumn },
  });
}

/** Masa `tchangesets` ↔ `content.changeset`, keyed by `changesetID`. */
export const tchangesetsMapping: Mapping = changesetMapping(
  'tchangesets',
  CHANGESET,
  [
    'changesetID',
    'siteID',
    'name',
    'description',
    'created',
    'publishDate',
    'published',
    'lastUpdate',
    'lastUpdateBy',
    'lastUpdateByID',
    'remoteID',
    'remotePubDate',
    'remoteSourceURL',
    'closeDate',
  ],
  ['changesetID'],
  'siteID',
);

/** ORM `tchangesetrollback` ↔ `content.changeset_rollback`, keyed by `rollbackID`. */
export const tchangesetrollbackMapping: Mapping = changesetMapping(
  'tchangesetrollback',
  CHANGESET_ROLLBACK,
  ['siteID', 'rollbackID', 'changesetID', 'previousHistID', 'changesetHistID'],
  ['rollbackID'],
  'siteID',
);

/** ORM `tchangesetcategoryassign` ↔ `content.changeset_category_assign`, keyed by `assignmentid`. */
export const tchangesetcategoryassignMapping: Mapping = changesetMapping(
  'tchangesetcategoryassign',
  CHANGESET_CATEGORY_ASSIGN,
  ['siteid', 'categoryid', 'changesetid', 'assignmentid'],
  ['assignmentid'],
  'siteid',
);

/** ORM `tchangesettagassign` ↔ `content.changeset_tag_assign`, keyed by `assignmentid`. */
export const tchangesettagassignMapping: Mapping = changesetMapping(
  'tchangesettagassign',
  CHANGESET_TAG_ASSIGN,
  ['siteid', 'changesetid', 'assignmentid', 'tag'],
  ['assignmentid'],
  'siteid',
);
