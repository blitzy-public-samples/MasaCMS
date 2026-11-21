// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components, operations } from '@/generated/clients/timesheets';
import { BUSINESS_DATE, TENANT_A } from '@opt2/platform/testing';
import { USER_IDS } from '../session';
import type { FakeRouteTable } from '../../helpers/fake-gateway';

type S = components['schemas'];
type TimesheetRoleKey = 'employee' | 'primaryApprover' | 'secondaryApprover';
type DayFields = Omit<S['TimesheetDay'], 'allowedActions'>;
type SheetList = operations['listSheets']['responses'][200]['content']['application/json'];
type DayActionConflict = operations['dayAction']['responses'][409]['content']['application/json;charset=utf-8'];

export const TIMESHEETS_AS_OF = BUSINESS_DATE;

export const TIMESHEET_IDS = Object.freeze({
  sheetApproved: '7E5A0001-0000-0000-0000000000000001',
  sheetDraft: '7E5A0001-0000-0000-0000000000000002',
  sheetReturned: '7E5A0001-0000-0000-0000000000000003',
  sheetSubmitted: '7E5A0001-0000-0000-0000000000000004',
  sheetPartiallyApproved: '7E5A0001-0000-0000-0000000000000005',
  dayDraft: '7E5A0002-0000-0000-0000000000000001',
  daySubmitted: '7E5A0002-0000-0000-0000000000000002',
  dayResubmitted: '7E5A0002-0000-0000-0000000000000003',
  dayPrimaryApproved: '7E5A0002-0000-0000-0000000000000004',
  dayApproved: '7E5A0002-0000-0000-0000000000000005',
  dayReturned: '7E5A0002-0000-0000-0000000000000006',
  dayBlackout: '7E5A0002-0000-0000-0000000000000007',
  primaryApproveAction: '7E5A0003-0000-0000-0000000000000001',
  employee: '7E5A00F0-0000-0000-0000000000000001',
  secondEmployee: '7E5A00F0-0000-0000-0000000000000002',
  thirdEmployee: '7E5A00F0-0000-0000-0000000000000003',
  primaryApprover: '7E5A00F0-0000-0000-0000000000000011',
  secondaryApprover: '7E5A00F0-0000-0000-0000000000000012',
} as const);

const returnedSheet: S['Timesheet'] = {
  timesheetId: TIMESHEET_IDS.sheetReturned,
  siteId: TENANT_A.siteId,
  personId: TIMESHEET_IDS.employee,
  periodStart: '2026-06-22T00:00:00',
  periodEnd: '2026-06-28T00:00:00',
  dueDate: '2026-07-03T00:00:00',
  created: '2026-06-22T07:00:00',
  lastUpdate: '2026-06-22T07:00:00',
  lastUpdateById: USER_IDS.tenantASiteAdmin,
  status: 'RETURNED',
  overdue: false,
};

export const timesheetSheets: S['Timesheet'][] = [
  {
    timesheetId: TIMESHEET_IDS.sheetApproved,
    siteId: TENANT_A.siteId,
    personId: TIMESHEET_IDS.employee,
    periodStart: '2026-06-08T00:00:00',
    periodEnd: '2026-06-14T00:00:00',
    dueDate: '2026-06-19T00:00:00',
    created: '2026-06-08T07:00:00',
    lastUpdate: '2026-06-08T07:00:00',
    lastUpdateById: USER_IDS.tenantASiteAdmin,
    status: 'APPROVED',
    overdue: false,
  },
  {
    timesheetId: TIMESHEET_IDS.sheetDraft,
    siteId: TENANT_A.siteId,
    personId: TIMESHEET_IDS.employee,
    periodStart: '2026-06-15T00:00:00',
    periodEnd: '2026-06-21T00:00:00',
    dueDate: '2026-06-26T00:00:00',
    created: '2026-06-15T07:00:00',
    lastUpdate: null,
    lastUpdateById: null,
    status: 'DRAFT',
    overdue: true,
  },
  returnedSheet,
  {
    timesheetId: TIMESHEET_IDS.sheetSubmitted,
    siteId: TENANT_A.siteId,
    personId: TIMESHEET_IDS.secondEmployee,
    periodStart: '2026-06-22T00:00:00',
    periodEnd: '2026-06-28T00:00:00',
    dueDate: '2026-07-03T00:00:00',
    created: '2026-06-22T07:00:00',
    lastUpdate: '2026-06-22T07:00:00',
    lastUpdateById: USER_IDS.tenantASiteAdmin,
    status: 'SUBMITTED',
    overdue: false,
  },
  {
    timesheetId: TIMESHEET_IDS.sheetPartiallyApproved,
    siteId: TENANT_A.siteId,
    personId: TIMESHEET_IDS.thirdEmployee,
    periodStart: '2026-06-22T00:00:00',
    periodEnd: '2026-06-28T00:00:00',
    dueDate: '2026-07-03T00:00:00',
    created: '2026-06-22T07:00:00',
    lastUpdate: '2026-06-22T07:00:00',
    lastUpdateById: USER_IDS.tenantASiteAdmin,
    status: 'PARTIALLY_APPROVED',
    overdue: false,
  },
];

