// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Audit hash chain against SQL Server vectors of `synthetic.usp_audit_append`, the e-signature repository writes and the signature_request mapping. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  MappingError,
  UnitNotAuthoritativeError,
  assertBatchTenant,
  closeGates,
  encodeRow,
  encodeValue,
  ensureUnitGates,
  openGates,
  resolveTenant,
  type CanonicalValue,
  type MigrationHandlerOptions,
} from '@opt2/platform/migration-kit';
import { OutsideTenantTransactionError, tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  GENESIS_PREV_HASH,
  HASH_BYTES,
  canonicalAt,
  canonicalString,
  chainVerifier,
  entryHash,
  hashFromHex,
  hashToHex,
  nextEntry,
  roundAt,
  verifyChain,
  type ChainEntry,
  type ChainSource,
  type NextEntry,
  type VerifyResult,
} from '../../src/domain/hash-chain.js';
import { signatureRequestMapping } from '../../src/migration/mappings/signature-request.js';
import { createEsignatureRepository, type EsignatureRepository, type NewSignatureRequest } from '../../src/repo/repository.js';
import { AUDIT_ENTRY, OWNED_TABLES, SIGNATURE, SIGNATURE_REQUEST, UNITS, type AuditEntryRow } from '../../src/repo/tables.js';

const REQUEST_ID = 'A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D';
const ACTOR = 'E1000000-AAAA-BBBB-0000000000000001';
const ZERO_HEX = '0'.repeat(64);

interface Vector {
  seq: number;
  action: string;
  actorUserId: string | null;
  detail: string | null;
  /** The `@at` the caller passes. */
  at: Date;
  /** The `datetime` the procedure stores. */
  stored: Date;
  text: string;
  hash: string;
}

/** Three appends to REQUEST_ID, with `entry_hash` as SQL Server 2022 HASHBYTES computed it over the procedure's CONCAT. */
const VECTORS: readonly Vector[] = [
  {
    seq: 1,
    action: 'created',
    actorUserId: ACTOR,
    detail: 'Document contract.pdf',
    at: new Date(2026, 5, 30, 14, 5, 9, 123),
    stored: new Date(2026, 5, 30, 14, 5, 9, 123),
    text: '2026-06-30T14:05:09.123',
    hash: 'e1e0dc340483ffb89d5d491e13c90c7354e9a677d0d622e678790971ddddcca7',
  },
  {
    seq: 2,
    action: 'viewed',
    actorUserId: null,
    detail: null,
    at: new Date(2026, 5, 30, 14, 6, 0, 0),
    stored: new Date(2026, 5, 30, 14, 6, 0, 0),
    text: '2026-06-30T14:06:00.000',
    hash: '879da8b859699d5bbf9f8a173b3f28dd83227e4796ed8a41fcb5479db3dfbd13',
  },
  {
    seq: 3,
    action: 'signed',
    actorUserId: ACTOR,
    detail: 'Zo\u00eb \u00c5ngstr\u00f6m \u2713 \u{1d4a5}',
    at: new Date(2026, 5, 30, 23, 59, 59, 999),
    stored: new Date(2026, 6, 1, 0, 0, 0, 0),
    text: '2026-07-01T00:00:00.000',
    hash: '41bf83c5f636c24f306449e305227a6bee03fba31af520cdfeb810176ef37983',
  },
];

const vector = (index: number): Vector => VECTORS[index] as Vector;
const prevHex = (index: number): string => (index === 0 ? ZERO_HEX : vector(index - 1).hash);

/** A CF-format id whose last group is `n` in hex and whose first group is `prefix`. */
const cfId = (prefix: string, n: number): string => `${prefix.padEnd(8, '0')}-AAAA-BBBB-${n.toString(16).toUpperCase().padStart(16, '0')}`;

/** The vectors as stored rows: `at` as the stored datetime. */
function storedChain(): ChainEntry[] {
  return VECTORS.map((v, index) => ({
    entry_id: cfId('D', v.seq),
    request_id: REQUEST_ID,
    seq: v.seq,
    action: v.action,
    actor_user_id: v.actorUserId,
    detail: v.detail,
    at: v.stored,
    prev_hash: Buffer.from(prevHex(index), 'hex'),
    entry_hash: Buffer.from(v.hash, 'hex'),
  }));
}

