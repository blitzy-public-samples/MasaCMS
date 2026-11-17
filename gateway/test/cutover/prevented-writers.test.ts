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
// A table writer records the bare id of the reviewed override it comes from.
const OVERRIDE_PREFIX = 'wov:';

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
const PUBLISHER = 'core/mura/publisher.cfc';
const EXTEND_MANAGER = 'core/mura/extend/extendManager.cfc';
const SITEMONITOR_RUN = 'sitemonitor:run';
const STARTUP = 'application.setupComplete';
const BUNDLE_GUARD = 'fileExists(local.bundleLoc) && application.contentGateway.getPageCount(projectSiteID).counter == 1';
const PROJECT_SITE_GUARD = "projectSiteID != 'default' && !application.settingsManager.siteExists(projectSiteID)";
const PLUGIN_GUARD = 'application.configBean.getValue("autoDiscoverPlugins") && !isdefined("url.safemode")';
// The generator records no writer these entries close: the dbUpdates include is an unresolved call (finding
// fe:appreload), and only the siteMonitor run, never start-up, reaches the fromMuraTrash re-saves.
const NO_GENERATED_RECORD = ['startup-db-updates', 'trash-restore-bean'];

/** Whether an appstart record's condition opens with the start-up branch `guard` reaching it. */
const inStartupBranch = (writer: InventoryWriter, guard: string): boolean =>
  writer.trigger === 'appstart' && writer.condition !== null && `${writer.condition} && `.startsWith(`${STARTUP} && ${guard} && `);

/** Expected resolution of the generated records each conditionIncludes, routeKey or statement match is written for. */
const GENERATED_RULES: ReadonlyArray<{ id: string; clause: string; selects: (writer: InventoryWriter) => boolean }> = [
  {
    id: 'native-sitemonitor-task',
    clause: 'scheduler writers the siteMonitor run reaches',
    selects: (writer) => writer.trigger === 'scheduler' && writer.routeKeys.includes(SITEMONITOR_RUN),
  },
  { id: 'startup-deploy-bundle', clause: 'the deploy-bundle branch', selects: (writer) => inStartupBranch(writer, BUNDLE_GUARD) },
  {
    id: 'startup-deploy-bundle',
    clause: 'the reviewed bundleable-bean save at start-up',
    selects: (writer) => writer.trigger === 'appstart' && writer.override === 'wov:sql-bundle-restore-bundleable-save',
  },
  { id: 'startup-project-site', clause: 'the project-site branch', selects: (writer) => inStartupBranch(writer, PROJECT_SITE_GUARD) },
  { id: 'startup-plugin-discovery', clause: 'the plugin-discovery branch', selects: (writer) => inStartupBranch(writer, PLUGIN_GUARD) },
  {
    id: 'startup-theme-site-sizes',
    clause: 'the reviewed theme-config site save at start-up',
    selects: (writer) =>
      writer.trigger === 'appstart' &&
      ['wov:ext-loadconfigxml-site-save', 'wov:ext-loadconfigxml-site-razuna-save'].includes(writer.override ?? ''),
  },
];

/** Inventory records whose reviewed override names the prevented-writer id. */
const reviewedRecords = (id: string): InventoryWriter[] =>
  writerRows.filter(({ writer }) => writer.override === `${OVERRIDE_PREFIX}${id}`).map(({ writer }) => writer);

const reviewedRows = nonRequestRows.filter(({ writer }) => OVERRIDE_REVIEWED.some((id) => writer.override === `${OVERRIDE_PREFIX}${id}`));

/** Id of the reviewed record whose span holds this extracted statement on its table, component and trigger. */
const reviewingId = (table: string, writer: InventoryWriter): string | undefined =>
  reviewedRows
    .find(
      (row) =>
        row.table === table &&
        row.writer.component === writer.component &&
        row.writer.trigger === writer.trigger &&
        row.writer.source.lines[0] <= writer.source.lines[0] &&
        writer.source.lines[1] <= row.writer.source.lines[1],
    )
    ?.writer.override?.slice(OVERRIDE_PREFIX.length);

