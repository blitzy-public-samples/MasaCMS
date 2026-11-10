// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { createHash } from 'node:crypto';
import type { SeedRandom } from './random.js';

/** ContentID of every Masa site's home node, the parent of top-level content. */
export const MASA_HOME_CONTENT_ID = '00000000000000000000000000000000001';

/** ModuleID of the Masa Site Manager module, used for seeded files. */
export const MASA_DEFAULT_MODULE_ID = '00000000000000000000000000000000000';

const HEX32 = /^[0-9A-Fa-f]{32}$/;

/** Formats 32 hex characters as a 35-character uppercase CF `createUUID()` value (8-4-4-16); throws on any other input. */
export function formatCfUuid(hex32: string): string {
  if (!HEX32.test(hex32)) throw new RangeError(`formatCfUuid: expected 32 hex characters, got "${hex32}"`);
  const hex = hex32.toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16)}`;
}

/** Draws a CF UUID from four `uint32()` words of `rng`, so equal streams yield equal ids. */
export function cfUuidFrom(rng: SeedRandom): string {
  let hex = '';
  for (let i = 0; i < 4; i += 1) hex += rng.uint32().toString(16).padStart(8, '0');
  return formatCfUuid(hex);
}

/** CF UUID from the first 128 bits of SHA-256 over the NUL-joined `parts`; equal parts always yield the same id. */
export function stableId(...parts: readonly (string | number)[]): string {
  const digest = createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex');
  return formatCfUuid(digest.slice(0, 32));
}
