// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components } from '@/generated/clients/surveys';
import { html, type SafeHtml } from '@/lib/html';
import type { RequestContext } from '@/lib/request-context';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext } from '../../registry';
import {
  block,
  controlGroup,
  focusesFirst,
  gridTable,
  isMalformedId,
  opt2ActionUrl,
  opt2Label,
  opt2View,
  postForm,
  refusedFields,
  stateBadgeOf,
  submitToService,
  textInput,
  valueRows,
  type FieldRule,
  type Opt2Refusal,
  type Opt2Write,
  type StateDisplay,
} from '../shared';
import {
  SURVEYS_GATE,
  SURVEYS_MODULE,
  SURVEYS_ROLES,
  dateTimeText,
  readOf,
  siteIdOf,
  surveyHeader,
  surveyIdOf,
  surveyStatusBadge,
  surveyTitleRow,
  unreadHeader,
  unreadSurveyId,
  type Survey,
  type Unread,
} from './common';

type ScheduledTaskView = components['schemas']['ScheduledTaskView'];
type ScheduleRequest = components['schemas']['ScheduleRequest'];

/** Label and badge tone of each task status communications reports. */
const TASK_STATUSES: Readonly<Record<ScheduledTaskView['status'], StateDisplay>> = Object.freeze({
  scheduled: { label: () => 'Scheduled', tone: 'info' },
  done: { label: () => 'Done', tone: 'success' },
  failed: { label: () => 'Failed', tone: 'important' },
  cancelled: { label: () => 'Cancelled', tone: 'inverse' },
  superseded: { label: () => 'Superseded', tone: 'inverse' },
});

/** The survey with its schedule and the tasks communications holds for it, or the alert shown in their place. */
export type ScheduleData = { readonly survey: Survey; readonly tasks: readonly ScheduledTaskView[] } | Unread;

/** The schedule form's text: launch time as `yyyy-mm-ddThh:mm:ss` and reminder offsets in minutes, comma-separated. */
interface ScheduleValues {
  launch: string;
  reminders: string;
}

// The service takes integer offsets; other text goes as NaN (JSON null), which it answers invalidParameters.
const INTEGER = /^[+-]?\d+$/;

/** Statuses the service reschedules; it answers 409 for a LAUNCHED or CLOSED survey. */
const SCHEDULABLE: ReadonlySet<Survey['status']> = new Set(['DRAFT', 'SCHEDULED']);

const LAUNCH_LABEL = 'Launch At (yyyy-mm-ddThh:mm:ss)';
const REMINDERS_LABEL = 'Reminder Offsets (minutes after launch, comma-separated)';

