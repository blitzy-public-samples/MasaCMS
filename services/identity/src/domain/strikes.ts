/** Login throttling over `identity.user_strike`, ported from Masa `userstrikes.cfc`; callers own the gated tenant transaction. */
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { IdentityRepository } from '../repo/repository.js';
import type { UserStrikeRow } from '../repo/tables.js';

/** Throttling limits: `allowedStrikes` is the configured `loginStrikes`; a block lasts `blockedDurationMinutes`. */
export interface StrikeSettings {
  allowedStrikes: number;
  blockedDurationMinutes: number;
}

/** Masa's `loginStrikes=4` default and its fixed 10-minute block [legacy: core/mura/user/userstrikes.cfc:6-7]. */
export const DEFAULT_STRIKE_SETTINGS: StrikeSettings = Object.freeze({ allowedStrikes: 4, blockedDurationMinutes: 10 });

/** The strike record of one login name; `username` is the name as given, never the stored spelling. */
export interface StrikeState {
  username: string;
  /** Null for a stored NULL count, kept rather than read as 0 because legacy never blocks it and `strikes + 1` leaves it NULL. */
  strikes: UserStrikeRow['strikes'];
  lastAttempt: Date;
}

/** The repository helpers the strike operations write through. */
export type StrikeRepository = Pick<IdentityRepository, 'ensureStrike' | 'setStrike' | 'addStrike'>;

/** Clock and limits of a strike operation; `settings` defaults to `DEFAULT_STRIKE_SETTINGS`, `ctx` tags its changelog rows. */
export interface StrikeOptions {
  settings?: StrikeSettings;
  clock: Clock;
  ctx?: WriteContext;
}

const MINUTE_MS = 60_000;

/** CFML `dateAdd('n', minutes, at)`: exact milliseconds, `minutes` truncated toward zero. */
function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + Math.trunc(minutes) * MINUTE_MS);
}

/** Loads the strikes of `username`, inserting its row when absent and resetting it once the block window has passed [legacy: core/mura/user/userstrikes.cfc:20-61]. */
export async function loadStrikes(
  repo: StrikeRepository,
  tx: TenantTx,
  username: string,
  { settings = DEFAULT_STRIKE_SETTINGS, clock, ctx }: StrikeOptions,
): Promise<StrikeState> {
  const now = clock.now();
  const row = await repo.ensureStrike(tx, username, now, ctx);
  // A NULL last attempt fails legacy's isDate check and takes the reset branch.
  if (row.lastattempt !== null && row.lastattempt.getTime() >= addMinutes(now, -settings.blockedDurationMinutes).getTime()) {
    return { username, strikes: row.strikes, lastAttempt: row.lastattempt };
  }
  const reset = { strikes: 0, lastattempt: addMinutes(now, -1) };
  await repo.setStrike(tx, username, reset, ctx);
  return { username, strikes: reset.strikes, lastAttempt: reset.lastattempt };
}

/** Records a failed attempt now, then reloads [legacy: core/mura/user/userstrikes.cfc:90-99]. */
export async function addStrike(repo: StrikeRepository, tx: TenantTx, state: StrikeState, options: StrikeOptions): Promise<StrikeState> {
  await repo.addStrike(tx, state.username, options.clock.now(), options.ctx);
  return loadStrikes(repo, tx, state.username, options);
}

/** Resets the count with a last attempt a minute ago, then reloads [legacy: core/mura/user/userstrikes.cfc:113-122]. */
export async function clearStrikes(repo: StrikeRepository, tx: TenantTx, state: StrikeState, options: StrikeOptions): Promise<StrikeState> {
  await repo.setStrike(tx, state.username, { strikes: 0, lastattempt: addMinutes(options.clock.now(), -1) }, options.ctx);
  return loadStrikes(repo, tx, state.username, options);
}

/** True once the count exceeds `allowedStrikes` [legacy: core/mura/user/userstrikes.cfc:101-103]. */
export function isBlocked(state: StrikeState, settings: StrikeSettings): boolean {
  // CFML compares a NULL count, read as '', with a number as strings, which is never greater.
  return state.strikes !== null && state.strikes > settings.allowedStrikes;
}

/** End of the block when blocked, otherwise a minute ago [legacy: core/mura/user/userstrikes.cfc:105-111]. */
export function blockedUntil(state: StrikeState, settings: StrikeSettings, clock: Clock): Date {
  return isBlocked(state, settings) ? addMinutes(state.lastAttempt, settings.blockedDurationMinutes) : addMinutes(clock.now(), -1);
}
