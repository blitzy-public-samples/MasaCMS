// Unit tests for the legacy file-store manifest: snapshot lookups, listing through the bridge, orphans, store refusals and reads.
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@opt2/platform/logging';
import type { MetadataTx, QueryResult, QueryResultRow, TenantDb } from '@opt2/platform/tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FILE_LOOKUP_IDS,
  FileStoreUnsupportedError,
  MANIFEST_PAGE_ROWS,
  SUPPORTED_FILE_STORE,
  buildFileManifest,
  readManifest,
  readManifestNames,
  readManifestPage,
  readSnapshotFiles,
  readSnapshotSites,
  snapshotDatabase,
  streamManifest,
  type ManifestEntry,
} from '../../src/files/manifest.js';
import type { StoredVariant } from '../../src/files/names.js';
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
/** A 35-character id files.cfm lists but the owner cannot store, since it is no CF UUID. */
const STRAY_ID = 'QAORPHAN-FILE-0000-0000000000000058';
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
  /** Rows the statement returned. */
  returned: number;
}

const SELECT_MANIFEST = 'SELECT site_id, path, file_id, variant, ext, size, sha256, orphan FROM migration.file_manifest';
const MANIFEST_ORDER = 'ORDER BY site_id COLLATE "C", path COLLATE "C"';
const FIRST_PAGE_SQL = `${SELECT_MANIFEST} WHERE snapshot_seq = $1 ${MANIFEST_ORDER} LIMIT $2`;
const NEXT_PAGE_SQL = `${SELECT_MANIFEST} WHERE snapshot_seq = $1 AND (site_id COLLATE "C", path COLLATE "C") > ($2, $3) ${MANIFEST_ORDER} LIMIT $4`;
const NAMES_SQL =
  `${SELECT_MANIFEST} WHERE snapshot_seq = $1 AND file_id = ANY($2::bpchar[]) ` +
  `AND (file_id, variant, ext) IN (SELECT * FROM unnest($2::bpchar[], $3::text[], $4::text[])) ${MANIFEST_ORDER}`;

/** Identity of a (file id, variant, extension) triple. */
const nameText = (fileId: string, variant: string, ext: string): string => `${fileId}\u0000${variant}\u0000${ext}`;

