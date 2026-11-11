// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { parseProgramTable, programTableName } from '@opt2/platform/migration-kit';
import { SITE_ORDER, type SeedConfig } from './config.js';
import type { MasaData, MasaIndex } from './masa.js';
import type { SeedRandom } from './random.js';
import type { Calendar } from './time.js';

/** Column value of a fixture row as the dataset serialises it. */
export type FixtureValue = string | number | null;

/** One fixture row keyed by DDL column name, in catalog order. */
export type FixtureRow = Record<string, FixtureValue>;

/** Fixture rows per dataset key (`synthetic.<table>` or `Program_<id>.<table>`). */
export type FixtureTables = Record<string, FixtureRow[]>;

/** Fixture module, as named under `legacy-fixtures/sql/` and `legacy-fixtures/cfml/modules/`. */
export type FixtureModule = 'people' | 'timesheets' | 'finance' | 'surveys' | 'reporting' | 'communications' | 'esignature';

/** Target service folder that owns a fixture table; a key of `OPT2_SERVICE_URLS`. */
export type OwningService = 'people' | 'timesheets' | 'finance' | 'surveys' | 'reporting' | 'communications' | 'e-signature';

/** Inputs every fixture builder reads. */
export interface FixtureContext {
  config: SeedConfig;
  random: SeedRandom;
  calendar: Calendar;
  masa: MasaData;
  index: MasaIndex;
}

/** Source of a row's tenant site: its own column, the site of its parent row, or its `Program_<id>` schema. */
export type SiteRule = { kind: 'column'; column: string } | { kind: 'parent'; table: string; foreignKey: string } | { kind: 'program' };

/** One fixture table: module, owning service, schema scope, primary-key column and tenant site rule. */
export interface FixtureTableSpec {
  module: FixtureModule;
  service: OwningService;
  scope: 'synthetic' | 'program';
  table: string;
  key: string;
  site: SiteRule;
}

const OWNER: Readonly<Record<FixtureModule, OwningService>> = Object.freeze({
  people: 'people',
  timesheets: 'timesheets',
  finance: 'finance',
  surveys: 'surveys',
  reporting: 'reporting',
  communications: 'communications',
  esignature: 'e-signature',
});

const SYNTHETIC_SCHEMA = 'synthetic';

const column = (name: string): SiteRule => ({ kind: 'column', column: name });
const parent = (table: string, foreignKey: string): SiteRule => ({ kind: 'parent', table, foreignKey });
const program = (): SiteRule => ({ kind: 'program' });

function spec(module: FixtureModule, scope: FixtureTableSpec['scope'], table: string, key: string, site: SiteRule): FixtureTableSpec {
  return Object.freeze({ module, service: OWNER[module], scope, table, key, site: Object.freeze(site) });
}

/** Every fixture table of the dataset, parents before children. */
export const FIXTURE_TABLE_SPECS: readonly FixtureTableSpec[] = Object.freeze([
  spec('people', 'synthetic', 'person_archive', 'archive_id', column('siteID')),
  spec('timesheets', 'program', 'timesheet', 'timesheet_id', program()),
  spec('timesheets', 'program', 'timesheet_day', 'day_id', program()),
  spec('timesheets', 'program', 'approval_action', 'action_id', program()),
  spec('timesheets', 'program', 'blackout', 'blackout_id', program()),
  spec('finance', 'program', 'finance_record', 'record_id', program()),
  spec('finance', 'program', 'finance_record_version', 'version_id', program()),
  spec('finance', 'program', 'finance_attachment', 'attachment_id', program()),
  spec('surveys', 'synthetic', 'survey', 'survey_id', column('siteID')),
  spec('surveys', 'synthetic', 'survey_schedule', 'schedule_id', parent('survey', 'survey_id')),
  spec('surveys', 'synthetic', 'survey_reminder', 'reminder_id', parent('survey', 'survey_id')),
  // A target's own siteID names the targeted site, so its tenant is the survey's site.
  spec('surveys', 'synthetic', 'survey_target', 'target_id', parent('survey', 'survey_id')),
  spec('surveys', 'synthetic', 'survey_response', 'response_id', column('siteID')),
  spec('reporting', 'synthetic', 'export_definition', 'definition_id', column('siteID')),
  spec('reporting', 'synthetic', 'export_job', 'job_id', column('siteID')),
  spec('communications', 'synthetic', 'message_template', 'template_id', column('siteID')),
  spec('communications', 'synthetic', 'message', 'message_id', column('siteID')),
  spec('communications', 'synthetic', 'delivery_status', 'status_id', parent('message', 'message_id')),
  spec('esignature', 'synthetic', 'signature_request', 'request_id', column('siteID')),
  spec('esignature', 'synthetic', 'signature', 'signature_id', parent('signature_request', 'request_id')),
  spec('esignature', 'synthetic', 'audit_entry', 'entry_id', parent('signature_request', 'request_id')),
]);

const SPEC_BY_SCOPED_TABLE: ReadonlyMap<string, FixtureTableSpec> = new Map(
  FIXTURE_TABLE_SPECS.map((entry): [string, FixtureTableSpec] => [`${entry.scope}:${entry.table}`, entry]),
);

/** Dataset key of `spec`: `synthetic.<table>`, or `Program_<programId>.<table>`; throws `RangeError` when `programId` does not fit the scope. */
export function fixtureKey(spec: FixtureTableSpec, programId?: number): string {
  if (spec.scope === 'synthetic') {
    if (programId !== undefined) throw new RangeError(`${SYNTHETIC_SCHEMA}.${spec.table} takes no programId, got ${programId}`);
    return `${SYNTHETIC_SCHEMA}.${spec.table}`;
  }
  if (programId === undefined) throw new RangeError(`Program table ${spec.table} needs a programId`);
  return programTableName(programId, spec.table);
}

/** Program ids of the configured sites, ascending. */
function programIds(config: SeedConfig): number[] {
  return SITE_ORDER.map((site) => config.sites[site].programId)
    .filter((id): id is number => id !== null)
    .sort((a, b) => a - b);
}

/** Every dataset key in registry order, each program table expanded per program id ascending. */
export function fixtureKeys(config: SeedConfig): string[] {
  const programs = programIds(config);
  return FIXTURE_TABLE_SPECS.flatMap((entry) =>
    entry.scope === 'synthetic' ? [fixtureKey(entry)] : programs.map((programId) => fixtureKey(entry, programId)),
  );
}

/** Spec and program id (null for synthetic tables) of an exact dataset key; throws `RangeError` for any other key. */
export function specForKey(key: string): { spec: FixtureTableSpec; programId: number | null } {
  const parsed = parseProgramTable(key);
  const programId = parsed?.programId;
  const scoped = parsed === null ? `synthetic:${key.slice(SYNTHETIC_SCHEMA.length + 1)}` : `program:${parsed.table}`;
  const found = SPEC_BY_SCOPED_TABLE.get(scoped);
  if (found === undefined || fixtureKey(found, programId) !== key) {
    throw new RangeError(`Unknown fixture table key ${JSON.stringify(key)}`);
  }
  return { spec: found, programId: programId ?? null };
}

/** Every dataset key mapped to an empty row list, in `fixtureKeys` order. */
export function emptyFixtureTables(config: SeedConfig): FixtureTables {
  return Object.fromEntries(fixtureKeys(config).map((key): [string, FixtureRow[]] => [key, []]));
}
