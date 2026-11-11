/** Owned tables of schema `people`, as the platform repository declares them. */
import type { CanonicalColumn, CanonicalType, TableDefinition } from '@opt2/platform/migration-kit';

/** Units of write authority of schema `people`, as and in the order `opt2/table-ownership.json` lists them. */
export const PEOPLE_UNITS = [
  'people.extend_attribute',
  'people.extend_data',
  'people.extend_data_user_activity',
  'people.extend_rc_set',
  'people.extend_set',
  'people.extend_subtype',
  'people.person',
  'people.person_archive',
  'people.trash',
  'people.user_address',
  'people.user_favorite',
  'people.user_interest',
  'people.user_tag',
] as const;

/** One people unit id. */
export type PeopleUnit = (typeof PEOPLE_UNITS)[number];

/** People tables without a unit: never migrated, projected or gated, but still written with changelog rows. */
export const NON_UNIT_TABLE_NAMES = ['roster_operation', 'group_name'] as const;

type NonUnitTableName = (typeof NON_UNIT_TABLE_NAMES)[number];
type TableOfUnit<U extends string> = U extends `people.${infer T}` ? T : never;

/** Name of one owned `people` table. */
export type PeopleTableName = TableOfUnit<PeopleUnit> | NonUnitTableName;

/** A people table definition whose table name is `T`. */
export interface PeopleTableDefinition<T extends PeopleTableName = PeopleTableName> extends TableDefinition {
  table: T;
}

/** A gated people table definition whose unit is `U`. */
export interface PeopleUnitTableDefinition<U extends PeopleUnit = PeopleUnit> extends PeopleTableDefinition<TableOfUnit<U>> {
  unit: U;
}

type Columns = readonly CanonicalColumn[];
type ColumnName<C extends Columns> = C[number]['name'];
type Key<C extends Columns> = readonly [ColumnName<C>, ...ColumnName<C>[]];

const UNIT_PREFIX = 'people.';
// The platform repository requires tenant_id among the declared columns and fills it from the transaction tenant.
const TENANT_ID = { name: 'tenant_id', type: 's' } as const satisfies CanonicalColumn;

function unitTable<U extends PeopleUnit, C extends Columns>(unit: U, columns: C, key: Key<C>): PeopleUnitTableDefinition<U> {
  return { table: unit.slice(UNIT_PREFIX.length) as TableOfUnit<U>, columns: [...columns], key: [...key], unit };
}

function nonUnitTable<T extends NonUnitTableName, C extends Columns>(table: T, columns: C, key: Key<C>): PeopleTableDefinition<T> {
  return { table, columns: [...columns], key: [...key] };
}

