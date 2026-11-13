// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
// The surveys list inside the shell over the surveys fixtures: DOM snapshot, service calls, paging, denials, errors.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { SURVEY_IDS, multiSiteSurvey, surveys } from '../../../fixtures/opt2/surveys';
import { adminS2Request } from '../../../helpers/admin-request';
import { fragmentModel, type DomModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { routeKey, type FakeRoute } from '../../../helpers/fake-gateway';
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

const LIST_ROUTE = routeKey('GET', 'surveys', '/v1/surveys');

const screenHref = (screen: string, surveyId: string): string =>
  `/opt2/admin/surveys/${screen}?siteid=${SITE}&surveyid=${surveyId}`;

const rowLinks = (surveyId: string) => [
  { href: screenHref('schedule', surveyId), text: 'Schedule' },
  { href: screenHref('targets', surveyId), text: 'Targets' },
  { href: screenHref('responses', surveyId), text: 'Responses' },
];

/** A list answer of `total` surveys holding the fixture rows. */
const listOf = (total: number): FakeRoute => ({ status: 200, body: { data: surveys, total } });

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('surveys list', () => {
  it('lists each survey with its status, launch, reminder count and screen links (DOM snapshot)', async () => {
    const gateway = surveysGateway();

    const model = await bodyModel('surveys', managerRequest(), gateway);

    expect(model).toEqual<DomModel>({
      title: '',
      headings: ['Surveys'],
      labels: [],
      controls: [],
      buttons: [],
      links: [...rowLinks(SURVEY_IDS.singleSiteSurvey), ...rowLinks(SURVEY_IDS.multiSiteSurvey)],
      tables: [
        {
          headers: ['Title', 'Status', 'Launch', 'Reminders', 'Created', ''],
          rows: [
            ['Program 1 onboarding check-in', 'DRAFT', '', '', '2026-06-29 09:00:00', 'ScheduleTargetsResponses'],
            [
              'Cross-program timesheet experience',
              'SCHEDULED',
              '2026-07-01 09:00:00',
              '2',
              '2026-06-29 10:00:00',
              'ScheduleTargetsResponses',
            ],
          ],
        },
      ],
      alerts: [],
    });
    expect(surveysCalls(gateway)).toEqual([
      {
        method: 'GET',
        path: '/v1/surveys',
        query: { siteid: SITE, pageIndex: '1', itemsPerPage: '50' },
        json: undefined,
        headers: undefined,
      },
    ]);
    expect(csrfContexts(gateway)).toEqual([]);
  });

  it('renders inside the shell with the OPT-2 Surveys entry active', async () => {
    const page = await renderScreenPage(surveysScreen('surveys'), contextFor(managerRequest(), surveysGateway()));

    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    expect(page.html).toContain('<div class="mura-header"><h1>Surveys</h1></div>');
    expect(page.html).toContain('<table class="mura-table-grid">');
    expect(page.html).toMatch(/<a class="active" href="\/opt2\/admin\/surveys\/surveys\?siteid=tenant-a">/);
  });

  it('shows the empty-list message when the site has no surveys', async () => {
    const gateway = surveysGateway({ [LIST_ROUTE]: { status: 200, body: { data: [], total: 0 } } });

    const model = await bodyModel('surveys', managerRequest(), gateway);

    expect(model.tables).toEqual([]);
    expect(model.links).toEqual([]);
  });

  it('encodes survey titles as text', async () => {
    const title = '<img src=x onerror=alert(1)> & "Q3"';
    const gateway = surveysGateway({
      [LIST_ROUTE]: { status: 200, body: { data: [{ ...multiSiteSurvey, title }], total: 1 } },
    });

    const html = await bodyHtml('surveys', managerRequest(), gateway);

    expect(html).not.toContain('<img');
    expect(fragmentModel(html).tables[0]?.rows[0]?.[0]).toBe(title);
  });

  it.each([
    { pageIndex: '3', sent: '3' },
    { pageIndex: '0', sent: '1' },
    { pageIndex: '1.5', sent: '1' },
    { pageIndex: 'x', sent: '1' },
  ])('asks for page $sent when pageIndex is $pageIndex', async ({ pageIndex, sent }) => {
    const gateway = surveysGateway({ [LIST_ROUTE]: listOf(500) });

    await bodyModel('surveys', managerRequest({ pageIndex }), gateway);

    expect(surveysCalls(gateway)[0]?.query?.pageIndex).toBe(sent);
  });

  it.each([
    { pageIndex: '1', total: 120, page: 'Page 1 of 3', links: [['Next', '2']] },
    { pageIndex: '2', total: 120, page: 'Page 2 of 3', links: [['Previous', '1'], ['Next', '3']] },
    { pageIndex: '3', total: 120, page: 'Page 3 of 3', links: [['Previous', '2']] },
    { pageIndex: '1', total: 50, page: undefined, links: [] },
  ])('pages $total surveys from page $pageIndex', async ({ pageIndex, total, page, links }) => {
    const gateway = surveysGateway({ [LIST_ROUTE]: listOf(total) });

    const html = await bodyHtml('surveys', managerRequest({ pageIndex }), gateway);

    const pagerLinks = fragmentModel(html).links.filter(({ href }) => href.includes('pageIndex='));
    expect(pagerLinks).toEqual(
      links.map(([text, to]) => ({ href: `/opt2/admin/surveys/surveys?siteid=${SITE}&pageIndex=${to}`, text })),
    );
    expect(html.includes('<p>Page ')).toBe(page !== undefined);
    if (page !== undefined) expect(html).toContain(`<p>${page}</p>`);
  });

  it.each([
    { status: 403, location: NOACCESS },
    { status: 401, location: LOGOUT },
  ])('answers the service $status with the access gate redirect', async ({ status, location }) => {
    const gateway = surveysGateway({ [LIST_ROUTE]: { status } });

    const page = await renderScreenPage(surveysScreen('surveys'), contextFor(adminS2Request(), gateway));

    expect(page).toEqual({ kind: 'redirect', location });
  });

  it('leaves access to the service: the S2 admin without surveys.manager is sent its call, and its 403', async () => {
    const gateway = surveysGateway({ [LIST_ROUTE]: { status: 403 } });

    await renderScreenPage(surveysScreen('surveys'), contextFor(adminS2Request(), gateway));

    expect(surveysCalls(gateway).map(({ method, path }) => `${method} ${path}`)).toEqual(['GET /v1/surveys']);
    expect(surveysScreen('surveys').gate).toBeUndefined();
  });

  it('propagates an unavailable surveys service', async () => {
    const gateway = surveysGateway();
    gateway.failWith();
    const def = surveysScreen('surveys');

    await expect(def.load(contextFor(managerRequest(), gateway))).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
