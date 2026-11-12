/**
 * Read-only SQL of the content tree, ported from Masa `contentGateway` (the Adobe gateway, legacy's engine) and the
 * read paths of `contentDAO`. Every function runs in the caller's tenant transaction, whose RLS scopes the rows;
 * `./repository.ts` re-exposes them as `repo.content.*` and owns every write.
 *
 * SQL Server semantics are reproduced where results depend on them: text equality, LIKE and grouping are
 * case-insensitive (SQL_Latin1_General_CP1_CI_AS), text sorts through lower(), and NULLs sort lowest.
 */
import { awaitReadable, qualified } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import {
  APPROVAL_ASSIGNMENT,
  APPROVAL_REQUEST,
  CATEGORY_ASSIGN,
  CHANGESET,
  COMMENT,
  CONTENT,
  CONTENT_ASSIGNMENT,
  CONTENT_OBJECT,
  CONTENT_RELATED,
  CONTENT_STATS,
  CONTENT_TAG,
  EXTEND_ATTRIBUTE,
  EXTEND_DATA,
  EXTEND_RCSET,
  FILE,
  FILE_METADATA,
  FORM_RESPONSE_PACKET,
  UNIT_OF,
  type CategoryAssignRow,
  type ContentAssignmentRow,
  type ContentObjectRow,
  type ContentRelatedRow,
  type ContentRow,
  type ContentStatsRow,
  type ContentUnit,
  type FileRow,
} from './tables.js';

/** The changeset preview a session user selected (legacy `ChangesetPreviewData`), supplied only for that preview's site. */
export interface ChangesetPreview {
  contentIds: readonly string[];
  contentHistIds: readonly string[];
}

/** A SQL predicate or clause and the values its placeholders bind, in placeholder order. */
export interface SqlFragment {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Collects bound values and numbers their `$n` placeholders from `offset + 1`. */
export class SqlParams {
  readonly values: unknown[] = [];
  readonly #offset: number;

  constructor(offset = 0) {
    this.#offset = offset;
  }

  /** The offset a builder must number from so that its fragment can be `include`d next. */
  get next(): number {
    return this.#offset + this.values.length;
  }

