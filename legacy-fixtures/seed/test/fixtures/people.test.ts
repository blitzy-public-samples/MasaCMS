// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type SeedConfig } from '../../src/config.js';
import { createRandom } from '../../src/random.js';
import { createCalendar } from '../../src/time.js';
import { buildMasa, indexMasa } from '../../src/masa.js';
import { fixtureKeys, specForKey, type FixtureContext } from '../../src/fixture-tables.js';
import { buildPeopleFixtures } from '../../src/fixtures/people.js';

const CONFIG_PATH = fileURLToPath(new URL('../../seed.config.json', import.meta.url));

let config: SeedConfig;
let ctx: FixtureContext;

/** Fixture context of `c`, with the people builder's own random stream. */
function context(c: SeedConfig): FixtureContext {
  const random = createRandom(c.seed);
  const calendar = createCalendar(c.businessDate);
  const masa = buildMasa(c, random.fork('masa'), calendar);
  return { config: c, random: random.fork('fixtures/people'), calendar, masa, index: indexMasa(masa, c) };
}

beforeAll(async () => {
  config = await loadConfig(CONFIG_PATH);
  ctx = context(config);
});

describe('buildPeopleFixtures', () => {
  it('maps each people key, in registry order, to an empty row list', () => {
    const peopleKeys = fixtureKeys(config).filter((key) => specForKey(key).spec.module === 'people');
    const tables = buildPeopleFixtures(ctx);
    expect(peopleKeys).toEqual(['synthetic.person_archive']);
    expect(Object.keys(tables)).toEqual(peopleKeys);
    for (const rows of Object.values(tables)) expect(rows).toEqual([]);
  });

  it('returns no key of another module', () => {
    const tables = buildPeopleFixtures(ctx);
    const otherKeys = fixtureKeys(config).filter((key) => specForKey(key).spec.module !== 'people');
    expect(otherKeys.length).toBeGreaterThan(0);
    expect(otherKeys.filter((key) => Object.hasOwn(tables, key))).toEqual([]);
  });

  it('is deterministic and independent of the seed', () => {
    const first = buildPeopleFixtures(ctx);
    expect(buildPeopleFixtures(ctx)).toEqual(first);
    expect(buildPeopleFixtures(context({ ...config, seed: config.seed + 1 }))).toEqual(first);
  });
});
