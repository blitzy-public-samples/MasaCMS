// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRow, type ApplyRequest, type ApplyResponse, type CanonicalValue } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig, type SeedConfig } from '../src/config.js';
import type { Dataset } from '../src/dataset.js';
import { directServices, planDirectBatches, runDirect, type DirectClient, type DirectResult } from '../src/direct.js';
import { fixtureKeys, specForKey, type FixtureRow, type FixtureTables } from '../src/fixture-tables.js';
import { run } from '../src/generate.js';
import { stableId } from '../src/ids.js';
import { readDataset, writeDataset } from '../src/writer.js';
import { ARCHIVE_KEY, archiveRows, withArchives } from './helpers/archives.js';

type DirectRequest = Parameters<DirectClient['request']>[0];
type DecodedRow = Record<string, CanonicalValue>;
type Answer = { status: number; headers?: Record<string, string>; body?: unknown } | Error | undefined;

interface Sent {
  request: DirectRequest;
  body: ApplyRequest;
  rows: DecodedRow[];
}

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = path.resolve(PKG_ROOT, '../..');
const CONFIG_PATH = path.join(PKG_ROOT, 'seed.config.json');
const PINNED_SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const APPLY_PATH = '/internal/v1/migration/apply';
const SERVICES = ['people'];
const quiet = (): void => undefined;

let base: string;
let out: string;
let pinPath: string;
let env: NodeJS.ProcessEnv;
let seeded: Dataset;
let dataset: Dataset;
let config: SeedConfig;
let keys: string[];
let code: number;
let log: string[];
let sent: Sent[];

/** Stub client recording every request; answers 200 with an `ApplyResponse` unless `answer` gives a status, body or error. */
function recordingClient(answer?: (req: DirectRequest, index: number) => Answer): { client: DirectClient; requests: DirectRequest[] } {
  const requests: DirectRequest[] = [];
  const client: DirectClient = {
    request<T>(req: DirectRequest) {
      const index = requests.push(req) - 1;
      const given = answer?.(req, index);
      if (given instanceof Error) return Promise.reject(given);
      const body = req.json as ApplyRequest;
      const applied: ApplyResponse = { batchId: body.batchId, duplicate: false, applied: body.rows.length, skipped: 0 };
      return Promise.resolve({ status: given?.status ?? 200, headers: given?.headers ?? {}, body: (given === undefined ? applied : given.body) as T });
    },
  };
  return { client, requests };
}

/** `run --direct` arguments reading the dataset from `dir`. */
function directArgs(dir: string): string[] {
  return ['--direct', '--config', CONFIG_PATH, '--out', dir, '--pin', pinPath];
}

/** A request with its apply body and its rows decoded over the body's columns. */
function decoded(request: DirectRequest): Sent {
  const body = request.json as ApplyRequest;
  return { request, body, rows: body.rows.map(({ row }) => decodeRow(body.columns, row)) };
}

/** Collects stderr writes until the test ends. */
function captureStderr(): () => string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  onTestFinished(() => spy.mockRestore());
  return () => chunks.join('');
}

function rowsOf(key: string): FixtureRow[] {
  const rows = dataset.fixtures[key];
  if (rows === undefined) throw new Error(`dataset has no ${key}`);
  return rows;
}

function firstRow(key: string): FixtureRow {
  const [row] = rowsOf(key);
  if (row === undefined) throw new Error(`dataset ${key} is empty`);
  return row;
}

/** Every configured fixture table empty except those in `tables`. */
function only(tables: FixtureTables): FixtureTables {
  return { ...Object.fromEntries(keys.map((key): [string, FixtureRow[]] => [key, []])), ...tables };
}

/** Site of a `key` row, read from its spec's site column. */
function siteOf(key: string, row: Readonly<Record<string, unknown>>): string {
  return String(row[specForKey(key).siteColumn]);
}

/** A decoded row in dataset form: bytes as hex, every other value as its text. */
function datasetForm(row: DecodedRow, columns: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(
    columns.map((name) => {
      const value = row[name] ?? null;
      return [name, Buffer.isBuffer(value) ? value.toString('hex') : value];
    }),
  );
}

/** `[service, legacyTable, batchId, row count]` of a request. */
function signature(req: DirectRequest): [string, string, string, number] {
  const body = req.json as ApplyRequest;
  return [req.service, body.legacyTable, body.batchId, body.rows.length];
}

