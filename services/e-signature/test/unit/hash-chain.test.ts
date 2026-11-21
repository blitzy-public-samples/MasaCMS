// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Hash chain against the shared `usp_audit_append` vectors and the fixture verify verdicts, plus seeded properties over generated chains. */
import { Buffer } from 'node:buffer';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GENESIS_PREV_HASH,
  HASH_BYTES,
  canonicalAt,
  canonicalString,
  entryHash,
  hashFromHex,
  hashToHex,
  nextEntry,
  verifyChain,
  type AuditCanonicalInput,
  type ChainEntry,
  type NextEntry,
  type NextEntryInput,
  type VerifyResult,
} from '../../src/domain/hash-chain.js';
import { CHAIN_VECTORS, GENESIS_HEX, TAMPER_CASES, VECTOR_REQUEST_ID, chainEntries, type ChainVector } from '../helpers/vectors.js';

const RUNS = { seed: 20260601, numRuns: 100 } as const;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;
const LOWER_HEX_HASH = /^[0-9a-f]{64}$/;
const AT_2026 = fc.date({ min: new Date(2026, 0, 1), max: new Date(2026, 11, 31, 23, 59, 59, 999), noInvalidDate: true });

const VECTOR_CASES: { name: string; vector: ChainVector }[] = CHAIN_VECTORS.map((vector) => ({
  name: `seq ${vector.input.seq} ${vector.input.action}`,
  vector,
}));

/** The only vector whose input satisfies `predicate`. */
function vectorWhere(predicate: (input: AuditCanonicalInput) => boolean): ChainVector {
  const found = CHAIN_VECTORS.filter((vector) => predicate(vector.input));
  expect(found).toHaveLength(1);
  return found[0] as ChainVector;
}

/** The `request_id|seq|action|actor|detail|at` fields of a canonical text without `|` in its values. */
function fieldsOf(canonical: string): string[] {
  return canonical.split('|');
}

/** The trailing `yyyy-MM-ddTHH:mm:ss.fff` field of a vector's canonical text. */
function timestampOf(vector: ChainVector): string {
  return vector.canonical.slice(vector.canonical.lastIndexOf('|') + 1);
}

/** How many code points of `text` lie above `limit`. */
function codePointsAbove(text: string | null, limit: number): number {
  return [...(text ?? '')].filter((char) => (char.codePointAt(0) ?? 0) > limit).length;
}

/** A vector hash literal as bytes; fails on text `hashFromHex` rejects. */
function hashOf(hex: string): Buffer {
  const hash = hashFromHex(hex);
  if (hash === null) throw new Error(`not a 64-digit hex hash: ${hex}`);
  return hash;
}

/** A vector's procedure parameters; every vector passes `@at` as a Date. */
function appendInput({ input }: ChainVector): NextEntryInput {
  if (!(input.at instanceof Date)) throw new TypeError(`vector seq ${input.seq} passes @at as text`);
  return { requestId: input.requestId, action: input.action, actorUserId: input.actorUserId, detail: input.detail, at: input.at };
}

/** Every vector appended in order from an empty chain. */
function appendVectors(): NextEntry[] {
  const appended: NextEntry[] = [];
  for (const vector of CHAIN_VECTORS) appended.push(nextEntry(appended.at(-1) ?? null, appendInput(vector)));
  return appended;
}

/** Epoch milliseconds of a stored row's `datetime`. */
function storedTime(entry: ChainEntry): number {
  if (!(entry.at instanceof Date)) throw new TypeError(`entry seq ${entry.seq} stores at as text`);
  return entry.at.getTime();
}

describe('constants', () => {
  it('uses 32-byte hashes and links a first entry to 32 zero bytes, the vectors GENESIS_HEX', () => {
    expect(HASH_BYTES).toBe(32);
    expect(Buffer.isBuffer(GENESIS_PREV_HASH)).toBe(true);
    expect(GENESIS_PREV_HASH.equals(Buffer.alloc(HASH_BYTES))).toBe(true);
    expect(GENESIS_HEX).toBe('0'.repeat(64));
    expect(hashToHex(GENESIS_PREV_HASH)).toBe(GENESIS_HEX);
  });
});

