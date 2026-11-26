/** Legacy SQL Server widths of the content tables' text columns, and the guard that holds target rows to them. */
import { RepositoryError } from '@opt2/platform/migration-kit';

import type { ContentUnitTableName } from './tables.js';

/**
 * Width in UTF-16 code units of each finite `char`, `nchar`, `varchar` and `nvarchar` column of every unit's legacy table,
 * by target column, as `opt2/inventory/live-catalog.json` records it; `max` columns have none.
 */
const LEGACY_LIMITS = {
  approval_action: { siteid: 25, actiontype: 50, userid: 35, groupid: 35, actiontid: 35, requestid: 35, parentid: 35, chainid: 35 },
  approval_assignment: { siteid: 25, assignmentid: 35, contentid: 35, chainid: 35 },
  approval_chain: { siteid: 25, chainid: 35, name: 100, lastupdateby: 50, lastupdatebyid: 35 },
  approval_membership: { groupid: 35, siteid: 25, membershipid: 35, chainid: 35 },
  approval_request: { siteid: 25, userid: 35, groupid: 35, status: 50, contenthistid: 35, requestid: 35, chainid: 35 },
  category: {
    categoryid: 35, siteid: 25, parentid: 35, lastupdateby: 50, name: 50, sortby: 50, sortdirection: 50, restrictgroups: 255, remoteid: 255,
    remotesourceurl: 255, urltitle: 255, filename: 255,
  },
  changeset: { changesetid: 35, siteid: 25, name: 100, lastupdateby: 50, lastupdatebyid: 35, remoteid: 255, remotesourceurl: 255 },
  changeset_category_assign: { siteid: 25, categoryid: 35, changesetid: 35, assignmentid: 35 },
  changeset_rollback: { siteid: 25, rollbackid: 35, changesetid: 35, previoushistid: 35, changesethistid: 35 },
  changeset_tag_assign: { siteid: 25, changesetid: 35, assignmentid: 35, tag: 100 },
  comment: {
    commentid: 35, contentid: 35, contenthistid: 35, url: 255, name: 50, email: 100, siteid: 25, ip: 50, userid: 35, parentid: 35,
    remoteid: 35,
  },
  commenter: { remoteid: 50, commenterid: 35, email: 50, name: 50 },
  content: {
    siteid: 25, moduleid: 35, parentid: 35, contentid: 35, contenthistid: 35, remoteid: 255, remoteurl: 255, remotepubdate: 50,
    remotesourceurl: 255, remotesource: 255, credits: 255, fileid: 35, template: 50, type: 25, subtype: 25, title: 255, menutitle: 255,
    filename: 255, lastupdateby: 50, lastupdatebyid: 50, restrictgroups: 255, target: 50, targetparams: 255, moduleassign: 255,
    inheritobjects: 25, sortby: 50, sortdirection: 50, audience: 255, urltitle: 255, htmltitle: 255, changesetid: 35, imagesize: 50,
    imageheight: 15, imagewidth: 15, childtemplate: 50, displayinterval: 200,
  },
  content_assignment: { contentid: 35, contenthistid: 35, siteid: 50, userid: 35, type: 50 },
  content_category_assign: { contenthistid: 35, categoryid: 35, contentid: 35, siteid: 25 },
  content_object: { contenthistid: 35, objectid: 100, object: 50, contentid: 35, name: 255, siteid: 25 },
  content_rating: { contentid: 35, userid: 35, siteid: 25 },
  content_related: { contenthistid: 35, relatedid: 35, contentid: 35, siteid: 25, relatedcontentsetid: 35 },
  content_remote_pointer: { siteid: 25, remoteid: 50, remoteurl: 250, created: 50, pointerid: 35, contentid: 35 },
  content_stats: { contentid: 35, siteid: 25, lockid: 35, locktype: 50 },
  content_tag: { contenthistid: 35, contentid: 35, siteid: 25, tag: 100, taggroup: 255 },
  display_title_approval: { contentid: 35, email: 150, siteid: 25 },
  extend_attribute: {
    extendsetid: 35, siteid: 25, name: 100, type: 100, required: 50, validation: 50, regex: 300, message: 300, defaultvalue: 100,
  },
  extend_data: { baseid: 35, siteid: 25, remoteid: 35, stringvalue: 255 },
  extend_rc_set: { subtypeid: 35, siteid: 25, entitytype: 100, name: 50, relatedcontentsetid: 35 },
  extend_set: { extendsetid: 35, subtypeid: 35, siteid: 25, name: 50, container: 50 },
  extend_subtype: {
    subtypeid: 35, siteid: 25, basetable: 50, basekeyfield: 50, datatable: 50, type: 50, subtype: 50, lastupdateby: 100, iconclass: 50,
  },
  feed: {
    feedid: 35, siteid: 25, parentid: 35, name: 250, lang: 50, lastupdateby: 100, version: 50, type: 50, sortby: 50, sortdirection: 50,
    altname: 250, remoteid: 255, remotesourceurl: 255, imagesize: 50, imageheight: 15, imagewidth: 15, viewalllink: 255, viewalllabel: 100,
    cssclass: 255, authtype: 10,
  },
  feed_advanced_param: { paramid: 35, feedid: 35, relationship: 50, field: 100, condition: 50, criteria: 200, datatype: 50 },
  feed_item: { feedid: 35, itemid: 35, type: 50 },
  file: {
    fileid: 35, contentid: 35, siteid: 25, moduleid: 35, filename: 200, contenttype: 100, contentsubtype: 200, fileext: 50, credits: 255,
    alttext: 255, remoteid: 255, remoteurl: 255, remotesource: 255, remotesourceurl: 255,
  },
  file_metadata: {
    alttext: 255, contenthistid: 35, fileid: 35, siteid: 25, remoteurl: 255, remoteid: 255, remotesourceurl: 255, remotesource: 255,
    metaid: 35, contentid: 35,
  },
  filename_archive: { siteid: 25, archiveid: 35, contentid: 35, filename: 255 },
  form_response_packet: { responseid: 35, formid: 35, siteid: 25 },
  form_response_question: { responseid: 35, formid: 35, formfield: 50, pollvalue: 255 },
  public_submission_approval: { contentid: 35, email: 150, siteid: 25 },
  source_map: { siteid: 25, sourceid: 35, contenthistid: 35, mapid: 35, contentid: 35 },
  trash: {
    objectid: 35, parentid: 35, siteid: 25, objectlabel: 255, objectclass: 50, objecttype: 50, objectsubtype: 50, deletedby: 50,
    deleteid: 35,
  },
  variation_targeting: { targetingid: 35, siteid: 25, contentid: 35 },
} as const satisfies Record<ContentUnitTableName, Readonly<Record<string, number>>>;

