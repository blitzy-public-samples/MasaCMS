/** Roster recovery over a throwaway `people` schema: a stale people-committed operation rolled back to its before-image. */
import { describe, expect, it } from 'vitest';
import { createLogger } from '@opt2/platform/logging';
import { encodeRow } from '@opt2/platform/migration-kit';
import { TENANT_A } from '@opt2/platform/testing';
import { resolveOperation, type RecoveryDeps } from '../../src/domain/roster-recovery.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import { PERSON, type PersonRow } from '../../src/repo/tables.js';
import { createMutableClock } from '../helpers/app.js';
import { accountFor, personRow } from '../helpers/fixtures.js';
import { PG_AVAILABLE, withPgApp } from '../helpers/pg-app.js';
import { CHANGE, STALE_MS, imageOf } from '../helpers/roster-recovery-fixtures.js';

const A = TENANT_A.tenantId;

describe.skipIf(!PG_AVAILABLE)('roster recovery against PostgreSQL', () => {
  it('rolls a people-committed operation identity still prepared back to its before-image byte for byte', async () => {
    const result = await withPgApp(async ({ db, identity }) => {
      const clock = createMutableClock();
      const lines: string[] = [];
      const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: (line: string) => void lines.push(line) } });
      const repo = createPeopleRepository({ clock, schema: db.schema });
      const deps: RecoveryDeps = { db, repo, identity: identity.identityClient, events: createPeopleEvents(repo), clock, logger };
      const before = await db.withTenant(A, (tx) => repo.insert<PersonRow>(tx, PERSON.table, personRow()));
      const operation = await db.withTenant(A, async (tx) => {
        const started = await repo.insertRosterOperation(tx, { kind: 'admin-update', userId: before.userid, payload: '{}' });
        await repo.update(tx, PERSON.table, { userid: before.userid }, { fname: 'Robin', email: 'robin@tenant-a.opt2.test', row_version: '2' });
        return repo.setRosterOperationState(tx, started.operation_id, { state: 'people-committed', beforeImage: imageOf(before) });
      });
      if (operation === null) throw new Error('roster operation missing after its insert');
      identity.seedAccounts(accountFor(before));
      await identity.identityClient.prepare(before.userid, operation.operation_id, CHANGE);
      clock.advance(STALE_MS);

      const outcome = await resolveOperation(deps, { tenantId: A, operationId: operation.operation_id });
      const restored = await db.withTenant(A, (tx) => repo.findPerson(tx, before.userid));
      const final = await db.withTenant(A, (tx) => repo.findRosterOperation(tx, operation.operation_id));
      return { outcome, restored, final, identityState: identity.operation(operation.operation_id)?.state, before };
    });

    if ('skipped' in result) throw new Error(result.reason);
    const { outcome, restored, final, identityState, before } = result;
    expect(outcome).toMatchObject({ from: 'people-committed', to: 'rolled-back', action: 'aborted', identityState: 'prepared' });
    expect(identityState).toBe('aborted');
    expect(final).toMatchObject({ state: 'rolled-back' });
    if (restored === null) throw new Error('restored person missing');
    const legacyColumns = PERSON.columns.filter((column) => column.name !== 'row_version');
    expect(encodeRow(legacyColumns, restored)).toBe(encodeRow(legacyColumns, before));
    expect(restored.row_version).toBe('3');
  });
});
