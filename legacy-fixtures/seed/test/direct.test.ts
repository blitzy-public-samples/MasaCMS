// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { createHash } from 'node:crypto';
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
import { readDataset } from '../src/writer.js';

type DirectRequest = Parameters<DirectClient['request']>[0];
type DecodedRow = Record<string, CanonicalValue>;
type Answer = { status: number; body?: unknown } | Error | undefined;

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
const SERVICES = ['people', 'timesheets', 'finance', 'surveys', 'reporting', 'communications', 'e-signature'];
const BARE_PROGRAM_TABLES = ['timesheet', 'timesheet_day', 'approval_action', 'finance_record', 'finance_record_version', 'finance_attachment'];
const AUDIT_KEY = 'synthetic.audit_entry';
const AUDIT_COLUMNS = ['entry_id', 'request_id', 'seq', 'action', 'actor_user_id', 'detail', 'at', 'prev_hash', 'entry_hash'];
const GENESIS_HASH = '0'.repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;
const quiet = (): void => undefined;

/** Consecutive `[parent, child]` pairs of `keys`. */
function chain(...keys: string[]): [string, string][] {
  return keys.slice(1).map((child, i): [string, string] => [String(keys[i]), child]);
}

const PARENT_PAIRS: readonly [string, string][] = [
  ...[1, 2].flatMap((id) => [
    ...chain(`Program_${id}.timesheet`, `Program_${id}.timesheet_day`, `Program_${id}.approval_action`),
    ...chain(`Program_${id}.finance_record`, `Program_${id}.finance_record_version`, `Program_${id}.finance_attachment`),
  ]),
  ...['survey_schedule', 'survey_reminder', 'survey_target', 'survey_response'].map((child): [string, string] => ['synthetic.survey', `synthetic.${child}`]),
  ['synthetic.export_definition', 'synthetic.export_job'],
  ...chain('synthetic.message_template', 'synthetic.message', 'synthetic.delivery_status'),
  ...chain('synthetic.signature_request', 'synthetic.signature', AUDIT_KEY),
];

let base: string;
let out: string;
let pinPath: string;
let env: NodeJS.ProcessEnv;
let dataset: Dataset;
let config: SeedConfig;
let keys: string[];
let rowsByKey: Map<string, Map<string, FixtureRow>>;
let programSites: Map<number, string>;
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
      return Promise.resolve({ status: given?.status ?? 200, headers: {}, body: (given === undefined ? applied : given.body) as T });
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

/** Site of a `key` row by its spec's site rule, following parent rows of the dataset. */
function siteOf(key: string, row: Readonly<Record<string, unknown>>): string {
  const { spec, programId } = specForKey(key);
  const rule = spec.site;
  if (rule.kind === 'column') return String(row[rule.column]);
  if (rule.kind === 'program') return String(programSites.get(programId ?? -1));
  const parentKey = keys.find((candidate) => {
    const parent = specForKey(candidate);
    return parent.spec.table === rule.table && (parent.programId === null || parent.programId === programId);
  });
  const parentRow = parentKey === undefined ? undefined : rowsByKey.get(parentKey)?.get(String(row[rule.foreignKey]));
  if (parentKey === undefined || parentRow === undefined) throw new Error(`${key} row has no ${rule.table} parent`);
  return siteOf(parentKey, parentRow);
}

