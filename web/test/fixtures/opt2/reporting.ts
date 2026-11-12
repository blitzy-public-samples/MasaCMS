// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components, operations } from '@/generated/clients/reporting';
import { TENANT_A } from '@opt2/platform/testing';
import { USER_IDS } from '../session';
import type { FakeRouteTable } from '../../helpers/fake-gateway';

type S = components['schemas'];
type ListExportsBody = operations['listExports']['responses'][200]['content']['application/json'];
type DownloadUrlBody = operations['getExportDownloadUrl']['responses'][200]['content']['application/json'];
type CreateExportBody = operations['createExport']['responses'][200]['content']['application/json'];
type CreateExportBadRequestBody =
  operations['createExport']['responses'][400]['content']['application/json;charset=utf-8'];

export const REPORTING_IDS = Object.freeze({
  definitionTimesheetStatus: '2E900001-0000-0000-0000000000000001',
  definitionFinanceRecords: '2E900001-0000-0000-0000000000000002',
  definitionBroken: '2E900001-0000-0000-0000000000000003',
  jobDoneXlsx: '2E900002-0000-0000-0000000000000001',
  jobDoneCsv: '2E900002-0000-0000-0000000000000002',
  jobFailedPdf: '2E900002-0000-0000-0000000000000003',
  jobDonePdf: '2E900002-0000-0000-0000000000000004',
  jobRunningXlsx: '2E900002-0000-0000-0000000000000005',
  jobQueuedCsv: '2E900002-0000-0000-0000000000000006',
  jobCreated: '2E900002-0000-0000-0000000000000007',
  exporter: '2E9000F0-0000-0000-0000000000000001',
} as const);

const EXPORTS_PATH = '/opt2/svc/reporting/v1/reporting/exports';
const OBJECT_PREFIX = `/opt2/files/reporting-exports/${TENANT_A.tenantId}`;
const URL_EXPIRES = 1782821700;
const URL_EXPIRES_AT = '2026-06-30T12:15:00.000Z';

export const exportDefinitions: S['ExportDefinition'][] = [
  {
    definition_id: REPORTING_IDS.definitionTimesheetStatus,
    siteid: TENANT_A.siteId,
    name: 'Timesheet status',
    source: 'timesheets.sheets',
    columns: ['timesheet_id', 'person_id', 'period_start', 'status', 'overdue'],
  },
  {
    definition_id: REPORTING_IDS.definitionFinanceRecords,
    siteid: TENANT_A.siteId,
    name: 'Finance records',
    source: 'finance.records',
    columns: ['record_id', 'title', 'amount', 'period', 'state'],
  },
  {
    definition_id: REPORTING_IDS.definitionBroken,
    siteid: TENANT_A.siteId,
    name: 'Archived ledger extract',
    source: 'broken',
    columns: ['ledger_id', 'account', 'amount'],
  },
];

export const exportJobs: S['ExportJob'][] = [
  {
    job_id: REPORTING_IDS.jobDoneXlsx,
    siteid: TENANT_A.siteId,
    definition_id: REPORTING_IDS.definitionTimesheetStatus,
    format: 'xlsx',
    state: 'done',
    requested_by_id: REPORTING_IDS.exporter,
    created: '2026-06-29T09:00:00',
    started_at: '2026-06-29T09:00:02',
    finished_at: '2026-06-29T09:00:05',
    error: '',
    file_name: `export-${REPORTING_IDS.jobDoneXlsx}.xlsx`,
    content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    output_sha256: 'ec5cbf020fd2bb6495c165db51eb6c4134a4637f47662e80194d7b785382bbca',
  },
  {
    job_id: REPORTING_IDS.jobDoneCsv,
    siteid: TENANT_A.siteId,
    definition_id: REPORTING_IDS.definitionFinanceRecords,
    format: 'csv',
    state: 'done',
    requested_by_id: REPORTING_IDS.exporter,
    created: '2026-06-29T14:30:00',
    started_at: '2026-06-29T14:30:01',
    finished_at: '2026-06-29T14:30:03',
    error: '',
    file_name: `export-${REPORTING_IDS.jobDoneCsv}.csv`,
    content_type: 'text/csv',
    output_sha256: 'df068be5f0074c934e929058b0e0860d53334f08a3de0c9abe3a0775ecb49a61',
  },
  {
    job_id: REPORTING_IDS.jobFailedPdf,
    siteid: TENANT_A.siteId,
    definition_id: REPORTING_IDS.definitionBroken,
    format: 'pdf',
    state: 'failed',
    requested_by_id: USER_IDS.tenantASiteAdmin,
    created: '2026-06-30T08:45:00',
    started_at: '2026-06-30T08:45:01',
    finished_at: '2026-06-30T08:45:02',
    error: 'source-unavailable',
    file_name: '',
    content_type: '',
    output_sha256: '',
  },
  {
    job_id: REPORTING_IDS.jobDonePdf,
    siteid: TENANT_A.siteId,
    definition_id: REPORTING_IDS.definitionFinanceRecords,
    format: 'pdf',
    state: 'done',
    requested_by_id: REPORTING_IDS.exporter,
    created: '2026-06-30T10:15:00',
    started_at: '2026-06-30T10:15:02',
    finished_at: '2026-06-30T10:15:09',
    error: '',
    file_name: `export-${REPORTING_IDS.jobDonePdf}.pdf`,
    content_type: 'application/pdf',
    output_sha256: 'b79871980850b752eaf7ec2168e3a3ba013167239d7ac62004246698e1282f4d',
  },
  {
    job_id: REPORTING_IDS.jobRunningXlsx,
    siteid: TENANT_A.siteId,
    definition_id: REPORTING_IDS.definitionFinanceRecords,
    format: 'xlsx',
    state: 'running',
    requested_by_id: REPORTING_IDS.exporter,
    created: '2026-06-30T11:50:00',
    started_at: '2026-06-30T11:50:03',
    finished_at: '',
    error: '',
    file_name: '',
    content_type: '',
    output_sha256: '',
  },
  {
    job_id: REPORTING_IDS.jobQueuedCsv,
    siteid: TENANT_A.siteId,
    definition_id: REPORTING_IDS.definitionTimesheetStatus,
    format: 'csv',
    state: 'queued',
    requested_by_id: USER_IDS.tenantASiteAdmin,
    created: '2026-06-30T11:58:00',
    started_at: '',
    finished_at: '',
    error: '',
    file_name: '',
    content_type: '',
    output_sha256: '',
  },
];

