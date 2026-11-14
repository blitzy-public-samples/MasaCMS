// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Signature requests as esignature.cfc handles them: create, typed-name sign, the hash-chained audit append, and the chain reads and verifications. */
import { createHash } from 'node:crypto';
import { LEGACY_ERROR_MAP, cfUuid } from '@opt2/platform/legacy-compat';
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import { registryEntryForTenant, type TenantTx } from '@opt2/platform/tenancy';
import type { PeopleClient } from '../legacy/people-client.js';
import type { EsignatureRepository } from '../repo/repository.js';
import {
  auditChainBatches,
  findRequest,
  findSignature,
  listAuditEntries,
  lockRequest,
  listRequests as queryRequestPage,
  type AuditPage,
  type AuditPaging,
  type RequestPage,
  type RequestPaging,
} from '../repo/queries.js';
import {
  REQUEST_STATES,
  type AuditEntryRow,
  type SignatureRequestMetadataRow,
  type SignatureRequestRow,
  type SignatureRow,
} from '../repo/tables.js';
import { chainVerifier, hashFromHex, nextEntry, roundAt, verifyChain, type ChainEntry, type VerifyResult } from './hash-chain.js';

/** The acting user, the legacy site and the role groups of the request, all taken from the verified token. */
export interface EsignatureActor {
  userId: string;
  siteId: string;
  roles: readonly string[];
}

/** Collaborators of the e-signature domain functions; the routes' dependencies satisfy it. */
export interface EsignatureDomainDeps {
  repository: EsignatureRepository;
  clock: Clock;
  peopleClient: PeopleClient;
}

/** Fields of a new request, validated at the route boundary; `document` holds the decoded document bytes. */
export interface CreateRequestInput {
  documentName: string;
  document: Buffer;
  signerUserId: string;
}

/** A typed-name signature of request `requestId`; `typedName` is stored as sent. */
export interface SignInput {
  requestId: string;
  typedName: string;
}

/** One entry of a supplied chain copy as esignature.cfc reads it: every chain key as text. */
export interface SuppliedAuditEntry {
  seq: string;
  action: string;
  actor_user_id: string;
  detail: string;
  at: string;
  prev_hash: string;
  entry_hash: string;
}

/** The values of one audit append; `seq` and both hashes are derived from the request's last entry. */
export interface AuditAppendInput {
  requestId: string;
  action: string;
  actorUserId: string | null;
  detail: string | null;
  at: Date;
}

/** A created request and its first audit entry. */
export interface CreatedRequest {
  request: SignatureRequestRow;
  audit: AuditEntryRow;
}

/** A signed request, its signature and the audit entry appended with it. */
export interface SignedRequest {
  request: SignatureRequestRow;
  signature: SignatureRow;
  audit: AuditEntryRow;
}

/** A request with its signature, null while it is PENDING. */
export interface RequestDetail {
  request: SignatureRequestMetadataRow;
  signature: SignatureRow | null;
}

/** Audit `action` values esignature.cfc appends. */
export const AUDIT_ACTIONS = Object.freeze({ created: 'created', signed: 'signed' } as const);

/** One audit action esignature.cfc appends. */
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Fixture envelope error types the domain raises. */
export type EsignatureErrorType = 'invalidParameters' | 'forbidden' | 'notFound' | 'conflict';

/** Message esignature.cfc raises with `conflict` when the request is no longer PENDING. */
export const ALREADY_SIGNED_MESSAGE = 'already-signed';

// envelope.cfc fail() answers the type's map message whenever raise() passed none.
const DEFAULT_MESSAGES: Readonly<Record<EsignatureErrorType, string>> = Object.freeze({
  invalidParameters: LEGACY_ERROR_MAP.invalidParameters.message,
  forbidden: 'Insufficient Account Permissions',
  notFound: 'Not Found',
  conflict: 'Conflict',
});

/** An esignature.cfc error of `type` carrying the message its envelope answers; `legacy/envelope.ts` renders it. */
export class EsignatureDomainError extends Error {
  override readonly name = 'EsignatureDomainError';

  /** `message` as `envelope.raise(type, message)` takes it: empty means the type's default. */
  constructor(
    readonly type: EsignatureErrorType,
    message = '',
  ) {
    super(message === '' ? DEFAULT_MESSAGES[type] : message);
  }
}

const [PENDING, SIGNED] = REQUEST_STATES;
const USER_TYPE = 2;
// The fixture role group whose holders read every request of the site, as auth.cfc rolesHeld() names it.
const AUDITOR_ROLE = 'esignature.auditor';
// nvarchar(255) of typed_name, measured in UTF-16 code units as CFML len() measures it.
const MAX_TYPED_NAME_LENGTH = 255;
// What esignature.cfc strips before deciding that a typed name is blank.
const INVISIBLE_CHARACTERS = /[\p{Z}\p{Cf}\p{Cc}]/gu;
const SUPPLIED_SEQ = /^[1-9][0-9]{0,8}$/;
const SUPPLIED_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/;

