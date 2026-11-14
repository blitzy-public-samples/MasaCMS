// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components } from '@/generated/clients/surveys';
import { html, type SafeHtml } from '@/lib/html';
import type { RequestContext } from '@/lib/request-context';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext } from '../../registry';
import {
  block,
  controlGroup,
  gridTable,
  opt2ActionUrl,
  opt2Label,
  opt2View,
  postForm,
  submitToService,
  textInput,
  type Opt2Write,
} from '../shared';
import {
  NO_SURVEY,
  SURVEYS_MODULE,
  SURVEYS_ROLES,
  dateTimeText,
  readOf,
  siteIdOf,
  surveyHeader,
  surveyIdOf,
  unreadHeader,
  type Survey,
  type Unread,
} from './common';

type ScheduledTaskView = components['schemas']['ScheduledTaskView'];
type ScheduleRequest = components['schemas']['ScheduleRequest'];

/** The survey with its schedule and the tasks communications holds for it, or the alert shown in their place. */
export type ScheduleData = { readonly survey: Survey; readonly tasks: readonly ScheduledTaskView[] } | Unread;

/** The schedule form's text: launch time as `yyyy-mm-ddThh:mm:ss` and reminder offsets in minutes, comma-separated. */
interface ScheduleValues {
  launch: string;
  reminders: string;
}

// The service takes integer offsets; other text goes as NaN (JSON null), which it answers invalidParameters.
const INTEGER = /^[+-]?\d+$/;

/** The survey (`getSurvey`), then its tasks (`listSurveyTasks`) with the CSRF pair of its id context. */
async function loadSchedule(ctx: ScreenContext, surveyId: string): Promise<ScheduleData> {
  if (surveyId === '') return NO_SURVEY;
  const query = { siteid: siteIdOf(ctx) };
  const survey = readOf(
    await ctx.gateway.surveys.call('get', '/v1/surveys/{surveyId}', { params: { surveyId }, query }),
    'getSurvey',
  );
  if ('unread' in survey) return survey;
  // The form posts the stored id, which the service takes as the CSRF context, so the pair is issued for that id.
  const storedId = survey.body.data.surveyId;
  const [tasks] = await Promise.all([
    ctx.gateway.surveys.call('get', '/v1/surveys/{surveyId}/tasks', { params: { surveyId }, query }),
    ctx.csrf.prefetch([storedId]),
  ]);
  const taskList = readOf(tasks, 'listSurveyTasks');
  if ('unread' in taskList) return taskList;
  return { survey: survey.body.data, tasks: taskList.body.data };
}

/** The stored schedule as form text; empty when the survey was never scheduled. */
function storedValues(survey: Survey): ScheduleValues {
  const { schedule } = survey;
  if (schedule === null) return { launch: '', reminders: '' };
  return {
    launch: schedule.launchAt.slice(0, 'yyyy-mm-ddThh:mm:ss'.length),
    reminders: schedule.reminders.map((reminder) => reminder.offsetMinutes).join(','),
  };
}

/** The posted form text. */
function postedValues(rc: RequestContext): ScheduleValues {
  return { launch: rc['launchAt'] ?? '', reminders: rc['reminders'] ?? '' };
}

/** The `scheduleSurvey` body of the form text: one reminder per non-blank comma-separated offset, in order. */
function scheduleRequestOf(values: ScheduleValues): ScheduleRequest {
  const offsets = values.reminders
    .split(',')
    .map((text) => text.trim())
    .filter((text) => text !== '');
  return {
    launchAt: values.launch.trim(),
    reminders: offsets.map((text) => ({ offsetMinutes: INTEGER.test(text) ? Number(text) : Number.NaN })),
  };
}

/**
 * Status, the schedule form holding `values` (default: the stored schedule), then the reminder and task grids;
 * `alert` follows the header. Without a survey, only the header, `alert` and the read's alert.
 */
