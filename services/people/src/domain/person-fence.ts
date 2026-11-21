// The roster protocol's per-user fence as a collaborator type, so modules the protocol imports can take it without an import cycle.
import type { Clock } from '@opt2/platform/service-kit';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';

/** Options of `PersonFence.fencePersons`; `selfOperationId` names the caller's own operation, which does not close its user. */
export interface PersonFenceOptions {
  selfOperationId?: string;
}

/** Options of `PersonFence.withPersonsOpen`; `sleep` waits between attempts and defaults to a timer. */
export interface PersonsOpenOptions {
  clock: Clock;
  sleep?: (ms: number) => Promise<unknown>;
}

/** Closes the users a transaction reads or writes to every open roster operation; roster-protocol.ts `personFence` implements it. */
export interface PersonFence {
  /** Share-locks `userIds` until `tx` ends, then signals `withPersonsOpen` when an open roster operation keeps any of them closed. */
  fencePersons(tx: TenantTx, userIds: readonly string[], opts?: PersonFenceOptions): Promise<void>;
  /** Runs `fn` in one gated transaction of `tenantId`, again after each closed signal; throws the legacy 503 once the user-closed wait is spent. */
  withPersonsOpen<T>(db: TenantDb, tenantId: string, fn: (tx: TenantTx) => Promise<T>, opts: PersonsOpenOptions): Promise<T>;
}
