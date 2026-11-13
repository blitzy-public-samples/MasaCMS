// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey-response grants over `tenant_grant`: the owner's own grant, grantees of targeted sites, their per-survey and per-target locks, writes and re-sync, and the grantor and granted-survey lookups. */
import { tenantForRegisteredSite, withMetadata, writeGrant, type GrantInput, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';

/** Grant kind that lets a targeted site's tenant respond to the grantor's survey. */
export const SURVEY_RESPONSE_GRANT = 'survey-response' as const;

/** SQL Server's default collation compares text case-insensitively and ignores trailing spaces. */
export function collated(value: string): string {
  return value.replace(/ +$/, '').toLowerCase();
}

const GRANT_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const heldGrantLocks = new WeakMap<TenantTx, Set<string>>();

/** Holds the response-grant lock of each string in `surveyIds` until `tx` ends, taking those not yet held in sorted order. */
export async function lockSurveyGrants(tx: TenantTx, surveyIds: Iterable<unknown>): Promise<void> {
  let held = heldGrantLocks.get(tx);
  if (held === undefined) {
    held = new Set();
    heldGrantLocks.set(tx, held);
  }
  const wanted = new Set<string>();
  for (const surveyId of surveyIds) {
    if (typeof surveyId !== 'string') continue;
    // survey_id is char(35), whose equality ignores trailing spaces.
    const key = `${tx.schema}.survey_target.grants:${tx.tenantId}:${surveyId.replace(/ +$/, '')}`;
    if (!held.has(key)) wanted.add(key);
  }
  for (const key of [...wanted].sort()) {
    await tx.query(GRANT_LOCK_SQL, [key]);
    held.add(key);
  }
}

/** Holds the write lock of target `targetId`, stored or not, until `tx` ends; a non-string id takes none. */
export async function lockTargetKey(tx: TenantTx, targetId: unknown): Promise<void> {
  if (typeof targetId !== 'string') return;
  // target_id is char(35), whose equality ignores trailing spaces.
  await tx.query(GRANT_LOCK_SQL, [`${tx.schema}.survey_target.key:${tx.tenantId}:${targetId.replace(/ +$/, '')}`]);
}

/** Each distinct registered tenant of `sites` other than the grantor, yielded right after its site's registry lookup. */
async function* responseGrantees(tx: TenantTx, sites: Iterable<string>): AsyncGenerator<string> {
  const distinct = new Map<string, string>();
  for (const site of sites) {
    const key = collated(site);
    // The fixture's response check matches the site with `=`, which ignores trailing spaces; the registry lookup does not.
    if (!distinct.has(key)) distinct.set(key, site.replace(/ +$/, ''));
  }
  const seen = new Set<string>();
  for (const site of distinct.values()) {
    const grantee = await tenantForRegisteredSite(tx, site);
    if (grantee !== null && grantee !== tx.tenantId && !seen.has(grantee)) {
      seen.add(grantee);
      yield grantee;
    }
  }
}

/** Grants `survey-response` on `surveyId` to the tenant of each of `sites`, under the caller's `lockSurveyGrants`; a grant already held is kept. */
export async function grantSurveyResponses(tx: TenantTx, surveyId: string, sites: Iterable<string>): Promise<void> {
  for await (const grantee of responseGrantees(tx, sites)) {
    await writeGrant(tx, { grantee, kind: SURVEY_RESPONSE_GRANT, resourceId: surveyId });
  }
}

/** Grants the transaction tenant `survey-response` on its own survey `surveyId`, under the caller's `lockSurveyGrants`; a grant already held is kept. */
export async function grantOwnSurveyResponses(tx: TenantTx, surveyId: string): Promise<void> {
  await writeGrant(tx, { grantee: tx.tenantId, kind: SURVEY_RESPONSE_GRANT, resourceId: surveyId });
}

/** Removes the transaction tenant's own `survey-response` grant on `surveyId`, under the caller's `lockSurveyGrants`. */
export async function revokeOwnSurveyResponses(tx: TenantTx, surveyId: string): Promise<void> {
  await tx.query(
    `DELETE FROM ${tx.schema}.tenant_grant WHERE grantor_tenant = $1 AND grantee_tenant = $2 AND kind = $3 AND resource_id = $4`,
    [tx.tenantId, tx.tenantId, SURVEY_RESPONSE_GRANT, surveyId],
  );
}

/** Makes the transaction tenant's `survey-response` grants on `surveyId` to other tenants exactly those `sites` derive, under the caller's `lockSurveyGrants`. */
export async function syncSurveyResponseGrants(tx: TenantTx, surveyId: string, sites: Iterable<string>): Promise<void> {
  const wanted = new Set<string>();
  for await (const grantee of responseGrantees(tx, sites)) {
    wanted.add(grantee);
  }
  const { rows } = await tx.query<{ grantee_tenant: string }>(
    `SELECT grantee_tenant FROM ${tx.schema}.tenant_grant WHERE grantor_tenant = $1 AND kind = $2 AND resource_id = $3`,
    [tx.tenantId, SURVEY_RESPONSE_GRANT, surveyId],
  );
  const held = new Set(rows.map((row) => row.grantee_tenant));
  for (const grantee of wanted) {
    if (!held.has(grantee)) await writeGrant(tx, { grantee, kind: SURVEY_RESPONSE_GRANT, resourceId: surveyId });
  }
  const stale = [...held].filter((grantee) => grantee !== tx.tenantId && !wanted.has(grantee));
  if (stale.length > 0) {
    await tx.query(
      `DELETE FROM ${tx.schema}.tenant_grant WHERE grantor_tenant = $1 AND kind = $2 AND resource_id = $3 AND grantee_tenant = ANY($4::uuid[])`,
      [tx.tenantId, SURVEY_RESPONSE_GRANT, surveyId, stale],
    );
  }
}

/** The tenant that granted `grantee` the `kind` grant on `resourceId`, or null when none has. */
export async function findGrantor(db: TenantDb, { grantee, kind, resourceId }: GrantInput): Promise<string | null> {
  // Qualified by the handle's schema, as platform hasGrant is, not the fixed SCHEMA constant, so a throwaway schema is read.
  const result = await withMetadata(db, (tx) =>
    tx.query<{ grantor_tenant: string }>(
      `SELECT grantor_tenant FROM ${tx.schema}.tenant_grant WHERE grantee_tenant = $1 AND kind = $2 AND resource_id = $3 ORDER BY grantor_tenant LIMIT 1`,
      [grantee, kind, resourceId],
    ),
  );
  return result.rows[0]?.grantor_tenant ?? null;
}

/** True when any tenant holds a `survey-response` grant on `surveyId`, as every stored survey's own tenant does; reads metadata only. */
export async function isGrantedSurvey(db: TenantDb, surveyId: string): Promise<boolean> {
  const result = await withMetadata(db, (tx) =>
    tx.query(`SELECT 1 FROM ${tx.schema}.tenant_grant WHERE kind = $1 AND resource_id = $2 LIMIT 1`, [SURVEY_RESPONSE_GRANT, surveyId]),
  );
  return result.rows.length > 0;
}