/** Rows sent per owning service, in order of first appearance. */
function rowsByService(): Map<string, number> {
  const totals = new Map<string, number>();
  for (const { request, rows } of sent) totals.set(request.service, (totals.get(request.service) ?? 0) + rows.length);
  return totals;
}

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-seed-test-'));
  out = path.join(base, 'out');
  pinPath = path.join(base, 'source-pin.json');
  await fs.writeFile(pinPath, JSON.stringify({ sha: PINNED_SHA }));
  env = { ...process.env, OPT2_STATE_DIR: path.join(base, 'state'), HOME: base };
  expect(await run(['--config', CONFIG_PATH, '--out', path.join(base, 'seeded'), '--pin', pinPath], env, { log: quiet })).toBe(0);
  seeded = await readDataset(path.join(base, 'seeded'));
  config = await loadConfig(CONFIG_PATH);
  // The seed leaves the archive empty; tenant-b's one batch precedes tenant-a's two.
  dataset = withArchives(seeded, archiveRows(seeded, [['tenant-b', 50], ['tenant-a', 1500]]));
  await writeDataset(out, dataset, config.chunkRows);
  keys = fixtureKeys();
  const { client, requests } = recordingClient();
  log = [];
  code = await run(directArgs(out), env, { client, log: (line) => void log.push(line) });
  sent = requests.map(decoded);
}, 600_000);

afterAll(async () => {
  if (base !== undefined) await fs.rm(base, { recursive: true, force: true });
});

describe('batching', () => {
  it('applies the dataset through the injected client and logs the totals', () => {
    expect(code).toBe(0);
    expect(sent.length).toBeGreaterThan(0);
    const totals = [...rowsByService()].map(([service, rows]) => `${service}=${rows}`).join(' ');
    const rows = sent.reduce((sum, { rows: batch }) => sum + batch.length, 0);
    expect(log.at(-1)).toBe(`seed direct digest=${dataset.digest} batches=${sent.length} rows=${rows} ${totals}`);
  });

  it("posts every batch as a backfill to its owner's migration apply endpoint", () => {
    for (const { request, body } of sent) {
      expect([request.method, request.path, request.userToken, body.origin]).toEqual(['POST', APPLY_PATH, null, 'backfill']);
      expect(SERVICES).toContain(request.service);
      expect(request.service).toBe(specForKey(body.legacyTable).service);
    }
  });

  it('chunks each table and tenant into full batches of chunkRows rows and one remainder', () => {
    expect(config.chunkRows).toBe(1000);
    const groups = new Map<string, number[]>();
    for (const { body } of sent) {
      expect(body.rows.length).toBeGreaterThanOrEqual(1);
      expect(body.rows.length).toBeLessThanOrEqual(config.chunkRows);
      const group = `${body.legacyTable} ${String(body.tenantId)}`;
      groups.set(group, [...(groups.get(group) ?? []), body.rows.length]);
    }
    for (const sizes of groups.values()) expect(sizes.slice(0, -1).every((size) => size === config.chunkRows)).toBe(true);
    expect([...groups.values()].some((sizes) => sizes.length > 1)).toBe(true);
  });

  it("sends each batch under the tenant of its rows' one site", () => {
    for (const { body, rows } of sent) {
      const sites = new Set(rows.map((row) => siteOf(body.legacyTable, row)));
      const [site = ''] = sites;
      expect(sites.size).toBe(1);
      expect(body.tenantId).toBe(tenantIdForSite(site));
    }
  });

  it('sends every row of each non-empty table once, unchanged, and nothing for empty tables', () => {
    const sentRows = new Map<string, DecodedRow[]>();
    for (const { body, rows } of sent) sentRows.set(body.legacyTable, [...(sentRows.get(body.legacyTable) ?? []), ...rows]);
    const nonEmpty = keys.filter((key) => rowsOf(key).length > 0);
    expect([...sentRows.keys()]).toEqual(nonEmpty);
    expect(planDirectBatches(seeded, config)).toEqual([]);
    for (const key of nonEmpty) {
      const pk = specForKey(key).key;
      const expected = rowsOf(key);
      const byKey = new Map((sentRows.get(key) ?? []).map((row): [string, DecodedRow] => [String(row[pk]), row]));
      expect([sentRows.get(key)?.length, byKey.size]).toEqual([expected.length, expected.length]);
      const columns = Object.keys(expected[0] ?? {});
      const actual = expected.map((row) => {
        const match = byKey.get(String(row[pk]));
        return match === undefined ? undefined : datasetForm(match, columns);
      });
      const wanted = expected.map((row) => Object.fromEntries(columns.map((name) => [name, row[name] === null ? null : String(row[name])])));
      expect(actual, key).toEqual(wanted);
    }
  });

});