describe('canonicalAt', () => {
  it.each(VECTOR_CASES)('renders the @at of $name as the datetime column stores it', ({ vector }) => {
    const text = canonicalAt(vector.input.at);
    expect(text).toMatch(TIMESTAMP);
    expect(text).toBe(timestampOf(vector));
  });

  it('carries a .999 @at to midnight of the next day', () => {
    const vector = vectorWhere((input) => input.at instanceof Date && input.at.getMilliseconds() === 999);
    const { at } = appendInput(vector);
    const text = canonicalAt(at);
    expect(text).toBe(timestampOf(vector));
    expect(text.endsWith('T00:00:00.000')).toBe(true);
    expect(Number(text.slice(8, 10))).not.toBe(at.getDate());
  });

  it('renders the text it produces for any Date unchanged, so a listed copy hashes as the stored row', () => {
    fc.assert(
      fc.property(AT_2026, (at) => {
        const text = canonicalAt(at);
        expect(text).toMatch(TIMESTAMP);
        expect(canonicalAt(text)).toBe(text);
      }),
      RUNS,
    );
  });

  it('renders text TRY_CONVERT turns into NULL empty: a day past the end of its month or a year before 1753', () => {
    const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
    const pastMonthEnd = fc
      .tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 29, max: 31 }), fc.integer({ min: 0, max: 999 }))
      .filter(([month, day]) => day > new Date(2026, month, 0).getDate())
      .map(([month, day, ms]) => `2026-${pad(month)}-${pad(day)}T12:00:00.${pad(ms, 3)}`);
    const before1753 = fc
      .tuple(fc.integer({ min: 1000, max: 1752 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }), fc.integer({ min: 0, max: 999 }))
      .map(([year, month, day, ms]) => `${year}-${pad(month)}-${pad(day)}T23:59:59.${pad(ms, 3)}`);
    fc.assert(
      fc.property(fc.oneof(pastMonthEnd, before1753), (text) => {
        expect(canonicalAt(text)).toBe('');
      }),
      RUNS,
    );
  });
});

describe('canonicalString', () => {
  it.each(VECTOR_CASES)('builds the procedure CONCAT text of $name', ({ vector }) => {
    expect(canonicalString(vector.input)).toBe(vector.canonical);
    expect(fieldsOf(vector.canonical)).toHaveLength(6);
  });

  it('renders a NULL and an empty detail alike, as an empty field', () => {
    const withNull = vectorWhere((input) => input.detail === null);
    const withEmpty = vectorWhere((input) => input.detail === '');
    for (const vector of [withNull, withEmpty]) expect(fieldsOf(vector.canonical)[4]).toBe('');
    expect(canonicalString({ ...withNull.input, detail: '' })).toBe(withNull.canonical);
    expect(canonicalString({ ...withEmpty.input, detail: null })).toBe(withEmpty.canonical);
  });

  it('keeps non-ASCII BMP detail text exactly, without Unicode normalisation', () => {
    const vector = vectorWhere((input) => codePointsAbove(input.detail, 0x7f) > 0 && codePointsAbove(input.detail, 0xffff) === 0);
    const detail = vector.input.detail ?? '';
    expect(fieldsOf(vector.canonical)[4]).toBe(detail);
    expect(vector.canonical.length).toBe([...vector.canonical].length);
    expect(detail.normalize('NFD')).not.toBe(detail);
    expect(canonicalString({ ...vector.input, detail: detail.normalize('NFD') })).not.toBe(vector.canonical);
  });

  it('keeps a surrogate pair as two UTF-16 code units of the canonical text', () => {
    const vector = vectorWhere((input) => codePointsAbove(input.detail, 0xffff) === 1);
    const canonical = canonicalString(vector.input);
    expect(canonical).toBe(vector.canonical);
    expect(canonical.length).toBe([...canonical].length + 1);
    expect(fieldsOf(canonical)[4]).toBe(vector.input.detail);
  });
});

describe('entryHash', () => {
  it.each(VECTOR_CASES)('reproduces the HASHBYTES literal of $name over prev_hash and the UTF-16LE canonical text', ({ vector }) => {
    expect(hashToHex(entryHash(hashOf(vector.prevHex), vector.canonical))).toBe(vector.entryHex);
  });

  it('links the vectors into one chain from seq 1 on the genesis hash', () => {
    const [first] = CHAIN_VECTORS;
    expect(first?.input.seq).toBe(1);
    expect(first?.prevHex).toBe(GENESIS_HEX);
    CHAIN_VECTORS.slice(1).forEach((vector, index) => {
      const previous = CHAIN_VECTORS[index] as ChainVector;
      expect(vector.input.seq).toBe(previous.input.seq + 1);
      expect(vector.prevHex).toBe(previous.entryHex);
    });
  });
});