/** Provenance of a domain write by `actor`. */
function writeContext(actor: EsignatureActor): WriteContext {
  return { actorUserId: actor.userId };
}

/** CFML `compareNoCase(a, b) == 0` over Masa user ids. */
function sameUserId(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** A pool id as settingsBean reads it: empty means the site's own. */
function poolOrOwn(poolId: string | null, ownSiteId: string): string {
  return poolId === null || poolId === '' ? ownSiteId : poolId;
}

/** True when `userSiteId` is the public or private user pool of the transaction tenant's site. */
async function inUserPools(tx: TenantTx, actorSiteId: string, userSiteId: string): Promise<boolean> {
  const entry = await registryEntryForTenant(tx, tx.tenantId);
  const own = entry?.siteId ?? actorSiteId;
  const pools = [poolOrOwn(entry?.publicUserPoolId ?? null, own), poolOrOwn(entry?.privateUserPoolId ?? null, own)];
  return pools.some((pool) => pool.toLowerCase() === userSiteId.toLowerCase());
}

/** The stored UserID of a Type 2 user of the site's public or private user pool, as esignature.cfc poolUserId resolves it; throws `invalidParameters` otherwise. */
async function poolUserId(tx: TenantTx, deps: EsignatureDomainDeps, actor: EsignatureActor, userId: string): Promise<string> {
  const person = await deps.peopleClient.readPerson(actor.siteId, userId);
  // People also finds users stored under the site's own id, which is not always one of its pools, so membership is checked here.
  if (person === null || person.type !== USER_TYPE || !(await inUserPools(tx, actor.siteId, person.siteId))) {
    throw new EsignatureDomainError('invalidParameters');
  }
  return person.userId;
}

/** Inserts the entry `synthetic.usp_audit_append` appends after `last`, the request's highest-`seq` entry or null before the first. */
function appendAfter(
  tx: TenantTx,
  deps: EsignatureDomainDeps,
  last: AuditEntryRow | null,
  input: AuditAppendInput,
  ctx: WriteContext,
): Promise<AuditEntryRow> {
  const next = nextEntry(last, input);
  return deps.repository.insertAuditEntry(
    tx,
    {
      tenant_id: tx.tenantId,
      entry_id: cfUuid(),
      request_id: input.requestId,
      seq: next.seq,
      action: input.action,
      actor_user_id: input.actorUserId,
      detail: input.detail,
      at: next.at,
      prev_hash: next.prev_hash,
      entry_hash: next.entry_hash,
    },
    ctx,
  );
}

/**
 * Creates a PENDING request for a pool user and appends its `created` entry, whose detail is the document SHA-256.
 * Throws `invalidParameters` when the signer is not a Type 2 user of the site's user pools.
 */
export async function createSignatureRequest(
  tx: TenantTx,
  deps: EsignatureDomainDeps,
  input: CreateRequestInput,
  actor: EsignatureActor,
): Promise<CreatedRequest> {
  const signerUserId = await poolUserId(tx, deps, actor, input.signerUserId);
  const documentSha256 = createHash('sha256').update(input.document).digest('hex');
  const now = roundAt(deps.clock.now());
  const ctx = writeContext(actor);
  const request = await deps.repository.insertRequest(
    tx,
    {
      tenant_id: tx.tenantId,
      request_id: cfUuid(),
      siteid: actor.siteId,
      document_name: input.documentName,
      document_sha256: documentSha256,
      document: input.document,
      signer_user_id: signerUserId,
      state: PENDING,
      created: now,
      createdbyid: actor.userId,
    },
    ctx,
  );
  // The request was inserted with a fresh id in this transaction, so it has no entry to lock or read before its first.
  const audit = await appendAfter(
    tx,
    deps,
    null,
    { requestId: request.request_id, action: AUDIT_ACTIONS.created, actorUserId: actor.userId, detail: documentSha256, at: now },
    ctx,
  );
  return { request, audit };
}

/**
 * Signs request `input.requestId` as its signer and appends its `signed` entry, whose detail is the typed name.
 * Throws, in esignature.cfc order: `notFound`, `forbidden` for another user, `invalidParameters` for a blank or
 * over-long typed name, then `conflict` with `already-signed` once the request is SIGNED.
 */
export async function signRequest(tx: TenantTx, deps: EsignatureDomainDeps, input: SignInput, actor: EsignatureActor): Promise<SignedRequest> {
  const locked = await lockRequest(tx, input.requestId);
  if (locked === null) throw new EsignatureDomainError('notFound');
  if (!sameUserId(locked.request.signer_user_id, actor.userId)) throw new EsignatureDomainError('forbidden');
  if (input.typedName.replace(INVISIBLE_CHARACTERS, '') === '' || input.typedName.length > MAX_TYPED_NAME_LENGTH) {
    throw new EsignatureDomainError('invalidParameters');
  }
  if (locked.request.state !== PENDING) throw new EsignatureDomainError('conflict', ALREADY_SIGNED_MESSAGE);

  const now = roundAt(deps.clock.now());
  const ctx = writeContext(actor);
  const requestId = locked.request.request_id;
  const request = await deps.repository.updateRequest(tx, requestId, { state: SIGNED }, ctx);
  if (request === null) throw new EsignatureDomainError('notFound');
  const signature = await deps.repository.insertSignature(
    tx,
    {
      tenant_id: tx.tenantId,
      signature_id: cfUuid(),
      request_id: requestId,
      typed_name: input.typedName,
      signer_user_id: actor.userId,
      signed_at: now,
    },
    ctx,
  );
  const audit = await appendAfter(
    tx,
    deps,
    locked.last,
    { requestId, action: AUDIT_ACTIONS.signed, actorUserId: actor.userId, detail: input.typedName, at: now },
    ctx,
  );
  return { request, signature, audit };
}

/** Appends one hash-chained entry to request `input.requestId` under its row lock, as `synthetic.usp_audit_append` does; throws `notFound` for a missing request. */
export async function appendAuditEntry(tx: TenantTx, deps: EsignatureDomainDeps, input: AuditAppendInput): Promise<AuditEntryRow> {
  const locked = await lockRequest(tx, input.requestId);
  if (locked === null) throw new EsignatureDomainError('notFound');
  const ctx: WriteContext = input.actorUserId === null ? {} : { actorUserId: input.actorUserId };
  return appendAfter(tx, deps, locked.last, { ...input, requestId: locked.request.request_id }, ctx);
}

/** Request `id` for an auditor, or for a signer who is its signer; throws `notFound`, then `forbidden`, as esignature.cfc authorizeChainReader does. */
export async function authorizeRequestReader(tx: TenantTx, id: string, actor: EsignatureActor): Promise<SignatureRequestMetadataRow> {
  const request = await findRequest(tx, id);
  if (request === null) throw new EsignatureDomainError('notFound');
  if (!actor.roles.includes(AUDITOR_ROLE) && !sameUserId(request.signer_user_id, actor.userId)) {
    throw new EsignatureDomainError('forbidden');
  }
  return request;
}

/** Request `id` with its signature, for the readers `authorizeRequestReader` admits. */
export async function getRequest(tx: TenantTx, id: string, actor: EsignatureActor): Promise<RequestDetail> {
  const request = await authorizeRequestReader(tx, id, actor);
  return { request, signature: await findSignature(tx, request.request_id) };
}

/** One page of the tenant's requests by `created`, then id, with the count of all of them. */
export function listRequests(tx: TenantTx, paging: RequestPaging): Promise<RequestPage> {
  return queryRequestPage(tx, paging);
}

/** One page of request `id`'s audit entries by `seq`, with their total, for the readers `authorizeRequestReader` admits. */
export async function getAuditChain(tx: TenantTx, id: string, paging: AuditPaging, actor: EsignatureActor): Promise<AuditPage> {
  const request = await authorizeRequestReader(tx, id, actor);
  return listAuditEntries(tx, request.request_id, paging);
}

/** Recomputes request `id`'s stored chain in `seq` order, for the readers `authorizeRequestReader` admits. */
export async function verifyStored(tx: TenantTx, id: string, actor: EsignatureActor): Promise<VerifyResult> {
  const request = await authorizeRequestReader(tx, id, actor);
  const verifier = chainVerifier('stored');
  for await (const batch of auditChainBatches(tx, request.request_id)) {
    verifier.push(batch);
  }
  return verifier.result();
}

/** A supplied entry as the chain entry hashed against `requestId`; throws `invalidParameters` for a seq, at or hash esignature.cfc rejects. */
function suppliedChainEntry(requestId: string, entry: SuppliedAuditEntry): ChainEntry {
  const prevHash = hashFromHex(entry.prev_hash);
  const entryHash = hashFromHex(entry.entry_hash);
  if (!SUPPLIED_SEQ.test(entry.seq) || !SUPPLIED_AT.test(entry.at) || prevHash === null || entryHash === null) {
    throw new EsignatureDomainError('invalidParameters');
  }
  return {
    entry_id: '',
    request_id: requestId,
    seq: Number(entry.seq),
    action: entry.action,
    actor_user_id: entry.actor_user_id,
    detail: entry.detail,
    at: entry.at,
    prev_hash: prevHash,
    entry_hash: entryHash,
  };
}

/**
 * Recomputes a supplied chain copy in array order against `request`, the stored request `authorizeRequestReader` returned,
 * whose stored id esignature.cfc hashes in place of any id the copy carries. Throws `invalidParameters` for a malformed entry.
 */
export function verifySupplied(request: Pick<SignatureRequestMetadataRow, 'request_id'>, entries: readonly SuppliedAuditEntry[]): VerifyResult {
  return verifyChain(
    entries.map((entry) => suppliedChainEntry(request.request_id, entry)),
    'supplied',
  );
}
