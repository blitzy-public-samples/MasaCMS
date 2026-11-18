// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
// The surveys list inside the shell over the surveys fixtures: DOM snapshot, service calls, paging, denials, errors.
import * as cheerio from 'cheerio';
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

/** The row-actions toggle, then the row's menu links to its schedule, targets and responses screens. */
const rowLinks = (surveyId: string) => [
  { href: 'javascript:;', text: '' },
  { href: screenHref('schedule', surveyId), text: 'Schedule' },
  { href: screenHref('targets', surveyId), text: 'Targets' },
  { href: screenHref('responses', surveyId), text: 'Responses' },
];

const ROW_ICONS = ['mi-calendar', 'mi-bullseye', 'mi-list-alt'];

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
          headers: ['', 'Title', 'Status', 'Launch', 'Reminders', 'Created'],
          rows: [
            [
              'ScheduleTargetsResponses',
              'Program 1 onboarding check-in',
              'Draft',
              'Not scheduled',
              '0',
              '2026-06-29 09:00:00',
            ],
            [
              'ScheduleTargetsResponses',
              'Cross-program timesheet experience',
              'Scheduled',
              '2026-07-01 09:00:00',
              '2',
              '2026-06-29 10:00:00',
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
    expect(page.html).toContain(
      '<td><span class="label label-inverse">Draft</span></td><td class="hidden-xs">Not scheduled</td><td class="hidden-xs">0</td>',
    );
    expect(page.html).toContain('<td><span class="label label-info">Scheduled</span></td>');
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
    expect(fragmentModel(html).tables[0]?.rows[0]?.[1]).toBe(title);
  });

  it('opens each row on a legacy ⋮ actions menu in a first, unlabelled actions column', async () => {
    const html = await bodyHtml('surveys', managerRequest(), surveysGateway());
    const $ = cheerio.load(html, null, false);
    const headers = $('table.mura-table-grid > thead > tr > th');
    const rows = $('table.mura-table-grid > tbody > tr').toArray();

    expect(headers.first().attr('class')).toBe('actions');
    expect(headers.first().html()).toBe('');
    expect(headers.eq(1).attr('class')).toBe('var-width');
    expect($('table .btn-group, table .btn')).toHaveLength(0);
    expect(rows.map((row) => $(row).children('td').first().attr('class'))).toEqual(['actions', 'actions']);
    const menus = rows.map((row) => {
      const cell = $(row).children('td.actions');
      const toggle = cell.children('a.show-actions');
      return {
        toggle: [toggle.attr('href'), toggle.attr('onclick'), toggle.children('i').attr('class')],
        menuClass: cell.children('div').attr('class'),
        items: cell
          .find('div.actions-menu > ul.actions-list > li > a')
          .toArray()
          .map((link) => ({ href: $(link).attr('href'), icon: $(link).children('i').attr('class'), text: $(link).text() })),
      };
    });
    expect(menus).toEqual(
      [SURVEY_IDS.singleSiteSurvey, SURVEY_IDS.multiSiteSurvey].map((surveyId) => ({
        toggle: ['javascript:;', 'showTableControls(this);', 'mi-ellipsis-v'],
        menuClass: 'actions-menu hide',
        items: rowLinks(surveyId)
          .slice(1)
          .map((link, index) => ({ ...link, icon: ROW_ICONS[index] })),
      })),
    );
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
    { pageIndex: '1', total: 120, range: '1-50 of 120', links: [['2', '2'], ['3', '3'], ['', '2']] },
    { pageIndex: '2', total: 120, range: '51-100 of 120', links: [['', '1'], ['1', '1'], ['3', '3'], ['', '3']] },
    { pageIndex: '3', total: 120, range: '101-120 of 120', links: [['', '2'], ['1', '1'], ['2', '2']] },
    { pageIndex: '1', total: 50, range: undefined, links: [] },
  ])('pages $total surveys from page $pageIndex', async ({ pageIndex, total, range, links }) => {
    const gateway = surveysGateway({ [LIST_ROUTE]: listOf(total) });

    const html = await bodyHtml('surveys', managerRequest({ pageIndex }), gateway);

    const pagerLinks = fragmentModel(html).links.filter(({ href }) => href.includes('pageIndex='));
    expect(pagerLinks).toEqual(
      links.map(([text, to]) => ({ href: `/opt2/admin/surveys/surveys?siteid=${SITE}&pageIndex=${to}`, text })),
    );
    expect(html.includes('class="pagination pull-right"')).toBe(range !== undefined);
    if (range !== undefined) {
      expect(html).toContain(`<p class="clearfix search-showing">Showing ${range} Results</p>`);
      expect(html).toContain(`<li class="active"><a href="#">${pageIndex}</a></li>`);
    }
  });

  it('shows page 1 for a page past the last, reading it after the out-of-range page', async () => {
    const gateway = surveysGateway({
      [LIST_ROUTE]: (request) => ({
        status: 200,
        body: { data: request.query['pageIndex'] === '1' ? surveys : [], total: 120 },
      }),
    });

    const html = await bodyHtml('surveys', managerRequest({ pageIndex: '9999' }), gateway);

    expect(surveysCalls(gateway).map(({ query }) => query?.pageIndex)).toEqual(['9999', '1']);
    expect(fragmentModel(html).tables[0]?.rows).toHaveLength(surveys.length);
    expect(html).not.toContain('There are no surveys for this site.');
    expect(html).toContain('<li class="active"><a href="#">1</a></li>');
  });

  it.each([
    { status: 403, location: NOACCESS },
    { status: 401, location: LOGOUT },
  ])('answers the service $status with the access gate redirect', async ({ status, location }) => {
    const gateway = surveysGateway({ [LIST_ROUTE]: { status } });

    const page = await renderScreenPage(surveysScreen('surveys'), contextFor(managerRequest(), gateway));

    expect(page).toEqual({ kind: 'redirect', location });
  });

  it('sends the S2 admin without surveys.manager to no-access without asking surveys', async () => {
    const gateway = surveysGateway();

    const page = await renderScreenPage(surveysScreen('surveys'), contextFor(adminS2Request({ mode: 'opt2' }), gateway));

    expect(page).toEqual({ kind: 'redirect', location: NOACCESS });
    expect(surveysCalls(gateway)).toEqual([]);
  });

  it('propagates an unavailable surveys service', async () => {
    const gateway = surveysGateway();
    gateway.failWith();
    const def = surveysScreen('surveys');

    await expect(def.load(contextFor(managerRequest(), gateway))).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
