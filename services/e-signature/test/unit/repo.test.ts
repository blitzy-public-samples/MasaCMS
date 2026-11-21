// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature repository and queries over the recording db: same-transaction changelog rows, unit gates, the serialised audit append, write positions and gated reads. */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError, cfUuid, isCfUuid } from '@opt2/platform/legacy-compat';
import {
  CHANGELOG_TABLE,
  UNIT_GATE_TABLE,
  UnitNotAuthoritativeError,
  UnitReadBlockedError,
  WRITE_POSITION_HEADER_LC,
  encodeKey,
  encodeRow,
  parseWritePosition,
  withGatedTenant,
  type GatePhase,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { GENESIS_PREV_HASH, hashToHex, nextEntry } from '../../src/domain/hash-chain.js';
import { appendAuditEntry, createSignatureRequest, signRequest, type EsignatureActor, type EsignatureDomainDeps } from '../../src/domain/signing.js';
import { createEsignatureRepository, type EsignatureRepository, type NewAuditEntry, type NewSignatureRequest } from '../../src/repo/repository.js';
import { auditChainBatches, findRequest, findSignature, lastAuditEntry, listAuditEntries, listRequests, lockRequest } from '../../src/repo/queries.js';
import {
  AUDIT_ENTRY,
  OWNER,
  SCHEMA,
  SIGNATURE,
  SIGNATURE_REQUEST,
  type AuditEntryRow,
  type EsignatureTableDefinition,
} from '../../src/repo/tables.js';
import { CSRF_HEADERS, DEFAULT_PERSONS, TEST_CLOCK, buildTestApp, createFakePeopleClient, createRecordingDb, type RecordingDb } from '../helpers/app.js';
import { SIGNER_USER_ID, userHeaders } from '../helpers/tokens.js';
import { CHAIN_VECTORS } from '../helpers/vectors.js';

// The fixture contract path as legacy callers send it, not the route module's constant, so the suite pins the wire path.
const FIXTURE_REQUESTS = '/legacy-fixtures/cfml/api.cfm/esignature/requests';
const DOCUMENT = Buffer.from('%PDF-1.7 synthetic e-signature repository fixture');
const DOCUMENT_SHA256 = createHash('sha256').update(DOCUMENT).digest('hex');
const ACTOR: EsignatureActor = { userId: SIGNER_USER_ID, siteId: TENANT_A.siteId, roles: [Roles.esignatureSigner] };
const CTX: WriteContext = { actorUserId: SIGNER_USER_ID };
const ALL_ENTRIES = { pageIndex: 1, itemsPerPage: 1000 };
const CHANGELOG = `${SCHEMA}.${CHANGELOG_TABLE}`;
const GATE_RELATION = `"${SCHEMA}"."${UNIT_GATE_TABLE}"`;

/** A PENDING tenant-a request for SIGNER_USER_ID, as a seed row or an `insertRequest` row. */
function requestRow(requestId: string, created: Date = TEST_CLOCK.now()): NewSignatureRequest {
  return {
    tenant_id: TENANT_A.tenantId,
    request_id: requestId,
    siteid: TENANT_A.siteId,
    document_name: 'contract.pdf',
    document_sha256: DOCUMENT_SHA256,
    document: DOCUMENT,
    signer_user_id: SIGNER_USER_ID,
    state: 'PENDING',
    created,
    createdbyid: SIGNER_USER_ID,
  };
}

/** The `viewed` entry usp_audit_append would append to `requestId` after `last`. */
function auditRow(requestId: string, last: AuditEntryRow | null = null): NewAuditEntry {
  const next = nextEntry(last, { requestId, action: 'viewed', actorUserId: SIGNER_USER_ID, detail: null, at: TEST_CLOCK.now() });
  return {
    entry_id: cfUuid(),
    request_id: requestId,
    seq: next.seq,
    action: 'viewed',
    actor_user_id: SIGNER_USER_ID,
    detail: null,
    at: next.at,
    prev_hash: next.prev_hash,
    entry_hash: next.entry_hash,
  };
}

/** Asserts that `entries`, in `seq` order, run from 1 and each hashes as usp_audit_append over its predecessor. */
function expectLinkedChain(entries: readonly AuditEntryRow[]): void {
  let previous: AuditEntryRow | null = null;
  for (const [index, entry] of entries.entries()) {
    const recomputed = nextEntry(previous, {
      requestId: entry.request_id,
      action: entry.action,
      actorUserId: entry.actor_user_id,
      detail: entry.detail,
      at: entry.at,
    });
    expect(entry.seq).toBe(index + 1);
    expect(hashToHex(entry.prev_hash)).toBe(hashToHex(previous?.entry_hash ?? GENESIS_PREV_HASH));
    expect(hashToHex(entry.entry_hash)).toBe(hashToHex(recomputed.entry_hash));
    previous = entry;
  }
}

describe('e-signature repository and queries over the recording db', () => {
  let db: RecordingDb;
  let repository: EsignatureRepository;
  let deps: EsignatureDomainDeps;
  let requestId: string;

  const inTenantA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withGatedTenant(db, TENANT_A.tenantId, fn);
  const readTenantA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(db, TENANT_A.tenantId, fn);
  const chainOf = async (id: string): Promise<AuditEntryRow[]> => (await readTenantA((tx) => listAuditEntries(tx, id, ALL_ENTRIES))).rows;

  beforeEach(() => {
    db = createRecordingDb();
    repository = createEsignatureRepository({ db, clock: TEST_CLOCK });
    deps = { repository, clock: TEST_CLOCK, peopleClient: createFakePeopleClient(DEFAULT_PERSONS) };
    requestId = cfUuid();
    db.seed('signature_request', [requestRow(requestId)]);
  });

  /** Asserts that the only committed writes are `stored`'s row write on `def` and its changelog row, in one transaction. */
  function expectAudited(def: EsignatureTableDefinition, op: 'insert' | 'update', stored: Record<string, unknown>, before?: Record<string, unknown>): void {
    const statements = db.queries().map((query) => query.sql);
    expect(statements.filter((sql) => sql === 'BEGIN' || sql === 'COMMIT')).toEqual(['BEGIN', 'COMMIT']);
    expect([statements[0], statements.at(-1)]).toEqual(['BEGIN', 'COMMIT']);
    const writes = db.writes();
    expect(writes.map((write) => [write.table, write.op, write.tenantId])).toEqual([
      [`${SCHEMA}.${def.table}`, op, TENANT_A.tenantId],
      [CHANGELOG, 'insert', TENANT_A.tenantId],
    ]);
    expect(writes[0]?.row).toEqual(stored);
    expect(writes[1]?.row).toMatchObject({
      xid: db.lastXid(),
      table: def.table,
      op,
      key: encodeKey(def.columns, def.key, stored),
      before: before === undefined ? null : encodeRow(def.columns, before),
      after: encodeRow(def.columns, stored),
      origin: 'target',
      actor_user_id: SIGNER_USER_ID,
      at: TEST_CLOCK.now(),
    });
  }

  /** Asserts that a FOR SHARE on `unit`'s gate row ran before the first statement matching `write`. */
  function expectGateLockedBefore(unit: string, write: RegExp): void {
    const queries = db.queries();
    const gate = queries.findIndex(
      (query) => query.sql.includes(GATE_RELATION) && query.sql.includes('FOR SHARE') && (query.params[0] as readonly string[]).includes(unit),
    );
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(queries.findIndex((query) => write.test(query.sql))).toBeGreaterThan(gate);
  }

  describe('same-transaction changelog and write gates', () => {
    const INSERTS: readonly { name: string; def: EsignatureTableDefinition; write: (tx: TenantTx) => Promise<Record<string, unknown>> }[] = [
      { name: 'insertRequest', def: SIGNATURE_REQUEST, write: (tx) => repository.insertRequest(tx, requestRow(cfUuid()), CTX) },
      {
        name: 'insertSignature',
        def: SIGNATURE,
        write: (tx) =>
          repository.insertSignature(
            tx,
            { signature_id: cfUuid(), request_id: requestId, typed_name: 'Jane Signer', signer_user_id: SIGNER_USER_ID, signed_at: TEST_CLOCK.now() },
            CTX,
          ),
      },
      { name: 'insertAuditEntry', def: AUDIT_ENTRY, write: (tx) => repository.insertAuditEntry(tx, auditRow(requestId), CTX) },
    ];

    it.each(INSERTS)('$name commits its row with one insert changelog row of the same xid, after share-locking its gate', async ({ def, write }) => {
      const stored = await inTenantA(write);
      expectAudited(def, 'insert', stored);
      expect(db.writes()[1]?.row).toMatchObject({ columns: def.columns.map((column) => column.name).filter((name) => name !== 'tenant_id') });
      expectGateLockedBefore(def.unit, new RegExp(`^INSERT INTO "${SCHEMA}"."${def.table}"`));
    });

    it.each(INSERTS)('$name is refused while its unit is legacy-authoritative, writing nothing', async ({ def, write }) => {
      db.setGate(def.unit, 'legacy');
      await expect(inTenantA(write)).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
      expect(db.writes()).toEqual([]);
      expect(db.lastXid()).toBeUndefined();
    });

    it('updateRequest logs PENDING to SIGNED as an update with before and after images and the changed state column', async () => {
      const [before] = db.rows('signature_request');
      const stored = await inTenantA((tx) => repository.updateRequest(tx, requestId, { state: 'SIGNED' }, CTX));
      expect(before?.state).toBe('PENDING');
      expect(stored?.state).toBe('SIGNED');
      expectAudited(SIGNATURE_REQUEST, 'update', stored ?? {}, before);
      expect(db.writes()[1]?.row.columns).toEqual(['state']);
      expectGateLockedBefore(SIGNATURE_REQUEST.unit, new RegExp(`^UPDATE "${SCHEMA}"."${SIGNATURE_REQUEST.table}"`));
    });

    it('updateRequest answers null and writes nothing for a request the tenant does not hold', async () => {
      expect(await inTenantA((tx) => repository.updateRequest(tx, cfUuid(), { state: 'SIGNED' }, CTX))).toBeNull();
      expect(db.writes()).toEqual([]);
    });

    it.each([
      ['the audit_entry insert', `INSERT INTO "${SCHEMA}"."${AUDIT_ENTRY.table}"`],
      ['its changelog insert', `INSERT INTO "${SCHEMA}"."${CHANGELOG_TABLE}"`],
    ])('commits neither the audit row nor its changelog row when %s fails', async (_name, match) => {
      db.failNext(match);
      await expect(inTenantA((tx) => repository.insertAuditEntry(tx, auditRow(requestId), CTX))).rejects.toMatchObject({ code: '40001' });
      expect(db.writes()).toEqual([]);
      expect(db.rows('audit_entry')).toEqual([]);
      expect(db.rows('changelog')).toEqual([]);
      expect(db.lastXid()).toBeUndefined();
    });
  });

  describe('lockRequest and the serialised audit append', () => {
    it('row-locks the request before reading its last entry, and answers null for an unknown request', async () => {
      const locked = await readTenantA((tx) => lockRequest(tx, requestId));
      const statements = db.queries().map((query) => query.sql);
      const lock = statements.findIndex((sql) => sql.includes(`"${SIGNATURE_REQUEST.table}"`) && sql.endsWith('FOR UPDATE'));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(statements.findIndex((sql) => sql.includes(`"${AUDIT_ENTRY.table}"`) && sql.endsWith('DESC LIMIT 1'))).toBeGreaterThan(lock);
      expect(locked).toEqual({ request: expect.objectContaining({ request_id: requestId, state: 'PENDING' }), last: null });
      expect(locked?.request).not.toHaveProperty('document');
      expect(await readTenantA((tx) => lockRequest(tx, cfUuid()))).toBeNull();
    });

    it('chains create, sign and later appends from seq 1, and lastAuditEntry answers the highest seq', async () => {
      const created = await inTenantA((tx) =>
        createSignatureRequest(tx, deps, { documentName: 'contract.pdf', document: DOCUMENT, signerUserId: SIGNER_USER_ID }, ACTOR),
      );
      const id = created.request.request_id;
      expect(await readTenantA((tx) => lockRequest(tx, id))).toMatchObject({ last: { seq: 1, entry_id: created.audit.entry_id } });
      await inTenantA((tx) => signRequest(tx, deps, { requestId: id, typedName: 'Jane Signer' }, ACTOR));
      for (const action of ['viewed', 'downloaded']) {
        await inTenantA((tx) => appendAuditEntry(tx, deps, { requestId: id, action, actorUserId: SIGNER_USER_ID, detail: null, at: TEST_CLOCK.now() }));
      }

      const chain = await chainOf(id);
      expect(chain.map((entry) => [entry.seq, entry.action])).toEqual([
        [1, 'created'],
        [2, 'signed'],
        [3, 'viewed'],
        [4, 'downloaded'],
      ]);
      expect(chain.every((entry) => isCfUuid(entry.entry_id))).toBe(true);
      expectLinkedChain(chain);
      expect((await readTenantA((tx) => lastAuditEntry(tx, id)))?.entry_id).toBe(chain.at(-1)?.entry_id);
      expect(await readTenantA((tx) => lastAuditEntry(tx, requestId))).toBeNull();
    });

    it('appends the SQL Server usp_audit_append vectors byte for byte', async () => {
      const [first] = CHAIN_VECTORS;
      const vectorRequest = first?.input.requestId ?? '';
      db.seed('signature_request', [requestRow(vectorRequest)]);
      for (const { input, prevHex, entryHex } of CHAIN_VECTORS) {
        const entry = await inTenantA((tx) =>
          appendAuditEntry(tx, deps, { requestId: vectorRequest, action: input.action, actorUserId: input.actorUserId, detail: input.detail, at: new Date(input.at) }),
        );
        expect({ seq: entry.seq, prev: hashToHex(entry.prev_hash), entry: hashToHex(entry.entry_hash) }).toEqual({ seq: input.seq, prev: prevHex, entry: entryHex });
      }
      expectLinkedChain(await chainOf(vectorRequest));
    });

    it.each([2, 5])('serialises %i concurrent appends on one request into unique, contiguous, linked seq values', async (count) => {
      const details = Array.from({ length: count }, (_, i) => `append-${i + 1}`);
      const appended = await Promise.all(
        details.map((detail) => inTenantA((tx) => appendAuditEntry(tx, deps, { requestId, action: 'viewed', actorUserId: SIGNER_USER_ID, detail, at: TEST_CLOCK.now() }))),
      );
      expect(appended.map((entry) => entry.seq).sort((a, b) => a - b)).toEqual(details.map((_, i) => i + 1));
      const statements = db.queries().map((query) => query.sql);
      const locks = statements.flatMap((sql, at) => (sql.includes(`"${SIGNATURE_REQUEST.table}"`) && sql.endsWith('FOR UPDATE') ? [at] : []));
      expect(locks).toHaveLength(count);
      expect(Math.max(...locks)).toBeLessThan(statements.findIndex((sql) => sql.startsWith(`INSERT INTO "${SCHEMA}"."${AUDIT_ENTRY.table}"`)));
      const chain = await chainOf(requestId);
      expect(chain.map((entry) => entry.detail).sort()).toEqual(details);
      expectLinkedChain(chain);
    });

    it('keeps independent chains for appends interleaved across two requests', async () => {
      const other = cfUuid();
      db.seed('signature_request', [requestRow(other)]);
      const append = (id: string, detail: string): Promise<AuditEntryRow> =>
        inTenantA((tx) => appendAuditEntry(tx, deps, { requestId: id, action: 'viewed', actorUserId: SIGNER_USER_ID, detail, at: TEST_CLOCK.now() }));
      await Promise.all([append(requestId, 'a1'), append(other, 'b1'), append(requestId, 'a2'), append(other, 'b2')]);
      for (const [id, details] of [
        [requestId, ['a1', 'a2']],
        [other, ['b1', 'b2']],
      ] as const) {
        const chain = await chainOf(id);
        expect(chain.map((entry) => entry.request_id)).toEqual([id, id]);
        expect(chain.map((entry) => entry.detail).sort()).toEqual(details);
        expectLinkedChain(chain);
      }
    });
  });

  describe('read queries', () => {
    it('finds a request only inside its own tenant, without its document bytes', async () => {
      const found = await readTenantA((tx) => findRequest(tx, requestId));
      expect(found).toMatchObject({ request_id: requestId, tenant_id: TENANT_A.tenantId, state: 'PENDING' });
      expect(found).not.toHaveProperty('document');
      expect(await withTenant(db, TENANT_B.tenantId, (tx) => findRequest(tx, requestId))).toBeNull();
    });

    it('row-locks the request only when asked for update', async () => {
      const lastRequestRead = (): string | undefined =>
        db
          .queries()
          .map((query) => query.sql)
          .filter((sql) => sql.startsWith('SELECT') && sql.includes(`"${SIGNATURE_REQUEST.table}"`))
          .at(-1);
      await readTenantA((tx) => findRequest(tx, requestId));
      expect(lastRequestRead()).not.toMatch(/FOR UPDATE/);
      await readTenantA((tx) => findRequest(tx, requestId, { forUpdate: true }));
      expect(lastRequestRead()).toMatch(/FOR UPDATE$/);
    });

    it.each([
      [1, 2],
      [2, 2],
      [3, 2],
      [1, 1000],
    ])('pages pageIndex %i of %i requests by created, then id, with the total', async (pageIndex, itemsPerPage) => {
      const earlier = new Date(TEST_CLOCK.now().getTime() - 60_000);
      const extra = [cfUuid(), cfUuid()];
      db.seed('signature_request', [requestRow(extra[0] ?? '', earlier), requestRow(extra[1] ?? '')]);
      const ordered = [
        { id: extra[0] ?? '', created: earlier.getTime() },
        { id: requestId, created: TEST_CLOCK.now().getTime() },
        { id: extra[1] ?? '', created: TEST_CLOCK.now().getTime() },
      ]
        .sort((x, y) => x.created - y.created || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
        .map((row) => row.id);
      const page = await readTenantA((tx) => listRequests(tx, { pageIndex, itemsPerPage }));
      const offset = (pageIndex - 1) * itemsPerPage;
      expect(page.total).toBe(3);
      expect(page.rows.map((row) => row.request_id)).toEqual(ordered.slice(offset, offset + itemsPerPage));
      expect(page.rows.every((row) => !('document' in row))).toBe(true);
    });

    it('finds a signature once inserted and only inside its tenant', async () => {
      expect(await readTenantA((tx) => findSignature(tx, requestId))).toBeNull();
      const signatureId = cfUuid();
      await inTenantA((tx) =>
        repository.insertSignature(
          tx,
          { signature_id: signatureId, request_id: requestId, typed_name: 'Jane Signer', signer_user_id: SIGNER_USER_ID, signed_at: TEST_CLOCK.now() },
          CTX,
        ),
      );
      expect(await readTenantA((tx) => findSignature(tx, requestId))).toMatchObject({ signature_id: signatureId, typed_name: 'Jane Signer' });
      expect(await withTenant(db, TENANT_B.tenantId, (tx) => findSignature(tx, requestId))).toBeNull();
    });

    it.each([
      [1, [[1], [2], [3]]],
      [2, [[1, 2], [3]]],
      [3, [[1, 2, 3]]],
      [1000, [[1, 2, 3]]],
    ])('reads the whole chain in batches of %i by seq', async (batchSize, expected) => {
      for (const detail of ['d1', 'd2', 'd3']) {
        await inTenantA((tx) => appendAuditEntry(tx, deps, { requestId, action: 'viewed', actorUserId: SIGNER_USER_ID, detail, at: TEST_CLOCK.now() }));
      }
      const batches = await readTenantA(async (tx) => {
        const read: number[][] = [];
        for await (const batch of auditChainBatches(tx, requestId, batchSize)) read.push(batch.map((entry) => entry.seq));
        return read;
      });
      expect(batches).toEqual(expected);
      expect(await readTenantA(async (tx) => (await auditChainBatches(tx, cfUuid()).next()).done)).toBe(true);
    });

    it.each<GatePhase>(['executing', 'importing', 'import-pending'])('fails an audit read during a window in its %s phase with the legacy 503', async (phase) => {
      db.setGate(AUDIT_ENTRY.unit, 'closed', phase);
      const err: unknown = await withGatedTenant(db, TENANT_A.tenantId, (tx) => listAuditEntries(tx, requestId, ALL_ENTRIES), { budgetMs: 0 }).catch(
        (caught: unknown) => caught,
      );
      expect(err).toBeInstanceOf(UnitReadBlockedError);
      expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
      expect((err as UnitReadBlockedError).units).toEqual([AUDIT_ENTRY.unit]);
    });

    it('reads through a closed gate in its quiet phase', async () => {
      db.setGate(AUDIT_ENTRY.unit, 'closed', 'quiet');
      expect(await withGatedTenant(db, TENANT_A.tenantId, (tx) => listAuditEntries(tx, requestId, ALL_ENTRIES), { budgetMs: 0 })).toEqual({ rows: [], total: 0 });
    });
  });
});

describe('e-signature write positions', () => {
  it('answers a committed fixture sign with its transaction xid as the e-signature write position, and an audit read with none', async () => {
    const { app, db } = await buildTestApp();
    try {
      const id = cfUuid();
      db.seed('signature_request', [requestRow(id)]);
      const headers = await userHeaders({ sub: SIGNER_USER_ID, roles: [Roles.systemUser, Roles.esignatureSigner] });

      const signed = await app.inject({
        method: 'POST',
        url: `${FIXTURE_REQUESTS}/${id}/sign`,
        headers: { ...headers, ...CSRF_HEADERS },
        payload: { typedName: 'Jane Signer' },
      });
      expect(signed.statusCode).toBe(200);
      expect(OWNER).toBe('e-signature');
      expect(parseWritePosition(signed.headers[WRITE_POSITION_HEADER_LC] as string | undefined)).toEqual(new Map([[OWNER, db.lastXid()]]));
      const writes = db.writes();
      expect(writes.map((write) => write.table)).toEqual([
        `${SCHEMA}.${SIGNATURE_REQUEST.table}`,
        CHANGELOG,
        `${SCHEMA}.${SIGNATURE.table}`,
        CHANGELOG,
        `${SCHEMA}.${AUDIT_ENTRY.table}`,
        CHANGELOG,
      ]);
      for (const change of writes.filter((write) => write.table === CHANGELOG)) {
        expect(change.row).toMatchObject({ xid: db.lastXid(), origin: 'target', actor_user_id: SIGNER_USER_ID, request_id: expect.any(String) });
      }

      const audit = await app.inject({ method: 'GET', url: `${FIXTURE_REQUESTS}/${id}/audit`, headers });
      expect(audit.statusCode).toBe(200);
      expect(audit.headers).not.toHaveProperty(WRITE_POSITION_HEADER_LC);
      expect(db.writes()).toHaveLength(writes.length);
    } finally {
      await app.close();
    }
  });
});
