// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Owned tables of schema `finance`, one per fixture table `Program_<id>.finance_*` and one per split Masa share, as the platform repository declares them. */
import type { CanonicalColumn, RepositoryRow, TableDefinition } from '@opt2/platform/migration-kit';
import { objectKey, type BucketName } from '@opt2/platform/storage';

/** Service name carried by finance write positions. */
export const OWNER = 'finance';

/** PostgreSQL schema owned by the finance service. */
export const SCHEMA = 'finance';

/** Bucket holding the bytes of finance attachments. */
export const ATTACHMENT_BUCKET = 'finance-attachments' satisfies BucketName;

/** Units of write authority of schema `finance`, as `opt2/table-ownership.json` names them, in declaration order. */
export const UNITS = Object.freeze([
  'finance.record',
  'finance.record_version',
  'finance.attachment',
  'finance.rollup',
  'finance.extend_subtype',
  'finance.extend_set',
  'finance.extend_attribute',
  'finance.extend_rc_set',
  'finance.extend_data',
  'finance.trash',
] as const);

/** One finance unit id. */
export type FinanceUnit = (typeof UNITS)[number];

/** A gated finance table definition: always keyed, and its unit is `U`. */
export interface FinanceTableDefinition<U extends FinanceUnit = FinanceUnit> extends TableDefinition {
  key: string[];
  unit: U;
}

const TENANT_ID: CanonicalColumn = { name: 'tenant_id', type: 's' };
const MONEY = { type: 'd', scale: 4 } as const;
const LEGACY_PROGRAM_ID: CanonicalColumn = { name: 'legacy_program_id', type: 'i' };
const ROW_VERSION: CanonicalColumn = { name: 'row_version', type: 'i' };

/** Deep-freezes `def` so no consumer can change the shared catalogue. */
function frozen<T extends TableDefinition & { key: string[] }>(def: T): Readonly<T> {
  def.columns.forEach((column) => Object.freeze(column));
  Object.freeze(def.columns);
  Object.freeze(def.key);
  return Object.freeze(def);
}

/** `finance.record`, from `Program_<id>.finance_record`, plus the fold's `legacy_program_id` and the target-only `row_version`. */
export const FINANCE_RECORD = frozen<FinanceTableDefinition<'finance.record'>>({
  table: 'record',
  columns: [
    TENANT_ID,
    { name: 'record_id', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'title', type: 's' },
    { name: 'amount', ...MONEY },
    { name: 'period', type: 's' },
    { name: 'state', type: 's' },
    { name: 'version', type: 'i' },
    { name: 'created', type: 't' },
    { name: 'createdbyid', type: 's' },
    { name: 'lastupdate', type: 't' },
    { name: 'lastupdatebyid', type: 's' },
    LEGACY_PROGRAM_ID,
    ROW_VERSION,
  ],
  key: ['record_id'],
  unit: 'finance.record',
});

/** `finance.record_version`, from `Program_<id>.finance_record_version`; one row per create, edit and transition. */
export const FINANCE_RECORD_VERSION = frozen<FinanceTableDefinition<'finance.record_version'>>({
  table: 'record_version',
  columns: [
    TENANT_ID,
    { name: 'version_id', type: 's' },
    { name: 'record_id', type: 's' },
    { name: 'version', type: 'i' },
    { name: 'state', type: 's' },
    { name: 'title', type: 's' },
    { name: 'amount', ...MONEY },
    { name: 'period', type: 's' },
    { name: 'action', type: 's' },
    { name: 'actor_user_id', type: 's' },
    { name: 'created', type: 't' },
    LEGACY_PROGRAM_ID,
    ROW_VERSION,
  ],
  key: ['version_id'],
  unit: 'finance.record_version',
});

/** `finance.attachment`, from `Program_<id>.finance_attachment`; the legacy `content` bytes live in the object named by `object_key`. */
export const FINANCE_ATTACHMENT = frozen<FinanceTableDefinition<'finance.attachment'>>({
  table: 'attachment',
  columns: [
    TENANT_ID,
    { name: 'attachment_id', type: 's' },
    { name: 'record_id', type: 's' },
    { name: 'file_name', type: 's' },
    { name: 'content_type', type: 's' },
    { name: 'size_bytes', type: 'i' },
    { name: 'sha256', type: 's' },
    { name: 'object_key', type: 's' },
    { name: 'created', type: 't' },
    { name: 'createdbyid', type: 's' },
    LEGACY_PROGRAM_ID,
    ROW_VERSION,
  ],
  key: ['attachment_id'],
  unit: 'finance.attachment',
});

