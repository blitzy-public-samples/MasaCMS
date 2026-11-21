// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The communications mappings against table ownership and the target DDL: exact column coverage, keys, tenant sources, baseTable splits, byte-exact round trips and split applies. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeRow,
  diffCoverage,
  encodeRow,
  mappingCoverage,
  resolveTenant,
  type ApplyRequest,
  type ApplyResponse,
  type Mapping,
  type TenantLookups,
  type TenantSource,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_UMBRELLA } from '@opt2/platform/testing';
import {
  MAPPINGS,
  deliveryStatusMapping,
  emailMapping,
  emailReturnStatMapping,
  emailStatMapping,
  extendAttributeMapping,
  extendDataMapping,
  extendRcSetMapping,
  extendSetMapping,
  extendSubtypeMapping,
  mailingListMapping,
  mailingListMemberMapping,
  messageMapping,
  messageTemplateMapping,
  trashMapping,
} from '../../src/migration/mappings/index.js';
import {
  DELIVERY_STATUS,
  EMAIL,
  EMAIL_RETURN_STAT,
  EMAIL_STAT,
  EXTEND_ATTRIBUTE,
  EXTEND_DATA,
  EXTEND_RC_SET,
  EXTEND_SET,
  EXTEND_SUBTYPE,
  MAILING_LIST,
  MAILING_LIST_MEMBER,
  MESSAGE,
  MESSAGE_TEMPLATE,
  SCHEDULED_TASK,
  TRASH,
  UNITS,
  type CommunicationsTableDefinition,
} from '../../src/repo/tables.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';

const OWNER = 'communications';

interface OwnershipTarget {
  unit: string;
  rowPredicate: string | null;
  keyColumns: string[];
  columnPolicy: 'whole-table' | 'explicit';
  ownedColumns: string[];
}

interface OwnershipTable {
  table: string;
  columns: string[];
  siteIdColumn: string | null;
  rowIdentity: 'key' | 'multiset';
  tenantResolution: string | null;
  tenantParent?: { table: string; join: string };
  split?: { by: string };
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string; legacyTables: string[] }[];
  tables: OwnershipTable[];
}

interface OwnedTarget {
  table: OwnershipTable;
  target: OwnershipTarget;
}

type LegacyRow = Readonly<Record<string, unknown>>;

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const OWNERSHIP = JSON.parse(read('../../../../opt2/table-ownership.json')) as Ownership;
const TARGET_DDL = ['0002_communications.sql', '0003_extensions.sql'].map((file) => read(`../../db/migrations/${file}`)).join('\n');
const OWNED_UNITS = OWNERSHIP.units.filter((unit) => unit.owner === OWNER);
const OWNED_TARGETS: readonly OwnedTarget[] = OWNERSHIP.tables.flatMap((table) =>
  (table.targets ?? []).filter((target) => target.unit.startsWith(`${OWNER}.`)).map((target) => ({ table, target })),
);

/** Legacy columns a target owns; a whole-table target owns every column ownership records for the table. */
const ownedColumns = ({ table, target }: OwnedTarget): string[] => (target.columnPolicy === 'whole-table' ? table.columns : target.ownedColumns);

/** Base tables a `baseTable in (...)` row predicate lists, in its order; empty for any other predicate. */
function baseTablesOf(predicate: string | null): string[] {
  const listed = /^baseTable in \((.+)\)$/.exec(predicate ?? '')?.[1];
  return listed === undefined ? [] : listed.split(',').map((item) => item.trim().replace(/^'(.*)'$/, '$1'));
}

/** Owner a `classMap owner = <owner>` row predicate names; empty for any other predicate. */
function classOwnersOf(predicate: string | null): string[] {
  const owner = /^classMap owner = (\S+)$/.exec(predicate ?? '')?.[1];
  return owner === undefined ? [] : [owner];
}

/** `mappingCoverage` key of a target's legacy table: suffixed with the base tables or the class-map owner its row predicate names. */
function coverageKey({ table, target }: OwnedTarget): string {
  if (table.split === undefined) return table.table;
  const values = table.split.by === 'baseTable' ? baseTablesOf(target.rowPredicate) : classOwnersOf(target.rowPredicate);
  return `${table.table}{${table.split.by}=${values.join(',')}}`;
}

