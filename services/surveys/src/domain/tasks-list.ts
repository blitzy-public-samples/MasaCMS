// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** A survey's launch and reminder tasks, read from the scheduled tasks communications created for it. */
import type { FastifyInstance } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { paths } from '../generated/clients/communications.js';
import {
  toFixtureTaskList,
  toScheduledTaskView,
  type FixtureTaskItem,
  type ScheduledTaskRecord,
  type ScheduledTaskViewItem,
} from '../legacy/tasks-view.js';
import { getSchedule, listReminders } from '../repo/queries.js';
import { requireSurvey } from './surveys.js';

type ListScheduledTasks = paths['/internal/v1/scheduled-tasks']['get'];
type ListQuery = ListScheduledTasks['parameters']['query'];
type ListBody = ListScheduledTasks['responses'][200]['content']['application/json'];

const COMMUNICATIONS = 'communications';
const LIST_PATH = '/internal/v1/scheduled-tasks';

/** The survey whose tasks are listed: the verified token's tenant and the requested survey id. */
export interface SurveyTasksQuery {
  tenantId: string;
  surveyId: string;
}

/** The service's tenant database; a service created without one cannot list tasks. */
function tenantDbOf(app: FastifyInstance): TenantDb {
  const { db } = app.opt2;
  if (db === undefined) throw new TypeError('Listing survey tasks needs a service created with a database');
  return db;
}

/** Communications' records of the survey's current schedule version; any answer but 2xx is the legacy 503. */
async function scheduledTasksOf(app: FastifyInstance, surveyId: string): Promise<ScheduledTaskRecord[]> {
  const query: ListQuery = { sourceType: 'survey', sourceId: surveyId };
  // The client forwards the caller's user token, from which communications takes the tenant.
  const res = await app.opt2.client.request<ListBody>({ service: COMMUNICATIONS, method: 'GET', path: LIST_PATH, query });
  if (res.status < 200 || res.status >= 300) {
    throw new LegacyServiceUnavailableError(
      `Service ${COMMUNICATIONS} listScheduledTasks answered HTTP ${String(res.status)}`,
      'auto',
      'service-unavailable',
    );
  }
  return res.body.items;
}

/** The fixture's task items of the survey: existence first, then communications' records under the survey's own task names and offsets. */
export async function listSurveyTasks(app: FastifyInstance, { tenantId, surveyId }: SurveyTasksQuery): Promise<FixtureTaskItem[]> {
  const recorded = await withTenant(tenantDbOf(app), tenantId, async (tx) => {
    const survey = await requireSurvey(tx, surveyId);
    const schedule = await getSchedule(tx, survey.survey_id);
    const reminders = await listReminders(tx, survey.survey_id);
    return { surveyId: survey.survey_id, schedule, reminders };
  });
  return toFixtureTaskList(await scheduledTasksOf(app, recorded.surveyId), recorded);
}

/** The `/v1/` task views of the survey: every record of communications' current schedule version, in communications' order. */
export async function listSurveyTaskViews(
  app: FastifyInstance,
  { tenantId, surveyId }: SurveyTasksQuery,
): Promise<ScheduledTaskViewItem[]> {
  const survey = await withTenant(tenantDbOf(app), tenantId, (tx) => requireSurvey(tx, surveyId));
  return (await scheduledTasksOf(app, survey.survey_id)).map(toScheduledTaskView);
}
