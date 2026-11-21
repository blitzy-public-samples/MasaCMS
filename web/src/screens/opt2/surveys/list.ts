// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { okBody } from '@/lib/gateway-client';
import { html, type SafeHtml } from '@/lib/html';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import { block, gridTable, opt2Label, opt2View, pageHeader, pagination, readPage, rowActionsMenu } from '../shared';
import {
  PAGE_SIZE,
  SURVEYS_GATE,
  SURVEYS_MODULE,
  SURVEYS_ROLES,
  SURVEY_SCREENS,
  dateTimeText,
  pageIndexOf,
  screenLabel,
  siteIdOf,
  surveyStatusBadge,
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

/** Page `rc.pageIndex` of the session site's surveys (`listSurveys`), page 1 when it is past the last. */
async function loadList(ctx: ScreenContext): Promise<SurveyListData> {
  const { answer: res, page: pageIndex } = await readPage(
    pageIndexOf(ctx),
    (page) =>
      ctx.gateway.surveys.call('get', '/v1/surveys', {
        query: { siteid: siteIdOf(ctx), pageIndex: page, itemsPerPage: PAGE_SIZE },
      }),
    (answer) => (answer.ok ? Math.ceil(answer.body.total / PAGE_SIZE) : undefined),
  );
  const { data, total } = okBody(res, 'surveys', 'listSurveys');
  return { surveys: data, total, pageIndex };
}

/** Legacy `mi-*` icon of each survey screen's row action. */
const SCREEN_ICONS: Readonly<Record<SurveyScreen, string>> = {
  schedule: 'mi-calendar',
  targets: 'mi-bullseye',
  responses: 'mi-list-alt',
};

/** Row-actions menu linking one survey to its schedule, targets and responses screens. */
function rowLinks(ctx: ScreenContext, survey: Survey): SafeHtml {
  return rowActionsMenu(
    SURVEY_SCREENS.map((screen) => ({
      label: screenLabel(ctx, screen),
      href: surveysUrl(ctx, screen, { surveyid: survey.surveyId }),
      icon: SCREEN_ICONS[screen],
    })),
    opt2Label(ctx, 'Actions'),
  );
}

/** The survey grid, row actions first as in legacy lists, with launch time and reminder count, then the pager. */
function renderList(ctx: ScreenContext, data: SurveyListData): SafeHtml {
  const rows = data.surveys.map((survey) => [
    rowLinks(ctx, survey),
    survey.title,
    surveyStatusBadge(ctx, survey.status),
    survey.schedule === null ? 'Not scheduled' : dateTimeText(survey.schedule.launchAt),
    survey.schedule?.reminders.length ?? 0,
    dateTimeText(survey.created),
  ]);
  const grid = gridTable(
    ['', opt2Label(ctx, 'Title'), opt2Label(ctx, 'Status'), 'Launch', 'Reminders', opt2Label(ctx, 'Created')],
    rows,
    'There are no surveys for this site.',
    {
      varWidthColumn: 1,
      columnClasses: ['actions', undefined, undefined, 'hidden-xs', 'hidden-xs', 'hidden-xs hidden-sm'],
    },
  );
  const pager = pagination(ctx, {
    page: data.pageIndex,
    totalRecords: data.total,
    recordsPerPage: PAGE_SIZE,
    href: (pageIndex) => surveysUrl(ctx, 'surveys', { pageIndex }),
  });
  return html`${pageHeader('Surveys')}${block(html`${grid}${pager}`)}`;
}

/** `/opt2/admin/surveys/surveys`: the site's surveys with their schedules. */
export const surveysListScreen: Opt2ScreenDefinition<SurveyListData> = {
  module: SURVEYS_MODULE,
  screen: 'surveys',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  gate: SURVEYS_GATE,
  load: loadList,
  render: (ctx, data) => opt2View(SURVEYS_MODULE, renderList(ctx, data), 'surveys'),
};
