// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** A survey's launch and reminder tasks, read from the scheduled tasks communications created for it. */
import type { FastifyInstance } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { paths } from '../generated/clients/communications.js';
import { fixturePage, type FixtureListResult, type FixtureParams } from '../legacy/fixture-envelope.js';
import {
  compareFixtureTaskKeys,
  compareFixtureTasks,
  toFixtureTasks,
  toScheduledTaskView,
  type FixtureTaskItem,
  type FixtureTaskKey,
  type ScheduledTaskRecord,
  type ScheduledTaskViewItem,
} from '../legacy/tasks-view.js';
import { getSchedule, listReminderTaskKeys } from '../repo/queries.js';
import { requireSurvey } from './surveys.js';

type ListScheduledTasks = paths['/internal/v1/scheduled-tasks']['get'];
type ListQuery = ListScheduledTasks['parameters']['query'];
type ListBody = ListScheduledTasks['responses'][200]['content']['application/json'];

const COMMUNICATIONS = 'communications';
const LIST_PATH = '/internal/v1/scheduled-tasks';

/** Largest page communications' scheduled-task list serves, and the page size every whole list is read in. */
export const TASK_PAGE_MAX = 1000;

/** Most task names one communications call filters by, and so the survey task names one fixture batch holds. */
export const TASK_NAME_BATCH = 100;

/** The survey whose tasks are listed: the verified token's tenant and the requested survey id. */
export interface SurveyTasksQuery {
  tenantId: string;
  surveyId: string;
}

/** One page of a survey's tasks: at most `limit` (1 to TASK_PAGE_MAX; communications' default when omitted), after the cursor `after`. */
export interface SurveyTasksPage {
  limit?: number;
  after?: string;
}

/** Tasks in communications' order and the `after` cursor of the next page; `next` is null after the last page. */
export interface TaskPage<T> {
  items: T[];
  next: string | null;
}

/** One fixture page of the survey's task items and the count of all of them. */
export interface SurveyTaskListPage extends FixtureListResult {
  list: FixtureTaskItem[];
  totalItems: number;
}

/** The service's tenant database; a service created without one cannot list tasks. */
function tenantDbOf(app: FastifyInstance): TenantDb {
  const { db } = app.opt2;
  if (db === undefined) throw new TypeError('Listing survey tasks needs a service created with a database');
  return db;
}

/** One page of communications' records of the survey, of the tasks `taskNames` names when given; any answer but 2xx is the legacy 503, a 400 to the caller's cursor `invalidParameters`. */
async function scheduledTaskPage(
  app: FastifyInstance,
  surveyId: string,
  page: SurveyTasksPage & { taskNames?: readonly string[] },
  callerCursor = false,
): Promise<TaskPage<ScheduledTaskRecord>> {
  const query: ListQuery = {
    sourceType: 'survey',
    sourceId: surveyId,
    ...(page.limit === undefined ? {} : { limit: String(page.limit) }),
    ...(page.after === undefined ? {} : { after: page.after }),
    ...(page.taskNames === undefined ? {} : { taskName: [...page.taskNames] }),
  };
  // The client forwards the caller's user token, from which communications takes the tenant.
  const res = await app.opt2.client.request<ListBody>({ service: COMMUNICATIONS, method: 'GET', path: LIST_PATH, query });
  // Surveys validated every other parameter, so the refusal is of the cursor.
  if (res.status === 400 && callerCursor) {
    throw new LegacyApiError('invalidParameters');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new LegacyServiceUnavailableError(
      `Service ${COMMUNICATIONS} listScheduledTasks answered HTTP ${String(res.status)}`,
      'auto',
      'service-unavailable',
    );
  }
  return { items: res.body.items, next: res.body.next ?? null };
}

/** The survey's task names and offsets in fixture task order, its launch at offset 0, at most TASK_NAME_BATCH a batch, each read in its own tenant transaction. */
async function* fixtureTaskKeyBatches(
  db: TenantDb,
  tenantId: string,
  surveyId: string,
  launchTaskName: string | undefined,
): AsyncGenerator<FixtureTaskKey[]> {
  let launch: FixtureTaskKey | undefined = launchTaskName === undefined ? undefined : [0, launchTaskName];
  let after: FixtureTaskKey | undefined;
  for (;;) {
    const reminders = await withTenant(db, tenantId, (tx) => listReminderTaskKeys(tx, surveyId, { limit: TASK_NAME_BATCH, after }));
    const more = reminders.length === TASK_NAME_BATCH;
    let keys = reminders.map((row): FixtureTaskKey => [row.offset_minutes, row.task_name]);
    // The launch joins the first batch that reaches past it; a reminder it pushes out of a full batch leads the next one.
    const last = keys.at(-1);
    if (launch !== undefined && (!more || (last !== undefined && compareFixtureTaskKeys(launch, last) < 0))) {
      keys = [...keys, launch].sort(compareFixtureTaskKeys).slice(0, TASK_NAME_BATCH);
      launch = undefined;
    }
    if (keys.length > 0) yield keys;
    if (!more && launch === undefined) return;
    after = keys.at(-1);
  }
}

