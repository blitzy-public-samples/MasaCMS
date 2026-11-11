// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature read queries against a throwaway `esignature` schema: fixture order and paging, id matching, the append lock, tenant isolation and window read gates. */
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { UnitReadBlockedError, closeGates, ensureUnitGates, openGates, withGatedTenant, type GatePhase } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { findRequest, findSignature, lastAuditEntry, listAuditEntries, listRequests, lockRequest } from '../../src/repo/queries.js';
import { AUDIT_ENTRY, SIGNATURE, SIGNATURE_REQUEST, UNITS } from '../../src/repo/tables.js';

let handle: ThrowawaySchema;
let nextEntryId = 0;

/** A CF-format id whose last group is `n` in hex and whose first group is `prefix`. */
const cfId = (prefix: string, n: number): string => `${prefix.padEnd(8, '0')}-AAAA-BBBB-${n.toString(16).toUpperCase().padStart(16, '0')}`;

const ACTOR = cfId('E', 1);
const GENESIS = Buffer.alloc(32);
/** 100 tenant-a requests over ten `created` values, with ids out of creation order, so ties exercise the id tie-breaker. */
const A_REQUESTS = Array.from({ length: 100 }, (_, i) => ({
  id: cfId(i % 2 === 0 ? 'A' : 'F', 1000 - i),
  created: `2026-06-${String(10 + (i % 10))} 09:00:00.${String((i % 3) * 3).padStart(3, '0')}`,
}));
const SIGNED = A_REQUESTS[0]!.id;
const CHAINED = A_REQUESTS[1]!.id;
const B_REQUEST = cfId('B', 1);

/** Inserts one PENDING request in the transaction tenant. */
async function insertRequest(tx: TenantTx, id: string, created: string, siteId: string): Promise<void> {
  await tx.query(
    `INSERT INTO ${handle.schema}.signature_request (tenant_id, request_id, siteid, document_name, document_sha256, document, signer_user_id, state, created, createdbyid)
     VALUES ($1, $2, $3, 'doc.pdf', $4, $5, $6, 'PENDING', $7, $6)`,
    [tx.tenantId, id, siteId, 'a'.repeat(64), Buffer.from('document'), ACTOR, created],
  );
}

/** Inserts audit entry `seq` linked to `prev` and returns its hash. */
async function insertEntry(tx: TenantTx, requestId: string, seq: number, prev: Buffer, detail: string): Promise<Buffer> {
  const entryHash = createHash('sha256').update(prev).update(`${requestId}|${seq}|${detail}`).digest();
  await tx.query(
    `INSERT INTO ${handle.schema}.audit_entry (tenant_id, entry_id, request_id, seq, action, actor_user_id, detail, at, prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4, 'created', $5, $6, localtimestamp(3), $7, $8)`,
    [tx.tenantId, cfId('D', (nextEntryId += 1)), requestId, seq, ACTOR, detail, prev, entryHash],
  );
  return entryHash;
}

/** Wraps `tx` so every statement text it runs is appended to `seen`. */
function recording(tx: TenantTx, seen: string[]): TenantTx {
  const query = ((text: string, values?: unknown[]) => {
    seen.push(text);
    return tx.query(text, values);
  }) as TenantTx['query'];
  return { ...tx, query };
}

/** Fixture order of requests: `created`, then id. */
function fixtureOrder(rows: readonly { id: string; created: string }[]): string[] {
  const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return [...rows].sort((x, y) => compare(x.created, y.created) || compare(x.id, y.id)).map((row) => row.id);
}

