// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
// The surveys bulk targeting screen and its post action: DOM snapshot, service calls, CSRF forwarding, re-render.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { alertBox } from '@/screens/opt2/shared';
import { targetsBody } from '@/screens/opt2/surveys/targets';
import { SURVEY_IDS, bulkTargetRequest, scheduleInvalid, surveyTargets } from '../../../fixtures/opt2/surveys';
import { fragmentModel, normaliseIds, type DomControl, type DomModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { routeKey } from '../../../helpers/fake-gateway';
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
const BULK_PATH = `/v1/surveys/${MULTI}/targets/bulk` as const;
const BULK_ROUTE = routeKey('POST', 'surveys', BULK_PATH);
const SURVEY_ROUTE = routeKey('GET', 'surveys', `/v1/surveys/${MULTI}` as const);
const TARGETS_ROUTE = routeKey('GET', 'surveys', `/v1/surveys/${MULTI}/targets` as const);
const SURVEYS_LINK = { href: `/opt2/admin/surveys/surveys?siteid=${SITE}`, text: 'Surveys' };
const NOT_FOUND = {
  status: 404,
  body: { apiversion: 'v1', method: 'surveys.find', error: { message: 'Not found', code: 'not_found' } },
};

/** The DOM model of a survey that could not be read: the bare header, then `alerts`. */
const unreadModel = (alerts: DomModel['alerts']): DomModel => ({
  title: '',
  headings: ['Targets'],
  labels: [],
  controls: [],
  buttons: [],
  links: [SURVEYS_LINK],
  tables: [],
  alerts,
});
const CSRF_POSTED = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };
const LABEL = 'Targets (one site ID per line; add a comma and a group name to target one group)';

const textareaControl = (value: string): DomControl => ({
  tag: 'textarea',
  name: 'targets',
  type: 'textarea',
  value,
  checked: false,
  selected: [],
  options: [],
});

const hiddenControl = (name: string, value: string): DomControl => ({
  tag: 'input',
  name,
  type: 'hidden',
  value,
  checked: false,
  selected: [],
  options: [],
});

const bulkRc = (targets: string, rc: Record<string, string> = {}): Record<string, string> => ({
  surveyid: MULTI,
  targets,
  ...CSRF_POSTED,
  ...rc,
});

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('surveys targets screen', () => {
  it('lists the site and group targets under the bulk targeting form (DOM snapshot)', async () => {
    const gateway = surveysGateway();

    const model = await bodyModel('targets', managerRequest({ surveyid: MULTI }), gateway);

    expect(model).toEqual<DomModel>({
      title: '',
      headings: ['Targets: Cross-program timesheet experience', 'Current Targets'],
      labels: [LABEL],
      controls: [
        textareaControl(''),
        hiddenControl('csrf_token', FIXED_CSRF.token),
        hiddenControl('csrf_token_expires', FIXED_CSRF.expires),
      ],
      buttons: [{ text: 'Add Targets', type: 'submit', hasOnclick: false }],
      links: [
        { href: `/opt2/admin/surveys/surveys?siteid=${SITE}`, text: 'Surveys' },
        { href: `/opt2/admin/surveys/schedule?siteid=${SITE}&surveyid=${MULTI}`, text: 'Schedule' },
        { href: `/opt2/admin/surveys/responses?siteid=${SITE}&surveyid=${MULTI}`, text: 'Responses' },
      ],
      tables: [
        {
          headers: ['Site', 'Group', 'Added'],
          rows: [
            ['tenant-a', 'All users', '2026-06-29 10:05:00'],
            ['tenant-b', 'All users', '2026-06-30 09:20:00'],
            ['tenant-b', 'timesheets.employee', '2026-06-30 09:20:00'],
          ],
        },
      ],
      alerts: [],
    });
    expect(surveysCalls(gateway).map(({ method, path, query }) => ({ method, path, query }))).toEqual([
      { method: 'GET', path: `/v1/surveys/${MULTI}`, query: { siteid: SITE } },
      { method: 'GET', path: `/v1/surveys/${MULTI}/targets`, query: { siteid: SITE } },
    ]);
    expect(csrfContexts(gateway)).toEqual([MULTI]);
  });

  it.each([
    { name: 'its targets', targets: surveyTargets, empty: false },
    { name: 'the empty message', targets: [], empty: true },
  ])('counts the read targets above $name', async ({ targets, empty }) => {
    const gateway = surveysGateway({ [TARGETS_ROUTE]: { status: 200, body: { data: targets } } });

    const html = await bodyHtml('targets', managerRequest({ surveyid: MULTI }), gateway);

    expect(html).toContain(
      `<h2>Current Targets</h2><p class="help-block">Total targets: ${targets.length}</p>${
        empty ? '<div class="help-block-empty">This survey has no targets.</div>' : '<table class="mura-table-grid">'
      }`,
    );
    expect(fragmentModel(html).tables).toHaveLength(empty ? 0 : 1);
  });

  it('shows the info alert without calling a service when no survey is selected', async () => {
    const gateway = surveysGateway();

    const model = await bodyModel('targets', managerRequest(), gateway);

    expect(model).toEqual(unreadModel([{ text: 'No survey selected.', className: 'alert alert-info' }]));
    expect(gateway.calls).toEqual([]);
  });

  it.each([
    { read: 'survey', status: 404, overrides: { [SURVEY_ROUTE]: NOT_FOUND }, alert: 'Not found' },
    { read: 'survey', status: 400, overrides: { [SURVEY_ROUTE]: scheduleInvalid }, alert: 'Invalid parameters' },
    { read: 'targets', status: 404, overrides: { [TARGETS_ROUTE]: { status: 404 } }, alert: 'Not Found' },
  ])('shows the error of a $read read answered $status under the bare header', async ({ overrides, alert }) => {
    const gateway = surveysGateway(overrides);

    const model = await bodyModel('targets', managerRequest({ surveyid: MULTI }), gateway);

    expect(model).toEqual(unreadModel([{ text: alert, className: 'alert alert-error' }]));
  });

  it.each([TARGETS_ROUTE, SURVEY_ROUTE])('answers a 403 on %s with the no-access redirect', async (route) => {
    const gateway = surveysGateway({ [route]: { status: 403 } });
    const ctx = contextFor(managerRequest({ surveyid: MULTI }), gateway);

    const page = await renderScreenPage(surveysScreen('targets'), ctx);

    expect(page).toEqual({ kind: 'redirect', location: NOACCESS });
  });

  it('propagates an unavailable surveys service', async () => {
    const gateway = surveysGateway();
    gateway.failWith();
    const def = surveysScreen('targets');

    await expect(def.load(contextFor(managerRequest({ surveyid: MULTI }), gateway))).rejects.toBeInstanceOf(
      GatewayUnavailableError,
    );
  });
});

