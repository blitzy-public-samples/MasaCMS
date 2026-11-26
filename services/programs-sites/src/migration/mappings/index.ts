import type { Mapping } from '@opt2/platform/migration-kit';
import { UNITS } from '../../repo/tables.js';
import { tsettingsMapping } from './tsettings.js';
import { timagesizesMapping } from './timagesizes.js';
import { tdirectoriesMapping } from './tdirectories.js';
import { tsystemobjectsMapping } from './tsystemobjects.js';
import { tclassextendMapping } from './tclassextend.js';
import { tclassextendsetsMapping } from './tclassextendsets.js';
import { tclassextendattributesMapping } from './tclassextendattributes.js';
import { tclassextendrcsetsMapping } from './tclassextendrcsets.js';
import { tclassextenddataMapping } from './tclassextenddata.js';
import { ttrashMapping } from './ttrash.js';

export { tsettingsMapping } from './tsettings.js';
export { timagesizesMapping } from './timagesizes.js';
export { tdirectoriesMapping } from './tdirectories.js';
export { tsystemobjectsMapping } from './tsystemobjects.js';
export { tclassextendMapping } from './tclassextend.js';
export { tclassextendsetsMapping } from './tclassextendsets.js';
export { tclassextendattributesMapping } from './tclassextendattributes.js';
export { tclassextendrcsetsMapping } from './tclassextendrcsets.js';
export { tclassextenddataMapping } from './tclassextenddata.js';
export { ttrashMapping } from './ttrash.js';

// ttrash is mapped because opt2/table-ownership.json assigns programs_sites.trash (site extendObject rows) to this service;
// its rows migrate although the trash screens are withheld. sitemonitor_state has no unit and is never mapped.
/** The programs-sites mappings, parents before children, one per mapped unit in `UNITS` order. */
export const mappings: readonly Mapping[] = Object.freeze([
  tsettingsMapping,
  timagesizesMapping,
  tdirectoriesMapping,
  tsystemobjectsMapping,
  tclassextendMapping,
  tclassextendsetsMapping,
  tclassextendattributesMapping,
  tclassextendrcsetsMapping,
  tclassextenddataMapping,
  ttrashMapping,
]);

/** Units of write authority the migration handlers gate, exactly `UNITS` in its order. */
export const units: readonly string[] = UNITS;
