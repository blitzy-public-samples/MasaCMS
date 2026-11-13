/** The single data-access path of schema `people`: the platform repository plus typed person, address, interest, tag, favorite, extended-data, definition, trash, archive, roster-operation and group-name helpers. */
import {
  RepositoryError,
  createRepository,
  qualified,
  type Repository,
  type RepositoryRow,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import type { QueryResultRow, TenantTx } from '@opt2/platform/tenancy';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import {
  ADDRESS,
  EXTEND_ATTRIBUTE,
  EXTEND_DATA,
  EXTEND_SET,
  EXTEND_SUBTYPE,
  FAVORITE,
  FINISH_PENDING_ERROR,
  GROUP_NAME,
  INTEREST,
  OPEN_ROSTER_STATES,
  OWNED_TABLES,
  PERSON,
  PERSON_ARCHIVE,
  PERSON_INSERT_COLUMNS,
  PERSON_TOMBSTONE,
  PERSON_UPDATE_COLUMNS,
  RECOVERABLE_ROSTER_STATES,
  ROSTER_OPERATION,
  TAG,
  TRASH,
  type AddressRow,
  type ExtendAttributeRow,
  type ExtendDataRow,
  type ExtendSetRow,
  type ExtendSubtypeRow,
  type FavoriteRow,
  type GroupNameRow,
  type InterestRow,
  type PeopleTableName,
  type PersonArchiveRow,
  type PersonColumnName,
  type PersonRow,
  type PersonTombstoneRow,
  type RosterOperationRow,
  type RosterState,
  type TagRow,
  type TrashRow,
} from './tables.js';

/** Service name the people write positions carry. */
export const OWNER = 'people' as const;

/** Schema the people service owns. */
export const SCHEMA = 'people' as const;

const UNIQUE_VIOLATION = '23505';
/** Width of the legacy `char(35)` id columns. */
const ID_WIDTH = 35;
/** PostgreSQL's name for the unnamed `UNIQUE (tenant_id, person_id, effective_from)` of 0004_roster_archive.sql. */
const ARCHIVE_UNIQUE_CONSTRAINT = 'person_archive_tenant_id_person_id_effective_from_key';
/** The case-insensitive unique index on `(tenant_id, person_id, effective_from)` (0007_person_lookup_indexes.sql). */
const ARCHIVE_CI_UNIQUE_INDEX = 'person_archive_tenant_ci_person_effective_uidx';
/** The partial unique index on the case-insensitive `roster_operation.user_id` over open states (0007_person_lookup_indexes.sql). */
const OPEN_ROSTER_INDEX = 'roster_operation_open_user_uidx';
const NEXT_IDS_SQL = 'SELECT nextval(pg_get_serial_sequence($1, $2)::regclass)::text AS id FROM generate_series(1, $3::integer)';
/** SQL Server's char/varchar equality collation (0006_extend_attribute_set_ci_index.sql), as identity and programs-sites define it. */
const LEGACY_CHAR_CI_COLLATION = 'legacy_char_ci';
/** Rows per page when a caller gives no limit. */
const DEFAULT_PAGE_SIZE = 500;
/** The most rows one page returns. */
const MAX_PAGE_SIZE = 1000;
/** `getSearch`'s `maxrows` on SQL Server [legacy: core/mura/user/userGateway.cfc:129-134]. */
const SEARCH_MAX_ROWS = 2100;

/** DAO `cfqueryparam null="#iif(x neq '',…)#"`: an empty string is stored as NULL [legacy: core/mura/user/userDAO.cfc:304-343]. */
function daoNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/** CFML `trim`, which is Java `String.trim`: strips every code unit up to U+0020 at both ends. */
function cfTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end);
}

/** A posted id the legacy `char(35)` column can hold; legacy swallows the insert error of any other [legacy: core/mura/user/userDAO.cfc:597-614]. */
function storableId(value: string): boolean {
  return value !== '' && value.length <= ID_WIDTH;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, constraint: violated } = err as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && violated === constraint;
}

/** The next `row_version` of a stored row; pg returns int8 as a decimal string. */
function nextRowVersion(current: string): string {
  return String(BigInt(current) + 1n);
}

/** `limit` when it is a positive integer; throws RangeError otherwise. */
function positiveLimit(limit: number, what: string): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`${what} must be a positive integer, got ${limit}`);
  }
  return limit;
}

/** Rows of one page: `limit`, else the default, capped at the page maximum. */
function pageSize(limit: number | undefined): number {
  return limit === undefined ? DEFAULT_PAGE_SIZE : Math.min(positiveLimit(limit, 'page limit'), MAX_PAGE_SIZE);
}

/** The page of the first `take` rows of `found`, which holds one row more when another page follows. */
function pageOf<R, C>(found: readonly R[], take: number, cursorOf: (row: R) => C): Page<R, C> {
  const rows = found.slice(0, take);
  const last = rows.at(-1);
  return { rows, next: found.length > take && last !== undefined ? cursorOf(last) : null };
}

/** Every row of a keyset listing, fetched a page at a time, stopping after `cap` rows. */
async function collect<R, C>(fetch: (after: C | null, take: number) => Promise<Page<R, C>>, cap = Number.POSITIVE_INFINITY): Promise<R[]> {
  const rows: R[] = [];
  let after: C | null = null;
  do {
    const page = await fetch(after, Math.min(MAX_PAGE_SIZE, cap - rows.length));
    rows.push(...page.rows);
    after = page.next;
  } while (after !== null && rows.length < cap);
  return rows;
}

/** A legacy column limit: a text width in UTF-16 code units, the `tinyint` range, a finite `float` or the `datetime` range. */
export type LegacyLimit = number | 'tinyint' | 'float' | 'datetime';

/** First and last local times a SQL Server `datetime` holds once rounded to 1/300 s. */
const DATETIME_RANGE = [new Date(1752, 11, 31, 23, 59, 59, 999).getTime(), new Date(9999, 11, 31, 23, 59, 59, 998).getTime()] as const;

/** Live legacy catalog limits of the caller-supplied columns the write helpers set; `char(35)`, `max` and `int` columns need none. */
const LEGACY_LIMITS = {
  person: {
    groupname: 255, fname: 50, lname: 50, email: 255, company: 50, jobtitle: 50, mobilephone: 50, website: 255, subtype: 50,
    lastupdateby: 50, lastupdatebyid: 35, siteid: 50, imname: 100, imservice: 50, keepprivate: 'tinyint',
  },
  user_address: {
    siteid: 50, addressname: 50, address1: 50, address2: 50, city: 50, state: 50, zip: 50, country: 50, phone: 50, fax: 50,
    isprimary: 'tinyint', addressurl: 200, longitude: 'float', latitude: 'float', addressemail: 100,
  },
  user_tag: { siteid: 25, tag: 100 },
  extend_data_user_activity: { siteid: 25, remoteid: 35, datetimevalue: 'datetime', numericvalue: 'float', stringvalue: 255 },
  trash: { siteid: 25, objectlabel: 255, objectclass: 50, objecttype: 50, objectsubtype: 50, deleteddate: 'datetime', deletedby: 50 },
  person_archive: { siteid: 50, effective_from: 'datetime', archived_at: 'datetime', archived_by: 50 },
} as const satisfies Partial<Record<PeopleTableName, Readonly<Record<string, LegacyLimit>>>>;

/** A people table whose legacy column limits `legacyStorable` enforces. */
export type LegacyLimitedTable = keyof typeof LEGACY_LIMITS;

/**
 * `row` as legacy SQL Server stores it: text beyond its width by trailing spaces only is cut to the width, as
 * ANSI_WARNINGS allows; any other value legacy rejects throws LegacyStorageError. NULL and absent values pass.
 */
export function legacyStorable<R extends Readonly<Record<string, unknown>>>(table: LegacyLimitedTable, row: R): R {
  let stored = row;
  for (const [column, limit] of Object.entries<LegacyLimit>(LEGACY_LIMITS[table])) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    if (typeof limit === 'number') {
      if (typeof value !== 'string' || value.length <= limit) continue;
      if (!/^ +$/.test(value.slice(limit))) throw new LegacyStorageError(table, column, 'width', limit);
      stored = { ...stored, [column]: value.slice(0, limit) };
    } else if (limit === 'datetime') {
      const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
      if (!(time >= DATETIME_RANGE[0] && time <= DATETIME_RANGE[1])) throw new LegacyStorageError(table, column, 'range', limit);
    } else if (limit === 'tinyint' ? !(Number(value) >= 0 && Number(value) <= 255) : !Number.isFinite(Number(value))) {
      throw new LegacyStorageError(table, column, 'range', limit);
    }
  }
  return stored;
}

/** The acting user of a person save, as `session.mura` gives it; `isLoggedIn` is `session.mura.isLoggedIn`. */
export interface AuditActor {
  userId: string;
  fname?: string | null;
  lname?: string | null;
  isLoggedIn: boolean;
}

/** First and last name and id of the saved person. */
export interface AuditSubject {
  userid: string;
  fname?: string | null;
  lname?: string | null;
}

