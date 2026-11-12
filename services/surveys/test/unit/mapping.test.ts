// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The surveys mappings against table ownership, the fixture DDL and the surveys tables: column coverage, units, tenant sources and byte-exact round trips. */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  diffCoverage,
  encodeRow,
  mappingCoverage,
  resolveTenant,
  type Mapping,
  type TenantLookups,
  type TenantSource,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import {
  MAPPINGS,
  surveyMapping,
  surveyReminderMapping,
  surveyResponseMapping,
  surveyScheduleMapping,
  surveyTargetMapping,
} from '../../src/migration/mappings/index.js';
import { OWNED_TABLES, TARGET_ONLY_COLUMNS, UNITS } from '../../src/repo/tables.js';

const OWNER = 'surveys';

interface OwnershipTarget {
  unit: string;
  keyColumns: string[];
  columnPolicy: 'whole-table' | 'explicit';
  ownedColumns: string[];
}

interface OwnershipTable {
  table: string;
  columns: string[];
  siteIdColumn: string | null;
  rowIdentity: 'key' | 'multiset';
  serializedDocumentColumns: string[];
  tenantResolution: string | null;
  tenantParent?: { table: string; join: string };
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string; legacyTables: string[] }[];
  tables: OwnershipTable[];
}

/** A surveys target of table ownership with its legacy table. */
interface OwnedTarget {
  table: OwnershipTable;
  target: OwnershipTarget;
}

type LegacyRow = Readonly<Record<string, unknown>>;

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const OWNERSHIP = JSON.parse(read('../../../../opt2/table-ownership.json')) as Ownership;
const FIXTURE_DDL = read('../../../../legacy-fixtures/sql/surveys/100_tables.sql');
const OWNED_UNITS = OWNERSHIP.units.filter((unit) => unit.owner === OWNER);
const OWNED_UNIT_IDS: ReadonlySet<string> = new Set(OWNED_UNITS.map((unit) => unit.unit));
const OWNED_TARGETS: readonly OwnedTarget[] = OWNERSHIP.tables.flatMap((table) =>
  (table.targets ?? []).filter((target) => OWNED_UNIT_IDS.has(target.unit)).map((target) => ({ table, target })),
);

/** The one mapping of the target's legacy table onto its unit. */
function mappingFor({ table, target }: OwnedTarget): Mapping {
  const found = MAPPINGS.filter((mapping) => mapping.legacyTable === table.table && mapping.unit === target.unit);
  const [mapping] = found;
  if (found.length !== 1 || mapping === undefined) throw new Error(`${String(found.length)} mappings of ${table.table} onto ${target.unit}`);
  return mapping;
}

/** The table ownership entry of a surveys legacy table. */
function ownershipTable(legacyTable: string): OwnershipTable {
  const entry = OWNED_TARGETS.find(({ table }) => table.table === legacyTable);
  if (entry === undefined) throw new Error(`table ownership gives ${legacyTable} no surveys target`);
  return entry.table;
}

/** Column names of `[<schema>].[<table>]` in `100_tables.sql`, in catalog order. */
function fixtureColumns(legacyTable: string): string[] {
  const [schema = '', table = ''] = legacyTable.split('.');
  const head = `CREATE TABLE [${schema}].[${table}] (`;
  const start = FIXTURE_DDL.indexOf(head);
  if (start < 0) throw new Error(`no fixture table ${legacyTable}`);
  const body = FIXTURE_DDL.slice(start + head.length, FIXTURE_DDL.indexOf('\n) ON', start));
  return body.split('\n').flatMap((line) => /^\s*\[(\w+)\] \[\w+\]/.exec(line)?.[1] ?? []);
}

/** A CF-format 35-character id ending in the two digits of `n`. */
const cfId = (n: number): string => `A1B2C3D4-E5F6-7890-ABCDEF12345678${String(n).padStart(2, '0')}`;
/** A local wall-clock `datetime` of June 2026, as the SQL Server driver returns it. */
const at = (day: number, hour: number, ms = 0): Date => new Date(2026, 5, day, hour, 0, 0, ms);

