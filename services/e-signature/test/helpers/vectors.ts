// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Audit hash-chain vectors and tamper verdicts; hex computed with python3 hashlib over UTF-16LE canonical text, cross-checked on SQL Server 2022 with usp_audit_append's and esignature.cfc verify's expressions. */
import { Buffer } from 'node:buffer';
import type { AuditCanonicalInput, ChainEntry } from '../../src/domain/hash-chain.js';

/** `prev_hash` of a request's first entry as hex: 32 zero bytes. */
export const GENESIS_HEX = '0'.repeat(64);

/** `request_id` of every vector. */
export const VECTOR_REQUEST_ID = 'ABCDEF01-2345-6789-ABCDEF0123456789';

/** One procedure append: its inputs with the raw `@at`, the canonical text it hashes, and lowercase-hex `prev_hash` and `entry_hash`. */
export interface ChainVector {
  input: AuditCanonicalInput;
  canonical: string;
  prevHex: string;
  entryHex: string;
}

/** A mutation of `chainEntries()` and the `brokenat` the fixture verify route reports for it. */
export interface TamperCase {
  name: string;
  mutate(entries: ChainEntry[]): ChainEntry[];
  brokenat: number;
}

/** A vector with the `entry_id` of its stored row and `at` as the `datetime` column stores it. */
interface StoredVector {
  vector: ChainVector;
  entryId: string;
  storedAt: Date;
}

const STORED_VECTORS: readonly StoredVector[] = [
  {
    vector: {
      input: {
        requestId: VECTOR_REQUEST_ID,
        seq: 1,
        action: 'created',
        actorUserId: 'A1B2C3D4-0000-0000-0000000000000001',
        detail: 'cbe8263992edc7f17cfdcb0d0b113055db84a88864419e372f390f0630f7057d',
        at: new Date(2026, 5, 29, 23, 59, 59, 999),
      },
      canonical:
        'ABCDEF01-2345-6789-ABCDEF0123456789|1|created|A1B2C3D4-0000-0000-0000000000000001|cbe8263992edc7f17cfdcb0d0b113055db84a88864419e372f390f0630f7057d|2026-06-30T00:00:00.000',
      prevHex: GENESIS_HEX,
      entryHex: '18164a5905ad3555e39d741971514b66c24e3673ecc52c0add4a557efb6f41c0',
    },
    entryId: 'ABCDEF01-2345-6789-E000000000000001',
    storedAt: new Date(2026, 5, 30, 0, 0, 0, 0),
  },
  {
    vector: {
      input: {
        requestId: VECTOR_REQUEST_ID,
        seq: 2,
        action: 'signed',
        actorUserId: 'A1B2C3D4-0000-0000-0000000000000001',
        detail: null,
        at: new Date(2026, 5, 30, 12, 0, 0, 1),
      },
      canonical: 'ABCDEF01-2345-6789-ABCDEF0123456789|2|signed|A1B2C3D4-0000-0000-0000000000000001||2026-06-30T12:00:00.000',
      prevHex: '18164a5905ad3555e39d741971514b66c24e3673ecc52c0add4a557efb6f41c0',
      entryHex: '11c3c1d38fa8255e7123b53e6987c0b91c070bd813b74b63a5d5f27c5dd8fa8d',
    },
    entryId: 'ABCDEF01-2345-6789-E000000000000002',
    storedAt: new Date(2026, 5, 30, 12, 0, 0, 0),
  },
  {
    vector: {
      input: {
        requestId: VECTOR_REQUEST_ID,
        seq: 3,
        action: 'signed',
        actorUserId: 'A1B2C3D4-0000-0000-0000000000000002',
        detail: '',
        at: new Date(2026, 5, 30, 12, 0, 0, 2),
      },
      canonical: 'ABCDEF01-2345-6789-ABCDEF0123456789|3|signed|A1B2C3D4-0000-0000-0000000000000002||2026-06-30T12:00:00.003',
      prevHex: '11c3c1d38fa8255e7123b53e6987c0b91c070bd813b74b63a5d5f27c5dd8fa8d',
      entryHex: '726987f63d7392562884606119dbbbef56ed8807a7e9a580f37536d6405df8b4',
    },
    entryId: 'ABCDEF01-2345-6789-E000000000000003',
    storedAt: new Date(2026, 5, 30, 12, 0, 0, 3),
  },
  {
    vector: {
      input: {
        requestId: VECTOR_REQUEST_ID,
        seq: 4,
        action: 'signed',
        actorUserId: 'A1B2C3D4-0000-0000-0000000000000001',
        detail: 'Zo\u00eb \u00dcnal \u2013 \u7f72\u540d',
        at: new Date(2026, 5, 30, 12, 0, 0, 5),
      },
      canonical:
        'ABCDEF01-2345-6789-ABCDEF0123456789|4|signed|A1B2C3D4-0000-0000-0000000000000001|Zo\u00eb \u00dcnal \u2013 \u7f72\u540d|2026-06-30T12:00:00.007',
      prevHex: '726987f63d7392562884606119dbbbef56ed8807a7e9a580f37536d6405df8b4',
      entryHex: 'af3be5b25626e5f0e4b663e451c1d65981d616bed83be78ff74eddb88a19462e',
    },
    entryId: 'ABCDEF01-2345-6789-E000000000000004',
    storedAt: new Date(2026, 5, 30, 12, 0, 0, 7),
  },
  {
    vector: {
      input: {
        requestId: VECTOR_REQUEST_ID,
        seq: 5,
        action: 'signed',
        actorUserId: 'A1B2C3D4-0000-0000-0000000000000001',
        detail: 'Signed with \u{1F58B}',
        at: new Date(2026, 5, 30, 12, 0, 1, 997),
      },
      canonical: 'ABCDEF01-2345-6789-ABCDEF0123456789|5|signed|A1B2C3D4-0000-0000-0000000000000001|Signed with \u{1F58B}|2026-06-30T12:00:01.997',
      prevHex: 'af3be5b25626e5f0e4b663e451c1d65981d616bed83be78ff74eddb88a19462e',
      entryHex: '9998930c5e2cadfacfaa6a00272bbe6554fcae68f911c15ccb7dcae48ad0229c',
    },
    entryId: 'ABCDEF01-2345-6789-E000000000000005',
    storedAt: new Date(2026, 5, 30, 12, 0, 1, 997),
  },
];

