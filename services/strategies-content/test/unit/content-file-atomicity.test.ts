/** Content operations and their `content.file` writes commit or roll back as one transaction, pooled or not, with uploads' staged intents settled after it. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GateRaceError, acquireWriteGates, closeGates, openGates } from '@opt2/platform/migration-kit';
import type { StoragePort } from '@opt2/platform/storage';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, pgAvailable } from '@opt2/platform/testing';
import {
  deleteAll,
  deleteHistAll,
  deleteVersion,
  publish,
  saveContent,
  type ContentDeps,
  type ContentInput,
  type ContentSaveSite,
} from '../../src/domain/content.js';
import type { Actor } from '../../src/domain/context.js';
import { saveFileMetaDataEntity, storeUploadedFile, type UploadedFile } from '../../src/domain/files.js';
import { poolTenantTx } from '../../src/domain/pools.js';
import { StartupPredicateViolationError } from '../../src/domain/startup-guard.js';
import { CONTENT_FILES_BUCKET } from '../../src/migration/objects.js';
import type { ContentRepository } from '../../src/repo/repository.js';
import { ADMIN, END, HOME, SITE, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

const UMBRELLA = TENANT_UMBRELLA.tenantId;
const TENANTS = [TENANT_A.tenantId, TENANT_B.tenantId, UMBRELLA];

/** A tenant whose content saves are exercised and the tenant holding its file pool. */
interface Tenancy {
  name: string;
  actor: Actor;
  site: ContentSaveSite;
  pool: string;
  poolSiteId: string;
  attributeId: number;
}

const POOLED: Tenancy = { name: 'tenant-a, pooled to umbrella', actor: ADMIN, site: SITE, pool: UMBRELLA, poolSiteId: TENANT_UMBRELLA.siteId, attributeId: 9101 };
const UNPOOLED: Tenancy = {
  name: 'tenant-b, its own file pool',
  actor: { ...ADMIN, siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId },
  site: { ...SITE, siteId: TENANT_B.siteId, site: 'Tenant B', urls: { ...SITE.urls, siteId: TENANT_B.siteId, filePoolId: TENANT_B.siteId } },
  pool: TENANT_B.tenantId,
  poolSiteId: TENANT_B.siteId,
  attributeId: 9201,
};
const TENANCIES = [POOLED, UNPOOLED];

/** One changelog row as the assertions compare it. */
interface Change {
  tenant_id: string;
  xid: string;
  table: string;
}

/** How a save posts its upload: the `newfile` part, or the part of an extend File attribute. */
interface UploadSource {
  name: string;
  input: (t: Tenancy, fileName: string) => ContentInput;
  field: string;
}

const NEWFILE: UploadSource = { name: 'newfile', input: () => ({}), field: 'newfile' };
const EXTEND_FILE: UploadSource = {
  name: 'an extend File attribute',
  input: (t, fileName) => ({ extendsetid: extendSetId(t), attachment: fileName }),
  field: 'attachment',
};

/** The extend set holding `t`'s File attribute `attachment`. */
function extendSetId(t: Tenancy): string {
  return cfId('S', t.attributeId);
}

const part = (fileName: string, fieldName: string): UploadedFile => ({ fieldName, fileName, contentType: 'application/pdf', bytes: Buffer.from(`bytes of ${fileName}`) });