/** Triples a names lookup binds as its three parallel arrays after the snapshot. */
function boundNames(values: unknown[]): Set<string> {
  const [ids, variants, exts] = values.slice(1) as [string[], string[], string[]];
  if (variants.length !== ids.length || exts.length !== ids.length) throw new Error('names lookup binds arrays of unequal lengths');
  return new Set(ids.map((id, index) => nameText(id, variants[index] ?? '', exts[index] ?? '')));
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const keyOrder = (a: { site_id: string; path: string }, b: { site_id: string; path: string }): number =>
  byteOrder(a.site_id, b.site_id) || byteOrder(a.path, b.path);

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

  pages(): Statement[] {
    return this.statements.filter((statement) => statement.sql === FIRST_PAGE_SQL || statement.sql === NEXT_PAGE_SQL);
  }

  private run(sql: string, values: unknown[]): QueryResult {
    const answer = this.answer(sql, values);
    this.statements.push({ sql, values, returned: answer.rows.length });
    return answer;
  }

  private answer(sql: string, values: unknown[]): QueryResult {
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
    if (sql === FIRST_PAGE_SQL || sql === NEXT_PAGE_SQL || sql === NAMES_SQL) {
      const [after, limit] =
        sql === NEXT_PAGE_SQL ? [{ site_id: values[1] as string, path: values[2] as string }, values[3] as number] : [undefined, sql === FIRST_PAGE_SQL ? (values[1] as number) : Infinity];
      const names = sql === NAMES_SQL ? boundNames(values) : undefined;
      const rows = this.manifest
        .filter((row) => row.snapshot_seq === seq && (after === undefined || keyOrder(row, after) > 0) && (names?.has(nameText(row.file_id, row.variant, row.ext)) ?? true))
        .sort(keyOrder)
        .slice(0, limit)
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

/** The tfiles lookup of `count` file ids, bound `@p0` onwards. */
function tfilesLookupSql(count: number): string {
  const params = Array.from({ length: count }, (_unused, index) => `@p${String(index)}`).join(', ');
  return `SELECT [fileID], [siteID], [contentType], [contentSubType], [fileExt] FROM [dbo].[tfiles] WHERE [fileID] IN (${params});`;
}

/** Legacy SQL Server reads of restored snapshot databases; `queries` records each statement with its bound values. */
function legacyOf(databases: Record<string, SnapshotDatabase>) {
  const queries: { database: string; sql: string; inputs: unknown[] }[] = [];
  const database = vi.fn((name: string) => {
    const found = databases[name];
    if (found === undefined) return Promise.reject(new Error(`Cannot open database "${name}"`));
    const request = () => {
      const inputs: unknown[] = [];
      const bound = {
        input: (_name: string, _type: unknown, value: unknown) => {
          inputs.push(value);
          return bound;
        },
        query: (sql: string) => {
          queries.push({ database: name, sql, inputs });
          if (sql === 'SELECT DISTINCT [SiteID] FROM [dbo].[tsettings] ORDER BY [SiteID];') {
            return Promise.resolve({ recordset: found.tsettings.map((SiteID) => ({ SiteID })) });
          }
          // SQL Server compares char(35) ids case-insensitively and without trailing spaces under the legacy collation.
          if (sql === tfilesLookupSql(inputs.length)) {
            const wanted = new Set(inputs.map((value) => String(value).trim().toUpperCase()));
            const rows = found.tfiles.filter((row) => wanted.has(row.fileID.trim().toUpperCase()));
            return Promise.resolve({ recordset: rows.map((row) => ({ contentType: null, contentSubType: null, fileExt: null, ...row })) });
          }
          return Promise.reject(new Error(`unexpected legacy statement: ${sql}`));
        },
      };
      return bound;
    };
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
  const warn = vi.fn();
  return { logger: { info, warn } as unknown as Logger, info, warn };
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
      listed(`${STRAY_ID}.txt`, 1),
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
    expect(legacy.queries).toEqual([{ database: SNAP_DB, sql: 'SELECT DISTINCT [SiteID] FROM [dbo].[tsettings] ORDER BY [SiteID];', inputs: [] }]);
  });
});

describe('readSnapshotFiles', () => {
  it('keys the tfiles rows of the asked file ids by their upper-cased, trimmed fileID, asking once per distinct id', async () => {
    const legacy = legacyOf({
      [SNAP_DB]: {
        tsettings: [],
        tfiles: [
          { fileID: `${FID_A.toLowerCase()}  `, siteID: 'default' },
          { fileID: FID_B, siteID: 'tenant-a' },
          { fileID: FID_C, siteID: null },
        ],
      },
    });

    const files = await readSnapshotFiles({ legacy: legacy.legacy }, SNAP_DB, [FID_A, FID_A.toLowerCase(), FID_C, STRAY_ID]);

    expect([...files].map(([fileId, row]) => [fileId, row.siteID])).toEqual([
      [FID_A, 'default'],
      [FID_C, null],
    ]);
    expect(legacy.queries).toEqual([{ database: SNAP_DB, sql: tfilesLookupSql(3), inputs: [FID_A, FID_C, STRAY_ID] }]);
  });

  it(`binds at most ${String(FILE_LOOKUP_IDS)} file ids per lookup`, async () => {
    const ids = Array.from({ length: FILE_LOOKUP_IDS * 2 + 1 }, (_unused, index) => `${String(index).padStart(8, '0')}-E5F6-A7B8-C9D0E1F2A3B4C5D6`);
    const legacy = legacyOf({ [SNAP_DB]: { tsettings: [], tfiles: ids.filter((_id, index) => index % 2 === 0).map((fileID) => ({ fileID, siteID: 'a' })) } });

    const files = await readSnapshotFiles({ legacy: legacy.legacy }, SNAP_DB, ids);

    expect(files.size).toBe(FILE_LOOKUP_IDS + 1);
    expect(legacy.queries.map((query) => [query.sql, query.inputs])).toEqual([
      [tfilesLookupSql(FILE_LOOKUP_IDS), ids.slice(0, FILE_LOOKUP_IDS)],
      [tfilesLookupSql(FILE_LOOKUP_IDS), ids.slice(FILE_LOOKUP_IDS, FILE_LOOKUP_IDS * 2)],
      [tfilesLookupSql(1), ids.slice(FILE_LOOKUP_IDS * 2)],
    ]);
  });

  it('reads nothing for no file ids', async () => {
    const legacy = legacyOf({ [SNAP_DB]: { tsettings: [], tfiles: [] } });

    expect(await readSnapshotFiles({ legacy: legacy.legacy }, SNAP_DB, [])).toEqual(new Map());
    expect(legacy.database).not.toHaveBeenCalled();
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
        { siteId: 'default', name: 'Thumbs.db', reason: 'not a stored-object name' },
        { siteId: 'default', name: 'notes.txt', reason: 'not a stored-object name' },
        { siteId: 'default', name: `${STRAY_ID}.txt`, reason: 'file id is not a CF UUID' },
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
    expect(log.info).toHaveBeenCalledWith('file manifest of snapshot 3 built: 2 sites, 7 entries, 1 orphans, 3 skipped');
    expect(log.warn.mock.calls).toEqual([
      ['file manifest of snapshot 3 skipped Thumbs.db of site default: not a stored-object name'],
      ['file manifest of snapshot 3 skipped notes.txt of site default: not a stored-object name'],
      [`file manifest of snapshot 3 skipped ${STRAY_ID}.txt of site default: file id is not a CF UUID`],
    ]);
    expect(legacy.queries.filter((query) => query.sql.includes('[tfiles]')).map((query) => query.inputs)).toEqual([[FID_A, FID_B], [FID_C]]);
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
    const log = logger();

    const built = await buildFileManifest({ db: tables.db(), legacy: legacy.legacy, bridge: bridge.bridge, logger: log.logger }, 4);

    expect(built).toMatchObject({ entries: 501, orphans: 0, bytes: 1002, skipped: [] });
    expect(log.warn).not.toHaveBeenCalled();
    expect(tables.inserts().map((statement) => statement.values.length)).toEqual([5000, 10]);
    expect(legacy.queries.filter((query) => query.sql.includes('[tfiles]')).map((query) => query.inputs.length)).toEqual([500, 1]);
    expect(await readManifest({ db: tables.db() }, 4)).toHaveLength(501);
  });

  it('inserts the rows of consecutive sites in shared statements of at most 500 rows', async () => {
    const tables = new MigrationTables();
    tables.snapshots.set(4, { database_name: SNAP_DB, manifest_complete: false });
    const ids = Array.from({ length: 600 }, (_unused, index) => `${String(index).padStart(8, '0')}-E5F6-A7B8-C9D0E1F2A3B4C5D6`);
    const legacy = legacyOf({ [SNAP_DB]: { tsettings: ['a', 'b'], tfiles: ids.map((fileID) => ({ fileID, siteID: 'a' })) } });
    const bridge = bridgeOf({
      a: listing(ids.slice(0, 300).map((id) => listed(`${id}.txt`, 2))),
      b: listing(ids.slice(300).map((id) => listed(`${id}.txt`, 3))),
    });

    const built = await buildFileManifest({ db: tables.db(), legacy: legacy.legacy, bridge: bridge.bridge, logger: logger().logger }, 4);

    expect(built).toMatchObject({ sites: 2, entries: 600, orphans: 0, bytes: 300 * 2 + 300 * 3, skipped: [] });
    expect(tables.inserts().map((statement) => statement.values.length)).toEqual([5000, 1000]);
    expect((await readManifest({ db: tables.db() }, 4)).map((found) => found.siteId)).toEqual([...Array<string>(300).fill('a'), ...Array<string>(300).fill('b')]);
  });

  describe('spill directory', () => {
    let spillDir: string;

    beforeEach(async () => {
      spillDir = await mkdtemp(join(tmpdir(), 'files-manifest-test-'));
    });

    afterEach(async () => {
      await rm(spillDir, { recursive: true, force: true });
    });

    it('spills each listed site to disk before listing the next one and removes the spill on success', async () => {
      const { tables, bridge, ctx } = twoSiteStore();
      const seen: { dirs: string[]; paths: string[] }[] = [];
      const filesList = async (siteId: string): Promise<FileListing> => {
        const dirs = await readdir(spillDir);
        const text = await readFile(join(spillDir, dirs[0] ?? '', 'rows.ndjson'), 'utf8');
        const paths = text
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => (JSON.parse(line) as ManifestEntry).path);
        seen.push({ dirs, paths });
        return bridge.bridge.filesList(siteId);
      };

      const built = await buildFileManifest({ ...ctx, bridge: { filesList } as unknown as BridgeClient }, 3, { spillDir });

      expect(built.entries).toBe(7);
      expect(seen.map(({ dirs }) => dirs.map((dir) => dir.startsWith('opt2-file-manifest-')))).toEqual([[true], [true]]);
      expect(seen.map(({ paths }) => paths)).toEqual([
        [],
        [`${FID_A}.jpg`, `${FID_A}_source.jpg`, `${FID_A}_small.jpg`, `${FID_A}_medium.jpg`, `${FID_A}_W100_H50.jpg`, `${FID_B}.pdf`].map(
          (name) => `default/cache/file/${name}`,
        ),
      ]);
      expect(tables.manifest).toHaveLength(7);
      expect(await readdir(spillDir)).toEqual([]);
    });

    it.each<[string, Record<string, FileListing | Error>, Record<string, unknown>]>([
      [
        'a later site cannot be listed',
        { default: listing([listed(`${FID_A}.jpg`, 1)]), 'tenant-a': new BridgeError('files.list', 500, 'Internal Server Error') },
        { name: 'BridgeError', status: 500 },
      ],
      [
        'an insert fails',
        { default: listing([listed(`${FID_A}.jpg`, 1), listed(`${FID_A}.jpg`, 1)]), 'tenant-a': listing([]) },
        { code: '23505' },
      ],
    ])('removes the spill and leaves the manifest unwritten when %s', async (_case, answers, failure) => {
      const { tables, ctx } = twoSiteStore();

      const error = await buildFileManifest({ ...ctx, bridge: bridgeOf(answers).bridge }, 3, { spillDir }).catch((caught: unknown) => caught);

      expect(error).toMatchObject(failure);
      expect(tables.manifest).toEqual([]);
      expect(tables.snapshots.get(3)?.manifest_complete).toBe(false);
      expect(await readdir(spillDir)).toEqual([]);
    });
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

  /** Snapshot 6 of four entries, out of key order, and one entry of snapshot 7. */
  function fourEntries(): MigrationTables {
    const tables = new MigrationTables();
    tables.manifest.push(
      row('tenant-a', `${FID_C}.png`),
      row('default', `${FID_A}_small.jpg`),
      row('Default', `${FID_B}.pdf`),
      row('default', `${FID_A}_W100_H50.jpg`),
      row('default', `${FID_A}.jpg`, 7),
    );
    return tables;
  }

  it('returns the snapshot entries by site id then path in byte order, with int8 sizes as numbers', async () => {
    const tables = new MigrationTables();
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

  it.each<[number, number[]]>([
    [1, [1, 1, 1, 1, 0]],
    [2, [2, 2, 0]],
    [3, [3, 1]],
    [4, [4, 0]],
    [5, [4]],
  ])('streams the manifest in keyset pages of %i entries', async (pageRows, returned) => {
    const tables = fourEntries();
    const expected = await readManifest({ db: fourEntries().db() }, 6);

    const streamed: ManifestEntry[] = [];
    for await (const found of streamManifest({ db: tables.db() }, 6, { pageRows })) streamed.push(found);

    expect(streamed).toEqual(expected);
    const pages = tables.pages();
    expect(pages.map((page) => page.returned)).toEqual(returned);
    expect(tables.statements).toEqual(pages);
    expect(pages[0]).toMatchObject({ sql: FIRST_PAGE_SQL, values: [6, pageRows] });
    pages.slice(1).forEach((page, index) => {
      const last = streamed[(index + 1) * pageRows - 1];
      expect(page).toMatchObject({ sql: NEXT_PAGE_SQL, values: [6, last?.siteId, last?.path, pageRows] });
    });
  });

  it.each<[number, number[]]>([
    [2345, [1000, 1000, 345]],
    [2000, [1000, 1000, 0]],
  ])('reads %i entries in pages of at most MANIFEST_PAGE_ROWS rows', async (count, returned) => {
    const tables = new MigrationTables();
    const names = Array.from({ length: count }, (_unused, index) => `${String(count - index).padStart(8, '0')}-E5F6-A7B8-C9D0E1F2A3B4C5D6.txt`);
    tables.manifest.push(...names.map((name) => row(Number(name.slice(0, 8)) % 2 === 0 ? 'even' : 'odd', name, 8)));

    const entries = await readManifest({ db: tables.db() }, 8);

    expect(entries).toHaveLength(count);
    expect(entries.map((found) => found.path)).toEqual(
      tables.manifest.toSorted(keyOrder).map((found) => found.path),
    );
    expect(MANIFEST_PAGE_ROWS).toBe(1000);
    expect(tables.pages().map((page) => page.returned)).toEqual(returned);
    expect(Math.max(...tables.statements.map((statement) => statement.returned))).toBeLessThanOrEqual(MANIFEST_PAGE_ROWS);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a page size of %s before querying', async (limit) => {
    const tables = fourEntries();

    await expect(readManifestPage({ db: tables.db() }, 6, undefined, limit)).rejects.toThrow(
      new RangeError(`manifest page size must be a positive integer, not ${String(limit)}`),
    );
    expect(tables.statements).toEqual([]);
  });

  it('reads the entries of exactly the asked names in key order with one statement binding each name once, and none for no names', async () => {
    const tables = fourEntries();

    const entries = await readManifestNames({ db: tables.db() }, 6, [
      { fileId: FID_C, variant: '', ext: 'png' },
      { fileId: FID_A, variant: '_small', ext: 'jpg' },
      { fileId: FID_A, variant: '_small', ext: 'jpg' },
      { fileId: FID_A, variant: '', ext: 'jpg' },
      { fileId: FID_B.toLowerCase(), variant: '', ext: 'pdf' },
    ]);

    expect(entries.map((found) => found.path)).toEqual([`default/cache/file/${FID_A}_small.jpg`, `tenant-a/cache/file/${FID_C}.png`]);
    expect(tables.statements).toMatchObject([
      { sql: NAMES_SQL, values: [6, [FID_C, FID_A, FID_A, FID_B.toLowerCase()], ['', '_small', '', ''], ['png', 'jpg', 'jpg', 'pdf']], returned: 2 },
    ]);
    expect(await readManifestNames({ db: tables.db() }, 6, [])).toEqual([]);
    expect(tables.statements).toHaveLength(1);
  });

  it(`binds at most ${String(FILE_LOOKUP_IDS)} names per lookup, returning at most one entry per site and name`, async () => {
    const tables = new MigrationTables();
    const variants = Array.from({ length: FILE_LOOKUP_IDS * 2 + 1 }, (_unused, index): StoredVariant => `_W${String(index)}_H50`);
    const names = variants.map((variant) => ({ fileId: FID_A, variant, ext: 'jpg' }));
    tables.manifest.push(...['default', 'tenant-a'].flatMap((siteId) => variants.map((variant) => row(siteId, `${FID_A}${variant}.jpg`))));

    const entries = await readManifestNames({ db: tables.db() }, 6, names);

    expect(entries).toHaveLength(names.length * 2);
    expect(tables.statements.map((statement) => [statement.sql, statement.values[2], statement.returned])).toEqual([
      [NAMES_SQL, variants.slice(0, FILE_LOOKUP_IDS), FILE_LOOKUP_IDS * 2],
      [NAMES_SQL, variants.slice(FILE_LOOKUP_IDS, FILE_LOOKUP_IDS * 2), FILE_LOOKUP_IDS * 2],
      [NAMES_SQL, variants.slice(FILE_LOOKUP_IDS * 2), 2],
    ]);
  });

  it('reads the page following a key that is not itself in the manifest', async () => {
    const tables = fourEntries();

    const page = await readManifestPage({ db: tables.db() }, 6, { siteId: 'default', path: `default/cache/file/${FID_A}_X` }, 10);

    expect(page.map((found) => found.path)).toEqual([`default/cache/file/${FID_A}_small.jpg`, `tenant-a/cache/file/${FID_C}.png`]);
    expect(tables.statements).toMatchObject([{ sql: NEXT_PAGE_SQL, values: [6, 'default', `default/cache/file/${FID_A}_X`, 10], returned: 2 }]);
  });
});