/**
 * `LastUpdateBy` and `LastUpdateByID` of a saved person [legacy: core/mura/user/userManager.cfc:834-845, userBean.cfc:284-288]:
 * a logged-in actor names itself, otherwise the person names itself.
 */
export function lastUpdateInfo(actor: AuditActor | null | undefined, person: AuditSubject): { lastupdateby: string; lastupdatebyid: string } {
  // left(..., 50) counts UTF-16 code units, as slice does; setLastUpdateBy then trims, so blank names give ''.
  const label = (names: { fname?: string | null; lname?: string | null }): string => cfTrim(`${names.fname ?? ''} ${names.lname ?? ''}`.slice(0, 50));
  if (actor !== null && actor !== undefined && actor.isLoggedIn) {
    return { lastupdateby: label(actor), lastupdatebyid: actor.userId };
  }
  return { lastupdateby: label(person), lastupdatebyid: person.userid };
}

type PersonInsertColumn = (typeof PERSON_INSERT_COLUMNS)[number];
type PersonUpdateColumn = (typeof PERSON_UPDATE_COLUMNS)[number];

/** A person to insert, with `userDAO.create`'s columns; `created`, `lastupdate` and `row_version` are set here. */
export type PersonInput = Pick<PersonRow, Exclude<PersonInsertColumn, 'created' | 'lastupdate'>>;

/** A person's new values, with `userDAO.update`'s columns; `lastupdate` and `row_version` are set here. */
export type PersonUpdate = Pick<PersonRow, Exclude<PersonUpdateColumn, 'lastupdate'>>;

/** A `people.person` column a query may filter or sort on. */
export type PersonQueryColumn = Exclude<PersonColumnName, 'tenant_id'>;

/** Comparison of one `PersonCondition`; `like` matches anywhere, `begins` at the start, `in` any of a list. */
export type PersonConditionOp = 'eq' | 'neq' | 'like' | 'begins' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'null' | 'notnull';

/** One advanced-search condition; text columns compare as SQL Server's case-insensitive collation does. */
export interface PersonCondition {
  column: PersonQueryColumn;
  op: PersonConditionOp;
  value?: unknown;
}

/** One sort key; NULLs sort lowest, as in SQL Server. */
export interface PersonOrder {
  column: PersonQueryColumn;
  direction: 'asc' | 'desc';
}

/** An advanced search over `people.person` of the transaction tenant. */
export interface PersonQuery {
  siteIds?: readonly string[];
  userIds?: readonly string[];
  conditions?: readonly PersonCondition[];
  combine?: 'and' | 'or';
  orderBy?: readonly PersonOrder[];
  limit?: number;
}

/** Arguments of `searchPersons` [legacy: core/mura/user/userGateway.cfc:124-162]. */
export interface PersonSearch {
  /** The user-pool site the search reads. */
  siteId: string;
  term: string;
  /** Users matched by a column people does not own, such as identity's `username`. */
  orUserIds?: readonly string[];
  /** When given, only these users can match. */
  restrictUserIds?: readonly string[];
  /** Most rows returned; legacy's 2100 when omitted. */
  limit?: number;
}

/** Paging of a keyset listing: `after` is the previous page's `next`; `limit` defaults to 500 and is capped at 1000. */
export interface PageOptions<C> {
  after?: C | null;
  limit?: number;
}

/** One page of a keyset listing; `next` resumes after its last row and is null on the last page. */
export interface Page<R, C> {
  rows: R[];
  next: C | null;
}

/** The position after one person of an ordering: its order-key values as PostgreSQL returned them, then its userid. */
export interface PersonCursor {
  keys: readonly unknown[];
  userid: string;
}

/** The position after one operation of the stale roster-operation listing. */
export interface RosterOperationCursor {
  updatedAt: Date;
  operationId: string;
}

/** An address to insert as `createAddress` does; a missing `addressid` gets a new CF UUID, other missing values the `addressBean` defaults ('' and 0). */
export type AddressInput = Partial<Omit<AddressRow, 'tenant_id' | 'addressid' | 'userid'>> & { userid: string; addressid?: string };

/** The columns `userDAO.updateAddress` sets; missing values take the `addressBean` defaults [legacy: core/mura/user/userDAO.cfc:749-774]. */
export type AddressUpdate = Partial<Omit<AddressRow, 'tenant_id' | 'addressid' | 'isprimary'>>;

/** Arguments of `replaceTags`; `tags` is the person's comma list. */
export interface TagReplacement {
  userId: string;
  siteId: string;
  tags: string | null;
}

/** Stored value columns of one extended attribute of a person or address. */
export type ExtendDataValues = Omit<ExtendDataRow, 'tenant_id' | 'dataid' | 'baseid' | 'attributeid'>;

/** One attribute of an extended-data save: its rows are deleted, then `row` is inserted unless null. */
export interface ExtendDataReplacement {
  attributeId: number;
  row: ExtendDataValues | null;
}

/** Filters of `listExtendAttributes`; each given filter must match, set and site ids as SQL Server compares them. */
export interface ExtendAttributeFilter {
  setIds?: readonly string[];
  attributeIds?: readonly number[];
  siteId?: string;
}

/** A trash row to insert. */
export type TrashInput = Omit<TrashRow, 'tenant_id'>;

/** An archive record to insert; a missing `archive_id` gets a new CF UUID and a missing `archived_at` is now. */
export type PersonArchiveInput = Omit<PersonArchiveRow, 'tenant_id' | 'archive_id' | 'archived_at'> & {
  archive_id?: string;
  archived_at?: Date;
};

/** A roster operation to record in state `started`; `payload` is JSON text. */
export interface RosterOperationInput {
  kind: string;
  userId: string;
  payload: string;
}

/** The new state of a roster operation and the optional columns set with it. */
export interface RosterOperationStatePatch {
  state: RosterState;
  beforeImage?: string | null;
  identityXid?: string | null;
  error?: string | null;
  identityUnreachableSince?: Date | null;
}

/** A group-name projection row to store. */
export type GroupNameInput = Omit<GroupNameRow, 'tenant_id' | 'aggregate_version'> & { aggregate_version: number | string };

/** Raised when the person already has an archive record; the archive route answers it with the legacy `badRequest`. */
export class DuplicateArchiveError extends Error {
  override readonly name: string = 'DuplicateArchiveError';

  constructor(
    readonly personId: string,
    options?: { cause?: unknown },
  ) {
    super(`person ${personId} is already archived`, options);
  }
}

/** Raised when the user already has an open roster operation; unhandled, it answers the legacy 503. */
export class RosterOperationOpenError extends LegacyServiceUnavailableError {
  override readonly name: string = 'RosterOperationOpenError';

  constructor(readonly userId: string) {
    super(`user ${userId} has an open roster operation`, 'auto', 'roster-operation-open');
  }
}

/** Raised for a value the legacy column cannot store, writing nothing; unhandled, it answers the legacy 500 of the failed legacy query. */
export class LegacyStorageError extends RepositoryError {
  override readonly name: string = 'LegacyStorageError';

  constructor(
    table: string,
    readonly column: string,
    readonly violation: 'width' | 'range',
    readonly limit: LegacyLimit,
  ) {
    super(`column ${column} is beyond the legacy ${violation} ${limit}`, table);
  }
}

/**
 * The platform repository of schema `people` plus typed helpers; every helper runs in the caller's open tenant transaction.
 * Id and site arguments match stored values as SQL Server's case-insensitive, trailing-space-blind collation does; rows keep their stored spelling.
 */
export interface PeopleRepository extends Repository {
  /** The underlying platform repository, as `registerMigrationHandlers` takes it. */
  readonly base: Repository;

  /** The person `userId`; null when absent. */
  findPerson(tx: TenantTx, userId: string): Promise<PersonRow | null>;
  /** The persons of `userIds`, each once at its first input position; missing ids are omitted. */
  findPersons(tx: TenantTx, userIds: readonly string[]): Promise<PersonRow[]>;
  /** Inserts a person as `userDAO.create` does, with `row_version` 1, or one past its tombstone [legacy: core/mura/user/userDAO.cfc:300-347]. */
  insertPerson(tx: TenantTx, input: PersonInput, ctx?: WriteContext): Promise<PersonRow>;
  /** Updates a person as `userDAO.update` does and adds 1 to `row_version` [legacy: core/mura/user/userDAO.cfc:403-458]; null when absent. */
  updatePerson(tx: TenantTx, userId: string, input: PersonUpdate, ctx?: WriteContext): Promise<PersonRow | null>;
  /** The last aggregate version published for the deleted person `userId`; null when none was deleted. */
  personTombstoneVersion(tx: TenantTx, userId: string): Promise<string | null>;
  /** Stores `rowVersion` as the deleted person's last aggregate version. */
  recordPersonTombstone(tx: TenantTx, userId: string, rowVersion: string, ctx?: WriteContext): Promise<PersonTombstoneRow>;
  /** Persons of user-pool site `siteId`, optionally only `userIds`, by last then first name, NULLs first [legacy: core/mura/user/userGateway.cfc:712-713]. */
  listPersonsForSite(tx: TenantTx, siteId: string, opts?: { userIds?: readonly string[] }): Promise<PersonRow[]>;
  /** One keyset page of `listPersonsForSite`. */
  pagePersonsForSite(
    tx: TenantTx,
    siteId: string,
    opts?: PageOptions<PersonCursor> & { userIds?: readonly string[] },
  ): Promise<Page<PersonRow, PersonCursor>>;
  /** The person-column part of `getSearch`: none for an empty term, else a LIKE match on name, company, email or job title, by last name. */
  searchPersons(tx: TenantTx, search: PersonSearch): Promise<PersonRow[]>;
  /** Persons matching `query`, by its order (default last then first name); `query.limit` caps the total. */
  queryPersons(tx: TenantTx, query: PersonQuery): Promise<PersonRow[]>;
  /** One keyset page of the persons matching `query`, by its order. */
  pageQueryPersons(tx: TenantTx, query: Omit<PersonQuery, 'limit'>, opts?: PageOptions<PersonCursor>): Promise<Page<PersonRow, PersonCursor>>;

