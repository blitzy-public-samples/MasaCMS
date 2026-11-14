/** userBean `getPasswordExpired()` and the `MURA_EXPIREPASSWORDS` setting it reads [legacy: core/mura/user/userBean.cfc:840-862]. */
import { describe, expect, it } from 'vitest';
import { expirePasswordsSetting, passwordExpired } from '../../src/domain/password-expiry.js';
import type { UserValues } from '../../src/domain/person.js';

const NOW = new Date(2026, 5, 30, 9, 15, 0, 0);
type Bean = Pick<UserValues, 'isnew' | 'passwordcreated'>;

describe('passwordExpired', () => {
  it.each<[string, number, Bean, boolean]>([
    ['passwords that never expire', 0, { isnew: 0, passwordcreated: new Date(2025, 0, 1) }, false],
    ['a new user', 30, { isnew: 1, passwordcreated: new Date(2025, 0, 1) }, false],
    ['an undated password', 30, { isnew: 0, passwordcreated: '' }, true],
    ['password date text no parser accepted', 30, { isnew: 0, passwordcreated: 'soon' }, true],
    ['a password older than the expiry', 30, { isnew: 0, passwordcreated: new Date(2026, 4, 1, 9, 15) }, true],
    ['a password a millisecond past the expiry', 30, { isnew: 0, passwordcreated: new Date(2026, 4, 31, 9, 14, 59, 999) }, true],
    ['a password expiring at the clock time', 30, { isnew: 0, passwordcreated: new Date(2026, 4, 31, 9, 15) }, false],
    ['a recent password', 30, { isnew: 0, passwordcreated: new Date(2026, 5, 20, 9, 15) }, false],
    ['a fractional expiry dateAdd truncates to 0 days', 0.5, { isnew: 0, passwordcreated: new Date(2026, 5, 30, 9, 0) }, true],
    ['a stored user whose isNew reads as the word false', 30, { isnew: 'false', passwordcreated: new Date(2026, 4, 1) }, true],
  ])('answers %s with expirePasswords %j as %j', (_case, expirePasswords, bean, expired) => {
    expect(passwordExpired(bean, expirePasswords, NOW)).toBe(expired);
  });

  it('fails as exists() does on an isNew that is no boolean, but only once passwords expire', () => {
    const bean: Bean = { isnew: 'abc', passwordcreated: NOW };
    expect(passwordExpired(bean, 0, NOW)).toBe(false);
    expect(() => passwordExpired(bean, 30, NOW)).toThrow(TypeError);
  });
});

describe('expirePasswordsSetting', () => {
  it.each<[string | undefined, number]>([
    [undefined, 0],
    ['30', 30],
    [' 30 ', 30],
    ['1.5', 1.5],
    ['0', 0],
    ['', 0],
    ['never', 0],
    ['${expirePasswords}', 0],
    ['{{expirePasswords}}', 0],
  ])('reads MURA_EXPIREPASSWORDS %j as %j', (value, expected) => {
    expect(expirePasswordsSetting(value === undefined ? {} : { MURA_EXPIREPASSWORDS: value })).toBe(expected);
  });
});
