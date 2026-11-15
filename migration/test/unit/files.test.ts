// Unit tests of the legacy file-store move over the shared doubles: stored names, the manifest built from the bridge
// double's listings into a migrated migration schema, and the byte-exact transfer to the strategies-content owner double.
import { DEFAULT_UMBRELLA_SITE_ID, sha256Hex } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { pgAvailable } from '@opt2/platform/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FileHashMismatchError,
  FileStoreUnsupportedError,
  InvalidStoredNameError,
  STORED_NAME_PATTERN,
  STORED_VARIANTS,
  buildFileManifest,
  compareManifestKeys,
  formatStoredName,
  nameFromStorePath,
  objectKey,
  parseObjectKey,
  parseStoredName,
  planObjects,
  readManifest,
  storePath,
  transferFiles,
  type ManifestEntry,
  type ManifestKey,
  type PlannedObject,
  type StoredName,
  type StoredVariant,
} from '../../src/files/index.js';
import { BridgeHashMismatchError, UnsupportedFileStoreError } from '../../src/legacy/index.js';
import type { BridgeDouble } from '../helpers/bridge-double.js';
import {
  MIGRATION_SCHEMA_SKIP_REASON,
  buildTestContext,
  withMigrationSchema,
  type MigrationSchemaHandle,
  type TestContext,
} from '../helpers/context.js';
import { TEST_SOURCE_SHA } from '../helpers/env.js';
import { createFakeLegacyDb } from '../helpers/fake-legacy-db.js';
import { FILE_BYTES, FILE_LISTINGS, FIXTURE_FILES, seedFakeLegacy, type FixtureFile } from '../helpers/fixtures.js';

const ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const CONTENT_OWNER = 'strategies-content';
const SNAPSHOT_SEQ = 1;
const SNAPSHOT_DB = 'masa_test_opt2_snap_1';
const UMBRELLA_TENANT = tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID);
const OCTET_STREAM = 'application/octet-stream';
const INSERT_SNAPSHOT_SQL =
  'INSERT INTO migration.snapshot (seq, database_name, backup_file, kind, state, taken_at, source_sha) ' +
  "VALUES ($1, $2, $3, 'seed', 'ready', $4, $5)";

/** One object fileDAO stores for a fixture file. */
interface StoredObject {
  file: FixtureFile;
  variant: StoredVariant;
  ext: string;
  name: string;
}

// fileDAO.cfc:153-199: images add _source, _small and _medium in their own extension; flv adds _small.jpg and _medium.jpg.
function fileDaoVariants(ext: string): [StoredVariant, string][] {
  if (['png', 'gif', 'jpg', 'jpeg'].includes(ext)) return [['', ext], ['_source', ext], ['_small', ext], ['_medium', ext]];
  if (ext === 'flv') return [['', 'flv'], ['_small', 'jpg'], ['_medium', 'jpg']];
  return [['', ext]];
}

const STORED: readonly StoredObject[] = Object.values(FIXTURE_FILES).flatMap((file) =>
  fileDaoVariants(file.ext).map(([variant, ext]) => ({ file, variant, ext, name: `${file.fileId}${variant}.${ext}` })),
);

const pathOf = (siteId: string, name: string): string => `${siteId}/cache/file/${name}`;

function bytesOf(name: string): Buffer {
  const bytes = FILE_BYTES[name];
  if (bytes === undefined) throw new Error(`No fixture bytes for ${name}`);
  return bytes;
}

function storedObject(file: FixtureFile, variant: StoredVariant): StoredObject {
  const found = STORED.find((object) => object.file === file && object.variant === variant);
  if (found === undefined) throw new Error(`No stored ${variant || 'original'} of ${file.filename}`);
  return found;
}

const TOTAL_BYTES = STORED.reduce((sum, object) => sum + bytesOf(object.name).length, 0);

/** Manifest entry of `object` as listed from the directory of `siteId`, holding `bytes`. */
function expectedEntry(object: StoredObject, siteId: string = object.file.siteId, bytes = bytesOf(object.name)): ManifestEntry {
  return {
    snapshotSeq: SNAPSHOT_SEQ,
    siteId,
    path: pathOf(siteId, object.name),
    name: object.name,
    fileId: object.file.fileId,
    variant: object.variant,
    ext: object.ext,
    size: bytes.length,
    sha256: sha256Hex(bytes),
    orphan: !object.file.catalogued,
  };
}

