import { randomBytes } from 'node:crypto';
import { cfEq } from './serializer.js';

const CF_UUID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$/;

/** Fixed ContentID of every site's home node; the JSON API's findOne and save id checks accept it like a uuid. */
export const LEGACY_ADMIN_SENTINEL_ID = '00000000000000000000000000000000001';

/** Generates a 35-character ColdFusion `createUUID()` value (uppercase hex, 8-4-4-16). */
export function cfUuid(): string {
  const hex = randomBytes(16).toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16)}`;
}

/** Mirrors CFML `isValid('uuid', s)`, which accepts either case. */
export function isCfUuid(s: string): boolean {
  return CF_UUID_PATTERN.test(s);
}

/** Mirrors the JSON API findOne id test (jsonApiUtility.cfc:1265, 1277): a CF uuid, or the sentinel by ACF `==` (`1`, `01` match; `1.` does not). */
export function isLegacyFindOneId(s: string): boolean {
  return isCfUuid(s) || cfEq(s, LEGACY_ADMIN_SENTINEL_ID);
}
