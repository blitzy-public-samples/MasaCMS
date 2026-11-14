// userBean `getPasswordExpired()` and the configBean `expirePasswords` setting it reads [legacy: core/mura/user/userBean.cfc:840-862, core/mura/configBean.cfc:270-279].
import { cfDateAdd, cfIsDate, cfIsNumeric, cfToBoolean, cfToNumber } from '@opt2/platform/legacy-compat';
import type { UserValues } from './person.js';

/** configBean `expirePasswords` from `MURA_EXPIREPASSWORDS`; unset, an unevaluable `${…}` or `{{…}}` expression, or other non-numeric text is 0. */
export function expirePasswordsSetting(env: Readonly<Record<string, string | undefined>>): number {
  const value = env.MURA_EXPIREPASSWORDS;
  return value !== undefined && cfIsNumeric(value) ? cfToNumber(value) : 0;
}

/**
 * userBean `getPasswordExpired()` at `now`: false while passwords never expire or for a new bean, true for an undated
 * password, else whether `expirePasswords` days after `passwordcreated` lie before `now`.
 * @throws TypeError When `isnew` is no CFML boolean, as `exists()` fails on it.
 */
export function passwordExpired(values: Pick<UserValues, 'isnew' | 'passwordcreated'>, expirePasswords: number, now: Date): boolean {
  if (expirePasswords === 0 || cfToBoolean(values.isnew)) return false;
  const created = values.passwordcreated;
  return !cfIsDate(created) || cfDateAdd('d', expirePasswords, created).getTime() < now.getTime();
}