export const sheetStatusRows: S['SheetStatusRow'][] = [
  {
    timesheetId: TIMESHEET_IDS.sheetApproved,
    siteId: TENANT_A.siteId,
    personId: TIMESHEET_IDS.employee,
    periodStart: '2026-06-08T00:00:00',
    status: 'APPROVED',
    overdue: false,
    dayCount: 5,
    blackoutCount: 0,
    approvedCount: 5,
  },
  {
    timesheetId: TIMESHEET_IDS.sheetDraft,
    siteId: TENANT_A.siteId,
    personId: TIMESHEET_IDS.employee,
    periodStart: '2026-06-15T00:00:00',
    status: 'DRAFT',
    overdue: true,
    dayCount: 5,
    blackoutCount: 0,
    approvedCount: 0,
  },
  {
    timesheetId: TIMESHEET_IDS.sheetReturned,
    siteId: TENANT_A.siteId,
    personId: TIMESHEET_IDS.employee,
    periodStart: '2026-06-22T00:00:00',
    status: 'RETURNED',
    overdue: false,
    dayCount: 7,
    blackoutCount: 1,
    approvedCount: 1,
  },
  {
    timesheetId: TIMESHEET_IDS.sheetSubmitted,
    siteId: TENANT_A.siteId,
    personId: TIMESHEET_IDS.secondEmployee,
    periodStart: '2026-06-22T00:00:00',
    status: 'SUBMITTED',
    overdue: false,
    dayCount: 5,
    blackoutCount: 0,
    approvedCount: 0,
  },
  {
    timesheetId: TIMESHEET_IDS.sheetPartiallyApproved,
    siteId: TENANT_A.siteId,
    personId: TIMESHEET_IDS.thirdEmployee,
    periodStart: '2026-06-22T00:00:00',
    status: 'PARTIALLY_APPROVED',
    overdue: false,
    dayCount: 5,
    blackoutCount: 0,
    approvedCount: 2,
  },
];

const dayDraft: DayFields = {
  dayId: TIMESHEET_IDS.dayDraft,
  timesheetId: TIMESHEET_IDS.sheetReturned,
  workDate: '2026-06-22T00:00:00',
  hours: '8.0000',
  state: 'DRAFT',
  blackout: false,
  lastUpdate: null,
  lastUpdateById: null,
};

const daySubmitted: DayFields = {
  dayId: TIMESHEET_IDS.daySubmitted,
  timesheetId: TIMESHEET_IDS.sheetReturned,
  workDate: '2026-06-23T00:00:00',
  hours: '8.0000',
  state: 'SUBMITTED',
  blackout: false,
  lastUpdate: '2026-06-23T17:00:00',
  lastUpdateById: TIMESHEET_IDS.employee,
};

const dayResubmitted: DayFields = {
  dayId: TIMESHEET_IDS.dayResubmitted,
  timesheetId: TIMESHEET_IDS.sheetReturned,
  workDate: '2026-06-24T00:00:00',
  hours: '7.5000',
  state: 'RESUBMITTED',
  blackout: false,
  lastUpdate: '2026-06-29T08:15:00',
  lastUpdateById: TIMESHEET_IDS.employee,
};

const dayPrimaryApproved: DayFields = {
  dayId: TIMESHEET_IDS.dayPrimaryApproved,
  timesheetId: TIMESHEET_IDS.sheetReturned,
  workDate: '2026-06-25T00:00:00',
  hours: '8.0000',
  state: 'PRIMARY_APPROVED',
  blackout: false,
  lastUpdate: '2026-06-26T10:00:00',
  lastUpdateById: TIMESHEET_IDS.primaryApprover,
};

const dayApproved: DayFields = {
  dayId: TIMESHEET_IDS.dayApproved,
  timesheetId: TIMESHEET_IDS.sheetReturned,
  workDate: '2026-06-26T00:00:00',
  hours: '6.0000',
  state: 'APPROVED',
  blackout: false,
  lastUpdate: '2026-06-29T11:00:00',
  lastUpdateById: TIMESHEET_IDS.secondaryApprover,
};