/** Tenant source named by a table's `tenantResolution`, `siteIdColumn` and `tenantParent.join`. */
function expectedTenant(table: OwnershipTable): TenantSource {
  if (table.tenantResolution === 'siteID' || table.tenantResolution === 'siteID-or-umbrella') {
    return { kind: 'site', column: table.siteIdColumn ?? '' };
  }
  const [child = '', parent = ''] = (table.tenantParent?.join ?? '').split(' = ').map((side) => side.slice(side.lastIndexOf('.') + 1));
  return { kind: 'parent', parentLegacyTable: table.tenantParent?.table ?? '', columns: { [child]: parent } };
}

/** Columns of the primary key of `communications.<table>` in the target DDL. */
function primaryKeyOf(table: string): string | undefined {
  const start = TARGET_DDL.indexOf(`CREATE TABLE communications.${table} (`);
  return start < 0 ? undefined : /PRIMARY KEY \(([^)]+)\)/.exec(TARGET_DDL.slice(start))?.[1];
}

/** A CF-format 35-character id ending in the two digits of `n`. */
const cfId = (n: number): string => `A1B2C3D4-E5F6-7890-ABCDEF12345678${String(n).padStart(2, '0')}`;

const MESSAGE_ID = cfId(1);
const EMAIL_ID = cfId(2);
const MLID = 'ML-0001'.padEnd(35);

const TEMPLATE_ROW: LegacyRow = {
  template_id: cfId(10),
  siteID: TENANT_A.siteId,
  name: 'Welcome',
  subject: 'Re: welcome\u0007',
  body_text: '',
  body_html: '<p>Hi</p>\r\n',
  created: '2026-06-30T09:15:00.997',
  lastUpdate: null,
};
const MESSAGE_ROW: LegacyRow = {
  message_id: MESSAGE_ID,
  siteID: TENANT_A.siteId,
  template_id: cfId(10),
  to_address: 'member@example.com',
  from_address: 'noreply@example.com',
  subject: 'Your code: 42\t',
  body_text: 'line one\nline two',
  body_html: '',
  state: 'sent',
  created: '2026-06-30T09:15:01.003',
  sent_at: '2026-06-30T09:15:02.007',
};
const STATUS_ROW: LegacyRow = {
  status_id: cfId(3),
  message_id: MESSAGE_ID,
  status: 'delivered',
  detail: null,
  mailpit_id: 'mp:Xy9\u0001',
  recorded_at: '2026-06-30T09:15:03.123',
};
const EMAIL_ROW: LegacyRow = {
  EmailID: EMAIL_ID,
  siteid: TENANT_A.siteId,
  Subject: 'News: June\u001f',
  BodyText: '',
  BodyHtml: null,
  CreatedDate: '2026-06-01T08:00:00.000',
  DeliveryDate: null,
  status: '1',
  GroupList: 'G1,G2',
  LastUpdateBy: 'admin',
  LastUpdateByID: cfId(4),
  NumberSent: '0',
  ReplyTo: null,
  format: 'HTML',
  fromLabel: 'Masa',
  isDeleted: '0',
  template: 'default.cfm',
};
const EMAIL_STAT_ROW: LegacyRow = {
  EmailID: EMAIL_ID,
  Email: 'member@example.com',
  emailOpen: '1',
  returnClick: '0',
  bounce: '0',
  sent: '1',
  Created: '2026-06-02T10:30:45.997',
};
const RETURN_STAT_ROW: LegacyRow = {
  emailID: EMAIL_ID,
  email: 'member@example.com',
  url: 'https://example.com/a?b=c:d',
  created: '2026-06-02T10:31:00.010',
};
const MAILING_LIST_ROW: LegacyRow = {
  MLID,
  SiteID: TENANT_A.siteId,
  Name: 'Newsletter',
  Description: '',
  LastUpdate: '2026-05-31T23:59:59.997',
  isPurge: '0',
  isPublic: '1',
};
const MEMBER_ROW: LegacyRow = {
  MLID,
  Email: 'member@example.com',
  SiteID: TENANT_A.siteId,
  fname: 'Ada',
  lname: null,
  company: '',
  isVerified: '1',
  created: null,
};
const TRASH_ROW: LegacyRow = {
  objectID: cfId(6),
  parentID: '00000000000000000000000000000000001',
  siteID: TENANT_A.siteId,
  objectLabel: 'Newsletter',
  objectClass: 'mailinglist',
  objectType: 'mailinglist',
  objectSubType: 'default',
  objectstring: "<wddxPacket version='1.0'><header/><data><string>a:b</string></data></wddxPacket>",
  deletedDate: '2026-06-30T14:05:09.123',
  deletedBy: 'admin',
  deleteid: null,
  orderno: '3',
};

