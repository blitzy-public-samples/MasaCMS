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
/** The partial unique index on `roster_operation.user_id` over open states (0004_roster_archive.sql). */
const OPEN_ROSTER_INDEX = 'roster_operation_open_user_uidx';
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const NEXT_ID_SQL = 'SELECT nextval(pg_get_serial_sequence($1, $2)::regclass)::text AS id';

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

/** The SQL Server `char` key equality form: trailing spaces stripped, A-Z and À-Þ case folded. */
function charKey(value: string): string {
  return value.replace(/ +$/, '').replace(/[A-Z\u00C0-\u00DE]/g, (c) => c.toLowerCase());
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
 * `LastUpdateBy` and `LastUpdateByID` of a saved person [legacy: core/mura/user/userManager.cfc:834-845]:
 * a logged-in actor names itself, otherwise the person names itself.
 */
export function lastUpdateInfo(actor: AuditActor | null | undefined, person: AuditSubject): { lastupdateby: string; lastupdatebyid: string } {
  // CFML left(..., 50) counts UTF-16 code units, as slice does; two empty names leave the single space.
  const label = (names: { fname?: string | null; lname?: string | null }): string => `${names.fname ?? ''} ${names.lname ?? ''}`.slice(0, 50);
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
  limit?: number;
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

/** The platform repository of schema `people` plus typed helpers; every helper runs in the caller's open tenant transaction. */
export interface PeopleRepository extends Repository {
  /** The underlying platform repository, as `registerMigrationHandlers` takes it. */
  readonly base: Repository;

  /** The person `userId`; null when absent. */
  findPerson(tx: TenantTx, userId: string): Promise<PersonRow | null>;
  /** The persons of `userIds` in input order; missing ids are omitted. */
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
  /** The person-column part of `getSearch`: none for an empty term, else a LIKE match on name, company, email or job title, by last name. */
  searchPersons(tx: TenantTx, search: PersonSearch): Promise<PersonRow[]>;
  /** Persons matching `query`, by its order (default last then first name). */
  queryPersons(tx: TenantTx, query: PersonQuery): Promise<PersonRow[]>;

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
  /** Started or people-committed operations last updated before `olderThan`, oldest first. */
  listStaleRosterOperations(tx: TenantTx, olderThan: Date): Promise<RosterOperationRow[]>;

  /** Inserts or replaces the projection row of `row.group_id`. */
  upsertGroupName(tx: TenantTx, row: GroupNameInput, ctx?: WriteContext): Promise<GroupNameRow>;
  /** Deletes the projection row of `groupId`; false when absent. */
  deleteGroupName(tx: TenantTx, groupId: string, ctx?: WriteContext): Promise<boolean>;
  /** Projection rows of `groupIds` (all when omitted), by group id. */
  listGroupNames(tx: TenantTx, groupIds?: readonly string[]): Promise<GroupNameRow[]>;
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

/** One ORDER BY key: text case-insensitively, NULLs lowest as in SQL Server. */
function orderSql(order: PersonOrder): string {
  const { sql: column, text } = personColumn(order.column);
  const key = text ? `lower(${column})` : column;
  return order.direction === 'desc' ? `${key} DESC NULLS LAST` : `${key} ASC NULLS FIRST`;
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

  // SQL Server sorts NULL lowest and compares names case-insensitively; userid makes ties deterministic.
  const personOrder = 'lower(lname) ASC NULLS FIRST, lower(fname) ASC NULLS FIRST, userid';
  // A bpchar[] keeps userid uncast, so the (tenant_id, userid) key applies.
  const personsByIdSql = `SELECT * FROM ${person} WHERE tenant_id = $1 AND userid = ANY($2::bpchar[])`;
  const lockPersonSql = `SELECT userid, row_version FROM ${person} WHERE tenant_id = $1 AND userid = $2 FOR UPDATE`;
  const personsForSiteSql =
    `SELECT * FROM ${person} WHERE tenant_id = $1 AND siteid = $2 AND ($3::bpchar[] IS NULL OR userid = ANY($3::bpchar[]))` +
    ` ORDER BY ${personOrder}`;
  // The term is not escaped, so % and _ stay wildcards as in SQL Server; ESCAPE '' keeps a backslash literal.
  const searchPersonsSql =
    `SELECT * FROM ${person} WHERE tenant_id = $1 AND siteid = $2` +
    " AND (lname ILIKE $3 ESCAPE '' OR fname ILIKE $3 ESCAPE '' OR company ILIKE $3 ESCAPE '' OR email ILIKE $3 ESCAPE ''" +
    " OR jobtitle ILIKE $3 ESCAPE '' OR userid = ANY($4::bpchar[]))" +
    ' AND ($5::bpchar[] IS NULL OR userid = ANY($5::bpchar[]))' +
    ' ORDER BY lower(lname) ASC NULLS FIRST, userid LIMIT $6';
  const addressesSql = `SELECT * FROM ${address} WHERE tenant_id = $1 AND userid = $2 ORDER BY isprimary DESC NULLS LAST, addressid`;
  const lockOtherPrimariesSql =
    `SELECT addressid FROM ${address} WHERE tenant_id = $1 AND userid = $2 AND addressid <> $3` +
    ' AND isprimary IS DISTINCT FROM 0 ORDER BY addressid FOR UPDATE';
  const lockAddressSql = `SELECT isprimary FROM ${address} WHERE tenant_id = $1 AND addressid = $2 FOR UPDATE`;
  const lockInterestsSql =
    `SELECT categoryid FROM ${interest} WHERE tenant_id = $1 AND userid = $2` +
    ' AND ($3::bpchar[] IS NULL OR categoryid = ANY($3::bpchar[])) ORDER BY categoryid FOR UPDATE';
  const interestIdsSql = `SELECT categoryid FROM ${interest} WHERE tenant_id = $1 AND userid = $2`;
  const lockTagsSql = `SELECT tagid FROM ${tag} WHERE tenant_id = $1 AND userid = $2 ORDER BY tagid FOR UPDATE`;
  const favoritesSql = `SELECT * FROM ${favorite} WHERE tenant_id = $1 AND userid = $2 ORDER BY datecreated, favoriteid`;
  const extendDataSql = `SELECT * FROM ${extendData} WHERE tenant_id = $1 AND baseid = ANY($2::bpchar[]) ORDER BY baseid, attributeid, dataid`;
  const lockExtendByBaseSql = `SELECT dataid FROM ${extendData} WHERE tenant_id = $1 AND baseid = $2 ORDER BY dataid FOR UPDATE`;
  const lockExtendByAttributeSql =
    `SELECT dataid FROM ${extendData} WHERE tenant_id = $1 AND baseid = $2 AND attributeid = $3 ORDER BY dataid FOR UPDATE`;
  // The schema holds only the people split (baseTable tusers or tusersaddresses), so no baseTable predicate is needed.
  const subtypesSql =
    `SELECT * FROM ${subtype} WHERE tenant_id = $1 AND siteid = $2` +
    ` AND ($3::text[] IS NULL OR ${ciText('type')} = ANY (SELECT ${ciText('t')} FROM unnest($3::text[]) AS t))` +
    ' ORDER BY lower(type) ASC NULLS FIRST, lower(subtype) ASC NULLS FIRST, subtypeid';
  const setsSql = `SELECT * FROM ${set} WHERE tenant_id = $1 AND subtypeid = ANY($2::bpchar[]) ORDER BY orderno ASC NULLS FIRST, extendsetid`;
  // SQL Server's char equality, leakproof and so indexable under forced RLS: bpchar ignores trailing spaces, legacy_char_ci compares the rest.
  const attributesSql =
    `SELECT * FROM ${attribute} WHERE tenant_id = $1` +
    ` AND ($2::bpchar[] IS NULL OR (extendsetid COLLATE ${qualified(schema, 'legacy_char_ci')}) = ANY ($2::bpchar[]))` +
    ` AND ($3::integer[] IS NULL OR attributeid = ANY($3::integer[])) AND ($4::text IS NULL OR ${ciText('siteid')} = ${ciText('$4::text')})` +
    ' ORDER BY orderno ASC NULLS FIRST, lower(name) ASC NULLS FIRST, attributeid';
  // The fixture's archive order (legacy-fixtures/cfml/modules/people.cfc findArchives).
  const archiveSql =
    `SELECT * FROM ${archive} WHERE tenant_id = $1 AND person_id = $2 AND ($3::timestamp IS NULL OR effective_from = $3)` +
    ' ORDER BY effective_from, archive_id LIMIT 1';
  const openRosterSql =
    `SELECT * FROM ${rosterOperation} WHERE tenant_id = $1 AND user_id = $2 AND state = ANY($3::text[])` +
    ' ORDER BY started_at, operation_id LIMIT 1';
  const staleRosterSql =
    `SELECT * FROM ${rosterOperation} WHERE tenant_id = $1 AND state = ANY($2::text[]) AND updated_at < $3` +
    ' ORDER BY updated_at, operation_id';
  const groupNamesSql =
    `SELECT * FROM ${groupName} WHERE tenant_id = $1 AND ($2::bpchar[] IS NULL OR group_id = ANY($2::bpchar[])) ORDER BY group_id`;

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

  /** The next target id of an integer key from the sequence 0002_person.sql owns by the column. */
  async function nextId(tx: TenantTx, table: { table: string }, column: string): Promise<number> {
    const id = (await select<{ id: string | null }>(tx, NEXT_ID_SQL, [name(table), column]))[0]?.id ?? null;
    if (id === null) {
      throw new RepositoryError(`column ${column} has no id sequence`, table.table);
    }
    return Number(id);
  }

  function findPerson(tx: TenantTx, userId: string): Promise<PersonRow | null> {
    return base.findByKey<PersonRow>(tx, PERSON.table, { userid: userId });
  }

  async function findPersons(tx: TenantTx, userIds: readonly string[]): Promise<PersonRow[]> {
    if (userIds.length === 0) return [];
    const rows = await readUnits<PersonRow>(tx, PERSON.unit, personsByIdSql, [tx.tenantId, [...userIds]]);
    // bpchar pads short ids, so rows and inputs are matched with their trailing spaces stripped.
    const byId = new Map(rows.map((row) => [row.userid.replace(/ +$/, ''), row]));
    const found: PersonRow[] = [];
    for (const id of new Set(userIds.map((userId) => userId.replace(/ +$/, '')))) {
      const row = byId.get(id);
      if (row !== undefined) found.push(row);
    }
    return found;
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
    return base.insert<PersonRow>(tx, PERSON.table, row, ctx);
  }

  async function updatePerson(tx: TenantTx, userId: string, input: PersonUpdate, ctx: WriteContext = {}): Promise<PersonRow | null> {
    // Locked first, so concurrent saves never publish the same row_version.
    const current = (await readUnits<Pick<PersonRow, 'userid' | 'row_version'>>(tx, PERSON.unit, lockPersonSql, [tx.tenantId, userId]))[0];
    if (current === undefined) {
      return null;
    }
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
    patch.row_version = nextRowVersion(current.row_version);
    return base.update<PersonRow>(tx, PERSON.table, { userid: current.userid }, patch, ctx);
  }

  async function personTombstoneVersion(tx: TenantTx, userId: string): Promise<string | null> {
    return (await base.findByKey<PersonTombstoneRow>(tx, PERSON_TOMBSTONE.table, { userid: userId }))?.row_version ?? null;
  }

  function recordPersonTombstone(tx: TenantTx, userId: string, rowVersion: string, ctx: WriteContext = {}): Promise<PersonTombstoneRow> {
    return base.upsert<PersonTombstoneRow>(tx, PERSON_TOMBSTONE.table, { userid: userId, row_version: rowVersion }, ctx);
  }

  function listPersonsForSite(tx: TenantTx, siteId: string, opts: { userIds?: readonly string[] } = {}): Promise<PersonRow[]> {
    const only = opts.userIds === undefined ? null : [...opts.userIds];
    return readUnits<PersonRow>(tx, PERSON.unit, personsForSiteSql, [tx.tenantId, siteId, only]);
  }

  async function searchPersons(tx: TenantTx, search: PersonSearch): Promise<PersonRow[]> {
    // getSearch adds `and 0=1` for an empty search term.
    if (search.term === '') return [];
    const params = [
      tx.tenantId,
      search.siteId,
      `%${search.term}%`,
      [...(search.orUserIds ?? [])],
      search.restrictUserIds === undefined ? null : [...search.restrictUserIds],
      search.limit ?? null,
    ];
    return readUnits<PersonRow>(tx, PERSON.unit, searchPersonsSql, params);
  }

  function queryPersons(tx: TenantTx, query: PersonQuery): Promise<PersonRow[]> {
    const params: unknown[] = [tx.tenantId];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ['tenant_id = $1'];
    if (query.siteIds !== undefined) where.push(`siteid = ANY(${bind([...query.siteIds])}::text[])`);
    if (query.userIds !== undefined) where.push(`userid = ANY(${bind([...query.userIds])}::bpchar[])`);
    const conditions = (query.conditions ?? []).map((condition) => conditionSql(condition, bind));
    if (conditions.length > 0) where.push(`(${conditions.join(query.combine === 'or' ? ' OR ' : ' AND ')})`);
    const order = [...(query.orderBy ?? DEFAULT_PERSON_ORDER).map(orderSql), 'userid'].join(', ');
    const limit = query.limit === undefined ? '' : ` LIMIT ${bind(query.limit)}`;
    const sql = `SELECT * FROM ${person} WHERE ${where.join(' AND ')} ORDER BY ${order}${limit}`;
    return readUnits<PersonRow>(tx, PERSON.unit, sql, params);
  }

  function listAddresses(tx: TenantTx, userId: string): Promise<AddressRow[]> {
    return readUnits<AddressRow>(tx, ADDRESS.unit, addressesSql, [tx.tenantId, userId]);
  }

  function findAddress(tx: TenantTx, addressId: string): Promise<AddressRow | null> {
    return base.findByKey<AddressRow>(tx, ADDRESS.table, { addressid: addressId });
  }

  function insertAddress(tx: TenantTx, input: AddressInput, ctx: WriteContext = {}): Promise<AddressRow> {
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
    return base.insert<AddressRow>(tx, ADDRESS.table, row, ctx);
  }

  function updateAddress(tx: TenantTx, addressId: string, input: AddressUpdate, ctx: WriteContext = {}): Promise<AddressRow | null> {
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
    return base.update<AddressRow>(tx, ADDRESS.table, { addressid: addressId }, patch, ctx);
  }

  /** Deletes every extended value stored under `baseId`. */
  async function deleteExtendRows(tx: TenantTx, baseId: string, ctx: WriteContext): Promise<number> {
    const stale = await readUnits<{ dataid: number }>(tx, EXTEND_DATA.unit, lockExtendByBaseSql, [tx.tenantId, baseId]);
    return deleteKeys(tx, EXTEND_DATA.table, stale, ctx);
  }

  async function deleteAddress(tx: TenantTx, addressId: string, ctx: WriteContext = {}): Promise<boolean> {
    // Legacy also deletes tcontentratings rows of the address; that table belongs to strategies-content.
    const removed = await base.delete(tx, ADDRESS.table, { addressid: addressId }, ctx);
    await deleteExtendRows(tx, addressId, ctx);
    return removed !== null;
  }

  async function setPrimaryAddress(tx: TenantTx, userId: string, addressId: string, ctx: WriteContext = {}): Promise<void> {
    // Rows already at the target value are skipped, so no changelog row records a no-op update.
    const others = await readUnits<{ addressid: string }>(tx, ADDRESS.unit, lockOtherPrimariesSql, [tx.tenantId, userId, addressId]);
    for (const { addressid } of others) {
      await base.update(tx, ADDRESS.table, { addressid }, { isprimary: 0 }, ctx);
    }
    const target = (await select<{ isprimary: number | null }>(tx, lockAddressSql, [tx.tenantId, addressId]))[0];
    if (target !== undefined && target.isprimary !== 1) {
      await base.update(tx, ADDRESS.table, { addressid: addressId }, { isprimary: 1 }, ctx);
    }
  }

  async function replaceInterests(
    tx: TenantTx,
    userId: string,
    categoryIds: readonly string[],
    opts: { scopeCategoryIds?: readonly string[] } = {},
    ctx: WriteContext = {},
  ): Promise<InterestRow[]> {
    const scope = opts.scopeCategoryIds === undefined ? null : [...opts.scopeCategoryIds];
    const stale = await readUnits<{ categoryid: string }>(tx, INTEREST.unit, lockInterestsSql, [tx.tenantId, userId, scope]);
    await deleteKeys(tx, INTEREST.table, stale.map(({ categoryid }) => ({ userid: userId, categoryid })), ctx);
    // Legacy swallows each failed insert, so an id the key already holds, or one too long for char(35), is skipped.
    const held = new Set((await select<{ categoryid: string }>(tx, interestIdsSql, [tx.tenantId, userId])).map((row) => charKey(row.categoryid)));
    const inserted: InterestRow[] = [];
    for (const categoryId of categoryIds) {
      if (!storableId(categoryId) || held.has(charKey(categoryId))) continue;
      inserted.push(await base.insert<InterestRow>(tx, INTEREST.table, { userid: userId, categoryid: categoryId }, ctx));
      held.add(charKey(categoryId));
    }
    return inserted;
  }

  async function replaceTags(tx: TenantTx, input: TagReplacement, ctx: WriteContext = {}): Promise<TagRow[]> {
    const stale = await readUnits<{ tagid: number }>(tx, TAG.unit, lockTagsSql, [tx.tenantId, input.userId]);
    await deleteKeys(tx, TAG.table, stale, ctx);
    const created: TagRow[] = [];
    for (const item of (input.tags ?? '').split(',')) {
      const value = cfTrim(item);
      if (value === '') continue;
      // createTags binds siteID without the DAO NULL rule, so it is written as given.
      const row: Omit<TagRow, 'tenant_id'> = { tagid: await nextId(tx, TAG, 'tagid'), userid: input.userId, siteid: input.siteId, tag: value };
      created.push(await base.insert<TagRow>(tx, TAG.table, row, ctx));
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
    const inserted: ExtendDataRow[] = [];
    for (const { attributeId, row } of entries) {
      const stale = await readUnits<{ dataid: number }>(tx, EXTEND_DATA.unit, lockExtendByAttributeSql, [tx.tenantId, baseId, attributeId]);
      await deleteKeys(tx, EXTEND_DATA.table, stale, ctx);
      if (row === null) continue;
      const stored: Omit<ExtendDataRow, 'tenant_id'> = {
        ...row,
        dataid: await nextId(tx, EXTEND_DATA, 'dataid'),
        baseid: baseId,
        attributeid: attributeId,
      };
      inserted.push(await base.insert<ExtendDataRow>(tx, EXTEND_DATA.table, stored, ctx));
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
    if ((await base.findByKey(tx, TRASH.table, { objectid: row.objectid })) !== null) {
      return null;
    }
    return base.insert<TrashRow>(tx, TRASH.table, row, ctx);
  }

  async function findPersonArchive(tx: TenantTx, personId: string, effectiveFrom?: Date): Promise<PersonArchiveRow | null> {
    const rows = await readUnits<PersonArchiveRow>(tx, PERSON_ARCHIVE.unit, archiveSql, [tx.tenantId, personId, effectiveFrom ?? null]);
    return rows[0] ?? null;
  }

  async function insertPersonArchive(tx: TenantTx, row: PersonArchiveInput, ctx: WriteContext = {}): Promise<PersonArchiveRow> {
    // The fixture rejects any second archive of a person, serialising archives per person (UPDLOCK, HOLDLOCK); this lock does the same.
    await tx.query(ADVISORY_LOCK_SQL, [`${schema}.${PERSON_ARCHIVE.table}:${tx.tenantId}:${charKey(row.person_id)}`]);
    if ((await findPersonArchive(tx, row.person_id)) !== null) {
      throw new DuplicateArchiveError(row.person_id);
    }
    const stored: Omit<PersonArchiveRow, 'tenant_id'> = {
      ...row,
      archive_id: row.archive_id === undefined || row.archive_id === '' ? cfUuid() : row.archive_id,
      archived_at: row.archived_at ?? clock.now(),
    };
    try {
      return await base.insert<PersonArchiveRow>(tx, PERSON_ARCHIVE.table, stored, ctx);
    } catch (err) {
      // PostgreSQL has aborted the transaction, so the error must leave it.
      if (isUniqueViolation(err, ARCHIVE_UNIQUE_CONSTRAINT)) {
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

  function listStaleRosterOperations(tx: TenantTx, olderThan: Date): Promise<RosterOperationRow[]> {
    return select<RosterOperationRow>(tx, staleRosterSql, [tx.tenantId, [...RECOVERABLE_ROSTER_STATES], olderThan]);
  }

  function upsertGroupName(tx: TenantTx, row: GroupNameInput, ctx: WriteContext = {}): Promise<GroupNameRow> {
    return base.upsert<GroupNameRow>(tx, GROUP_NAME.table, row, ctx);
  }

  async function deleteGroupName(tx: TenantTx, groupId: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await base.delete(tx, GROUP_NAME.table, { group_id: groupId }, ctx)) !== null;
  }

  function listGroupNames(tx: TenantTx, groupIds?: readonly string[]): Promise<GroupNameRow[]> {
    return select<GroupNameRow>(tx, groupNamesSql, [tx.tenantId, groupIds === undefined ? null : [...groupIds]]);
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
    searchPersons,
    queryPersons,
    listAddresses,
    findAddress,
    insertAddress,
    updateAddress,
    deleteAddress,
    setPrimaryAddress,
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
    upsertGroupName,
    deleteGroupName,
    listGroupNames,
  });
}