/** The vectors as the fixture audit route lists them and a caller posts them back: `at` as text. */
function suppliedChain(): ChainEntry[] {
  return storedChain().map((entry, index) => ({ ...entry, at: vector(index).text }));
}

describe('audit hash chain constants', () => {
  it('uses 32-byte hashes and links a first entry to 32 zero bytes', () => {
    expect(HASH_BYTES).toBe(32);
    expect(GENESIS_PREV_HASH).toHaveLength(HASH_BYTES);
    expect(hashToHex(GENESIS_PREV_HASH)).toBe(ZERO_HEX);
  });
});

describe('canonicalAt', () => {
  it.each([
    [0, '2026-06-30T14:05:09.000'],
    [1, '2026-06-30T14:05:09.000'],
    [2, '2026-06-30T14:05:09.003'],
    [4, '2026-06-30T14:05:09.003'],
    [5, '2026-06-30T14:05:09.007'],
    [6, '2026-06-30T14:05:09.007'],
    [8, '2026-06-30T14:05:09.007'],
    [9, '2026-06-30T14:05:09.010'],
    [990, '2026-06-30T14:05:09.990'],
    [991, '2026-06-30T14:05:09.990'],
    [992, '2026-06-30T14:05:09.993'],
    [994, '2026-06-30T14:05:09.993'],
    [995, '2026-06-30T14:05:09.997'],
    [997, '2026-06-30T14:05:09.997'],
    [998, '2026-06-30T14:05:09.997'],
    [999, '2026-06-30T14:05:10.000'],
  ])('renders a Date at %i ms as SQL Server datetime rounds it to 1/300 s: %s', (ms, expected) => {
    expect(canonicalAt(new Date(2026, 5, 30, 14, 5, 9, ms))).toBe(expected);
  });

  it.each([
    ['a year', new Date(2026, 11, 31, 23, 59, 59, 999), new Date(2027, 0, 1, 0, 0, 0, 0), '2027-01-01T00:00:00.000'],
    ['a leap-year February 28', new Date(2024, 1, 28, 23, 59, 59, 999), new Date(2024, 1, 29, 0, 0, 0, 0), '2024-02-29T00:00:00.000'],
  ])('carries a .999 Date at the end of %s into the next second', (_name, at, rounded, expected) => {
    expect(roundAt(at).getTime()).toBe(rounded.getTime());
    expect(canonicalAt(at)).toBe(expected);
  });

  it('leaves a Date already on a datetime tick unchanged', () => {
    const at = new Date(2026, 5, 30, 14, 5, 9, 997);
    expect(roundAt(at).getTime()).toBe(at.getTime());
  });

  it.each([
    ['2026-06-30T14:05:09.123', '2026-06-30T14:05:09.123'],
    ['2026-06-30T14:05:09.998', '2026-06-30T14:05:09.997'],
    ['2026-12-31T23:59:59.999', '2027-01-01T00:00:00.000'],
    ['1753-01-01T00:00:00.000', '1753-01-01T00:00:00.000'],
    ['9999-12-31T23:59:59.997', '9999-12-31T23:59:59.997'],
  ])('renders supplied text %s as TRY_CONVERT(datetime, at, 126) stores it', (text, expected) => {
    expect(canonicalAt(text)).toBe(expected);
  });

  it.each(['1752-12-31T23:59:59.999', '9999-12-31T23:59:59.999', '2026-02-30T00:00:00.000', 'not a timestamp'])(
    'renders supplied text %s that TRY_CONVERT turns into NULL as empty',
    (text) => {
      expect(canonicalAt(text)).toBe('');
    },
  );
});

