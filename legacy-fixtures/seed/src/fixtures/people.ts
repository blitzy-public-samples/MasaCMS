// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { fixtureKeys, specForKey, type FixtureContext, type FixtureRow, type FixtureTables } from '../fixture-tables.js';

/** Builds the people fixture tables; no archives are seeded, so every person stays open to archive. */
export function buildPeopleFixtures(ctx: FixtureContext): FixtureTables {
  return Object.fromEntries(
    fixtureKeys(ctx.config)
      .filter((key) => specForKey(key).spec.module === 'people')
      .map((key): [string, FixtureRow[]] => [key, []]),
  );
}
