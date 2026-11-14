/** The roster write protocol's constants and photo-branch error, without a database. */
import { describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { IDENTITY_OPERATION_UNITS, PEOPLE_OPERATION_UNITS, PhotoBranchError, REQUEST_BUDGET_MS, USER_CLOSED_WAIT_MS } from '../../src/domain/roster-protocol.js';
import { PEOPLE_UNITS } from '../../src/repo/tables.js';

describe('roster protocol constants', () => {
  it('names the closure and request waits and the units of both participants', () => {
    expect([USER_CLOSED_WAIT_MS, REQUEST_BUDGET_MS]).toEqual([10_000, 10_000]);
    expect(PEOPLE_OPERATION_UNITS).toEqual(['people.person', 'people.user_address', 'people.user_interest', 'people.user_tag', 'people.extend_data_user_activity', 'people.trash']);
    expect(PEOPLE_OPERATION_UNITS.every((unit) => (PEOPLE_UNITS as readonly string[]).includes(unit))).toBe(true);
    expect(IDENTITY_OPERATION_UNITS).toEqual(['identity.user_account', 'identity.credential', 'identity.login_state', 'identity.membership']);
  });

  it('answers the photo branch with the legacy 503', () => {
    const error = new PhotoBranchError();
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ name: 'PhotoBranchError', surface: 'auto', reason: 'photo-withheld' });
  });
});