/** The survey (`getSurvey`), then its tasks (`listSurveyTasks`), with the CSRF pair of its id when it is schedulable. */
async function loadSchedule(ctx: ScreenContext, surveyId: string): Promise<ScheduleData> {
  const unread = unreadSurveyId(surveyId);
  if (unread !== undefined) return unread;
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
    SCHEDULABLE.has(survey.body.data.status) ? ctx.csrf.prefetch([storedId]) : undefined,
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

/** The stored schedule as read-only values, with why the schedule of a survey in its status cannot change. */
function storedSchedule(survey: Survey): SafeHtml {
  const stored = storedValues(survey);
  return html`${valueRows([
    [LAUNCH_LABEL, stored.launch],
    [REMINDERS_LABEL, stored.reminders],
  ])}<p class="help-block">A ${survey.status} survey's schedule can no longer be changed.</p>`;
}

// The contract's LocalSecondTimestamp.
const LAUNCH_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/;
const MIN_LAUNCH_YEAR = 1753;

/** Whether surveys may accept launch time `text`: the contract's pattern, from 1753, on a real date and clock time. */
function mayLaunchAt(text: string): boolean {
  if (!LAUNCH_AT.test(text) || Number(text.slice(0, 4)) < MIN_LAUNCH_YEAR) return false;
  // surveys refuses a time that rolls over when parsed; read as UTC, fields roll over in every zone alike.
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = text.split(/[-T:]/).map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString().slice(0, 19) === text;
}

/** The surveys schedule rules over the body the form text is sent as: launchAt's time, offsets of 0 or more. */
const SCHEDULE_RULES: Readonly<Record<keyof ScheduleValues, FieldRule>> = Object.freeze({
  launch: (launch) =>
    mayLaunchAt(scheduleRequestOf({ launch, reminders: '' }).launchAt)
      ? undefined
      : 'Enter an existing date and time from 1753 on as yyyy-mm-ddThh:mm:ss, for example 2026-06-30T09:15:00.',
  reminders: (reminders) =>
    (scheduleRequestOf({ launch: '', reminders }).reminders ?? []).every(({ offsetMinutes }) => offsetMinutes >= 0)
      ? undefined
      : 'Enter whole numbers of minutes, 0 or more, separated by commas.',
});

/**
 * Status, `alert`, the schedule form holding `values` (default: the stored schedule) marked for `refusal` or, for a
 * survey the service does not reschedule, the stored schedule read-only, then the reminder and task grids. Without a
 * survey, only the header, `alert` and the read's alert.
 */
function renderSchedule(
  ctx: ScreenContext,
  data: ScheduleData,
  { alert, refusal, values }: { alert?: SafeHtml; refusal?: Opt2Refusal; values?: ScheduleValues } = {},
): SafeHtml {
  if ('unread' in data) return html`${unreadHeader(ctx, 'schedule')}${alert}${data.unread}`;
  const { survey, tasks } = data;
  const shown = values ?? storedValues(survey);
  const errors = refusedFields(SCHEDULE_RULES, shown, refusal);
  const form = SCHEDULABLE.has(survey.status)
    ? postForm(
        opt2ActionUrl(SURVEYS_MODULE, 'schedule', { siteid: siteIdOf(ctx), surveyid: survey.surveyId }),
        html`${controlGroup(
          LAUNCH_LABEL,
          textInput('launchAt', shown.launch, { error: errors.launch, focus: focusesFirst(refusal, errors) }),
        )}${controlGroup(REMINDERS_LABEL, textInput('reminders', shown.reminders, { error: errors.reminders }))}`,
        'Save Schedule',
        { hidden: ctx.csrf.render(survey.surveyId) },
      )
    : storedSchedule(survey);
  const reminders = gridTable(
    ['Reminder', 'Offset (minutes)', 'Remind At', 'Sent At'],
    (survey.schedule?.reminders ?? []).map((reminder) => [
      reminder.n,
      reminder.offsetMinutes,
      dateTimeText(reminder.remindAt),
      dateTimeText(reminder.sentAt),
    ]),
    'No reminders are scheduled.',
    { columnClasses: [undefined, 'hidden-xs'] },
  );
  const status = opt2Label(ctx, 'Status');
  const taskGrid = gridTable(
    ['Task', 'Kind', 'Scheduled For', status],
    tasks.map((task) => [
      task.taskName,
      task.kind,
      dateTimeText(task.scheduleTime),
      stateBadgeOf(ctx, TASK_STATUSES, task.status),
    ]),
    'No launch or reminder tasks are scheduled.',
    { columnClasses: [undefined, 'hidden-xs'] },
  );
  // The form ends its block, as legacy action rows do: the next heading carries no top margin.
  return html`${surveyHeader(ctx, survey, 'schedule')}${block(
    html`${surveyTitleRow(ctx, survey)}<p>${status}: ${surveyStatusBadge(ctx, survey.status)}</p>${alert}${form}`,
  )}${block(html`<h2>Reminders</h2>${reminders}<h2>Tasks</h2>${taskGrid}`)}`;
}

/** Loads and renders the schedule body of `surveyId` with `opts.alert`, posted `opts.values` and `opts.refusal`. */
export async function scheduleBody(
  ctx: ScreenContext,
  surveyId: string,
  opts: { alert?: SafeHtml; refusal?: Opt2Refusal; values?: { launch?: string; reminders?: string } } = {},
): Promise<SafeHtml> {
  const { alert, refusal, values } = opts;
  const shown = values && { launch: values.launch ?? '', reminders: values.reminders ?? '' };
  return renderSchedule(ctx, await loadSchedule(ctx, surveyId), { alert, refusal, values: shown });
}

/** `/opt2/admin/surveys/schedule?surveyid=…`: launch time, reminders and their tasks. */
export const scheduleScreen: Opt2ScreenDefinition<ScheduleData> = {
  module: SURVEYS_MODULE,
  screen: 'schedule',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  gate: SURVEYS_GATE,
  load: (ctx) => loadSchedule(ctx, surveyIdOf(ctx)),
  render: (ctx, data) => opt2View(SURVEYS_MODULE, renderSchedule(ctx, data), 'schedule'),
};

/** `/opt2/admin-actions/surveys/schedule`: replaces the survey's schedule (`scheduleSurvey`), then shows it. */
export const scheduleAction: Opt2ActionDefinition = {
  module: SURVEYS_MODULE,
  action: 'schedule',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  gate: SURVEYS_GATE,
  async submit(ctx) {
    const surveyId = surveyIdOf(ctx);
    const siteid = siteIdOf(ctx);
    const values = postedValues(ctx.req.rc);
    // The schedule read refuses a malformed id itself, with the invalid-parameters alert; nothing is written.
    if (isMalformedId(surveyId)) {
      return { kind: 'render', view: opt2View(SURVEYS_MODULE, await scheduleBody(ctx, surveyId), 'schedule') };
    }
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
      (alert, refusal) => scheduleBody(ctx, surveyId, { alert, refusal, values }),
    );
  },
};
