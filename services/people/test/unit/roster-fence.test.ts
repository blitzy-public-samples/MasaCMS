/** The roster protocol's per-user fence object and its closed-user signal, without a database. */
import { describe, expect, it } from 'vitest';
import { OperationBlockedError } from '@opt2/platform/migration-kit';
import { IDENTITY_OPERATION_UNITS, PEOPLE_OPERATION_UNITS, PersonClosedSignal, fencePersons, personFence, withPersonsOpen } from '../../src/domain/roster-protocol.js';

describe('personFence', () => {
  it('carries the protocol fence and runner', () => {
    expect(personFence).toEqual({ fencePersons, withPersonsOpen });
    expect(Object.isFrozen(personFence)).toBe(true);
  });

  it('signals a closed user as the legacy 503 it answers when unhandled', () => {
    const closed = new PersonClosedSignal('U1', 'OP-1');
    expect(closed).toBeInstanceOf(OperationBlockedError);
    expect(closed).toMatchObject({ name: 'PersonClosedSignal', userId: 'U1', operationId: 'OP-1', reason: 'operation-blocked' });
    expect(closed.message).toBe('Roster operation OP-1 keeps user U1 closed');
    expect(closed.units).toEqual([...PEOPLE_OPERATION_UNITS, ...IDENTITY_OPERATION_UNITS]);
  });
});
