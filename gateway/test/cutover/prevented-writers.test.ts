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

/** Inventory records whose reviewed override names the prevented-writer id. */
const reviewedRecords = (id: string): InventoryWriter[] =>
  writerRows.filter(({ writer }) => writer.override === `${OVERRIDE_PREFIX}${id}`).map(({ writer }) => writer);

describe('PREVENTED_WRITERS', () => {
  it('is the closed list of five mechanisms, in order', () => {
    expect(ids).toEqual([
      'scheduler-registration',
      'native-sitemonitor-task',
      'fixture-survey-tasks',
      'fixture-export-threads',
      'startup-url-conversion',
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

  it.each(PREVENTED_WRITERS.map((entry) => [entry.id, entry] as const))(
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

  it('matches every thread writer of synthetic.export_job, the job procedure included', () => {
    const threadRows = nonRequestRows.filter(({ table, writer }) => table === 'synthetic.export_job' && writer.trigger === 'thread');
    expect(threadRows.map(({ writer }) => writer.component)).toContain(
      'legacy-fixtures/sql/reporting/200_usp_export_job_transition.sql',
    );
    for (const { writer } of threadRows) expect(isPreventedWriter(writer)?.id).toBe('fixture-export-threads');
  });

  it('matches no other non-request inventory writer', () => {
    const unexpected = nonRequestRows.filter(({ table, writer }) => {
      const reviewed = ids.some((id) => writer.override === `${OVERRIDE_PREFIX}${id}`);
      const exportThread = table === 'synthetic.export_job' && writer.trigger === 'thread';
      return !reviewed && !exportThread && isPreventedWriter(writer) !== undefined;
    });
    expect(unexpected).toEqual([]);
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
  ])('returns undefined for %s', (_case, writer) => {
    expect(isPreventedWriter(writer)).toBeUndefined();
  });
});
