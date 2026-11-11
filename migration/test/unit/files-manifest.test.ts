// Unit tests for the legacy file-store manifest: snapshot lookups, listing through the bridge, orphans, store refusals and reads.
import { createHash } from 'node:crypto';

import type { Logger } from '@opt2/platform/logging';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  FileStoreUnsupportedError,
  SUPPORTED_FILE_STORE,
  buildFileManifest,
  readManifest,
  readSnapshotFileOwners,
  readSnapshotSites,
  snapshotDatabase,
  type ManifestEntry,
} from '../../src/files/manifest.js';
import {
  BridgeError,
  UnsupportedFileStoreError,
  type BridgeClient,
  type FileListing,
  type LegacyFileEntry,
} from '../../src/legacy/bridge.js';
import type { LegacyDb } from '../../src/legacy/legacy-db.js';

const SNAP_DB = 'muradb_opt2_snap_3';
const FID_A = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_B = 'B1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_C = 'C1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const MODIFIED = '2026-06-30 11:59:59';
const MANIFEST_COLUMNS = 'snapshot_seq, site_id, path, file_id, variant, ext, size, sha256, orphan, last_modified';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

interface ManifestRecord {
  snapshot_seq: number;
  site_id: string;
  path: string;
  file_id: string;
  variant: string;
  ext: string;
  size: number;
  sha256: string;
  orphan: boolean;
  last_modified: string | null;
}

interface Statement {
  sql: string;
  values: unknown[];
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** In-memory migration.snapshot and migration.file_manifest with the primary key and rollback PostgreSQL gives them. */
class MigrationTables {
  snapshots = new Map<number, { database_name: string; manifest_complete: boolean }>();
  manifest: ManifestRecord[] = [];
  readonly statements: Statement[] = [];

  db(): TenantDb {
    return {
      schema: 'migration',
      withTenant: () => Promise.reject(new Error('the file manifest never runs in a tenant transaction')),
      withMetadata: async <T>(fn: (tx: MetadataTx) => Promise<T>): Promise<T> => {
        const before = { snapshots: structuredClone(this.snapshots), manifest: structuredClone(this.manifest) };
        const tx = {
          schema: 'migration',
          kind: 'metadata',
          onCommit: () => undefined,
          query: (text: unknown, values?: unknown[]) => Promise.resolve().then(() => this.run(String(text), values ?? [])),
        } as unknown as MetadataTx;
        try {
          return await fn(tx);
        } catch (error) {
          this.snapshots = before.snapshots;
          this.manifest = before.manifest;
          throw error;
        }
      },
      end: () => Promise.resolve(),
    };
  }

  inserts(): Statement[] {
    return this.statements.filter((statement) => statement.sql.startsWith('INSERT'));
  }

  private run(sql: string, values: unknown[]): QueryResult {
    this.statements.push({ sql, values });
    const seq = values[0] as number;
    if (sql === 'SELECT database_name FROM migration.snapshot WHERE seq = $1') {
      const snapshot = this.snapshots.get(seq);
      return result(snapshot === undefined ? [] : [{ database_name: snapshot.database_name }]);
    }
    if (sql === 'DELETE FROM migration.file_manifest WHERE snapshot_seq = $1') {
      const kept = this.manifest.filter((row) => row.snapshot_seq !== seq);
      const removed = this.manifest.length - kept.length;
      this.manifest = kept;
      return result([], removed);
    }
    if (sql.startsWith(`INSERT INTO migration.file_manifest (${MANIFEST_COLUMNS}) VALUES `)) {
      return result([], this.insert(sql, values));
    }
    if (sql === 'UPDATE migration.snapshot SET manifest_complete = true WHERE seq = $1') {
      const snapshot = this.snapshots.get(seq);
      if (snapshot !== undefined) snapshot.manifest_complete = true;
      return result([], snapshot === undefined ? 0 : 1);
    }
    if (
      sql ===
      'SELECT site_id, path, file_id, variant, ext, size, sha256, orphan FROM migration.file_manifest ' +
        'WHERE snapshot_seq = $1 ORDER BY site_id COLLATE "C", path COLLATE "C"'
    ) {
      const rows = this.manifest
        .filter((row) => row.snapshot_seq === seq)
        .sort((a, b) => byteOrder(a.site_id, b.site_id) || byteOrder(a.path, b.path))
        .map(({ site_id, path, file_id, variant, ext, size, sha256, orphan }) => ({
          site_id,
          path,
          file_id,
          variant,
          ext,
          size: String(size),
          sha256,
          orphan,
        }));
      return result(rows);
    }
    throw new Error(`unexpected statement: ${sql}`);
  }

