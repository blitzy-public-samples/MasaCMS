// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components } from '@/generated/clients/surveys';
import { okBody } from '@/lib/gateway-client';
import { html, type SafeHtml } from '@/lib/html';
import type { RequestContext } from '@/lib/request-context';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext } from '../../registry';
import {
  block,
  controlGroup,
  gridTable,
  opt2ActionUrl,
  opt2View,
  postForm,
  submitToService,
  textInput,
  type Opt2Write,
} from '../shared';
import {
  SURVEYS_MODULE,
  SURVEYS_ROLES,
  dateTimeText,
  loadSurvey,
  siteIdOf,
  surveyHeader,
  surveyIdOf,
  type Survey,
} from './common';

type ScheduledTaskView = components['schemas']['ScheduledTaskView'];
type ScheduleRequest = components['schemas']['ScheduleRequest'];

/** The survey with its schedule and the launch and reminder tasks communications holds for it. */
export interface ScheduleData {
  survey: Survey;
  tasks: ScheduledTaskView[];
}

/** The schedule form's text: launch time as `yyyy-mm-ddThh:mm:ss` and reminder offsets in minutes, comma-separated. */
interface ScheduleValues {
  launchAt: string;
  reminders: string;
}

// The service takes integer offsets; other text goes as NaN (JSON null), which it answers invalidParameters.
const INTEGER = /^[+-]?\d+$/;

/** The survey (`getSurvey`), its tasks (`listSurveyTasks`) and the CSRF pair of its id context. */
async function loadSchedule(ctx: ScreenContext): Promise<ScheduleData> {
  const surveyId = surveyIdOf(ctx);
  const [survey, tasks] = await Promise.all([
    loadSurvey(ctx, surveyId),
    ctx.gateway.surveys
      .call('get', '/v1/surveys/{surveyId}/tasks', { params: { surveyId }, query: { siteid: siteIdOf(ctx) } })
      .then((res) => okBody(res, 'surveys', 'listSurveyTasks').data),
    ctx.csrf.prefetch([surveyId]),
  ]);
  return { survey, tasks };
}

/** The stored schedule as form text; empty when the survey was never scheduled. */
function storedValues(survey: Survey): ScheduleValues {
  const { schedule } = survey;
  if (schedule === null) return { launchAt: '', reminders: '' };
  return {
    launchAt: schedule.launchAt.slice(0, 'yyyy-mm-ddThh:mm:ss'.length),
    reminders: schedule.reminders.map((reminder) => reminder.offsetMinutes).join(','),
  };
}

/** The posted form text. */
function postedValues(rc: RequestContext): ScheduleValues {
  return { launchAt: rc['launchAt'] ?? '', reminders: rc['reminders'] ?? '' };
}

/** The `scheduleSurvey` body of the form text: one reminder per non-blank comma-separated offset, in order. */
function scheduleRequestOf(values: ScheduleValues): ScheduleRequest {
  const offsets = values.reminders
    .split(',')
    .map((text) => text.trim())
    .filter((text) => text !== '');
  return {
    launchAt: values.launchAt.trim(),
    reminders: offsets.map((text) => ({ offsetMinutes: INTEGER.test(text) ? Number(text) : Number.NaN })),
  };
}

/** Status, the schedule form holding `values`, then the reminder and task grids; `alert` follows the header. */
function renderSchedule(ctx: ScreenContext, data: ScheduleData, values: ScheduleValues, alert?: SafeHtml): SafeHtml {
  const { survey, tasks } = data;
  const form = postForm(
    opt2ActionUrl(SURVEYS_MODULE, 'schedule', { siteid: siteIdOf(ctx), surveyid: survey.surveyId }),
    html`${controlGroup('Launch At (yyyy-mm-ddThh:mm:ss)', textInput('launchAt', values.launchAt))}${controlGroup(
      'Reminder Offsets (minutes after launch, comma-separated)',
      textInput('reminders', values.reminders),
    )}`,
    'Save Schedule',
    { hidden: ctx.csrf.render(surveyIdOf(ctx)) },
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
  const taskGrid = gridTable(
    ['Task', 'Kind', 'Scheduled For', 'Status'],
    tasks.map((task) => [task.taskName, task.kind, dateTimeText(task.scheduleTime), task.status]),
    'No launch or reminder tasks are scheduled.',
  );
  return html`${surveyHeader(ctx, survey, 'schedule')}${alert}${block(
    html`<p>Status: ${survey.status}</p>${form}<h2>Reminders</h2>${reminders}<h2>Tasks</h2>${taskGrid}`,
  )}`;
}

/** `/opt2/admin/surveys/schedule?surveyid=…`: launch time, reminders and their tasks. */
export const scheduleScreen: Opt2ScreenDefinition<ScheduleData> = {
  module: SURVEYS_MODULE,
  screen: 'schedule',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  load: loadSchedule,
  render: (ctx, data) => opt2View(SURVEYS_MODULE, renderSchedule(ctx, data, storedValues(data.survey))),
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
      async (alert) => renderSchedule(ctx, await loadSchedule(ctx), values, alert),
    );
  },
};
