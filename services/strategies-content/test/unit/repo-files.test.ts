/** `repo/files` read queries over a throwaway `content` schema: legacy select lists, case-insensitive ids, rendition filters, metadata, object manifest paging, content references, tenant isolation and window read gates. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitReadBlockedError, closeGates, ensureUnitGates, openGates, withGatedTenant, type GatePhase } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  fileIdsReferencedInContent,
  findFileObject,
  findFileObjectBySha,
  listDeletedFileIds,
  listFileMetadata,
  listFileObjects,
  listFileObjectsForExport,
  readFile,
  readFileAll,
  readFileMedium,
  readFileMeta,
  readFileSmall,
} from '../../src/repo/files.js';
import { CONTENT_UNITS, FILE, UNIT_OF } from '../../src/repo/tables.js';

/** A CF-format id whose first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;

/** `id` with its first group in lower case. */
const mixedCase = (id: string): string => `${id.slice(0, 9).toLowerCase()}${id.slice(9)}`;

const WITH_RENDITIONS = cfId('F', 1);
const DELETED_PLAIN = cfId('F', 2);
const DELETED_POOLED = cfId('F', 3);
const B_FILE = cfId('B', 1);
const MISSING = cfId('Z', 9);
const HIST_1 = cfId('H', 1);
const HIST_2 = cfId('H', 2);
const ATTRIBUTE_BASE = cfId('X', 1);
const CONTENT_ID = cfId('C', 1);
const SHA = 'a'.repeat(64);

// Ids stored in mixed case, as a caller-supplied fileID or contentHistID can be; their rows are in the umbrella tenant.
const MIXED_FILE = '6300Ed4a-1320-5cC3-f9D6a2D279e386d0';
const MIXED_HIST = '7300Ed4a-1320-5cC3-f9D6a2D279e386d0';
const MIXED_BASE = '8300Ed4a-1320-5cC3-f9D6a2D279e386d0';
const MIXED_ATTRIBUTE_FILE = '9300Ed4a-1320-5cC3-f9D6a2D279e386d0';

/** Spellings SQL Server's case-insensitive char equality treats as the stored id. */
const SPELLINGS: [string, (id: string) => string][] = [
  ['in lower case', (id) => id.toLowerCase()],
  ['in upper case', (id) => id.toUpperCase()],
  ['with trailing spaces', (id) => `${id.toLowerCase()}  `],
];

const READ_LIST = ['fileid', 'contentid', 'siteid', 'moduleid', 'filename', 'filesize', 'contenttype', 'contentsubtype', 'fileext'];

let handle: ThrowawaySchema;

/** Inserts one `content.file` row in the transaction tenant. */
async function insertFile(tx: TenantTx, fileId: string, siteId: string, opts: { renditions?: boolean; deleted?: number } = {}): Promise<void> {
  await tx.query(
    `INSERT INTO ${handle.schema}.file (tenant_id, fileid, contentid, siteid, moduleid, filename, image, imagesmall, imagemedium, filesize,
       contenttype, contentsubtype, fileext, created, deleted, caption, credits, alttext, exif)
     VALUES ($1, $2, $3, $4, '00000000000000000000000000000000003', 'a.png', $5, $6, $7, 3, 'image', 'png', 'png',
       '2026-06-01 10:00:00.000', $8, 'cap', 'cred', 'alt', '{}')`,
    [
      tx.tenantId,
      fileId,
      CONTENT_ID,
      siteId,
      Buffer.from('original'),
      opts.renditions ? Buffer.from('small') : null,
      opts.renditions ? Buffer.from('medium') : null,
      opts.deleted ?? 0,
    ],
  );
}

/** Inserts one `content.file_object` row in the transaction tenant under its `<tenant>/<fileID><variant>.<ext>` key. */
async function insertObject(tx: TenantTx, fileId: string, variant: string, ext: string): Promise<void> {
  await tx.query(
    `INSERT INTO ${handle.schema}.file_object (tenant_id, file_id, variant, ext, object_key, size, sha256, content_type, orphan, created_at)
     VALUES ($1, $2, $3, $4, $5, 12, $6, 'image/png', false, '2026-06-01 10:00:00.000')`,
    [tx.tenantId, fileId, variant, ext, `${tx.tenantId}/${fileId}${variant}.${ext}`, SHA],
  );
}

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_B.tenantId, fn);
const inUmbrella = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_UMBRELLA.tenantId, fn);

