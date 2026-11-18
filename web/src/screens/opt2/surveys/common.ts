// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/surveys';
import { okBody, type GatewayResponse } from '@/lib/gateway-client';
import type { SafeHtml } from '@/lib/html';
import type { Opt2Module, ScreenContext } from '../../registry';
import {
  alertBox,
  errorMessage,
  invalidParametersAlert,
  isMalformedId,
  opt2Label,
  opt2ScreenUrl,
  pageHeader,
  stateBadgeOf,
  valueRows,
  wrappable,
  type HeaderLink,
  type Label,
  type Opt2Params,
  type StateDisplay,
} from '../shared';

export type Survey = components['schemas']['Survey'];

export type SurveyStatus = components['schemas']['SurveyStatus'];

/** Why a survey screen shows no survey: the alert under its bare header. */
export type Unread = { readonly unread: SafeHtml };

export const SURVEYS_MODULE: Opt2Module = 'surveys';

/** Roles the surveys service requires on every `/v1/surveys` route; the service decides access. */
export const SURVEYS_ROLES: readonly Role[] = Object.freeze([Roles.surveysManager]);

/** Rows per page of the paged screens, sent as `itemsPerPage` so the pager counts pages as the service fills them. */
export const PAGE_SIZE = 50;

/** Screens of one survey, in header-link order. */
export type SurveyScreen = 'schedule' | 'targets' | 'responses';

/** Every survey screen, in header-link and survey-row link order. */
export const SURVEY_SCREENS: readonly SurveyScreen[] = ['schedule', 'targets', 'responses'];

/** Label of each survey screen; targets and responses have no admin-bundle key. */
const SCREEN_LABELS: Readonly<Record<SurveyScreen, (ctx: ScreenContext) => Label>> = {
  schedule: (ctx) => opt2Label(ctx, 'Schedule'),
  targets: () => 'Targets',
  responses: () => 'Responses',
};

/** Label of survey screen `screen` in the session locale of `ctx`. */
export function screenLabel(ctx: ScreenContext, screen: SurveyScreen): Label {
  return SCREEN_LABELS[screen](ctx);
}

/** Label and badge tone of each survey status. */
const SURVEY_STATUSES: Readonly<Record<SurveyStatus, StateDisplay>> = Object.freeze({
  DRAFT: { label: (ctx) => opt2Label(ctx, 'Draft'), tone: 'inverse' },
  SCHEDULED: { label: () => 'Scheduled', tone: 'info' },
  LAUNCHED: { label: () => 'Launched', tone: 'success' },
  CLOSED: { label: () => 'Closed', tone: 'inverse' },
});

/** Badge of survey status `status` in the session locale of `ctx`. */
export function surveyStatusBadge(ctx: ScreenContext, status: SurveyStatus): SafeHtml {
  return stateBadgeOf(ctx, SURVEY_STATUSES, status);
}

// A survey id the service cannot parse (400) or does not hold for the site (404) is shown, not raised as a 500.
const UNREAD_STATUSES: ReadonlySet<number> = new Set([400, 404]);

/** The unread state of a request naming no survey; `/v1/surveys/{surveyId}` has no empty-id form, so none is sent. */
export const NO_SURVEY: Unread = Object.freeze({ unread: alertBox('No survey selected.', 'info') });

/** The unread state of a request naming a malformed survey id, which is not sent either. */
export const MALFORMED_SURVEY: Unread = Object.freeze({ unread: invalidParametersAlert() });

/** Why survey `surveyId` is not read: none named, or a malformed id; undefined when it may name a survey. */
export function unreadSurveyId(surveyId: string): Unread | undefined {
  if (surveyId === '') return NO_SURVEY;
  return isMalformedId(surveyId) ? MALFORMED_SURVEY : undefined;
}

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
 * The 2xx body of surveys `operation`, or its envelope error as an alert when the service answers 400 or 404.
 * @throws GatewayDenialError For 401 or 403; any other status throws `Error`.
 */
export function readOf<T>(
  response: { readonly ok: true; readonly body: T } | (GatewayResponse & { readonly ok: false }),
  operation: string,
): { readonly body: T } | Unread {
  if (!response.ok && UNREAD_STATUSES.has(response.status)) return { unread: alertBox(errorMessage(response)) };
  return { body: okBody(response, 'surveys', operation) };
}

/** Header link to the survey list. */
function listLink(ctx: ScreenContext): HeaderLink {
  return { label: 'Surveys', href: surveysUrl(ctx, 'surveys') };
}

/** Header of survey screen `current` when no survey was read: its label, linking the list. */
export function unreadHeader(ctx: ScreenContext, current: SurveyScreen): SafeHtml {
  return pageHeader(screenLabel(ctx, current), [listLink(ctx)]);
}

/** Header of survey screen `current`: its fixed label, linking the list and the other screens. */
export function surveyHeader(ctx: ScreenContext, survey: Survey, current: SurveyScreen): SafeHtml {
  const links: HeaderLink[] = [listLink(ctx)];
  for (const screen of SURVEY_SCREENS) {
    if (screen !== current) {
      links.push({ label: screenLabel(ctx, screen), href: surveysUrl(ctx, screen, { surveyid: survey.surveyId }) });
    }
  }
  return pageHeader(screenLabel(ctx, current), links);
}

/** The survey title as the read-only row that opens each survey screen's block. */
export function surveyTitleRow(ctx: ScreenContext, survey: Survey): SafeHtml {
  return valueRows([[opt2Label(ctx, 'Title'), wrappable(survey.title)]]);
}

/** A service `LocalTimestamp` to the second, as `yyyy-mm-dd hh:mm:ss`; `''` for null. */
export function dateTimeText(value: string | null): string {
  return value === null ? '' : `${value.slice(0, 10)} ${value.slice(11, 19)}`;
}