const dayReturned: DayFields = {
  dayId: TIMESHEET_IDS.dayReturned,
  timesheetId: TIMESHEET_IDS.sheetReturned,
  workDate: '2026-06-27T00:00:00',
  hours: '4.0000',
  state: 'RETURNED',
  blackout: false,
  lastUpdate: '2026-06-29T09:30:00',
  lastUpdateById: TIMESHEET_IDS.primaryApprover,
};

const dayBlackout: DayFields = {
  dayId: TIMESHEET_IDS.dayBlackout,
  timesheetId: TIMESHEET_IDS.sheetReturned,
  workDate: '2026-06-28T00:00:00',
  hours: '0.0000',
  state: 'DRAFT',
  blackout: true,
  lastUpdate: null,
  lastUpdateById: null,
};

export const timesheetDetailByRole: Record<TimesheetRoleKey, S['TimesheetDetail']> = {
  employee: {
    ...returnedSheet,
    days: [
      { ...dayDraft, allowedActions: ['submit'] },
      { ...daySubmitted, allowedActions: [] },
      { ...dayResubmitted, allowedActions: [] },
      { ...dayPrimaryApproved, allowedActions: [] },
      { ...dayApproved, allowedActions: [] },
      { ...dayReturned, allowedActions: ['resubmit'] },
      { ...dayBlackout, allowedActions: [] },
    ],
  },
  primaryApprover: {
    ...returnedSheet,
    days: [
      { ...dayDraft, allowedActions: [] },
      { ...daySubmitted, allowedActions: ['primary-approve', 'return'] },
      { ...dayResubmitted, allowedActions: ['primary-approve', 'return'] },
      { ...dayPrimaryApproved, allowedActions: [] },
      { ...dayApproved, allowedActions: [] },
      { ...dayReturned, allowedActions: [] },
      { ...dayBlackout, allowedActions: [] },
    ],
  },
  secondaryApprover: {
    ...returnedSheet,
    days: [
      { ...dayDraft, allowedActions: [] },
      { ...daySubmitted, allowedActions: [] },
      { ...dayResubmitted, allowedActions: [] },
      { ...dayPrimaryApproved, allowedActions: ['secondary-approve', 'return'] },
      { ...dayApproved, allowedActions: [] },
      { ...dayReturned, allowedActions: [] },
      { ...dayBlackout, allowedActions: [] },
    ],
  },
};

export const dayActionLegal: S['DayActionResult'] = {
  dayId: TIMESHEET_IDS.daySubmitted,
  timesheetId: TIMESHEET_IDS.sheetReturned,
  action: 'primary-approve',
  fromState: 'SUBMITTED',
  toState: 'PRIMARY_APPROVED',
  actionId: TIMESHEET_IDS.primaryApproveAction,
  workDate: daySubmitted.workDate,
  hours: daySubmitted.hours,
  blackout: false,
};

export const dayActionBlackout: { readonly status: 409; readonly body: DayActionConflict } = {
  status: 409,
  body: {
    apiversion: 'v1',
    method: 'timesheets.days.submit',
    error: { code: 'invalid_request', message: 'blackout' },
  },
};

const SERVICE_PATH = '/opt2/svc/timesheets/v1/timesheets';

const sheetList: SheetList = { items: timesheetSheets, total: timesheetSheets.length };

const sharedAnswers = {
  [`GET ${SERVICE_PATH}/sheets`]: { status: 200, body: sheetList },
  [`POST ${SERVICE_PATH}/days/${TIMESHEET_IDS.daySubmitted}/primary-approve`]: { status: 200, body: dayActionLegal },
  [`POST ${SERVICE_PATH}/days/${TIMESHEET_IDS.dayBlackout}/submit`]: dayActionBlackout,
} satisfies FakeRouteTable;

const detailKey = `GET ${SERVICE_PATH}/sheets/${TIMESHEET_IDS.sheetReturned}` as const;

export const timesheetsAnswersByRole: Record<TimesheetRoleKey, FakeRouteTable> = {
  employee: {
    ...sharedAnswers,
    [detailKey]: { status: 200, body: timesheetDetailByRole.employee },
  } satisfies FakeRouteTable,
  primaryApprover: {
    ...sharedAnswers,
    [detailKey]: { status: 200, body: timesheetDetailByRole.primaryApprover },
  } satisfies FakeRouteTable,
  secondaryApprover: {
    ...sharedAnswers,
    [detailKey]: { status: 200, body: timesheetDetailByRole.secondaryApprover },
  } satisfies FakeRouteTable,
};