  /** The person's addresses, primary first [legacy: core/mura/user/userDAO.cfc:862-871]. */
  listAddresses(tx: TenantTx, userId: string): Promise<AddressRow[]>;
  /** The address `addressId`; null when absent. */
  findAddress(tx: TenantTx, addressId: string): Promise<AddressRow | null>;
  /** Inserts an address as `createAddress` does [legacy: core/mura/user/userDAO.cfc:776-808]. */
  insertAddress(tx: TenantTx, input: AddressInput, ctx?: WriteContext): Promise<AddressRow>;
  /** Updates an address as `updateAddress` does; null when absent. */
  updateAddress(tx: TenantTx, addressId: string, input: AddressUpdate, ctx?: WriteContext): Promise<AddressRow | null>;
  /** Deletes the address and its extended data [legacy: core/mura/user/userDAO.cfc:810-823]; false when no address row existed. */
  deleteAddress(tx: TenantTx, addressId: string, ctx?: WriteContext): Promise<boolean>;
  /** Makes `addressId` the person's only primary address [legacy: core/mura/user/userDAO.cfc:849-860]. */
  setPrimaryAddress(tx: TenantTx, userId: string, addressId: string, ctx?: WriteContext): Promise<void>;

  /** The person's interests by category id, as `readInterestGroupIDs` lists them [legacy: core/mura/user/userDAO.cfc:674-682]. */
  listInterests(tx: TenantTx, userId: string): Promise<InterestRow[]>;
  /** The person's tags by tag id. */
  listTags(tx: TenantTx, userId: string): Promise<TagRow[]>;
  /** Deletes the person's interests (only `scopeCategoryIds` when given), then inserts each new storable id [legacy: core/mura/user/userDAO.cfc:583-616]; returns the inserted rows. */
  replaceInterests(
    tx: TenantTx,
    userId: string,
    categoryIds: readonly string[],
    opts?: { scopeCategoryIds?: readonly string[] },
    ctx?: WriteContext,
  ): Promise<InterestRow[]>;
  /** Deletes the person's tags, then inserts each trimmed, non-empty item of the comma list [legacy: core/mura/user/userDAO.cfc:895-922]. */
  replaceTags(tx: TenantTx, input: TagReplacement, ctx?: WriteContext): Promise<TagRow[]>;
  /** The person's favorites by creation time. */
  listFavorites(tx: TenantTx, userId: string): Promise<FavoriteRow[]>;

  /** Stored extended values of `baseIds` (persons or addresses), by base, attribute and data id. */
  listExtendData(tx: TenantTx, baseIds: readonly string[]): Promise<ExtendDataRow[]>;
  /** Per attribute, deletes the stored values of `baseId`, then inserts the new row [legacy: core/mura/extend/extendManager.cfc:439-640]; returns the inserted rows. */
  replaceExtendData(tx: TenantTx, baseId: string, entries: readonly ExtendDataReplacement[], ctx?: WriteContext): Promise<ExtendDataRow[]>;
  /** Deletes every extended value of `baseId` [legacy: core/mura/extend/extendManager.cfc:1060-1091]; returns the number deleted. */
  deleteExtendDataForBase(tx: TenantTx, baseId: string, ctx?: WriteContext): Promise<number>;
  /** Subtypes of `siteId`, only `types` when given, by type then subtype [legacy: core/mura/extend/extendManager.cfc:939-973]. */
  listExtendSubtypes(tx: TenantTx, filter: { siteId: string; types?: readonly string[] }): Promise<ExtendSubtypeRow[]>;
  /** Sets of `subtypeIds` by order number. */
  listExtendSets(tx: TenantTx, subtypeIds: readonly string[]): Promise<ExtendSetRow[]>;
  /** Attributes matching `filter` by order number then name [legacy: core/mura/extend/extendSet.cfc:265-276]. */
  listExtendAttributes(tx: TenantTx, filter: ExtendAttributeFilter): Promise<ExtendAttributeRow[]>;

  /** Inserts the trash row unless one exists for its `objectid` [legacy: core/mura/trash/trashManager.cfc:250-273]; null when one did. */
  insertTrashIfAbsent(tx: TenantTx, row: TrashInput, ctx?: WriteContext): Promise<TrashRow | null>;

  /** The person's archive record effective at `effectiveFrom`, else the first by effective date; null when none. */
  findPersonArchive(tx: TenantTx, personId: string, effectiveFrom?: Date): Promise<PersonArchiveRow | null>;
  /** Inserts the archive record; throws DuplicateArchiveError, writing nothing, when the person already has one. */
  insertPersonArchive(tx: TenantTx, row: PersonArchiveInput, ctx?: WriteContext): Promise<PersonArchiveRow>;

  /** Records a roster operation in state `started`; throws RosterOperationOpenError while the user has an open one. */
  insertRosterOperation(tx: TenantTx, input: RosterOperationInput, ctx?: WriteContext): Promise<RosterOperationRow>;
  /** Sets the operation's state, the given optional columns and `updated_at`; null when absent. */
  setRosterOperationState(tx: TenantTx, operationId: string, patch: RosterOperationStatePatch, ctx?: WriteContext): Promise<RosterOperationRow | null>;
  /** The operation `operationId`; null when absent. */
  findRosterOperation(tx: TenantTx, operationId: string): Promise<RosterOperationRow | null>;
  /** The user's open (started, people-committed or halted) operation; null when none. */
  findOpenRosterOperation(tx: TenantTx, userId: string): Promise<RosterOperationRow | null>;
  /** Started or people-committed operations, and done ones whose identity finish is pending, last updated before `olderThan`, oldest first, locked FOR UPDATE SKIP LOCKED. */
  listStaleRosterOperations(tx: TenantTx, olderThan: Date): Promise<RosterOperationRow[]>;
  /** One keyset page of `listStaleRosterOperations`. */
  pageStaleRosterOperations(
    tx: TenantTx,
    olderThan: Date,
    opts?: PageOptions<RosterOperationCursor>,
  ): Promise<Page<RosterOperationRow, RosterOperationCursor>>;

  /** Inserts or replaces the projection row of `row.group_id`. */
  upsertGroupName(tx: TenantTx, row: GroupNameInput, ctx?: WriteContext): Promise<GroupNameRow>;
  /** Deletes the projection row of `groupId`; false when absent. */
  deleteGroupName(tx: TenantTx, groupId: string, ctx?: WriteContext): Promise<boolean>;
  /** Projection rows of `groupIds` (all when omitted), by group id. */
  listGroupNames(tx: TenantTx, groupIds?: readonly string[]): Promise<GroupNameRow[]>;
  /** One keyset page of `listGroupNames`; a cursor is the stored group id of a page's last row. */
  pageGroupNames(tx: TenantTx, opts?: PageOptions<string> & { groupIds?: readonly string[] }): Promise<Page<GroupNameRow, string>>;
}

/** Settings of `createPeopleRepository`; `schema` differs from `people` only for throwaway test schemas. */
export interface PeopleRepositoryOptions {
  clock?: Clock;
  schema?: string;
}

async function select<R extends QueryResultRow>(tx: TenantTx, sql: string, params: readonly unknown[]): Promise<R[]> {
  return (await tx.query<R>(sql, [...params])).rows;
}

const PERSON_COLUMN_TYPES: ReadonlyMap<string, string> = new Map(
  PERSON.columns.filter((column) => column.name !== 'tenant_id').map((column) => [column.name, column.type]),
);
const DEFAULT_PERSON_ORDER: readonly PersonOrder[] = [
  { column: 'lname', direction: 'asc' },
  { column: 'fname', direction: 'asc' },
];
const COMPARISONS: Readonly<Record<'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte', string>> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/** The quoted `people.person` column `column` and whether it is text; throws RepositoryError for any other name. */
function personColumn(column: string): { sql: string; text: boolean } {
  const type = PERSON_COLUMN_TYPES.get(column);
  if (type === undefined) {
    throw new RepositoryError(`has no queryable column ${column}`, PERSON.table);
  }
  return { sql: `"${column}"`, text: type === 's' };
}

