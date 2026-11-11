// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance read queries against a throwaway `finance` schema: fixture order and paging, value forms, tenant isolation and window read gates. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { UnitReadBlockedError, closeGates, ensureUnitGates, openGates, withGatedTenant, type GatePhase } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  findAttachment,
  findProgramBinding,
  findRecord,
  listAttachmentObjects,
  listAttachments,
  listRecords,
  listRollups,
  listVersions,
} from '../../src/repo/queries.js';
import { FINANCE_ATTACHMENT, FINANCE_RECORD, UNITS } from '../../src/repo/tables.js';

let handle: ThrowawaySchema;

/** A CF-format id whose first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;

const ACTOR = cfId('E', 1);
const A_RECORDS = [
  { id: cfId('A', 5), created: '2026-06-01 10:00:00.000' },
  { id: cfId('A', 3), created: '2026-06-01 10:00:00.000' },
  { id: cfId('A', 9), created: '2026-05-01 09:00:00.000' },
  { id: cfId('F', 1), created: '2026-06-01 10:00:00.000' },
  { id: cfId('A', 1), created: '2026-07-01 08:00:00.000' },
];
const RECORD_WITH_CHILDREN = cfId('A', 5);
const B_RECORD = cfId('B', 2);
const A_ATTACHMENT_LATER = cfId('C', 21);
const A_ATTACHMENT_EARLIER = cfId('C', 22);
const B_ATTACHMENT = cfId('C', 31);

/** Inserts one IN-PROGRESS record of amount 1234.5 in the transaction tenant. */
async function insertRecord(tx: TenantTx, recordId: string, created: string, program: number, siteId: string): Promise<void> {
  await tx.query(
    `INSERT INTO ${handle.schema}.record (tenant_id, record_id, siteid, title, amount, period, state, version, created, createdbyid, legacy_program_id)
     VALUES ($1, $2, $3, 'Title', 1234.5, '2026-06', 'IN-PROGRESS', 1, $4, $5, $6)`,
    [tx.tenantId, recordId, siteId, created, ACTOR, program],
  );
}

/** Inserts one attachment row of `recordId` in the transaction tenant. */
async function insertAttachment(tx: TenantTx, row: { id: string; recordId: string; fileName: string; size: number; sha: string; key: string; created: string; program: number }): Promise<void> {
  await tx.query(
    `INSERT INTO ${handle.schema}.attachment (tenant_id, attachment_id, record_id, file_name, content_type, size_bytes, sha256, object_key, created, createdbyid, legacy_program_id)
     VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6, $7, $8, $9, $10)`,
    [tx.tenantId, row.id, row.recordId, row.fileName, row.size, row.sha, row.key, row.created, ACTOR, row.program],
  );
}

/** Wraps `tx` so every statement text it runs is appended to `seen`. */
function recording(tx: TenantTx, seen: string[]): TenantTx {
  const query = ((text: string, values?: unknown[]) => {
    seen.push(text);
    return tx.query(text, values);
  }) as TenantTx['query'];
  return { ...tx, query };
}

/** Fixture order of records: `created`, then id. */
function fixtureOrder(rows: readonly { id: string; created: string }[]): string[] {
  const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return [...rows].sort((x, y) => compare(x.created, y.created) || compare(x.id, y.id)).map((row) => row.id);
}