/** Resolves once a backend of the app role waits on a lock; throws after 5 s. */
async function untilLockWaiter(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await handle.adminPool.query<{ waiting: number }>(
      "SELECT count(*)::integer AS waiting FROM pg_stat_activity WHERE usename = $1 AND wait_event_type = 'Lock'",
      [handle.roles.app],
    );
    if ((rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('No transaction waited on the request row lock');
}

describe.skipIf(!(await pgAvailable()))('e-signature read queries', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'e-signature', schemaName: 'esignature', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      for (const request of A_REQUESTS) await insertRequest(tx, request.id, request.created, TENANT_A.siteId);
      await tx.query(
        `INSERT INTO ${handle.schema}.signature (tenant_id, signature_id, request_id, typed_name, signer_user_id, signed_at)
         VALUES ($1, $2, $3, 'Jane Doe', $4, localtimestamp(3))`,
        [tx.tenantId, cfId('C', 1), SIGNED, ACTOR],
      );
      let prev: Buffer = GENESIS;
      for (const seq of [1, 2, 3]) prev = await insertEntry(tx, CHAINED, seq, prev, `d${seq}`);
    });
    await handle.app.withTenant(TENANT_B.tenantId, async (tx) => {
      await insertRequest(tx, B_REQUEST, '2026-01-01 00:00:00', TENANT_B.siteId);
      await insertEntry(tx, B_REQUEST, 1, GENESIS, 'b');
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it.each([
    [1, 50],
    [2, 50],
    [3, 50],
    [1, 1000],
    [100, 1],
    [101, 1],
    [8, 13],
    [9, 13],
  ])('pages pageIndex %i of %i requests by created then id with the total, as envelope.cfc queryPage()', async (pageIndex, itemsPerPage) => {
    const page = await handle.app.withTenant(TENANT_A.tenantId, (tx) => listRequests(tx, { pageIndex, itemsPerPage }));
    const offset = (pageIndex - 1) * itemsPerPage;
    expect(page.total).toBe(100);
    expect(page.rows.map((row) => row.request_id)).toEqual(fixtureOrder(A_REQUESTS).slice(offset, offset + itemsPerPage));
  });

  it('selects the catalogue columns of each table in pg value forms', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      const request = await findRequest(tx, SIGNED);
      const signature = await findSignature(tx, SIGNED);
      const entries = await listAuditEntries(tx, CHAINED);
      expect(Object.keys(request ?? {})).toEqual(SIGNATURE_REQUEST.columns.map((column) => column.name));
      expect(Object.keys(signature ?? {})).toEqual(SIGNATURE.columns.map((column) => column.name));
      expect(Object.keys(entries[0] ?? {})).toEqual(AUDIT_ENTRY.columns.map((column) => column.name));
      expect(request).toMatchObject({ state: 'PENDING', row_version: '0', document: Buffer.from('document') });
      expect(request?.created).toBeInstanceOf(Date);
      expect(signature?.typed_name).toBe('Jane Doe');
      expect(entries[0]?.prev_hash).toEqual(GENESIS);
    });
  });

  it('lists audit entries by seq, finds the last one, and answers empty for a request without entries or signature', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      const entries = await listAuditEntries(tx, CHAINED);
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
      expect(entries[2]?.prev_hash).toEqual(entries[1]?.entry_hash);
      expect((await lastAuditEntry(tx, CHAINED))?.seq).toBe(3);
      expect(await lastAuditEntry(tx, SIGNED)).toBeNull();
      expect(await listAuditEntries(tx, SIGNED)).toEqual([]);
      expect(await findSignature(tx, CHAINED)).toBeNull();
    });
  });

  it('matches request ids case- and trailing-space-insensitively, as the fixture collation does', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      expect((await findRequest(tx, SIGNED.toLowerCase()))?.request_id).toBe(SIGNED);
      expect((await findRequest(tx, `${SIGNED}  `))?.request_id).toBe(SIGNED);
      expect((await findSignature(tx, SIGNED.toLowerCase()))?.request_id).toBe(SIGNED);
      expect(await listAuditEntries(tx, CHAINED.toLowerCase())).toHaveLength(3);
      expect((await lockRequest(tx, CHAINED.toLowerCase()))?.last?.seq).toBe(3);
      expect(await findRequest(tx, 'unknown')).toBeNull();
      await tx.query('SET LOCAL enable_seqscan = off');
      const plan = await tx.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT 1 FROM ${handle.schema}.signature_request WHERE "request_id" = upper($1)::bpchar`,
        [SIGNED],
      );
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toMatch(/Index (Only )?Scan using pk_signature_request/);
    });
  });

  it('row-locks the request only when asked for update', async () => {
    const seen: string[] = [];
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      await findRequest(recording(tx, seen), SIGNED);
      expect(seen.at(-1)).not.toMatch(/FOR UPDATE/);
      await findRequest(recording(tx, seen), SIGNED, { forUpdate: true });
      expect(seen.at(-1)).toMatch(/FOR UPDATE$/);
    });
  });

  it('locks the request before reading its last entry, and answers null for an unknown request', async () => {
    const seen: string[] = [];
    const locked = await handle.app.withTenant(TENANT_A.tenantId, (tx) => lockRequest(recording(tx, seen), CHAINED));
    const lock = seen.findIndex((text) => text.includes('"signature_request"') && text.endsWith('FOR UPDATE'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(seen.findIndex((text) => text.includes('"audit_entry"') && text.endsWith('DESC LIMIT 1'))).toBeGreaterThan(lock);
    expect(locked?.request.request_id).toBe(CHAINED);
    expect(locked?.last?.seq).toBe(3);
    expect((await handle.app.withTenant(TENANT_A.tenantId, (tx) => lockRequest(tx, SIGNED)))?.last).toBeNull();
    expect(await handle.app.withTenant(TENANT_A.tenantId, (tx) => lockRequest(tx, cfId('A', 0xfffff)))).toBeNull();
  });

  it('serialises two concurrent appends on one request into consecutive linked entries', async () => {
    const target = A_REQUESTS[5]!.id;
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const append = (name: string, hold: boolean): Promise<void> =>
      handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
        const { last } = (await lockRequest(tx, target))!;
        events.push(`${name}:locked`);
        if (hold) {
          signalLocked();
          await held;
        }
        await insertEntry(tx, target, (last?.seq ?? 0) + 1, last?.entry_hash ?? GENESIS, name);
        events.push(`${name}:inserted`);
      });
    const first = append('first', true);
    await locked;
    const second = append('second', false);
    try {
      await untilLockWaiter();
      expect(events).toEqual(['first:locked']);
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
    await Promise.all([first, second]);
    expect(events).toEqual(['first:locked', 'first:inserted', 'second:locked', 'second:inserted']);
    const entries = await handle.app.withTenant(TENANT_A.tenantId, (tx) => listAuditEntries(tx, target));
    expect(entries.map((entry) => [entry.seq, entry.detail])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
    expect(entries[0]?.prev_hash).toEqual(GENESIS);
    expect(entries[1]?.prev_hash).toEqual(entries[0]?.entry_hash);
  });

  it('hides other tenants rows from every query', async () => {
    await handle.app.withTenant(TENANT_B.tenantId, async (tx) => {
      expect(await findRequest(tx, SIGNED)).toBeNull();
      expect(await findSignature(tx, SIGNED)).toBeNull();
      expect(await listAuditEntries(tx, CHAINED)).toEqual([]);
      expect(await lastAuditEntry(tx, CHAINED)).toBeNull();
      expect(await lockRequest(tx, CHAINED)).toBeNull();
      const page = await listRequests(tx, { pageIndex: 1, itemsPerPage: 50 });
      expect({ total: page.total, ids: page.rows.map((row) => row.request_id) }).toEqual({ total: 1, ids: [B_REQUEST] });
    });
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      expect(await findRequest(tx, B_REQUEST)).toBeNull();
      expect(await listAuditEntries(tx, B_REQUEST)).toEqual([]);
    });
    await handle.app.withTenant(TENANT_UMBRELLA.tenantId, async (tx) => {
      expect(await listRequests(tx, { pageIndex: 1, itemsPerPage: 50 })).toEqual({ rows: [], total: 0 });
      expect(await lockRequest(tx, B_REQUEST)).toBeNull();
    });
  });

  it.each<GatePhase>(['executing', 'importing', 'import-pending'])('makes every read wait out the %s phase and fail with the legacy 503', async (phase) => {
    const holderId = `window-${randomUUID()}`;
    await closeGates(handle.app, { units: UNITS, holderId, phase, allowLegacy: true });
    try {
      const reads: ((tx: TenantTx) => Promise<unknown>)[] = [
        (tx) => findRequest(tx, CHAINED),
        (tx) => listRequests(tx, { pageIndex: 1, itemsPerPage: 5 }),
        (tx) => findSignature(tx, SIGNED),
        (tx) => listAuditEntries(tx, CHAINED),
        (tx) => lastAuditEntry(tx, CHAINED),
        (tx) => lockRequest(tx, CHAINED),
      ];
      for (const read of reads) {
        const started = Date.now();
        const err = await withGatedTenant(handle.app, TENANT_A.tenantId, read, { budgetMs: 300 }).catch((caught: unknown) => caught);
        expect(err).toBeInstanceOf(UnitReadBlockedError);
        expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      }
    } finally {
      await openGates(handle.app, { units: UNITS, holderId, state: 'legacy' });
    }
  });

  it('makes lockRequest wait out a window on the audit unit alone as a blocked read', async () => {
    const units = [AUDIT_ENTRY.unit];
    const holderId = `window-${randomUUID()}`;
    await closeGates(handle.app, { units, holderId, phase: 'executing', allowLegacy: true });
    try {
      const err = await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => lockRequest(tx, CHAINED), { budgetMs: 300 }).catch((caught: unknown) => caught);
      expect(err).toBeInstanceOf(UnitReadBlockedError);
    } finally {
      await openGates(handle.app, { units, holderId, state: 'legacy' });
    }
  });

  it('reads through a closed gate in its quiet phase', async () => {
    const units = [AUDIT_ENTRY.unit];
    const holderId = `window-${randomUUID()}`;
    await closeGates(handle.app, { units, holderId, phase: 'quiet', allowLegacy: true });
    try {
      const entries = await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => listAuditEntries(tx, CHAINED), { budgetMs: 300 });
      expect(entries).toHaveLength(3);
    } finally {
      await openGates(handle.app, { units, holderId, state: 'legacy' });
    }
  });
});