/** Subtype baseTable of the class-extension rows below, and the apply discriminator of their sets, attributes and values. */
const BASE_TABLE = 'temails';
const SUBTYPE_ID = cfId(20);
const EXTEND_SET_ID = cfId(21);

const SUBTYPE_ROW: LegacyRow = {
  subTypeID: SUBTYPE_ID,
  siteID: TENANT_A.siteId,
  baseTable: BASE_TABLE,
  baseKeyField: 'emailID',
  dataTable: 'tclassextenddata',
  type: 'Email',
  subType: 'Newsletter',
  isActive: '1',
  notes: '',
  lastUpdate: '2026-06-01T08:00:00.003',
  dateCreated: '2026-06-01T08:00:00.000',
  lastUpdateBy: 'admin',
  hasSummary: '0',
  hasBody: '1',
  description: null,
  availableSubTypes: null,
  iconclass: 'mi-envelope',
  hasAssocFile: '0',
  hasConfigurator: '0',
  adminonly: '0',
};
const EXTEND_SET_ROW: LegacyRow = {
  extendSetID: EXTEND_SET_ID,
  subTypeID: SUBTYPE_ID,
  categoryID: '',
  siteID: TENANT_A.siteId,
  name: 'Default',
  orderno: '1',
  isActive: '1',
  container: 'Default',
};
const ATTRIBUTE_ROW: LegacyRow = {
  attributeID: '17',
  extendSetID: EXTEND_SET_ID,
  siteID: TENANT_A.siteId,
  name: 'campaignCode',
  label: 'Campaign: code',
  hint: null,
  type: 'TextBox',
  orderno: '1',
  isActive: '1',
  required: 'false',
  validation: '',
  regex: '^[A-Z]+$',
  message: null,
  defaultValue: '',
  optionList: '',
  optionLabelList: '',
  adminonly: '0',
};
const RC_SET_ROW: LegacyRow = {
  subTypeID: SUBTYPE_ID,
  availableSubTypes: 'Page/Default',
  siteID: TENANT_A.siteId,
  entitytype: 'content',
  name: 'Related pages',
  orderNo: '2',
  relatedContentSetID: cfId(22),
};
const EXTEND_DATA_ROW: LegacyRow = {
  dataID: '42',
  baseID: EMAIL_ID,
  attributeID: '17',
  siteID: TENANT_A.siteId,
  attributeValue: 'JUNE\r\n',
  remoteID: null,
  datetimevalue: null,
  numericvalue: '2.5',
  stringvalue: 'JUNE',
};

const SHAPES: ReadonlyArray<readonly [Mapping, CommunicationsTableDefinition, number, readonly string[] | null, LegacyRow]> = [
  [messageTemplateMapping, MESSAGE_TEMPLATE, 8, ['template_id'], TEMPLATE_ROW],
  [messageMapping, MESSAGE, 11, ['message_id'], MESSAGE_ROW],
  [deliveryStatusMapping, DELIVERY_STATUS, 6, ['status_id'], STATUS_ROW],
  [emailMapping, EMAIL, 17, ['EmailID'], EMAIL_ROW],
  [emailStatMapping, EMAIL_STAT, 7, null, EMAIL_STAT_ROW],
  [emailReturnStatMapping, EMAIL_RETURN_STAT, 4, null, RETURN_STAT_ROW],
  [mailingListMapping, MAILING_LIST, 7, null, MAILING_LIST_ROW],
  [mailingListMemberMapping, MAILING_LIST_MEMBER, 8, null, MEMBER_ROW],
  [trashMapping, TRASH, 12, ['objectID'], TRASH_ROW],
  [extendSubtypeMapping, EXTEND_SUBTYPE, 20, ['subTypeID'], SUBTYPE_ROW],
  [extendSetMapping, EXTEND_SET, 8, ['extendSetID'], EXTEND_SET_ROW],
  [extendAttributeMapping, EXTEND_ATTRIBUTE, 17, ['attributeID'], ATTRIBUTE_ROW],
  [extendRcSetMapping, EXTEND_RC_SET, 7, ['relatedContentSetID'], RC_SET_ROW],
  [extendDataMapping, EXTEND_DATA, 9, ['dataID'], EXTEND_DATA_ROW],
];

