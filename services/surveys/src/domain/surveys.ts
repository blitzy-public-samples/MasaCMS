// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey create, list and detail as the fixture `surveys.cfc` answers them, plus the helpers every surveys domain operation shares. */
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import { LegacyApiError, javaTrim } from '@opt2/platform/legacy-compat';
import { FixtureApiError } from '../legacy/fixture-envelope.js';
import type { SurveysRepository } from '../repo/repository.js';
import * as queries from '../repo/queries.js';
import type { SurveyRow, SurveyStatus } from '../repo/tables.js';

export { SURVEY_STATUSES } from '../repo/tables.js';
export type { SurveyStatus } from '../repo/tables.js';

/** Each survey status by name, e.g. `SURVEY_STATUS.SCHEDULED`. */
export const SURVEY_STATUS: Readonly<Record<SurveyStatus, SurveyStatus>> = Object.freeze({
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  LAUNCHED: 'LAUNCHED',
  CLOSED: 'CLOSED',
} satisfies { [S in SurveyStatus]: S });

/** Dependencies of the surveys domain operations: the service's tenant database, its repository and its clock. */
export type DomainDeps = { db: TenantDb; repository: SurveysRepository; clock: Clock };

/** Create-survey parameters under the fixture's names; `title` is the request value as received. */
export interface CreateSurveyInput {
  title?: unknown;
}

const MAX_TITLE_LENGTH = 255;

/** The fixture's unknown-survey error: `notFound` with its default message. */
function surveyNotFound(): FixtureApiError {
  return new FixtureApiError('notFound');
}

/** The title the fixture accepts: a simple value, non-blank once trimmed, at most 255 UTF-16 units; else `invalidParameters`. */
function validTitle(value: unknown): string {
  // An absent or null parameter reads as ''; objects and arrays are not simple values.
  const title = value ?? '';
  if (typeof title !== 'string' && typeof title !== 'number' && typeof title !== 'boolean') {
    throw new LegacyApiError('invalidParameters');
  }
  const text = String(title);
  if (javaTrim(text) === '' || text.length > MAX_TITLE_LENGTH) {
    throw new LegacyApiError('invalidParameters');
  }
  return text;
}

/** The tenant's survey with `surveyId`; throws the fixture's `notFound` when there is none. */
export async function requireSurvey(tx: TenantTx, surveyId: string): Promise<SurveyRow> {
  const survey = await queries.findSurvey(tx, surveyId);
  if (survey === null) {
    throw surveyNotFound();
  }
  return survey;
}

/** Creates a `DRAFT` survey in `siteId` created by `userId` (the token's `site` and `sub`) and returns its detail. */
export async function createSurvey(
  { db, repository }: DomainDeps,
  { tenantId, siteId, userId, input }: { tenantId: string; siteId: string; userId: string; input: CreateSurveyInput },
): Promise<queries.SurveyDetail> {
  const title = validTitle(input.title);
  return withGatedTenant(db, tenantId, async (tx) => {
    // insertSurvey assigns the CF UUID, the DRAFT status and `created` from the repository clock.
    const survey = await repository.insertSurvey(tx, { siteId, title, createdById: userId });
    // A new survey has no schedule, reminders or targets, so its detail needs no re-read.
    return { survey, schedule: null, reminders: [], targets: [] };
  });
}

/** One page of the filter's surveys by creation time and id, with the count of every survey it matches. */
export function listSurveys(
  { db }: Pick<DomainDeps, 'db'>,
  { tenantId, filters }: { tenantId: string; filters: queries.SurveyListFilters },
): Promise<queries.SurveyPage> {
  return withTenant(db, tenantId, (tx) => queries.listSurveys(tx, filters));
}

/** The survey with its schedule, reminders and targets; throws the fixture's `notFound` when the tenant has no such survey. */
export async function getSurvey(
  { db }: Pick<DomainDeps, 'db'>,
  { tenantId, surveyId }: { tenantId: string; surveyId: string },
): Promise<queries.SurveyDetail> {
  const detail = await withTenant(db, tenantId, (tx) => queries.getSurvey(tx, surveyId));
  if (detail === null) {
    throw surveyNotFound();
  }
  return detail;
}