/** `finance.rollup`, from `Program_<id>.finance_rollup`: record count and total amount per program, period and state. */
export const FINANCE_ROLLUP = frozen<FinanceTableDefinition<'finance.rollup'>>({
  table: 'rollup',
  columns: [
    TENANT_ID,
    { name: 'period', type: 's' },
    { name: 'state', type: 's' },
    { name: 'record_count', type: 'i' },
    { name: 'total_amount', ...MONEY },
    { name: 'computed_at', type: 't' },
    LEGACY_PROGRAM_ID,
    ROW_VERSION,
  ],
  // The target key is the migration's primary key, which adds legacy_program_id to the fixture's (period, state).
  key: ['legacy_program_id', 'period', 'state'],
  unit: 'finance.rollup',
});

// The Masa dbo shares below are not folded: they carry no legacy_program_id and take their tenant from siteID.

/** `finance.extend_subtype`, the Masa `tclassextend` rows whose `baseTable` is a finance table. */
export const EXTEND_SUBTYPE = frozen<FinanceTableDefinition<'finance.extend_subtype'>>({
  table: 'extend_subtype',
  columns: [
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
  ],
  key: ['subtypeid'],
  unit: 'finance.extend_subtype',
});

/** `finance.extend_set`, the Masa `tclassextendsets` rows of finance subtypes. */
export const EXTEND_SET = frozen<FinanceTableDefinition<'finance.extend_set'>>({
  table: 'extend_set',
  columns: [
    TENANT_ID,
    { name: 'extendsetid', type: 's' },
    { name: 'subtypeid', type: 's' },
    { name: 'categoryid', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'name', type: 's' },
    { name: 'orderno', type: 'i' },
    { name: 'isactive', type: 'i' },
    { name: 'container', type: 's' },
  ],
  key: ['extendsetid'],
  unit: 'finance.extend_set',
});

/** `finance.extend_attribute`, the Masa `tclassextendattributes` rows of finance extend sets. */
export const EXTEND_ATTRIBUTE = frozen<FinanceTableDefinition<'finance.extend_attribute'>>({
  table: 'extend_attribute',
  columns: [
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
  ],
  key: ['attributeid'],
  unit: 'finance.extend_attribute',
});

/** `finance.extend_rc_set`, the Masa `tclassextendrcsets` rows of finance subtypes. */
export const EXTEND_RC_SET = frozen<FinanceTableDefinition<'finance.extend_rc_set'>>({
  table: 'extend_rc_set',
  columns: [
    TENANT_ID,
    { name: 'subtypeid', type: 's' },
    { name: 'availablesubtypes', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'entitytype', type: 's' },
    { name: 'name', type: 's' },
    { name: 'orderno', type: 'i' },
    { name: 'relatedcontentsetid', type: 's' },
  ],
  key: ['relatedcontentsetid'],
  unit: 'finance.extend_rc_set',
});

/** `finance.extend_data`, the Masa `tclassextenddata` rows of finance attributes. */
export const EXTEND_DATA = frozen<FinanceTableDefinition<'finance.extend_data'>>({
  table: 'extend_data',
  columns: [
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
  ],
  key: ['dataid'],
  unit: 'finance.extend_data',
});

/** `finance.trash`, the Masa `ttrash` rows whose class-map owner is finance; `objectstring` is byte-exact WDDX. */
export const TRASH = frozen<FinanceTableDefinition<'finance.trash'>>({
  table: 'trash',
  columns: [
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
  ],
  key: ['objectid'],
  unit: 'finance.trash',
});

/** `finance.program_binding`, the `Program_<id>` schema a tenant's rows were folded from, one per tenant. */
export const PROGRAM_BINDING = frozen<TableDefinition & { key: string[] }>({
  table: 'program_binding',
  columns: [
    TENANT_ID,
    { name: 'site_id', type: 's' },
    LEGACY_PROGRAM_ID,
    { name: 'updated_at', type: 't' },
  ],
  key: ['legacy_program_id'],
});

/** `finance.staged_object`, the ledger of attachment objects an uncommitted apply stored or a committed one replaced, until collected. */
export const STAGED_OBJECT = frozen<TableDefinition & { key: string[] }>({
  table: 'staged_object',
  columns: [
    TENANT_ID,
    { name: 'object_key', type: 's' },
    { name: 'attachment_id', type: 's' },
    { name: 'state', type: 's' },
    { name: 'recorded_at', type: 't' },
  ],
  key: ['object_key'],
});

