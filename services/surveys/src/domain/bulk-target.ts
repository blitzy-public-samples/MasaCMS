// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Bulk survey targeting as the fixture `surveys.cfc` and `usp_survey_bulk_target` apply it, plus the response grants of the targeted sites. */
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { tenantForRegisteredSite, writeGrant, type TenantTx } from '@opt2/platform/tenancy';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { requireSurvey, type DomainDeps } from './surveys.js';
import { listTargets } from '../repo/queries.js';
import type { TargetInsertResult, TargetPair } from '../repo/repository.js';

/** Grant kind that lets a targeted site's tenant respond to the grantor's survey. */
export const SURVEY_RESPONSE_GRANT = 'survey-response' as const;

/** One item of the fixture's `targets` array; a null or absent `groupName` targets the whole site. */
export type BulkTargetInputItem = { siteID: string; groupName?: string | null };

/** A target as the procedure's OPENJSON reads it; `groupName` is null for a whole-site target. */
export type BulkTargetPair = { siteid: string; groupName: string | null };

/** The distinct input pairs the survey lacks, in input order, with the procedure's `(inserted, total)`. */
export type BulkTargetPlan = { toInsert: BulkTargetPair[]; inserted: number; total: number };

/** Response data of the fixture route: targets added and the survey's target count afterwards. */
export type BulkTargetResult = TargetInsertResult;

/** Parameters of `applyBulkTarget`; `tenantId` is the verified token's `tid`, `input` the `targets` param as received. */
export interface ApplyBulkTargetInput {
  tenantId: string;
  surveyId: string;
  input: unknown;
}

// Lengths of the OPENJSON WITH columns, which truncate longer text without an error.
const SITE_ID_LENGTH = 25;
const GROUP_NAME_LENGTH = 255;

/** SQL Server's default collation compares text case-insensitively and ignores trailing spaces, as the repository does. */
function collated(value: string): string {
  return value.replace(/ +$/, '').toLowerCase();
}

/** Comparison key of a target under that collation; a NULL group equals only another NULL group. */
function pairKey(siteid: string, groupName: string | null): string {
  return JSON.stringify([collated(siteid), groupName === null ? null : collated(groupName)]);
}

/** JSON.parse that keeps each number's source text, which OPENJSON returns for a number read as nvarchar. */
function parseJsonText(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && context?.source !== undefined ? context.source : value,
  );
}

/** The `targets` param as an array, JSON text parsed; anything else raises the fixture's `invalidParameters`. */
function targetArray(input: unknown): unknown[] {
  // The fixture reads an absent or null param as ''.
  let value: unknown = input ?? '';
  if (typeof value === 'string') {
    try {
      value = parseJsonText(value);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      throw new LegacyApiError('invalidParameters');
    }
  }
  if (!Array.isArray(value)) {
    throw new LegacyApiError('invalidParameters');
  }
  return value;
}

/** Text OPENJSON gives a simple JSON value; undefined for null, objects and arrays, which it reads as NULL. */
function simpleText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** The item's `siteID` text when the item is an object whose exact-case `siteID` holds a non-empty simple value. */
function itemSiteId(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item) || !Object.hasOwn(item, 'siteID')) {
    return undefined;
  }
  const text = simpleText((item as Record<string, unknown>).siteID);
  return text === undefined || text === '' ? undefined : text;
}

/** The distinct targets of the `targets` param as the procedure reads them, first occurrence kept; throws `invalidParameters` as the fixture does. */
export function parseBulkTargets(input: unknown): BulkTargetPair[] {
  const pairs = new Map<string, BulkTargetPair>();
  for (const item of targetArray(input)) {
    const siteId = itemSiteId(item);
    if (siteId === undefined) {
      throw new LegacyApiError('invalidParameters');
    }
    const group = simpleText((item as Record<string, unknown>).groupName);
    const pair: BulkTargetPair = {
      siteid: siteId.slice(0, SITE_ID_LENGTH),
      groupName: group === undefined ? null : group.slice(0, GROUP_NAME_LENGTH),
    };
    const key = pairKey(pair.siteid, pair.groupName);
    if (!pairs.has(key)) {
      pairs.set(key, pair);
    }
  }
  return [...pairs.values()];
}

/** The plan of `pairs` against the survey's `existing` targets. */
function planTargets(
  existing: ReadonlyArray<{ siteid: string; group_name: string | null }>,
  pairs: readonly BulkTargetPair[],
): BulkTargetPlan {
  const targeted = new Set(existing.map((target) => pairKey(target.siteid, target.group_name)));
  const toInsert = pairs.filter((pair) => !targeted.has(pairKey(pair.siteid, pair.groupName)));
  return { toInsert, inserted: toInsert.length, total: existing.length + toInsert.length };
}

/** Plans `usp_survey_bulk_target` for one survey: `input` is a JSON array of `BulkTargetInputItem` or its text. */
export function bulkTarget(existing: ReadonlyArray<{ siteid: string; group_name: string | null }>, input: unknown): BulkTargetPlan {
  return planTargets(existing, parseBulkTargets(input));
}

/** Grants `survey-response` on the survey to the tenant of each distinct targeted site the registry knows, other than the grantor. */
async function grantResponses(tx: TenantTx, surveyId: string, pairs: readonly BulkTargetPair[]): Promise<void> {
  const sites = new Map<string, string>();
  for (const { siteid } of pairs) {
    const key = collated(siteid);
    // The fixture's response check matches the site with `=`, which ignores trailing spaces; the registry lookup does not.
    if (!sites.has(key)) sites.set(key, siteid.replace(/ +$/, ''));
  }
  const granted = new Set<string>();
  for (const siteId of sites.values()) {
    const grantee = await tenantForRegisteredSite(tx, siteId);
    if (grantee !== null && grantee !== tx.tenantId && !granted.has(grantee)) {
      granted.add(grantee);
      await writeGrant(tx, { grantee, kind: SURVEY_RESPONSE_GRANT, resourceId: surveyId });
    }
  }
}

/** Adds the survey's missing targets in one gated transaction, grants the targeted sites its responses and returns `{inserted, total}`. */
export function applyBulkTarget(deps: DomainDeps, { tenantId, surveyId, input }: ApplyBulkTargetInput): Promise<BulkTargetResult> {
  return withGatedTenant(deps.db, tenantId, async (tx) => {
    // The fixture finds the survey before it reads `targets`, so notFound wins over invalidParameters.
    const survey = await requireSurvey(tx, surveyId);
    const pairs = parseBulkTargets(input);
    const plan = planTargets(await listTargets(tx, survey.survey_id), pairs);
    const rows: TargetPair[] = plan.toInsert.map(({ siteid, groupName }) => ({ siteId: siteid, groupName }));
    // insertTargets re-checks under the survey row lock and fills target_id and created, so its counts are the ones returned.
    const { inserted, total } = await deps.repository.insertTargets(tx, survey.survey_id, rows);
    await grantResponses(tx, survey.survey_id, pairs);
    return { inserted, total };
  });
}