  private insert(sql: string, values: unknown[]): number {
    const width = MANIFEST_COLUMNS.split(', ').length;
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    if (placeholders.length !== values.length || placeholders.some((n, index) => n !== index + 1) || values.length % width !== 0) {
      throw new Error(`malformed insert: ${String(placeholders.length)} placeholders for ${String(values.length)} values`);
    }
    for (let start = 0; start < values.length; start += width) {
      const [snapshot_seq, site_id, path, file_id, variant, ext, size, sha256, orphan, last_modified] = values.slice(start, start + width);
      const row = { snapshot_seq, site_id, path, file_id, variant, ext, size, sha256, orphan, last_modified } as ManifestRecord;
      if (this.manifest.some((other) => other.snapshot_seq === row.snapshot_seq && other.site_id === row.site_id && other.path === row.path)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "file_manifest_pkey"'), { code: '23505' });
      }
      this.manifest.push(row);
    }
    return values.length / width;
  }
}

function result(rows: QueryResultRow[], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}

interface SnapshotDatabase {
  tsettings: (string | null)[];
  tfiles: { fileID: string; siteID: string | null }[];
}

/** Legacy SQL Server reads of restored snapshot databases. */
function legacyOf(databases: Record<string, SnapshotDatabase>) {
  const queries: { database: string; sql: string }[] = [];
  const database = vi.fn((name: string) => {
    const found = databases[name];
    if (found === undefined) return Promise.reject(new Error(`Cannot open database "${name}"`));
    const request = () => ({
      query: (sql: string) => {
        queries.push({ database: name, sql });
        if (sql === 'SELECT DISTINCT [SiteID] FROM [dbo].[tsettings] ORDER BY [SiteID];') {
          return Promise.resolve({ recordset: found.tsettings.map((SiteID) => ({ SiteID })) });
        }
        if (sql === 'SELECT [fileID], [siteID] FROM [dbo].[tfiles];') return Promise.resolve({ recordset: found.tfiles });
        return Promise.reject(new Error(`unexpected legacy statement: ${sql}`));
      },
    });
    return Promise.resolve({ request });
  });
  return { legacy: { database } as unknown as LegacyDb, database, queries };
}

/** Bridge whose files.list answers per site with a listing or a failure. */
function bridgeOf(answers: Record<string, FileListing | Error>) {
  const filesList = vi.fn((siteId: string) => {
    const answer = answers[siteId];
    if (answer === undefined) return Promise.reject(new Error(`no listing for ${siteId}`));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  return { bridge: { filesList } as unknown as BridgeClient, filesList };
}

/** A listed file whose wire fields disagree with its name, so only the name can supply the recorded parts. */
function listed(name: string, size: number | string, hash = sha(name)): LegacyFileEntry {
  return { name, fileId: 'from-the-listing', variant: '', ext: 'bin', size: size as number, sha256: hash, lastModified: MODIFIED };
}

function listing(files: LegacyFileEntry[], fileStore = SUPPORTED_FILE_STORE): FileListing {
  return { fileStore, files, serverTime: '2026-06-30 12:00:00' };
}

function logger() {
  const info = vi.fn();
  return { logger: { info } as unknown as Logger, info };
}

function entry(siteId: string, name: string, parts: Omit<ManifestEntry, 'siteId' | 'path' | 'name' | 'snapshotSeq' | 'sha256'>, seq = 3): ManifestEntry {
  return { snapshotSeq: seq, siteId, path: `${siteId}/cache/file/${name}`, name, sha256: sha(name), ...parts };
}

/** Snapshot 3 of two sites: default holds one image with every variant, an orphan and two foreign names; tenant-a one owned file. */
function twoSiteStore() {
  const tables = new MigrationTables();
  tables.snapshots.set(3, { database_name: SNAP_DB, manifest_complete: false });
  const legacy = legacyOf({
    [SNAP_DB]: {
      tsettings: ['default', 'tenant-a', null, ''],
      tfiles: [
        { fileID: ` ${FID_A.toLowerCase()} `, siteID: 'default' },
        { fileID: FID_C, siteID: 'tenant-a' },
      ],
    },
  });
  const bridge = bridgeOf({
    default: listing([
      listed(`${FID_A}.jpg`, '2048', sha(`${FID_A}.jpg`).toUpperCase()),
      listed(`${FID_A}_source.jpg`, 4096),
      listed(`${FID_A}_small.jpg`, 512),
      listed(`${FID_A}_medium.jpg`, 1024),
      listed(`${FID_A}_W100_H50.jpg`, 300),
      listed(`${FID_B}.pdf`, 10),
      listed('Thumbs.db', 99),
      listed('notes.txt', 1),
    ]),
    'tenant-a': listing([listed(`${FID_C}.png`, 7)]),
  });
  const log = logger();
  return { tables, legacy, bridge, log, ctx: { db: tables.db(), legacy: legacy.legacy, bridge: bridge.bridge, logger: log.logger } };
}

describe('snapshotDatabase', () => {
  it('returns the restored database recorded for the snapshot', async () => {
    const tables = new MigrationTables();
    tables.snapshots.set(3, { database_name: SNAP_DB, manifest_complete: false });

    expect(await snapshotDatabase({ db: tables.db() }, 3)).toBe(SNAP_DB);
  });

  it('throws for an unknown snapshot', async () => {
    await expect(snapshotDatabase({ db: new MigrationTables().db() }, 7)).rejects.toThrow(new Error('unknown snapshot 7'));
  });
});

describe('readSnapshotSites', () => {
  it('lists the non-empty site ids of the snapshot database tsettings in SiteID order', async () => {
    const legacy = legacyOf({ [SNAP_DB]: { tsettings: [null, '', 'default', 'tenant-a'], tfiles: [] } });

    expect(await readSnapshotSites({ legacy: legacy.legacy }, SNAP_DB)).toEqual(['default', 'tenant-a']);
    expect(legacy.queries).toEqual([{ database: SNAP_DB, sql: 'SELECT DISTINCT [SiteID] FROM [dbo].[tsettings] ORDER BY [SiteID];' }]);
  });
});

describe('readSnapshotFileOwners', () => {
  it('keys each tfiles owner site by its upper-cased, trimmed fileID', async () => {
    const legacy = legacyOf({
      [SNAP_DB]: {
        tsettings: [],
        tfiles: [
          { fileID: ` ${FID_A.toLowerCase()}  `, siteID: 'default' },
          { fileID: FID_C, siteID: null },
        ],
      },
    });

    const owners = await readSnapshotFileOwners({ legacy: legacy.legacy }, SNAP_DB);

    expect([...owners]).toEqual([
      [FID_A, 'default'],
      [FID_C, null],
    ]);
  });
});

describe('buildFileManifest', () => {
  it('records every stored object of every site with the parts its name carries, skipping other names', async () => {
    const { tables, legacy, bridge, log, ctx } = twoSiteStore();

    const built = await buildFileManifest(ctx, 3);

    expect(built).toEqual({
      snapshotSeq: 3,
      database: SNAP_DB,
      sites: 2,
      entries: 7,
      orphans: 1,
      bytes: 2048 + 4096 + 512 + 1024 + 300 + 10 + 7,
      skipped: [
        { siteId: 'default', name: 'Thumbs.db' },
        { siteId: 'default', name: 'notes.txt' },
      ],
    });
    expect(legacy.database.mock.calls.every(([name]) => name === SNAP_DB)).toBe(true);
    expect(bridge.filesList.mock.calls.map(([siteId]) => siteId)).toEqual(['default', 'tenant-a']);
    expect(await readManifest({ db: tables.db() }, 3)).toEqual([
      entry('default', `${FID_A}.jpg`, { fileId: FID_A, variant: '', ext: 'jpg', size: 2048, orphan: false }),
      entry('default', `${FID_A}_W100_H50.jpg`, { fileId: FID_A, variant: '_W100_H50', ext: 'jpg', size: 300, orphan: false }),
      entry('default', `${FID_A}_medium.jpg`, { fileId: FID_A, variant: '_medium', ext: 'jpg', size: 1024, orphan: false }),
      entry('default', `${FID_A}_small.jpg`, { fileId: FID_A, variant: '_small', ext: 'jpg', size: 512, orphan: false }),
      entry('default', `${FID_A}_source.jpg`, { fileId: FID_A, variant: '_source', ext: 'jpg', size: 4096, orphan: false }),
      entry('default', `${FID_B}.pdf`, { fileId: FID_B, variant: '', ext: 'pdf', size: 10, orphan: true }),
      entry('tenant-a', `${FID_C}.png`, { fileId: FID_C, variant: '', ext: 'png', size: 7, orphan: false }),
    ]);
    expect(tables.manifest.every((row) => row.last_modified === MODIFIED)).toBe(true);
    expect(tables.snapshots.get(3)?.manifest_complete).toBe(true);
    expect(log.info).toHaveBeenCalledWith('file manifest of snapshot 3 built: 2 sites, 7 entries, 1 orphans, 2 skipped');
  });

  it('replaces the earlier rows of the snapshot and leaves other snapshots alone', async () => {
    const { tables, ctx } = twoSiteStore();
    const stale: ManifestRecord = {
      snapshot_seq: 3,
      site_id: 'default',
      path: `default/cache/file/${FID_B}_small.jpg`,
      file_id: FID_B,
      variant: '_small',
      ext: 'jpg',
      size: 1,
      sha256: sha('stale'),
      orphan: true,
      last_modified: null,
    };
    const earlier: ManifestRecord = { ...stale, snapshot_seq: 2 };
    tables.manifest.push(stale, earlier);

    await buildFileManifest(ctx, 3);
    await buildFileManifest(ctx, 3);

    const paths = (seq: number) => tables.manifest.filter((row) => row.snapshot_seq === seq).map((row) => row.path);
    expect(paths(3)).toHaveLength(7);
    expect(paths(3)).not.toContain(stale.path);
    expect(tables.manifest.filter((row) => row.snapshot_seq === 2)).toEqual([earlier]);
  });

  it('reads the database it is given instead of the snapshot record', async () => {
    const tables = new MigrationTables();
    const legacy = legacyOf({ muradb_restore: { tsettings: ['default'], tfiles: [{ fileID: FID_A, siteID: 'default' }] } });
    const bridge = bridgeOf({ default: listing([listed(`${FID_A}.gif`, 5)]) });

    const built = await buildFileManifest(
      { db: tables.db(), legacy: legacy.legacy, bridge: bridge.bridge, logger: logger().logger },
      9,
      { database: 'muradb_restore' },
    );

    expect(built).toMatchObject({ snapshotSeq: 9, database: 'muradb_restore', entries: 1, orphans: 0, bytes: 5 });
    expect(tables.statements.some((statement) => statement.sql.includes('FROM migration.snapshot'))).toBe(false);
    expect(legacy.database.mock.calls.map(([name]) => name)).toEqual(['muradb_restore', 'muradb_restore']);
  });

  it('refuses an unknown snapshot before reading legacy or listing any site', async () => {
    const { tables, legacy, bridge, ctx } = twoSiteStore();
    tables.snapshots.clear();

    await expect(buildFileManifest(ctx, 3)).rejects.toThrow('unknown snapshot 3');
    expect(legacy.database).not.toHaveBeenCalled();
    expect(bridge.filesList).not.toHaveBeenCalled();
  });

  it('refuses a store other than fileDir before writing any row', async () => {
    const { tables, ctx } = twoSiteStore();
    const kept: ManifestRecord = {
      snapshot_seq: 3,
      site_id: 'default',
      path: `default/cache/file/${FID_A}.jpg`,
      file_id: FID_A,
      variant: '',
      ext: 'jpg',
      size: 1,
      sha256: sha('kept'),
      orphan: false,
      last_modified: null,
    };
    tables.manifest.push(kept);
    const bridge = bridgeOf({ default: listing([listed(`${FID_A}.jpg`, 1)]), 'tenant-a': listing([], 's3') });

    const error = await buildFileManifest({ ...ctx, bridge: bridge.bridge }, 3).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileStoreUnsupportedError);
    expect(error).toMatchObject({
      name: 'FileStoreUnsupportedError',
      code: 'unsupportedFileStore',
      fileStore: 's3',
      siteId: 'tenant-a',
      message: 'Legacy file store "s3" of site tenant-a is not fileDir',
    });
    expect(tables.manifest).toEqual([kept]);
    expect(tables.snapshots.get(3)?.manifest_complete).toBe(false);
    expect(tables.statements.filter((statement) => !statement.sql.startsWith('SELECT'))).toEqual([]);
  });

  it.each([
    ['the store its message names', { error: 'unsupportedFileStore', message: 's3' }, 's3'],
    ['unknown without a message', { error: 'unsupportedFileStore' }, 'unknown'],
    ['unknown for an empty message', { error: 'unsupportedFileStore', message: '' }, 'unknown'],
    ['unknown for a text body', 'unsupportedFileStore', 'unknown'],
  ])('maps the bridge unsupportedFileStore answer to FileStoreUnsupportedError naming %s', async (_case, body, store) => {
    const { tables, ctx } = twoSiteStore();
    const refusal = new UnsupportedFileStoreError('files.list', body);
    const bridge = bridgeOf({ default: refusal });

    const error = await buildFileManifest({ ...ctx, bridge: bridge.bridge }, 3).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileStoreUnsupportedError);
    expect(error).toMatchObject({ fileStore: store, siteId: 'default', cause: refusal });
    expect(tables.manifest).toEqual([]);
  });

  it('propagates any other bridge failure unchanged', async () => {
    const { tables, ctx } = twoSiteStore();
    const failure = new BridgeError('files.list', 500, 'Internal Server Error');

    await expect(buildFileManifest({ ...ctx, bridge: bridgeOf({ default: failure }).bridge }, 3)).rejects.toBe(failure);
    expect(tables.snapshots.get(3)?.manifest_complete).toBe(false);
  });

  it('inserts more than 500 objects in statements of at most 500 rows', async () => {
    const tables = new MigrationTables();
    tables.snapshots.set(4, { database_name: SNAP_DB, manifest_complete: false });
    const ids = Array.from({ length: 501 }, (_unused, index) => `${String(index).padStart(8, '0')}-E5F6-A7B8-C9D0E1F2A3B4C5D6`);
    const legacy = legacyOf({ [SNAP_DB]: { tsettings: ['default'], tfiles: ids.map((fileID) => ({ fileID, siteID: 'default' })) } });
    const bridge = bridgeOf({ default: listing(ids.map((id) => listed(`${id}.txt`, 2))) });

    const built = await buildFileManifest({ db: tables.db(), legacy: legacy.legacy, bridge: bridge.bridge, logger: logger().logger }, 4);

    expect(built).toMatchObject({ entries: 501, orphans: 0, bytes: 1002, skipped: [] });
    expect(tables.inserts().map((statement) => statement.values.length)).toEqual([5000, 10]);
    expect(await readManifest({ db: tables.db() }, 4)).toHaveLength(501);
  });

  it('marks a site without stored files complete without inserting', async () => {
    const tables = new MigrationTables();
    tables.snapshots.set(5, { database_name: SNAP_DB, manifest_complete: false });
    const legacy = legacyOf({ [SNAP_DB]: { tsettings: ['default'], tfiles: [] } });
    const bridge = bridgeOf({ default: listing([]) });

    const built = await buildFileManifest({ db: tables.db(), legacy: legacy.legacy, bridge: bridge.bridge, logger: logger().logger }, 5);

    expect(built).toEqual({ snapshotSeq: 5, database: SNAP_DB, sites: 1, entries: 0, orphans: 0, bytes: 0, skipped: [] });
    expect(tables.inserts()).toEqual([]);
    expect(tables.snapshots.get(5)?.manifest_complete).toBe(true);
  });
});

describe('readManifest', () => {
  it('returns the snapshot entries by site id then path in byte order, with int8 sizes as numbers', async () => {
    const tables = new MigrationTables();
    const row = (site_id: string, name: string, snapshot_seq = 6): ManifestRecord => ({
      snapshot_seq,
      site_id,
      path: `${site_id}/cache/file/${name}`,
      file_id: name.slice(0, 35),
      variant: name.slice(35, name.lastIndexOf('.')),
      ext: name.slice(name.lastIndexOf('.') + 1),
      size: 3_000_000_000,
      sha256: sha(name),
      orphan: false,
      last_modified: MODIFIED,
    });
    tables.manifest.push(
      row('tenant-a', `${FID_C}.png`),
      row('default', `${FID_A}_small.jpg`),
      row('Default', `${FID_B}.pdf`),
      row('default', `${FID_A}_W100_H50.jpg`),
      row('default', `${FID_A}.jpg`, 7),
    );

    const entries = await readManifest({ db: tables.db() }, 6);

    expect(entries.map((found) => found.path)).toEqual([
      `Default/cache/file/${FID_B}.pdf`,
      `default/cache/file/${FID_A}_W100_H50.jpg`,
      `default/cache/file/${FID_A}_small.jpg`,
      `tenant-a/cache/file/${FID_C}.png`,
    ]);
    expect(entries[1]).toEqual(
      entry('default', `${FID_A}_W100_H50.jpg`, { fileId: FID_A, variant: '_W100_H50', ext: 'jpg', size: 3_000_000_000, orphan: false }, 6),
    );
  });

  it('returns no entries for a snapshot without a manifest', async () => {
    expect(await readManifest({ db: new MigrationTables().db() }, 1)).toEqual([]);
  });
});