describe('canonicalString', () => {
  it('joins request_id|seq|action|actor|detail|at as the procedure CONCATs them', () => {
    const v = vector(0);
    expect(canonicalString({ requestId: REQUEST_ID, seq: v.seq, action: v.action, actorUserId: v.actorUserId, detail: v.detail, at: v.at })).toBe(
      `${REQUEST_ID}|1|created|${ACTOR}|Document contract.pdf|2026-06-30T14:05:09.123`,
    );
  });

  it('renders a NULL actor and a NULL detail empty, so a NULL and an empty detail hash alike', () => {
    const input = { requestId: REQUEST_ID, seq: 2, action: 'viewed', actorUserId: null, at: vector(1).at };
    const withNull = canonicalString({ ...input, detail: null });
    const withEmpty = canonicalString({ ...input, detail: '' });
    expect(withNull).toBe(`${REQUEST_ID}|2|viewed|||2026-06-30T14:06:00.000`);
    expect(withEmpty).toBe(withNull);
    expect(hashToHex(entryHash(Buffer.from(vector(0).hash, 'hex'), withEmpty))).toBe(vector(1).hash);
  });

  it('pads the request id and a stored actor to char(35) but hashes a supplied actor as sent', () => {
    const input = { requestId: 'R1', seq: 1, action: 'created', detail: '', at: vector(0).at };
    expect(canonicalString({ ...input, actorUserId: null })).toBe(`R1${' '.repeat(33)}|1|created|||2026-06-30T14:05:09.123`);
    expect(canonicalString({ ...input, actorUserId: '' })).toBe(`R1${' '.repeat(33)}|1|created|${' '.repeat(35)}||2026-06-30T14:05:09.123`);
    expect(canonicalString({ ...input, actorUserId: 'admin' }, 'stored')).toContain(`|admin${' '.repeat(30)}|`);
    expect(canonicalString({ ...input, actorUserId: 'admin' }, 'supplied')).toContain('|created|admin||');
  });
});

describe('entryHash', () => {
  it('hashes prev followed by the UTF-16LE canonical text, as HASHBYTES over nvarchar does', () => {
    const hex = hashToHex(entryHash(GENESIS_PREV_HASH, 'a'));
    expect(hex).toBe('7a4dfe43d3b05ec0e015abfa7151d2ce649b925deaeb3d7e3bba8239e08021ea');
    expect(hex).not.toBe('41a0370c3d9f42773a59e8e01651911cf43b1e3f66944cbb690029debc4eb647');
  });

  it.each(VECTORS.map((v, index) => [v.seq, v, index] as const))('reproduces the procedure hash of entry %i, non-BMP text included', (_seq, v, index) => {
    const canonical = canonicalString({ requestId: REQUEST_ID, seq: v.seq, action: v.action, actorUserId: v.actorUserId, detail: v.detail, at: v.at });
    expect(hashToHex(entryHash(Buffer.from(prevHex(index), 'hex'), canonical))).toBe(v.hash);
  });
});

describe('nextEntry', () => {
  /** Appends every vector in order through nextEntry. */
  function appendAll(requestId = REQUEST_ID, actor?: string): NextEntry[] {
    const appended: NextEntry[] = [];
    for (const v of VECTORS) {
      appended.push(
        nextEntry(appended.at(-1) ?? null, {
          requestId,
          action: v.action,
          actorUserId: actor ?? v.actorUserId,
          detail: v.detail,
          at: v.at,
        }),
      );
    }
    return appended;
  }

  it('starts at seq 1 on the genesis hash and links each next entry to the last entry_hash', () => {
    expect(appendAll().map((entry) => [entry.seq, hashToHex(entry.prev_hash), hashToHex(entry.entry_hash)])).toEqual(
      VECTORS.map((v, index) => [v.seq, prevHex(index), v.hash]),
    );
  });

  it('returns at rounded as the datetime column stores it, carrying .999 into the next day', () => {
    const appended = appendAll();
    expect(appended.map((entry) => entry.at.getTime())).toEqual(VECTORS.map((v) => v.stored.getTime()));
    expect(appended[2]?.canonical).toBe(`${REQUEST_ID}|3|signed|${ACTOR}|${vector(2).detail ?? ''}|2026-07-01T00:00:00.000`);
  });

  it('hands out a copy of the genesis hash, never the shared buffer', () => {
    const first = nextEntry(null, { requestId: REQUEST_ID, action: 'created', actorUserId: ACTOR, detail: null, at: vector(0).at });
    expect(first.prev_hash).not.toBe(GENESIS_PREV_HASH);
    first.prev_hash.fill(1);
    expect(hashToHex(GENESIS_PREV_HASH)).toBe(ZERO_HEX);
  });

  it('builds a chain that verifies stored, but breaks a supplied copy whose short actor lost its char(35) padding', () => {
    const appended = appendAll('R1', 'admin');
    const stored: ChainEntry[] = appended.map((entry, index) => ({
      entry_id: cfId('D', entry.seq),
      request_id: 'R1',
      seq: entry.seq,
      action: vector(index).action,
      actor_user_id: 'admin',
      detail: vector(index).detail,
      at: entry.at,
      prev_hash: entry.prev_hash,
      entry_hash: entry.entry_hash,
    }));
    expect(verifyChain(stored)).toEqual({ valid: true, entries: 3, brokenat: 0 });
    const supplied = stored.map((entry, index) => ({ ...entry, at: vector(index).text }));
    expect(verifyChain(supplied.map((entry) => ({ ...entry, actor_user_id: 'admin'.padEnd(35) })), 'supplied')).toEqual({
      valid: true,
      entries: 3,
      brokenat: 0,
    });
    expect(verifyChain(supplied, 'supplied')).toEqual({ valid: false, entries: 3, brokenat: 1 });
  });
});

