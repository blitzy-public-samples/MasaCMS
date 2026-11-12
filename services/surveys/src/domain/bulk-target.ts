// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Bulk survey targeting as the fixture `surveys.cfc` and `usp_survey_bulk_target` apply it, plus the response grants of the targeted sites. */
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { siteForTenant, tenantForRegisteredSite, type TenantTx } from '@opt2/platform/tenancy';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { requireSurvey, type DomainDeps } from './surveys.js';
import { cfNumberValueText, parseCfJsonText } from '../legacy/cf-json.js';
import { listTargets } from '../repo/queries.js';
import { collated, grantSurveyResponses } from '../repo/grants.js';
import type { TargetInsertResult, TargetPair } from '../repo/repository.js';

export { SURVEY_RESPONSE_GRANT } from '../repo/grants.js';

/** One item of the fixture's `targets` array; a null or absent `groupName` targets the whole site. */
export type BulkTargetInputItem = { siteID: string; groupName?: string | null };

/** A target as the fixture passes it to the procedure; `groupName` is null for a whole-site target. */
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

// Lengths of `survey_target.siteID` and `group_name`; the fixture answers invalidParameters for longer text.
const SITE_ID_LENGTH = 25;
const GROUP_NAME_LENGTH = 255;

/** Comparison key of a target under SQL Server's default collation; a NULL group equals only another NULL group. */
function pairKey(siteid: string, groupName: string | null): string {
  return JSON.stringify([collated(siteid), groupName === null ? null : collated(groupName)]);
}

/** The `targets` param as an array, JSON text parsed; anything else raises the fixture's `invalidParameters`. */
function targetArray(input: unknown): unknown[] {
  // The fixture reads an absent or null param as ''.
  let value: unknown = input ?? '';
  if (typeof value === 'string') {
    try {
      value = parseCfJsonText(value);
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

/** Text ACF gives a simple JSON value; undefined for null, objects and arrays. */
function simpleText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberValueText(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/** The member a ColdFusion struct of `item` holds as `name`: keys fold by upper case, the first spelling stays, the last value wins; absent unless that spelling is exactly `name`. */
function exactMember(item: object, name: string): { value: unknown } | undefined {
  const folded = name.toUpperCase();
  let spelling: string | undefined;
  let value: unknown;
  for (const [key, entry] of Object.entries(item)) {
    if (key.toUpperCase() === folded) {
      spelling ??= key;
      value = entry;
    }
  }
  return spelling === name ? { value } : undefined;
}

/** The item's `siteID` text when the item is an object whose exact-case `siteID` holds a non-empty simple value. */
function itemSiteId(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return undefined;
  }
  const text = simpleText(exactMember(item, 'siteID')?.value);
  return text === undefined || text === '' ? undefined : text;
}

/** The item's `groupName` text, null when absent or null; raises `invalidParameters` for an object, an array or more than 255 characters. */
function itemGroupName(item: object): string | null {
  const value = exactMember(item, 'groupName')?.value ?? null;
  if (value === null) return null;
  const text = simpleText(value);
  if (text === undefined || text.length > GROUP_NAME_LENGTH) {
    throw new LegacyApiError('invalidParameters');
  }
  return text;
}

/** Every target of the `targets` param in input order, as the fixture reads it; throws `invalidParameters` as the fixture does. */
export function parseBulkTargets(input: unknown): BulkTargetPair[] {
  return targetArray(input).map((item) => {
    const siteId = itemSiteId(item);
    if (siteId === undefined || siteId.length > SITE_ID_LENGTH) {
      throw new LegacyApiError('invalidParameters');
    }
    // itemSiteId found a siteID, so the item is an object.
    return { siteid: siteId, groupName: itemGroupName(item as object) };
  });
}

/** The distinct pairs the survey's `existing` targets lack, first occurrence kept, with the procedure's counts. */
function planTargets(
  existing: ReadonlyArray<{ siteid: string; group_name: string | null }>,
  pairs: readonly BulkTargetPair[],
): BulkTargetPlan {
  const targeted = new Set(existing.map((target) => pairKey(target.siteid, target.group_name)));
  const toInsert: BulkTargetPair[] = [];
  for (const pair of pairs) {
    const key = pairKey(pair.siteid, pair.groupName);
    if (!targeted.has(key)) {
      targeted.add(key);
      toInsert.push(pair);
    }
  }
  return { toInsert, inserted: toInsert.length, total: existing.length + toInsert.length };
}

/** Plans `usp_survey_bulk_target` for one survey with site ids as given: `input` is a JSON array of `BulkTargetInputItem` or its text. */
export function bulkTarget(existing: ReadonlyArray<{ siteid: string; group_name: string | null }>, input: unknown): BulkTargetPlan {
  return planTargets(existing, parseBulkTargets(input));
}

/** The pairs with each site id replaced by its registered canonical id; an unregistered site raises `invalidParameters`, as the fixture's site check does. */
async function registeredTargets(tx: TenantTx, pairs: readonly BulkTargetPair[]): Promise<BulkTargetPair[]> {
  const sites = new Map<string, string>();
  const targets: BulkTargetPair[] = [];
  for (const { siteid, groupName } of pairs) {
    let canonical = sites.get(siteid);
    if (canonical === undefined) {
      const tenant = await tenantForRegisteredSite(tx, siteid);
      const registered = tenant === null ? null : await siteForTenant(tx, tenant);
      if (registered === null) {
        throw new LegacyApiError('invalidParameters');
      }
      canonical = registered;
      sites.set(siteid, canonical);
    }
    targets.push({ siteid: canonical, groupName });
  }
  return targets;
}

/** Adds the survey's missing targets in one gated transaction, grants the targeted sites its responses and returns `{inserted, total}`. */
export function applyBulkTarget(deps: DomainDeps, { tenantId, surveyId, input }: ApplyBulkTargetInput): Promise<BulkTargetResult> {
  return withGatedTenant(deps.db, tenantId, async (tx) => {
    // The fixture finds the survey before it reads `targets`, so notFound wins over invalidParameters.
    const survey = await requireSurvey(tx, surveyId);
    const targets = await registeredTargets(tx, parseBulkTargets(input));
    const plan = planTargets(await listTargets(tx, survey.survey_id), targets);
    const rows: TargetPair[] = plan.toInsert.map(({ siteid, groupName }) => ({ siteId: siteid, groupName }));
    // insertTargets re-checks under the survey row lock and fills target_id and created, so its counts are the ones returned.
    const { inserted, total } = await deps.repository.insertTargets(tx, survey.survey_id, rows);
    await grantSurveyResponses(tx, survey.survey_id, targets.map(({ siteid }) => siteid));
    return { inserted, total };
  });
}
