// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/surveys';
import { okBody } from '@/lib/gateway-client';
import { attr, html, type SafeHtml } from '@/lib/html';
import type { Opt2Module, ScreenContext } from '../../registry';
import { opt2ScreenUrl, pageHeader, type HeaderLink, type Opt2Params } from '../shared';

export type Survey = components['schemas']['Survey'];

export const SURVEYS_MODULE: Opt2Module = 'surveys';

/** Roles the surveys service requires on every `/v1/surveys` route; the service decides access. */
export const SURVEYS_ROLES: readonly Role[] = Object.freeze([Roles.surveysManager]);

/** Rows per page of the paged screens, sent as `itemsPerPage` so the pager counts pages as the service fills them. */
export const PAGE_SIZE = 50;

/** Screens of one survey, in header-link order. */
export type SurveyScreen = 'schedule' | 'targets' | 'responses';

const SURVEY_SCREENS: readonly SurveyScreen[] = ['schedule', 'targets', 'responses'];

const SCREEN_LABELS: Readonly<Record<SurveyScreen, string>> = {
  schedule: 'Schedule',
  targets: 'Targets',
  responses: 'Responses',
};

/** The session site, sent as `siteid` on every surveys call. */
export function siteIdOf(ctx: ScreenContext): string {
  return ctx.req.session.siteid;
}

/** `rc.surveyid`, `''` when absent; the service answers an id it does not hold. */
export function surveyIdOf(ctx: ScreenContext): string {
  return ctx.req.rc['surveyid'] ?? '';
}

/** `rc.pageIndex` when it is a page number, else 1. */
export function pageIndexOf(ctx: ScreenContext): number {
  const page = Number(ctx.req.rc['pageIndex']);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/** Browser URL of the surveys screen `screen` for the session site, with `params` after `siteid`. */
export function surveysUrl(ctx: ScreenContext, screen: string, params: Opt2Params = {}): string {
  return opt2ScreenUrl(SURVEYS_MODULE, screen, { siteid: siteIdOf(ctx), ...params });
}

/**
 * The survey `surveyId` of the session site, with its schedule.
 * @throws GatewayDenialError When the service answers 401 or 403.
 */
export async function loadSurvey(ctx: ScreenContext, surveyId: string): Promise<Survey> {
  const res = await ctx.gateway.surveys.call('get', '/v1/surveys/{surveyId}', {
    params: { surveyId },
    query: { siteid: siteIdOf(ctx) },
  });
  return okBody(res, 'surveys', 'getSurvey').data;
}

/** Header of survey screen `current`: its label and the survey title, linking the list and the other screens. */
export function surveyHeader(ctx: ScreenContext, survey: Survey, current: SurveyScreen): SafeHtml {
  const links: HeaderLink[] = [{ label: 'Surveys', href: surveysUrl(ctx, 'surveys') }];
  for (const screen of SURVEY_SCREENS) {
    if (screen !== current) {
      links.push({ label: SCREEN_LABELS[screen], href: surveysUrl(ctx, screen, { surveyid: survey.surveyId }) });
    }
  }
  return pageHeader(`${SCREEN_LABELS[current]}: ${survey.title}`, links);
}

/** A service `LocalTimestamp` to the second, as `yyyy-mm-dd hh:mm:ss`; `''` for null. */
export function dateTimeText(value: string | null): string {
  return value === null ? '' : `${value.slice(0, 10)} ${value.slice(11, 19)}`;
}

/** Previous and next links of page `pageIndex` of `total` rows, with `params` kept; null for a single page. */
export function pager(
  ctx: ScreenContext,
  screen: string,
  params: Opt2Params,
  pageIndex: number,
  total: number,
): SafeHtml | null {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  const link = (label: string, page: number): SafeHtml =>
    html`<a class="btn"${attr('href', surveysUrl(ctx, screen, { ...params, pageIndex: page }))}>${label}</a>`;
  return html`<div class="btn-group">${pageIndex > 1 ? link('Previous', pageIndex - 1) : null}${
    pageIndex < pages ? link('Next', pageIndex + 1) : null
  }</div><p>Page ${pageIndex} of ${pages}</p>`;
}