function renderSchedule(
  ctx: ScreenContext,
  data: ScheduleData,
  { alert, values }: { alert?: SafeHtml; values?: ScheduleValues } = {},
): SafeHtml {
  if ('unread' in data) return html`${unreadHeader(ctx, 'schedule')}${alert}${data.unread}`;
  const { survey, tasks } = data;
  const shown = values ?? storedValues(survey);
  const form = postForm(
    opt2ActionUrl(SURVEYS_MODULE, 'schedule', { siteid: siteIdOf(ctx), surveyid: survey.surveyId }),
    html`${controlGroup('Launch At (yyyy-mm-ddThh:mm:ss)', textInput('launchAt', shown.launch))}${controlGroup(
      'Reminder Offsets (minutes after launch, comma-separated)',
      textInput('reminders', shown.reminders),
    )}`,
    'Save Schedule',
    { hidden: ctx.csrf.render(survey.surveyId) },
  );
  const reminders = gridTable(
    ['Reminder', 'Offset (minutes)', 'Remind At', 'Sent At'],
    (survey.schedule?.reminders ?? []).map((reminder) => [
      reminder.n,
      reminder.offsetMinutes,
      dateTimeText(reminder.remindAt),
      dateTimeText(reminder.sentAt),
    ]),
    'No reminders are scheduled.',
  );
  const status = opt2Label(ctx, 'Status');
  const taskGrid = gridTable(
    ['Task', 'Kind', 'Scheduled For', status],
    tasks.map((task) => [task.taskName, task.kind, dateTimeText(task.scheduleTime), task.status]),
    'No launch or reminder tasks are scheduled.',
  );
  return html`${surveyHeader(ctx, survey, 'schedule')}${alert}${block(
    html`<p>${status}: ${survey.status}</p>${form}<h2>Reminders</h2>${reminders}<h2>Tasks</h2>${taskGrid}`,
  )}`;
}

/** Loads and renders the schedule body of `surveyId`: `opts.alert` after the header, the form holding `opts.values`. */
export async function scheduleBody(
  ctx: ScreenContext,
  surveyId: string,
  opts: { alert?: SafeHtml; values?: { launch?: string; reminders?: string } } = {},
): Promise<SafeHtml> {
  const { alert, values } = opts;
  const shown = values && { launch: values.launch ?? '', reminders: values.reminders ?? '' };
  return renderSchedule(ctx, await loadSchedule(ctx, surveyId), { alert, values: shown });
}

/** `/opt2/admin/surveys/schedule?surveyid=…`: launch time, reminders and their tasks. */
export const scheduleScreen: Opt2ScreenDefinition<ScheduleData> = {
  module: SURVEYS_MODULE,
  screen: 'schedule',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  load: (ctx) => loadSchedule(ctx, surveyIdOf(ctx)),
  render: (ctx, data) => opt2View(SURVEYS_MODULE, renderSchedule(ctx, data)),
};

/** `/opt2/admin-actions/surveys/schedule`: replaces the survey's schedule (`scheduleSurvey`), then shows it. */
export const scheduleAction: Opt2ActionDefinition = {
  module: SURVEYS_MODULE,
  action: 'schedule',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  submit(ctx) {
    const surveyId = surveyIdOf(ctx);
    const siteid = siteIdOf(ctx);
    const values = postedValues(ctx.req.rc);
    const write: Opt2Write = {
      service: 'surveys',
      call: (gateway, headers) =>
        gateway.surveys.call('post', '/v1/surveys/{surveyId}/schedule', {
          params: { surveyId },
          query: { siteid },
          json: scheduleRequestOf(values),
          headers,
        }),
    };
    return submitToService(
      ctx,
      write,
      { module: SURVEYS_MODULE, screen: 'schedule', params: { siteid, surveyid: surveyId } },
      (alert) => scheduleBody(ctx, surveyId, { alert, values }),
    );
  },
};
