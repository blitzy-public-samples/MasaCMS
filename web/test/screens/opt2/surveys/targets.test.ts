// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
// The surveys bulk targeting screen and its post action: DOM snapshot, service calls, CSRF forwarding, re-render.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURVEY_IDS, bulkTargetRequest, scheduleInvalid } from '../../../fixtures/opt2/surveys';
import type { DomControl, DomModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { routeKey } from '../../../helpers/fake-gateway';
import { FIXED_CSRF } from '../../../helpers/screen-context';
import {
  SITE,
  bodyModel,
  contextFor,
  csrfContexts,
  managerRequest,
  renderedModel,
  surveysAction,
  surveysCalls,
  surveysGateway,
} from './context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const MULTI = SURVEY_IDS.multiSiteSurvey;
const BULK_PATH = `/v1/surveys/${MULTI}/targets/bulk` as const;
const BULK_ROUTE = routeKey('POST', 'surveys', BULK_PATH);
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

  it('shows the empty message for a survey without targets', async () => {
    const gateway = surveysGateway({
      [routeKey('GET', 'surveys', `/v1/surveys/${MULTI}/targets`)]: { status: 200, body: { data: [] } },
    });

    const model = await bodyModel('targets', managerRequest({ surveyid: MULTI }), gateway);

    expect(model.tables).toEqual([]);
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

  it('answers a refused user token with the login redirect error', async () => {
    const gateway = surveysGateway({ [BULK_ROUTE]: { status: 401 } });

    const result = surveysAction('bulk-target').submit(contextFor(managerRequest(bulkRc('tenant-b')), gateway));

    await expect(result).rejects.toMatchObject({ name: 'GatewayDenialError', status: 401 });
  });
});