const SURVEY_ID = cfId(90);
const USER_ID = cfId(80);
const TASK_HASH = 'c0ffee00'.repeat(8);
const ANSWERS = JSON.stringify({ q1: 'yes: très bien', q2: 'line one\nline two' }, null, 2);

const SURVEY_ROW: LegacyRow = {
  survey_id: SURVEY_ID,
  siteID: TENANT_A.siteId,
  title: 'Staff pulse: Q2\nwellbeing',
  status: 'SCHEDULED',
  created: at(1, 9, 3),
  createdByID: USER_ID,
  lastUpdate: at(1, 10),
  lastUpdateByID: USER_ID,
  launched_at: null,
};
const SCHEDULE_ROW: LegacyRow = {
  schedule_id: cfId(91),
  survey_id: SURVEY_ID,
  launch_at: at(2, 8),
  schedule_version: 2,
  task_name: `opt2-survey-${SURVEY_ID}-launch`,
  task_token_hash: TASK_HASH,
  created: at(1, 10),
};
const REMINDER_ROW: LegacyRow = {
  reminder_id: cfId(92),
  survey_id: SURVEY_ID,
  offset_minutes: 1440,
  remind_at: at(3, 8),
  task_name: `opt2-survey-${SURVEY_ID}-reminder-1`,
  task_token_hash: TASK_HASH,
  sent_at: null,
};
const TARGET_GROUP_ROW: LegacyRow = {
  target_id: cfId(93),
  survey_id: SURVEY_ID,
  siteID: TENANT_B.siteId,
  group_name: 'Survey Managers',
  created: at(1, 10),
};
const TARGET_SITE_ROW: LegacyRow = { ...TARGET_GROUP_ROW, target_id: cfId(94), siteID: TENANT_A.siteId, group_name: null };
const RESPONSE_ROW: LegacyRow = {
  response_id: cfId(95),
  survey_id: SURVEY_ID,
  siteID: TENANT_A.siteId,
  respondentSiteID: TENANT_B.siteId,
  respondent_user_id: USER_ID,
  answers: ANSWERS,
  created: at(4, 14, 998),
};

const SAMPLES: ReadonlyArray<readonly [label: string, mapping: Mapping, row: LegacyRow]> = [
  ['survey', surveyMapping, SURVEY_ROW],
  ['survey_schedule', surveyScheduleMapping, SCHEDULE_ROW],
  ['survey_reminder', surveyReminderMapping, REMINDER_ROW],
  ['survey_target with a group', surveyTargetMapping, TARGET_GROUP_ROW],
  ['survey_target without a group', surveyTargetMapping, TARGET_SITE_ROW],
  ['survey_response', surveyResponseMapping, RESPONSE_ROW],
];

const LOOKUPS: TenantLookups = {
  umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID,
  parentSiteId: (parentLegacyTable, parentKey) =>
    parentLegacyTable === surveyMapping.legacyTable && parentKey.survey_id === SURVEY_ID ? TENANT_A.siteId : null,
};

const IN_TENANT_A = { tenantId: tenantIdForSite(TENANT_A.siteId), siteId: TENANT_A.siteId, orphan: false };

/** The target row of a legacy row, through its canonical encoding as the apply handler receives it. */
function targetOf(mapping: Mapping, row: LegacyRow): Record<string, unknown> {
  return mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encodeRow(mapping.legacyColumns, row)));
}

