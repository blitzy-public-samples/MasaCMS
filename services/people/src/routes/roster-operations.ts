// The operator's list of every roster operation recovery halted, which parity replay records on the exceptions list.
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import { listHaltedOperations, type RecoveryDeps } from '../domain/roster-recovery.js';
import type { components } from '../generated/openapi.js';

type HaltedRosterOperations = components['schemas']['HaltedRosterOperations'];
type HaltedRosterOperation = HaltedRosterOperations['operations'][number];

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.platformMigration, Roles.platformOperator]),
});

/** Registers `listHaltedRosterOperations` as the people contract declares it. */
export async function registerRosterOperationRoutes(app: FastifyInstance, deps: Pick<RecoveryDeps, 'db' | 'repo'>): Promise<void> {
  app.get('/internal/v1/roster-operations/halted', { config: { opt2: ROUTE_AUTH } }, async (): Promise<HaltedRosterOperations> => {
    const operations = (await listHaltedOperations(deps)).map(
      (operation): HaltedRosterOperation => ({
        operationId: operation.operationId,
        tenantId: operation.tenantId,
        userId: operation.userId,
        kind: operation.kind,
        state: operation.state,
        startedAt: operation.startedAt.toISOString(),
        updatedAt: operation.updatedAt.toISOString(),
        haltedAt: operation.haltedAt.toISOString(),
        identityUnreachableSince: operation.identityUnreachableSince?.toISOString() ?? null,
        units: [...operation.units],
      }),
    );
    return { operations };
  });
}
