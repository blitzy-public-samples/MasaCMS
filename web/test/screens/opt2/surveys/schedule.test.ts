// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
// The surveys schedule screen and its post action: DOM snapshot, service calls, CSRF forwarding, re-render, denials.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { alertBox, GUARDED_SUBMIT, valueRows } from '@/screens/opt2/shared';
import type { Survey } from '@/screens/opt2/surveys/common';
import { scheduleBody } from '@/screens/opt2/surveys/schedule';
import {
  SURVEY_IDS,
  invalidScheduleRequest,
  multiSiteSurvey,
  scheduleInvalid,
  scheduleRequest,
  surveyTasks,
} from '../../../fixtures/opt2/surveys';
import { fragmentModel, type DomModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { routeKey, type FakeReply } from '../../../helpers/fake-gateway';
import { FIXED_CSRF, renderScreenPage } from '../../../helpers/screen-context';
import {
  NOACCESS,
  SITE,
  bodyHtml,
  bodyModel,
  contextFor,
  csrfContexts,
  managerRequest,
  renderedModel,
  surveysAction,
  surveysCalls,
  surveysGateway,
  surveysScreen,
} from './context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const MULTI = SURVEY_IDS.multiSiteSurvey;
const SINGLE = SURVEY_IDS.singleSiteSurvey;
const SCHEDULE_PATH = `/v1/surveys/${MULTI}/schedule` as const;
const SCHEDULE_ROUTE = routeKey('POST', 'surveys', SCHEDULE_PATH);
const SURVEY_ROUTE = routeKey('GET', 'surveys', `/v1/surveys/${MULTI}` as const);
const TASKS_ROUTE = routeKey('GET', 'surveys', `/v1/surveys/${MULTI}/tasks` as const);
const CSRF_POSTED = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };
/** Display text of each task status. */
const TASK_STATUS_TEXT: Readonly<Record<(typeof surveyTasks)[number]['status'], string>> = {
  scheduled: 'Scheduled',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
};
const NOT_FOUND_ENVELOPE = {
  apiversion: 'v1',
  method: 'surveys.get',
  error: { message: 'The requested survey does not exist.', code: 'invalid_request' },
};
const errorAlert = (text: string) => ({ text, className: 'alert alert-error' });

/** The body of a request naming no survey of the site: the header linking the list, then `alerts`. */
const noSurveyModel = (alerts: DomModel['alerts']): DomModel => ({
  title: '',
  headings: ['Schedule'],
  labels: [],
  controls: [],
  buttons: [],
  links: [{ href: `/opt2/admin/surveys/surveys?siteid=${SITE}`, text: 'Surveys' }],
  tables: [],
  alerts,
});
const CSRF_HEADERS = { 'x-csrf_token': FIXED_CSRF.token, 'x-csrf_token_expires': FIXED_CSRF.expires };

const control = (tag: 'input' | 'textarea', name: string, type: string, value: string) => ({
  tag,
  name,
  type,
  value,
  checked: false,
  selected: [],
  options: [],
});

const headerLinks = (surveyId: string) => [
  { href: `/opt2/admin/surveys/surveys?siteid=${SITE}`, text: 'Surveys' },
  { href: `/opt2/admin/surveys/targets?siteid=${SITE}&surveyid=${surveyId}`, text: 'Targets' },
  { href: `/opt2/admin/surveys/responses?siteid=${SITE}&surveyid=${surveyId}`, text: 'Responses' },
];

/** The schedule form's model parts holding `launchAt` and `reminders`, with tokens as `tokenValue`. */
const formParts = (launchAt: string, reminders: string, tokenValue: string, expiresValue: string) => ({
  labels: ['Launch At (yyyy-mm-ddThh:mm:ss)', 'Reminder Offsets (minutes after launch, comma-separated)'],
  controls: [
    control('input', 'launchAt', 'text', launchAt),
    control('input', 'reminders', 'text', reminders),
    control('input', 'csrf_token', 'hidden', tokenValue),
    control('input', 'csrf_token_expires', 'hidden', expiresValue),
  ],
  buttons: [{ text: 'Save Schedule', type: 'submit', hasOnclick: false }],
});

/** The survey read answering the multi-site survey in `status`. */
const surveyIn = (status: Survey['status']) => ({ status: 200, body: { data: { ...multiSiteSurvey, status } } });