/** Id of the entry a non-request inventory record must resolve to, or `undefined`. */
function expectedEntry(table: string, writer: InventoryWriter): string | undefined {
  const reviewed = OVERRIDE_REVIEWED.find((id) => writer.override === `${OVERRIDE_PREFIX}${id}`);
  if (reviewed !== undefined) return reviewed;
  if (table === 'synthetic.export_job' && writer.trigger === 'thread') return 'fixture-export-threads';
  const inSpan = reviewingId(table, writer);
  if (inSpan !== undefined) return inSpan;
  const byCondition = conditionEntries.find(
    (entry) => entry.trigger === writer.trigger && entry.match.condition === writer.condition,
  );
  if (byCondition !== undefined) return byCondition.id;
  return GENERATED_RULES.find((rule) => rule.selects(writer))?.id;
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
      if (entry.match.conditionIncludes) expect(Object.isFrozen(entry.match.conditionIncludes)).toBe(true);
      if (entry.alsoMatch) expect(Object.isFrozen(entry.alsoMatch)).toBe(true);
      for (const match of entry.alsoMatch ?? []) expect(Object.isFrozen(match)).toBe(true);
    }
  });

  it.each(PREVENTED_WRITERS.filter((entry) => !NO_GENERATED_RECORD.includes(entry.id)).map((entry) => [entry.id] as const))(
    '%s matches at least one non-request inventory writer',
    (id) => {
      expect(nonRequestRows.some(({ writer }) => isPreventedWriter(writer)?.id === id)).toBe(true);
    },
  );

  it.each(NO_GENERATED_RECORD.map((id) => [id] as const))('%s matches no generated inventory writer', (id) => {
    expect(nonRequestRows.filter(({ writer }) => isPreventedWriter(writer)?.id === id)).toEqual([]);
  });

  it.each(GENERATED_RULES.map((rule) => [rule.id, rule.clause, rule] as const))(
    '%s matches every inventory writer of %s, and there is one',
    (id, _clause, rule) => {
      const records = nonRequestRows.filter(({ writer }) => rule.selects(writer)).map(({ writer }) => writer);
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) expect(isPreventedWriter(record)?.id).toBe(id);
    },
  );

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

  // The generated inventory records each writer's extracted branch condition, so it may record none of these reviewed ones.
  it.each(conditionEntries.map((entry) => [entry.id, entry] as const))(
    '%s matches every non-request inventory writer recording its condition',
    (id, entry) => {
      const records = nonRequestRows.filter(({ writer }) => writer.condition === entry.match.condition).map(({ writer }) => writer);
      for (const record of records) {
        expect(record.trigger).toBe(entry.trigger);
        expect(isPreventedWriter(record)?.id).toBe(id);
      }
    },
  );

  it('matches every thread writer of synthetic.export_job', () => {
    const threadRows = nonRequestRows.filter(({ table, writer }) => table === 'synthetic.export_job' && writer.trigger === 'thread');
    expect(threadRows.map(({ writer }) => writer.component)).toContain('legacy-fixtures/cfml/modules/reporting.cfc');
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
      'an alsoMatch component',
      {
        component: 'legacy-fixtures/sql/reporting/200_usp_export_job_transition.sql',
        method: '(template)',
        trigger: 'thread',
        source: { lines: [50, 59] },
      },
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
      'guard conjuncts of a start-up branch',
      { component: PUBLISHER, trigger: 'appstart', condition: `${STARTUP} && ${BUNDLE_GUARD} && len(arguments.toSiteID)` },
      'startup-deploy-bundle',
    ],
    [
      'guard conjuncts in every disjunct, in any order',
      {
        component: 'core/mura/content/contentUtility.cfc',
        trigger: 'appstart',
        condition: `${STARTUP} && ${PROJECT_SITE_GUARD} && a || !application.settingsManager.siteExists(projectSiteID) && (b || c) && projectSiteID != 'default'`,
      },
      'startup-project-site',
    ],
    [
      'guard conjuncts ahead of a later component entry',
      { component: SETTINGS_DAO, method: 'update', trigger: 'appstart', condition: `${STARTUP} && ${PROJECT_SITE_GUARD} && x` },
      'startup-project-site',
    ],
    [
      'guard conjuncts with quoted text',
      { component: 'core/mura/plugin/pluginManager.cfc', trigger: 'appstart', condition: `${STARTUP} && ${PLUGIN_GUARD} && name neq '.svn'` },
      'startup-plugin-discovery',
    ],
    [
      'a route key among several',
      {
        component: 'core/mura/content/changeset/changesetManager.cfc',
        method: 'publish',
        trigger: 'scheduler',
        routeKeys: ['admin:cchangesets.publish', SITEMONITOR_RUN],
      },
      'native-sitemonitor-task',
    ],
    [
      'the bundleable-bean save statement',
      { component: PUBLISHER, method: 'getToWork', trigger: 'appstart', source: { lines: [171, 190] } },
      'startup-deploy-bundle',
    ],
    [
      'the theme-config site save statement',
      { component: EXTEND_MANAGER, method: 'loadConfigXML', trigger: 'appstart', source: { lines: [2016, 2018] } },
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
    ['settingsDAO.update outside a closed branch', { component: SETTINGS_DAO, method: 'update', trigger: 'appstart', condition: null }],
    [
      'the theme-config image-size upsert',
      {
        component: 'core/mura/settings/settingsImageSizeBean.cfc',
        method: 'save',
        trigger: 'appstart',
        condition: `${STARTUP} && len(variables.themeConfig) && IsValid('xml', variables.themeConfig)`,
        source: { lines: [190, 195] },
      },
    ],
    [
      'another theme-config statement',
      { component: EXTEND_MANAGER, method: 'loadConfigXML', trigger: 'appstart', source: { lines: [1943, 1957] } },
    ],
    ['a null condition where the entry names guard conjuncts', { component: PUBLISHER, trigger: 'appstart', condition: null }],
    [
      'one of two guard conjuncts',
      { component: SETTINGS_DAO, method: 'create', trigger: 'appstart', condition: `${STARTUP} && projectSiteID != 'default' && x` },
    ],
    [
      'guard conjuncts missing from one disjunct',
      { component: PUBLISHER, trigger: 'appstart', condition: `${STARTUP} && ${BUNDLE_GUARD} && a || b` },
    ],
    ['guard conjuncts inside a negation', { component: PUBLISHER, trigger: 'appstart', condition: `${STARTUP} && !(${BUNDLE_GUARD})` }],
    [
      'guard conjuncts inside quoted text',
      { component: PUBLISHER, trigger: 'appstart', condition: `${STARTUP} && x eq ' && ${BUNDLE_GUARD} && '` },
    ],
    ['guard conjuncts under another trigger', { component: PUBLISHER, trigger: 'scheduler', condition: `${STARTUP} && ${BUNDLE_GUARD}` }],
    [
      'route keys without the siteMonitor run',
      { component: 'core/mura/content/changeset/changesetManager.cfc', trigger: 'scheduler', routeKeys: ['admin:cchangesets.publish'] },
    ],
    ['the siteMonitor route key under another trigger', { component: PUBLISHER, trigger: 'appstart', routeKeys: [SITEMONITOR_RUN] }],
  ])('returns undefined for %s', (_case, writer) => {
    expect(isPreventedWriter(writer)).toBeUndefined();
  });
});
