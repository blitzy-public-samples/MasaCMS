// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Row builders and sample rows of the reporting suites: target rows, producer wire rows and legacy fixture rows. */
import { Buffer } from 'node:buffer';
import { cfUuid, isCfUuid } from '@opt2/platform/legacy-compat';
import { formatCanonicalTimestamp, sha256Hex, type CanonicalValue } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { BUSINESS_DATE, TENANT_A, TENANT_B, TENANT_LIST, type TenantFixture } from '@opt2/platform/testing';
import type { ExportError } from '../../src/domain/job-state.js';
import { extensionFor } from '../../src/domain/writers/index.js';
import type { components as FinanceComponents } from '../../src/generated/clients/finance.js';
import type { components as TimesheetsComponents } from '../../src/generated/clients/timesheets.js';
import {
  EXPORT_DEFINITION,
  EXPORT_JOB,
  EXPORT_SOURCES,
  exportObjectKey,
  type ExportDefinitionRow,
  type ExportFormat,
  type ExportJobRow,
  type ExportSource,
  type ExportState,
} from '../../src/repo/tables.js';
import { REQUESTER, TEST_CLOCK, type SeedTable, type TestApp } from './app.js';

/** A row of the timesheets `listSheetStatus` export read. */
export type SheetStatusRow = TimesheetsComponents['schemas']['SheetStatusRow'];

/** A row of the finance `listRecords` export read. */
export type FinanceRecord = FinanceComponents['schemas']['FinanceRecord'];

/** A fixture-table row keyed by legacy column name, in catalog order, with the canonical values a migration apply decodes. */
type LegacyRow = Readonly<Record<string, CanonicalValue>>;

/** Masa UserID every built job is requested by: the reporting exporter whose tokens `headersFor` mints. */
export const SAMPLE_REQUESTER_ID: string = REQUESTER.sub;

/** Name and source columns of each source's definition, as the seed generator writes its first definitions. */
const DEFINITION_TEMPLATES: Readonly<Record<ExportSource, { name: string; columns: readonly string[] }>> = Object.freeze({
  'timesheets.sheets': { name: 'Timesheet status', columns: ['timesheet_id', 'person_id', 'period_start', 'status', 'overdue'] },
  'finance.records': { name: 'Finance records', columns: ['record_id', 'title', 'amount', 'period', 'state'] },
  broken: { name: 'Archived ledger extract', columns: ['ledger_id'] },
});

/** Content type of each format's output, as `reporting.cfc` and the writers store it. */
const CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = Object.freeze({
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  pdf: 'application/pdf',
});

/** Row version a job holds in each state: inserted at 1, then one more per state move. */
const ROW_VERSIONS: Readonly<Record<ExportState, string>> = Object.freeze({ queued: '1', running: '2', done: '3', failed: '3' });

/** `row` with its keys in the column order of `def`. */
function inColumnOrder<T extends Record<string, unknown>>(def: { readonly columns: readonly { readonly name: string }[] }, row: T): T {
  return Object.fromEntries(def.columns.map(({ name }) => [name, row[name]])) as T;
}

