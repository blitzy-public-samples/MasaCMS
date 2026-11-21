// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture row projections against the rows esignature.cfc renders through `envelope.rows()`, and a fixture list answer carrying them. */
import { describe, expect, it } from 'vitest';
import { createApiSerializer, etag, formatSerializerDate, isCfUuid, legacyHeaders } from '@opt2/platform/legacy-compat';
import { TENANT_A } from '@opt2/platform/testing';
import { hashFromHex, verifyChain, type ChainEntry, type VerifyResult } from '../../src/domain/hash-chain.js';
import { auditRow, requestRow, signatureRow, verifyResult } from '../../src/legacy/serialize.js';
import type { AuditEntryRow, SignatureRequestMetadataRow, SignatureRequestRow, SignatureRow } from '../../src/repo/tables.js';
import { buildTestApp } from '../helpers/app.js';
import { headersFor } from '../helpers/tokens.js';
import { CHAIN_VECTORS, VECTOR_REQUEST_ID, chainEntries, type ChainVector } from '../helpers/vectors.js';

const REQUEST_ID = 'A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D';
const SIGNER_ID = 'E1000000-AAAA-BBBB-0000000000000001';
const SIGNATURE_ID = '11111111-2222-3333-4444555566667777';
const TENANT_ID = TENANT_A.tenantId;
const DOCUMENT_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TARGET_ONLY = ['tenant_id', 'row_version', 'legacy_row_hash', 'document'];
const FIXTURE_REQUESTS_URL = '/legacy-fixtures/cfml/api.cfm/esignature/requests';

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

// The request row the fixture list renders for requestOf(), keys and value forms as envelope.rows() writes them.
const REQUEST_WIRE =
  '{"request_id":"A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D","siteid":"tenant-a","document_name":"contract.pdf",' +
  '"document_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",' +
  '"signer_user_id":"E1000000-AAAA-BBBB-0000000000000001","state":"PENDING","created":"2026-06-30T09:15:00",' +
  '"createdbyid":"E1000000-AAAA-BBBB-0000000000000001"}';

/** CHAIN_VECTORS paired with the stored rows chainEntries() builds for them, in seq order. */
const CHAIN = chainEntries().map((stored, index) => ({ stored, vector: CHAIN_VECTORS[index] as ChainVector }));

type ChainItem = (typeof CHAIN)[number];

/** The chain item of `seq`. */
function chainItem(seq: number): ChainItem {
  const found = CHAIN.find((item) => item.vector.input.seq === seq);
  if (found === undefined) throw new RangeError(`CHAIN_VECTORS has no seq ${String(seq)}`);
  return found;
}

/** The fixture audit route's FORMAT text of a vector's stored `at`: the last field of its canonical text. */
const atTextOf = (v: ChainVector): string => v.canonical.slice(v.canonical.lastIndexOf('|') + 1);

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

/** The stored audit row of a chain item with its target-only columns, hashes parsed from the vector's hex. */
const auditOf = ({ stored, vector }: ChainItem, over: Partial<AuditEntryRow> = {}): AuditEntryRow => ({
  tenant_id: TENANT_ID,
  entry_id: stored.entry_id,
  request_id: stored.request_id,
  seq: stored.seq,
  action: stored.action,
  actor_user_id: stored.actor_user_id,
  detail: stored.detail,
  at: stored.at as Date,
  prev_hash: hashFromHex(vector.prevHex) as Buffer,
  entry_hash: hashFromHex(vector.entryHex) as Buffer,
  row_version: '1',
  ...over,
});

