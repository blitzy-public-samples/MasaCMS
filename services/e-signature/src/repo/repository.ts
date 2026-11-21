// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The only write path of schema `esignature`: the platform repository plus the request, signature and audit-entry writes. */
import { createRepository, type MigrationHandlerOptions, type Repository, type WriteContext } from '@opt2/platform/migration-kit';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import {
  AUDIT_ENTRY,
  OWNED_TABLES,
  OWNER,
  SIGNATURE,
  SIGNATURE_REQUEST,
  type AuditEntryRow,
  type SignatureRequestRow,
  type SignatureRow,
} from './tables.js';

/** A request to insert; `tenant_id` defaults to the transaction tenant and `row_version` to its column default. */
export type NewSignatureRequest = Omit<SignatureRequestRow, 'tenant_id' | 'row_version'> &
  Partial<Pick<SignatureRequestRow, 'tenant_id' | 'row_version'>>;

/** Columns an update sets on a request; its key and tenant never change. */
export type SignatureRequestChanges = Partial<Omit<SignatureRequestRow, 'tenant_id' | 'request_id'>>;

/** A signature to insert; `tenant_id` defaults to the transaction tenant and `row_version` to its column default. */
export type NewSignature = Omit<SignatureRow, 'tenant_id' | 'row_version'> & Partial<Pick<SignatureRow, 'tenant_id' | 'row_version'>>;

/** An audit entry to insert, with its `seq` and chain hashes already computed by the caller. */
export type NewAuditEntry = Omit<AuditEntryRow, 'tenant_id' | 'row_version'> & Partial<Pick<AuditEntryRow, 'tenant_id' | 'row_version'>>;

/** Domain writes of schema `esignature`; each runs in the caller's open tenant transaction and returns the stored row. */
export interface EsignatureWrites {
  /** Inserts a signature request. */
  insertRequest(tx: TenantTx, row: NewSignatureRequest, ctx?: WriteContext): Promise<SignatureRequestRow>;
  /** Sets `changes` on request `requestId`; null when the transaction tenant has no such request. */
  updateRequest(tx: TenantTx, requestId: string, changes: SignatureRequestChanges, ctx?: WriteContext): Promise<SignatureRequestRow | null>;
  /** Inserts a typed-name signature. */
  insertSignature(tx: TenantTx, row: NewSignature, ctx?: WriteContext): Promise<SignatureRow>;
  /** Inserts one hash-chained audit entry. */
  insertAuditEntry(tx: TenantTx, row: NewAuditEntry, ctx?: WriteContext): Promise<AuditEntryRow>;
}

/** The platform repository of schema `esignature` with its domain writes. */
export type EsignatureRepository = Repository & EsignatureWrites;

/** Settings of `createEsignatureRepository`; `clock` defaults to the system clock. */
export interface EsignatureRepositoryOptions {
  db: TenantDb;
  clock?: Clock;
}

/** Builds the e-signature repository over the platform repository of `OWNED_TABLES`; `src/app.ts` hands it to the migration handlers. */
export function createEsignatureRepository({ db, clock = systemClock }: EsignatureRepositoryOptions): EsignatureRepository {
  // The platform repository requires its schema to equal `tx.schema`: `esignature` in the service, a throwaway name in tests.
  const base = createRepository({ owner: OWNER, schema: db.schema, tables: OWNED_TABLES, clock });

  const repository: EsignatureRepository = {
    ...base,
    insertRequest: (tx, row, ctx) => base.insert<SignatureRequestRow>(tx, SIGNATURE_REQUEST.table, row, ctx),
    updateRequest: (tx, requestId, changes, ctx) =>
      base.update<SignatureRequestRow>(tx, SIGNATURE_REQUEST.table, { request_id: requestId }, changes, ctx),
    insertSignature: (tx, row, ctx) => base.insert<SignatureRow>(tx, SIGNATURE.table, row, ctx),
    insertAuditEntry: (tx, row, ctx) => base.insert<AuditEntryRow>(tx, AUDIT_ENTRY.table, row, ctx),
  };
  return Object.freeze(repository satisfies MigrationHandlerOptions['repository']);
}