/** A content table whose legacy column widths `legacyStorable` enforces. */
export type LegacyLimitedTable = keyof typeof LEGACY_LIMITS;

/** True for a table `legacyStorable` holds to legacy widths. */
export function isLegacyLimited(table: string): table is LegacyLimitedTable {
  return Object.hasOwn(LEGACY_LIMITS, table);
}

/**
 * `row` as legacy SQL Server stores it: text beyond its width by trailing spaces only is cut to the width, as
 * ANSI_WARNINGS allows; any other text beyond its width throws LegacyStorageError. NULL and absent values pass.
 */
export function legacyStorable<R extends Readonly<Record<string, unknown>>>(table: LegacyLimitedTable, row: R): R {
  let stored = row;
  for (const [column, limit] of Object.entries<number>(LEGACY_LIMITS[table])) {
    const value = row[column];
    if (typeof value !== 'string' || value.length <= limit) continue;
    if (!/^ +$/.test(value.slice(limit))) throw new LegacyStorageError(table, column, limit);
    stored = { ...stored, [column]: value.slice(0, limit) };
  }
  return stored;
}

/** Raised for text wider than its legacy column, writing nothing; unhandled, it answers the legacy 500 of the failed legacy query. */
export class LegacyStorageError extends RepositoryError {
  override readonly name: string = 'LegacyStorageError';

  constructor(
    override readonly table: LegacyLimitedTable,
    readonly column: string,
    readonly limit: number,
  ) {
    super(`column ${column} is beyond the legacy width ${limit}`, table);
  }
}
