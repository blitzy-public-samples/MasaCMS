// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture row projections against the rows esignature.cfc renders through `envelope.rows()`. */
import { describe, expect, it } from 'vitest';
import { createApiSerializer, formatSerializerDate, isCfUuid } from '@opt2/platform/legacy-compat';
import { hashFromHex, verifyChain, type ChainEntry, type VerifyResult } from '../../src/domain/hash-chain.js';
import { auditRow, requestRow, signatureRow, verifyResult } from '../../src/legacy/serialize.js';
import type { AuditEntryRow, SignatureRequestMetadataRow, SignatureRequestRow, SignatureRow } from '../../src/repo/tables.js';

const REQUEST_ID = 'A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D';
const SIGNER_ID = 'E1000000-AAAA-BBBB-0000000000000001';
const SIGNATURE_ID = '11111111-2222-3333-4444555566667777';
const TENANT_ID = '0b9a7c1e-2f3d-5a4b-8c6d-7e8f9a0b1c2d';
const DOCUMENT_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ZERO_HEX = '0000000000000000000000000000000000000000000000000000000000000000';
const TARGET_ONLY = ['tenant_id', 'row_version', 'legacy_row_hash', 'document'];

// esignature.cfc requestColumns, lower-cased as the serializer writes struct keys.
const REQUEST_KEYS = ['request_id', 'siteid', 'document_name', 'document_sha256', 'signer_user_id', 'state', 'created', 'createdbyid'];
// The esignature.cfc audit route SELECT list.
const AUDIT_KEYS = ['entry_id', 'request_id', 'seq', 'action', 'actor_user_id', 'detail', 'at', 'prev_hash', 'entry_hash'];

// envelope.cfc serializer hints for the keys these rows carry.
const FIXTURE_SERIALIZER = createApiSerializer([
  { key: 'seq', hint: 'integer' },
  { key: 'entries', hint: 'integer' },
  { key: 'brokenat', hint: 'integer' },
  { key: 'valid', hint: 'boolean' },
]);

/** Three usp_audit_append appends to REQUEST_ID: the stored `at`, its FORMAT text and SQL Server's HASHBYTES result. */
const VECTORS = [
  {
    seq: 1,
    action: 'created',
    actor: SIGNER_ID,
    detail: 'Document contract.pdf',
    at: new Date(2026, 5, 30, 14, 5, 9, 123),
    text: '2026-06-30T14:05:09.123',
    prev: ZERO_HEX,
    hash: 'e1e0dc340483ffb89d5d491e13c90c7354e9a677d0d622e678790971ddddcca7',
  },
  {
    seq: 2,
    action: 'viewed',
    actor: null,
    detail: null,
    at: new Date(2026, 5, 30, 14, 6, 0, 0),
    text: '2026-06-30T14:06:00.000',
    prev: 'e1e0dc340483ffb89d5d491e13c90c7354e9a677d0d622e678790971ddddcca7',
    hash: '879da8b859699d5bbf9f8a173b3f28dd83227e4796ed8a41fcb5479db3dfbd13',
  },
  {
    seq: 3,
    action: 'signed',
    actor: SIGNER_ID,
    detail: 'Zo\u00eb \u00c5ngstr\u00f6m \u2713 \u{1d4a5}',
    at: new Date(2026, 6, 1, 0, 0, 0, 0),
    text: '2026-07-01T00:00:00.000',
    prev: '879da8b859699d5bbf9f8a173b3f28dd83227e4796ed8a41fcb5479db3dfbd13',
    hash: '41bf83c5f636c24f306449e305227a6bee03fba31af520cdfeb810176ef37983',
  },
] as const;

type Vector = (typeof VECTORS)[number];

/** A stored request row with its document bytes and target-only columns. */
const requestOf = (over: Partial<SignatureRequestRow> = {}): SignatureRequestRow => ({
  tenant_id: TENANT_ID,
  request_id: REQUEST_ID,
  siteid: 'tenant-a',
  document_name: 'contract.pdf',
  document_sha256: DOCUMENT_SHA256,
  document: Buffer.from('%PDF-1.7'),
  signer_user_id: SIGNER_ID,
  state: 'PENDING',
  created: new Date(2026, 5, 30, 9, 15, 0, 997),
  createdbyid: SIGNER_ID,
  row_version: '3',
  ...over,
});

/** A stored signature row with its target-only columns. */
const signatureOf = (over: Partial<SignatureRow> = {}): SignatureRow => ({
  tenant_id: TENANT_ID,
  signature_id: SIGNATURE_ID,
  request_id: REQUEST_ID,
  typed_name: 'Zo\u00eb \u00c5ngstr\u00f6m',
  signer_user_id: SIGNER_ID,
  signed_at: new Date(2026, 0, 2, 23, 59, 59, 1),
  row_version: '1',
  ...over,
});

/** The stored audit row of a vector, hashes parsed from the vector's hex. */
const auditOf = (v: Vector): AuditEntryRow => ({
  tenant_id: TENANT_ID,
  entry_id: `D0000000-AAAA-BBBB-${v.seq.toString(16).toUpperCase().padStart(16, '0')}`,
  request_id: REQUEST_ID,
  seq: v.seq,
  action: v.action,
  actor_user_id: v.actor,
  detail: v.detail,
  at: v.at,
  prev_hash: hashFromHex(v.prev) as Buffer,
  entry_hash: hashFromHex(v.hash) as Buffer,
  row_version: '1',
});

