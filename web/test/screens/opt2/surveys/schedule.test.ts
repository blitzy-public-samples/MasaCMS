// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
// The surveys schedule screen and its post action: DOM snapshot, service calls, CSRF forwarding, re-render, denials.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import {
  SURVEY_IDS,
  invalidScheduleRequest,
  scheduleInvalid,
  scheduleRequest,
  surveyTasks,
} from '../../../fixtures/opt2/surveys';
import type { DomModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { routeKey } from '../../../helpers/fake-gateway';
import { FIXED_CSRF, renderScreenPage } from '../../../helpers/screen-context';
import {
  NOACCESS,
  SITE,
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
const CSRF_POSTED = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };
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
      headings: ['Schedule: Cross-program timesheet experience', 'Reminders', 'Tasks'],
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
            task.status,
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
  });

  it('posts form1 to the schedule action of the survey with the CSRF pair of its id', async () => {
    const page = await renderScreenPage(
      surveysScreen('schedule'),
      contextFor(managerRequest({ surveyid: MULTI }), surveysGateway()),
    );

    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    const action =
      `&#x2f;opt2&#x2f;admin-actions&#x2f;surveys&#x2f;schedule&#x3f;siteid&#x3d;${SITE}&amp;surveyid&#x3d;${MULTI}`;
    expect(page.html).toContain(`<form novalidate="novalidate" action="${action}" method="post" name="form1">`);
    expect(page.html).toMatch(/<a class="active" href="\/opt2\/admin\/surveys\/surveys\?siteid=tenant-a">/);
  });

  it('shows an empty form and empty grids for a survey never scheduled', async () => {
    const model = await bodyModel('schedule', managerRequest({ surveyid: SINGLE }), surveysGateway());

    expect(model.headings).toEqual(['Schedule: Program 1 onboarding check-in', 'Reminders', 'Tasks']);
    expect(model.controls.slice(0, 2).map(({ value }) => value)).toEqual(['', '']);
    expect(model.tables).toEqual([]);
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
    expect(model.headings).toEqual(['Schedule: Cross-program timesheet experience', 'Reminders', 'Tasks']);
    expect(csrfContexts(gateway)).toEqual([MULTI]);
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