/** Tenant of a stored object: its `tfiles` site, which is the file-pool site, or the umbrella for an orphan. */
const tenantOf = (object: StoredObject): string => (object.file.catalogued ? tenantIdForSite(object.file.siteId) : UMBRELLA_TENANT);

/** Content type of a stored object: its `tfiles` type, image/jpeg for an flv's renditions, octet-stream without a row. */
function contentTypeOf(object: StoredObject): string {
  if (!object.file.catalogued) return OCTET_STREAM;
  return object.ext === object.file.ext ? `${object.file.contentType}/${object.file.contentSubType}` : 'image/jpeg';
}

function expectedPlan(entry: ManifestEntry, object: StoredObject, status: PlannedObject['status'] = 'transfer'): PlannedObject {
  const tenantId = tenantOf(object);
  return { entry, tenantId, key: `${tenantId}/${object.name}`, contentType: contentTypeOf(object), status, orphan: !object.file.catalogued };
}

const keyOf = (entry: ManifestKey): ManifestKey => ({ siteId: entry.siteId, path: entry.path });

describe('stored names', () => {
  it('lists each fixture file under exactly the names fileDAO writes for it', () => {
    const listed = Object.entries(FILE_LISTINGS).flatMap(([siteId, listing]) => listing.files.map((file) => pathOf(siteId, file.name)));
    expect(listed.sort()).toEqual(STORED.map((object) => pathOf(object.file.siteId, object.name)).sort());
  });

  it.each<[string, StoredName]>([
    ...STORED.map((object): [string, StoredName] => [object.name, { fileId: object.file.fileId, variant: object.variant, ext: object.ext }]),
    [`${ID}.pdf`, { fileId: ID, variant: '', ext: 'pdf' }],
    [`${ID}_source.png`, { fileId: ID, variant: '_source', ext: 'png' }],
    [`${ID}_small.jpg`, { fileId: ID, variant: '_small', ext: 'jpg' }],
    [`${ID}_medium.gif`, { fileId: ID, variant: '_medium', ext: 'gif' }],
    // On-demand renditions carry their image-size name (processImgCfimage.cfc:190-201), so any `_<name>` is a variant.
    [`${ID}_large.png`, { fileId: ID, variant: '_large', ext: 'png' }],
  ])('parses %s, formats it back, and keys it under its store path and tenant', (name, parts) => {
    const tenant = tenantIdForSite('tenant-a');

    expect(parseStoredName(name)).toEqual(parts);
    expect(formatStoredName(parts)).toBe(name);
    expect(storePath('tenant-a', name)).toBe(`tenant-a/cache/file/${name}`);
    expect(nameFromStorePath(storePath('tenant-a', name))).toBe(name);
    expect(objectKey(tenant, parts.fileId, parts.variant, parts.ext)).toBe(`${tenant}/${name}`);
    expect(parseObjectKey(`${tenant}/${name}`)).toEqual({ tenantId: tenant, ...parts });
  });

  it.each([
    '../x.png',
    `${ID.slice(1)}.png`,
    ID,
    `${ID}_small`,
    `${ID}.`,
    `${ID}.tar.gz`,
    pathOf('tenant-a', `${ID}.png`),
    `${ID}_a/b.png`,
    `${ID}_a\\b.png`,
  ])('rejects %j as a stored name and as the name part of an object key', (name) => {
    expect(parseStoredName(name)).toBeNull();
    expect(parseObjectKey(`${tenantIdForSite('tenant-a')}/${name}`)).toBeNull();
  });

  it('refuses an object key whose tenant is not a tenant UUID or whose name is not a stored name', () => {
    const tenant = tenantIdForSite('tenant-a');

    expect(() => objectKey('tenant-a', ID, '_small', 'jpg')).toThrow(InvalidStoredNameError);
    expect(() => objectKey('tenant-a', ID, '_small', 'jpg')).toThrow(expect.objectContaining({ value: `tenant-a/${ID}_small.jpg` }));
    expect(() => objectKey(tenant, ID.slice(1), '', 'jpg')).toThrow(InvalidStoredNameError);
    expect(parseObjectKey(`tenant-a/${ID}.jpg`)).toBeNull();
    expect(parseObjectKey(`${tenant}/cache/${ID}.jpg`)).toBeNull();
  });

  it('names objects by a 35-character fileID, an optional `_` variant and the extension after the last dot', () => {
    expect(STORED_NAME_PATTERN).toEqual(/^([A-Za-z0-9-]{35})(_[^/\\\u0000-\u001F\u007F]+)?\.([A-Za-z0-9]+)$/);
    expect(STORED_VARIANTS).toEqual(['', '_source', '_small', '_medium']);
  });
});

