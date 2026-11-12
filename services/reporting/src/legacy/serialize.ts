// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture row projections: target `reporting` rows as reporting.cfc's `envelope.rows()` renders the `synthetic.export_*` rows. */
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import type { JobState } from '../domain/job-state.js';
import type { ExportDefinitionRow, ExportFormat, ExportJobRow } from '../repo/tables.js';

// envelope.cfc rows() renders datetime columns with this dateTimeFormat mask before serialization, not through the serializer's date hint.
const FIXTURE_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss";

/** An `export_job` row without `output`: lower-cased column names in the fixture's select order, NULL columns as ''. */
export type FixtureExportJob = {
  job_id: string;
  siteid: string;
  definition_id: string;
  format: ExportFormat;
  state: JobState;
  requested_by_id: string;
  created: string;
  started_at: string;
  finished_at: string;
  error: string;
  file_name: string;
  content_type: string;
  output_sha256: string;
};

/** An `export_definition` row: lower-cased column names in catalog order. */
export type FixtureExportDefinition = {
  definition_id: string;
  siteid: string;
  name: string;
  source: string;
  columns: string;
};

/** Fixture text of a stored datetime in the process (legacy server) zone, or '' for NULL. */
function timestamp(value: Date | null): string {
  return value === null ? '' : cfDateTimeFormat(value, FIXTURE_TIMESTAMP_MASK);
}

/** Projects a `reporting.export_job` row onto the fixture job fields; the object key and row version never leave the service. */
export function jobRow(row: ExportJobRow): FixtureExportJob {
  return {
    job_id: row.job_id,
    siteid: row.siteid,
    definition_id: row.definition_id,
    format: row.format,
    state: row.state,
    requested_by_id: row.requested_by_id,
    created: timestamp(row.created),
    started_at: timestamp(row.started_at),
    finished_at: timestamp(row.finished_at),
    error: row.error ?? '',
    file_name: row.file_name ?? '',
    content_type: row.content_type ?? '',
    output_sha256: row.output_sha256 ?? '',
  };
}

// envelope.rows() passes the nvarchar(max) column list through as text, and seeded definitions may hold text that is not a JSON array.
/** Projects a `reporting.export_definition` row onto the fixture definition fields, `columns` as its stored JSON text. */
export function definitionRow(row: ExportDefinitionRow): FixtureExportDefinition {
  return {
    definition_id: row.definition_id,
    siteid: row.siteid,
    name: row.name,
    source: row.source,
    columns: row.columns,
  };
}