  /** Binds `value` and returns its placeholder. */
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.next}`;
  }

  /** Appends a fragment built with `offset: this.next` and returns its SQL. */
  include(fragment: SqlFragment): string {
    this.values.push(...fragment.params);
    return fragment.sql;
  }

  /** `sql` with the values bound so far. */
  fragment(sql: string): SqlFragment {
    return { sql, params: [...this.values] };
  }
}

/** Raised where the legacy query fails at the database, so the caller answers as legacy's error path does. */
export class ContentQueryError extends Error {
  override readonly name = 'ContentQueryError';
}

/** Module id of the site tree (`00000000000000000000000000000000000`). */
export const SITE_TREE_MODULE_ID = '00000000000000000000000000000000000';
/** Parent id of a site's home page; the crumb walk stops there. */
export const ROOT_PARENT_ID = '00000000000000000000000000000000END';

// getReadOnlyQRYAttrs(maxrows=1000) of the search, expiring-content and locked-content queries.
const LEGACY_MAX_ROWS = 1000;
// ACF isValid("UUID"): the 35-character CF form 8-4-4-16.
const CF_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/i;
const VERSION_TYPES = ['Page', 'Folder', 'File', 'Calendar', 'Link', 'Gallery', 'Component', 'Form', 'Variation', 'Module'];
const IMAGE_EXTENSIONS = ['png', 'gif', 'jpg', 'jpeg'];

type Nullable<T> = { [K in keyof T]: T[K] | null };
type Def = { readonly table: string; readonly columns: readonly { readonly name: string }[] };
type ColumnOf<D extends Def> = D['columns'][number]['name'];

/** Qualified names of the tables these reads join, in the transaction's schema. */
function tablesFor(schema: string) {
  const name = (def: Def): string => qualified(schema, def.table);
  return {
    content: name(CONTENT),
    object: name(CONTENT_OBJECT),
    related: name(CONTENT_RELATED),
    tag: name(CONTENT_TAG),
    categoryAssign: name(CATEGORY_ASSIGN),
    stats: name(CONTENT_STATS),
    assignment: name(CONTENT_ASSIGNMENT),
    file: name(FILE),
    fileMetadata: name(FILE_METADATA),
    approvalAssignment: name(APPROVAL_ASSIGNMENT),
    approvalRequest: name(APPROVAL_REQUEST),
    changeset: name(CHANGESET),
    extendData: name(EXTEND_DATA),
    extendAttribute: name(EXTEND_ATTRIBUTE),
    relatedContentSet: name(EXTEND_RCSET),
    comment: name(COMMENT),
    formResponsePacket: name(FORM_RESPONSE_PACKET),
  };
}

/** `alias.column` for each listed column of `def`, comma-separated. */
function columns<D extends Def>(_def: D, alias: string, names: readonly ColumnOf<D>[]): string {
  return names.map((name) => `${alias}.${name}`).join(', ');
}

/** Runs `sql` in `tx`; the caller has already awaited readability of every unit it reads. */
async function run<R extends Record<string, unknown>>(tx: TenantTx, sql: string, params: readonly unknown[]): Promise<R[]> {
  const { rows } = await tx.query<R>(sql, [...params]);
  return rows;
}

/** Waits out a write window on the units of `tables`, so the reads that follow see no superseded rows. */
function readable(tx: TenantTx, ...tables: (keyof typeof UNIT_OF)[]): Promise<void> {
  return awaitReadable(tx, tables.map((table): ContentUnit => UNIT_OF[table]));
}

/** The elements of a CF list: comma-separated, empty elements skipped. */
function cfList(value: string | null | undefined): string[] {
  return (value ?? '').split(',').filter((item) => item.length > 0);
}

/** SQL Server `expr = value`: case-insensitive, trailing spaces ignored. */
function ciEq(p: SqlParams, expr: string, value: unknown): string {
  return `lower(rtrim(${expr})) = lower(rtrim(${p.add(value)}::text))`;
}

/** SQL Server `expr LIKE pattern`: case-insensitive and without an escape character. */
function ciLike(p: SqlParams, expr: string, pattern: string): string {
  return `upper(${expr}) LIKE upper(${p.add(pattern)}::text) ESCAPE ''`;
}

/** SQL Server `expr IN (values)` under its case-insensitive collation. */
function ciIn(p: SqlParams, expr: string, values: readonly string[]): string {
  return `lower(rtrim(${expr})) IN (SELECT lower(rtrim(v)) FROM unnest(${p.add(values)}::text[]) AS v)`;
}

/** The forms a stored single-case CF id may take for a caller-supplied id. */
function idForms(ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((id) => [id, id.toUpperCase(), id.toLowerCase()]))];
}

// Stored ids are single-case CF UUIDs, so matching the listed, upper- and lower-case forms as bpchar reproduces SQL
// Server's case- and trailing-space-insensitive id equality while the id indexes still apply.
/** SQL Server `expr = id` for an id column. */
function idEq(p: SqlParams, expr: string, id: string): string {
  return `${expr} = ANY(${p.add(idForms([id]))}::bpchar[])`;
}

/** SQL Server `expr IN (ids)` for an id column. */
function idIn(p: SqlParams, expr: string, ids: readonly string[]): string {
  return `${expr} = ANY(${p.add(idForms(ids))}::bpchar[])`;
}


/** A text column as SQL Server sorts it under a case-insensitive collation. */
function textSort(expr: string): string {
  return `lower(${expr})`;
}

/** One ORDER BY key with SQL Server's NULL placement: lowest, so first ascending and last descending. */
function orderKey(expr: string, direction: SortDirection): string {
  return `${expr} ${direction.toUpperCase()} NULLS ${direction === 'asc' ? 'FIRST' : 'LAST'}`;
}

/** CF `dateAdd("d", days, date)`: calendar days, wall-clock time kept. */
function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

/** CF `dateAdd("m", months, date)`: calendar months, the day clamped to the target month's length. */
function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(date.getDate(), lastDay));
  return result;
}

/** CF `createDate(year, month, 1)`. */
function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** CF `dateAdd("D", 1, createDate(year, month, daysInMonth))`: midnight starting the next month. */
function nextMonthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

/** CF `createDate(year, 1, 1)`. */
function yearStart(date: Date): Date {
  return new Date(date.getFullYear(), 0, 1);
}

/** CF `dateAdd("D", 1, createDate(year, 12, 31))`. */
function nextYearStart(date: Date): Date {
  return new Date(date.getFullYear() + 1, 0, 1);
}

/** CF `createDateTime(year, month, day, hour, minute, second)` on the date's own day. */
function onDay(date: Date, hour: number, minute: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0);
}

/**
 * `utility.datetimeToTimespanInterval` on Adobe ColdFusion: `date` rounded down to a multiple of the timespan plus one
 * second (Adobe's branch adds it), counted from the Unix epoch. `seconds` is the legacy timespan, 5 minutes when 0.
 */
export function timespanInterval(date: Date, seconds = 300): Date {
  const span = (seconds > 0 ? seconds : 300) + 1;
  const epochSeconds = Math.trunc(date.getTime() / 1000);
  return new Date(Math.trunc(epochSeconds / span) * span * 1000);
}

/** Options of `activeClause`: legacy `liveOnly` and `activeOnly` (both default true) and the placeholder offset. */
export interface ActiveClauseOptions {
  liveOnly?: boolean;
  activeOnly?: boolean;
  offset?: number;
}

/**
 * `contentGateway.renderActiveClause` (liveOnly), `contentDAO.renderActiveClause` (`liveOnly: false`) and the
 * `feedGateway.renderActiveClause` form, as a predicate without the leading AND. A non-empty `preview` also admits
 * its versions in place of their live ones.
 */
export function activeClause(alias: string, preview?: ChangesetPreview | null, opts: ActiveClauseOptions = {}): SqlFragment {
  const { liveOnly = true, activeOnly = true, offset = 0 } = opts;
  const p = new SqlParams(offset);
  if (!activeOnly) {
    return p.fragment('TRUE');
  }
  const live = `${alias}.active = 1${liveOnly ? ` AND ${alias}.approved = 1` : ''}`;
  if (preview === undefined || preview === null || preview.contentIds.length === 0) {
    return p.fragment(`(${live})`);
  }
  return p.fragment(
    `((${live} AND ${alias}.contentid <> ALL(${p.add(preview.contentIds)}::bpchar[]))` +
      ` OR ${alias}.contenthistid = ANY(${p.add(preview.contentHistIds)}::bpchar[]))`,
  );
}

/** Options of `menuTypeClause`: the placeholder offset, and the clock time `ReleaseMonth` compares (default `menuDate`). */
export interface MenuTypeClauseOptions {
  offset?: number;
  now?: Date;
}

/**
 * `contentGateway.renderMenuTypeClause`: the display window of a menu type on `menuDate`, rendered as legacy renders
 * it, without enclosing parentheses. Menu types match case-insensitively; any other type is the default window.
 */
export function menuTypeClause(alias: string, menuType: string, menuDate: Date, opts: MenuTypeClauseOptions = {}): SqlFragment {
  const p = new SqlParams(opts.offset);
  const now = opts.now ?? menuDate;
  const c = (column: ColumnOf<typeof CONTENT>): string => `${alias}.${column}`;
  const nextDay = addDays(menuDate, 1);
  switch (menuType.toLowerCase()) {
    case 'calendar':
    case 'calendardate':
      return p.fragment(
        `${c('display')} = 2 AND (${c('displaystart')} < ${p.add(nextDay)}` +
          ` AND (${c('displaystop')} >= ${p.add(menuDate)} OR ${c('displaystop')} IS NULL))`,
      );
    case 'calendar_features':
      return p.fragment(
        `${c('display')} = 2 AND (${c('displaystart')} >= ${p.add(menuDate)}` +
          ` OR (${c('displaystart')} < ${p.add(menuDate)} AND ${c('displaystop')} >= ${p.add(menuDate)}))`,
      );
    case 'releasedate':
      return p.fragment(
        `(${c('display')} = 1 OR (${c('display')} = 2 AND (${c('displaystart')} < ${p.add(nextDay)}` +
          ` AND (${c('displaystop')} >= ${p.add(menuDate)} OR ${c('displaystop')} IS NULL))))` +
          ` AND ((${c('releasedate')} < ${p.add(nextDay)} AND ${c('releasedate')} >= ${p.add(menuDate)})` +
          ` OR (${c('releasedate')} IS NULL AND ${c('lastupdate')} < ${p.add(nextDay)} AND ${c('lastupdate')} >= ${p.add(menuDate)}))`,
      );
    case 'releasemonth': {
      const from = monthStart(menuDate);
      const to = nextMonthStart(menuDate);
      return p.fragment(
        `(${c('display')} = 1 OR (${c('display')} = 2 AND (${c('displaystart')} <= ${p.add(now)}` +
          ` AND ${c('displaystart')} < ${p.add(addMonths(menuDate, 1))}` +
          ` AND (${c('displaystop')} >= ${p.add(now)} OR ${c('displaystop')} IS NULL))))` +
          ` AND ((${c('releasedate')} < ${p.add(to)} AND ${c('releasedate')} >= ${p.add(from)})` +
          ` OR (${c('releasedate')} IS NULL AND ${c('lastupdate')} < ${p.add(to)} AND ${c('lastupdate')} >= ${p.add(from)}))`,
      );
    }
    case 'calendarmonth': {
      const from = monthStart(menuDate);
      const to = nextMonthStart(menuDate);
      return p.fragment(
        `${c('display')} = 2 AND ((${c('displaystart')} < ${p.add(to)} AND ${c('displaystart')} >= ${p.add(from)})` +
          ` OR (${c('displaystop')} < ${p.add(to)} AND (${c('displaystop')} >= ${p.add(from)} OR ${c('displaystop')} IS NULL))` +
          ` OR (${c('displaystart')} < ${p.add(from)} AND (${c('displaystop')} >= ${p.add(to)} OR ${c('displaystop')} IS NULL)))`,
      );
    }
    case 'releaseyear': {
      const from = yearStart(menuDate);
      const to = nextYearStart(menuDate);
      return p.fragment(
        `(${c('display')} = 1 OR (${c('display')} = 2 AND (${c('displaystart')} < ${p.add(nextDay)}` +
          ` AND (${c('displaystop')} >= ${p.add(menuDate)} OR ${c('displaystop')} IS NULL))))` +
          ` AND ((${c('releasedate')} < ${p.add(to)} AND ${c('releasedate')} >= ${p.add(from)})` +
          ` OR (${c('releasedate')} IS NULL AND ${c('lastupdate')} < ${p.add(to)} AND ${c('lastupdate')} >= ${p.add(from)}))`,
      );
    }
    case 'fixed':
      return p.fragment(`${c('display')} = 1`);
    default:
      return p.fragment(
        `${c('display')} = 1 OR (${c('display')} = 2 AND (${c('displaystart')} < ${p.add(menuDate)}` +
          ` AND (${c('displaystop')} >= ${p.add(menuDate)} OR ${c('displaystop')} IS NULL)))`,
      );
  }
}

/** `contentGateway.renderMobileClause` without its leading AND; `mobile` is legacy `request.muraMobileRequest`. */
export function mobileClause(alias: string, mobile = false): string {
  return `(${alias}.mobileexclude IS NULL OR ${alias}.mobileexclude IN (0, ${mobile ? 2 : 1}))`;
}

/** A legacy sort direction. */
export type SortDirection = 'asc' | 'desc';

/** `getKids` sort options; any other `sortBy` is an extended-attribute sort. */
export const CONTENT_SORT_OPTIONS = [
  'menutitle',
  'title',
  'lastupdate',
  'releasedate',
  'orderno',
  'displaystart',
  'created',
  'rating',
  'comment',
  'credits',
  'type',
  'subtype',
] as const;

// getNest's list names tcontent.credits where getKids names credits, so credits is an extended sort in the tree.
const NEST_SORT_OPTIONS = [...CONTENT_SORT_OPTIONS.filter((option) => option !== 'credits'), 'tcontent.credits'] as const;

// The cfcase list both gateways order by column; text columns sort case-insensitively.
const COLUMN_SORTS = new Set([
  'menutitle',
  'title',
  'lastupdate',
  'releasedate',
  'orderno',
  'displaystart',
  'displaystop',
  'created',
  'tcontent.credits',
  'type',
  'subtype',
]);
const TEXT_SORTS = new Set(['menutitle', 'title', 'type', 'subtype']);

/** Legacy `sortDirection` coercion: `asc` or `desc` in any case, else `fallback`. */
export function sortDirectionOf(value: string | null | undefined, fallback: SortDirection = 'asc'): SortDirection {
  const direction = (value ?? '').toLowerCase();
  return direction === 'asc' || direction === 'desc' ? direction : fallback;
}

/** Whether `sortBy` is an extended-attribute sort against the sort `options` (case-insensitive, as listFindNoCase). */
export function isExtendedSort(sortBy: string, options: readonly string[] = CONTENT_SORT_OPTIONS): boolean {
  return !options.includes(sortBy.toLowerCase());
}

/** The ORDER BY key of a cfcase column sort, or undefined when `sortBy` is not one. */
function columnSort(alias: string, sortBy: string, direction: SortDirection): string | undefined {
  const key = sortBy.toLowerCase();
  if (!COLUMN_SORTS.has(key)) {
    return undefined;
  }
  if (key === 'tcontent.credits') {
    // Legacy interpolates it as tcontent.tcontent.credits, which the database rejects.
    throw new ContentQueryError(`Sort column "tcontent.${sortBy}" does not exist`);
  }
  const expr = `${alias}.${key}`;
  return orderKey(TEXT_SORTS.has(key) ? textSort(expr) : expr, direction);
}

/** The `tclassextenddata` value column an extended-attribute sort or filter compares. */
export type ExtendedCastColumn = 'numericvalue' | 'datetimevalue' | 'stringvalue';

/** `extendManager.getCastString` (strict extended data): the value column of `datatype`, or of the attribute's validation. */
export async function extendedCastColumn(
  tx: TenantTx,
  args: { siteId: string; attribute: string; datatype?: string | null },
): Promise<ExtendedCastColumn> {
  let datatype = args.datatype;
  if (datatype === undefined || datatype === null) {
    await readable(tx, 'extend_attribute');
    const p = new SqlParams();
    const where = /^[+-]?\d+(\.\d+)?$/.test(args.attribute.trim())
      ? `attributeid = ${p.add(Math.trunc(Number(args.attribute)))}`
      : `siteid = ${p.add(args.siteId)} AND ${ciEq(p, 'name', args.attribute)}`;
    const rows = await run<{ validation: string | null }>(
      tx,
      `SELECT validation FROM ${qualified(tx.schema, EXTEND_ATTRIBUTE.table)} WHERE ${where} ORDER BY attributeid LIMIT 1`,
      p.values,
    );
    datatype = rows.length === 0 ? 'stringvalue' : (rows[0]?.validation ?? '');
  }
  switch (datatype.toLowerCase()) {
    case 'numeric':
      return 'numericvalue';
    case 'date':
    case 'datetime':
    case 'timestamp':
      return 'datetimevalue';
    default:
      return 'stringvalue';
  }
}

/** The `qExtendedSort` join of an extended-attribute sort on `alias.contenthistid`, numbered from `offset`. */
export function extendedSortJoin(
  schema: string,
  alias: string,
  cast: ExtendedCastColumn,
  siteId: string,
  attribute: string,
  offset = 0,
): SqlFragment {
  const p = new SqlParams(offset);
  return p.fragment(
    `LEFT JOIN (SELECT tclassextenddata.${cast} AS extendedsort, tclassextenddata.baseid` +
      ` FROM ${qualified(schema, EXTEND_DATA.table)} tclassextenddata` +
      ` INNER JOIN ${qualified(schema, EXTEND_ATTRIBUTE.table)} tclassextendattributes` +
      ` ON (tclassextenddata.attributeid = tclassextendattributes.attributeid)` +
      ` WHERE tclassextendattributes.siteid = ${p.add(siteId)} AND ${ciEq(p, 'tclassextendattributes.name', attribute)}) qextendedsort` +
      ` ON (${alias}.contenthistid = qextendedsort.baseid)`,
  );
}

/** The ORDER BY key of an extended-attribute sort joined by `extendedSortJoin`. */
export function extendedSortKey(cast: ExtendedCastColumn, direction: SortDirection): string {
  const expr = 'qextendedsort.extendedsort';
  return orderKey(cast === 'stringvalue' ? textSort(expr) : expr, direction);
}

/** Legacy `isFeature` test on `alias` at `now`: always featured, or featured inside its feature window. */
function featureClause(p: SqlParams, alias: string, now: Date): string {
  return (
    `(${alias}.isfeature = 1 OR (${alias}.isfeature = 2 AND ${alias}.featurestart <= ${p.add(now)}` +
    ` AND (${alias}.featurestop >= ${p.add(now)} OR ${alias}.featurestop IS NULL)))`
  );
}


/** SQL Server `expr IN (values)` for constant `values`, never caller input: case-insensitive, trailing spaces ignored. */
function ciLiterals(expr: string, values: readonly string[]): string {
  return `lower(rtrim(${expr})) IN (${values.map((value) => `'${value.toLowerCase()}'`).join(', ')})`;
}

// contentDAO's variables.fieldlist, in its order.
const VERSION_FIELDS = [
  'active',
  'approved',
  'audience',
  'body',
  'contenthistid',
  'contentid',
  'credits',
  'display',
  'displaystart',
  'displaystop',
  'featurestart',
  'featurestop',
  'fileid',
  'filename',
  'forcessl',
  'inheritobjects',
  'isfeature',
  'islocked',
  'isnav',
  'keypoints',
  'lastupdate',
  'lastupdateby',
  'lastupdatebyid',
  'menutitle',
  'metadesc',
  'metakeywords',
  'moduleassign',
  'moduleid',
  'nextn',
  'notes',
  'orderno',
  'parentid',
  'displaytitle',
  'releasedate',
  'remoteid',
  'remotepubdate',
  'remotesource',
  'remotesourceurl',
  'remoteurl',
  'responsechart',
  'responsedisplayfields',
  'responsemessage',
  'responsesendto',
  'restricted',
  'restrictgroups',
  'searchexclude',
  'siteid',
  'sortby',
  'sortdirection',
  'summary',
  'target',
  'targetparams',
  'template',
  'title',
  'type',
  'subtype',
  'path',
  'tags',
  'docache',
  'created',
  'urltitle',
  'htmltitle',
  'mobileexclude',
  'changesetid',
  'imagesize',
  'imageheight',
  'imagewidth',
  'childtemplate',
  'majorversion',
  'minorversion',
  'expires',
  'displayinterval',
  'objectparams',
] as const satisfies readonly ColumnOf<typeof CONTENT>[];

/** File columns of a left join to `content.file`; null where the file is missing or kept in another tenant's file pool. */
type FileJoin<K extends keyof FileRow> = Nullable<Pick<FileRow, K>>;

/** A content version as the contentDAO reads return it. */
export type ContentVersionRow = Pick<ContentRow, (typeof VERSION_FIELDS)[number]> &
  FileJoin<'filesize' | 'contenttype' | 'contentsubtype' | 'fileext'> & {
    assocfilename: string | null;
    approvalstatus: string | null;
    requestid: string | null;
    approvalgroupid: string | null;
  };

/** The contentDAO read of versions with their file and approval-request columns, without a WHERE clause. */
function versionSelect(schema: string): string {
  const t = tablesFor(schema);
  return (
    `SELECT ${columns(CONTENT, 'tcontent', VERSION_FIELDS)}, tfiles.filesize, tfiles.contenttype, tfiles.contentsubtype,` +
    ' tfiles.fileext, tfiles.filename AS assocfilename, tapprovalrequests.status AS approvalstatus, tapprovalrequests.requestid,' +
    ' tapprovalrequests.groupid AS approvalgroupid' +
    ` FROM ${t.content} tcontent LEFT JOIN ${t.file} tfiles ON (tcontent.fileid = tfiles.fileid)` +
    ` LEFT JOIN ${t.approvalRequest} tapprovalrequests ON (tcontent.contenthistid = tapprovalrequests.contenthistid)`
  );
}

/**
 * contentDAO.readVersion: the version `contentHistId` (no row for an empty id). Where the site's file pool is another
 * tenant, the file columns are null and the caller fills them with `fileJoinColumns` in the file-pool tenant.
 */
export async function readVersion(tx: TenantTx, args: { contentHistId: string }): Promise<ContentVersionRow[]> {
  if (args.contentHistId === '') {
    return [];
  }
  await readable(tx, 'content', 'file', 'approval_request');
  const p = new SqlParams();
  return run(tx, `${versionSelect(tx.schema)} WHERE ${idEq(p, 'tcontent.contenthistid', args.contentHistId)}`, p.values);
}

/** Shared arguments of the contentDAO active-version reads. */
export interface ActiveVersionArgs {
  siteId: string;
  preview?: ChangesetPreview | null;
}

/** Arguments of the active-version reads that narrow by content type. */
export interface TypedActiveVersionArgs extends ActiveVersionArgs {
  /** Legacy `type`; empty selects the content types legacy lists. */
  type?: string;
}

/** The active versions matching `where` in `siteId`, as the contentDAO readActive* functions select them. */
async function readActiveWhere(
  tx: TenantTx,
  p: SqlParams,
  where: string,
  args: TypedActiveVersionArgs,
  types: readonly string[],
): Promise<ContentVersionRow[]> {
  await readable(tx, 'content', 'file', 'approval_request');
  const active = p.include(activeClause('tcontent', args.preview, { liveOnly: false, offset: p.next }));
  const type =
    args.type !== undefined && args.type !== '' ? ciEq(p, 'tcontent.type', args.type) : ciLiterals('tcontent.type', types);
  return run(
    tx,
    `${versionSelect(tx.schema)} WHERE ${where} AND ${active} AND tcontent.siteid = ${p.add(args.siteId)} AND ${type}`,
    p.values,
  );
}

/** contentDAO.readActive: the active version of `contentId` (no row for an empty id); file columns as for `readVersion`. */
export async function readActive(tx: TenantTx, args: ActiveVersionArgs & { contentId: string }): Promise<ContentVersionRow[]> {
  if (args.contentId === '') {
    return [];
  }
  const p = new SqlParams();
  return readActiveWhere(tx, p, idEq(p, 'tcontent.contentid', args.contentId), { siteId: args.siteId, preview: args.preview }, VERSION_TYPES);
}

/** contentDAO.readActiveByRemoteID: active versions by `remoteid` (none for an empty id); file columns as for `readVersion`. */
export async function readActiveByRemoteId(
  tx: TenantTx,
  args: TypedActiveVersionArgs & { remoteId: string },
): Promise<ContentVersionRow[]> {
  if (args.remoteId === '') {
    return [];
  }
  const p = new SqlParams();
  return readActiveWhere(tx, p, ciEq(p, 'tcontent.remoteid', args.remoteId), args, VERSION_TYPES);
}

/** contentDAO.readActiveByTitle: active versions by `title` (none for an empty title); file columns as for `readVersion`. */
export async function readActiveByTitle(tx: TenantTx, args: TypedActiveVersionArgs & { title: string }): Promise<ContentVersionRow[]> {
  if (args.title === '') {
    return [];
  }
  const p = new SqlParams();
  return readActiveWhere(tx, p, ciEq(p, 'tcontent.title', args.title), args, VERSION_TYPES);
}

/** contentDAO.readActiveByURLTitle: active versions by `urltitle` (none when empty); file columns as for `readVersion`. */
export async function readActiveByUrlTitle(
  tx: TenantTx,
  args: TypedActiveVersionArgs & { urlTitle: string },
): Promise<ContentVersionRow[]> {
  if (args.urlTitle === '') {
    return [];
  }
  const p = new SqlParams();
  return readActiveWhere(tx, p, ciEq(p, 'tcontent.urltitle', args.urlTitle), args, VERSION_TYPES);
}

/**
 * contentDAO.readActiveByFilename: active pages, folders, calendars, galleries, files and links by `filename`; an empty
 * filename selects the home page (`filename IS NULL`). File columns as for `readVersion`.
 */
export async function readActiveByFilename(
  tx: TenantTx,
  args: TypedActiveVersionArgs & { filename: string },
): Promise<ContentVersionRow[]> {
  const p = new SqlParams();
  const filename = args.filename === '' ? 'tcontent.filename IS NULL' : ciEq(p, 'tcontent.filename', args.filename.toLowerCase());
  const where = `${filename} AND ${ciLiterals('tcontent.type', ['Page', 'Folder', 'Calendar', 'Gallery', 'File', 'Link'])}`;
  return readActiveWhere(tx, p, where, args, VERSION_TYPES.filter((type) => type !== 'Module'));
}

/** contentGateway.getContentIDFromContentHistID: the content id of a version, or '' when there is none. */
export async function contentIdFromHistId(tx: TenantTx, args: { contentHistId: string }): Promise<string> {
  await readable(tx, 'content');
  const p = new SqlParams();
  const rows = await run<{ contentid: string | null }>(
    tx,
    `SELECT contentid FROM ${qualified(tx.schema, CONTENT.table)} WHERE ${idEq(p, 'contenthistid', args.contentHistId)} LIMIT 1`,
    p.values,
  );
  return rows[0]?.contentid ?? '';
}

/**
 * contentGateway.getContentHistIDFromContentID: the active version id of `contentId`, or ''. As in legacy, a value
 * that is not a CF UUID is looked up as a live version's title.
 */
export async function histIdFromContentId(
  tx: TenantTx,
  args: { contentId: string; siteId: string; preview?: ChangesetPreview | null },
): Promise<string> {
  await readable(tx, 'content');
  const p = new SqlParams();
  const where = CF_UUID.test(args.contentId)
    ? `${idEq(p, 'tcontent.contentid', args.contentId)}` +
      ` AND ${p.include(activeClause('tcontent', args.preview, { liveOnly: false, offset: p.next }))}` +
      ` AND tcontent.siteid = ${p.add(args.siteId)}`
    : `tcontent.siteid = ${p.add(args.siteId)} AND ${ciEq(p, 'tcontent.title', args.contentId)}` +
      ` AND ${p.include(activeClause('tcontent', args.preview, { offset: p.next }))}`;
  const rows = await run<{ contenthistid: string | null }>(
    tx,
    `SELECT tcontent.contenthistid FROM ${qualified(tx.schema, CONTENT.table)} tcontent WHERE ${where} LIMIT 1`,
    p.values,
  );
  return rows[0]?.contenthistid ?? '';
}

const REGION_OBJECT_FIELDS = [
  'contenthistid',
  'contentid',
  'objectid',
  'siteid',
  'object',
  'name',
  'columnid',
  'orderno',
  'params',
] as const satisfies readonly ColumnOf<typeof CONTENT_OBJECT>[];

/** A display-object placement as contentDAO.readRegionObjects selects it. */
export type RegionObjectRow = Pick<ContentObjectRow, (typeof REGION_OBJECT_FIELDS)[number]>;

/** contentDAO.readRegionObjects for every region of a version, ordered by region then position. */
export async function contentObjects(tx: TenantTx, args: { contentHistId: string; siteId: string }): Promise<RegionObjectRow[]> {
  await readable(tx, 'content_object');
  const p = new SqlParams();
  return run(
    tx,
    `SELECT ${REGION_OBJECT_FIELDS.join(', ')} FROM ${qualified(tx.schema, CONTENT_OBJECT.table)}` +
      ` WHERE ${idEq(p, 'contenthistid', args.contentHistId)} AND siteid = ${p.add(args.siteId)} ORDER BY columnid, orderno`,
    p.values,
  );
}

/** contentDAO.readRegionObjects: the objects of one region of a version, by position; legacy ignores the site id. */
export async function regionObjects(
  tx: TenantTx,
  args: { contentHistId: string; columnId: number; siteId?: string },
): Promise<RegionObjectRow[]> {
  await readable(tx, 'content_object');
  const p = new SqlParams();
  return run(
    tx,
    `SELECT ${REGION_OBJECT_FIELDS.join(', ')} FROM ${qualified(tx.schema, CONTENT_OBJECT.table)}` +
      ` WHERE ${idEq(p, 'contenthistid', args.contentHistId)} AND columnid = ${p.add(args.columnId)} ORDER BY orderno`,
    p.values,
  );
}

/** A `content_object` row without its tenant. */
export type ContentObjectFields = Omit<ContentObjectRow, 'tenant_id'>;

/** contentDAO.readContentObject: the object at position `orderNo` of region `columnId` of a version. */
export async function contentObject(
  tx: TenantTx,
  args: { contentHistId: string; columnId: number; orderNo: number },
): Promise<ContentObjectFields[]> {
  await readable(tx, 'content_object');
  const p = new SqlParams();
  return run(
    tx,
    `SELECT ${columns(CONTENT_OBJECT, 'o', ['contenthistid', 'objectid', 'object', 'contentid', 'name', 'orderno', 'siteid', 'columnid', 'params'])}` +
      ` FROM ${qualified(tx.schema, CONTENT_OBJECT.table)} o WHERE ${idEq(p, 'o.contenthistid', args.contentHistId)}` +
      ` AND o.columnid = ${p.add(args.columnId)} AND o.orderno = ${p.add(args.orderNo)}`,
    p.values,
  );
}

/** A related-content link as contentDAO.readRelatedItems selects it. */
export type RelatedItemRow = Pick<ContentRelatedRow, 'relatedid' | 'relatedcontentsetid' | 'orderno'>;

/** contentDAO.readRelatedItems: a version's related-content links, optionally of one related-content set. */
export async function relatedItems(
  tx: TenantTx,
  args: { contentHistId: string; siteId: string; relatedContentSetId?: string },
): Promise<RelatedItemRow[]> {
  await readable(tx, 'content_related');
  const p = new SqlParams();
  const set =
    args.relatedContentSetId !== undefined && args.relatedContentSetId !== ''
      ? ` AND ${idEq(p, 'relatedcontentsetid', args.relatedContentSetId)}`
      : '';
  // The clustered key orders legacy's scan, so rows come back in insertion order.
  return run(
    tx,
    `SELECT relatedid, relatedcontentsetid, orderno FROM ${qualified(tx.schema, CONTENT_RELATED.table)}` +
      ` WHERE ${idEq(p, 'contenthistid', args.contentHistId)} AND siteid = ${p.add(args.siteId)}${set} ORDER BY relatedcontentid`,
    p.values,
  );
}

/** contentDAO.setCustomTagGroups: a version's tags in custom tag groups, in insertion order. */
export async function tags(tx: TenantTx, args: { contentHistId: string }): Promise<{ tag: string; taggroup: string | null }[]> {
  await readable(tx, 'content_tag');
  const p = new SqlParams();
  return run(
    tx,
    `SELECT tag, taggroup FROM ${qualified(tx.schema, CONTENT_TAG.table)}` +
      ` WHERE ${idEq(p, 'contenthistid', args.contentHistId)} AND taggroup IS NOT NULL ORDER BY tagid`,
    p.values,
  );
}

/** A category assignment without its tenant. */
export type CategoryAssignmentRow = Omit<CategoryAssignRow, 'tenant_id'>;

/**
 * contentGateway.getCategoriesByHistID, assignment columns only. Categories live in the category-pool tenant, so the
 * caller joins their name, filename, parent and path there, keeps the assignments whose category exists, and orders by
 * category filename as legacy does.
 */
export async function categoryAssignments(tx: TenantTx, args: { contentHistId: string }): Promise<CategoryAssignmentRow[]> {
  await readable(tx, 'content_category_assign');
  const p = new SqlParams();
  return run(
    tx,
    `SELECT ${columns(CATEGORY_ASSIGN, 'a', ['contenthistid', 'categoryid', 'contentid', 'isfeature', 'orderno', 'siteid', 'featurestart', 'featurestop'])}` +
      ` FROM ${qualified(tx.schema, CATEGORY_ASSIGN.table)} a WHERE ${idEq(p, 'a.contenthistid', args.contentHistId)} ORDER BY a.categoryid`,
    p.values,
  );
}

/** A `content_stats` row without its tenant. */
export type StatsRow = Omit<ContentStatsRow, 'tenant_id'>;

/** contentStatsBean.getQuery: the stats, lock and version-number row of a content item, or null. */
export async function stats(tx: TenantTx, args: { contentId: string; siteId: string }): Promise<StatsRow | null> {
  await readable(tx, 'content_stats');
  const p = new SqlParams();
  const rows = await run<StatsRow>(
    tx,
    `SELECT ${columns(CONTENT_STATS, 's', [
      'contentid',
      'siteid',
      'views',
      'rating',
      'totalvotes',
      'upvotes',
      'downvotes',
      'comments',
      'majorversion',
      'minorversion',
      'lockid',
      'locktype',
      'disablecomments',
    ])} FROM ${qualified(tx.schema, CONTENT_STATS.table)} s WHERE ${idEq(p, 's.contentid', args.contentId)} AND s.siteid = ${p.add(args.siteId)}`,
    p.values,
  );
  return rows[0] ?? null;
}

/** A content assignment without its tenant. */
export type ContentAssignmentFields = Omit<ContentAssignmentRow, 'tenant_id'>;

/** The draft and expiry assignments of a version (contentDAO assignment rows), by type then user. */
export async function contentAssignments(tx: TenantTx, args: { contentHistId: string }): Promise<ContentAssignmentFields[]> {
  await readable(tx, 'content_assignment');
  const p = new SqlParams();
  return run(
    tx,
    `SELECT contentid, contenthistid, siteid, userid, type FROM ${qualified(tx.schema, CONTENT_ASSIGNMENT.table)}` +
      ` WHERE ${idEq(p, 'contenthistid', args.contentHistId)} ORDER BY type, userid`,
    p.values,
  );
}

/** contentDAO.getExpireAssignments: the users notified when a version expires. */
export async function expireAssignments(tx: TenantTx, args: { contentHistId: string }): Promise<{ userid: string }[]> {
  await readable(tx, 'content_assignment');
  const p = new SqlParams();
  return run(
    tx,
    `SELECT userid FROM ${qualified(tx.schema, CONTENT_ASSIGNMENT.table)}` +
      ` WHERE ${idEq(p, 'contenthistid', args.contentHistId)} AND ${ciLiterals('type', ['expire'])}`,
    p.values,
  );
}


/** One crumb of `contentGateway.buildCrumblist`, keyed as legacy keys the crumb struct (`targetprams` is legacy's spelling). */
export interface Crumb {
  type: string | null;
  subtype: string | null;
  filename: string | null;
  title: string | null;
  menutitle: string | null;
  urltitle: string | null;
  target: string | null;
  contentid: string | null;
  parentid: string | null;
  siteid: string | null;
  restricted: number | null;
  restrictgroups: string | null;
  template: string | null;
  contenthistid: string | null;
  targetprams: string | null;
  metadesc: string | null;
  metakeywords: string | null;
  sortby: string | null;
  sortdirection: string | null;
  inheritobjects: string | null;
  fileext: string | null;
  chainid: string | null;
  exemptid: string | null;
  moduleid: string | null;
  /** The content ids of the crumbs, set on the first crumb only. */
  parentarray?: string[];
}

const CRUMB_FIELDS = [
  'contenthistid',
  'contentid',
  'title',
  'menutitle',
  'urltitle',
  'filename',
  'parentid',
  'type',
  'subtype',
  'target',
  'targetparams',
  'siteid',
  'restricted',
  'restrictgroups',
  'template',
  'childtemplate',
  'inheritobjects',
  'metadesc',
  'metakeywords',
  'sortby',
  'sortdirection',
  'moduleid',
] as const satisfies readonly ColumnOf<typeof CONTENT>[];

type CrumbQueryRow = Pick<ContentRow, (typeof CRUMB_FIELDS)[number]> & {
  fileext: string | null;
  chainid: string | null;
  exemptid: string | null;
};

/** The crumb select of `buildCrumblist`, without its WHERE clause. */
function crumbSelect(schema: string): string {
  const t = tablesFor(schema);
  return (
    `SELECT ${columns(CONTENT, 'tcontent', CRUMB_FIELDS)}, tfiles.fileext, tapprovalassignments.chainid, tapprovalassignments.exemptid` +
    ` FROM ${t.content} tcontent LEFT JOIN ${t.file} tfiles ON (tcontent.fileid = tfiles.fileid)` +
    ` LEFT JOIN ${t.approvalAssignment} tapprovalassignments` +
    ' ON (tcontent.contentid = tapprovalassignments.contentid AND tcontent.siteid = tapprovalassignments.siteid)'
  );
}

/** A non-empty CF value, else `fallback` (CF `len(value)` on a NULL column is 0). */
function orElse(value: string | null, fallback: string | null): string | null {
  return value !== null && value !== '' ? value : fallback;
}

function toCrumb(row: CrumbQueryRow, menuTitleFallback: boolean): Crumb {
  return {
    type: row.type,
    subtype: row.subtype,
    filename: row.filename,
    title: row.title,
    menutitle: menuTitleFallback ? orElse(row.menutitle, row.title) : row.menutitle,
    urltitle: row.urltitle,
    target: row.target,
    contentid: row.contentid,
    parentid: row.parentid,
    siteid: row.siteid,
    restricted: row.restricted,
    restrictgroups: row.restrictgroups,
    template: orElse(row.childtemplate, row.template),
    contenthistid: row.contenthistid,
    targetprams: row.targetparams,
    metadesc: row.metadesc,
    metakeywords: row.metakeywords,
    sortby: row.sortby,
    sortdirection: row.sortdirection,
    inheritobjects: row.inheritobjects,
    fileext: row.fileext,
    chainid: row.chainid,
    exemptid: row.exemptid,
    moduleid: row.moduleid,
  };
}

/** The most crumbs the legacy walk appends before it gives up on a parent loop and returns them without `parentarray`. */
const CRUMB_WALK_LIMIT = 51;

/**
 * contentGateway.buildCrumblist: the active crumbs from `contentId` up to the site root, self first. With a stored
 * `path` (a CF list of content ids) the crumbs are read at once, deepest first, and keep an empty menu title; walking
 * falls back to the title. File extensions are null where the site's file pool is another tenant; the caller fills
 * them with `fileJoinColumns` there.
 */
export async function crumbPath(tx: TenantTx, args: { contentId: string; siteId: string; path?: string }): Promise<Crumb[]> {
  await readable(tx, 'content', 'file', 'approval_assignment');
  const crumbs: Crumb[] = [];
  const parents: string[] = [];
  if (args.path !== undefined && args.path !== '') {
    const ids = cfList(args.path);
    if (ids.length > 0) {
      const p = new SqlParams();
      const rows = await run<CrumbQueryRow>(
        tx,
        `${crumbSelect(tx.schema)} WHERE ${idIn(p, 'tcontent.contentid', ids)} AND tcontent.active = 1` +
          ` AND tcontent.siteid = ${p.add(args.siteId)} ORDER BY ${orderKey('length(rtrim(tcontent.path))', 'desc')}`,
        p.values,
      );
      for (const row of rows) {
        crumbs.push(toCrumb(row, false));
        parents.push(row.contentid ?? '');
      }
    }
  } else {
    let id = args.contentId;
    while (id.toUpperCase() !== ROOT_PARENT_ID) {
      const p = new SqlParams();
      const [row] = await run<CrumbQueryRow>(
        tx,
        `${crumbSelect(tx.schema)} WHERE tcontent.active = 1 AND ${idEq(p, 'tcontent.contentid', id)}` +
          ` AND tcontent.siteid = ${p.add(args.siteId)} LIMIT 1`,
        p.values,
      );
      if (row === undefined) {
        break;
      }
      crumbs.push(toCrumb(row, true));
      parents.push(row.contentid ?? '');
      if (crumbs.length >= CRUMB_WALK_LIMIT) {
        return crumbs;
      }
      id = row.parentid ?? '';
    }
  }
  const [first] = crumbs;
  if (first !== undefined) {
    first.parentarray = parents;
  }
  return crumbs;
}

/** Arguments of `kids`, as `contentGateway.getKids` names them. */
export interface KidsArgs {
  /** Defaults to the site tree module. */
  moduleId?: string;
  siteId: string;
  parentId: string;
  /** Menu type; defaults to `default`, whose date is rounded to the five-minute interval. */
  type?: string;
  /** Legacy `nowAdjusted`: the preview publish date, point in time, or the caller's clock. */
  today: Date;
  /** The caller's clock, which the `ReleaseMonth` window compares; defaults to `today`. */
  now?: Date;
  /** Row limit; defaults to 100, and 0 returns every row. */
  size?: number;
  keywords?: string;
  hasFeatures?: boolean;
  sortBy?: string;
  sortDirection?: string;
  /**
   * Category filter, resolved by the caller in the category-pool tenant: every category id itself plus its descendants
   * by `path`, or the listed ids alone with `useCategoryIntersect`. Undefined filters nothing; an empty array matches nothing.
   */
  categoryIds?: readonly string[];
  relatedIds?: readonly string[];
  /** Legacy `tag`: a CF list of tags. */
  tag?: string;
  tagGroup?: string;
  /** Adds the `kids` count of live navigable children. */
  aggregation?: boolean;
  useCategoryIntersect?: boolean;
  preview?: ChangesetPreview | null;
  mobile?: boolean;
}

/** A child as `getKids` selects it. */
export type KidsRow = Pick<
  ContentRow,
  | 'title'
  | 'releasedate'
  | 'menutitle'
  | 'lastupdate'
  | 'summary'
  | 'tags'
  | 'filename'
  | 'type'
  | 'subtype'
  | 'siteid'
  | 'contentid'
  | 'contenthistid'
  | 'target'
  | 'targetparams'
  | 'restricted'
  | 'restrictgroups'
  | 'displaystart'
  | 'displaystop'
  | 'orderno'
  | 'sortby'
  | 'sortdirection'
  | 'fileid'
  | 'credits'
  | 'remotesource'
  | 'remotesourceurl'
  | 'remoteurl'
  | 'audience'
  | 'keypoints'
  | 'path'
  | 'created'
  | 'nextn'
  | 'majorversion'
  | 'minorversion'
  | 'expires'
  | 'displayinterval'
  | 'display'
  | 'changesetid'
> &
  FileJoin<'filesize' | 'fileext'> &
  Nullable<Pick<ContentStatsRow, 'rating' | 'totalvotes' | 'downvotes' | 'upvotes' | 'comments' | 'lockid' | 'locktype'>> & {
    parenttype: string;
    kids: number | null;
    assocfilename: string | null;
    filealttext: string | null;
  };

/** The category filter of the tree and search reads on `alias`, with legacy's feature test on the assignments when `featuredAt`. */
function categoryFilter(
  p: SqlParams,
  schema: string,
  alias: string,
  categoryIds: readonly string[],
  intersect: boolean,
  featuredAt?: Date,
): string {
  const assign = qualified(schema, CATEGORY_ASSIGN.table);
  const featured = (a: string): string => (featuredAt === undefined ? '' : ` AND ${featureClause(p, a, featuredAt)}`);
  if (!intersect) {
    return `${alias}.contenthistid IN (SELECT DISTINCT cca.contenthistid FROM ${assign} cca WHERE ${idIn(p, 'cca.categoryid', categoryIds)}${featured('cca')})`;
  }
  const [first, ...rest] = categoryIds;
  if (first === undefined) {
    return 'FALSE';
  }
  const joins = rest
    .map((id, i) => {
      const a = `ca${i + 2}`;
      return ` INNER JOIN ${assign} ${a} ON (ca${i + 1}.contenthistid = ${a}.contenthistid AND ${idEq(p, `${a}.categoryid`, id)}${featured(a)})`;
    })
    .join('');
  return `${alias}.contenthistid IN (SELECT ca1.contenthistid FROM ${assign} ca1${joins} WHERE ${idEq(p, 'ca1.categoryid', first)}${featured('ca1')})`;
}

/** The filters `getKids` applies both to the children and to its `qKids` aggregate, on `tcontent`. */
function kidsFilters(p: SqlParams, schema: string, args: KidsArgs, menuDate: Date): string[] {
  const filters: string[] = [];
  if (args.keywords !== undefined && args.keywords !== '') {
    const pattern = `%${args.keywords}%`;
    filters.push(`(${ciLike(p, 'tcontent.body', pattern)} OR ${ciLike(p, 'tcontent.title', pattern)})`);
  }
  filters.push(`(${p.include(menuTypeClause('tcontent', args.type ?? 'default', menuDate, { offset: p.next, now: args.now ?? args.today }))})`);
  if (args.relatedIds !== undefined && args.relatedIds.length > 0) {
    filters.push(
      `tcontent.contentid IN (SELECT relatedid FROM ${qualified(schema, CONTENT_RELATED.table)}` +
        ` WHERE ${idIn(p, 'contentid', args.relatedIds)} AND siteid = ${p.add(args.siteId)})`,
    );
  }
  if (args.categoryIds === undefined) {
    if (args.hasFeatures === true) {
      filters.push(featureClause(p, 'tcontent', menuDate));
    }
  } else {
    filters.push(
      categoryFilter(p, schema, 'tcontent', args.categoryIds, args.useCategoryIntersect === true, args.hasFeatures === true ? menuDate : undefined),
    );
  }
  return filters;
}

// getKids' default order where getNest's is orderno.
const KIDS_DEFAULT_ORDER = `${orderKey('tcontent.releasedate', 'desc')}, ${orderKey('tcontent.lastupdate', 'desc')}, ${orderKey(textSort('tcontent.menutitle'), 'asc')}`;
const NEST_DEFAULT_ORDER = orderKey('tcontent.orderno', 'asc');

/** The ORDER BY switch of `getKids` and `getNest`; `fallback` orders a sort that is neither a column nor extended. */
function treeOrder(sortBy: string, direction: SortDirection, extended: boolean, cast: ExtendedCastColumn, fallback: string): string {
  const column = columnSort('tcontent', sortBy, direction);
  if (column !== undefined) {
    return column;
  }
  switch (sortBy.toLowerCase()) {
    case 'rating':
      return `${orderKey('tcontentstats.rating', direction)}, ${orderKey('tcontentstats.totalvotes', direction)}`;
    case 'comments':
      return orderKey('tcontentstats.comments', direction);
    default:
      return extended ? extendedSortKey(cast, direction) : fallback;
  }
}

/**
 * contentGateway.getKids: the live navigable children of `parentId`, before legacy's permission filter and interval
 * expansion, which the caller applies. `mxpRelevance` without `aggregation` needs the marketing plugin's tables and
 * fails as legacy does without them. File columns are null where the site's file pool is another tenant; the caller
 * fills them with `fileJoinColumns` there.
 */
export async function kids(tx: TenantTx, args: KidsArgs): Promise<KidsRow[]> {
  const sortBy = args.sortBy ?? 'orderno';
  const direction = sortDirectionOf(args.sortDirection);
  const aggregation = args.aggregation === true;
  const tag = args.tag ?? '';
  if (sortBy.toLowerCase() === 'mxprelevance' && !aggregation) {
    throw new ContentQueryError('The mxpRelevance sort reads the marketing plugin tables, which do not exist');
  }
  const extended = isExtendedSort(sortBy);
  await readable(
    tx,
    'content',
    'file',
    'content_stats',
    'file_metadata',
    ...(extended ? (['extend_data', 'extend_attribute'] as const) : []),
    ...(tag !== '' ? (['content_tag'] as const) : []),
    ...(args.relatedIds !== undefined && args.relatedIds.length > 0 ? (['content_related'] as const) : []),
    ...(args.categoryIds !== undefined ? (['content_category_assign'] as const) : []),
  );
  const sortCast = extended ? await extendedCastColumn(tx, { siteId: args.siteId, attribute: sortBy }) : 'stringvalue';
  const order = treeOrder(sortBy, direction, extended, sortCast, KIDS_DEFAULT_ORDER);
  const moduleId = args.moduleId ?? SITE_TREE_MODULE_ID;
  const menuDate = (args.type ?? 'default').toLowerCase() === 'default' ? timespanInterval(args.today) : args.today;
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const joins: string[] = [
    `LEFT JOIN ${t.file} tfiles ON (tcontent.fileid = tfiles.fileid)`,
    `LEFT JOIN ${t.stats} tcontentstats ON (tcontent.contentid = tcontentstats.contentid AND tcontent.siteid = tcontentstats.siteid)`,
    `LEFT JOIN ${t.fileMetadata} tcontentfilemetadata ON (tcontent.fileid = tcontentfilemetadata.fileid` +
      ' AND tcontent.contenthistid = tcontentfilemetadata.contenthistid AND tcontent.siteid = tcontentfilemetadata.siteid)',
  ];
  if (extended) {
    joins.push(p.include(extendedSortJoin(tx.schema, 'tcontent', sortCast, args.siteId, sortBy, p.next)));
  }
  if (aggregation) {
    const tagJoin = tag !== '' ? ` INNER JOIN ${t.tag} tcontenttags ON (tcontent.contenthistid = tcontenttags.contenthistid)` : '';
    const where = [
      `tcontent.siteid = ${p.add(args.siteId)}`,
      idEq(p, 'tcontent.parentid', args.parentId),
      p.include(activeClause('tcontent', args.preview, { offset: p.next })),
      'tcontent.isnav = 1',
      p.include(activeClause('tkids', args.preview, { offset: p.next })),
      'tkids.isnav = 1',
      idEq(p, 'tcontent.moduleid', moduleId),
      ...kidsFilters(p, tx.schema, args, menuDate),
      // Legacy compares the aggregate's tag with the whole tag list.
      ...(tag !== '' ? [ciEq(p, 'tcontenttags.tag', tag)] : []),
    ];
    joins.push(
      `LEFT JOIN (SELECT tcontent.contentid, count(tkids.contentid)::integer AS kids FROM ${t.content} tcontent` +
        ` LEFT JOIN ${t.content} tkids ON (tcontent.contentid = tkids.parentid AND tcontent.siteid = tkids.siteid)${tagJoin}` +
        ` WHERE ${where.join(' AND ')} GROUP BY tcontent.contentid) qkids ON (tcontent.contentid = qkids.contentid)`,
    );
  }
  if (tag !== '') {
    joins.push(`INNER JOIN ${t.tag} tcontenttags ON (tcontent.contenthistid = tcontenttags.contenthistid)`);
  }
  const where = [
    idEq(p, 'tcontent.parentid', args.parentId),
    p.include(activeClause('tcontent', args.preview, { offset: p.next })),
    'tcontent.isnav = 1',
    idEq(p, 'tcontent.moduleid', moduleId),
    `tcontent.siteid = ${p.add(args.siteId)}`,
    ...kidsFilters(p, tx.schema, args, menuDate),
    mobileClause('tcontent', args.mobile),
  ];
  if (tag !== '') {
    const group =
      args.tagGroup !== undefined && args.tagGroup !== '' && args.tagGroup.toLowerCase() !== 'default'
        ? ` AND ${ciEq(p, 'tcontenttags.taggroup', args.tagGroup)}`
        : '';
    where.push(`(${ciIn(p, 'tcontenttags.tag', cfList(tag))}${group})`);
  }
  const size = args.size ?? 100;
  const limit = size > 0 ? ` LIMIT ${p.add(Math.trunc(size))}` : '';
  return run(
    tx,
    'SELECT tcontent.title, tcontent.releasedate, tcontent.menutitle, tcontent.lastupdate, tcontent.summary, tcontent.tags,' +
      ' tcontent.filename, tcontent.type, tcontent.subtype, tcontent.siteid, tcontent.contentid, tcontent.contenthistid,' +
      ' tcontent.target, tcontent.targetparams, tcontent.restricted, tcontent.restrictgroups, tcontent.displaystart,' +
      ' tcontent.displaystop, tcontent.orderno, tcontent.sortby, tcontent.sortdirection, tcontent.fileid, tcontent.credits,' +
      ' tcontent.remotesource, tcontent.remotesourceurl, tcontent.remoteurl, tfiles.filesize, tfiles.fileext, tcontent.audience,' +
      ' tcontent.keypoints, tcontentstats.rating, tcontentstats.totalvotes, tcontentstats.downvotes, tcontentstats.upvotes,' +
      ` tcontentstats.comments, ''::text AS parenttype, ${aggregation ? 'qkids.kids' : 'NULL::integer AS kids'}, tcontent.path,` +
      ' tcontent.created, tcontent.nextn, tcontent.majorversion, tcontent.minorversion, tcontentstats.lockid, tcontentstats.locktype,' +
      ' tcontent.expires, tfiles.filename AS assocfilename, tcontent.displayinterval, tcontent.display,' +
      ' tcontentfilemetadata.alttext AS filealttext, tcontent.changesetid' +
      ` FROM ${t.content} tcontent ${joins.join(' ')} WHERE ${where.join(' AND ')}` +
      ` ORDER BY ${order}${limit}`,
    p.values,
  );
}


/**
 * contentGateway.getKidsCount: the children of `parentId`, live and navigable in the `type` window (default `default`)
 * at the caller's clock `today` to the minute, or merely active when `liveOnly` is false.
 */
export async function kidsCount(
  tx: TenantTx,
  args: {
    siteId: string;
    parentId: string;
    today: Date;
    liveOnly?: boolean;
    type?: string;
    preview?: ChangesetPreview | null;
    mobile?: boolean;
  },
): Promise<number> {
  await readable(tx, 'content');
  const p = new SqlParams();
  const { today } = args;
  const menuDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), today.getHours(), today.getMinutes(), 0);
  // Legacy renders the menu clause without parentheses, so an OR in it splits the WHERE clause exactly as here.
  const live =
    args.liveOnly === false
      ? ' AND tcontent.active = 1'
      : ` AND ${p.include(activeClause('tcontent', args.preview, { offset: p.next }))} AND isnav = 1` +
        ` AND ${p.include(menuTypeClause('tcontent', args.type ?? 'default', menuDate, { offset: p.next }))}` +
        ` AND ${mobileClause('tcontent', args.mobile)}`;
  const rows = await run<{ kids: number }>(
    tx,
    `SELECT count(tcontent.parentid)::integer AS kids FROM ${qualified(tx.schema, CONTENT.table)} tcontent` +
      ` WHERE tcontent.siteid = ${p.add(args.siteId)} AND ${idEq(p, 'tcontent.parentid', args.parentId)}${live}`,
    p.values,
  );
  return rows[0]?.kids ?? 0;
}

const NEST_FIELDS = [
  'contenthistid',
  'contentid',
  'moduleid',
  'approved',
  'filename',
  'active',
  'type',
  'subtype',
  'orderno',
  'parentid',
  'title',
  'menutitle',
  'lastupdate',
  'lastupdateby',
  'lastupdatebyid',
  'display',
  'displaystart',
  'displaystop',
  'isnav',
  'restricted',
  'isfeature',
  'inheritobjects',
  'target',
  'targetparams',
  'islocked',
  'sortby',
  'sortdirection',
  'releasedate',
  'siteid',
  'featurestart',
  'featurestop',
  'template',
  'childtemplate',
  'majorversion',
  'minorversion',
  'expires',
  'displayinterval',
  'fileid',
  'remoteurl',
] as const satisfies readonly ColumnOf<typeof CONTENT>[];

/** A Site Manager tree row as `getNest` selects it; `haskids` only with aggregation. */
export type NestRow = Pick<ContentRow, (typeof NEST_FIELDS)[number]> &
  FileJoin<'filesize' | 'fileext' | 'contenttype' | 'contentsubtype'> &
  Nullable<Pick<ContentStatsRow, 'lockid' | 'locktype' | 'rating' | 'totalvotes' | 'comments'>> & {
    haskids?: number;
    assocfilename: string | null;
    filealttext: string | null;
  };

const NEST_TYPES = ['Page', 'Component', 'Link', 'Variation', 'File', 'Folder', 'Calendar', 'Form', 'Gallery', 'Module'];

/**
 * contentGateway.getNest: the active children of `parentId` for the Site Manager tree, with the `haskids` aggregate
 * unless `aggregation` is false. Files join on the content's own site, so their columns are null where the site's
 * file pool is another tenant; the caller fills them with `fileJoinColumns` there.
 */
export async function nest(
  tx: TenantTx,
  args: { parentId: string; siteId: string; sortBy?: string; sortDirection?: string; searchString?: string; aggregation?: boolean },
): Promise<NestRow[]> {
  const sortBy = args.sortBy ?? 'orderno';
  const direction = sortDirectionOf(args.sortDirection);
  const aggregation = args.aggregation !== false;
  const extended = isExtendedSort(sortBy, NEST_SORT_OPTIONS);
  await readable(tx, 'content', 'file', 'content_stats', 'file_metadata', ...(extended ? (['extend_data', 'extend_attribute'] as const) : []));
  const sortCast = extended ? await extendedCastColumn(tx, { siteId: args.siteId, attribute: sortBy }) : 'stringvalue';
  const order = treeOrder(sortBy, direction, extended, sortCast, NEST_DEFAULT_ORDER);
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const grouped = [
    columns(CONTENT, 'tcontent', NEST_FIELDS),
    'tfiles.filesize, tfiles.fileext, tfiles.contenttype, tfiles.contentsubtype',
    'tcontentstats.lockid, tcontentstats.locktype, tcontentstats.rating, tcontentstats.totalvotes, tcontentstats.comments',
  ];
  const joins = [
    aggregation ? `LEFT JOIN ${t.content} tcontent2 ON (tcontent.contentid = tcontent2.parentid)` : '',
    `LEFT JOIN ${t.file} tfiles ON (tcontent.fileid = tfiles.fileid AND tcontent.siteid = tfiles.siteid)`,
    `LEFT JOIN ${t.stats} tcontentstats ON (tcontent.contentid = tcontentstats.contentid AND tcontent.siteid = tcontentstats.siteid)`,
    `LEFT JOIN ${t.fileMetadata} tcontentfilemetadata ON (tcontent.fileid = tcontentfilemetadata.fileid` +
      ' AND tcontent.contenthistid = tcontentfilemetadata.contenthistid)',
    extended ? p.include(extendedSortJoin(tx.schema, 'tcontent', sortCast, args.siteId, sortBy, p.next)) : '',
  ];
  const search =
    args.searchString !== undefined && args.searchString !== ''
      ? ` AND ${ciLike(p, 'tcontent.menutitle', `%${args.searchString}%`)}`
      : '';
  const groupBy = aggregation
    ? ` GROUP BY ${grouped.join(', ')}, tcontent.created, tfiles.filename, tcontentfilemetadata.alttext${extended ? ', qextendedsort.extendedsort' : ''}`
    : '';
  return run(
    tx,
    `SELECT ${grouped.join(', ')}, tfiles.filename AS assocfilename, tcontentfilemetadata.alttext AS filealttext` +
      `${aggregation ? ', count(tcontent2.parentid)::integer AS haskids' : ''}` +
      ` FROM ${t.content} tcontent ${joins.filter((join) => join !== '').join(' ')}` +
      ` WHERE tcontent.siteid = ${p.add(args.siteId)} AND ${idEq(p, 'tcontent.parentid', args.parentId)}` +
      ` AND tcontent.active = 1 AND ${ciLiterals('tcontent.type', NEST_TYPES)}${search}${groupBy} ORDER BY ${order}`,
    p.values,
  );
}

// SQL Server returns rows of an unordered tcontent read in its clustered tcontent_ID order.
const CLUSTERED_ORDER = 'ORDER BY tcontent.tcontent_id';

/** A section as `getSections` selects it. */
export type SectionRow = Pick<ContentRow, 'contentid' | 'menutitle' | 'type' | 'siteid' | 'path'>;

/** contentGateway.getSections: the live folders, calendars and galleries of a site, or its live items of `type`. */
export async function sections(tx: TenantTx, args: { siteId: string; type?: string }): Promise<SectionRow[]> {
  await readable(tx, 'content');
  const p = new SqlParams();
  const type =
    args.type === undefined || args.type === ''
      ? ciLiterals('tcontent.type', ['Folder', 'Calendar', 'Gallery'])
      : ciEq(p, 'tcontent.type', args.type);
  return run(
    tx,
    `SELECT tcontent.contentid, tcontent.menutitle, tcontent.type, tcontent.siteid, tcontent.path FROM ${qualified(tx.schema, CONTENT.table)} tcontent` +
      ` WHERE tcontent.siteid = ${p.add(args.siteId)} AND ${type} AND tcontent.approved = 1 AND tcontent.active = 1 ${CLUSTERED_ORDER}`,
    p.values,
  );
}

/** contentGateway.getPageCount: the count of a site's active pages, folders, files, calendars and galleries. */
export async function pageCount(tx: TenantTx, args: { siteId: string }): Promise<{ counter: number }[]> {
  await readable(tx, 'content');
  const p = new SqlParams();
  return run(
    tx,
    `SELECT count(contentid)::integer AS counter FROM ${qualified(tx.schema, CONTENT.table)}` +
      ` WHERE ${ciLiterals('type', ['Page', 'Folder', 'File', 'Calendar', 'Gallery'])} AND active = 1 AND siteid = ${p.add(args.siteId)}`,
    p.values,
  );
}

/** An item summary as `getItemCount` selects it. */
export type ItemCountRow = Pick<ContentRow, 'menutitle' | 'title' | 'filename' | 'lastupdate' | 'type'>;

/** contentGateway.getItemCount: the active version summary of a content item. */
export async function itemCount(tx: TenantTx, args: { contentId: string; siteId: string }): Promise<ItemCountRow[]> {
  await readable(tx, 'content');
  const p = new SqlParams();
  return run(
    tx,
    `SELECT tcontent.menutitle, tcontent.title, tcontent.filename, tcontent.lastupdate, tcontent.type FROM ${qualified(tx.schema, CONTENT.table)} tcontent` +
      ` WHERE ${idEq(p, 'tcontent.contentid', args.contentId)} AND tcontent.active = 1 AND tcontent.siteid = ${p.add(args.siteId)} ${CLUSTERED_ORDER}`,
    p.values,
  );
}

/** contentGateway.getCount: the live navigable children of `contentId` displayed at the caller's clock `today`. */
export async function count(tx: TenantTx, args: { siteId: string; contentId: string; today: Date }): Promise<number> {
  await readable(tx, 'content');
  const p = new SqlParams();
  const rows = await run<{ thecount: number }>(
    tx,
    `SELECT count(contentid)::integer AS thecount FROM ${qualified(tx.schema, CONTENT.table)} tcontent` +
      ` WHERE ${idEq(p, 'parentid', args.contentId)} AND siteid = ${p.add(args.siteId)} AND active = 1 AND approved = 1 AND isnav = 1` +
      ` AND (display = 1 OR (display = 2 AND (displaystart <= ${p.add(args.today)})` +
      ` AND (displaystop >= ${p.add(args.today)} OR tcontent.displaystop IS NULL)))`,
    p.values,
  );
  return rows[0]?.thecount ?? 0;
}

/** A component as `getComponents` selects it. */
export type ComponentRow = Pick<ContentRow, 'contentid' | 'menutitle' | 'body' | 'title' | 'filename'>;

/** contentGateway.getComponents: the live components of a site assigned to module `moduleId`, by title. */
export async function components(tx: TenantTx, args: { moduleId: string; siteId: string }): Promise<ComponentRow[]> {
  await readable(tx, 'content');
  const p = new SqlParams();
  const branch = (display: number): string =>
    `(tcontent.active = 1) AND (tcontent.display = ${display}) AND (tcontent.approved = 1) AND (tcontent.siteid = ${p.add(args.siteId)})` +
    ` AND (${ciLiterals('tcontent.type', ['Component'])}) AND ${ciLike(p, 'tcontent.moduleassign', `%${args.moduleId}%`)}`;
  return run(
    tx,
    `SELECT tcontent.contentid, tcontent.menutitle, tcontent.body, tcontent.title, tcontent.filename FROM ${qualified(tx.schema, CONTENT.table)} tcontent` +
      ` WHERE ${branch(2)} OR ${branch(1)} ORDER BY ${orderKey(textSort('tcontent.title'), 'asc')}`,
    p.values,
  );
}

/** A component or form as `getComponentType` selects it. */
export type ComponentTypeRow = Pick<ContentRow, 'contentid' | 'menutitle' | 'responsechart'>;

/** contentGateway.getComponentType: a site's live items of `type`, optionally assigned to `moduleId`, by title. */
export async function componentType(
  tx: TenantTx,
  args: { siteId: string; type: string; moduleId?: string },
): Promise<ComponentTypeRow[]> {
  await readable(tx, 'content');
  const p = new SqlParams();
  const module =
    args.moduleId !== undefined && args.moduleId !== '' ? ` AND (${ciLike(p, 'tcontent.moduleassign', `%${args.moduleId}%`)})` : '';
  return run(
    tx,
    `SELECT tcontent.contentid, tcontent.menutitle, tcontent.responsechart FROM ${qualified(tx.schema, CONTENT.table)} tcontent` +
      ` WHERE (tcontent.active = 1) AND (tcontent.display = 1 OR tcontent.display = 2) AND (tcontent.approved = 1)` +
      ` AND (tcontent.siteid = ${p.add(args.siteId)}) AND (${ciEq(p, 'tcontent.type', args.type)})${module}` +
      ` ORDER BY ${orderKey(textSort('tcontent.title'), 'asc')}`,
    p.values,
  );
}

const TOP_FIELDS = [
  'contenthistid',
  'contentid',
  'moduleid',
  'approved',
  'filename',
  'active',
  'type',
  'subtype',
  'orderno',
  'parentid',
  'title',
  'menutitle',
  'lastupdate',
  'lastupdateby',
  'lastupdatebyid',
  'display',
  'displaystart',
  'displaystop',
  'isnav',
  'restricted',
  'isfeature',
  'inheritobjects',
  'target',
  'targetparams',
  'islocked',
  'sortby',
  'sortdirection',
  'releasedate',
  'featurestart',
  'featurestop',
  'template',
  'childtemplate',
  'siteid',
  'remoteurl',
] as const satisfies readonly ColumnOf<typeof CONTENT>[];

/** A tree root as `getTop` selects it; `fileid` is the joined file's. */
export type TopRow = Pick<ContentRow, (typeof TOP_FIELDS)[number]> &
  FileJoin<'fileext' | 'fileid'> &
  Nullable<Pick<ContentStatsRow, 'lockid' | 'locktype'>> & { assocfilename: string | null };

/** contentGateway.getTop: the active version of tree root `topId`; file columns as for `readVersion`. */
export async function top(tx: TenantTx, args: { topId: string; siteId: string }): Promise<TopRow[]> {
  await readable(tx, 'content', 'file', 'content_stats');
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  return run(
    tx,
    `SELECT ${columns(CONTENT, 'tcontent', TOP_FIELDS)}, tfiles.fileext, tfiles.filename AS assocfilename, tfiles.fileid,` +
      ' tcontentstats.lockid, tcontentstats.locktype' +
      ` FROM ${t.content} tcontent` +
      ` LEFT JOIN ${t.stats} tcontentstats ON (tcontent.contentid = tcontentstats.contentid AND tcontent.siteid = tcontentstats.siteid)` +
      ` LEFT JOIN ${t.file} tfiles ON (tcontent.fileid = tfiles.fileid)` +
      ` WHERE tcontent.siteid = ${p.add(args.siteId)} AND tcontent.active = 1 AND ${idEq(p, 'tcontent.contentid', args.topId)} ${CLUSTERED_ORDER}`,
    p.values,
  );
}

/** contentGateway.getDownloadSelect: the first and last submission times and the submission count of a form. */
export async function downloadSelect(
  tx: TenantTx,
  args: { contentId: string; siteId: string },
): Promise<{ firstentered: Date | null; lastentered: Date | null; countentered: number }[]> {
  await readable(tx, 'form_response_packet');
  const p = new SqlParams();
  return run(
    tx,
    `SELECT min(entered) AS firstentered, max(entered) AS lastentered, count(*)::integer AS countentered` +
      ` FROM ${qualified(tx.schema, FORM_RESPONSE_PACKET.table)} WHERE siteid = ${p.add(args.siteId)} AND ${idEq(p, 'formid', args.contentId)}`,
    p.values,
  );
}


type ApprovalJoin = { approvalstatus: string | null; requestid: string | null; approvalgroupid: string | null };

const HISTORY_FIELDS = [
  'menutitle',
  'contentid',
  'contenthistid',
  'fileid',
  'type',
  'lastupdateby',
  'lastupdatebyid',
  'active',
  'approved',
  'lastupdate',
  'display',
  'displaystart',
  'displaystop',
  'moduleid',
  'isnav',
  'notes',
  'isfeature',
  'inheritobjects',
  'filename',
  'targetparams',
  'releasedate',
] as const satisfies readonly ColumnOf<typeof CONTENT>[];

/** A version of `getHist`; `changsetpublished` keeps legacy's alias spelling. */
export type HistRow = Pick<
  ContentRow,
  (typeof HISTORY_FIELDS)[number] | 'siteid' | 'featurestart' | 'featurestop' | 'changesetid' | 'majorversion' | 'minorversion'
> &
  ApprovalJoin & { changesetname: string | null; changsetpublished: number | null; changesetpublishdate: Date | null };

/** A version of `getDraftHist` and `getArchiveHist`. */
export type DraftHistRow = Pick<ContentRow, (typeof HISTORY_FIELDS)[number] | 'path'> & ApprovalJoin;

/** A version of `getPendingChangesets`. */
export type PendingChangesetRow = DraftHistRow & {
  changesetpublishdate: Date | null;
  changesetname: string | null;
  changesetid: string;
};

/** A history read, named after its `contentGateway` function. */
export type HistoryRead = 'hist' | 'draftHist' | 'pendingChangesets' | 'archiveHist';

/** The row type of each history read. */
export interface HistoryRows {
  hist: HistRow;
  draftHist: DraftHistRow;
  pendingChangesets: PendingChangesetRow;
  archiveHist: DraftHistRow;
}

// Each read's columns after HISTORY_FIELDS, its tchangesets join ('' for none) and its filter.
const HISTORY_READS: Record<HistoryRead, { select: string; changesets: '' | 'LEFT' | 'INNER'; where: string }> = {
  hist: {
    select:
      'tcontent.siteid, tcontent.featurestart, tcontent.featurestop, tcontent.changesetid, tchangesets.name AS changesetname,' +
      ' tchangesets.published AS changsetpublished, tchangesets.publishdate AS changesetpublishdate, tcontent.majorversion, tcontent.minorversion',
    changesets: 'LEFT',
    where: '',
  },
  draftHist: { select: 'tcontent.path', changesets: '', where: ' AND tcontent.approved = 0 AND tcontent.changesetid IS NULL' },
  pendingChangesets: {
    select: 'tcontent.path, tchangesets.publishdate AS changesetpublishdate, tchangesets.name AS changesetname, tchangesets.changesetid',
    changesets: 'INNER',
    where: ' AND tcontent.approved = 0 AND tcontent.changesetid IS NOT NULL',
  },
  archiveHist: { select: 'tcontent.path', changesets: '', where: ' AND tcontent.approved = 1 AND tcontent.active = 0' },
};

// Legacy's `order by tcontent.lastupdate desc`, ties in SQL Server's clustered (tcontent_id) scan order, then by request.
const HISTORY_ORDER = `${orderKey('tcontent.lastupdate', 'desc')}, tcontent.tcontent_id ASC, ${orderKey('tapprovalrequests.requestid', 'asc')}`;

/** The select list of `read`. */
function historySelect(read: HistoryRead): string {
  return (
    `SELECT ${columns(CONTENT, 'tcontent', HISTORY_FIELDS)}, ${HISTORY_READS[read].select},` +
    ' tapprovalrequests.status AS approvalstatus, tapprovalrequests.requestid, tapprovalrequests.groupid AS approvalgroupid'
  );
}

/** The FROM, joins and WHERE of `read` over the versions of `contentId` in `siteId`, bound into `p`. */
function historyFrom(tx: TenantTx, read: HistoryRead, args: { contentId: string; siteId: string }, p: SqlParams): string {
  const t = tablesFor(tx.schema);
  const { changesets, where } = HISTORY_READS[read];
  const changesetJoin = changesets === '' ? '' : ` ${changesets} JOIN ${t.changeset} tchangesets ON (tcontent.changesetid = tchangesets.changesetid)`;
  return (
    ` FROM ${t.content} tcontent${changesetJoin}` +
    ` LEFT JOIN ${t.approvalRequest} tapprovalrequests ON (tcontent.contenthistid = tapprovalrequests.contenthistid)` +
    ` WHERE ${idEq(p, 'tcontent.contentid', args.contentId)} AND tcontent.siteid = ${p.add(args.siteId)}${where}`
  );
}

/** Every row of `read` over the versions of `contentId` in `siteId`, newest first. */
async function historyOf<K extends HistoryRead>(tx: TenantTx, read: K, args: { contentId: string; siteId: string }): Promise<HistoryRows[K][]> {
  await readable(tx, 'content', 'approval_request', 'changeset');
  const p = new SqlParams();
  return run<HistoryRows[K]>(tx, `${historySelect(read)}${historyFrom(tx, read, args, p)} ORDER BY ${HISTORY_ORDER}`, p.values);
}

/** contentGateway.getHist: every version of a content item, newest first, with its change set and approval request. */
export function hist(tx: TenantTx, args: { contentId: string; siteId: string }): Promise<HistRow[]> {
  return historyOf(tx, 'hist', args);
}

/** contentGateway.getDraftHist: the unapproved versions outside change sets, newest first. */
export function draftHist(tx: TenantTx, args: { contentId: string; siteId: string }): Promise<DraftHistRow[]> {
  return historyOf(tx, 'draftHist', args);
}

/** contentGateway.getPendingChangesets: the unapproved versions in change sets, newest first. */
export function pendingChangesets(tx: TenantTx, args: { contentId: string; siteId: string }): Promise<PendingChangesetRow[]> {
  return historyOf(tx, 'pendingChangesets', args);
}

/** contentGateway.getArchiveHist: the approved versions no longer active, newest first. */
export function archiveHist(tx: TenantTx, args: { contentId: string; siteId: string }): Promise<DraftHistRow[]> {
  return historyOf(tx, 'archiveHist', args);
}

/** Largest history page or batch size (LEGACY_MAX_ROWS). */
export const HISTORY_MAX_PAGE = LEGACY_MAX_ROWS;
/** Rows per `historyBatches` batch by default. */
export const HISTORY_BATCH_SIZE = 500;

/** At most `limit` rows of a history read after its first `offset` rows (default 0). */
export interface HistoryPaging {
  limit: number;
  offset?: number;
}

/** One page of a history read and the read's full row count. */
export interface HistoryPage<R> {
  rows: R[];
  total: number;
}

/** Throws a RangeError unless `value` is an integer from `min` to `max`. */
function checkHistoryCount(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
}

/** A page of a contentGateway history read (getHist and its siblings) with its total, for version history screens and JSON API findVersionHistory. */
export async function historyPage<K extends HistoryRead>(
  tx: TenantTx,
  read: K,
  args: { contentId: string; siteId: string },
  paging: HistoryPaging,
): Promise<HistoryPage<HistoryRows[K]>> {
  const offset = paging.offset ?? 0;
  checkHistoryCount('limit', paging.limit, 1, HISTORY_MAX_PAGE);
  checkHistoryCount('offset', offset, 0, Number.MAX_SAFE_INTEGER);
  await readable(tx, 'content', 'approval_request', 'changeset');
  const c = new SqlParams();
  const [counted] = await run<{ total: number }>(tx, `SELECT count(*)::integer AS total${historyFrom(tx, read, args, c)}`, c.values);
  const total = counted?.total ?? 0;
  if (offset >= total) return { rows: [], total };
  const p = new SqlParams();
  const from = historyFrom(tx, read, args, p);
  const rows = await run<HistoryRows[K]>(
    tx,
    `${historySelect(read)}${from} ORDER BY ${HISTORY_ORDER} LIMIT ${p.add(paging.limit)} OFFSET ${p.add(offset)}`,
    p.values,
  );
  return { rows, total };
}

/** Every row of a contentGateway history read (getHist and its siblings) in keyset batches of history order, where legacy needs every row. */
export async function* historyBatches<K extends HistoryRead>(
  tx: TenantTx,
  read: K,
  args: { contentId: string; siteId: string },
  batchSize = HISTORY_BATCH_SIZE,
): AsyncGenerator<HistoryRows[K][]> {
  checkHistoryCount('batchSize', batchSize, 1, HISTORY_MAX_PAGE);
  await readable(tx, 'content', 'approval_request', 'changeset');
  // HISTORY_ORDER without NULLs: a null lastupdate sorts last descending as -infinity, a null request first as ''.
  const lastUpdate = "COALESCE(tcontent.lastupdate, '-infinity'::timestamp(3))";
  const requestId = "COALESCE(tapprovalrequests.requestid, '')";
  type Cursor = { tcontent_id: number; lastupdate: Date | null; requestid: string | null };
  let after: Cursor | undefined;
  for (;;) {
    const p = new SqlParams();
    const from = historyFrom(tx, read, args, p);
    let seek = '';
    if (after !== undefined) {
      const [u, k, r] = [`${p.add(after.lastupdate ?? '-infinity')}::timestamp(3)`, p.add(after.tcontent_id), p.add(after.requestid ?? '')];
      seek =
        ` AND (${lastUpdate} < ${u} OR (${lastUpdate} = ${u}` +
        ` AND (tcontent.tcontent_id > ${k} OR (tcontent.tcontent_id = ${k} AND ${requestId} > ${r}))))`;
    }
    const rows = await run<Cursor & Record<string, unknown>>(
      tx,
      `${historySelect(read)}, tcontent.tcontent_id${from}${seek}` +
        ` ORDER BY ${lastUpdate} DESC, tcontent.tcontent_id ASC, ${requestId} ASC LIMIT ${p.add(batchSize)}`,
      p.values,
    );
    after = rows.at(-1);
    if (after === undefined) return;
    yield rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'tcontent_id'))) as HistoryRows[K][];
    if (rows.length < batchSize) return;
  }
}

/** The ORDER BY of legacy's query-of-queries: validated sort fields of `fields`, the direction applying to the last. */
function resultOrder(sortBy: string, sortDirection: string, fields: readonly string[]): string {
  const direction = sortDirection.trim().toLowerCase();
  if (direction !== 'asc' && direction !== 'desc') {
    throw new ContentQueryError(`Invalid sort direction '${sortDirection}'. Only 'asc' or 'desc' allowed to prevent SQL injection.`);
  }
  const keys = cfList(sortBy).map((field) => {
    const name = field.trim().toLowerCase();
    if (!fields.includes(name)) {
      throw new ContentQueryError(`Invalid sort by field: '${field.trim()}'`);
    }
    return name;
  });
  return keys.map((key, i) => orderKey(`d.${key}`, i === keys.length - 1 ? direction : 'asc')).join(', ');
}

/** `getDraftList`'s "day" bounds: `stopDate` at 23:59 and `startDate` at midnight, on the `column` of `alias`. */
function dayBounds(p: SqlParams, column: string, args: { startDate?: Date | null; stopDate?: Date | null }): string {
  const stop = args.stopDate ? ` AND ${column} <= ${p.add(onDay(args.stopDate, 23, 59))}` : '';
  const start = args.startDate ? ` AND ${column} >= ${p.add(onDay(args.startDate, 0, 0))}` : '';
  return `${stop}${start}`;
}

const DRAFT_LIST_FIELDS = [
  'contenthistid',
  'module',
  'moduleid',
  'siteid',
  'parentid',
  'type',
  'subtype',
  'menutitle',
  'filename',
  'contentid',
  'targetparams',
  'lastupdate',
  'lastupdateby',
  'fileext',
  'changesetid',
  'majorversion',
  'minorversion',
  'lockid',
  'locktype',
  'expires',
] as const;

/** A draft of `getDraftList`. */
export type DraftListRow = Pick<
  ContentRow,
  | 'contenthistid'
  | 'moduleid'
  | 'siteid'
  | 'parentid'
  | 'type'
  | 'subtype'
  | 'menutitle'
  | 'filename'
  | 'contentid'
  | 'targetparams'
  | 'lastupdate'
  | 'lastupdateby'
  | 'changesetid'
  | 'majorversion'
  | 'minorversion'
  | 'expires'
> & { module: string | null; fileext: string | null; lockid: string | null; locktype: string | null };

/** Sorting and paging arguments of the draft and approval lists, as legacy names them. */
export interface DraftListPaging {
  /** Defaults to every row. */
  limit?: number;
  startDate?: Date | null;
  stopDate?: Date | null;
  /** A CF list of result columns; defaults to `lastUpdate`. */
  sortBy?: string;
  sortDirection?: string;
}

/**
 * contentGateway.getDraftList: the drafts assigned to or saved by `userId` that are newer than, or replace, the
 * active version, outside change sets and approval requests. Versions select the draft's or the active version's
 * columns exactly as each of legacy's four queries does; file columns as for `readVersion`.
 */
export async function draftList(tx: TenantTx, args: DraftListPaging & { siteId: string; userId: string }): Promise<DraftListRow[]> {
  const order = resultOrder(args.sortBy ?? 'lastUpdate', sortDirectionOf(args.sortDirection, 'desc'), DRAFT_LIST_FIELDS);
  await readable(tx, 'content', 'content_assignment', 'file', 'content_stats', 'approval_request');
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const select = (source: 'active' | 'draft'): string =>
    `SELECT draft.contenthistid, module.title AS module, ${source}.moduleid, ${source}.siteid, ${source}.parentid, ${source}.type,` +
    ` ${source}.subtype, ${source}.menutitle, ${source}.filename, ${source}.contentid, ${source}.targetparams, draft.lastupdate,` +
    ' draft.lastupdateby, tfiles.fileext, draft.changesetid, draft.majorversion, draft.minorversion, tcontentstats.lockid,' +
    ' tcontentstats.locktype, draft.expires';
  const module = `INNER JOIN ${t.content} module ON (draft.moduleid = module.contentid AND draft.siteid = module.siteid)`;
  const statsJoin = `LEFT JOIN ${t.stats} tcontentstats ON (draft.contentid = tcontentstats.contentid AND draft.siteid = tcontentstats.siteid)`;
  const notRequested = (): string =>
    `draft.contenthistid NOT IN (SELECT contenthistid FROM ${t.approvalRequest} WHERE siteid = ${p.add(args.siteId)})`;
  const sites = (withActive: boolean): string =>
    ` AND module.siteid = ${p.add(args.siteId)} AND draft.siteid = ${p.add(args.siteId)}` +
    (withActive ? ` AND active.siteid = ${p.add(args.siteId)}` : '');
  const assigned = (on: 'active' | 'draft'): string =>
    `INNER JOIN ${t.assignment} tcontentassignments ON (${on}.contentid = tcontentassignments.contentid AND ${ciLiterals('tcontentassignments.type', ['draft'])})`;
  const newerDraft = (by: string): string =>
    `${select('active')} FROM ${t.content} active INNER JOIN ${t.content} draft ON active.contentid = draft.contentid ${module}` +
    ` ${by} LEFT JOIN ${t.file} tfiles ON active.fileid = tfiles.fileid ${statsJoin}` +
    ` WHERE draft.active = 0 AND draft.approved = 0 AND ${notRequested()} AND active.active = 1 AND draft.lastupdate > active.lastupdate` +
    ' AND draft.changesetid IS NULL';
  const unpublished = (by: string): string =>
    `${select('draft')} FROM ${t.content} draft ${module} ${by}` +
    ` LEFT JOIN ${t.content} active ON draft.contentid = active.contentid AND active.approved = 1` +
    ` LEFT JOIN ${t.file} tfiles ON draft.fileid = tfiles.fileid ${statsJoin}` +
    ` WHERE draft.active = 1 AND draft.approved = 0 AND ${notRequested()} AND active.contentid IS NULL AND draft.changesetid IS NULL`;
  const queries = [
    `${newerDraft(assigned('active'))} AND ${idEq(p, 'tcontentassignments.userid', args.userId)}` +
      `${dayBounds(p, 'draft.lastupdate', args)}${sites(true)}`,
    `${unpublished(assigned('draft'))} AND ${idEq(p, 'tcontentassignments.userid', args.userId)}` +
      `${dayBounds(p, 'draft.lastupdate', args)}${sites(false)}`,
    `${newerDraft('')} AND ${ciEq(p, 'draft.lastupdatebyid', args.userId)}${dayBounds(p, 'draft.lastupdate', args)}${sites(true)}`,
    `${unpublished('')} AND ${ciEq(p, 'draft.lastupdatebyid', args.userId)}${dayBounds(p, 'draft.lastupdate', args)}${sites(false)}`,
  ];
  const limit = args.limit !== undefined ? ` LIMIT ${p.add(Math.trunc(args.limit))}` : '';
  return run(tx, `SELECT * FROM (${queries.join(' UNION ')}) d ORDER BY ${order}${limit}`, p.values);
}

const APPROVAL_LIST_FIELDS = [...DRAFT_LIST_FIELDS, 'approvalstatus', 'displaystart', 'publishdate'] as const;

/** A pending version of `getApprovals` and `getSubmissions`. */
export type ApprovalListRow = DraftListRow & {
  approvalstatus: string | null;
  displaystart: Date | null;
  publishdate: Date | null;
};

/** The pending approval requests of `siteId` that `requester` narrows, as getApprovals and getSubmissions read them. */
async function pendingRequests(
  tx: TenantTx,
  args: DraftListPaging & { siteId: string },
  requester: (p: SqlParams) => string,
): Promise<ApprovalListRow[]> {
  const order = resultOrder(args.sortBy ?? 'lastUpdate', args.sortDirection ?? 'desc', APPROVAL_LIST_FIELDS);
  await readable(tx, 'content', 'file', 'content_stats', 'changeset', 'approval_request');
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const selected =
    'draft.contenthistid, module.title, draft.moduleid, draft.siteid, draft.parentid, draft.type, draft.subtype, draft.menutitle,' +
    ' draft.filename, draft.contentid, draft.targetparams, draft.lastupdate, draft.lastupdateby, tfiles.fileext, draft.changesetid,' +
    ' draft.majorversion, draft.minorversion, tcontentstats.lockid, tcontentstats.locktype, draft.expires, tapprovalrequests.status,' +
    ' draft.displaystart, tchangesets.publishdate';
  const query =
    'SELECT DISTINCT draft.contenthistid, module.title AS module, draft.moduleid, draft.siteid, draft.parentid, draft.type,' +
    ' draft.subtype, draft.menutitle, draft.filename, draft.contentid, draft.targetparams, draft.lastupdate, draft.lastupdateby,' +
    ' tfiles.fileext, draft.changesetid, draft.majorversion, draft.minorversion, tcontentstats.lockid, tcontentstats.locktype,' +
    ' draft.expires, tapprovalrequests.status AS approvalstatus, draft.displaystart, tchangesets.publishdate' +
    ` FROM ${t.content} draft INNER JOIN ${t.content} module ON (draft.moduleid = module.contentid AND draft.siteid = module.siteid)` +
    ` LEFT JOIN ${t.content} active ON (draft.contentid = active.contentid AND active.approved = 1 AND draft.siteid = active.siteid)` +
    ` LEFT JOIN ${t.file} tfiles ON draft.fileid = tfiles.fileid` +
    ` LEFT JOIN ${t.stats} tcontentstats ON (draft.contentid = tcontentstats.contentid AND draft.siteid = tcontentstats.siteid)` +
    ` LEFT JOIN ${t.changeset} tchangesets ON (draft.changesetid = tchangesets.changesetid)` +
    ` INNER JOIN ${t.approvalRequest} tapprovalrequests ON (tapprovalrequests.contenthistid = draft.contenthistid)` +
    ` WHERE draft.siteid = ${p.add(args.siteId)} AND (draft.active = 0 OR draft.active = 1 AND draft.approved = 0)` +
    ` AND ${ciLiterals('tapprovalrequests.status', ['Pending'])}${requester(p)}${dayBounds(p, 'active.lastupdate', args)}` +
    ` GROUP BY ${selected}, draft.isnav, module.siteid`;
  const limit = args.limit !== undefined ? ` LIMIT ${p.add(Math.trunc(args.limit))}` : '';
  return run(tx, `SELECT * FROM (${query}) d ORDER BY ${order}${limit}`, p.values);
}

/**
 * contentGateway.getApprovals: the pending approval requests of a site, limited to requests of `groupIds` (the
 * user's groups from `membership_projection`); null lifts the limit, as legacy does for admin and super users.
 */
export function approvalsQuery(
  tx: TenantTx,
  args: DraftListPaging & { siteId: string; groupIds: readonly string[] | null },
): Promise<ApprovalListRow[]> {
  const { groupIds } = args;
  return pendingRequests(tx, args, (p) => (groupIds === null ? '' : ` AND ${idIn(p, 'tapprovalrequests.groupid', groupIds)}`));
}

/** contentGateway.getSubmissions: the pending approval requests `userId` submitted in a site. */
export function submissionsQuery(tx: TenantTx, args: DraftListPaging & { siteId: string; userId: string }): Promise<ApprovalListRow[]> {
  return pendingRequests(tx, args, (p) => ` AND ${idEq(p, 'tapprovalrequests.userid', args.userId)}`);
}

/** contentGateway.getExpiringContent: content `userId` updated or is notified about that expires within a month or expired within a year of `today`. */
export async function expiringContent(
  tx: TenantTx,
  args: { siteId: string; userId: string; today: Date },
): Promise<{ contentid: string | null }[]> {
  await readable(tx, 'content', 'content_assignment');
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const window = (column: string): string =>
    `${column} <= ${p.add(addMonths(args.today, 1))} AND ${column} > ${p.add(addMonths(args.today, -12))}`;
  return run(
    tx,
    `SELECT contentid FROM ${t.content} WHERE ${ciEq(p, 'lastupdatebyid', args.userId)} AND active = 1 AND siteid = ${p.add(args.siteId)}` +
      ` AND ${window('expires')}` +
      ` UNION SELECT tcontent.contentid FROM ${t.content} tcontent INNER JOIN ${t.assignment} tcontentassignments` +
      ` ON (tcontent.contenthistid = tcontentassignments.contenthistid AND ${ciLiterals('tcontentassignments.type', ['expire'])})` +
      ` WHERE tcontent.active = 1 AND tcontent.siteid = ${p.add(args.siteId)} AND ${idEq(p, 'tcontentassignments.userid', args.userId)}` +
      ` AND ${window('tcontent.expires')} ORDER BY contentid LIMIT ${LEGACY_MAX_ROWS}`,
    p.values,
  );
}

/** contentGateway.getLockedContentCount: the content items `userId` holds locks on in a site. */
export async function lockedContentCount(tx: TenantTx, args: { siteId: string; userId: string }): Promise<number> {
  await readable(tx, 'content_stats');
  const p = new SqlParams();
  const rows = await run<{ thecount: number }>(
    tx,
    `SELECT count(*)::integer AS thecount FROM ${qualified(tx.schema, CONTENT_STATS.table)}` +
      ` WHERE ${idEq(p, 'lockid', args.userId)} AND siteid = ${p.add(args.siteId)}`,
    p.values,
  );
  return rows[0]?.thecount ?? 0;
}

/** A pending change-set version of `changesetManager.getPendingByContentID`. */
export type PendingByContentRow = Pick<ContentRow, 'contentid' | 'contenthistid' | 'siteid' | 'menutitle' | 'lastupdate' | 'lastupdateby'> &
  ApprovalJoin & {
    changesetid: string;
    changesetname: string | null;
    publishdate: Date | null;
    closedate: Date | null;
  };

/** The rows `contentManager.getDraftPromptData` decides from; the verdict, lock and dialog logic stays with the caller. */
export interface DraftPromptData {
  /** The active version (`content.loadBy`), or null. */
  active: ContentVersionRow | null;
  draftHist: DraftHistRow[];
  /** `changesetManager.getPendingByContentID`: versions in unpublished change sets. */
  pendingChangesets: PendingByContentRow[];
  stats: StatsRow | null;
}

/** contentManager.getDraftPromptData: the active version, drafts, pending change-set versions and stats of a content item. */
export async function draftPromptData(
  tx: TenantTx,
  args: { contentId: string; siteId: string; preview?: ChangesetPreview | null },
): Promise<DraftPromptData> {
  await readable(tx, 'content', 'file', 'approval_request', 'changeset', 'content_stats');
  const [active] = await readActive(tx, args);
  const history = await draftHist(tx, args);
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const pending = await run<PendingByContentRow>(
    tx,
    'SELECT tchangesets.changesetid, tcontent.contentid, tcontent.contenthistid, tcontent.siteid, tcontent.menutitle,' +
      ' tchangesets.name AS changesetname, tapprovalrequests.status AS approvalstatus, tapprovalrequests.requestid,' +
      ' tcontent.lastupdate, tcontent.lastupdateby, tapprovalrequests.groupid AS approvalgroupid, tchangesets.publishdate,' +
      ` tchangesets.closedate FROM ${t.content} tcontent INNER JOIN ${t.changeset} tchangesets ON tcontent.changesetid = tchangesets.changesetid` +
      ` LEFT JOIN ${t.approvalRequest} tapprovalrequests ON (tcontent.contenthistid = tapprovalrequests.contenthistid)` +
      ` WHERE tcontent.siteid = ${p.add(args.siteId)} AND ${idEq(p, 'tcontent.contentid', args.contentId)} AND tchangesets.published = 0` +
      ` ${CLUSTERED_ORDER}`,
    p.values,
  );
  return { active: active ?? null, draftHist: history, pendingChangesets: pending, stats: await stats(tx, args) };
}


const SEARCH_TYPES = ['Page', 'Folder', 'Calendar', 'File', 'Link', 'Gallery', 'Form', 'Component', 'Variation'];
// getPrivateSearch's default moduleid list: the site tree, components and forms.
const PRIVATE_SEARCH_MODULES = [SITE_TREE_MODULE_ID, '00000000000000000000000000000000003', '00000000000000000000000000000000004'];
// File ids per poolFileMatches lookup.
const POOL_FILE_BATCH = 1000;

/**
 * The files of a site's file pool that a private image or file search matches, for a site whose file pool is another
 * tenant. The caller reads `privateSearchFileIds` in the content tenant, `poolFileMatches` with those ids in the
 * file-pool tenant, then `privateSearch` with these as `pooledFiles`.
 */
export interface PooledFileMatches {
  /** The listed files the search may return: images for an image search, every file for a file search. */
  fileIds: readonly string[];
  /** Those of them whose caption, credits, alt text or filename contain the keywords. */
  keywordFileIds: readonly string[];
}

/**
 * The file-pool half of an image or file `privateSearch` for a site whose files are kept in this tenant's pool, over
 * the `fileIds` from `privateSearchFileIds`, looked up `batchSize` ids at a time; results are sorted by file id.
 */
export async function poolFileMatches(
  tx: TenantTx,
  args: { keywords: string; searchType: string; fileIds: readonly string[] },
  batchSize = POOL_FILE_BATCH,
): Promise<PooledFileMatches> {
  const searchType = args.searchType.toLowerCase();
  if ((searchType !== 'image' && searchType !== 'file') || args.fileIds.length === 0) {
    return { fileIds: [], keywordFileIds: [] };
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`poolFileMatches needs a positive integer batch size, not ${batchSize}`);
  }
  await readable(tx, 'file');
  const kw = args.keywords.trim();
  const ids = [...new Map(args.fileIds.map((id) => [id.toLowerCase(), id])).values()];
  const image = searchType === 'image' ? ciLiterals('tfiles.fileext', IMAGE_EXTENSIONS) : 'TRUE';
  const batches: { fileid: string; matches: boolean }[][] = [];
  for (let start = 0; start < ids.length; start += batchSize) {
    const p = new SqlParams();
    const matches =
      kw === ''
        ? 'FALSE'
        : ['caption', 'credits', 'alttext', 'filename'].map((column) => ciLike(p, `tfiles.${column}`, `%${kw}%`)).join(' OR ');
    batches.push(
      await run<{ fileid: string; matches: boolean }>(
        tx,
        `SELECT tfiles.fileid, (${matches}) AS matches FROM ${qualified(tx.schema, FILE.table)} tfiles` +
          ` WHERE ${idIn(p, 'tfiles.fileid', ids.slice(start, start + batchSize))} AND ${image} ORDER BY tfiles.fileid`,
        p.values,
      ),
    );
  }
  const rows = batches.flat();
  const matched = new Set(rows.filter((row) => row.matches).map((row) => row.fileid));
  // Rows of several batches are merged in the database's own fileid order.
  const fileIds =
    batches.filter((batch) => batch.length > 0).length > 1
      ? (
          await run<{ fileid: string }>(
            tx,
            'SELECT f.fileid FROM unnest($1::bpchar[]) AS f(fileid) ORDER BY f.fileid',
            [rows.map((row) => row.fileid)],
          )
        ).map((row) => row.fileid)
      : rows.map((row) => row.fileid);
  return { fileIds, keywordFileIds: fileIds.filter((id) => matched.has(id)) };
}

/** Arguments of `privateSearch`, as `contentGateway.getPrivateSearch` names them. */
export interface PrivateSearchArgs {
  siteId: string;
  keywords: string;
  tag?: string;
  sectionId?: string;
  /** `default`, `image` or `file`. */
  searchType?: string;
  /** A CF list of module ids; defaults to the site tree, components and forms. */
  moduleId?: string;
  /** For image and file searches, `siteId` and the sites whose file pool it is (legacy's `tsettings` subquery). */
  filePoolSiteIds?: readonly string[];
  /** Set when the site's file pool is another tenant; the file table is then not joined. */
  pooledFiles?: PooledFileMatches;
}

/** A result of `getPrivateSearch`. */
export type PrivateSearchRow = Pick<
  ContentRow,
  | 'contenthistid'
  | 'contentid'
  | 'approved'
  | 'filename'
  | 'active'
  | 'type'
  | 'orderno'
  | 'parentid'
  | 'title'
  | 'menutitle'
  | 'lastupdate'
  | 'lastupdateby'
  | 'lastupdatebyid'
  | 'display'
  | 'displaystart'
  | 'subtype'
  | 'displaystop'
  | 'isnav'
  | 'restricted'
  | 'isfeature'
  | 'inheritobjects'
  | 'target'
  | 'targetparams'
  | 'islocked'
  | 'releasedate'
  | 'nextn'
  | 'majorversion'
  | 'minorversion'
  | 'expires'
> &
  FileJoin<'filesize' | 'fileext' | 'fileid'> &
  Nullable<Pick<ContentStatsRow, 'lockid' | 'locktype'>> & {
    haskids: number;
    priority: number;
    assocfilename: string | null;
    filealttext: string | null;
    supersort: number;
  };

const PRIVATE_SEARCH_FIELDS = [
  'contenthistid',
  'contentid',
  'approved',
  'filename',
  'active',
  'type',
  'orderno',
  'parentid',
  'title',
  'menutitle',
  'lastupdate',
  'lastupdateby',
  'lastupdatebyid',
  'display',
  'displaystart',
  'subtype',
  'displaystop',
  'isnav',
  'restricted',
  'isfeature',
  'inheritobjects',
  'target',
  'targetparams',
  'islocked',
  'releasedate',
  'nextn',
  'majorversion',
  'minorversion',
  'expires',
] as const satisfies readonly ColumnOf<typeof CONTENT>[];

/** getPrivateSearch's module ids: the CF list `moduleId`, else the site tree, components and forms. */
function privateSearchModules(args: PrivateSearchArgs): string[] {
  return args.moduleId === undefined ? PRIVATE_SEARCH_MODULES : cfList(args.moduleId);
}

/** getPrivateSearch's site, content type and section scope of `tcontent`; a file search spans `filePoolSiteIds`. */
function privateSearchScope(p: SqlParams, args: PrivateSearchArgs, fileSearch: boolean): string {
  return (
    (fileSearch ? `tcontent.siteid = ANY(${p.add(args.filePoolSiteIds ?? [args.siteId])}::text[])` : `tcontent.siteid = ${p.add(args.siteId)}`) +
    ` AND ${ciLiterals('tcontent.type', SEARCH_TYPES)}` +
    (args.sectionId !== undefined && args.sectionId !== '' ? ` AND ${ciLike(p, 'tcontent.path', `%${args.sectionId}%`)}` : '')
  );
}

/**
 * The content half of a pooled image or file getPrivateSearch: the distinct files of the active versions in its site,
 * type, section and module scope, none without keywords or a tag. Read in the content tenant for `poolFileMatches`.
 */
export async function privateSearchFileIds(tx: TenantTx, args: PrivateSearchArgs): Promise<string[]> {
  const searchType = (args.searchType ?? 'default').toLowerCase();
  if ((searchType !== 'image' && searchType !== 'file') || (args.keywords.trim() === '' && (args.tag ?? '') === '')) {
    return [];
  }
  await readable(tx, 'content');
  const p = new SqlParams();
  const rows = await run<{ fileid: string }>(
    tx,
    `SELECT DISTINCT tcontent.fileid FROM ${qualified(tx.schema, CONTENT.table)} tcontent` +
      ` WHERE tcontent.active = 1 AND tcontent.fileid IS NOT NULL AND ${privateSearchScope(p, args, true)}` +
      ` AND ${idIn(p, 'tcontent.moduleid', privateSearchModules(args))} ORDER BY tcontent.fileid`,
    p.values,
  );
  return rows.map((row) => row.fileid);
}

/**
 * contentGateway.getPrivateSearch (admin `carch.search`, `cnav.searchsitedata`, associated-file search): up to 1000
 * versions matching `keywords` or `tag`, exact title matches first. Where the site's file pool is another tenant the
 * caller passes `pooledFiles` (see `PooledFileMatches`); `fileid` is then the version's file when it is one of the
 * pool's files, and the other file columns are null for the caller to fill with `fileJoinColumns` there.
 */
export async function privateSearch(tx: TenantTx, args: PrivateSearchArgs): Promise<PrivateSearchRow[]> {
  const kw = args.keywords.trim();
  const tag = args.tag ?? '';
  const searchType = (args.searchType ?? 'default').toLowerCase();
  const fileSearch = searchType === 'image' || searchType === 'file';
  const pooled = args.pooledFiles;
  await readable(
    tx,
    'content',
    'content_stats',
    'file_metadata',
    'extend_data',
    ...(pooled === undefined ? (['file'] as const) : []),
    ...(tag !== '' ? (['content_tag'] as const) : []),
  );
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const modules = privateSearchModules(args);
  const fileColumns =
    pooled === undefined
      ? 'tfiles.filesize, tfiles.fileext, tfiles.fileid, tfiles.filename AS assocfilename'
      : `NULL::integer AS filesize, NULL::text AS fileext,` +
        ` CASE WHEN ${idIn(p, 'tcontent.fileid', pooled.fileIds)} THEN tcontent.fileid END AS fileid, NULL::text AS assocfilename`;
  const grouped =
    `${columns(CONTENT, 'tcontent', PRIVATE_SEARCH_FIELDS)}, tcontentstats.lockid, tcontentstats.locktype, tcontentfilemetadata.alttext` +
    (pooled === undefined ? ', tfiles.filesize, tfiles.fileext, tfiles.fileid, tfiles.filename' : ', tcontent.fileid');
  const selectFor = (priority: number): string =>
    `SELECT ${columns(CONTENT, 'tcontent', PRIVATE_SEARCH_FIELDS)}, count(tcontent2.parentid)::integer AS haskids, ${priority} AS priority,` +
    ` ${fileColumns}, tcontentstats.lockid, tcontentstats.locktype, tcontentfilemetadata.alttext AS filealttext,` +
    ` CASE WHEN ${ciEq(p, 'tcontent.title', args.keywords)} OR ${ciEq(p, 'tcontent.menutitle', args.keywords)} THEN 0 ELSE 1 END AS supersort`;
  const fileJoin = (inner: boolean): string =>
    pooled === undefined ? ` ${inner ? 'INNER' : 'LEFT'} JOIN ${t.file} tfiles ON (tcontent.fileid = tfiles.fileid)` : '';
  // Without the file table, the inner join's existence test becomes membership of the pool's matching files.
  const fileRequired = (inner: boolean): string =>
    pooled !== undefined && inner ? ` AND ${idIn(p, 'tcontent.fileid', pooled.fileIds)}` : '';
  const imageOnly = (): string =>
    searchType === 'image' && pooled === undefined ? `${ciLiterals('tfiles.fileext', IMAGE_EXTENSIONS)} AND ` : '';
  const from = (innerFile: boolean, withTag: boolean): string =>
    ` FROM ${t.content} tcontent LEFT JOIN ${t.content} tcontent2 ON (tcontent.contentid = tcontent2.parentid)` +
    ` LEFT JOIN ${t.stats} tcontentstats ON (tcontent.contentid = tcontentstats.contentid AND tcontent.siteid = tcontentstats.siteid)` +
    fileJoin(innerFile) +
    (withTag ? ` INNER JOIN ${t.tag} tcontenttags ON (tcontent.contenthistid = tcontenttags.contenthistid)` : '') +
    ` LEFT JOIN ${t.fileMetadata} tcontentfilemetadata ON (tcontent.fileid = tcontentfilemetadata.fileid` +
    ' AND tcontent.contenthistid = tcontentfilemetadata.contenthistid)';
  const scope = (): string => privateSearchScope(p, args, fileSearch);
  const keywordMatch = (): string => {
    const like = (expr: string): string => ciLike(p, expr, `%${kw}%`);
    const fileMatches = !fileSearch
      ? []
      : pooled === undefined
        ? ['tfiles.caption', 'tfiles.credits', 'tfiles.alttext', 'tfiles.filename'].map(like)
        : [idIn(p, 'tcontent.fileid', pooled.keywordFileIds)];
    const metadataMatches = fileSearch ? ['tcontentfilemetadata.caption', 'tcontentfilemetadata.credits', 'tcontentfilemetadata.alttext'].map(like) : [];
    return (
      `(${[like('tcontent.title'), like('tcontent.menutitle'), like('tcontent.summary'), ...fileMatches, ...metadataMatches].join(' OR ')}` +
      ` OR (NOT (${ciLiterals('tcontent.type', ['Link', 'File'])}) AND ${ciLike(p, 'tcontent.body', `%${args.keywords}%`)})` +
      ` OR tcontent.contenthistid IN (SELECT DISTINCT tcontent.contenthistid FROM ${t.extendData} tclassextenddata` +
      ` INNER JOIN ${t.content} tcontent ON (tclassextenddata.baseid = tcontent.contenthistid)` +
      ` WHERE tcontent.active = 1 AND tcontent.siteid = ${p.add(args.siteId)} AND ${like('tclassextenddata.attributevalue')}))` +
      ` AND NOT (${ciEq(p, 'tcontent.title', kw)} OR ${ciEq(p, 'tcontent.menutitle', kw)})`
    );
  };
  const broad =
    kw !== '' || tag !== ''
      ? `tcontent.active = 1 AND ${scope()} AND ${tag !== '' ? ciEq(p, 'tcontenttags.tag', tag.trim()) : keywordMatch()}` +
        ` AND ${idIn(p, 'tcontent.moduleid', modules)}${fileRequired(fileSearch)}`
      : '0 = 1';
  const queries = [`${selectFor(2)}${from(fileSearch, tag !== '')} WHERE ${imageOnly()}${broad} GROUP BY ${grouped}`];
  if (kw !== '') {
    const imageInner = searchType === 'image';
    queries.push(
      `${selectFor(1)}${from(imageInner, false)} WHERE ${imageOnly()}tcontent.active = 1 AND ${idIn(p, 'tcontent.moduleid', modules)}` +
        ` AND ${scope()} AND (${ciEq(p, 'tcontent.title', kw)} OR ${ciEq(p, 'tcontent.menutitle', kw)})${fileRequired(imageInner)}` +
        ` GROUP BY ${grouped}`,
    );
  }
  return run(
    tx,
    `SELECT * FROM (${queries.join(' UNION ')}) d` +
      ` ORDER BY ${orderKey('d.supersort', 'asc')}, ${orderKey('d.priority', 'asc')}, ${orderKey(textSort('d.title'), 'asc')} LIMIT ${LEGACY_MAX_ROWS}`,
    p.values,
  );
}


/** Arguments of `publicSearch`, as `contentGateway.getPublicSearch` names them. */
export interface PublicSearchArgs {
  siteId: string;
  keywords: string;
  /** A CF list of tags; searches by tag instead of keywords. */
  tag?: string;
  tagGroup?: string;
  sectionId?: string;
  /** Category ids with their descendants, resolved by the caller in the category-pool tenant; undefined filters nothing. */
  categoryIds?: readonly string[];
  /** The caller's clock, which display windows compare. */
  today: Date;
  mobile?: boolean;
}

/** A result of `getPublicSearch`. */
export type PublicSearchRow = Pick<
  ContentRow,
  | 'contentid'
  | 'contenthistid'
  | 'siteid'
  | 'title'
  | 'menutitle'
  | 'targetparams'
  | 'filename'
  | 'summary'
  | 'tags'
  | 'restricted'
  | 'releasedate'
  | 'type'
  | 'subtype'
  | 'restrictgroups'
  | 'target'
  | 'displaystart'
  | 'displaystop'
  | 'credits'
  | 'remotesource'
  | 'remotesourceurl'
  | 'remoteurl'
  | 'fileid'
  | 'audience'
  | 'keypoints'
  | 'nextn'
  | 'path'
  | 'orderno'
  | 'lastupdate'
  | 'created'
  | 'majorversion'
  | 'minorversion'
  | 'expires'
> &
  FileJoin<'filesize' | 'fileext'> &
  Nullable<Pick<ContentStatsRow, 'rating' | 'totalvotes' | 'downvotes' | 'upvotes' | 'lockid' | 'locktype'>> & {
    comments: number;
    kids: number;
    parenttype: string | null;
    sortdate: Date | null;
    priority: number;
    assocfilename: string | null;
    filealttext: string | null;
    supersort: number;
  };

/**
 * contentGateway.getPublicSearch (JSON API keyword `findQuery`): up to 1000 live, searchable pages matching `keywords`
 * or `tag`, exact title matches first, then newest. File columns are null where the site's file pool is another
 * tenant; the caller fills them with `fileJoinColumns` there.
 */
export async function publicSearch(tx: TenantTx, args: PublicSearchArgs): Promise<PublicSearchRow[]> {
  const tag = args.tag ?? '';
  await readable(
    tx,
    'content',
    'file',
    'content_stats',
    'file_metadata',
    'extend_data',
    ...(tag !== '' ? (['content_tag'] as const) : []),
    ...(args.categoryIds !== undefined ? (['content_category_assign'] as const) : []),
  );
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const like = (expr: string): string => ciLike(p, expr, `%${args.keywords}%`);
  const branch = (released: boolean): string => {
    const match =
      tag !== ''
        ? `(${ciIn(p, 'tcontenttags.tag', cfList(tag))}` +
          (args.tagGroup !== undefined && args.tagGroup !== '' && args.tagGroup.toLowerCase() !== 'default'
            ? ` AND ${ciEq(p, 'tcontenttags.taggroup', args.tagGroup)}`
            : '') +
          ')'
        : `(${like('tcontent.title')} OR ${like('tcontent.menutitle')} OR ${like('tcontent.metakeywords')} OR ${like('tcontent.summary')}` +
          ` OR (NOT (${ciLiterals('tcontent.type', ['Link', 'File'])}) AND ${like('tcontent.body')}) OR ${like('tcontent.credits')}` +
          ` OR tcontent.contenthistid IN (SELECT DISTINCT tcontent.contenthistid FROM ${t.extendData} tclassextenddata` +
          ` INNER JOIN ${t.content} tcontent ON (tclassextenddata.baseid = tcontent.contenthistid)` +
          ` WHERE tcontent.active = 1 AND tcontent.siteid = ${p.add(args.siteId)} AND ${like('tclassextenddata.attributevalue')}))`;
    const categories =
      args.categoryIds !== undefined
        ? ` AND tcontent.contenthistid IN (SELECT tcontentcategoryassign.contenthistid FROM ${t.categoryAssign} tcontentcategoryassign` +
          ` WHERE ${idIn(p, 'tcontentcategoryassign.categoryid', args.categoryIds)})`
        : '';
    return (
      'SELECT tcontent.contentid, tcontent.contenthistid, tcontent.siteid, tcontent.title, tcontent.menutitle, tcontent.targetparams,' +
      ' tcontent.filename, tcontent.summary, tcontent.tags, tcontent.restricted, tcontent.releasedate, tcontent.type, tcontent.subtype,' +
      ' tcontent.restrictgroups, tcontent.target, tcontent.displaystart, tcontent.displaystop, 0 AS comments, tcontent.credits,' +
      ' tcontent.remotesource, tcontent.remotesourceurl, tcontent.remoteurl, tfiles.filesize, tfiles.fileext, tcontent.fileid,' +
      ' tcontent.audience, tcontent.keypoints, tcontentstats.rating, tcontentstats.totalvotes, tcontentstats.downvotes,' +
      ' tcontentstats.upvotes, 0 AS kids, tparent.type AS parenttype, tcontent.nextn, tcontent.path, tcontent.orderno,' +
      ` tcontent.lastupdate, tcontent.created, tcontent.${released ? 'releasedate' : 'created'} AS sortdate, 0 AS priority,` +
      ' tcontent.majorversion, tcontent.minorversion, tcontentstats.lockid, tcontentstats.locktype, tcontent.expires,' +
      ' tfiles.filename AS assocfilename, tcontentfilemetadata.alttext AS filealttext,' +
      ` CASE WHEN ${ciEq(p, 'tcontent.title', args.keywords)} OR ${ciEq(p, 'tcontent.menutitle', args.keywords)} THEN 0 ELSE 1 END AS supersort` +
      ` FROM ${t.content} tcontent LEFT JOIN ${t.file} tfiles ON (tcontent.fileid = tfiles.fileid)` +
      ` LEFT JOIN ${t.content} tparent ON (tcontent.parentid = tparent.contentid AND tcontent.siteid = tparent.siteid AND tparent.active = 1)` +
      ` LEFT JOIN ${t.stats} tcontentstats ON (tcontent.contentid = tcontentstats.contentid AND tcontent.siteid = tcontentstats.siteid)` +
      ` LEFT JOIN ${t.fileMetadata} tcontentfilemetadata ON (tcontent.fileid = tcontentfilemetadata.fileid` +
      ' AND tcontent.contenthistid = tcontentfilemetadata.contenthistid)' +
      (tag !== '' ? ` INNER JOIN ${t.tag} tcontenttags ON (tcontent.contenthistid = tcontenttags.contenthistid)` : '') +
      ` WHERE (tcontent.active = 1 AND tcontent.approved = 1 AND tcontent.siteid = ${p.add(args.siteId)})` +
      ` AND (tcontent.display = 2 AND ((tcontent.displaystart <= ${p.add(args.today)}` +
      ` AND (tcontent.displaystop >= ${p.add(args.today)} OR tcontent.displaystop IS NULL)) OR ${ciLiterals('tparent.type', ['Calendar'])})` +
      ' OR tcontent.display = 1)' +
      ` AND ${ciLiterals('tcontent.type', ['Page', 'Folder', 'Calendar', 'File', 'Link', 'Gallery'])}` +
      ` AND tcontent.releasedate IS ${released ? 'NOT ' : ''}NULL` +
      (args.sectionId !== undefined && args.sectionId !== '' ? ` AND ${ciLike(p, 'tcontent.path', `%${args.sectionId}%`)}` : '') +
      ` AND ${match} AND tcontent.searchexclude = 0${categories} AND ${mobileClause('tcontent', args.mobile)}`
    );
  };
  return run(
    tx,
    `SELECT * FROM (${branch(false)} UNION ALL ${branch(true)}) d` +
      ` ORDER BY ${orderKey('d.supersort', 'asc')}, ${orderKey('d.priority', 'asc')}, ${orderKey('d.sortdate', 'desc')},` +
      ` ${orderKey(textSort('d.title'), 'asc')} LIMIT ${LEGACY_MAX_ROWS}`,
    p.values,
  );
}


/** Arguments of `relatedContent`, as `contentGateway.getRelatedContent` names them. */
export interface RelatedContentArgs {
  siteId: string;
  /** A CF list of version ids whose related content is read. */
  contentHistId: string;
  /** Defaults to true. */
  liveOnly?: boolean;
  /** The caller's clock (legacy `nowAdjusted` before rounding). */
  today: Date;
  sortBy?: string;
  sortDirection?: string;
  relatedContentSetId?: string;
  /** Related-content set name; `Default` also matches links without a set. */
  name?: string;
  /** Reads the versions that relate to `reverseContentId` instead. */
  reverse?: boolean;
  /** A CF list of content ids, with `reverse`. */
  reverseContentId?: string;
  navOnly?: boolean;
  preview?: ChangesetPreview | null;
  /** The site ids of `siteId`'s content pool (legacy `getContentPoolID()`); defaults to `siteId`. */
  contentPoolSiteIds?: readonly string[];
  mobile?: boolean;
}

/**
 * Related content as `getRelatedContent` selects it. Legacy also selects the link's `tcr.orderNo` after
 * `tcontent.orderno`; a ColdFusion query answers a repeated column name with its first column, so `orderno` is the
 * content's own.
 */
export type RelatedContentRow = Pick<
  ContentRow,
  | 'title'
  | 'releasedate'
  | 'menutitle'
  | 'lastupdate'
  | 'lastupdatebyid'
  | 'summary'
  | 'filename'
  | 'type'
  | 'contentid'
  | 'target'
  | 'targetparams'
  | 'restricted'
  | 'restrictgroups'
  | 'displaystart'
  | 'displaystop'
  | 'orderno'
  | 'sortby'
  | 'sortdirection'
  | 'fileid'
  | 'credits'
  | 'remotesource'
  | 'remotesourceurl'
  | 'remoteurl'
  | 'subtype'
  | 'path'
  | 'siteid'
  | 'contenthistid'
  | 'displayinterval'
  | 'display'
> &
  FileJoin<'filesize' | 'fileext'> & {
    relatedfromcontentid: string;
    relatedcontentsetid: string | null;
    parenttype: string;
  };

const RELATED_SORTS = new Set([
  'menutitle',
  'title',
  'lastupdate',
  'releasedate',
  'orderno',
  'displaystart',
  'displaystop',
  'created',
  'credits',
  'type',
  'subtype',
  'comments',
  'rating',
]);

/** The ORDER BY of `getRelatedContent` for an already validated `sortBy`. */
function relatedOrder(sortBy: string, direction: SortDirection, bySet: boolean): string {
  switch (sortBy) {
    case 'orderno':
      return orderKey(bySet ? 'tcr.orderno' : 'tcontent.orderno', direction);
    case 'rating':
    case 'comments':
      // Legacy orders by tcontentstats, which this query never joins, so the database rejects it.
      throw new ContentQueryError(`Sort by ${sortBy} references tcontentstats, which getRelatedContent does not join`);
    default:
      return columnSort('tcontent', sortBy, direction) ?? orderKey('tcontent.orderno', 'asc');
  }
}

/** getRelatedContent's set arguments as legacy coerces them: set `0` is the site tree's. */
function relatedSet(args: Pick<RelatedContentArgs, 'relatedContentSetId' | 'name'>): { setId: string; name: string } {
  return { setId: args.relatedContentSetId === '0' ? SITE_TREE_MODULE_ID : (args.relatedContentSetId ?? ''), name: args.name ?? '' };
}

/** getRelatedContent's coerced set arguments and ORDER BY. */
function relatedSort(args: RelatedContentArgs): { setId: string; name: string; order: string } {
  let sortBy = (args.sortBy ?? 'orderno').toLowerCase();
  let direction = sortDirectionOf(args.sortDirection);
  if (!RELATED_SORTS.has(sortBy)) {
    sortBy = 'orderno';
  }
  if (args.reverse === true && sortBy === 'orderno') {
    sortBy = 'menutitle';
    direction = 'asc';
  }
  const { setId, name } = relatedSet(args);
  return { setId, name, order: relatedOrder(sortBy, direction, setId !== '' || name !== '') };
}

/** getRelatedContent's set or set-name predicate on `tcr` and `tcrs`, with its leading AND; `Default` also matches links without a set. */
function relatedSetFilter(p: SqlParams, setId: string, name: string): string {
  if (name !== '') {
    return ` AND (${ciEq(p, 'tcrs.name', name)}${name.toLowerCase() === 'default' ? ' OR tcrs.name IS NULL' : ''})`;
  }
  if (setId !== '') {
    return ` AND (${idEq(p, 'tcr.relatedcontentsetid', setId)}${setId === SITE_TREE_MODULE_ID ? ' OR tcr.relatedcontentsetid IS NULL' : ''})`;
  }
  return '';
}

/** A link of a forward getRelatedContent, joined to its destination content in each content-pool tenant. */
export type RelatedLinkRow = Pick<ContentRelatedRow, 'relatedid' | 'contentid' | 'relatedcontentsetid' | 'orderno'>;

/** getRelatedContent's links of the versions `contentHistId` in the set or set name, read in the versions' tenant. */
export async function relatedLinks(
  tx: TenantTx,
  args: Pick<RelatedContentArgs, 'contentHistId' | 'relatedContentSetId' | 'name'>,
): Promise<RelatedLinkRow[]> {
  const { setId, name } = relatedSet(args);
  await readable(tx, 'content_related', ...(name !== '' ? (['extend_rc_set'] as const) : []));
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const linked = idIn(p, 'tcr.contenthistid', cfList(args.contentHistId));
  return run(
    tx,
    `SELECT tcr.relatedid, tcr.contentid, tcr.relatedcontentsetid, tcr.orderno FROM ${t.related} tcr` +
      (name !== '' ? ` LEFT JOIN ${t.relatedContentSet} tcrs ON (tcr.relatedcontentsetid = tcrs.relatedcontentsetid)` : '') +
      ` WHERE ${linked}${relatedSetFilter(p, setId, name)} ORDER BY tcr.relatedcontentid`,
    p.values,
  );
}

/** A row of `relatedCandidates` with the keys `mergeRelatedContent` orders it by beyond its legacy columns. */
export interface RelatedCandidate {
  row: RelatedContentRow;
  /** The link's `orderno`, which a set or set-name read orders by. */
  linkOrderNo: number | null;
  created: Date | null;
}

type RelatedCandidateQueryRow = RelatedContentRow & { relatedlinkorderno: number | null; relatedcreated: Date | null };

/**
 * contentGateway.getRelatedContent in this tenant, each row with its merge keys. `links` from `relatedLinks` make a
 * forward read join them to this tenant's content instead of reading this tenant's links.
 */
export async function relatedCandidates(
  tx: TenantTx,
  args: RelatedContentArgs & { links?: readonly RelatedLinkRow[] },
): Promise<RelatedCandidate[]> {
  const reverse = args.reverse === true;
  const { links } = args;
  if (links !== undefined && reverse) {
    throw new TypeError('relatedCandidates takes links only for a forward read');
  }
  const { setId, name, order } = relatedSort(args);
  if (links !== undefined && links.length === 0) {
    return [];
  }
  await readable(
    tx,
    'content',
    'file',
    ...(links === undefined ? (['content_related'] as const) : []),
    ...(links === undefined && name !== '' ? (['extend_rc_set'] as const) : []),
  );
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const pool = args.contentPoolSiteIds ?? [args.siteId];
  const nowAdjusted = timespanInterval(args.today);
  let join: string;
  let linked = '';
  if (links === undefined) {
    const link = reverse ? '(tcontent.contenthistid = tcr.contenthistid)' : '(tcontent.contentid = tcr.relatedid)';
    join =
      ` INNER JOIN ${t.related} tcr ON ${link}` +
      (name !== '' ? ` LEFT JOIN ${t.relatedContentSet} tcrs ON (tcr.relatedcontentsetid = tcrs.relatedcontentsetid)` : '');
    linked =
      (reverse ? idIn(p, 'tcr.relatedid', cfList(args.reverseContentId)) : idIn(p, 'tcr.contenthistid', cfList(args.contentHistId))) +
      `${relatedSetFilter(p, setId, name)} AND `;
  } else {
    join =
      ` INNER JOIN unnest(${p.add(links.map((l) => l.relatedid))}::bpchar[], ${p.add(links.map((l) => l.contentid))}::bpchar[],` +
      ` ${p.add(links.map((l) => l.relatedcontentsetid))}::text[], ${p.add(links.map((l) => l.orderno))}::integer[])` +
      ' AS tcr(relatedid, contentid, relatedcontentsetid, orderno) ON (tcontent.contentid = tcr.relatedid)';
  }
  const live =
    args.liveOnly === false
      ? ' AND tcontent.active = 1'
      : ` AND ${p.include(activeClause('tcontent', args.preview, { offset: p.next }))}` +
        ` AND ((tcontent.display = 2 AND ((tcontent.displaystart >= ${p.add(args.today)}` +
        ` AND tcontent.parentid IN (SELECT tcalendar.contentid FROM ${t.content} tcalendar WHERE ${ciLiterals('tcalendar.type', ['Calendar'])}` +
        ` AND ${p.include(activeClause('tcalendar', args.preview, { offset: p.next }))} AND tcalendar.siteid = ANY(${p.add(pool)}::text[])))` +
        ` OR (tcontent.displaystart <= ${p.add(nowAdjusted)} AND (tcontent.displaystop >= ${p.add(nowAdjusted)}` +
        ' OR tcontent.displaystop IS NULL)))) OR (tcontent.display = 1))';
  const rows = await run<RelatedCandidateQueryRow>(
    tx,
    'SELECT tcontent.title, tcontent.releasedate, tcontent.menutitle, tcontent.lastupdate, tcontent.lastupdatebyid, tcontent.summary,' +
      ' tcontent.filename, tcontent.type, tcontent.contentid, tcontent.target, tcontent.targetparams, tcontent.restricted,' +
      ' tcontent.restrictgroups, tcontent.displaystart, tcontent.displaystop, tcontent.orderno, tcontent.sortby, tcontent.sortdirection,' +
      ' tcontent.fileid, tcontent.credits, tcontent.remotesource, tcontent.remotesourceurl, tcontent.remoteurl, tcontent.subtype,' +
      ' tfiles.filesize, tfiles.fileext, tcontent.path, tcontent.siteid, tcontent.contenthistid, tcr.contentid AS relatedfromcontentid,' +
      " tcr.relatedcontentsetid, tcontent.displayinterval, tcontent.display, ''::text AS parenttype," +
      ' tcr.orderno AS relatedlinkorderno, tcontent.created AS relatedcreated' +
      ` FROM ${t.content} tcontent LEFT JOIN ${t.file} tfiles ON (tcontent.fileid = tfiles.fileid)${join}` +
      ` WHERE ${linked}tcontent.siteid = ANY(${p.add(pool)}::text[])` +
      `${args.navOnly === true ? ' AND tcontent.isnav = 1' : ''}${live} AND ${mobileClause('tcontent', args.mobile)} ORDER BY ${order}`,
    p.values,
  );
  return rows.map(({ relatedlinkorderno, relatedcreated, ...row }) => ({ row, linkOrderNo: relatedlinkorderno, created: relatedcreated }));
}

/**
 * contentGateway.getRelatedContent for content entities in this tenant: the content a version relates to (or, with
 * `reverse`, the versions relating to content), before the caller's interval expansion of live rows. File columns are
 * null where the site's file pool is another tenant; the caller fills them with `fileJoinColumns` there. Over a
 * content pool of several tenants, a forward read is `relatedLinks` in the versions' tenant, `relatedCandidates` with
 * those links in each registered pool tenant, then `mergeRelatedContent`; a reverse read is `relatedCandidates` in
 * each pool tenant, then `mergeRelatedContent`.
 */
export async function relatedContent(tx: TenantTx, args: RelatedContentArgs): Promise<RelatedContentRow[]> {
  return (await relatedCandidates(tx, args)).map((candidate) => candidate.row);
}

/**
 * Merges the `relatedCandidates` of every content-pool tenant, outer array in pool order, into getRelatedContent's
 * ORDER BY as the database sorts it; ties keep pool order. Reads no table.
 */
export async function mergeRelatedContent(
  tx: TenantTx,
  args: RelatedContentArgs,
  candidates: readonly (readonly RelatedCandidate[])[],
): Promise<RelatedContentRow[]> {
  const { order } = relatedSort(args);
  const all = candidates.flat();
  if (all.length <= 1) {
    return all.map((candidate) => candidate.row);
  }
  const p = new SqlParams();
  const keys = [
    `${p.add(all.map((_, i) => i))}::integer[]`,
    `${p.add(all.map((c) => c.row.orderno))}::integer[]`,
    `${p.add(all.map((c) => c.linkOrderNo))}::integer[]`,
    ...(['menutitle', 'title', 'type', 'subtype'] as const).map((key) => `${p.add(all.map((c) => c.row[key]))}::text[]`),
    ...(['lastupdate', 'releasedate', 'displaystart', 'displaystop'] as const).map((key) => `${p.add(all.map((c) => c.row[key]))}::timestamp(3)[]`),
    `${p.add(all.map((c) => c.created))}::timestamp(3)[]`,
  ];
  const rows = await run<{ i: number }>(
    tx,
    `SELECT tcontent.i FROM unnest(${keys.join(', ')}) AS tcontent(i, orderno, linkorderno, menutitle, title, type, subtype,` +
      ' lastupdate, releasedate, displaystart, displaystop, created) CROSS JOIN LATERAL (SELECT tcontent.linkorderno AS orderno) tcr' +
      ` ORDER BY ${order}, tcontent.i`,
    p.values,
  );
  return rows.flatMap(({ i }) => {
    const candidate = all[i];
    return candidate === undefined ? [] : [candidate.row];
  });
}

/** A version using a display object, as `getUsage` selects it. */
export type UsageRow = Pick<
  ContentRow,
  | 'menutitle'
  | 'type'
  | 'filename'
  | 'lastupdate'
  | 'contentid'
  | 'siteid'
  | 'approved'
  | 'display'
  | 'displaystart'
  | 'displaystop'
  | 'moduleid'
  | 'contenthistid'
  | 'parentid'
>;

/** contentGateway.getUsage: the active versions that place `objectId` in a region or mention it in their body. */
export async function usage(tx: TenantTx, args: { siteId: string; objectId: string }): Promise<UsageRow[]> {
  if (args.objectId === '') {
    return [];
  }
  await readable(tx, 'content', 'content_object');
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const pattern = `%${args.objectId}%`;
  return run(
    tx,
    'SELECT tcontent.menutitle, tcontent.type, tcontent.filename, tcontent.lastupdate, tcontent.contentid, tcontent.siteid,' +
      ' tcontent.approved, tcontent.display, tcontent.displaystart, tcontent.displaystop, tcontent.moduleid, tcontent.contenthistid,' +
      ` tcontent.parentid FROM ${t.content} tcontent WHERE tcontent.active = 1 AND tcontent.siteid = ${p.add(args.siteId)}` +
      ` AND (tcontent.contentid IN (SELECT o.contentid FROM ${t.object} o WHERE o.siteid = ${p.add(args.siteId)} AND ${ciLike(p, 'o.objectid', pattern)})` +
      ` OR tcontent.contentid IN (SELECT b.contentid FROM ${t.content} b WHERE b.siteid = ${p.add(args.siteId)} AND b.active = 1` +
      ` AND ${ciLike(p, 'b.body', pattern)})) ${CLUSTERED_ORDER}`,
    p.values,
  );
}

/**
 * contentGateway.getTagCloud (`carch.loadtagarray`): live tag counts of a site's navigable content, by tag, in the
 * default tag group unless `tagGroup` names another. Tags group case-insensitively, as under SQL Server's collation.
 * Legacy's `rsContent` filter names an ambiguous column and always fails there, so it is not offered.
 */
export async function tagCloud(
  tx: TenantTx,
  args: {
    siteId: string;
    parentId?: string;
    /** A category with its descendants, resolved by the caller in the category-pool tenant. */
    categoryIds?: readonly string[];
    moduleId?: string;
    tagGroup?: string;
    today: Date;
    mobile?: boolean;
  },
): Promise<{ tag: string; tagcount: number }[]> {
  await readable(tx, 'content', 'content_tag', ...(args.categoryIds !== undefined ? (['content_category_assign'] as const) : []));
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const moduleId = args.moduleId ?? SITE_TREE_MODULE_ID;
  const siteTree = moduleId === SITE_TREE_MODULE_ID;
  const group =
    args.tagGroup !== undefined && args.tagGroup !== '' && args.tagGroup.toLowerCase() !== 'default'
      ? ciEq(p, 'tcontenttags.taggroup', args.tagGroup)
      : 'tcontenttags.taggroup IS NULL';
  return run(
    tx,
    `SELECT min(tcontenttags.tag) AS tag, count(tcontenttags.tag)::integer AS tagcount FROM ${t.tag} tcontenttags` +
      ` INNER JOIN ${t.content} tcontent ON (tcontenttags.contenthistid = tcontent.contenthistid)` +
      (siteTree
        ? ` LEFT JOIN ${t.content} tparent ON (tcontent.parentid = tparent.contentid AND tcontent.siteid = tparent.siteid AND tparent.active = 1)`
        : '') +
      (args.categoryIds !== undefined
        ? ` INNER JOIN ${t.categoryAssign} tcontentcategoryassign ON (tcontent.contenthistid = tcontentcategoryassign.contenthistid)`
        : '') +
      ` WHERE tcontent.siteid = ${p.add(args.siteId)} AND tcontent.approved = 1 AND tcontent.active = 1` +
      `${siteTree ? ' AND tcontent.isnav = 1' : ''} AND ${idEq(p, 'tcontent.moduleid', moduleId)}` +
      (args.parentId !== undefined && args.parentId !== '' ? ` AND ${idEq(p, 'tcontent.parentid', args.parentId)}` : '') +
      (args.categoryIds !== undefined ? ` AND ${idIn(p, 'tcontentcategoryassign.categoryid', args.categoryIds)}` : '') +
      ` AND ${group} AND (tcontent.display = 1 OR (tcontent.display = 2 AND ((tcontent.displaystart <= ${p.add(args.today)}` +
      ` AND (tcontent.displaystop >= ${p.add(args.today)} OR tcontent.displaystop IS NULL))${siteTree ? ` OR ${ciLiterals('tparent.type', ['Calendar'])}` : ''})))` +
      ` AND ${mobileClause('tcontent', args.mobile)}` +
      ' GROUP BY lower(rtrim(tcontenttags.tag)) ORDER BY lower(rtrim(tcontenttags.tag))',
    p.values,
  );
}

/** A placed display object as `getObjects` and `getObjectInheritance` select it. */
export type PlacedObjectRow = Pick<ContentObjectRow, 'object' | 'name' | 'objectid' | 'orderno' | 'params'> & {
  /** Always null: plugin display objects are a decision-list table that only legacy renders. */
  configuratorinit: string | null;
};

/** contentGateway.getObjects: the objects of region `columnId` of a version, by position. */
export async function objects(
  tx: TenantTx,
  args: { columnId: number; contentHistId: string; siteId: string },
): Promise<PlacedObjectRow[]> {
  await readable(tx, 'content', 'content_object');
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  return run(
    tx,
    'SELECT o.object, o.name, o.objectid, o.orderno, o.params, NULL::text AS configuratorinit' +
      ` FROM ${t.object} o INNER JOIN ${t.content} tcontent ON (o.contenthistid = tcontent.contenthistid AND o.siteid = tcontent.siteid)` +
      ` WHERE tcontent.siteid = ${p.add(args.siteId)} AND ${idEq(p, 'tcontent.contenthistid', args.contentHistId)}` +
      ` AND o.columnid = ${p.add(args.columnId)} ORDER BY o.orderno`,
    p.values,
  );
}

/** contentGateway.getObjectInheritance: the cascaded objects of region `columnId` of version `inheritedObjects`. */
export async function objectInheritance(
  tx: TenantTx,
  args: { columnId: number; inheritedObjects: string; siteId: string },
): Promise<PlacedObjectRow[]> {
  await readable(tx, 'content_object');
  const p = new SqlParams();
  return run(
    tx,
    'SELECT o.object, o.name, o.objectid, o.orderno, o.params, NULL::text AS configuratorinit' +
      ` FROM ${qualified(tx.schema, CONTENT_OBJECT.table)} o WHERE ${idEq(p, 'o.contenthistid', args.inheritedObjects)}` +
      ` AND o.siteid = ${p.add(args.siteId)} AND o.columnid = ${p.add(args.columnId)} AND NOT (${ciEq(p, 'o.object', 'goToFirstChild')})` +
      ' ORDER BY o.orderno',
    p.values,
  );
}

/**
 * contentGateway.getCategorySummary: live navigable site-tree content counted per assigned category. Category
 * data lives in the category-pool tenant, so the caller resolves legacy `categorypathid` into `categoryIds` (each
 * category with its descendants), joins names there, drops ids without a category, and orders by name.
 * `withinCategoryIds` is legacy `categoryid`, which narrows the content only alongside `categoryIds`; on its own
 * legacy renders an unclosed IN list and fails.
 */
export async function categorySummary(
  tx: TenantTx,
  args: {
    siteId: string;
    /** A CF list of parent content ids. */
    parentId?: string;
    relatedIds?: readonly string[];
    today: Date;
    menuType?: string;
    categoryIds?: readonly string[];
    withinCategoryIds?: readonly string[];
    preview?: ChangesetPreview | null;
    mobile?: boolean;
  },
): Promise<{ categoryid: string; count: number }[]> {
  if (args.categoryIds === undefined && args.withinCategoryIds !== undefined && args.withinCategoryIds.length > 0) {
    throw new ContentQueryError('Incorrect syntax: the category id IN list is not closed');
  }
  const related = args.relatedIds !== undefined && args.relatedIds.length > 0;
  await readable(tx, 'content', 'content_category_assign', ...(related ? (['content_related'] as const) : []));
  const t = tablesFor(tx.schema);
  const p = new SqlParams();
  const now = timespanInterval(args.today);
  const parents = cfList(args.parentId);
  const filters: string[] = [];
  if (parents.length > 0) {
    filters.push(idIn(p, 'tcontent.parentid', parents));
  }
  filters.push(p.include(activeClause('tcontent', args.preview, { offset: p.next })));
  if (args.categoryIds !== undefined) {
    if (args.withinCategoryIds !== undefined && args.withinCategoryIds.length > 0) {
      filters.push(
        `tcontent.contenthistid IN (SELECT contenthistid FROM ${t.categoryAssign} WHERE ${idIn(p, 'categoryid', args.withinCategoryIds)})`,
      );
    }
    filters.push(idIn(p, 'tcontentcategoryassign.categoryid', args.categoryIds));
  }
  filters.push(`tcontent.moduleid = '${SITE_TREE_MODULE_ID}'`, 'tcontent.isnav = 1', `tcontent.siteid = ${p.add(args.siteId)}`);
  const window =
    (args.menuType ?? '').toLowerCase() === 'calendar'
      ? `AND ((tcontent.displaystart >= ${p.add(now)} AND tcontent.displaystart < ${p.add(addMonths(now, 1))})` +
        ` OR (tcontent.displaystop >= ${p.add(now)} AND tcontent.displaystop < ${p.add(addMonths(now, 1))}))`
      : `AND (tcontent.displaystart <= ${p.add(now)}) AND (tcontent.displaystop >= ${p.add(now)} OR tcontent.displaystop IS NULL)`;
  filters.push(`((tcontent.display = 2 ${window}) OR tcontent.display = 1)`, mobileClause('tcontent', args.mobile));
  if (related) {
    filters.push(
      `tcontent.contentid IN (SELECT tcontentrelated.contentid FROM ${t.related} tcontentrelated` +
        ` WHERE ${idIn(p, 'tcontentrelated.relatedid', args.relatedIds ?? [])} AND tcontentrelated.siteid = ${p.add(args.siteId)})`,
    );
  }
  return run(
    tx,
    'SELECT tcontentcategoryassign.categoryid, count(tcontent.contenthistid)::integer AS count' +
      ` FROM ${t.content} tcontent INNER JOIN ${t.categoryAssign} tcontentcategoryassign ON (tcontent.contenthistid = tcontentcategoryassign.contenthistid)` +
      ` WHERE ${filters.join(' AND ')} GROUP BY tcontentcategoryassign.categoryid ORDER BY tcontentcategoryassign.categoryid`,
    p.values,
  );
}

/** contentGateway.getCommentCount: the approved comments of a content item, by spam and deletion flags (default 0). */
export async function commentCount(
  tx: TenantTx,
  args: { siteId: string; contentId: string; isSpam?: boolean; isDeleted?: boolean },
): Promise<number> {
  await readable(tx, 'comment');
  const p = new SqlParams();
  const rows = await run<{ commentcount: number }>(
    tx,
    `SELECT count(contentid)::integer AS commentcount FROM ${qualified(tx.schema, COMMENT.table)}` +
      ` WHERE ${idEq(p, 'contentid', args.contentId)} AND siteid = ${p.add(args.siteId)} AND isapproved = 1` +
      ` AND isspam = ${p.add(args.isSpam === true ? 1 : 0)} AND isdeleted = ${p.add(args.isDeleted === true ? 1 : 0)}`,
    p.values,
  );
  return rows[0]?.commentcount ?? 0;
}

/** The placements of display object `object` on a version or its cascaded `inheritedObjects` version. */
async function objectCount(
  tx: TenantTx,
  args: { siteId: string; contentHistId: string; inheritedObjects?: string },
  object: string,
): Promise<number> {
  await readable(tx, 'content_object');
  const p = new SqlParams();
  const versions =
    args.inheritedObjects !== undefined && args.inheritedObjects !== ''
      ? `(${idEq(p, 'contenthistid', args.contentHistId)} OR ${idEq(p, 'contenthistid', args.inheritedObjects)})`
      : `(${idEq(p, 'contenthistid', args.contentHistId)})`;
  const rows = await run<{ thecount: number }>(
    tx,
    `SELECT count(contentid)::integer AS thecount FROM ${qualified(tx.schema, CONTENT_OBJECT.table)}` +
      ` WHERE ${versions} AND siteid = ${p.add(args.siteId)} AND ${ciEq(p, 'object', object)}`,
    p.values,
  );
  return rows[0]?.thecount ?? 0;
}

/** contentGateway.getHasComments: the comments objects on a version or its `inheritedObjects` (legacy `request.inheritedObjects`). */
export function hasComments(tx: TenantTx, args: { siteId: string; contentHistId: string; inheritedObjects?: string }): Promise<number> {
  return objectCount(tx, args, 'comments');
}

/** contentGateway.getHasRatings: the rater objects on a version or its `inheritedObjects`. */
export function hasRatings(tx: TenantTx, args: { siteId: string; contentHistId: string; inheritedObjects?: string }): Promise<number> {
  return objectCount(tx, args, 'Rater');
}

/** contentGateway.getHasTagCloud: the tag cloud objects on a version or its `inheritedObjects`. */
export function hasTagCloud(tx: TenantTx, args: { siteId: string; contentHistId: string; inheritedObjects?: string }): Promise<number> {
  return objectCount(tx, args, 'tag_cloud');
}

/** The file columns the content reads join from `tfiles`. */
export type FileJoinRow = Pick<FileRow, 'fileid' | 'fileext' | 'filesize' | 'contenttype' | 'contentsubtype'> & {
  assocfilename: string | null;
};

/**
 * The file columns of `fileIds`, read in the file-pool tenant to fill the null file columns that the reads above
 * return for a site whose files are kept in another tenant. Alt text (`filealttext`) comes from version metadata,
 * which lives with the content, so the reads above already return it.
 */
export async function fileJoinColumns(tx: TenantTx, fileIds: readonly string[]): Promise<FileJoinRow[]> {
  if (fileIds.length === 0) {
    return [];
  }
  await readable(tx, 'file');
  const p = new SqlParams();
  return run(
    tx,
    'SELECT fileid, fileext, filesize, filename AS assocfilename, contenttype, contentsubtype' +
      ` FROM ${qualified(tx.schema, FILE.table)} WHERE ${idIn(p, 'fileid', fileIds)} ORDER BY fileid`,
    p.values,
  );
}

