// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
// The surveys responses screen: DOM snapshot of single- and multi-site responses, the empty list, whole answers,
// paging, safe markup, denials and unavailability.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { SURVEY_IDS, surveyResponses } from '../../../fixtures/opt2/surveys';
import type { DomModel } from '../../../helpers/dom-model';
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

const headerLinks = (surveyId: string) => [
  { href: `/opt2/admin/surveys/surveys?siteid=${SITE}`, text: 'Surveys' },
  { href: `/opt2/admin/surveys/schedule?siteid=${SITE}&surveyid=${surveyId}`, text: 'Schedule' },
  { href: `/opt2/admin/surveys/targets?siteid=${SITE}&surveyid=${surveyId}`, text: 'Targets' },
];

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
      rows: [
        [
          'tenant-b',
          SURVEY_IDS.tenantBRespondent,
          '{"q1":"5","q2":"Approvals arrive within a day."}',
          '2026-06-30 09:30:00',
        ],
      ],
    },
    {
      label: 'a single-site survey answered from its own site',
      surveyId: SINGLE,
      title: 'Program 1 onboarding check-in',
      rows: [
        [
          'tenant-a',
          SURVEY_IDS.tenantARespondent,
          '{"q1":"4","q2":"The welcome pack was clear."}',
          '2026-06-30 08:45:00',
        ],
      ],
    },
  ])('lists the responses of $label with the respondent site (DOM snapshot)', async ({ surveyId, title, rows }) => {
    const gateway = surveysGateway();

    const model = await bodyModel('responses', managerRequest({ surveyid: surveyId }), gateway);

    expect(model).toEqual<DomModel>({
      title: '',
      headings: [`Responses: ${title}`],
      labels: [],
      controls: [],
      buttons: [],
      links: headerLinks(surveyId),
      tables: [{ headers: ['Respondent Site', 'Respondent', 'Answers', 'Submitted'], rows }],
      alerts: [],
    });
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

  it('shows answers longer than 80 characters whole and unparsed', async () => {
    const answers = `{"q1":"3","q2":"${'Approvals & reminders arrive late on "Fridays". '.repeat(4)}"}`;
    const [response] = surveyResponses.multiSite;
    const gateway = surveysGateway({
      [RESPONSES_ROUTE]: { status: 200, body: { data: [{ ...response, answers }], total: 1 } },
    });

    const model = await bodyModel('responses', managerRequest({ surveyid: MULTI }), gateway);

    expect(answers.length).toBeGreaterThan(80);
    expect(model.tables[0]?.rows[0]?.[2]).toBe(answers);
  });

  it.each([
    { label: 'survey read', route: routeKey('GET', 'surveys', `/v1/surveys/${MULTI}`) },
    { label: 'responses read', route: RESPONSES_ROUTE },
  ])('propagates an unavailable $label', async ({ route }) => {
    const gateway = surveysGateway({ [route]: { status: 503 } });

    const load = surveysScreen('responses').load(contextFor(managerRequest({ surveyid: MULTI }), gateway));

    await expect(load).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it('encodes stored answers as text', async () => {
    const answers = '{"q1":"<script>alert(1)</script>"}';
    const [response] = surveyResponses.multiSite;
    const gateway = surveysGateway({
      [RESPONSES_ROUTE]: { status: 200, body: { data: [{ ...response, answers }], total: 1 } },
    });

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

  it.each<{ label: string; rc: Record<string, string>; status: number }>([
    { label: 'holds no such survey', rc: { surveyid: SURVEY_IDS.tenantARespondent }, status: 404 },
    { label: 'refuses an absent survey id', rc: {}, status: 400 },
  ])('fails the render when the service $label', async ({ rc, status }) => {
    const gateway = surveysGateway({ [routeKey('GET', 'surveys', '/v1/surveys/')]: { status: 400 } });
    const ctx = contextFor(managerRequest(rc), gateway);

    await expect(surveysScreen('responses').load(ctx)).rejects.toThrow(`getSurvey answered HTTP ${status}`);
  });
});
