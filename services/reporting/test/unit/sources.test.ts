// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export sources over a fake service client: source reads, error conversion, fixture row order and cell forms. */
import { describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import {
  ServiceUnavailableError,
  UnknownServiceError,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import type { ExportRunPayload } from '../../src/domain/deps.js';
import {
  openExportTable,
  parseDefinitionColumns,
  SourceUnavailableError,
  type ExportCell,
  type ExportTableStream,
  type FetchExportTableInput,
} from '../../src/domain/sources.js';
import type { ExportDefinitionRow, ExportJobRow } from '../../src/repo/tables.js';

const SITE = 'tenant-a';
const TENANT = '7d4a9f3e-1c2b-5e6f-8a9b-0c1d2e3f4a5b';
const JOB_ID = '0A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const USER_ID = '1B2C3D4E-5F60-7182-93A4B5C6D7E8F90A';
const SHEET_COLUMNS = ['timesheet_id', 'siteID', 'person_id', 'period_start', 'status', 'overdue', 'Day_Count', 'blackout_count', 'approved_count'];
const FINANCE_COLUMNS = ['record_id', 'siteID', 'title', 'amount', 'period', 'state', 'version', 'created', 'createdByID', 'lastUpdate', 'lastUpdateByID'];

const job: ExportJobRow = {
  tenant_id: TENANT,
  job_id: JOB_ID,
  siteid: SITE,
  definition_id: '2C3D4E5F-6071-8293-A4B5C6D7E8F90A1B',
  format: 'csv',
  state: 'running',
  requested_by_id: USER_ID,
  created: new Date('2026-06-30T09:00:00'),
  started_at: new Date('2026-06-30T09:00:01'),
  finished_at: null,
  error: null,
  file_name: null,
  content_type: null,
  object_key: null,
  output_sha256: null,
  row_version: '2',
};

const payload: ExportRunPayload = { jobId: JOB_ID, asOf: '2026-06-30', userToken: 'requester-token' };

function definition(source: string, columns: string): ExportDefinitionRow {
  return { tenant_id: TENANT, definition_id: job.definition_id, siteid: SITE, name: `${source} export`, source, columns };
}

const ok = (body: unknown): ServiceResponse => ({ status: 200, headers: { 'content-type': 'application/json' }, body });

/** A client answering each call with the next queued response, or throwing the next queued error. */
function fakeClient(...answers: Array<ServiceResponse | Error>): { client: ServiceClient; calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const client: ServiceClient = {
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push(req);
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected call to ${req.service} ${req.path}`);
      if (next instanceof Error) throw next;
      return next as ServiceResponse<T>;
    },
    async close() {},
  };
  return { client, calls };
}

/** Every row of `table`, read to the end. */
async function rowsOf(table: ExportTableStream): Promise<(readonly ExportCell[])[]> {
  const rows: (readonly ExportCell[])[] = [];
  for await (const row of table.rows) rows.push(row);
  return rows;
}

/** Opens the table of `input` with `client` and reads every row of it. */
async function readTable(client: ServiceClient, input: FetchExportTableInput): Promise<{ table: ExportTableStream; rows: (readonly ExportCell[])[] }> {
  const table = await openExportTable({ client }, input);
  return { table, rows: await rowsOf(table) };
}

function sheet(timesheetId: string, personId: string, periodStart: string, siteId = SITE) {
  return { timesheetId, siteId, personId, periodStart, status: 'DRAFT', overdue: true, dayCount: 5, blackoutCount: 1, approvedCount: 0 };
}

function record(recordId: string, created: string, lastupdate = '') {
  return {
    record_id: recordId,
    siteid: SITE,
    title: 'Travel 2026-06',
    amount: '1250.5000',
    period: '2026-06',
    state: 'IN-PROGRESS',
    version: 1,
    created,
    createdbyid: USER_ID,
    lastupdate,
    lastupdatebyid: lastupdate === '' ? '' : USER_ID,
  };
}

describe('parseDefinitionColumns', () => {
  it('returns each column name as its own field and label', () => {
    expect(parseDefinitionColumns('["timesheet_id","Status"]')).toEqual([
      { field: 'timesheet_id', label: 'timesheet_id' },
      { field: 'Status', label: 'Status' },
    ]);
  });

  it.each([
    ['malformed JSON', '["timesheet_id"', SyntaxError],
    ['a non-array', '"timesheet_id"', TypeError],
    ['a non-string name', '["timesheet_id", 5]', TypeError],
  ])('throws on %s', (_case, json, type) => {
    expect(() => parseDefinitionColumns(json)).toThrow(type);
  });
});

describe('openExportTable', () => {
  it('fails a broken source without calling any producer', async () => {
    const { client, calls } = fakeClient();
    const error = await openExportTable({ client }, { job, definition: definition('broken', '["ledger_id"]'), payload }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error).not.toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ source: 'broken', status: undefined });
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown source as a plain error without calling any producer', async () => {
    const { client, calls } = fakeClient();
    const error = await openExportTable({ client }, { job, definition: definition('ledger', '[]'), payload }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SourceUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it('reads sheet status as of asOf with the requester token, in the fixture order of the job site', async () => {
    const A = 'AAAAAAAA-0000-0000-0000000000000001';
    const B = 'BBBBBBBB-0000-0000-0000000000000002';
    const C = 'CCCCCCCC-0000-0000-0000000000000003';
    const P1 = '11111111-0000-0000-0000000000000001';
    const P2 = '22222222-0000-0000-0000000000000002';
    // Producer order: period start, person id, sheet id.
    const items = [
      { ...sheet(C, P1, '2026-06-01T00:00:00'), overdue: false, status: 'APPROVED', approvedCount: 4 },
      sheet(B, P2, '2026-06-01T00:00:00'),
      sheet(A, P2, '2026-06-08T00:00:00'),
      sheet('DDDDDDDD-0000-0000-0000000000000004', P1, '2026-05-25T00:00:00', 'tenant-b'),
    ];
    const { client, calls } = fakeClient(ok({ items }));

    const { table, rows } = await readTable(client, { job, definition: definition('timesheets.sheets', JSON.stringify(SHEET_COLUMNS)), payload });

    expect(calls).toEqual([
      {
        service: 'timesheets',
        method: 'GET',
        path: '/v1/timesheets/sheet-status',
        query: { asOf: '2026-06-30' },
        userToken: 'requester-token',
      },
    ]);
    expect(table.title).toBe('timesheets.sheets export');
    expect(table.columns.map((c) => c.label)).toEqual(SHEET_COLUMNS);
    expect(rows).toEqual([
      [B, SITE, P2, '2026-06-01T00:00:00', 'DRAFT', '1', '5', '1', '0'],
      [C, SITE, P1, '2026-06-01T00:00:00', 'APPROVED', '0', '5', '1', '4'],
      [A, SITE, P2, '2026-06-08T00:00:00', 'DRAFT', '1', '5', '1', '0'],
    ]);
  });

  it('reads every finance record page by page, keeping the producer order and the fixture value forms', async () => {
    const ids = ['AAAAAAAA-0000-0000-0000000000000001', 'CCCCCCCC-0000-0000-0000000000000003', 'BBBBBBBB-0000-0000-0000000000000002'];
    const { client, calls } = fakeClient(
      ok({ data: [record(ids[0] as string, '2026-06-02T09:15:00'), record(ids[1] as string, '2026-06-02T09:15:00')], total: 3 }),
      ok({ data: [record(ids[2] as string, '2026-06-03T10:00:00', '2026-06-04T11:30:00')], total: 3 }),
    );

    const { table, rows } = await readTable(client, { job, definition: definition('finance.records', JSON.stringify(FINANCE_COLUMNS)), payload });

    expect(calls.map((c) => [c.service, c.method, c.path, c.query, c.userToken])).toEqual([
      ['finance', 'GET', '/v1/finance/records', { page: '1', pageSize: '1000' }, 'requester-token'],
      ['finance', 'GET', '/v1/finance/records', { page: '2', pageSize: '1000' }, 'requester-token'],
    ]);
    expect(table.columns.map((c) => c.label)).toEqual(FINANCE_COLUMNS);
    expect(rows).toEqual([
      [ids[0], SITE, 'Travel 2026-06', '1250.5000', '2026-06', 'IN-PROGRESS', '1', '2026-06-02T09:15:00', USER_ID, '', ''],
      [ids[1], SITE, 'Travel 2026-06', '1250.5000', '2026-06', 'IN-PROGRESS', '1', '2026-06-02T09:15:00', USER_ID, '', ''],
      [ids[2], SITE, 'Travel 2026-06', '1250.5000', '2026-06', 'IN-PROGRESS', '1', '2026-06-03T10:00:00', USER_ID, '2026-06-04T11:30:00', USER_ID],
    ]);
  });

  it.each([
    ['no records', [ok({ data: [], total: 0 })], 1],
    ['an empty page before the total', [ok({ data: [record('AAAAAAAA-0000-0000-0000000000000001', '2026-06-02T09:15:00')], total: 5 }), ok({ data: [], total: 5 })], 2],
  ])('stops reading finance pages on %s', async (_case, answers, expectedCalls) => {
    const { client, calls } = fakeClient(...answers);
    const { rows } = await readTable(client, { job, definition: definition('finance.records', '["record_id"]'), payload });
    expect(calls).toHaveLength(expectedCalls);
    expect(rows).toHaveLength(expectedCalls - 1);
  });

  it('reads each later finance page only once the rows before it are consumed, and none once the consumer stops', async () => {
    const [A, B, C, D] = ['AAAAAAAA-0000-0000-0000000000000001', 'BBBBBBBB-0000-0000-0000000000000002', 'CCCCCCCC-0000-0000-0000000000000003', 'DDDDDDDD-0000-0000-0000000000000004'];
    const { client, calls } = fakeClient(
      ok({ data: [record(A, '2026-06-02T09:15:00'), record(B, '2026-06-02T09:16:00')], total: 6 }),
      ok({ data: [record(C, '2026-06-02T09:17:00'), record(D, '2026-06-02T09:18:00')], total: 6 }),
    );
    const table = await openExportTable({ client }, { job, definition: definition('finance.records', '["record_id"]'), payload });
    const rows = table.rows[Symbol.asyncIterator]();
    expect(calls).toHaveLength(1);

    expect([(await rows.next()).value, (await rows.next()).value]).toEqual([[A], [B]]);
    expect(calls).toHaveLength(1);
    expect((await rows.next()).value).toEqual([C]);
    expect(calls.map((c) => c.query)).toEqual([{ page: '1', pageSize: '1000' }, { page: '2', pageSize: '1000' }]);

    await rows.return?.();
    expect(await rows.next()).toEqual({ done: true, value: undefined });
    expect(calls).toHaveLength(2);
  });

  it('keeps only the finance records of the job site, compared case-insensitively, on every page', async () => {
    const [A, B, C] = ['AAAAAAAA-0000-0000-0000000000000001', 'BBBBBBBB-0000-0000-0000000000000002', 'CCCCCCCC-0000-0000-0000000000000003'];
    const { client } = fakeClient(
      ok({ data: [{ ...record(A, '2026-06-02T09:15:00'), siteid: 'tenant-b' }, record(B, '2026-06-02T09:16:00')], total: 3 }),
      ok({ data: [{ ...record(C, '2026-06-02T09:17:00'), siteid: 'TENANT-A' }], total: 3 }),
    );
    const { rows } = await readTable(client, { job, definition: definition('finance.records', '["record_id","siteID"]'), payload });
    expect(rows).toEqual([
      [B, SITE],
      [C, 'TENANT-A'],
    ]);
  });

  // The first read is made when the table opens; a later finance page is read, and fails, while the rows are read.
  const FIRST_OF_TWO_PAGES = ok({ data: [record('AAAAAAAA-0000-0000-0000000000000001', '2026-06-02T09:15:00')], total: 2 });
  const READS = [
    { read: 'the timesheets read', source: 'timesheets.sheets', columns: '["status"]', before: [] },
    { read: 'a later finance page', source: 'finance.records', columns: '["record_id"]', before: [FIRST_OF_TWO_PAGES] },
  ];

  it.each(
    READS.flatMap((read) =>
      (
        [
          ['a 503 answer', { status: 503, headers: {}, body: undefined }, 503],
          ['a 500 answer', { status: 500, headers: {}, body: undefined }, 500],
          ['a 403 answer', { status: 403, headers: {}, body: undefined }, 403],
          ['a thrown ServiceUnavailableError', new ServiceUnavailableError('timesheets', new Error('timed out')), undefined],
          ['a thrown ECONNREFUSED error', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8118'), { code: 'ECONNREFUSED' }), undefined],
          ['a thrown undici socket error', Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }), undefined],
          ['a thrown timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), undefined],
        ] satisfies [string, ServiceResponse | Error, number | undefined][]
      ).map(([name, answer, status]) => ({ ...read, name, answer, status })),
    ),
  )('turns $name on $read into a SourceUnavailableError', async ({ source, columns, before, answer, status }) => {
    const { client } = fakeClient(...before, answer);
    const error = await readTable(client, { job, definition: definition(source, columns), payload }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error).not.toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ source, status });
    if (answer instanceof Error) expect((error as Error).cause).toBe(answer);
  });

  it.each(
    [
      { read: 'the first finance page', before: [] },
      { read: 'a later finance page', before: [FIRST_OF_TWO_PAGES] },
    ].flatMap((read) => [
      { ...read, name: 'an UnknownServiceError', thrown: new UnknownServiceError('finance') },
      { ...read, name: 'any other error', thrown: new Error('boom') },
    ]),
  )('lets $name on $read propagate unchanged', async ({ before, thrown }) => {
    const { client } = fakeClient(...before, thrown);
    await expect(readTable(client, { job, definition: definition('finance.records', '["record_id"]'), payload })).rejects.toBe(thrown);
  });

  it.each([
    ['malformed columns', 'timesheets.sheets', 'not json', SyntaxError],
    ['a column the source lacks', 'timesheets.sheets', '["timesheet_id","ledger_id"]', /ledger_id is not a column of source timesheets\.sheets/],
    ['malformed columns', 'finance.records', 'not json', SyntaxError],
    ['a column the source lacks', 'finance.records', '["record_id","ledger_id"]', /ledger_id is not a column of source finance\.records/],
  ])('fails the read on %s of %s after its first read answered', async (_case, source, columns, expected) => {
    const answer =
      source === 'finance.records'
        ? ok({ data: [record('AAAAAAAA-0000-0000-0000000000000001', '2026-06-02T09:15:00')], total: 5000 })
        : ok({ items: [] });
    const { client, calls } = fakeClient(answer);
    await expect(openExportTable({ client }, { job, definition: definition(source, columns), payload })).rejects.toThrow(expected);
    expect(calls).toHaveLength(1);
  });
});
