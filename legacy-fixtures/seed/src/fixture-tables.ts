// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { SeedConfig } from './config.js';
import type { MasaData, MasaIndex } from './masa.js';
import type { SeedRandom } from './random.js';
import type { Calendar } from './time.js';

/** Column value of a fixture row as the dataset serialises it. */
export type FixtureValue = string | number | null;

/** One fixture row keyed by DDL column name, in catalog order. */
export type FixtureRow = Record<string, FixtureValue>;

/** Fixture rows per dataset key (`synthetic.<table>`). */
export type FixtureTables = Record<string, FixtureRow[]>;

/** Fixture module, as named under `legacy-fixtures/sql/` and `legacy-fixtures/cfml/modules/`. */
export type FixtureModule = 'people';

/** Target service folder that owns a fixture table; a key of `OPT2_SERVICE_URLS`. */
export type OwningService = 'people';

/** Inputs every fixture builder reads. */
export interface FixtureContext {
  config: SeedConfig;
  random: SeedRandom;
  calendar: Calendar;
  masa: MasaData;
  index: MasaIndex;
}

/** One fixture table of schema `synthetic`: module, owning service, primary-key column and the column naming its tenant site. */
export interface FixtureTableSpec {
  module: FixtureModule;
  service: OwningService;
  table: string;
  key: string;
  siteColumn: string;
}

const SYNTHETIC_SCHEMA = 'synthetic';

/** Every fixture table of the dataset. */
export const FIXTURE_TABLE_SPECS: readonly FixtureTableSpec[] = Object.freeze([
  Object.freeze({ module: 'people', service: 'people', table: 'person_archive', key: 'archive_id', siteColumn: 'siteID' } as const),
]);

/** Dataset key of `spec`: `synthetic.<table>`. */
export function fixtureKey(spec: FixtureTableSpec): string {
  return `${SYNTHETIC_SCHEMA}.${spec.table}`;
}

const SPEC_BY_KEY: ReadonlyMap<string, FixtureTableSpec> = new Map(FIXTURE_TABLE_SPECS.map((entry): [string, FixtureTableSpec] => [fixtureKey(entry), entry]));

/** Every dataset key in registry order. */
export function fixtureKeys(): string[] {
  return [...SPEC_BY_KEY.keys()];
}

/** Spec of an exact dataset key; throws `RangeError` for any other key. */
export function specForKey(key: string): FixtureTableSpec {
  const found = SPEC_BY_KEY.get(key);
  if (found === undefined) throw new RangeError(`Unknown fixture table key ${JSON.stringify(key)}`);
  return found;
}

/** Every dataset key mapped to an empty row list, in `fixtureKeys` order. */
export function emptyFixtureTables(): FixtureTables {
  return Object.fromEntries(fixtureKeys().map((key): [string, FixtureRow[]] => [key, []]));
}