describe('verifyChain', () => {
  it('accepts the intact stored chain and the empty chain', () => {
    expect(verifyChain(storedChain())).toEqual({ valid: true, entries: 3, brokenat: 0 });
    expect(verifyChain([])).toEqual({ valid: true, entries: 0, brokenat: 0 });
    expect(verifyChain([], 'supplied')).toEqual({ valid: true, entries: 0, brokenat: 0 });
  });

  it('accepts the audit route copy with at as text', () => {
    expect(verifyChain(suppliedChain(), 'supplied')).toEqual({ valid: true, entries: 3, brokenat: 0 });
  });

  it.each<[string, (chain: ChainEntry[]) => ChainEntry[], { valid: boolean; entries: number; brokenat: number }]>([
    ['an altered detail', (c) => c.map((e) => (e.seq === 2 ? { ...e, detail: 'tampered' } : e)), { valid: false, entries: 3, brokenat: 2 }],
    ['an altered action', (c) => c.map((e) => (e.seq === 3 ? { ...e, action: 'voided' } : e)), { valid: false, entries: 3, brokenat: 3 }],
    ['an altered at', (c) => c.map((e) => (e.seq === 1 ? { ...e, at: new Date(2026, 5, 30, 14, 5, 10, 123) } : e)), { valid: false, entries: 3, brokenat: 1 }],
    ['an altered entry_hash', (c) => c.map((e) => (e.seq === 2 ? { ...e, entry_hash: Buffer.alloc(32, 0xff) } : e)), { valid: false, entries: 3, brokenat: 2 }],
    ['an altered last entry_hash', (c) => c.map((e) => (e.seq === 3 ? { ...e, entry_hash: Buffer.alloc(32, 0xff) } : e)), { valid: false, entries: 3, brokenat: 3 }],
    ['a first prev_hash other than genesis', (c) => c.map((e) => (e.seq === 1 ? { ...e, prev_hash: Buffer.alloc(32, 1) } : e)), { valid: false, entries: 3, brokenat: 1 }],
    ['swapped seq numbers', (c) => c.map((e) => (e.seq === 2 ? { ...e, seq: 3 } : e.seq === 3 ? { ...e, seq: 2 } : e)), { valid: false, entries: 3, brokenat: 2 }],
    ['a deleted middle entry', (c) => c.filter((e) => e.seq !== 2), { valid: false, entries: 2, brokenat: 3 }],
    ['a deleted first entry', (c) => c.filter((e) => e.seq !== 1), { valid: false, entries: 2, brokenat: 2 }],
    ['a deleted last entry, which no recomputation can detect', (c) => c.filter((e) => e.seq !== 3), { valid: true, entries: 2, brokenat: 0 }],
  ])('answers a stored chain with %s in the fixture verdict form', (_name, tamper, expected) => {
    expect(verifyChain(tamper(storedChain()))).toEqual(expected);
  });

  it('orders a stored chain by seq but breaks a supplied copy at the first entry out of position', () => {
    const reorder = (chain: ChainEntry[]): ChainEntry[] => [chain[0], chain[2], chain[1]] as ChainEntry[];
    expect(verifyChain(reorder(storedChain()))).toEqual({ valid: true, entries: 3, brokenat: 0 });
    expect(verifyChain(reorder(suppliedChain()), 'supplied')).toEqual({ valid: false, entries: 3, brokenat: 3 });
  });

  it('breaks a supplied copy at an entry whose at text SQL Server cannot convert', () => {
    const chain = suppliedChain().map((e) => (e.seq === 2 ? { ...e, at: '2026-02-30T00:00:00.000' } : e));
    expect(verifyChain(chain, 'supplied')).toEqual({ valid: false, entries: 3, brokenat: 2 });
  });
});

