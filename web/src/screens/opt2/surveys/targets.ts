// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components } from '@/generated/clients/surveys';
import { okBody } from '@/lib/gateway-client';
import { html, type SafeHtml } from '@/lib/html';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext } from '../../registry';
import {
  block,
  controlGroup,
  gridTable,
  opt2ActionUrl,
  opt2View,
  postForm,
  submitToService,
  textarea,
  type Opt2Write,
} from '../shared';
import {
  SURVEYS_MODULE,
  SURVEYS_ROLES,
  dateTimeText,
  loadSurvey,
  siteIdOf,
  surveyHeader,
  surveyIdOf,
  type Survey,
} from './common';

type SurveyTarget = components['schemas']['SurveyTarget'];
type BulkTargetRequest = components['schemas']['BulkTargetRequest'];

/** The survey and the sites and groups it targets. */
export interface TargetsData {
  survey: Survey;
  targets: SurveyTarget[];
}

/** The survey (`getSurvey`), its targets (`listSurveyTargets`) and the CSRF pair of its id context. */
async function loadTargets(ctx: ScreenContext): Promise<TargetsData> {
  const surveyId = surveyIdOf(ctx);
  const [survey, targets] = await Promise.all([
    loadSurvey(ctx, surveyId),
    ctx.gateway.surveys
      .call('get', '/v1/surveys/{surveyId}/targets', { params: { surveyId }, query: { siteid: siteIdOf(ctx) } })
      .then((res) => okBody(res, 'surveys', 'listSurveyTargets').data),
    ctx.csrf.prefetch([surveyId]),
  ]);
  return { survey, targets };
}

/**
 * The `bulkTargetSurvey` body of the form text: one target per non-blank line, `<site id>` for every user of the site
 * or `<site id>,<group name>` for one group; the group name is the text after the first comma.
 */
function bulkTargetRequestOf(text: string): BulkTargetRequest {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return {
    targets: lines.map((line) => {
      const comma = line.indexOf(',');
      if (comma < 0) return { siteId: line };
      return { siteId: line.slice(0, comma).trim(), groupName: line.slice(comma + 1).trim() || null };
    }),
  };
}

/** The bulk targeting form holding `text`, then the current targets; `alert` follows the header. */
function renderTargets(ctx: ScreenContext, data: TargetsData, text: string, alert?: SafeHtml): SafeHtml {
  const { survey, targets } = data;
  const form = postForm(
    opt2ActionUrl(SURVEYS_MODULE, 'bulk-target', { siteid: siteIdOf(ctx), surveyid: survey.surveyId }),
    controlGroup(
      'Targets (one site ID per line; add a comma and a group name to target one group)',
      textarea('targets', text),
    ),
    'Add Targets',
    { hidden: ctx.csrf.render(surveyIdOf(ctx)) },
  );
  const grid = gridTable(
    ['Site', 'Group', 'Added'],
    targets.map((target) => [target.siteId, target.groupName ?? 'All users', dateTimeText(target.created)]),
    'This survey has no targets.',
  );
  return html`${surveyHeader(ctx, survey, 'targets')}${alert}${block(html`${form}<h2>Current Targets</h2>${grid}`)}`;
}

/** `/opt2/admin/surveys/targets?surveyid=…`: the survey's targets and the bulk targeting form. */
export const targetsScreen: Opt2ScreenDefinition<TargetsData> = {
  module: SURVEYS_MODULE,
  screen: 'targets',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  load: loadTargets,
  render: (ctx, data) => opt2View(SURVEYS_MODULE, renderTargets(ctx, data, '')),
};

/** `/opt2/admin-actions/surveys/bulk-target`: adds the posted targets the survey lacks (`bulkTargetSurvey`). */
export const bulkTargetAction: Opt2ActionDefinition = {
  module: SURVEYS_MODULE,
  action: 'bulk-target',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  submit(ctx) {
    const surveyId = surveyIdOf(ctx);
    const siteid = siteIdOf(ctx);
    const text = ctx.req.rc['targets'] ?? '';
    const write: Opt2Write = {
      service: 'surveys',
      call: (gateway, headers) =>
        gateway.surveys.call('post', '/v1/surveys/{surveyId}/targets/bulk', {
          params: { surveyId },
          query: { siteid },
          json: bulkTargetRequestOf(text),
          headers,
        }),
    };
    return submitToService(
      ctx,
      write,
      { module: SURVEYS_MODULE, screen: 'targets', params: { siteid, surveyid: surveyId } },
      async (alert) => renderTargets(ctx, await loadTargets(ctx), text, alert),
    );
  },
};
