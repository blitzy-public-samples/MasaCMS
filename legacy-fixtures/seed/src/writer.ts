// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { datasetDigest, type Dataset } from './dataset.js';
import { parseJson, printable } from './errors.js';
import type { FixtureTables } from './fixture-tables.js';
import type { MasaData } from './masa.js';

/** One part file holding rows `offset` to `offset + count - 1` of `array` (`masa.<name>` or `fixtures.<schema>.<table>`). */
export interface ManifestPart {
  file: string;
  array: string;
  offset: number;
  count: number;
}

/** Index of a written dataset directory: row count of every array and every part file in write order. */
export interface Manifest {
  sourceSha: string;
  seed: number;
  businessDate: string;
  digest: string;
  counts: Record<string, number>;
  parts: ManifestPart[];
}

/** Content of one `dataset-NNNN.json` part file. */
export interface DatasetPart {
  sourceSha: string;
  digest: string;
  array: string;
  offset: number;
  rows: unknown[];
}

const DATASET_FILE = 'dataset.json';
const MANIFEST_FILE = 'manifest.json';
const PART_FILE = /^dataset-\d{4}\.json$/;
const MAX_PARTS = 9999;
const DIGEST = /^[0-9a-f]{64}$/;

// Mapped type: the compiler rejects a missing or extra MasaData key; literal order is MasaData order.
const MASA_ORDER: { readonly [K in keyof MasaData]: null } = {
  sites: null,
  groups: null,
  users: null,
  memberships: null,
  categories: null,
  content: null,
  files: null,
  oauthClients: null,
};
const MASA_ARRAYS = Object.keys(MASA_ORDER) as (keyof MasaData)[];

type NamedArray = readonly [name: string, rows: readonly unknown[]];

/** Every dataset array as `[name, rows]`: Masa arrays in `MasaData` order, then fixture tables in dataset order. */
function namedArrays(masa: MasaData, fixtures: FixtureTables): NamedArray[] {
  return [
    ...MASA_ARRAYS.map((name): NamedArray => [`masa.${name}`, masa[name]]),
    ...Object.entries(fixtures).map(([key, rows]): NamedArray => [`fixtures.${key}`, rows]),
  ];
}

function partFileName(n: number): string {
  return `dataset-${String(n).padStart(4, '0')}.json`;
}

function compactJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Writes `dataset.json`, one part file per `chunkRows` rows of each non-empty array, then `manifest.json`; returns the manifest. */
export async function writeDataset(outDir: string, dataset: Dataset, chunkRows: number): Promise<Manifest> {
  if (!Number.isInteger(chunkRows) || chunkRows < 1) throw printable(new RangeError(`chunkRows must be a positive integer, got ${chunkRows}`));
  const { sourceSha, seed, businessDate, digest } = dataset;
  const counts: Record<string, number> = {};
  const parts: ManifestPart[] = [];
  const bodies: (readonly [file: string, body: DatasetPart])[] = [];
  for (const [array, rows] of namedArrays(dataset.masa, dataset.fixtures)) {
    counts[array] = rows.length;
    for (let offset = 0; offset < rows.length; offset += chunkRows) {
      const slice = rows.slice(offset, offset + chunkRows);
      const file = partFileName(parts.length + 1);
      parts.push({ file, array, offset, count: slice.length });
      bodies.push([file, { sourceSha, digest, array, offset, rows: slice }]);
    }
  }
  if (parts.length > MAX_PARTS) throw printable(new RangeError(`${parts.length} parts exceed ${MAX_PARTS}; raise chunkRows above ${chunkRows}`));

  await mkdir(outDir, { recursive: true });
  // Drop the previous manifest first so no reader pairs it with parts being rewritten.
  await rm(join(outDir, MANIFEST_FILE), { force: true });
  for (const name of await readdir(outDir)) {
    if (PART_FILE.test(name)) await rm(join(outDir, name), { force: true });
  }
  await writeFile(join(outDir, DATASET_FILE), compactJson(dataset));
  for (const [file, body] of bodies) await writeFile(join(outDir, file), compactJson(body));
  const manifest: Manifest = { sourceSha, seed, businessDate, digest, counts, parts };
  await writeFile(join(outDir, MANIFEST_FILE), compactJson(manifest));
  return manifest;
}

/** Reads `dataset.json` from `outDir`; throws naming the file, never its content, when it is not JSON, not a dataset or not its recorded digest. */
export async function readDataset(outDir: string): Promise<Dataset> {
  const file = join(outDir, DATASET_FILE);
  const dataset = parseJson(await readFile(file, 'utf8'), file) as Dataset;
  let computed: string;
  try {
    computed = datasetDigest(dataset);
  } catch {
    throw printable(new TypeError(`${file} does not hold a dataset`));
  }
  if (computed !== dataset.digest) {
    const recorded = typeof dataset.digest === 'string' && DIGEST.test(dataset.digest) ? dataset.digest : 'a value that is not a digest';
    throw printable(new Error(`dataset digest mismatch in ${file}: recorded ${recorded}, computed ${computed}`));
  }
  return dataset;
}