describe('surveys mapping coverage', () => {
  it('maps exactly the legacy columns table ownership assigns to surveys', () => {
    const expected = Object.fromEntries(OWNED_TARGETS.map(({ table, target }) => [table.table, target.ownedColumns]));
    const diff = diffCoverage(expected, mappingCoverage(MAPPINGS));

    expect(OWNED_TARGETS).toHaveLength(UNITS.length);
    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });

  it.each(OWNED_TARGETS.map((entry) => [entry.table.table, entry.target.unit, entry] as const))(
    'maps every %s fixture column in catalog order onto %s, keyed on its primary key',
    (_legacyTable, unit, entry) => {
      const mapping = mappingFor(entry);

      expect(entry.target.columnPolicy).toBe('whole-table');
      expect(entry.target.ownedColumns).toStrictEqual(entry.table.columns);
      expect(entry.table.columns).toStrictEqual(fixtureColumns(entry.table.table));
      expect(mapping.legacyColumns.map((column) => column.name)).toStrictEqual(entry.table.columns);
      expect([mapping.targetTable, mapping.key, mapping.keyless]).toStrictEqual([unit, entry.target.keyColumns, entry.table.rowIdentity === 'multiset']);
      expect([mapping.split, mapping.fold]).toStrictEqual([undefined, undefined]);
    },
  );

  it('declares one mapping per surveys unit in UNITS order, each from the legacy table ownership lists for it', () => {
    expect(MAPPINGS.map((mapping) => mapping.unit)).toStrictEqual([...UNITS]);
    expect([...OWNED_UNIT_IDS].sort()).toStrictEqual([...UNITS].sort());
    expect(MAPPINGS.map((mapping) => OWNED_UNITS.find((unit) => unit.unit === mapping.unit)?.legacyTables)).toStrictEqual(
      MAPPINGS.map((mapping) => [mapping.legacyTable]),
    );
  });

  it('lists the named mappings in the frozen barrel, survey before its children', () => {
    const named = [surveyMapping, surveyScheduleMapping, surveyReminderMapping, surveyTargetMapping, surveyResponseMapping];

    expect(MAPPINGS.map((mapping) => named.indexOf(mapping))).toStrictEqual([0, 1, 2, 3, 4]);
    expect(Object.isFrozen(MAPPINGS)).toBe(true);
  });

  it.each(MAPPINGS.map((mapping) => [mapping.unit, mapping] as const))(
    'targets the %s columns of its surveys table besides tenant_id and its target-only columns',
    (unit, mapping) => {
      const definition = OWNED_TABLES.find((table) => table.unit === unit);
      const local = new Set(['tenant_id', ...(TARGET_ONLY_COLUMNS[definition?.table ?? ''] ?? [])]);

      expect(mapping.targetColumns).toStrictEqual(definition?.columns.filter((column) => !local.has(column.name)));
    },
  );

  it('maps no tenant_id and leaves the survey_schedule row_version unmapped', () => {
    expect(MAPPINGS.flatMap((mapping) => mapping.targetColumns.map((column) => column.name))).not.toContain('tenant_id');
    expect(surveyScheduleMapping.targetColumns.map((column) => column.name)).not.toContain('row_version');
    expect(surveyScheduleMapping.legacyColumns.map((column) => column.name)).not.toContain('row_version');
  });

  it('maps the serialized answers document as byte-exact text', () => {
    const documents = OWNED_TARGETS.flatMap(({ table }) =>
      table.serializedDocumentColumns.map((name) => [
        table.table,
        name,
        MAPPINGS.find((mapping) => mapping.legacyTable === table.table)?.legacyColumns.find((column) => column.name === name)?.type,
      ]),
    );

    expect(documents).toStrictEqual([[surveyResponseMapping.legacyTable, 'answers', 's']]);
  });
});