const schemaAvailable = await pgAvailable();
const pgTitle = (title: string): string => (schemaAvailable ? title : `${title} (skipped: ${MIGRATION_SCHEMA_SKIP_REASON})`);

describe.skipIf(!schemaAvailable)(pgTitle('file store against a migrated migration schema'), () => {
  let schema: MigrationSchemaHandle | undefined;
  let t: TestContext;

  function db(): MigrationSchemaHandle['db'] {
    if (schema === undefined) throw new Error(MIGRATION_SCHEMA_SKIP_REASON);
    return schema.db;
  }

  function bridge(): BridgeDouble {
    if (t.bridge === null) throw new Error('The test context started no bridge double');
    return t.bridge;
  }

  const content = () => {
    if (t.owners === null) throw new Error('The test context has no owner doubles');
    return t.owners.owner(CONTENT_OWNER);
  };

  const manifestComplete = (): Promise<boolean | undefined> =>
    db().withMetadata(async (tx) => {
      const result = await tx.query<{ manifest_complete: boolean }>('SELECT manifest_complete FROM migration.snapshot WHERE seq = $1', [SNAPSHOT_SEQ]);
      return result.rows[0]?.manifest_complete;
    });

  const bridgeSites = (op: string): (string | undefined)[] =>
    bridge()
      .calls.filter((call) => call.op === op)
      .map((call) => call.query.siteid);

  beforeAll(async () => {
    schema = (await withMigrationSchema()) ?? undefined;
    if (schema === undefined) throw new Error(MIGRATION_SCHEMA_SKIP_REASON);
  });

  afterAll(async () => {
    await schema?.drop();
  });

  beforeEach(async () => {
    await db().withMetadata(async (tx) => {
      await tx.query('DELETE FROM migration.file_manifest');
      await tx.query('DELETE FROM migration.snapshot');
      await tx.query(INSERT_SNAPSHOT_SQL, [SNAPSHOT_SEQ, SNAPSHOT_DB, 'snap-1.bak', '2026-06-01 09:00:00', TEST_SOURCE_SHA]);
    });
    // The fake's live database is the restored snapshot the manifest reads its sites and tfiles rows from.
    const legacy = createFakeLegacyDb({ database: SNAPSHOT_DB });
    seedFakeLegacy(legacy);
    t = await buildTestContext({ legacy, migrationDb: db() });
  });

  afterEach(async () => {
    await t.close();
  });

  describe('buildFileManifest', () => {
    it('records every listed object with its variant, size, SHA-256 and orphan flag, read back in key order', async () => {
      const built = await buildFileManifest(t.ctx, SNAPSHOT_SEQ);

      expect(built).toEqual({
        snapshotSeq: SNAPSHOT_SEQ,
        database: SNAPSHOT_DB,
        sites: 4,
        entries: STORED.length,
        orphans: 1,
        bytes: TOTAL_BYTES,
        skipped: [],
      });
      const entries = await readManifest(t.ctx, SNAPSHOT_SEQ);
      expect(entries).toEqual(STORED.map((object) => expectedEntry(object)).sort(compareManifestKeys));
      const variantsOf = (file: FixtureFile): string[] =>
        entries.filter((entry) => entry.fileId === file.fileId).map((entry) => `${entry.variant}.${entry.ext}`);
      expect(variantsOf(FIXTURE_FILES.image)).toEqual(['.jpg', '_medium.jpg', '_small.jpg', '_source.jpg']);
      expect(variantsOf(FIXTURE_FILES.video)).toEqual(['.flv', '_medium.jpg', '_small.jpg']);
      expect(variantsOf(FIXTURE_FILES.pdf)).toEqual(['.pdf']);
      expect(entries.filter((entry) => entry.orphan).map((entry) => entry.fileId)).toEqual([FIXTURE_FILES.orphan.fileId]);
      expect(bridgeSites('files.list')).toEqual(['default', 'tenant-a', 'tenant-b', DEFAULT_UMBRELLA_SITE_ID]);
      expect(await manifestComplete()).toBe(true);
    });

    it('takes renditions from the listing rather than assuming them, replacing the snapshot rows on a rebuild', async () => {
      const image = FIXTURE_FILES.image;
      await buildFileManifest(t.ctx, SNAPSHOT_SEQ);
      const onDemand = Buffer.from('on-demand rendition bytes', 'utf8');
      bridge().files.delete(pathOf(image.siteId, `${image.fileId}_small.jpg`));
      bridge().files.set(pathOf(image.siteId, `${image.fileId}_W100_H50.jpg`), onDemand);

      const built = await buildFileManifest(t.ctx, SNAPSHOT_SEQ);

      expect(built.entries).toBe(STORED.length);
      const entries = (await readManifest(t.ctx, SNAPSHOT_SEQ)).filter((entry) => entry.fileId === image.fileId);
      expect(entries.map((entry) => entry.variant)).toEqual(['', '_W100_H50', '_medium', '_source']);
      expect(entries[1]).toMatchObject({ ext: 'jpg', size: onDemand.length, sha256: sha256Hex(onDemand), orphan: false });
    });

    it('reports a listed name outside the stored-name language as skipped and records the rest', async () => {
      const junk = Buffer.from('desktop index', 'utf8');
      bridge().failNext('files.list', 200, {
        fileStore: 'fileDir',
        files: [{ name: 'Thumbs.db', fileId: '', variant: '', ext: 'db', size: junk.length, sha256: sha256Hex(junk), lastModified: '2026-06-01T09:00:00.000' }],
      });

      const built = await buildFileManifest(t.ctx, SNAPSHOT_SEQ);

      expect(built).toMatchObject({ entries: STORED.length, skipped: [{ siteId: 'default', name: 'Thumbs.db' }] });
      expect((await readManifest(t.ctx, SNAPSHOT_SEQ)).some((entry) => entry.siteId === 'default')).toBe(false);
    });

    it.each<[string, (double: BridgeDouble) => void, boolean]>([
      ['the listing names another store', (double) => double.setFileStore('s3'), false],
      ['the bridge answers 409 unsupportedFileStore', (double) => double.failNext('files.list', 409, { error: 'unsupportedFileStore', message: 's3' }), true],
    ])('halts with FileStoreUnsupportedError and keeps the earlier manifest when %s', async (_case, refuse, bridgeRefusal) => {
      await buildFileManifest(t.ctx, SNAPSHOT_SEQ);
      refuse(bridge());

      const error = await buildFileManifest(t.ctx, SNAPSHOT_SEQ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FileStoreUnsupportedError);
      expect(error).toMatchObject({ code: 'unsupportedFileStore', fileStore: 's3', siteId: 'default' });
      expect((error as FileStoreUnsupportedError).cause instanceof UnsupportedFileStoreError).toBe(bridgeRefusal);
      expect(await readManifest(t.ctx, SNAPSHOT_SEQ)).toHaveLength(STORED.length);
    });
  });

  describe('planObjects and transferFiles', () => {
    const image = storedObject(FIXTURE_FILES.image, '');
    const pdf = storedObject(FIXTURE_FILES.pdf, '');
    const videoSmall = storedObject(FIXTURE_FILES.video, '_small');
    const orphan = storedObject(FIXTURE_FILES.orphan, '');
    // A stale copy of the pooled image in tenant-a's own directory, which Masa never reads (fileManager.cfc:244).
    const misplacedBytes = Buffer.from('stale copy outside the file pool', 'utf8');
    const misplaced = expectedEntry(image, 'tenant-a', misplacedBytes);
    const entryKey = (object: StoredObject): ManifestKey => ({ siteId: object.file.siteId, path: pathOf(object.file.siteId, object.name) });

    beforeEach(async () => {
      bridge().files.set(misplaced.path, misplacedBytes);
      await buildFileManifest(t.ctx, SNAPSHOT_SEQ);
    });

    it('places each object under its tfiles site tenant, orphans under the umbrella, and marks a copy outside its site misplaced', async () => {
      const planned = await planObjects(t.ctx, SNAPSHOT_SEQ);

      expect(planned).toEqual(
        [
          ...STORED.map((object) => expectedPlan(expectedEntry(object), object)),
          expectedPlan(misplaced, image, 'misplaced'),
        ].sort((a, b) => compareManifestKeys(a.entry, b.entry)),
      );
      expect(planned.find((object) => object.entry.fileId === image.file.fileId)?.tenantId).toBe(UMBRELLA_TENANT);
      expect(planned.find((object) => object.entry.fileId === videoSmall.file.fileId)?.tenantId).toBe(tenantIdForSite('tenant-b'));
    });

    it('stores every transfer object byte-exactly with the manifest hash, and answers a repeat unchanged without rewriting any', async () => {
      const first = await transferFiles(t.ctx, SNAPSHOT_SEQ);

      expect(first).toEqual({
        snapshotSeq: SNAPSHOT_SEQ,
        transferred: STORED.length,
        unchanged: 0,
        bytes: TOTAL_BYTES,
        orphans: [entryKey(orphan)],
        misplaced: [keyOf(misplaced)],
      });
      const { objects } = content();
      expect([...objects.keys()].sort()).toEqual(STORED.map((object) => `${tenantOf(object)}/${object.name}`).sort());
      for (const object of STORED) {
        const bytes = bytesOf(object.name);
        const stored = objects.get(`${tenantOf(object)}/${object.name}`);
        expect(stored?.bytes).toEqual(bytes);
        expect(stored).toMatchObject({ size: bytes.length, sha256: sha256Hex(bytes), contentType: contentTypeOf(object) });
      }
      expect(bridgeSites('files.get')).not.toContain('tenant-a');

      const held = new Map(objects);
      const second = await transferFiles(t.ctx, SNAPSHOT_SEQ);

      expect(second).toEqual({ ...first, transferred: 0, unchanged: STORED.length });
      expect(objects.size).toBe(held.size);
      for (const [key, stored] of held) expect(objects.get(key)).toBe(stored);
    });

    it('rejects bytes changed since the manifest with FileHashMismatchError, sends nothing for them, and resumes once they match', async () => {
      const path = pathOf(pdf.file.siteId, pdf.name);
      const tampered = Buffer.from('bytes changed after the manifest was taken', 'utf8');
      bridge().files.set(path, tampered);

      const error = await transferFiles(t.ctx, SNAPSHOT_SEQ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FileHashMismatchError);
      expect(error).toMatchObject({ siteId: pdf.file.siteId, path, expected: sha256Hex(bytesOf(pdf.name)), actual: sha256Hex(tampered) });
      const { objects } = content();
      expect(objects.has(`${tenantOf(pdf)}/${pdf.name}`)).toBe(false);

      const sent = objects.size;
      bridge().files.set(path, bytesOf(pdf.name));
      expect(await transferFiles(t.ctx, SNAPSHOT_SEQ)).toMatchObject({ transferred: STORED.length - sent, unchanged: sent });
    });

    it('maps bytes the bridge serves against its own hash header to FileHashMismatchError before any put', async () => {
      const served = 'not the stored bytes';
      bridge().failNext('files.get', 200, served);

      const error = await transferFiles(t.ctx, SNAPSHOT_SEQ, { only: [entryKey(videoSmall)] }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FileHashMismatchError);
      expect(error).toMatchObject({
        siteId: videoSmall.file.siteId,
        path: entryKey(videoSmall).path,
        expected: sha256Hex(bytesOf(videoSmall.name)),
        actual: sha256Hex(Buffer.from(served, 'utf8')),
      });
      expect((error as FileHashMismatchError).cause).toBeInstanceOf(BridgeHashMismatchError);
      expect(content().calls.filter((call) => call.method === 'putObject')).toEqual([]);
    });

    it('restricts planning and transfer to the keys `only` names, still reporting their orphans and misplaced copies', async () => {
      const only = [entryKey(videoSmall), keyOf(misplaced), entryKey(orphan)];

      const planned = await planObjects(t.ctx, SNAPSHOT_SEQ, { only });
      const result = await transferFiles(t.ctx, SNAPSHOT_SEQ, { only });

      expect(planned.map((object) => keyOf(object.entry))).toEqual([...only].sort(compareManifestKeys));
      expect(result).toEqual({
        snapshotSeq: SNAPSHOT_SEQ,
        transferred: 2,
        unchanged: 0,
        bytes: bytesOf(videoSmall.name).length + bytesOf(orphan.name).length,
        orphans: [entryKey(orphan)],
        misplaced: [keyOf(misplaced)],
      });
      expect([...content().objects.keys()].sort()).toEqual([`${tenantOf(videoSmall)}/${videoSmall.name}`, `${tenantOf(orphan)}/${orphan.name}`].sort());
    });
  });
});
