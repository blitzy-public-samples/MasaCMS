// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components } from '@/generated/clients/surveys';
import { html, type SafeHtml } from '@/lib/html';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import { block, gridTable, opt2Label, opt2View, pagination, readPage } from '../shared';
import {
  PAGE_SIZE,
  SURVEYS_GATE,
  SURVEYS_MODULE,
  SURVEYS_ROLES,
  dateTimeText,
  pageIndexOf,
  readOf,
  siteIdOf,
  surveyHeader,
  surveyIdOf,
  surveyTitleRow,
  surveysUrl,
  unreadHeader,
  unreadSurveyId,
  type Survey,
  type Unread,
} from './common';

type SurveyResponse = components['schemas']['SurveyResponse'];

/** No column takes the variable width: `var-width` ellipsizes its cell, which would cut long answers off. */
const NO_VAR_WIDTH_COLUMN = -1;

/**
 * Column classes: legacy responsive hiding of the respondent site, and of its id below 1200 px where it pushes the
 * answers off the block; answers align left as a legacy `title` column, so each starts in view.
 */
const COLUMN_CLASSES: ReadonlyArray<string | undefined> = [
  undefined,
  'hidden-xs',
  'hidden-xs hidden-sm hidden-md',
  'title',
];

/** The survey and one page of its responses from every responding site with their count, or why none was read. */
export type ResponsesData =
  | { survey: Survey; responses: SurveyResponse[]; total: number; pageIndex: number }
  | Unread;

/**
 * The survey (`getSurvey`) and page `rc.pageIndex` of its responses (`listSurveyResponses`), page 1 when it is past the
 * last.
 */
async function loadResponses(ctx: ScreenContext): Promise<ResponsesData> {
  const surveyId = surveyIdOf(ctx);
  const unread = unreadSurveyId(surveyId);
  if (unread !== undefined) return unread;
  const siteid = siteIdOf(ctx);
  const [surveyRes, { answer: pageRes, page: pageIndex }] = await Promise.all([
    ctx.gateway.surveys.call('get', '/v1/surveys/{surveyId}', { params: { surveyId }, query: { siteid } }),
    readPage(
      pageIndexOf(ctx),
      (page) =>
        ctx.gateway.surveys.call('get', '/v1/surveys/{surveyId}/responses', {
          params: { surveyId },
          query: { siteid, pageIndex: page, itemsPerPage: PAGE_SIZE },
        }),
      (answer) => (answer.ok ? Math.ceil(answer.body.total / PAGE_SIZE) : undefined),
    ),
  ]);
  const survey = readOf(surveyRes, 'getSurvey');
  if ('unread' in survey) return survey;
  const page = readOf(pageRes, 'listSurveyResponses');
  if ('unread' in page) return page;
  return { survey: survey.body.data, responses: page.body.data, total: page.body.total, pageIndex };
}

/**
 * One row per response with its answers whole as stored, cells on one line as in legacy lists; the responsive
 * container scrolls a grid wider than the block. No responses: the message.
 */
function responseGrid(ctx: ScreenContext, responses: readonly SurveyResponse[]): SafeHtml {
  const headers = ['Submitted', 'Respondent Site', 'Respondent', opt2Label(ctx, 'Answers')];
  const rows = responses.map((response) => [
    dateTimeText(response.created),
    response.respondentSiteId,
    response.respondentUserId,
    response.answers,
  ]);
  const table = gridTable(headers, rows, 'This survey has no responses.', {
    varWidthColumn: NO_VAR_WIDTH_COLUMN,
    columnClasses: COLUMN_CLASSES,
  });
  return responses.length === 0 ? table : html`<div class="table-responsive">${table}</div>`;
}

/** The responses grid, then the pager; without a survey, the bare header and the reason. */
function renderResponses(ctx: ScreenContext, data: ResponsesData): SafeHtml {
  if ('unread' in data) return html`${unreadHeader(ctx, 'responses')}${data.unread}`;
  const { survey } = data;
  const paging = pagination(ctx, {
    page: data.pageIndex,
    totalRecords: data.total,
    recordsPerPage: PAGE_SIZE,
    href: (pageIndex) => surveysUrl(ctx, 'responses', { surveyid: survey.surveyId, pageIndex }),
  });
  return html`${surveyHeader(ctx, survey, 'responses')}${block(
    html`${surveyTitleRow(ctx, survey)}${responseGrid(ctx, data.responses)}${paging}`,
  )}`;
}

/** `/opt2/admin/surveys/responses?surveyid=…`: single- and multi-site responses of the survey. */
export const responsesScreen: Opt2ScreenDefinition<ResponsesData> = {
  module: SURVEYS_MODULE,
  screen: 'responses',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  gate: SURVEYS_GATE,
  load: loadResponses,
  render: (ctx, data) => opt2View(SURVEYS_MODULE, renderResponses(ctx, data), 'responses'),
};
