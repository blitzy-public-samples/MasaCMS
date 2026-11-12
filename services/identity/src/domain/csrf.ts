/** CSRF tokens of identity sessions and the single-use ledger `identity.csrf_claim` that legacy and target requests share [legacy: core/mura/user/sessionUserFacade.cfc:206-252]. */
import { cfDateAdd, generateCsrfToken, validateCsrfToken, type CsrfTokens } from '@opt2/platform/legacy-compat';
import type { Clock, CsrfConsumeRequest, CsrfConsumeResponse } from '@opt2/platform/service-kit';
import { SYSTEM_TENANT_ID, registeredTenants, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import type { BridgeRelay, LegacyUsedToken } from '../legacy/bridge-relay.js';
import type { IdentityRepository } from '../repo/repository.js';
import type { CsrfClaimState, SessionRow } from '../repo/tables.js';

/** Hours a used token stays in the ledger [legacy: core/mura/user/sessionUserFacade.cfc:211-215]. */
export const CSRF_USED_TTL_HOURS = 3;

/** Longest a target consume waits on a `pending-legacy` claim for the legacy outcome. */
export const PENDING_LEGACY_WAIT_MS = 5_000;

/** Interval at which a waiting consume re-reads a `pending-legacy` claim. */
const PENDING_POLL_MS = 100;

/** The formula check runs against an empty ledger: single use is decided by the claim. */
const NO_USED_TOKENS: ReadonlyMap<string, Date> = new Map();

/** `csrf_claim.state`. */
export type ClaimState = CsrfClaimState;

/** A session's tenant, id and CSRF secret (`session.mura.csrfsecretkey`). */
export interface CsrfSessionRef {
  tenantId: string;
  sessionId: string;
  csrfSecret: string;
}

/** Dependencies of the CSRF operations; `sleep` defaults to a timer wait. */
export interface CsrfDeps {
  db: TenantDb;
  repo: IdentityRepository;
  bridge: BridgeRelay;
  clock: Clock;
  sleep?: (ms: number) => Promise<void>;
}

/** A session row and the tenant holding it, which never changes. */
export interface LocatedSession {
  tenantId: string;
  row: SessionRow;
}

/** The fields of the contract's `CsrfClaimRequest` a claim uses: the identity session and the token a validating legacy request carries. */
export interface LegacyClaimRequest {
  sessionId: string;
  token: string;
}

/** The contract's `CsrfClaimResponse`: `pending-legacy` when the token is held for legacy, `used` when it is already consumed. */
export interface LegacyClaimResult {
  state: ClaimState;
}

/** The contract's `CsrfSettleRequest`: tokens the legacy request consumed, and pending tokens it left usable. */
export interface LegacySettleRequest {
  sessionId: string;
  consumed: readonly string[];
  released: readonly string[];
}

/** The contract's `CsrfSettleResponse`: claims that became used, and pending claims released. */
export interface LegacySettleResult {
  used: number;
  released: number;
}

/** Outcome of one claim insert: `won` when inserted, the holding claim's state, or null when that claim vanished in between. */
type ClaimAttempt = 'won' | ClaimState | null;

/** Global `setTimeout`, so an installed fake timer drives the wait. */
function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Ledger key of a token; legacy struct keys match case-insensitively. */
function claimKey(token: string): string {
  return token.toUpperCase();
}

/** Ledger entries used before this instant are purged [legacy: core/mura/user/sessionUserFacade.cfc:211-215]. */
function usedCutoff(now: Date): Date {
  return cfDateAdd('h', -CSRF_USED_TTL_HOURS, now);
}

/** Inserts a claim of `key` in `state` at `at`. */
async function takeClaim(
  repo: IdentityRepository,
  tx: TenantTx,
  sessionId: string,
  key: string,
  state: ClaimState,
  at: Date,
): Promise<ClaimAttempt> {
  const inserted = await repo.insertCsrfClaim(tx, { sessionId, token: key, state, claimedAt: at, usedAt: state === 'used' ? at : null });
  if (inserted !== null) return 'won';
  return (await repo.findCsrfClaim(tx, sessionId, key))?.state ?? null;
}

/** Moves the claim of `key` to `used` at `at`, inserting it when absent; false when it was already used. */
async function recordUsed(repo: IdentityRepository, tx: TenantTx, sessionId: string, key: string, at: Date): Promise<boolean> {
  if (await repo.setCsrfClaimState(tx, sessionId, key, 'pending-legacy', 'used', { usedAt: at })) return true;
  if ((await takeClaim(repo, tx, sessionId, key, 'used', at)) === 'won') return true;
  // A pending claim taken between the two calls is moved now; otherwise the token was already used.
  return repo.setCsrfClaimState(tx, sessionId, key, 'pending-legacy', 'used', { usedAt: at });
}

/** Deletes the claim of `key` while it is `pending-legacy`; false when absent or used. */
async function releasePending(repo: IdentityRepository, tx: TenantTx, sessionId: string, key: string): Promise<boolean> {
  // The same-state move locks the row, so a concurrent settle that marks it used is never undone.
  if (!(await repo.setCsrfClaimState(tx, sessionId, key, 'pending-legacy', 'pending-legacy'))) return false;
  return repo.deleteCsrfClaim(tx, sessionId, key);
}

/** The session `sessionId`, searched in `SYSTEM_TENANT_ID`, then in each registered tenant; undefined when absent. Session code imports it from here, so the two modules never import each other. */
export async function locateSession(
  deps: { db: TenantDb; repo: Pick<IdentityRepository, 'findSession'> },
  sessionId: string,
): Promise<LocatedSession | undefined> {
  const { db, repo } = deps;
  const find = (tenantId: string): Promise<SessionRow | null> => withTenant(db, tenantId, (tx) => repo.findSession(tx, sessionId));
  const anonymous = await find(SYSTEM_TENANT_ID);
  if (anonymous !== null) return { tenantId: SYSTEM_TENANT_ID, row: anonymous };
  const tenants = new Set((await registeredTenants(db)).map((entry) => entry.tenantId));
  for (const tenantId of tenants) {
    const row = await find(tenantId);
    if (row !== null) return { tenantId, row };
  }
  return undefined;
}

/** A token and expiry for `context` under the session's secret [legacy: core/mura/user/sessionUserFacade.cfc:237-252]. */
export function issueTokens(session: Pick<CsrfSessionRef, 'csrfSecret'>, opts: { context?: string; clock: Clock }): CsrfTokens {
  return generateCsrfToken({ context: opts.context ?? '', secret: session.csrfSecret, now: opts.clock.now() });
}

/** Consumes a token valid for its context once across legacy and target; `valid` only when this call consumed it [legacy: core/mura/user/sessionUserFacade.cfc:206-235]. */
export async function consumeToken(deps: CsrfDeps, request: CsrfConsumeRequest): Promise<CsrfConsumeResponse> {
  const { db, repo, clock } = deps;
  const { sessionId } = request;
  const located = await locateSession(deps, sessionId);
  if (located === undefined) return { valid: false };
  const { tenantId } = located;
  const now = clock.now();
  const key = claimKey(request.token);
  // Each attempt holds the session row shared, so a login or logout replacing its secret runs wholly before or after it.
  const first = await withTenant(db, tenantId, async (tx): Promise<{ secret: string; outcome: ClaimAttempt } | undefined> => {
    const session = await repo.lockSession(tx, sessionId, 'share');
    if (session?.state !== 'active') return undefined;
    // Legacy purges the ledger before it looks at the token.
    await repo.purgeCsrfClaims(tx, { sessionId, olderThan: usedCutoff(now) });
    const secret = session.csrf_secret;
    const { valid } = validateCsrfToken({ token: request.token, expires: request.expires, context: request.context, secret, used: NO_USED_TOKENS, now });
    return valid ? { secret, outcome: await takeClaim(repo, tx, sessionId, key, 'used', now) } : undefined;
  });
  if (first === undefined) return { valid: false };
  const { secret } = first;
  let { outcome } = first;
  let usedAt = now;

  const sleep = deps.sleep ?? timerSleep;
  let waited = 0;
  while (outcome === 'pending-legacy' || outcome === null) {
    if (waited >= PENDING_LEGACY_WAIT_MS) return { valid: false };
    const step = Math.min(PENDING_POLL_MS, PENDING_LEGACY_WAIT_MS - waited);
    await sleep(step);
    waited += step;
    const at = clock.now();
    usedAt = at;
    const next = await withTenant(db, tenantId, async (tx): Promise<ClaimAttempt | undefined> => {
      const session = await repo.lockSession(tx, sessionId, 'share');
      // The session logged in or out during the wait, so the token belongs to a secret it no longer holds.
      if (session?.state !== 'active' || session.csrf_secret !== secret) return undefined;
      const held = await repo.findCsrfClaim(tx, sessionId, key);
      // A released claim leaves the token free again, so this consume claims it.
      return held === null ? takeClaim(repo, tx, sessionId, key, 'used', at) : held.state;
    });
    if (next === undefined) return { valid: false };
    outcome = next;
  }
  if (outcome !== 'won') return { valid: false };
  // The claim stays used when the relay fails: the request then fails closed and the token remains consumed.
  await deps.bridge.markUsed(sessionId, [{ token: request.token, usedAt }]);
  return { valid: true };
}

/** Takes a `pending-legacy` claim before a validating legacy request; `used` when the token is already consumed. */
export async function claimForLegacy(deps: CsrfDeps, request: LegacyClaimRequest): Promise<LegacyClaimResult> {
  const { sessionId } = request;
  const located = await locateSession(deps, sessionId);
  // Without an identity session nothing is arbitrated, and legacy alone decides.
  if (located === undefined) return { state: 'pending-legacy' };
  const key = claimKey(request.token);
  const at = deps.clock.now();
  const outcome = await withTenant(deps.db, located.tenantId, async (tx): Promise<ClaimAttempt> => {
    const first = await takeClaim(deps.repo, tx, sessionId, key, 'pending-legacy', at);
    return first ?? takeClaim(deps.repo, tx, sessionId, key, 'pending-legacy', at);
  });
  return { state: outcome === 'used' ? 'used' : 'pending-legacy' };
}

/** Records the tokens a legacy request consumed as used and releases its unconsumed pending claims, which stay usable. */
export async function settleLegacy(deps: CsrfDeps, request: LegacySettleRequest): Promise<LegacySettleResult> {
  const { sessionId } = request;
  const located = await locateSession(deps, sessionId);
  if (located === undefined) return { used: 0, released: 0 };
  const consumed = new Set(request.consumed.map(claimKey));
  const keys = [...new Set([...consumed, ...request.released.map(claimKey)])].sort();
  const at = deps.clock.now();
  return withTenant(deps.db, located.tenantId, async (tx) => {
    const result: LegacySettleResult = { used: 0, released: 0 };
    // One sorted order, so concurrent settles of a session lock their claims without deadlocking.
    for (const key of keys) {
      if (consumed.has(key)) {
        if (await recordUsed(deps.repo, tx, sessionId, key, at)) result.used += 1;
      } else if (await releasePending(deps.repo, tx, sessionId, key)) {
        result.released += 1;
      }
    }
    return result;
  });
}

/** Records legacy's used-token keys as `used` claims in the caller's transaction; returns the number that became used. */
export async function importUsedTokens(
  repo: IdentityRepository,
  tx: TenantTx,
  sessionId: string,
  usedTokens: readonly LegacyUsedToken[],
): Promise<number> {
  const byKey = new Map<string, Date>();
  for (const { token, usedAt } of usedTokens) {
    const key = claimKey(token);
    if (!byKey.has(key)) byKey.set(key, usedAt);
  }
  let imported = 0;
  // Sorted as `settleLegacy` visits keys, so the two never lock one session's claims in opposite orders.
  for (const [key, usedAt] of [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (await recordUsed(repo, tx, sessionId, key, usedAt)) imported += 1;
  }
  return imported;
}

/** The session's `used` claims not yet purged at `now`, as legacy's used-token ledger holds them. */
export async function usedTokensFor(repo: IdentityRepository, tx: TenantTx, sessionId: string, now: Date): Promise<LegacyUsedToken[]> {
  const rows = await repo.listCsrfClaims(tx, sessionId, { state: 'used', since: usedCutoff(now) });
  return rows.map((row) => ({ token: row.token, usedAt: row.used_at ?? row.claimed_at }));
}

/** Deletes every claim of the session, as a new login clears the used tokens [legacy: core/mura/user/userUtility.cfc:761-763]; returns the number deleted. */
export function clearClaims(repo: IdentityRepository, tx: TenantTx, sessionId: string): Promise<number> {
  return repo.purgeCsrfClaims(tx, { sessionId });
}
