// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey responses as the fixture `surveys.cfc` stores and lists them; another site's respondent reaches a survey only through its `survey-response` grant. */
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { hasGrant, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { requireSurvey, type DomainDeps } from './surveys.js';
import { SURVEY_RESPONSE_GRANT } from './bulk-target.js';
import * as queries from '../repo/queries.js';
import { collated, findGrantor } from '../repo/grants.js';
import type { SurveysRepository } from '../repo/repository.js';
import type { SurveyResponseRow, SurveyRow } from '../repo/tables.js';
import { FixtureApiError, fixturePage, type FixtureListResult, type FixtureParams } from '../legacy/fixture-envelope.js';

/** Submit-response parameters under the fixture's names; `answers` is the merged param untyped, checked after the survey and site as the fixture orders them. */
export interface SubmitResponseInput {
  answers?: unknown;
}

/** A response submission; `tenantId`, `site` and `userId` are the verified token's `tid`, `site` and `sub`. */
export interface SubmitResponseRequest {
  tenantId: string;
  site: string;
  userId: string;
  surveyId: string;
  input: SubmitResponseInput;
}

/** The survey whose responses are listed, in the verified token's tenant. */
export interface SurveyResponsesQuery {
  tenantId: string;
  surveyId: string;
}

/** One fixture page of a survey's responses as envelope.cfc `queryPage` returns it, ready for `fixtureList`. */
export type SurveyResponseListPage = FixtureListResult & { list: SurveyResponseRow[]; totalItems: number };

/** The respondent of one submission. */
type Respondent = { site: string; userId: string; answers: unknown };

/** Whether `site` may respond to `survey`: it is the survey's site or one of its targeted sites, compared as SQL Server's collation does. */
async function siteMayRespond(tx: TenantTx, survey: SurveyRow, site: string): Promise<boolean> {
  const key = collated(site);
  if (collated(survey.siteid) === key) {
    return true;
  }
  return (await queries.listTargets(tx, survey.survey_id)).some((target) => collated(target.siteid) === key);
}

/** Checks the respondent's site, then the answers, in the fixture's order, and stores the response under the survey's site. */
async function writeResponse(
  repository: SurveysRepository,
  tx: TenantTx,
  survey: SurveyRow,
  { site, userId, answers }: Respondent,
): Promise<SurveyResponseRow> {
  if (!(await siteMayRespond(tx, survey, site))) {
    throw new FixtureApiError('forbidden');
  }
  // legacyParamsOf gives JSON simple values as text and null as '', so only text is a simple value here.
  if (typeof answers !== 'string' || answers === '') {
    throw new LegacyApiError('invalidParameters');
  }
  // insertResponse assigns the CF UUID and `created` from the repository clock and stores `answers` unchanged.
  return repository.insertResponse(tx, { survey, respondentSiteId: site, respondentUserId: userId, answers });
}

/** Stores a response to the token tenant's survey, or to a survey whose grantor granted that tenant `survey-response`; returns the stored row. */
export async function submitResponse(
  { db, repository }: Pick<DomainDeps, 'db' | 'repository'>,
  { tenantId, site, userId, surveyId, input }: SubmitResponseRequest,
): Promise<SurveyResponseRow> {
  const respondent: Respondent = { site, userId, answers: input.answers };
  const own = await withGatedTenant(db, tenantId, async (tx) => {
    const survey = await queries.findSurvey(tx, surveyId);
    return survey === null ? null : writeResponse(repository, tx, survey, respondent);
  });
  if (own !== null) {
    return own;
  }
  const grant = { grantee: tenantId, kind: SURVEY_RESPONSE_GRANT, resourceId: surveyId };
  const grantor = await findGrantor(db, grant);
  if (grantor === null || !(await hasGrant(db, { grantor, ...grant }))) {
    // Without a grant the survey's tenant is unknown, so an untargeted survey of another site answers notFound where the fixture answers forbidden.
    throw new FixtureApiError('notFound');
  }
  return withGatedTenant(db, grantor, async (tx) => writeResponse(repository, tx, await requireSurvey(tx, surveyId), respondent));
}

/** Every response of the tenant's survey by creation time and id, with their total; responses of granted sites are stored with the survey, so the list is complete. */
export function listResponses(
  { db }: Pick<DomainDeps, 'db'>,
  { tenantId, surveyId }: SurveyResponsesQuery,
): Promise<queries.SurveyResponsePage> {
  return withTenant(db, tenantId, async (tx) => {
    const survey = await requireSurvey(tx, surveyId);
    return queries.listResponses(tx, survey.survey_id);
  });
}

/** One fixture page of the tenant's survey's responses, paged by `params`; throws notFound, then the paging's invalidParameters. */
export function listResponsePage(
  { db }: Pick<DomainDeps, 'db'>,
  { tenantId, surveyId, params }: SurveyResponsesQuery & { params: FixtureParams },
): Promise<SurveyResponseListPage> {
  return withTenant(db, tenantId, async (tx) => {
    const survey = await requireSurvey(tx, surveyId);
    // The fixture finds the survey before queryPage validates paging, so the page is read here rather than by the route.
    const page = fixturePage(params);
    const { rows, total } = await queries.listResponses(tx, survey.survey_id, page);
    return { list: rows, pageIndex: page.pageIndex, itemsPerPage: page.itemsPerPage, totalItems: total };
  });
}