/** The class-extension mappings with their table and a sample row; tclassextend alone reads baseTable from the row. */
const EXTEND_CASES = SHAPES.filter(([mapping]) => mapping.split?.by === 'baseTable').map(
  ([mapping, definition, , , row]) => [mapping.legacyTable, mapping, definition, row] as const,
);

const LOOKUPS: TenantLookups = {
  umbrellaSiteId: TENANT_UMBRELLA.siteId,
  parentSiteId: (parentLegacyTable, parentKey) => {
    const parents: Record<string, readonly [string, string]> = {
      'synthetic.message': ['message_id', MESSAGE_ID],
      temails: ['EmailID', EMAIL_ID],
    };
    const [column, id] = parents[parentLegacyTable] ?? [];
    return column !== undefined && parentKey[column] === id ? TENANT_A.siteId : null;
  },
};

const IN_TENANT_A = { tenantId: tenantIdForSite('tenant-a'), siteId: TENANT_A.siteId, orphan: false };
const ORPHAN = { tenantId: TENANT_UMBRELLA.tenantId, siteId: TENANT_UMBRELLA.siteId, orphan: true };

const sourceOf = (mapping: Mapping): TenantSource => mapping.tenant ?? { kind: 'umbrella' };
/** Apply discriminator the migration sends with a row of `mapping`: the class-map owner for ttrash, else the subtype baseTable. */
const discriminatorOf = (mapping: Mapping): string => (mapping.split?.by === 'objectClass' ? OWNER : BASE_TABLE);
const targetNames = (mapping: Mapping): string[] => mapping.targetColumns.map((column) => column.name);

describe('communications mapping coverage', () => {
  it('covers owned columns exactly', () => {
    const expected = Object.fromEntries(OWNED_TARGETS.map((entry) => [coverageKey(entry), ownedColumns(entry)]));
    const diff = diffCoverage(expected, mappingCoverage(MAPPINGS));

    expect(diff, JSON.stringify(diff)).toStrictEqual({ missing: {}, extra: {} });
  });

  it.each(OWNED_TARGETS.map((entry) => [entry.target.unit, entry.table.table, entry] as const))(
    'maps %s from %s as ownership records it',
    (unit, legacyTable, entry) => {
      const mapping = MAPPINGS.find((candidate) => candidate.unit === unit);

      expect(mapping?.legacyTable).toBe(legacyTable);
      expect(mapping?.legacyColumns.map((column) => column.name)).toStrictEqual(ownedColumns(entry));
      expect([mapping?.key ?? [], mapping?.keyless]).toStrictEqual([entry.target.keyColumns, entry.table.rowIdentity === 'multiset']);
      expect(mapping?.tenant).toStrictEqual(expectedTenant(entry.table));
    },
  );

  it('maps each unit with a legacy table, in UNITS order', () => {
    const legacyTables = (unit: string): string[] | undefined => OWNED_UNITS.find((owned) => owned.unit === unit)?.legacyTables;
    const legacyFed = UNITS.filter((unit) => (legacyTables(unit)?.length ?? 0) > 0);

    expect(new Set(OWNED_UNITS.map((unit) => unit.unit))).toStrictEqual(new Set(UNITS));
    expect(legacyFed).toStrictEqual(UNITS.filter((unit) => unit !== SCHEDULED_TASK.unit));
    expect(MAPPINGS.map((mapping) => mapping.unit)).toStrictEqual(legacyFed);
    expect(MAPPINGS.map((mapping) => [mapping.legacyTable])).toStrictEqual(legacyFed.map(legacyTables));
    expect(OWNED_TARGETS.map(({ target }) => target.unit).sort()).toStrictEqual([...legacyFed].sort());
  });

  it('maps no tenant_id and no target-only column', () => {
    expect(MAPPINGS.flatMap(targetNames)).not.toContain('tenant_id');
    expect(targetNames(messageMapping).filter((name) => ['source', 'event_id', 'row_version'].includes(name))).toStrictEqual([]);
    expect(targetNames(deliveryStatusMapping)).not.toContain('source');
  });
});

