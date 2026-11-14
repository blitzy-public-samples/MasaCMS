// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components } from '@/generated/clients/surveys';
import { html, type SafeHtml } from '@/lib/html';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext } from '../../registry';
import {
  block,
  controlGroup,
  gridTable,
  opt2ActionUrl,
  opt2Label,
  opt2View,
  postForm,
  submitToService,
  textarea,
  type Opt2Write,
} from '../shared';
import {
  NO_SURVEY,
  SURVEYS_MODULE,
  SURVEYS_ROLES,
  dateTimeText,
  readOf,
  siteIdOf,
  surveyHeader,
  surveyIdOf,
  unreadHeader,
  type Survey,
  type Unread,
} from './common';

type SurveyTarget = components['schemas']['SurveyTarget'];
type BulkTargetRequest = components['schemas']['BulkTargetRequest'];

/** The survey, its targets and the requested id (its CSRF context), or the alert saying why no survey was read. */
export type TargetsData = { surveyId: string; survey: Survey; targets: SurveyTarget[] } | Unread;

/** Survey `surveyId` (`getSurvey`), its targets (`listSurveyTargets`) and the CSRF pair of its id context. */
async function loadTargets(ctx: ScreenContext, surveyId: string): Promise<TargetsData> {
  if (surveyId === '') return NO_SURVEY;
  const request = { params: { surveyId }, query: { siteid: siteIdOf(ctx) } };
  const [surveyRes, targetsRes] = await Promise.all([
    ctx.gateway.surveys.call('get', '/v1/surveys/{surveyId}', request),
    ctx.gateway.surveys.call('get', '/v1/surveys/{surveyId}/targets', request),
    ctx.csrf.prefetch([surveyId]),
  ]);
  const survey = readOf(surveyRes, 'getSurvey');
  if ('unread' in survey) return survey;
  const targets = readOf(targetsRes, 'listSurveyTargets');
  if ('unread' in targets) return targets;
  return { surveyId, survey: survey.body.data, targets: targets.body.data };
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

/** The form holding `text`, then the target count and grid, or the bare header and reason; `alert` after the header. */
function renderTargets(ctx: ScreenContext, data: TargetsData, text: string, alert?: SafeHtml): SafeHtml {
  if ('unread' in data) return html`${unreadHeader(ctx, 'targets')}${alert}${data.unread}`;
  const { surveyId, survey, targets } = data;
  // No role check here: the service answered the targets read only for surveys.manager, the role the post needs.
  const form = postForm(
    opt2ActionUrl(SURVEYS_MODULE, 'bulk-target', { siteid: siteIdOf(ctx), surveyid: survey.surveyId }),
    controlGroup(
      'Targets (one site ID per line; add a comma and a group name to target one group)',
      textarea('targets', text),
    ),
    'Add Targets',
    { hidden: ctx.csrf.render(surveyId) },
  );
  const grid = gridTable(
    [opt2Label(ctx, 'Site'), opt2Label(ctx, 'Group'), 'Added'],
    targets.map((target) => [target.siteId, target.groupName ?? 'All users', dateTimeText(target.created)]),
    'This survey has no targets.',
  );
  return html`${surveyHeader(ctx, survey, 'targets')}${alert}${block(
    html`${form}<h2>Current Targets</h2><p class="help-block">Total targets: ${targets.length}</p>${grid}`,
  )}`;
}

/** Targets screen body of survey `surveyId`, read afresh: `opts.alert` after the header, `opts.values` in the form. */
export async function targetsBody(
  ctx: ScreenContext,
  surveyId: string,
  opts: { alert?: SafeHtml; values?: { targets?: string } } = {},
): Promise<SafeHtml> {
  return renderTargets(ctx, await loadTargets(ctx, surveyId), opts.values?.targets ?? '', opts.alert);
}

/** `/opt2/admin/surveys/targets?surveyid=…`: the survey's targets and the bulk targeting form. */
export const targetsScreen: Opt2ScreenDefinition<TargetsData> = {
  module: SURVEYS_MODULE,
  screen: 'targets',
  roles: SURVEYS_ROLES,
  service: 'surveys',
  load: (ctx) => loadTargets(ctx, surveyIdOf(ctx)),
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
      (alert) => targetsBody(ctx, surveyId, { alert, values: { targets: text } }),
    );
  },
};
