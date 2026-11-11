// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Attachment object manifest against a throwaway `finance` schema and the local storage adapter: entries describe the stored bytes. */
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectManifestEntry } from '@opt2/platform/migration-kit';
import { InvalidObjectKeyError, createLocalStorageAdapter, objectKey, type LocalStorageAdapter } from '@opt2/platform/storage';
import { tenantDbFromPool, tenantIdForSite, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { createExportObjects } from '../../src/migration/objects.js';
import { MANIFEST_PAGE_SIZE } from '../../src/repo/queries.js';
import { createFinanceRepository } from '../../src/repo/repository.js';
import { ATTACHMENT_BUCKET, FINANCE_ATTACHMENT, UNITS } from '../../src/repo/tables.js';

const HMAC_KEY = 'finance-objects-test-hmac-key';
const ACTOR = 'E0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const RECORD = 'A0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a, 0x0d, 0x7f, 0x80]);
const OTHER_BYTES = Buffer.from('replaced bytes of another length', 'utf8');

/** A CF-format attachment id whose first group is `C<n>`. */
const attachmentId = (n: number): string => `C${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

let handle: ThrowawaySchema;
let stateDir: string;
let storage: LocalStorageAdapter;
let exportObjects: ReturnType<typeof createExportObjects>;

/** Inserts one attachment row per id under `tenantId`, keyed `<tenantId>/<id>.pdf`, carrying the size and SHA-256 of `BYTES`; returns the keys. */
async function insertAttachments(tenantId: string, ids: readonly string[]): Promise<string[]> {
  const keys = ids.map((id) => objectKey({ tenantId, id, ext: 'pdf' }));
  await handle.app.withTenant(tenantId, (tx) =>
    tx.query(
      `INSERT INTO ${handle.schema}.attachment (tenant_id, attachment_id, record_id, file_name, content_type, size_bytes, sha256, object_key, created, createdbyid, legacy_program_id)
       SELECT $1, t.id, $2, 'scan.pdf', 'application/pdf', $3, $4, t.key, localtimestamp(3), $5, 1 FROM unnest($6::text[], $7::text[]) AS t(id, key)`,
      [tenantId, RECORD, BYTES.length, sha256(BYTES), ACTOR, ids, keys],
    ),
  );
  return keys;
}

/** The whole manifest of `unit` for `tenantId`, read in that tenant's transaction; throws if finance answers with a manifest page. */
async function manifest(tenantId: string, unit: string = FINANCE_ATTACHMENT.unit, wrap: (tx: TenantTx) => TenantTx = (tx) => tx): Promise<ObjectManifestEntry[]> {
  const result = await handle.app.withTenant(tenantId, (tx) => exportObjects(wrap(tx), { unit, tenantId }));
  if (!Array.isArray(result)) throw new Error(`finance exportObjects answered unit ${unit} with a manifest page, not the whole manifest`);
  return result;
}

/** The entry an object of `bytes` stored for attachment `id` under `key` must have. */
function entryFor(key: string, id: string, bytes: Buffer): ObjectManifestEntry {
  return { key, size: bytes.length, sha256: sha256(bytes), contentType: 'application/pdf', legacyPath: `Program_1.finance_attachment/${id}` };
}

describe.skipIf(!(await pgAvailable()))('finance attachment object manifest', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'finance', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-finance-objects-'));
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: HMAC_KEY });
    const stagingDb = tenantDbFromPool(handle.connect('app', { max: 1 }), { schema: handle.schema });
    exportObjects = createExportObjects({ storage, repository: createFinanceRepository({ db: handle.app, stagingDb, storage, clock: fixedClock(new Date(2026, 5, 30)) }) });
  });

  afterAll(async () => {
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('lists a stored object with the size and SHA-256 of its bytes, and leaves out a missing one', async () => {
    const tenantId = tenantIdForSite('objects-present');
    const [stored, missing] = await insertAttachments(tenantId, [attachmentId(1), attachmentId(2)]);
    await storage.put(ATTACHMENT_BUCKET, stored as string, BYTES, { contentType: 'application/pdf' });
    expect(await storage.head(ATTACHMENT_BUCKET, missing as string)).toBeNull();
    expect(await manifest(tenantId)).toEqual([entryFor(stored as string, attachmentId(1), BYTES)]);
  });

  it.each<[string, (key: string) => Promise<void>, boolean]>([
    [
      'replaced under the same key',
      async (key) => {
        await storage.put(ATTACHMENT_BUCKET, key, OTHER_BYTES, { contentType: 'application/pdf' });
      },
      false,
    ],
    [
      'altered on disk behind its stored metadata',
      async (key) => {
        await storage.put(ATTACHMENT_BUCKET, key, BYTES, { contentType: 'application/pdf' });
        // The local adapter keeps the payload first in `<stateDir>/storage/<bucket>/<key>`, then its metadata trailer.
        const file = await open(path.join(stateDir, 'storage', ATTACHMENT_BUCKET, ...key.split('/')), 'r+');
        try {
          await file.write(OTHER_BYTES, 0, BYTES.length, 0);
        } finally {
          await file.close();
        }
      },
      true,
    ],
  ])('reports the actual bytes of an object %s, not the row hash', async (name, corrupt, staleHead) => {
    const tenantId = tenantIdForSite(`objects-corrupt-${name}`);
    const id = attachmentId(3);
    const [key] = (await insertAttachments(tenantId, [id])) as [string];
    await corrupt(key);
    const actual = await storage.get(ATTACHMENT_BUCKET, key);
    expect(actual.equals(BYTES)).toBe(false);
    const entries = await manifest(tenantId);
    expect(entries).toEqual([entryFor(key, id, actual)]);
    expect(entries[0]?.sha256).not.toBe(sha256(BYTES));
    expect((await storage.head(ATTACHMENT_BUCKET, key))?.sha256 === entries[0]?.sha256).toBe(!staleHead);
  });

  it('propagates a storage error other than a missing object', async () => {
    const tenantId = tenantIdForSite('objects-bad-key');
    await handle.app.withTenant(tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.attachment (tenant_id, attachment_id, record_id, file_name, content_type, size_bytes, sha256, object_key, created, createdbyid, legacy_program_id)
         VALUES ($1, $2, $3, 'scan.pdf', 'application/pdf', 1, $4, '../outside.pdf', localtimestamp(3), $5, 1)`,
        [tenantId, attachmentId(5), RECORD, sha256(BYTES), ACTOR],
      ),
    );
    await expect(manifest(tenantId)).rejects.toBeInstanceOf(InvalidObjectKeyError);
  });

  it.each(UNITS.filter((unit) => unit !== FINANCE_ATTACHMENT.unit))('answers no objects for unit %s', async (unit) => {
    const tenantId = tenantIdForSite(`objects-${unit}`);
    const [key] = (await insertAttachments(tenantId, [attachmentId(4)])) as [string];
    await storage.put(ATTACHMENT_BUCKET, key, BYTES, { contentType: 'application/pdf' });
    expect(await manifest(tenantId, unit)).toEqual([]);
  });

  it('reads more rows than one keyset page and lists every stored object once, by attachment id', async () => {
    const tenantId = tenantIdForSite('objects-pages');
    const ids = Array.from({ length: MANIFEST_PAGE_SIZE + 1 }, (_, n) => attachmentId(MANIFEST_PAGE_SIZE + 1 - n));
    const keys = await insertAttachments(tenantId, ids);
    for (let start = 0; start < keys.length; start += 50) {
      await Promise.all(keys.slice(start, start + 50).map((key) => storage.put(ATTACHMENT_BUCKET, key, BYTES, { contentType: 'application/pdf' })));
    }
    const seen: string[] = [];
    const recording = (tx: TenantTx): TenantTx => ({
      ...tx,
      query: ((text: string, values?: unknown[]) => {
        seen.push(text);
        return tx.query(text, values);
      }) as TenantTx['query'],
    });
    const entries = await manifest(tenantId, FINANCE_ATTACHMENT.unit, recording);
    expect(entries.map((entry) => entry.legacyPath)).toEqual([...ids].sort().map((id) => `Program_1.finance_attachment/${id}`));
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(ids.length);
    expect(entries.every((entry) => entry.sha256 === sha256(BYTES) && entry.size === BYTES.length)).toBe(true);
    expect(seen.map((text) => /LIMIT \$\d+$/.test(text) && (text.includes('"attachment_id" > $1') ? 'after' : 'first'))).toEqual(['first', 'after']);
  });
});
