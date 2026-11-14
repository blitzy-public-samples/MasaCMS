// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature domain functions against a throwaway `esignature` schema, held to the errors, actions and verdicts of esignature.cfc. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { tenantIdForSite, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, fixedClock, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  ALREADY_SIGNED_MESSAGE,
  AUDIT_ACTIONS,
  EsignatureDomainError,
  appendAuditEntry,
  authorizeRequestReader,
  createSignatureRequest,
  getAuditChain,
  getRequest,
  listRequests,
  signRequest,
  verifyStored,
  verifySupplied,
  type CreatedRequest,
  type EsignatureActor,
  type EsignatureDomainDeps,
  type EsignatureErrorType,
  type SignedRequest,
  type SuppliedAuditEntry,
} from '../../src/domain/signing.js';
import type { PeopleClient, PersonSummary } from '../../src/legacy/people-client.js';
import { auditRow } from '../../src/legacy/serialize.js';
import { createEsignatureRepository } from '../../src/repo/repository.js';
import { UNITS, type AuditEntryRow } from '../../src/repo/tables.js';

/** envelope.cfc error map messages of the types esignature.cfc raises. */
const MESSAGES: Readonly<Record<EsignatureErrorType, string>> = {
  invalidParameters: 'Invalid parameters',
  forbidden: 'Insufficient Account Permissions',
  notFound: 'Not Found',
  conflict: 'Conflict',
};

const SIGNER_ROLE = 'esignature.signer';
const AUDITOR_ROLE = 'esignature.auditor';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const NOW = new Date(2026, 5, 30, 14, 5, 9, 124);
const STORED_AT = new Date(2026, 5, 30, 14, 5, 9, 123);
const AT_TEXT = '2026-06-30T14:05:09.123';
const DOCUMENT = Buffer.from('%PDF-1.7 synthetic signing contract');
const DOCUMENT_SHA256 = createHash('sha256').update(DOCUMENT).digest('hex');
const LIST_SITE = 'esignature-domain-list';
const LIST_TENANT = tenantIdForSite(LIST_SITE);

/** A CF-format Masa UserID ending in `n`. */
const userId = (n: number): string => `E5160000-0000-0000-${n.toString(16).toUpperCase().padStart(16, '0')}`;

/** A people pool-user read result of type `type` stored under `siteId`. */
const person = (n: number, siteId: string, type = 2): PersonSummary => ({ userId: userId(n), siteId, type });

const SIGNER = person(1, TENANT_A.siteId);
const POOL_SIGNER = person(2, TENANT_UMBRELLA.siteId);
const AUDITOR_ID = userId(3);
const OTHER = person(4, TENANT_A.siteId);
const GROUP = person(5, TENANT_A.siteId, 1);
const OUTSIDER = person(6, TENANT_B.siteId);
const B_SIGNER = person(7, TENANT_B.siteId);
const LIST_SIGNER = person(8, LIST_SITE);
const UPPER_SITE_SIGNER = person(9, TENANT_A.siteId.toUpperCase());
const UNKNOWN_ID = userId(0xfff);

/** An actor of `siteId` holding `roles`. */
const actor = (id: string, siteId: string = TENANT_A.siteId, roles: readonly string[] = [SIGNER_ROLE]): EsignatureActor => ({ userId: id, siteId, roles });

/** A people reader answering from `persons` by user id, case-insensitively, recording each `[siteId, userId]` read. */
function fakePeople(persons: readonly PersonSummary[]): PeopleClient & { reads: [string, string][] } {
  const reads: [string, string][] = [];
  return {
    reads,
    readPerson: (siteId, id) => {
      reads.push([siteId, id]);
      return Promise.resolve(persons.find((candidate) => candidate.userId.toUpperCase() === id.toUpperCase()) ?? null);
    },
  };
}

/** SHA-256 of `prev` and the UTF-16LE `request_id|seq|action|actor|detail|at` text usp_audit_append hashes. */
function procedureHash(prev: Buffer, parts: readonly [string, number, string, string, string, string]): Buffer {
  return createHash('sha256').update(prev).update(Buffer.from(parts.join('|'), 'utf16le')).digest();
}

/** The audit route's listing of `rows`, as a caller posts it back to verify. */
function suppliedCopy(rows: readonly AuditEntryRow[]): SuppliedAuditEntry[] {
  return rows.map((row) => {
    const { seq, action, actor_user_id, detail, at, prev_hash, entry_hash } = auditRow(row);
    return { seq: String(seq), action, actor_user_id, detail, at, prev_hash, entry_hash };
  });
}