/** Lowercase hex of a decoded binary value. */
function hexOf(value: CanonicalValue | undefined): string {
  if (!Buffer.isBuffer(value)) throw new TypeError(`expected bytes, got ${JSON.stringify(value)}`);
  return value.toString('hex');
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

/** Asserts each request's audit entries form the `usp_audit_append` hash chain. */
function expectChained(entries: readonly DecodedRow[]): void {
  const byRequest = new Map<string, DecodedRow[]>();
  for (const entry of entries) {
    expect(Object.keys(entry)).toEqual(AUDIT_COLUMNS);
    const requestId = String(entry.request_id);
    byRequest.set(requestId, [...(byRequest.get(requestId) ?? []), entry]);
  }
  for (const chained of byRequest.values()) {
    let previous = GENESIS_HASH;
    chained
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .forEach((entry, i) => {
        const prevHash = hexOf(entry.prev_hash);
        const entryHash = hexOf(entry.entry_hash);
        expect(Number(entry.seq)).toBe(i + 1);
        expect([prevHash, entryHash]).toEqual([previous, expect.stringMatching(HEX64)]);
        const canonical = [entry.request_id, entry.seq, entry.action, entry.actor_user_id ?? '', entry.detail ?? '', entry.at].map(String).join('|');
        const expected = createHash('sha256').update(Buffer.concat([Buffer.from(prevHash, 'hex'), Buffer.from(canonical, 'utf16le')])).digest('hex');
        expect(entryHash).toBe(expected);
        previous = entryHash;
      });
  }
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
  expect(await run(['--config', CONFIG_PATH, '--out', out, '--pin', pinPath], env, { log: quiet })).toBe(0);
  dataset = await readDataset(out);
  config = await loadConfig(CONFIG_PATH);
  keys = fixtureKeys(config);
  rowsByKey = new Map(
    keys.map((key): [string, Map<string, FixtureRow>] => {
      const pk = specForKey(key).spec.key;
      return [key, new Map(rowsOf(key).map((row): [string, FixtureRow] => [String(row[pk]), row]))];
    }),
  );
  programSites = new Map(Object.values(config.sites).flatMap((site): [number, string][] => (site.programId === null ? [] : [[site.programId, site.siteID]])));
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
      expect(request.service).toBe(specForKey(body.legacyTable).spec.service);
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

  it('keeps the Program_<id> schema in program table names', () => {
    for (const { body } of sent) {
      expect(body.legacyTable).toMatch(specForKey(body.legacyTable).spec.scope === 'program' ? /^Program_[12]\.[a-z_]+$/ : /^synthetic\.[a-z_]+$/);
      expect(BARE_PROGRAM_TABLES).not.toContain(body.legacyTable);
    }
    expect(['Program_1.', 'Program_2.'].every((schema) => sent.some(({ body }) => body.legacyTable.startsWith(schema)))).toBe(true);
  });

  it('sends every row of each non-empty table once, unchanged, and nothing for empty tables', () => {
    const sentRows = new Map<string, DecodedRow[]>();
    for (const { body, rows } of sent) sentRows.set(body.legacyTable, [...(sentRows.get(body.legacyTable) ?? []), ...rows]);
    const nonEmpty = keys.filter((key) => rowsOf(key).length > 0);
    expect([...sentRows.keys()]).toEqual(nonEmpty);
    for (const key of ['synthetic.person_archive', 'Program_1.blackout', 'Program_2.blackout']) expect(sentRows.has(key)).toBe(false);
    for (const key of nonEmpty) {
      const pk = specForKey(key).spec.key;
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

  it('sends parent tables before their children', () => {
    const order = sent.map(({ body }) => body.legacyTable);
    for (const [parent, child] of PARENT_PAIRS) {
      expect([order.includes(parent), order.includes(child)], `${parent} and ${child} sent`).toEqual([true, true]);
      expect(order.lastIndexOf(parent), `${parent} before ${child}`).toBeLessThan(order.indexOf(child));
    }
  });
});

describe('batch ids', () => {
  it('derives a unique batch id from the digest, table, site and chunk index', () => {
    const chunks = new Map<string, number>();
    const ids = sent.map(({ body, rows }) => {
      const site = siteOf(body.legacyTable, rows[0] ?? {});
      const group = `${body.legacyTable}\u0000${site}`;
      const chunkIndex = chunks.get(group) ?? 0;
      chunks.set(group, chunkIndex + 1);
      expect(body.batchId).toBe(stableId(dataset.digest, body.legacyTable, site, chunkIndex));
      return body.batchId;
    });
    expect(new Set(ids).size).toBe(ids.length);
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
    expect(directServices(dataset, config)).toEqual(SERVICES.filter((service) => service !== 'people'));
    expect(directServices(dataset, config)).toEqual([...new Set(planDirectBatches(dataset, config).map(({ service }) => service))]);
    const archived = { ...dataset.fixtures, 'synthetic.person_archive': [{ archive_id: stableId('owners', 1) }] };
    expect(directServices({ ...dataset, fixtures: archived }, config)).toEqual(SERVICES);
    const fixtures = only({
      [AUDIT_KEY]: rowsOf(AUDIT_KEY),
      'Program_2.finance_record_version': rowsOf('Program_2.finance_record_version'),
      'Program_1.timesheet_day': rowsOf('Program_1.timesheet_day'),
      'Program_2.timesheet_day': rowsOf('Program_2.timesheet_day'),
    });
    expect(directServices({ ...dataset, fixtures }, config)).toEqual(['timesheets', 'finance', 'e-signature']);
    expect(directServices({ ...dataset, fixtures: only({}) }, config)).toEqual([]);
  });
});

describe('audit chain', () => {
  it("chains each request's audit entries as usp_audit_append does", () => {
    const entries = sent.filter(({ body }) => body.legacyTable === AUDIT_KEY).flatMap(({ rows }) => rows);
    expect(entries.length).toBe(rowsOf(AUDIT_KEY).length);
    expect(entries.length).toBeGreaterThan(0);
    expectChained(entries);
  });

  it('hashes a NULL actor and detail as empty text', async () => {
    const request = firstRow('synthetic.signature_request');
    const template = firstRow(AUDIT_KEY);
    const audit = [1, 2].map((n) => ({ ...template, entry_id: stableId('null-audit', n), request_id: request.request_id ?? null, actor_user_id: null, detail: null }));
    const { client, requests } = recordingClient();
    await runDirect({ ...dataset, fixtures: only({ 'synthetic.signature_request': [request], [AUDIT_KEY]: audit }) }, { client, config, log: quiet });
    const entries = requests.map(decoded).filter(({ body }) => body.legacyTable === AUDIT_KEY).flatMap(({ rows }) => rows);
    expect(entries.map(({ seq, actor_user_id, detail }) => [seq, actor_user_id, detail])).toEqual([
      ['1', null, null],
      ['2', null, null],
    ]);
    expectChained(entries);
  });
});

describe('failures', () => {
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
      () => Object.fromEntries(Object.entries(dataset.fixtures).filter(([key]) => key !== 'synthetic.survey')),
      /fixture tables differ from the configuration \(missing synthetic\.survey; extra -\)/,
    ],
    [
      'a row with a column outside its DDL',
      () => only({ 'synthetic.message_template': [{ ...firstRow('synthetic.message_template'), bogus: 'x' }] }),
      /synthetic\.message_template row template_id=\S+ does not match its DDL columns \(missing -; extra bogus\)/,
    ],
    [
      'a row whose key and extra column are not identifiers',
      () => only({ 'synthetic.message_template': [{ ...firstRow('synthetic.message_template'), template_id: 'Zelda Sentinel', 'zelda.sentinel@example.com': 'x' }] }),
      /^direct: synthetic\.message_template row template_id=<string> does not match its DDL columns \(missing -; extra <name>\)$/,
    ],
    [
      'a dataset table key that is not an identifier',
      () => ({ ...dataset.fixtures, 'zelda.sentinel@example.com': [] }),
      /^direct: dataset fixture tables differ from the configuration \(missing -; extra <name>\)$/,
    ],
    [
      'a child row whose parent key is not an identifier',
      () => only({ 'synthetic.survey_schedule': [{ ...firstRow('synthetic.survey_schedule'), survey_id: 'zelda.sentinel@example.com' }] }),
      /^direct: synthetic\.survey_schedule row schedule_id="[0-9A-F-]{35}" has no resolvable site \(parent synthetic\.survey\.survey_id=<string>\)$/,
    ],
    [
      'a child row whose parent is absent',
      () => only({ 'synthetic.survey_schedule': [firstRow('synthetic.survey_schedule')] }),
      /synthetic\.survey_schedule row schedule_id=\S+ has no resolvable site \(parent synthetic\.survey\.survey_id=/,
    ],
    [
      'a value its column type rejects',
      () => only({ 'Program_1.finance_record': [{ ...firstRow('Program_1.finance_record'), amount: 'abc' }] }),
      /Program_1\.finance_record row record_id=\S+ does not encode/,
    ],
    [
      'an audit entry without a request id',
      () => only({ [AUDIT_KEY]: [{ ...firstRow(AUDIT_KEY), request_id: null }] }),
      /synthetic\.audit_entry row needs text request_id, got null/,
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
      new ServiceUnavailableError('communications', Object.assign(new Error('connect refused by zelda.sentinel'), { code: 'ECONNREFUSED' })),
      / failed: Service communications unavailable \(ECONNREFUSED\)$/,
      'zelda',
    ],
    ['an owner answers a legacy error envelope', { status: 503, body: { error: { code: 'unavailable', message: 'gate closed' } } }, / answered 503 \(unavailable\)$/, 'gate closed'],
    ['an envelope code is free text', { status: 500, body: { error: { code: 'row zelda.sentinel@example.com', message: 'x' } } }, / answered 500$/, 'zelda'],
    ['an owner answers without an envelope', { status: 409, body: 'conflict' }, / answered 409$/, 'conflict'],
  ])('runDirect stops at the first batch when %s, never quoting the answer', async (_label, answer, message, hidden) => {
    const { client, requests } = recordingClient(() => answer);
    const templates = rowsOf('synthetic.message_template');
    const pending = runDirect({ ...dataset, fixtures: only({ 'synthetic.message_template': templates }) }, { client, config, log: quiet });
    await expect(pending).rejects.toThrow(/^direct: communications synthetic\.message_template site=\S+ chunk=0 batch=\S+/);
    await expect(pending).rejects.toThrow(message);
    await expect(pending).rejects.not.toThrow(hidden);
    expect(requests).toHaveLength(1);
  });
});

