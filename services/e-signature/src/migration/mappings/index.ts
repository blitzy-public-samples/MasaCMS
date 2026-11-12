// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Mapping } from '@opt2/platform/migration-kit';
import { UNITS } from '../../repo/tables.js';
import { signatureRequestMapping } from './signature-request.js';
import { signatureMapping } from './signature.js';
import { auditEntryMapping } from './audit-entry.js';

export { signatureRequestMapping, signatureMapping, auditEntryMapping };

/** The e-signature mappings, request before its children, one per unit in `UNITS` order. */
export const mappings: readonly Mapping[] = Object.freeze([signatureRequestMapping, signatureMapping, auditEntryMapping]);

/** Units of write authority the migration handlers gate, exactly `UNITS` in its order. */
export const units = UNITS;
