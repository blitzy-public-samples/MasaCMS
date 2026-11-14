// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
// The surveys responses screen: DOM snapshot of single- and multi-site responses, the empty list, whole answers,
// paging, safe markup, denials, unavailability and unread surveys.
import { load } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { SURVEY_IDS, multiSiteSurvey, scheduleInvalid, surveyResponses } from '../../../fixtures/opt2/surveys';
import { fragmentModel, type DomControl, type DomModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { routeKey } from '../../../helpers/fake-gateway';
import { renderScreenPage } from '../../../helpers/screen-context';
import {
  LOGOUT,
  NOACCESS,
  SITE,
  bodyHtml,
  bodyModel,
  contextFor,
  csrfContexts,
  managerRequest,
  surveysCalls,
  surveysGateway,
  surveysScreen,
} from './context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const MULTI = SURVEY_IDS.multiSiteSurvey;
const SINGLE = SURVEY_IDS.singleSiteSurvey;
const RESPONSES_ROUTE = routeKey('GET', 'surveys', `/v1/surveys/${MULTI}/responses`);
const MARKUP = '{"q1":"<script>alert(1)</script>"}';

const headerLinks = (surveyId: string) => [
  { href: `/opt2/admin/surveys/surveys?siteid=${SITE}`, text: 'Surveys' },
  { href: `/opt2/admin/surveys/schedule?siteid=${SITE}&surveyid=${surveyId}`, text: 'Schedule' },
  { href: `/opt2/admin/surveys/targets?siteid=${SITE}&surveyid=${surveyId}`, text: 'Targets' },
];

/** The read-only answers textarea of a response, its value left to each case. */
const ANSWERS_CONTROL: Omit<DomControl, 'value'> = {
  tag: 'textarea',
  name: 'answers',
  type: 'textarea',
  checked: false,
  selected: [],
  options: [],
};

/** Each response block's label and value pairs in order, a textarea's value as its raw content. */
function responseEntries(html: string): string[][][] {
  const $ = load(html);
  return $('.block-content .block-content')
    .toArray()
    .map((content) =>
      $(content)
        .children('.mura-control-group')
        .toArray()
        .map((group) => [$(group).children('label').text(), $(group).children('div, textarea').text()]),
    );
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('surveys responses screen', () => {
  it.each([
    {
      label: 'a multi-site survey answered from tenant-b',
      surveyId: MULTI,
      title: 'Cross-program timesheet experience',
      site: 'tenant-b',
      respondent: SURVEY_IDS.tenantBRespondent,
      answers: '{"q1":"5","q2":"Approvals arrive within a day."}',
      submitted: '2026-06-30 09:30:00',
    },
    {
      label: 'a single-site survey answered from its own site',
      surveyId: SINGLE,
      title: 'Program 1 onboarding check-in',
      site: 'tenant-a',
      respondent: SURVEY_IDS.tenantARespondent,
      answers: '{"q1":"4","q2":"The welcome pack was clear."}',
      submitted: '2026-06-30 08:45:00',
    },
  ])('lists the responses of $label with the respondent site (DOM snapshot)', async (row) => {
    const { surveyId, title, answers } = row;
    const gateway = surveysGateway();

    const html = await bodyHtml('responses', managerRequest({ surveyid: surveyId }), gateway);

    expect(fragmentModel(html)).toEqual<DomModel>({
      title: '',
      headings: [`Responses: ${title}`],
      labels: ['Respondent Site', 'Respondent', 'Answers', 'Submitted'],
      controls: [{ ...ANSWERS_CONTROL, value: answers }],
      buttons: [],
      links: headerLinks(surveyId),
      tables: [],
      alerts: [],
    });
    expect(responseEntries(html)).toEqual([
      [
        ['Respondent Site', row.site],
        ['Respondent', row.respondent],
        ['Answers', answers],
        ['Submitted', row.submitted],
      ],
    ]);
    expect(surveysCalls(gateway).map(({ method, path, query }) => ({ method, path, query }))).toEqual([
      { method: 'GET', path: `/v1/surveys/${surveyId}`, query: { siteid: SITE } },
      {
        method: 'GET',
        path: `/v1/surveys/${surveyId}/responses`,
        query: { siteid: SITE, pageIndex: '1', itemsPerPage: '50' },
      },
    ]);
    expect(csrfContexts(gateway)).toEqual([]);
  });

  it('shows the empty-list message when the survey has no responses', async () => {
    const gateway = surveysGateway({ [RESPONSES_ROUTE]: { status: 200, body: { data: [], total: 0 } } });

    const html = await bodyHtml('responses', managerRequest({ surveyid: MULTI }), gateway);

    expect(html).toContain('<div class="help-block-empty">This survey has no responses.</div>');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('Previous');
  });

  it('shows long answers whole and unparsed in a labelled read-only control of each response', async () => {
    const answers = `{"q1":"3","q2":"${'Approvals & reminders arrive late on "Fridays". '.repeat(4)}"}`;
    const [response] = surveyResponses.multiSite;
    const [other] = surveyResponses.singleSite;
    const gateway = surveysGateway({
      [RESPONSES_ROUTE]: { status: 200, body: { data: [{ ...response, answers }, other], total: 2 } },
    });

    const $ = load(await bodyHtml('responses', managerRequest({ surveyid: MULTI }), gateway));

    expect(answers.length).toBeGreaterThan(200);
    const controls = $('textarea').toArray().map((el) => $(el));
    expect(controls.map((control) => control.attr('id'))).toEqual([
      `answers-${response?.responseId}`,
      `answers-${other?.responseId}`,
    ]);
    const [long] = controls;
    expect(long?.text()).toBe(answers);
    expect(long?.is('[readonly]')).toBe(true);
    expect($(`label[for="answers-${response?.responseId}"]`).text()).toBe('Answers');
    expect($('table, .var-width')).toHaveLength(0);
  });

  it.each([
    { label: 'survey read', route: routeKey('GET', 'surveys', `/v1/surveys/${MULTI}`) },
    { label: 'responses read', route: RESPONSES_ROUTE },
  ])('propagates an unavailable $label', async ({ route }) => {
    const gateway = surveysGateway({ [route]: { status: 503 } });

    const load = surveysScreen('responses').load(contextFor(managerRequest({ surveyid: MULTI }), gateway));

    await expect(load).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it.each([
    {
      field: 'stored answers',
      route: RESPONSES_ROUTE,
      reply: { status: 200, body: { data: [{ ...surveyResponses.multiSite[0], answers: MARKUP }], total: 1 } },
    },
    {
      field: 'the survey title after the bundle label of the header',
      route: routeKey('GET', 'surveys', `/v1/surveys/${MULTI}`),
      reply: { status: 200, body: { data: { ...multiSiteSurvey, title: MARKUP } } },
    },
  ])('encodes $field as text', async ({ route, reply }) => {
    const gateway = surveysGateway({ [route]: reply });

    const html = await bodyHtml('responses', managerRequest({ surveyid: MULTI }), gateway);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('pages the responses, keeping the survey in the pager links', async () => {
    const gateway = surveysGateway({
      [RESPONSES_ROUTE]: { status: 200, body: { data: surveyResponses.multiSite, total: 500 } },
    });

    const html = await bodyHtml('responses', managerRequest({ surveyid: MULTI, pageIndex: '2' }), gateway);

    expect(surveysCalls(gateway)[1]?.query).toEqual({ siteid: SITE, pageIndex: '2', itemsPerPage: '50' });
    const href = (page: number): string =>
      `&#x2f;opt2&#x2f;admin&#x2f;surveys&#x2f;responses&#x3f;siteid&#x3d;${SITE}&amp;surveyid&#x3d;${MULTI}` +
      `&amp;pageIndex&#x3d;${page}`;
    const previous = `<a class="btn" href="${href(1)}">Previous</a>`;
    const next = `<a class="btn" href="${href(3)}">Next</a>`;
    expect(html).toContain(`<div class="btn-group">${previous}${next}</div><p>Page 2 of 10</p>`);
  });

  it.each([
    { status: 403, location: NOACCESS },
    { status: 401, location: LOGOUT },
  ])('answers the service $status with the access gate redirect', async ({ status, location }) => {
    const gateway = surveysGateway({ [RESPONSES_ROUTE]: { status } });

    const page = await renderScreenPage(
      surveysScreen('responses'),
      contextFor(managerRequest({ surveyid: MULTI }), gateway),
    );

    expect(page).toEqual({ kind: 'redirect', location });
  });

  it.each<{ label: string; rc: Record<string, string>; alert: DomModel['alerts'][number]; reads: number }>([
    {
      label: 'names no survey',
      rc: {},
      alert: { text: 'No survey selected.', className: 'alert alert-info' },
      reads: 0,
    },
    {
      label: 'names a malformed survey id (400)',
      rc: { surveyid: 'bad' },
      alert: { text: 'Invalid parameters', className: 'alert alert-error' },
      reads: 2,
    },
    {
      label: 'names a survey the site does not hold (404)',
      rc: { surveyid: SURVEY_IDS.tenantARespondent },
      alert: { text: 'Not Found', className: 'alert alert-error' },
      reads: 2,
    },
  ])('shows the bare header and the alert when the request $label', async ({ rc, alert, reads }) => {
    const gateway = surveysGateway({ [routeKey('GET', 'surveys', '/v1/surveys/bad')]: scheduleInvalid });

    const model = await bodyModel('responses', managerRequest(rc), gateway);

    expect(model).toEqual<DomModel>({
      title: '',
      headings: ['Responses'],
      labels: [],
      controls: [],
      buttons: [],
      links: [{ href: `/opt2/admin/surveys/surveys?siteid=${SITE}`, text: 'Surveys' }],
      tables: [],
      alerts: [alert],
    });
    expect(surveysCalls(gateway)).toHaveLength(reads);
  });
});
