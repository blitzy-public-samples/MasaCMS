// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components, operations } from '@/generated/clients/finance';
import { TENANT_A } from '@opt2/platform/testing';
import type { FakeRouteTable } from '../../helpers/fake-gateway';

type S = components['schemas'];
type OkBody<Op extends keyof operations> = operations[Op]['responses'] extends {
  200: { content: { 'application/json': infer Body } };
}
  ? Body
  : never;
type TransitionConflict = operations['transitionRecord']['responses'][409]['content']['application/json;charset=utf-8'];

export const FINANCE_IDS = Object.freeze({
  recordInProgress: 'F1A00001-0000-0000-0000000000000001',
  recordSubmitted: 'F1A00001-0000-0000-0000000000000002',
  recordResubmitted: 'F1A00001-0000-0000-0000000000000003',
  recordApproved: 'F1A00001-0000-0000-0000000000000004',
  recordRejected: 'F1A00001-0000-0000-0000000000000005',
  versionCreate: 'F1A00002-0000-0000-0000000000000001',
  versionEdit: 'F1A00002-0000-0000-0000000000000002',
  versionSubmit: 'F1A00002-0000-0000-0000000000000003',
  versionReject: 'F1A00002-0000-0000-0000000000000004',
  versionEditAfterReject: 'F1A00002-0000-0000-0000000000000005',
  versionResubmit: 'F1A00002-0000-0000-0000000000000006',
  attachmentPdf: 'F1A00003-0000-0000-0000000000000001',
  attachmentPng: 'F1A00003-0000-0000-0000000000000002',
  attachmentUploaded: 'F1A00003-0000-0000-0000000000000003',
  preparer: 'F1A000F0-0000-0000-0000000000000001',
  approver: 'F1A000F0-0000-0000-0000000000000002',
} as const);

const PERIOD = '2026-06';
const OBJECT_PREFIX = `/opt2/files/finance-attachments/${TENANT_A.tenantId}`;
const URL_EXPIRES = 1782821700;
const URL_EXPIRES_AT = '2026-06-30T12:15:00.000Z';
const ROLLUP_COMPUTED_AT = '2026-06-29T10:05:00';

const resubmittedRecord: S['FinanceRecord'] = {
  record_id: FINANCE_IDS.recordResubmitted,
  siteid: TENANT_A.siteId,
  title: 'Consulting services Q2',
  amount: '4200.0000',
  period: PERIOD,
  state: 'RE-SUBMITTED',
  version: 6,
  created: '2026-06-05T08:45:00',
  createdbyid: FINANCE_IDS.preparer,
  lastupdate: '2026-06-26T11:20:00',
  lastupdatebyid: FINANCE_IDS.preparer,
};

export const financeRecords: S['FinanceRecord'][] = [
  {
    record_id: FINANCE_IDS.recordInProgress,
    siteid: TENANT_A.siteId,
    title: 'Office supplies June',
    amount: '1250.0000',
    period: PERIOD,
    state: 'IN-PROGRESS',
    version: 1,
    created: '2026-06-01T09:00:00',
    createdbyid: FINANCE_IDS.preparer,
    lastupdate: '',
    lastupdatebyid: '',
  },
  {
    record_id: FINANCE_IDS.recordSubmitted,
    siteid: TENANT_A.siteId,
    title: 'Travel reimbursement',
    amount: '980.5000',
    period: PERIOD,
    state: 'SUBMITTED',
    version: 2,
    created: '2026-06-03T10:30:00',
    createdbyid: FINANCE_IDS.preparer,
    lastupdate: '2026-06-04T14:00:00',
    lastupdatebyid: FINANCE_IDS.preparer,
  },
  resubmittedRecord,
  {
    record_id: FINANCE_IDS.recordApproved,
    siteid: TENANT_A.siteId,
    title: 'Software licence renewal',
    amount: '315.7500',
    period: PERIOD,
    state: 'APPROVED',
    version: 3,
    created: '2026-06-08T13:15:00',
    createdbyid: FINANCE_IDS.preparer,
    lastupdate: '2026-06-12T09:40:00',
    lastupdatebyid: FINANCE_IDS.approver,
  },
  {
    record_id: FINANCE_IDS.recordRejected,
    siteid: TENANT_A.siteId,
    title: 'Equipment purchase',
    amount: '12000.0000',
    period: PERIOD,
    state: 'REJECTED',
    version: 3,
    created: '2026-06-10T15:00:00',
    createdbyid: FINANCE_IDS.preparer,
    lastupdate: '2026-06-29T10:05:00',
    lastupdatebyid: FINANCE_IDS.approver,
  },
];