describe('chainVerifier', () => {
  /** A copy of `hash` with its first byte's low bit flipped. */
  const flipped = (hash: Buffer): Buffer => {
    const copy = Buffer.from(hash);
    copy.writeUInt8(copy.readUInt8(0) ^ 0x01, 0);
    return copy;
  };
  /** `items` cut into consecutive slices of `size`. */
  const inBatches = <T>(items: readonly T[], size: number): T[][] =>
    Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

  it.each<{ name: string; chain: () => ChainEntry[]; source: ChainSource; expected: VerifyResult }>([
    { name: 'an intact stored chain', chain: storedChain, source: 'stored', expected: { valid: true, entries: 3, brokenat: 0 } },
    { name: 'the empty chain', chain: () => [], source: 'stored', expected: { valid: true, entries: 0, brokenat: 0 } },
    {
      name: 'an entry_hash with one flipped bit',
      chain: () => storedChain().map((e) => (e.seq === 2 ? { ...e, entry_hash: flipped(e.entry_hash) } : e)),
      source: 'stored',
      expected: { valid: false, entries: 3, brokenat: 2 },
    },
    {
      name: 'a broken prev_hash link',
      chain: () => storedChain().map((e) => (e.seq === 3 ? { ...e, prev_hash: flipped(e.prev_hash) } : e)),
      source: 'stored',
      expected: { valid: false, entries: 3, brokenat: 3 },
    },
    {
      name: 'a wrong seq',
      chain: () => storedChain().map((e) => (e.seq === 2 ? { ...e, seq: 4 } : e)),
      source: 'stored',
      expected: { valid: false, entries: 3, brokenat: 3 },
    },
    {
      name: 'a first entry renumbered to seq 0',
      chain: () => storedChain().map((e) => (e.seq === 1 ? { ...e, seq: 0 } : e)),
      source: 'stored',
      expected: { valid: false, entries: 3, brokenat: 0 },
    },
    { name: 'an intact supplied copy', chain: suppliedChain, source: 'supplied', expected: { valid: true, entries: 3, brokenat: 0 } },
    {
      name: 'a supplied copy out of order',
      chain: () => {
        const c = suppliedChain();
        return [c[0], c[2], c[1]] as ChainEntry[];
      },
      source: 'supplied',
      expected: { valid: false, entries: 3, brokenat: 3 },
    },
  ])('gives the verifyChain verdict on $name fed in batches of every size', ({ chain, source, expected }) => {
    const entries = chain();
    const pushed = source === 'stored' ? [...entries].sort((a, b) => a.seq - b.seq) : entries;
    expect(verifyChain(entries, source)).toEqual(expected);
    for (let size = 1; size <= Math.max(pushed.length, 1); size += 1) {
      const verifier = chainVerifier(source);
      verifier.push([]);
      for (const batch of inBatches(pushed, size)) verifier.push(batch);
      expect(verifier.result()).toEqual(expected);
    }
  });
});

describe('hashToHex and hashFromHex', () => {
  const hash = vector(0).hash;

  it('renders lowercase hex by default and uppercase on request', () => {
    expect(hashToHex(Buffer.from(hash, 'hex'))).toBe(hash);
    expect(hashToHex(Buffer.from(hash, 'hex'), 'upper')).toBe(hash.toUpperCase());
  });

  it('parses exactly 64 hex digits in either case', () => {
    expect(hashFromHex(hash)).toEqual(Buffer.from(hash, 'hex'));
    expect(hashFromHex(hash.toUpperCase())).toEqual(Buffer.from(hash, 'hex'));
  });

  it.each([
    ['empty text', ''],
    ['63 digits', hash.slice(1)],
    ['65 digits', `${hash}0`],
    ['a 0x prefix', `0x${hash.slice(2)}`],
    ['a non-hex digit', `g${hash.slice(1)}`],
    ['surrounding space', ` ${hash.slice(1)}`],
  ])('answers null for %s', (_name, text) => {
    expect(hashFromHex(text)).toBeNull();
  });
});