/** CF UUID of the first 32 hex digits of SHA-256(`<siteId>:<source>`), upper-cased, so every suite names the same definition. */
function definitionIdFor(siteId: string, source: ExportSource): string {
  const hex = sha256Hex(`${siteId}:${source}`).slice(0, 32).toUpperCase();
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16)}`;
  if (!isCfUuid(id)) throw new Error(`definition id ${id} of ${siteId}:${source} is not a CF UUID`);
  return id;
}

/** The `reporting.export_definition` row of `tenant` reading `source`, with a deterministic id; `overrides` replace any column. */
export function definitionFor(tenant: TenantFixture, source: ExportSource, overrides: Partial<ExportDefinitionRow> = {}): ExportDefinitionRow {
  const template = DEFINITION_TEMPLATES[source];
  return inColumnOrder<ExportDefinitionRow>(EXPORT_DEFINITION, {
    tenant_id: tenantIdForSite(tenant.siteId),
    definition_id: definitionIdFor(tenant.siteId, source),
    siteid: tenant.siteId,
    name: template.name,
    source,
    columns: JSON.stringify(template.columns),
    ...overrides,
  });
}

/** Options of {@link jobFor}: `at` is the job's creation time (the test clock by default); any other job column may be overridden. */
export type JobOptions = {
  format: ExportFormat;
  state?: ExportState;
  jobId?: string;
  requestedById?: string;
  error?: ExportError;
  at?: Date;
} & Partial<ExportJobRow>;

/**
 * A `reporting.export_job` row of `definition` in `opts.state` (queued by default), run at its creation time. A done job carries the
 * writer's file name and content type, its export object key and a placeholder SHA-256; override `output_sha256` with that of stored bytes.
 */
export function jobFor(definition: ExportDefinitionRow, opts: JobOptions): ExportJobRow {
  const { format, state = 'queued', jobId = cfUuid(), requestedById = SAMPLE_REQUESTER_ID, error, at = TEST_CLOCK.now(), ...overrides } = opts;
  const ran = state !== 'queued';
  const finished = state === 'done' || state === 'failed';
  const done = state === 'done';
  const ext = extensionFor(format);
  const fileName = `export-${jobId}.${ext}`;
  return inColumnOrder<ExportJobRow>(EXPORT_JOB, {
    tenant_id: definition.tenant_id,
    job_id: jobId,
    siteid: definition.siteid,
    definition_id: definition.definition_id,
    format,
    state,
    requested_by_id: requestedById,
    created: new Date(at.getTime()),
    started_at: ran ? new Date(at.getTime()) : null,
    finished_at: finished ? new Date(at.getTime()) : null,
    error: error ?? (state === 'failed' ? 'export-failed' : null),
    file_name: done ? fileName : null,
    content_type: done ? CONTENT_TYPES[format] : null,
    object_key: done ? exportObjectKey(definition.tenant_id, jobId, ext) : null,
    output_sha256: done ? sha256Hex(fileName) : null,
    row_version: ROW_VERSIONS[state],
    ...overrides,
  });
}

/** Definitions {@link seedDefinitions} seeded, by tenant fixture key and then source. */
export type SeededDefinitions = Record<TenantFixture['key'], Record<ExportSource, ExportDefinitionRow>>;

/** Seeds one definition per source for each of tenant-a, tenant-b and umbrella, and returns them by tenant key and source. */
export async function seedDefinitions(handle: Pick<TestApp, 'seed'>): Promise<SeededDefinitions> {
  const seeded = Object.fromEntries(
    TENANT_LIST.map((tenant) => [tenant.key, Object.fromEntries(EXPORT_SOURCES.map((source) => [source, definitionFor(tenant, source)]))]),
  ) as SeededDefinitions;
  // The catalogue types its table name as a plain string; it is one of the owned tables the seed accepts.
  await handle.seed(EXPORT_DEFINITION.table as SeedTable, Object.values(seeded).flatMap((bySource) => Object.values(bySource)));
  return seeded;
}

/** `YYYY-MM-DDT<time>` of the calendar day `days` before the business date. */
function beforeBusinessDate(days: number, time = '00:00:00'): string {
  const day = new Date(`${BUSINESS_DATE}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return `${day.toISOString().slice(0, 10)}T${time}`;
}

/** A tenant-a sheet of five days starting on the Monday `daysBefore` days before the business date. */
function sheetRow(
  status: SheetStatusRow['status'],
  daysBefore: number,
  counts: Pick<SheetStatusRow, 'overdue' | 'blackoutCount' | 'approvedCount'>,
): SheetStatusRow {
  return {
    timesheetId: cfUuid(),
    siteId: TENANT_A.siteId,
    personId: cfUuid(),
    periodStart: beforeBusinessDate(daysBefore),
    status,
    overdue: counts.overdue,
    dayCount: 5,
    blackoutCount: counts.blackoutCount,
    approvedCount: counts.approvedCount,
  };
}

/** tenant-a sheet status rows in the producer's period order, one per sheet status, with an overdue and a current DRAFT. */
export const SAMPLE_SHEET_STATUS: readonly SheetStatusRow[] = Object.freeze([
  sheetRow('DRAFT', 36, { overdue: true, blackoutCount: 0, approvedCount: 0 }),
  sheetRow('APPROVED', 29, { overdue: false, blackoutCount: 1, approvedCount: 4 }),
  sheetRow('RETURNED', 22, { overdue: false, blackoutCount: 0, approvedCount: 1 }),
  sheetRow('PARTIALLY_APPROVED', 15, { overdue: false, blackoutCount: 0, approvedCount: 2 }),
  sheetRow('SUBMITTED', 8, { overdue: false, blackoutCount: 1, approvedCount: 0 }),
  sheetRow('DRAFT', 1, { overdue: false, blackoutCount: 0, approvedCount: 0 }),
]);

