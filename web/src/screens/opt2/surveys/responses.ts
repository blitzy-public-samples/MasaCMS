// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components } from '@/generated/clients/surveys';
import { html, type SafeHtml } from '@/lib/html';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import { block, controlGroup, opt2Label, opt2View, textarea, valueRows } from '../shared';
import {
  NO_SURVEY,
  PAGE_SIZE,
  SURVEYS_MODULE,
  SURVEYS_ROLES,
  dateTimeText,
  pageIndexOf,
  pager,
  readOf,
  siteIdOf,
  surveyHeader,
  surveyIdOf,
  unreadHeader,
  type Survey,
  type Unread,
} from './common';

type SurveyResponse = components['schemas']['SurveyResponse'];

/** Visible lines of each read-only answers control; longer answers scroll inside it. */
const ANSWER_ROWS = 4;

/** The survey and one page of its responses from every responding site with their count, or why none was read. */
export type ResponsesData =
  | { survey: Survey; responses: SurveyResponse[]; total: number; pageIndex: number }
  | Unread;

/** The survey (`getSurvey`) and page `rc.pageIndex` of its responses (`listSurveyResponses`). */
async function loadResponses(ctx: ScreenContext): Promise<ResponsesData> {
  const surveyId = surveyIdOf(ctx);
  if (surveyId === '') return NO_SURVEY;
  const pageIndex = pageIndexOf(ctx);
  const siteid = siteIdOf(ctx);
  const [surveyRes, pageRes] = await Promise.all([
    ctx.gateway.surveys.call('get', '/v1/surveys/{surveyId}', { params: { surveyId }, query: { siteid } }),
    ctx.gateway.surveys.call('get', '/v1/surveys/{surveyId}/responses', {
      params: { surveyId },
      query: { siteid, pageIndex, itemsPerPage: PAGE_SIZE },
    }),
  ]);
  const survey = readOf(surveyRes, 'getSurvey');
  if ('unread' in survey) return survey;
  const page = readOf(pageRes, 'listSurveyResponses');
  if ('unread' in page) return page;
  return { survey: survey.body.data, responses: page.body.data, total: page.body.total, pageIndex };
}

/**
 * `response` as read-only rows in a block of its own, its answers whole in a labelled read-only control; a grid cell
 * would cut long answers off.
 */
function responseBlock(ctx: ScreenContext, response: SurveyResponse): SafeHtml {
  const respondent = valueRows([
    ['Respondent Site', response.respondentSiteId],
    ['Respondent', response.respondentUserId],
  ]);
  const answers = controlGroup(
    opt2Label(ctx, 'Answers'),
    textarea('answers', response.answers, ANSWER_ROWS, { readonly: true, id: `answers-${response.responseId}` }),
  );
  const submitted = valueRows([['Submitted', dateTimeText(response.created)]]);
  return block(html`${respondent}${answers}${submitted}`);
}

/** Each response, answers as stored, then the pager; without a survey, the bare header and the reason. */
function renderResponses(ctx: ScreenContext, data: ResponsesData): SafeHtml {
  if ('unread' in data) return html`${unreadHeader(ctx, 'responses')}${data.unread}`;
  const { survey } = data;
  const entries =
    data.responses.length === 0
      ? html`<div class="help-block-empty">This survey has no responses.</div>`
      : html`${data.responses.map((response) => responseBlock(ctx, response))}`;
  const paging = pager(ctx, 'responses', { surveyid: survey.surveyId }, data.pageIndex, data.total);
  return html`${surveyHeader(ctx, survey, 'responses')}${block(html`${entries}${paging}`)}`;
}

/** `/opt2/admin/surveys/responses?surveyid=…`: single- and multi-site responses of the survey. */
export const responsesScreen: Opt2ScreenDefinition<ResponsesData> = {
  module: SURVEYS_MODULE,
  screen: 'responses',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  load: loadResponses,
  render: (ctx, data) => opt2View(SURVEYS_MODULE, renderResponses(ctx, data)),
};