describe('nextEntry', () => {
  it('folds the vector appends from an empty chain into the vector seq, canonical text and hashes', () => {
    expect(
      appendVectors().map((entry) => ({ seq: entry.seq, canonical: entry.canonical, prevHex: hashToHex(entry.prev_hash), entryHex: hashToHex(entry.entry_hash) })),
    ).toEqual(CHAIN_VECTORS.map((vector) => ({ seq: vector.input.seq, canonical: vector.canonical, prevHex: vector.prevHex, entryHex: vector.entryHex })));
  });

  it('returns at rounded to the datetime the stored rows hold', () => {
    expect(appendVectors().map((entry) => entry.at.getTime())).toEqual(chainEntries().map(storedTime));
  });
});

describe('verifyChain', () => {
  it('accepts the intact vector chain stored and as the audit route lists it, and the empty chain, with brokenat 0', () => {
    const intact: VerifyResult = { valid: true, entries: CHAIN_VECTORS.length, brokenat: 0 };
    expect(verifyChain(chainEntries())).toEqual(intact);
    const listed = chainEntries().map((entry, index) => ({ ...entry, at: timestampOf(CHAIN_VECTORS[index] as ChainVector) }));
    expect(verifyChain(listed, 'supplied')).toEqual(intact);
    expect(verifyChain([])).toEqual({ valid: true, entries: 0, brokenat: 0 });
  });

  it.each(TAMPER_CASES)('reports the $name chain broken at seq $brokenat', ({ mutate, brokenat }) => {
    const tampered = mutate(chainEntries());
    expect(verifyChain(tampered)).toEqual({ valid: false, entries: tampered.length, brokenat });
  });
});

describe('hex helpers', () => {
  const HEX_DIGIT = fc.constantFrom(...'0123456789abcdefABCDEF');
  const VECTOR_HASHES = [...new Set(CHAIN_VECTORS.flatMap((vector) => [vector.prevHex, vector.entryHex]))];

  it.each(VECTOR_HASHES)('renders vector hash %s as its lowercase literal and parses it back in either case', (hex) => {
    const hash = hashOf(hex);
    expect(hash).toHaveLength(HASH_BYTES);
    expect(hashToHex(hash)).toMatch(LOWER_HEX_HASH);
    expect(hashToHex(hash)).toBe(hex);
    expect(hashFromHex(hex.toUpperCase())).toEqual(hash);
    expect(hashFromHex(hashToHex(hash, 'upper'))).toEqual(hash);
  });

  it('round-trips any 32-byte hash through hex', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: HASH_BYTES, maxLength: HASH_BYTES }), (bytes) => {
        const hash = Buffer.from(bytes);
        expect(hashToHex(hash)).toMatch(LOWER_HEX_HASH);
        expect(hashFromHex(hashToHex(hash))).toEqual(hash);
        expect(hashFromHex(hashToHex(hash, 'upper'))).toEqual(hash);
      }),
      RUNS,
    );
  });

  it('answers null for hex digits of any length other than 64', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: HEX_DIGIT, maxLength: 2 * 64 + 2 }).filter((text) => text.length !== 64),
        (text) => {
          expect(hashFromHex(text)).toBeNull();
        },
      ),
      RUNS,
    );
  });

  it('answers null for 64 characters holding one that is not a hex digit', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: HEX_DIGIT, minLength: 64, maxLength: 64 }),
        fc.nat({ max: 63 }),
        fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 1 }).filter((char) => !/^[0-9a-fA-F]$/.test(char)),
        (digits, position, char) => {
          expect(hashFromHex(digits.slice(0, position) + char + digits.slice(position + 1))).toBeNull();
        },
      ),
      RUNS,
    );
  });
});

