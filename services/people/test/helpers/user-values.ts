/** Fixed-clock userBean values shared by the person-domain unit and isolation suites. */
import { fixedClock } from '@opt2/platform/testing';
import { newUserValues, type UserValues } from '../../src/domain/person.js';

export const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
export const CLOCK = fixedClock(NOW);

/** A new userBean at `CLOCK` with `overrides` set. */
export function bean(overrides: Partial<UserValues>): UserValues {
  return { ...newUserValues(CLOCK), ...overrides };
}