interface OwnerAnswer {
  batchId: string;
  duplicate: boolean;
  /** False only for a known batch id sent with rows other than those it first applied. */
  sameRows: boolean;
}

/** Stub owner recording applied batch ids per tenant and applied keys per table; answers a known id as a duplicate like the migration-kit apply, and 503 unapplied to each request index `fails` selects. */
function owningClient(fails: (index: number) => boolean): { client: DirectClient; applied: Map<string, Set<string>>; answers: OwnerAnswer[] } {
  const batches = new Map<string, string>();
  const applied = new Map<string, Set<string>>();
  const answers: OwnerAnswer[] = [];
  let index = 0;
  const client: DirectClient = {
    request<T>(req: DirectRequest) {
      if (fails(index++)) return Promise.resolve({ status: 503, headers: {}, body: { error: { code: 'unavailable', message: 'stub outage' } } as T });
      const { body, rows } = decoded(req);
      const pk = specForKey(body.legacyTable).key;
      const rowKeys = rows.map((row) => String(row[pk]));
      const id = `${String(body.tenantId)}\u0000${body.batchId}`;
      const known = batches.get(id);
      const duplicate = known !== undefined;
      answers.push({ batchId: body.batchId, duplicate, sameRows: !duplicate || known === rowKeys.join('\u0000') });
      if (!duplicate) {
        batches.set(id, rowKeys.join('\u0000'));
        const tableKeys = applied.get(body.legacyTable) ?? new Set<string>();
        for (const key of rowKeys) tableKeys.add(key);
        applied.set(body.legacyTable, tableKeys);
      }
      const answer: ApplyResponse = { batchId: body.batchId, duplicate, applied: duplicate ? 0 : rows.length, skipped: 0 };
      return Promise.resolve({ status: 200, headers: {}, body: answer as T });
    },
  };
  return { client, applied, answers };
}

describe('batch ids', () => {
  it('derives a unique batch id from the digest, table, site and row range', () => {
    const offsets = new Map<string, number>();
    const ids = sent.map(({ body, rows }) => {
      const site = siteOf(body.legacyTable, rows[0] ?? {});
      const group = `${body.legacyTable}\u0000${site}`;
      const start = offsets.get(group) ?? 0;
      offsets.set(group, start + rows.length);
      expect(body.batchId).toBe(stableId(dataset.digest, body.legacyTable, site, start, rows.length));
      return body.batchId;
    });
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resumes a partial run under a larger chunkRows without skipping rows, and repeats it as duplicates', async () => {
    const failAt = sent.findIndex(({ body }, i) => body.legacyTable === sent[i - 1]?.body.legacyTable && body.tenantId === sent[i - 1]?.body.tenantId);
    expect(failAt).toBeGreaterThan(0);
    const owner = owningClient((index) => index === failAt);
    await expect(runDirect(dataset, { client: owner.client, config, log: quiet })).rejects.toThrow(/ chunk=1 batch=\S+ answered 503 /);
    expect(owner.answers).toHaveLength(failAt);

    const resumed: SeedConfig = { ...config, chunkRows: 2 * config.chunkRows };
    await runDirect(dataset, { client: owner.client, config: resumed, log: quiet });
    const resumedAnswers = owner.answers.slice(failAt);
    const replays = resumedAnswers.filter(({ duplicate }) => duplicate);
    expect(replays.length).toBeGreaterThan(0);
    expect(replays.filter(({ sameRows }) => !sameRows)).toEqual([]);

    const nonEmpty = keys.filter((key) => rowsOf(key).length > 0);
    expect([...owner.applied.keys()].sort()).toEqual([...nonEmpty].sort());
    for (const key of nonEmpty) {
      const pk = specForKey(key).key;
      const applied = owner.applied.get(key) ?? new Set<string>();
      const missing = rowsOf(key)
        .map((row) => String(row[pk]))
        .filter((id) => !applied.has(id));
      expect({ missing: missing.slice(0, 3), applied: applied.size }, key).toEqual({ missing: [], applied: rowsOf(key).length });
    }

    await runDirect(dataset, { client: owner.client, config: resumed, log: quiet });
    const repeated = owner.answers.slice(failAt + resumedAnswers.length);
    expect(repeated.map(({ batchId }) => batchId)).toEqual(resumedAnswers.map(({ batchId }) => batchId));
    expect(repeated.filter(({ duplicate, sameRows }) => !duplicate || !sameRows)).toEqual([]);
  });

  it('repeats the same batches on a second run', async () => {
    const { client, requests } = recordingClient();
    expect(await run(directArgs(out), env, { client, log: quiet })).toBe(0);
    expect(requests.map(signature)).toEqual(sent.map(({ request }) => signature(request)));
  });

  it('plans the batches it sends, and runDirect sends them alike', async () => {
    const planned = planDirectBatches(dataset, config);
    expect(planned.map(({ batchId }) => batchId)).toEqual(sent.map(({ body }) => body.batchId));
    expect(planned.map((batch) => [batch.service, batch.legacyTable, batch.tenantId, batch.rows.length])).toEqual(
      sent.map(({ request, body }) => [request.service, body.legacyTable, body.tenantId, body.rows.length]),
    );

    const { client, requests } = recordingClient();
    const lines: string[] = [];
    const result: DirectResult = await runDirect(dataset, { client, config, log: (line) => void lines.push(line) });
    expect(JSON.stringify(requests) === JSON.stringify(sent.map(({ request }) => request))).toBe(true);
    const rows = sent.reduce((sum, { rows: batch }) => sum + batch.length, 0);
    expect(result).toEqual({ batches: sent.length, rows, byService: Object.fromEntries(rowsByService()) });

    const perTable = new Map<string, { service: string; rows: number; batches: number }>();
    for (const { request, body } of sent) {
      const table = perTable.get(body.legacyTable) ?? { service: request.service, rows: 0, batches: 0 };
      perTable.set(body.legacyTable, { ...table, rows: table.rows + body.rows.length, batches: table.batches + 1 });
    }
    const tableLines = [...perTable].map(([key, table]) => `direct ${table.service} ${key} rows=${table.rows} batches=${table.batches}`);
    expect(lines).toEqual(tableLines);
    expect(log.slice(0, -1)).toEqual(tableLines);
  });
});