describe.skipIf(!(await pgAvailable()))('content file atomicity', () => {
  let fx: ContentFixture;
  let storage: StoragePort;
  let n = 0;
  const unique = (prefix: string): string => `${prefix}-${++n}`;

  /** Rows of `text` (with `{schema}`) in `tenantId`. */
  const query = <R = Record<string, unknown>>(tenantId: string, text: string, params: unknown[] = []): Promise<R[]> =>
    fx.inTenant(async (tx) => (await tx.query(text.replaceAll('{schema}', fx.handle.schema), params)).rows as R[], tenantId);

  /** The highest changelog seq of every tenant; `seq` is one sequence across tenants. */
  async function changelogMark(): Promise<bigint> {
    let mark = 0n;
    for (const tenantId of TENANTS) {
      const [row] = await query<{ seq: string }>(tenantId, 'SELECT coalesce(max(seq), 0)::text AS seq FROM {schema}.changelog');
      if (BigInt(row?.seq ?? '0') > mark) mark = BigInt(row?.seq ?? '0');
    }
    return mark;
  }

  /** Every changelog row written after `mark`, in every tenant. */
  async function changesSince(mark: bigint): Promise<Change[]> {
    const changes: Change[] = [];
    for (const tenantId of TENANTS) {
      changes.push(...(await query<Change>(tenantId, 'SELECT tenant_id::text, xid::text, "table" FROM {schema}.changelog WHERE seq > $1 ORDER BY seq', [mark.toString()])));
    }
    return changes;
  }

  /** `fx.deps` with the object keys of every put recorded and `content` repository overrides. */
  function rigged(content: Partial<ContentRepository['content']> = {}): { deps: ContentDeps; keys: string[] } {
    const keys: string[] = [];
    const deps: ContentDeps = {
      ...fx.deps,
      repository: { ...fx.repo, content: { ...fx.repo.content, ...content } },
      storage: {
        ...storage,
        put: (bucket, key, body, opts) => {
          keys.push(key);
          return storage.put(bucket, key, body, opts);
        },
      },
    };
    return { deps, keys };
  }

  /** The `deleted` flag of `fileId` in `t`'s file pool tenant. */
  async function deletedFlag(t: Tenancy, fileId: string): Promise<number | null> {
    return (await fx.inTenant((tx) => fx.repo.files.readFileAll(tx, fileId), t.pool))?.deleted ?? null;
  }

  /** The staged intents left for `objectKey` in `t`'s file pool tenant. */
  const stagedFor = (t: Tenancy, objectKey: string) => query(t.pool, 'SELECT stage_id FROM {schema}.staged_object WHERE object_key = $1', [objectKey]);

  /** The `content.file` rows named `fileName` in every tenant. */
  async function filesNamed(fileName: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    for (const tenantId of TENANTS) rows.push(...(await query(tenantId, 'SELECT * FROM {schema}.file WHERE filename = $1', [fileName])));
    return rows;
  }

  /** Saves `input` as `t`'s actor on `t`'s site. */
  const saveAs = (t: Tenancy, deps: ContentDeps, input: ContentInput, files: UploadedFile[] = []) =>
    saveContent(deps, t.actor, t.site, { siteid: t.site.siteId, ...input }, { files });

  /** A published File item of `t` whose versions hold one upload each, oldest first; returns the item and its version file ids. */
  async function fileItem(t: Tenancy, versions: number): Promise<{ contentId: string; histIds: string[]; fileIds: string[] }> {
    const title = unique('Versioned');
    const first = await saveAs(t, fx.deps, { parentid: HOME, type: 'File', title, approved: 1 }, [part(`${title}-1.pdf`, 'newfile')]);
    const contentId = first.bean.contentId();
    for (let v = 2; v <= versions; v++) {
      await publish(fx.deps, t.actor, t.site, { siteid: t.site.siteId, contentid: contentId, parentid: HOME, type: 'File', title }, { files: [part(`${title}-${v}.pdf`, 'newfile')] });
    }
    const rows = await query<{ contenthistid: string; fileid: string }>(t.actor.tenantId, 'SELECT contenthistid, fileid FROM {schema}.content WHERE contentid = $1 ORDER BY tcontent_id', [contentId]);
    return { contentId, histIds: rows.map((row) => row.contenthistid), fileIds: rows.map((row) => row.fileid) };
  }

  beforeAll(async () => {
    fx = await createContentFixture('content-file-atomicity-test');
    if (fx.deps.storage === undefined) throw new Error('The content fixture has no storage');
    storage = fx.deps.storage;
    for (const t of TENANCIES) {
      await saveAs(t, fx.deps, { contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 });
      await fx.inTenant(async (tx) => {
        const subtypeId = cfId('T', t.attributeId);
        await tx.query(`INSERT INTO ${fx.handle.schema}.extend_subtype (tenant_id, subtypeid, siteid, basetable, type, subtype, isactive) VALUES ($1, $2, $3, 'tcontent', 'Page', 'Default', 1)`, [
          tx.tenantId,
          subtypeId,
          t.site.siteId,
        ]);
        await tx.query(`INSERT INTO ${fx.handle.schema}.extend_set (tenant_id, extendsetid, subtypeid, siteid, name, orderno, isactive) VALUES ($1, $2, $3, $4, 'Main', 1, 1)`, [
          tx.tenantId,
          extendSetId(t),
          subtypeId,
          t.site.siteId,
        ]);
        await tx.query(
          `INSERT INTO ${fx.handle.schema}.extend_attribute (tenant_id, attributeid, extendsetid, siteid, name, type, validation, orderno, isactive, defaultvalue)` +
            " VALUES ($1, $2, $3, $4, 'attachment', 'File', '', 1, 1, '')",
          [tx.tenantId, t.attributeId, extendSetId(t), t.site.siteId],
        );
      }, t.actor.tenantId);
    }
  });

  afterAll(async () => {
    await fx?.drop();
  });

  describe.each(TENANCIES)('$name', (t) => {
    const failures = [
      { name: 'the start-up guard', type: 'Link', content: {}, error: StartupPredicateViolationError },
      { name: 'a finish-save write', type: 'Page', content: { insertSourceMap: () => Promise.reject(new Error('source map write failed')) }, error: Error },
    ] as const;

    it.each([NEWFILE, EXTEND_FILE].flatMap((source) => failures.map((failure) => ({ source, failure, label: `${source.name} then ${failure.name}` }))))(
      'rolls back an upload made through $label with the save, and settles its staged object',
      async ({ source, failure }) => {
        const title = unique('Rolled Back');
        const fileName = `${title}.pdf`;
        const { deps, keys } = rigged(failure.content);
        const mark = await changelogMark();

        await expect(saveAs(t, deps, { parentid: HOME, type: failure.type, title, approved: 1, ...source.input(t, fileName) }, [part(fileName, source.field)])).rejects.toBeInstanceOf(
          failure.error,
        );

        expect(keys).toHaveLength(1);
        const [objectKey = ''] = keys;
        expect(objectKey.startsWith(`${t.pool}/`)).toBe(true);
        expect(await storage.head(CONTENT_FILES_BUCKET, objectKey)).toBeNull();
        expect(await stagedFor(t, objectKey)).toEqual([]);
        expect(await filesNamed(fileName)).toEqual([]);
        expect(await query(t.pool, 'SELECT * FROM {schema}.file_object WHERE object_key = $1', [objectKey])).toEqual([]);
        expect(await query(t.actor.tenantId, 'SELECT * FROM {schema}.content WHERE title = $1', [title])).toEqual([]);
        expect(await changesSince(mark)).toEqual([]);
      },
    );

    it.each([NEWFILE, EXTEND_FILE])('commits an upload made through $name in the file pool tenant, in the transaction of the content rows', async (source) => {
      const title = unique('Committed');
      const fileName = `${title}.pdf`;
      const { deps, keys } = rigged();
      const mark = await changelogMark();

      const saved = await saveAs(t, deps, { parentid: HOME, type: 'Page', title, approved: 1, ...source.input(t, fileName) }, [part(fileName, source.field)]);

      expect(saved.errors).toEqual({});
      const [objectKey = ''] = keys;
      expect(await filesNamed(fileName)).toEqual([expect.objectContaining({ tenant_id: t.pool, siteid: t.poolSiteId, deleted: 0 })]);
      expect(await query(t.pool, 'SELECT tenant_id FROM {schema}.file_object WHERE object_key = $1', [objectKey])).toEqual([{ tenant_id: t.pool }]);
      expect(await storage.head(CONTENT_FILES_BUCKET, objectKey)).not.toBeNull();
      expect(await stagedFor(t, objectKey)).toEqual([]);
      const changes = await changesSince(mark);
      expect(new Set(changes.map((change) => change.xid)).size).toBe(1);
      expect(changes.filter((change) => change.table === 'file' || change.table === 'file_object').map((change) => [change.table, change.tenant_id])).toEqual([
        ['file', t.pool],
        ['file_object', t.pool],
      ]);
      expect(changes).toContainEqual(expect.objectContaining({ table: 'content', tenant_id: t.actor.tenantId }));
    });

    it('settles the staged object of an attempt a gate race re-ran, keeping only the committed upload', async () => {
      const title = unique('Re-run');
      const fileName = `${title}.pdf`;
      let raced = false;
      const { deps, keys } = rigged({
        insertSourceMap: (...args) => {
          if (raced) return fx.repo.content.insertSourceMap(...args);
          raced = true;
          return Promise.reject(new GateRaceError(['content.source_map']));
        },
      });

      const saved = await saveAs(t, deps, { parentid: HOME, type: 'Page', title, approved: 1 }, [part(fileName, 'newfile')]);

      expect(saved.errors).toEqual({});
      expect(keys).toHaveLength(2);
      const [discarded = '', kept = ''] = keys;
      expect(await storage.head(CONTENT_FILES_BUCKET, discarded)).toBeNull();
      expect(await storage.head(CONTENT_FILES_BUCKET, kept)).not.toBeNull();
      expect([...(await stagedFor(t, discarded)), ...(await stagedFor(t, kept))]).toEqual([]);
      const files = await filesNamed(fileName);
      expect(files).toHaveLength(1);
      expect(kept).toContain(String(files[0]?.fileid));
    });

    it('leaves a deletefile save unflagged when the save fails, and flags the file with the save when it commits', async () => {
      const name = unique('Detached');
      const stored = await storeUploadedFile({ ...fx.deps, storage }, t.actor, { file: part(`${name}.pdf`, 'newfile') });
      const input = { parentid: HOME, type: 'Page', approved: 1, fileid: stored.fileid, deletefile: 'true' };
      const mark = await changelogMark();

      await expect(saveAs(t, rigged({ insertSourceMap: () => Promise.reject(new Error('source map write failed')) }).deps, { ...input, title: name })).rejects.toThrow();
      expect(await deletedFlag(t, stored.fileid)).toBe(0);
      expect(await changesSince(mark)).toEqual([]);

      await saveAs(t, fx.deps, { ...input, title: name });
      expect(await deletedFlag(t, stored.fileid)).toBe(1);
      const changes = await changesSince(mark);
      expect(new Set(changes.map((change) => change.xid)).size).toBe(1);
      expect(changes).toContainEqual({ tenant_id: t.pool, xid: changes[0]?.xid, table: 'file' });
    });

    const deletes = [
      {
        name: 'deleteVersion',
        versions: 2,
        failing: { deleteVersion: () => Promise.reject(new Error('version delete failed')) },
        run: (deps: ContentDeps, item: { contentId: string; histIds: string[] }) =>
          deleteVersion(deps, t.actor, t.site, { contentHistId: item.histIds[0] ?? '', siteId: t.site.siteId }),
      },
      {
        name: 'deleteHistAll',
        versions: 2,
        failing: { deleteHistAll: () => Promise.reject(new Error('history delete failed')) },
        run: (deps: ContentDeps, item: { contentId: string }) => deleteHistAll(deps, t.actor, t.site, { contentId: item.contentId, siteId: t.site.siteId }),
      },
      {
        name: 'deleteAll',
        versions: 1,
        failing: { deleteContent: () => Promise.reject(new Error('content delete failed')) },
        run: (deps: ContentDeps, item: { contentId: string }) => deleteAll(deps, t.actor, t.site, { contentId: item.contentId, siteId: t.site.siteId }),
      },
    ];

    it.each(deletes)('$name leaves the file unflagged when its content delete fails, and flags it with the delete when it commits', async (op) => {
      const item = await fileItem(t, op.versions);
      const [fileId = ''] = item.fileIds;
      const mark = await changelogMark();

      await expect(op.run(rigged(op.failing).deps, item)).rejects.toThrow();
      expect(await deletedFlag(t, fileId)).toBe(0);
      expect(await changesSince(mark)).toEqual([]);

      await op.run(fx.deps, item);
      expect(await deletedFlag(t, fileId)).toBe(1);
      const changes = await changesSince(mark);
      expect(new Set(changes.map((change) => change.xid)).size).toBe(1);
      expect(changes).toContainEqual({ tenant_id: t.pool, xid: changes[0]?.xid, table: 'file' });
      expect(changes).toContainEqual(expect.objectContaining({ tenant_id: t.actor.tenantId, table: 'content' }));
    });
  });

  describe('saveFileMetaDataEntity', () => {
    it.each(TENANCIES)('updates the version metadata row and, with setAsDefault, the file in one transaction for $name', async (t) => {
      const title = unique('Meta');
      const saved = await saveAs(t, fx.deps, { parentid: HOME, type: 'Page', title, approved: 1 }, [part(`${title}.pdf`, 'newfile')]);
      const ids = { contentId: saved.bean.contentId(), contentHistId: saved.bean.contentHistId(), siteId: t.site.siteId, fileId: saved.bean.text('fileid') };
      await fx.inTenant(
        (tx) => fx.repo.files.insertFileMetadata(tx, { contentid: ids.contentId, contenthistid: ids.contentHistId, siteid: ids.siteId, fileid: ids.fileId, alttext: 'Old alt' }),
        t.actor.tenantId,
      );
      const mark = await changelogMark();

      await saveFileMetaDataEntity(fx.deps, t.actor.tenantId, { ...ids, values: { alttext: 'New alt' }, setAsDefault: true });

      expect((await fx.inTenant((tx) => fx.repo.files.readFileAll(tx, ids.fileId), t.pool))?.alttext).toBe('New alt');
      const changes = await changesSince(mark);
      expect(changes.map((change) => [change.table, change.tenant_id])).toEqual([
        ['file_metadata', t.actor.tenantId],
        ['file', t.pool],
      ]);
      expect(new Set(changes.map((change) => change.xid)).size).toBe(1);
    });
  });

  describe('poolTenantTx', () => {
    const A = TENANT_A.tenantId;
    const setting = async (q: TenantTx): Promise<unknown> => (await q.query<{ t: string }>("SELECT current_setting('app.tenant_id') AS t")).rows[0]?.t;

    it('runs each view statement as the pool tenant on the same transaction and restores the transaction tenant', async () => {
      await fx.inTenant(async (tx) => {
        const view = await poolTenantTx(tx, UMBRELLA.toUpperCase(), []);
        expect([view.kind, view.tenantId, view.schema]).toEqual(['tenant', UMBRELLA, tx.schema]);
        expect(await setting(view)).toBe(UMBRELLA);
        expect(await setting(tx)).toBe(A);
        const xid = async (q: TenantTx): Promise<unknown> => (await q.query<{ x: string }>('SELECT pg_current_xact_id()::text AS x')).rows[0]?.x;
        expect(await xid(view)).toBe(await xid(tx));
        expect(await poolTenantTx(tx, UMBRELLA, [])).toBe(view);
        expect(await poolTenantTx(tx, A, [])).toBe(tx);
      });
    });

    it.each([
      { name: 'the view', handle: (_tx: TenantTx, view: TenantTx) => view },
      { name: 'the transaction', handle: (tx: TenantTx) => tx },
    ])('recovers a failed view statement by rolling back to a savepoint taken through $name', async ({ handle }) => {
      await fx.inTenant(async (tx) => {
        const view = await poolTenantTx(tx, UMBRELLA, []);
        await handle(tx, view).query('SAVEPOINT pooled');
        await expect(view.query('SELECT 1 / 0')).rejects.toThrow(/division by zero/u);
        await handle(tx, view).query('ROLLBACK TO SAVEPOINT pooled');
        expect(await setting(tx)).toBe(A);
        expect(await setting(view)).toBe(UMBRELLA);
      });
    });

    it('raises GateRaceError at once for a pool gate closed while the transaction holds other gates', async () => {
      const holderId = 'content-file-atomicity-test';
      try {
        await fx.inTenant(async (tx) => {
          await acquireWriteGates(tx, ['content.content']);
          await closeGates(fx.handle.app, { units: ['content.file'], holderId });
          await expect(poolTenantTx(tx, UMBRELLA, ['content.file'])).rejects.toBeInstanceOf(GateRaceError);
        });
      } finally {
        await openGates(fx.handle.app, { units: ['content.file'], holderId, state: 'open' });
      }
    });
  });
});
