// The claim fence of a transition drive, shared by the service that holds the claim and the steps whose effects it fences.
import { AsyncLocalStorage } from 'node:async_hooks';

/** This instance no longer holds the claim on the transition's row, so it must stop driving it. */
export class TransitionClaimLostError extends Error {
  override readonly name: string = 'TransitionClaimLostError';

  constructor(readonly transitionId: string) {
    super(`Transition ${transitionId} is no longer claimed by this instance`);
  }
}

/** A drive's view of its claim: the latest expiry it wrote and whether a renewal or write found the claim taken. */
export interface ClaimFence {
  validUntil: number;
  taken: boolean;
  /** @throws TransitionClaimLostError unless the claim outlasts one more call */
  assert(): void;
}

/** Fence of the drive running in the current async context. */
export const claimFences = new AsyncLocalStorage<ClaimFence>();

/** Refuses an effect of a drive that no longer holds its claim; outside a drive nothing is checked. @throws TransitionClaimLostError */
export function assertClaim(): void {
  claimFences.getStore()?.assert();
}