describe('owners', () => {
  it('lists the owner of each non-empty table once, in plan order', () => {
    // synthetic.person_archive is left to the archive flow, so the seeded dataset gives people nothing to apply.
    expect(directServices(seeded)).toEqual([]);
    expect(directServices(dataset)).toEqual(SERVICES);
    expect(directServices(dataset)).toEqual([...new Set(planDirectBatches(dataset, config).map(({ service }) => service))]);
    expect(directServices({ ...dataset, fixtures: only({ [ARCHIVE_KEY]: [{ archive_id: stableId('owners', 1) }] }) })).toEqual(SERVICES);
    expect(directServices({ ...dataset, fixtures: only({}) })).toEqual([]);
  });
});

describe('failures', () => {
  it('re-sends once a batch its owner committed with its events left to the sweep, then seeds the rest', async () => {
    const pending = { status: 503, headers: { 'x-opt2-unpublished-events': '1' }, body: { error: { code: 'server_error', message: 'Unhandled Exception' } } };
    const { client, requests } = recordingClient((_req, index) => (index === 0 ? pending : undefined));
    expect(await run(directArgs(out), env, { client, log: quiet })).toBe(0);
    expect(requests).toHaveLength(sent.length + 1);
    expect(requests[1]?.json).toBe(requests[0]?.json);
    expect(JSON.stringify(requests.slice(1)) === JSON.stringify(sent.map(({ request }) => request))).toBe(true);
  });

  it('exits 1 when an owner answers 500', async () => {
    const stderr = captureStderr();
    const { client, requests } = recordingClient((_req, index) =>
      index === 0 ? { status: 500, body: { error: { code: 'server_error', message: 'stub failure' } } } : undefined,
    );
    expect(await run(directArgs(out), env, { client, log: quiet })).toBe(1);
    expect(requests).toHaveLength(1);
    expect(stderr()).toMatch(/^seed: direct: \S+ \S+ site=\S+ chunk=0 batch=\S+ answered 500 \(server_error\)\n$/);
    expect(stderr()).not.toContain('stub failure');
  });

  it('exits 1 when --out holds no dataset', async () => {
    const stderr = captureStderr();
    const empty = await fs.mkdtemp(path.join(base, 'empty-'));
    const { client, requests } = recordingClient();
    expect(await run(directArgs(empty), env, { client, log: quiet })).toBe(1);
    expect(requests).toHaveLength(0);
    expect(stderr()).toMatch(/dataset\.json/);
  });

  it('exits 2 on an unknown option', async () => {
    captureStderr();
    const { client, requests } = recordingClient();
    expect(await run(['--direct', '--nope'], env, { client })).toBe(2);
    expect(requests).toHaveLength(0);
  });

  it('refuses --out inside the checkout', async () => {
    const stderr = captureStderr();
    const inside = path.join(REPO_ROOT, 'opt2-seed-direct-out');
    const { client, requests } = recordingClient();
    expect(await run(directArgs(inside), env, { client, log: quiet })).not.toBe(0);
    expect(requests).toHaveLength(0);
    expect(stderr()).toContain(`${inside} is inside the checkout ${REPO_ROOT}`);
    await expect(fs.access(inside)).rejects.toThrow();
  });

  it.each<[string, () => FixtureTables, RegExp]>([
    [
      'a dataset missing a configured table',
      () => Object.fromEntries(Object.entries(dataset.fixtures).filter(([key]) => key !== ARCHIVE_KEY)),
      /fixture tables differ from the configuration \(missing synthetic\.person_archive; extra -\)/,
    ],
    [
      'a row with a column outside its DDL',
      () => only({ [ARCHIVE_KEY]: [{ ...firstRow(ARCHIVE_KEY), bogus: 'x' }] }),
      /synthetic\.person_archive row archive_id=\S+ does not match its DDL columns \(missing -; extra bogus\)/,
    ],
    [
      'a row whose key and extra column are not identifiers',
      () => only({ [ARCHIVE_KEY]: [{ ...firstRow(ARCHIVE_KEY), archive_id: 'Zelda Sentinel', 'zelda.sentinel@example.com': 'x' }] }),
      /^direct: synthetic\.person_archive row archive_id=<string> does not match its DDL columns \(missing -; extra <name>\)$/,
    ],
    [
      'a dataset table key that is not an identifier',
      () => ({ ...dataset.fixtures, 'zelda.sentinel@example.com': [] }),
      /^direct: dataset fixture tables differ from the configuration \(missing -; extra <name>\)$/,
    ],
    [
      'a row without a site',
      () => only({ [ARCHIVE_KEY]: [{ ...firstRow(ARCHIVE_KEY), siteID: '' }] }),
      /^direct: synthetic\.person_archive row archive_id="[0-9A-F-]{35}" has no resolvable site \(column siteID\)$/,
    ],
    [
      'a value its column type rejects',
      () => only({ [ARCHIVE_KEY]: [{ ...firstRow(ARCHIVE_KEY), effective_from: 'abc' }] }),
      /synthetic\.person_archive row archive_id=\S+ does not encode/,
    ],
  ])('runDirect rejects %s before sending', async (_label, fixtures, message) => {
    const { client, requests } = recordingClient();
    await expect(runDirect({ ...dataset, fixtures: fixtures() }, { client, config, log: quiet })).rejects.toThrow(message);
    expect(requests).toHaveLength(0);
  });

  it.each<[string, Answer, RegExp, string]>([
    ['the client rejects', new Error('socket hang up'), / failed: Error$/, 'socket hang up'],
    [
      'the owner is unreachable',
      new ServiceUnavailableError('people', Object.assign(new Error('connect refused by zelda.sentinel'), { code: 'ECONNREFUSED' })),
      / failed: Service people unavailable \(ECONNREFUSED\)$/,
      'zelda',
    ],
    ['an owner answers a legacy error envelope', { status: 503, body: { error: { code: 'unavailable', message: 'gate closed' } } }, / answered 503 \(unavailable\)$/, 'gate closed'],
    ['an envelope code is free text', { status: 500, body: { error: { code: 'row zelda.sentinel@example.com', message: 'x' } } }, / answered 500$/, 'zelda'],
    ['an owner answers without an envelope', { status: 409, body: 'conflict' }, / answered 409$/, 'conflict'],
  ])('runDirect stops at the first batch when %s, never quoting the answer', async (_label, answer, message, hidden) => {
    const { client, requests } = recordingClient(() => answer);
    const pending = runDirect({ ...dataset, fixtures: only({ [ARCHIVE_KEY]: rowsOf(ARCHIVE_KEY) }) }, { client, config, log: quiet });
    await expect(pending).rejects.toThrow(/^direct: people synthetic\.person_archive site=\S+ chunk=0 batch=\S+/);
    await expect(pending).rejects.toThrow(message);
    await expect(pending).rejects.not.toThrow(hidden);
    expect(requests).toHaveLength(1);
  });
});

