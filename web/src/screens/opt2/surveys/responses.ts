// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components } from '@/generated/clients/surveys';
import { okBody } from '@/lib/gateway-client';
import { html, type SafeHtml } from '@/lib/html';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import { block, gridTable, opt2View } from '../shared';
import {
  PAGE_SIZE,
  SURVEYS_MODULE,
  SURVEYS_ROLES,
  dateTimeText,
  loadSurvey,
  pageIndexOf,
  pager,
  siteIdOf,
  surveyHeader,
  surveyIdOf,
  type Survey,
} from './common';

type SurveyResponse = components['schemas']['SurveyResponse'];

/** The survey and one page of its responses from every responding site, with the count of all of them. */
export interface ResponsesData {
  survey: Survey;
  responses: SurveyResponse[];
  total: number;
  pageIndex: number;
}

/** The survey (`getSurvey`) and page `rc.pageIndex` of its responses (`listSurveyResponses`). */
async function loadResponses(ctx: ScreenContext): Promise<ResponsesData> {
  const surveyId = surveyIdOf(ctx);
  const pageIndex = pageIndexOf(ctx);
  const [survey, page] = await Promise.all([
    loadSurvey(ctx, surveyId),
    ctx.gateway.surveys
      .call('get', '/v1/surveys/{surveyId}/responses', {
        params: { surveyId },
        query: { siteid: siteIdOf(ctx), pageIndex, itemsPerPage: PAGE_SIZE },
      })
      .then((res) => okBody(res, 'surveys', 'listSurveyResponses')),
  ]);
  return { survey, responses: page.data, total: page.total, pageIndex };
}

/** The response grid, answers as stored, then the pager. */
function renderResponses(ctx: ScreenContext, data: ResponsesData): SafeHtml {
  const { survey } = data;
  const grid = gridTable(
    ['Respondent Site', 'Respondent', 'Answers', 'Submitted'],
    data.responses.map((response) => [
      response.respondentSiteId,
      response.respondentUserId,
      response.answers,
      dateTimeText(response.created),
    ]),
    'This survey has no responses.',
    { varWidthColumn: 2 },
  );
  const paging = pager(ctx, 'responses', { surveyid: survey.surveyId }, data.pageIndex, data.total);
  return html`${surveyHeader(ctx, survey, 'responses')}${block(html`${grid}${paging}`)}`;
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