/** The status badge of each survey status whose schedule is read-only. */
const READ_ONLY_BADGES = {
  LAUNCHED: '<span class="label label-success">Launched</span>',
  CLOSED: '<span class="label label-inverse">Closed</span>',
} as const;

/**
 * The multi-site survey's status line, any `alert`, its stored schedule as read-only values and why they cannot
 * change, closing the schedule block.
 */
const storedScheduleHtml = (status: keyof typeof READ_ONLY_BADGES, alert = ''): string =>
  `<p>Status: ${READ_ONLY_BADGES[status]}</p>${alert}${toString(
    valueRows([
      ['Launch At (yyyy-mm-ddThh:mm:ss)', '2026-07-01T09:00:00'],
      ['Reminder Offsets (minutes after launch, comma-separated)', '1440,4320'],
    ]),
  )}<p class="help-block">A ${status} survey's schedule can no longer be changed.</p></div>`;

const scheduleRc = (rc: Record<string, string> = {}): Record<string, string> => ({
  surveyid: MULTI,
  launchAt: scheduleRequest.launchAt,
  reminders: '1440,4320',
  ...CSRF_POSTED,
  ...rc,
});

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('surveys schedule screen', () => {
  it('shows the launch, reminders and their tasks in a schedule form (DOM snapshot)', async () => {
    const gateway = surveysGateway();

    const model = await bodyModel('schedule', managerRequest({ surveyid: MULTI }), gateway);

    expect(model).toEqual<DomModel>({
      title: '',
      headings: ['Schedule', 'Reminders', 'Tasks'],
      ...formParts('2026-07-01T09:00:00', '1440,4320', FIXED_CSRF.token, FIXED_CSRF.expires),
      links: headerLinks(MULTI),
      tables: [
        {
          headers: ['Reminder', 'Offset (minutes)', 'Remind At', 'Sent At'],
          rows: [
            ['1', '1440', '2026-07-02 09:00:00', ''],
            ['2', '4320', '2026-07-04 09:00:00', ''],
          ],
        },
        {
          headers: ['Task', 'Kind', 'Scheduled For', 'Status'],
          rows: surveyTasks.map((task) => [
            task.taskName,
            task.kind,
            task.scheduleTime.slice(0, 19).replace('T', ' '),
            TASK_STATUS_TEXT[task.status],
          ]),
        },
      ],
      alerts: [],
    });
    expect(surveysCalls(gateway).map(({ method, path, query }) => ({ method, path, query }))).toEqual([
      { method: 'GET', path: `/v1/surveys/${MULTI}`, query: { siteid: SITE } },
      { method: 'GET', path: `/v1/surveys/${MULTI}/tasks`, query: { siteid: SITE } },
    ]);
    expect(csrfContexts(gateway)).toEqual([MULTI]);
    const html = await bodyHtml('schedule', managerRequest({ surveyid: MULTI }), surveysGateway());
    expect(html).toContain('<p>Status: <span class="label label-info">Scheduled</span></p>');
    expect(html).toContain('<td><span class="label label-info">Scheduled</span></td>');
  });

  it('posts form1 to the schedule action of the survey with the CSRF pair of its id', async () => {
    const page = await renderScreenPage(
      surveysScreen('schedule'),
      contextFor(managerRequest({ surveyid: MULTI }), surveysGateway()),
    );

    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const action =
      `&#x2f;opt2&#x2f;admin-actions&#x2f;surveys&#x2f;schedule&#x3f;siteid&#x3d;${SITE}&amp;surveyid&#x3d;${MULTI}`;
    expect(page.html).toContain(
      `<form novalidate="novalidate" action="${action}" method="post" name="form1"${GUARDED_SUBMIT.value}>`,
    );
    expect(page.html).toMatch(/<a class="active" href="\/opt2\/admin\/surveys\/surveys\?siteid=tenant-a">/);
    expect(page.html).not.toContain(' autofocus');
  });

  it('shows an empty form and empty grids for a survey never scheduled', async () => {
    const model = await bodyModel('schedule', managerRequest({ surveyid: SINGLE }), surveysGateway());

    expect(model.headings).toEqual(['Schedule', 'Reminders', 'Tasks']);
    expect(model.controls.slice(0, 2).map(({ value }) => value)).toEqual(['', '']);
    expect(model.tables).toEqual([]);
  });

  it.each(['LAUNCHED', 'CLOSED'] as const)(
    'shows the stored schedule of a %s survey read-only, with no form and no CSRF pair',
    async (status) => {
      const editable = await bodyModel('schedule', managerRequest({ surveyid: MULTI }), surveysGateway());
      const gateway = surveysGateway({ [SURVEY_ROUTE]: surveyIn(status) });

      const body = await bodyHtml('schedule', managerRequest({ surveyid: MULTI }), gateway);

      expect(body).not.toContain('<form');
      expect(body).toContain(storedScheduleHtml(status));
      expect(fragmentModel(body)).toMatchObject({
        headings: editable.headings,
        controls: [],
        buttons: [],
        links: editable.links,
        tables: editable.tables,
        alerts: [],
      });
      expect(csrfContexts(gateway)).toEqual([]);
    },
  );

  it('shows the no-survey alert and asks no service when the request names no survey', async () => {
    const gateway = surveysGateway();

    const model = await bodyModel('schedule', managerRequest(), gateway);

    expect(model).toEqual(noSurveyModel([{ text: 'No survey selected.', className: 'alert alert-info' }]));
    expect(gateway.calls).toEqual([]);
  });

  it.each([
    { name: 'an empty survey 404', route: SURVEY_ROUTE, reply: { status: 404 }, alert: 'Not Found', reads: 1 },
    {
      name: 'a survey 404 envelope',
      route: SURVEY_ROUTE,
      reply: { status: 404, body: NOT_FOUND_ENVELOPE },
      alert: 'The requested survey does not exist.',
      reads: 1,
    },
    {
      name: 'a survey 400 envelope',
      route: SURVEY_ROUTE,
      reply: scheduleInvalid,
      alert: 'Invalid parameters',
      reads: 1,
    },
    { name: 'a tasks 404', route: TASKS_ROUTE, reply: { status: 404 }, alert: 'Not Found', reads: 2 },
  ])('shows only the header and the envelope alert for $name', async ({ route, reply, alert, reads }) => {
    const gateway = surveysGateway({ [route]: reply });

    const model = await bodyModel('schedule', managerRequest({ surveyid: MULTI }), gateway);

    expect(model).toEqual(noSurveyModel([errorAlert(alert)]));
    expect(surveysCalls(gateway).map(({ path }) => path)).toEqual(
      [`/v1/surveys/${MULTI}`, `/v1/surveys/${MULTI}/tasks`].slice(0, reads),
    );
  });

  it.each(['..', '../x', '../../x', 'abc'])(
    'answers the malformed survey id %j as surveys answers one, asking it nothing, on the screen and its post',
    async (surveyid) => {
      const gateway = surveysGateway();
      const alert = [errorAlert('Invalid parameters')];

      const screen = await bodyModel('schedule', managerRequest({ surveyid }), gateway);
      const post = renderedModel(
        await surveysAction('schedule').submit(contextFor(managerRequest(scheduleRc({ surveyid })), gateway)),
      );

      expect(screen).toEqual(noSurveyModel(alert));
      expect(post).toEqual(noSurveyModel(alert));
      expect(gateway.calls).toEqual([]);
    },
  );

  it.each([
    { route: SURVEY_ROUTE, status: 503, error: GatewayUnavailableError },
    { route: TASKS_ROUTE, status: 503, error: GatewayUnavailableError },
    { route: SURVEY_ROUTE, status: 401, error: GatewayDenialError },
    { route: TASKS_ROUTE, status: 500, error: Error },
  ])('propagates a $status answer to $route', async ({ route, status, error }) => {
    const gateway = surveysGateway({ [route]: { status } });

    const model = bodyModel('schedule', managerRequest({ surveyid: MULTI }), gateway);

    await expect(model).rejects.toBeInstanceOf(error);
  });
});