describe('e-signature repository', () => {
  it('extends the platform repository of the owned tables on the database schema', () => {
    const repository = createEsignatureRepository({ db: { schema: 'esignature' } as TenantDb });
    const handlerRepository: MigrationHandlerOptions['repository'] = repository;
    expect(Object.isFrozen(repository)).toBe(true);
    expect(handlerRepository).toMatchObject({ owner: 'e-signature', schema: 'esignature' });
    expect(repository.units()).toEqual([...UNITS]);
    expect(OWNED_TABLES.map((table) => repository.definition(table.table).unit)).toEqual([...UNITS]);
  });

  it('refuses every domain write outside an open tenant transaction', async () => {
    const repository = createEsignatureRepository({ db: { schema: 'esignature' } as TenantDb });
    const tx = { kind: 'tenant', schema: 'esignature', tenantId: TENANT_A.tenantId } as TenantTx;
    const writes: Promise<unknown>[] = [
      repository.insertRequest(tx, newRequest(REQUEST_ID, TENANT_A.siteId)),
      repository.updateRequest(tx, REQUEST_ID, { state: 'SIGNED' }),
      repository.insertSignature(tx, { signature_id: cfId('C', 1), request_id: REQUEST_ID, typed_name: 'Jane Doe', signer_user_id: ACTOR, signed_at: vector(2).stored }),
      repository.insertAuditEntry(tx, auditRow(storedChain()[0] as ChainEntry & { at: Date }, REQUEST_ID)),
    ];
    for (const write of writes) await expect(write).rejects.toBeInstanceOf(OutsideTenantTransactionError);
  });
});

/** A PENDING request of `siteId` created at the first vector's time. */
function newRequest(requestId: string, siteId: string): NewSignatureRequest {
  return {
    request_id: requestId,
    siteid: siteId,
    document_name: 'contract.pdf',
    document_sha256: 'ab'.repeat(32),
    document: Buffer.from('%PDF-1.7 contract'),
    signer_user_id: ACTOR,
    state: 'PENDING',
    created: vector(0).stored,
    createdbyid: ACTOR,
  };
}

/** The audit_entry insert of a chain entry, re-keyed to `requestId`. */
function auditRow(entry: Pick<ChainEntry, 'seq' | 'action' | 'actor_user_id' | 'detail' | 'prev_hash' | 'entry_hash'> & { at: Date }, requestId: string) {
  return {
    entry_id: cfId('D', entry.seq),
    request_id: requestId,
    seq: entry.seq,
    action: entry.action,
    actor_user_id: entry.actor_user_id,
    detail: entry.detail,
    at: entry.at,
    prev_hash: entry.prev_hash,
    entry_hash: entry.entry_hash,
  };
}

const available = await pgAvailable();

