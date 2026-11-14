// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Mapping } from '@opt2/platform/migration-kit';
import { UNITS } from '../../repo/tables.js';
import { financeRecordMapping } from './finance-record.js';
import { financeRecordVersionMapping } from './finance-record-version.js';
import { financeAttachmentMapping } from './finance-attachment.js';
import { financeRollupMapping } from './finance-rollup.js';

export { financeRecordMapping } from './finance-record.js';
export { financeRecordVersionMapping } from './finance-record-version.js';
export { financeAttachmentMapping } from './finance-attachment.js';
export { financeRollupMapping } from './finance-rollup.js';

// finance.program_binding and finance.staged_object have no unit and are never mapped.
/** The finance mappings, record before its children, one per unit in `UNITS` order. */
export const mappings: readonly Mapping[] = Object.freeze([
  financeRecordMapping,
  financeRecordVersionMapping,
  financeAttachmentMapping,
  financeRollupMapping,
]);

/** Units of write authority the migration handlers gate, exactly `UNITS` in its order. */
export const units: readonly string[] = UNITS;

const PROGRAM_SITE_ROWS = { 1: 'tenant-a', 2: 'tenant-b' } as const;

/** Masa site of each fixture `Program_<id>` schema, keyed by program id, as `synthetic.program_site` holds them. */
export const PROGRAM_SITES: typeof PROGRAM_SITE_ROWS & Readonly<Record<number, string>> = Object.freeze(PROGRAM_SITE_ROWS);
