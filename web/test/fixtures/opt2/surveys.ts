// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components, operations } from '@/generated/clients/surveys';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { USER_IDS } from '../session';
import type { FakeRouteTable } from '../../helpers/fake-gateway';

type S = components['schemas'];
type OkBody<Op extends keyof operations> = operations[Op]['responses'] extends {
  200: { content: { 'application/json': infer Body } };
}
  ? Body
  : never;
type ScheduleBadRequestBody = operations['scheduleSurvey']['responses'][400]['content']['application/json'];

export const SURVEY_IDS = Object.freeze({
  singleSiteSurvey: '5D900001-0000-0000-0000000000000001',
  multiSiteSurvey: '5D900001-0000-0000-0000000000000002',
  firstReminder: '5D900002-0000-0000-0000000000000001',
  secondReminder: '5D900002-0000-0000-0000000000000002',
  singleSiteTarget: '5D900003-0000-0000-0000000000000001',
  multiSiteTargetA: '5D900003-0000-0000-0000000000000002',
  multiSiteTargetB: '5D900003-0000-0000-0000000000000003',
  multiSiteTargetBEmployees: '5D900003-0000-0000-0000000000000004',
  singleSiteResponse: '5D900004-0000-0000-0000000000000001',
  multiSiteResponse: '5D900004-0000-0000-0000000000000002',
  tenantARespondent: '5D9000F0-0000-0000-0000000000000001',
  tenantBRespondent: '5D9000F0-0000-0000-0000000000000002',
} as const);

const MULTI_SITE_TASK_BASE = `opt2-survey-${SURVEY_IDS.multiSiteSurvey}-`;

export const scheduleRequest: S['ScheduleRequest'] = {
  launchAt: '2026-07-01T09:00:00',
  reminders: [{ offsetMinutes: 1440 }, { offsetMinutes: 4320 }],
};

// The service accepts launch times in the past; a June 31 launch rolls over, which it rejects as invalidParameters.
export const invalidScheduleRequest: S['ScheduleRequest'] = {
  launchAt: '2026-06-31T09:00:00',
  reminders: [{ offsetMinutes: 1440 }],
};

export const surveySchedule: S['SurveySchedule'] = {
  surveyId: SURVEY_IDS.multiSiteSurvey,
  launchAt: '2026-07-01T09:00:00.000',
  scheduleVersion: 1,
  launchTaskName: `${MULTI_SITE_TASK_BASE}launch`,
  reminders: [
    {
      reminderId: SURVEY_IDS.firstReminder,
      n: 1,
      offsetMinutes: 1440,
      remindAt: '2026-07-02T09:00:00.000',
      taskName: `${MULTI_SITE_TASK_BASE}reminder-1`,
      sentAt: null,
    },
    {
      reminderId: SURVEY_IDS.secondReminder,
      n: 2,
      offsetMinutes: 4320,
      remindAt: '2026-07-04T09:00:00.000',
      taskName: `${MULTI_SITE_TASK_BASE}reminder-2`,
      sentAt: null,
    },
  ],
};

export const singleSiteSurvey: S['Survey'] = {
  surveyId: SURVEY_IDS.singleSiteSurvey,
  siteId: TENANT_A.siteId,
  title: 'Program 1 onboarding check-in',
  status: 'DRAFT',
  created: '2026-06-29T09:00:00.000',
  createdById: USER_IDS.tenantASiteAdmin,
  lastUpdate: null,
  lastUpdateById: null,
  launchedAt: null,
  schedule: null,
};

export const multiSiteSurvey: S['Survey'] = {
  surveyId: SURVEY_IDS.multiSiteSurvey,
  siteId: TENANT_A.siteId,
  title: 'Cross-program timesheet experience',
  status: 'SCHEDULED',
  created: '2026-06-29T10:00:00.000',
  createdById: USER_IDS.tenantASiteAdmin,
  lastUpdate: null,
  lastUpdateById: null,
  launchedAt: null,
  schedule: surveySchedule,
};

export const surveys: S['Survey'][] = [singleSiteSurvey, multiSiteSurvey];

export const surveyTasks: S['ScheduledTaskView'][] = [
  {
    taskName: `${MULTI_SITE_TASK_BASE}launch`,
    kind: 'launch',
    scheduleTime: '2026-07-01T09:00:00.000',
    status: 'scheduled',
  },
  {
    taskName: `${MULTI_SITE_TASK_BASE}reminder-1`,
    kind: 'reminder',
    scheduleTime: '2026-07-02T09:00:00.000',
    status: 'scheduled',
  },
  {
    taskName: `${MULTI_SITE_TASK_BASE}reminder-2`,
    kind: 'reminder',
    scheduleTime: '2026-07-04T09:00:00.000',
    status: 'scheduled',
  },
];

export const singleSiteSurveyTargets: S['SurveyTarget'][] = [
  {
    targetId: SURVEY_IDS.singleSiteTarget,
    surveyId: SURVEY_IDS.singleSiteSurvey,
    siteId: TENANT_A.siteId,
    groupName: null,
    created: '2026-06-29T09:05:00.000',
  },
];

