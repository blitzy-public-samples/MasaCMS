// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export sources: the finance and timesheets reads of an export job, projected into the table the fixture runner writes. */
import { ServiceUnavailableError, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import type { paths as FinancePaths } from '../generated/clients/finance.js';
import type { paths as TimesheetsPaths } from '../generated/clients/timesheets.js';
import { EXPORT_SOURCES, type ExportDefinitionRow, type ExportJobRow, type ExportSource } from '../repo/tables.js';
import type { ReportingDeps } from './deps.js';

/** One definition column: `field` names a source column, matched case-insensitively; `label` heads the column as written. */
export interface ExportColumn {
  field: string;
  label: string;
}

/** One exported value in the fixture runner's string form; NULL is the empty string, so no cell is null or numeric. */
export type ExportCell = string;

/** A titled export table: one header label per column, then the rows, each aligned with `columns`, read from the source as they are consumed. */
export interface ExportTableStream {
  title: string;
  columns: readonly ExportColumn[];
  rows: AsyncIterable<readonly ExportCell[]>;
}

/** Inputs of {@link openExportTable}: the job as its run claimed it, its definition and the business date its source is read as of. */
export interface FetchExportTableInput {
  job: ExportJobRow;
  definition: ExportDefinitionRow;
  asOf: string;
}

/** The export's source could not be read: a `broken` source, an unreachable producer or a non-2xx answer. */
export class SourceUnavailableError extends Error {
  override readonly name: string = 'SourceUnavailableError';
  /** The producer's HTTP status, when it answered. */
  readonly status: number | undefined;

  constructor(
    readonly source: ExportSource,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(
      options.status === undefined
        ? `Export source ${source} is unavailable`
        : `Export source ${source} answered HTTP ${String(options.status)}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.status = options.status;
  }
}

/** Parses `export_definition.columns`, a JSON array of source column names; throws on malformed JSON or any other shape. */
export function parseDefinitionColumns(columnsJson: string): ExportColumn[] {
  const parsed: unknown = JSON.parse(columnsJson);
  if (!Array.isArray(parsed) || !parsed.every((name): name is string => typeof name === 'string')) {
    throw new TypeError('Export columns are not an array of column names');
  }
  return parsed.map((name) => ({ field: name, label: name }));
}

const SHEET_STATUS_PATH = '/internal/v1/timesheets/sheet-status' satisfies keyof TimesheetsPaths;
const FINANCE_RECORDS_PATH = '/internal/v1/finance/records' satisfies keyof FinancePaths;

type SheetStatusPage = TimesheetsPaths[typeof SHEET_STATUS_PATH]['get']['responses'][200]['content']['application/json'];
type SheetStatusRow = SheetStatusPage['items'][number];
type FinanceRecordPage = FinancePaths[typeof FINANCE_RECORDS_PATH]['get']['responses'][200]['content']['application/json'];
type FinanceRecord = FinanceRecordPage['data'][number];

// envelope.cfc's page maximum, the finance export read's pageSize maximum.
const FINANCE_PAGE_SIZE = 1000;
// The timesheets contract's itemsPerPage maximum.
const SHEET_STATUS_PAGE_SIZE = 1000;

/** Cell reader of each column of a source's result set, keyed by the lower-cased column name. */
type SourceCells<R> = Readonly<Record<string, (row: R) => ExportCell>>;

// The producers already answer in the runner's value forms (fixture datetimes, four-decimal money, CF UUIDs, '' for NULL),
// so cells pass through and no legacy date formatting is applied here.
/** `tvf_timesheet_status` columns; `overdue` is a tinyint there, written as 1 or 0. */
const SHEET_CELLS: SourceCells<SheetStatusRow> = {
  timesheet_id: (row) => row.timesheetId,
  siteid: (row) => row.siteId,
  person_id: (row) => row.personId,
  period_start: (row) => row.periodStart,
  status: (row) => row.status,
  overdue: (row) => (row.overdue ? '1' : '0'),
  day_count: (row) => String(row.dayCount),
  blackout_count: (row) => String(row.blackoutCount),
  approved_count: (row) => String(row.approvedCount),
};

/** `finance_record` columns. */
const FINANCE_CELLS: SourceCells<FinanceRecord> = {
  record_id: (row) => row.record_id,
  siteid: (row) => row.siteid,
  title: (row) => row.title,
  amount: (row) => row.amount,
  period: (row) => row.period,
  state: (row) => row.state,
  version: (row) => String(row.version),
  created: (row) => row.created,
  createdbyid: (row) => row.createdbyid,
  lastupdate: (row) => row.lastupdate,
  lastupdatebyid: (row) => row.lastupdatebyid,
};

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT']);

/** Whether `err` is a connection-level failure: a Node network error, an undici error or a timeout. */
function isConnectionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const { code } = err as NodeJS.ErrnoException;
  return err.name === 'TimeoutError' || (typeof code === 'string' && (NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_')));
}

/** Sends one read to a source's producer and returns its 2xx body; an unreachable or refusing producer is a SourceUnavailableError. */
async function readSource<T>(deps: Pick<ReportingDeps, 'client'>, source: ExportSource, request: ServiceRequest): Promise<T> {
  let response: ServiceResponse<T>;
  try {
    response = await deps.client.request<T>(request);
  } catch (err) {
    // ServiceUnavailableError is a LegacyServiceUnavailableError, which the runner retries; an unreadable source fails the job instead.
    if (err instanceof ServiceUnavailableError || isConnectionFailure(err)) throw new SourceUnavailableError(source, { cause: err });
    throw err;
  }
  if (response.status < 200 || response.status > 299) throw new SourceUnavailableError(source, { status: response.status });
  return response.body;
}

/** The job and business date a source read takes from {@link FetchExportTableInput}. */
type SourceReadInput = Pick<FetchExportTableInput, 'job' | 'asOf'>;

/**
 * The export scope every source read names: the job, its site and the row version its run claimed it at, which the producer has
 * reporting confirm before it reads that site's tenant.
 */
function exportScope({ job }: SourceReadInput): Record<string, string> {
  return { exportId: job.job_id, siteId: job.siteid, claim: job.row_version };
}

// A Cloud Tasks run acts as System: each read carries only reporting's invocation credential, never a user token.
/** Page `pageIndex` of the tenant's sheet status rows as of the input's `asOf`, in the producer's order. */
function readSheetStatusPage(deps: Pick<ReportingDeps, 'client'>, input: SourceReadInput, pageIndex: number): Promise<SheetStatusPage> {
  return readSource<SheetStatusPage>(deps, 'timesheets.sheets', {
    service: 'timesheets',
    method: 'GET',
    path: SHEET_STATUS_PATH,
    query: { ...exportScope(input), asOf: input.asOf, pageIndex: String(pageIndex), itemsPerPage: String(SHEET_STATUS_PAGE_SIZE) },
    userToken: null,
  });
}

/** Every sheet status row of the tenant: those of `first`, then each later page, read once the rows before it are consumed. */
async function* sheetStatusRows(
  deps: Pick<ReportingDeps, 'client'>,
  input: SourceReadInput,
  first: SheetStatusPage,
): AsyncGenerator<SheetStatusRow> {
  let body = first;
  let read = 0;
  for (let pageIndex = 1; ; pageIndex += 1) {
    yield* body.items;
    read += body.items.length;
    if (body.items.length === 0 || read >= body.total) return;
    body = await readSheetStatusPage(deps, input, pageIndex + 1);
  }
}

/** Page `page` of the tenant's finance records, in the producer's order. */
function readFinancePage(deps: Pick<ReportingDeps, 'client'>, input: SourceReadInput, page: number): Promise<FinanceRecordPage> {
  return readSource<FinanceRecordPage>(deps, 'finance.records', {
    service: 'finance',
    method: 'GET',
    path: FINANCE_RECORDS_PATH,
    query: { ...exportScope(input), page: String(page), pageSize: String(FINANCE_PAGE_SIZE) },
    userToken: null,
  });
}

/** Every finance record of the tenant: those of `first`, then each later page, read once the records before it are consumed. */
async function* financeRecords(
  deps: Pick<ReportingDeps, 'client'>,
  input: SourceReadInput,
  first: FinanceRecordPage,
): AsyncGenerator<FinanceRecord> {
  let body = first;
  let read = 0;
  for (let page = 1; ; page += 1) {
    yield* body.data;
    read += body.data.length;
    if (body.data.length === 0 || read >= body.total) return;
    body = await readFinancePage(deps, input, page + 1);
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bySheetId(a: SheetStatusRow, b: SheetStatusRow): number {
  return compareText(a.timesheetId, b.timesheetId);
}

/**
 * `rows` in the fixture's `ORDER BY period_start, timesheet_id`. The producer orders by period start, then person, so only each
 * run of one period start is held and re-sorted, by sheet id.
 */
async function* inSheetFixtureOrder(rows: AsyncIterable<SheetStatusRow>): AsyncGenerator<SheetStatusRow> {
  let periodStart: string | undefined;
  let period: SheetStatusRow[] = [];
  for await (const row of rows) {
    if (row.periodStart !== periodStart) {
      yield* period.sort(bySheetId);
      periodStart = row.periodStart;
      period = [];
    }
    period.push(row);
  }
  yield* period.sort(bySheetId);
}

/** The fixture's `WHERE siteID = :siteid`, compared case-insensitively as SQL Server does. */
function ofSite(siteId: string, jobSiteId: string): boolean {
  return siteId.toLowerCase() === jobSiteId.toLowerCase();
}

function isExportSource(source: string): source is ExportSource {
  return (EXPORT_SOURCES as readonly string[]).includes(source);
}

/** The source rows `keep` accepts, each projected through `readers` as it is consumed. */
async function* projectRows<R>(
  rows: AsyncIterable<R> | Iterable<R>,
  keep: (row: R) => boolean,
  readers: readonly ((row: R) => ExportCell)[],
): AsyncGenerator<readonly ExportCell[]> {
  for await (const row of rows) {
    if (keep(row)) yield readers.map((read) => read(row));
  }
}

/** Projects source rows onto the definition's columns; throws when the columns are malformed or name a column the source lacks. */
function project<R>(
  source: ExportSource,
  rows: AsyncIterable<R> | Iterable<R>,
  keep: (row: R) => boolean,
  cells: SourceCells<R>,
  definition: ExportDefinitionRow,
): ExportTableStream {
  const columns = parseDefinitionColumns(definition.columns);
  const readers = columns.map(({ field }) => {
    const key = field.toLowerCase();
    const read = Object.hasOwn(cells, key) ? cells[key] : undefined;
    if (read === undefined) throw new Error(`Export column ${field} is not a column of source ${source}`);
    return read;
  });
  return { title: definition.name, columns, rows: projectRows(rows, keep, readers) };
}

/**
 * Opens the definition's source for the job's site in the fixture's columns, row order and value forms. The first read is
 * made here; later pages are read as the rows are consumed, and their failures surface through the rows.
 */
export async function openExportTable(deps: Pick<ReportingDeps, 'client'>, input: FetchExportTableInput): Promise<ExportTableStream> {
  const { job, definition } = input;
  const source = definition.source;
  if (!isExportSource(source)) throw new Error(`Unknown export source ${source}`);
  switch (source) {
    case 'broken':
      throw new SourceUnavailableError(source);
    case 'timesheets.sheets': {
      // Ordering before the site filter gives the order ordering after it would.
      const rows = inSheetFixtureOrder(sheetStatusRows(deps, input, await readSheetStatusPage(deps, input, 1)));
      return project(source, rows, (row) => ofSite(row.siteId, job.siteid), SHEET_CELLS, definition);
    }
    case 'finance.records': {
      // The producer already orders by created, then record_id; its created is cut to seconds, so re-sorting here would
      // lose the millisecond order the fixture's ORDER BY keeps.
      const rows = financeRecords(deps, input, await readFinancePage(deps, input, 1));
      return project(source, rows, (row) => ofSite(row.siteid, job.siteid), FINANCE_CELLS, definition);
    }
    default: {
      const unreachable: never = source;
      throw new Error(`Unhandled export source ${String(unreachable)}`);
    }
  }
}