/** One chain of VECTOR_REQUEST_ID in `seq` order from 1, each `prevHex` the previous `entryHex`. */
export const CHAIN_VECTORS: readonly ChainVector[] = STORED_VECTORS.map(({ vector }) => vector);

/** The chain as stored rows, freshly built on each call. */
export function chainEntries(): ChainEntry[] {
  return STORED_VECTORS.map(({ vector, entryId, storedAt }) => ({
    entry_id: entryId,
    request_id: vector.input.requestId,
    seq: vector.input.seq,
    action: vector.input.action,
    actor_user_id: vector.input.actorUserId,
    detail: vector.input.detail,
    at: new Date(storedAt.getTime()),
    prev_hash: Buffer.from(vector.prevHex, 'hex'),
    entry_hash: Buffer.from(vector.entryHex, 'hex'),
  }));
}

/** Tampered copies of `chainEntries()`; `brokenat` is the `seq` of the first entry the verify route reports broken. */
export const TAMPER_CASES: readonly TamperCase[] = [
  {
    name: 'altered detail',
    mutate: (entries) => entries.map((entry) => (entry.seq === 4 ? { ...entry, detail: 'Zoe Unal' } : entry)),
    brokenat: 4,
  },
  {
    name: 'altered entry_hash',
    mutate: (entries) =>
      entries.map((entry) => {
        if (entry.seq !== 3) return entry;
        const entryHash = Buffer.from(entry.entry_hash);
        entryHash.writeUInt8(entryHash.readUInt8(0) ^ 0xff, 0);
        return { ...entry, entry_hash: entryHash };
      }),
    brokenat: 3,
  },
  {
    name: 'swapped seq',
    mutate: (entries) => entries.map((entry) => (entry.seq === 2 || entry.seq === 3 ? { ...entry, seq: entry.seq === 2 ? 3 : 2 } : entry)),
    brokenat: 2,
  },
  {
    name: 'deleted entry',
    mutate: (entries) => entries.filter((entry) => entry.seq !== 3),
    brokenat: 4,
  },
];
