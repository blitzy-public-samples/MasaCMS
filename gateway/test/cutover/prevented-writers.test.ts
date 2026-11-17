import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PREVENTED_WRITERS,
  isPreventedWriter,
  type WriterRecord,
} from '../../src/cutover/prevented-writers.js';
import type { InventoryDoc, InventoryWriter } from '../../src/cutover/types.js';

const INVENTORY_PATH = fileURLToPath(new URL('../../../opt2/inventory/legacy-inventory.json', import.meta.url));
const OVERRIDE_PREFIX = 'harness/inventory/writer-overrides.yaml#wov:';

const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')) as InventoryDoc;
const writerRows = inventory.tables.flatMap((table) => table.writers.map((writer) => ({ table: table.table, writer })));
const nonRequestRows = writerRows.filter(({ writer }) => writer.trigger !== 'request');
const ids = PREVENTED_WRITERS.map((entry) => entry.id);

const OVERRIDE_REVIEWED = [
  'scheduler-registration',
  'native-sitemonitor-task',
  'fixture-survey-tasks',
  'fixture-export-threads',
  'startup-url-conversion',
];
const conditionEntries = PREVENTED_WRITERS.filter((entry) => entry.match.condition !== undefined);
const SETTINGS_DAO = 'core/mura/settings/settingsDAO.cfc';

/** Inventory records whose reviewed override names the prevented-writer id. */
const reviewedRecords = (id: string): InventoryWriter[] =>
  writerRows.filter(({ writer }) => writer.override === `${OVERRIDE_PREFIX}${id}`).map(({ writer }) => writer);

/** Id of the entry a non-request inventory record must resolve to, or `undefined`; condition entries outrank settingsDAO.update. */
function expectedEntry(table: string, writer: InventoryWriter): string | undefined {
  const reviewed = OVERRIDE_REVIEWED.find((id) => writer.override === `${OVERRIDE_PREFIX}${id}`);
  if (reviewed !== undefined) return reviewed;
  if (table === 'synthetic.export_job' && writer.trigger === 'thread') return 'fixture-export-threads';
  const byCondition = conditionEntries.find(
    (entry) => entry.trigger === writer.trigger && entry.match.condition === writer.condition,
  );
  if (byCondition !== undefined) return byCondition.id;
  const themeSiteSizes = writer.trigger === 'appstart' && writer.component === SETTINGS_DAO && writer.method === 'update';
  return themeSiteSizes ? 'startup-theme-site-sizes' : undefined;
}

describe('PREVENTED_WRITERS', () => {
  it('is the closed list of eleven mechanisms, in order', () => {
    expect(ids).toEqual([
      ...OVERRIDE_REVIEWED,
      'startup-deploy-bundle',
      'startup-project-site',
      'startup-db-updates',
      'startup-plugin-discovery',
      'trash-restore-bean',
      'startup-theme-site-sizes',
    ]);
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(PREVENTED_WRITERS)).toBe(true);
    for (const entry of PREVENTED_WRITERS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.match)).toBe(true);
      if (entry.match.lines) expect(Object.isFrozen(entry.match.lines)).toBe(true);
      if (entry.alsoMatch) expect(Object.isFrozen(entry.alsoMatch)).toBe(true);
    }
  });

  it.each(PREVENTED_WRITERS.filter((entry) => OVERRIDE_REVIEWED.includes(entry.id)).map((entry) => [entry.id, entry] as const))(
    '%s matches its reviewed inventory writer records',
    (id, entry) => {
      const records = reviewedRecords(id);
      expect(records.length, `no inventory writer carries override wov:${id}`).toBeGreaterThan(0);
      for (const record of records) {
        expect(record.trigger).toBe(entry.trigger);
        expect(isPreventedWriter(record)?.id).toBe(id);
      }
    },
  );

  it.each(conditionEntries.map((entry) => [entry.id, entry] as const))(
    '%s matches every non-request inventory writer recording its condition',
    (id, entry) => {
      const records = nonRequestRows.filter(({ writer }) => writer.condition === entry.match.condition).map(({ writer }) => writer);
      expect(records.length, `no inventory writer records the condition of ${id}`).toBeGreaterThan(0);
      for (const record of records) {
        expect(record.trigger).toBe(entry.trigger);
        expect(isPreventedWriter(record)?.id).toBe(id);
      }
    },
  );

  it('matches every thread writer of synthetic.export_job, the job procedure included', () => {
    const threadRows = nonRequestRows.filter(({ table, writer }) => table === 'synthetic.export_job' && writer.trigger === 'thread');
    expect(threadRows.map(({ writer }) => writer.component)).toContain(
      'legacy-fixtures/sql/reporting/200_usp_export_job_transition.sql',
    );
    for (const { writer } of threadRows) expect(isPreventedWriter(writer)?.id).toBe('fixture-export-threads');
  });

  it('matches no other non-request inventory writer', () => {
    const mismatched = nonRequestRows
      .map(({ table, writer }) => ({ table, writer, expected: expectedEntry(table, writer), actual: isPreventedWriter(writer)?.id }))
      .filter(({ expected, actual }) => expected !== actual);
    expect(mismatched).toEqual([]);
  });
});

