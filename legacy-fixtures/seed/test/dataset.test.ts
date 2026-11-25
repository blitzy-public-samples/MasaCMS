// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig, parseConfig, type SeedConfig } from '../src/config.js';
import { buildDataset, canonicalJson, datasetDigest, type Dataset } from '../src/dataset.js';
import { fixtureKeys, type FixtureTables } from '../src/fixture-tables.js';

const CONFIG_PATH = fileURLToPath(new URL('../seed.config.json', import.meta.url));
const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';

let config: SeedConfig;
let dataset: Dataset;

/** Committed configuration edited by `edit`, then parsed. */
async function editedConfig(edit: (raw: Record<string, unknown>) => void): Promise<SeedConfig> {
  const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  edit(raw);
  return parseConfig(raw);
}

/** Committed configuration with its seed replaced. */
function withSeed(seed: number): Promise<SeedConfig> {
  return editedConfig((raw) => {
    raw.seed = seed;
  });
}

beforeAll(async () => {
  config = await loadConfig(CONFIG_PATH);
  dataset = buildDataset(config, SHA);
});

describe('canonicalJson', () => {
  it.each([
    [{ b: 1, a: [{ d: 2, c: null }] }, '{"a":[{"c":null,"d":2}],"b":1}'],
    [{}, '{}'],
    [[], '[]'],
    ['x"\n', '"x\\"\\n"'],
    [false, 'false'],
    [-0, '0'],
    [1.5e-7, '1.5e-7'],
    [{ '10': 1, '2': 2, B: 3, a: 4, é: 5, '\u{1F600}': 6, '\uFF61': 7 }, '{"10":1,"2":2,"B":3,"a":4,"é":5,"\u{1F600}":6,"\uFF61":7}'],
    [Object.assign(Object.create(null) as object, { z: 1, y: 2 }), '{"y":2,"z":1}'],
  ])('encodes %j', (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it.each([
    ['undefined', undefined, '$'],
    ['an undefined property', { a: [0, { b: undefined }] }, '$["a"][1]["b"]'],
    ['an array hole', [1, , 3], '$[1]'],
    ['a function', [() => 1], '$[0]'],
    ['NaN', { x: Number.NaN }, '$["x"]'],
    ['Infinity', Infinity, '$'],
    ['a symbol', Symbol('s'), '$'],
    ['a bigint', 10n, '$'],
    ['a Date', new Date(0), '$'],
    ['a Buffer', { bytes: Buffer.from('a') }, '$["bytes"]'],
  ])('rejects %s', (_label, value, at) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
    expect(() => canonicalJson(value)).toThrow(new RegExp(`^canonicalJson: cannot encode .+ at ${at.replace(/[$[\]]/g, '\\$&')}$`));
  });

  it('encodes a value alike before and after a JSON round trip', () => {
    const value = { z: [1, 'two', null, { y: false, x: 0.1 }], a: { c: '\u2028', b: -0 } };
    expect(canonicalJson(JSON.parse(JSON.stringify(value)))).toBe(canonicalJson(value));
  });
});

describe('buildDataset', () => {
  it('orders properties and records the inputs', () => {
    expect(Object.keys(dataset)).toEqual(['sourceSha', 'seed', 'businessDate', 'digest', 'masa', 'fixtures']);
    expect([dataset.sourceSha, dataset.seed, dataset.businessDate]).toEqual([SHA, 20260601, '2026-06-30']);
    expect(dataset.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keys fixtures in fixtureKeys order', () => {
    expect(Object.keys(dataset.fixtures)).toEqual(fixtureKeys());
    expect(dataset.fixtures['synthetic.person_archive']).toEqual([]);
  });

  it('is deterministic', () => {
    const again = buildDataset(config, SHA);
    expect(again.digest).toBe(dataset.digest);
    expect(JSON.stringify(again)).toBe(JSON.stringify(dataset));
  });

  it('digest depends on the seed, not on the source SHA', async () => {
    expect(buildDataset(config, 'f'.repeat(40)).digest).toBe(dataset.digest);
    expect(buildDataset(await withSeed(20260602), SHA).digest).not.toBe(dataset.digest);
  });

  it('ignores the retired module keys and scenario password names seed.config.json carries', async () => {
    const trimmed = await editedConfig((raw) => {
      delete raw.roleGroups;
      raw.scenarioPasswords = config.scenarioPasswords;
      for (const site of Object.values(raw.sites as Record<string, { programId?: unknown; counts: Record<string, unknown> }>)) {
        delete site.programId;
        for (const key of Object.keys(site.counts)) if (!Object.hasOwn(config.sites['tenant-a'].counts, key)) delete site.counts[key];
      }
    });
    expect(trimmed).toEqual(config);
    expect(buildDataset(trimmed, SHA).digest).toBe(dataset.digest);
  });
});

describe('datasetDigest', () => {
  it('hashes the canonical JSON of seed, businessDate, masa and fixtures only', () => {
    const { seed, businessDate, masa, fixtures } = dataset;
    const expected = createHash('sha256').update(canonicalJson({ seed, businessDate, masa, fixtures })).digest('hex');
    expect(datasetDigest(dataset)).toBe(expected);
    expect(datasetDigest({ ...dataset, sourceSha: 'other', digest: 'other' } as Dataset)).toBe(dataset.digest);
  });

  it('matches after the dataset.json round trip and changes with one edited row', () => {
    const back = JSON.parse(`${JSON.stringify(dataset)}\n`) as Dataset;
    expect(datasetDigest(back)).toBe(dataset.digest);
    const user = back.masa.users[0];
    if (user === undefined) throw new Error('dataset has no users');
    user.fname = `${user.fname}x`;
    expect(datasetDigest(back)).not.toBe(dataset.digest);
  });
});

describe('buildDataset merge', () => {
  /** `buildDataset` with the people builder returning `tables`. */
  async function buildWith(tables: FixtureTables): Promise<typeof buildDataset> {
    onTestFinished(() => {
      vi.doUnmock('../src/fixtures/people.js');
      vi.resetModules();
    });
    vi.doMock('../src/fixtures/people.js', () => ({ buildPeopleFixtures: (): FixtureTables => tables }));
    vi.resetModules();
    return (await import('../src/dataset.js')).buildDataset;
  }

  it('rejects an unknown key', async () => {
    const build = await buildWith({ 'synthetic.person': [] });
    expect(() => build(config, SHA)).toThrow(new RangeError('fixtures/people returned unknown fixture key "synthetic.person"'));
  });

  it('keeps every key, in order, when a builder omits some', async () => {
    const { fixtures } = (await buildWith({}))(config, SHA);
    expect(Object.keys(fixtures)).toEqual(fixtureKeys());
    expect(fixtures['synthetic.person_archive']).toEqual([]);
  });
});
