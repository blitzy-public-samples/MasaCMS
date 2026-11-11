// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig, parseConfig, type SeedConfig } from '../src/config.js';
import { buildDataset, canonicalJson, datasetDigest, type Dataset } from '../src/dataset.js';
import { fixtureKeys, specForKey, type FixtureTables } from '../src/fixture-tables.js';

const CONFIG_PATH = fileURLToPath(new URL('../seed.config.json', import.meta.url));
const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';

let config: SeedConfig;
let dataset: Dataset;

/** Committed configuration with its seed replaced. */
async function withSeed(seed: number): Promise<SeedConfig> {
  const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as { seed: number };
  return parseConfig({ ...raw, seed });
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
    expect(Object.keys(dataset.fixtures)).toEqual(fixtureKeys(config));
    expect(dataset.fixtures['Program_1.timesheet_day']).toHaveLength(20000);
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
  it.each([
    ['an unknown key', { 'Program_9.finance_record': [] }, new RangeError('fixtures/finance returned unknown fixture key "Program_9.finance_record"')],
    ['a key already filled', { 'Program_1.timesheet': [] }, new Error('fixtures/finance returned fixture key "Program_1.timesheet" already filled')],
  ])('rejects %s', async (_label, tables: FixtureTables, error) => {
    onTestFinished(() => {
      vi.doUnmock('../src/fixtures/finance.js');
      vi.resetModules();
    });
    vi.doMock('../src/fixtures/finance.js', () => ({ buildFinanceFixtures: (): FixtureTables => tables }));
    vi.resetModules();
    const { buildDataset: build } = await import('../src/dataset.js');
    expect(() => build(config, SHA)).toThrow(error);
  });

  it('keeps every key, in order, when a builder omits some', async () => {
    onTestFinished(() => {
      vi.doUnmock('../src/fixtures/finance.js');
      vi.resetModules();
    });
    const row = { record_id: 'X' };
    vi.doMock('../src/fixtures/finance.js', () => ({ buildFinanceFixtures: (): FixtureTables => ({ 'Program_2.finance_record': [row] }) }));
    vi.resetModules();
    const { buildDataset: build } = await import('../src/dataset.js');
    const { fixtures } = build(config, SHA);
    expect(Object.keys(fixtures)).toEqual(fixtureKeys(config));
    expect(fixtures['Program_2.finance_record']).toEqual([row]);
    for (const key of Object.keys(fixtures).filter((k) => specForKey(k).spec.module === 'finance' && k !== 'Program_2.finance_record')) {
      expect(fixtures[key]).toEqual([]);
    }
  });
});
