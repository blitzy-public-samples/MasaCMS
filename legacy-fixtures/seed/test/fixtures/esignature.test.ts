// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/bytes.js';
import { loadConfig, parseConfig, roleGroupName, type SeedConfig } from '../../src/config.js';
import { fixtureKeys, specForKey, type FixtureContext, type FixtureRow, type FixtureTables } from '../../src/fixture-tables.js';
import { buildEsignatureFixtures } from '../../src/fixtures/esignature.js';
import { buildMasa, indexMasa, type MasaData } from '../../src/masa.js';
import { createRandom } from '../../src/random.js';
import { createCalendar } from '../../src/time.js';

const CONFIG_PATH = fileURLToPath(new URL('../../seed.config.json', import.meta.url));
const DDL_PATH = fileURLToPath(new URL('../../../sql/esignature/100_tables.sql', import.meta.url));
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;
const DDL_TABLE = /CREATE TABLE \[synthetic\]\.\[([^\]]+)\] \(([\s\S]*?)\n\s*\) ON /g;
const DDL_COLUMN = /^\s*\[([^\]]+)\] \[/gm;
const SIGNER = 'esignature.signer';
const REQUESTS = 'synthetic.signature_request';
const SIGNATURES = 'synthetic.signature';
const ENTRIES = 'synthetic.audit_entry';
/** Audit columns usp_audit_append assigns when the seed loads. */
const CHAIN_COLUMNS: readonly string[] = ['seq', 'prev_hash', 'entry_hash'];

type Json = Record<string, any>;

let raw: Json;
let config: SeedConfig;
let ctx: FixtureContext;
let tables: FixtureTables;
let ddl: Map<string, string[]>;

/** Fixture context of `c` over `masa` (built from `c` when omitted), with the e-signature builder's own random stream. */
function context(c: SeedConfig, masa?: MasaData): FixtureContext {
  const random = createRandom(c.seed);
  const calendar = createCalendar(c.businessDate);
  const data = masa ?? buildMasa(c, random.fork('masa'), calendar);
  return { config: c, random: random.fork('fixtures/esignature'), calendar, masa: data, index: indexMasa(data, c) };
}

/** Rows of `key` in `t`; throws when the key is absent. */
function rows(t: FixtureTables, key: string): FixtureRow[] {
  const found = t[key];
  if (found === undefined) throw new Error(`No ${key} in the fixture tables`);
  return found;
}

/** Text value of `column` in `row`. */
const text = (row: FixtureRow, column: string): string => row[column] as string;

/** `list` keyed by each row's `column` value. */
const byColumn = (list: readonly FixtureRow[], column: string): Map<string, FixtureRow> =>
  new Map(list.map((row): [string, FixtureRow] => [text(row, column), row]));

/** `seed.config.json` parsed with the `tenant-b` request count set to `count`. */
function withTenantBRequests(count: number): SeedConfig {
  const copy = structuredClone(raw);
  copy.sites['tenant-b'].counts.signatureRequests = count;
  return parseConfig(copy);
}

/** `ctx.masa` with the `tenant-b` signer-group memberships cut to its first `keep` signers. */
function withTenantBSigners(keep: number): MasaData {
  const group = roleGroupName(config, SIGNER);
  const pool = ctx.index.site('tenant-b').privateUserPoolID;
  const kept = new Set(ctx.index.actors('tenant-b', SIGNER).slice(0, keep));
  const memberships = ctx.masa.memberships.filter((m) => m.groupSiteID !== pool || m.groupname !== group || kept.has(m.userID));
  return { ...ctx.masa, memberships };
}

beforeAll(async () => {
  raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Json;
  config = await loadConfig(CONFIG_PATH);
  ctx = context(config);
  tables = buildEsignatureFixtures(ctx);
  const sql = await readFile(DDL_PATH, 'utf8');
  ddl = new Map([...sql.matchAll(DDL_TABLE)].map(([, table = '', body = '']) => [table, [...body.matchAll(DDL_COLUMN)].map((m) => m[1] ?? '')]));
});

describe('buildEsignatureFixtures', () => {
  it('returns exactly the e-signature keys of the registry, in registry order', () => {
    const keys = fixtureKeys(config).filter((key) => specForKey(key).spec.module === 'esignature');
    expect(keys).toEqual([REQUESTS, SIGNATURES, ENTRIES]);
    expect(Object.keys(tables)).toEqual(keys);
  });

  it.each([
    [REQUESTS, 'signature_request', []],
    [SIGNATURES, 'signature', []],
    [ENTRIES, 'audit_entry', CHAIN_COLUMNS],
  ] as [string, string, readonly string[]][])('%s rows hold the %s DDL columns in catalog order', (key, table, assigned) => {
    const columns = ddl.get(table) ?? [];
    expect(columns).toEqual(expect.arrayContaining([...assigned]));
    const expected = columns.filter((column) => !assigned.includes(column));
    expect(expected.length).toBeGreaterThan(2);
    expect(rows(tables, key).length).toBeGreaterThan(0);
    for (const row of rows(tables, key)) {
      expect(Object.keys(row)).toEqual(expected);
      for (const value of Object.values(row)) expect(typeof value).toBe('string');
    }
  });

  it('keys every row with a unique CF UUID', () => {
    const ids = [
      ...rows(tables, REQUESTS).map((r) => text(r, 'request_id')),
      ...rows(tables, SIGNATURES).map((s) => text(s, 'signature_id')),
      ...rows(tables, ENTRIES).map((e) => text(e, 'entry_id')),
    ];
    expect(ids).toHaveLength(55 + 33 + 88);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(CF_UUID);
  });

  it.each([
    ['umbrella', 0, 0],
    ['tenant-a', 50, 30],
    ['tenant-b', 5, 3],
  ] as const)('%s has %i requests, %i of them signed', (site, total, signed) => {
    expect(config.sites[site].counts.signatureRequests).toBe(total);
    const siteRequests = rows(tables, REQUESTS).filter((r) => r.siteID === site);
    expect(siteRequests).toHaveLength(total);
    expect(siteRequests.filter((r) => r.state === 'SIGNED')).toHaveLength(signed);
    expect(siteRequests.filter((r) => r.state === 'PENDING')).toHaveLength(total - signed);
    const ids = new Set(siteRequests.map((r) => text(r, 'request_id')));
    expect(rows(tables, SIGNATURES).filter((s) => ids.has(text(s, 'request_id')))).toHaveLength(signed);
    expect(rows(tables, ENTRIES).filter((e) => ids.has(text(e, 'request_id')))).toHaveLength(total + signed);
  });

  it('gives each signed request one signature and every request a created, then signed, audit chain', () => {
    const requests = byColumn(rows(tables, REQUESTS), 'request_id');
    const signatureOf = new Map<string, FixtureRow>();
    for (const s of rows(tables, SIGNATURES)) {
      expect(requests.has(text(s, 'request_id'))).toBe(true);
      expect(signatureOf.has(text(s, 'request_id'))).toBe(false);
      signatureOf.set(text(s, 'request_id'), s);
    }
    const chains = new Map<string, string[]>();
    for (const e of rows(tables, ENTRIES)) {
      expect(requests.has(text(e, 'request_id'))).toBe(true);
      chains.set(text(e, 'request_id'), [...(chains.get(text(e, 'request_id')) ?? []), text(e, 'action')]);
    }
    for (const [id, request] of requests) {
      const signed = request.state === 'SIGNED';
      expect(signatureOf.has(id)).toBe(signed);
      expect(chains.get(id)).toEqual(signed ? ['created', 'signed'] : ['created']);
    }
  });

  it('records the document SHA-256 on creation and the signer full name, as typed, on signing', () => {
    const requests = byColumn(rows(tables, REQUESTS), 'request_id');
    const signatures = byColumn(rows(tables, SIGNATURES), 'request_id');
    for (const e of rows(tables, ENTRIES)) {
      const request = requests.get(text(e, 'request_id'))!;
      if (e.action === 'created') {
        expect([e.detail, e.actor_user_id, e.at]).toEqual([request.document_sha256, request.createdByID, request.created]);
        continue;
      }
      const signature = signatures.get(text(e, 'request_id'))!;
      const signer = ctx.index.user(text(signature, 'signer_user_id'));
      expect(signature.signer_user_id).toBe(request.signer_user_id);
      expect(signature.typed_name).toBe(`${signer.fname} ${signer.lname}`.trim());
      expect([e.action, e.detail, e.actor_user_id, e.at]).toEqual(['signed', signature.typed_name, signature.signer_user_id, signature.signed_at]);
    }
  });

  it('stores each document as a PDF matching its SHA-256 and name', () => {
    for (const r of rows(tables, REQUESTS)) {
      const id = text(r, 'request_id');
      const document = Buffer.from(text(r, 'document'), 'hex');
      expect(document.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
      expect(document.toString('latin1')).toContain(`(Reference ${id})`);
      expect(r.document_sha256).toBe(sha256Hex(document));
      expect(r.document_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.document_name).toMatch(new RegExp(`^[A-Za-z -]+ ${id.slice(0, 8)}\\.pdf$`));
    }
  });

  it("draws creator and signer from the site's esignature.signer holders, two different ones when it has several", () => {
    for (const site of ['tenant-a', 'tenant-b'] as const) {
      const holders = ctx.index.actors(site, SIGNER);
      expect(holders.length).toBeGreaterThan(1);
      for (const r of rows(tables, REQUESTS).filter((x) => x.siteID === site)) {
        expect(holders).toContain(r.signer_user_id);
        expect(holders).toContain(r.createdByID);
        expect(r.createdByID).not.toBe(r.signer_user_id);
      }
    }
  });

  it('creates inside the history window and signs 5 minutes to 14 days later, all before the business date', () => {
    const { calendar } = ctx;
    const earliest = calendar.localTimestamp(-config.historyDays, 0);
    const midnight = `${config.businessDate}T00:00:00.000`;
    const requests = byColumn(rows(tables, REQUESTS), 'request_id');
    for (const r of requests.values()) {
      expect(r.created).toMatch(TS);
      expect(text(r, 'created') >= earliest && text(r, 'created') < midnight).toBe(true);
    }
    for (const s of rows(tables, SIGNATURES)) {
      const created = text(requests.get(text(s, 'request_id'))!, 'created');
      const signedAt = text(s, 'signed_at');
      expect(signedAt).toMatch(TS);
      expect(signedAt >= calendar.addMinutes(created, 5)).toBe(true);
      expect(signedAt <= calendar.addMinutes(created, 14 * 1440)).toBe(true);
      expect(signedAt < midnight).toBe(true);
    }
  });

  it('orders requests by site, then creation time and request id, with signatures and chains in request order', () => {
    const requests = rows(tables, REQUESTS);
    expect([...new Set(requests.map((r) => r.siteID))]).toEqual(['tenant-a', 'tenant-b']);
    for (let i = 1; i < requests.length; i += 1) {
      const [a, b] = [requests[i - 1]!, requests[i]!];
      if (a.siteID === b.siteID) expect(`${text(a, 'created')} ${text(a, 'request_id')}` < `${text(b, 'created')} ${text(b, 'request_id')}`).toBe(true);
    }
    const ids = requests.map((r) => r.request_id);
    expect(rows(tables, SIGNATURES).map((s) => s.request_id)).toEqual(requests.filter((r) => r.state === 'SIGNED').map((r) => r.request_id));
    expect(rows(tables, ENTRIES).map((e) => e.request_id).filter((id, i, all) => i === 0 || all[i - 1] !== id)).toEqual(ids);
  });

  it('yields identical tables for the same seed and different ones for another seed', () => {
    expect(JSON.stringify(buildEsignatureFixtures(context(config)))).toBe(JSON.stringify(tables));
    const other = buildEsignatureFixtures(context({ ...config, seed: config.seed + 1 }));
    expect(rows(other, REQUESTS)).toHaveLength(55);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(tables));
  });
});

describe('buildEsignatureFixtures edge cases', () => {
  it.each([
    [1, 0],
    [2, 1],
  ] as const)('a site with %i request(s) signs %i, leaving other sites unchanged', (count, signed) => {
    const t = buildEsignatureFixtures(context(withTenantBRequests(count), ctx.masa));
    const siteRequests = rows(t, REQUESTS).filter((r) => r.siteID === 'tenant-b');
    expect(siteRequests).toHaveLength(count);
    expect(siteRequests.filter((r) => r.state === 'SIGNED')).toHaveLength(signed);
    const ids = new Set(siteRequests.map((r) => text(r, 'request_id')));
    expect(rows(t, SIGNATURES).filter((s) => ids.has(text(s, 'request_id')))).toHaveLength(signed);
    expect(rows(t, ENTRIES).filter((e) => ids.has(text(e, 'request_id')))).toHaveLength(count + signed);
    expect(rows(t, REQUESTS).filter((r) => r.siteID === 'tenant-a')).toEqual(rows(tables, REQUESTS).filter((r) => r.siteID === 'tenant-a'));
  });

  it('lets a lone signer both create and sign', () => {
    const [lone] = ctx.index.actors('tenant-b', SIGNER);
    const t = buildEsignatureFixtures(context(config, withTenantBSigners(1)));
    const siteRequests = rows(t, REQUESTS).filter((r) => r.siteID === 'tenant-b');
    expect(siteRequests).toHaveLength(5);
    for (const r of siteRequests) expect([r.signer_user_id, r.createdByID]).toEqual([lone, lone]);
    const ids = new Set(siteRequests.map((r) => text(r, 'request_id')));
    const entries = rows(t, ENTRIES).filter((e) => ids.has(text(e, 'request_id')));
    expect(entries).toHaveLength(8);
    for (const e of entries) expect(e.actor_user_id).toBe(lone);
  });

  it('rejects a site with requests but no esignature.signer holder', () => {
    const build = (): FixtureTables => buildEsignatureFixtures(context(config, withTenantBSigners(0)));
    expect(build).toThrow(RangeError);
    expect(build).toThrow('No esignature.signer actor in site tenant-b');
  });

  it('rejects a registry that lacks one of its tables', async () => {
    vi.resetModules();
    vi.doMock('../../src/fixture-tables.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/fixture-tables.js')>();
      return { ...actual, fixtureKeys: (c: SeedConfig) => actual.fixtureKeys(c).filter((key) => key !== SIGNATURES) };
    });
    try {
      const { buildEsignatureFixtures: build } = await import('../../src/fixtures/esignature.js');
      expect(() => build(ctx)).toThrow(RangeError);
      expect(() => build(ctx)).toThrow('No esignature fixture table signature in the registry');
    } finally {
      vi.doUnmock('../../src/fixture-tables.js');
      vi.resetModules();
    }
  });
});
