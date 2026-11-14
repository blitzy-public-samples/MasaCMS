// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Mapping } from '@opt2/platform/migration-kit';
import { UNITS } from '../../repo/tables.js';
import { exportDefinitionMapping } from './export-definition.js';
import { exportJobMapping } from './export-job.js';
import { sessionTrackingMapping } from './tsessiontracking.js';
import {
  tclassextendMapping,
  tclassextendattributesMapping,
  tclassextenddataMapping,
  tclassextendrcsetsMapping,
  tclassextendsetsMapping,
} from './extend.js';
import { trashMapping } from './trash.js';

export { exportDefinitionMapping } from './export-definition.js';
export { exportJobMapping } from './export-job.js';
export { sessionTrackingMapping } from './tsessiontracking.js';
export {
  REPORTING_BASE_TABLES,
  tclassextendMapping,
  tclassextendattributesMapping,
  tclassextenddataMapping,
  tclassextendrcsetsMapping,
  tclassextendsetsMapping,
} from './extend.js';
export { trashMapping } from './trash.js';

/** The reporting mappings, parents before children, one per unit in `UNITS` order. */
export const mappings: readonly Mapping[] = Object.freeze([
  exportDefinitionMapping,
  exportJobMapping,
  sessionTrackingMapping,
  tclassextendMapping,
  tclassextendsetsMapping,
  tclassextendattributesMapping,
  tclassextendrcsetsMapping,
  tclassextenddataMapping,
  trashMapping,
]);

export const units: readonly string[] = UNITS;
