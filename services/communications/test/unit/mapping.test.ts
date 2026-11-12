// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The communications mappings against table ownership and the target DDL: exact column coverage, keys, tenant sources and byte-exact round trips. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeRow,
  diffCoverage,
  encodeRow,
  mappingCoverage,
  resolveTenant,
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
  MAILING_LIST,
  MAILING_LIST_MEMBER,
  MESSAGE,
  MESSAGE_TEMPLATE,
  SCHEDULED_TASK,
  TRASH,
  UNITS,
  type CommunicationsTableDefinition,
} from '../../src/repo/tables.js';

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
  split?: { by: string; classMap: { classes: string[]; owner?: string }[] };
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
const TARGET_DDL = read('../../db/migrations/0002_communications.sql');
const OWNED_UNITS = OWNERSHIP.units.filter((unit) => unit.owner === OWNER);
const OWNED_TARGETS: readonly OwnedTarget[] = OWNERSHIP.tables.flatMap((table) =>
  (table.targets ?? []).filter((target) => target.unit.startsWith(`${OWNER}.`)).map((target) => ({ table, target })),
);

/** Legacy columns a target owns; a whole-table target owns every column ownership records for the table. */
const ownedColumns = ({ table, target }: OwnedTarget): string[] => (target.columnPolicy === 'whole-table' ? table.columns : target.ownedColumns);

/** `mappingCoverage` key of a legacy table: suffixed with the classes ownership's split assigns to communications. */
function coverageKey(table: OwnershipTable): string {
  if (table.split === undefined) return table.table;
  const classes = table.split.classMap.filter((entry) => entry.owner === OWNER).flatMap((entry) => entry.classes);
  return `${table.table}{${table.split.by}=${classes.join(',')}}`;
}

/** Tenant source named by a table's `tenantResolution`, `siteIdColumn` and `tenantParent.join`. */
function expectedTenant(table: OwnershipTable): TenantSource {
  if (table.tenantResolution === 'siteID' || table.tenantResolution === 'siteID-or-umbrella') {
    return { kind: 'site', column: table.siteIdColumn ?? '' };
  }
  const [child = '', parent = ''] = (table.tenantParent?.join ?? '').split(' = ').map((side) => side.slice(side.lastIndexOf('.') + 1));
  return { kind: 'parent', parentLegacyTable: table.tenantParent?.table ?? '', columns: { [child]: parent } };
}

/** Columns of the primary key of `communications.<table>` in `0002_communications.sql`. */
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
];

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
const targetNames = (mapping: Mapping): string[] => mapping.targetColumns.map((column) => column.name);

describe('communications mapping coverage', () => {
  it('covers owned columns exactly', () => {
    const expected = Object.fromEntries(OWNED_TARGETS.map((entry) => [coverageKey(entry.table), ownedColumns(entry)]));
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

describe('row round trips', () => {
  it.each(SHAPES.map(([mapping, definition, , , row]) => [definition.table, mapping, row] as const))(
    'keeps %s rows byte-exact',
    (_table, mapping, row) => {
      const encoding = encodeRow(mapping.legacyColumns, row);
      const decoded = decodeRow(mapping.legacyColumns, encoding);
      const target = mapping.toTarget(decoded);

      expect(decoded).toStrictEqual(row);
      expect(mapping.acceptsRow(row)).toBe(true);
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