/** Asserts that `promise` rejects with the esignature.cfc error `type` carrying `message`. */
async function expectDomainError(promise: Promise<unknown>, type: EsignatureErrorType, message: string = MESSAGES[type]): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(EsignatureDomainError);
  expect(error).toMatchObject({ type, message });
}

describe('EsignatureDomainError', () => {
  it.each(Object.entries(MESSAGES) as [EsignatureErrorType, string][])('answers %s raised without a message with the envelope.cfc message %s', (type, message) => {
    const error = new EsignatureDomainError(type);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'EsignatureDomainError', type, message });
  });

  it('keeps the message it was raised with, as conflict already-signed', () => {
    expect(ALREADY_SIGNED_MESSAGE).toBe('already-signed');
    expect(new EsignatureDomainError('conflict', ALREADY_SIGNED_MESSAGE)).toMatchObject({ type: 'conflict', message: 'already-signed' });
  });
});

describe('AUDIT_ACTIONS', () => {
  it('names the created and signed actions esignature.cfc appends, frozen', () => {
    expect(AUDIT_ACTIONS).toEqual({ created: 'created', signed: 'signed' });
    expect(Object.isFrozen(AUDIT_ACTIONS)).toBe(true);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('e-signature signing domain against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let deps: EsignatureDomainDeps;
  const people = fakePeople([SIGNER, POOL_SIGNER, OTHER, GROUP, OUTSIDER, B_SIGNER, LIST_SIGNER, UPPER_SITE_SIGNER]);

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'e-signature',
      schemaName: 'esignature',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await closeGates(handle.app, { units: UNITS, holderId: 'signing-domain-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'signing-domain-test', state: 'open' });
    await seedRegistry(handle.app);
    deps = { repository: createEsignatureRepository({ db: handle.app, clock: fixedClock(NOW) }), clock: fixedClock(NOW), peopleClient: people };
  });

  afterAll(async () => {
    await handle?.drop();
  });

  /** Runs `fn` in a gated transaction of `tenantId`, as the routes do. */
  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenantId: string = TENANT_A.tenantId): Promise<T> {
    return withGatedTenant(handle.app, tenantId, fn);
  }

  /** Creates a request of DOCUMENT for `signerUserId` as `creator`, in the creator's tenant. */
  function create(signerUserId: string = SIGNER.userId, creator: EsignatureActor = actor(OTHER.userId), clock = deps.clock): Promise<CreatedRequest> {
    return inTenant(
      (tx) => createSignatureRequest(tx, { ...deps, clock }, { documentName: 'contract.pdf', document: DOCUMENT, signerUserId }, creator),
      tenantIdForSite(creator.siteId),
    );
  }

  /** A request of SIGNER signed by SIGNER as `typedName`. */
  async function createSigned(typedName = 'Jane Doe'): Promise<SignedRequest & { created: AuditEntryRow }> {
    const { request, audit } = await create();
    const signed = await inTenant((tx) => signRequest(tx, deps, { requestId: request.request_id, typedName }, actor(SIGNER.userId)));
    return { ...signed, created: audit };
  }

  /** `[op, table, actor_user_id]` of the changelog rows the open transaction wrote. */
  async function written(tx: TenantTx): Promise<unknown[][]> {
    const { rows } = await tx.query<{ op: string; table: string; actor_user_id: string | null }>(
      `SELECT op, "table", actor_user_id FROM ${handle.schema}.changelog WHERE xid = pg_current_xact_id() ORDER BY seq`,
    );
    return rows.map((row) => [row.op, row.table, row.actor_user_id]);
  }

  /** The number of requests tenant-a holds. */
  async function tenantARequests(): Promise<number> {
    return (await inTenant((tx) => listRequests(tx, { pageIndex: 1, itemsPerPage: 1 }))).total;
  }

  describe('createSignatureRequest', () => {
    it('creates a PENDING request with a CF UUID and appends its created entry on the genesis hash, logging both writes as the actor', async () => {
      const reads = people.reads.length;
      const { created, log } = await inTenant(async (tx) => {
        const result = await createSignatureRequest(
          tx,
          deps,
          { documentName: 'contract.pdf', document: DOCUMENT, signerUserId: SIGNER.userId.toLowerCase() },
          actor(OTHER.userId),
        );
        return { created: result, log: await written(tx) };
      });
      const { request, audit } = created;
      expect(people.reads.slice(reads)).toEqual([[TENANT_A.siteId, SIGNER.userId.toLowerCase()]]);
      expect(request.request_id).toMatch(CF_UUID);
      expect(request).toEqual({
        tenant_id: TENANT_A.tenantId,
        request_id: request.request_id,
        siteid: TENANT_A.siteId,
        document_name: 'contract.pdf',
        document_sha256: DOCUMENT_SHA256,
        document: DOCUMENT,
        signer_user_id: SIGNER.userId,
        state: 'PENDING',
        created: STORED_AT,
        createdbyid: OTHER.userId,
        row_version: '0',
      });
      expect(audit.entry_id).toMatch(CF_UUID);
      expect(audit).toMatchObject({
        tenant_id: TENANT_A.tenantId,
        request_id: request.request_id,
        seq: 1,
        action: 'created',
        actor_user_id: OTHER.userId,
        detail: DOCUMENT_SHA256,
        at: STORED_AT,
      });
      expect(audit.prev_hash).toEqual(Buffer.alloc(32));
      expect(audit.entry_hash).toEqual(procedureHash(Buffer.alloc(32), [request.request_id, 1, 'created', OTHER.userId, DOCUMENT_SHA256, AT_TEXT]));
      expect(log).toEqual([
        ['insert', 'signature_request', OTHER.userId],
        ['insert', 'audit_entry', OTHER.userId],
      ]);
    });

    it.each([
      ['a user of the public user pool', POOL_SIGNER],
      ['a user stored under its pool site id in another case', UPPER_SITE_SIGNER],
    ])('accepts %s as signer and stores its stored UserID', async (_name, signer) => {
      const { request } = await create(signer.userId.toLowerCase());
      expect(request.signer_user_id).toBe(signer.userId);
    });

    it.each([
      ['an empty id', ''],
      ['an unknown user', UNKNOWN_ID],
      ['a group', GROUP.userId],
      ['a user outside the tenant user pools', OUTSIDER.userId],
    ])('refuses %s as signer with invalidParameters and stores nothing', async (_name, signerUserId) => {
      const before = await tenantARequests();
      await expectDomainError(create(signerUserId), 'invalidParameters');
      expect(await tenantARequests()).toBe(before);
    });
  });

  describe('signRequest', () => {
    let pending: CreatedRequest;

    beforeAll(async () => {
      pending = await create();
    });

    it('signs as the signer, stores the typed name as sent and chains the signed entry to the created one', async () => {
      const typedName = '  Zo\u00eb \u00c5ngstr\u00f6m\u0301 \u{1F600} ';
      const { request, audit } = await create();
      const { signed, log } = await inTenant(async (tx) => {
        const result = await signRequest(tx, deps, { requestId: request.request_id, typedName }, actor(SIGNER.userId));
        return { signed: result, log: await written(tx) };
      });
      expect(signed.request).toMatchObject({ request_id: request.request_id, state: 'SIGNED' });
      expect(signed.signature.signature_id).toMatch(CF_UUID);
      expect(signed.signature).toMatchObject({
        tenant_id: TENANT_A.tenantId,
        request_id: request.request_id,
        typed_name: typedName,
        signer_user_id: SIGNER.userId,
        signed_at: STORED_AT,
      });
      expect(signed.audit).toMatchObject({ request_id: request.request_id, seq: 2, action: 'signed', actor_user_id: SIGNER.userId, detail: typedName, at: STORED_AT });
      expect(signed.audit.prev_hash).toEqual(audit.entry_hash);
      expect(signed.audit.entry_hash).toEqual(procedureHash(audit.entry_hash, [request.request_id, 2, 'signed', SIGNER.userId, typedName, AT_TEXT]));
      expect(log).toEqual([
        ['update', 'signature_request', SIGNER.userId],
        ['insert', 'signature', SIGNER.userId],
        ['insert', 'audit_entry', SIGNER.userId],
      ]);
      const stored = await inTenant((tx) => getRequest(tx, request.request_id, actor(SIGNER.userId)));
      expect(stored.signature?.typed_name).toBe(typedName);
    });

    it('matches the signer case-insensitively and records the acting user id as sent', async () => {
      const { request } = await create();
      const signer = actor(SIGNER.userId.toLowerCase());
      const signed = await inTenant((tx) => signRequest(tx, deps, { requestId: request.request_id.toLowerCase(), typedName: 'Jane Doe' }, signer));
      expect(signed.signature).toMatchObject({ request_id: request.request_id, signer_user_id: signer.userId });
      expect(signed.audit.actor_user_id).toBe(signer.userId);
      expect(await inTenant((tx) => verifyStored(tx, request.request_id, signer))).toEqual({ valid: true, entries: 2, brokenat: 0 });
    });

    it.each([
      ['255 UTF-16 code units', 'a'.repeat(255)],
      ['127 astral characters and one more unit', `${'\u{1F600}'.repeat(127)}a`],
      ['one visible character among blanks', ' \u200b x \t'],
    ])('accepts a typed name of %s and stores it as sent', async (_name, typedName) => {
      const { signature } = await createSigned(typedName);
      expect(signature.typed_name).toBe(typedName);
    });

    it.each([
      ['empty', ''],
      ['spaces', '   '],
      ['separators', '\u00a0\u2003\u3000\u2028\u2029'],
      ['format characters', '\u200b\u200d\ufeff\u00ad'],
      ['control characters', '\t\n\r\u0000\u007f'],
      ['separators, format and control characters', ' \u200b\t\u00a0'],
      ['256 UTF-16 code units', 'a'.repeat(256)],
      ['128 astral characters, 256 code units', '\u{1F600}'.repeat(128)],
    ])('refuses a typed name of %s with invalidParameters and leaves the request PENDING', async (_name, typedName) => {
      const requestId = pending.request.request_id;
      await expectDomainError(
        inTenant((tx) => signRequest(tx, deps, { requestId, typedName }, actor(SIGNER.userId))),
        'invalidParameters',
      );
      const detail = await inTenant((tx) => getRequest(tx, requestId, actor(SIGNER.userId)));
      expect({ state: detail.request.state, signature: detail.signature }).toEqual({ state: 'PENDING', signature: null });
    });

    it('refuses a second signature with conflict already-signed and appends nothing', async () => {
      const { request } = await createSigned();
      await expectDomainError(
        inTenant((tx) => signRequest(tx, deps, { requestId: request.request_id, typedName: 'Jane Again' }, actor(SIGNER.userId))),
        'conflict',
        'already-signed',
      );
      const chain = await inTenant((tx) => getAuditChain(tx, request.request_id, { pageIndex: 1, itemsPerPage: 50 }, actor(SIGNER.userId)));
      expect(chain.total).toBe(2);
    });

    it.each<[string, () => Promise<string>, EsignatureActor, string, EsignatureErrorType]>([
      ['an unknown request, even with a blank name', () => Promise.resolve(UNKNOWN_ID), actor(OTHER.userId), '', 'notFound'],
      ['another user, before the typed name', async () => (await create()).request.request_id, actor(OTHER.userId), '', 'forbidden'],
      ['another user of a signed request', async () => (await createSigned()).request.request_id, actor(OTHER.userId), 'Jane Doe', 'forbidden'],
      ['a blank name on a signed request, before its state', async () => (await createSigned()).request.request_id, actor(SIGNER.userId), ' ', 'invalidParameters'],
    ])('raises in esignature.cfc order for %s', async (_name, requestId, signer, typedName, type) => {
      const id = await requestId();
      await expectDomainError(
        inTenant((tx) => signRequest(tx, deps, { requestId: id, typedName }, signer)),
        type,
      );
    });
  });

  describe('appendAuditEntry', () => {
    it.each([
      ['no actor', null],
      ['an actor', AUDITOR_ID],
    ])('appends the next linked entry with %s under the stored request id, as usp_audit_append', async (_name, actorUserId) => {
      const { request, audit: first } = await create();
      const at = new Date(2026, 5, 30, 14, 6, 0, 1);
      const { entry, log } = await inTenant(async (tx) => {
        const appended = await appendAuditEntry(tx, deps, { requestId: request.request_id.toLowerCase(), action: 'viewed', actorUserId, detail: null, at });
        return { entry: appended, log: await written(tx) };
      });
      expect(entry).toMatchObject({ request_id: request.request_id, seq: 2, action: 'viewed', actor_user_id: actorUserId, detail: null, at: new Date(2026, 5, 30, 14, 6, 0, 0) });
      expect(entry.entry_id).toMatch(CF_UUID);
      expect(entry.prev_hash).toEqual(first.entry_hash);
      expect(entry.entry_hash).toEqual(procedureHash(first.entry_hash, [request.request_id, 2, 'viewed', actorUserId ?? '', '', '2026-06-30T14:06:00.000']));
      expect(log).toEqual([['insert', 'audit_entry', actorUserId]]);
      expect(await inTenant((tx) => verifyStored(tx, request.request_id, actor(AUDITOR_ID, TENANT_A.siteId, [AUDITOR_ROLE])))).toEqual({
        valid: true,
        entries: 2,
        brokenat: 0,
      });
    });

    it('raises notFound for an unknown request', async () => {
      await expectDomainError(
        inTenant((tx) => appendAuditEntry(tx, deps, { requestId: UNKNOWN_ID, action: 'viewed', actorUserId: null, detail: null, at: NOW })),
        'notFound',
      );
    });
  });

  describe('request readers', () => {
    let request: CreatedRequest['request'];

    beforeAll(async () => {
      request = (await create()).request;
    });

    it.each([
      ['an auditor who is not its signer', actor(AUDITOR_ID, TENANT_A.siteId, [AUDITOR_ROLE])],
      ['its signer', actor(SIGNER.userId)],
      ['its signer by a lower-case user id', actor(SIGNER.userId.toLowerCase())],
    ])('admits %s and returns the request without its document', async (_name, reader) => {
      const row = await inTenant((tx) => authorizeRequestReader(tx, request.request_id.toLowerCase(), reader));
      expect(row).toMatchObject({ request_id: request.request_id, signer_user_id: SIGNER.userId, state: 'PENDING' });
      expect(row).not.toHaveProperty('document');
    });

    it.each<[string, () => string, EsignatureActor, EsignatureErrorType]>([
      ['another signer with forbidden', () => request.request_id, actor(OTHER.userId), 'forbidden'],
      ['an auditor asking for an unknown request with notFound', () => UNKNOWN_ID, actor(AUDITOR_ID, TENANT_A.siteId, [AUDITOR_ROLE]), 'notFound'],
      ['another signer asking for an unknown request with notFound', () => UNKNOWN_ID, actor(OTHER.userId), 'notFound'],
    ])('refuses %s on every chain read', async (_name, id, reader, type) => {
      const reads: ((tx: TenantTx) => Promise<unknown>)[] = [
        (tx) => authorizeRequestReader(tx, id(), reader),
        (tx) => getRequest(tx, id(), reader),
        (tx) => getAuditChain(tx, id(), { pageIndex: 1, itemsPerPage: 50 }, reader),
        (tx) => verifyStored(tx, id(), reader),
      ];
      for (const read of reads) await expectDomainError(inTenant(read), type);
    });

    it('returns a request with a null signature while PENDING and its signature once SIGNED', async () => {
      expect((await inTenant((tx) => getRequest(tx, request.request_id, actor(SIGNER.userId)))).signature).toBeNull();
      const signed = await createSigned('Jane Q. Doe');
      const detail = await inTenant((tx) => getRequest(tx, signed.request.request_id, actor(AUDITOR_ID, TENANT_A.siteId, [AUDITOR_ROLE])));
      expect(detail.request).toMatchObject({ request_id: signed.request.request_id, state: 'SIGNED' });
      expect(detail.request).not.toHaveProperty('document');
      expect(detail.signature).toEqual(signed.signature);
    });
  });

  describe('listRequests', () => {
    it('pages the tenant requests by created with their total, for a tenant the registry does not list', async () => {
      const creator = actor(OTHER.userId, LIST_SITE);
      const at = (minute: number): Date => new Date(2026, 5, 30, 9, minute, 0, 0);
      const ids: string[] = [];
      for (const minute of [30, 10, 20]) ids.push((await create(LIST_SIGNER.userId, creator, fixedClock(at(minute)))).request.request_id);
      await expectDomainError(create(SIGNER.userId, creator), 'invalidParameters');
      const page = (pageIndex: number) => inTenant((tx) => listRequests(tx, { pageIndex, itemsPerPage: 2 }), LIST_TENANT);
      const [first, second, third] = [await page(1), await page(2), await page(3)];
      expect(first.rows.map((row) => row.request_id)).toEqual([ids[1], ids[2]]);
      expect(second.rows.map((row) => row.request_id)).toEqual([ids[0]]);
      expect(third).toEqual({ rows: [], total: 3 });
      expect([first.total, second.total]).toEqual([3, 3]);
      expect(first.rows.map((row) => row.created)).toEqual([at(10), at(20)]);
    });
  });

  describe('getAuditChain', () => {
    it.each([
      ['its signer', actor(SIGNER.userId)],
      ['an auditor', actor(AUDITOR_ID, TENANT_A.siteId, [AUDITOR_ROLE])],
    ])('pages the audit entries by seq with their total for %s', async (_name, reader) => {
      const signed = await createSigned();
      const all = await inTenant((tx) => getAuditChain(tx, signed.request.request_id, { pageIndex: 1, itemsPerPage: 50 }, reader));
      expect({ total: all.total, entries: all.rows.map((row) => [row.seq, row.action]) }).toEqual({
        total: 2,
        entries: [
          [1, 'created'],
          [2, 'signed'],
        ],
      });
      expect(all.rows).toEqual([signed.created, signed.audit]);
      const second = await inTenant((tx) => getAuditChain(tx, signed.request.request_id, { pageIndex: 2, itemsPerPage: 1 }, reader));
      expect({ total: second.total, seqs: second.rows.map((row) => row.seq) }).toEqual({ total: 2, seqs: [2] });
    });
  });

  describe('verifyStored', () => {
    it('answers a valid verdict over the stored chain', async () => {
      const { request } = await createSigned();
      expect(await inTenant((tx) => verifyStored(tx, request.request_id, actor(SIGNER.userId)))).toEqual({ valid: true, entries: 2, brokenat: 0 });
    });

    it.each([
      ['detail', 2, 'tampered'],
      ['action', 1, 'forged'],
      ['actor_user_id', 2, OTHER.userId],
    ])('breaks at the entry whose stored %s was altered at seq %i', async (column, seq, value) => {
      const { request } = await createSigned();
      await inTenant((tx) => tx.query(`UPDATE ${handle.schema}.audit_entry SET "${column}" = $3 WHERE request_id = $1 AND seq = $2`, [request.request_id, seq, value]));
      expect(await inTenant((tx) => verifyStored(tx, request.request_id, actor(AUDITOR_ID, TENANT_A.siteId, [AUDITOR_ROLE])))).toEqual({
        valid: false,
        entries: 2,
        brokenat: seq,
      });
    });
  });

  describe('verifySupplied', () => {
    let signed: SignedRequest;
    let copy: SuppliedAuditEntry[];

    beforeAll(async () => {
      signed = await createSigned('Zo\u00eb \u00c5ngstr\u00f6m');
      const chain = await inTenant((tx) => getAuditChain(tx, signed.request.request_id, { pageIndex: 1, itemsPerPage: 50 }, actor(SIGNER.userId)));
      copy = suppliedCopy(chain.rows);
    });

    /** `copy` with entry `index` changed by `changes`. */
    const changed = (index: number, changes: Partial<SuppliedAuditEntry>): SuppliedAuditEntry[] =>
      copy.map((entry, position) => (position === index ? { ...entry, ...changes } : entry));

    it('verifies the copy the audit chain lists, its hashes in upper case, and the empty copy', () => {
      const upper = copy.map((entry) => ({ ...entry, prev_hash: entry.prev_hash.toUpperCase(), entry_hash: entry.entry_hash.toUpperCase() }));
      expect(verifySupplied(signed.request, copy)).toEqual({ valid: true, entries: 2, brokenat: 0 });
      expect(verifySupplied(signed.request, upper)).toEqual({ valid: true, entries: 2, brokenat: 0 });
      expect(verifySupplied(signed.request, [])).toEqual({ valid: true, entries: 0, brokenat: 0 });
    });

    it('hashes the stored request id it is given, so the copy of one request breaks against another', () => {
      expect(verifySupplied({ request_id: UNKNOWN_ID }, copy)).toEqual({ valid: false, entries: 2, brokenat: 1 });
    });

    it.each<[string, number, Partial<SuppliedAuditEntry>, number]>([
      ['an altered detail', 1, { detail: 'Jane Doe' }, 2],
      ['an altered first action', 0, { action: 'forged' }, 1],
      ['an altered at', 1, { at: '2026-06-30T14:05:09.127' }, 2],
      ['an altered entry_hash', 1, { entry_hash: 'f'.repeat(64) }, 2],
      ['an altered prev_hash', 1, { prev_hash: '0'.repeat(64) }, 2],
      ['a renumbered entry', 1, { seq: '3' }, 3],
    ])('breaks a copy with %s at the first broken entry in array order', (_name, index, changes, brokenat) => {
      expect(verifySupplied(signed.request, changed(index, changes))).toEqual({ valid: false, entries: 2, brokenat });
    });

    it('breaks a copy whose entries are out of order', () => {
      expect(verifySupplied(signed.request, [copy[1], copy[0]] as SuppliedAuditEntry[])).toEqual({ valid: false, entries: 2, brokenat: 2 });
    });

    it.each<[string, Partial<SuppliedAuditEntry>]>([
      ['seq 0', { seq: '0' }],
      ['a seq with a leading zero', { seq: '02' }],
      ['a negative seq', { seq: '-2' }],
      ['a decimal seq', { seq: '2.0' }],
      ['an empty seq', { seq: '' }],
      ['a ten-digit seq', { seq: '1000000000' }],
      ['an at with a space separator', { at: '2026-06-30 14:05:09.123' }],
      ['an at without milliseconds', { at: '2026-06-30T14:05:09' }],
      ['an at with a zone', { at: '2026-06-30T14:05:09.123Z' }],
      ['a 63-digit prev_hash', { prev_hash: '0'.repeat(63) }],
      ['a 0x-prefixed prev_hash', { prev_hash: `0x${'0'.repeat(62)}` }],
      ['a non-hex entry_hash', { entry_hash: `g${'0'.repeat(63)}` }],
      ['a 65-digit entry_hash', { entry_hash: '0'.repeat(65) }],
      ['an empty entry_hash', { entry_hash: '' }],
    ])('refuses a copy with %s with invalidParameters', async (_name, changes) => {
      await expectDomainError(
        Promise.resolve().then(() => verifySupplied(signed.request, changed(1, changes))),
        'invalidParameters',
      );
    });
  });

  describe('tenant isolation', () => {
    it('hides a tenant-a request from tenant-b in every read and write, and the reverse', async () => {
      const a = await createSigned();
      const bReader = actor(B_SIGNER.userId, TENANT_B.siteId, [SIGNER_ROLE, AUDITOR_ROLE]);
      const b = await create(B_SIGNER.userId, actor(B_SIGNER.userId, TENANT_B.siteId));
      const aId = a.request.request_id;
      const inB = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => inTenant(fn, TENANT_B.tenantId);
      const calls: ((tx: TenantTx) => Promise<unknown>)[] = [
        (tx) => authorizeRequestReader(tx, aId, bReader),
        (tx) => getRequest(tx, aId, bReader),
        (tx) => getAuditChain(tx, aId, { pageIndex: 1, itemsPerPage: 50 }, bReader),
        (tx) => verifyStored(tx, aId, bReader),
        (tx) => signRequest(tx, deps, { requestId: aId, typedName: 'Jane Doe' }, actor(SIGNER.userId, TENANT_B.siteId)),
        (tx) => appendAuditEntry(tx, deps, { requestId: aId, action: 'viewed', actorUserId: B_SIGNER.userId, detail: null, at: NOW }),
      ];
      for (const call of calls) await expectDomainError(inB(call), 'notFound');
      const bPage = await inB((tx) => listRequests(tx, { pageIndex: 1, itemsPerPage: 1000 }));
      expect({ total: bPage.total, ids: bPage.rows.map((row) => row.request_id) }).toEqual({ total: 1, ids: [b.request.request_id] });
      await expectDomainError(
        inTenant((tx) => getRequest(tx, b.request.request_id, actor(AUDITOR_ID, TENANT_A.siteId, [AUDITOR_ROLE]))),
        'notFound',
      );
      const aPage = await inTenant((tx) => listRequests(tx, { pageIndex: 1, itemsPerPage: 1000 }));
      expect(aPage.rows.map((row) => row.request_id)).not.toContain(b.request.request_id);
      expect(aPage.rows.every((row) => row.tenant_id === TENANT_A.tenantId)).toBe(true);
    });

    it('refuses a tenant-a pool user as signer of a tenant-b request', async () => {
      await expectDomainError(create(SIGNER.userId, actor(B_SIGNER.userId, TENANT_B.siteId)), 'invalidParameters');
    });
  });
});