/** SQL Server's case-insensitive, trailing-space-blind form of a text expression. */
function ciText(expression: string): string {
  return `rtrim(lower(${expression}))`;
}

/** The predicate of one condition, binding its values through `bind`. */
function conditionSql(condition: PersonCondition, bind: (value: unknown) => string): string {
  const { sql: column, text } = personColumn(condition.column);
  const value = condition.value;
  switch (condition.op) {
    case 'null':
      return `${column} IS NULL`;
    case 'notnull':
      return `${column} IS NOT NULL`;
    // ESCAPE '' keeps a backslash literal, as SQL Server's LIKE has no default escape character.
    case 'like':
      return `${column}::text ILIKE ${bind(`%${String(value ?? '')}%`)} ESCAPE ''`;
    case 'begins':
      return `${column}::text ILIKE ${bind(`${String(value ?? '')}%`)} ESCAPE ''`;
    case 'in': {
      const values = Array.isArray(value) ? value : [value];
      return text
        ? `${ciText(column)} = ANY (SELECT ${ciText('v')} FROM unnest(${bind(values.map((v) => String(v ?? '')))}::text[]) AS v)`
        : `${column} = ANY (${bind(values)})`;
    }
    default: {
      const op = COMPARISONS[condition.op];
      return text ? `${ciText(column)} ${op} ${ciText(`${bind(String(value ?? ''))}::text`)}` : `${column} ${op} ${bind(value)}`;
    }
  }
}

/** WHERE terms of a person read and the parameters they bind. */
interface PersonFilter {
  where: readonly string[];
  params: readonly unknown[];
}

/** One sort key of a person ordering. */
interface PersonOrderKey {
  expression: string;
  descending: boolean;
}

/** The sort key of `order`: text case-insensitively. */
function orderKey(order: PersonOrder): PersonOrderKey {
  const { sql: column, text } = personColumn(order.column);
  return { expression: text ? `lower(${column})` : column, descending: order.direction === 'desc' };
}

/** One ORDER BY key: NULLs lowest as in SQL Server. */
function orderSql(key: PersonOrderKey): string {
  return key.descending ? `${key.expression} DESC NULLS LAST` : `${key.expression} ASC NULLS FIRST`;
}

/** The column alias carrying the value of sort key `index`. */
function orderAlias(index: number): string {
  return `__order_${index}`;
}

/** Rows after `cursor` in `keys` order then userid, binding the cursor values through `bind`. */
function afterSql(keys: readonly PersonOrderKey[], cursor: PersonCursor, bind: (value: unknown) => string): string {
  if (cursor.keys.length !== keys.length) {
    throw new RangeError(`person cursor holds ${cursor.keys.length} sort keys, the ordering ${keys.length}`);
  }
  const later: string[] = [];
  const equal: string[] = [];
  keys.forEach(({ expression, descending }, index) => {
    const value = cursor.keys[index];
    const param = value === null || value === undefined ? null : bind(value);
    // NULLs sort first ascending, so every value follows a NULL; they sort last descending, so nothing follows one.
    if (param === null) {
      if (!descending) later.push([...equal, `${expression} IS NOT NULL`].join(' AND '));
      equal.push(`${expression} IS NULL`);
    } else {
      later.push([...equal, descending ? `(${expression} < ${param} OR ${expression} IS NULL)` : `${expression} > ${param}`].join(' AND '));
      equal.push(`${expression} = ${param}`);
    }
  });
  later.push([...equal, `userid > ${bind(cursor.userid)}`].join(' AND '));
  return `(${later.map((term) => `(${term})`).join(' OR ')})`;
}

/** A binder that appends each value to `params` and returns its placeholder. */
function binder(params: unknown[]): (value: unknown) => string {
  return (value) => {
    params.push(value);
    return `$${params.length}`;
  };
}

