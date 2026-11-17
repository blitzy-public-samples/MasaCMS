// Deadline signals and the server-side row-lock bound they set, shared by the write-window and transition claims.
import type { MetadataTx } from '@opt2/platform/tenancy';

/** Real time, in epoch milliseconds, at which each signal {@link timeoutSignal} made aborts. */
const abortTimes = new WeakMap<AbortSignal, number>();

/** Signal aborting once `ms` have passed; already aborted when none are left. */
export function timeoutSignal(ms: number): AbortSignal {
  const signal = ms > 0 ? AbortSignal.timeout(Math.ceil(ms)) : AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  abortTimes.set(signal, Date.now() + Math.max(0, Math.ceil(ms)));
  return signal;
}

/**
 * Bounds the transaction's row-lock waits server-side to what `signal` has left, since PostgreSQL keeps waiting on a lock
 * after the abort closes its connection; a wait the bound ends raises 55P03. A signal not from {@link timeoutSignal} sets none.
 */
export async function boundLockWaits(tx: MetadataTx, signal: AbortSignal): Promise<void> {
  const abortsAt = abortTimes.get(signal);
  if (abortsAt === undefined) return;
  // lock_timeout 0 disables the timeout, so an exhausted signal still gets the shortest positive one.
  await tx.query("SELECT set_config('lock_timeout', $1, true)", [`${String(Math.max(1, Math.ceil(abortsAt - Date.now())))}ms`]);
}

/** True for PostgreSQL's lock_not_available (55P03), which a lock wait {@link boundLockWaits} bounded ends with. */
export function isLockNotAvailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '55P03';
}