/** The fixture items of communications' records of the tasks `keys` name, in the fixture's task order. */
async function listedFixtureTasks(app: FastifyInstance, surveyId: string, keys: readonly FixtureTaskKey[]): Promise<FixtureTaskItem[]> {
  const offsets = new Map(keys.map(([offsetMinutes, taskName]) => [taskName, offsetMinutes]));
  const taskNames = [...offsets.keys()];
  const items: FixtureTaskItem[] = [];
  let after: string | undefined;
  do {
    const page = await scheduledTaskPage(app, surveyId, { limit: TASK_PAGE_MAX, after, taskNames });
    items.push(...toFixtureTasks(page.items, { surveyId, offsets }));
    after = page.next ?? undefined;
  } while (after !== undefined);
  // The sort is stable, so records of one name keep communications' order.
  return items.sort(compareFixtureTasks);
}

/** One fixture page of the survey's task items as envelope.cfc list() pages them: notFound, then paging's invalidParameters, then communications' records by name batch. */
export async function listSurveyTaskPage(
  app: FastifyInstance,
  { tenantId, surveyId, params }: SurveyTasksQuery & { params: FixtureParams },
): Promise<SurveyTaskListPage> {
  const db = tenantDbOf(app);
  const { storedId, launchTaskName } = await withTenant(db, tenantId, async (tx) => {
    const survey = await requireSurvey(tx, surveyId);
    return { storedId: survey.survey_id, launchTaskName: (await getSchedule(tx, survey.survey_id))?.task_name };
  });
  // The fixture finds the survey before list() validates paging.
  const { pageIndex, itemsPerPage, offset } = fixturePage(params);
  const list: FixtureTaskItem[] = [];
  let totalItems = 0;
  for await (const keys of fixtureTaskKeyBatches(db, tenantId, storedId, launchTaskName)) {
    for (const item of await listedFixtureTasks(app, storedId, keys)) {
      if (totalItems >= offset && list.length < itemsPerPage) list.push(item);
      totalItems += 1;
    }
  }
  return { list, pageIndex, itemsPerPage, totalItems };
}

/** The `/v1/` task views of one page of the survey's tasks, in communications' order, with the cursor of the next page. */
export async function listSurveyTaskViews(
  app: FastifyInstance,
  { tenantId, surveyId }: SurveyTasksQuery,
  page: SurveyTasksPage,
): Promise<TaskPage<ScheduledTaskViewItem>> {
  const survey = await withTenant(tenantDbOf(app), tenantId, (tx) => requireSurvey(tx, surveyId));
  const { items, next } = await scheduledTaskPage(app, survey.survey_id, page, page.after !== undefined);
  return { items: items.map(toScheduledTaskView), next };
}

/** The `/v1/` task views of communications' records from `first` on, each later page fetched only when the batch is wanted. */
async function* taskViewBatches(
  app: FastifyInstance,
  surveyId: string,
  first: TaskPage<ScheduledTaskRecord>,
): AsyncGenerator<ScheduledTaskViewItem[]> {
  let page = first;
  yield page.items.map(toScheduledTaskView);
  while (page.next !== null) {
    page = await scheduledTaskPage(app, surveyId, { limit: TASK_PAGE_MAX, after: page.next });
    yield page.items.map(toScheduledTaskView);
  }
}

/** Every `/v1/` task view of the survey's current records in communications' order, as batches; existence and the first page are read before it resolves. */
export async function listSurveyTaskViewBatches(
  app: FastifyInstance,
  { tenantId, surveyId }: SurveyTasksQuery,
): Promise<AsyncIterable<ScheduledTaskViewItem[]>> {
  const survey = await withTenant(tenantDbOf(app), tenantId, (tx) => requireSurvey(tx, surveyId));
  const first = await scheduledTaskPage(app, survey.survey_id, { limit: TASK_PAGE_MAX });
  return taskViewBatches(app, survey.survey_id, first);
}