describe('keys and keyless tables', () => {
  it.each(SHAPES.map(([mapping, definition, count, key]) => [definition.table, count, key, mapping, definition] as const))(
    '%s maps %i columns on key %j',
    (_table, count, key, mapping, definition) => {
      expect(mapping.unit).toBe(definition.unit);
      expect(mapping.columns).toHaveLength(count);
      expect([mapping.key, mapping.keyless, definition.key === null]).toStrictEqual([key, key === null, key === null]);
    },
  );

  it.each(SHAPES.filter(([, , , key]) => key === null).map(([mapping, definition]) => [definition.table, mapping, definition] as const))(
    'identifies %s rows by legacy_row_hash and occurrence',
    (table, mapping, definition) => {
      expect(mapping.keyless).toBe(true);
      expect(definition.columns.slice(-2)).toStrictEqual([
        { name: 'legacy_row_hash', type: 's' },
        { name: 'occurrence', type: 'i' },
      ]);
      expect(primaryKeyOf(table)).toBe('tenant_id, legacy_row_hash, occurrence');
    },
  );
});

describe('tenant sources', () => {
  it.each([
    [MESSAGE_TEMPLATE.table, messageTemplateMapping, TEMPLATE_ROW],
    [MESSAGE.table, messageMapping, MESSAGE_ROW],
    [EMAIL.table, emailMapping, EMAIL_ROW],
    [MAILING_LIST.table, mailingListMapping, MAILING_LIST_ROW],
    [MAILING_LIST_MEMBER.table, mailingListMemberMapping, MEMBER_ROW],
    [EXTEND_SUBTYPE.table, extendSubtypeMapping, SUBTYPE_ROW],
    [EXTEND_SET.table, extendSetMapping, EXTEND_SET_ROW],
    [EXTEND_ATTRIBUTE.table, extendAttributeMapping, ATTRIBUTE_ROW],
    [EXTEND_RC_SET.table, extendRcSetMapping, RC_SET_ROW],
    [EXTEND_DATA.table, extendDataMapping, EXTEND_DATA_ROW],
  ] as const)('resolves %s rows to their own site tenant', (_table, mapping, row) => {
    const source = sourceOf(mapping);
    const column = source.kind === 'site' ? source.column : '';

    expect(source.kind).toBe('site');
    expect(IN_TENANT_A.tenantId).toBe(TENANT_A.tenantId);
    expect(resolveTenant(source, row, LOOKUPS)).toStrictEqual(IN_TENANT_A);
    expect(resolveTenant(source, { ...row, [column]: 'TENANT-A' }, LOOKUPS).tenantId).toBe(TENANT_A.tenantId);
  });

  it.each([
    [DELIVERY_STATUS.table, deliveryStatusMapping, STATUS_ROW],
    [EMAIL_STAT.table, emailStatMapping, EMAIL_STAT_ROW],
    [EMAIL_RETURN_STAT.table, emailReturnStatMapping, RETURN_STAT_ROW],
  ] as const)('inherits the parent tenant of %s rows', (_table, mapping, row) => {
    const source = sourceOf(mapping);

    expect(source.kind).toBe('parent');
    expect(resolveTenant(source, row, LOOKUPS)).toStrictEqual(IN_TENANT_A);
  });

  it.each([
    ['a delivery_status row without its message', deliveryStatusMapping, { ...STATUS_ROW, message_id: cfId(99) }],
    ['an email_stat row without its email', emailStatMapping, { ...EMAIL_STAT_ROW, EmailID: cfId(99) }],
    ['an email_return_stat row with a null emailID', emailReturnStatMapping, { ...RETURN_STAT_ROW, emailID: null }],
    ['an email row without a site', emailMapping, { ...EMAIL_ROW, siteid: null }],
    ['a tclassextend row without a site', extendSubtypeMapping, { ...SUBTYPE_ROW, siteID: null }],
  ] as const)('places %s under the umbrella tenant as an orphan', (_label, mapping, row) => {
    expect(resolveTenant(sourceOf(mapping), row, LOOKUPS)).toStrictEqual(ORPHAN);
  });
});