describe('tenant sources', () => {
  const siteSourced: ReadonlyArray<readonly [Mapping, LegacyRow]> = [
    [surveyMapping, SURVEY_ROW],
    [surveyResponseMapping, RESPONSE_ROW],
  ];
  const parentSourced: ReadonlyArray<readonly [Mapping, LegacyRow]> = [
    [surveyScheduleMapping, SCHEDULE_ROW],
    [surveyReminderMapping, REMINDER_ROW],
    [surveyTargetMapping, TARGET_GROUP_ROW],
  ];

  it.each(siteSourced.map(([mapping, row]) => [mapping.legacyTable, mapping, row] as const))(
    'resolves the %s tenant from the row its own siteID names',
    (legacyTable, mapping, row) => {
      const table = ownershipTable(legacyTable);

      expect([table.tenantResolution, table.siteIdColumn]).toStrictEqual(['siteID', 'siteID']);
      expect(mapping.tenant).toStrictEqual({ kind: 'site', column: table.siteIdColumn });
      expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, row, LOOKUPS)).toStrictEqual(IN_TENANT_A);
    },
  );

  it.each(parentSourced.map(([mapping, row]) => [mapping.legacyTable, mapping, row] as const))(
    'inherits the survey tenant of a %s row through survey_id',
    (legacyTable, mapping, row) => {
      const table = ownershipTable(legacyTable);
      const join = /^(.+)\.(\w+) = (.+)\.(\w+)$/.exec(table.tenantParent?.join ?? '');
      const source: TenantSource = mapping.tenant ?? { kind: 'umbrella' };

      expect(table.tenantResolution).toBe(`parent:${surveyMapping.legacyTable}`);
      expect(join?.slice(1)).toStrictEqual([legacyTable, 'survey_id', surveyMapping.legacyTable, 'survey_id']);
      expect(mapping.tenant).toStrictEqual({ kind: 'parent', parentLegacyTable: table.tenantParent?.table, columns: { survey_id: 'survey_id' } });
      expect(resolveTenant(source, row, LOOKUPS)).toStrictEqual(IN_TENANT_A);
      expect(resolveTenant(source, { ...row, survey_id: cfId(99) }, LOOKUPS)).toStrictEqual({
        tenantId: tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID),
        siteId: DEFAULT_UMBRELLA_SITE_ID,
        orphan: true,
      });
    },
  );

  it('resolves a survey_target row to its survey tenant, not the site it targets', () => {
    const resolved = resolveTenant(surveyTargetMapping.tenant ?? { kind: 'umbrella' }, TARGET_GROUP_ROW, LOOKUPS);

    expect(ownershipTable(surveyTargetMapping.legacyTable).siteIdColumn).toBe('siteID');
    expect(surveyTargetMapping.tenant?.kind).toBe('parent');
    expect(resolved).toStrictEqual(IN_TENANT_A);
    expect(resolved.tenantId).not.toBe(tenantIdForSite(TENANT_B.siteId));
  });
});

describe('row round trips', () => {
  it.each(SAMPLES)('keeps a %s row byte-exact through its target row', (_label, mapping, row) => {
    const encoding = encodeRow(mapping.legacyColumns, row);
    const target = mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encoding));

    expect(mapping.acceptsRow(row)).toBe(true);
    expect(Object.keys(target)).toStrictEqual(mapping.targetColumns.map((column) => column.name));
    expect(mapping.encodeLegacy(target)).toBe(encoding);
    expect(encodeRow(mapping.legacyColumns, mapping.toLegacy(target))).toBe(encoding);
  });

  it('carries a NULL group_name as NULL and a named group as its text', () => {
    const groups = [TARGET_SITE_ROW, TARGET_GROUP_ROW].map((row) => targetOf(surveyTargetMapping, row).group_name);

    expect(groups).toStrictEqual([null, 'Survey Managers']);
  });

  it('carries schedule_version as integer text and launch_at as a local wall-clock timestamp', () => {
    const target = targetOf(surveyScheduleMapping, SCHEDULE_ROW);

    expect([target.schedule_version, target.launch_at]).toStrictEqual(['2', '2026-06-02 08:00:00.000']);
  });

  it('encodes answers by UTF-8 byte length and keeps them byte-exact, created rounded to datetime precision', () => {
    const target = targetOf(surveyResponseMapping, RESPONSE_ROW);

    expect(encodeRow(surveyResponseMapping.legacyColumns, RESPONSE_ROW)).toContain(`s${String(Buffer.byteLength(ANSWERS, 'utf8'))}:${ANSWERS}`);
    expect(Buffer.byteLength(ANSWERS, 'utf8')).toBeGreaterThan(ANSWERS.length);
    expect([target.answers, target.created]).toStrictEqual([ANSWERS, '2026-06-04 14:00:00.997']);
  });
});