describe('requestRow', () => {
  it('equals the fixture request row, keys in requestColumns order', () => {
    const projected = requestRow(requestOf());
    expect(Object.keys(projected)).toEqual(REQUEST_KEYS);
    expect(FIXTURE_SERIALIZER.serialize(projected)).toBe(
      '{"request_id":"A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D","siteid":"tenant-a","document_name":"contract.pdf",' +
        '"document_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",' +
        '"signer_user_id":"E1000000-AAAA-BBBB-0000000000000001","state":"PENDING","created":"2026-06-30T09:15:00",' +
        '"createdbyid":"E1000000-AAAA-BBBB-0000000000000001"}',
    );
    expect(isCfUuid(projected.request_id)).toBe(true);
  });

  it('projects a metadata row, as the read queries return it, exactly as a full row', () => {
    const metadata = Object.fromEntries(Object.entries(requestOf()).filter(([key]) => key !== 'document')) as SignatureRequestMetadataRow;
    expect(requestRow(metadata)).toEqual(requestRow(requestOf()));
  });

  it.each(['PENDING', 'SIGNED'] as const)('passes state %s through', (state) => {
    expect(requestRow(requestOf({ state })).state).toBe(state);
  });

  it.each([
    [new Date(2026, 5, 30, 9, 15, 0, 997), '2026-06-30T09:15:00'],
    [new Date(2026, 11, 31, 23, 59, 59, 999), '2026-12-31T23:59:59'],
    [new Date(2026, 0, 1, 0, 0, 0, 0), '2026-01-01T00:00:00'],
  ])('renders created %s as %s, the legacy serializer date form', (created, wire) => {
    expect(requestRow(requestOf({ created })).created).toBe(wire);
    expect(wire).toBe(formatSerializerDate(created));
  });
});

describe('signatureRow', () => {
  it('equals the signature row in catalog order, typed name byte-exact', () => {
    const projected = signatureRow(signatureOf());
    expect(Object.keys(projected)).toEqual(['signature_id', 'request_id', 'typed_name', 'signer_user_id', 'signed_at']);
    expect(projected).toEqual({
      signature_id: SIGNATURE_ID,
      request_id: REQUEST_ID,
      typed_name: 'Zo\u00eb \u00c5ngstr\u00f6m',
      signer_user_id: SIGNER_ID,
      signed_at: '2026-01-02T23:59:59',
    });
  });
});

describe('auditRow', () => {
  it.each(VECTORS.map((v) => [v.seq, v] as const))('lists entry %i as the fixture audit SELECT does', (_seq, v) => {
    const projected = auditRow(auditOf(v));
    expect(Object.keys(projected)).toEqual(AUDIT_KEYS);
    expect(projected).toMatchObject({ seq: v.seq, action: v.action, at: v.text, prev_hash: v.prev, entry_hash: v.hash });
  });

  it('renders NULL actor and detail as the empty string ACF reads, and seq as a JSON number', () => {
    expect(FIXTURE_SERIALIZER.serialize(auditRow(auditOf(VECTORS[1])))).toBe(
      '{"entry_id":"D0000000-AAAA-BBBB-0000000000000002","request_id":"A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D","seq":2,' +
        '"action":"viewed","actor_user_id":"","detail":"","at":"2026-06-30T14:06:00.000",' +
        '"prev_hash":"e1e0dc340483ffb89d5d491e13c90c7354e9a677d0d622e678790971ddddcca7",' +
        '"entry_hash":"879da8b859699d5bbf9f8a173b3f28dd83227e4796ed8a41fcb5479db3dfbd13"}',
    );
  });

  it('carries the hex in the hash columns, with no usp_audit_append _hex columns', () => {
    const projected = auditRow(auditOf(VECTORS[0]));
    expect(projected).not.toHaveProperty('prev_hash_hex');
    expect(projected).not.toHaveProperty('entry_hash_hex');
  });

  it('lists a chain whose items post back to verify unchanged as valid', () => {
    const supplied: ChainEntry[] = VECTORS.map((v) => auditRow(auditOf(v))).map((item) => ({
      ...item,
      prev_hash: hashFromHex(item.prev_hash) as Buffer,
      entry_hash: hashFromHex(item.entry_hash) as Buffer,
    }));
    expect(verifyChain(supplied, 'supplied')).toEqual({ valid: true, entries: 3, brokenat: 0 });
  });
});

describe('verifyResult', () => {
  it.each([
    [{ valid: true, entries: 3, brokenat: 0 }, '{"valid":true,"entries":3,"brokenat":0}'],
    [{ valid: false, entries: 4, brokenat: 2 }, '{"valid":false,"entries":4,"brokenat":2}'],
    [{ valid: true, entries: 0, brokenat: 0 }, '{"valid":true,"entries":0,"brokenat":0}'],
  ] as const)('renders %j as the fixture verdict', (result, wire) => {
    const reordered: VerifyResult = { brokenat: result.brokenat, entries: result.entries, valid: result.valid };
    expect(Object.keys(verifyResult(reordered))).toEqual(['valid', 'entries', 'brokenat']);
    expect(FIXTURE_SERIALIZER.serialize(verifyResult(reordered))).toBe(wire);
  });
});

describe('target-only columns', () => {
  it.each([
    ['requestRow', () => requestRow(requestOf())],
    ['signatureRow', () => signatureRow(signatureOf())],
    ['auditRow', () => auditRow(auditOf(VECTORS[0]))],
  ] as const)('%s emits none', (_name, project) => {
    const projected = project();
    for (const key of TARGET_ONLY) expect(projected).not.toHaveProperty(key);
  });
});