describe.skipIf(!(await pgAvailable()))('repo/files', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await inA(async (tx) => {
      await insertFile(tx, WITH_RENDITIONS, TENANT_A.siteId, { renditions: true });
      await insertFile(tx, DELETED_PLAIN, TENANT_A.siteId, { deleted: 1 });
      await insertFile(tx, DELETED_POOLED, 'umbrella', { deleted: 1 });
      for (const variant of ['_small', '', '_source', '_medium']) await insertObject(tx, WITH_RENDITIONS, variant, 'png');
      await insertObject(tx, DELETED_PLAIN, '', 'pdf');
      await tx.query(
        `INSERT INTO ${handle.schema}.file_metadata (tenant_id, metaid, fileid, contenthistid, contentid, siteid, alttext)
         VALUES ($1, $2, $3, $4, $5, $6, 'hist-1'), ($1, $7, $3, $8, $5, $6, 'hist-2'), ($1, $9, $10, $4, $5, 'other', 'other-site')`,
        [tx.tenantId, cfId('M', 2), WITH_RENDITIONS, HIST_1, CONTENT_ID, TENANT_A.siteId, cfId('M', 1), HIST_2, cfId('M', 3), DELETED_PLAIN],
      );
      await tx.query(
        `INSERT INTO ${handle.schema}.content (tenant_id, contentid, contenthistid, fileid, siteid) VALUES ($1, $2, $3, $4, $6), ($1, $5, NULL, $7, $6)`,
        [tx.tenantId, CONTENT_ID, HIST_1, WITH_RENDITIONS, cfId('C', 2), TENANT_A.siteId, DELETED_POOLED],
      );
      await tx.query(
        `INSERT INTO ${handle.schema}.extend_data (tenant_id, baseid, attributeid, siteid, stringvalue) VALUES ($1, $2, 1, $3, $4)`,
        [tx.tenantId, ATTRIBUTE_BASE, TENANT_A.siteId, DELETED_PLAIN],
      );
    });
    await inB(async (tx) => {
      await insertFile(tx, B_FILE, TENANT_B.siteId, { renditions: true, deleted: 1 });
      await insertObject(tx, B_FILE, '', 'png');
    });
    await inUmbrella(async (tx) => {
      await insertFile(tx, MIXED_FILE, TENANT_UMBRELLA.siteId, { renditions: true });
      for (const variant of ['_small', '']) await insertObject(tx, MIXED_FILE, variant, 'png');
      await tx.query(
        `INSERT INTO ${handle.schema}.file_metadata (tenant_id, metaid, fileid, contenthistid, contentid, siteid, alttext) VALUES ($1, $2, $3, $4, $5, $6, 'mixed')`,
        [tx.tenantId, cfId('M', 4), MIXED_FILE, MIXED_HIST, CONTENT_ID, TENANT_UMBRELLA.siteId],
      );
      await tx.query(`INSERT INTO ${handle.schema}.content (tenant_id, contentid, contenthistid, fileid, siteid) VALUES ($1, $2, $3, $4, $5)`, [
        tx.tenantId,
        CONTENT_ID,
        MIXED_HIST,
        MIXED_FILE,
        TENANT_UMBRELLA.siteId,
      ]);
      await tx.query(`INSERT INTO ${handle.schema}.extend_data (tenant_id, baseid, attributeid, siteid, stringvalue) VALUES ($1, $2, 1, $3, $4)`, [
        tx.tenantId,
        MIXED_BASE,
        TENANT_UMBRELLA.siteId,
        MIXED_ATTRIBUTE_FILE,
      ]);
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('reads the fileDAO select lists in legacy column order', async () => {
    const read = await inA((tx) => readFile(tx, WITH_RENDITIONS));
    expect(Object.keys(read ?? {})).toEqual([...READ_LIST, 'image', 'created', 'alttext', 'caption', 'credits']);
    expect(read?.image).toEqual(Buffer.from('original'));
    expect(read?.created).toBeInstanceOf(Date);
    expect(Object.keys((await inA((tx) => readFileAll(tx, WITH_RENDITIONS))) ?? {})).toEqual(FILE.columns.map((column) => column.name));
    expect(Object.keys((await inA((tx) => readFileMeta(tx, WITH_RENDITIONS))) ?? {})).toEqual([...READ_LIST, 'created', 'alttext', 'caption', 'credits']);
    const small = await inA((tx) => readFileSmall(tx, WITH_RENDITIONS));
    expect(Object.keys(small ?? {})).toEqual([...READ_LIST, 'imagesmall', 'created', 'alttext', 'caption', 'credits']);
    expect(small?.imagesmall).toEqual(Buffer.from('small'));
    const medium = await inA((tx) => readFileMedium(tx, WITH_RENDITIONS));
    expect(Object.keys(medium ?? {})).toEqual([...READ_LIST, 'imagemedium', 'created']);
    expect(medium?.imagemedium).toEqual(Buffer.from('medium'));
  });

  it.each<[string, (tx: TenantTx, fileId: string) => Promise<unknown>, string]>([
    ['readFile', readFile, MISSING],
    ['readFileAll', readFileAll, MISSING],
    ['readFileMeta', readFileMeta, MISSING],
    ['readFileSmall', readFileSmall, MISSING],
    ['readFileMedium', readFileMedium, MISSING],
    ['readFileSmall without a small image', readFileSmall, DELETED_PLAIN],
    ['readFileMedium without a medium image', readFileMedium, DELETED_PLAIN],
    ['readFileSmall without a small image, by a lower-case id', readFileSmall, DELETED_PLAIN.toLowerCase()],
    ['readFile of another tenant', readFile, B_FILE],
  ])('%s answers null', async (_label, read, fileId) => {
    expect(await inA((tx) => read(tx, fileId))).toBeNull();
  });

  it.each<[string, (tx: TenantTx, fileId: string) => Promise<{ fileid: string } | null>, string]>([
    ['readFile', readFile, WITH_RENDITIONS.toLowerCase()],
    ['readFileAll', readFileAll, mixedCase(WITH_RENDITIONS)],
    ['readFileMeta', readFileMeta, `${WITH_RENDITIONS.toLowerCase()}  `],
    ['readFileSmall', readFileSmall, WITH_RENDITIONS.toLowerCase()],
    ['readFileMedium', readFileMedium, mixedCase(WITH_RENDITIONS)],
  ])('%s finds a stored upper-case id by another spelling and returns it as stored', async (_label, read, fileId) => {
    expect((await inA((tx) => read(tx, fileId)))?.fileid).toBe(WITH_RENDITIONS);
  });

  it('lists deleted file ids per tenant, narrowed to a non-empty site id', async () => {
    expect(await inA((tx) => listDeletedFileIds(tx))).toEqual([DELETED_PLAIN, DELETED_POOLED]);
    expect(await inA((tx) => listDeletedFileIds(tx, ''))).toEqual([DELETED_PLAIN, DELETED_POOLED]);
    expect(await inA((tx) => listDeletedFileIds(tx, TENANT_A.siteId))).toEqual([DELETED_PLAIN]);
    expect(await inA((tx) => listDeletedFileIds(tx, `${TENANT_A.siteId.toUpperCase()} `))).toEqual([DELETED_PLAIN]);
    expect(await inB((tx) => listDeletedFileIds(tx))).toEqual([B_FILE]);
  });

  it.each([
    ['a file', { siteId: TENANT_A.siteId, fileId: WITH_RENDITIONS }, ['hist-2', 'hist-1']],
    ['a content version', { siteId: TENANT_A.siteId, contentHistId: HIST_1 }, ['hist-1']],
    ['a file in one version', { siteId: TENANT_A.siteId, fileId: WITH_RENDITIONS, contentHistId: HIST_2 }, ['hist-2']],
    ['another site', { siteId: 'other', fileId: WITH_RENDITIONS }, []],
    ['a file by a lower-case id', { siteId: TENANT_A.siteId, fileId: WITH_RENDITIONS.toLowerCase() }, ['hist-2', 'hist-1']],
    ['a content version by a lower-case id', { siteId: TENANT_A.siteId, contentHistId: HIST_1.toLowerCase() }, ['hist-1']],
    ['a site spelt in another case', { siteId: TENANT_A.siteId.toUpperCase(), fileId: mixedCase(WITH_RENDITIONS) }, ['hist-2', 'hist-1']],
  ])('lists the metadata of %s by metaid', async (_label, filter, alttexts) => {
    expect((await inA((tx) => listFileMetadata(tx, filter))).map((row) => row.alttext)).toEqual(alttexts);
  });

  it('reads stored objects by file, variant and key', async () => {
    const objects = await inA((tx) => listFileObjects(tx, WITH_RENDITIONS));
    expect(objects.map((row) => row.variant)).toEqual(['', '_medium', '_small', '_source']);
    expect(objects[0]).toMatchObject({ size: '12', orphan: false, sha256: SHA, file_id: WITH_RENDITIONS });
    expect((await inA((tx) => findFileObject(tx, WITH_RENDITIONS, '_small')))?.object_key).toBe(`${TENANT_A.tenantId}/${WITH_RENDITIONS}_small.png`);
    expect(await inA((tx) => findFileObject(tx, DELETED_PLAIN, '_small'))).toBeNull();
    expect((await inA((tx) => findFileObjectBySha(tx, `${TENANT_A.tenantId}/${DELETED_PLAIN}.pdf`)))?.sha256).toBe(SHA);
    expect(await inA((tx) => findFileObjectBySha(tx, `${TENANT_B.tenantId}/${B_FILE}.png`))).toBeNull();
  });

  it('reads stored objects by another spelling of the file id, as stored', async () => {
    const objects = await inA((tx) => listFileObjects(tx, WITH_RENDITIONS.toLowerCase()));
    expect(objects.map((row) => [row.variant, row.file_id])).toEqual(['', '_medium', '_small', '_source'].map((variant) => [variant, WITH_RENDITIONS]));
    expect((await inA((tx) => findFileObject(tx, mixedCase(WITH_RENDITIONS), '_small')))?.object_key).toBe(`${TENANT_A.tenantId}/${WITH_RENDITIONS}_small.png`);
  });

  it('pages the object manifest by key with the export columns, per tenant', async () => {
    const all = await inA((tx) => listFileObjectsForExport(tx, { limit: 100 }));
    expect(Object.keys(all[0] ?? {})).toEqual(['object_key', 'file_id', 'variant', 'ext', 'size', 'sha256', 'content_type', 'orphan']);
    const keys = all.map((row) => row.object_key);
    expect(keys).toHaveLength(5);
    expect([...keys].sort()).toEqual(keys);
    const paged: string[] = [];
    let afterKey: string | undefined;
    for (;;) {
      const page = await inA((tx) => listFileObjectsForExport(tx, { limit: 2, ...(afterKey === undefined ? {} : { afterKey }) }));
      paged.push(...page.map((row) => row.object_key));
      if (page.length < 2) break;
      afterKey = page[page.length - 1]?.object_key;
    }
    expect(paged).toEqual(keys);
    expect((await inB((tx) => listFileObjectsForExport(tx, { limit: 100 }))).map((row) => row.file_id)).toEqual([B_FILE]);
  });

  it.each([
    ['an empty list without a query', [], [HIST_2], []],
    ['content and attribute references, deduplicated in input order', [DELETED_PLAIN, WITH_RENDITIONS, WITH_RENDITIONS, B_FILE], [HIST_2], [DELETED_PLAIN, WITH_RENDITIONS]],
    ['nothing once the referencing bases are excluded', [WITH_RENDITIONS, DELETED_PLAIN], [HIST_1, ATTRIBUTE_BASE], []],
    ['no NULL-version reference, as legacy NOT IN', [DELETED_POOLED], [], []],
    ['references when no base is excluded', [WITH_RENDITIONS], [], [WITH_RENDITIONS]],
    [
      'references by other spellings of stored ids, in the caller spelling',
      [`${DELETED_PLAIN.toLowerCase()} `, mixedCase(WITH_RENDITIONS)],
      [HIST_2],
      [`${DELETED_PLAIN.toLowerCase()} `, mixedCase(WITH_RENDITIONS)],
    ],
    ['nothing once the referencing bases are excluded by other spellings', [WITH_RENDITIONS.toLowerCase(), DELETED_PLAIN], [HIST_1.toLowerCase(), mixedCase(ATTRIBUTE_BASE)], []],
  ])('fileIdsReferencedInContent finds %s', async (_label, fileIds, excluded, expected) => {
    expect(await inA((tx) => fileIdsReferencedInContent(tx, fileIds, excluded))).toEqual(expected);
  });

  it.each(SPELLINGS)('reads a mixed-case stored file id spelt %s, as stored', async (_spelling, spell) => {
    const reads: [string, (tx: TenantTx, fileId: string) => Promise<{ fileid: string } | null>][] = [
      ['readFile', readFile],
      ['readFileAll', readFileAll],
      ['readFileMeta', readFileMeta],
      ['readFileSmall', readFileSmall],
      ['readFileMedium', readFileMedium],
    ];
    for (const [name, read] of reads) {
      expect((await inUmbrella((tx) => read(tx, spell(MIXED_FILE))))?.fileid, name).toBe(MIXED_FILE);
    }
  });

  it.each(SPELLINGS)('lists the metadata of a mixed-case stored file id and content version spelt %s, as stored', async (_spelling, spell) => {
    const stored = [[MIXED_FILE, MIXED_HIST]];
    const list = (filter: { fileId?: string; contentHistId?: string }): Promise<string[][]> =>
      inUmbrella(async (tx) => (await listFileMetadata(tx, { siteId: TENANT_UMBRELLA.siteId, ...filter })).map((row) => [row.fileid ?? '', row.contenthistid ?? '']));
    expect(await list({ fileId: spell(MIXED_FILE) })).toEqual(stored);
    expect(await list({ contentHistId: spell(MIXED_HIST) })).toEqual(stored);
    expect(await list({ fileId: spell(MIXED_FILE), contentHistId: spell(MIXED_HIST) })).toEqual(stored);
  });

  it.each(SPELLINGS)('reads the stored objects of a mixed-case stored file id spelt %s, as stored', async (_spelling, spell) => {
    const objects = await inUmbrella((tx) => listFileObjects(tx, spell(MIXED_FILE)));
    expect(objects.map((row) => [row.variant, row.file_id])).toEqual([
      ['', MIXED_FILE],
      ['_small', MIXED_FILE],
    ]);
    expect(await inUmbrella((tx) => findFileObject(tx, spell(MIXED_FILE), '_small'))).toMatchObject({
      file_id: MIXED_FILE,
      object_key: `${TENANT_UMBRELLA.tenantId}/${MIXED_FILE}_small.png`,
    });
  });

  it.each(SPELLINGS)('fileIdsReferencedInContent matches mixed-case stored references and bases spelt %s', async (_spelling, spell) => {
    const asked = [spell(MIXED_FILE), spell(MIXED_ATTRIBUTE_FILE)];
    expect(await inUmbrella((tx) => fileIdsReferencedInContent(tx, asked, []))).toEqual(asked);
    expect(await inUmbrella((tx) => fileIdsReferencedInContent(tx, asked, [spell(MIXED_HIST)]))).toEqual([spell(MIXED_ATTRIBUTE_FILE)]);
    expect(await inUmbrella((tx) => fileIdsReferencedInContent(tx, asked, [spell(MIXED_HIST), spell(MIXED_BASE)]))).toEqual([]);
  });

  it.each<GatePhase>(['executing', 'importing', 'import-pending'])(
    'makes user reads wait out the %s phase and fail with UnitReadBlockedError, but never the migration object reads',
    async (phase) => {
      const units = [UNIT_OF.file, UNIT_OF.file_metadata, UNIT_OF.content, UNIT_OF.extend_data];
      const holderId = `window-${randomUUID()}`;
      await closeGates(handle.app, { units, holderId, phase, allowLegacy: true });
      try {
        const reads: ((tx: TenantTx) => Promise<unknown>)[] = [
          (tx) => readFile(tx, WITH_RENDITIONS),
          (tx) => readFileAll(tx, WITH_RENDITIONS),
          (tx) => readFileMeta(tx, WITH_RENDITIONS),
          (tx) => readFileSmall(tx, WITH_RENDITIONS),
          (tx) => readFileMedium(tx, WITH_RENDITIONS),
          (tx) => listFileMetadata(tx, { siteId: TENANT_A.siteId }),
          (tx) => findFileObject(tx, WITH_RENDITIONS, ''),
          (tx) => listFileObjects(tx, WITH_RENDITIONS),
          (tx) => listDeletedFileIds(tx),
          (tx) => fileIdsReferencedInContent(tx, [WITH_RENDITIONS], [HIST_2]),
        ];
        for (const read of reads) {
          const err = await withGatedTenant(handle.app, TENANT_A.tenantId, read, { budgetMs: 200 }).catch((caught: unknown) => caught);
          expect(err).toBeInstanceOf(UnitReadBlockedError);
        }
        const started = Date.now();
        expect(await inA((tx) => listFileObjectsForExport(tx, { limit: 10 }))).toHaveLength(5);
        expect(await inA((tx) => findFileObjectBySha(tx, `${TENANT_A.tenantId}/${DELETED_PLAIN}.pdf`))).not.toBeNull();
        expect(Date.now() - started).toBeLessThan(150);
      } finally {
        await openGates(handle.app, { units, holderId, state: 'legacy' });
      }
    },
  );
});