const PREPARER_ID = cfUuid();
const APPROVER_ID = cfUuid();

/** A tenant-a record of the business month created by the preparer; without `updated` its last-update columns are NULL (''). */
function financeRecord(
  fields: Pick<FinanceRecord, 'title' | 'amount' | 'state' | 'version' | 'created'> & { updated?: { at: string; by: string } },
): FinanceRecord {
  return {
    record_id: cfUuid(),
    siteid: TENANT_A.siteId,
    title: fields.title,
    amount: fields.amount,
    period: BUSINESS_DATE.slice(0, 7),
    state: fields.state,
    version: fields.version,
    created: fields.created,
    createdbyid: PREPARER_ID,
    lastupdate: fields.updated?.at ?? '',
    lastupdatebyid: fields.updated?.by ?? '',
  };
}

/** tenant-a finance records in the producer's `created` order, one per lifecycle state, with zero and large amounts. */
export const SAMPLE_FINANCE_RECORDS: readonly FinanceRecord[] = Object.freeze([
  financeRecord({ title: 'Office supplies', amount: '0.0000', state: 'IN-PROGRESS', version: 1, created: beforeBusinessDate(20, '09:00:00') }),
  financeRecord({
    title: 'Quarterly travel',
    amount: '1250.0000',
    state: 'SUBMITTED',
    version: 2,
    created: beforeBusinessDate(18, '10:30:00'),
    updated: { at: beforeBusinessDate(17, '14:00:00'), by: PREPARER_ID },
  }),
  financeRecord({
    title: 'Equipment lease',
    amount: '99999.9999',
    state: 'RE-SUBMITTED',
    version: 4,
    created: beforeBusinessDate(15, '08:45:00'),
    updated: { at: beforeBusinessDate(5, '16:20:00'), by: PREPARER_ID },
  }),
  financeRecord({
    title: 'Conference fees',
    amount: '342.7500',
    state: 'APPROVED',
    version: 3,
    created: beforeBusinessDate(12, '11:05:00'),
    updated: { at: beforeBusinessDate(10, '09:40:00'), by: APPROVER_ID },
  }),
  financeRecord({
    title: 'Catering',
    amount: '18.9900',
    state: 'REJECTED',
    version: 3,
    created: beforeBusinessDate(9, '15:30:00'),
    updated: { at: beforeBusinessDate(8, '10:10:00'), by: APPROVER_ID },
  }),
]);

/** Canonical `t` text of the test clock's time, the form a decoded apply row carries. */
const LEGACY_NOW = formatCanonicalTimestamp(TEST_CLOCK.now());

const SHEETS_A = definitionFor(TENANT_A, 'timesheets.sheets');
const FINANCE_B = definitionFor(TENANT_B, 'finance.records');
const BROKEN_B = definitionFor(TENANT_B, 'broken');

/** The `synthetic.export_definition` row the target `row` was migrated from. */
function legacyDefinitionRow(row: ExportDefinitionRow): LegacyRow {
  return Object.freeze({ definition_id: row.definition_id, siteID: row.siteid, name: row.name, source: row.source, columns: row.columns });
}

/** `synthetic.export_definition` rows: tenant-a and tenant-b definitions equal to their {@link definitionFor} rows, then an orphan. */
export const LEGACY_EXPORT_DEFINITION_ROWS: readonly LegacyRow[] = Object.freeze([
  legacyDefinitionRow(SHEETS_A),
  legacyDefinitionRow(FINANCE_B),
  legacyDefinitionRow(BROKEN_B),
  // The fixture's siteID is NOT NULL, here and in the target, so the orphan names no site with an empty siteID rather than NULL.
  legacyDefinitionRow({ ...SHEETS_A, definition_id: cfUuid(), siteid: '' }),
]);

