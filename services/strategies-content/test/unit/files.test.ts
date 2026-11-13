/** `domain/files` over a throwaway `content` schema, the seeded registry and local storage: image halts, restricted files, pooled uploads, failed-upload cleanup, deletes, metadata and render resolution. */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { UnitNotAuthoritativeError, closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter } from '@opt2/platform/storage';
import { tenantIdForSite, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, fixedClock, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, type Actor } from '../../src/domain/context.js';
import {
  DELETE_IF_NOT_USED_UNCHECKED,
  IMAGE_UPLOAD_EXTS,
  ImageUploadHaltedError,
  deleteAllFiles,
  deleteFileVersion,
  deleteIfNotUsed,
  isImageUploadExt,
  requestHasRestrictedFiles,
  resolveRenderObject,
  saveFileMetaData,
  setFileContentId,
  storeUploadedFile,
  type FileMetaDataValues,
  type RenderResolution,
  type UploadDeps,
  type UploadedFile,
} from '../../src/domain/files.js';
import { UnregisteredTenantError } from '../../src/domain/pools.js';
import { CONTENT_FILES_BUCKET, exportObjects } from '../../src/migration/objects.js';
import { StagedObjectsPendingError, recoverStagedObjects } from '../../src/migration/staged-objects.js';
import { createContentRepository, type ContentRepository, type FileInput } from '../../src/repo/repository.js';
import { CONTENT_UNITS, type FileRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const HOLDER = 'domain-files-test';
const UMBRELLA = TENANT_UMBRELLA.tenantId;

/** A CF-format id whose eight-character first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(8 - prefix.length, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** An actor of the token site `siteId`. */
function actorOf(siteId: string): Actor {
  return {
    userId: cfId('U', 1),
    fullName: 'Admin User',
    isLoggedIn: true,
    s2: true,
    roles: [],
    siteId,
    tenantId: tenantIdForSite(siteId),
  };
}

/** A posted part of `fileName`. */
function upload(fileName: string, contentType = 'application/pdf', bytes = Buffer.from(`bytes of ${fileName}`)): UploadedFile {
  return { fieldName: 'newfile', fileName, contentType, bytes };
}

describe('image upload extensions', () => {
  it.each([
    ...IMAGE_UPLOAD_EXTS.map((ext) => [ext, true] as const),
    ['PNG', true],
    ['Jpeg', true],
    ['FLV', true],
    ['pdf', false],
    ['docx', false],
    ['', false],
  ] as const)('isImageUploadExt(%j) is %s', (ext, expected) => {
    expect(isImageUploadExt(ext)).toBe(expected);
  });

  it('lists the legacy checks the target cannot read', () => {
    expect(DELETE_IF_NOT_USED_UNCHECKED).toEqual(['tclassextenddatauseractivity', 'tsettings.placeholderImgID']);
  });
});

describe('requestHasRestrictedFiles', () => {
  it.each([
    ['an allowed extension', ['a.pdf'], 'pdf,doc', false],
    ['an allowed extension in another case', ['A.PDF'], 'pdf', false],
    ['a short extension outside the list', ['x.exe'], 'pdf', true],
    ['an extension of five or more characters', ['x.webarchive'], 'pdf', false],
    ['a long name without a dot', ['README'], 'pdf', false],
    ['a short name without a dot', ['abc'], 'pdf', true],
    ['a trailing dot, skipped as an empty list element', ['a.exe.'], 'pdf', true],
    ['an empty allow list', ['x.exe'], '', false],
    ['list items with spaces, which are not trimmed', ['a.doc'], 'pdf, doc', true],
    ['one restricted file among several', ['a.pdf', 'b.bat'], 'pdf', true],
    ['no files', [], 'pdf', false],
  ] as const)('%s', (_name, names, allowed, expected) => {
    expect(requestHasRestrictedFiles(names.map((fileName) => ({ fileName })), allowed)).toBe(expected);
  });
});

describe.skipIf(!(await pgAvailable()))('domain/files', () => {
  let handle: ThrowawaySchema;
  let repo: ContentRepository;
  let stateDir: string;
  let storage: LocalStorageAdapter;
  let deps: UploadDeps;

  const gated = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => withGatedTenant(handle.app, tenantId, fn);
  const read = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, tenantId, fn);

  /** Inserts a `content.file` row of `fileId` in `tenantId`. */
  function insertFile(tenantId: string, fileId: string, row: Omit<FileInput, 'fileid'>): Promise<FileRow> {
    return gated(tenantId, (tx) => repo.files.insertFile(tx, { fileid: fileId, ...row }));
  }

  /** Inserts content versions `(contentId, contentHistId, fileId)` in `tenantId`. */
  async function insertVersions(tenantId: string, siteId: string, versions: readonly [string, string, string | null][]): Promise<void> {
    await read(tenantId, async (tx) => {
      for (const [contentId, contentHistId, fileId] of versions) {
        await tx.query(`INSERT INTO ${handle.schema}.content (tenant_id, contentid, contenthistid, fileid, siteid) VALUES ($1, $2, $3, $4, $5)`, [
          tx.tenantId,
          contentId,
          contentHistId,
          fileId,
          siteId,
        ]);
      }
    });
  }

  /** The `deleted` flag of `fileId` in `tenantId`. */
  async function deletedFlag(tenantId: string, fileId: string): Promise<number | null> {
    return (await read(tenantId, (tx) => repo.files.readFileAll(tx, fileId)))?.deleted ?? null;
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: HOLDER, allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: HOLDER, state: 'open' });
    await seedRegistry(handle.app);
    const clock = fixedClock(NOW);
    repo = createContentRepository({ clock, schema: handle.schema });
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-files-'));
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'domain-files-test-key' });
    deps = { db: handle.app, repository: repo, clock, config: CONTENT_CONFIG_DEFAULTS, storage };
  });

  afterAll(async () => {
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  describe('storeUploadedFile', () => {
    it('stores a non-image upload in the site file pool tenant with matching row, object and manifest', async () => {
      const file = upload('Quarterly Report.PDF');
      const stored = await storeUploadedFile(deps, actorOf(TENANT_A.siteId), { file, contentId: cfId('C', 1), caption: 'Q2' });
      if (stored.kind !== 'stored') throw new Error('expected a stored upload');

      expect(isCfUuid(stored.fileid)).toBe(true);
      expect(stored.filename).toBe('Quarterly Report.PDF');
      expect(stored.object).toMatchObject({
        tenant_id: UMBRELLA,
        file_id: stored.fileid,
        variant: '',
        ext: 'pdf',
        object_key: `${UMBRELLA}/${stored.fileid}.pdf`,
        size: String(file.bytes.length),
        sha256: sha256(file.bytes),
        content_type: 'application/pdf',
        orphan: false,
      });
      expect(await storage.head(CONTENT_FILES_BUCKET, stored.object.object_key)).toEqual({
        size: file.bytes.length,
        sha256: sha256(file.bytes),
        contentType: 'application/pdf',
      });
      expect(await read(UMBRELLA, (tx) => repo.files.readFileAll(tx, stored.fileid))).toMatchObject({
        fileid: stored.fileid,
        contentid: cfId('C', 1),
        siteid: TENANT_UMBRELLA.siteId,
        moduleid: '00000000000000000000000000000000000',
        filename: 'Quarterly Report.PDF',
        image: null,
        imagesmall: null,
        imagemedium: null,
        filesize: file.bytes.length,
        contenttype: 'application',
        contentsubtype: 'pdf',
        fileext: 'pdf',
        created: NOW,
        deleted: 0,
        caption: 'Q2',
        credits: null,
        exif: '{}',
      });
      expect(await read(TENANT_A.tenantId, (tx) => repo.files.readFileAll(tx, stored.fileid))).toBeNull();
    });

    it('stores an unpooled site upload under its own tenant', async () => {
      const stored = await storeUploadedFile(deps, actorOf(TENANT_B.siteId), {
        file: upload('slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
        moduleId: '00000000000000000000000000000000003',
      });
      if (stored.kind !== 'stored') throw new Error('expected a stored upload');
      expect(stored.object.object_key).toBe(`${TENANT_B.tenantId}/${stored.fileid}.pptx`);
      expect(stored.file).toMatchObject({
        siteid: TENANT_B.siteId,
        moduleid: '00000000000000000000000000000000003',
        contenttype: 'application',
        contentsubtype: 'vnd.openxmlformats-officedocument.presentationml.presentation',
      });
    });

    it.each(['Photo.JPG', 'banner.png', 'clip.flv'])('refuses the image upload %s before storing anything', async (fileName) => {
      await expect(storeUploadedFile(deps, actorOf(TENANT_A.siteId), { file: upload(fileName, 'image/jpeg') })).rejects.toBeInstanceOf(
        ImageUploadHaltedError,
      );
    });

    it('answers an extension outside fmAllowedExtensions as fileBean does, with a fresh id and no row or object', async () => {
      const stored = await storeUploadedFile({ ...deps, config: { ...CONTENT_CONFIG_DEFAULTS, fmAllowedExtensions: 'pdf' } }, actorOf(TENANT_A.siteId), {
        file: upload('notes.txt', 'text/plain'),
      });
      expect(stored).toEqual({ kind: 'rejected', fileid: expect.any(String), filename: 'Invalid file type .TXT' });
      expect(isCfUuid(stored.fileid)).toBe(true);
      expect(await read(UMBRELLA, (tx) => repo.files.readFileAll(tx, stored.fileid))).toBeNull();
      expect(await storage.head(CONTENT_FILES_BUCKET, `${UMBRELLA}/${stored.fileid}.txt`)).toBeNull();
    });

    it('raises UnregisteredTenantError for a token tenant without a registry entry', async () => {
      await expect(storeUploadedFile(deps, actorOf('nowhere'), { file: upload('a.pdf') })).rejects.toBeInstanceOf(UnregisteredTenantError);
    });

    it('links a stored file to its content item', async () => {
      const stored = await storeUploadedFile(deps, actorOf(TENANT_B.siteId), { file: upload('multi.pdf') });
      const linked = await gated(TENANT_B.tenantId, (tx) => setFileContentId(tx, repo, stored.fileid, cfId('C', 9)));
      expect(linked?.contentid).toBe(cfId('C', 9));
    });

    describe('failed uploads', () => {
      const failure = new Error('injected upload failure');
      const lostCommit = new Error('connection lost after COMMIT');

      /** `d` with the `files` methods of its repository replaced by `overrides`. */
      const withFiles = (d: UploadDeps, overrides: Partial<ContentRepository['files']>): UploadDeps => ({
        ...d,
        repository: { ...d.repository, files: { ...d.repository.files, ...overrides } },
      });

      /** Reports failure after the publication transaction committed. */
      function commitThenReject(db: TenantDb): TenantDb {
        let calls = 0;
        return {
          schema: db.schema,
          async withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
            const result = await db.withTenant(tenantId, fn);
            if (++calls === 3) throw lostCommit;
            return result;
          },
          withMetadata: db.withMetadata.bind(db),
          end: db.end.bind(db),
        };
      }

      /** Sets the `content.file` gate to `state` under this file's holder. */
      async function setFileGate(state: 'open' | 'legacy'): Promise<void> {
        await closeGates(handle.app, { units: ['content.file'], holderId: HOLDER, allowLegacy: true });
        await openGates(handle.app, { units: ['content.file'], holderId: HOLDER, state });
      }

      /** A failing upload: its gate, its collaborators over the test's, the error it rejects with, and what it leaves. */
      interface FailedUpload {
        name: string;
        gate: 'open' | 'legacy';
        rig: (d: UploadDeps) => UploadDeps;
        error: Error | typeof UnitNotAuthoritativeError;
        put: boolean;
        kept: boolean;
        committed: boolean;
      }

      it.each<FailedUpload>([
        { name: 'a legacy content.file gate', gate: 'legacy', rig: (d) => d, error: UnitNotAuthoritativeError, put: false, kept: false, committed: false },
        {
          name: 'a failing file row insert',
          gate: 'open',
          rig: (d) => withFiles(d, { insertFile: () => Promise.reject(failure) }),
          error: failure,
          put: false,
          kept: false,
          committed: false,
        },
        {
          name: 'a failing object row write',
          gate: 'open',
          rig: (d) => withFiles(d, { upsertFileObject: () => Promise.reject(failure) }),
          error: failure,
          put: true,
          kept: false,
          committed: false,
        },
        {
          name: 'a failing object row write whose manifest check fails',
          gate: 'open',
          rig: (d) =>
            withFiles(d, { upsertFileObject: () => Promise.reject(failure), findFileObjectBySha: () => Promise.reject(new Error('manifest check failed')) }),
          error: failure,
          put: true,
          kept: true,
          committed: false,
        },
        {
          name: 'a failing object row write whose storage cleanup fails',
          gate: 'open',
          rig: (d) => ({ ...withFiles(d, { upsertFileObject: () => Promise.reject(failure) }),
            storage: { ...d.storage, delete: () => Promise.reject(new Error('storage unavailable')) },
          }),
          error: failure,
          put: true,
          kept: true,
          committed: false,
        },
        {
          name: 'an ambiguous put followed by database loss',
          gate: 'open',
          rig: (d) => {
            let dead = false;
            return { ...d,
              db: { ...d.db, withTenant: (tenantId, fn) => dead ? Promise.reject(new Error('database unavailable')) : d.db.withTenant(tenantId, fn) },
              storage: { ...d.storage, put: async (...args) => {
                await d.storage.put(...args);
                dead = true;
                throw failure;
              } },
            };
          },
          error: failure,
          put: true,
          kept: true,
          committed: false,
        },
        {
          name: 'a commit reported failed after it committed',
          gate: 'open',
          rig: (d) => ({ ...d, db: commitThenReject(d.db) }),
          error: lostCommit,
          put: true,
          kept: true,
          committed: true,
        },
      ])('$name rejects the upload; bytes put: $put, object kept: $kept, rows committed: $committed', async (c) => {
        const rigged = c.rig(deps);
        const fileIds: string[] = [];
        const putKeys: string[] = [];
        const recording: UploadDeps = {
          ...withFiles(rigged, {
            insertFile: (tx, row, ctx) => {
              fileIds.push(row.fileid ?? '');
              return rigged.repository.files.insertFile(tx, row, ctx);
            },
          }),
          storage: {
            ...rigged.storage,
            put: (bucket, key, body, opts) => {
              putKeys.push(key);
              return rigged.storage.put(bucket, key, body, opts);
            },
          },
        };
        const file = upload('failed.pdf');

        await setFileGate(c.gate);
        try {
          await expect(storeUploadedFile(recording, actorOf(TENANT_A.siteId), { file })).rejects.toThrow(c.error);
        } finally {
          await setFileGate('open');
        }

        expect(fileIds).toHaveLength(1);
        const objectKey = `${UMBRELLA}/${fileIds[0]}.pdf`;
        expect(putKeys).toEqual(c.put ? [objectKey] : []);
        expect(await storage.head(CONTENT_FILES_BUCKET, objectKey)).toEqual(
          c.kept ? { size: file.bytes.length, sha256: sha256(file.bytes), contentType: 'application/pdf' } : null,
        );
        expect((await read(UMBRELLA, (tx) => repo.files.readFileAll(tx, fileIds[0] ?? ''))) !== null).toBe(c.committed);
        expect((await read(UMBRELLA, (tx) => repo.files.findFileObjectBySha(tx, objectKey))) !== null).toBe(c.committed);
        const staged = () => read(UMBRELLA, async (tx) =>
          (await tx.query(`SELECT * FROM ${handle.schema}.staged_object WHERE object_key = $1`, [objectKey])).rows);
        expect(await staged()).toHaveLength(c.kept && !c.committed ? 1 : 0);
        if (c.kept && !c.committed) {
          await read(UMBRELLA, (tx) => tx.query(
            `UPDATE ${handle.schema}.staged_object SET recorded_at = clock_timestamp() - interval '2 minutes' WHERE object_key = $1`, [objectKey]));
          await expect(read(UMBRELLA, (tx) => exportObjects(tx, { unit: 'content.file', tenantId: UMBRELLA }))).rejects.toBeInstanceOf(StagedObjectsPendingError);
          expect(await recoverStagedObjects(deps, UMBRELLA, 0)).toBe(1);
          expect(await storage.head(CONTENT_FILES_BUCKET, objectKey)).toBeNull();
          expect(await staged()).toEqual([]);
          await expect(read(UMBRELLA, (tx) => exportObjects(tx, { unit: 'content.file', tenantId: UMBRELLA }))).resolves.toHaveProperty('objects');
        }
      });
    });
  });

  describe('deletes', () => {
    const SITE_B = TENANT_B.siteId;
    const B = TENANT_B.tenantId;
    const A = TENANT_A.tenantId;

    beforeAll(async () => {
      for (const n of [1, 2, 3, 4, 5]) await insertFile(B, cfId('FB', n), { siteid: SITE_B, filename: `f${n}.pdf`, fileext: 'pdf' });
      await insertFile(UMBRELLA, cfId('FU', 1), { siteid: TENANT_UMBRELLA.siteId, filename: 'pooled.pdf', fileext: 'pdf' });
      await insertVersions(B, SITE_B, [
        [cfId('CB', 1), cfId('HB', 1), cfId('FB', 1)],
        [cfId('CB', 1), cfId('HB', 2), cfId('FB', 1)],
        [cfId('CB', 2), cfId('HB', 3), cfId('FB', 2)],
        [cfId('CB', 3), cfId('HB', 4), cfId('FB', 4)],
        [cfId('CB', 3), cfId('HB', 5), cfId('FB', 4)],
      ]);
      await insertVersions(A, TENANT_A.siteId, [[cfId('CA', 1), cfId('HA', 1), cfId('FU', 1)]]);
    });

    it('deleteFileVersion flags the file deleted and keeps its row', async () => {
      const rows = await gated(B, (tx) => deleteFileVersion(tx, repo, cfId('FB', 3)));
      expect(rows.map((row) => row.fileid)).toEqual([cfId('FB', 3)]);
      expect(await deletedFlag(B, cfId('FB', 3))).toBe(1);
    });

    it('deleteIfNotUsed keeps a file another version still references', async () => {
      expect(await gated(B, (tx) => deleteIfNotUsed(tx, repo, [cfId('FB', 1)], [cfId('HB', 1)]))).toEqual([]);
      expect(await deletedFlag(B, cfId('FB', 1))).toBe(0);
    });

    it('deleteIfNotUsed flags a file only the excluded versions reference', async () => {
      expect(await gated(B, (tx) => deleteIfNotUsed(tx, repo, [cfId('FB', 1)], [cfId('HB', 1), cfId('HB', 2)]))).toEqual([cfId('FB', 1)]);
      expect(await deletedFlag(B, cfId('FB', 1))).toBe(1);
    });

    it('deleteIfNotUsed of an empty list changes nothing', async () => {
      expect(await gated(B, (tx) => deleteIfNotUsed(tx, repo, [], []))).toEqual([]);
    });

    it('deleteAllFiles flags the file of a single-version item', async () => {
      const deletion = await gated(B, (tx) => deleteAllFiles(tx, repo, cfId('CB', 2)));
      expect(deletion).toEqual({ versionFiles: [{ contenthistid: cfId('HB', 3), fileid: cfId('FB', 2) }], deletedFileIds: [cfId('FB', 2)] });
      expect(await deletedFlag(B, cfId('FB', 2))).toBe(1);
    });

    it('deleteAllFiles of versions sharing a file flags nothing, as legacy binds the id list as one value', async () => {
      const deletion = await gated(B, (tx) => deleteAllFiles(tx, repo, cfId('CB', 3)));
      expect(deletion.versionFiles).toHaveLength(2);
      expect(deletion.deletedFileIds).toEqual([]);
      expect(await deletedFlag(B, cfId('FB', 4))).toBe(0);
    });

    it('deleteIfNotUsed of a pooled file checks the content tenant and flags the file in its pool tenant', async () => {
      const pooled = (baseIds: string[]): Promise<string[]> =>
        gated(A, (tx) => gated(UMBRELLA, (fileTx) => deleteIfNotUsed(tx, repo, [cfId('FU', 1)], baseIds, { fileTx })));
      expect(await pooled([cfId('HA', 9)])).toEqual([]);
      expect(await deletedFlag(UMBRELLA, cfId('FU', 1))).toBe(0);
      expect(await pooled([cfId('HA', 1)])).toEqual([cfId('FU', 1)]);
      expect(await deletedFlag(UMBRELLA, cfId('FU', 1))).toBe(1);
    });
  });

  describe('saveFileMetaData', () => {
    const B = TENANT_B.tenantId;
    const SITE_B = TENANT_B.siteId;
    const FILE = cfId('MB', 1);
    const CSS = cfId('MB', 2);
    const POOLED = cfId('MU', 1);
    const CONTENT = cfId('CM', 1);

    beforeAll(async () => {
      const common = { contentid: CONTENT, caption: 'file caption', credits: 'file credits', alttext: 'file alt', remoteid: 'r-1' };
      await insertFile(B, FILE, { ...common, siteid: SITE_B, filename: 'guide.pdf', fileext: 'pdf', contenttype: 'application', contentsubtype: 'pdf', exif: '{"Make":"Scanner"}' });
      await insertFile(B, CSS, { ...common, siteid: SITE_B, filename: 'site.CSS', fileext: 'css', contenttype: 'application', contentsubtype: 'octet-stream' });
      await insertFile(UMBRELLA, POOLED, { ...common, siteid: TENANT_UMBRELLA.siteId, filename: 'pooled.pdf', fileext: 'pdf' });
    });

    const save = (fileId: string, contentHistId: string, values: FileMetaDataValues, setAsDefault = false) =>
      gated(B, (tx) => saveFileMetaData(tx, repo, { contentId: CONTENT, contentHistId, siteId: SITE_B, fileId, values, setAsDefault }));

    it('starts a version row from the file columns, then applies the submitted values', async () => {
      const row = await save(FILE, cfId('HM', 1), { alttext: 'version alt' });
      expect(isCfUuid(row.metaid)).toBe(true);
      expect(row).toMatchObject({
        tenant_id: B,
        contentid: CONTENT,
        contenthistid: cfId('HM', 1),
        siteid: SITE_B,
        fileid: FILE,
        caption: 'file caption',
        credits: 'file credits',
        alttext: 'version alt',
        remoteid: 'r-1',
        exif: '{"Make":"Scanner"}',
      });
    });

    it('updates the version row on the next save and serializes non-JSON exif as {}', async () => {
      const first = await save(FILE, cfId('HM', 2), {});
      const second = await save(FILE, cfId('HM', 2), { caption: 'second', exif: 'not json' });
      expect(second).toMatchObject({ metaid: first.metaid, caption: 'second', alttext: 'file alt', exif: '{}' });
      const rows = await read(B, (tx) => repo.files.listFileMetadata(tx, { siteId: SITE_B, fileId: FILE, contentHistId: cfId('HM', 2) }));
      expect(rows).toHaveLength(1);
    });

    it('copies the metadata onto the file with setAsDefault', async () => {
      await save(FILE, cfId('HM', 3), { caption: 'default caption', credits: 'default credits' }, true);
      expect(await read(B, (tx) => repo.files.readFileAll(tx, FILE))).toMatchObject({
        caption: 'default caption',
        credits: 'default credits',
        alttext: 'file alt',
        contenttype: 'application',
        contentsubtype: 'pdf',
      });
    });

    it('sets the text/css content type of a .CSS file saved as default', async () => {
      await save(CSS, cfId('HM', 4), { alttext: 'styles' }, true);
      expect(await read(B, (tx) => repo.files.readFileAll(tx, CSS))).toMatchObject({ alttext: 'styles', contenttype: 'text', contentsubtype: 'css' });
    });

    it('writes a pooled file new row under the pool site, which the site-scoped lookup never finds again', async () => {
      const pooled = () =>
        gated(TENANT_A.tenantId, (tx) =>
          gated(UMBRELLA, (fileTx) =>
            saveFileMetaData(
              tx,
              repo,
              { contentId: CONTENT, contentHistId: cfId('HM', 5), siteId: TENANT_A.siteId, fileId: POOLED, values: { alttext: 'a' }, setAsDefault: false },
              { fileTx },
            ),
          ),
        );
      const first = await pooled();
      const second = await pooled();
      expect(first).toMatchObject({ tenant_id: UMBRELLA, siteid: TENANT_UMBRELLA.siteId, alttext: 'a' });
      expect(second.metaid).not.toBe(first.metaid);
      const inUmbrella = await read(UMBRELLA, (tx) =>
        repo.files.listFileMetadata(tx, { siteId: TENANT_UMBRELLA.siteId, fileId: POOLED, contentHistId: cfId('HM', 5) }),
      );
      expect(inUmbrella).toHaveLength(2);
    });

    it('keeps a row without a file and skips setAsDefault for it', async () => {
      const row = await save('', cfId('HM', 6), { alttext: 'orphan' }, true);
      expect(row).toMatchObject({ fileid: null, siteid: SITE_B, alttext: 'orphan', exif: '{}' });
    });
  });

  // Render ids must pass the CF UUID check, so their prefixes are hex digits.
  describe('resolveRenderObject', () => {
    const PDF = cfId('E', 1);
    const PNG = cfId('E', 2);
    const FLV = cfId('E', 3);
    const CREATED = new Date(2026, 0, 2, 3, 4, 5, 0);

    beforeAll(async () => {
      const base = { siteid: TENANT_UMBRELLA.siteId, created: CREATED };
      await insertFile(UMBRELLA, PDF, { ...base, filename: 'brochure.pdf', fileext: 'pdf', contenttype: 'application', contentsubtype: 'pdf' });
      await insertFile(UMBRELLA, PNG, { ...base, filename: 'logo.png', fileext: 'png', contenttype: 'image', contentsubtype: 'png' });
      await insertFile(UMBRELLA, FLV, { ...base, filename: 'clip.flv', fileext: 'flv', contenttype: 'video', contentsubtype: 'x-flv' });
      await storage.put(CONTENT_FILES_BUCKET, `${UMBRELLA}/${PNG}_thumb.png`, Buffer.from('thumb'), { contentType: 'image/png' });
    });

    const object = (key: string, contentType: string, fileName: string): RenderResolution => ({
      kind: 'object',
      objectKey: `${UMBRELLA}/${key}`,
      contentType,
      fileName,
      created: CREATED,
    });

    it.each<[string, string, string | undefined, RenderResolution]>([
      ['a non-UUID id', 'not-a-uuid', undefined, { kind: 'not-found' }],
      ['a dotted size', PNG, 'a.b', { kind: 'not-found' }],
      ['an unknown file', cfId('E', 9), undefined, { kind: 'not-found' }],
      ['a plain file', PDF, undefined, object(`${PDF}.pdf`, 'application/pdf', 'brochure.pdf')],
      ['a non-image file with the path size', PDF, 'file', object(`${PDF}.pdf`, 'application/pdf', 'brochure.pdf')],
      ['the small rendition', PNG, 'small', object(`${PNG}_small.png`, 'image/png', 'logo.png')],
      ['the medium rendition in upper case', PNG, 'MEDIUM', object(`${PNG}_medium.png`, 'image/png', 'logo.png')],
      ['a small request of a non-image file', PDF, 'small', object(`${PDF}_small.pdf`, 'application/pdf', 'brochure.pdf')],
      ['an FLV thumbnail under its stored extension', FLV, 'small', object(`${FLV}_small.flv`, 'video/x-flv', 'clip.flv')],
      ['a stored custom size', PNG, 'thumb', object(`${PNG}_thumb.png`, 'image/png', 'logo.png')],
      ['a custom size never stored', PNG, 'file', { kind: 'missing-rendition', objectKey: `${UMBRELLA}/${PNG}_file.png` }],
    ])('resolves %s', async (_name, fileId, size, expected) => {
      expect(await resolveRenderObject(deps, { tenantId: TENANT_A.tenantId, fileId, ...(size === undefined ? {} : { size }) })).toEqual(expected);
    });

    it('does not find a file outside the token site file pool', async () => {
      expect(await resolveRenderObject(deps, { tenantId: TENANT_B.tenantId, fileId: PDF })).toEqual({ kind: 'not-found' });
    });
  });
});