describe.skipIf(!available)('e-signature repository writes against PostgreSQL', () => {
  const NOW = new Date(2026, 5, 30, 14, 10, 0, 0);
  let handle: ThrowawaySchema;
  let repository: EsignatureRepository;
  let tenants = 0;
  let siteId: string;
  let tenantId: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'e-signature',
      schemaName: 'esignature',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    repository = createEsignatureRepository({ db: handle.app, clock: fixedClock(NOW) });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    tenants += 1;
    siteId = `esignature-audit-chain-${tenants}`;
    tenantId = tenantIdForSite(siteId);
  });

  /** Moves every e-signature gate to `state` through the holder compare-and-set. */
  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: UNITS, holderId: 'audit-chain-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'audit-chain-test', state });
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = tenantId): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  /** `<op> <table>` with origin, actor, request id, columns and time of the changelog rows the open transaction wrote. */
  async function written(tx: TenantTx): Promise<Record<string, unknown>[]> {
    const { rows } = await tx.query(
      `SELECT op, "table", origin, actor_user_id, request_id, columns, at FROM ${handle.schema}.changelog WHERE xid = pg_current_xact_id() ORDER BY seq`,
    );
    return rows;
  }

  it('stores a request, its signature and an audit chain that verifies as pg returns it, with one changelog row per write', async () => {
    const ctx = { actorUserId: ACTOR, requestId: 'req-audit-chain' };
    await inTenant(async (tx) => {
      const request = await repository.insertRequest(tx, newRequest(REQUEST_ID, siteId), ctx);
      expect(request).toEqual({ ...newRequest(REQUEST_ID, siteId), tenant_id: tenantId, row_version: '0' });
      const signature = await repository.insertSignature(
        tx,
        { signature_id: cfId('C', tenants), request_id: REQUEST_ID, typed_name: 'Zo\u00eb \u00c5ngstr\u00f6m', signer_user_id: ACTOR, signed_at: vector(2).stored },
        ctx,
      );
      expect(signature).toMatchObject({ tenant_id: tenantId, request_id: REQUEST_ID, typed_name: 'Zo\u00eb \u00c5ngstr\u00f6m', row_version: '0' });

      const stored: AuditEntryRow[] = [];
      for (const v of VECTORS) {
        const next = nextEntry(stored.at(-1) ?? null, { requestId: REQUEST_ID, action: v.action, actorUserId: v.actorUserId, detail: v.detail, at: v.at });
        stored.push(await repository.insertAuditEntry(tx, auditRow({ ...next, action: v.action, actor_user_id: v.actorUserId, detail: v.detail }, REQUEST_ID), ctx));
      }
      expect(stored.map((row) => [row.tenant_id, row.seq, row.at.getTime(), hashToHex(row.entry_hash)])).toEqual(
        VECTORS.map((v) => [tenantId, v.seq, v.stored.getTime(), v.hash]),
      );
      expect(verifyChain(stored)).toEqual({ valid: true, entries: 3, brokenat: 0 });

      const logged = await written(tx);
      expect(logged.map((row) => `${String(row.op)} ${String(row.table)}`)).toEqual([
        `insert ${SIGNATURE_REQUEST.table}`,
        `insert ${SIGNATURE.table}`,
        `insert ${AUDIT_ENTRY.table}`,
        `insert ${AUDIT_ENTRY.table}`,
        `insert ${AUDIT_ENTRY.table}`,
      ]);
      expect(logged.every((row) => row.origin === 'target' && row.actor_user_id === ACTOR && row.request_id === ctx.requestId)).toBe(true);
      expect(logged.map((row) => (row.at as Date).getTime())).toEqual(logged.map(() => NOW.getTime()));
    });
  });

  it('sets changes on a request and answers null for a request the transaction tenant does not have', async () => {
    const requestId = cfId('A', tenants);
    await inTenant(async (tx) => {
      await repository.insertRequest(tx, newRequest(requestId, siteId));
      const signed = await repository.updateRequest(tx, requestId, { state: 'SIGNED' });
      expect(signed).toEqual({ ...newRequest(requestId, siteId), tenant_id: tenantId, state: 'SIGNED', row_version: '0' });
      expect(await repository.updateRequest(tx, cfId('A', 0xfffff), { state: 'SIGNED' })).toBeNull();
      expect((await written(tx)).map((row) => [row.op, row.columns])).toEqual([
        ['insert', SIGNATURE_REQUEST.columns.filter((column) => column.name !== 'tenant_id').map((column) => column.name)],
        ['update', ['state']],
      ]);
    });
    await inTenant(async (tx) => {
      expect(await repository.updateRequest(tx, requestId, { state: 'PENDING' })).toBeNull();
      expect(await written(tx)).toEqual([]);
    }, TENANT_B.tenantId);
  });

  it('rejects target writes while the units are legacy-authoritative and stores nothing', async () => {
    await setGates('legacy');
    const requestId = cfId('B', tenants);
    await expect(inTenant((tx) => repository.insertRequest(tx, newRequest(requestId, siteId)))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    await expect(inTenant((tx) => repository.insertAuditEntry(tx, auditRow(storedChain()[0] as ChainEntry & { at: Date }, requestId)))).rejects.toBeInstanceOf(
      UnitNotAuthoritativeError,
    );
    await setGates('open');
    const counts = await inTenant(async (tx) => {
      const { rows } = await tx.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM ${handle.schema}.signature_request)::integer + (SELECT count(*) FROM ${handle.schema}.audit_entry)::integer + (SELECT count(*) FROM ${handle.schema}.changelog)::integer AS n`,
      );
      return rows[0]?.n;
    });
    expect(counts).toBe(0);
  });
});

describe('synthetic.signature_request mapping', () => {
  const LEGACY_COLUMNS = ['request_id', 'siteID', 'document_name', 'document_sha256', 'document', 'signer_user_id', 'state', 'created', 'createdByID'];
  const DOCUMENT = Buffer.from('%PDF-1.7 contract');

  /** A fixture row as the backfill reads it, `document` as bytes and `created` as datetime text. */
  function legacyRow(overrides: Record<string, CanonicalValue> = {}): Record<string, CanonicalValue> {
    return {
      request_id: REQUEST_ID,
      siteID: TENANT_A.siteId,
      document_name: 'contract.pdf',
      document_sha256: 'ab'.repeat(32),
      document: DOCUMENT,
      signer_user_id: ACTOR,
      state: 'PENDING',
      created: '2026-06-30T14:05:09.123',
      createdByID: ACTOR,
      ...overrides,
    };
  }

  it('maps the fixture table to the schema-qualified signature_request unit, keyed by request_id', () => {
    expect(signatureRequestMapping).toMatchObject({
      legacyTable: 'synthetic.signature_request',
      targetTable: 'esignature.signature_request',
      unit: SIGNATURE_REQUEST.unit,
      key: ['request_id'],
      keyless: false,
      split: undefined,
      fold: undefined,
    });
    expect(Object.isFrozen(signatureRequestMapping)).toBe(true);
  });

  it('maps every fixture column in its DDL spelling to the lower-cased repository column and canonical type', () => {
    expect(signatureRequestMapping.legacyColumns.map((column) => column.name)).toEqual(LEGACY_COLUMNS);
    expect(signatureRequestMapping.columns.map((column) => column.target)).toEqual(LEGACY_COLUMNS.map((name) => name.toLowerCase()));
    expect(signatureRequestMapping.targetColumns).toEqual(
      SIGNATURE_REQUEST.columns.filter((column) => column.name !== 'tenant_id' && column.name !== 'row_version'),
    );
  });

  it("resolves a row to the tenant of its own siteID and refuses it in another tenant's batch", () => {
    const source = signatureRequestMapping.tenant;
    expect(source).toStrictEqual({ kind: 'site', column: 'siteID' });
    if (source === undefined) throw new Error('signature_request declares no tenant source');
    expect(resolveTenant(source, legacyRow(), { umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID })).toStrictEqual({
      tenantId: TENANT_A.tenantId,
      siteId: TENANT_A.siteId,
      orphan: false,
    });
    expect(() => assertBatchTenant(signatureRequestMapping, legacyRow(), TENANT_A.tenantId)).not.toThrow();
    expect(() => assertBatchTenant(signatureRequestMapping, legacyRow(), TENANT_B.tenantId)).toThrow(MappingError);
  });

  it('turns a decoded fixture row into pg parameters: bytes as a Buffer, datetime as wall-clock text', () => {
    const encoding = encodeRow(signatureRequestMapping.legacyColumns, legacyRow());
    expect(signatureRequestMapping.toTarget(signatureRequestMapping.decodeLegacy(signatureRequestMapping.legacyColumns, encoding))).toEqual({
      request_id: REQUEST_ID,
      siteid: TENANT_A.siteId,
      document_name: 'contract.pdf',
      document_sha256: 'ab'.repeat(32),
      document: DOCUMENT,
      signer_user_id: ACTOR,
      state: 'PENDING',
      created: '2026-06-30 14:05:09.123',
      createdbyid: ACTOR,
    });
    expect(signatureRequestMapping.toTarget(legacyRow({ document: null })).document).toBeNull();
  });

  it.each<{ name: string; targetRow: (target: Record<string, unknown>) => Record<string, unknown> }>([
    { name: 'the target parameters', targetRow: (target) => target },
    { name: 'the values pg returns', targetRow: (target) => ({ ...target, created: vector(0).stored }) },
  ])('re-encodes $name byte for byte as the fixture row', ({ targetRow }) => {
    const encoding = encodeRow(signatureRequestMapping.legacyColumns, legacyRow());
    const row = targetRow(signatureRequestMapping.toTarget(signatureRequestMapping.decodeLegacy(signatureRequestMapping.legacyColumns, encoding)));
    expect(Object.keys(signatureRequestMapping.toLegacy(row))).toEqual(LEGACY_COLUMNS);
    expect(signatureRequestMapping.encodeLegacy(row)).toBe(encoding);
    expect(signatureRequestMapping.encodeLegacyKey(row)).toBe(encodeValue('s', REQUEST_ID));
  });

  it('refuses a fixture row without one of its columns', () => {
    const withoutState = Object.fromEntries(Object.entries(legacyRow()).filter(([name]) => name !== 'state'));
    expect(() => signatureRequestMapping.toTarget(withoutState)).toThrow(MappingError);
  });
});