describe('isPreventedWriter', () => {
  it.each<[string, WriterRecord, string]>([
    [
      'a "first-last" line string',
      { component: 'core/appcfc/onApplicationStart_include.cfm', trigger: 'appstart', source: { lines: '570-580' } },
      'scheduler-registration',
    ],
    [
      'a partially overlapping tuple',
      { component: 'core/appcfc/onApplicationStart_include.cfm', trigger: 'appstart', source: { lines: [929, 940] } },
      'startup-url-conversion',
    ],
    [
      'source.path when the component differs',
      {
        component: '(template)',
        method: 'handleAPIRequest',
        trigger: 'scheduler',
        source: { path: 'core/mura/content/contentServer.cfc', lines: [737, 743] },
      },
      'native-sitemonitor-task',
    ],
    [
      'an entry without a line span',
      { component: 'legacy-fixtures/cfml/modules/reporting.cfc', method: 'createExport', trigger: 'thread' },
      'fixture-export-threads',
    ],
    [
      'a condition whatever the component',
      {
        component: 'core/mura/publisher.cfc',
        method: 'getToWorkUsers',
        trigger: 'appstart',
        condition: 'runs only on upgrade from an older version',
      },
      'startup-db-updates',
    ],
    [
      'a condition ahead of a later component entry',
      {
        component: SETTINGS_DAO,
        method: 'update',
        trigger: 'appstart',
        condition: 'ProjectSiteID is not default and that site does not exist (core/appcfc/onApplicationStart_include.cfm:771)',
      },
      'startup-project-site',
    ],
    [
      'a component and method without a condition',
      { component: SETTINGS_DAO, method: 'update', trigger: 'appstart', condition: null },
      'startup-theme-site-sizes',
    ],
  ])('matches on %s', (_case, writer, id) => {
    expect(isPreventedWriter(writer)?.id).toBe(id);
  });

  it.each<[string, WriterRecord]>([
    ['an unknown component', { component: 'core/mura/x.cfc', trigger: 'thread' }],
    [
      'a request trigger',
      { component: 'core/appcfc/onApplicationStart_include.cfm', trigger: 'request', source: { lines: [561, 575] } },
    ],
    [
      'a different trigger',
      { component: 'core/appcfc/onApplicationStart_include.cfm', trigger: 'scheduler', source: { lines: [561, 575] } },
    ],
    [
      'a different method',
      { component: 'core/mura/content/contentServer.cfc', method: 'renderFilename', trigger: 'scheduler', source: { lines: [669, 747] } },
    ],
    [
      'a missing method where the entry names one',
      { component: 'legacy-fixtures/cfml/modules/surveys.cfc', trigger: 'scheduler', source: { lines: [37, 42] } },
    ],
    [
      'disjoint lines',
      { component: 'core/appcfc/onApplicationStart_include.cfm', trigger: 'appstart', source: { lines: [576, 891] } },
    ],
    ['missing lines where the entry names a span', { component: 'core/appcfc/onApplicationStart_include.cfm', trigger: 'appstart' }],
    [
      'an unparseable line string',
      { component: 'core/appcfc/onApplicationStart_include.cfm', trigger: 'appstart', source: { lines: 'line 561' } },
    ],
    [
      'a condition that differs from the entry',
      { component: 'core/mura/publisher.cfc', trigger: 'appstart', condition: 'runs only on upgrade from an older version.' },
    ],
    [
      'a null condition where the entry names one',
      { component: 'core/mura/dbUpdates/5.2.0.cfm', trigger: 'appstart', condition: null },
    ],
    [
      'a matching condition under another trigger',
      { component: 'core/mura/publisher.cfc', trigger: 'scheduler', condition: 'runs only on upgrade from an older version' },
    ],
    [
      'another settingsDAO method without a condition',
      { component: SETTINGS_DAO, method: 'create', trigger: 'appstart', condition: null },
    ],
    [
      'the theme-config image-size upsert',
      {
        component: 'core/mura/settings/settingsImageSizeBean.cfc',
        method: 'save',
        trigger: 'appstart',
        condition: null,
        source: { lines: [190, 190] },
      },
    ],
  ])('returns undefined for %s', (_case, writer) => {
    expect(isPreventedWriter(writer)).toBeUndefined();
  });
});
