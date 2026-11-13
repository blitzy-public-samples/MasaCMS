// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { okBody } from '@/lib/gateway-client';
import { attr, html, type SafeHtml } from '@/lib/html';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import { block, gridTable, opt2View, pageHeader } from '../shared';
import {
  PAGE_SIZE,
  SURVEYS_MODULE,
  SURVEYS_ROLES,
  dateTimeText,
  pageIndexOf,
  pager,
  siteIdOf,
  surveysUrl,
  type Survey,
  type SurveyScreen,
} from './common';

/** One page of the site's surveys and the count of all of them. */
export interface SurveyListData {
  surveys: Survey[];
  total: number;
  pageIndex: number;
}

const ROW_LINKS: ReadonlyArray<readonly [SurveyScreen, string]> = [
  ['schedule', 'Schedule'],
  ['targets', 'Targets'],
  ['responses', 'Responses'],
];

/** Page `rc.pageIndex` of the session site's surveys (`listSurveys`). */
async function loadList(ctx: ScreenContext): Promise<SurveyListData> {
  const pageIndex = pageIndexOf(ctx);
  const res = await ctx.gateway.surveys.call('get', '/v1/surveys', {
    query: { siteid: siteIdOf(ctx), pageIndex, itemsPerPage: PAGE_SIZE },
  });
  const { data, total } = okBody(res, 'surveys', 'listSurveys');
  return { surveys: data, total, pageIndex };
}

/** Links from one survey row to its schedule, targets and responses screens. */
function rowLinks(ctx: ScreenContext, survey: Survey): SafeHtml {
  return html`<div class="btn-group">${ROW_LINKS.map(
    ([screen, label]) =>
      html`<a class="btn"${attr('href', surveysUrl(ctx, screen, { surveyid: survey.surveyId }))}>${label}</a>`,
  )}</div>`;
}

/** The survey grid with its launch time and reminder count, then the pager. */
function renderList(ctx: ScreenContext, data: SurveyListData): SafeHtml {
  const rows = data.surveys.map((survey) => [
    survey.title,
    survey.status,
    dateTimeText(survey.schedule?.launchAt ?? null),
    survey.schedule?.reminders.length,
    dateTimeText(survey.created),
    rowLinks(ctx, survey),
  ]);
  const grid = gridTable(
    ['Title', 'Status', 'Launch', 'Reminders', 'Created', ''],
    rows,
    'There are no surveys for this site.',
  );
  return html`${pageHeader('Surveys')}${block(html`${grid}${pager(ctx, 'surveys', {}, data.pageIndex, data.total)}`)}`;
}

/** `/opt2/admin/surveys/surveys`: the site's surveys with their schedules. */
export const surveysListScreen: Opt2ScreenDefinition<SurveyListData> = {
  module: SURVEYS_MODULE,
  screen: 'surveys',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  load: loadList,
  render: (ctx, data) => opt2View(SURVEYS_MODULE, renderList(ctx, data)),
};