describe('login-mail rows', () => {
  // Login mail exists only in the target, where `source` defaults to 'send' on apply; MappingSpec has no target-row predicate, so ownership's rowPredicate is null.
  it.each([
    [messageMapping.legacyTable, messageMapping, MESSAGE_ROW],
    [deliveryStatusMapping.legacyTable, deliveryStatusMapping, STATUS_ROW],
  ] as const)('takes every %s row and keeps source target-only', (legacyTable, mapping, row) => {
    expect(OWNED_TARGETS.find(({ table }) => table.table === legacyTable)?.target.rowPredicate).toBeNull();
    expect(mapping.split).toBeUndefined();
    expect(mapping.columns.map((column) => column.legacy)).not.toContain('source');
    expect(mapping.acceptsRow(row)).toBe(true);
  });
});

describe('baseTable split of the class-extension tables', () => {
  const COMMUNICATIONS_BASE_TABLES = baseTablesOf(OWNED_TARGETS.find(({ table }) => table.table === 'tclassextend')?.target.rowPredicate ?? null);
  const OTHER_BASE_TABLES: readonly (string | undefined)[] = ['tcontent', 'tusers', 'custom', undefined];

  /** Whether `mapping` takes `row` of a subtype on `baseTable`: read from the row by tclassextend, else sent as the apply discriminator. */
  function accepts(mapping: Mapping, row: LegacyRow, baseTable: string | undefined): boolean {
    const column = mapping.split?.column;
    return column === undefined ? mapping.acceptsRow(row, baseTable) : mapping.acceptsRow({ ...row, [column]: baseTable ?? null });
  }

  it.each(EXTEND_CASES)('splits %s by the base tables its ownership row predicate lists, in that order', (legacyTable, mapping) => {
    const listed = baseTablesOf(OWNED_TARGETS.find(({ table }) => table.table === legacyTable)?.target.rowPredicate ?? null);

    expect(listed).toStrictEqual(COMMUNICATIONS_BASE_TABLES);
    expect(listed).toHaveLength(8);
    expect(mapping.split).toStrictEqual(
      mapping.legacyTable === 'tclassextend' ? { by: 'baseTable', value: listed, column: 'baseTable' } : { by: 'baseTable', value: listed },
    );
  });

  it.each(EXTEND_CASES.flatMap(([legacyTable, mapping, , row]) => COMMUNICATIONS_BASE_TABLES.map((baseTable) => [legacyTable, baseTable, mapping, row] as const)))(
    'takes a %s row of a subtype on %s',
    (_legacyTable, baseTable, mapping, row) => {
      expect(accepts(mapping, row, baseTable)).toBe(true);
    },
  );

  it.each(
    EXTEND_CASES.flatMap(([legacyTable, mapping, , row]) =>
      OTHER_BASE_TABLES.map((baseTable) => [legacyTable, baseTable ?? 'no baseTable', baseTable, mapping, row] as const),
    ),
  )('leaves a %s row of a subtype on %s to another owner or legacy', (_legacyTable, _label, baseTable, mapping, row) => {
    expect(accepts(mapping, row, baseTable)).toBe(false);
  });
});

describe('row round trips', () => {
  it.each(SHAPES.map(([mapping, definition, , , row]) => [definition.table, mapping, row] as const))(
    'keeps %s rows byte-exact',
    (_table, mapping, row) => {
      const encoding = encodeRow(mapping.legacyColumns, row);
      const decoded = decodeRow(mapping.legacyColumns, encoding);
      const target = mapping.toTarget(decoded);

      expect(decoded).toStrictEqual(row);
      // Unsplit mappings and tclassextend, which reads its baseTable from the row, ignore the apply discriminator.
      expect(mapping.acceptsRow(row, discriminatorOf(mapping))).toBe(true);
      expect(mapping.encodeLegacy(target)).toBe(encoding);
      expect(encodeRow(mapping.legacyColumns, mapping.toLegacy(target))).toBe(encoding);
    },
  );

  it('keeps char(35) padding and tells an empty string from NULL', () => {
    expect(encodeRow(mailingListMemberMapping.legacyColumns, MEMBER_ROW)).toBe(
      `s35:${MLID}s18:member@example.coms8:${TENANT_A.siteId}s3:AdaNs0:i1:1N`,
    );
  });
});