const resubmittedHistory = {
  record_id: FINANCE_IDS.recordResubmitted,
  title: resubmittedRecord.title,
  period: PERIOD,
} as const;

export const financeRecordVersions: S['FinanceRecordVersion'][] = [
  {
    ...resubmittedHistory,
    version_id: FINANCE_IDS.versionCreate,
    version: 1,
    state: 'IN-PROGRESS',
    amount: '3900.0000',
    action: 'create',
    actor_user_id: FINANCE_IDS.preparer,
    created: '2026-06-05T08:45:00',
  },
  {
    ...resubmittedHistory,
    version_id: FINANCE_IDS.versionEdit,
    version: 2,
    state: 'IN-PROGRESS',
    amount: '4050.0000',
    action: 'edit',
    actor_user_id: FINANCE_IDS.preparer,
    created: '2026-06-08T10:00:00',
  },
  {
    ...resubmittedHistory,
    version_id: FINANCE_IDS.versionSubmit,
    version: 3,
    state: 'SUBMITTED',
    amount: '4050.0000',
    action: 'submit',
    actor_user_id: FINANCE_IDS.preparer,
    created: '2026-06-09T16:30:00',
  },
  {
    ...resubmittedHistory,
    version_id: FINANCE_IDS.versionReject,
    version: 4,
    state: 'REJECTED',
    amount: '4050.0000',
    action: 'reject',
    actor_user_id: FINANCE_IDS.approver,
    created: '2026-06-15T11:10:00',
  },
  {
    ...resubmittedHistory,
    version_id: FINANCE_IDS.versionEditAfterReject,
    version: 5,
    state: 'REJECTED',
    amount: '4200.0000',
    action: 'edit',
    actor_user_id: FINANCE_IDS.preparer,
    created: '2026-06-24T09:25:00',
  },
  {
    ...resubmittedHistory,
    version_id: FINANCE_IDS.versionResubmit,
    version: 6,
    state: 'RE-SUBMITTED',
    amount: '4200.0000',
    action: 'resubmit',
    actor_user_id: FINANCE_IDS.preparer,
    created: '2026-06-26T11:20:00',
  },
];

export const financeAttachments: S['FinanceAttachment'][] = [
  {
    attachment_id: FINANCE_IDS.attachmentPdf,
    record_id: FINANCE_IDS.recordResubmitted,
    file_name: 'consulting-invoice-2026-06.pdf',
    content_type: 'application/pdf',
    size_bytes: 48213,
    sha256: 'e0584865b79c9d600762dc48ef4026c29988bae99bf52627e5fe9b35cac66641',
    created: '2026-06-05T09:00:00',
    createdbyid: FINANCE_IDS.preparer,
  },
  {
    attachment_id: FINANCE_IDS.attachmentPng,
    record_id: FINANCE_IDS.recordResubmitted,
    file_name: 'timesheet-summary.png',
    content_type: 'image/png',
    size_bytes: 15872,
    sha256: '6fc7c6e29dc514c7d0559cb591114c9abb3495e509c888d9d986c369abf4faf7',
    created: '2026-06-24T09:30:00',
    createdbyid: FINANCE_IDS.preparer,
  },
];

export const financeRecordDetail: S['FinanceRecordDetail'] = {
  ...resubmittedRecord,
  versions: financeRecordVersions,
  attachments: financeAttachments,
};

export const financeAttachmentUploaded: S['FinanceAttachment'] = {
  attachment_id: FINANCE_IDS.attachmentUploaded,
  record_id: FINANCE_IDS.recordResubmitted,
  file_name: 'receipt-2026-06-30.pdf',
  content_type: 'application/pdf',
  size_bytes: 20480,
  sha256: '283cb024a12b57de719da230f9e8f20107d0f5346a80a00c94905e0135da712e',
  created: '2026-06-30T12:00:00',
  createdbyid: FINANCE_IDS.preparer,
};

// The service signs each download with the file's Content-Disposition, so local URLs end with `&disposition=`.
export const financeAttachmentSignedUrl: S['SignedUrl'] = {
  url: `${OBJECT_PREFIX}/${FINANCE_IDS.attachmentPdf}.pdf?expires=${URL_EXPIRES}&sig=9767e03ab20e5f8025bd348486ade535e16dc4a3e07945bc6e6aef06c98f51a7&disposition=attachment%3B%20filename%3D%22consulting-invoice-2026-06.pdf%22`,
  expiresAt: URL_EXPIRES_AT,
};