describe.skipIf(!(await pgAvailable()))('finance read queries', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'finance', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      for (const record of A_RECORDS) await insertRecord(tx, record.id, record.created, 1, TENANT_A.siteId);
      await tx.query(
        `INSERT INTO ${handle.schema}.record_version (tenant_id, version_id, record_id, version, state, title, amount, period, action, actor_user_id, created, legacy_program_id)
         VALUES ($1, $2, $3, 2, 'SUBMITTED', 'Title', 1, '2026-06', 'submit', $4, localtimestamp(3), 1),
                ($1, $5, $3, 1, 'IN-PROGRESS', 'Title', 1, '2026-06', 'create', $4, localtimestamp(3), 1)`,
        [tx.tenantId, cfId('D', 11), RECORD_WITH_CHILDREN, ACTOR, cfId('D', 12)],
      );
      const base = { recordId: RECORD_WITH_CHILDREN, program: 1 };
      await insertAttachment(tx, { ...base, id: A_ATTACHMENT_LATER, fileName: 'b.pdf', size: 10, sha: 'a'.repeat(64), key: 'k-later', created: '2026-06-02' });
      await insertAttachment(tx, { ...base, id: A_ATTACHMENT_EARLIER, fileName: 'a.pdf', size: 20, sha: 'b'.repeat(64), key: 'k-earlier', created: '2026-06-01' });
      await tx.query(
        `INSERT INTO ${handle.schema}.rollup (tenant_id, period, state, record_count, total_amount, computed_at, legacy_program_id)
         VALUES ($1, '2026-06', 'REJECTED', 1, 1, localtimestamp(3), 1), ($1, '2026-06', 'RE-SUBMITTED', 1, 2, localtimestamp(3), 1),
                ($1, '2026-05', 'SUBMITTED', 1, 3, localtimestamp(3), 1)`,
        [tx.tenantId],
      );
      await tx.query(`INSERT INTO ${handle.schema}.program_binding VALUES ($1, $2, 1, localtimestamp(3))`, [tx.tenantId, TENANT_A.siteId]);
    });
    await handle.app.withTenant(TENANT_B.tenantId, async (tx) => {
      await insertRecord(tx, B_RECORD, '2026-01-01 00:00:00', 2, TENANT_B.siteId);
      await insertAttachment(tx, { id: B_ATTACHMENT, recordId: B_RECORD, fileName: 'x.pdf', size: 5, sha: 'c'.repeat(64), key: 'k-b', created: '2026-06-01', program: 2 });
      await tx.query(`INSERT INTO ${handle.schema}.program_binding VALUES ($1, $2, 2, localtimestamp(3))`, [tx.tenantId, TENANT_B.siteId]);
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('pages records by created then id with the total, and an empty page past the end', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      const pages = [];
      for (const pageIndex of [1, 2, 3]) pages.push(await listRecords(tx, { pageIndex, itemsPerPage: 2 }));
      expect(pages.map((page) => page.total)).toEqual([5, 5, 5]);
      expect(pages.map((page) => page.rows.length)).toEqual([2, 2, 1]);
      expect(pages.flatMap((page) => page.rows.map((row) => row.record_id))).toEqual(fixtureOrder(A_RECORDS));
      expect(await listRecords(tx, { pageIndex: 4, itemsPerPage: 2 })).toEqual({ rows: [], total: 5 });
    });
  });

  it('keeps pg value forms: money as four-decimal text, timestamps as Date, int8 as text', async () => {
    const record = await handle.app.withTenant(TENANT_A.tenantId, (tx) => findRecord(tx, RECORD_WITH_CHILDREN));
    expect(record).toMatchObject({ record_id: RECORD_WITH_CHILDREN, amount: '1234.5000', version: 1, legacy_program_id: 1, row_version: '0' });
    expect(record?.created).toBeInstanceOf(Date);
    expect(record?.lastupdate).toBeNull();
  });

  it('selects the catalogue columns of each table', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      const record = await findRecord(tx, RECORD_WITH_CHILDREN);
      const attachment = await findAttachment(tx, RECORD_WITH_CHILDREN, A_ATTACHMENT_LATER);
      expect(Object.keys(record ?? {})).toEqual(FINANCE_RECORD.columns.map((column) => column.name));
      expect(Object.keys(attachment ?? {})).toEqual(FINANCE_ATTACHMENT.columns.map((column) => column.name));
    });
  });

  it('lists versions by version, attachments by created then id, and rollups by period then state in binary order', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      expect((await listVersions(tx, RECORD_WITH_CHILDREN)).map((row) => row.version)).toEqual([1, 2]);
      expect((await listAttachments(tx, RECORD_WITH_CHILDREN)).map((row) => row.attachment_id)).toEqual([A_ATTACHMENT_EARLIER, A_ATTACHMENT_LATER]);
      expect(await listAttachments(tx, cfId('A', 3))).toEqual([]);
      const rollups = await listRollups(tx);
      expect(rollups.map((row) => `${row.period}/${row.state}`)).toEqual(['2026-05/SUBMITTED', '2026-06/RE-SUBMITTED', '2026-06/REJECTED']);
      expect(rollups[0]?.total_amount).toBe('3.0000');
    });
  });

  it('finds an attachment only under its own record', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      expect((await findAttachment(tx, RECORD_WITH_CHILDREN, A_ATTACHMENT_LATER))?.object_key).toBe('k-later');
      expect(await findAttachment(tx, cfId('A', 3), A_ATTACHMENT_LATER)).toBeNull();
    });
  });

  it('lists the attachment object manifest by attachment id', async () => {
    const objects = await handle.app.withTenant(TENANT_B.tenantId, (tx) => listAttachmentObjects(tx));
    expect(objects).toEqual([
      { attachment_id: B_ATTACHMENT, record_id: B_RECORD, object_key: 'k-b', size: 5, sha256: 'c'.repeat(64), content_type: 'application/pdf', legacy_program_id: 2 },
    ]);
  });

  it('hides tenant B rows from a tenant A transaction', async () => {
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      expect(await findRecord(tx, B_RECORD)).toBeNull();
      expect((await listRecords(tx, { pageIndex: 1, itemsPerPage: 50 })).rows.map((row) => row.record_id)).not.toContain(B_RECORD);
      expect((await listAttachmentObjects(tx)).map((row) => row.attachment_id)).toEqual([A_ATTACHMENT_LATER, A_ATTACHMENT_EARLIER]);
      expect(await findProgramBinding(tx)).toMatchObject({ site_id: TENANT_A.siteId, legacy_program_id: 1 });
    });
    await handle.app.withTenant(TENANT_B.tenantId, async (tx) => {
      expect(await findRecord(tx, RECORD_WITH_CHILDREN)).toBeNull();
      expect(await findProgramBinding(tx)).toMatchObject({ site_id: TENANT_B.siteId, legacy_program_id: 2 });
    });
  });

  it('answers no binding and an empty page for a tenant without rows', async () => {
    await handle.app.withTenant(TENANT_UMBRELLA.tenantId, async (tx) => {
      expect(await findProgramBinding(tx)).toBeNull();
      expect(await listRecords(tx, { pageIndex: 1, itemsPerPage: 50 })).toEqual({ rows: [], total: 0 });
    });
  });

  it('row-locks the record only when asked for update', async () => {
    const seen: string[] = [];
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      await findRecord(recording(tx, seen), RECORD_WITH_CHILDREN);
      expect(seen.at(-1)).not.toMatch(/FOR UPDATE/);
      expect((await findRecord(recording(tx, seen), RECORD_WITH_CHILDREN, { forUpdate: true }))?.record_id).toBe(RECORD_WITH_CHILDREN);
      expect(seen.at(-1)).toMatch(/FOR UPDATE$/);
      const other = await handle.appPool.connect();
      try {
        await other.query('BEGIN');
        await other.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A.tenantId]);
        await expect(
          other.query(`SELECT 1 FROM ${handle.schema}.record WHERE record_id = $1 FOR UPDATE NOWAIT`, [RECORD_WITH_CHILDREN]),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await other.query('ROLLBACK');
        other.release();
      }
    });
  });

  it.each<GatePhase>(['executing', 'importing', 'import-pending'])(
    'makes user reads wait out the %s phase and fail with the legacy 503, but never the export manifest or binding',
    async (phase) => {
      const units = [FINANCE_RECORD.unit, FINANCE_ATTACHMENT.unit];
      const holderId = `window-${randomUUID()}`;
      await closeGates(handle.app, { units, holderId, phase, allowLegacy: true });
      try {
        const reads: ((tx: TenantTx) => Promise<unknown>)[] = [
          (tx) => findRecord(tx, RECORD_WITH_CHILDREN),
          (tx) => listRecords(tx, { pageIndex: 1, itemsPerPage: 2 }),
          (tx) => listAttachments(tx, RECORD_WITH_CHILDREN),
          (tx) => findAttachment(tx, RECORD_WITH_CHILDREN, A_ATTACHMENT_LATER),
        ];
        for (const read of reads) {
          const started = Date.now();
          const err = await withGatedTenant(handle.app, TENANT_A.tenantId, read, { budgetMs: 300 }).catch((caught: unknown) => caught);
          expect(err).toBeInstanceOf(UnitReadBlockedError);
          expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
          expect(Date.now() - started).toBeGreaterThanOrEqual(250);
        }
        const started = Date.now();
        const objects = await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => listAttachmentObjects(tx), { budgetMs: 300 });
        expect(objects).toHaveLength(2);
        expect(await handle.app.withTenant(TENANT_A.tenantId, (tx) => findProgramBinding(tx))).not.toBeNull();
        expect(Date.now() - started).toBeLessThan(250);
      } finally {
        await openGates(handle.app, { units, holderId, state: 'legacy' });
      }
    },
  );

  it('reads through a closed gate in its quiet phase', async () => {
    const units = [FINANCE_RECORD.unit];
    const holderId = `window-${randomUUID()}`;
    await closeGates(handle.app, { units, holderId, phase: 'quiet', allowLegacy: true });
    try {
      const record = await withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => findRecord(tx, RECORD_WITH_CHILDREN), { budgetMs: 300 });
      expect(record?.record_id).toBe(RECORD_WITH_CHILDREN);
    } finally {
      await openGates(handle.app, { units, holderId, state: 'legacy' });
    }
  });
});