/** Fixture `varbinary(max)` output of the done legacy job. */
const LEGACY_OUTPUT = Buffer.from('timesheet_id,status\r\n1,SUBMITTED\r\n');

/** A `synthetic.export_job` row of `definition` run at the test clock's time, with its `output` bytes and their SHA-256 when it has any. */
function legacyJobRow(
  definition: ExportDefinitionRow,
  { format, state, output = null, error = null }: { format: ExportFormat; state: ExportState; output?: Buffer | null; error?: ExportError | null },
): LegacyRow {
  const jobId = cfUuid();
  const done = state === 'done';
  return Object.freeze({
    job_id: jobId,
    siteID: definition.siteid,
    definition_id: definition.definition_id,
    format,
    state,
    requested_by_id: SAMPLE_REQUESTER_ID,
    created: LEGACY_NOW,
    started_at: state === 'queued' ? null : LEGACY_NOW,
    finished_at: done || state === 'failed' ? LEGACY_NOW : null,
    error,
    file_name: done ? `export-${jobId}.${extensionFor(format)}` : null,
    content_type: done ? CONTENT_TYPES[format] : null,
    output,
    output_sha256: output === null ? null : sha256Hex(output),
  });
}

/** `synthetic.export_job` rows of the legacy definitions: a done CSV job with output bytes, a queued job and a failed one. */
export const LEGACY_EXPORT_JOB_ROWS: readonly LegacyRow[] = Object.freeze([
  legacyJobRow(SHEETS_A, { format: 'csv', state: 'done', output: LEGACY_OUTPUT }),
  legacyJobRow(FINANCE_B, { format: 'xlsx', state: 'queued' }),
  legacyJobRow(BROKEN_B, { format: 'pdf', state: 'failed', error: 'source-unavailable' }),
]);

/**
 * Masa `tsessiontracking` rows with all 20 columns: a logged-in tenant-a visit, an anonymous tenant-b visit and a visit with no site.
 * NULL and '' follow `sessionTrackingDAO.createTrackingRecord`, which writes empty ids, keywords and names as NULL.
 */
export const LEGACY_SESSION_TRACKING_ROWS: readonly LegacyRow[] = Object.freeze([
  Object.freeze({
    trackingID: '1',
    contentID: cfUuid(),
    siteID: TENANT_A.siteId,
    userid: cfUuid(),
    remote_addr: '203.0.113.10',
    server_name: 'localhost',
    query_string: 'siteid=tenant-a',
    referer: 'http://localhost/tenant-a/',
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64)',
    script_name: '/index.cfm',
    urlToken: 'CFID=1001&CFTOKEN=10010001',
    entered: LEGACY_NOW,
    country: 'Unknown',
    lang: 'Unknown',
    locale: 'en_US',
    keywords: 'quarterly report',
    originalUrlToken: 'CFID=1001&CFTOKEN=10010001',
    fname: 'Ada',
    lname: 'Lovelace',
    company: 'Analytical Engines',
  }),
  Object.freeze({
    trackingID: '2',
    contentID: cfUuid(),
    siteID: TENANT_B.siteId,
    userid: null,
    remote_addr: '198.51.100.20',
    server_name: 'localhost',
    query_string: '',
    referer: '',
    user_agent: 'curl/8.5.0',
    script_name: '/index.cfm',
    urlToken: 'CFID=1002&CFTOKEN=10020002',
    entered: LEGACY_NOW,
    country: 'Unknown',
    lang: 'Unknown',
    locale: 'en_US',
    keywords: null,
    originalUrlToken: 'CFID=1002&CFTOKEN=10020002',
    fname: null,
    lname: null,
    company: null,
  }),
  Object.freeze({
    trackingID: '3',
    contentID: null,
    siteID: null,
    userid: null,
    remote_addr: '192.0.2.30',
    server_name: 'localhost',
    query_string: '',
    referer: '',
    user_agent: '',
    script_name: '/index.cfm',
    urlToken: 'CFID=1003&CFTOKEN=10030003',
    entered: LEGACY_NOW,
    country: 'Unknown',
    lang: 'Unknown',
    locale: 'en_US',
    keywords: null,
    originalUrlToken: 'CFID=1003&CFTOKEN=10030003',
    fname: null,
    lname: null,
    company: null,
  }),
]);