const pngSignedUrl: S['SignedUrl'] = {
  url: `${OBJECT_PREFIX}/${FINANCE_IDS.attachmentPng}.png?expires=${URL_EXPIRES}&sig=0a3ae60851a92233a093f4496056a09fd591b10574dfb7248bc5cf017abf1a2e&disposition=attachment%3B%20filename%3D%22timesheet-summary.png%22`,
  expiresAt: URL_EXPIRES_AT,
};

export const financeAttachmentSignedUrls: Readonly<Record<string, S['SignedUrl']>> = Object.freeze({
  [FINANCE_IDS.attachmentPdf]: financeAttachmentSignedUrl,
  [FINANCE_IDS.attachmentPng]: pngSignedUrl,
});

export const financeRollups: S['FinanceRollup'][] = [
  { period: PERIOD, state: 'APPROVED', record_count: 1, total_amount: '315.7500', computed_at: ROLLUP_COMPUTED_AT },
  { period: PERIOD, state: 'IN-PROGRESS', record_count: 1, total_amount: '1250.0000', computed_at: ROLLUP_COMPUTED_AT },
  { period: PERIOD, state: 'RE-SUBMITTED', record_count: 1, total_amount: '4200.0000', computed_at: ROLLUP_COMPUTED_AT },
  { period: PERIOD, state: 'REJECTED', record_count: 1, total_amount: '12000.0000', computed_at: ROLLUP_COMPUTED_AT },
  { period: PERIOD, state: 'SUBMITTED', record_count: 1, total_amount: '980.5000', computed_at: ROLLUP_COMPUTED_AT },
];

export const financeTransitionLegal: OkBody<'transitionRecord'> = {
  data: {
    ...resubmittedRecord,
    state: 'APPROVED',
    version: 7,
    lastupdate: '2026-06-30T12:00:00',
    lastupdatebyid: FINANCE_IDS.approver,
  },
};

export const financeTransitionIllegal: { readonly status: 409; readonly body: TransitionConflict } = {
  status: 409,
  body: {
    apiversion: 'v1',
    method: 'finance.records.submit',
    error: { code: 'invalid_request', message: 'illegalTransition' },
  },
};

const SERVICE = '/opt2/svc/finance/v1/finance';
const RECORDS = `${SERVICE}/records`;
const RESUBMITTED = `${RECORDS}/${FINANCE_IDS.recordResubmitted}`;
const ATTACHMENTS = `${RESUBMITTED}/attachments`;

export const financeAnswers = Object.freeze({
  [`GET ${RECORDS}`]: {
    status: 200,
    body: { data: financeRecords, total: financeRecords.length } satisfies OkBody<'listRecords'>,
  },
  [`GET ${SERVICE}/rollups`]: {
    status: 200,
    body: { data: financeRollups } satisfies OkBody<'listRollups'>,
  },
  [`GET ${RESUBMITTED}`]: { status: 200, body: { data: financeRecordDetail } satisfies OkBody<'getRecord'> },
  [`GET ${RESUBMITTED}/versions`]: {
    status: 200,
    body: { data: financeRecordVersions } satisfies OkBody<'listRecordVersions'>,
  },
  [`GET ${ATTACHMENTS}`]: {
    status: 200,
    body: { data: financeAttachments } satisfies OkBody<'listRecordAttachments'>,
  },
  [`POST ${ATTACHMENTS}`]: {
    status: 200,
    body: { data: financeAttachmentUploaded } satisfies OkBody<'uploadRecordAttachment'>,
  },
  [`GET ${ATTACHMENTS}/${FINANCE_IDS.attachmentPdf}/download-url`]: {
    status: 200,
    body: { data: financeAttachmentSignedUrl } satisfies OkBody<'getAttachmentDownloadUrl'>,
  },
  [`GET ${ATTACHMENTS}/${FINANCE_IDS.attachmentPng}/download-url`]: {
    status: 200,
    body: { data: pngSignedUrl } satisfies OkBody<'getAttachmentDownloadUrl'>,
  },
  [`POST ${RESUBMITTED}/transitions/approve`]: { status: 200, body: financeTransitionLegal },
  [`POST ${RECORDS}/${FINANCE_IDS.recordApproved}/transitions/submit`]: financeTransitionIllegal,
} satisfies FakeRouteTable);