const PERSON_CATALOG = [
  TENANT_ID,
  { name: 'userid', type: 's' },
  { name: 'groupname', type: 's' },
  { name: 'fname', type: 's' },
  { name: 'lname', type: 's' },
  { name: 'email', type: 's' },
  { name: 'company', type: 's' },
  { name: 'jobtitle', type: 's' },
  { name: 'mobilephone', type: 's' },
  { name: 'website', type: 's' },
  { name: 'subtype', type: 's' },
  { name: 'ext', type: 'i' },
  { name: 'contactform', type: 's' },
  { name: 'lastupdate', type: 't' },
  { name: 'lastupdateby', type: 's' },
  { name: 'lastupdatebyid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'subscribe', type: 'i' },
  { name: 'notes', type: 's' },
  { name: 'description', type: 's' },
  { name: 'interests', type: 's' },
  { name: 'keepprivate', type: 'i' },
  { name: 'photofileid', type: 's' },
  { name: 'imname', type: 's' },
  { name: 'imservice', type: 's' },
  { name: 'created', type: 't' },
  { name: 'tags', type: 's' },
  { name: 'row_version', type: 'i' },
] as const satisfies Columns;

/** `people.person`: person columns of Masa `tusers` Type=2 rows, plus the target-only `row_version` of `people.person.changed.v1`. */
export const PERSON = unitTable('people.person', PERSON_CATALOG, ['userid']);

/** Column of `people.person`. */
export type PersonColumnName = ColumnName<typeof PERSON_CATALOG>;

/** The 24 person columns of `tusers` that people owns, in catalog order. */
export const PERSON_COLUMNS = [
  'groupname',
  'fname',
  'lname',
  'email',
  'company',
  'jobtitle',
  'mobilephone',
  'website',
  'subtype',
  'ext',
  'contactform',
  'lastupdate',
  'lastupdateby',
  'lastupdatebyid',
  'subscribe',
  'notes',
  'description',
  'interests',
  'keepprivate',
  'photofileid',
  'imname',
  'imservice',
  'created',
  'tags',
] as const satisfies readonly PersonColumnName[];

/** People columns `userDAO.create` inserts (core/mura/user/userDAO.cfc:300-347); legacy never writes `Ext`. */
export const PERSON_INSERT_COLUMNS = [
  'userid',
  'groupname',
  'fname',
  'lname',
  'email',
  'company',
  'jobtitle',
  'mobilephone',
  'website',
  'subtype',
  'contactform',
  'lastupdate',
  'lastupdateby',
  'lastupdatebyid',
  'siteid',
  'subscribe',
  'notes',
  'description',
  'interests',
  'keepprivate',
  'photofileid',
  'imname',
  'imservice',
  'created',
  'tags',
] as const satisfies readonly PersonColumnName[];

/** People columns `userDAO.update` sets (core/mura/user/userDAO.cfc:403-458); `Ext` and `created` stay untouched. */
export const PERSON_UPDATE_COLUMNS = [
  'groupname',
  'fname',
  'lname',
  'email',
  'company',
  'jobtitle',
  'mobilephone',
  'website',
  'subtype',
  'contactform',
  'lastupdate',
  'lastupdateby',
  'lastupdatebyid',
  'siteid',
  'subscribe',
  'notes',
  'description',
  'interests',
  'keepprivate',
  'photofileid',
  'imname',
  'imservice',
  'tags',
] as const satisfies readonly PersonColumnName[];

/** Target-only columns per table, which no legacy mapping carries. */
export const TARGET_ONLY_COLUMNS: Readonly<Partial<Record<PeopleTableName, readonly string[]>>> = { person: ['row_version'] };

const ADDRESS_CATALOG = [
  TENANT_ID,
  { name: 'addressid', type: 's' },
  { name: 'userid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'addressname', type: 's' },
  { name: 'address1', type: 's' },
  { name: 'address2', type: 's' },
  { name: 'city', type: 's' },
  { name: 'state', type: 's' },
  { name: 'zip', type: 's' },
  { name: 'country', type: 's' },
  { name: 'phone', type: 's' },
  { name: 'fax', type: 's' },
  { name: 'isprimary', type: 'i' },
  { name: 'addressnotes', type: 's' },
  { name: 'addressurl', type: 's' },
  { name: 'longitude', type: 'f' },
  { name: 'latitude', type: 'f' },
  { name: 'addressemail', type: 's' },
  { name: 'hours', type: 's' },
] as const satisfies Columns;

// The split child tables keep the shared legacy table's name and unit id (user_address, …) and hold only rows of Type=2
// owners; the constants keep the person-share names (ADDRESS, INTEREST, TAG, FAVORITE) their consumers import.
/** `people.user_address`: Masa `tuseraddresses` rows of users. */
export const ADDRESS = unitTable('people.user_address', ADDRESS_CATALOG, ['addressid']);

const INTEREST_CATALOG = [TENANT_ID, { name: 'userid', type: 's' }, { name: 'categoryid', type: 's' }] as const satisfies Columns;

/** `people.user_interest`: Masa `tusersinterests` rows of users. */
export const INTEREST = unitTable('people.user_interest', INTEREST_CATALOG, ['userid', 'categoryid']);

const TAG_CATALOG = [
  TENANT_ID,
  { name: 'tagid', type: 'i' },
  { name: 'userid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'tag', type: 's' },
] as const satisfies Columns;

/** `people.user_tag`: Masa `tuserstags` rows of users; new ids from `people.user_tag_tagid_seq`. */
export const TAG = unitTable('people.user_tag', TAG_CATALOG, ['tagid']);

const FAVORITE_CATALOG = [
  TENANT_ID,
  { name: 'favoriteid', type: 's' },
  { name: 'userid', type: 's' },
  { name: 'favoritename', type: 's' },
  { name: 'favorite', type: 's' },
  { name: 'type', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'datecreated', type: 't' },
  { name: 'columnnumber', type: 'i' },
  { name: 'rownumber', type: 'i' },
  { name: 'maxrssitems', type: 'i' },
] as const satisfies Columns;

/** `people.user_favorite`: Masa `tusersfavorites` rows of users. */
export const FAVORITE = unitTable('people.user_favorite', FAVORITE_CATALOG, ['favoriteid']);

const EXTEND_DATA_CATALOG = [
  TENANT_ID,
  { name: 'dataid', type: 'i' },
  { name: 'baseid', type: 's' },
  { name: 'attributeid', type: 'i' },
  { name: 'siteid', type: 's' },
  { name: 'attributevalue', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'datetimevalue', type: 't' },
  { name: 'numericvalue', type: 'f' },
  { name: 'stringvalue', type: 's' },
] as const satisfies Columns;

// Masa saves user and address extended data to tclassextenddatauseractivity, so EXTEND_DATA is that table;
// the table named people.extend_data holds tclassextenddata rows and is CLASS_EXTEND_DATA.
/** `people.extend_data_user_activity`: rows of users and addresses; new ids from `people.extend_data_user_activity_dataid_seq`. */
export const EXTEND_DATA = unitTable('people.extend_data_user_activity', EXTEND_DATA_CATALOG, ['dataid']);

const CLASS_EXTEND_DATA_CATALOG = [
  TENANT_ID,
  { name: 'dataid', type: 'i' },
  { name: 'baseid', type: 's' },
  { name: 'attributeid', type: 'i' },
  { name: 'siteid', type: 's' },
  { name: 'attributevalue', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'datetimevalue', type: 't' },
  { name: 'numericvalue', type: 'f' },
  { name: 'stringvalue', type: 's' },
] as const satisfies Columns;

/** `people.extend_data`: Masa `tclassextenddata` rows of `tusers` subtypes. */
export const CLASS_EXTEND_DATA = unitTable('people.extend_data', CLASS_EXTEND_DATA_CATALOG, ['dataid']);

const TRASH_CATALOG = [
  TENANT_ID,
  { name: 'objectid', type: 's' },
  { name: 'parentid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'objectlabel', type: 's' },
  { name: 'objectclass', type: 's' },
  { name: 'objecttype', type: 's' },
  { name: 'objectsubtype', type: 's' },
  { name: 'objectstring', type: 's' },
  { name: 'deleteddate', type: 't' },
  { name: 'deletedby', type: 's' },
  { name: 'deleteid', type: 's' },
  { name: 'orderno', type: 'i' },
] as const satisfies Columns;

/** `people.trash`: Masa `ttrash` rows of the people objectClass share; `objectstring` is byte-exact WDDX. */
export const TRASH = unitTable('people.trash', TRASH_CATALOG, ['objectid']);

const EXTEND_SUBTYPE_CATALOG = [
  TENANT_ID,
  { name: 'subtypeid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'basetable', type: 's' },
  { name: 'basekeyfield', type: 's' },
  { name: 'datatable', type: 's' },
  { name: 'type', type: 's' },
  { name: 'subtype', type: 's' },
  { name: 'isactive', type: 'i' },
  { name: 'notes', type: 's' },
  { name: 'lastupdate', type: 't' },
  { name: 'datecreated', type: 't' },
  { name: 'lastupdateby', type: 's' },
  { name: 'hassummary', type: 'i' },
  { name: 'hasbody', type: 'i' },
  { name: 'description', type: 's' },
  { name: 'availablesubtypes', type: 's' },
  { name: 'iconclass', type: 's' },
  { name: 'hasassocfile', type: 'i' },
  { name: 'hasconfigurator', type: 'i' },
  { name: 'adminonly', type: 'i' },
] as const satisfies Columns;

/** `people.extend_subtype`: Masa `tclassextend` subtypes of baseTable `tusers` (types 1, 2, User, Group, Address). */
export const EXTEND_SUBTYPE = unitTable('people.extend_subtype', EXTEND_SUBTYPE_CATALOG, ['subtypeid']);

const EXTEND_SET_CATALOG = [
  TENANT_ID,
  { name: 'extendsetid', type: 's' },
  { name: 'subtypeid', type: 's' },
  { name: 'categoryid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'name', type: 's' },
  { name: 'orderno', type: 'i' },
  { name: 'isactive', type: 'i' },
  { name: 'container', type: 's' },
] as const satisfies Columns;

/** `people.extend_set`: Masa `tclassextendsets` rows of `tusers` subtypes. */
export const EXTEND_SET = unitTable('people.extend_set', EXTEND_SET_CATALOG, ['extendsetid']);

const EXTEND_ATTRIBUTE_CATALOG = [
  TENANT_ID,
  { name: 'attributeid', type: 'i' },
  { name: 'extendsetid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'name', type: 's' },
  { name: 'label', type: 's' },
  { name: 'hint', type: 's' },
  { name: 'type', type: 's' },
  { name: 'orderno', type: 'i' },
  { name: 'isactive', type: 'i' },
  { name: 'required', type: 's' },
  { name: 'validation', type: 's' },
  { name: 'regex', type: 's' },
  { name: 'message', type: 's' },
  { name: 'defaultvalue', type: 's' },
  { name: 'optionlist', type: 's' },
  { name: 'optionlabellist', type: 's' },
  { name: 'adminonly', type: 'i' },
] as const satisfies Columns;

/** `people.extend_attribute`: Masa `tclassextendattributes` rows of `tusers` subtype sets. */
export const EXTEND_ATTRIBUTE = unitTable('people.extend_attribute', EXTEND_ATTRIBUTE_CATALOG, ['attributeid']);

const EXTEND_RCSET_CATALOG = [
  TENANT_ID,
  { name: 'subtypeid', type: 's' },
  { name: 'availablesubtypes', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'entitytype', type: 's' },
  { name: 'name', type: 's' },
  { name: 'orderno', type: 'i' },
  { name: 'relatedcontentsetid', type: 's' },
] as const satisfies Columns;

/** `people.extend_rc_set`: Masa `tclassextendrcsets` rows of `tusers` subtypes. */
export const EXTEND_RCSET = unitTable('people.extend_rc_set', EXTEND_RCSET_CATALOG, ['relatedcontentsetid']);

const PERSON_ARCHIVE_CATALOG = [
  TENANT_ID,
  { name: 'archive_id', type: 's' },
  { name: 'person_id', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'effective_from', type: 't' },
  { name: 'archived_at', type: 't' },
  { name: 'archived_by_id', type: 's' },
  { name: 'archived_by', type: 's' },
] as const satisfies Columns;

/** `people.person_archive`: the archive record, from fixture `synthetic.person_archive`; unique on `(person_id, effective_from)`. */
export const PERSON_ARCHIVE = unitTable('people.person_archive', PERSON_ARCHIVE_CATALOG, ['archive_id']);

const ROSTER_OPERATION_CATALOG = [
  TENANT_ID,
  { name: 'operation_id', type: 's' },
  { name: 'kind', type: 's' },
  { name: 'user_id', type: 's' },
  { name: 'payload', type: 's' },
  { name: 'before_image', type: 's' },
  { name: 'identity_xid', type: 's' },
  { name: 'state', type: 's' },
  { name: 'error', type: 's' },
  { name: 'started_at', type: 't' },
  { name: 'updated_at', type: 't' },
  { name: 'identity_unreachable_since', type: 't' },
] as const satisfies Columns;

/** `people.roster_operation`: durable intent of a roster write operation. */
export const ROSTER_OPERATION = nonUnitTable('roster_operation', ROSTER_OPERATION_CATALOG, ['operation_id']);

const GROUP_NAME_CATALOG = [
  TENANT_ID,
  { name: 'group_id', type: 's' },
  { name: 'site_id', type: 's' },
  { name: 'group_name', type: 's' },
  { name: 'is_public', type: 'i' },
  { name: 'deleted', type: 'i' },
  { name: 'aggregate_version', type: 'i' },
] as const satisfies Columns;

/** `people.group_name`: the projection of `identity.group.changed.v1`. */
export const GROUP_NAME = nonUnitTable('group_name', GROUP_NAME_CATALOG, ['group_id']);

/** Table definitions position for position with the unit tuple `T`. */
type TablesForUnits<T extends readonly PeopleUnit[]> = { readonly [I in keyof T]: PeopleUnitTableDefinition<T[I] & PeopleUnit> };

/** Every unit table, in `PEOPLE_UNITS` order. */
export const UNIT_TABLES: TablesForUnits<typeof PEOPLE_UNITS> = [
  EXTEND_ATTRIBUTE,
  CLASS_EXTEND_DATA,
  EXTEND_DATA,
  EXTEND_RCSET,
  EXTEND_SET,
  EXTEND_SUBTYPE,
  PERSON,
  PERSON_ARCHIVE,
  TRASH,
  ADDRESS,
  FAVORITE,
  INTEREST,
  TAG,
];

/** Every owned table in migration order; the `tables` of the people repository. */
export const OWNED_TABLES: readonly PeopleTableDefinition[] = [
  PERSON,
  ADDRESS,
  INTEREST,
  TAG,
  FAVORITE,
  EXTEND_DATA,
  CLASS_EXTEND_DATA,
  TRASH,
  EXTEND_SUBTYPE,
  EXTEND_SET,
  EXTEND_ATTRIBUTE,
  EXTEND_RCSET,
  PERSON_ARCHIVE,
  ROSTER_OPERATION,
  GROUP_NAME,
];

/** `roster_operation.state`, as its CHECK constraint lists them. */
export const ROSTER_STATES = ['started', 'people-committed', 'done', 'rolled-back', 'halted'] as const;
/** One roster operation state. */
export type RosterState = (typeof ROSTER_STATES)[number];
/** States that keep the user closed: the predicate of the partial unique index on `roster_operation.user_id`. */
export const OPEN_ROSTER_STATES = ['started', 'people-committed', 'halted'] as const satisfies readonly RosterState[];
/** Open states the outbox-sweep recovery resolves; `halted` waits for an operator. */
export const RECOVERABLE_ROSTER_STATES = ['started', 'people-committed'] as const satisfies readonly RosterState[];

// Row shapes are type aliases, not interfaces, so they stay assignable to the repository's Record<string, unknown> rows.

/** pg value of a canonical tag; int8 and boolean columns are overridden per table. */
type ColumnValue<T extends CanonicalType> = T extends 's' | 'd' ? string : T extends 'i' | 'f' ? number : T extends 't' ? Date : Buffer;

/** A row of columns `C` as pg returns it; `NotNull` columns are never null. */
type RowOf<C extends Columns, NotNull extends ColumnName<C>> = {
  [K in C[number] as K['name']]: ColumnValue<K['type']> | (K['name'] extends NotNull ? never : null);
};

/** Row `R` with the value types `O` names replaced, keeping each column's nullability. */
type Override<R, O extends Partial<Record<keyof R, unknown>>> = {
  [K in keyof R]: K extends keyof O ? O[K] | (null extends R[K] ? null : never) : R[K];
};

/** A `person` row; the int8 `row_version` arrives as a decimal string. */
export type PersonRow = Override<RowOf<typeof PERSON_CATALOG, 'tenant_id' | 'userid' | 'row_version'>, { row_version: string }>;
/** A `user_address` row of a user. */
export type AddressRow = RowOf<typeof ADDRESS_CATALOG, 'tenant_id' | 'addressid'>;
/** A `user_interest` row of a user. */
export type InterestRow = RowOf<typeof INTEREST_CATALOG, 'tenant_id' | 'userid' | 'categoryid'>;
/** A `user_tag` row of a user. */
export type TagRow = RowOf<typeof TAG_CATALOG, 'tenant_id' | 'tagid'>;
/** A `user_favorite` row of a user. */
export type FavoriteRow = RowOf<typeof FAVORITE_CATALOG, 'tenant_id' | 'favoriteid' | 'userid' | 'favorite' | 'type' | 'datecreated'>;
/** An `extend_data_user_activity` row of a user or address. */
export type ExtendDataRow = RowOf<typeof EXTEND_DATA_CATALOG, 'tenant_id' | 'dataid' | 'baseid' | 'attributeid'>;
/** An `extend_data` row. */
export type ClassExtendDataRow = RowOf<typeof CLASS_EXTEND_DATA_CATALOG, 'tenant_id' | 'dataid' | 'baseid' | 'attributeid'>;
/** A `trash` row of the people share. */
export type TrashRow = RowOf<
  typeof TRASH_CATALOG,
  'tenant_id' | 'objectid' | 'parentid' | 'siteid' | 'objectlabel' | 'objectclass' | 'objecttype' | 'objectsubtype' | 'deletedby'
>;
/** An `extend_subtype` row. */
export type ExtendSubtypeRow = RowOf<typeof EXTEND_SUBTYPE_CATALOG, 'tenant_id' | 'subtypeid'>;
/** An `extend_set` row. */
export type ExtendSetRow = RowOf<typeof EXTEND_SET_CATALOG, 'tenant_id' | 'extendsetid'>;
/** An `extend_attribute` row. */
export type ExtendAttributeRow = RowOf<typeof EXTEND_ATTRIBUTE_CATALOG, 'tenant_id' | 'attributeid'>;
/** An `extend_rc_set` row. */
export type ExtendRcsetRow = RowOf<typeof EXTEND_RCSET_CATALOG, 'tenant_id' | 'name' | 'relatedcontentsetid'>;
/** A `person_archive` row. */
export type PersonArchiveRow = RowOf<
  typeof PERSON_ARCHIVE_CATALOG,
  'tenant_id' | 'archive_id' | 'person_id' | 'siteid' | 'effective_from' | 'archived_at'
>;
// `kind` has no CHECK constraint; its vocabulary belongs to the roster protocol, so it stays a string here.
/** A `roster_operation` row; `payload` and `before_image` are JSON text, `identity_xid` identity's xid8 decimal text. */
export type RosterOperationRow = Override<
  RowOf<typeof ROSTER_OPERATION_CATALOG, 'tenant_id' | 'operation_id' | 'kind' | 'user_id' | 'payload' | 'state' | 'started_at' | 'updated_at'>,
  { state: RosterState }
>;
/** A `group_name` row; pg returns `deleted` as a boolean and the int8 `aggregate_version` as a decimal string. */
export type GroupNameRow = Override<
  RowOf<typeof GROUP_NAME_CATALOG, 'tenant_id' | 'group_id' | 'deleted' | 'aggregate_version'>,
  { deleted: boolean; aggregate_version: string }
>;