export const surveyTargets: S['SurveyTarget'][] = [
  {
    targetId: SURVEY_IDS.multiSiteTargetA,
    surveyId: SURVEY_IDS.multiSiteSurvey,
    siteId: TENANT_A.siteId,
    groupName: null,
    created: '2026-06-29T10:05:00.000',
  },
  {
    targetId: SURVEY_IDS.multiSiteTargetB,
    surveyId: SURVEY_IDS.multiSiteSurvey,
    siteId: TENANT_B.siteId,
    groupName: null,
    created: '2026-06-30T09:20:00.000',
  },
  {
    targetId: SURVEY_IDS.multiSiteTargetBEmployees,
    surveyId: SURVEY_IDS.multiSiteSurvey,
    siteId: TENANT_B.siteId,
    groupName: 'timesheets.employee',
    created: '2026-06-30T09:20:00.000',
  },
];

export const bulkTargetRequest: S['BulkTargetRequest'] = {
  targets: [
    { siteId: TENANT_A.siteId },
    { siteId: TENANT_B.siteId },
    { siteId: TENANT_B.siteId, groupName: 'timesheets.employee' },
  ],
};

export const bulkTargetResult: S['BulkTargetResult'] = {
  inserted: 2,
  total: 3,
};

export const surveyResponses: Record<'singleSite' | 'multiSite', S['SurveyResponse'][]> = {
  singleSite: [
    {
      responseId: SURVEY_IDS.singleSiteResponse,
      surveyId: SURVEY_IDS.singleSiteSurvey,
      siteId: TENANT_A.siteId,
      respondentSiteId: TENANT_A.siteId,
      respondentUserId: SURVEY_IDS.tenantARespondent,
      answers: '{"q1":"4","q2":"The welcome pack was clear."}',
      created: '2026-06-30T08:45:00.000',
    },
  ],
  multiSite: [
    {
      responseId: SURVEY_IDS.multiSiteResponse,
      surveyId: SURVEY_IDS.multiSiteSurvey,
      siteId: TENANT_A.siteId,
      respondentSiteId: TENANT_B.siteId,
      respondentUserId: SURVEY_IDS.tenantBRespondent,
      answers: '{"q1":"5","q2":"Approvals arrive within a day."}',
      created: '2026-06-30T09:30:00.000',
    },
  ],
};

export const scheduleInvalid: { readonly status: 400; readonly body: ScheduleBadRequestBody } = {
  status: 400,
  body: {
    apiversion: 'v1',
    method: 'invalid',
    error: { message: 'Invalid parameters', code: 'invalid_request' },
  },
};

const SURVEYS_V1 = '/opt2/svc/surveys/v1/surveys';
const SINGLE_SITE_V1 = `${SURVEYS_V1}/${SURVEY_IDS.singleSiteSurvey}`;
const MULTI_SITE_V1 = `${SURVEYS_V1}/${SURVEY_IDS.multiSiteSurvey}`;

export const surveysAnswers = {
  [`GET ${SURVEYS_V1}`]: {
    status: 200,
    body: { data: surveys, total: surveys.length } satisfies OkBody<'listSurveys'>,
  },
  [`GET ${SINGLE_SITE_V1}`]: { status: 200, body: { data: singleSiteSurvey } satisfies OkBody<'getSurvey'> },
  [`GET ${MULTI_SITE_V1}`]: { status: 200, body: { data: multiSiteSurvey } satisfies OkBody<'getSurvey'> },
  [`GET ${SINGLE_SITE_V1}/tasks`]: { status: 200, body: { data: [] } satisfies OkBody<'listSurveyTasks'> },
  [`GET ${MULTI_SITE_V1}/tasks`]: { status: 200, body: { data: surveyTasks } satisfies OkBody<'listSurveyTasks'> },
  [`GET ${SINGLE_SITE_V1}/targets`]: {
    status: 200,
    body: { data: singleSiteSurveyTargets } satisfies OkBody<'listSurveyTargets'>,
  },
  [`GET ${MULTI_SITE_V1}/targets`]: {
    status: 200,
    body: { data: surveyTargets } satisfies OkBody<'listSurveyTargets'>,
  },
  [`GET ${SINGLE_SITE_V1}/responses`]: {
    status: 200,
    body: {
      data: surveyResponses.singleSite,
      total: surveyResponses.singleSite.length,
    } satisfies OkBody<'listSurveyResponses'>,
  },
  [`GET ${MULTI_SITE_V1}/responses`]: {
    status: 200,
    body: {
      data: surveyResponses.multiSite,
      total: surveyResponses.multiSite.length,
    } satisfies OkBody<'listSurveyResponses'>,
  },
  [`POST ${MULTI_SITE_V1}/schedule`]: {
    status: 200,
    body: { data: surveySchedule } satisfies OkBody<'scheduleSurvey'>,
  },
  [`POST ${MULTI_SITE_V1}/targets/bulk`]: {
    status: 200,
    body: { data: bulkTargetResult } satisfies OkBody<'bulkTargetSurvey'>,
  },
} satisfies FakeRouteTable;