describe('requestRow', () => {
  it('equals the fixture request row, keys in requestColumns order', () => {
    const projected = requestRow(requestOf());
    expect(Object.keys(projected)).toEqual(REQUEST_KEYS);
    expect(FIXTURE_SERIALIZER.serialize(projected)).toBe(REQUEST_WIRE);
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
  it.each(CHAIN.map((item) => [item.vector.input.seq, item] as const))('lists entry %i as the fixture audit SELECT does', (_seq, item) => {
    const projected = auditRow(auditOf(item));
    expect(Object.keys(projected)).toEqual(AUDIT_KEYS);
    expect(projected).toMatchObject({
      entry_id: item.stored.entry_id,
      request_id: VECTOR_REQUEST_ID,
      seq: item.vector.input.seq,
      action: item.vector.input.action,
      at: atTextOf(item.vector),
      prev_hash: item.vector.prevHex,
      entry_hash: item.vector.entryHex,
    });
  });

  it('renders NULL actor and detail as the empty string ACF reads, and seq as a JSON number', () => {
    expect(FIXTURE_SERIALIZER.serialize(auditRow(auditOf(chainItem(2), { actor_user_id: null })))).toBe(
      '{"entry_id":"ABCDEF01-2345-6789-E000000000000002","request_id":"ABCDEF01-2345-6789-ABCDEF0123456789","seq":2,' +
        '"action":"signed","actor_user_id":"","detail":"","at":"2026-06-30T12:00:00.000",' +
        '"prev_hash":"18164a5905ad3555e39d741971514b66c24e3673ecc52c0add4a557efb6f41c0",' +
        '"entry_hash":"11c3c1d38fa8255e7123b53e6987c0b91c070bd813b74b63a5d5f27c5dd8fa8d"}',
    );
  });

  it('keeps a non-ASCII detail byte-exact', () => {
    expect(auditRow(auditOf(chainItem(4))).detail).toBe('Zo\u00eb \u00dcnal \u2013 \u7f72\u540d');
  });

  it('carries the hex in the hash columns, with no usp_audit_append _hex columns', () => {
    const projected = auditRow(auditOf(chainItem(1)));
    expect(projected).toMatchObject({ prev_hash: '0'.repeat(64), entry_hash: '18164a5905ad3555e39d741971514b66c24e3673ecc52c0add4a557efb6f41c0' });
    expect(projected).not.toHaveProperty('prev_hash_hex');
    expect(projected).not.toHaveProperty('entry_hash_hex');
  });

  it('lists a chain whose items post back to verify unchanged as valid', () => {
    const supplied: ChainEntry[] = CHAIN.map((item) => auditRow(auditOf(item))).map((listed) => ({
      ...listed,
      prev_hash: hashFromHex(listed.prev_hash) as Buffer,
      entry_hash: hashFromHex(listed.entry_hash) as Buffer,
    }));
    expect(verifyChain(supplied, 'supplied')).toEqual({ valid: true, entries: CHAIN_VECTORS.length, brokenat: 0 });
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
    ['auditRow', () => auditRow(auditOf(chainItem(1)))],
  ] as const)('%s emits none', (_name, project) => {
    const projected = project();
    for (const key of TARGET_ONLY) expect(projected).not.toHaveProperty(key);
  });
});

describe('fixture request list on the wire', () => {
  it('answers GET requests as a signer with the projected row, the legacy headers and ETag = hash(body)', async () => {
    const { app } = await buildTestApp({ seed: { signature_request: [requestOf()] } });
    try {
      const res = await app.inject({ method: 'GET', url: `${FIXTURE_REQUESTS_URL}?siteid=tenant-a`, headers: await headersFor('esignature.signer') });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(
        `{"apiversion":"v1","method":"esignature.requests","data":{"items":[${REQUEST_WIRE}],` +
          '"startindex":1,"endindex":1,"itemsperpage":50,"totalitems":1,"totalpages":1,"pageindex":1}}',
      );
      expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
      expect({ Generator: res.headers['generator'], 'Strict-Transport-Security': res.headers['strict-transport-security'] }).toStrictEqual(
        legacyHeaders(),
      );
      expect(legacyHeaders()).toStrictEqual({ Generator: 'Masa CMS 7.6.1', 'Strict-Transport-Security': 'max-age=1200' });
      expect(res.headers['etag']).toBe(etag(res.body));
      // ACF 2023 hash() without an algorithm is SHA-256, so the fixture ETag is 64 uppercase hex digits, not MD5.
      expect(res.headers['etag']).toMatch(/^[0-9A-F]{64}$/);
    } finally {
      await app.close();
    }
  });
});