describe('migration applies of the split tables', () => {
  const APPLY_URL = '/internal/v1/migration/apply';
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp();
  });

  afterEach(async () => {
    await t.app.close();
  });

  /** Status and answer of one backfill apply of `rows` of `mapping`'s legacy table for tenant A. */
  async function apply(batchId: string, mapping: Mapping, rows: ApplyRequest['rows']): Promise<{ status: number; body: ApplyResponse }> {
    const payload: ApplyRequest = {
      batchId,
      origin: 'backfill',
      legacyTable: mapping.legacyTable,
      siteId: TENANT_A.siteId,
      columns: [...mapping.legacyColumns],
      rows,
    };
    const res = await t.app.inject({ method: 'POST', url: APPLY_URL, headers: await headersFor('service:migration'), payload });
    return { status: res.statusCode, body: res.json<ApplyResponse>() };
  }

  /** Tenant and legacy encoding of each stored row of `definition`, as export reads them back. */
  const stored = (mapping: Mapping, definition: CommunicationsTableDefinition): [unknown, string][] =>
    t.db.rows(definition.table).map((row) => [row.tenant_id, mapping.encodeLegacy(row)]);

  it('stores only the temails subtype of a tclassextend batch that also holds a custom subtype', async () => {
    const custom = { ...SUBTYPE_ROW, subTypeID: cfId(30), baseTable: 'custom' };
    const rows = [SUBTYPE_ROW, custom].map((row) => ({ op: 'upsert' as const, row: encodeRow(extendSubtypeMapping.legacyColumns, row) }));

    expect(await apply('extend-subtype-1', extendSubtypeMapping, rows)).toStrictEqual({
      status: 200,
      body: { batchId: 'extend-subtype-1', duplicate: false, applied: 1, skipped: 1 },
    });
    expect(stored(extendSubtypeMapping, EXTEND_SUBTYPE)).toStrictEqual([[TENANT_A.tenantId, rows[0]?.row]]);
  });

  it.each(EXTEND_CASES.filter(([, mapping]) => mapping.split?.column === undefined))(
    'stores a %s row only under a communications base-table discriminator',
    async (legacyTable, mapping, definition, row) => {
      const encoding = encodeRow(mapping.legacyColumns, row);
      const rows = ['tcontent', undefined, BASE_TABLE].map((discriminator) => ({ op: 'upsert' as const, row: encoding, discriminator }));

      expect(await apply(`extend-${legacyTable}`, mapping, rows)).toStrictEqual({
        status: 200,
        body: { batchId: `extend-${legacyTable}`, duplicate: false, applied: 1, skipped: 2 },
      });
      expect(stored(mapping, definition)).toStrictEqual([[TENANT_A.tenantId, encoding]]);
    },
  );

  it('stores the ttrash rows sent under the communications discriminator, an extendObject row included, and skips those of another owner', async () => {
    const extendObject: LegacyRow = {
      ...TRASH_ROW,
      objectID: cfId(7),
      objectLabel: 'Newsletter subtype',
      objectClass: 'extendObject',
      objectType: 'Email',
      objectSubType: 'Newsletter',
      objectstring: "<wddxPacket version='1.0'><header/><data><struct><var name='BASETABLE'><string>temails </string></var></struct></data></wddxPacket>\r\n",
    };
    const content: LegacyRow = { ...extendObject, objectID: cfId(8), objectType: 'Page', objectSubType: 'Default' };
    const rows = (
      [
        [TRASH_ROW, OWNER],
        [extendObject, OWNER],
        [content, 'strategies-content'],
      ] as const
    ).map(([row, discriminator]) => ({ op: 'upsert' as const, row: encodeRow(trashMapping.legacyColumns, row), discriminator }));

    expect(await apply('trash-1', trashMapping, rows)).toStrictEqual({
      status: 200,
      body: { batchId: 'trash-1', duplicate: false, applied: 2, skipped: 1 },
    });
    expect(stored(trashMapping, TRASH)).toStrictEqual([
      [TENANT_A.tenantId, rows[0]?.row],
      [TENANT_A.tenantId, rows[1]?.row],
    ]);
    expect(t.db.rows(TRASH.table).map((row) => row.objectstring)).toStrictEqual([TRASH_ROW.objectstring, extendObject.objectstring]);
  });
});