describe('surveys scheduleBody', () => {
  it('holds the given values, a missing field empty, under the alert', async () => {
    const ctx = contextFor(managerRequest(), surveysGateway());

    const body = await scheduleBody(ctx, MULTI, {
      alert: alertBox('Check the launch time.', 'warning'),
      values: { launch: '2026-08-01T10:00:00' },
    });

    const model = fragmentModel(toString(body));
    expect(model.alerts).toEqual([{ text: 'Check the launch time.', className: 'alert alert-warning' }]);
    expect(model.controls.slice(0, 2).map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'launchAt', value: '2026-08-01T10:00:00' },
      { name: 'reminders', value: '' },
    ]);
  });

  it('holds the stored schedule without values', async () => {
    const ctx = contextFor(managerRequest(), surveysGateway());

    const model = fragmentModel(toString(await scheduleBody(ctx, MULTI)));

    expect(model.alerts).toEqual([]);
    expect(model.controls.slice(0, 2).map(({ value }) => value)).toEqual(['2026-07-01T09:00:00', '1440,4320']);
  });
});

describe('surveys schedule action', () => {
  it('sends the schedule with the posted CSRF pair, then redirects to the schedule screen', async () => {
    const gateway = surveysGateway();

    const result = await surveysAction('schedule').submit(contextFor(managerRequest(scheduleRc()), gateway));

    expect(result).toEqual({
      kind: 'location',
      location: `/opt2/admin/surveys/schedule?siteid=${SITE}&surveyid=${MULTI}`,
    });
    expect(surveysCalls(gateway)).toEqual([
      { method: 'POST', path: SCHEDULE_PATH, query: { siteid: SITE }, json: scheduleRequest, headers: CSRF_HEADERS },
    ]);
  });

  it.each([
    { reminders: '', offsets: [] },
    { reminders: ' 1440 , ,4320 ', offsets: [1440, 4320] },
    { reminders: '+15', offsets: [15] },
    { reminders: '-5', offsets: [-5] },
    { reminders: '0x10,1e3,abc', offsets: [Number.NaN, Number.NaN, Number.NaN] },
  ])('sends reminder offsets $offsets for "$reminders"', async ({ reminders, offsets }) => {
    const gateway = surveysGateway();

    await surveysAction('schedule').submit(contextFor(managerRequest(scheduleRc({ reminders })), gateway));

    const [call] = surveysCalls(gateway);
    expect(call?.json).toEqual({
      launchAt: scheduleRequest.launchAt,
      reminders: offsets.map((offsetMinutes) => ({ offsetMinutes })),
    });
  });

  it('sends an empty launch time and no reminders when the form posted neither', async () => {
    const gateway = surveysGateway();

    await surveysAction('schedule').submit(contextFor(managerRequest({ surveyid: MULTI, ...CSRF_POSTED }), gateway));

    expect(surveysCalls(gateway)[0]?.json).toEqual({ launchAt: '', reminders: [] });
  });

  it('sends no CSRF headers when no token was posted', async () => {
    const gateway = surveysGateway();
    const rc = scheduleRc({ csrf_token: '', csrf_token_expires: '' });

    await surveysAction('schedule').submit(contextFor(managerRequest(rc), gateway));

    expect(surveysCalls(gateway)[0]?.headers).toBeUndefined();
  });

  it.each([
    { status: 400, body: scheduleInvalid.body, alert: 'Invalid parameters' },
    {
      status: 409,
      body: { apiversion: 'v1', method: 'surveys.schedule', error: { message: 'Conflict', code: 'invalid_request' } },
      alert: 'Conflict',
    },
    {
      status: 403,
      body: {
        apiversion: 'v1',
        method: 'surveys.schedule',
        error: { message: 'Insufficient Account Permissions', code: 'invalid_request' },
      },
      alert: 'Insufficient Account Permissions',
    },
    { status: 404, body: undefined, alert: 'Not Found' },
  ])('re-renders the posted values under the $status alert', async ({ status, body, alert }) => {
    const gateway = surveysGateway({ [SCHEDULE_ROUTE]: { status, body } });
    const rc = scheduleRc({ launchAt: invalidScheduleRequest.launchAt, reminders: '1440' });

    const model = renderedModel(await surveysAction('schedule').submit(contextFor(managerRequest(rc), gateway)));

    expect(model.alerts).toEqual([{ text: alert, className: 'alert alert-error' }]);
    expect(model).toMatchObject(formParts(invalidScheduleRequest.launchAt, '1440', '<token>', '<token>'));
    expect(model.headings).toEqual(['Schedule', 'Reminders', 'Tasks']);
    expect(csrfContexts(gateway)).toEqual([MULTI]);
  });

  it('re-renders a survey closed before the post with its stored schedule read-only under the 409 alert', async () => {
    const gateway = surveysGateway({
      [SCHEDULE_ROUTE]: {
        status: 409,
        body: { apiversion: 'v1', method: 'surveys.schedule', error: { message: 'Conflict', code: 'invalid_request' } },
      },
      [SURVEY_ROUTE]: surveyIn('CLOSED'),
    });
    const rc = scheduleRc({ launchAt: invalidScheduleRequest.launchAt, reminders: '1440' });

    const result = await surveysAction('schedule').submit(contextFor(managerRequest(rc), gateway));

    expect(renderedModel(result)).toMatchObject({ controls: [], buttons: [], alerts: [errorAlert('Conflict')] });
    const body = result.kind === 'render' ? toString(result.view.body) : '';
    expect(body.indexOf('<div class="mura-header">')).toBe(0);
    expect(body).toContain(storedScheduleHtml('CLOSED', toString(alertBox('Conflict'))));
    expect(csrfContexts(gateway)).toEqual([]);
  });

  const LAUNCH_MESSAGE =
    'Enter an existing date and time from 1753 on as yyyy-mm-ddThh:mm:ss, for example 2026-06-30T09:15:00.';
  const REMINDERS_MESSAGE = 'Enter whole numbers of minutes, 0 or more, separated by commas.';
  /** A schedule refusal answered with `status` and envelope `message`. */
  const scheduleRefusal = (status: number, message: string): FakeReply => ({
    status,
    body: { apiversion: 'v1', method: 'surveys.schedule', error: { message, code: 'invalid_request' } },
  });
  const CSRF_REFUSAL = scheduleRefusal(400, 'Invalid CSRF tokens');

  /** The re-rendered schedule body of a schedule of `rc` refused with `reply`. */
  async function refusedBody(rc: Record<string, string>, reply: FakeReply = scheduleInvalid) {
    const gateway = surveysGateway({ [SCHEDULE_ROUTE]: reply });
    const result = await surveysAction('schedule').submit(contextFor(managerRequest(scheduleRc(rc)), gateway));
    if (result.kind !== 'render') throw new Error(`Expected a re-render, got ${result.kind}`);
    return cheerio.load(toString(result.view.body), null, false);
  }

  /** The marked fields of a schedule of `rc` refused with `reply`: name, message and focus, in order. */
  async function markedFields(rc: Record<string, string>, reply: FakeReply = scheduleInvalid) {
    const $ = await refusedBody(rc, reply);
    expect($('[autofocus]')).toHaveLength(1);
    return $('div.mura-control-group.has-error')
      .toArray()
      .map((group) => {
        const input = $(group).find('input');
        const message = $(group).children('label').next('p.help-block');
        expect(input.attr('aria-invalid')).toBe('true');
        expect(input.attr('aria-describedby')).toBe(`${input.attr('id')}-error`);
        expect(message.attr('id')).toBe(`${input.attr('id')}-error`);
        return [input.attr('name'), message.text(), input.attr('autofocus') !== undefined];
      });
  }

  it.each<{ label: string; rc: Record<string, string>; marked: unknown[][] }>([
    { label: 'the launch time tomorrow', rc: { launchAt: 'tomorrow' }, marked: [['launchAt', LAUNCH_MESSAGE, true]] },
    ...['2026-08-01T10:00', '2026-06-31T09:00:00', '2026-08-01T24:00:00', '1752-12-31T23:59:59'].map((launchAt) => ({
      label: `the launch time ${launchAt}`,
      rc: { launchAt },
      marked: [['launchAt', LAUNCH_MESSAGE, true]],
    })),
    { label: 'the offsets abc,60', rc: { reminders: 'abc,60' }, marked: [['reminders', REMINDERS_MESSAGE, true]] },
    { label: 'the offset -30', rc: { reminders: '-30' }, marked: [['reminders', REMINDERS_MESSAGE, true]] },
    { label: 'the offset 1.5', rc: { reminders: '60,1.5' }, marked: [['reminders', REMINDERS_MESSAGE, true]] },
    {
      label: 'both fields, the launch time focused',
      rc: { launchAt: 'tomorrow', reminders: '-30' },
      marked: [
        ['launchAt', LAUNCH_MESSAGE, true],
        ['reminders', REMINDERS_MESSAGE, false],
      ],
    },
  ])('marks $label beside its field on the invalidParameters refusal', async ({ rc, marked }) => {
    expect(await markedFields(rc)).toEqual(marked);
  });

  it.each<{ label: string; rc: Record<string, string>; reply?: FakeReply }>([
    {
      label: 'a padded launch time and +15, -0 and blank offsets, which surveys may accept',
      rc: { launchAt: ' 2026-08-01T10:00:00 ', reminders: '+15, -0, ,30' },
    },
    { label: 'a leap day, which surveys may accept', rc: { launchAt: '2028-02-29T23:59:59' } },
    { label: 'the first allowed year, which surveys may accept', rc: { launchAt: '1753-01-01T00:00:00' } },
    ...(
      [
        ['a CSRF refusal', CSRF_REFUSAL],
        ['a role refusal (403)', scheduleRefusal(403, 'Insufficient Account Permissions')],
        ['an unknown survey (404)', scheduleRefusal(404, 'Not Found')],
        ['a conflict (409)', scheduleRefusal(409, 'Conflict')],
      ] as const
    ).map(([label, reply]) => ({
      label: `${label}, which says nothing of the values`,
      rc: { launchAt: 'tomorrow', reminders: '-30' },
      reply,
    })),
  ])('marks no field for $label, and focuses the launch time', async ({ rc, reply }) => {
    const $ = await refusedBody(rc, reply);
    expect($('.has-error')).toHaveLength(0);
    expect($('[aria-invalid]')).toHaveLength(0);
    expect(
      $('[autofocus]')
        .toArray()
        .map((el) => $(el).attr('id')),
    ).toEqual(['launchAt']);
  });

  it('shows the refused schedule alert just before the schedule form, the posted text kept', async () => {
    const $ = await refusedBody({ launchAt: 'tomorrow', reminders: 'abc,60' });

    expect($('form[name="form1"]').prev().is('div.alert.alert-error')).toBe(true);
    expect($('div.mura-header').next().is('div.alert')).toBe(false);
    expect([$('#launchAt').attr('value'), $('#reminders').attr('value')]).toEqual(['tomorrow', 'abc,60']);
  });

  it('re-renders only the header, the write alert and the read alert when the survey is gone', async () => {
    const gateway = surveysGateway({
      [SCHEDULE_ROUTE]: { status: 404, body: NOT_FOUND_ENVELOPE },
      [SURVEY_ROUTE]: { status: 404 },
    });

    const result = await surveysAction('schedule').submit(contextFor(managerRequest(scheduleRc()), gateway));

    expect(renderedModel(result)).toEqual(
      noSurveyModel([errorAlert('The requested survey does not exist.'), errorAlert('Not Found')]),
    );
    expect(csrfContexts(gateway)).toEqual([]);
  });

  it('answers a refused user token with the login redirect error', async () => {
    const gateway = surveysGateway({ [SCHEDULE_ROUTE]: { status: 401 } });

    const result = surveysAction('schedule').submit(contextFor(managerRequest(scheduleRc()), gateway));

    await expect(result).rejects.toMatchObject({ name: 'GatewayDenialError', status: 401 });
  });

  it('answers the no-access redirect when the service refuses both the write and the re-render reads', async () => {
    const gateway = surveysGateway({ [SCHEDULE_ROUTE]: { status: 403 }, [SURVEY_ROUTE]: { status: 403 } });

    const result = surveysAction('schedule').submit(contextFor(managerRequest(scheduleRc()), gateway));

    await expect(result).rejects.toBeInstanceOf(GatewayDenialError);
    await expect(result).rejects.toMatchObject({ status: 403 });
    const page = await renderScreenPage(
      surveysScreen('schedule'),
      contextFor(managerRequest({ surveyid: MULTI }), gateway),
    );
    expect(page).toEqual({ kind: 'redirect', location: NOACCESS });
  });

  it.each([
    { status: 503, error: GatewayUnavailableError },
    { status: 500, error: Error },
  ])('propagates a $status write answer', async ({ status, error }) => {
    const gateway = surveysGateway({ [SCHEDULE_ROUTE]: { status } });

    const result = surveysAction('schedule').submit(contextFor(managerRequest(scheduleRc()), gateway));

    await expect(result).rejects.toBeInstanceOf(error);
  });
});
