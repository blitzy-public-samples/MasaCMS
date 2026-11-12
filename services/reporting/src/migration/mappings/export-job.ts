// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import type { CanonicalValue, Mapping } from '@opt2/platform/migration-kit';
import { EXPORT_JOB, EXPORT_OUTPUT_FIELD } from '../../repo/tables.js';

const columnsMapping: Mapping = defineMapping({
  legacyTable: 'synthetic.export_job',
  // Mapping targets are schema-qualified: EXPORT_JOB.unit, not the repository's bare EXPORT_JOB.table.
  targetTable: EXPORT_JOB.unit,
  unit: EXPORT_JOB.unit,
  // `output` is object-backed, so it stays out of the row encoding: reconciliation compares the object manifest instead.
  columns: [
    { legacy: 'job_id', target: 'job_id', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'definition_id', target: 'definition_id', type: 's' },
    { legacy: 'format', target: 'format', type: 's' },
    { legacy: 'state', target: 'state', type: 's' },
    { legacy: 'requested_by_id', target: 'requested_by_id', type: 's' },
    { legacy: 'created', target: 'created', type: 't' },
    { legacy: 'started_at', target: 'started_at', type: 't' },
    { legacy: 'finished_at', target: 'finished_at', type: 't' },
    { legacy: 'error', target: 'error', type: 's' },
    { legacy: 'file_name', target: 'file_name', type: 's' },
    { legacy: 'content_type', target: 'content_type', type: 's' },
    { legacy: 'output_sha256', target: 'output_sha256', type: 's' },
  ],
  key: EXPORT_JOB.key,
  tenant: { kind: 'site', column: 'siteID' },
});

/** The decoded `output` value of a legacy row, its name matched case-insensitively as SQL Server matches it; undefined when absent. */
function legacyOutput(legacyValues: Readonly<Record<string, CanonicalValue>>): CanonicalValue | undefined {
  for (const [name, value] of Object.entries(legacyValues)) {
    if (name.toLowerCase() === EXPORT_OUTPUT_FIELD) return value;
  }
  return undefined;
}

// Bytes pass unchecked: the repository verifies them against output_sha256, stores them in reporting-exports and sets object_key.
// Values are pg parameters (t as canonical text), so the row keeps Mapping's type rather than ExportJobApplyRow.
const toTarget: Mapping['toTarget'] = (legacyValues, opts) => {
  const row = columnsMapping.toTarget(legacyValues, opts);
  const output = legacyOutput(legacyValues);
  return output === undefined ? row : { ...row, [EXPORT_OUTPUT_FIELD]: output };
};

/** Mapping of fixture table `synthetic.export_job` to `reporting.export_job`, tenant from `siteID`; `toTarget` also carries the legacy bytes under `output`. */
export const exportJobMapping: Mapping = Object.freeze({ ...columnsMapping, toTarget });
