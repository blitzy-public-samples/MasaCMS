// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Mapping } from '@opt2/platform/migration-kit';
import { UNITS } from '../../repo/tables.js';
import { exportDefinitionMapping } from './export-definition.js';
import { exportJobMapping } from './export-job.js';
import { sessionTrackingMapping } from './tsessiontracking.js';

export { exportDefinitionMapping } from './export-definition.js';
export { exportJobMapping } from './export-job.js';
export { sessionTrackingMapping } from './tsessiontracking.js';

/** The reporting mappings, definitions before the jobs that reference them, one per unit in `UNITS` order. */
export const mappings: readonly Mapping[] = Object.freeze([exportDefinitionMapping, exportJobMapping, sessionTrackingMapping]);

export const units: readonly string[] = UNITS;
