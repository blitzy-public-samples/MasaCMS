// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Owned tables of schema `esignature`, one per fixture table `synthetic.<table>`, as the platform repository declares them. */
import type { CanonicalColumn, TableDefinition } from '@opt2/platform/migration-kit';

/** Service name carried by e-signature write positions and changelog rows. */
export const OWNER = 'e-signature' as const;

/** PostgreSQL schema owned by the e-signature service. */
export const SCHEMA = 'esignature' as const;

/** Units of write authority of schema `esignature`, as `opt2/table-ownership.json` names them, parent request first. */
export const UNITS = Object.freeze(['esignature.signature_request', 'esignature.signature', 'esignature.audit_entry'] as const);

/** One e-signature unit id. */
export type EsignatureUnit = (typeof UNITS)[number];

/** Values of `signature_request.state`; a new request is `PENDING`. */
export const REQUEST_STATES = Object.freeze(['PENDING', 'SIGNED'] as const);

/** One signature request state. */
export type RequestState = (typeof REQUEST_STATES)[number];

/** A gated e-signature table definition: always keyed, and its unit is `U`. */
export interface EsignatureTableDefinition<U extends EsignatureUnit = EsignatureUnit> extends TableDefinition {
  key: string[];
  unit: U;
}

// The platform repository rejects a definition without tenant_id and refuses undeclared columns,
// so the target-only tenant_id and row_version are declared beside the fixture columns.
const TENANT_ID: CanonicalColumn = { name: 'tenant_id', type: 's' };
const ROW_VERSION: CanonicalColumn = { name: 'row_version', type: 'i' };

/** Deep-freezes `def` so no consumer can change the shared catalogue. */
function frozen<T extends TableDefinition & { key: string[] }>(def: T): Readonly<T> {
  def.columns.forEach((column) => Object.freeze(column));
  Object.freeze(def.columns);
  Object.freeze(def.key);
  return Object.freeze(def);
}

/** `esignature.signature_request`, from `synthetic.signature_request`; `document` holds the document bytes. */
export const SIGNATURE_REQUEST = frozen<EsignatureTableDefinition<'esignature.signature_request'>>({
  table: 'signature_request',
  columns: [
    TENANT_ID,
    { name: 'request_id', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'document_name', type: 's' },
    { name: 'document_sha256', type: 's' },
    { name: 'document', type: 'b' },
    { name: 'signer_user_id', type: 's' },
    { name: 'state', type: 's' },
    { name: 'created', type: 't' },
    { name: 'createdbyid', type: 's' },
    ROW_VERSION,
  ],
  key: ['request_id'],
  unit: 'esignature.signature_request',
});

/** `esignature.signature`, from `synthetic.signature`: the typed-name signature, at most one per request. */
export const SIGNATURE = frozen<EsignatureTableDefinition<'esignature.signature'>>({
  table: 'signature',
  columns: [
    TENANT_ID,
    { name: 'signature_id', type: 's' },
    { name: 'request_id', type: 's' },
    { name: 'typed_name', type: 's' },
    { name: 'signer_user_id', type: 's' },
    { name: 'signed_at', type: 't' },
    ROW_VERSION,
  ],
  key: ['signature_id'],
  unit: 'esignature.signature',
});

/** `esignature.audit_entry`, from `synthetic.audit_entry`: one SHA-256 hash-chained entry per request and `seq`. */
export const AUDIT_ENTRY = frozen<EsignatureTableDefinition<'esignature.audit_entry'>>({
  table: 'audit_entry',
  columns: [
    TENANT_ID,
    { name: 'entry_id', type: 's' },
    { name: 'request_id', type: 's' },
    { name: 'seq', type: 'i' },
    { name: 'action', type: 's' },
    { name: 'actor_user_id', type: 's' },
    { name: 'detail', type: 's' },
    { name: 'at', type: 't' },
    { name: 'prev_hash', type: 'b' },
    { name: 'entry_hash', type: 'b' },
    ROW_VERSION,
  ],
  key: ['entry_id'],
  unit: 'esignature.audit_entry',
});

/** Table definitions position for position with the unit tuple `T`. */
type TablesForUnits<T extends readonly EsignatureUnit[]> = { readonly [I in keyof T]: EsignatureTableDefinition<T[I]> };

/** Every owned unit table, in `UNITS` order; the `tables` of the e-signature repository. */
export const OWNED_TABLES: TablesForUnits<typeof UNITS> = Object.freeze([SIGNATURE_REQUEST, SIGNATURE, AUDIT_ENTRY] as const);

// Row shapes are type aliases, not interfaces, so they stay assignable to the repository's Record<string, unknown> rows.

/** An `esignature.signature_request` row as pg returns it; the int8 `row_version` is a decimal string. */
export type SignatureRequestRow = {
  tenant_id: string;
  request_id: string;
  siteid: string;
  document_name: string;
  document_sha256: string;
  document: Buffer | null;
  signer_user_id: string;
  state: RequestState;
  created: Date;
  createdbyid: string;
  row_version: string;
};

/** A request row without its document bytes, as the fixture's request columns read it. */
export type SignatureRequestMetadataRow = Omit<SignatureRequestRow, 'document'>;

/** An `esignature.signature` row as pg returns it. */
export type SignatureRow = {
  tenant_id: string;
  signature_id: string;
  request_id: string;
  typed_name: string;
  signer_user_id: string;
  signed_at: Date;
  row_version: string;
};

/** An `esignature.audit_entry` row as pg returns it; both hashes are 32 bytes. */
export type AuditEntryRow = {
  tenant_id: string;
  entry_id: string;
  request_id: string;
  seq: number;
  action: string;
  actor_user_id: string | null;
  detail: string | null;
  at: Date;
  prev_hash: Buffer;
  entry_hash: Buffer;
  row_version: string;
};