describe('targetsBody', () => {
  it('renders the read survey with the given alert after the header and the given form text', async () => {
    const gateway = surveysGateway();
    const ctx = contextFor(managerRequest(), gateway);

    const body = await targetsBody(ctx, MULTI, { alert: alertBox('Rejected'), values: { targets: 'tenant-a,Ops' } });

    const model = normaliseIds(fragmentModel(toString(body)));
    expect(model.alerts).toEqual([{ text: 'Rejected', className: 'alert alert-error' }]);
    expect(model.controls[0]).toEqual(textareaControl('tenant-a,Ops'));
    expect(model.tables[0]?.rows).toHaveLength(surveyTargets.length);
    expect(csrfContexts(gateway)).toEqual([MULTI]);
  });
});

describe('surveys bulk-target action', () => {
  it('sends one target per line with the posted CSRF pair, then redirects to the targets screen', async () => {
    const gateway = surveysGateway();
    const text = 'tenant-a\r\n\r\n tenant-b \ntenant-b, timesheets.employee\n';

    const result = await surveysAction('bulk-target').submit(contextFor(managerRequest(bulkRc(text)), gateway));

    expect(result).toEqual({
      kind: 'location',
      location: `/opt2/admin/surveys/targets?siteid=${SITE}&surveyid=${MULTI}`,
    });
    expect(surveysCalls(gateway)).toEqual([
      {
        method: 'POST',
        path: BULK_PATH,
        query: { siteid: SITE },
        json: bulkTargetRequest,
        headers: { 'x-csrf_token': FIXED_CSRF.token, 'x-csrf_token_expires': FIXED_CSRF.expires },
      },
    ]);
  });

  it.each([
    { text: '', targets: [] },
    { text: 'umbrella,', targets: [{ siteId: 'umbrella', groupName: null }] },
    { text: 'tenant-b,Ops, North', targets: [{ siteId: 'tenant-b', groupName: 'Ops, North' }] },
  ])('sends targets $targets for "$text"', async ({ text, targets }) => {
    const gateway = surveysGateway();

    await surveysAction('bulk-target').submit(contextFor(managerRequest(bulkRc(text)), gateway));

    expect(surveysCalls(gateway)[0]?.json).toEqual({ targets });
  });

  it('sends no targets when the form posted none', async () => {
    const gateway = surveysGateway();

    await surveysAction('bulk-target').submit(contextFor(managerRequest({ surveyid: MULTI, ...CSRF_POSTED }), gateway));

    expect(surveysCalls(gateway)[0]?.json).toEqual({ targets: [] });
  });

  it('re-renders the posted lines under the service error alert', async () => {
    const gateway = surveysGateway({ [BULK_ROUTE]: scheduleInvalid });
    const text = 'no-such-site\ntenant-b';

    const result = await surveysAction('bulk-target').submit(contextFor(managerRequest(bulkRc(text)), gateway));

    const model = renderedModel(result);
    expect(model.alerts).toEqual([{ text: 'Invalid parameters', className: 'alert alert-error' }]);
    expect(model.controls).toEqual([
      textareaControl(text),
      hiddenControl('csrf_token', '<token>'),
      hiddenControl('csrf_token_expires', '<token>'),
    ]);
    expect(model.tables[0]?.rows).toHaveLength(3);
  });

  it('re-renders the submit alert, then the reason, when the survey can no longer be read', async () => {
    const gateway = surveysGateway({ [BULK_ROUTE]: NOT_FOUND, [SURVEY_ROUTE]: NOT_FOUND });

    const result = await surveysAction('bulk-target').submit(contextFor(managerRequest(bulkRc('tenant-b')), gateway));

    expect(renderedModel(result)).toEqual(
      unreadModel([
        { text: 'Not found', className: 'alert alert-error' },
        { text: 'Not found', className: 'alert alert-error' },
      ]),
    );
  });

  it('answers a refused user token with the login redirect error', async () => {
    const gateway = surveysGateway({ [BULK_ROUTE]: { status: 401 } });

    const result = surveysAction('bulk-target').submit(contextFor(managerRequest(bulkRc('tenant-b')), gateway));

    await expect(result).rejects.toMatchObject({ name: 'GatewayDenialError', status: 401 });
  });
});