describe('properties', () => {
  /** A stored row whose `at` is the Date `nextEntry` rounded. */
  type BuiltEntry = ChainEntry & { at: Date };

  const TAMPERED_FIELDS = ['detail', 'action', 'actor_user_id', 'seq', 'at', 'prev_hash', 'entry_hash'] as const;
  const UPPER_HEX = fc.constantFrom(...'0123456789ABCDEF');
  const hexGroup = (length: number): fc.Arbitrary<string> => fc.string({ unit: UPPER_HEX, minLength: length, maxLength: length });
  const CF_UUID = fc.tuple(hexGroup(8), hexGroup(4), hexGroup(4), hexGroup(16)).map((groups) => groups.join('-'));
  const APPEND: fc.Arbitrary<NextEntryInput> = fc.record({
    requestId: fc.constant(VECTOR_REQUEST_ID),
    action: fc.constantFrom('created', 'viewed', 'signed', 'declined', 'voided'),
    actorUserId: CF_UUID,
    detail: fc.option(fc.string({ unit: 'grapheme' }), { nil: null }),
    at: AT_2026,
  });
  const APPENDS = fc.array(APPEND, { minLength: 1, maxLength: 12 });

  /** The stored row of an appended entry: the procedure's derived columns plus the caller's parameters. */
  function toChainEntry(next: NextEntry, input: NextEntryInput): BuiltEntry {
    return {
      entry_id: `ABCDEF01-2345-6789-${next.seq.toString(16).toUpperCase().padStart(16, '0')}`,
      request_id: input.requestId,
      seq: next.seq,
      action: input.action,
      actor_user_id: input.actorUserId,
      detail: input.detail,
      at: next.at,
      prev_hash: next.prev_hash,
      entry_hash: next.entry_hash,
    };
  }

  /** The chain `nextEntry` builds by appending `inputs` in order from an empty chain. */
  function buildChain(inputs: readonly NextEntryInput[]): BuiltEntry[] {
    const chain: BuiltEntry[] = [];
    for (const input of inputs) chain.push(toChainEntry(nextEntry(chain.at(-1) ?? null, input), input));
    return chain;
  }

  /** `text` with the UTF-16 code unit at `position` (modulo its length) XOR 1; null when it is NULL or empty. */
  function flipChar(text: string | null, position: number): string | null {
    if (text === null || text.length === 0) return null;
    const at = position % text.length;
    return text.slice(0, at) + String.fromCharCode(text.charCodeAt(at) ^ 1) + text.slice(at + 1);
  }

  /** A copy of `hash` with bit `bit` of byte `position` (modulo its length) flipped. */
  function flipBit(hash: Buffer, position: number, bit: number): Buffer {
    const copy = Buffer.from(hash);
    const at = position % copy.length;
    copy.writeUInt8(copy.readUInt8(at) ^ (1 << bit), at);
    return copy;
  }

  /** `entry` with one character, bit, seq bit or second of `field` changed; null when the field has nothing to flip. */
  function tamper(entry: BuiltEntry, field: (typeof TAMPERED_FIELDS)[number], position: number, bit: number): BuiltEntry | null {
    switch (field) {
      case 'detail': {
        const detail = flipChar(entry.detail, position);
        return detail === null ? null : { ...entry, detail };
      }
      case 'action': {
        const action = flipChar(entry.action, position);
        return action === null ? null : { ...entry, action };
      }
      case 'actor_user_id': {
        const actor = flipChar(entry.actor_user_id, position);
        return actor === null ? null : { ...entry, actor_user_id: actor };
      }
      case 'seq':
        return { ...entry, seq: entry.seq ^ 1 };
      case 'at':
        return { ...entry, at: new Date(entry.at.getTime() + 1000) };
      case 'prev_hash':
        return { ...entry, prev_hash: flipBit(entry.prev_hash, position, bit) };
      case 'entry_hash':
        return { ...entry, entry_hash: flipBit(entry.entry_hash, position, bit) };
    }
  }

  it('verifies every chain nextEntry builds, counting each entry', () => {
    fc.assert(
      fc.property(APPENDS, (inputs) => {
        const chain = buildChain(inputs);
        expect(chain.map((entry) => entry.seq)).toEqual(inputs.map((_, index) => index + 1));
        expect(verifyChain(chain)).toEqual({ valid: true, entries: chain.length, brokenat: 0 });
      }),
      RUNS,
    );
  });

  it('breaks a built chain at the seq the entry carries once one hashed field or stored hash is flipped', () => {
    fc.assert(
      fc.property(
        APPENDS,
        fc.nat(),
        fc.constantFrom(...TAMPERED_FIELDS),
        fc.nat(),
        fc.integer({ min: 0, max: 7 }),
        (inputs, pick, field, position, bit) => {
          const chain = buildChain(inputs);
          const index = pick % chain.length;
          const tampered = tamper(chain[index] as BuiltEntry, field, position, bit);
          fc.pre(tampered !== null);
          chain[index] = tampered;
          expect(verifyChain(chain)).toEqual({ valid: false, entries: chain.length, brokenat: tampered.seq });
        },
      ),
      RUNS,
    );
  });
});