const doneXlsxUrl: S['SignedUrl'] = {
  url: `${OBJECT_PREFIX}/${REPORTING_IDS.jobDoneXlsx}.xlsx?expires=${URL_EXPIRES}&sig=df446b554c4ce84cae8f76ced2e0e5853480d46507a380ec47a51debc6b2143f`,
  expiresAt: URL_EXPIRES_AT,
};

const doneCsvUrl: S['SignedUrl'] = {
  url: `${OBJECT_PREFIX}/${REPORTING_IDS.jobDoneCsv}.csv?expires=${URL_EXPIRES}&sig=a9581bc4da17651df0f9450dd61e6c6a3c6bb178c481d06ed736d669c07459fd`,
  expiresAt: URL_EXPIRES_AT,
};

const donePdfUrl: S['SignedUrl'] = {
  url: `${OBJECT_PREFIX}/${REPORTING_IDS.jobDonePdf}.pdf?expires=${URL_EXPIRES}&sig=597e391afc77a4110fc8ccc0d082dd14dabdae28b723fb365f907c1addb55bde`,
  expiresAt: URL_EXPIRES_AT,
};

export const exportDownloadUrls: Record<string, S['SignedUrl']> = {
  [REPORTING_IDS.jobDoneXlsx]: doneXlsxUrl,
  [REPORTING_IDS.jobDoneCsv]: doneCsvUrl,
  [REPORTING_IDS.jobDonePdf]: donePdfUrl,
};

export const createExportAccepted: CreateExportBody = {
  data: {
    job_id: REPORTING_IDS.jobCreated,
    siteid: TENANT_A.siteId,
    definition_id: REPORTING_IDS.definitionTimesheetStatus,
    format: 'xlsx',
    state: 'queued',
    requested_by_id: REPORTING_IDS.exporter,
    created: '2026-06-30T12:00:00',
    started_at: '',
    finished_at: '',
    error: '',
    file_name: '',
    content_type: '',
    output_sha256: '',
  },
};

export const createExportInvalid: { readonly status: 400; readonly body: CreateExportBadRequestBody } = {
  status: 400,
  body: {
    apiversion: 'v1',
    method: 'invalid',
    error: { message: 'Invalid parameters', code: 'invalid_request' },
  },
};

export const reportingAnswers = {
  [`GET ${EXPORTS_PATH}`]: {
    status: 200,
    body: { data: exportJobs, total: exportJobs.length } satisfies ListExportsBody,
  },
  [`GET ${EXPORTS_PATH}/${REPORTING_IDS.jobDoneXlsx}/download-url`]: {
    status: 200,
    body: { data: doneXlsxUrl } satisfies DownloadUrlBody,
  },
  [`GET ${EXPORTS_PATH}/${REPORTING_IDS.jobDoneCsv}/download-url`]: {
    status: 200,
    body: { data: doneCsvUrl } satisfies DownloadUrlBody,
  },
  [`GET ${EXPORTS_PATH}/${REPORTING_IDS.jobDonePdf}/download-url`]: {
    status: 200,
    body: { data: donePdfUrl } satisfies DownloadUrlBody,
  },
  [`POST ${EXPORTS_PATH}`]: { status: 200, body: createExportAccepted },
} satisfies FakeRouteTable;