/** Builds the people repository over the platform repository of `OWNED_TABLES`. */
export function createPeopleRepository({ clock = systemClock, schema = SCHEMA }: PeopleRepositoryOptions = {}): PeopleRepository {
  const base = createRepository({ owner: OWNER, schema, tables: OWNED_TABLES, clock });
  const name = (table: { table: string }): string => qualified(schema, table.table);
  const person = name(PERSON);
  const address = name(ADDRESS);
  const interest = name(INTEREST);
  const tag = name(TAG);
  const favorite = name(FAVORITE);
  const extendData = name(EXTEND_DATA);
  const subtype = name(EXTEND_SUBTYPE);
  const set = name(EXTEND_SET);
  const attribute = name(EXTEND_ATTRIBUTE);
  const archive = name(PERSON_ARCHIVE);
  const rosterOperation = name(ROSTER_OPERATION);
  const groupName = name(GROUP_NAME);
  const trash = name(TRASH);
  const personTombstone = name(PERSON_TOMBSTONE);

  const legacyCi = qualified(schema, LEGACY_CHAR_CI_COLLATION);
  // Indexes on `<id> COLLATE legacyCi` serve these comparisons; an rtrim(lower(...)) form could not, because forced row
  // security keeps predicates with non-leakproof functions of a column out of index conditions.
  /** The char(35) id `column` equals the parameter `param` as SQL Server compares char ids: case-insensitively, trailing spaces ignored. */
  const idEquals = (column: string, param: string): string => `${column} COLLATE ${legacyCi} = ${param}::bpchar`;
  /** The char(35) id `column` equals an element of the array parameter `param`, compared as `idEquals` does. */
  const idIn = (column: string, param: string): string => `${column} COLLATE ${legacyCi} = ANY (${param}::bpchar[])`;
  // The text-to-bpchar cast is a binary relabel, not a function, so the comparison stays leakproof and keeps the column's statistics.
  /** The text site id `column` equals the parameter `param` as SQL Server compares varchar: case-insensitively, trailing spaces ignored. */
  const siteEquals = (column: string, param: string): string => `${column}::bpchar COLLATE ${legacyCi} = ${param}::bpchar`;
  /** The text site id `column` equals an element of the array parameter `param`, compared as `siteEquals` does. */
  const siteIn = (column: string, param: string): string => `${column}::bpchar COLLATE ${legacyCi} = ANY (${param}::bpchar[])`;

  // A person matching several spellings is returned once, at the first of them.
  const personsByIdSql =
    `SELECT p.* FROM ${person} AS p WHERE p.tenant_id = $1 AND ${idIn('p.userid', '$2')}` +
    ` ORDER BY (SELECT min(u.n) FROM unnest($2::bpchar[]) WITH ORDINALITY AS u(v, n) WHERE ${idEquals('p.userid', 'u.v')})`;
  const personByIdSql = `SELECT * FROM ${person} WHERE tenant_id = $1 AND ${idEquals('userid', '$2')}`;
  const lockPersonSql = `SELECT userid, row_version FROM ${person} WHERE tenant_id = $1 AND ${idEquals('userid', '$2')} FOR UPDATE`;
  // The term is not escaped, so % and _ stay wildcards as in SQL Server; ESCAPE '' keeps a backslash literal.
  const searchPersonsSql =
    `SELECT * FROM ${person} WHERE tenant_id = $1 AND ${siteEquals('siteid', '$2')}` +
    " AND (lname ILIKE $3 ESCAPE '' OR fname ILIKE $3 ESCAPE '' OR company ILIKE $3 ESCAPE '' OR email ILIKE $3 ESCAPE ''" +
    ` OR jobtitle ILIKE $3 ESCAPE '' OR ${idIn('userid', '$4')})` +
    ` AND ($5::bpchar[] IS NULL OR ${idIn('userid', '$5')})` +
    ' ORDER BY lower(lname) ASC NULLS FIRST, userid LIMIT $6';
  const addressesSql = `SELECT * FROM ${address} WHERE tenant_id = $1 AND ${idEquals('userid', '$2')} ORDER BY isprimary DESC NULLS LAST, addressid`;
  const lockOtherPrimariesSql =
    `SELECT addressid FROM ${address} WHERE tenant_id = $1 AND ${idEquals('userid', '$2')} AND addressid COLLATE ${legacyCi} <> $3::bpchar` +
    ' AND isprimary IS DISTINCT FROM 0 ORDER BY addressid FOR UPDATE';
  const addressByIdSql = `SELECT * FROM ${address} WHERE tenant_id = $1 AND ${idEquals('addressid', '$2')}`;
  const lockAddressSql = `SELECT addressid, isprimary FROM ${address} WHERE tenant_id = $1 AND ${idEquals('addressid', '$2')} FOR UPDATE`;
  const lockInterestsSql =
    `SELECT userid, categoryid FROM ${interest} WHERE tenant_id = $1 AND ${idEquals('userid', '$2')}` +
    ` AND ($3::bpchar[] IS NULL OR ${idIn('categoryid', '$3')}) ORDER BY categoryid FOR UPDATE`;
  // The submitted ids to insert, in input order: storable ($4), not held by the user and unequal to an earlier storable id.
  const newInterestsSql =
    'SELECT u.v AS categoryid FROM unnest($3::text[], $4::boolean[]) WITH ORDINALITY AS u(v, storable, n) WHERE u.storable' +
    ` AND NOT EXISTS (SELECT 1 FROM ${interest} AS i WHERE i.tenant_id = $1 AND ${idEquals('i.userid', '$2')} AND ${idEquals('i.categoryid', 'u.v')})` +
    ' AND NOT EXISTS (SELECT 1 FROM unnest($3::text[], $4::boolean[]) WITH ORDINALITY AS e(v, storable, n)' +
    ` WHERE e.n < u.n AND e.storable AND ${idEquals('e.v::bpchar', 'u.v')}) ORDER BY u.n`;
  const lockTagsSql = `SELECT tagid FROM ${tag} WHERE tenant_id = $1 AND ${idEquals('userid', '$2')} ORDER BY tagid FOR UPDATE`;
  // tusersinterests is clustered on (userID, categoryID), the order its unordered select returns.
  const interestsSql = `SELECT * FROM ${interest} WHERE tenant_id = $1 AND ${idEquals('userid', '$2')} ORDER BY categoryid`;
  const tagsSql = `SELECT * FROM ${tag} WHERE tenant_id = $1 AND ${idEquals('userid', '$2')} ORDER BY tagid`;
  const favoritesSql = `SELECT * FROM ${favorite} WHERE tenant_id = $1 AND ${idEquals('userid', '$2')} ORDER BY datecreated, favoriteid`;
  const extendDataSql = `SELECT * FROM ${extendData} WHERE tenant_id = $1 AND ${idIn('baseid', '$2')} ORDER BY baseid, attributeid, dataid`;
  const lockExtendByBaseSql = `SELECT dataid FROM ${extendData} WHERE tenant_id = $1 AND ${idEquals('baseid', '$2')} ORDER BY dataid FOR UPDATE`;
  const lockExtendByAttributesSql =
    `SELECT dataid, attributeid FROM ${extendData} WHERE tenant_id = $1 AND ${idEquals('baseid', '$2')}` +
    ' AND attributeid = ANY($3::integer[]) ORDER BY dataid FOR UPDATE';
  // The schema holds only the people split (baseTable tusers or tusersaddresses), so no baseTable predicate is needed.
  const subtypesSql =
    `SELECT * FROM ${subtype} WHERE tenant_id = $1 AND ${siteEquals('siteid', '$2')}` +
    ` AND ($3::text[] IS NULL OR ${ciText('type')} = ANY (SELECT ${ciText('t')} FROM unnest($3::text[]) AS t))` +
    ' ORDER BY lower(type) ASC NULLS FIRST, lower(subtype) ASC NULLS FIRST, subtypeid';
  const setsSql = `SELECT * FROM ${set} WHERE tenant_id = $1 AND ${idIn('subtypeid', '$2')} ORDER BY orderno ASC NULLS FIRST, extendsetid`;
  const attributesSql =
    `SELECT * FROM ${attribute} WHERE tenant_id = $1 AND ($2::bpchar[] IS NULL OR ${idIn('extendsetid', '$2')})` +
    ` AND ($3::integer[] IS NULL OR attributeid = ANY($3::integer[])) AND ($4::text IS NULL OR ${siteEquals('siteid', '$4')})` +
    ' ORDER BY orderno ASC NULLS FIRST, lower(name) ASC NULLS FIRST, attributeid';
  const trashByIdSql = `SELECT objectid FROM ${trash} WHERE tenant_id = $1 AND ${idEquals('objectid', '$2')}`;
  // The fixture's archive order (legacy-fixtures/cfml/modules/people.cfc findArchives).
  const archiveSql =
    `SELECT * FROM ${archive} WHERE tenant_id = $1 AND ${idEquals('person_id', '$2')} AND ($3::timestamp IS NULL OR effective_from = $3)` +
    ' ORDER BY effective_from, archive_id LIMIT 1';
  // The id is hashed under the collation, so every spelling of one person takes the same lock.
  const archiveLockSql = `SELECT pg_advisory_xact_lock(hashtext($1::text), hashbpchar($2::bpchar COLLATE ${legacyCi}))`;
  const openRosterSql =
    `SELECT * FROM ${rosterOperation} WHERE tenant_id = $1 AND ${idEquals('user_id', '$2')} AND state = ANY($3::text[])` +
    ' ORDER BY started_at, operation_id LIMIT 1';
  // SKIP LOCKED leaves a row another sweep or a request holds to the next sweep.
  const staleRosterSql =
    `SELECT * FROM ${rosterOperation} WHERE tenant_id = $1 AND (state = ANY($2::text[]) OR (state = 'done' AND error = $7)) AND updated_at < $3` +
    ' AND ($4::timestamp IS NULL OR (updated_at, operation_id) > ($4::timestamp, $5::bpchar)) ORDER BY updated_at, operation_id LIMIT $6' +
    ' FOR UPDATE SKIP LOCKED';
  const groupNamesSql =
    `SELECT * FROM ${groupName} WHERE tenant_id = $1 AND ($2::bpchar[] IS NULL OR ${idIn('group_id', '$2')})` +
    ' AND ($3::bpchar IS NULL OR group_id > $3::bpchar) ORDER BY group_id LIMIT $4';
  const lockGroupNameSql = `SELECT group_id FROM ${groupName} WHERE tenant_id = $1 AND ${idEquals('group_id', '$2')} FOR UPDATE`;
  const tombstoneSql = `SELECT userid, row_version FROM ${personTombstone} WHERE tenant_id = $1 AND ${idEquals('userid', '$2')}`;

  /** Selects rows of unit tables once no window phase blocks reading `units`. */
  function readUnits<R extends QueryResultRow>(tx: TenantTx, units: string | readonly string[], sql: string, params: readonly unknown[]): Promise<R[]> {
    return base.read(tx, units, () => select<R>(tx, sql, params));
  }

  /** Deletes the rows of `table` whose keys `keys` lists, each through the platform write; returns how many existed. */
  async function deleteKeys(tx: TenantTx, table: string, keys: readonly RepositoryRow[], ctx: WriteContext): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if ((await base.delete(tx, table, key, ctx)) !== null) deleted += 1;
    }
    return deleted;
  }

  /** `count` new target ids of an integer key, ascending, from the sequence 0002_person.sql owns by the column. */
  async function nextIds(tx: TenantTx, table: { table: string }, column: string, count: number): Promise<number[]> {
    if (count === 0) return [];
    const rows = await select<{ id: string | null }>(tx, NEXT_IDS_SQL, [name(table), column, count]);
    if (rows.some(({ id }) => id === null)) {
      throw new RepositoryError(`column ${column} has no id sequence`, table.table);
    }
    return rows.map(({ id }) => Number(id)).sort((a, b) => a - b);
  }

  async function findPerson(tx: TenantTx, userId: string): Promise<PersonRow | null> {
    return (await readUnits<PersonRow>(tx, PERSON.unit, personByIdSql, [tx.tenantId, userId]))[0] ?? null;
  }

  async function findPersons(tx: TenantTx, userIds: readonly string[]): Promise<PersonRow[]> {
    if (userIds.length === 0) return [];
    return readUnits<PersonRow>(tx, PERSON.unit, personsByIdSql, [tx.tenantId, [...userIds]]);
  }

  async function insertPerson(tx: TenantTx, input: PersonInput, ctx: WriteContext = {}): Promise<PersonRow> {
    const now = clock.now();
    const values: Readonly<Record<string, unknown>> = input;
    const row: RepositoryRow = {};
    for (const column of PERSON_INSERT_COLUMNS) {
      const type = PERSON_COLUMN_TYPES.get(column);
      if (type === 't') {
        row[column] = now;
      } else if (type === 's' && column !== 'userid') {
        row[column] = daoNull(values[column] as string | null | undefined);
      } else {
        // userDAO.create inlines UserID and the numeric flags, so they are written as given.
        row[column] = values[column] ?? null;
      }
    }
    const tombstone = await personTombstoneVersion(tx, input.userid);
    row.row_version = tombstone === null ? 1 : nextRowVersion(tombstone);
    return base.insert<PersonRow>(tx, PERSON.table, legacyStorable(PERSON.table, row), ctx);
  }

  async function updatePerson(tx: TenantTx, userId: string, input: PersonUpdate, ctx: WriteContext = {}): Promise<PersonRow | null> {
    // Locked first, so concurrent saves never publish the same row_version.
    const current = (await readUnits<Pick<PersonRow, 'userid' | 'row_version'>>(tx, PERSON.unit, lockPersonSql, [tx.tenantId, userId]))[0];
    const now = clock.now();
    const values: Readonly<Record<string, unknown>> = input;
    const patch: RepositoryRow = {};
    for (const column of PERSON_UPDATE_COLUMNS) {
      const type = PERSON_COLUMN_TYPES.get(column);
      if (type === 't') {
        patch[column] = now;
      } else if (column === 'siteid') {
        // userDAO.update writes '#trim(siteID)#' as a literal, so an empty site id stays ''.
        patch[column] = cfTrim((values[column] as string | null | undefined) ?? '');
      } else if (type === 's') {
        patch[column] = daoNull(values[column] as string | null | undefined);
      } else {
        patch[column] = values[column] ?? null;
      }
    }
    // SQL Server rejects an unstorable value even when the UPDATE matches no row.
    const stored = legacyStorable(PERSON.table, patch);
    if (current === undefined) {
      return null;
    }
    stored.row_version = nextRowVersion(current.row_version);
    return base.update<PersonRow>(tx, PERSON.table, { userid: current.userid }, stored, ctx);
  }

  /** The tombstone of `userId`, locked when `lock` is set; undefined when none. */
  async function tombstoneOf(tx: TenantTx, userId: string, lock = false): Promise<Pick<PersonTombstoneRow, 'userid' | 'row_version'> | undefined> {
    return (await select<Pick<PersonTombstoneRow, 'userid' | 'row_version'>>(tx, lock ? `${tombstoneSql} FOR UPDATE` : tombstoneSql, [tx.tenantId, userId]))[0];
  }

  async function personTombstoneVersion(tx: TenantTx, userId: string): Promise<string | null> {
    return (await tombstoneOf(tx, userId))?.row_version ?? null;
  }

  async function recordPersonTombstone(tx: TenantTx, userId: string, rowVersion: string, ctx: WriteContext = {}): Promise<PersonTombstoneRow> {
    // A stored tombstone keeps its id spelling.
    const stored = await tombstoneOf(tx, userId, true);
    return base.upsert<PersonTombstoneRow>(tx, PERSON_TOMBSTONE.table, { userid: stored?.userid ?? userId, row_version: rowVersion }, ctx);
  }

  /** WHERE terms of the persons of user-pool site `siteId`, optionally only `userIds`, over their bound parameters. */
  function siteFilter(tx: TenantTx, siteId: string, userIds: readonly string[] | undefined): PersonFilter {
    const where = ['tenant_id = $1', siteEquals('siteid', '$2')];
    if (userIds === undefined) return { where, params: [tx.tenantId, siteId] };
    return { where: [...where, idIn('userid', '$3')], params: [tx.tenantId, siteId, [...userIds]] };
  }

  /** WHERE terms of the persons matching `query`, over their bound parameters; throws RepositoryError for an unknown column. */
  function queryFilter(tx: TenantTx, query: Omit<PersonQuery, 'limit'>): PersonFilter {
    const params: unknown[] = [tx.tenantId];
    const bind = binder(params);
    const where = ['tenant_id = $1'];
    if (query.siteIds !== undefined) where.push(siteIn('siteid', bind([...query.siteIds])));
    if (query.userIds !== undefined) where.push(idIn('userid', bind([...query.userIds])));
    const conditions = (query.conditions ?? []).map((condition) => conditionSql(condition, bind));
    if (conditions.length > 0) where.push(`(${conditions.join(query.combine === 'or' ? ' OR ' : ' AND ')})`);
    return { where, params };
  }

  /** The `take` persons of `filter` after `after`, in `orderBy` order then userid; the sort-key values ride along under alias columns. */
  async function personPage(
    tx: TenantTx,
    filter: PersonFilter,
    orderBy: readonly PersonOrder[],
    after: PersonCursor | null | undefined,
    take: number,
  ): Promise<Page<PersonRow, PersonCursor>> {
    const params = [...filter.params];
    const bind = binder(params);
    const keys = orderBy.map(orderKey);
    const aliases = keys.map((_, index) => orderAlias(index));
    const where = after === null || after === undefined ? filter.where : [...filter.where, afterSql(keys, after, bind)];
    const columns = ['*', ...keys.map((key, index) => `${key.expression} AS "${orderAlias(index)}"`)].join(', ');
    const order = [...keys.map(orderSql), 'userid'].join(', ');
    const sql = `SELECT ${columns} FROM ${person} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${bind(take + 1)}`;
    const found = await readUnits<RepositoryRow>(tx, PERSON.unit, sql, params);
    const page = pageOf(found, take, (row) => ({ keys: aliases.map((alias) => row[alias]), userid: row.userid as string }));
    const hidden = new Set(aliases);
    const rows = page.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !hidden.has(column))) as PersonRow);
    return { rows, next: page.next };
  }

  function listPersonsForSite(tx: TenantTx, siteId: string, opts: { userIds?: readonly string[] } = {}): Promise<PersonRow[]> {
    const filter = siteFilter(tx, siteId, opts.userIds);
    return collect((after: PersonCursor | null, take) => personPage(tx, filter, DEFAULT_PERSON_ORDER, after, take));
  }

  async function pagePersonsForSite(
    tx: TenantTx,
    siteId: string,
    opts: PageOptions<PersonCursor> & { userIds?: readonly string[] } = {},
  ): Promise<Page<PersonRow, PersonCursor>> {
    return personPage(tx, siteFilter(tx, siteId, opts.userIds), DEFAULT_PERSON_ORDER, opts.after, pageSize(opts.limit));
  }

  async function searchPersons(tx: TenantTx, search: PersonSearch): Promise<PersonRow[]> {
    const limit = search.limit === undefined ? SEARCH_MAX_ROWS : positiveLimit(search.limit, 'search limit');
    // getSearch adds `and 0=1` for an empty search term.
    if (search.term === '') return [];
    const params = [
      tx.tenantId,
      search.siteId,
      `%${search.term}%`,
      [...(search.orUserIds ?? [])],
      search.restrictUserIds === undefined ? null : [...search.restrictUserIds],
      limit,
    ];
    return readUnits<PersonRow>(tx, PERSON.unit, searchPersonsSql, params);
  }

  async function queryPersons(tx: TenantTx, query: PersonQuery): Promise<PersonRow[]> {
    const cap = query.limit === undefined ? Number.POSITIVE_INFINITY : positiveLimit(query.limit, 'query limit');
    const filter = queryFilter(tx, query);
    const orderBy = query.orderBy ?? DEFAULT_PERSON_ORDER;
    return collect((after: PersonCursor | null, take) => personPage(tx, filter, orderBy, after, take), cap);
  }

  async function pageQueryPersons(
    tx: TenantTx,
    query: Omit<PersonQuery, 'limit'>,
    opts: PageOptions<PersonCursor> = {},
  ): Promise<Page<PersonRow, PersonCursor>> {
    return personPage(tx, queryFilter(tx, query), query.orderBy ?? DEFAULT_PERSON_ORDER, opts.after, pageSize(opts.limit));
  }

  function listAddresses(tx: TenantTx, userId: string): Promise<AddressRow[]> {
    return readUnits<AddressRow>(tx, ADDRESS.unit, addressesSql, [tx.tenantId, userId]);
  }

  async function findAddress(tx: TenantTx, addressId: string): Promise<AddressRow | null> {
    return (await readUnits<AddressRow>(tx, ADDRESS.unit, addressByIdSql, [tx.tenantId, addressId]))[0] ?? null;
  }

  /** Locks the address `addressId` and returns its stored id and primary flag; undefined when absent. */
  async function lockAddress(tx: TenantTx, addressId: string): Promise<Pick<AddressRow, 'addressid' | 'isprimary'> | undefined> {
    return (await readUnits<Pick<AddressRow, 'addressid' | 'isprimary'>>(tx, ADDRESS.unit, lockAddressSql, [tx.tenantId, addressId]))[0];
  }

  async function insertAddress(tx: TenantTx, input: AddressInput, ctx: WriteContext = {}): Promise<AddressRow> {
    // createAddress inlines AddressID, UserID and the numeric columns; addressBean initialises the numbers to 0.
    const row: Omit<AddressRow, 'tenant_id'> = {
      addressid: input.addressid === undefined || input.addressid === '' ? cfUuid() : input.addressid,
      userid: input.userid,
      siteid: daoNull(input.siteid),
      addressname: daoNull(input.addressname),
      address1: daoNull(input.address1),
      address2: daoNull(input.address2),
      city: daoNull(input.city),
      state: daoNull(input.state),
      zip: daoNull(input.zip),
      country: daoNull(input.country),
      phone: daoNull(input.phone),
      fax: daoNull(input.fax),
      isprimary: input.isprimary === undefined ? 0 : input.isprimary,
      addressnotes: daoNull(input.addressnotes),
      addressurl: daoNull(input.addressurl),
      longitude: input.longitude === undefined ? 0 : input.longitude,
      latitude: input.latitude === undefined ? 0 : input.latitude,
      addressemail: daoNull(input.addressemail),
      hours: daoNull(input.hours),
    };
    return base.insert<AddressRow>(tx, ADDRESS.table, legacyStorable(ADDRESS.table, row), ctx);
  }

  async function updateAddress(tx: TenantTx, addressId: string, input: AddressUpdate, ctx: WriteContext = {}): Promise<AddressRow | null> {
    const patch: Omit<AddressRow, 'tenant_id' | 'addressid' | 'isprimary'> = {
      phone: daoNull(input.phone),
      address1: daoNull(input.address1),
      address2: daoNull(input.address2),
      city: daoNull(input.city),
      state: daoNull(input.state),
      zip: daoNull(input.zip),
      fax: daoNull(input.fax),
      addressnotes: daoNull(input.addressnotes),
      // updateAddress writes '#trim(siteID)#' as a literal, so an empty site id stays ''.
      siteid: cfTrim(input.siteid ?? ''),
      userid: daoNull(input.userid),
      addressname: daoNull(input.addressname),
      country: daoNull(input.country),
      addressurl: daoNull(input.addressurl),
      longitude: input.longitude === undefined ? 0 : input.longitude,
      latitude: input.latitude === undefined ? 0 : input.latitude,
      addressemail: daoNull(input.addressemail),
      hours: daoNull(input.hours),
    };
    // SQL Server rejects an unstorable value even when the UPDATE matches no row; the platform write keys on the stored id spelling.
    const stored = legacyStorable(ADDRESS.table, patch);
    const target = await lockAddress(tx, addressId);
    return target === undefined ? null : base.update<AddressRow>(tx, ADDRESS.table, { addressid: target.addressid }, stored, ctx);
  }

  /** Deletes every extended value stored under `baseId`. */
  async function deleteExtendRows(tx: TenantTx, baseId: string, ctx: WriteContext): Promise<number> {
    const stale = await readUnits<{ dataid: number }>(tx, EXTEND_DATA.unit, lockExtendByBaseSql, [tx.tenantId, baseId]);
    return deleteKeys(tx, EXTEND_DATA.table, stale, ctx);
  }

  async function deleteAddress(tx: TenantTx, addressId: string, ctx: WriteContext = {}): Promise<boolean> {
    // Legacy also deletes tcontentratings rows of the address; that table belongs to strategies-content.
    const target = await lockAddress(tx, addressId);
    const removed = target === undefined ? null : await base.delete(tx, ADDRESS.table, { addressid: target.addressid }, ctx);
    await deleteExtendRows(tx, addressId, ctx);
    return removed !== null;
  }

  async function setPrimaryAddress(tx: TenantTx, userId: string, addressId: string, ctx: WriteContext = {}): Promise<void> {
    // Rows already at the target value are skipped, so no changelog row records a no-op update.
    const others = await readUnits<{ addressid: string }>(tx, ADDRESS.unit, lockOtherPrimariesSql, [tx.tenantId, userId, addressId]);
    for (const { addressid } of others) {
      await base.update(tx, ADDRESS.table, { addressid }, { isprimary: 0 }, ctx);
    }
    const target = await lockAddress(tx, addressId);
    if (target !== undefined && target.isprimary !== 1) {
      await base.update(tx, ADDRESS.table, { addressid: target.addressid }, { isprimary: 1 }, ctx);
    }
  }

  function listInterests(tx: TenantTx, userId: string): Promise<InterestRow[]> {
    return readUnits<InterestRow>(tx, INTEREST.unit, interestsSql, [tx.tenantId, userId]);
  }

  function listTags(tx: TenantTx, userId: string): Promise<TagRow[]> {
    return readUnits<TagRow>(tx, TAG.unit, tagsSql, [tx.tenantId, userId]);
  }

  async function replaceInterests(
    tx: TenantTx,
    userId: string,
    categoryIds: readonly string[],
    opts: { scopeCategoryIds?: readonly string[] } = {},
    ctx: WriteContext = {},
  ): Promise<InterestRow[]> {
    const scope = opts.scopeCategoryIds === undefined ? null : [...opts.scopeCategoryIds];
    const stale = await readUnits<Pick<InterestRow, 'userid' | 'categoryid'>>(tx, INTEREST.unit, lockInterestsSql, [tx.tenantId, userId, scope]);
    await deleteKeys(tx, INTEREST.table, stale, ctx);
    // Legacy swallows each failed insert, so an id the key already holds, or one too long for char(35), is skipped;
    // SQL selects them, so the skipped ids are exactly those the key's unique index would reject.
    const storable = categoryIds.map((categoryId) => storableId(categoryId));
    const fresh = await select<{ categoryid: string }>(tx, newInterestsSql, [tx.tenantId, userId, [...categoryIds], storable]);
    const inserted: InterestRow[] = [];
    for (const { categoryid } of fresh) {
      inserted.push(await base.insert<InterestRow>(tx, INTEREST.table, { userid: userId, categoryid }, ctx));
    }
    return inserted;
  }

  async function replaceTags(tx: TenantTx, input: TagReplacement, ctx: WriteContext = {}): Promise<TagRow[]> {
    // createTags binds siteID without the DAO NULL rule, so it is written as given.
    const rows = (input.tags ?? '')
      .split(',')
      .map((item) => cfTrim(item))
      .filter((value) => value !== '')
      .map((value) => legacyStorable(TAG.table, { userid: input.userId, siteid: input.siteId, tag: value }));
    const stale = await readUnits<{ tagid: number }>(tx, TAG.unit, lockTagsSql, [tx.tenantId, input.userId]);
    await deleteKeys(tx, TAG.table, stale, ctx);
    const ids = await nextIds(tx, TAG, 'tagid', rows.length);
    const created: TagRow[] = [];
    for (const [index, row] of rows.entries()) {
      const stored: Omit<TagRow, 'tenant_id'> = { tagid: ids[index] as number, ...row };
      created.push(await base.insert<TagRow>(tx, TAG.table, stored, ctx));
    }
    return created;
  }

  function listFavorites(tx: TenantTx, userId: string): Promise<FavoriteRow[]> {
    return readUnits<FavoriteRow>(tx, FAVORITE.unit, favoritesSql, [tx.tenantId, userId]);
  }

  async function listExtendData(tx: TenantTx, baseIds: readonly string[]): Promise<ExtendDataRow[]> {
    if (baseIds.length === 0) return [];
    return readUnits<ExtendDataRow>(tx, EXTEND_DATA.unit, extendDataSql, [tx.tenantId, [...baseIds]]);
  }

  async function replaceExtendData(
    tx: TenantTx,
    baseId: string,
    entries: readonly ExtendDataReplacement[],
    ctx: WriteContext = {},
  ): Promise<ExtendDataRow[]> {
    if (entries.length === 0) return [];
    const values = entries.map(({ row }) => (row === null ? null : legacyStorable(EXTEND_DATA.table, row)));
    const attributeIds = [...new Set(entries.map(({ attributeId }) => attributeId))];
    // Rows each attribute holds, ascending; an entry replaces them, so a repeated attribute deletes its earlier insert.
    const held = new Map<number, number[]>(attributeIds.map((attributeId) => [attributeId, []]));
    const locked = await readUnits<{ dataid: number; attributeid: number }>(tx, EXTEND_DATA.unit, lockExtendByAttributesSql, [
      tx.tenantId,
      baseId,
      attributeIds,
    ]);
    for (const { dataid, attributeid } of locked) held.get(attributeid)?.push(dataid);
    const ids = await nextIds(tx, EXTEND_DATA, 'dataid', values.filter((row) => row !== null).length);
    const inserted: ExtendDataRow[] = [];
    for (const [index, { attributeId }] of entries.entries()) {
      await deleteKeys(tx, EXTEND_DATA.table, (held.get(attributeId) ?? []).map((dataid) => ({ dataid })), ctx);
      held.set(attributeId, []);
      const row = values[index] ?? null;
      if (row === null) continue;
      const stored: Omit<ExtendDataRow, 'tenant_id'> = {
        ...row,
        dataid: ids[inserted.length] as number,
        baseid: baseId,
        attributeid: attributeId,
      };
      inserted.push(await base.insert<ExtendDataRow>(tx, EXTEND_DATA.table, stored, ctx));
      held.set(attributeId, [stored.dataid]);
    }
    return inserted;
  }

  function deleteExtendDataForBase(tx: TenantTx, baseId: string, ctx: WriteContext = {}): Promise<number> {
    return deleteExtendRows(tx, baseId, ctx);
  }

  function listExtendSubtypes(tx: TenantTx, filter: { siteId: string; types?: readonly string[] }): Promise<ExtendSubtypeRow[]> {
    const types = filter.types === undefined ? null : [...filter.types];
    return readUnits<ExtendSubtypeRow>(tx, EXTEND_SUBTYPE.unit, subtypesSql, [tx.tenantId, filter.siteId, types]);
  }

  async function listExtendSets(tx: TenantTx, subtypeIds: readonly string[]): Promise<ExtendSetRow[]> {
    if (subtypeIds.length === 0) return [];
    return readUnits<ExtendSetRow>(tx, EXTEND_SET.unit, setsSql, [tx.tenantId, [...subtypeIds]]);
  }

  function listExtendAttributes(tx: TenantTx, filter: ExtendAttributeFilter): Promise<ExtendAttributeRow[]> {
    const params = [
      tx.tenantId,
      filter.setIds === undefined ? null : [...filter.setIds],
      filter.attributeIds === undefined ? null : [...filter.attributeIds],
      filter.siteId ?? null,
    ];
    return readUnits<ExtendAttributeRow>(tx, EXTEND_ATTRIBUTE.unit, attributesSql, params);
  }

  async function insertTrashIfAbsent(tx: TenantTx, row: TrashInput, ctx: WriteContext = {}): Promise<TrashRow | null> {
    if ((await readUnits(tx, TRASH.unit, trashByIdSql, [tx.tenantId, row.objectid])).length > 0) {
      return null;
    }
    return base.insert<TrashRow>(tx, TRASH.table, legacyStorable(TRASH.table, row), ctx);
  }

  async function findPersonArchive(tx: TenantTx, personId: string, effectiveFrom?: Date): Promise<PersonArchiveRow | null> {
    const rows = await readUnits<PersonArchiveRow>(tx, PERSON_ARCHIVE.unit, archiveSql, [tx.tenantId, personId, effectiveFrom ?? null]);
    return rows[0] ?? null;
  }

  async function insertPersonArchive(tx: TenantTx, row: PersonArchiveInput, ctx: WriteContext = {}): Promise<PersonArchiveRow> {
    // The fixture rejects any second archive of a person, serialising archives per person (UPDLOCK, HOLDLOCK); this lock does the same.
    await tx.query(archiveLockSql, [`${schema}.${PERSON_ARCHIVE.table}:${tx.tenantId}:`, row.person_id]);
    if ((await findPersonArchive(tx, row.person_id)) !== null) {
      throw new DuplicateArchiveError(row.person_id);
    }
    const stored: Omit<PersonArchiveRow, 'tenant_id'> = legacyStorable(PERSON_ARCHIVE.table, {
      ...row,
      archive_id: row.archive_id === undefined || row.archive_id === '' ? cfUuid() : row.archive_id,
      archived_at: row.archived_at ?? clock.now(),
    });
    try {
      return await base.insert<PersonArchiveRow>(tx, PERSON_ARCHIVE.table, stored, ctx);
    } catch (err) {
      // PostgreSQL has aborted the transaction, so the error must leave it.
      if (isUniqueViolation(err, ARCHIVE_UNIQUE_CONSTRAINT) || isUniqueViolation(err, ARCHIVE_CI_UNIQUE_INDEX)) {
        throw new DuplicateArchiveError(row.person_id, { cause: err });
      }
      throw err;
    }
  }

  async function insertRosterOperation(tx: TenantTx, input: RosterOperationInput, ctx: WriteContext = {}): Promise<RosterOperationRow> {
    const now = clock.now();
    const row: Omit<RosterOperationRow, 'tenant_id'> = {
      operation_id: cfUuid(),
      kind: input.kind,
      user_id: input.userId,
      payload: input.payload,
      before_image: null,
      identity_xid: null,
      state: 'started',
      error: null,
      started_at: now,
      updated_at: now,
      identity_unreachable_since: null,
    };
    try {
      return await base.insert<RosterOperationRow>(tx, ROSTER_OPERATION.table, row, ctx);
    } catch (err) {
      if (isUniqueViolation(err, OPEN_ROSTER_INDEX)) {
        throw new RosterOperationOpenError(input.userId);
      }
      throw err;
    }
  }

  function setRosterOperationState(
    tx: TenantTx,
    operationId: string,
    patch: RosterOperationStatePatch,
    ctx: WriteContext = {},
  ): Promise<RosterOperationRow | null> {
    // Undefined optional columns are left as stored; null clears them.
    const values: RepositoryRow = {
      state: patch.state,
      before_image: patch.beforeImage,
      identity_xid: patch.identityXid,
      error: patch.error,
      identity_unreachable_since: patch.identityUnreachableSince,
      updated_at: clock.now(),
    };
    return base.update<RosterOperationRow>(tx, ROSTER_OPERATION.table, { operation_id: operationId }, values, ctx);
  }

  function findRosterOperation(tx: TenantTx, operationId: string): Promise<RosterOperationRow | null> {
    return base.findByKey<RosterOperationRow>(tx, ROSTER_OPERATION.table, { operation_id: operationId });
  }

  async function findOpenRosterOperation(tx: TenantTx, userId: string): Promise<RosterOperationRow | null> {
    return (await select<RosterOperationRow>(tx, openRosterSql, [tx.tenantId, userId, [...OPEN_ROSTER_STATES]]))[0] ?? null;
  }

  /** The `take` stale roster operations after `after`, oldest first. */
  async function staleRosterPage(
    tx: TenantTx,
    olderThan: Date,
    after: RosterOperationCursor | null | undefined,
    take: number,
  ): Promise<Page<RosterOperationRow, RosterOperationCursor>> {
    const params = [
      tx.tenantId,
      [...RECOVERABLE_ROSTER_STATES],
      olderThan,
      after?.updatedAt ?? null,
      after?.operationId ?? null,
      take + 1,
      FINISH_PENDING_ERROR,
    ];
    const found = await select<RosterOperationRow>(tx, staleRosterSql, params);
    return pageOf(found, take, (row) => ({ updatedAt: row.updated_at, operationId: row.operation_id }));
  }

  function listStaleRosterOperations(tx: TenantTx, olderThan: Date): Promise<RosterOperationRow[]> {
    return collect((after: RosterOperationCursor | null, take) => staleRosterPage(tx, olderThan, after, take));
  }

  async function pageStaleRosterOperations(
    tx: TenantTx,
    olderThan: Date,
    opts: PageOptions<RosterOperationCursor> = {},
  ): Promise<Page<RosterOperationRow, RosterOperationCursor>> {
    return staleRosterPage(tx, olderThan, opts.after, pageSize(opts.limit));
  }

  /** Locks the projection row of `groupId` and returns its stored group id; undefined when absent. */
  async function lockGroupName(tx: TenantTx, groupId: string): Promise<string | undefined> {
    return (await select<{ group_id: string }>(tx, lockGroupNameSql, [tx.tenantId, groupId]))[0]?.group_id;
  }

  async function upsertGroupName(tx: TenantTx, row: GroupNameInput, ctx: WriteContext = {}): Promise<GroupNameRow> {
    // A stored row keeps its id spelling.
    const stored = await lockGroupName(tx, row.group_id);
    return base.upsert<GroupNameRow>(tx, GROUP_NAME.table, stored === undefined ? row : { ...row, group_id: stored }, ctx);
  }

  async function deleteGroupName(tx: TenantTx, groupId: string, ctx: WriteContext = {}): Promise<boolean> {
    const stored = await lockGroupName(tx, groupId);
    return stored !== undefined && (await base.delete(tx, GROUP_NAME.table, { group_id: stored }, ctx)) !== null;
  }

  /** The `take` projection rows of `groupIds` (all when omitted) after group id `after`, by group id. */
  async function groupNamePage(
    tx: TenantTx,
    groupIds: readonly string[] | undefined,
    after: string | null | undefined,
    take: number,
  ): Promise<Page<GroupNameRow, string>> {
    const found = await select<GroupNameRow>(tx, groupNamesSql, [tx.tenantId, groupIds === undefined ? null : [...groupIds], after ?? null, take + 1]);
    return pageOf(found, take, (row) => row.group_id);
  }

  function listGroupNames(tx: TenantTx, groupIds?: readonly string[]): Promise<GroupNameRow[]> {
    return collect((after: string | null, take) => groupNamePage(tx, groupIds, after, take));
  }

  async function pageGroupNames(tx: TenantTx, opts: PageOptions<string> & { groupIds?: readonly string[] } = {}): Promise<Page<GroupNameRow, string>> {
    return groupNamePage(tx, opts.groupIds, opts.after, pageSize(opts.limit));
  }

  return Object.freeze({
    ...base,
    base,
    findPerson,
    findPersons,
    insertPerson,
    updatePerson,
    personTombstoneVersion,
    recordPersonTombstone,
    listPersonsForSite,
    pagePersonsForSite,
    searchPersons,
    queryPersons,
    pageQueryPersons,
    listAddresses,
    findAddress,
    insertAddress,
    updateAddress,
    deleteAddress,
    setPrimaryAddress,
    listInterests,
    listTags,
    replaceInterests,
    replaceTags,
    listFavorites,
    listExtendData,
    replaceExtendData,
    deleteExtendDataForBase,
    listExtendSubtypes,
    listExtendSets,
    listExtendAttributes,
    insertTrashIfAbsent,
    findPersonArchive,
    insertPersonArchive,
    insertRosterOperation,
    setRosterOperationState,
    findRosterOperation,
    findOpenRosterOperation,
    listStaleRosterOperations,
    pageStaleRosterOperations,
    upsertGroupName,
    deleteGroupName,
    listGroupNames,
    pageGroupNames,
  });
}