/** Table definitions position for position with the unit tuple `T`. */
type TablesForUnits<T extends readonly FinanceUnit[]> = { readonly [I in keyof T]: FinanceTableDefinition<T[I]> };

/** Every owned unit table, in `UNITS` order; the `tables` of the finance repository. */
export const OWNED_TABLES: TablesForUnits<typeof UNITS> = Object.freeze([
  FINANCE_RECORD,
  FINANCE_RECORD_VERSION,
  FINANCE_ATTACHMENT,
  FINANCE_ROLLUP,
  EXTEND_SUBTYPE,
  EXTEND_SET,
  EXTEND_ATTRIBUTE,
  EXTEND_RC_SET,
  EXTEND_DATA,
  TRASH,
] as const);

/** Finance tables without a unit: never migrated, projected or gated, but still written with changelog rows. */
export const NON_UNIT_TABLES = Object.freeze([PROGRAM_BINDING, STAGED_OBJECT] as const);

// Row shapes are type aliases, not interfaces, so they stay assignable to the repository's Record<string, unknown> rows.

/** Any owned row as pg returns it, keyed by column name. */
export type FinanceRow = Readonly<RepositoryRow>;

/** A `finance.record` row as pg returns it; money is four-decimal text and the int8 `row_version` a decimal string. */
export type FinanceRecordRow = {
  tenant_id: string;
  record_id: string;
  siteid: string;
  title: string;
  amount: string;
  period: string;
  state: string;
  version: number;
  created: Date;
  createdbyid: string;
  lastupdate: Date | null;
  lastupdatebyid: string | null;
  legacy_program_id: number;
  row_version: string;
};

/** A `finance.record_version` row as pg returns it. */
export type FinanceRecordVersionRow = {
  tenant_id: string;
  version_id: string;
  record_id: string;
  version: number;
  state: string;
  title: string;
  amount: string;
  period: string;
  action: string;
  actor_user_id: string;
  created: Date;
  legacy_program_id: number;
  row_version: string;
};

/** A `finance.attachment` row as pg returns it; `sha256` is lowercase hex of the stored object's bytes. */
export type FinanceAttachmentRow = {
  tenant_id: string;
  attachment_id: string;
  record_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  object_key: string;
  created: Date;
  createdbyid: string;
  legacy_program_id: number;
  row_version: string;
};

/** A `finance.rollup` row as pg returns it. */
export type FinanceRollupRow = {
  tenant_id: string;
  period: string;
  state: string;
  record_count: number;
  total_amount: string;
  computed_at: Date;
  legacy_program_id: number;
  row_version: string;
};

/** A `finance.program_binding` row as pg returns it. */
export type ProgramBindingRow = {
  tenant_id: string;
  site_id: string;
  legacy_program_id: number;
  updated_at: Date;
};

/** A `finance.staged_object` row as pg returns it: `staged` while its apply is open or after it rolled back, `superseded` once replaced. */
export type StagedObjectRow = {
  tenant_id: string;
  object_key: string;
  attachment_id: string;
  state: 'staged' | 'superseded';
  recorded_at: Date;
};

/** Transient apply-row field carrying the legacy `varbinary(max)` attachment bytes. */
export const ATTACHMENT_CONTENT_FIELD = 'content';

// A mapped legacy row has no tenant, object key or row version yet: the repository supplies them when it stores the bytes.
/** An attachment row as a migration apply delivers it, with the legacy bytes under `content`. */
export type FinanceAttachmentApplyRow = Omit<FinanceAttachmentRow, 'tenant_id' | 'object_key' | 'row_version'> &
  Partial<Pick<FinanceAttachmentRow, 'tenant_id' | 'object_key' | 'row_version'>> & { [ATTACHMENT_CONTENT_FIELD]?: Buffer };

const OBJECT_EXTENSION = /^[a-z0-9]+$/;
const FALLBACK_EXTENSION = 'bin';

/**
 * `finance-attachments` key `<tenantId>/<id>.<ext>` for an attachment id or an object version id, `ext` being the lower-cased text after
 * the last `.` of `fileName`, or `bin` when there is none or it holds characters outside `[a-z0-9]`; throws when `id` is not a CF UUID.
 */
export function attachmentObjectKey(tenantId: string, id: string, fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
  return objectKey({ tenantId, id, ext: OBJECT_EXTENSION.test(ext) ? ext : FALLBACK_EXTENSION });
}
