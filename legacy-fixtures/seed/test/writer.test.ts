// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig, type SeedConfig } from '../src/config.js';
import { buildDataset, datasetDigest, type Dataset } from '../src/dataset.js';
import { fixtureKeys } from '../src/fixture-tables.js';
import { readDataset, writeDataset, type DatasetPart, type Manifest } from '../src/writer.js';

const CONFIG_PATH = fileURLToPath(new URL('../seed.config.json', import.meta.url));
const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const MASA_ARRAYS = ['sites', 'groups', 'users', 'memberships', 'categories', 'content', 'files', 'oauthClients'];
const PART_NAME = /^dataset-\d{4}\.json$/;

let config: SeedConfig;
let dataset: Dataset;
let root: string;
let outDir: string;
let manifest: Manifest;

/** Fresh empty directory under the test root. */
async function freshDir(name: string): Promise<string> {
  return mkdtemp(join(root, `${name}-`));
}

/** File names in `dir`, sorted. */
async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** The full dataset with every array cut to its first `n` rows and the digest recomputed. */
function truncated(n: number): Dataset {
  const masa = Object.fromEntries(Object.entries(dataset.masa).map(([k, rows]) => [k, rows.slice(0, n)])) as unknown as Dataset['masa'];
  const fixtures = Object.fromEntries(Object.entries(dataset.fixtures).map(([k, rows]) => [k, rows.slice(0, n)]));
  const { sourceSha, seed, businessDate } = dataset;
  return { sourceSha, seed, businessDate, digest: datasetDigest({ seed, businessDate, masa, fixtures }), masa, fixtures };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'seed-writer-'));
  config = await loadConfig(CONFIG_PATH);
  dataset = buildDataset(config, SHA);
  outDir = await freshDir('full');
  manifest = await writeDataset(outDir, dataset, config.chunkRows);
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('writeDataset', () => {
  it('writes compact dataset and manifest files with a trailing newline', async () => {
    expect(await readFile(join(outDir, 'dataset.json'), 'utf8')).toBe(`${JSON.stringify(dataset)}\n`);
    expect(await readFile(join(outDir, 'manifest.json'), 'utf8')).toBe(`${JSON.stringify(manifest)}\n`);
    expect(Object.keys(manifest)).toEqual(['sourceSha', 'seed', 'businessDate', 'digest', 'counts', 'parts']);
    expect([manifest.sourceSha, manifest.seed, manifest.businessDate, manifest.digest]).toEqual([SHA, dataset.seed, dataset.businessDate, dataset.digest]);
  });

  it('counts every array in MasaData then fixture order, zero counts included', () => {
    expect(Object.keys(manifest.counts)).toEqual([...MASA_ARRAYS.map((k) => `masa.${k}`), ...fixtureKeys(config).map((k) => `fixtures.${k}`)]);
    expect(manifest.counts['masa.users']).toBe(3200);
    for (const empty of ['fixtures.synthetic.person_archive', 'fixtures.Program_1.blackout', 'fixtures.Program_2.blackout']) {
      expect(manifest.counts[empty]).toBe(0);
      expect(manifest.parts.some((p) => p.array === empty)).toBe(false);
    }
  });

  it('splits masa.users into chunkRows parts', () => {
    const users = manifest.parts.filter((p) => p.array === 'masa.users');
    expect(users.map((p) => [p.offset, p.count])).toEqual([[0, 1000], [1000, 1000], [2000, 1000], [3000, 200]]);
  });

  it('numbers parts globally in write order and gives every non-empty array at least one part', async () => {
    expect(manifest.parts.map((p) => p.file)).toEqual(manifest.parts.map((_, i) => `dataset-${String(i + 1).padStart(4, '0')}.json`));
    const order = Object.keys(manifest.counts);
    const arrays = [...new Set(manifest.parts.map((p) => p.array))];
    expect(arrays).toEqual(order.filter((k) => (manifest.counts[k] ?? 0) > 0));
    expect(manifest.parts.every((p) => p.count >= 1 && p.count <= config.chunkRows)).toBe(true);
    expect(await listing(outDir)).toEqual(['dataset.json', ...manifest.parts.map((p) => p.file), 'manifest.json'].sort());
  });

  it('parts concatenated in offset order equal each array of dataset.json', async () => {
    const written = await readJson<Dataset>(join(outDir, 'dataset.json'));
    const arrays: Record<string, unknown[]> = {
      ...Object.fromEntries(Object.entries(written.masa).map(([k, rows]) => [`masa.${k}`, rows])),
      ...Object.fromEntries(Object.entries(written.fixtures).map(([k, rows]) => [`fixtures.${k}`, rows])),
    };
    const joined: Record<string, unknown[]> = Object.fromEntries(Object.keys(arrays).map((k) => [k, []]));
    for (const part of manifest.parts) {
      const body = await readJson<DatasetPart>(join(outDir, part.file));
      expect(Object.keys(body)).toEqual(['sourceSha', 'digest', 'array', 'offset', 'rows']);
      expect([body.sourceSha, body.digest, body.array, body.offset, body.rows.length]).toEqual([SHA, dataset.digest, part.array, part.offset, part.count]);
      expect(joined[part.array]).toHaveLength(part.offset);
      joined[part.array]?.push(...body.rows);
    }
    expect(joined).toEqual(arrays);
    const content = manifest.parts.find((p) => p.array === 'masa.content');
    if (content === undefined) throw new Error('no masa.content part');
    const [first] = (await readJson<DatasetPart>(join(outDir, content.file))).rows as { versions: unknown[] }[];
    expect(first?.versions).toEqual(dataset.masa.content[0]?.versions);
  });

  it('writes byte-identical files for the same dataset', async () => {
    const again = await freshDir('again');
    expect(await writeDataset(again, dataset, config.chunkRows)).toEqual(manifest);
    const names = await listing(outDir);
    expect(await listing(again)).toEqual(names);
    for (const name of names) {
      expect((await readFile(join(again, name))).equals(await readFile(join(outDir, name))), name).toBe(true);
    }
  });

  it('removes stale part files and keeps every other file', async () => {
    const dir = await freshDir('stale');
    const small = truncated(3);
    const first = await writeDataset(dir, small, 1);
    await writeFile(join(dir, 'credentials.json'), '{}\n');
    await writeFile(join(dir, 'dataset-1.json'), '{}\n');
    const second = await writeDataset(dir, small, 2);
    expect(second.parts.length).toBeLessThan(first.parts.length);
    expect((await listing(dir)).filter((n) => PART_NAME.test(n))).toEqual(second.parts.map((p) => p.file));
    expect(await listing(dir)).toEqual(expect.arrayContaining(['credentials.json', 'dataset-1.json', 'dataset.json', 'manifest.json']));
  });

  it('creates the output directory recursively', async () => {
    const dir = join(await freshDir('nested'), 'a', 'b');
    await writeDataset(dir, truncated(1), 1000);
    expect(await listing(dir)).toContain('manifest.json');
  });

  it('removes the previous manifest first and writes the new one last', async () => {
    onTestFinished(() => {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    });
    const events: string[] = [];
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...fs,
        rm: async (path: string, opts: Parameters<typeof fs.rm>[1]) => {
          events.push(`rm ${basename(path)}`);
          return fs.rm(path, opts);
        },
        writeFile: async (path: string, data: string) => {
          events.push(`write ${basename(path)}`);
          return fs.writeFile(path, data);
        },
      };
    });
    vi.resetModules();
    const { writeDataset: write } = await import('../src/writer.js');
    const dir = await freshDir('order');
    const small = truncated(2);
    const first = await write(dir, small, 1);
    events.length = 0;
    const written = await write(dir, small, 2);
    const firstWrite = events.findIndex((e) => e.startsWith('write '));
    expect(events.slice(0, firstWrite).sort()).toEqual(['rm manifest.json', ...first.parts.map((p) => `rm ${p.file}`)].sort());
    expect(events[0]).toBe('rm manifest.json');
    expect(events.slice(firstWrite)).toEqual([
      'write dataset.json',
      ...written.parts.map((p) => `write ${p.file}`),
      'write manifest.json',
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects chunkRows %s before writing anything', async (chunkRows) => {
    const dir = join(root, `never-${String(chunkRows)}`);
    await expect(writeDataset(dir, dataset, chunkRows)).rejects.toThrow(new RangeError(`chunkRows must be a positive integer, got ${chunkRows}`));
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects more than 9999 parts before writing anything', async () => {
    const dir = join(root, 'too-many');
    await expect(writeDataset(dir, dataset, 2)).rejects.toThrow(RangeError);
    await expect(writeDataset(dir, dataset, 2)).rejects.toThrow(/parts exceed 9999; raise chunkRows above 2$/);
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('readDataset', () => {
  it('returns a dataset equal to the one written', async () => {
    const back = await readDataset(outDir);
    expect(back).toEqual(dataset);
    expect(JSON.stringify(back)).toBe(JSON.stringify(dataset));
  });

  it('throws naming both digests when one row was edited', async () => {
    const dir = await freshDir('tampered');
    const small = truncated(5);
    await writeDataset(dir, small, 1000);
    const file = join(dir, 'dataset.json');
    const edited = await readJson<Dataset>(file);
    const user = edited.masa.users[0];
    if (user === undefined) throw new Error('dataset has no users');
    user.fname = `${user.fname}x`;
    await writeFile(file, `${JSON.stringify(edited)}\n`);
    const computed = datasetDigest(edited);
    await expect(readDataset(dir)).rejects.toThrow(
      new Error(`dataset digest mismatch in ${file}: recorded ${small.digest}, computed ${computed}`),
    );
  });
});
