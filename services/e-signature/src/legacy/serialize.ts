// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture row projections: target `esignature` rows as esignature.cfc's `envelope.rows()` renders the `synthetic.*` rows. */
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { canonicalAt, hashToHex, type VerifyResult } from '../domain/hash-chain.js';
import type { AuditEntryRow, RequestState, SignatureRequestMetadataRow, SignatureRow } from '../repo/tables.js';

// envelope.cfc rows() renders datetime columns with this dateTimeFormat mask before serialization, not through the serializer's date hint.
const FIXTURE_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss";

// The fixture audit query selects both hashes as LOWER(CONVERT(varchar(64), hash, 2)).
const FIXTURE_HASH_CASE = 'lower';

/** A `signature_request` row without its document bytes: lower-cased column names in catalog order. */
export type FixtureRequest = {
  request_id: string;
  siteid: string;
  document_name: string;
  document_sha256: string;
  signer_user_id: string;
  state: RequestState;
  created: string;
  createdbyid: string;
};

/** A `signature` row: lower-cased column names in catalog order. */
export type FixtureSignature = {
  signature_id: string;
  request_id: string;
  typed_name: string;
  signer_user_id: string;
  signed_at: string;
};

/** An `audit_entry` row as the fixture audit route lists it: `at` as the hashed text, hashes as lowercase hex, NULL as ''. */
export type FixtureAuditEntry = {
  entry_id: string;
  request_id: string;
  seq: number;
  action: string;
  actor_user_id: string;
  detail: string;
  at: string;
  prev_hash: string;
  entry_hash: string;
};

/** The fixture verify verdict; `brokenat` is 0 when `valid`. */
export type FixtureVerifyResult = {
  valid: boolean;
  entries: number;
  brokenat: number;
};

/** Fixture text of a stored datetime in the process (legacy server) zone. */
function timestamp(value: Date): string {
  return cfDateTimeFormat(value, FIXTURE_TIMESTAMP_MASK);
}

/** Projects an `esignature.signature_request` row, with or without its document, onto the fixture request fields. */
export function requestRow(row: SignatureRequestMetadataRow): FixtureRequest {
  return {
    request_id: row.request_id,
    siteid: row.siteid,
    document_name: row.document_name,
    document_sha256: row.document_sha256,
    signer_user_id: row.signer_user_id,
    state: row.state,
    created: timestamp(row.created),
    createdbyid: row.createdbyid,
  };
}

/** Projects an `esignature.signature` row onto the fixture signature fields. */
export function signatureRow(row: SignatureRow): FixtureSignature {
  return {
    signature_id: row.signature_id,
    request_id: row.request_id,
    typed_name: row.typed_name,
    signer_user_id: row.signer_user_id,
    signed_at: timestamp(row.signed_at),
  };
}

// The fixture audit route answers its own SELECT, not usp_audit_append's result set, so there are no
// prev_hash_hex/entry_hash_hex keys and the hash columns carry the hex text itself.
/** Projects an `esignature.audit_entry` row onto the audit entry the fixture lists and accepts back for verification. */
export function auditRow(row: AuditEntryRow): FixtureAuditEntry {
  return {
    entry_id: row.entry_id,
    request_id: row.request_id,
    seq: row.seq,
    action: row.action,
    actor_user_id: row.actor_user_id ?? '',
    detail: row.detail ?? '',
    at: canonicalAt(row.at),
    prev_hash: hashToHex(row.prev_hash, FIXTURE_HASH_CASE),
    entry_hash: hashToHex(row.entry_hash, FIXTURE_HASH_CASE),
  };
}

/** Projects a chain verdict onto the fixture verdict, keys in the fixture's order. */
export function verifyResult(result: VerifyResult): FixtureVerifyResult {
  return { valid: result.valid, entries: result.entries, brokenat: result.brokenat };
}
